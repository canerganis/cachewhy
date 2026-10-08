// Tests for src/graph/index.ts. Inputs are synthetic in-memory parse results (no real ids, paths or text).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, countedByKind, countedResponseIndices, summarizeLinks } from "../../src/graph/index.js";
import { chainKeyString, emptyCoverage } from "../../src/model/types.js";
import type {
  ChainKey,
  ClaudeParseResult,
  ClaudeResponse,
  ClaudeUuidNode,
  CodexParseResult,
  CodexResponse,
  ExcludedRecord,
  ExclusionReason,
  FileInfo,
  Graph,
  Link,
  ParseResult,
  RequestKind,
  Response,
  Stream,
  UsageBuckets,
} from "../../src/model/types.js";

// ---------------------------------------------------------------------------
// synthetic builders
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 0, 1);
const sec = (s: number): number => T0 + s * 1000;
const WIDE = { since_ms: T0 - 1e12, until_ms: T0 + 1e12 };

function usage(o: { i?: bigint; r?: bigint; w5?: bigint; w1?: bigint; wu?: bigint; cw?: bigint } = {}): UsageBuckets {
  return {
    input_uncached: o.i ?? 10n,
    cache_read: o.r ?? 0n,
    cache_write_5m: o.w5 ?? 0n,
    cache_write_1h: o.w1 ?? 0n,
    cache_write_unknown_ttl: o.wu ?? 0n,
    cache_write: o.cw ?? 0n,
    output: 5n,
    output_lower_bound: 5n,
    reasoning: null,
    reasoning_included_in_output: false,
  };
}

interface RespOpts {
  key: string;
  t: number;
  session?: string;
  thread?: string;
  kind?: RequestKind;
  role?: "owner" | "replayed";
  i?: bigint;
  r?: bigint;
  w5?: bigint;
  w1?: bigint;
  wu?: bigint;
  excl?: ExclusionReason;
  asm?: number | null;
  parent_uuid?: string | null;
  files?: number[];
  start?: number | null;
}

function claude(o: RespOpts): ClaudeResponse {
  const chain: ChainKey = { provider: "claude", root_session: o.session ?? "s1", thread: o.thread ?? "main" };
  const t = sec(o.t);
  const asm = o.asm === undefined || o.asm === null ? null : sec(o.asm);
  return {
    provider: "claude",
    key: o.key,
    chain,
    kind: o.kind ?? (chain.thread === "main" ? "main" : "subagent"),
    version: "2.1.293",
    support: "full",
    model: { candidate: "m", verified: true, source: "claude_explicit", model: "m" },
    usage: o.excl ? null : usage(o),
    exclusion: o.excl ?? null,
    flags: [],
    modifiers: { speed: "standard", inference_geo: null, service_tier: null },
    effort: null,
    time: {
      event_ms: t,
      t_first_ms: t,
      t_last_ms: t,
      t_asm_ms: asm,
      start_lo_ms: asm !== null && asm <= t ? asm : null,
      start_hi_ms: t,
      gap_basis: asm !== null && asm <= t ? "parent_record" : "none",
    },
    ordinal: null,
    ownership: { role: o.role ?? "owner", ambiguous: false, owner_stream_start_ms: null },
    provenance: { files: o.files ?? [0], from_copy_exposed_file: false },
    message_id: `m-${o.key}`,
    uuid: `u-${o.key}`,
    parent_uuid: o.parent_uuid ?? null,
    is_sidechain: chain.thread !== "main",
    entrypoint: "cli",
    per_turn_effort: null,
    advisor_model: null,
    stop_reason: "end_turn",
    diag: null,
    copies: 1,
  };
}

function codex(o: RespOpts & { thread?: string; root?: string }): CodexResponse {
  const thread = o.thread ?? "th1";
  const root = o.root ?? o.session ?? "root1";
  const t = sec(o.t);
  return {
    provider: "codex",
    key: o.key,
    chain: { provider: "codex", root_session: root, thread },
    kind: o.kind ?? "main",
    version: "0.160.1",
    support: "full",
    model: { candidate: "g", verified: true, source: "own_turn", model: "g" },
    usage: o.excl ? null : usage({ ...o, cw: 0n }),
    exclusion: o.excl ?? null,
    flags: [],
    modifiers: { speed: null, inference_geo: null, service_tier: null },
    effort: null,
    time: { event_ms: t, t_first_ms: t, t_last_ms: t, t_asm_ms: null, start_lo_ms: null, start_hi_ms: t, gap_basis: "none" },
    ordinal: null,
    ownership: { role: o.role ?? "owner", ambiguous: false, owner_stream_start_ms: null },
    provenance: { files: o.files ?? [0], from_copy_exposed_file: false },
    thread_id: thread,
    session_id: root,
    turn_id: null,
    root_turn_id: null,
    comp_hash: null,
    collaboration_mode: null,
    thread_total: null,
  };
}

function mkStream(chain: ChainKey, o: Partial<Stream> = {}): Stream {
  return {
    chain,
    provider: chain.provider,
    files: [0],
    start_ms: T0,
    ordinal_verified: chain.provider === "codex" ? true : null,
    integrity_unverified: false,
    integrity_reasons: [],
    fork: null,
    has_settings_marker: false,
    ...o,
  };
}

function autoStreams(rs: readonly Response[], extra: readonly ChainKey[] = []): Stream[] {
  const m = new Map<string, ChainKey>();
  for (const r of rs) m.set(chainKeyString(r.chain), r.chain);
  for (const c of extra) m.set(chainKeyString(c), c);
  return [...m.values()].map((c) => mkStream(c));
}

function fileInfo(index: number, provider: "claude" | "codex", o: Partial<FileInfo> = {}): FileInfo {
  return {
    index,
    provider,
    source_kind: provider === "claude" ? "claude-main" : "codex-rollout",
    versions: [],
    support: "full",
    readable: true,
    archived: false,
    stream_assignment: "assigned",
    copy_exposed: false,
    without_response_id: false,
    lines: 1,
    ...o,
  };
}

function claudeResult(o: {
  responses?: ClaudeResponse[];
  excluded?: ExcludedRecord[];
  streams?: Stream[] | "auto";
  links?: Link[];
  files?: FileInfo[];
  uuids?: [string, ClaudeUuidNode][];
}): ClaudeParseResult {
  const responses = o.responses ?? [];
  return {
    provider: "claude",
    responses,
    excluded: o.excluded ?? [],
    coverage: emptyCoverage(),
    conflicts: [],
    links: o.links ?? [],
    streams: o.streams === undefined || o.streams === "auto" ? autoStreams(responses) : o.streams,
    files: o.files ?? [fileInfo(0, "claude")],
    assumptions: [],
    uuid_index: new Map(o.uuids ?? []),
    compact_boundaries: [],
    prefix_hints: [],
    cost_state: [],
  };
}

