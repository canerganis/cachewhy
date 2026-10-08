// Tests for src/sources/claude.ts. All data is synthetic (test/fixtures/builder.ts). Rule ids cite docs/methodology.md.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { discover } from "../../src/discover.ts";
import type { DiscoveredFile } from "../../src/discover.ts";
import { parseClaude } from "../../src/sources/claude.ts";
import { PHYSICAL_COVERAGE_COUNTERS, contextTokens, countsInTotals, writeTokens, cachedPrefix } from "../../src/model/types.ts";
import type { ClaudeParseResult, ClaudeResponse, CoverageCountField } from "../../src/model/types.ts";
import { BASE_TIME_MS, ClaudeProject, writeFiles } from "../fixtures/builder.ts";
import type { ClaudeRecord, GeneratedFile } from "../fixtures/builder.ts";

const V = "2.1.293";
const MAX = Number.MAX_SAFE_INTEGER;
const MAXN = BigInt(MAX);

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cachewhy-claude-"));
  dirs.push(d);
  return d;
}

async function load(files: readonly GeneratedFile[]): Promise<DiscoveredFile[]> {
  const dir = tmp();
  writeFiles(dir, files as GeneratedFile[]);
  const d = await discover({ claudeDirs: [join(dir, "projects")], codexDirs: [join(dir, "none")], env: {}, home: dir });
  return d.files;
}
async function run(files: readonly GeneratedFile[], opts?: Parameters<typeof parseClaude>[1]): Promise<ClaudeParseResult> {
  return parseClaude(await load(files), opts);
}

const usageOf = (r: ClaudeResponse) => {
  assert.ok(r.usage, "usage present");
  return r.usage;
};
function byKey(res: ClaudeParseResult, key: string): ClaudeResponse[] {
  return res.responses.filter((r) => r.key === key);
}
function one(res: ClaudeParseResult, key: string): ClaudeResponse {
  const l = byKey(res, key);
  assert.equal(l.length, 1, `exactly one response for ${key}`);
  return l[0] as ClaudeResponse;
}
const msg = (r: ClaudeRecord): any => r.message;
const sessionProject = (build: (s: ReturnType<ClaudeProject["session"]>, p: ClaudeProject) => void, sessionId = "synthetic-session-t"): GeneratedFile[] => {
  const p = new ClaudeProject();
  const s = p.session({ sessionId, version: V });
  build(s, p);
  return p.files();
};

function jsonStr(v: unknown): string {
  return JSON.stringify(v, (_k, x) => {
    if (typeof x === "bigint") return `${x}n`;
    if (x instanceof Map) return [...x.entries()].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
    if (x instanceof Set) return [...x].sort();
    return x;
  });
}

/** Canonical form of a result for comparisons. Physical counters, file sets and file infos are optional. */
function canon(r: ClaudeParseResult, o: { physical?: boolean; provenance?: boolean } = {}): string {
  const cov: Record<string, unknown> = { ...r.coverage };
  if (!o.physical) {
    for (const f of PHYSICAL_COVERAGE_COUNTERS) delete cov[f];
    delete cov["versions"];
  }
  const strip = <T extends { files?: unknown }>(x: T): T => {
    if (o.provenance) return x;
    const c = { ...x } as Record<string, unknown>;
    delete c["files"];
    return c as T;
  };
  return jsonStr({
    responses: r.responses.map((x) => (o.provenance ? x : { ...x, provenance: { ...x.provenance, files: [] } })),
    excluded: r.excluded.map(strip),
    coverage: cov,
    conflicts: r.conflicts.map(strip),
    links: r.links,
    streams: r.streams.map(strip),
    files: o.physical ? r.files : [],
    assumptions: r.assumptions,
    uuid_index: r.uuid_index,
    compact_boundaries: r.compact_boundaries,
    prefix_hints: r.prefix_hints,
    cost_state: r.cost_state,
  });
}

/** Compare two canonical strings; on mismatch report where they first differ. */
function same(actual: string, expected: string, msg: string): void {
  if (actual === expected) return;
  let i = 0;
  while (i < actual.length && actual[i] === expected[i]) i++;
  assert.fail(`${msg}: first difference at ${i}
  actual:   ...${actual.slice(Math.max(0, i - 60), i + 100)}
  expected: ...${expected.slice(Math.max(0, i - 60), i + 100)}`);
}

function mapContent(files: readonly GeneratedFile[], suffix: string, fn: (text: string) => string): GeneratedFile[] {
  return files.map((f) => (f.path.endsWith(suffix) ? { ...f, content: fn(String(f.content)) } : f));
}

// ---------------------------------------------------------------------------
describe("usage normalization (R2.1, R2.2, R2.3, R2.5)", () => {
  test("input + read + write with 5m/1h buckets, output from the final copy, three copies make one response", async () => {
    const res = await run(
      sessionProject((s) => {
        s.main.request({
          requestId: "r1",
          usage: { input: 5, cacheRead: 100, write5m: 30, write1h: 20, output: 55, thinkingTokens: 9 },
          blocks: [{ type: "thinking" }, { type: "text" }, { type: "tool_use", name: "Read" }],
        });
      }),
    );
    assert.equal(res.responses.length, 1);
    const r = one(res, "r1");
    const u = usageOf(r);
    assert.deepEqual(
      [u.input_uncached, u.cache_read, u.cache_write_5m, u.cache_write_1h, u.cache_write_unknown_ttl, u.cache_write],
      [5n, 100n, 30n, 20n, 0n, 0n],
    );
    assert.equal(u.output, 55n);
    assert.equal(u.output_lower_bound, 55n);
    assert.equal(u.reasoning, 9n, "thinking_tokens from the final copy, informational (R2.4)");
    assert.equal(u.reasoning_included_in_output, false);
    assert.equal(contextTokens(u), 155n);
    assert.equal(writeTokens(u), 50n);
    assert.equal(cachedPrefix(u), 150n);
    assert.equal(r.copies, 3);
    assert.equal(r.exclusion, null);
    assert.deepEqual(r.flags, []);
    assert.deepEqual(r.modifiers, { speed: "standard", inference_geo: "not_available", service_tier: "standard" });
    assert.equal(r.stop_reason, "tool_use");
    assert.deepEqual(r.model, { candidate: "claude-sonnet-4-5", verified: true, source: "claude_explicit", model: "claude-sonnet-4-5" });
    assert.equal(r.kind, "main");
    assert.equal(res.coverage.responses_total, 1);
    assert.equal(res.coverage.records_usage_bearing, 3);
    assert.equal(res.coverage.requests_with_final_marker, 1);
  });

  test("no cache_creation object: the write is bucketed unknown TTL (R2.1)", async () => {
    const res = await run(sessionProject((s) => void s.main.request({ requestId: "r1", usage: { writeTotal: 200, omitCacheCreation: true } })));
    const r = one(res, "r1");
    assert.equal(usageOf(r).cache_write_unknown_ttl, 200n);
    assert.equal(usageOf(r).cache_write_5m, 0n);
    assert.deepEqual(r.flags, ["w_unknown_ttl"]);
  });

  test("bucket mismatch: bucket sum is used, response flagged and counted (R2.1)", async () => {
    const res = await run(sessionProject((s) => void s.main.request({ requestId: "r1", usage: { write1h: 1796, writeTotal: 0, cacheRead: 4500 } })));
    const r = one(res, "r1");
    assert.equal(usageOf(r).cache_write_1h, 1796n);
    assert.deepEqual(r.flags, ["bucket_mismatch"]);
    assert.equal(res.coverage.responses_bucket_mismatch, 1);
    assert.equal(r.exclusion, null, "kept: excluded from detection later, not from accounting");
  });

  test("no final copy: output unknown with lower bound max(o), speed assumed (R2.3, R3.4)", async () => {
    const res = await run(
      sessionProject((s) => {
        s.main.request({ requestId: "r1", finalSpeed: null, usage: { output: 50 }, blocks: [{ type: "text" }, { type: "text" }, { type: "text" }], partialOutputs: [3, 70] });
      }),
    );
    const r = one(res, "r1");
    assert.equal(usageOf(r).output, null);
    assert.equal(usageOf(r).output_lower_bound, 70n);
    assert.deepEqual(r.flags, ["output_unknown", "speed_assumed"]);
    assert.equal(r.modifiers.speed, null);
    assert.equal(r.stop_reason, null);
    assert.equal(res.coverage.output_unknown_requests, 1);
    assert.equal(res.coverage.responses_speed_assumed, 1);
    assert.equal(res.coverage.requests_with_final_marker, 0);
  });

  test("final copy first in the file gives the same result as last (R4.3)", async () => {
    const mk = (finalFirst: boolean) =>
      run(sessionProject((s) => void s.main.request({ requestId: "r1", finalFirst, usage: { output: 80 }, blocks: [{ type: "text" }, { type: "text" }] })));
    const a = await mk(true);
    const b = await mk(false);
    assert.equal(canon(a), canon(b));
    assert.equal(usageOf(one(a, "r1")).output, 80n);
  });

  test("counters at MAX_SAFE_INTEGER stay exact, sums beyond 2^53 are exact BigInt (R2.15, R2.16)", async () => {
    const res = await run(
      sessionProject((s) => {
        s.main.request({ requestId: "r1", usage: { input: MAX, cacheRead: MAX, write5m: MAX, output: MAX } });
        s.main.request({ requestId: "r2", usage: { input: 1, cacheRead: MAX, write5m: MAX, write1h: MAX, writeTotal: MAX, output: 1 } });
      }),
    );
    const a = usageOf(one(res, "r1"));
    assert.equal(contextTokens(a), 3n * MAXN);
    assert.equal(cachedPrefix(a), 2n * MAXN);
    const b = one(res, "r2");
    assert.deepEqual(b.flags, ["bucket_mismatch"]);
    assert.equal(writeTokens(usageOf(b)), 2n * MAXN, "w = w5 + w1 exceeds MAX_SAFE_INTEGER and stays exact");
    assert.equal(cachedPrefix(usageOf(b)), 3n * MAXN);
  });

  test("MAX_SAFE_INTEGER + 1, negative and fractional counters fail the range check (R2.15)", async () => {
    const files = sessionProject((s) => {
      s.main.request({ requestId: "big", usage: { input: MAX + 1 } });
      s.main.request({ requestId: "neg", usage: { input: -1 } });
      s.main.request({ requestId: "frac", usage: { cacheRead: 1.5 } });
      s.main.request({ requestId: "think", usage: { thinkingTokens: -3 } });
      s.main.request({ requestId: "good", usage: { input: 3 } });
    });
    const res = await run(files);
    for (const k of ["big", "neg", "frac", "think"]) {
      const r = one(res, k);
      assert.equal(r.exclusion, "usage_range_failed", k);
      assert.equal(r.usage, null, k);
      assert.ok(!countsInTotals(r));
    }
    assert.equal(one(res, "good").exclusion, null);
    assert.equal(res.coverage.responses_usage_range_failed, 4);
    assert.equal(res.coverage.responses_total, 5, "still counted as responses (they sit between P and C)");
  });

  test("missing or non-integer counters are usage_incomplete and reported, never 0 (R2.12)", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    const a = s.main.request({ requestId: "miss", usage: { input: 7, cacheRead: 11, write5m: 13, output: 17 } });
    delete msg(a.records[0] as ClaudeRecord).usage.cache_creation_input_tokens;
    const b = s.main.request({ requestId: "str", usage: { input: 2 } });
    msg(b.records[0] as ClaudeRecord).usage.input_tokens = "2";
    const c = s.main.request({ requestId: "nocc", usage: { input: 4 } });
    msg(c.records[0] as ClaudeRecord).usage.cache_creation = { ephemeral_5m_input_tokens: 1 };
    const res = await parseClaude(await load(p.files()));
    for (const k of ["miss", "str", "nocc"]) {
      assert.equal(one(res, k).exclusion, "usage_incomplete", k);
      assert.equal(one(res, k).usage, null, k);
    }
    // miss: i + r + (w5 + w1) + o = 7 + 11 + 13 + 17; str: cache_read 0 + w 0 + o 100; nocc: no valid sum rule beyond present ints
    assert.ok(res.coverage.tokens_in_incomplete_responses >= 48n);
    assert.equal(res.coverage.records_usage_unmappable, 3);
    assert.equal(res.coverage.records_usage_bearing, 3);
  });

  test("a request whose key is repeated in many records is one response (R4.1)", async () => {
    const res = await run(sessionProject((s) => void s.main.request({ requestId: "r1", blocks: Array.from({ length: 6 }, () => ({ type: "text" as const })) })));
    assert.equal(res.responses.length, 1);
    assert.equal(one(res, "r1").copies, 6);
  });
});

