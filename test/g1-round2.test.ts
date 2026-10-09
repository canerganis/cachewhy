// G1 round 2 regressions (Sol G1 audit, round 2). Each case runs src/ and scripts/recompute on the same synthetic tree
// and compares them (R13.2). All data is synthetic (test/fixtures/builder.ts); nothing is read from the home directory.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { recompute, type RecomputeResult } from "../scripts/recompute/index.mjs";
import { analyze } from "../src/analyze.ts";
import { discover } from "../src/discover.ts";
import { countedResponseIndices } from "../src/graph/index.ts";
import { buildReportInput } from "../src/report/input.ts";
import { ClaudeProject, CodexHome, CodexThread, writeFiles, type GeneratedFile } from "./fixtures/builder.ts";
import { OLD_MTIME_MS, RUN_START_MS } from "./fixtures/r09.ts";

const NOW = RUN_START_MS;
const T0 = Date.UTC(2026, 0, 1);

async function both(files: readonly GeneratedFile[], opts: { since?: string; until?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cw-g1r2-"));
  try {
    writeFiles(dir, files.map((f) => ({ ...f, mtimeMs: f.mtimeMs ?? OLD_MTIME_MS })));
    const found = await discover({ claudeDirs: [join(dir, "projects")], codexDirs: [dir], env: {}, home: dir });
    const analysis = await analyze(found.files, { since: opts.since, until: opts.until, now_ms: NOW, codex_tier_for_test: "standard" });
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
    const rec: RecomputeResult = recompute({
      claudeDirs: [join(dir, "projects")],
      codexDirs: [dir],
      since: opts.since ?? null,
      until: opts.until ?? new Date(NOW).toISOString(),
      codexTierForTest: "standard",
      runStartMs: NOW,
    });
    return { analysis, view, rec };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();
const statusOf = (rec: RecomputeResult, key: string): string => rec.responses.find((r) => r.key === key)?.status ?? "absent";

describe("G1 round 2, finding 1: the event time of a Claude request is the minimum over every copy (R4.2, R5.9, R6.3)", () => {
  // The owner stream (earliest stream start) holds the copy at +600 s; the replaying stream holds the same request at
  // +300 s. The request time is +300 s whoever owns it, so the window [+200 s, +400 s) holds it.
  const build = (): GeneratedFile[] => {
    const p = new ClaudeProject();
    const a = p.session({ sessionId: "synthetic-session-a", version: "2.1.293", model: "claude-opus-5-5", startMs: T0 });
    a.main.user();
    const ra = a.main.request({ requestId: "ra1", usage: { input: 5, write5m: 1000, output: 10 } });
    const b = p.session({ sessionId: "synthetic-session-b", version: "2.1.293", model: "claude-opus-5-5", startMs: T0 + 250_000 });
    b.main.user();
    b.main.replay(ra.records.map((r) => ({ ...structuredClone(r), sessionId: "synthetic-session-b", timestamp: iso(T0 + 300_000) })));
    for (const r of ra.records) r.timestamp = iso(T0 + 600_000);
    return p.files();
  };
  const since = iso(T0 + 200_000);
  const until = iso(T0 + 400_000);

  it("src and recompute both count the request inside the window", async () => {
    const { analysis, rec } = await both(build(), { since, until });
    const srcKeys = countedResponseIndices(analysis.graph).map((i) => analysis.graph.responses[i]!.key);
    assert.deepEqual(srcKeys, ["ra1"], "src counts ra1 in [+200 s, +400 s)");
    assert.deepEqual(rec.responses.filter((r) => r.counted).map((r) => r.key), ["ra1"], "recompute counts ra1");
    const r = analysis.graph.responses.find((x) => x.key === "ra1" && x.ownership.role === "owner")!;
    assert.equal(r.time.event_ms, T0 + 300_000);
    assert.equal(r.time.t_first_ms, T0 + 300_000);
    assert.equal(r.time.t_last_ms, T0 + 600_000);
    const rep = analysis.graph.responses.find((x) => x.key === "ra1" && x.ownership.role === "replayed")!;
    assert.equal(rep.time.event_ms, T0 + 300_000, "the replayed representation carries the same time");
    assert.equal(rep.time.t_last_ms, T0 + 600_000);
  });

  it("a window that holds only the owner copy time (+600 s) does not hold the request", async () => {
    const { analysis, rec } = await both(build(), { since: iso(T0 + 500_000), until: iso(T0 + 700_000) });
    assert.equal(countedResponseIndices(analysis.graph).length, 0);
    assert.equal(rec.responses.filter((r) => r.counted).length, 0);
  });
});

describe("G1 round 2, finding 2: every integer member of iterations[0] is range checked (R1.2, R2.15)", () => {
  const build = (member: string, value: number): GeneratedFile[] => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-it", version: "2.1.293", model: "claude-opus-5-5", startMs: T0 });
    s.main.user();
    s.main.request({ requestId: "clean", usage: { input: 5, write5m: 2000, output: 30 } });
    const a = s.main.request({ requestId: "r1", usage: { input: 9, cacheRead: 2000, output: 40 }, blocks: [{ type: "text" }, { type: "text" }] });
    const recs = a.records as Array<Record<string, any>>;
    const final = recs[recs.length - 1]!;
    const u = final.message.usage;
    u.iterations = [{ input_tokens: u.input_tokens, output_tokens: u.output_tokens, [member]: value }];
    return p.files();
  };
  for (const [member, value] of [
    ["total_tokens", -1],
    ["some_other_counter", Number.MAX_SAFE_INTEGER + 2],
  ] as const) {
    it(`${member} = ${value} makes the response usage_range_failed in both and taints its chain`, async () => {
      const { analysis, rec, view } = await both(build(member, value));
      assert.equal(statusOf(rec, "r1"), "excluded:usage_range_failed");
      assert.equal(analysis.graph.responses.some((r) => r.key === "r1" && r.exclusion === null), false, "src: r1 is not accounted");
      assert.equal(view.coverage_by_provider.claude.responses_usage_range_failed, 1);
      assert.equal(rec.coverage.claude["responses_usage_range_failed"], 1);
      assert.ok(rec.responses.find((r) => r.key === "clean")!.taint_reasons.includes("request_anomaly"));
      const clean = analysis.graph.responses.findIndex((r) => r.key === "clean");
      assert.equal(analysis.priced[clean]!.cost.pico, null, "the chain is tainted, nothing is priced");
    });
  }
  it("an in-range extra member changes nothing", async () => {
    const { rec, view } = await both(build("total_tokens", 49));
    assert.equal(statusOf(rec, "r1"), "counted");
    assert.equal(view.coverage_by_provider.claude.responses_usage_range_failed, 0);
  });
});

describe("G1 round 2, finding 3: an unusable context model blocks carried_verified in both (R2.17 (b), (c))", () => {
  const build = (badTurn: boolean): GeneratedFile[] => {
    const home = new CodexHome();
    const t = new CodexThread({ threadId: "synthetic-thread-m", threadSource: "user", cliVersion: "0.160.1", model: "gpt-6-sol" });
    t.turnContext({ turnId: "t1", model: "gpt-6-sol" });
    t.tokenUsage({ responseId: "c1", usage: { input: 1000, cached: 0, output: 10 }, turnId: "t1" });
    t.turnContext({ turnId: "t2", model: "Not A Model!" });
    if (badTurn) t.tokenUsage({ responseId: "c2", usage: { input: 1100, cached: 500, output: 10 }, turnId: "t2" });
    t.tokenUsage({ responseId: "c3", usage: { input: 1200, cached: 600, output: 10 }, turnId: "t3-none" });
    home.add(t);
    return home.files();
  };
  for (const bad of [false, true]) {
    it(`${bad ? "a response of the unusable-model turn" : "a response of a turn without a context"} is not verified in either`, async () => {
      const { analysis, rec } = await both(build(bad));
      for (const key of bad ? ["c2", "c3"] : ["c3"]) {
        const x = rec.responses.find((r) => r.key === key)!;
        const i = analysis.graph.responses.findIndex((r) => r.key === key);
        const r = analysis.graph.responses[i]!;
        assert.equal(r.model.verified, false, `src: ${key} not verified`);
        assert.equal(x.model_source === "own_turn" || x.model_source === "carried_verified", false, `recompute: ${key} not verified`);
        assert.equal(r.model.source, x.model_source, `${key}: same model_source`);
      }
    });
  }
});

describe("G1 round 2, finding 4: conflicting Codex copies get one time whatever the file order (R4.10, R5.9, R17.6)", () => {
  // Two threads log one response id (a conflict). One occurrence lies inside the window, the other outside. The request
  // time is the minimum over the occurrences, so the window holds the conflict in both file orders.
  const build = (swap: boolean): GeneratedFile[] => {
    const home = new CodexHome();
    const x = new CodexThread({ threadId: "synthetic-thread-x", sessionId: "synthetic-sess-1", threadSource: "user", cliVersion: "0.160.1", model: "gpt-6-sol" });
    x.turnContext({ turnId: "tx" });
    x.tokenUsage({ responseId: "dup", usage: { input: 1000, output: 10 }, turnId: "tx", dtMs: 100_000 });
    const y = new CodexThread({ threadId: "synthetic-thread-y", sessionId: "synthetic-sess-1", threadSource: "user", cliVersion: "0.160.1", model: "gpt-6-sol" });
    y.clock.set(T0 + 10_000_000);
    y.turnContext({ turnId: "ty" });
    y.tokenUsage({ responseId: "dup", usage: { input: 1000, output: 10 }, turnId: "ty", dtMs: 100_000 });
    home.add(x);
    home.add(y);
    const files = home.files();
    // the two files swap their names, so the discovery order changes and nothing else does
    if (swap) {
      const [f0, f1] = [files[0]!, files[1]!];
      const p0 = f0.path;
      f0.path = f1.path;
      f1.path = p0;
    }
    return files;
  };
  const xs = new CodexThread({ threadId: "synthetic-thread-x" });
  const since = iso(xs.clock.now() - 1);
  const until = iso(T0 + 3_600_000);

  it("requests_conflict and the kinds agree between src and recompute and between both file orders", async () => {
    const a = await both(build(false), { since, until });
    const b = await both(build(true), { since, until });
    const cA = a.view.coverage_by_provider.codex;
    const cB = b.view.coverage_by_provider.codex;
    assert.equal(cA.requests_conflict, 1, "src: the conflict is inside the window");
    assert.equal(cB.requests_conflict, 1, "src, swapped files");
    assert.equal(a.rec.coverage.codex["requests_conflict"], 1, "recompute");
    assert.equal(b.rec.coverage.codex["requests_conflict"], 1, "recompute, swapped files");
    assert.deepEqual(a.rec.coverage.codex["requests_conflict_by_kind"], b.rec.coverage.codex["requests_conflict_by_kind"]);
    assert.equal(cA.requests_conflict_by_kind.conflict_attribution, 1);
    assert.equal(cB.requests_conflict_by_kind.conflict_attribution, 1);
    assert.deepEqual(a.rec.coverage.codex["requests_conflict_by_kind"], { conflict_attribution: 1 });
  });
});

describe("G1 round 2, finding 5: the cumulative counters take part in record equality (R1.2, R4.4, R4.12)", () => {
  const build = (mutate: ((payload: Record<string, any>) => void) | null): GeneratedFile[] => {
    const home = new CodexHome();
    const t = new CodexThread({ threadId: "synthetic-thread-q", threadSource: "user", cliVersion: "0.160.1", model: "gpt-6-sol" });
    t.turnContext({ turnId: "tq" });
    t.tokenUsage({ responseId: "clean", usage: { input: 1000, output: 10 }, turnId: "tq" });
    const first = t.tokenUsage({ responseId: "q1", usage: { input: 2000, output: 20 }, turnId: "tq" }).line;
    if (mutate !== null) {
      const dup = structuredClone(first);
      mutate(dup.payload as Record<string, any>);
      t.lines.push(dup);
    }
    home.add(t);
    return home.files();
  };
  it("an exact duplicate is one record (no conflict)", async () => {
    const { rec, view } = await both(build((p) => void p));
    assert.equal(statusOf(rec, "q1"), "counted");
    assert.equal(view.coverage_by_provider.codex.requests_conflict, 0);
  });
  for (const [name, mutate] of [
    ["thread_token_usage.input_tokens", (p: Record<string, any>) => (p["thread_token_usage"].input_tokens += 1)],
    ["thread_token_usage.reasoning_output_tokens", (p: Record<string, any>) => (p["thread_token_usage"].reasoning_output_tokens += 1)],
    ["turn_token_usage.cached_input_tokens", (p: Record<string, any>) => (p["turn_token_usage"] = { ...p["turn_token_usage"], cached_input_tokens: 5 })],
  ] as const) {
    it(`a second occurrence that differs only in ${name} is conflict_attribution in both`, async () => {
      const { analysis, rec, view } = await both(build(mutate));
      assert.equal(statusOf(rec, "q1"), "excluded:conflict_attribution");
      assert.equal(view.coverage_by_provider.codex.requests_conflict, 1);
      assert.equal(view.coverage_by_provider.codex.requests_conflict_by_kind.conflict_attribution, 1);
      assert.equal(rec.coverage.codex["requests_conflict"], 1);
      const q1 = analysis.graph.responses.filter((r) => r.key === "q1");
      assert.ok(q1.length > 0 && q1.every((r) => r.exclusion === "conflict_attribution"));
      const clean = analysis.graph.responses.findIndex((r) => r.key === "clean");
      assert.equal(analysis.priced[clean]!.cost.pico, null, "the thread is tainted: nothing is priced");
    });
  }
});
