// Regression tests for the confirmed review issues: unresolved uuids (R6.3), windowed and live-thinned drift and
// coverage (R17.3, R0.9), the model-unverified counter (R2.10), once-per-request conflicts (R17.1), cross-thread Codex
// duplicates (R4.4), the window start (R5.9), the range precedence (R2.15). All data is synthetic (builder.ts).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { recompute } from "../scripts/recompute/index.mjs";
import { analyze } from "../src/analyze.ts";
import { discover } from "../src/discover.ts";
import { CONFLICT_KINDS } from "../src/model/types.ts";
import type { ClaudeParseResult, CodexParseResult, PricingTable } from "../src/model/types.ts";
import { DEFAULT_TABLE, auditTable, loadPriceBook } from "../src/pricing/index.ts";
import { buildReportInput } from "../src/report/input.ts";
import type { ReportView } from "../src/report/input.ts";
import { parseClaude } from "../src/sources/claude.ts";
import { parseCodex } from "../src/sources/codex.ts";
import { BASE_TIME_MS, ClaudeProject, CodexHome, CodexThread, withRawLines, withTruncatedTail, writeFiles } from "./fixtures/builder.ts";
import type { ClaudeRecord, GeneratedFile } from "./fixtures/builder.ts";
import { OLD_MTIME_MS, RUN_START_MS } from "./fixtures/r09.ts";

const NOW = RUN_START_MS;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const DAY = 86_400_000;

const stamped = (files: readonly GeneratedFile[]): GeneratedFile[] => files.map((f) => ({ ...f, mtimeMs: f.mtimeMs ?? OLD_MTIME_MS }));