// ---------------------------------------------------------------------------
describe("copy selection, conflicts (R4.1, R4.2)", () => {
  test("conflict_input: copies disagree on a counter, request excluded and listed", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    const a = s.main.request({ requestId: "r1", blocks: [{ type: "text" }, { type: "text" }] });
    msg(a.records[0] as ClaudeRecord).usage.cache_read_input_tokens = 7;
    s.main.request({ requestId: "ok" });
    const res = await parseClaude(await load(p.files()));
    const r = one(res, "r1");
    assert.equal(r.exclusion, "conflict_input");
    assert.equal(r.usage, null);
    assert.deepEqual(res.conflicts.map((c) => [c.kind, c.effect]), [["conflict_input", "excluded"]]);
    assert.equal(res.coverage.requests_conflict, 1);
    assert.equal(res.coverage.requests_conflict_by_kind.conflict_input, 1);
    assert.equal(one(res, "ok").exclusion, null);
  });

  test("conflict_model: copies disagree on the model", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    const a = s.main.request({ requestId: "r1", blocks: [{ type: "text" }, { type: "text" }] });
    msg(a.records[0] as ClaudeRecord).model = "claude-opus-5-5";
    const res = await parseClaude(await load(p.files()));
    assert.equal(one(res, "r1").exclusion, "conflict_model");
    assert.equal(res.conflicts[0]?.kind, "conflict_model");
  });

  test("model ids are normalized: trailing -YYYYMMDD stripped, odd ids become unlisted (R3.3, R14.3)", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    s.main.request({ requestId: "dated", model: "claude-opus-5-5-20260101" });
    s.main.request({ requestId: "odd", model: "Model With Spaces CANARY_1234" });
    const res = await parseClaude(await load(p.files()));
    assert.equal(one(res, "dated").model.model, "claude-opus-5-5");
    assert.equal(one(res, "odd").model.model, "unlisted");
    assert.ok(!jsonStr(res).includes("CANARY"));
  });

  test("conflict_output: two final copies disagree, output unknown and tokens kept", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    const a = s.main.request({ requestId: "r1", usage: { output: 90, cacheRead: 5 }, blocks: [{ type: "text" }, { type: "text" }] });
    msg(a.records[0] as ClaudeRecord).usage.speed = "standard"; // the partial now looks final, with a smaller output
    const res = await parseClaude(await load(p.files()));
    const r = one(res, "r1");
    assert.equal(r.exclusion, null);
    assert.equal(usageOf(r).output, null);
    assert.equal(usageOf(r).output_lower_bound, 90n);
    assert.equal(usageOf(r).cache_read, 5n);
    assert.ok(r.flags.includes("conflict_output") && r.flags.includes("output_unknown"));
    assert.deepEqual(res.conflicts.map((c) => [c.kind, c.effect]), [["conflict_output", "output_unknown"]]);
  });

  test("several equal final copies are fine (R4.2)", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    const a = s.main.request({ requestId: "r1", usage: { output: 90 }, blocks: [{ type: "text" }, { type: "text" }] });
    msg(a.records[0] as ClaudeRecord).usage.speed = "standard";
    msg(a.records[0] as ClaudeRecord).usage.output_tokens = 90;
    const res = await parseClaude(await load(p.files()));
    assert.equal(usageOf(one(res, "r1")).output, 90n);
    assert.deepEqual(res.conflicts, []);
  });

  test("conflict_iterations: iterations[0] differs from the top level, response kept, output unknown", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    const a = s.main.request({ requestId: "r1", usage: { input: 4, iterations: true, output: 33 } });
    msg(a.records[0] as ClaudeRecord).usage.iterations[0].input_tokens = 5;
    s.main.request({ requestId: "r2", usage: { input: 4, iterations: true, output: 33 } });
    const res = await parseClaude(await load(p.files()));
    const r = one(res, "r1");
    assert.equal(r.exclusion, null);
    assert.equal(usageOf(r).output, null);
    assert.equal(usageOf(r).output_lower_bound, 33n);
    assert.ok(r.flags.includes("conflict_iterations"));
    assert.equal(usageOf(one(res, "r2")).output, 33n, "matching iterations[0] is no conflict");
  });

  test("modifiers: geo and tier come from any copy, a disagreement is conflict_modifier and unpriced later (R4.2, R3.4)", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    const a = s.main.request({ requestId: "r1", usage: { inferenceGeo: "us" }, blocks: [{ type: "text" }, { type: "text" }] });
    msg(a.records[1] as ClaudeRecord).usage.inference_geo = "not_available";
    // a copy that lacks the field is no conflict
    const b = s.main.request({ requestId: "r2", usage: { inferenceGeo: "us", serviceTier: "priority" }, blocks: [{ type: "text" }, { type: "text" }] });
    delete msg(b.records[0] as ClaudeRecord).usage.inference_geo;
    const res = await parseClaude(await load(p.files()));
    const r1 = one(res, "r1");
    assert.ok(r1.flags.includes("conflict_modifier"));
    assert.equal(r1.modifiers.inference_geo, null);
    assert.equal(r1.exclusion, null, "tokens kept");
    const r2 = one(res, "r2");
    assert.ok(!r2.flags.includes("conflict_modifier"));
    assert.deepEqual(r2.modifiers, { speed: "standard", inference_geo: "us", service_tier: "priority" });
    assert.equal(res.coverage.requests_conflict_modifier, 1);
    assert.equal(res.conflicts[0]?.effect, "unpriced_modifier");
  });

  test("unknown modifier values map to other, absent ones stay null (R1.2)", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    s.main.request({ requestId: "r1", finalSpeed: "turbo", usage: { serviceTier: "flex", inferenceGeo: null } });
    const res = await parseClaude(await load(p.files()));
    assert.deepEqual(one(res, "r1").modifiers, { speed: "other", inference_geo: null, service_tier: "other" });
  });

  test("diagnostics: union of non-null reasons, two different types give no evidence (R4.2, R10.4, R10.7)", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    s.main.request({ requestId: "d1", diagnostics: { type: "tools_changed", cacheMissedInputTokens: 123 } });
    s.main.request({ requestId: "d2", diagnostics: { type: "something_new" } });
    const c = s.main.request({ requestId: "d3", diagnostics: { type: "tools_changed" }, blocks: [{ type: "text" }, { type: "text" }] });
    msg(c.records[0] as ClaudeRecord).diagnostics = { cache_miss_reason: { type: "messages_changed" } };
    s.main.request({ requestId: "d4" });
    const res = await parseClaude(await load(p.files()));
    assert.deepEqual(one(res, "d1").diag, { type: "tools_changed", missed_tokens_reported: 123n });
    assert.deepEqual(one(res, "d2").diag, { type: "other", missed_tokens_reported: null });
    assert.equal(one(res, "d3").diag, null);
    assert.ok(one(res, "d3").flags.includes("conflict_diagnostics"));
    assert.equal(one(res, "d4").diag, null);
  });

  test("key_conflict: one requestId with two message ids, and one message id with two requestIds (R4.1)", async () => {
    const res = await run(
      sessionProject((s) => {
        s.main.request({ requestId: "k1", messageId: "m1" });
        s.main.request({ requestId: "k1", messageId: "m2" });
        s.main.request({ requestId: "k2", messageId: "m3" });
        s.main.request({ requestId: "k3", messageId: "m3" });
        s.main.request({ requestId: "fine", messageId: "m9" });
      }),
    );
    for (const k of ["k1", "k2", "k3"]) assert.equal(one(res, k).exclusion, "key_conflict", k);
    assert.equal(one(res, "fine").exclusion, null);
    assert.equal(res.coverage.requests_conflict_by_kind.key_conflict, 3);
    assert.equal(res.coverage.requests_conflict, 3);
  });
});

