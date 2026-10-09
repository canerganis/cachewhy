// Spec revision 11.1 (amendment after the real-data review at G1). Synthetic data only; every expectation is computed
// by hand from the spec text and checked in both implementations (src/ and scripts/recompute).
//
//   R0.9    Claude request_anomaly is chain scoped (plus the link (iii) component), Codex keeps the family scope;
//           link guard (effect 4) and the t_asm guard of effect 4
//   R17.3   drift_stream_integrity counts Codex families, drift is decided per provider (partial headline)
//   R16.5   first line of a partial report; R14.5 withheld_by_provider and per provider usd in the JSON
//   R3.9    tokens_unpriced_by_reason, the priced share and the reason list of the text report
//   R4.10   the 99/100 file fixture: withholding is presentation only
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { recompute, type RecomputeResult } from "../scripts/recompute/index.mjs";
import { analyze, type Analysis } from "../src/analyze.ts";
import { discover } from "../src/discover.ts";
import { countedResponseIndices } from "../src/graph/index.ts";
import { chainIdOf, UNPRICED_TOKEN_REASONS } from "../src/model/types.ts";
import type { ProviderTotals, Provider } from "../src/model/types.ts";
import { buildReportInput, type ReportView } from "../src/report/input.ts";
import { reportToJson } from "../src/report/json.ts";
import { pricedShareLine, renderReport } from "../src/report/text.ts";
import { ClaudeProject, CodexHome, CodexThread, writeFiles, type GeneratedFile } from "./fixtures/builder.ts";
import { OLD_MTIME_MS, RUN_START_MS } from "./fixtures/r09.ts";

const NOW = RUN_START_MS;
const VERSION = "2.1.293";
const OPUS = "claude-opus-5-5";

// ---------------------------------------------------------------------------
// harness: one tree, both implementations
// ---------------------------------------------------------------------------

const stamped = (files: readonly GeneratedFile[]): GeneratedFile[] => files.map((f) => ({ ...f, mtimeMs: f.mtimeMs ?? OLD_MTIME_MS }));

interface Both {
  readonly analysis: Analysis;
  readonly view: ReportView;
  readonly rec: RecomputeResult;
}

