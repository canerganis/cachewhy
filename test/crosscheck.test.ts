// Integration: the src/ pipeline (discover, parse, graph, taint, price) against the independent scripts/recompute
// implementation, response by response, on the committed synthetic trees and on the stored R0.9 / R2.17 fixtures
// (spec R13.1 to R13.3: exact agreement on accounting, and R0.9 taint, families and live counters). All data is
// synthetic. Nothing is read from the home directory.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { scenarios } from "../scripts/gen-fixtures.ts";
import { recompute, type RecomputeResult } from "../scripts/recompute/index.mjs";
import { analyze } from "../src/analyze.ts";
import { discover } from "../src/discover.ts";
import { countedResponseIndices } from "../src/graph/index.ts";
import { chainIdOf, responseTokens, TAINT_REASONS } from "../src/model/types.ts";
import type { Provider } from "../src/model/types.ts";
import { ClaudeProject, CodexHome, CodexThread, writeFiles, type GeneratedFile } from "./fixtures/builder.ts";
import { splitAt, splitPositions } from "./fixtures/metamorphic.ts";
import { allR09Fixtures, OLD_MTIME_MS, RUN_START_MS } from "./fixtures/r09.ts";

const NOW = RUN_START_MS;
const PROVIDER_LIST: readonly Provider[] = ["claude", "codex"];

/** Files without an explicit modification time get an old one, so no file is live unless a fixture says so (R0.9). */
const stamped = (files: readonly GeneratedFile[]): GeneratedFile[] => files.map((f) => ({ ...f, mtimeMs: f.mtimeMs ?? OLD_MTIME_MS }));