describe("more copy-selection edge cases", () => {
  test("input and model conflicts are both recorded, the request is excluded once", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    const a = s.main.request({ requestId: "r1", blocks: [{ type: "text" }, { type: "text" }] });
    msg(a.records[0] as ClaudeRecord).usage.cache_read_input_tokens = 7;
    msg(a.records[0] as ClaudeRecord).model = "claude-opus-5-5";
    const res = await parseClaude(await load(p.files()));
    assert.equal(one(res, "r1").exclusion, "conflict_input");
    assert.deepEqual(res.conflicts.map((c) => c.kind).sort(), ["conflict_input", "conflict_model"]);
    assert.equal(res.coverage.responses_total, 1);
    assert.equal(res.coverage.requests_conflict, 2, "counted per kind; the by-kind counts sum to the total");
  });

  test("a usage copy without a parseable timestamp makes the request incomplete (no position, no event time)", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    const a = s.main.request({ requestId: "r1" });
    (a.records[0] as ClaudeRecord).timestamp = "yesterday";
    const res = await parseClaude(await load(p.files()));
    assert.equal(one(res, "r1").exclusion, "usage_incomplete");
    assert.equal(res.coverage.records_usage_unmappable, 1);
  });

  test("copies of one key in a supported and an unverified version: only supported copies are used (R15.7)", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    const a = s.main.request({ requestId: "r1", usage: { cacheRead: 5, output: 40 }, blocks: [{ type: "text" }, { type: "text" }] });
    (a.records[0] as ClaudeRecord).version = "2.1.290";
    msg(a.records[0] as ClaudeRecord).usage.cache_read_input_tokens = 999; // would be a conflict if it were read
    const res = await parseClaude(await load(p.files()));
    const r = one(res, "r1");
    assert.equal(r.exclusion, null);
    assert.equal(usageOf(r).cache_read, 5n);
    assert.equal(r.copies, 1);
    assert.equal(res.coverage.requests_unverified_version, 1, "the key also has an unverified copy");
    assert.equal(res.coverage.requests_total, 1);
    assert.equal(res.excluded.length, 0);
  });

  test("a stop_reason of null on the final copy is reported as null, an unknown one as other (R1.2)", async () => {
    const res = await run(
      sessionProject((s) => {
        s.main.request({ requestId: "a", stopReason: null });
        s.main.request({ requestId: "b", stopReason: "max_tokens" });
      }),
    );
    assert.equal(one(res, "a").stop_reason, "null");
    assert.equal(one(res, "b").stop_reason, "other");
  });
});

// ---------------------------------------------------------------------------
describe("retries, errors, unkeyed (R2.13, R2.14, R4.5)", () => {
  test("two different keys with identical usage are two billed responses, never merged (R4.5)", async () => {
    const res = await run(
      sessionProject((s) => {
        s.main.request({ requestId: "a", usage: { input: 9, cacheRead: 1000, output: 7 } });
        s.main.request({ requestId: "b", usage: { input: 9, cacheRead: 1000, output: 7 } });
      }),
    );
    assert.equal(res.responses.length, 2);
    assert.equal(res.coverage.responses_total, 2);
  });

  test("api error and <synthetic> records are not requests; they are excluded records (R2.14)", async () => {
    const res = await run(
      sessionProject((s) => {
        s.main.request({ requestId: "ok" });
        s.main.request({ requestId: "err", apiError: true });
      }),
    );
    assert.deepEqual(res.responses.map((r) => r.key), ["ok"]);
    assert.equal(res.coverage.api_error_records, 1);
    assert.deepEqual(res.excluded.map((e) => e.reason), ["api_error"]);
    assert.equal(res.coverage.records_usage_bearing, 1, "an error record is not usage bearing");
  });

  test("a record without requestId is unkeyed: counted, excluded, never in totals (R2.13)", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    const a = s.main.request({ requestId: "x" });
    delete (a.records[0] as ClaudeRecord).requestId;
    s.main.request({ requestId: "ok" });
    const res = await parseClaude(await load(p.files()));
    assert.deepEqual(res.responses.map((r) => r.key), ["ok"]);
    assert.equal(res.coverage.records_unkeyed, 1);
    assert.deepEqual(res.excluded.map((e) => e.reason), ["unkeyed"]);
  });
});

// ---------------------------------------------------------------------------
describe("helper, classifier, advisor tagging and kinds (R5.2, R5.5)", () => {
  test("serverClassifierRequest and advisorModel are attributes of the request", async () => {
    const res = await run(
      sessionProject((s) => {
        s.main.request({ requestId: "c", extra: { serverClassifierRequest: { x: 1 }, advisorModel: "claude-opus-5-5-20260101", effort: "high", perTurnEffort: "weird" } });
        s.main.request({ requestId: "plain" });
      }),
    );
    const c = one(res, "c");
    assert.ok(c.flags.includes("classifier_attached"));
    assert.equal(c.advisor_model, "claude-opus-5-5");
    assert.equal(c.effort, "high");
    assert.equal(c.per_turn_effort, "other");
    assert.equal(c.entrypoint, "cli");
    const p = one(res, "plain");
    assert.ok(!p.flags.includes("classifier_attached"));
    assert.equal(p.advisor_model, null);
    assert.equal(res.responses.length, 2, "the classifier call itself is not a request");
  });

  test("kind follows the file: main, subagent, workflow_agent", async () => {
    const res = await run(
      sessionProject((s) => {
        s.main.request({ requestId: "m" });
        s.spawnAgent({ spawnDepth: 1 }).agent.thread.request({ requestId: "sub" });
        s.agent({ agentId: "synthetic-agent-wf", workflowRunId: "synthetic-run-1", omitMeta: true }).thread.request({ requestId: "wf" });
      }),
    );
    assert.equal(one(res, "m").kind, "main");
    assert.equal(one(res, "sub").kind, "subagent");
    assert.equal(one(res, "wf").kind, "workflow_agent");
    assert.equal(one(res, "sub").is_sidechain, true);
  });
});