async function both(files: readonly GeneratedFile[], tier?: "standard"): Promise<Both> {
  const dir = mkdtempSync(join(tmpdir(), "cw-rev111-"));
  try {
    writeFiles(dir, stamped(files));
    const found = await discover({ claudeDirs: [join(dir, "projects")], codexDirs: [dir], env: {}, home: dir });
    const analysis = await analyze(found.files, { now_ms: NOW, codex_tier_for_test: tier });
    const view = buildReportInput(
      {
        graph: analysis.graph,
        parsed: analysis.parsed,
        priced: analysis.priced,
        detection: analysis.detection,
        book: analysis.book,
        options: { command: "default", json: false, show_ids: false, demo: false, color: false },
        generated_at_ms: NOW,
        tool_version: "0.0.0",
      },
      analysis.filter,
    );
    const rec = recompute({
      claudeDirs: [join(dir, "projects")],
      codexDirs: [dir],
      since: null,
      until: new Date(NOW).toISOString(),
      codexTierForTest: tier,
      runStartMs: NOW,
    });
    return { analysis, view, rec };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Rewrite the JSON lines of the files whose path satisfies `pred`; `fn` returns the new object or null to drop it. */
function mapLines(files: GeneratedFile[], pred: (path: string) => boolean, fn: (o: any, idx: number) => any): GeneratedFile[] {
  return files.map((f) => {
    if (!pred(f.path) || typeof f.content !== "string") return f;
    const out: string[] = [];
    f.content
      .split("\n")
      .filter(Boolean)
      .forEach((l, idx) => {
        const o = fn(JSON.parse(l), idx);
        if (o !== null) out.push(JSON.stringify(o));
      });
    return { ...f, content: out.join("\n") + "\n" };
  });
}

interface RowView {
  readonly provider: Provider;
  readonly key: string;
  readonly chain: string;
  readonly tainted: boolean;
  readonly reasons: readonly string[];
  readonly verified: boolean;
  readonly model: string | null;
  readonly pico: bigint | null;
  readonly tokens_unpriced: bigint;
  readonly t_asm: number | null;
  readonly start_lo: number | null;
  readonly gap_basis: string;
}

/** Counted responses of the src pipeline, by `provider:key`. */
function rows(b: Both): Map<string, RowView> {
  const g = b.analysis.graph;
  const out = new Map<string, RowView>();
  for (const i of countedResponseIndices(g)) {
    const r = g.responses[i]!;
    const p = b.analysis.priced[i]!;
    const t = g.taint[r.provider].chains.get(chainIdOf(r.chain))!;
    out.set(`${r.provider}:${r.key}`, {
      provider: r.provider,
      key: r.key,
      chain: chainIdOf(r.chain),
      tainted: t.tainted,
      reasons: [...t.reasons],
      verified: r.model.verified,
      model: r.model.verified ? r.model.model : null,
      pico: p.cost.pico,
      tokens_unpriced: p.tokens_unpriced,
      t_asm: r.time.t_asm_ms,
      start_lo: r.time.start_lo_ms,
      gap_basis: r.time.gap_basis,
    });
  }
  return out;
}

/** Exact agreement of the two implementations: counted set, buckets, taint, reasons, picodollars, unpriced breakdown. */
function assertAgree(b: Both, label: string): void {
  const mine = rows(b);
  const theirs = new Map(b.rec.responses.filter((r) => r.counted).map((r) => [`${r.provider}:${r.key}`, r]));
  assert.deepEqual([...mine.keys()].sort(), [...theirs.keys()].sort(), `${label}: same counted set`);
  const g = b.analysis.graph;
  for (const i of countedResponseIndices(g)) {
    const r = g.responses[i]!;
    const x = theirs.get(`${r.provider}:${r.key}`)!;
    const m = mine.get(`${r.provider}:${r.key}`)!;
    assert.equal(m.tainted, x.tainted, `${label}: ${r.key} tainted`);
    assert.deepEqual(m.reasons, x.taint_reasons, `${label}: ${r.key} reasons`);
    assert.equal(m.pico, x.price!.priced ? x.price!.pico : null, `${label}: ${r.key} picodollars`);
    const u = r.usage!;
    const bk = x.buckets!;
    assert.equal(u.input_uncached, bk.input_uncached, `${label}: ${r.key} input`);
    assert.equal(u.cache_read, bk.cache_read, `${label}: ${r.key} cache_read`);
    assert.equal(u.cache_write_5m, bk.cache_write_5m, `${label}: ${r.key} cache_write_5m`);
    assert.equal(u.output, bk.output, `${label}: ${r.key} output`);
  }
  for (const p of ["claude", "codex"] as const) {
    const v = b.view.coverage_by_provider[p];
    const c = b.rec.coverage[p];
    assert.equal(v.chains_tainted, c.chains_tainted, `${label}: ${p} chains_tainted`);
    assert.equal(v.families_tainted, c.families_tainted, `${label}: ${p} families_tainted`);
    assert.equal(v.families_total, c.families_total, `${label}: ${p} families_total`);
    assert.equal(v.families_ordinal_unverified, c.families_ordinal_unverified, `${label}: ${p} families_ordinal_unverified`);
    let sum = 0n;
    for (const k of UNPRICED_TOKEN_REASONS) {
      assert.equal(v.tokens_unpriced_by_reason[k].toString(), c.tokens_unpriced_by_reason[k], `${label}: ${p} tokens_unpriced_by_reason.${k}`);
      sum += v.tokens_unpriced_by_reason[k];
    }
    assert.equal(sum, v.tokens_unpriced, `${label}: ${p} the reasons sum to tokens_unpriced`);
  }
}

const key = (id: string): string => `claude:${id}`;

// ---------------------------------------------------------------------------
// (a) R0.9 fixture (7): Claude request_anomaly is chain scoped
// ---------------------------------------------------------------------------

interface Fixture7 {
  readonly files: GeneratedFile[];
  readonly subIds: readonly string[];
  readonly confUuid: string;
}

/**
 * Session A: the main chain holds one request `conf` with two copies and three linked subagent chains with priced
 * responses. Session B replays a copy of `conf`. Session C holds a replayed copy of the clean request `clean-main` of
 * the main chain A. Session D is unrelated. `anomaly` false builds the control scan (no copy disagrees).
 */
function fixture7(anomaly: boolean, opts: { subParentIsConf?: boolean } = {}): Fixture7 {
  const p = new ClaudeProject();
  const a = p.session({ sessionId: "synthetic-session-a", version: VERSION, model: OPUS, startMs: Date.UTC(2026, 0, 1) });
  // an earlier request, so that the stream of A starts before every replayed copy (no ownership tie, R4.6)
  a.main.request({ requestId: "pre", usage: { input: 12, output: 22 } });
  const cleanMain = a.main.request({ requestId: "clean-main", usage: { input: 11, output: 21 } });
  const conf = a.main.request({ requestId: "conf", blocks: [{ type: "text" }, { type: "text" }], usage: { input: 10, output: 20 } });
  const subIds: string[] = [];
  for (let k = 1; k <= 3; k++) {
    const sub = a.spawnAgent({ spawnDepth: 1, model: OPUS });
    const id = `sub${k}`;
    sub.agent.thread.request({ requestId: id, usage: { input: 100 * k, cacheRead: 5 * k, write5m: 7 * k, output: 30 * k } });
    subIds.push(id);
  }
  const b = p.session({ sessionId: "synthetic-session-b", version: VERSION, model: OPUS, startMs: Date.UTC(2026, 0, 2) });
  b.main.replay(conf.records);
  const c = p.session({ sessionId: "synthetic-session-c", version: VERSION, model: OPUS, startMs: Date.UTC(2026, 0, 3) });
  c.main.replay(cleanMain.records);
  p.session({ sessionId: "synthetic-session-d", version: VERSION, model: OPUS, startMs: Date.UTC(2026, 0, 4) }).main.request({
    requestId: "dee",
    usage: { input: 9, output: 19 },
  });
  const confUuid = conf.records[0]!.uuid as string;
  let files = p.files();
  if (anomaly) {
    // the first copy of `conf` in the main file of session A disagrees on input_tokens (conflict_input)
    let seen = 0;
    files = mapLines(files, (path) => path.endsWith("synthetic-session-a.jsonl"), (o) => {
      if (o.requestId === "conf") {
        if (seen === 0) o.message.usage.input_tokens = 6;
        seen += 1;
      }
      return o;
    });
  }
  if (opts.subParentIsConf) {
    // the first record of subagent 1 names a record of the main chain as its parent
    files = mapLines(files, (path) => path.includes("/subagents/") && path.endsWith(".jsonl") && !path.endsWith(".meta.json"), (o) => {
      if (o.requestId === "sub1") o.parentUuid = confUuid;
      return o;
    });
  }
  return { files, subIds, confUuid };
}

describe("R0.9 revision 11.1: Claude request_anomaly is chain scoped", () => {
  it("fixture (7): only the chains that hold a copy, or share a request key with them, are tainted; subagents keep verified models and dollars", async () => {
    const fx = fixture7(true);
    const ctl = await both(fixture7(false).files);
    const bad = await both(fx.files);
    const r = rows(bad);
    const c = rows(ctl);

    // the control scan is fully clean and every subagent is priced
    for (const row of c.values()) assert.equal(row.tainted, false, `control: ${row.key}`);
    for (const id of fx.subIds) assert.notEqual(c.get(key(id))!.pico, null, `control: ${id} priced`);

    // main chain A: tainted (conflict_input); B replays a copy of `conf`: tainted too
    // (replayed copies are counted nowhere, so the chains are read from the taint result, not from the counted rows)
    const taintedChains = new Set([...bad.analysis.graph.taint.claude.chains.values()].filter((t) => t.tainted).map((t) => t.chain));
    const chainName = (s: string): string => chainIdOf({ provider: "claude", root_session: s, thread: "main" });
    assert.ok(taintedChains.has(chainName("synthetic-session-a")), "main chain of A is tainted");
    assert.ok(taintedChains.has(chainName("synthetic-session-b")), "the chain that replays a copy of the request is tainted");
    // C holds no copy of `conf`, only a replayed copy of the clean request `clean-main` of the tainted chain A: link (iii)
    assert.ok(taintedChains.has(chainName("synthetic-session-c")), "a chain that shares a request key with the tainted chain is tainted");
    assert.equal(taintedChains.size, 3, "nothing else is tainted: the three subagents and session D stay clean");
    for (const row of r.values()) if (row.tainted) assert.deepEqual(row.reasons, ["request_anomaly"]);

    // the three subagents: untainted, verified model, the same non-null dollars as without the anomaly
    for (const id of fx.subIds) {
      const x = r.get(key(id))!;
      const y = c.get(key(id))!;
      assert.equal(x.tainted, false, `${id} untainted`);
      assert.equal(x.verified, true, `${id} keeps a verified model`);
      assert.equal(x.model, y.model);
      assert.notEqual(x.pico, null, `${id} keeps its dollars`);
      assert.equal(x.pico, y.pico, `${id} dollars equal those of a scan without the anomaly`);
    }
    const dee = r.get(key("dee"))!;
    assert.equal(dee.tainted, false);
    assert.equal(dee.pico, c.get(key("dee"))!.pico);

    // links are still counted: 3 verified, whatever the taint
    assert.equal(bad.view.coverage_by_provider.claude.links_verified, 3);
    assert.equal(ctl.view.coverage_by_provider.claude.links_verified, 3);

    // chain counts: A main + 3 subagents, B, C, D main = 7 chains; 3 tainted; the family of A holds 4 chains
    const cov = bad.view.coverage_by_provider.claude;
    assert.equal(cov.chains_total, 7);
    assert.equal(cov.chains_tainted, 3);
    assert.equal(cov.chains_tainted_by_reason.request_anomaly, 3);
    // families: A+subagents (+ B and C through link (iii)), D alone. One family of 6 chains and D.
    assert.equal(cov.families_total, 2);
    assert.equal(cov.families_tainted, 1);

    // both implementations agree exactly (buckets, taint, picodollars)
    assertAgree(bad, "fixture 7");
    assertAgree(ctl, "fixture 7 control");
  });

  it("link guard: link_decides_boundary is false for each child of a tainted parent, true in the control scan", async () => {
    const bad = await both(fixture7(true).files);
    const ctl = await both(fixture7(false).files);
    const subs = (b: Both) => b.analysis.graph.chains.filter((c) => c.kind === "subagent");
    assert.equal(subs(bad).length, 3);
    for (const c of subs(bad)) {
      assert.equal(c.tainted, false);
      assert.equal(c.link?.state, "verified");
      assert.equal(c.link_decides_boundary, false, "the parent is tainted, so the link decides no boundary");
    }
    for (const c of subs(ctl)) assert.equal(c.link_decides_boundary, true, "control: verified link, child and parent untainted");
    // a tainted chain never decides a boundary through its own link, and a main chain has no link
    for (const c of bad.analysis.graph.chains) if (c.tainted) assert.equal(c.link_decides_boundary, false);
  });

  it("t_asm guard: a clean subagent whose parentUuid resolves to a record of the tainted main chain has no t_asm and no start_lo", async () => {
    const bad = await both(fixture7(true, { subParentIsConf: true }).files);
    const ctl = await both(fixture7(false, { subParentIsConf: true }).files);
    const x = rows(bad).get(key("sub1"))!;
    const y = rows(ctl).get(key("sub1"))!;
    assert.equal(x.tainted, false);
    assert.equal(y.t_asm !== null && y.start_lo !== null, true, "control: the parent record gives a time");
    assert.equal(y.gap_basis, "parent_record");
    assert.equal(x.t_asm, null);
    assert.equal(x.start_lo, null);
    assert.equal(x.gap_basis, "none");
    assert.equal(x.pico, y.pico, "accounting and dollars are unchanged");
    // the other subagents resolve nothing through a tainted record and keep what the parser read
    assert.equal(rows(bad).get(key("sub2"))!.t_asm, rows(ctl).get(key("sub2"))!.t_asm);
  });

  it("the scope is a function of the record set: shuffled and line-duplicated files give the same taint", async () => {
    const fx = fixture7(true);
    const reversed = [...fx.files].reverse();
    const dup = mapLines(fx.files, (path) => path.endsWith("synthetic-session-c.jsonl"), (o) => o);
    const dupText = dup.map((f) => (f.path.endsWith("synthetic-session-c.jsonl") && typeof f.content === "string" ? { ...f, content: f.content + f.content } : f));
    const base = rows(await both(fx.files));
    for (const files of [reversed, dupText]) {
      const alt = rows(await both(files));
      assert.deepEqual(
        [...alt.values()].map((x) => [x.key, x.tainted]).sort(),
        [...base.values()].map((x) => [x.key, x.tainted]).sort(),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Codex keeps the family scope
// ---------------------------------------------------------------------------

describe("R0.9 revision 11.1: a Codex request_anomaly keeps the family scope", () => {
  it("a conflicting token_usage_record in a thread with a linked subagent thread taints the whole family, in both implementations", async () => {
    const home = new CodexHome();
    const parent = new CodexThread({ threadId: "synthetic-thread-p", threadSource: "user", model: "gpt-6-sol" });
    parent.turnContext({ turnId: "Tp" });
    parent.tokenUsage({ responseId: "dup", usage: { input: 1000, output: 10 } });
    parent.tokenUsage({ responseId: "dup", usage: { input: 2000, output: 10 }, noAccumulate: true });
    const child = new CodexThread({
      threadId: "synthetic-thread-c",
      sessionId: "synthetic-session-x",
      threadSource: "subagent",
      threadSpawn: { parentThreadId: "synthetic-thread-p", depth: 1 },
      model: "gpt-6-sol",
    });
    child.turnContext({ turnId: "Tc" });
    child.tokenUsage({ responseId: "kid", usage: { input: 3000, output: 30 } });
    const other = new CodexThread({ threadId: "synthetic-thread-o", threadSource: "user", model: "gpt-6-sol" });
    other.turnContext({ turnId: "To" });
    other.tokenUsage({ responseId: "oth", usage: { input: 4000, output: 40 } });
    for (const t of [parent, child, other]) home.add(t);
    const b = await both(home.files(), "standard");
    const r = rows(b);
    const kid = r.get("codex:kid")!;
    assert.equal(kid.tainted, true, "the subagent thread of the family is tainted");
    assert.deepEqual(kid.reasons, ["request_anomaly"]);
    assert.equal(kid.pico, null);
    assert.equal(r.get("codex:oth")!.tainted, false);
    assert.notEqual(r.get("codex:oth")!.pico, null);
    const cov = b.view.coverage_by_provider.codex;
    assert.equal(cov.chains_total, 3);
    assert.equal(cov.chains_tainted, 2);
    assert.equal(cov.families_tainted, 1);
    assertAgree(b, "codex family");
  });
});

// ---------------------------------------------------------------------------
// (c) drift_stream_integrity counts families
// ---------------------------------------------------------------------------

/** `families` Codex families: `failing` of them hold a stream that fails R4.12; the first failing one has `subs` subagent threads. */
function driftFiles(families: number, failing: number, subs: number): GeneratedFile[] {
  const home = new CodexHome();
  for (let i = 0; i < families; i++) {
    const id = `synthetic-thread-f${String(i).padStart(3, "0")}`;
    const t = new CodexThread({ threadId: id, threadSource: "user", model: "gpt-6-sol" });
    t.turnContext({ turnId: `T${i}`, ...(i < failing ? { ordinal: null } : {}) }); // an ordinal-decision record without ordinal
    t.tokenUsage({ responseId: `r${i}`, usage: { input: 1000, output: 10 } });
    home.add(t);
    if (i === 0) {
      for (let k = 0; k < subs; k++) {
        const s = new CodexThread({
          threadId: `${id}-sub${k}`,
          sessionId: `synthetic-session-${i}`,
          threadSource: "subagent",
          threadSpawn: { parentThreadId: id, depth: 1 },
          model: "gpt-6-sol",
        });
        s.turnContext({ turnId: `T${i}s${k}` });
        s.tokenUsage({ responseId: `r${i}s${k}`, usage: { input: 1000, output: 10 } });
        home.add(s);
      }
    }
  }
  return home.files();
}

describe("R17.3 revision 11.1: drift_stream_integrity counts families, not chains", () => {
  const finding = (b: Both) => b.view.drift.find((d) => d.code === "drift_stream_integrity" && d.provider === "codex")!;

  it("1 failing family of 100 (with many subagent threads) does not trip; 2 failing families of 100 do", async () => {
    const one = await both(driftFiles(100 - 0, 1, 6), "standard");
    const cov1 = one.view.coverage_by_provider.codex;
    assert.equal(cov1.families_total, 100);
    assert.equal(cov1.families_ordinal_unverified, 1);
    // the failing family holds 7 chains (the parent and 6... see below): more than 1 percent of all chains, so the
    // old chain based rule would have tripped
    assert.ok(cov1.chains_tainted_by_reason.ordinal_unverified >= 2, "the failing family holds several failing chains");
    assert.ok(100 * cov1.chains_tainted_by_reason.ordinal_unverified > cov1.chains_total, "the old rule (chains) would trip");
    assert.equal(finding(one).tripped, false);
    assert.equal(one.view.headline_status, "ok");
    assert.equal(one.view.withheld_by_provider.codex, null);
    assert.equal(one.rec.coverage.codex.families_ordinal_unverified, 1);
    assertAgree(one, "drift 1 of 100");

    const two = await both(driftFiles(100, 2, 6), "standard");
    assert.equal(two.view.coverage_by_provider.codex.families_total, 100);
    assert.equal(two.view.coverage_by_provider.codex.families_ordinal_unverified, 2);
    assert.equal(finding(two).tripped, true);
    assert.equal(two.view.withheld_by_provider.codex, "drift_stream_integrity");
    assert.equal(two.view.headline_status, "withheld");
    assertAgree(two, "drift 2 of 100");
  });
});

// ---------------------------------------------------------------------------
// (d) per-provider withholding, and R4.10 (99/100 files)
// ---------------------------------------------------------------------------

/**
 * `n` Codex files: one pair X, Y where the file of Y holds a usage record of X (a stream conflict, drift trips when
 * files <= 99), and clean single thread files. `splitOne` splits one clean thread over two files.
 */
function codexFiles(n: number, splitOne: boolean): GeneratedFile[] {
  const home = new CodexHome();
  const x = new CodexThread({ threadId: "synthetic-thread-x", threadSource: "user", model: "gpt-6-sol" });
  x.turnContext({ turnId: "Tx" });
  x.tokenUsage({ responseId: "x1", usage: { input: 1000, output: 10 } });
  const y = new CodexThread({ threadId: "synthetic-thread-y", threadSource: "user", model: "gpt-6-sol" });
  // a distinct, later ordinal and instant: the record of X in the file of Y is a stream conflict and nothing else
  y.tokenUsage({ responseId: "x2", usage: { input: 2000, output: 20 }, threadId: "synthetic-thread-x", turnId: "Tx", ordinal: 100, dtMs: 100000 });
  home.add(x);
  home.add(y);
  const total = n - (splitOne ? 1 : 0); // files of the unsplit scan
  for (let i = 0; i < total - 2; i++) {
    const t = new CodexThread({ threadId: `synthetic-thread-c${String(i).padStart(3, "0")}`, threadSource: "user", model: "gpt-6-sol" });
    t.turnContext({ turnId: `Tc${i}` });
    t.tokenUsage({ responseId: `c${i}a`, usage: { input: 1000, output: 10 } });
    const cut = t.lines.length;
    t.tokenUsage({ responseId: `c${i}b`, usage: { input: 1100, output: 10 } });
    home.add(t, i === 0 && splitOne ? { splitAfter: [cut] } : {});
  }
  return home.files();
}

function claudeFiles(opts: { unkeyedExtra?: boolean } = {}): GeneratedFile[] {
  const p = new ClaudeProject();
  const s = p.session({ sessionId: "synthetic-session-cl", version: VERSION, model: OPUS, startMs: Date.UTC(2026, 0, 1) });
  s.main.request({ requestId: "cl1", usage: { input: 1000, cacheRead: 200, write5m: 50, output: 100 } });
  let files = p.files();
  if (opts.unkeyedExtra) {
    // two more usage-bearing assistant records without a request key: drift_no_key (C10) trips for Claude
    const q = new ClaudeProject();
    const e = q.session({ sessionId: "synthetic-session-nk", version: VERSION, model: OPUS, startMs: Date.UTC(2026, 0, 2) });
    e.main.request({ requestId: "nk1", usage: { input: 5, output: 5 } });
    e.main.request({ requestId: "nk2", usage: { input: 6, output: 6 } });
    files = [
      ...files,
      ...mapLines(q.files(), () => true, (o) => {
        if (o.requestId !== undefined) delete o.requestId;
        return o;
      }),
    ];
  }
  return files;
}

describe("R17.3, R16.5, R14.5 revision 11.1: drift is per provider", () => {
  it("a Codex drift trip with a priced Claude response gives partial: Claude keeps its dollars, Codex prints none", async () => {
    const b = await both([...claudeFiles(), ...codexFiles(99, false)], "standard");
    const v = b.view;
    assert.equal(v.headline_status, "partial");
    assert.deepEqual(v.withheld_by_provider, { claude: null, codex: "drift_stream_integrity" });
    assert.equal(v.withheld_reason, "drift_stream_integrity");
    const cl = v.totals.find((t) => t.provider === "claude")!;
    const cx = v.totals.find((t) => t.provider === "codex")!;
    assert.notEqual(cl.usd_pico, null);
    assert.notEqual(cx.usd_pico, null, "the dollars are computed; only the printing is withheld");
    // headline usd sums the open provider only
    assert.equal(v.headline.usd_pico, cl.usd_pico);
    assert.ok(v.assumptions.includes("no_regional_surcharge_assumed"));

    const j = reportToJson(v) as any;
    assert.equal(j.headline_status, "partial");
    assert.deepEqual(j.withheld_by_provider, { claude: null, codex: "drift_stream_integrity" });
    const jc = j.totals.find((t: any) => t.provider === "claude");
    const jx = j.totals.find((t: any) => t.provider === "codex");
    assert.equal(jc.usd, cl.usd_pico!.toString());
    assert.ok(jc.models.every((m: any) => m.usd === null || typeof m.usd === "string"));
    assert.ok(jc.models.some((m: any) => m.usd !== null));
    assert.equal(jx.usd, null);
    assert.ok(jx.models.every((m: any) => m.usd === null));
    // coverage stays complete for the closed provider
    assert.equal(typeof j.coverage.tokens_unpriced_by_reason.chain_tainted, "string");

    const text = renderReport(v).split("\n");
    assert.equal(text[0], "Headline withheld for Codex: drift_stream_integrity; its tokens below are unverified and none of its dollars is printed.");
    const body = text.join("\n");
    assert.ok(body.includes("Codex (unverified)"), "the closed provider keeps the unverified label");
    assert.ok(!body.includes("Claude (unverified)"));
    assert.ok(!/Headline withheld: /.test(body), "not the all-closed sentence");
    // the Claude dollars are printed, the Codex block prints none
    const clBlock = body.slice(body.indexOf("\nClaude\n"), body.indexOf("\nCodex (unverified)"));
    assert.match(clBlock, /List-price equivalent: .*\$/);
    const cxBlock = body.slice(body.indexOf("\nCodex (unverified)"));
    assert.match(cxBlock, /List-price equivalent: not printed/);
    assert.ok(!/\$\d/.test(cxBlock.slice(0, cxBlock.indexOf("Coverage"))), "no dollar amount in the closed provider block");
    assertAgree(b, "partial");
  });

  it("both providers tripped gives withheld, no dollars anywhere, and the first sentence of R16.5", async () => {
    const b = await both([...claudeFiles({ unkeyedExtra: true }), ...codexFiles(99, false)], "standard");
    const v = b.view;
    assert.equal(v.headline_status, "withheld");
    assert.equal(v.withheld_by_provider.claude, "drift_no_key");
    assert.equal(v.withheld_by_provider.codex, "drift_stream_integrity");
    assert.equal(v.withheld_reason, "drift_no_key", "the first tripped code in provider order");
    const j = reportToJson(v) as any;
    for (const t of j.totals) {
      assert.equal(t.usd, null);
      assert.ok(t.models.every((m: any) => m.usd === null));
    }
    const text = renderReport(v);
    assert.ok(text.includes("Headline withheld: drift_no_key"));
    assert.ok(!text.startsWith("Headline withheld for"));
    assert.ok(!v.assumptions.includes("no_regional_surcharge_assumed"), "no open provider prints a dollar");
  });

  it("no provider closed: ok, and the JSON carries null codes", async () => {
    const b = await both(claudeFiles());
    assert.equal(b.view.headline_status, "ok");
    assert.deepEqual(b.view.withheld_by_provider, { claude: null, codex: null });
    assert.equal(b.view.withheld_reason, null);
    assert.equal(renderReport(b.view).split("\n").some((l) => l.startsWith("Headline withheld")), false);
  });
});

describe("R4.10 revision 11.1: withholding is presentation only (99 files versus 100 files)", () => {
  it("one stream-conflict file of 99 trips; after splitting a clean file into two (100 files) it does not; every computed amount is equal", async () => {
    const a = await both(codexFiles(99, false), "standard");
    const c = await both(codexFiles(100, true), "standard");
    assert.equal(a.view.coverage_by_provider.codex.files_total, 99);
    assert.equal(c.view.coverage_by_provider.codex.files_total, 100);
    assert.equal(a.view.coverage_by_provider.codex.files_stream_conflict, 1);
    assert.equal(a.view.withheld_by_provider.codex, "drift_stream_integrity");
    assert.equal(a.view.headline_status, "withheld");
    assert.equal(c.view.withheld_by_provider.codex, null);
    assert.equal(c.view.headline_status, "ok");

    // every computed amount is equal
    const ra = rows(a);
    const rc = rows(c);
    assert.deepEqual(
      [...ra.values()].map((x) => [x.key, x.tainted, x.pico, x.tokens_unpriced, x.verified, x.model]).sort(),
      [...rc.values()].map((x) => [x.key, x.tainted, x.pico, x.tokens_unpriced, x.verified, x.model]).sort(),
    );
    const ta = a.view.totals.find((t) => t.provider === "codex")!;
    const tc = c.view.totals.find((t) => t.provider === "codex")!;
    assert.equal(ta.usd_pico, tc.usd_pico);
    assert.notEqual(ta.usd_pico, null);
    assert.equal(ta.requests_priced, tc.requests_priced);
    assert.equal(ta.tokens_unpriced, tc.tokens_unpriced);
    assert.deepEqual(ta.tokens_unpriced_by_reason, tc.tokens_unpriced_by_reason);
    const ca = a.view.coverage_by_provider.codex;
    const cc = c.view.coverage_by_provider.codex;
    for (const f of ["requests_priced", "requests_unknown_model", "requests_unpriced_modifier", "chains_total", "chains_tainted", "families_total", "families_tainted", "links_verified"] as const) {
      assert.equal(ca[f], cc[f], f);
    }
    assert.deepEqual(ca.tokens_unpriced_by_reason, cc.tokens_unpriced_by_reason);
    assert.equal(ca.tokens_unpriced, cc.tokens_unpriced);

    // only the withholding fields and the printed dollars differ
    const ja = reportToJson(a.view) as any;
    const jc = reportToJson(c.view) as any;
    assert.equal(ja.totals.find((t: any) => t.provider === "codex").usd, null);
    assert.equal(jc.totals.find((t: any) => t.provider === "codex").usd, ta.usd_pico!.toString());
    assert.deepEqual(ja.coverage.tokens_unpriced_by_reason, jc.coverage.tokens_unpriced_by_reason);
    assertAgree(a, "99 files");
    assertAgree(c, "100 files");
  });
});

// ---------------------------------------------------------------------------
// (e) tokens_unpriced_by_reason and the priced share
// ---------------------------------------------------------------------------

/** The R3.9 multi-gate fixture plus one priced response. */
function multiGateFiles(): GeneratedFile[] {
  const p = new ClaudeProject();
  // S1: an unlisted model without a final copy (gates 4 and 5 both refuse: unknown_model comes first)
  p.session({ sessionId: "synthetic-session-m1", version: VERSION, model: "claude-synthetic-unlisted-9", startMs: Date.UTC(2026, 0, 1) }).main.request({
    requestId: "m1",
    usage: { input: 1000, output: 100 },
    finalSpeed: null,
  });
  // S2: a tainted chain with a conflicting modifier (the chain is tainted: chain_tainted comes first)
  const s2 = p.session({ sessionId: "synthetic-session-m2", version: VERSION, model: OPUS, startMs: Date.UTC(2026, 0, 2) });
  s2.main.request({ requestId: "m2", blocks: [{ type: "text" }, { type: "text" }], usage: { input: 500, output: 50 } });
  s2.main.request({ requestId: "m2b", usage: { input: 200, output: 20 } });
  // S3: speed other with inference_geo other (speed_other comes first)
  p.session({ sessionId: "synthetic-session-m3", version: VERSION, model: OPUS, startMs: Date.UTC(2026, 0, 3) }).main.request({
    requestId: "m3",
    usage: { input: 300, output: 30, inferenceGeo: "eu" },
    finalSpeed: "turbo",
  });
  // S4: priced
  p.session({ sessionId: "synthetic-session-m4", version: VERSION, model: OPUS, startMs: Date.UTC(2026, 0, 4) }).main.request({
    requestId: "m4",
    usage: { input: 5000, output: 500 },
  });
  let seen = 0;
  return mapLines(p.files(), (path) => path.endsWith("synthetic-session-m2.jsonl"), (o) => {
    if (o.requestId === "m2") {
      if (seen === 0) o.message.usage.inference_geo = "us"; // conflict_modifier between the copies
      seen += 1;
    }
    return o;
  });
}

describe("R3.9 revision 11.1: tokens_unpriced_by_reason", () => {
  it("the multi-gate fixture counts each response once, under the first refusing gate, in both implementations", async () => {
    const b = await both(multiGateFiles());
    const r = rows(b);
    assert.equal(r.get(key("m1"))!.pico, null);
    assert.equal(r.get(key("m2"))!.tainted, true);
    const by = b.view.coverage_by_provider.claude.tokens_unpriced_by_reason;
    assert.equal(by.unknown_model, 1100n, "unlisted model without a final copy: unknown_model, not modifier_unverified");
    assert.equal(by.chain_tainted, 550n + 220n, "tainted chain with a conflicting modifier: chain_tainted, not conflict_modifier");
    assert.equal(by.speed_other, 330n, "speed other with geo other: speed_other, not geo_other");
    assert.equal(by.geo_other, 0n);
    assert.equal(by.conflict_modifier, 0n);
    assert.equal(by.modifier_unverified, 0n);
    assert.equal(by.model_unknown, 0n);
    assert.equal(by.excluded, 0n);
    const sum = Object.values(by).reduce((x, y) => x + y, 0n);
    assert.equal(sum, b.view.coverage_by_provider.claude.tokens_unpriced);
    assert.equal(sum, 1100n + 770n + 330n);
    // the recompute breakdown was written independently and agrees
    assert.equal(b.rec.coverage.claude.tokens_unpriced_by_reason["unknown_model"], "1100");
    assert.equal(b.rec.coverage.claude.tokens_unpriced_by_reason["chain_tainted"], "770");
    assert.equal(b.rec.coverage.claude.tokens_unpriced_by_reason["speed_other"], "330");
    assertAgree(b, "multi gate");
    // per provider totals and the merged coverage of the JSON
    const t = b.view.totals.find((x) => x.provider === "claude")!;
    assert.deepEqual(t.tokens_unpriced_by_reason, by);
    const j = reportToJson(b.view) as any;
    assert.equal(j.coverage.tokens_unpriced_by_reason.unknown_model, "1100");
    assert.deepEqual(Object.keys(j.coverage.tokens_unpriced_by_reason), [...UNPRICED_TOKEN_REASONS]);
    assert.equal(j.totals.find((x: any) => x.provider === "claude").tokens_unpriced_by_reason.chain_tainted, "770");
  });

  it("the text report prints the priced share and the reasons, largest first, with shares of all tokens", async () => {
    const b = await both(multiGateFiles());
    const text = renderReport(b.view);
    // total 7700 tokens, priced 5500: 71.4 percent
    const line = text.split("\n").find((l) => l.includes("Priced share:"))!;
    assert.equal(
      line,
      "  Priced share: 71.4% of tokens (5,500 of 7,700); unpriced by reason: unknown_model 14.3% (1,100), chain_tainted 10.0% (770), speed_other 4.3% (330).",
    );
  });

  it("the reason list has every non-zero reason, largest first, equal amounts in the enum order (R3.9)", () => {
    const zero = Object.fromEntries(UNPRICED_TOKEN_REASONS.map((k) => [k, 0n])) as Record<(typeof UNPRICED_TOKEN_REASONS)[number], bigint>;
    const totals = (by: Partial<typeof zero>, unpriced: bigint, total: bigint): ProviderTotals =>
      ({ tokens_total: total, tokens_unpriced: unpriced, tokens_unpriced_by_reason: { ...zero, ...by } }) as unknown as ProviderTotals;
    const line = pricedShareLine(
      totals({ modifier_unverified: 100n, speed_other: 100n, unknown_model: 100n, chain_tainted: 50n, geo_other: 10n, tier_unverified: 5n }, 365n, 1000n),
    );
    // equal amounts (100) in enum order: unknown_model, speed_other, modifier_unverified; then chain_tainted 50, geo_other 10,
    // tier_unverified 5: no cap
    assert.equal(
      line,
      "  Priced share: 63.5% of tokens (635 of 1,000); unpriced by reason: unknown_model 10.0% (100), speed_other 10.0% (100), modifier_unverified 10.0% (100), chain_tainted 5.0% (50), geo_other 1.0% (10), tier_unverified 0.5% (5).",
    );
    assert.equal(pricedShareLine(totals({}, 0n, 1000n)), "  Priced share: 100.0% of tokens (1,000 of 1,000); no unpriced tokens.");
    assert.equal(pricedShareLine(totals({}, 0n, 0n)), "  Priced share: n/a of tokens (0 of 0); no unpriced tokens.");
  });

  it("a withheld provider prints the priced share too (token facts, not dollars)", async () => {
    const b = await both([...claudeFiles(), ...codexFiles(99, false)], "standard");
    const text = renderReport(b.view);
    assert.equal(text.split("\n").filter((l) => l.includes("Priced share:")).length, 2);
  });

  it("the reasons sum to tokens_unpriced per provider on the Codex fixtures too", async () => {
    for (const files of [codexFiles(99, false), driftFiles(10, 2, 3)]) {
      for (const tier of [undefined, "standard"] as const) {
        const b = await both(files, tier);
        for (const p of ["claude", "codex"] as const) {
          const c = b.view.coverage_by_provider[p];
          assert.equal(Object.values(c.tokens_unpriced_by_reason).reduce((x, y) => x + y, 0n), c.tokens_unpriced, `${p} ${tier}`);
        }
        assertAgree(b, `codex sums ${tier}`);
      }
    }
  });
});
