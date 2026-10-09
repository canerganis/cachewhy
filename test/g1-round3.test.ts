// G1 round 3 regressions (Sol G1 audit, round 3). Each case runs src/ and scripts/recompute on the same synthetic tree
// and compares them (R13.2). All data is synthetic (test/fixtures/builder.ts); nothing is read from the home directory.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { recompute, type RecomputeResult } from "../scripts/recompute/index.mjs";
import { analyze } from "../src/analyze.ts";
import { discover } from "../src/discover.ts";
import { buildReportInput } from "../src/report/input.ts";
import { ClaudeProject, CodexHome, CodexThread, writeFiles, type GeneratedFile } from "./fixtures/builder.ts";
import { OLD_MTIME_MS, RUN_START_MS } from "./fixtures/r09.ts";

const NOW = RUN_START_MS;
const T0 = Date.UTC(2026, 0, 1);

async function both(files: readonly GeneratedFile[]) {
  const dir = mkdtempSync(join(tmpdir(), "cw-g1r3-"));
  try {
    writeFiles(dir, files.map((f) => ({ ...f, mtimeMs: f.mtimeMs ?? OLD_MTIME_MS })));
    const found = await discover({ claudeDirs: [join(dir, "projects")], codexDirs: [dir], env: {}, home: dir });
    const analysis = await analyze(found.files, { now_ms: NOW, codex_tier_for_test: "standard" });
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
      since: null,
      until: new Date(NOW).toISOString(),
      codexTierForTest: "standard",
      runStartMs: NOW,
    });
    return { analysis, view, rec };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const statusOf = (rec: RecomputeResult, key: string): string => rec.responses.find((r) => r.key === key)?.status ?? "absent";

describe("G1 round 3, finding 1: Claude copies are compared on the normalized model (R3.3, R4.2, R13.2)", () => {
  const build = (m0: string, m1: string): GeneratedFile[] => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-m", version: "2.1.293", model: "claude-opus-5-5", startMs: T0 });
    s.main.user();
    s.main.request({ requestId: "clean", usage: { input: 5, write5m: 2000, output: 30 } });
    const a = s.main.request({ requestId: "r1", usage: { input: 9, cacheRead: 2000, output: 40 }, blocks: [{ type: "text" }, { type: "text" }] });
    const rs = a.records as Array<Record<string, any>>;
    rs[0]!.message.model = m0;
    rs[1]!.message.model = m1;
    return p.files();
  };

  it("a dated and an undated copy of one model are one response with equal buckets and picodollars", async () => {
    const dated = await both(build("claude-opus-5-5", "claude-opus-5-5-20261009"));
    const plain = await both(build("claude-opus-5-5", "claude-opus-5-5"));
    for (const x of [dated, plain]) {
      assert.equal(statusOf(x.rec, "r1"), "counted");
      const i = x.analysis.graph.responses.findIndex((r) => r.key === "r1");
      assert.ok(i >= 0, "src counts r1");
      const r = x.analysis.graph.responses[i]!;
      const y = x.rec.responses.find((q) => q.key === "r1")!;
      assert.equal(r.exclusion, null);
      assert.equal(r.model.model, "claude-opus-5-5");
      assert.equal(y.model, "claude-opus-5-5");
      const b = y.buckets!;
      assert.equal(r.usage!.input_uncached, b.input_uncached);
      assert.equal(r.usage!.cache_read, b.cache_read);
      assert.equal(r.usage!.cache_write_5m, b.cache_write_5m);
      assert.equal(r.usage!.cache_write_1h, b.cache_write_1h);
      assert.equal(r.usage!.output, b.output);
      const price = y.price!;
      assert.equal(price.priced, true);
      assert.notEqual(x.analysis.priced[i]!.cost.pico, null);
      assert.equal(x.analysis.priced[i]!.cost.pico, price.pico, "picodollars equal across implementations");
      assert.equal(x.view.coverage_by_provider.claude.requests_conflict, 0);
    }
    const i1 = dated.analysis.graph.responses.findIndex((r) => r.key === "r1");
    const i2 = plain.analysis.graph.responses.findIndex((r) => r.key === "r1");
    assert.equal(dated.analysis.priced[i1]!.cost.pico, plain.analysis.priced[i2]!.cost.pico, "the date suffix changes nothing");
    assert.equal(dated.rec.responses.find((q) => q.key === "clean")!.tainted, false, "no anomaly, no taint");
  });

  it("two different models are still conflict_model in both", async () => {
    const x = await both(build("claude-opus-5-5", "claude-haiku-5-5-20261009"));
    assert.equal(statusOf(x.rec, "r1"), "excluded:conflict_model");
    assert.equal(x.view.coverage_by_provider.claude.requests_conflict_by_kind.conflict_model, 1);
    assert.equal(x.rec.coverage.claude["requests_conflict"], 1);
  });

  it("two copies that are no model id are one `unlisted` model in both (no conflict, no dollars)", async () => {
    const x = await both(build("Not A Model One!", "Not A Model Two!"));
    assert.equal(statusOf(x.rec, "r1"), "counted");
    assert.equal(x.view.coverage_by_provider.claude.requests_conflict, 0);
    const i = x.analysis.graph.responses.findIndex((r) => r.key === "r1");
    assert.equal(x.analysis.priced[i]!.cost.pico, null, "src: unlisted is no table row");
    assert.equal(x.rec.responses.find((q) => q.key === "r1")!.price!.priced, false, "recompute: unlisted is no table row");
  });
});