// ---------------------------------------------------------------------------
describe("linkage inputs (R5.3, R5.4)", () => {
  test("subagent linkage: verified, and every unlinked reason of R5.3", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    s.main.request({ requestId: "main-1", blocks: [{ type: "tool_use", name: "Read", id: "synthetic-toolu-read" }] });
    // verified depth 1
    s.spawnAgent({ agentId: "synthetic-agent-ok", spawnDepth: 1 }).agent.thread.request({ requestId: "ok-1" });
    // depth absent is depth 1
    s.spawnAgent({ agentId: "synthetic-agent-nodepth" }).agent.thread.request({ requestId: "nd-1" });
    // verified depth 2
    const d1 = s.spawnAgent({ agentId: "synthetic-agent-d1", spawnDepth: 1 });
    d1.agent.thread.request({ requestId: "d1-1" });
    s.spawnAgent({ parent: d1.agent.thread, agentId: "synthetic-agent-d2", spawnDepth: 2, parentAgentId: "synthetic-agent-d1" }).agent.thread.request({ requestId: "d2-1" });
    // depth 2 but the tool_use lives in main: the owner is not parentAgentId
    const tu = s.spawnAgent({ agentId: "synthetic-agent-holder", spawnDepth: 1 });
    tu.agent.thread.request({ requestId: "holder-1" });
    s.agent({ agentId: "synthetic-agent-pam", toolUseId: tu.toolUseId, spawnDepth: 2, parentAgentId: "synthetic-agent-holder" }).thread.request({ requestId: "pam-1" });
    // failures
    s.agent({ agentId: "synthetic-agent-nometa", omitMeta: true }).thread.request({ requestId: "nm-1" });
    s.agent({ agentId: "synthetic-agent-notool", toolUseId: null }).thread.request({ requestId: "nt-1" });
    s.agent({ agentId: "synthetic-agent-notfound", toolUseId: "synthetic-toolu-missing" }).thread.request({ requestId: "nf-1" });
    s.agent({ agentId: "synthetic-agent-wrongname", toolUseId: "synthetic-toolu-read" }).thread.request({ requestId: "wn-1" });
    s.agent({ agentId: "synthetic-agent-noparent", toolUseId: "synthetic-toolu-read", spawnDepth: 2, parentAgentId: "synthetic-agent-gone" }).thread.request({ requestId: "np-1" });
    s.agent({ agentId: "synthetic-agent-nopid", toolUseId: "synthetic-toolu-read", spawnDepth: 2 }).thread.request({ requestId: "npid-1" });
    s.agent({ agentId: "synthetic-agent-depth3", toolUseId: "synthetic-toolu-read", spawnDepth: 3 }).thread.request({ requestId: "d3-1" });
    const sm = s.spawnAgent({ agentId: "synthetic-agent-sessmis", spawnDepth: 1 });
    sm.agent.thread.request({ requestId: "sm-1" });
    for (const r of sm.agent.thread.records) r.sessionId = "synthetic-session-other";
    const am = s.spawnAgent({ agentId: "synthetic-agent-agentmis", spawnDepth: 1 });
    am.agent.thread.request({ requestId: "am-1" });
    for (const r of am.agent.thread.records) r.agentId = "synthetic-agent-someone";
    const res = await parseClaude(await load(p.files()));
    const L = (agent: string, session = "synthetic-session-t") => {
      const l = res.links.find((x) => x.chain.thread === agent && x.chain.root_session === session);
      assert.ok(l, `link for ${agent}`);
      return l;
    };
    const verified = ["ok", "nodepth", "d1", "d2", "holder"];
    for (const a of verified) assert.equal(L(`synthetic-agent-${a}`).state, "verified", a);
    assert.deepEqual(L("synthetic-agent-d2").parent, { provider: "claude", root_session: "synthetic-session-t", thread: "synthetic-agent-d1" });
    assert.deepEqual(L("synthetic-agent-ok").parent, { provider: "claude", root_session: "synthetic-session-t", thread: "main" });
    assert.equal(L("synthetic-agent-d2").depth, 2);
    const expected: Record<string, string> = {
      pam: "parent_agent_mismatch",
      nometa: "no_meta",
      notool: "no_tool_use_id",
      notfound: "tool_use_not_found",
      wrongname: "tool_name_unexpected",
      noparent: "parent_file_missing",
      nopid: "parent_file_missing",
      depth3: "parent_file_missing",
    };
    for (const [a, reason] of Object.entries(expected)) {
      const l = L(`synthetic-agent-${a}`);
      assert.equal(l.state, "unlinked", a);
      assert.equal(l.reason, reason, a);
      assert.equal(l.parent, null);
    }
    // identity mismatches move the records to the chain they name; that chain is unlinked with the matching reason
    assert.equal(L("synthetic-agent-sessmis", "synthetic-session-other").reason, "session_mismatch");
    assert.equal(L("synthetic-agent-someone").reason, "agent_mismatch");
    assert.equal(res.coverage.links_verified, verified.length);
    assert.equal(res.coverage.links_unlinked, Object.keys(expected).length + 2);
    assert.equal(res.coverage.links_unlinked_by_reason.no_meta, 1);
    assert.equal(res.coverage.links_unlinked_by_reason.parent_file_missing, 3);
  });

  test("workflow agents are never verified; directory only with a started journal entry and a matching run file (R5.4)", async () => {
    const res = await run(
      sessionProject((s) => {
        s.main.request({ requestId: "m", blocks: [{ type: "tool_use", name: "Workflow", id: "synthetic-toolu-wf" }] });
        s.workflowRun({ runId: "synthetic-run-1", journal: [{ type: "started", agentId: "synthetic-agent-a" }, { type: "finished", agentId: "synthetic-agent-b" }] });
        for (const a of ["a", "b"]) s.agent({ agentId: `synthetic-agent-${a}`, workflowRunId: "synthetic-run-1", omitMeta: true }).thread.request({ requestId: `wf-${a}` });
        s.workflowRun({ runId: "synthetic-run-2", json: false, journal: [{ type: "started", agentId: "synthetic-agent-c" }] });
        s.agent({ agentId: "synthetic-agent-c", workflowRunId: "synthetic-run-2", omitMeta: true }).thread.request({ requestId: "wf-c" });
        s.workflowRun({ runId: "synthetic-run-3", jsonRunId: "synthetic-run-other", journal: [{ type: "started", agentId: "synthetic-agent-d" }] });
        s.agent({ agentId: "synthetic-agent-d", workflowRunId: "synthetic-run-3", omitMeta: true }).thread.request({ requestId: "wf-d" });
        s.agent({ agentId: "synthetic-agent-e", workflowRunId: "synthetic-run-4", omitMeta: true }).thread.request({ requestId: "wf-e" });
      }),
    );
    const L = (a: string) => res.links.find((x) => x.chain.thread === `synthetic-agent-${a}`);
    assert.deepEqual([L("a")?.state, L("a")?.reason], ["directory", null]);
    assert.deepEqual([L("b")?.state, L("b")?.reason], ["unlinked", "no_journal_entry"]);
    assert.deepEqual([L("c")?.state, L("c")?.reason], ["unlinked", "no_run_file"]);
    assert.deepEqual([L("d")?.state, L("d")?.reason], ["unlinked", "run_id_mismatch"]);
    assert.deepEqual([L("e")?.state, L("e")?.reason], ["unlinked", "no_journal_entry"]);
    assert.ok(res.links.every((l) => l.kind === "workflow_agent" && l.state !== "verified"));
    assert.equal(res.coverage.links_directory_only, 1);
    assert.equal(res.coverage.links_verified, 0);
    assert.equal(res.coverage.links_unlinked, 4);
  });

  test("a run file whose runId carries the wf_ prefix (as real logs write it) matches the directory (R5.4)", async () => {
    const files = mapContent(
      sessionProject((s) => {
        s.main.request({ requestId: "m" });
        s.workflowRun({ runId: "synthetic-run-1", journal: [{ type: "started", agentId: "synthetic-agent-a" }] });
        s.agent({ agentId: "synthetic-agent-a", workflowRunId: "synthetic-run-1", omitMeta: true }).thread.request({ requestId: "wf-a" });
      }),
      "wf_synthetic-run-1.json",
      (t) => t.replace('"runId":"synthetic-run-1"', '"runId":"wf_synthetic-run-1"'),
    );
    const res = await run(files);
    assert.equal(res.links.find((l) => l.chain.thread === "synthetic-agent-a")?.state, "directory");
  });

  test("agent prefix.json is read as presence/enum hints only (R10.6)", async () => {
    const res = await run(
      sessionProject((s) => {
        s.main.request({ requestId: "m" });
        const a = s.spawnAgent({ agentId: "synthetic-agent-a", spawnDepth: 1, prefix: { model: "claude-sonnet-4-5-20260101", is1hCacheTTL: true, buildVersion: "2.1.293", toolsHash: "synthetic-hash" } });
        a.agent.thread.request({ requestId: "a1" });
        const b = s.agent({ agentId: "synthetic-agent-b", toolUseId: null, prefix: { is1hCacheTTL: false, toolsHash: null, buildVersion: "not a version CANARY_1" } });
        b.thread.request({ requestId: "b1" });
      }),
    );
    assert.deepEqual(
      res.prefix_hints.map((h) => [h.chain.thread, h.model, h.is_1h_cache_ttl, h.build_version, h.tools_hash_present]),
      [
        ["synthetic-agent-a", "claude-sonnet-4-5", true, "2.1.293", true],
        ["synthetic-agent-b", null, false, "unlisted", false],
      ],
    );
    assert.ok(!jsonStr(res).includes("CANARY"));
  });
});