function codexResult(o: {
  responses?: CodexResponse[];
  excluded?: ExcludedRecord[];
  streams?: Stream[] | "auto";
  links?: Link[];
  files?: FileInfo[];
}): CodexParseResult {
  const responses = o.responses ?? [];
  return {
    provider: "codex",
    responses,
    excluded: o.excluded ?? [],
    coverage: emptyCoverage(),
    conflicts: [],
    links: o.links ?? [],
    streams: o.streams === undefined || o.streams === "auto" ? autoStreams(responses) : o.streams,
    files: o.files ?? [fileInfo(0, "codex")],
    assumptions: [],
    compactions: [],
    thread_totals: [],
    forked_from_ids: new Set(),
  };
}

function excludedRec(chain: ChainKey, t: number, reason: ExcludedRecord["reason"] = "api_error", ordinal: number | null = null): ExcludedRecord {
  return { provider: chain.provider, chain, reason, event_ms: sec(t), ordinal, files: [0] };
}

function link(chain: ChainKey, kind: "subagent" | "workflow_agent", state: Link["state"], o: Partial<Link> = {}): Link {
  return { chain, kind, state, reason: null, parent: null, depth: null, is_fork: false, ...o };
}

const MAIN: ChainKey = { provider: "claude", root_session: "s1", thread: "main" };
const agentKey = (id: string, session = "s1"): ChainKey => ({ provider: "claude", root_session: session, thread: id });

/** Locate a response in the graph. */
function at(g: Graph, key: string, thread?: string): { i: number; r: Response; n: Graph["nodes"][number] } {
  const i = g.responses.findIndex((r) => r.key === key && (thread === undefined || r.chain.thread === thread));
  assert.ok(i >= 0, `response ${key} missing`);
  return { i, r: g.responses[i] as Response, n: g.nodes[i] as Graph["nodes"][number] };
}