async function withTree<T>(files: readonly GeneratedFile[], f: (dirs: { claude: string; codex: string; root: string }) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "cw-review-"));
  try {
    writeFiles(root, stamped(files));
    return await f({ claude: join(root, "projects"), codex: root, root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function discovered(files: readonly GeneratedFile[]) {
  return withTree(files, async (d) => (await discover({ claudeDirs: [d.claude], codexDirs: [d.codex], env: {}, home: d.root })).files);
}

async function parsedClaude(files: readonly GeneratedFile[]): Promise<ClaudeParseResult> {
  return withTree(files, async (d) => parseClaude((await discover({ claudeDirs: [d.claude], codexDirs: [], env: {}, home: d.root })).files, {}));
}

async function parsedCodex(files: readonly GeneratedFile[]): Promise<CodexParseResult> {
  return withTree(files, async (d) => parseCodex((await discover({ claudeDirs: [], codexDirs: [d.codex], env: {}, home: d.root })).files, {}));
}

async function report(files: readonly GeneratedFile[], since?: string) {
  return withTree(files, async (d) => {
    const found = await discover({ claudeDirs: [d.claude], codexDirs: [d.codex], env: {}, home: d.root });
    const analysis = await analyze(found.files, { since, now_ms: NOW, codex_tier_for_test: "standard" });
    const view: ReportView = buildReportInput(
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
      claudeDirs: [d.claude],
      codexDirs: [d.codex],
      since: since ?? null,
      until: new Date(NOW).toISOString(),
      codexTierForTest: "standard",
      runStartMs: NOW,
    });
    return { analysis, view, rec };
  });
}

const msg = (r: ClaudeRecord): any => r.message;

// ---------------------------------------------------------------------------
// R6.3 / R6.4: an unresolved uuid gives no t_asm and no start_lo
// ---------------------------------------------------------------------------

describe("R6.3 a uuid that names records with different timestamps or parents does not resolve", () => {
  function build(mutate: (dup: ClaudeRecord) => void): GeneratedFile[] {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-u", version: "2.1.293" });
    const u = s.main.user();
    const dup = structuredClone(u) as ClaudeRecord;
    mutate(dup);
    s.main.records.push(dup);
    s.main.request({ requestId: "r1", dtMs: 60_000 }); // parentUuid is the shared uuid
    return p.files();
  }

  it("two records of one uuid with different timestamps: t_asm and start_lo are null", async () => {
    const res = await parsedClaude(build((d) => (d.timestamp = new Date(BASE_TIME_MS + 50_000).toISOString())));
    const r = res.responses.find((x) => x.key === "r1");
    assert.ok(r);
    assert.equal(r.time.t_asm_ms, null);
    assert.equal(r.time.start_lo_ms, null);
    assert.equal(r.time.gap_basis, "none");
    const node = res.uuid_index.get(String(r.parent_uuid));
    assert.equal(node?.unresolved, true);
    assert.equal(node?.ts_ms, null);
  });

  it("two records of one uuid with different parents: the uuid does not resolve either", async () => {
    const res = await parsedClaude(build((d) => (d.parentUuid = "synthetic-other-parent")));
    const r = res.responses.find((x) => x.key === "r1");
    assert.ok(r);
    assert.equal(r.time.start_lo_ms, null);
    assert.equal(res.uuid_index.get(String(r.parent_uuid))?.unresolved, true);
    assert.equal(res.uuid_index.get(String(r.parent_uuid))?.parent_uuid, null);
  });

  it("an equal duplicate record keeps the uuid resolved (a duplicated line is one record)", async () => {
    const res = await parsedClaude(build(() => undefined));
    const r = res.responses.find((x) => x.key === "r1");
    assert.ok(r);
    assert.equal(r.time.gap_basis, "parent_record");
    assert.equal(r.time.start_lo_ms, r.time.t_asm_ms);
    assert.equal(res.uuid_index.get(String(r.parent_uuid))?.unresolved, false);
  });
});

// ---------------------------------------------------------------------------
// R17.3 drift is evaluated in the window; R0.9 live families are removed entirely
// ---------------------------------------------------------------------------

function rangeThenGood(): GeneratedFile[] {
  const p = new ClaudeProject();
  const s = p.session({ sessionId: "synthetic-session-d", version: "2.1.293", startMs: Date.UTC(2026, 0, 1) });
  for (let k = 0; k < 5; k++) {
    const r = s.main.request({ requestId: `bad-${k}`, usage: { input: 5, output: 10 } });
    for (const rec of r.records) msg(rec).usage.cache_read_input_tokens = MAX_SAFE + 1;
  }
  for (let k = 0; k < 40; k++) s.main.request({ requestId: `good-${k}`, usage: { input: 5, output: 10 }, dtMs: k === 0 ? 10 * DAY : 1000 });
  return p.files();
}

describe("R17.3 drift and the coverage counters follow the window", () => {
  it("anomalies before the window do not close the headline of a clean window", async () => {
    const all = await report(rangeThenGood());
    assert.equal(all.view.headline_status, "withheld");
    assert.equal(all.view.withheld_reason, "drift_invariant");
    const win = await report(rangeThenGood(), "2026-01-05");
    assert.equal(win.view.headline_status, "ok");
    const c = win.view.coverage_by_provider.claude;
    assert.equal(c.responses_total, 40);
    assert.equal(c.requests_total, 40, "responses_total and requests_total speak of the same responses");
    assert.equal(c.responses_usage_range_failed, 0);
    const d = win.view.drift.find((x) => x.provider === "claude" && x.code === "drift_invariant");
    assert.deepEqual([d?.numerator, d?.denominator, d?.tripped], [0n, 40n, false]);
    // the chain is still tainted by the earlier anomaly (taint is a record-set property, not windowed)
    assert.equal(c.chains_tainted, 1);
    // the independent recompute agrees on the windowed counters
    assert.equal(win.rec.coverage.claude["responses_usage_range_failed"], 0);
    assert.equal(all.rec.coverage.claude["responses_usage_range_failed"], 5);
  });

  it("a record with an unknown event time is in every window (abstain, never a silent drop)", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-n", version: "2.1.293", startMs: Date.UTC(2026, 0, 1) });
    const bad = s.main.request({ requestId: "no-time", usage: { input: 5, output: 10 } });
    for (const rec of bad.records) rec.timestamp = "nope";
    s.main.request({ requestId: "ok", usage: { input: 5, output: 10 }, dtMs: 10 * DAY });
    const win = await report(p.files(), "2026-01-05");
    assert.equal(win.view.coverage_by_provider.claude.responses_total, 2);
    assert.equal(win.view.coverage_by_provider.claude.records_usage_unmappable, 1);
  });
});

describe("R0.9 a live family is removed from the analysis entirely, including the drift counters", () => {
  function twoSessions(): GeneratedFile[] {
    const p = new ClaudeProject();
    const s1 = p.session({ sessionId: "synthetic-session-live", version: "2.1.293", startMs: Date.UTC(2026, 0, 1) });
    const bad = s1.main.request({ requestId: "live-bad", usage: { input: 5, output: 10 } });
    for (const rec of bad.records) msg(rec).usage.cache_read_input_tokens = MAX_SAFE + 1;
    s1.main.request({ requestId: "live-good", usage: { input: 5, output: 10 } });
    const s2 = p.session({ sessionId: "synthetic-session-calm", version: "2.1.293", startMs: Date.UTC(2026, 0, 2) });
    s2.main.request({ requestId: "calm-good", usage: { input: 5, output: 10 } });
    return p.files().map((f) => (f.path.includes("synthetic-session-live") ? { ...withTruncatedTail(f), mtimeMs: NOW - 1000 } : f));
  }

  it("the responses of the live session are in no logical counter and cannot withhold the headline", async () => {
    const r = await report(twoSessions());
    const c = r.view.coverage_by_provider.claude;
    assert.equal(c.families_live_skipped, 1);
    assert.equal(c.requests_total, 1);
    assert.equal(c.responses_total, 1);
    assert.equal(c.records_usage_bearing, 1);
    assert.equal(c.responses_usage_range_failed, 0);
    assert.equal(r.view.headline_status, "ok");
    assert.equal(r.rec.coverage.claude["responses_usage_range_failed"], 0, "the recompute removes the live family too");
  });
});

// ---------------------------------------------------------------------------
// R2.10 / R17.7: responses_model_unverified counts tainted chains, after the taint override
// ---------------------------------------------------------------------------

describe("R2.10 responses_model_unverified includes the responses of tainted chains", () => {
  it("Codex: a thread tainted by an unparsed line", async () => {
    const t = new CodexThread({ threadId: "synthetic-thread-mu", cliVersion: "0.160.1", model: "gpt-6-sol" });
    t.turnContext({ turnId: "tm1" });
    t.tokenUsage({ responseId: "mu1", usage: { input: 1000, output: 10 } });
    const clean = await report(t.files());
    assert.equal(clean.view.coverage_by_provider.codex.responses_model_unverified, 0);
    assert.equal(clean.rec.coverage.codex["responses_model_unverified"], 0);
    const dirty = t.files().map((f) => withRawLines(f, [{ at: 2, text: "this is not json" }]));
    const r = await report(dirty);
    assert.equal(r.view.coverage_by_provider.codex.chains_tainted, 1);
    assert.equal(r.view.coverage_by_provider.codex.responses_model_unverified, 1);
    assert.equal(r.rec.coverage.codex["responses_model_unverified"], 1);
  });

  it("Claude: a session tainted by an unparsed line", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-mu", version: "2.1.293", startMs: Date.UTC(2026, 0, 1) });
    s.main.request({ requestId: "a", usage: { input: 5, output: 10 } });
    s.main.request({ requestId: "b", usage: { input: 5, output: 10 } });
    const clean = await report(p.files());
    assert.equal(clean.view.coverage_by_provider.claude.responses_model_unverified, 0);
    const dirty = p.files().map((f) => withRawLines(f, [{ at: 1, text: "this is not json" }]));
    const r = await report(dirty);
    assert.equal(r.view.coverage_by_provider.claude.responses_model_unverified, 2);
    assert.equal(r.rec.coverage.claude["responses_model_unverified"], 2);
  });
});