// ---------------------------------------------------------------------------
describe("compact markers and the uuid index (R6.3, R11.7)", () => {
  test("compact_boundary, summary flag, parent edges and t_asm / start_lo", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    const m = s.main;
    m.user();
    m.request({ requestId: "r1", usage: { write5m: 100 } });
    const b = m.compactBoundary({ trigger: "manual", preTokens: 21500, postTokens: 4000 });
    const sum = m.user({ compactSummary: true });
    m.request({ requestId: "r2", usage: { write5m: 50 } });
    m.compactBoundary({ trigger: "weird", preTokens: -1, postTokens: 5 });
    const res = await parseClaude(await load(p.files()));
    assert.equal(res.compact_boundaries.length, 2);
    const first = res.compact_boundaries.find((x) => x.uuid === b.uuid);
    assert.ok(first);
    assert.deepEqual([first.trigger, first.pre_tokens, first.post_tokens, first.logical_parent_uuid !== null], ["manual", 21500n, 4000n, true]);
    assert.deepEqual(first.chain, { provider: "claude", root_session: "synthetic-session-t", thread: "main" });
    const second = res.compact_boundaries.find((x) => x.uuid !== b.uuid);
    assert.deepEqual([second?.trigger, second?.pre_tokens, second?.post_tokens], ["other", null, 5n]);
    assert.equal(res.coverage.fields_range_failed, 1, "preTokens -1 is a side field: treated as absent, counted (R2.15)");
    // uuid index
    const nb = res.uuid_index.get(String(b.uuid));
    assert.equal(nb?.is_compact_boundary, true);
    assert.equal(nb?.parent_uuid, null);
    const ns = res.uuid_index.get(String(sum.uuid));
    assert.equal(ns?.is_compact_summary, true);
    assert.equal(ns?.parent_uuid, String(b.uuid), "the summary's parent is the boundary (R11.7 walk input)");
    // start bounds
    const r2 = one(res, "r2");
    assert.equal(r2.time.t_asm_ms, ns?.ts_ms);
    assert.equal(r2.time.start_lo_ms, r2.time.t_asm_ms);
    assert.equal(r2.time.gap_basis, "parent_record");
    assert.equal(r2.time.start_hi_ms, r2.time.t_first_ms);
    assert.ok(res.assumptions.includes("parent_record_precedes_request"));
  });

  test("start_lo is unknown when the parent is missing from the index or later than t_first (R6.4)", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    s.main.user();
    const a = s.main.request({ requestId: "orphan" });
    for (const r of a.records) r.parentUuid = "synthetic-uuid-missing";
    const b = s.main.request({ requestId: "future" });
    const parent = s.main.records.find((r) => r.uuid === b.records[0]?.parentUuid) as ClaudeRecord;
    parent.timestamp = new Date(BASE_TIME_MS + 10 * 86_400_000).toISOString();
    const res = await parseClaude(await load(p.files()));
    for (const k of ["orphan", "future"]) {
      const t = one(res, k).time;
      assert.equal(t.start_lo_ms, null, k);
      assert.equal(t.gap_basis, "none", k);
    }
    assert.equal(one(res, "orphan").time.t_asm_ms, null);
    assert.ok(one(res, "future").time.t_asm_ms !== null, "t_asm is still reported, start_lo is not");
  });

  test("t_first and t_last are the min and max timestamp over copies (R6.3)", async () => {
    const res = await run(sessionProject((s) => void s.main.request({ requestId: "r1", blocks: [{ type: "text" }, { type: "text" }, { type: "text" }] })));
    const t = one(res, "r1").time;
    assert.equal(t.event_ms, t.t_first_ms);
    assert.equal(t.t_last_ms - t.t_first_ms, 10);
  });
});

// ---------------------------------------------------------------------------
describe("replay and ownership (R4.6, R4.7)", () => {
  const T0 = Date.UTC(2026, 0, 1);
  /** The builder's replay() keeps the origin session id; a real copy lives in the new session (R4.11), so rewrite it. */
  const replayInto = (thread: { replay(r: ClaudeRecord[]): void }, records: ClaudeRecord[], sessionId: string): void => {
    thread.replay(records.map((r) => ({ ...structuredClone(r), sessionId })));
  };

  test("a key in two streams is a replay in every stream but the earliest; replayed copies carry the owner's counters", async () => {
    const p = new ClaudeProject();
    const a = p.session({ sessionId: "synthetic-session-a", version: V, startMs: T0 });
    a.main.user();
    a.main.request({ requestId: "ra1", usage: { input: 5, write5m: 10000, output: 100 } });
    a.main.user();
    a.main.request({ requestId: "ra2", usage: { input: 5, cacheRead: 10000, write5m: 500, output: 100 } });
    const b = p.session({ sessionId: "synthetic-session-b", version: V, startMs: T0 + 3_600_000 });
    replayInto(b.main, a.main.records.slice(1), "synthetic-session-b"); // all but the very first record: no start tie
    b.main.user();
    b.main.request({ requestId: "rb1", usage: { input: 5, cacheRead: 10500, write5m: 700, output: 150 } });
    const res = await parseClaude(await load(p.files()));
    for (const k of ["ra1", "ra2"]) {
      const l = byKey(res, k);
      assert.equal(l.length, 2, k);
      const owner = l.find((r) => r.chain.root_session === "synthetic-session-a") as ClaudeResponse;
      const copy = l.find((r) => r.chain.root_session === "synthetic-session-b") as ClaudeResponse;
      assert.equal(owner.ownership.role, "owner");
      assert.equal(copy.ownership.role, "replayed");
      assert.ok(countsInTotals(owner) && !countsInTotals(copy));
      assert.deepEqual(copy.usage, owner.usage, "replayed copy carries the owner's counters");
      assert.equal(copy.ownership.ambiguous, false);
      assert.equal(copy.ownership.owner_stream_start_ms, T0 + 1000);
    }
    assert.equal(one(res, "rb1").ownership.role, "owner");
    assert.equal(res.coverage.replay_requests_excluded, 2);
    assert.equal(res.coverage.replay_ownership_ambiguous, 0);
    assert.equal(res.coverage.responses_total, 3, "one per key");
    const owned = res.responses.filter(countsInTotals);
    assert.equal(owned.length, 3);
    const read = owned.reduce((sum, r) => sum + usageOf(r).cache_read, 0n);
    assert.equal(read, 10000n + 10500n);
  });

  test("equal stream_start makes ownership ambiguous: the smaller sessionId owns, all copies are flagged (R4.6)", async () => {
    const p = new ClaudeProject();
    const a = p.session({ sessionId: "synthetic-session-a", version: V, startMs: T0 });
    a.main.user();
    a.main.request({ requestId: "ra1", usage: { input: 5, write5m: 10000 } });
    const b = p.session({ sessionId: "synthetic-session-0", version: V, startMs: T0 + 3_600_000 });
    replayInto(b.main, a.main.records, "synthetic-session-0"); // includes the first record: same stream_start
    const res = await parseClaude(await load(p.files()));
    const l = byKey(res, "ra1");
    assert.equal(l.length, 2);
    assert.ok(l.every((r) => r.ownership.ambiguous && r.flags.includes("ownership_ambiguous")));
    assert.equal(l.find((r) => r.ownership.role === "owner")?.chain.root_session, "synthetic-session-0");
    assert.equal(res.coverage.replay_ownership_ambiguous, 1);
    assert.equal(res.coverage.replay_requests_excluded, 1);
  });

  test("a key repeated inside one stream (duplicates, split files) is not a replay (R4.6)", async () => {
    const files = sessionProject((s) => {
      s.main.request({ requestId: "r1" });
      s.main.duplicateLast(3);
    });
    const res = await run(files);
    assert.equal(res.responses.length, 1);
    assert.equal(res.coverage.replay_requests_excluded, 0);
    assert.equal(res.coverage.lines_duplicate_collapsed, 1, "one extra copy of the single record; the others are different blocks");
  });
});