describe("G1 round 3, finding 2: the Codex retained projection holds only typed values (R1.1, R1.2, R4.12)", () => {
  const withDup = (type: "turn_context" | "token_usage_record", mutateA: (p: Record<string, any>) => void, mutateB: (p: Record<string, any>) => void): GeneratedFile[] => {
    const home = new CodexHome();
    const t = new CodexThread({ threadId: "synthetic-thread-t", threadSource: "user", cliVersion: "0.160.1", model: "gpt-6-sol" });
    t.turnContext({ turnId: "t1" });
    t.tokenUsage({ responseId: "clean", usage: { input: 1000, output: 10 }, turnId: "t1" });
    const line = type === "turn_context" ? t.turnContext({ turnId: "t2" }) : t.tokenUsage({ responseId: "q1", usage: { input: 2000, output: 20 }, turnId: "t1" }).line;
    const twin = structuredClone(line);
    mutateA(line.payload as Record<string, any>);
    mutateB(twin.payload as Record<string, any>);
    t.lines.push(twin); // same envelope and ordinal, so R4.12 (b) compares the two projections
    t.tokenUsage({ responseId: "tail", usage: { input: 10, output: 1 }, turnId: "t1" });
    home.add(t);
    return home.files();
  };
  const reasons = (x: Awaited<ReturnType<typeof both>>): string[] => x.rec.responses.find((r) => r.key === "clean")!.taint_reasons;

  it("effort values outside the enum are one `other`: same ordinal, no collision, in both", async () => {
    const x = await both(withDup("turn_context", (p) => (p["effort"] = "private-effort-one"), (p) => (p["effort"] = "private-effort-two")));
    assert.equal(reasons(x).includes("ordinal_unverified"), false, "recompute");
    const t = x.analysis.graph.taint.codex;
    assert.equal([...t.chains.values()].some((c) => c.reasons.includes("ordinal_unverified")), false, "src");
  });

  it("unusable model strings are one null model: same ordinal, no collision, in both", async () => {
    const x = await both(withDup("turn_context", (p) => (p["model"] = "Private Model One"), (p) => (p["model"] = "Private Model Two")));
    assert.equal(reasons(x).includes("ordinal_unverified"), false, "recompute");
    const t = x.analysis.graph.taint.codex;
    assert.equal([...t.chains.values()].some((c) => c.reasons.includes("ordinal_unverified")), false, "src");
  });

  it("control: two enum members still collide (the projection compares the typed value)", async () => {
    const x = await both(withDup("turn_context", (p) => (p["effort"] = "low"), (p) => (p["effort"] = "high")));
    assert.equal(reasons(x).includes("ordinal_unverified"), true, "recompute");
    const t = x.analysis.graph.taint.codex;
    assert.equal([...t.chains.values()].some((c) => c.reasons.includes("ordinal_unverified")), true, "src");
  });

  it("out-of-range cumulative members are one range state: an equal duplicate, not a conflict, in both", async () => {
    const mut = (v: number) => (p: Record<string, any>) => (p["thread_token_usage"]["input_tokens"] = v);
    const x = await both(withDup("token_usage_record", mut(-1), mut(-7)));
    assert.equal(statusOf(x.rec, "q1"), "counted");
    assert.equal(x.view.coverage_by_provider.codex.requests_conflict, 0);
    assert.equal(x.rec.coverage.codex["requests_conflict"], 0);
  });

  it("in-range cumulative members that differ stay a conflict_attribution in both", async () => {
    const mut = (v: number) => (p: Record<string, any>) => (p["thread_token_usage"]["input_tokens"] = v);
    const x = await both(withDup("token_usage_record", mut(11), mut(12)));
    assert.equal(statusOf(x.rec, "q1"), "excluded:conflict_attribution");
    assert.equal(x.view.coverage_by_provider.codex.requests_conflict, 1);
  });
});