// ---------------------------------------------------------------------------
// R17.1 requests_conflict counts requests
// ---------------------------------------------------------------------------

describe("R17.1 requests_conflict counts requests, requests_conflict_by_kind counts codes", () => {
  it("two conflict codes on one request count once in the total and once per code", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-c2", version: "2.1.293" });
    const q = s.main.request({ requestId: "two", blocks: [{ type: "text" }, { type: "text" }], usage: { input: 5, output: 90 } });
    msg(q.records[0] as ClaudeRecord).usage.speed = "standard"; // two final copies with different outputs: conflict_output
    msg(q.records[0] as ClaudeRecord).usage.inference_geo = "us"; // and a different modifier: conflict_modifier
    const res = await parsedClaude(p.files());
    assert.equal(res.coverage.responses_total, 1);
    assert.equal(res.coverage.requests_conflict, 1);
    assert.deepEqual(
      CONFLICT_KINDS.filter((k) => res.coverage.requests_conflict_by_kind[k] > 0),
      ["conflict_output", "conflict_modifier"],
    );
    assert.ok(res.coverage.requests_conflict <= res.coverage.responses_total);
    const rep = await report(p.files());
    assert.equal(rep.view.coverage_by_provider.claude.requests_conflict, 1);
    assert.equal(rep.rec.coverage.claude["requests_conflict"], 1);
    assert.equal((rep.rec.coverage.claude as Record<string, any>)["requests_conflict_by_kind"]["conflict_output"], 1);
    assert.equal((rep.rec.coverage.claude as Record<string, any>)["requests_conflict_by_kind"]["conflict_modifier"], 1);
  });

  it("input and model conflicts of one request: one request, two codes, in both implementations", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-c3", version: "2.1.293" });
    const q = s.main.request({ requestId: "im", blocks: [{ type: "text" }, { type: "text" }] });
    msg(q.records[0] as ClaudeRecord).usage.cache_read_input_tokens = 7;
    msg(q.records[0] as ClaudeRecord).model = "claude-opus-5-5";
    const rep = await report(p.files());
    const c = rep.view.coverage_by_provider.claude;
    assert.equal(c.requests_conflict, 1);
    assert.deepEqual([c.requests_conflict_by_kind.conflict_input, c.requests_conflict_by_kind.conflict_model], [1, 1]);
    assert.equal(rep.rec.coverage.claude["requests_conflict"], 1);
    assert.deepEqual(
      [(rep.rec.coverage.claude as Record<string, any>)["requests_conflict_by_kind"]["conflict_input"], (rep.rec.coverage.claude as Record<string, any>)["requests_conflict_by_kind"]["conflict_model"]],
      [1, 1],
    );
  });
});