// ---------------------------------------------------------------------------
describe("versions (R15.7)", () => {
  test("a version outside the matrix adds nothing: counted, excluded record only", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    s.main.request({ requestId: "a" });
    const u = s.main.request({ requestId: "unv", blocks: [{ type: "text" }, { type: "text" }] });
    for (const r of u.records) r.version = "2.1.290";
    s.main.request({ requestId: "b" });
    const res = await parseClaude(await load(p.files()));
    assert.deepEqual(res.responses.map((r) => r.key), ["a", "b"]);
    assert.equal(res.coverage.requests_unverified_version, 1);
    assert.equal(res.coverage.lines_unverified_version, 2);
    assert.equal(res.coverage.requests_total, 3);
    assert.equal(res.coverage.responses_total, 2);
    assert.deepEqual(res.excluded.map((e) => e.reason), ["unverified_version"]);
    assert.ok(res.assumptions.includes("unverified_version"));
    assert.equal(res.coverage.versions["2.1.290"], 2);
    assert.ok(res.excluded[0] && res.excluded[0].event_ms > one(res, "a").time.event_ms && res.excluded[0].event_ms < one(res, "b").time.event_ms);
  });

  test("an all-unverified tree produces no response, stream, link or uuid node", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: "2.1.290" });
    s.main.user();
    s.main.request({ requestId: "a" });
    s.spawnAgent({ spawnDepth: 1 }).agent.thread.request({ requestId: "b" });
    const res = await parseClaude(await load(p.files()));
    assert.equal(res.responses.length, 0);
    assert.equal(res.streams.length, 0);
    assert.equal(res.links.length, 0);
    assert.equal(res.uuid_index.size, 0);
    assert.equal(res.excluded.length, 0, "no stream to sit in");
    assert.equal(res.coverage.requests_unverified_version, 3, "main request, the Agent spawn request and the subagent request");
    assert.equal(res.coverage.responses_total, 0);
    assert.deepEqual(
      res.files.map((f) => f.support),
      ["coverage_only", "coverage_only", "full"],
    );
  });

  test("a missing or malformed version is listed as unlisted and not supported", async () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    const a = s.main.request({ requestId: "a" });
    for (const r of a.records) delete r.version;
    const b = s.main.request({ requestId: "b" });
    for (const r of b.records) r.version = "2.1.293-CANARY_1";
    const res = await parseClaude(await load(p.files()));
    assert.equal(res.responses.length, 0);
    assert.equal(res.coverage.versions["unlisted"], 2);
    assert.ok(!jsonStr(res).includes("CANARY"));
  });
});

// ---------------------------------------------------------------------------
describe("parse failures and line shapes (R1.3, R1.4)", () => {
  test("bad lines, truncated tail, CRLF and BOM, unlisted types", async () => {
    const files = mapContent(
      sessionProject((s) => void s.main.request({ requestId: "a" })),
      "synthetic-session-t.jsonl",
      (t) => {
        const lines = t.trimEnd().split("\n");
        lines.splice(1, 0, "this is not json CANARY_zzzz", '{"type":"summary","leafUuid":"synthetic-leaf","summary":"CANARY_text"}', "42");
        return "\uFEFF" + lines.join("\r\n") + '\r\n{"type":"assistant","message":{"content":"CANARY_tail';
      },
    );
    const res = await run(files);
    assert.equal(res.responses.length, 1);
    assert.equal(res.coverage.lines_parse_error, 1);
    assert.equal(res.coverage.lines_truncated_tail, 1);
    assert.equal(res.coverage.unlisted_type_count, 2, "summary record and the bare number");
    assert.equal(res.coverage.known_type_count, 1);
    assert.equal(res.coverage.lines_total, 1 + 3 + 1);
    assert.ok(!jsonStr(res).includes("CANARY"));
  });

  test("a final line without newline that parses is a normal line", async () => {
    const files = mapContent(sessionProject((s) => void s.main.request({ requestId: "a" })), "synthetic-session-t.jsonl", (t) => t.trimEnd());
    const res = await run(files);
    assert.equal(res.responses.length, 1);
    assert.equal(res.coverage.lines_truncated_tail, 0);
  });

  test("an unreadable file is counted, never thrown", async () => {
    const files = await load(sessionProject((s) => void s.main.request({ requestId: "a" })));
    const ghost: DiscoveredFile = { ...(files[0] as DiscoveredFile), path: join(tmp(), "missing.jsonl"), relPath: "zz/missing.jsonl" };
    const res = await parseClaude([...files, ghost]);
    assert.equal(res.responses.length, 1);
    assert.equal(res.coverage.files_unreadable, 1);
    assert.equal(res.files.filter((f) => !f.readable).length, 1);
  });

  test("non Claude files are ignored", async () => {
    const files = await load(sessionProject((s) => void s.main.request({ requestId: "a" })));
    const codex: DiscoveredFile = { ...(files[0] as DiscoveredFile), agent: "codex", kind: "codex-rollout" };
    const res = await parseClaude([...files, codex]);
    assert.equal(res.coverage.files_total, files.length);
  });
});

// ---------------------------------------------------------------------------
describe("window and prefilter (R5.9, R5.10)", () => {
  test("the parser loads everything; baseline requests are counted, never dropped", async () => {
    const files = sessionProject((s) => {
      s.main.request({ requestId: "old", dtMs: 1000 });
      s.main.request({ requestId: "new", dtMs: 86_400_000 });
    });
    const res = await run(files, { window: { since_ms: BASE_TIME_MS + 3_600_000, until_ms: BASE_TIME_MS + 10 * 86_400_000 } });
    assert.equal(res.responses.length, 2);
    assert.equal(res.coverage.baseline_requests_loaded, 1);
    assert.ok(!res.assumptions.includes("mtime_prefilter_on"));
  });

  test("--fast skips old files by mtime and prints the assumption", async () => {
    const files = await load(sessionProject((s) => void s.main.request({ requestId: "a" })));
    const old = files.map((f) => ({ ...f, mtimeMs: 1000 }));
    const since = Date.now();
    const res = await parseClaude(old, { fastPrefilter: true, window: { since_ms: since, until_ms: since + 1 } });
    assert.equal(res.responses.length, 0);
    assert.ok(res.assumptions.includes("mtime_prefilter_on"));
    const res2 = await parseClaude(old, { window: { since_ms: since, until_ms: since + 1 } });
    assert.equal(res2.responses.length, 1, "without --fast the mtime never matters");
  });
});

// ---------------------------------------------------------------------------
describe("cost-state (R17.5)", () => {
  test("latest cumulative per session and model, summed over sessions; difference to logged requests", async () => {
    const files = mapContent(
      sessionProject((s) => {
        s.main.request({ requestId: "a", model: "claude-opus-5-5", usage: { input: 10, cacheRead: 20, write5m: 30, output: 40 } });
      }),
      "synthetic-session-t.jsonl",
      (t) => {
        const cs = (ts: string, n: number) =>
          JSON.stringify({ type: "cost-state", sessionId: "synthetic-session-t", timestamp: ts, modelUsage: { "claude-opus-5-5-20260101": { inputTokens: n, outputTokens: n * 2, cacheReadInputTokens: n * 3, cacheCreationInputTokens: n * 4 } } });
        return t + cs("2026-01-01T00:00:10.000Z", 100) + "\n" + cs("2026-01-01T00:00:20.000Z", 1000) + "\n";
      },
    );
    const res = await run(files);
    assert.equal(res.cost_state.length, 1);
    assert.deepEqual(res.cost_state[0], { model: "claude-opus-5-5", input_uncached: 1000n, output: 2000n, cache_read: 3000n, cache_write: 4000n });
    assert.deepEqual(res.coverage.unlogged_tokens_estimate, { input_uncached: 990n, cache_read: 2980n, cache_write: 3970n, output: 1960n });
    assert.equal(res.responses.length, 1, "cost-state is never a request");
    assert.equal(res.coverage.known_type_count, 3, "one assistant record and two cost-state records are known types");
  });
});

// ---------------------------------------------------------------------------
describe("privacy (R1.1, R14.7)", () => {
  test("no canary text from any dropped field appears anywhere in the result", async () => {
    const canary = `CANARY_${randomBytes(8).toString("hex")}`;
    const p = new ClaudeProject({ canary });
    const s = p.session({ sessionId: "synthetic-session-t", version: V });
    s.main.user();
    s.main.request({ requestId: "r1", blocks: [{ type: "thinking" }, { type: "text" }, { type: "tool_use", name: "Read", id: "synthetic-toolu-1" }], extra: { gitBranch: canary } });
    s.main.compactBoundary();
    s.workflowRun({ runId: "synthetic-run-1", journal: [{ type: "started", agentId: "synthetic-agent-wf" }] });
    s.agent({ agentId: "synthetic-agent-wf", workflowRunId: "synthetic-run-1", omitMeta: true }).thread.request({ requestId: "w1" });
    s.spawnAgent({ spawnDepth: 1, prefix: { model: "claude-sonnet-4-5", is1hCacheTTL: true, buildVersion: "2.1.293" } }).agent.thread.request({ requestId: "a1" });
    const res = await parseClaude(await load(p.files()));
    assert.ok(res.responses.length >= 3);
    const text = jsonStr(res);
    const lower = canary.toLowerCase();
    for (let i = 0; i + 8 <= canary.length; i++) {
      const sub = canary.slice(i, i + 8);
      assert.ok(!text.includes(sub) && !text.toLowerCase().includes(sub.toLowerCase()), `substring ${i} of the canary leaked`);
    }
    assert.ok(!text.toLowerCase().includes(lower));
    assert.ok(res.coverage.lines_truncated_tail >= 1, "the planted truncated tail was seen");
  });
});

