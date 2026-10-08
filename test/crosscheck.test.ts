// Integration: the src/ pipeline (discover, parse, graph, price, report input) against the independent
// scripts/recompute implementation, response by response, on synthetic trees (spec R13.1 to R13.3: accounting
// agreement). All data is synthetic. Nothing is read from the home directory.
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
import { buildReportInput } from "../src/report/input.ts";
import { ClaudeProject, CodexHome, CodexThread, writeFiles, type GeneratedFile } from "./fixtures/builder.ts";

const NOW = Date.UTC(2026, 5, 1);

async function both(
  files: readonly GeneratedFile[],
  opts: { since?: string; until?: string; tier?: "standard" } = {},
): Promise<{ analysis: Awaited<ReturnType<typeof analyze>>; rec: RecomputeResult }> {
  const dir = mkdtempSync(join(tmpdir(), "cw-cross-"));
  try {
    writeFiles(dir, files);
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
    });
    return { analysis, rec };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Per-response agreement on status, buckets of unpriced tokens and dollars. */
function assertAgree(analysis: Awaited<ReturnType<typeof analyze>>, rec: RecomputeResult, label: string): number {
  const byKey = new Map(rec.responses.filter((r) => r.counted).map((r) => [`${r.provider}:${r.key}`, r]));
  const counted = countedResponseIndices(analysis.graph);
  assert.equal(counted.length, byKey.size, `${label}: same set of counted responses`);
  for (const i of counted) {
    const r = analysis.graph.responses[i]!;
    const p = analysis.priced[i]!;
    const x = byKey.get(`${r.provider}:${r.key}`);
    assert.ok(x, `${label}: ${r.provider} response present in recompute`);
    const price = x.price!;
    if (price.priced) {
      assert.equal(p.cost.pico, price.lo, `${label}: usd lo`);
      assert.equal((p.cost_hi ?? p.cost).pico, price.hi, `${label}: usd hi`);
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
    assert.equal(r.kind, x.kind, `${label}: kind`);
    assert.equal(r.model.verified ? r.model.model : null, x.model ?? null, `${label}: model`);
  }
  return counted.length;
}

describe("pipeline against scripts/recompute on the committed synthetic scenarios", () => {
  for (const sc of scenarios) {
    it(`${sc.name}: every response agrees (status, buckets, kind, model, dollars)`, async () => {
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
  m.request({ requestId: "r5", usage: { input: 9, cacheRead: 100, writeTotal: 9, write1h: 7, output: 5 } });
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
  it("Claude: fast, geo, no final copy, unknown model, bucket mismatch, service tier, Haiku tiers", async () => {
    const { analysis, rec } = await both(claudeRich());
    const n = assertAgree(analysis, rec, "claude-rich");
    assert.ok(n >= 10);
    const reasons = new Set(analysis.priced.map((x) => x.modifier_reason ?? x.cost.reason));
    assert.ok(reasons.has("modifier_unverified"), "R3.12 reached");
    assert.ok(reasons.has("unknown_model"));
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
    const input = buildReportInput({
      graph: win.analysis.graph,
      parsed: win.analysis.parsed,
      priced: win.analysis.priced,
      detection: win.analysis.detection,
      book: win.analysis.book,
      options: { command: "default", json: false, show_ids: false, demo: false, color: false },
      generated_at_ms: NOW,
      tool_version: "0.0.0",
    });
    assert.equal(input.coverage.baseline_requests_loaded, nAll - nWin);
  });
});