// ---------------------------------------------------------------------------
// R4.4: a Codex response id in two threads keeps the label of the conflict
// ---------------------------------------------------------------------------

describe("R4.4 a response_id in two threads with different usage is conflict_usage end to end", () => {
  it("the graph keeps the parser label (usage differs), and conflict_attribution when only the thread differs", async () => {
    const mk = (usageB: number): GeneratedFile[] => {
      const home = new CodexHome();
      const a = new CodexThread({ threadId: "synthetic-thread-xa", cliVersion: "0.160.1", model: "gpt-6-sol" });
      a.turnContext({ turnId: "xa1" });
      a.tokenUsage({ responseId: "synthetic-dup", usage: { input: 1000, output: 10 } });
      const b = new CodexThread({ threadId: "synthetic-thread-xb", cliVersion: "0.160.1", model: "gpt-6-sol" });
      b.turnContext({ turnId: "xb1" });
      b.tokenUsage({ responseId: "synthetic-dup", usage: { input: usageB, output: 10 } });
      home.add(a);
      home.add(b);
      return home.files();
    };
    const differ = await report(mk(2000));
    const dup = differ.analysis.graph.responses.filter((r) => r.key === "synthetic-dup");
    assert.deepEqual(dup.map((r) => r.exclusion), ["conflict_usage", "conflict_usage"]);
    assert.equal(differ.view.coverage_by_provider.codex.requests_conflict_by_kind.conflict_usage, 1);
    assert.equal(differ.view.coverage_by_provider.codex.requests_conflict_by_kind.conflict_attribution, 0);
    assert.equal((differ.rec.coverage.codex as Record<string, any>)["requests_conflict_by_kind"]["conflict_usage"], 1);
    const same = await report(mk(1000));
    const dup2 = same.analysis.graph.responses.filter((r) => r.key === "synthetic-dup");
    assert.deepEqual(dup2.map((r) => r.exclusion), ["conflict_attribution", "conflict_attribution"]);
  });
});

// ---------------------------------------------------------------------------
// R5.9: the default window starts at the first event with a parsed time
// ---------------------------------------------------------------------------

describe("R5.9 a record with an unparseable timestamp does not move the window start", () => {
  it("Claude", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-w", version: "2.1.293", startMs: Date.UTC(2026, 0, 1) });
    const bad = s.main.request({ requestId: "bad-time", usage: { input: 5, output: 10 } });
    for (const rec of bad.records) rec.timestamp = "nope";
    const ok = s.main.request({ requestId: "ok", usage: { input: 5, output: 10 } });
    const r = await report(p.files());
    assert.equal(r.analysis.window.since_ms, Date.parse(String((ok.records[0] as ClaudeRecord).timestamp)));
  });

  it("Codex", async () => {
    const t = new CodexThread({ threadId: "synthetic-thread-w", cliVersion: "0.160.1", model: "gpt-6-sol" });
    t.turnContext({ turnId: "w1" });
    t.tokenUsage({ responseId: "w-bad", usage: { input: 1000, output: 10 } }).line.timestamp = "nope";
    const ok = t.tokenUsage({ responseId: "w-ok", usage: { input: 1000, output: 10 } });
    const r = await report(t.files());
    assert.equal(r.analysis.window.since_ms, Date.parse(ok.line.timestamp));
  });
});