// ---------------------------------------------------------------------------
// Committed synthetic trees (test/fixtures/synthetic). They are copied to a temp dir and their version is rewritten
// (the builder default, 2.1.290, is outside the matrix of spec section 0.2).
// ---------------------------------------------------------------------------
describe("committed synthetic trees", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "synthetic");
  function copyPatched(name: string, version: string = V): string {
    const dst = tmp();
    const walk = (from: string, to: string): void => {
      mkdirSync(to, { recursive: true });
      for (const e of readdirSync(from)) {
        const f = join(from, e);
        const t = join(to, e);
        if (statSync(f).isDirectory()) walk(f, t);
        else if (e.endsWith(".jsonl")) writeFileSync(t, readFileSync(f, "utf8").replace(/"version":"[0-9]+\.[0-9]+\.[0-9]+"/g, `"version":"${version}"`));
        else cpSync(f, t);
      }
    };
    walk(join(SRC, name), dst);
    return dst;
  }
  async function parseTree(name: string, version: string = V): Promise<ClaudeParseResult> {
    const dir = copyPatched(name, version);
    const d = await discover({ claudeDirs: [dir], codexDirs: [join(dir, "none")], env: {}, home: dir });
    return parseClaude(d.files);
  }

  test("claude-basic with a version outside the matrix is coverage only", async () => {
    const res = await parseTree("claude-basic", "2.1.299");
    assert.equal(res.responses.length, 0);
    assert.ok(res.coverage.requests_unverified_version >= 10);
    assert.ok(res.coverage.lines_unverified_version > 0);
    assert.ok(res.assumptions.includes("unverified_version"));
  });

  test("claude-basic at a supported version", async () => {
    const res = await parseTree("claude-basic");
    assert.equal(res.responses.length, 10);
    const R = (i: number) => res.responses.find((r) => r.key === `synthetic-req-${String(i).padStart(4, "0")}`) as ClaudeResponse;
    const first = R(1);
    assert.equal(usageOf(first).cache_write_5m, 20000n);
    assert.equal(first.copies, 3);
    assert.equal(first.stop_reason, "tool_use");
    assert.deepEqual(res.coverage.lines_duplicate_collapsed, 1, "the duplicated line");
    // the old shape and the bucket mismatch
    assert.equal(res.coverage.responses_bucket_mismatch, 1);
    assert.equal(res.responses.filter((r) => r.flags.includes("w_unknown_ttl")).length, 1);
    // diagnostics on the rebuild request
    const withDiag = res.responses.filter((r) => r.diag !== null);
    assert.equal(withDiag.length, 1);
    assert.equal(withDiag[0]?.diag?.missed_tokens_reported, 21500n);
    assert.deepEqual(res.compact_boundaries.map((b) => [b.trigger, b.pre_tokens, b.post_tokens]), [["manual", 21500n, 4000n]]);
    assert.equal(res.links.length, 2);
    assert.deepEqual(res.links.map((l) => [l.state, l.reason]).sort(), [["unlinked", "no_tool_use_id"], ["verified", null]]);
    // the fast final copy
    assert.ok(res.responses.some((r) => r.modifiers.speed === "fast"));
  });

  test("claude-depth2 and claude-workflow", async () => {
    const d2 = await parseTree("claude-depth2");
    assert.deepEqual(
      d2.links.map((l) => [l.chain.thread, l.state, l.reason]).sort(),
      [
        ["synthetic-agent-d1", "verified", null],
        ["synthetic-agent-d2", "verified", null],
        ["synthetic-agent-wf1", "unlinked", "no_journal_entry"],
      ],
    );
    const wf = await parseTree("claude-workflow");
    const st = Object.fromEntries(wf.links.map((l) => [l.chain.thread.replace("synthetic-agent-", ""), l.state === "unlinked" ? l.reason : l.state]));
    assert.equal(st["wfa"], "directory");
    assert.equal(st["wfb"], "no_journal_entry");
    assert.equal(st["wfc"], "no_run_file");
    assert.equal(st["wfd"], "run_id_mismatch");
    assert.equal(st["bare"], "no_tool_use_id");
    assert.equal(wf.prefix_hints.length, 2);
  });

  test("claude-replay: replay() writes the copying session id, so the copies are replayed responses (R4.6, R4.7)", async () => {
    const res = await parseTree("claude-replay");
    assert.equal(res.coverage.replay_requests_excluded, 2);
    assert.equal(res.coverage.lines_duplicate_collapsed, 0);
    assert.equal(res.responses.length, 6);
    assert.equal(res.responses.filter((r) => r.ownership.role === "replayed").length, 2);
    assert.equal(res.responses.filter((r) => r.flags.includes("fork_first_own")).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Metamorphic tests (R4.10, R17.6)
// ---------------------------------------------------------------------------
function bigScenario(): GeneratedFile[] {
  const p = new ClaudeProject();
  const s = p.session({ sessionId: "synthetic-session-big", version: V });
  const m = s.main;
  m.user();
  m.request({ requestId: "big-1", usage: { input: 5, write5m: 20000, output: 300 }, blocks: [{ type: "thinking" }, { type: "text" }, { type: "tool_use", name: "Read", id: "synthetic-toolu-t1" }] });
  m.user({ toolResultFor: "synthetic-toolu-t1" });
  m.request({ requestId: "big-2", usage: { input: 8, cacheRead: 20000, write1h: 1500, output: 120 }, diagnostics: { type: "tools_changed", cacheMissedInputTokens: 100 } });
  m.compactBoundary({ trigger: "manual", preTokens: 21500, postTokens: 4000 });
  m.user({ compactSummary: true });
  m.request({ requestId: "big-3", usage: { input: 7, write5m: 4500, output: 60 }, finalSpeed: null, blocks: [{ type: "text" }, { type: "text" }] });
  m.request({ requestId: "big-err", apiError: true });
  m.request({ requestId: "big-4", usage: { input: 3, cacheRead: 100, writeTotal: 0, write1h: 7, output: 5 }, extra: { serverClassifierRequest: true } });
  m.attachment();
  const { agent } = s.spawnAgent({ spawnDepth: 1 });
  agent.thread.user();
  agent.thread.request({ requestId: "big-a1", usage: { input: 4, write5m: 8000, output: 200 } });
  agent.thread.request({ requestId: "big-a2", usage: { input: 4, cacheRead: 8000, write5m: 300, output: 50 } });
  s.agent({ agentId: "synthetic-agent-orphan", toolUseId: null }).thread.request({ requestId: "big-o1", usage: { input: 3, write5m: 1000, output: 10 } });
  s.workflowRun({ runId: "synthetic-run-big", journal: [{ type: "started", agentId: "synthetic-agent-wf" }] });
  s.agent({ agentId: "synthetic-agent-wf", workflowRunId: "synthetic-run-big", omitMeta: true }).thread.request({ requestId: "big-w1", usage: { input: 3, write5m: 900, output: 20 } });
  const unv = m.request({ requestId: "big-unv", usage: { input: 1 } });
  for (const r of unv.records) r.version = "2.1.290";
  const files = p.files();
  // lines the builder cannot make: an unlisted type, a parse error, an unkeyed record
  return mapContent(files, "synthetic-session-big.jsonl", (t) => {
    const lines = t.trimEnd().split("\n");
    const unkeyed = JSON.parse(lines.find((l) => l.includes('"requestId":"big-2"')) as string);
    delete unkeyed.requestId;
    unkeyed.uuid = "synthetic-uuid-unkeyed";
    lines.splice(4, 0, '{"type":"summary","leafUuid":"synthetic-leaf"}', "{broken json", JSON.stringify(unkeyed));
    return lines.join("\n") + "\n";
  });
}

function splitLines(text: string): string[] {
  return text.trimEnd().split("\n");
}

/** Deterministic PRNG so the shuffles are reproducible. */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x1_0000_0000;
  };
}
function shuffled<T>(a: readonly T[], seed: number): T[] {
  const r = rng(seed);
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

describe("metamorphic: order, duplication, splitting, re-serialization (R4.10, R17.6)", () => {
  const MAIN = "synthetic-session-big.jsonl";

  test("the scenario exercises what the metamorphic tests need", async () => {
    const res = await run(bigScenario());
    assert.equal(res.responses.length, 9);
    assert.equal(res.coverage.api_error_records, 1);
    assert.equal(res.coverage.records_unkeyed, 1);
    assert.equal(res.coverage.lines_parse_error, 1);
    assert.equal(res.coverage.unlisted_type_count, 1);
    assert.equal(res.coverage.requests_unverified_version, 1);
    assert.equal(res.compact_boundaries.length, 1);
    assert.equal(res.coverage.links_verified, 1);
    assert.equal(res.coverage.links_directory_only, 1);
    assert.equal(res.coverage.links_unlinked, 1);
  });

  test("shuffling the order of files does not change anything", async () => {
    const files = await load(bigScenario());
    const base = canon(await parseClaude(files), { physical: true, provenance: true });
    for (const seed of [1, 2, 3, 4, 5]) {
      same(canon(await parseClaude(shuffled(files, seed)), { physical: true, provenance: true }), base, `seed ${seed}`);
    }
    assert.equal(canon(await parseClaude([...files].reverse()), { physical: true, provenance: true }), base);
  });

  test("shuffling lines within every file does not change anything", async () => {
    const gen = bigScenario();
    const base = canon(await run(gen), { physical: true, provenance: true });
    for (const seed of [11, 12, 13]) {
      const files = gen.map((f, i) => (f.path.endsWith(".jsonl") ? { ...f, content: shuffled(splitLines(String(f.content)), seed + i).join("\n") + "\n" } : f));
      same(canon(await run(files), { physical: true, provenance: true }), base, `seed ${seed}`);
    }
  });

  test("re-serializing every line with reversed key order does not change anything", async () => {
    const gen = bigScenario();
    const rev = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(rev);
      if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v as object).reverse().map(([k, x]) => [k, rev(x)]));
      return v;
    };
    const files = gen.map((f) => {
      if (!f.path.endsWith(".jsonl") && !f.path.endsWith(".json")) return f;
      const lines = splitLines(String(f.content)).map((l) => {
        try {
          return JSON.stringify(rev(JSON.parse(l)));
        } catch {
          return l;
        }
      });
      return { ...f, content: lines.join("\n") + "\n" };
    });
    assert.equal(canon(await run(files), { physical: true, provenance: true }), canon(await run(gen), { physical: true, provenance: true }));
  });

  test("duplicating any line k times changes no logical result and exactly the physical counters of R17.6", async () => {
    const gen = bigScenario();
    const base = await run(gen);
    const baseLogical = canon(base, { provenance: true });
    const lines = splitLines(String(gen.find((f) => f.path.endsWith(MAIN))?.content));
    const KNOWN = new Set(["assistant", "user", "system", "attachment", "cost-state"]);
    const FULL = new Set(["2.1.286", "2.1.288", "2.1.289", "2.1.291", "2.1.293"]);
    const counts = new Map<string, number>();
    for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
    for (const k of [1, 3]) {
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i] as string;
        const next = [...lines.slice(0, i + 1), ...Array.from({ length: k }, () => line), ...lines.slice(i + 1)];
        const files = gen.map((f) => (f.path.endsWith(MAIN) ? { ...f, content: next.join("\n") + "\n" } : f));
        const res = await run(files);
        assert.equal(canon(res, { provenance: true }), baseLogical, `line ${i} x${k}: logical output unchanged`);
        // expected physical deltas
        let parsed: any = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          /* parse error line */
        }
        const exp: Partial<Record<CoverageCountField, number>> = { lines_total: k };
        if (parsed === null) {
          exp.lines_parse_error = k;
        } else {
          const known = typeof parsed === "object" && KNOWN.has(parsed.type);
          if (known) exp.known_type_count = k;
          else exp.unlisted_type_count = k;
          exp.lines_duplicate_collapsed = k;
          if ((counts.get(line) ?? 0) === 1) exp.duplicate_records_collapsed = 1;
          if (known && parsed.type !== "cost-state" && !FULL.has(parsed.version)) exp.lines_unverified_version = k;
        }
        for (const f of Object.keys(base.coverage) as Array<keyof typeof base.coverage>) {
          if (typeof base.coverage[f] !== "number") continue;
          const want = (base.coverage[f] as number) + (exp[f as CoverageCountField] ?? 0);
          assert.equal(res.coverage[f], want, `line ${i} x${k}: ${String(f)}`);
        }
      }
    }
  });

  test("splitting the main file at every line boundary changes only file counters and provenance", async () => {
    const gen = bigScenario();
    const base = await run(gen);
    const baseLogical = canon(base);
    const main = gen.find((f) => f.path.endsWith(MAIN)) as GeneratedFile;
    const lines = splitLines(String(main.content));
    for (let cut = 1; cut < lines.length; cut++) {
      const second: GeneratedFile = { path: main.path.replace("projects/synthetic-project/", "projects/synthetic-project-b/"), content: lines.slice(cut).join("\n") + "\n" };
      const files = [...gen.map((f) => (f === main ? { ...f, content: lines.slice(0, cut).join("\n") + "\n" } : f)), second];
      const res = await run(files);
      assert.equal(canon(res), baseLogical, `cut ${cut}`);
      assert.equal(res.coverage.files_total, base.coverage.files_total + 1);
      assert.equal(res.coverage.lines_total, base.coverage.lines_total);
      assert.equal(res.coverage.lines_duplicate_collapsed, base.coverage.lines_duplicate_collapsed);
    }
  });

  test("splitting an agent file keeps its link (identity is read per record)", async () => {
    const gen = bigScenario();
    const base = await run(gen);
    const agent = gen.find((f) => /subagents\/agent-synthetic-agent-0001\.jsonl$/.test(f.path)) as GeneratedFile;
    assert.ok(agent);
    const lines = splitLines(String(agent.content));
    const second: GeneratedFile = { path: agent.path.replace("projects/synthetic-project/", "projects/synthetic-project-b/"), content: lines.slice(1).join("\n") + "\n" };
    const files = [...gen.map((f) => (f === agent ? { ...f, content: lines[0] + "\n" } : f)), second];
    const res = await run(files);
    assert.equal(canon(res), canon(base));
    assert.equal(res.coverage.links_verified, 1);
  });

  test("a whole file copied to another location only adds provenance and physical counters", async () => {
    const gen = bigScenario();
    const base = await run(gen);
    const main = gen.find((f) => f.path.endsWith(MAIN)) as GeneratedFile;
    const copy: GeneratedFile = { path: main.path.replace("projects/synthetic-project/", "projects/synthetic-project-b/"), content: main.content };
    const res = await run([...gen, copy]);
    assert.equal(canon(res), canon(base));
    const r = res.responses.find((x) => x.key === "big-1") as ClaudeResponse;
    assert.equal(r.provenance.files.length, 2);
  });

  test("replay scenarios are invariant under file order, line shuffles, duplicates and splits", async () => {
    const T0 = Date.UTC(2026, 0, 1);
    const p = new ClaudeProject();
    const a = p.session({ sessionId: "synthetic-session-a", version: V, startMs: T0 });
    a.main.user();
    a.main.request({ requestId: "ra1", usage: { input: 5, write5m: 10000, output: 100 } });
    a.main.user();
    a.main.request({ requestId: "ra2", usage: { input: 5, cacheRead: 10000, write5m: 500, output: 100 } });
    const b = p.session({ sessionId: "synthetic-session-b", version: V, startMs: T0 + 3_600_000 });
    b.main.replay(a.main.records.slice(1).map((r) => ({ ...structuredClone(r), sessionId: "synthetic-session-b" })));
    b.main.user();
    b.main.request({ requestId: "rb1", usage: { input: 5, cacheRead: 10500, write5m: 700, output: 150 } });
    const gen = p.files();
    const base = await run(gen);
    assert.equal(base.coverage.replay_requests_excluded, 2);
    const baseText = canon(base, { provenance: true, physical: true });
    const files = await load(gen);
    same(canon(await parseClaude([...files].reverse()), { provenance: true, physical: true }), baseText, "file order");
    const bFile = gen.find((f) => f.path.endsWith("synthetic-session-b.jsonl")) as GeneratedFile;
    const lines = splitLines(String(bFile.content));
    const shuffledGen = gen.map((f) => (f === bFile ? { ...f, content: shuffled(lines, 7).join("\n") + "\n" } : f));
    same(canon(await run(shuffledGen), { provenance: true, physical: true }), baseText, "line shuffle");
    for (let cut = 1; cut < lines.length; cut++) {
      const second: GeneratedFile = { path: bFile.path.replace("projects/synthetic-project/", "projects/synthetic-project-b/"), content: lines.slice(cut).join("\n") + "\n" };
      const split = [...gen.map((f) => (f === bFile ? { ...f, content: lines.slice(0, cut).join("\n") + "\n" } : f)), second];
      same(canon(await run(split)), canon(base), `split at ${cut}`);
    }
    const dup = gen.map((f) => (f === bFile ? { ...f, content: [...lines.slice(0, 3), ...lines.slice(0, 3), ...lines.slice(3)].join("\n") + "\n" } : f));
    const dres = await run(dup);
    same(canon(dres, { provenance: true }), canon(base, { provenance: true }), "duplicates");
    assert.equal(dres.coverage.lines_duplicate_collapsed, 3);
  });

  test("the whole result is a pure function of the files (two runs, byte equal)", async () => {
    const files = await load(bigScenario());
    assert.equal(canon(await parseClaude(files), { physical: true, provenance: true }), canon(await parseClaude(files), { physical: true, provenance: true }));
  });
});