async function both(
  files: readonly GeneratedFile[],
  opts: { since?: string; until?: string; tier?: "standard" } = {},
): Promise<{ analysis: Awaited<ReturnType<typeof analyze>>; rec: RecomputeResult }> {
  const dir = mkdtempSync(join(tmpdir(), "cw-cross-"));
  try {
    writeFiles(dir, stamped(files));
    const found = await discover({ claudeDirs: [join(dir, "projects")], codexDirs: [dir], env: {}, home: dir });
    const analysis = await analyze(found.files, {
      since: opts.since,
      until: opts.until,
      now_ms: NOW,
      codex_tier_for_test: opts.tier,
    });
    const rec = recompute({
      claudeDirs: [join(dir, "projects")],
      codexDirs: [dir],
      since: opts.since ?? null,
      until: opts.until ?? new Date(NOW).toISOString(),
      codexTierForTest: opts.tier,
      runStartMs: NOW,
    });
    return { analysis, rec };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VERIFIED_SOURCES = new Set(["own_turn", "carried_verified", "claude_explicit"]);

/**
 * Per-response agreement (R13.2): counted, buckets, kind, model, model_source, taint, priced or unpriced reason and
 * picodollars. Then the chain, family and live counters (R0.9 Coverage).
 */
function assertAgree(analysis: Awaited<ReturnType<typeof analyze>>, rec: RecomputeResult, label: string): number {
  const byKey = new Map(rec.responses.filter((r) => r.counted).map((r) => [`${r.provider}:${r.key}`, r]));
  const counted = countedResponseIndices(analysis.graph);
  assert.equal(counted.length, byKey.size, `${label}: same set of counted responses`);
  const taintedBy: Record<Provider, { n: number; tokens: bigint }> = { claude: { n: 0, tokens: 0n }, codex: { n: 0, tokens: 0n } };
  for (const i of counted) {
    const r = analysis.graph.responses[i]!;
    const p = analysis.priced[i]!;
    const x = byKey.get(`${r.provider}:${r.key}`);
    assert.ok(x, `${label}: ${r.provider} response present in recompute`);
    const price = x.price!;
    if (price.priced) {
      assert.equal(p.cost.pico, price.pico, `${label}: usd`);
      assert.equal(p.tokens_unpriced, 0n);
    } else {
      assert.equal(p.cost.pico, null, `${label}: unpriced in both`);
      assert.equal(p.tokens_unpriced, price.tokens_unpriced, `${label}: unpriced tokens`);
      const reason = p.modifier_reason ?? p.cost.reason;
      assert.equal(reason, price.reason, `${label}: reason`);
    }
    const u = r.usage!;
    const b = x.buckets!;
    assert.equal(u.input_uncached, b.input_uncached);
    assert.equal(u.cache_read, b.cache_read);
    assert.equal(u.cache_write_5m, b.cache_write_5m);
    assert.equal(u.cache_write_1h, b.cache_write_1h);
    assert.equal(u.cache_write_unknown_ttl, b.cache_write_unknown_ttl);
    assert.equal(u.cache_write, b.cache_write);
    assert.equal(u.output, b.output);
    assert.equal(u.output_lower_bound, b.output_lower_bound);
    assert.equal(r.kind, x.kind, `${label}: kind`);
    assert.equal(r.model.source, x.model_source, `${label}: model_source`);
    const verified = VERIFIED_SOURCES.has(x.model_source as string);
    assert.equal(r.model.verified, verified, `${label}: model verified`);
    assert.equal(r.model.verified ? r.model.model : null, verified ? (x.model ?? null) : null, `${label}: model`);
    // R0.9: the taint of the response's chain
    const t = analysis.graph.taint[r.provider].chains.get(chainIdOf(r.chain));
    assert.ok(t, `${label}: chain has a taint record`);
    assert.equal(t.tainted, x.tainted, `${label}: tainted`);
    assert.deepEqual([...t.reasons], x.taint_reasons, `${label}: taint reasons`);
    assert.equal(t.live, false);
    if (t.tainted) {
      taintedBy[r.provider].n += 1;
      taintedBy[r.provider].tokens += responseTokens(u);
      assert.equal(price.priced, false, `${label}: tainted response is unpriced`);
    }
  }
  for (const pv of PROVIDER_LIST) {
    const g = analysis.graph.coverage_by_provider[pv];
    const c = rec.coverage[pv];
    assert.equal(g.chains_total, c.chains_total, `${label}: ${pv} chains_total`);
    assert.equal(g.chains_tainted, c.chains_tainted, `${label}: ${pv} chains_tainted`);
    for (const k of TAINT_REASONS) assert.equal(g.chains_tainted_by_reason[k], c.chains_tainted_by_reason[k], `${label}: ${pv} chains_tainted_by_reason.${k}`);
    assert.equal(g.families_total, c.families_total, `${label}: ${pv} families_total`);
    assert.equal(g.families_tainted, c.families_tainted, `${label}: ${pv} families_tainted`);
    assert.equal(g.families_live_skipped, c.families_live_skipped, `${label}: ${pv} families_live_skipped`);
    assert.equal(g.responses_live_skipped, c.responses_live_skipped, `${label}: ${pv} responses_live_skipped`);
    assert.equal(g.tokens_live_skipped.toString(), c.tokens_live_skipped, `${label}: ${pv} tokens_live_skipped`);
    assert.equal(taintedBy[pv].n, c.responses_in_tainted_chains, `${label}: ${pv} responses_in_tainted_chains`);
    assert.equal(taintedBy[pv].tokens.toString(), c.tokens_in_tainted_chains, `${label}: ${pv} tokens_in_tainted_chains`);
    assert.equal(taintedBy[pv].n, c.requests_unpriced_tainted, `${label}: ${pv} requests_unpriced_tainted`);
    const live = rec.responses.filter((x) => x.provider === pv && x.live_skipped);
    assert.equal(live.length, c.responses_live_skipped);
  }
  return counted.length;
}

describe("pipeline against scripts/recompute on the committed synthetic scenarios", () => {
  for (const sc of scenarios) {
    it(`${sc.name}: every response agrees (status, buckets, kind, model, taint, dollars)`, async () => {
      const { analysis, rec } = await both(sc.build());
      const n = assertAgree(analysis, rec, sc.name);
      assert.ok(n > 0, "the scenario has counted responses");
    });
  }
});

function claudeRich(): GeneratedFile[] {
  const p = new ClaudeProject();
  const s = p.session({ sessionId: "synthetic-session-rich", version: "2.1.293", model: "claude-opus-5-5", startMs: Date.UTC(2026, 0, 1) });
  const m = s.main;
  m.user();
  m.request({ requestId: "r1", usage: { input: 5, write5m: 20000, output: 300 }, blocks: [{ type: "thinking" }, { type: "text" }] });
  m.request({ requestId: "r2", usage: { input: 8, cacheRead: 20000, write1h: 1500, output: 120 }, finalSpeed: "fast" });
  m.request({ requestId: "r3", usage: { input: 8, cacheRead: 21500, write1h: 500, output: 20, inferenceGeo: "us" }, finalSpeed: "fast" });
  m.request({ requestId: "r4", usage: { input: 8, cacheRead: 22000, write5m: 400, output: 20 }, finalSpeed: null, blocks: [{ type: "text" }, { type: "text" }] });
  m.request({ requestId: "r6", model: "claude-future-9", usage: { input: 40, write5m: 100, output: 7 } });
  m.request({ requestId: "r7", usage: { input: 3, write5m: 50, output: 7, serviceTier: "priority" } });
  m.request({ requestId: "r8", usage: { input: 3, write5m: 50, output: 7, omitCacheCreation: true, writeTotal: 50 } });
  const { agent } = s.spawnAgent({ spawnDepth: 1, model: "haiku" });
  agent.thread.request({ requestId: "a1", model: "claude-haiku-5-5", usage: { input: 60000, write5m: 50000, output: 200 } });
  agent.thread.request({ requestId: "a2", model: "claude-haiku-5-5", usage: { input: 10, cacheRead: 110000, write5m: 300, output: 50 } });
  return p.files();
}

function codexRich(): GeneratedFile[] {
  const home = new CodexHome();
  const parent = new CodexThread({ threadId: "synthetic-thread-rp", threadSource: "user", cliVersion: "0.160.1", model: "gpt-6-sol" });
  parent.turnContext({ turnId: "tp1" });
  parent.tokenUsage({ responseId: "p1", usage: { input: 100000, cached: 0, cacheWrite: 10000, output: 300 } });
  parent.tokenUsage({ responseId: "p2", usage: { input: 300000, cached: 100000, output: 500, reasoning: 100 } });
  parent.turnContext({ turnId: "tp2", model: "gpt-5.5" });
  parent.tokenUsage({ responseId: "p3", usage: { input: 1000, cached: 500, output: 50 } });
  home.add(parent);
  const fork = CodexThread.fork(parent, { threadId: "synthetic-thread-rf", threadSource: "user", prefixLen: 2 });
  fork.turnContext({ turnId: "tf1", model: "gpt-6-luna" });
  fork.tokenUsage({ responseId: "f1", usage: { input: 5000, cached: 4000, output: 80 } });
  fork.tokenUsage({ responseId: "f2", usage: { input: 5200, cached: 5000, output: 90 }, turnId: "tf-none" });
  home.add(fork);
  const unsettled = new CodexThread({ threadId: "synthetic-thread-ru", threadSource: "automation", cliVersion: "0.160.1", model: "gpt-6-luna" });
  unsettled.turnContext({ turnId: "tu1" });
  unsettled.eventMsg("thread_settings_applied");
  unsettled.tokenUsage({ responseId: "u1", usage: { input: 700, cached: 100, output: 10 } });
  home.add(unsettled);
  return home.files();
}

describe("pipeline against scripts/recompute on richer synthetic trees", () => {
  it("Claude: fast, geo, no final copy, unknown model, service tier, Haiku tiers, unknown TTL", async () => {
    const { analysis, rec } = await both(claudeRich());
    const n = assertAgree(analysis, rec, "claude-rich");
    assert.ok(n >= 10);
    const reasons = new Set(analysis.priced.map((x) => x.modifier_reason ?? x.cost.reason));
    assert.ok(reasons.has("modifier_unverified"), "R3.12 reached");
    assert.ok(reasons.has("unknown_model"));
    assert.ok(reasons.has("bucket_unknown"), "R3.5 reached");
    assert.ok(analysis.priced.some((x) => x.cost.pico !== null), "some dollars");
  });

  it("Codex: default run gives no dollars (R3.4 gate); the test tier parameter prices request-scoped models", async () => {
    const files = codexRich();
    const def = await both(files);
    assertAgree(def.analysis, def.rec, "codex-rich default");
    assert.ok(def.analysis.priced.every((x) => x.cost.pico === null));
    const tier = await both(files, { tier: "standard" });
    assertAgree(tier.analysis, tier.rec, "codex-rich tier");
    assert.ok(tier.analysis.priced.some((x) => x.cost.pico !== null));
    // gpt-5.5 has a session scope in the shipped table: long_context_scope under the tier parameter
    assert.ok(tier.analysis.priced.some((x) => x.modifier_reason === "long_context_scope"));
  });

  it("window: a response before since is baseline and adds nothing (R5.10), in both implementations", async () => {
    const files = claudeRich();
    const all = await both(files);
    const cut = "2026-01-01T00:00:05Z";
    const win = await both(files, { since: cut });
    assertAgree(win.analysis, win.rec, "windowed");
    const nAll = countedResponseIndices(all.analysis.graph).length;
    const nWin = countedResponseIndices(win.analysis.graph).length;
    assert.ok(nWin < nAll, "fewer responses in the window");
    assert.equal(win.rec.coverage.claude["baseline_requests_loaded"], nAll - nWin);
  });
});

describe("pipeline against scripts/recompute on the stored R0.9 and R2.17 fixtures", () => {
  for (const fx of allR09Fixtures()) {
    it(`${fx.name} (${fx.rules}): unsplit and at every split position`, async () => {
      const { analysis, rec } = await both(fx.files, { tier: "standard" });
      assertAgree(analysis, rec, `${fx.name} unsplit`);
      for (const path of fx.splittable) {
        const idx = fx.files.findIndex((f) => f.path === path);
        const file = fx.files[idx]!;
        const provider = path.startsWith("projects/") ? "claude" : "codex";
        for (const at of splitPositions(file, provider)) {
          const halves = splitAt(file, at, provider)!;
          const files = [...fx.files.slice(0, idx), ...halves, ...fx.files.slice(idx + 1)];
          const r = await both(files, { tier: "standard" });
          assertAgree(r.analysis, r.rec, `${fx.name} ${path} at ${at}`);
        }
      }
    });
  }
});

describe("G1 round 1: copies without message.usage take part in the identity and model checks of both implementations (R4.1, R4.2, R13.2)", () => {
  const V = "2.1.293";
  const build = (edit: (records: Array<Record<string, any>>) => void): GeneratedFile[] => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-uc", version: V, model: "claude-opus-5-5", startMs: Date.UTC(2026, 0, 1) });
    s.main.user();
    s.main.request({ requestId: "clean", usage: { input: 5, write5m: 2000, output: 30 } });
    const a = s.main.request({ requestId: "r1", usage: { input: 9, cacheRead: 2000, output: 40 }, blocks: [{ type: "text" }, { type: "text" }] });
    edit(a.records as Array<Record<string, any>>);
    s.main.request({ requestId: "after", usage: { input: 3, cacheRead: 2100, output: 20 } });
    return p.files();
  };
  const statusOf = (rec: RecomputeResult, key: string): string => (rec.responses.find((r) => r.provider === "claude" && r.key === key)?.status ?? "absent");

  it("a usage-less copy with another model is conflict_model in both: no verified model, no dollars, tainted", async () => {
    const files = build((rs) => {
      delete rs[0]!.message.usage;
      rs[0]!.message.model = "claude-haiku-5-5";
    });
    const { analysis, rec } = await both(files);
    assert.equal(statusOf(rec, "r1"), "excluded:conflict_model");
    assertAgree(analysis, rec, "usage-less model conflict");
    const clean = analysis.graph.responses.findIndex((r) => r.key === "clean");
    assert.equal(analysis.priced[clean]!.cost.pico, null, "the chain is tainted, nothing is priced");
    assert.ok(rec.responses.find((r) => r.key === "clean")!.tainted);
  });

  it("a usage-less copy with another message id is key_conflict in both", async () => {
    const files = build((rs) => {
      delete rs[0]!.message.usage;
      rs[0]!.message.id = "synthetic-other-message";
    });
    const { analysis, rec } = await both(files);
    assert.equal(statusOf(rec, "r1"), "excluded:key_conflict");
    assertAgree(analysis, rec, "usage-less message id conflict");
  });

  it("a request whose copies all lack usage is usage_incomplete in both and taints the chain", async () => {
    const files = build((rs) => {
      for (const r of rs) delete r.message.usage;
    });
    const { analysis, rec } = await both(files);
    assert.equal(statusOf(rec, "r1"), "excluded:usage_incomplete");
    assertAgree(analysis, rec, "all copies without usage");
    assert.ok(rec.responses.find((r) => r.key === "clean")!.taint_reasons.includes("request_anomaly"));
  });

  it("a final copy without output_tokens is usage_incomplete in both implementations (R2.12)", async () => {
    const files = build((rs) => {
      delete rs[1]!.message.usage.output_tokens;
    });
    const { analysis, rec } = await both(files);
    assert.equal(statusOf(rec, "r1"), "excluded:usage_incomplete");
    assertAgree(analysis, rec, "final copy without output");
  });

  it("iterations[0] on the second of two final copies is a conflict in both: output unknown, tainted", async () => {
    const files = build((rs) => {
      const [c0, c1] = rs as [Record<string, any>, Record<string, any>];
      const u1 = c1.message.usage;
      u1.iterations = [{ input_tokens: u1.input_tokens, output_tokens: u1.output_tokens, cache_read_input_tokens: u1.cache_read_input_tokens, cache_creation_input_tokens: u1.cache_creation_input_tokens }];
      c0.message.usage.output_tokens = u1.output_tokens;
      c0.message.usage.speed = u1.speed;
      c0.message.usage.iterations = structuredClone(u1.iterations);
      u1.iterations[0].input_tokens += 1;
    });
    const { analysis, rec } = await both(files);
    const x = rec.responses.find((r) => r.key === "r1")!;
    assert.equal(x.buckets!.output, null, "recompute: output unknown");
    assertAgree(analysis, rec, "iterations on the second final copy");
  });

  it("a copy without sessionId and of an unverified version makes the key unverified in both", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-uc2", version: V, startMs: Date.UTC(2026, 0, 1) });
    s.main.request({ requestId: "clean", usage: { input: 5, write5m: 2000, output: 30 } });
    const a = s.main.request({ requestId: "r1", usage: { input: 9, cacheRead: 2000, output: 40 }, blocks: [{ type: "text" }, { type: "text" }] });
    const stray = structuredClone(a.records[1]!);
    delete (stray as Record<string, unknown>).sessionId;
    (stray as Record<string, unknown>).version = "2.1.290";
    s.main.records.push(stray);
    const { analysis, rec } = await both(p.files());
    assert.equal(rec.responses.some((r) => r.key === "r1" && r.counted), false, "recompute: r1 is not accounted");
    assert.equal(analysis.graph.responses.some((r) => r.key === "r1"), false, "src: r1 is not accounted");
    assertAgree(analysis, rec, "stray unverified copy");
  });
});