// ---------------------------------------------------------------------------
// R2.15: the range check precedes the missing check in both providers
// ---------------------------------------------------------------------------

describe("R2.15 a range failure with a missing counter is usage_range_failed in both providers", () => {
  it("Codex: input_tokens out of range and cache_write_input_tokens absent", async () => {
    const t = new CodexThread({ threadId: "synthetic-thread-rm", cliVersion: "0.160.1", model: "gpt-6-sol" });
    t.turnContext({ turnId: "rm1" });
    const { line } = t.tokenUsage({ responseId: "rm", usage: { input: 1000, output: 10 } });
    for (const key of ["usage", "turn_token_usage"]) {
      const u = (line.payload as any)[key];
      u.input_tokens = -1;
      delete u.cache_write_input_tokens;
    }
    const res = await parsedCodex(t.files());
    const r = res.responses.find((x) => x.key === "rm");
    assert.equal(r?.exclusion, "usage_range_failed");
    assert.equal(res.coverage.responses_usage_range_failed, 1);
    assert.equal(res.coverage.tokens_in_incomplete_responses, 0n);
  });

  it("Claude: the same pattern is usage_range_failed", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-rm", version: "2.1.293" });
    const q = s.main.request({ requestId: "rm", usage: { input: 5, output: 10 } });
    msg(q.records[0] as ClaudeRecord).usage.input_tokens = -1;
    delete msg(q.records[0] as ClaudeRecord).usage.cache_read_input_tokens;
    const res = await parsedClaude(p.files());
    assert.equal(res.responses.find((x) => x.key === "rm")?.exclusion, "usage_range_failed");
    assert.equal(res.coverage.tokens_in_incomplete_responses, 0n);
  });
});

// ---------------------------------------------------------------------------
// R13.2: the logical counters agree between the report and the recompute
// ---------------------------------------------------------------------------

describe("the windowed logical counters agree between the report and scripts/recompute", () => {
  function mixed(): GeneratedFile[] {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-m", version: "2.1.293", startMs: Date.UTC(2026, 0, 1) });
    const r0 = s.main.request({ requestId: "m-range", usage: { input: 5, output: 10 } });
    for (const rec of r0.records) msg(rec).usage.cache_read_input_tokens = MAX_SAFE + 1;
    s.main.request({ requestId: "m-ok-1", usage: { input: 5, output: 10 } });
    const c1 = s.main.request({ requestId: "m-in-model", blocks: [{ type: "text" }, { type: "text" }], dtMs: 2 * DAY });
    msg(c1.records[0] as ClaudeRecord).usage.cache_read_input_tokens = 7;
    msg(c1.records[0] as ClaudeRecord).model = "claude-opus-5-5";
    const c2 = s.main.request({ requestId: "m-out-mod", blocks: [{ type: "text" }, { type: "text" }], usage: { input: 5, output: 90 } });
    msg(c2.records[0] as ClaudeRecord).usage.speed = "standard";
    msg(c2.records[0] as ClaudeRecord).usage.inference_geo = "us";
    s.main.request({ requestId: "m-ok-2", usage: { input: 5, output: 10 }, dtMs: 3 * DAY });
    const home = new CodexHome();
    const t = new CodexThread({ threadId: "synthetic-thread-m", cliVersion: "0.160.1", model: "gpt-6-sol" });
    t.turnContext({ turnId: "mc1" });
    const bad = t.tokenUsage({ responseId: "mc-range", usage: { input: 1000, output: 10 } });
    for (const key of ["usage", "turn_token_usage"]) (bad.line.payload as any)[key].input_tokens = MAX_SAFE + 1;
    t.tokenUsage({ responseId: "mc-inv", usage: { input: 1000, output: 10, cached: 2000 }, dtMs: DAY });
    t.tokenUsage({ responseId: "mc-ok", usage: { input: 1000, output: 10 }, dtMs: 2 * DAY });
    home.add(t);
    return [...p.files(), ...home.files()];
  }

  const SAME = [
    "responses_usage_range_failed",
    "responses_bucket_mismatch",
    "requests_conflict",
    "records_unkeyed",
    "responses_usage_invariant_failed",
    "responses_model_unverified",
  ] as const;

  for (const since of [undefined, "2026-01-02", "2026-01-04"]) {
    it(`since ${since ?? "(none)"}`, async () => {
      const r = await report(mixed(), since);
      for (const pv of ["claude", "codex"] as const) {
        const c = r.view.coverage_by_provider[pv];
        const x = r.rec.coverage[pv] as Record<string, any>;
        for (const f of SAME) {
          if (pv === "claude" && f === "responses_usage_invariant_failed") continue;
          assert.equal(c[f], x[f] ?? 0, `${pv} ${f}`);
        }
        for (const k of CONFLICT_KINDS) {
          if (k === "conflict_diagnostics") continue;
          assert.equal(c.requests_conflict_by_kind[k], x["requests_conflict_by_kind"]?.[k] ?? 0, `${pv} by kind ${k}`);
        }
      }
      assert.equal(r.view.coverage_by_provider.codex.tokens_in_invalid_responses.toString(), (r.rec.coverage.codex as Record<string, any>)["tokens_in_invalid_responses"]);
    });
  }
});