function canon(g: Graph, strip = false): string {
  return JSON.stringify(g, (k, v: unknown) => {
    if (typeof v === "bigint") return `${v}n`;
    if (v instanceof Map) return [...v.entries()];
    if (v instanceof Set) return [...v];
    if (strip && (k === "provenance" || k === "files")) return undefined;
    return v;
  });
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

// ---------------------------------------------------------------------------
// order, P(C), ties, excluded between (R6.1, R6.2)
// ---------------------------------------------------------------------------

test("R6.1 chain order is (event time, key) and P is the immediately preceding request", () => {
  const rs = [claude({ key: "c", t: 30 }), claude({ key: "a", t: 10 }), claude({ key: "b", t: 20 })];
  const g = buildGraph([claudeResult({ responses: rs })], { window: WIDE });
  assert.deepEqual(g.responses.map((r) => r.key), ["a", "b", "c"]);
  assert.equal(g.chains.length, 1);
  assert.deepEqual(g.chains[0]?.order, [0, 1, 2]);
  assert.deepEqual(g.nodes.map((n) => [n.seq, n.prev]), [[0, null], [1, 0], [2, 1]]);
  assert.ok(g.nodes.every((n) => !n.order_tie && !n.excluded_between && !n.prev_is_replayed));
});

test("R6.1 equal event time orders by key and marks both requests as a tie", () => {
  const rs = [claude({ key: "b", t: 10 }), claude({ key: "a", t: 10 }), claude({ key: "c", t: 20 }), claude({ key: "z", t: 5 })];
  const g = buildGraph([claudeResult({ responses: rs })], { window: WIDE });
  assert.deepEqual(g.responses.map((r) => r.key), ["z", "a", "b", "c"]);
  assert.deepEqual(g.nodes.map((n) => n.order_tie), [false, true, true, false]);
  assert.equal(at(g, "c").n.prev, at(g, "b").i);
});

test("R6.1 a tie with a keyless excluded record also makes the request a tie", () => {
  const rs = [claude({ key: "a", t: 10 }), claude({ key: "b", t: 20 })];
  const g = buildGraph([claudeResult({ responses: rs, excluded: [excludedRec(MAIN, 20, "unkeyed")] })], { window: WIDE });
  assert.equal(at(g, "a").n.order_tie, false);
  assert.equal(at(g, "b").n.order_tie, true);
});

test("R6.2 removed requests are skipped as P and flagged as excluded between", () => {
  const rs = [
    claude({ key: "k1", t: 10 }),
    claude({ key: "bad", t: 20, excl: "conflict_input" }),
    claude({ key: "k2", t: 30 }),
    claude({ key: "k3", t: 40 }),
  ];
  const g = buildGraph([claudeResult({ responses: rs })], { window: WIDE });
  const k2 = at(g, "k2");
  assert.equal(k2.n.prev, at(g, "k1").i, "the removed request is not P");
  assert.equal(k2.n.excluded_between, true);
  assert.equal(at(g, "k3").n.excluded_between, false);
  const bad = at(g, "bad");
  assert.equal(bad.n.prev, null);
  assert.equal(bad.n.ttl_set, null);
  assert.equal(bad.n.gap, null);
});

test("R6.2 keyless, api-error and unverified-version records sit between P and C", () => {
  for (const reason of ["unkeyed", "api_error", "unverified_version"] as const) {
    const rs = [claude({ key: "k1", t: 10 }), claude({ key: "k2", t: 30 })];
    const g = buildGraph([claudeResult({ responses: rs, excluded: [excludedRec(MAIN, 20, reason)] })], { window: WIDE });
    assert.equal(at(g, "k2").n.excluded_between, true, reason);
    assert.equal(at(g, "k1").n.excluded_between, false, reason);
    assert.equal(g.excluded.length, 1);
  }
});

test("R6.2 an excluded record before the first kept request marks it (its first-ness cannot be asserted)", () => {
  const rs = [claude({ key: "k1", t: 30 })];
  const g = buildGraph([claudeResult({ responses: rs, excluded: [excludedRec(MAIN, 10)] })], { window: WIDE });
  const n = at(g, "k1").n;
  assert.equal(n.prev, null);
  assert.equal(n.excluded_between, true);
});

test("R6.2, R4.7 a replayed request stays in the history and can be P", () => {
  const rs = [claude({ key: "rep", t: 10, role: "replayed" }), claude({ key: "own", t: 20 })];
  const g = buildGraph([claudeResult({ responses: rs })], { window: WIDE });
  const own = at(g, "own");
  assert.equal(own.n.prev, at(g, "rep").i);
  assert.equal(own.n.prev_is_replayed, true);
  assert.equal(at(g, "rep").n.prev_is_replayed, false);
});

test("a response from a codex chain keeps ordering and ties but has no TTL set (R9.6)", () => {
  const rs = [codex({ key: "x2", t: 20, w5: 5n }), codex({ key: "x1", t: 10 })];
  const g = buildGraph([codexResult({ responses: rs })], { window: WIDE });
  assert.deepEqual(g.responses.map((r) => r.key), ["x1", "x2"]);
  assert.equal(at(g, "x2").n.ttl_set, null);
  assert.equal(at(g, "x2").n.prev, 0);
});

// ---------------------------------------------------------------------------
// window and baseline (R5.9, R5.10)
// ---------------------------------------------------------------------------

test("R5.9, R5.10 window is half-open on event time; baseline requests stay as P and in the TTL set", () => {
  const rs = [
    claude({ key: "base", t: 50, w1: 100n }),
    claude({ key: "in1", t: 100, r: 100n }),
    claude({ key: "in2", t: 199, r: 100n }),
    claude({ key: "out1", t: 200, r: 100n }),
    claude({ key: "out2", t: 300, r: 100n }),
  ];
  const g = buildGraph([claudeResult({ responses: rs })], { window: { since_ms: sec(100), until_ms: sec(200) } });
  assert.deepEqual(g.nodes.map((n) => n.in_window), [false, true, true, false, false]);
  const in1 = at(g, "in1");
  assert.equal(in1.n.prev, at(g, "base").i, "P may lie before the window");
  assert.deepEqual(in1.n.ttl_set, { has_5m: false, has_1h: true, ttl_unknown: false });
  assert.deepEqual(countedResponseIndices(g).map((i) => (g.responses[i] as Response).key), ["in1", "in2"]);
});

test("R5.9 event time alone decides: file position and provenance do not matter", () => {
  const a = claude({ key: "a", t: 10, files: [0] });
  const b = claude({ key: "b", t: 150, files: [7, 3] });
  const g = buildGraph([claudeResult({ responses: [b, a], files: [fileInfo(0, "claude"), fileInfo(3, "claude"), fileInfo(7, "claude")] })], {
    window: { since_ms: sec(100), until_ms: sec(200) },
  });
  assert.deepEqual(g.nodes.map((n) => n.in_window), [false, true]);
});

// ---------------------------------------------------------------------------
// TTL sets (R9.2)
// ---------------------------------------------------------------------------

function ttlOf(rs: ClaudeResponse[], key: string, excluded: ExcludedRecord[] = []) {
  const g = buildGraph([claudeResult({ responses: rs, excluded })], { window: WIDE });
  return at(g, key).n.ttl_set;
}

test("R9.2 the set covers requests up to and including P, never C", () => {
  const rs = [claude({ key: "r1", t: 10, w1: 100n }), claude({ key: "r2", t: 20, r: 100n, w5: 50n }), claude({ key: "r3", t: 30, r: 150n })];
  assert.equal(ttlOf(rs, "r1"), null);
  assert.deepEqual(ttlOf(rs, "r2"), { has_5m: false, has_1h: true, ttl_unknown: false });
  assert.deepEqual(ttlOf(rs, "r3"), { has_5m: true, has_1h: true, ttl_unknown: false });
});

test("R9.2 5m only and 1h only", () => {
  assert.deepEqual(ttlOf([claude({ key: "a", t: 1, w5: 10n }), claude({ key: "b", t: 2, r: 10n })], "b"), {
    has_5m: true,
    has_1h: false,
    ttl_unknown: false,
  });
  assert.deepEqual(ttlOf([claude({ key: "a", t: 1, w1: 10n }), claude({ key: "b", t: 2, r: 10n })], "b"), {
    has_5m: false,
    has_1h: true,
    ttl_unknown: false,
  });
});

test("R9.2 a write of unknown TTL sets ttl_unknown", () => {
  assert.equal(ttlOf([claude({ key: "a", t: 1, wu: 10n }), claude({ key: "b", t: 2 })], "b")?.ttl_unknown, true);
});

test("R9.2 (a) a read larger than K(prev) sets ttl_unknown; equal does not; a first request with R > 0 does", () => {
  const first = [claude({ key: "a", t: 1, r: 5n }), claude({ key: "b", t: 2 })];
  assert.equal(ttlOf(first, "b")?.ttl_unknown, true);
  const above = [claude({ key: "a", t: 1, w5: 100n }), claude({ key: "b", t: 2, r: 101n }), claude({ key: "c", t: 3 })];
  assert.equal(ttlOf(above, "c")?.ttl_unknown, true);
  const equal = [claude({ key: "a", t: 1, w5: 100n }), claude({ key: "b", t: 2, r: 100n }), claude({ key: "c", t: 3 })];
  assert.equal(ttlOf(equal, "c")?.ttl_unknown, false);
  // K(prev) is r + w of the previous request, so a pure-read chain keeps reading what it read.
  const pure = [claude({ key: "a", t: 1, w1: 100n }), claude({ key: "b", t: 2, r: 100n }), claude({ key: "c", t: 3, r: 100n }), claude({ key: "d", t: 4 })];
  assert.equal(ttlOf(pure, "d")?.ttl_unknown, false);
});

test("R9.2 (b) a removed request before P sets ttl_unknown; one between P and C does not (it is not in the set)", () => {
  const before = [claude({ key: "a", t: 1, w5: 10n }), claude({ key: "bad", t: 2, excl: "conflict_input" }), claude({ key: "b", t: 3, r: 10n }), claude({ key: "c", t: 4 })];
  assert.equal(ttlOf(before, "c")?.ttl_unknown, true);
  const rec = [claude({ key: "a", t: 1, w5: 10n }), claude({ key: "b", t: 3, r: 10n }), claude({ key: "c", t: 4 })];
  assert.equal(ttlOf(rec, "c", [excludedRec(MAIN, 2)])?.ttl_unknown, true);
  const between = [claude({ key: "a", t: 1, w5: 10n }), claude({ key: "bad", t: 2, excl: "conflict_input" }), claude({ key: "c", t: 4, r: 10n })];
  assert.equal(ttlOf(between, "c")?.ttl_unknown, false);
});

test("R9.2 replayed requests and baseline requests are part of the set", () => {
  const rs = [claude({ key: "rep", t: 1, w1: 10n, role: "replayed" }), claude({ key: "own", t: 2, r: 10n })];
  assert.deepEqual(ttlOf(rs, "own"), { has_5m: false, has_1h: true, ttl_unknown: false });
});

test("R9.2 mixed buckets in one request are both recorded", () => {
  assert.deepEqual(ttlOf([claude({ key: "a", t: 1, w5: 5n, w1: 5n }), claude({ key: "b", t: 2 })], "b"), {
    has_5m: true,
    has_1h: true,
    ttl_unknown: false,
  });
});

// ---------------------------------------------------------------------------
// gap bounds (R6.3 to R6.6)
// ---------------------------------------------------------------------------

test("R6.6 gap_min = start_lo(C) - start_hi(P), gap_max = start_hi(C) - start_lo(P), unknown ends are null", () => {
  const rs = [claude({ key: "p", t: 100 }), claude({ key: "c", t: 500, asm: 150 })];
  const g = buildGraph([claudeResult({ responses: rs })], { window: WIDE });
  assert.deepEqual(at(g, "c").n.gap, { min_ms: 50_000, max_ms: null, basis: "parent_record" });

  const both = [claude({ key: "p", t: 100, asm: 90 }), claude({ key: "c", t: 500, asm: 150 })];
  const g2 = buildGraph([claudeResult({ responses: both })], { window: WIDE });
  assert.deepEqual(at(g2, "c").n.gap, { min_ms: 50_000, max_ms: 410_000, basis: "parent_record" });

  const none = [claude({ key: "p", t: 100 }), claude({ key: "c", t: 500 })];
  const g3 = buildGraph([claudeResult({ responses: none })], { window: WIDE });
  assert.deepEqual(at(g3, "c").n.gap, { min_ms: null, max_ms: null, basis: "none" });
  assert.equal(at(g3, "p").n.gap, null);
});

test("R6.6 a negative gap_min is clamped to 0", () => {
  const rs = [claude({ key: "p", t: 100 }), claude({ key: "c", t: 500, asm: 80 })];
  const g = buildGraph([claudeResult({ responses: rs })], { window: WIDE });
  assert.equal(at(g, "c").n.gap?.min_ms, 0);
});

test("R6.4 a parent record later than t_first is no bound", () => {
  const rs = [claude({ key: "p", t: 100 }), claude({ key: "c", t: 500, asm: 600 })];
  const g = buildGraph([claudeResult({ responses: rs })], { window: WIDE });
  assert.equal(at(g, "c").n.gap?.min_ms, null);
});

test("R6.3 t_asm is resolved through the global uuid index when the parser left it empty", () => {
  const node: ClaudeUuidNode = {
    uuid: "up",
    parent_uuid: null,
    logical_parent_uuid: null,
    ts_ms: sec(250),
    is_compact_summary: false,
    is_compact_boundary: false,
    chain: MAIN,
  };
  const rs = [claude({ key: "p", t: 100 }), claude({ key: "c", t: 500, parent_uuid: "up" })];
  const g = buildGraph([claudeResult({ responses: rs, uuids: [["up", node]] })], { window: WIDE });
  assert.equal(at(g, "c").n.gap?.min_ms, 150_000);
  assert.equal(g.claude.uuid_index.get("up")?.ts_ms, sec(250));
});

test("R6.5 Codex gap bounds are always unknown with basis none", () => {
  const rs = [codex({ key: "x1", t: 10 }), codex({ key: "x2", t: 4000 })];
  const g = buildGraph([codexResult({ responses: rs })], { window: WIDE });
  assert.deepEqual(at(g, "x2").n.gap, { min_ms: null, max_ms: null, basis: "none" });
});

// ---------------------------------------------------------------------------
// single count (R4.6, R4.7, R5.8)
// ---------------------------------------------------------------------------

test("R5.8 one owner keeps counting, the replayed copy counts zero", () => {
  const mainA = claude({ key: "dup", t: 10, session: "sA" });
  const mainB = claude({ key: "dup", t: 10, session: "sB", role: "replayed" });
  const g = buildGraph([claudeResult({ responses: [mainA, mainB] })], { window: WIDE });
  assert.equal(g.responses.length, 2);
  assert.equal(countedResponseIndices(g).length, 1);
  assert.equal(((g.responses[countedResponseIndices(g)[0] as number]) as Response).chain.root_session, "sA");
});

test("R4.6 two owners of a key: the earlier stream_start owns, the other is demoted", () => {
  const a = claude({ key: "dup", t: 10, session: "sA" });
  const b = claude({ key: "dup", t: 10, session: "sB" });
  const streams = [mkStream(a.chain, { start_ms: sec(100) }), mkStream(b.chain, { start_ms: sec(50) })];
  const g = buildGraph([claudeResult({ responses: [a, b], streams })], { window: WIDE });
  const counted = countedResponseIndices(g).map((i) => g.responses[i] as Response);
  assert.equal(counted.length, 1);
  assert.equal(counted[0]?.chain.root_session, "sB");
  assert.equal(counted[0]?.ownership.ambiguous, false);
});

test("R4.6 a tie on stream_start makes ownership ambiguous; the smaller sessionId owns", () => {
  const a = claude({ key: "dup", t: 10, session: "sB" });
  const b = claude({ key: "dup", t: 10, session: "sA" });
  const streams = [mkStream(a.chain, { start_ms: sec(5) }), mkStream(b.chain, { start_ms: sec(5) })];
  const g = buildGraph([claudeResult({ responses: [a, b], streams })], { window: WIDE });
  const counted = countedResponseIndices(g).map((i) => g.responses[i] as Response);
  assert.equal(counted.length, 1);
  assert.equal(counted[0]?.chain.root_session, "sA");
  for (const r of g.responses) {
    assert.equal(r.ownership.ambiguous, true);
    assert.ok(r.flags.includes("ownership_ambiguous"));
  }
});

test("R4.4 the same Codex response_id owned by two threads is a conflict and counts nowhere", () => {
  const a = codex({ key: "resp", t: 10, thread: "t1", root: "r" });
  const b = codex({ key: "resp", t: 10, thread: "t2", root: "r" });
  const g = buildGraph([codexResult({ responses: [a, b] })], { window: WIDE });
  assert.equal(countedResponseIndices(g).length, 0);
  assert.ok(g.responses.every((r) => r.exclusion === "conflict_attribution" && r.usage === null));
  const c = codex({ key: "resp2", t: 10, thread: "t1", root: "r", i: 1n });
  const d = codex({ key: "resp2", t: 10, thread: "t2", root: "r", i: 2n });
  const g2 = buildGraph([codexResult({ responses: [c, d] })], { window: WIDE });
  assert.ok(g2.responses.every((r) => r.exclusion === "conflict_usage"));
});

test("feeding the same key twice into one chain collapses it and unions provenance", () => {
  const a = claude({ key: "k", t: 10, files: [0] });
  const b = claude({ key: "k", t: 10, files: [0] });
  const g = buildGraph([claudeResult({ responses: [a], files: [fileInfo(0, "claude")] }), claudeResult({ responses: [b], files: [fileInfo(0, "claude")] })], {
    window: WIDE,
  });
  // overlapping indices, so the second result is shifted: files [0] and [1]
  assert.equal(g.responses.length, 1);
  assert.deepEqual(g.responses[0]?.provenance.files, [0, 1]);
  assert.equal(countedResponseIndices(g).length, 1);
  // the very same object twice is the same input
  const r = claudeResult({ responses: [a] });
  assert.equal(canon(buildGraph([r, r], { window: WIDE })), canon(buildGraph([r], { window: WIDE })));
});

test("unequal counters for one key in one chain are a conflict, not a coin flip", () => {
  const a = claude({ key: "k", t: 10, i: 1n });
  const b = claude({ key: "k", t: 10, i: 2n, files: [1] });
  const g = buildGraph([claudeResult({ responses: [a] }), claudeResult({ responses: [b] })], { window: WIDE });
  assert.equal(g.responses.length, 1);
  assert.equal(g.responses[0]?.exclusion, "conflict_input");
  assert.equal(g.responses[0]?.usage, null);
  assert.equal(countedResponseIndices(g).length, 0);
});

test("R5.8 per-kind subtotals sum to the grand total", () => {
  const sub = agentKey("a1");
  const wf = agentKey("wf1");
  const rs = [
    claude({ key: "m1", t: 10 }),
    claude({ key: "m2", t: 20 }),
    claude({ key: "s1", t: 30, thread: "a1" }),
    claude({ key: "w1", t: 40, thread: "wf1", kind: "workflow_agent" }),
    claude({ key: "rep", t: 50, role: "replayed" }),
    claude({ key: "bad", t: 60, excl: "conflict_input" }),
  ];
  const links = [link(sub, "subagent", "verified", { parent: MAIN, depth: 1 }), link(wf, "workflow_agent", "directory")];
  const g = buildGraph([claudeResult({ responses: rs, links })], { window: WIDE });
  const byKind = countedByKind(g);
  const total = countedResponseIndices(g).length;
  assert.equal(total, 4);
  assert.deepEqual(byKind, { main: 2, subagent: 1, workflow_agent: 1, helper: 0, classifier: 0, advisor: 0 });
  assert.equal(Object.values(byKind).reduce((x, y) => x + y, 0), total);
});

// ---------------------------------------------------------------------------
// linkage (R5.3 to R5.7)
// ---------------------------------------------------------------------------

function linkState(links: Link[], extraMain = true, o: { session?: string } = {}): Graph {
  const rs: ClaudeResponse[] = [];
  const keys = new Map<string, ChainKey>();
  for (const l of links) keys.set(chainKeyString(l.chain), l.chain);
  if (extraMain) keys.set(chainKeyString(MAIN), MAIN);
  let t = 1;
  for (const k of keys.values()) rs.push(claude({ key: `r${t}`, t: t++, session: k.root_session, thread: k.thread, kind: k.thread === "main" ? "main" : "subagent" }));
  void o;
  return buildGraph([claudeResult({ responses: rs, links })], { window: WIDE });
}

function linkOf(g: Graph, thread: string): Link {
  const l = g.chains.find((c) => c.key.thread === thread)?.link;
  assert.ok(l, `no link for ${thread}`);
  return l;
}

test("R5.3 a verified depth 1 subagent with its main chain present stays verified", () => {
  const a = agentKey("a1");
  const g = linkState([link(a, "subagent", "verified", { parent: MAIN, depth: 1 })]);
  const l = linkOf(g, "a1");
  assert.equal(l.state, "verified");
  assert.equal(l.reason, null);
  assert.deepEqual(l.parent, MAIN);
  assert.equal(g.chains.find((c) => c.key.thread === "main")?.link, null);
});

test("R5.3 depth absent counts as depth 1; depth 2 needs an agent parent", () => {
  const a = agentKey("a1");
  const b = agentKey("b1");
  const ok = linkState([link(a, "subagent", "verified", { parent: MAIN, depth: null }), link(b, "subagent", "verified", { parent: a, depth: 2 })]);
  assert.equal(linkOf(ok, "a1").state, "verified");
  assert.equal(linkOf(ok, "b1").state, "verified");
  const d2Main = linkState([link(b, "subagent", "verified", { parent: MAIN, depth: 2 })]);
  assert.equal(linkOf(d2Main, "b1").reason, "parent_agent_mismatch");
  const d1Agent = linkState([link(a, "subagent", "unlinked", { reason: "no_meta" }), link(b, "subagent", "verified", { parent: a, depth: 1 })]);
  assert.equal(linkOf(d1Agent, "b1").reason, "parent_agent_mismatch");
  assert.equal(linkOf(d1Agent, "b1").state, "unlinked");
});

test("R5.3 a verified link whose parent chain is not in the scan is unlinked parent_file_missing", () => {
  const a = agentKey("a1");
  const g = linkState([link(a, "subagent", "verified", { parent: MAIN, depth: 1 })], false);
  const l = linkOf(g, "a1");
  assert.equal(l.state, "unlinked");
  assert.equal(l.reason, "parent_file_missing");
  assert.equal(l.parent, null);
  const none = linkState([link(a, "subagent", "verified", { parent: null, depth: 1 })]);
  assert.equal(linkOf(none, "a1").reason, "parent_file_missing");
});

test("R5.3 a parent in another session is session_mismatch", () => {
  const a = agentKey("a1", "s1");
  const otherMain: ChainKey = { provider: "claude", root_session: "s2", thread: "main" };
  const rs = [claude({ key: "p", t: 1, session: "s2" }), claude({ key: "c", t: 2, session: "s1", thread: "a1" })];
  const g = buildGraph([claudeResult({ responses: rs, links: [link(a, "subagent", "verified", { parent: otherMain, depth: 1 })] })], { window: WIDE });
  assert.equal(linkOf(g, "a1").reason, "session_mismatch");
});

test("R5.3 an unlinked subagent keeps its parser reason; a missing link is unlinked no_meta; main chains have none", () => {
  const a = agentKey("a1");
  const b = agentKey("b1");
  const g = linkState([link(a, "subagent", "unlinked", { reason: "tool_use_not_found" })]);
  assert.equal(linkOf(g, "a1").reason, "tool_use_not_found");
  // no Link record at all for a subagent chain
  const rs = [claude({ key: "m", t: 1 }), claude({ key: "s", t: 2, thread: b.thread })];
  const g2 = buildGraph([claudeResult({ responses: rs })], { window: WIDE });
  const l = linkOf(g2, "b1");
  assert.deepEqual([l.state, l.reason, l.kind], ["unlinked", "no_meta", "subagent"]);
  // a reasonless unlinked record gets the default reason; `directory` does not exist for subagents
  const g3 = linkState([link(a, "subagent", "unlinked"), link(b, "subagent", "directory")]);
  assert.equal(linkOf(g3, "a1").reason, "no_meta");
  assert.equal(linkOf(g3, "b1").state, "unlinked");
});

test("R5.4 workflow agents are never verified; directory is the best; no link means unlinked", () => {
  const w = agentKey("w1");
  const w2 = agentKey("w2");
  const g = linkState([link(w, "workflow_agent", "verified", { parent: MAIN })]);
  const l = linkOf(g, "w1");
  assert.deepEqual([l.state, l.reason], ["directory", null]);
  const g2 = linkState([link(w2, "workflow_agent", "unlinked", { reason: "no_run_file" })]);
  assert.deepEqual([linkOf(g2, "w2").state, linkOf(g2, "w2").reason], ["unlinked", "no_run_file"]);
  const rs = [claude({ key: "m", t: 1 }), claude({ key: "x", t: 2, thread: "w3", kind: "workflow_agent" })];
  const g3 = buildGraph([claudeResult({ responses: rs })], { window: WIDE });
  assert.deepEqual([linkOf(g3, "w3").state, linkOf(g3, "w3").reason, linkOf(g3, "w3").kind], ["unlinked", "no_journal_entry", "workflow_agent"]);
  assert.equal(g3.chains.find((c) => c.key.thread === "w3")?.kind, "workflow_agent");
});

test("R5.6 Codex: verified needs the parent stream in the scan, the same session and a matching fork parent", () => {
  const parent: ChainKey = { provider: "codex", root_session: "r", thread: "p" };
  const child: ChainKey = { provider: "codex", root_session: "r", thread: "c" };
  const mk = (extra: CodexResponse[], l: Link, childStream?: Partial<Stream>) =>
    buildGraph(
      [
        codexResult({
          responses: [codex({ key: "p1", t: 1, thread: "p", root: "r" }), codex({ key: "c1", t: 2, thread: "c", root: "r", kind: "subagent" }), ...extra],
          streams: [mkStream(parent), mkStream(child, childStream)],
          links: [l],
        }),
      ],
      { window: WIDE },
    );
  const ok = mk([], link(child, "subagent", "verified", { parent, depth: 1 }));
  assert.equal(linkOf(ok, "c").state, "verified");
  assert.equal(linkOf(ok, "c").is_fork, false);

  const missing = mk([], link(child, "subagent", "verified", { parent: { provider: "codex", root_session: "r", thread: "gone" } }));
  assert.equal(linkOf(missing, "c").reason, "parent_file_missing");

  const otherRoot: ChainKey = { provider: "codex", root_session: "r2", thread: "p2" };
  const g = buildGraph(
    [
      codexResult({
        responses: [codex({ key: "p1", t: 1, thread: "p2", root: "r2" }), codex({ key: "c1", t: 2, thread: "c", root: "r", kind: "subagent" })],
        links: [link(child, "subagent", "verified", { parent: otherRoot })],
      }),
    ],
    { window: WIDE },
  );
  assert.equal(linkOf(g, "c").reason, "root_mismatch");

  const forkOk = mk([], link(child, "subagent", "verified", { parent }), { fork: { forked_from_id: "p", history_start_ordinal: 3, prefix_resolved: true } });
  assert.equal(linkOf(forkOk, "c").state, "verified");
  assert.equal(linkOf(forkOk, "c").is_fork, true, "a verified linked subagent can still be a fork (R5.7)");
  const forkBad = mk([], link(child, "subagent", "verified", { parent }), { fork: { forked_from_id: "other", history_start_ordinal: 3, prefix_resolved: true } });
  assert.equal(linkOf(forkBad, "c").reason, "fork_parent_mismatch");
});

test("R5.6 a Codex subagent without a link record is unlinked no_parent_id; a main thread has no link", () => {
  const rs = [codex({ key: "m", t: 1, thread: "t0", root: "r" }), codex({ key: "s", t: 2, thread: "t1", root: "r", kind: "subagent" })];
  const g = buildGraph([codexResult({ responses: rs })], { window: WIDE });
  assert.equal(g.chains.find((c) => c.key.thread === "t0")?.link, null);
  assert.deepEqual([linkOf(g, "t1").state, linkOf(g, "t1").reason], ["unlinked", "no_parent_id"]);
});

test("link counters after the graph's checks", () => {
  const a = agentKey("a1");
  const b = agentKey("b1");
  const w = agentKey("w1");
  const u = agentKey("u1");
  const g = linkState([
    link(a, "subagent", "verified", { parent: MAIN, depth: 1 }),
    link(b, "subagent", "verified", { parent: agentKey("ghost"), depth: 1 }),
    link(w, "workflow_agent", "directory"),
    link(u, "subagent", "unlinked", { reason: "no_tool_use_id" }),
  ]);
  const s = summarizeLinks(g);
  assert.equal(s.verified, 1);
  assert.equal(s.directory, 1);
  assert.equal(s.unlinked, 2);
  assert.equal(s.unlinked_by_reason.parent_file_missing, 1);
  assert.equal(s.unlinked_by_reason.no_tool_use_id, 1);
  assert.equal(s.unlinked_by_reason.no_meta, 0);
});

// ---------------------------------------------------------------------------
// streams (R4.11, R4.13)
// ---------------------------------------------------------------------------

test("R4.11 a chain is one logical stream however its records arrive: split Stream records merge", () => {
  const chain: ChainKey = { provider: "codex", root_session: "r", thread: "t" };
  const r1 = codex({ key: "a", t: 10, thread: "t", root: "r", files: [0] });
  const r2 = codex({ key: "b", t: 20, thread: "t", root: "r", files: [0] });
  const half1 = codexResult({ responses: [r1], streams: [mkStream(chain, { files: [0], start_ms: sec(10), ordinal_verified: true })] });
  const half2 = codexResult({ responses: [r2], streams: [mkStream(chain, { files: [0], start_ms: sec(5), ordinal_verified: true })] });
  const g = buildGraph([half1, half2], { window: WIDE });
  assert.equal(g.chains.length, 1);
  const s = g.chains[0]?.stream as Stream;
  assert.deepEqual(s.files, [0, 1]);
  assert.equal(s.start_ms, sec(5));
  assert.equal(s.ordinal_verified, true);
  assert.equal(s.integrity_unverified, false);
  assert.equal(at(g, "b").n.prev, at(g, "a").i);
  // one half failing ordinal verification fails the whole stream; integrity is an OR
  const bad = codexResult({
    responses: [r2],
    streams: [mkStream(chain, { ordinal_verified: false, integrity_unverified: true, integrity_reasons: ["file_stream_conflict"] })],
  });
  const g2 = buildGraph([half1, bad], { window: WIDE });
  const s2 = g2.chains[0]?.stream as Stream;
  assert.equal(s2.ordinal_verified, false);
  assert.equal(s2.integrity_unverified, true);
  assert.deepEqual(s2.integrity_reasons, ["file_stream_conflict"]);
});

test("R4.13 a copy-exposed file makes its stream integrity_unverified even if the Stream record forgot it", () => {
  const chain: ChainKey = { provider: "codex", root_session: "r", thread: "t" };
  const rs = [codex({ key: "a", t: 10, thread: "t", root: "r" })];
  const g = buildGraph([codexResult({ responses: rs, streams: [mkStream(chain)], files: [fileInfo(0, "codex", { copy_exposed: true })] })], { window: WIDE });
  const s = g.chains[0]?.stream as Stream;
  assert.equal(s.integrity_unverified, true);
  assert.deepEqual(s.integrity_reasons, ["copy_exposed_file"]);
});

test("R4.11 divergent fork facts across Stream records make the stream unverified", () => {
  const chain: ChainKey = { provider: "codex", root_session: "r", thread: "t" };
  const rs = [codex({ key: "a", t: 10, thread: "t", root: "r" })];
  const f = (from: string) => mkStream(chain, { fork: { forked_from_id: from, history_start_ordinal: 2, prefix_resolved: true } });
  const g = buildGraph([codexResult({ responses: rs, streams: [f("x")] }), codexResult({ streams: [f("y")] })], { window: WIDE });
  const s = g.chains[0]?.stream as Stream;
  assert.equal(s.integrity_unverified, true);
  assert.deepEqual(s.integrity_reasons, ["divergent_session_meta"]);
});

test("R4.11 no guessing: responses without any Stream record are an unresolved stream", () => {
  const g = buildGraph([claudeResult({ responses: [claude({ key: "a", t: 1 })], streams: [] }), codexResult({ responses: [codex({ key: "b", t: 1 })], streams: [] })], { window: WIDE });
  for (const c of g.chains) assert.equal(c.stream.integrity_unverified, true);
  assert.equal(g.chains.find((c) => c.key.provider === "codex")?.stream.ordinal_verified, false);
  assert.equal(g.chains.find((c) => c.key.provider === "claude")?.stream.ordinal_verified, null);
});

// ---------------------------------------------------------------------------
// files, chains, kinds, misc
// ---------------------------------------------------------------------------

test("file indices: overlapping local indices are shifted, disjoint (shared list) indices are kept", () => {
  const c = claude({ key: "c1", t: 1, files: [0] });
  const x = codex({ key: "x1", t: 1, files: [0] });
  const g = buildGraph([claudeResult({ responses: [c] }), codexResult({ responses: [x] })], { window: WIDE });
  assert.deepEqual(g.files.map((f) => [f.index, f.provider]), [[0, "claude"], [1, "codex"]]);
  assert.deepEqual(at(g, "x1").r.provenance.files, [1]);
  assert.deepEqual(g.chains.find((k) => k.key.provider === "codex")?.stream.files, [1]);

  const c2 = claude({ key: "c1", t: 1, files: [0, 2] });
  const x2 = codex({ key: "x1", t: 1, files: [1] });
  const g2 = buildGraph(
    [
      claudeResult({ responses: [c2], files: [fileInfo(0, "claude"), fileInfo(2, "claude")], streams: [mkStream(c2.chain, { files: [0, 2] })] }),
      codexResult({ responses: [x2], files: [fileInfo(1, "codex")], streams: [mkStream(x2.chain, { files: [1] })] }),
    ],
    { window: WIDE },
  );
  assert.deepEqual(g2.files.map((f) => f.index), [0, 1, 2]);
  assert.deepEqual(at(g2, "x1").r.provenance.files, [1]);
});

test("chain kind comes from the link, then from its responses, then from the chain key", () => {
  const rs = [
    claude({ key: "m", t: 1 }),
    claude({ key: "h", t: 2, thread: "helper", kind: "helper" }),
    claude({ key: "s", t: 3, thread: "a1" }),
  ];
  const g = buildGraph([claudeResult({ responses: rs, links: [link(agentKey("a1"), "subagent", "unlinked", { reason: "no_meta" })] })], { window: WIDE });
  const kinds = Object.fromEntries(g.chains.map((c) => [c.key.thread, c.kind]));
  assert.deepEqual(kinds, { a1: "subagent", helper: "helper", main: "main" });
  assert.equal(g.chains.find((c) => c.key.thread === "helper")?.link, null, "helper chains are not agent links");
  // a chain that only has a removed record
  const g2 = buildGraph([claudeResult({ responses: [], excluded: [excludedRec(agentKey("zz"), 5)], streams: [] })], { window: WIDE });
  assert.equal(g2.chains[0]?.kind, "subagent");
});

test("graph invariants hold on random scenarios", () => {
  const rand = rng(7);
  for (let round = 0; round < 40; round++) {
    const rs: ClaudeResponse[] = [];
    const exc: ExcludedRecord[] = [];
    const nChains = 1 + Math.floor(rand() * 3);
    for (let c = 0; c < nChains; c++) {
      const thread = c === 0 ? "main" : `a${c}`;
      const n = Math.floor(rand() * 12);
      for (let k = 0; k < n; k++) {
        const roll = rand();
        rs.push(
          claude({
            key: `k${c}-${k}`,
            t: Math.floor(rand() * 8),
            thread,
            excl: roll < 0.1 ? "conflict_input" : undefined,
            role: roll > 0.9 ? "replayed" : "owner",
            r: BigInt(Math.floor(rand() * 3) * 10),
            w5: BigInt(Math.floor(rand() * 2) * 10),
          }),
        );
      }
      if (rand() < 0.3) exc.push(excludedRec({ provider: "claude", root_session: "s1", thread }, Math.floor(rand() * 8)));
    }
    const g = buildGraph([claudeResult({ responses: rs, excluded: exc })], { window: { since_ms: sec(2), until_ms: sec(6) } });
    assert.equal(g.nodes.length, g.responses.length);
    assert.equal(g.responses.length, rs.length);
    const seen = new Set<number>();
    g.chains.forEach((c, ci) => {
      c.order.forEach((idx, pos) => {
        assert.ok(!seen.has(idx));
        seen.add(idx);
        const n = g.nodes[idx] as Graph["nodes"][number];
        assert.equal(n.response, idx);
        assert.equal(n.chain, ci);
        assert.equal(n.seq, pos);
        assert.equal(chainKeyString((g.responses[idx] as Response).chain), chainKeyString(c.key));
        if (pos > 0) {
          const prevR = g.responses[c.order[pos - 1] as number] as Response;
          const r = g.responses[idx] as Response;
          assert.ok(prevR.time.event_ms < r.time.event_ms || (prevR.time.event_ms === r.time.event_ms && prevR.key < r.key));
        }
        if (n.prev !== null) {
          assert.ok(n.prev < idx);
          assert.equal((g.nodes[n.prev] as Graph["nodes"][number]).chain, ci);
          assert.equal((g.responses[n.prev] as Response).exclusion, null);
          assert.equal((g.responses[idx] as Response).exclusion, null);
          assert.ok(n.ttl_set !== null);
        }
      });
    });
    assert.equal(seen.size, g.responses.length);
    const counted = countedResponseIndices(g);
    assert.equal(new Set(counted.map((i) => (g.responses[i] as Response).key)).size, counted.length);
    assert.equal(Object.values(countedByKind(g)).reduce((x, y) => x + y, 0), counted.length);
  }
});

// ---------------------------------------------------------------------------
// metamorphic: shuffling and splitting (R4.10, R4.11)
// ---------------------------------------------------------------------------

function scenario(): { c: ClaudeParseResult; x: CodexParseResult } {
  const a1 = agentKey("a1");
  const rs = [
    claude({ key: "m1", t: 10, w1: 100n }),
    claude({ key: "m2", t: 20, r: 100n, asm: 15 }),
    claude({ key: "m3", t: 20, r: 100n }),
    claude({ key: "m4", t: 90, r: 100n, asm: 60 }),
    claude({ key: "bad", t: 50, excl: "conflict_input" }),
    claude({ key: "rep", t: 5, role: "replayed", w5: 30n, session: "sB" }),
    claude({ key: "own", t: 6, session: "sB", r: 30n }),
    claude({ key: "s1", t: 30, thread: "a1", w5: 40n }),
    claude({ key: "s2", t: 330, thread: "a1", r: 40n, asm: 331 }),
    claude({ key: "m1", t: 10, w1: 100n, session: "sB", role: "replayed" }),
  ];
  const c = claudeResult({
    responses: rs,
    excluded: [excludedRec(MAIN, 70), excludedRec(MAIN, 20, "unkeyed")],
    links: [link(a1, "subagent", "verified", { parent: MAIN, depth: 1 })],
    files: [fileInfo(0, "claude"), fileInfo(1, "claude")],
    streams: [...autoStreams(rs), mkStream(a1, { files: [1] })].map((s, i) => ({ ...s, start_ms: sec(i === 0 ? 10 : 5 + i) })),
  });
  const xs = [
    codex({ key: "x1", t: 10, thread: "t", root: "r" }),
    codex({ key: "x2", t: 40, thread: "t", root: "r", r: 9n }),
    codex({ key: "x3", t: 40, thread: "t", root: "r" }),
  ];
  return { c, x: codexResult({ responses: xs }) };
}

test("R4.10 shuffling responses, records, streams and parse result order does not change the graph", () => {
  const { c, x } = scenario();
  const base = canon(buildGraph([c, x], { window: { since_ms: sec(8), until_ms: sec(200) } }));
  const rand = rng(99);
  for (let i = 0; i < 25; i++) {
    const c2: ClaudeParseResult = {
      ...c,
      responses: shuffled(c.responses, rand),
      excluded: shuffled(c.excluded, rand),
      streams: shuffled(c.streams, rand),
      links: shuffled(c.links, rand),
      files: shuffled(c.files, rand),
    };
    const x2: CodexParseResult = { ...x, responses: shuffled(x.responses, rand), streams: shuffled(x.streams, rand) };
    const order = rand() < 0.5 ? [c2, x2] : [x2, c2];
    assert.equal(canon(buildGraph(order, { window: { since_ms: sec(8), until_ms: sec(200) } })), base);
  }
});

test("R4.10 splitting a chain across parse results (each half with its own file) gives the same graph", () => {
  const { c } = scenario();
  const whole = buildGraph([c], { window: WIDE });
  const rand = rng(5);
  for (let i = 0; i < 15; i++) {
    const left: ClaudeResponse[] = [];
    const right: ClaudeResponse[] = [];
    for (const r of c.responses) (rand() < 0.5 ? left : right).push(r);
    const mk = (rs: ClaudeResponse[], f: number): ClaudeParseResult =>
      claudeResult({
        responses: rs.map((r) => ({ ...r, provenance: { files: [0], from_copy_exposed_file: false } })),
        streams: c.streams.map((s) => ({ ...s, files: [0] })),
        files: [fileInfo(0, "claude")],
        // keep the structural records on one side only
        excluded: f === 0 ? c.excluded.map((e) => ({ ...e, files: [0] })) : [],
        links: f === 0 ? [...c.links] : [],
      });
    const split = buildGraph([mk(left, 0), mk(right, 1)], { window: WIDE });
    assert.equal(canon(split, true), canon(whole, true));
  }
});

test("a thread over several files of one result and the same thread in one file are the same chain", () => {
  const rs1 = [claude({ key: "a", t: 1, files: [0] }), claude({ key: "b", t: 2, files: [1] }), claude({ key: "c", t: 3, files: [2] })];
  const multi = buildGraph(
    [claudeResult({ responses: rs1, files: [fileInfo(0, "claude"), fileInfo(1, "claude"), fileInfo(2, "claude")], streams: [mkStream(MAIN, { files: [0, 1, 2] })] })],
    { window: WIDE },
  );
  const rs2 = rs1.map((r) => ({ ...r, provenance: { files: [0], from_copy_exposed_file: false } }));
  const single = buildGraph([claudeResult({ responses: rs2 })], { window: WIDE });
  assert.equal(canon(multi, true), canon(single, true));
  assert.equal(multi.chains.length, 1);
});

test("assumptions from the parsers are carried, deduplicated, in the spec order", () => {
  const a = { ...claudeResult({}), assumptions: ["mtime_prefilter_on", "no_batch_assumed"] as ParseResult["assumptions"] };
  const b = { ...codexResult({}), assumptions: ["no_batch_assumed", "unverified_version"] as ParseResult["assumptions"] };
  const g = buildGraph([b, a], { window: WIDE });
  assert.deepEqual(g.assumptions, ["no_batch_assumed", "unverified_version", "mtime_prefilter_on"]);
});