describe("G1 round 1: logical record counters use the full retained projection in both implementations (R4.12, R17.6)", () => {
  const files = (variant: (o: Record<string, any>) => void, kind: "unkeyed" | "api_error"): GeneratedFile[] => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-id", version: "2.1.293", model: "claude-opus-5-5", startMs: Date.UTC(2026, 0, 1) });
    s.main.request({ requestId: "clean", usage: { input: 5, write5m: 2000, output: 30 } });
    const records: Array<Record<string, any>> = [];
    for (let k = 0; k < 2; k++) {
      const r = s.main.request(kind === "api_error" ? { requestId: "synthetic-e", apiError: true } : { requestId: "synthetic-u", usage: { input: 5, write5m: 100, output: 10 } });
      records.push(...(r.records as Array<Record<string, any>>));
    }
    records.forEach((o, k) => {
      if (kind === "unkeyed") delete o.requestId;
      o.uuid = "synthetic-same-uuid";
      o.parentUuid = "synthetic-same-parent";
      o.timestamp = new Date(Date.UTC(2026, 0, 1, 0, 1)).toISOString();
      o.message.id = "synthetic-same-message";
      if (k === 1) variant(o);
    });
    return p.files();
  };
  const cases: Array<[string, (o: Record<string, any>) => void, number]> = [
    ["equal projections", () => {}, 1],
    ["different effort", (o) => (o.effort = "high"), 2],
    ["different stop reason", (o) => (o.message.stop_reason = "refusal"), 2],
    ["different usage", (o) => { if (o.message.usage) o.message.usage.output_tokens = 11; else o.message.stop_reason = "end_turn"; }, 2],
  ];
  for (const kind of ["unkeyed", "api_error"] as const) {
    for (const [name, variant, expected] of cases) {
      it(`${kind}: ${name} counts ${expected} in src and in recompute`, async () => {
        const { analysis, rec } = await both(files(variant, kind));
        const field = kind === "unkeyed" ? "records_unkeyed" : "api_error_records";
        const src = analysis.claude!.coverage[field as "records_unkeyed"];
        assert.equal(src, expected, "src");
        assert.equal(rec.coverage.claude[field], expected, "recompute");
      });
    }
  }
});