// ---------------------------------------------------------------------------
// R3.4 / R3.11: table mutations give the same answer in src and in scripts/recompute
// ---------------------------------------------------------------------------

describe("table mutations: src and scripts/recompute agree (R3.4 fast with geo us, R3.11 effective date)", () => {
  type Json = Record<string, any>;
  const entry = (t: Json, id: string): Json => (t.models as Json[]).find((m) => m.id === id) as Json;

  function oneFast(): GeneratedFile[] {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-fg", version: "2.1.293", model: "claude-opus-5-5", startMs: Date.UTC(2026, 0, 1) });
    s.main.request({ requestId: "fg", finalSpeed: "fast", usage: { input: 1000, output: 1, inferenceGeo: "us" } });
    s.main.request({ requestId: "std", usage: { input: 1000, output: 1 } });
    return p.files();
  }

  async function both(table: Json) {
    return withTree(oneFast(), async (d) => {
      const found = await discover({ claudeDirs: [d.claude], codexDirs: [d.codex], env: {}, home: d.root });
      const a = await analyze(found.files, { now_ms: NOW, book: loadPriceBook(table as PricingTable) });
      const rec = recompute({ claudeDirs: [d.claude], codexDirs: [d.codex], until: new Date(NOW).toISOString(), runStartMs: NOW, table });
      const out: Record<string, { src: string; rec: string }> = {};
      for (const [i, r] of a.graph.responses.entries()) {
        const p = a.priced[i]!;
        const x = rec.responses.find((y: any) => y.key === r.key);
        out[r.key] = {
          src: p.cost.pico !== null ? p.cost.pico.toString() : String(p.modifier_reason ?? p.cost.reason),
          rec: x?.price?.priced ? String(x.price.pico) : String((x?.price as any)?.reason),
        };
      }
      return out;
    });
  }

  const base = (): Json => structuredClone(DEFAULT_TABLE) as unknown as Json;

  it("the shipped table: the fast response with geo us is priced at the fast row times 11/10 in both", async () => {
    const r = await both(base());
    assert.equal(r["fg"]?.src, "8844000000");
    assert.equal(r["fg"]?.src, r["fg"]?.rec);
  });

  it("fast.geo_us_applies false or missing: fast_geo_unverified in both, the standard response is unaffected", async () => {
    for (const how of ["false", "missing", "entry_geo_off"] as const) {
      const t = base();
      const e = entry(t, "claude-opus-5-5");
      if (how === "false") e.fast.geo_us_applies = false;
      else if (how === "missing") delete e.fast.geo_us_applies;
      else e.geo_us.applies = false;
      const r = await both(t);
      assert.equal(r["fg"]?.src, "fast_geo_unverified", how);
      assert.equal(r["fg"]?.rec, "fast_geo_unverified", how);
      assert.equal(r["std"]?.src, r["std"]?.rec, how);
    }
  });

  it("a verified_at that is not an ISO date is no effective date in either implementation", async () => {
    const t = base();
    entry(t, "claude-opus-5-5").verified_at = "n/a";
    const r = await both(t);
    assert.equal(r["std"]?.src, "unknown_model");
    assert.equal(r["std"]?.rec, "unknown_model");
    assert.equal(auditTable(t as PricingTable).some((f) => f.code === "r311_effective_date" && !f.fatal), true);
  });
});