describe("G1 round 3, finding 3: every integer member of iterations[0] takes part in record identity (R1.2, R4.12, R17.6)", () => {
  const files = (a: Record<string, number>, b: Record<string, number>): GeneratedFile[] => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-it", version: "2.1.293", model: "claude-opus-5-5", startMs: T0 });
    s.main.request({ requestId: "clean", usage: { input: 5, write5m: 2000, output: 30 } });
    const records: Array<Record<string, any>> = [];
    for (let k = 0; k < 2; k++) {
      const r = s.main.request({ requestId: "synthetic-u", usage: { input: 5, write5m: 100, output: 10 } });
      records.push(...(r.records as Array<Record<string, any>>));
    }
    records.forEach((o, k) => {
      delete o.requestId;
      o.uuid = "synthetic-same-uuid";
      o.parentUuid = "synthetic-same-parent";
      o.timestamp = new Date(Date.UTC(2026, 0, 1, 0, 1)).toISOString();
      o.message.id = "synthetic-same-message";
      const u = o.message.usage;
      if (u) {
        const shared = { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cache_read_input_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens };
        u.iterations = [{ ...shared, ...(k === 0 ? a : b) }];
      }
    });
    return p.files();
  };
  const cases: Array<[string, Record<string, number>, Record<string, number>, number]> = [
    ["equal members", { thinking_tokens: 4 }, { thinking_tokens: 4 }, 1],
    ["only thinking_tokens differs", { thinking_tokens: 4 }, { thinking_tokens: 5 }, 2],
    ["a member present in one copy only", {}, { thinking_tokens: 5 }, 2],
    ["member order does not matter", { a_extra: 1, b_extra: 2 }, { b_extra: 2, a_extra: 1 }, 1],
    ["two unlisted members swapped", { a_extra: 1, b_extra: 2 }, { a_extra: 2, b_extra: 1 }, 2],
  ];
  for (const [name, a, b, expected] of cases) {
    it(`${name}: records_unkeyed is ${expected} in src and in recompute`, async () => {
      const { analysis, rec } = await both(files(a, b));
      assert.equal(analysis.claude!.coverage.records_unkeyed, expected, "src");
      assert.equal(rec.coverage.claude["records_unkeyed"], expected, "recompute");
    });
  }
});
