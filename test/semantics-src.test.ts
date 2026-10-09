// Accounting semantics checklist, src/ side (docs/accounting-semantics.md S1 to S10). One focused test per checklist item:
// each fails on the parsers, the graph or the pricing engine as they were before the checklist and passes now, or is
// marked "already conforming" where src/ implemented the item already. All data is synthetic (fixed ids, no free text).
// This file imports nothing from scripts/recompute (R13.1: the two implementations stay independent).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { analyze } from "../src/analyze.ts";
import { classifyClaude, discover } from "../src/discover.ts";
import { buildGraph } from "../src/graph/index.ts";
import { buildReportInput } from "../src/report/input.ts";
import { doctorCoverageToJson, reportToJsonText } from "../src/report/json.ts";
import { renderReport } from "../src/report/text.ts";
import {
  CONSTANTS,
  chainIdOf,
  type ClaudeParseResult,
  type ClaudeResponse,
  type CodexParseResult,
  type CodexResponse,
  type PricingTable,
  type TaintReason,
  type UsageBuckets,
} from "../src/model/types.ts";
import { DEFAULT_TABLE, PriceTableError, loadPriceBook, priceResponse } from "../src/pricing/index.ts";
import { CodexHome, CodexThread } from "./fixtures/builder.ts";
import { parseClaude } from "../src/sources/claude.ts";
import { parseCodex } from "../src/sources/codex.ts";
import { msToNs, nsToMs, parseBound, parseInstantNs, resolveWindow, windowContainsNs } from "../src/window.ts";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface TreeFile {
  path: string;
  content: string;
  /** Modification time; default OLD_MTIME (never live). */
  mtimeMs?: number;
}

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const OLD_MTIME = Date.UTC(2026, 0, 2);
const RUN_START = Date.UTC(2026, 5, 1);

function writeTree(files: readonly TreeFile[]): string {
  const root = mkdtempSync(join(tmpdir(), "cachewhy-sem-"));
  roots.push(root);
  for (const f of files) {
    const abs = join(root, ...f.path.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
    const m = (f.mtimeMs ?? OLD_MTIME) / 1000;
    utimesSync(abs, m, m);
  }
  return root;
}

const jsonl = (lines: readonly unknown[]): string => lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";

async function parseC(files: readonly TreeFile[]): Promise<ClaudeParseResult> {
  const root = writeTree(files);
  const d = await discover({ claudeDirs: [join(root, "projects")], codexDirs: [join(root, "none")], env: {}, home: root });
  return parseClaude(d.files);
}

async function parseX(files: readonly TreeFile[]): Promise<CodexParseResult> {
  const root = writeTree(files);
  const d = await discover({ codexDirs: [root], home: join(root, "no-home"), env: {} });
  return parseCodex(d.files);
}

/** Both providers through the whole pipeline, with an explicit window (S7.0) and the run start injected. */
async function analyzeTree(files: readonly TreeFile[], opts: { since?: string; until?: string } = {}) {
  const root = writeTree(files);
  const d = await discover({ claudeDirs: [join(root, "projects")], codexDirs: [root], env: {}, home: root });
  const analysis = await analyze(d.files, { now_ms: RUN_START, ...opts });
  const view = buildReportInput({
    graph: analysis.graph,
    parsed: analysis.parsed,
    priced: analysis.priced,
    detection: analysis.detection,
    book: analysis.book,
    options: { command: "default", json: false, show_ids: false, demo: false, color: false },
    generated_at_ms: RUN_START,
    tool_version: "0.0.0",
  });
  return { analysis, view };
}

// ---------------------------------------------------------------------------
// Claude record builders
// ---------------------------------------------------------------------------

const V = "2.1.293";
const SESS = "synthetic-session-a";

function ausage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input_tokens: 10,
    cache_creation_input_tokens: 4,
    cache_read_input_tokens: 2,
    cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 0 },
    output_tokens: 7,
    service_tier: "standard",
    inference_geo: "not_available",
    speed: "standard",
    ...over,
  };
}

interface AOpts {
  sid?: string;
  agent?: string;
  uuid: string;
  req?: string | null;
  msg?: string | null;
  ts?: unknown;
  model?: unknown;
  usage?: Record<string, unknown> | null;
  parent?: string | null;
  patch?: (r: any) => void;
}

function arec(o: AOpts): any {
  const r: any = {
    type: "assistant",
    uuid: o.uuid,
    parentUuid: o.parent ?? null,
    sessionId: o.sid ?? SESS,
    timestamp: o.ts === undefined ? "2026-01-01T00:00:01.000Z" : o.ts,
    isSidechain: false,
    version: V,
    entrypoint: "cli",
    requestId: o.req === undefined ? "synthetic-req-1" : o.req,
    message: {
      id: o.msg === undefined ? "synthetic-msg-1" : o.msg,
      type: "message",
      role: "assistant",
      model: o.model === undefined ? "claude-opus-5-5" : o.model,
      content: [{ type: "text", text: "synthetic" }],
      stop_reason: "end_turn",
      ...(o.usage === null ? {} : { usage: o.usage ?? ausage() }),
    },
  };
  if (o.agent !== undefined) r.agentId = o.agent;
  o.patch?.(r);
  return r;
}

const cfile = (sid: string, recs: readonly unknown[], dir = "synthetic-project"): TreeFile => ({
  path: `projects/${dir}/${sid}.jsonl`,
  content: jsonl(recs),
});

const claudeResp = (res: ClaudeParseResult, key: string): ClaudeResponse[] => res.responses.filter((r) => r.key === key);

// ---------------------------------------------------------------------------
// Codex record builders
// ---------------------------------------------------------------------------

function cmeta(id: string, ts: unknown, ord: unknown, payload: Record<string, unknown> = {}): any {
  return {
    timestamp: ts,
    type: "session_meta",
    ordinal: ord,
    payload: {
      id,
      session_id: id,
      timestamp: "2026-01-01T00:00:00.000Z",
      cli_version: "0.158.0",
      originator: "codex_cli",
      source: "cli",
      thread_source: "user",
      ...payload,
    },
  };
}
const ctc = (ts: unknown, ord: unknown, turn: string, model = "gpt-6-sol"): any => ({
  timestamp: ts,
  type: "turn_context",
  ordinal: ord,
  payload: { turn_id: turn, root_turn_id: turn, model, effort: "medium", comp_hash: "synthetic-comp", collaboration_mode: { mode: "default" } },
});
/** The six usage integers. A key that is present with the value `undefined` is left out of the record (absent). */
function cu(o: { in?: unknown; c?: unknown; cw?: unknown; out?: unknown; rs?: unknown; total?: unknown } = {}): Record<string, unknown> {
  const pick = (k: keyof typeof o, d: unknown): unknown => (k in o ? o[k] : d);
  const inn = pick("in", 1000);
  const out = pick("out", 100);
  const sum = typeof inn === "number" && typeof out === "number" ? inn + out : 0;
  const u: Record<string, unknown> = {
    input_tokens: inn,
    cached_input_tokens: pick("c", 0),
    cache_write_input_tokens: pick("cw", 0),
    output_tokens: out,
    reasoning_output_tokens: pick("rs", 0),
    total_tokens: pick("total", sum),
  };
  for (const k of Object.keys(u)) if (u[k] === undefined) delete u[k];
  return u;
}
function ctur(ts: unknown, ord: unknown, resp: string | null, thread: string, turn: string, usage: unknown, extra: Record<string, unknown> = {}): any {
  return {
    timestamp: ts,
    type: "token_usage_record",
    ordinal: ord,
    payload: { response_id: resp ?? undefined, thread_id: thread, session_id: thread, turn_id: turn, usage, ...extra },
  };
}
const xfile = (name: string, lines: readonly unknown[]): TreeFile => ({
  path: `sessions/2026/01/01/rollout-2026-01-01T00-00-00-${name}.jsonl`,
  content: jsonl(lines),
});
const t = (sec: number, frac = ""): string => `2026-01-01T00:00:${String(sec).padStart(2, "0")}${frac}Z`;

function triggersOf(res: { integrity: { triggers: readonly { reason: string; names: readonly string[] | "provider" }[] } }, reason: TaintReason): string[][] {
  return res.integrity.triggers.filter((x) => x.reason === reason).map((x) => (x.names === "provider" ? ["*"] : [...x.names]));
}
const xcid = (thread: string): string => chainIdOf({ provider: "codex", root_session: "", thread });

// ---------------------------------------------------------------------------
// S3.1, S3.2: the instant parser (item 1)
// ---------------------------------------------------------------------------

describe("S3 instants: own parser, exact nanoseconds", () => {
  it("accepts the grammar and returns exact BigInt nanoseconds (S3.1, S3.2)", () => {
    assert.equal(parseInstantNs("1970-01-01T00:00:00Z"), 0n);
    assert.equal(parseInstantNs("2026-01-01T00:00:00Z"), BigInt(Date.UTC(2026, 0, 1)) * 1_000_000n);
    assert.equal(parseInstantNs("2026-01-01T00:00:00.123456789Z"), BigInt(Date.UTC(2026, 0, 1)) * 1_000_000n + 123_456_789n);
    // trailing zeros of the fraction do not matter, a 7th digit does
    assert.equal(parseInstantNs("2026-01-01T00:00:00.12Z"), parseInstantNs("2026-01-01T00:00:00.120Z"));
    assert.notEqual(parseInstantNs("2026-01-01T00:00:00.1234567Z"), parseInstantNs("2026-01-01T00:00:00.1234568Z"));
    // an offset is applied
    assert.equal(parseInstantNs("2026-01-01T01:00:00+01:00"), parseInstantNs("2026-01-01T00:00:00Z"));
    assert.equal(parseInstantNs("2025-12-31T18:30:00-05:30"), parseInstantNs("2026-01-01T00:00:00Z"));
    // proleptic Gregorian leap years: 4, but not 100 unless 400
    assert.notEqual(parseInstantNs("2024-02-29T00:00:00Z"), null);
    assert.notEqual(parseInstantNs("2000-02-29T00:00:00Z"), null);
    assert.equal(parseInstantNs("1900-02-29T00:00:00Z"), null);
    assert.equal(parseInstantNs("2026-02-29T00:00:00Z"), null);
    // before the epoch the value is negative and exact
    assert.equal(parseInstantNs("1969-12-31T23:59:59.999999999Z"), -1n);
    assert.equal(parseInstantNs("0001-01-01T00:00:00Z"), -62_135_596_800_000_000_000n);
  });

  it("rejects what Date.parse accepts or the grammar forbids (S3.1)", () => {
    const bad = [
      "2026-02-30T00:00:00Z", // Date.parse accepts
      "2026-04-31T00:00:00Z",
      "2026-01-01T24:00:00Z", // Date.parse accepts
      "2026-01-01T23:60:00Z",
      "2026-01-01T23:59:60Z", // no leap second
      "2026-13-01T00:00:00Z",
      "2026-00-10T00:00:00Z",
      "2026-01-00T00:00:00Z",
      "0000-01-01T00:00:00Z",
      "2026-01-01t00:00:00Z",
      "2026-01-01T00:00:00z",
      "2026-01-01 00:00:00Z",
      "2026-01-01T00:00:00",
      "2026-01-01T00:00:00.Z",
      "2026-01-01T00:00:00.1234567890Z", // 10 fraction digits
      "2026-01-01T00:00:00+24:00",
      "2026-01-01T00:00:00+01:60",
      "2026-01-01T00:00:00+0100",
      " 2026-01-01T00:00:00Z",
      "2026-1-01T00:00:00Z",
      `2026-01-01T00:00:00.000000000${" ".repeat(20)}Z`, // more than 40 characters
    ];
    for (const s of bad) assert.equal(parseInstantNs(s), null, s);
    for (const v of [undefined, null, 5, true, {}, []]) assert.equal(parseInstantNs(v), null);
  });

  it("window membership is since * 10^6 <= t < until * 10^6 in BigInt (S7.1)", () => {
    const w = { since_ms: 1000, until_ms: 2000 };
    assert.equal(windowContainsNs(w, 1_000_000_000n - 1n), false);
    assert.equal(windowContainsNs(w, 1_000_000_000n), true);
    assert.equal(windowContainsNs(w, 2_000_000_000n - 1n), true);
    assert.equal(windowContainsNs(w, 2_000_000_000n), false);
    assert.equal(msToNs(5), 5_000_000n);
    assert.equal(nsToMs(-1n), -1); // floor, also before the epoch
    assert.equal(nsToMs(1_999_999n), 1);
  });

  it("CLI window bounds use the same calendar (S3.1)", () => {
    assert.equal(parseBound("2026-02-30", RUN_START), null);
    assert.equal(parseBound("2026-01-31T24:00:00Z", RUN_START), null);
    assert.equal(parseBound("2026-01-31", RUN_START), Date.UTC(2026, 0, 31));
    assert.equal(resolveWindow({ since: "2026-02-30" }, RUN_START, null), null);
  });
});

// ---------------------------------------------------------------------------
// Item 1 on the Claude side
// ---------------------------------------------------------------------------

describe("item 1: Claude instants (S3)", () => {
  it("an invalid timestamp is not an instant: the request is usage_incomplete (S3.1, S3.4, revision 11.1)", async () => {
    const files = [
      cfile(SESS, [
        arec({ uuid: "synthetic-u1", req: "r-feb30", msg: "m1", ts: "2026-02-30T10:00:00Z" }),
        arec({ uuid: "synthetic-u2", req: "r-24", msg: "m2", ts: "2026-01-01T24:00:00Z" }),
        arec({ uuid: "synthetic-u3", req: "r-sec60", msg: "m3", ts: "2026-01-01T00:00:60Z" }),
        arec({ uuid: "synthetic-u4", req: "r-ok", msg: "m4", ts: "2026-01-01T00:00:04Z" }),
      ]),
    ];
    const res = await parseC(files);
    for (const k of ["r-feb30", "r-24", "r-sec60"]) assert.equal(claudeResp(res, k)[0]?.exclusion, "usage_incomplete", k);
    assert.equal(claudeResp(res, "r-ok")[0]?.exclusion, null);
  });

  it("instants differing only in the 7th fractional digit are two records, equal instants are one (S3.2, S5.1)", async () => {
    const mk = (ts: string) => arec({ uuid: "synthetic-u1", ts });
    const distinct = await parseC([cfile(SESS, [mk("2026-01-01T00:00:01.0000001Z"), mk("2026-01-01T00:00:01.0000002Z")])]);
    assert.equal(distinct.coverage.duplicate_records_collapsed, 0);
    assert.equal(distinct.coverage.lines_duplicate_collapsed, 0);
    // exact t_first and t_last in nanoseconds, over all copies of the key
    const r = distinct.responses[0] as ClaudeResponse;
    assert.equal(r.time.t_first_ns, parseInstantNs("2026-01-01T00:00:01.0000001Z"));
    assert.equal(r.time.t_last_ns, parseInstantNs("2026-01-01T00:00:01.0000002Z"));
    assert.equal(r.time.event_ns, r.time.t_first_ns);
    assert.equal(r.time.t_first_ms, Date.UTC(2026, 0, 1, 0, 0, 1));
    const same = await parseC([cfile(SESS, [mk("2026-01-01T00:00:01.12Z"), mk("2026-01-01T00:00:01.120Z")])]);
    assert.equal(same.coverage.duplicate_records_collapsed, 1);
    assert.equal(same.coverage.lines_duplicate_collapsed, 1);
  });

  it("chain order ties are decided on nanoseconds (R6.1, S3.3)", async () => {
    const mk = (n: number, ts: string) => arec({ uuid: `synthetic-u${n}`, req: `r${n}`, msg: `m${n}`, ts });
    const keyIdx = (g: ReturnType<typeof buildGraph>, k: string): number => g.responses.findIndex((r) => r.key === k);
    const opt = { window: { since_ms: 0, until_ms: Date.UTC(2027, 0, 1) }, run_start_ms: RUN_START };
    const apart = buildGraph([await parseC([cfile(SESS, [mk(1, "2026-01-01T00:00:01.0000001Z"), mk(2, "2026-01-01T00:00:01.0000002Z")])])], opt);
    assert.equal(apart.nodes[keyIdx(apart, "r1")]?.order_tie, false);
    assert.equal(apart.nodes[keyIdx(apart, "r2")]?.order_tie, false);
    assert.ok(keyIdx(apart, "r1") < keyIdx(apart, "r2"));
    const tied = buildGraph([await parseC([cfile(SESS, [mk(1, "2026-01-01T00:00:01.5Z"), mk(2, "2026-01-01T00:00:01.500000000Z")])])], opt);
    assert.equal(tied.nodes[keyIdx(tied, "r1")]?.order_tie, true);
    assert.equal(tied.nodes[keyIdx(tied, "r2")]?.order_tie, true);
  });

  it("stream_start and ownership ties compare nanoseconds (R4.6, S3.3)", async () => {
    const copy = (sid: string, ts: string) => arec({ sid, uuid: `synthetic-u-${sid}`, req: "r-shared", msg: "m-shared", ts });
    const a = "synthetic-session-a";
    const b = "synthetic-session-b";
    // B's first record is 100 ns after A's: no tie, A owns. Before the change both floor to the same millisecond.
    const res = await parseC([
      cfile(a, [copy(a, "2026-01-01T00:00:01.0000000Z")]),
      cfile(b, [copy(b, "2026-01-01T00:00:01.0000001Z")]),
    ]);
    const rows = claudeResp(res, "r-shared");
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => !r.ownership.ambiguous));
    assert.equal(rows.find((r) => r.chain.root_session === a)?.ownership.role, "owner");
    assert.equal(res.coverage.replay_ownership_ambiguous, 0);
    assert.equal(res.streams.find((s) => s.chain.root_session === a)?.start_ns, parseInstantNs("2026-01-01T00:00:01Z"));
  });
});

// ---------------------------------------------------------------------------
// Item 1 on the Codex side
// ---------------------------------------------------------------------------

describe("item 1: Codex instants (S3)", () => {
  const th = "synthetic-thread-x";
  const base = (tsTur: unknown, extra: unknown[] = []): TreeFile =>
    xfile(th, [cmeta(th, t(1), 0), ctc(t(2), 1, "turn-1"), ctur(tsTur, 2, "resp-1", th, "turn-1", cu()), ...extra]);

  it("occurrences differing only in the 7th fractional digit are two records: conflict_attribution (R4.4, S5.2)", async () => {
    const dup = (a: string, b: string) =>
      xfile(th, [
        cmeta(th, t(1), 0),
        ctc(t(2), 1, "turn-1"),
        ctur(a, 2, "resp-1", th, "turn-1", cu()),
        ctur(b, 2, "resp-1", th, "turn-1", cu()),
      ]);
    const apart = await parseX([dup(t(3, ".0000001"), t(3, ".0000002"))]);
    assert.equal(apart.responses.length, 1);
    assert.equal(apart.responses[0]?.exclusion, "conflict_attribution");
    assert.equal(apart.coverage.requests_conflict_by_kind.conflict_attribution, 1);
    // equal instants are one record: counted once, no conflict
    const same = await parseX([dup(t(3, ".12"), t(3, ".120"))]);
    assert.equal(same.responses[0]?.exclusion, null);
    assert.equal(same.coverage.duplicate_records_collapsed, 1);
  });

  it("an invalid envelope instant makes the usage record incomplete and the stream ordinal_unverified (R2.12, R4.12 (a))", async () => {
    for (const bad of ["2026-02-30T00:00:03Z", "2026-01-01T24:00:03Z", undefined, null]) {
      const res = await parseX([base(bad)]);
      assert.equal(res.responses[0]?.exclusion, "usage_incomplete", String(bad));
      assert.deepEqual(triggersOf(res, "ordinal_unverified"), [[xcid(th)]], String(bad));
    }
  });

  it("the ordinal check (c) compares nanoseconds and skips a record without a valid instant (S3.5)", async () => {
    // ordinals 1 and 2 carry times 200 ns apart in the wrong order: before the change both floor to one millisecond
    const wrong = await parseX([
      xfile(th, [cmeta(th, t(1), 0), ctc(t(2, ".0000002"), 1, "turn-1"), ctur(t(2, ".0000001"), 2, "resp-1", th, "turn-1", cu())]),
    ]);
    assert.deepEqual(triggersOf(wrong, "ordinal_unverified"), [[xcid(th)]]);
    const right = await parseX([
      xfile(th, [cmeta(th, t(1), 0), ctc(t(2, ".0000001"), 1, "turn-1"), ctur(t(2, ".0000002"), 2, "resp-1", th, "turn-1", cu())]),
    ]);
    assert.deepEqual(triggersOf(right, "ordinal_unverified"), []);
    // a non-decision record (response_item) without a valid instant fails nothing and is skipped by check (c)
    const skip = await parseX([
      xfile(th, [
        cmeta(th, t(1), 0),
        { timestamp: "not-an-instant", type: "response_item", ordinal: 1, payload: { type: "message" } },
        ctc(t(2), 2, "turn-1"),
        ctur(t(3), 3, "resp-1", th, "turn-1", cu()),
      ]),
    ]);
    assert.deepEqual(triggersOf(skip, "ordinal_unverified"), []);
  });

  it("chain order and ties use the exact envelope instant (R6.1)", async () => {
    const files = (a: string, b: string) => [
      xfile(th, [cmeta(th, t(1), 0), ctc(t(2), 1, "turn-1"), ctur(a, 2, "resp-1", th, "turn-1", cu()), ctur(b, 3, "resp-2", th, "turn-1", cu())]),
    ];
    const opt = { window: { since_ms: 0, until_ms: Date.UTC(2027, 0, 1) }, run_start_ms: RUN_START };
    const apart = buildGraph([await parseX(files(t(3, ".0000001"), t(3, ".0000002")))], opt);
    assert.ok(apart.nodes.every((n) => !n.order_tie));
    const tied = buildGraph([await parseX(files(t(3, ".5"), t(3, ".500000000")))], opt);
    assert.ok(tied.nodes.every((n) => n.order_tie));
  });
});

// ---------------------------------------------------------------------------
// Item 2: S1.3, S1.4 null equals absent, optional integers keep their states
// ---------------------------------------------------------------------------

describe("item 2: null is absent, optional integers keep their states (S1.3, S1.4)", () => {
  const th = "synthetic-thread-x";

  it("Codex: a session_meta whose payload.timestamp is null equals one without it (S1.3)", async () => {
    const withNull = cmeta(th, t(1), 0, { timestamp: null });
    const without = cmeta(th, t(1), 0);
    delete without.payload.timestamp;
    const res = await parseX([xfile(th, [withNull, without])]);
    assert.equal(res.coverage.duplicate_records_collapsed, 1);
    assert.equal(res.coverage.lines_duplicate_collapsed, 1);
    // an invalid timestamp is its own state, not equal to a missing one
    const bad = cmeta(th, t(1), 0, { timestamp: "2026-02-30T00:00:00Z" });
    const res2 = await parseX([xfile(th, [bad, without])]);
    assert.equal(res2.coverage.duplicate_records_collapsed, 0);
  });

  it("Codex: null equals absent for ids, source, thread_spawn depth, window_number and ordinal (S1.3)", async () => {
    const a = cmeta(th, t(1), 0, { forked_from_id: null, parent_thread_id: null, source: null, thread_source: null });
    const b = cmeta(th, t(1), 0);
    delete b.payload.forked_from_id;
    delete b.payload.source;
    delete b.payload.thread_source;
    const compA = { timestamp: t(2), type: "compacted", ordinal: 1, payload: { window_number: null, latest_token_usage_record: null } };
    const compB = { timestamp: t(2), type: "compacted", ordinal: 1, payload: {} };
    const res = await parseX([xfile(th, [a, b, compA, compB])]);
    assert.equal(res.coverage.duplicate_records_collapsed, 2);
    const spawnA = cmeta("synthetic-child", t(1), 0, { source: { subagent: { thread_spawn: { parent_thread_id: th, depth: null }, other: null } } });
    const spawnB = cmeta("synthetic-child", t(1), 0, { source: { subagent: { thread_spawn: { parent_thread_id: th } } } });
    const res2 = await parseX([xfile("synthetic-child", [spawnA, spawnB])]);
    assert.equal(res2.coverage.duplicate_records_collapsed, 1);
  });

  it("Codex: the history start keeps missing, bad, range and value in the two-own-meta comparison (S1.4, R4.11)", async () => {
    const meta = (hist: unknown, ord: number): any => {
      const m = cmeta(th, t(1), ord, hist === "absent" ? {} : { subagent_history_start_ordinal: hist });
      return m;
    };
    const stream = async (a: unknown, b: unknown): Promise<string[][]> => triggersOf(await parseX([xfile(th, [meta(a, 0), meta(b, 1)])]), "stream_unresolved");
    // null and absent are one state: no divergence
    assert.deepEqual(await stream(null, "absent"), []);
    // missing against range (-1), against bad ("abc") and against a value; bad against range; two values
    assert.deepEqual(await stream("absent", -1), [[xcid(th)]]);
    assert.deepEqual(await stream("absent", "abc"), [[xcid(th)]]);
    assert.deepEqual(await stream("absent", 5), [[xcid(th)]]);
    assert.deepEqual(await stream("abc", -1), [[xcid(th)]]);
    assert.deepEqual(await stream(5, 6), [[xcid(th)]]);
    // the same state twice agrees: two range values are one state, two equal values are one record
    assert.deepEqual(await stream(-1, 1.5), []);
    assert.deepEqual(await stream(5, 5), []);
  });

  it("Claude: null equals absent for optional fields (S1.3)", async () => {
    const withNull = arec({ uuid: "synthetic-u1", patch: (r) => { r.message.stop_reason = null; r.message.usage.iterations = null; r.message.usage.cache_creation_input_tokens = 4; r.isSidechain = null; r.effort = null; r.message.diagnostics = null; } });
    const without = arec({ uuid: "synthetic-u1", patch: (r) => { delete r.message.stop_reason; delete r.isSidechain; } });
    const res = await parseC([cfile(SESS, [withNull, without])]);
    assert.equal(res.coverage.duplicate_records_collapsed, 1);
    assert.equal(claudeResp(res, "synthetic-req-1")[0]?.stop_reason, null);
  });

  it("Claude: cache_missed_input_tokens and preTokens keep missing, bad and range (S1.4, S5.1)", async () => {
    const diag = (v: unknown, omit = false): any =>
      arec({ uuid: "synthetic-u1", patch: (r) => { r.message.diagnostics = { cache_miss_reason: { type: "tools_changed", ...(omit ? {} : { cache_missed_input_tokens: v }) } }; } });
    const collapsed = async (...recs: any[]): Promise<number> => (await parseC([cfile(SESS, recs)])).coverage.lines_duplicate_collapsed;
    assert.equal(await collapsed(diag(null), diag(undefined, true)), 1); // null is absent
    assert.equal(await collapsed(diag("5"), diag(undefined, true)), 0); // bad is not missing
    assert.equal(await collapsed(diag(-1), diag(undefined, true)), 0); // range is not missing
    assert.equal(await collapsed(diag(-1), diag("5")), 0); // range is not bad
    assert.equal(await collapsed(diag(-1), diag(1.5)), 1); // two range values are one state
    const boundary = (pre: unknown, omit = false): any => ({
      type: "system", subtype: "compact_boundary", uuid: "synthetic-sys", parentUuid: null, sessionId: SESS, timestamp: t(2), version: V,
      compactMetadata: { trigger: "auto", ...(omit ? {} : { preTokens: pre }) },
    });
    const sys = async (...recs: any[]): Promise<number> => (await parseC([cfile(SESS, [arec({ uuid: "synthetic-u1" }), ...recs])])).coverage.lines_duplicate_collapsed;
    assert.equal(await sys(boundary(null), boundary(undefined, true)), 1);
    assert.equal(await sys(boundary("x"), boundary(undefined, true)), 0);
    assert.equal(await sys(boundary(-5), boundary("x")), 0);
  });
});

// ---------------------------------------------------------------------------
// Item 3: S1.2 absent type is missing, an unlisted one is other
// ---------------------------------------------------------------------------

describe("item 3: enum states (S1.2)", () => {
  const th = "synthetic-thread-x";

  it("Codex event_msg: an absent payload.type differs from an unlisted one", async () => {
    const line = (payload: unknown): any => ({ timestamp: t(2), type: "event_msg", ordinal: 1, payload });
    const res = await parseX([xfile(th, [cmeta(th, t(1), 0), line({}), line({ type: "zzz" })])]);
    assert.equal(res.coverage.duplicate_records_collapsed, 0);
    const same = await parseX([xfile(th, [cmeta(th, t(1), 0), line({ type: null }), line({})])]);
    assert.equal(same.coverage.duplicate_records_collapsed, 1); // null is absent (S1.3)
    const other = await parseX([xfile(th, [cmeta(th, t(1), 0), line({ type: "zzz" }), line({ type: 5 })])]);
    assert.equal(other.coverage.duplicate_records_collapsed, 1); // every unlisted value is `other`
  });

  it("the record type: an absent type is missing, an unlisted one is other, in both providers", async () => {
    const x = await parseX([xfile(th, [cmeta(th, t(1), 0), { timestamp: t(2), ordinal: 1, payload: {} }, { timestamp: t(2), type: "zzz", ordinal: 1, payload: {} }])]);
    assert.equal(x.coverage.duplicate_records_collapsed, 0);
    const y = await parseX([xfile(th, [cmeta(th, t(1), 0), { timestamp: t(2), type: null, ordinal: 1 }, { timestamp: t(2), ordinal: 1 }, { timestamp: t(2), type: 5, ordinal: 1 }, { timestamp: t(2), type: "zzz", ordinal: 1 }])]);
    assert.equal(y.coverage.duplicate_records_collapsed, 2); // {null, absent} and {5, "zzz"}
    const rec = (type: unknown): any => ({ type, uuid: "synthetic-o", sessionId: SESS, timestamp: t(2), version: V });
    const c = await parseC([cfile(SESS, [rec(undefined), rec("zzz")])]);
    assert.equal(c.coverage.lines_duplicate_collapsed, 0);
    const d = await parseC([cfile(SESS, [rec(null), rec(undefined), rec(5), rec("zzz")])]);
    assert.equal(d.coverage.lines_duplicate_collapsed, 2);
  });

  it("Claude diagnostics type: absent is missing (no evidence), unlisted is other, and the two differ", async () => {
    const diag = (cmr: unknown): any => arec({ uuid: "synthetic-u1", patch: (r) => { r.message.diagnostics = { cache_miss_reason: cmr }; } });
    const missing = await parseC([cfile(SESS, [diag({}), diag({ type: "zzz" })])]);
    assert.equal(missing.coverage.lines_duplicate_collapsed, 0);
    const r = missing.responses[0] as ClaudeResponse;
    assert.equal(r.diag?.type, "other"); // the unlisted copy is the evidence, the type-less copy gives none
    assert.equal(missing.coverage.requests_conflict_by_kind.conflict_diagnostics, 0);
    // two unlisted values are one state
    const same = await parseC([cfile(SESS, [diag({ type: "zzz" }), diag({ type: 7 })])]);
    assert.equal(same.coverage.lines_duplicate_collapsed, 1);
  });
});

// ---------------------------------------------------------------------------
// Item 4: S2.2, S5.1
// ---------------------------------------------------------------------------

describe("item 4: models, agentId and containers in the projection (S2.2, S5.1)", () => {
  it("<synthetic> is the reserved model: projection holds the normalized model and the raw boolean", async () => {
    const err = (model: unknown, flag?: boolean): any =>
      arec({ uuid: "synthetic-u1", req: null, msg: null, model, usage: null, patch: (r) => { if (flag !== undefined) r.isApiErrorMessage = flag; } });
    // same model, the raw boolean differs (true, absent): two records, both api errors (R2.14)
    const raw = await parseC([cfile(SESS, [err("<synthetic>", true), err("<synthetic>")])]);
    assert.equal(raw.coverage.lines_duplicate_collapsed, 0);
    assert.equal(raw.coverage.api_error_records, 2);
    // <synthetic> is no longer the same value as an unlisted model
    const model = await parseC([cfile(SESS, [err("<synthetic>", true), err("NOT A MODEL", true)])]);
    assert.equal(model.coverage.lines_duplicate_collapsed, 0);
    // a date suffix is stripped for the comparison of the other values
    const stripped = await parseC([cfile(SESS, [err("claude-opus-5-5-20260101", true), err("claude-opus-5-5", true)])]);
    assert.equal(stripped.coverage.lines_duplicate_collapsed, 1);
  });

  it("a model longer than 80 characters or an empty one is no model, `unlisted` is a model (S2.1, S2.2)", async () => {
    const res = await parseC([
      cfile(SESS, [
        arec({ uuid: "synthetic-u1", req: "r-long", msg: "m1", model: "a".repeat(81) }),
        arec({ uuid: "synthetic-u2", req: "r-empty", msg: "m2", model: "" }),
        arec({ uuid: "synthetic-u3", req: "r-odd", msg: "m3", model: "Not A Model" }),
      ]),
    ]);
    assert.equal(claudeResp(res, "r-long")[0]?.model.candidate, null);
    assert.equal(claudeResp(res, "r-empty")[0]?.model.candidate, null);
    assert.equal(claudeResp(res, "r-odd")[0]?.model.candidate, "unlisted");
    assert.equal(claudeResp(res, "r-odd")[0]?.model.verified, true);
  });

  it("two copies with `unlisted` agree, `unlisted` against a plain model is conflict_model (S2.2; already conforming)", async () => {
    const copy = (n: number, model: string): any => arec({ uuid: `synthetic-u${n}`, model });
    const agree = await parseC([cfile(SESS, [copy(1, "Odd One"), copy(2, "Odd Two")])]);
    assert.equal(agree.responses[0]?.exclusion, null);
    const clash = await parseC([cfile(SESS, [copy(1, "Odd One"), copy(2, "claude-opus-5-5")])]);
    assert.equal(clash.responses[0]?.exclusion, "conflict_model");
  });

  it("an absent agentId is `missing` in the projection, distinct from the string `main` (S5.1); the chain is main", async () => {
    const res = await parseC([cfile(SESS, [arec({ uuid: "synthetic-u1" }), arec({ uuid: "synthetic-u1", agent: "main" })])]);
    assert.equal(res.coverage.lines_duplicate_collapsed, 0);
    assert.equal(res.responses.length, 1); // one chain (S, main), two copies
    assert.equal(res.responses[0]?.chain.thread, "main");
    assert.equal(res.responses[0]?.copies, 2);
  });

  it("output_tokens_details absent and present without thinking_tokens are the same state (S5.1; already conforming)", async () => {
    const a = arec({ uuid: "synthetic-u1" });
    const b = arec({ uuid: "synthetic-u1", usage: ausage({ output_tokens_details: {} }) });
    const c = arec({ uuid: "synthetic-u1", usage: ausage({ output_tokens_details: "x" }) });
    const res = await parseC([cfile(SESS, [a, b, c])]);
    assert.equal(res.coverage.duplicate_records_collapsed, 1);
    assert.equal(res.coverage.lines_duplicate_collapsed, 2);
  });

  it("integer members of iterations[0] keep (name, value or range); the object is missing or bad (S5.1)", async () => {
    const it = (v: unknown): any => arec({ uuid: "synthetic-u1", usage: ausage({ iterations: v }) });
    const lines = async (...r: any[]): Promise<number> => (await parseC([cfile(SESS, r)])).coverage.lines_duplicate_collapsed;
    assert.equal(await lines(it(null), it(undefined)), 1);
    assert.equal(await lines(it(["x"]), it([])), 0); // bad against missing
    assert.equal(await lines(it([{ input_tokens: 10 }]), it([{ input_tokens: 11 }])), 0);
    assert.equal(await lines(it([{ extra: 1.5, input_tokens: 10 }]), it([{ input_tokens: 10 }])), 1); // a non-integer member is dropped
  });
});

// ---------------------------------------------------------------------------
// Item 5: S6.1 exclusion order
// ---------------------------------------------------------------------------

describe("item 5: exclusion order range, incomplete, key_conflict, conflicts (S6.1)", () => {
  const two = (key: string, a: Partial<AOpts>, b: Partial<AOpts>): any[] => [
    arec({ uuid: `u-${key}-1`, req: key, msg: `m-${key}-1`, ...a }),
    arec({ uuid: `u-${key}-2`, req: key, msg: `m-${key}-2`, ...b }),
  ];

  it("range comes before key_conflict, incomplete comes before key_conflict, key_conflict before conflict_input", async () => {
    const res = await parseC([
      cfile(SESS, [
        ...two("k-range", { usage: ausage({ input_tokens: -1 }) }, {}),
        ...two("k-incomplete", { usage: ausage({ output_tokens: undefined }) }, {}),
        ...two("k-ts", {}, { ts: null }),
        ...two("k-plain", {}, {}),
        ...two("k-plain-input", { usage: ausage({ input_tokens: 99 }) }, {}),
      ]),
    ]);
    const ex = (k: string) => claudeResp(res, k)[0]?.exclusion;
    assert.equal(ex("k-range"), "usage_range_failed");
    assert.equal(ex("k-incomplete"), "usage_incomplete");
    assert.equal(ex("k-ts"), "usage_incomplete");
    assert.equal(ex("k-plain"), "key_conflict");
    assert.equal(ex("k-plain-input"), "key_conflict"); // the key conflict is the first of the remaining ladder
    // only the first code is recorded and counted
    assert.equal(res.coverage.requests_conflict_by_kind.key_conflict, 2);
    assert.equal(res.coverage.requests_conflict_by_kind.conflict_input, 0);
    assert.equal(res.coverage.responses_usage_range_failed, 1);
    assert.deepEqual(res.conflicts.map((c) => `${c.kind}:${c.key}`).sort(), ["key_conflict:k-plain", "key_conflict:k-plain-input"]);
  });

  it("conflict_input and conflict_model are both recorded, the first is the exclusion (already conforming)", async () => {
    const res = await parseC([
      cfile(SESS, [
        arec({ uuid: "u1", req: "k", msg: "m", usage: ausage({ input_tokens: 99 }), model: "claude-sonnet-5-5" }),
        arec({ uuid: "u2", req: "k", msg: "m" }),
      ]),
    ]);
    assert.equal(res.responses[0]?.exclusion, "conflict_input");
    assert.deepEqual(res.conflicts.map((c) => c.kind).sort(), ["conflict_input", "conflict_model"]);
  });

  it("a copy without a usage object but a bad timestamp makes the request incomplete (revision 11.1)", async () => {
    const res = await parseC([
      cfile(SESS, [
        arec({ uuid: "u1", req: "k", msg: "m" }),
        arec({ uuid: "u2", req: "k", msg: "m", usage: null, ts: "2026-02-30T00:00:00Z" }),
      ]),
    ]);
    assert.equal(res.responses[0]?.exclusion, "usage_incomplete");
  });
});

// ---------------------------------------------------------------------------
// Item 6: S6.3 tokens_in_incomplete_responses
// ---------------------------------------------------------------------------

describe("item 6: tokens of incomplete responses (S6.3)", () => {
  it("Claude: each field is the maximum of its valid values over the usage-bearing copies; W is wt when valid", async () => {
    const res = await parseC([
      cfile(SESS, [
        // incomplete: output missing. i=10 r=5 wt=7 (5m 4, 1h 3)
        arec({
          uuid: "u1", req: "k", msg: "m",
          usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 3 } },
        }),
        // a final copy: i=12 r=2, wt missing and no cache_creation object, o=9
        arec({ uuid: "u2", req: "k", msg: "m", usage: { input_tokens: 12, cache_read_input_tokens: 2, output_tokens: 9, speed: "standard" } }),
      ]),
    ]);
    assert.equal(res.responses[0]?.exclusion, "usage_incomplete");
    // i = 12, r = 5, W = 7, o = 9
    assert.equal(res.coverage.tokens_in_incomplete_responses, 33n);
    assert.equal(res.ledger.find((e) => e.tokens_incomplete !== undefined && e.tokens_incomplete > 0n)?.tokens_incomplete, 33n);
  });

  it("Claude: without a valid wt the valid ones of w5 and w1 count, each once", async () => {
    const res = await parseC([
      cfile(SESS, [
        arec({ uuid: "u1", req: "k", msg: "m", usage: { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3, cache_creation: { ephemeral_5m_input_tokens: 4 } } }),
        arec({ uuid: "u2", req: "k", msg: "m", usage: { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3, cache_creation: { ephemeral_1h_input_tokens: 5 } } }),
        // a lone w5 with a bad wt
        arec({ uuid: "u3", req: "k2", msg: "m2", usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: "x", cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: "y" } } }),
      ]),
    ]);
    assert.equal(res.coverage.tokens_in_incomplete_responses, 1n + 2n + 4n + 5n + 3n + (1n + 2n + 4n));
  });

  it("Claude: a bad timestamp alone reports every valid counter (revision 11.1; already conforming)", async () => {
    const res = await parseC([cfile(SESS, [arec({ uuid: "u1", req: "k", msg: "m", ts: "nope" })])]);
    assert.equal(res.responses[0]?.exclusion, "usage_incomplete");
    assert.equal(res.coverage.tokens_in_incomplete_responses, 10n + 2n + 4n + 7n);
  });

  const th = "synthetic-thread-x";
  const OMIT = Symbol("omit");
  const codex = async (usage: unknown, ts: unknown = t(3)): Promise<CodexParseResult> =>
    parseX([xfile(th, [cmeta(th, t(1), 0), ctc(t(2), 1, "turn-1"), ctur(ts === OMIT ? undefined : ts, 2, "resp-1", th, "turn-1", usage)])]);

  it("Codex: I is `in` when valid, else the valid ones of c and cw; O is `out` when valid, else rs", async () => {
    // in missing: c and cw carried; out valid
    let res = await codex(cu({ in: undefined, c: 40, cw: 10, out: 100, rs: 20 }));
    assert.equal(res.responses[0]?.exclusion, "usage_incomplete");
    assert.equal(res.coverage.tokens_in_incomplete_responses, 50n + 100n);
    // in valid, out missing: rs carried, c and cw are inside `in` and not added
    res = await codex(cu({ in: 30, c: 5, cw: 5, out: undefined, rs: 7 }));
    assert.equal(res.coverage.tokens_in_incomplete_responses, 30n + 7n);
    // in bad ("x"), c bad, cw valid, out valid, rs valid and inside out
    res = await codex(cu({ in: "x", c: "y", cw: 3, out: 8, rs: 4 }));
    assert.equal(res.coverage.tokens_in_incomplete_responses, 3n + 8n);
    // nothing valid
    res = await codex({});
    assert.equal(res.coverage.tokens_in_incomplete_responses, 0n);
    assert.equal(res.responses[0]?.exclusion, "usage_incomplete");
  });

  it("Codex: a missing or bad envelope timestamp is usage_incomplete and reports I + O (revision 11.1; already conforming)", async () => {
    for (const ts of [OMIT, null, "yesterday", "2026-02-30T00:00:00Z"]) {
      const res = await codex(cu(), ts);
      assert.equal(res.responses[0]?.exclusion, "usage_incomplete", String(ts));
      assert.equal(res.coverage.tokens_in_incomplete_responses, 1100n, String(ts));
    }
  });

  it("range wins over incomplete and reports nothing (R2.15, S4.3; already conforming)", async () => {
    const res = await codex(cu({ in: -1, out: undefined }));
    assert.equal(res.responses[0]?.exclusion, "usage_range_failed");
    assert.equal(res.coverage.tokens_in_incomplete_responses, 0n);
  });
});

// ---------------------------------------------------------------------------
// Item 7: S3.5 records of a stream
// ---------------------------------------------------------------------------

describe("item 7: the records of a Codex stream are those of its assigned files (S3.5)", () => {
  it("a token_usage_record in a stream-conflict file is accounted but is not a record of the stream for R4.12", async () => {
    const x = "synthetic-thread-x";
    const y = "synthetic-thread-y";
    const f1 = xfile("f1", [cmeta(x, t(1), 0), ctc(t(2), 1, "turn-1"), ctur(t(3), 2, "resp-1", x, "turn-1", cu())]);
    // F2 names Y (own session_meta) and X (a usage record), so it is a stream-conflict file. Its record of X collides
    // with the record of F1 on ordinal 2 (different content) and would fail check (b) if it counted.
    const f2 = xfile("f2", [cmeta(y, t(1), 0), ctur(t(4), 2, "resp-2", x, "turn-1", cu({ in: 500 }))]);
    const res = await parseX([f1, f2]);
    assert.deepEqual(triggersOf(res, "stream_unresolved").sort(), [[xcid(x)], [xcid(y)]]);
    assert.deepEqual(triggersOf(res, "ordinal_unverified"), []);
    assert.equal(res.coverage.files_stream_conflict, 1);
    assert.equal(res.streams.find((s) => s.chain.thread === x)?.ordinal_verified, true);
    // it is still accounted by its thread_id
    assert.deepEqual(res.responses.map((r) => r.key).sort(), ["resp-1", "resp-2"]);
    assert.equal(res.streams.find((s) => s.chain.thread === x)?.start_ns, parseInstantNs(t(1)) /* meta of F1 */ === null ? null : parseInstantNs(t(1)));
  });

  it("a stream of an unsupported version gets version_unverified only: no ordinal and no fork check (already conforming)", async () => {
    const z = "synthetic-thread-z";
    const bad = xfile("z", [
      cmeta(z, t(5), 0, { cli_version: "0.1.0", forked_from_id: "synthetic-thread-parent" }),
      ctc(t(2), 1, "turn-1"), // decreasing instants and no history start
      ctur(t(1), 1, "resp-z", z, "turn-1", cu()),
    ]);
    const res = await parseX([bad]);
    assert.deepEqual(triggersOf(res, "version_unverified"), [[xcid(z)]]);
    assert.deepEqual(triggersOf(res, "ordinal_unverified"), []);
    assert.deepEqual(triggersOf(res, "fork_prefix_unresolved"), []);
    assert.equal(res.streams.length, 0);
    assert.equal(res.responses.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Item 8: S4.2 BigInt counters
// ---------------------------------------------------------------------------

describe("item 8: counters are BigInt from the range check on (S4.2, R2.16)", () => {
  const MAX = Number.MAX_SAFE_INTEGER;

  it("no Math.max or Math.min and no Number conversion of counters in src/sources", () => {
    const dir = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "src", "sources");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const text = readFileSync(join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      assert.ok(!/Math\.(max|min)\s*\(/.test(text), `${f}: Math.max or Math.min`);
    }
  });

  it("Claude: counters at MAX_SAFE_INTEGER are exact, MAX_SAFE_INTEGER + 1 fails the range check (already conforming)", async () => {
    const res = await parseC([
      cfile(SESS, [
        arec({ uuid: "u1", req: "k-max", msg: "m1", usage: ausage({ input_tokens: MAX, cache_read_input_tokens: MAX, cache_creation_input_tokens: MAX, cache_creation: { ephemeral_5m_input_tokens: MAX, ephemeral_1h_input_tokens: 0 }, output_tokens: MAX }) }),
        arec({ uuid: "u2", req: "k-over", msg: "m2", usage: ausage({ input_tokens: 9007199254740993 }) }),
        // wt = w5 + w1 is checked in BigInt: MAX is not MAX - 1 + 1 + 1
        arec({ uuid: "u3", req: "k-sum", msg: "m3", usage: ausage({ cache_creation_input_tokens: MAX, cache_creation: { ephemeral_5m_input_tokens: MAX - 1, ephemeral_1h_input_tokens: 1 } }) }),
        arec({ uuid: "u4", req: "k-sum2", msg: "m4", usage: ausage({ cache_creation_input_tokens: MAX, cache_creation: { ephemeral_5m_input_tokens: MAX - 1, ephemeral_1h_input_tokens: 2 } }) }),
      ]),
    ]);
    assert.equal(claudeResp(res, "k-max")[0]?.usage?.cache_read, BigInt(MAX));
    assert.equal(claudeResp(res, "k-over")[0]?.exclusion, "usage_range_failed");
    assert.ok(!claudeResp(res, "k-sum")[0]?.flags.includes("bucket_mismatch"));
    assert.ok(claudeResp(res, "k-sum2")[0]?.flags.includes("bucket_mismatch"));
  });

  it("Codex: the invariants of R2.7 are checked in BigInt (already conforming)", async () => {
    const th = "synthetic-thread-x";
    const res = await parseX([
      xfile(th, [
        cmeta(th, t(1), 0),
        ctc(t(2), 1, "turn-1"),
        ctur(t(3), 2, "ok", th, "turn-1", cu({ in: MAX - 5, out: 5, total: MAX })),
        ctur(t(4), 3, "cached-sum", th, "turn-1", cu({ in: MAX, c: MAX - 1, cw: 2, out: 0, total: MAX })),
        ctur(t(5), 4, "over", th, "turn-1", cu({ in: 9007199254740993 })),
        ctur(t(6), 5, "total-off", th, "turn-1", cu({ in: MAX - 5, out: 5, total: MAX - 1 })),
      ]),
    ]);
    const by = (k: string): CodexResponse => res.responses.find((r) => r.key === k) as CodexResponse;
    assert.equal(by("ok").exclusion, null);
    assert.equal(by("ok").usage?.input_uncached, BigInt(MAX - 5));
    assert.equal(by("cached-sum").exclusion, "usage_invariant_failed");
    assert.equal(by("over").exclusion, "usage_range_failed");
    assert.equal(by("total-off").exclusion, "usage_invariant_failed");
    assert.equal(res.coverage.tokens_in_invalid_responses, BigInt(MAX) + BigInt(MAX));
  });
});

// ---------------------------------------------------------------------------
// Items 9 and 10: pricing
// ---------------------------------------------------------------------------

function claudePriced(o: { model?: string; speed?: "standard" | "fast"; geo?: "us" | "not_available"; tier?: "standard" | "priority" | "batch"; input?: bigint }): ClaudeResponse {
  const usage: UsageBuckets = {
    input_uncached: o.input ?? 1_000_000n,
    cache_read: 0n,
    cache_write_5m: 0n,
    cache_write_1h: 0n,
    cache_write_unknown_ttl: 0n,
    cache_write: 0n,
    output: 0n,
    output_lower_bound: 0n,
    reasoning: null,
    reasoning_included_in_output: false,
  };
  const model = o.model ?? "claude-opus-5-5";
  return {
    provider: "claude",
    key: "synthetic-req-p",
    chain: { provider: "claude", root_session: "synthetic-session", thread: "main" },
    kind: "main",
    version: V,
    support: "full",
    model: { candidate: model, verified: true, source: "claude_explicit", model },
    usage,
    exclusion: null,
    flags: [],
    modifiers: { speed: o.speed ?? "standard", inference_geo: o.geo ?? "not_available", service_tier: o.tier ?? "standard" },
    effort: null,
    time: { event_ms: 1, t_first_ms: 1, t_last_ms: 1, t_asm_ms: null, start_lo_ms: null, start_hi_ms: 1, gap_basis: "none" },
    ordinal: null,
    ownership: { role: "owner", ambiguous: false, owner_stream_start_ms: 1 },
    provenance: { files: [0], from_copy_exposed_file: false },
    message_id: "synthetic-msg",
    uuid: null,
    parent_uuid: null,
    is_sidechain: false,
    entrypoint: null,
    per_turn_effort: null,
    advisor_model: null,
    stop_reason: null,
    diag: null,
    copies: 1,
  };
}

function codexPriced(model: string, input: bigint): CodexResponse {
  const usage: UsageBuckets = {
    input_uncached: input,
    cache_read: 0n,
    cache_write_5m: 0n,
    cache_write_1h: 0n,
    cache_write_unknown_ttl: 0n,
    cache_write: 0n,
    output: 10n,
    output_lower_bound: 10n,
    reasoning: 0n,
    reasoning_included_in_output: true,
  };
  const c = claudePriced({});
  return {
    ...c,
    provider: "codex",
    key: "synthetic-resp-p",
    chain: { provider: "codex", root_session: "synthetic-thread", thread: "synthetic-thread" },
    model: { candidate: model, verified: true, source: "own_turn", model },
    usage,
    modifiers: { speed: null, inference_geo: null, service_tier: null },
    thread_id: "synthetic-thread",
    session_id: "synthetic-thread",
    turn_id: null,
    root_turn_id: null,
    comp_hash: null,
    collaboration_mode: null,
    thread_total: null,
  } as unknown as CodexResponse;
}

const tableCopy = (): any => structuredClone(DEFAULT_TABLE) as any;

describe("item 9: geo us needs the table level modifiers.geo_us object too (S8.2, R3.4)", () => {
  const price = (table: PricingTable, r: ClaudeResponse) => priceResponse(r, loadPriceBook(table));
  const OPUS_GEO = claudePriced({ geo: "us" });

  it("verified table object and verified model object: priced with the 11/10 multiplier", () => {
    const p = price(tableCopy(), OPUS_GEO);
    assert.equal(p.cost.pico, 4_400_000_000_000n); // 1M input tokens at 4 USD, times 1.1
    assert.equal(price(tableCopy(), claudePriced({ geo: "not_available" })).cost.pico, 4_000_000_000_000n);
  });

  it("modifiers.geo_us.verified false: no dollars, reason geo_other (the standard row)", () => {
    const t = tableCopy();
    t.modifiers.geo_us.verified = false;
    const p = price(t, OPUS_GEO);
    assert.equal(p.cost.pico, null);
    assert.equal(p.modifier_reason, "geo_other");
    // a response without the geo multiplier is unaffected
    assert.equal(price(t, claudePriced({ geo: "not_available" })).cost.pico, 4_000_000_000_000n);
  });

  it("modifiers.geo_us.verified must be a boolean: the string \"true\" refuses the table (R3.1, S8.5b (4))", () => {
    const t = tableCopy();
    t.modifiers.geo_us.verified = "true";
    assert.throws(() => loadPriceBook(t), PriceTableError);
  });

  it("a placeholder date makes the table object unverified (S8.1), an ISO date with a time is a date", () => {
    const t = tableCopy();
    t.modifiers.geo_us.verified_at = "TBD";
    assert.equal(price(t, OPUS_GEO).modifier_reason, "geo_other");
    const ok = tableCopy();
    ok.modifiers.geo_us.verified_at = "2026-10-09T12:00:00Z";
    assert.equal(price(ok, OPUS_GEO).cost.pico, 4_400_000_000_000n);
    // the table date is inherited when the object has none and the placeholder sits at the table level
    const noDate = tableCopy();
    noDate.verified_at = "unknown";
    for (const m of noDate.models) delete m.verified_at;
    assert.equal(price(noDate, OPUS_GEO).cost.pico, null);
  });

  it("the model geo_us object must be verified and apply too (already conforming)", () => {
    const t = tableCopy();
    t.models.find((m: any) => m.id === "claude-opus-5-5").geo_us.verified = false;
    assert.equal(price(t, OPUS_GEO).modifier_reason, "geo_other");
    const u = tableCopy();
    u.models.find((m: any) => m.id === "claude-opus-5-5").geo_us.applies = false;
    assert.equal(price(u, OPUS_GEO).modifier_reason, "geo_other");
  });

  it("fast with geo us also needs the table level geo_us object: fast_geo_unverified", () => {
    const fastUs = claudePriced({ speed: "fast", geo: "us" });
    assert.equal(price(tableCopy(), fastUs).cost.pico, 8_800_000_000_000n); // fast input 8 USD times 1.1
    const t = tableCopy();
    t.modifiers.geo_us.verified = false;
    assert.equal(price(t, fastUs).modifier_reason, "fast_geo_unverified");
    const v = tableCopy();
    v.modifiers.fast_with_geo_us.verified = false;
    assert.equal(price(v, fastUs).modifier_reason, "fast_geo_unverified");
    // fast without geo is unaffected by the geo objects
    assert.equal(price(t, claudePriced({ speed: "fast" })).cost.pico, 8_000_000_000_000n);
  });
});

describe("item 10: table price grammar and scope sources (S8.5a)", () => {
  it("accepts 0, integers and decimals without leading zeros", () => {
    for (const v of ["0", "4", "0.5", "10.25", "100"]) {
      const t = tableCopy();
      t.models.find((m: any) => m.id === "claude-opus-5-5").prices_usd_per_mtok.input = v;
      // the ratio test would fail for a changed input price, so only the grammar is checked through the parser
      assert.doesNotThrow(() => {
        try {
          loadPriceBook(t);
        } catch (e) {
          if (e instanceof PriceTableError && e.findings.every((f) => f.code === "ratio" || f.code === "documented_multiplier")) return;
          throw e;
        }
      }, v);
    }
  });

  it("rejects a leading zero, a bare dot, a sign, an exponent and a non-string: the table is malformed", () => {
    for (const v of ["04", "00.5", "007", ".5", "4.", "+4", "-4", "4e1", "0x4", " 4", "4 ", 4, true]) {
      const t = tableCopy();
      t.models.find((m: any) => m.id === "claude-opus-5-5").prices_usd_per_mtok.output = v;
      assert.throws(() => loadPriceBook(t), PriceTableError, String(v));
    }
  });

  it("a malformed price in an unverified entry or in a fast row makes the table malformed too", () => {
    const a = tableCopy();
    a.models.find((m: any) => m.id === "mythos-preview").prices_usd_per_mtok = { input: "05", output: "1", cache_read: "1", cache_write_5m: "1", cache_write_1h: "1" };
    assert.throws(() => loadPriceBook(a), PriceTableError);
    const b = tableCopy();
    b.models.find((m: any) => m.id === "claude-opus-5-5").fast.prices_usd_per_mtok.cache_write_1h = "016";
    assert.throws(() => loadPriceBook(b), PriceTableError);
  });

  it("a multiplier with a leading zero is not a decimal either", () => {
    const t = tableCopy();
    t.models.find((m: any) => m.id === "claude-opus-5-5").multipliers.cache_read = "00.05";
    assert.throws(() => loadPriceBook(t), PriceTableError);
  });

  it("scope_source_id must be an own key of sources: inherited names are not sources (already conforming)", () => {
    const row = (src: string): CodexResponse => {
      const t = tableCopy();
      t.models.find((m: any) => m.id === "gpt-6-sol").long_context.scope_source_id = src;
      return priceResponse(codexPriced("gpt-6-sol", 1000n), loadPriceBook(t), { codex_tier_for_test: "standard" }) as unknown as CodexResponse;
    };
    const ok = priceResponse(codexPriced("gpt-6-sol", 1000n), loadPriceBook(tableCopy()), { codex_tier_for_test: "standard" });
    assert.notEqual(ok.cost.pico, null);
    for (const inherited of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const p = row(inherited) as unknown as { cost: { pico: bigint | null }; modifier_reason: string | null };
      assert.equal(p.cost.pico, null, inherited);
      assert.equal(p.modifier_reason, "long_context_scope", inherited);
    }
  });
});

// ---------------------------------------------------------------------------
// Item 11: S7.5
// ---------------------------------------------------------------------------

describe("item 11: replay_requests_excluded counts accounted responses only (S7.5)", () => {
  const a = "synthetic-session-a";
  const b = "synthetic-session-b";
  const copies = (usageA: Record<string, unknown>): TreeFile[] => [
    cfile(a, [arec({ sid: a, uuid: "u-a", req: "r-shared", msg: "m-shared", ts: "2026-01-01T00:00:01.000Z", usage: usageA })]),
    cfile(b, [arec({ sid: b, uuid: "u-a", req: "r-shared", msg: "m-shared", ts: "2026-01-01T00:00:01.000Z", usage: usageA })]),
  ];

  it("an accounted response counts its replayed representation, in the ledger at the request time", async () => {
    const res = await parseC(copies(ausage()));
    assert.equal(res.coverage.replay_requests_excluded, 1);
    const entry = res.ledger.find((e) => e.n.replay_requests_excluded !== undefined);
    assert.equal(entry?.n.replay_requests_excluded, 1);
    assert.equal(entry?.t_ns, parseInstantNs("2026-01-01T00:00:01.000Z"));
  });

  it("an excluded response (range, incomplete, conflict) counts no replayed representation", async () => {
    for (const bad of [ausage({ input_tokens: -1 }), ausage({ output_tokens: undefined })]) {
      const res = await parseC(copies(bad));
      assert.equal(res.coverage.replay_requests_excluded, 0);
      assert.equal(res.ledger.filter((e) => e.n.replay_requests_excluded !== undefined).length, 0);
    }
    const conflict = await parseC([
      cfile(a, [arec({ sid: a, uuid: "u-a", req: "r-shared", msg: "m-shared" })]),
      cfile(b, [arec({ sid: b, uuid: "u-a", req: "r-shared", msg: "m-shared", usage: ausage({ input_tokens: 99 }) })]),
    ]);
    assert.equal(claudeResp(conflict, "r-shared")[0]?.exclusion, "conflict_input");
    assert.equal(conflict.coverage.replay_requests_excluded, 0);
  });
});

// ---------------------------------------------------------------------------
// Item 12: S10.3
// ---------------------------------------------------------------------------

describe("item 12: the fields of S10.3 are decided over the set of session_metas of a Codex stream", () => {
  const x = "synthetic-thread-x";
  const rest = [ctc(t(2), 13, "turn-1"), ctur(t(3), 14, "resp-1", x, "turn-1", cu())];
  const perms = <T,>(xs: readonly T[]): T[][] => (xs.length <= 1 ? [[...xs]] : xs.flatMap((a, k) => perms(xs.filter((_, m) => m !== k)).map((r) => [a, ...r])));
  const kinds = async (metas: any[]): Promise<Set<string | undefined>> => {
    const out = new Set<string | undefined>();
    for (const order of perms(metas)) out.add((await parseX([xfile(x, [...order, ...rest])])).responses[0]?.kind);
    return out;
  };

  it("the kind follows the precedence subagent, helper, classifier, main whatever the order of the records", async () => {
    const sub = cmeta(x, t(1), 5, { thread_source: "subagent" });
    const auto = cmeta(x, t(1), 12, { thread_source: "automation" });
    const guard = cmeta(x, t(1), 20, { thread_source: "guardian_review" });
    const user = cmeta(x, t(1), 21, { thread_source: "user" });
    assert.deepEqual([...(await kinds([sub, auto]))], ["subagent"]);
    assert.deepEqual([...(await kinds([auto, guard]))], ["helper"]);
    assert.deepEqual([...(await kinds([guard, user]))], ["classifier"]);
    assert.deepEqual([...(await kinds([user, cmeta(x, t(1), 22, {})]))], ["main"]);
    // a spawn record alone makes a subagent too
    const spawn = cmeta(x, t(1), 6, { source: { subagent: { thread_spawn: { parent_thread_id: "synthetic-parent" } } } });
    assert.deepEqual([...(await kinds([spawn, auto]))], ["subagent"]);
  });

  it("two own metas with equal ordinals, one without a timestamp, give one kind in either order", async () => {
    const a = cmeta(x, t(1), 5, { thread_source: "automation" });
    const b = cmeta(x, undefined, 5, { thread_source: "subagent" });
    assert.deepEqual([...(await kinds([a, b]))], ["subagent"]);
    const c = cmeta(x, undefined, 5, { thread_source: "guardian_review" });
    assert.deepEqual([...(await kinds([a, c]))], ["helper"]);
  });

  it("the link parent counts only when every record of the set carries it: a disagreement is unlinked no_parent_id", async () => {
    const parent = (id: string | null) => ({ source: { subagent: { thread_spawn: id === null ? {} : { parent_thread_id: id } } }, thread_source: "subagent" });
    const link = async (a: any, b: any) => {
      const res = await parseX([xfile(x, [a, b, ...rest])]);
      return res.links.find((l) => l.chain.thread === x);
    };
    const l1 = await link(cmeta(x, t(1), 5, parent("synthetic-parent")), cmeta(x, t(1), 6, parent("synthetic-parent-2")));
    assert.equal(l1?.reason, "no_parent_id");
    const l2 = await link(cmeta(x, t(1), 6, parent("synthetic-parent-2")), cmeta(x, t(1), 5, parent("synthetic-parent")));
    assert.equal(l2?.reason, "no_parent_id");
    const l3 = await link(cmeta(x, t(1), 5, parent("synthetic-parent")), cmeta(x, t(1), 6, parent(null)));
    assert.equal(l3?.reason, "no_parent_id");
    const l4 = await link(cmeta(x, t(1), 5, parent("synthetic-parent")), cmeta(x, t(1), 6, parent("synthetic-parent")));
    assert.equal(l4?.reason, "parent_file_missing"); // the same parent in both records: decided by the usual rules
    // source.subagent.other counts only when uniform
    const other = (o: unknown) => ({ source: { subagent: { other: o } }, thread_source: "subagent" });
    const l5 = await link(cmeta(x, t(1), 5, other("zzz")), cmeta(x, t(1), 6, other(undefined)));
    assert.equal(l5?.reason, "no_parent_id");
  });

  it("a stream with no own session_meta uses its copied ones as a set", async () => {
    const y1 = "synthetic-thread-y1";
    const y2 = "synthetic-thread-y2";
    // Two fork files each carry a copied meta of X (non-own: another meta of the file forks from X). X has records only
    // as usage in its own file without a meta. Copies: automation and subagent.
    const fork = (id: string, copyOrd: number, src: string) =>
      xfile(id, [cmeta(x, t(1), copyOrd, { thread_source: src }), cmeta(id, t(2), copyOrd + 1, { forked_from_id: x, subagent_history_start_ordinal: copyOrd + 1 })]);
    const own = xfile("x", [ctc(t(3), 0, "turn-1"), ctur(t(4), 1, "resp-1", x, "turn-1", cu())]);
    for (const files of [[fork(y1, 12, "automation"), fork(y2, 5, "subagent"), own], [own, fork(y2, 5, "subagent"), fork(y1, 12, "automation")]]) {
      const res = await parseX(files);
      assert.equal(res.responses.find((r) => r.key === "resp-1")?.kind, "subagent");
    }
  });
});

// ---------------------------------------------------------------------------
// Item 13: S6.1 tail
// ---------------------------------------------------------------------------

describe("item 13: independent conflicts of a kept response (S6.1; already conforming)", () => {
  it("conflict_output, conflict_iterations, conflict_modifier and conflict_diagnostics are decided independently and all recorded", async () => {
    const final = (n: number, over: Record<string, unknown>, diagType: string): any =>
      arec({
        uuid: `u${n}`, req: "k", msg: "m",
        usage: ausage({ speed: "standard", ...over }),
        patch: (r) => { r.message.diagnostics = { cache_miss_reason: { type: diagType } }; },
      });
    const res = await parseC([
      cfile(SESS, [
        final(1, { output_tokens: 7, inference_geo: "us", iterations: [{ input_tokens: 99 }] }, "tools_changed"),
        final(2, { output_tokens: 9, inference_geo: "not_available" }, "system_changed"),
        // a second key with only a diagnostics disagreement
        arec({ uuid: "u3", req: "k2", msg: "m2", patch: (r) => { r.message.diagnostics = { cache_miss_reason: { type: "tools_changed" } }; } }),
        arec({ uuid: "u4", req: "k2", msg: "m2", patch: (r) => { r.message.diagnostics = { cache_miss_reason: { type: "system_changed" } }; } }),
      ]),
    ]);
    const r = claudeResp(res, "k")[0] as ClaudeResponse;
    assert.equal(r.exclusion, null);
    assert.deepEqual(
      res.conflicts.filter((c) => c.key === "k").map((c) => c.kind).sort(),
      ["conflict_diagnostics", "conflict_iterations", "conflict_modifier", "conflict_output"],
    );
    assert.equal(r.usage?.output, null);
    assert.equal(r.modifiers.inference_geo, null);
    assert.equal(r.diag, null);
    for (const f of ["conflict_output", "conflict_iterations", "conflict_modifier", "conflict_diagnostics"] as const) assert.ok(r.flags.includes(f), f);
    // counted once per kind; requests_conflict counts a request once and never for conflict_diagnostics alone
    assert.equal(res.coverage.requests_conflict_by_kind.conflict_output, 1);
    assert.equal(res.coverage.requests_conflict_by_kind.conflict_iterations, 1);
    assert.equal(res.coverage.requests_conflict_by_kind.conflict_modifier, 1);
    assert.equal(res.coverage.requests_conflict_by_kind.conflict_diagnostics, 2);
    assert.equal(res.coverage.requests_conflict, 1);
    assert.equal(claudeResp(res, "k2")[0]?.exclusion, null);
    // the chain is tainted by the first key, not by the diagnostics-only one
    assert.deepEqual(res.integrity.triggers.filter((x) => x.reason === "request_anomaly").length, 1);
  });

  it("the public constants this file relies on are unchanged", () => {
    assert.equal(CONSTANTS.CODEX_LONG_CTX, 272_000n);
  });
});

// ---------------------------------------------------------------------------
// Follow-up: S2.3 (revised), S2.4, S10.4, S10.5, S12
// ---------------------------------------------------------------------------

describe("S2.4: a model is normalized once, the price lookup uses it as is", () => {
  it("a doubly dated Claude model is normalized to one stripped suffix and has no table row (unknown_model)", async () => {
    const res = await parseC([
      cfile(SESS, [
        arec({ uuid: "u1", model: "claude-opus-5-5-20251001-20251001" }),
        arec({ uuid: "u2", req: "r2", msg: "m2", model: "claude-opus-5-5-20251001" }),
      ]),
    ]);
    const r = claudeResp(res, "synthetic-req-1")[0] as ClaudeResponse;
    assert.equal(r.model.candidate, "claude-opus-5-5-20251001");
    const book = loadPriceBook(DEFAULT_TABLE);
    assert.equal(priceResponse(r, book).cost.reason, "unknown_model");
    // a single suffix is stripped once at read time and prices as the plain model
    const plain = claudeResp(res, "r2")[0] as ClaudeResponse;
    assert.equal(plain.model.candidate, "claude-opus-5-5");
    assert.notEqual(priceResponse(plain, book).cost.pico, null);
  });

  it("the model rows of the totals use the normalized id exactly", async () => {
    const { view } = await analyzeTree([cfile(SESS, [arec({ uuid: "u1", model: "claude-opus-5-5-20251001-20251001" })])], { since: "2025-01-01", until: "2027-01-01" });
    const rows = view.totals.find((x) => x.provider === "claude")!.models;
    assert.deepEqual(rows.map((m) => m.model), ["unlisted"]);
  });
});

describe("S2.3: a null context model is a member of TM(T)", () => {
  const th = "synthetic-thread-x";
  const run = (models: Array<string | null>) =>
    parseX([
      xfile(th, [
        cmeta(th, t(1), 0),
        ...models.map((m, i) => ctc(t(2 + i), 1 + i, "turn-1", m ?? "NOT A MODEL!")),
        ctur(t(20), 10, "resp-1", th, "turn-1", cu()),
      ]),
    ]);
  it("a model A and a null model in one turn are turn_model_conflicted", async () => {
    assert.deepEqual(triggersOf(await run(["gpt-6-sol", null]), "turn_model_conflicted"), [[xcid(th)]]);
  });
  it("two null contexts of a turn and nothing else give a one-member set", async () => {
    assert.deepEqual(triggersOf(await run([null, null]), "turn_model_conflicted"), []);
    assert.deepEqual(triggersOf(await run(["gpt-6-sol", "gpt-6-sol"]), "turn_model_conflicted"), []);
  });
  it("a null context blocks own_turn", async () => {
    const res = await run([null]);
    assert.equal(res.responses[0]?.model.verified, false);
  });
});

describe("S12.3: records_unkeyed counts a usage-bearing record without key whatever its chain key", () => {
  it("no requestId and no sessionId: unkeyed and unattributed_record", async () => {
    const orphan = arec({ uuid: "u-orphan", req: null, msg: null, patch: (r) => { delete r.sessionId; } });
    const res = await parseC([cfile(SESS, [arec({ uuid: "u1" }), orphan])]);
    assert.equal(res.coverage.records_unkeyed, 1);
    assert.ok(res.integrity.triggers.some((x) => x.reason === "unattributed_record" && x.names === "provider"));
    assert.equal(res.ledger.filter((e) => e.n.records_unkeyed === 1 && e.chain === null).length, 1);
    // an API error record or a record without usage is not unkeyed
    const err = arec({ uuid: "u-err", req: null, msg: null, model: "<synthetic>", patch: (r) => { delete r.sessionId; } });
    const nou = arec({ uuid: "u-nou", req: null, msg: null, usage: null, patch: (r) => { delete r.sessionId; } });
    assert.equal((await parseC([cfile(SESS, [err, nou])])).coverage.records_unkeyed, 0);
    // a keyed record without a sessionId is not unkeyed
    const keyed = arec({ uuid: "u-k", patch: (r) => { delete r.sessionId; } });
    assert.equal((await parseC([cfile(SESS, [keyed])])).coverage.records_unkeyed, 0);
  });
});

describe("S12.7: the model row of a Claude response with no model at all is `unlisted`", () => {
  it("is keyed unlisted, unverified", async () => {
    const { view } = await analyzeTree([cfile(SESS, [arec({ uuid: "u1", model: null })])], { since: "2025-01-01", until: "2027-01-01" });
    const row = view.totals.find((x) => x.provider === "claude")!.models;
    assert.deepEqual(row.map((m) => m.model), ["unlisted"]);
  });
  it("an unverified Codex response has no model key", async () => {
    const th = "synthetic-thread-x";
    const { view } = await analyzeTree([xfile(th, [cmeta(th, t(1), 0), ctur(t(3), 1, "resp-1", th, "turn-1", cu())])], { since: "2025-01-01", until: "2027-01-01" });
    assert.deepEqual(view.totals.find((x) => x.provider === "codex")!.models.map((m) => m.model), [null]);
  });
});

describe("S12.1, S12.2, S12.4, S12.5: windowed and live-aware counters (already conforming)", () => {
  const A = "synthetic-session-a";
  const win = { since: "2026-01-01T00:00:10Z", until: "2026-01-01T00:00:30Z" };
  const rq = (n: number, sec: number, over: Partial<AOpts> = {}): any => arec({ uuid: `u${n}`, req: `r${n}`, msg: `m${n}`, ts: t(sec), ...over });

  it("requests_total, output_unknown_requests, api_error_records and baseline follow the window", async () => {
    const files = [
      cfile(A, [
        rq(1, 5), // before the window: baseline
        rq(2, 15), // in the window
        rq(3, 20, { usage: ausage({ speed: undefined }) }), // no final copy: output unknown
        arec({ uuid: "u-err", req: null, msg: null, model: "<synthetic>", ts: t(16), usage: null }),
        arec({ uuid: "u-err2", req: null, msg: null, model: "<synthetic>", ts: t(40), usage: null }),
        rq(4, 40), // after the window
      ]),
    ];
    const { view } = await analyzeTree(files, win);
    const c = view.coverage_by_provider.claude;
    const total = view.totals.find((x) => x.provider === "claude")!;
    assert.equal(total.requests_total, 2);
    assert.equal(c.requests_total, 2); // S12.2: equals the response count of the totals
    assert.equal(c.output_unknown_requests, 1); // S12.4: no final copy counts
    assert.equal(c.api_error_records, 1);
    assert.equal(c.baseline_requests_loaded, 1);
  });

  it("a live family is out of the windowed counters and the baseline", async () => {
    const B = "synthetic-session-b";
    const live = cfile(B, [
      arec({ sid: B, uuid: "ub1", req: "rb1", msg: "mb1", ts: t(5) }),
      arec({ sid: B, uuid: "ub2", req: "rb2", msg: "mb2", ts: t(15) }),
      "{ broken",
    ]);
    const files = [cfile(A, [rq(1, 5), rq(2, 15)]), { ...live, mtimeMs: RUN_START - 100_000 }];
    const { view } = await analyzeTree(files, win);
    const c = view.coverage_by_provider.claude;
    assert.equal(c.requests_total, 1);
    assert.equal(c.baseline_requests_loaded, 1); // only session A's early request
    assert.equal(c.families_live_skipped, 1);
  });
});

describe("S12.6: files and lines count sidecars", () => {
  it("a JSON sidecar is a file and one line, one parse error when it does not parse", async () => {
    const meta = (ok: boolean): TreeFile => ({
      path: `projects/synthetic-project/${SESS}/subagents/agent-ag1.meta.json`,
      content: ok ? JSON.stringify({ toolUseId: "tu" }) : "{ nope",
    });
    const prefix: TreeFile = { path: `projects/synthetic-project/${SESS}/subagents/agent-ag1.prefix.json`, content: JSON.stringify({ state: {} }) };
    const main = cfile(SESS, [arec({ uuid: "u1" }), arec({ uuid: "u2", req: "r2", msg: "m2" })]);
    const ok = await parseC([main, meta(true), prefix]);
    assert.equal(ok.coverage.files_total, 3);
    assert.equal(ok.coverage.lines_total, 4);
    assert.equal(ok.coverage.lines_parse_error, 0);
    const bad = await parseC([main, meta(false), prefix]);
    assert.equal(bad.coverage.files_total, 3);
    assert.equal(bad.coverage.lines_total, 4);
    assert.equal(bad.coverage.lines_parse_error, 1);
    assert.ok(bad.integrity.files.some((f) => f.unparsed_lines === 1 && f.named_chains.length === 0));
  });
});

describe("S10.4: a Codex fork is decided from own session_metas anywhere in the scan", () => {
  const x = "synthetic-thread-x";
  const y = "synthetic-thread-y";
  it("an own meta with a forked_from_id in a stream-conflict file makes the stream a fork; the prefix check reads it", async () => {
    // F1 holds X without a fork marker and its usage; F2 names X and Y (a stream-conflict file) and holds X's own forked meta
    const f1 = xfile("f1", [cmeta(x, t(1), 0), ctc(t(2), 1, "turn-1"), ctur(t(3), 2, "resp-1", x, "turn-1", cu())]);
    const f2 = xfile("f2", [cmeta(y, t(1), 0), cmeta(x, t(1), 1, { forked_from_id: "synthetic-parent" })]);
    const res = await parseX([f1, f2]);
    assert.equal(res.streams.find((s) => s.chain.thread === x)?.fork?.forked_from_id, "synthetic-parent");
    assert.equal(res.streams.find((s) => s.chain.thread === x)?.fork?.prefix_resolved, false); // no history start
    assert.deepEqual(triggersOf(res, "fork_prefix_unresolved"), [[xcid(x)]]);
  });
  it("a copied (non-own) meta with a forked_from_id does not make a fork; an unsupported version is not checked", async () => {
    const z = "synthetic-thread-z";
    const copyOnly = xfile("c", [
      cmeta(x, t(1), 0, { forked_from_id: "synthetic-grand" }), // copy of X's meta inside Y's fork file
      cmeta(y, t(2), 1, { forked_from_id: x, subagent_history_start_ordinal: 2 }),
    ]);
    const own = xfile("x", [ctc(t(3), 0, "turn-1"), ctur(t(4), 1, "resp-1", x, "turn-1", cu())]);
    const res = await parseX([copyOnly, own]);
    assert.equal(res.streams.find((s) => s.chain.thread === x)?.fork ?? null, null);
    const unsupported = await parseX([xfile("z", [cmeta(z, t(1), 0, { cli_version: "0.1.0", forked_from_id: "p" })])]);
    assert.deepEqual(triggersOf(unsupported, "fork_prefix_unresolved"), []);
  });
});

describe("S10.5: replay ownership is decided for excluded keys too", () => {
  it("a tie on a range-failed key gives ownership_ambiguous (counter and taint)", async () => {
    const a = "synthetic-session-a";
    const b = "synthetic-session-b";
    const copy = (sid: string): TreeFile => cfile(sid, [arec({ sid, uuid: "u-a", req: "r-shared", msg: "m-shared", usage: ausage({ input_tokens: -1 }) })]);
    const res = await parseC([copy(a), copy(b)]);
    assert.equal(claudeResp(res, "r-shared")[0]?.exclusion, "usage_range_failed");
    assert.equal(res.coverage.replay_ownership_ambiguous, 1);
    assert.equal(triggersOf(res, "ownership_ambiguous").length, 1);
  });
});

describe("S12.2: requests_total is the accounted responses of the window, unverified versions excluded", () => {
  it("an unverified-version key, an excluded key and a replayed copy are not in requests_total", async () => {
    const A = "synthetic-session-a";
    const B = "synthetic-session-b";
    const files = [
      cfile(A, [
        arec({ sid: A, uuid: "u1", req: "r-ok", msg: "m1", ts: t(5) }),
        arec({ sid: A, uuid: "u2", req: "r-old", msg: "m2", ts: t(6), patch: (r) => { r.version = "2.1.290"; } }),
        arec({ sid: A, uuid: "u3", req: "r-bad", msg: "m3", ts: t(7), usage: ausage({ input_tokens: -1 }) }),
      ]),
      cfile(B, [arec({ sid: B, uuid: "u1", req: "r-ok", msg: "m1", ts: t(5) })]),
    ];
    const { view } = await analyzeTree(files, { since: "2026-01-01T00:00:00Z", until: "2026-01-01T01:00:00Z" });
    const total = view.totals.find((x) => x.provider === "claude")!;
    assert.equal(total.requests_total, 1);
    assert.equal(view.coverage_by_provider.claude.requests_total, 1);
    assert.equal(view.coverage_by_provider.claude.requests_unverified_version, 1);
  });
});

describe("S12.1: an API error record without a sessionId is counted (no chain, never live)", () => {
  it("api_error_records counts it and its ledger entry has no chain", async () => {
    const err = arec({ uuid: "u-err", req: null, msg: null, model: "<synthetic>", usage: null, patch: (r) => { delete r.sessionId; } });
    const res = await parseC([cfile(SESS, [arec({ uuid: "u1" }), err])]);
    assert.equal(res.coverage.api_error_records, 1);
    assert.equal(res.ledger.filter((e) => e.n.api_error_records === 1 && e.chain === null).length, 1);
  });
});

describe("S12.6: workflow agent sidecars are discovered, counted and link nothing", () => {
  const dir = `projects/synthetic-project/${SESS}/subagents/workflows/wf_run1`;
  const wfAgent = (): TreeFile => ({
    path: `${dir}/agent-w1.jsonl`,
    content: jsonl([arec({ uuid: "uw", req: "rw", msg: "mw", agent: "w1" })]),
  });
  const main = cfile(SESS, [arec({ uuid: "u1" })]);
  const meta = (content: string): TreeFile => ({ path: `${dir}/agent-w1.meta.json`, content });
  const prefix: TreeFile = { path: `${dir}/agent-w1.prefix.json`, content: JSON.stringify({ state: { model: "claude-opus-5-5" } }) };

  it("each is one file and one line; one that does not parse is a parse error", async () => {
    const ok = await parseC([main, wfAgent(), meta(JSON.stringify({ toolUseId: "tu-1" })), prefix]);
    assert.equal(ok.coverage.files_total, 4);
    assert.equal(ok.coverage.lines_total, 1 + 1 + 1 + 1);
    assert.equal(ok.coverage.lines_parse_error, 0);
    const bad = await parseC([main, wfAgent(), meta("{ nope"), prefix]);
    assert.equal(bad.coverage.files_total, 4);
    assert.equal(bad.coverage.lines_parse_error, 1);
    assert.ok(bad.integrity.files.some((f) => f.unparsed_lines === 1 && f.named_chains.length === 0));
  });

  it("their fields link nothing: no link by toolUseId, no tool_use retained, no prefix hint", async () => {
    const withTool = arec({ uuid: "u1", patch: (r) => { r.message.content = [{ type: "tool_use", id: "tu-1", name: "Agent" }]; } });
    const res = await parseC([cfile(SESS, [withTool]), wfAgent(), meta(JSON.stringify({ toolUseId: "tu-1" })), prefix]);
    const wf = res.links.find((l) => l.chain.thread === "w1");
    assert.equal(wf?.kind, "workflow_agent");
    assert.notEqual(wf?.state, "verified");
    assert.equal(wf?.parent, null);
    assert.equal(res.prefix_hints.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Pre-audit follow-up: S1.3a, S5.1, S10.1, S12.0, S12.6a, S7.1, R3.9, R16.5
// ---------------------------------------------------------------------------

describe("S1.3a: a boolean holding a non-boolean value, and a container of the wrong shape, are `bad`", () => {
  const lines = async (...r: any[]): Promise<number> => (await parseC([cfile(SESS, r)])).coverage.lines_duplicate_collapsed;
  const side = (v: unknown): any => arec({ uuid: "u1", patch: (r) => { if (v !== undefined) r.isSidechain = v; else delete r.isSidechain; } });

  it("isSidechain: absent and null are missing; \"x\" and 5 are both bad and differ from missing and from true", async () => {
    assert.equal(await lines(side(null), side(undefined)), 1);
    assert.equal(await lines(side("x"), side(undefined)), 0);
    assert.equal(await lines(side("x"), side(5)), 1);
    assert.equal(await lines(side("x"), side(true)), 0);
  });

  it("isApiErrorMessage and isCompactSummary follow the same rule", async () => {
    const err = (v: unknown): any => arec({ uuid: "u1", req: null, msg: null, model: "<synthetic>", patch: (r) => { if (v !== undefined) r.isApiErrorMessage = v; } });
    assert.equal(await lines(err("yes"), err(undefined)), 0);
    assert.equal(await lines(err("yes"), err(1)), 1);
    const sum = (v: unknown): any => arec({ uuid: "u1", patch: (r) => { if (v !== undefined) r.isCompactSummary = v; } });
    assert.equal(await lines(sum({}), sum(undefined)), 0);
    assert.equal(await lines(sum({}), sum([])), 1);
  });

  it("iterations present and not an array, or iterations[0] not an object, is bad; absent, null and [] are missing", async () => {
    const it = (v: unknown): any => arec({ uuid: "u1", usage: ausage(v === undefined ? {} : { iterations: v }) });
    assert.equal(await lines(it("x"), it(undefined)), 0);
    assert.equal(await lines(it("x"), it([5])), 1);
    assert.equal(await lines(it({}), it(["y"])), 1);
    assert.equal(await lines(it(null), it([])), 1);
    assert.equal(await lines(it([null]), it(undefined)), 1);
  });

  it("message.content present and not an array is bad", async () => {
    const c = (v: unknown): any => arec({ uuid: "u1", patch: (r) => { if (v !== undefined) r.message.content = v; else delete r.message.content; } });
    assert.equal(await lines(c("x"), c(undefined)), 0);
    assert.equal(await lines(c("x"), c(5)), 1);
    assert.equal(await lines(c(null), c(undefined)), 1);
  });
});

describe("S10.1: a bad, missing or `main` agentId is the main chain", () => {
  it("agentId 5, \"\" and \"main\" all name (session, main)", async () => {
    const rec = (n: number, agent: unknown): any => arec({ uuid: `u${n}`, req: `r${n}`, msg: `m${n}`, patch: (r) => { if (agent !== undefined) r.agentId = agent; } });
    const res = await parseC([cfile(SESS, [rec(1, 5), rec(2, ""), rec(3, "main"), rec(4, undefined)])]);
    assert.equal(res.responses.length, 4);
    assert.ok(res.responses.every((r) => r.chain.thread === "main" && r.kind === "main"));
    assert.equal(res.streams.length, 1);
  });
});

describe("S12.0: usage-bearing logical records, chainless ones included", () => {
  it("a chainless unkeyed record is usage-bearing too, so records_unkeyed never exceeds records_usage_bearing", async () => {
    const orphan = arec({ uuid: "u-o", req: null, msg: null, patch: (r) => { delete r.sessionId; } });
    const res = await parseC([cfile(SESS, [arec({ uuid: "u1" }), orphan])]);
    assert.equal(res.coverage.records_usage_bearing, 2);
    assert.equal(res.coverage.records_unkeyed, 1);
    // a chainless record that carries a usage object but no valid counters is unmappable
    const bad = arec({ uuid: "u-b", usage: ausage({ output_tokens: undefined }), patch: (r) => { delete r.sessionId; } });
    const res2 = await parseC([cfile(SESS, [bad])]);
    assert.equal(res2.coverage.records_usage_bearing, 1);
    assert.equal(res2.coverage.records_usage_unmappable, 1);
    assert.equal(res2.ledger.filter((e) => e.chain === null && e.n.records_usage_bearing === 1 && e.n.records_usage_unmappable === 1).length, 1);
  });

  it("unmappable counts incomplete and range records", async () => {
    const res = await parseC([
      cfile(SESS, [
        arec({ uuid: "u1", req: "r1", msg: "m1" }),
        arec({ uuid: "u2", req: "r2", msg: "m2", usage: ausage({ input_tokens: -1 }) }),
        arec({ uuid: "u3", req: "r3", msg: "m3", usage: ausage({ output_tokens: undefined }) }),
      ]),
    ]);
    assert.equal(res.coverage.records_usage_bearing, 3);
    assert.equal(res.coverage.records_usage_unmappable, 2);
    const x = "synthetic-thread-x";
    const cx = await parseX([xfile(x, [cmeta(x, t(1), 0), ctur(t(2), 1, "ra", x, "turn-1", cu({ in: -1 })), ctur(t(3), 2, "rb", x, "turn-1", cu({ out: undefined })), ctur(t(4), 3, "rc", x, "turn-1", cu())])]);
    assert.equal(cx.coverage.records_usage_bearing, 3);
    assert.equal(cx.coverage.records_usage_unmappable, 2);
  });

  it("requests_with_final_marker counts accounted responses with a final copy only", async () => {
    const res = await parseC([
      cfile(SESS, [
        arec({ uuid: "u1", req: "r1", msg: "m1" }),
        arec({ uuid: "u2", req: "r2", msg: "m2", usage: ausage({ input_tokens: -1 }) }), // final copy, but range failed
        arec({ uuid: "u3", req: "r3", msg: "m3", usage: ausage({ speed: undefined }) }), // accounted, no final copy
      ]),
    ]);
    assert.equal(res.coverage.requests_with_final_marker, 1);
    assert.equal(res.ledger.reduce((a, e) => a + (e.n.requests_with_final_marker ?? 0), 0), 1);
  });

  it("fields_range_failed counts once per logical record and field, chainless records and cost-state members included", async () => {
    const diag = (over: Record<string, unknown> = {}): any =>
      arec({ uuid: "u1", patch: (r) => { r.message.diagnostics = { cache_miss_reason: { type: "tools_changed", cache_missed_input_tokens: -1 } }; Object.assign(r, over); } });
    const dup = await parseC([cfile(SESS, [diag(), diag()])]);
    assert.equal(dup.coverage.fields_range_failed, 1); // a duplicated line is one logical record
    const chainless = await parseC([cfile(SESS, [diag({ sessionId: undefined })])]);
    assert.equal(chainless.coverage.fields_range_failed, 1);
    assert.equal(chainless.ledger.filter((e) => e.chain === null && e.n.fields_range_failed === 1).length, 1);
    const cost: any = { type: "cost-state", uuid: "u-c", sessionId: SESS, timestamp: t(3), version: V, modelUsage: { "claude-opus-5-5": { inputTokens: -1, outputTokens: 5, cacheReadInputTokens: 1.5 } } };
    const c = await parseC([cfile(SESS, [arec({ uuid: "u2" }), cost])]);
    assert.equal(c.coverage.fields_range_failed, 2);
    assert.equal(c.coverage.known_type_count, 2); // cost-state is a known record type
    assert.equal(c.coverage.unlisted_type_count, 0);
  });
});

describe("S12.6a: a JSON sidecar over 8 MiB is unreadable", () => {
  it("exactly 8 MiB is read, one byte more counts in files_unreadable, adds no line and taints the provider", async () => {
    const MIB8 = 8 * 1024 * 1024;
    const body = (size: number): string => {
      const head = '{"toolUseId":"tu-1","pad":"';
      const tail = '"}';
      return head + "a".repeat(size - head.length - tail.length) + tail;
    };
    const meta = (size: number): TreeFile => ({ path: `projects/synthetic-project/${SESS}/subagents/agent-ag1.meta.json`, content: body(size) });
    const main = cfile(SESS, [arec({ uuid: "u1" })]);
    const ok = await parseC([main, meta(MIB8)]);
    assert.equal(ok.coverage.files_unreadable, 0);
    assert.equal(ok.coverage.lines_total, 2);
    const big = await parseC([main, meta(MIB8 + 1)]);
    assert.equal(big.coverage.files_total, 2);
    assert.equal(big.coverage.files_unreadable, 1);
    assert.equal(big.coverage.lines_total, 1);
    assert.ok(big.integrity.triggers.some((x) => x.reason === "file_unreadable" && x.names === "provider"));
  });
});

describe("S7.1: window membership is decided on exact instants", () => {
  const A = "synthetic-session-a";
  it("a request one nanosecond before since or at until is out, at since or one nanosecond before until is in", async () => {
    const win = { since: "2026-01-01T00:00:10Z", until: "2026-01-01T00:00:30Z" };
    const rq = (n: number, ts: string): any => arec({ uuid: `u${n}`, req: `r${n}`, msg: `m${n}`, ts });
    const files = [
      cfile(A, [
        rq(1, "2026-01-01T00:00:09.999999999Z"),
        rq(2, "2026-01-01T00:00:10.000000000Z"),
        rq(3, "2026-01-01T00:00:29.999999999Z"),
        rq(4, "2026-01-01T00:00:30.000000000Z"),
        arec({ uuid: "ue1", req: null, msg: null, model: "<synthetic>", usage: null, ts: "2026-01-01T00:00:09.999999999Z" }),
        arec({ uuid: "ue2", req: null, msg: null, model: "<synthetic>", usage: null, ts: "2026-01-01T00:00:29.999999999Z" }),
      ]),
    ];
    const { view } = await analyzeTree(files, win);
    const c = view.coverage_by_provider.claude;
    assert.equal(c.requests_total, 2);
    assert.equal(c.baseline_requests_loaded, 1);
    assert.equal(c.api_error_records, 1);
    // without --since the window starts at the first instant of the scan
    const open = await analyzeTree(files, { until: "2026-01-01T00:00:30Z" });
    assert.equal(open.view.coverage_by_provider.claude.requests_total, 3);
    assert.equal(open.view.coverage_by_provider.claude.baseline_requests_loaded, 0);
  });
});

describe("R16.5: a partial headline carries the figures of the open provider only", () => {
  it("the closed provider's tokens stay in its own totals block", async () => {
    const home = new CodexHome();
    const x = new CodexThread({ threadId: "synthetic-thread-x", threadSource: "user", model: "gpt-6-sol" });
    x.turnContext({ turnId: "Tx" });
    x.tokenUsage({ responseId: "x1", usage: { input: 1000, output: 10 } });
    const y = new CodexThread({ threadId: "synthetic-thread-y", threadSource: "user", model: "gpt-6-sol" });
    y.tokenUsage({ responseId: "x2", usage: { input: 2000, output: 20 }, threadId: "synthetic-thread-x", turnId: "Tx", ordinal: 100, dtMs: 100000 });
    home.add(x);
    home.add(y);
    for (let i = 0; i < 97; i++) {
      const th = new CodexThread({ threadId: `synthetic-thread-c${String(i).padStart(3, "0")}`, threadSource: "user", model: "gpt-6-sol" });
      th.turnContext({ turnId: `Tc${i}` });
      th.tokenUsage({ responseId: `c${i}a`, usage: { input: 1000, output: 10 } });
      home.add(th);
    }
    const codexTree: TreeFile[] = home.files().filter((f) => typeof f.content === "string").map((f) => ({ path: f.path, content: f.content as string }));
    const { view } = await analyzeTree([cfile(SESS, [arec({ uuid: "u1" }), arec({ uuid: "u2", req: "r2", msg: "m2", ts: "2026-01-01T00:00:02Z" })]), ...codexTree], { since: "2025-01-01", until: "2027-01-01" });
    assert.equal(view.headline_status, "partial");
    assert.equal(view.withheld_by_provider.claude, null);
    assert.notEqual(view.withheld_by_provider.codex, null);
    const cl = view.totals.find((x) => x.provider === "claude")!;
    const cx = view.totals.find((x) => x.provider === "codex")!;
    assert.ok(cx.requests_total > 0 && cx.tokens_total > 0n);
    const h = view.headline;
    assert.equal(h.n_cx, 0);
    assert.equal(h.n_total, cl.requests_total);
    assert.equal(h.n_priced, cl.requests_priced);
    assert.equal(h.tokens_unpriced, cl.tokens_unpriced);
    assert.equal(h.tokens_total, cl.tokens_total);
    assert.equal(h.cache_read, cl.tokens.cache_read);
    assert.equal(h.total_input, cl.total_input);
    assert.equal(h.usd_pico, cl.usd_pico);
  });
});

describe("S12.0: Codex records without a response_id, API errors and bare timestamps", () => {
  const x = "synthetic-thread-x";
  it("a record without response_id is usage-bearing; incomplete or range counters make it unmappable", async () => {
    const res = await parseX([
      xfile(x, [
        cmeta(x, t(1), 0),
        ctur(t(2), 1, null, x, "turn-1", cu({ in: -1 })),
        ctur(t(3), 2, null, x, "turn-1", cu({ out: undefined })),
        ctur(t(4), 3, null, x, "turn-1", cu()),
      ]),
    ]);
    assert.equal(res.coverage.records_usage_bearing, 3);
    assert.equal(res.coverage.records_unkeyed, 3);
    assert.equal(res.coverage.records_usage_unmappable, 2);
  });
  it("an API error record is not usage-bearing, a bad timestamp alone is not unmappable", async () => {
    const err = arec({ uuid: "u-err", req: null, msg: null, model: "<synthetic>" });
    const res = await parseC([cfile(SESS, [err, arec({ uuid: "u1", ts: "nope" })])]);
    assert.equal(res.coverage.api_error_records, 1);
    assert.equal(res.coverage.records_usage_bearing, 1);
    assert.equal(res.coverage.records_usage_unmappable, 0);
    assert.equal(res.responses[0]?.exclusion, "usage_incomplete");
  });
});

// ---------------------------------------------------------------------------
// G1 round 5: S6.0 (chainless copies) and S5.1 (unlisted-type projection)
// ---------------------------------------------------------------------------

describe("S6.0: a Claude copy without a sessionId is still a copy of its requestId for every check", () => {
  const A = "synthetic-session-a";
  const good = (over: Partial<AOpts> = {}): any => arec({ uuid: "u-good", req: "k", msg: "m", ...over });
  /** The copy without a sessionId (an unattributed_record). */
  const loose = (over: Partial<AOpts> = {}): any =>
    arec({ uuid: "u-loose", req: "k", msg: "m", ...over, patch: (r) => { delete r.sessionId; over.patch?.(r); } });
  const run = (...recs: any[]) => parseC([cfile(A, recs)]);

  it("the valid response plus a chainless copy that lacks the timestamp: usage_incomplete (the audit example)", async () => {
    const res = await run(good(), loose({ patch: (r) => { delete r.timestamp; } }));
    assert.equal(res.responses.length, 1);
    assert.equal(res.responses[0]?.exclusion, "usage_incomplete");
    assert.ok(res.integrity.triggers.some((x) => x.reason === "unattributed_record" && x.names === "provider"));
  });

  it("a chainless copy with a bad timestamp or a missing counter makes the key incomplete; a bad counter makes it range failed", async () => {
    assert.equal((await run(good(), loose({ ts: "2026-02-30T00:00:00Z" }))).responses[0]?.exclusion, "usage_incomplete");
    assert.equal((await run(good(), loose({ usage: ausage({ output_tokens: undefined }) }))).responses[0]?.exclusion, "usage_incomplete");
    assert.equal((await run(good(), loose({ usage: ausage({ input_tokens: -1 }) }))).responses[0]?.exclusion, "usage_range_failed");
    // range comes before incomplete also across chains
    assert.equal((await run(good(), loose({ usage: ausage({ input_tokens: -1 }), ts: null }))).responses[0]?.exclusion, "usage_range_failed");
  });

  it("a chainless copy of an unsupported version makes the key unverified: no response", async () => {
    const res = await run(good(), loose({ patch: (r) => { r.version = "2.1.290"; } }));
    assert.equal(res.responses.length, 0);
    assert.equal(res.coverage.requests_unverified_version, 1);
  });

  it("a chainless copy with another message id is key_conflict (R4.1)", async () => {
    const res = await run(good(), loose({ msg: "m-other" }));
    assert.equal(res.responses[0]?.exclusion, "key_conflict");
    assert.equal(res.coverage.requests_conflict_by_kind.key_conflict, 1);
  });

  it("a chainless copy with other input counters or another model is conflict_input and conflict_model", async () => {
    const input = await run(good(), loose({ usage: ausage({ input_tokens: 99 }) }));
    assert.equal(input.responses[0]?.exclusion, "conflict_input");
    const model = await run(good(), loose({ model: "claude-sonnet-5-5" }));
    assert.equal(model.responses[0]?.exclusion, "conflict_model");
  });

  it("a chainless final copy with another output, iterations or modifier is conflict_output, conflict_iterations and conflict_modifier", async () => {
    const out = await run(good(), loose({ usage: ausage({ output_tokens: 9 }) }));
    assert.equal(out.responses[0]?.exclusion, null);
    assert.ok(out.conflicts.some((c) => c.kind === "conflict_output"));
    assert.equal(out.responses[0]?.usage?.output, null);
    const it = await run(good(), loose({ usage: ausage({ iterations: [{ input_tokens: 99 }] }) }));
    assert.ok(it.conflicts.some((c) => c.kind === "conflict_iterations"));
    const mod = await run(good(), loose({ usage: ausage({ inference_geo: "us" }) }));
    assert.ok(mod.conflicts.some((c) => c.kind === "conflict_modifier"));
    assert.equal(mod.responses[0]?.modifiers.inference_geo, null);
  });

  it("a chainless copy without the final marker does not hide a modifier it carries: a non-final copy must agree with the final one", async () => {
    const res = await run(good(), loose({ usage: ausage({ speed: undefined, inference_geo: "us" }) }));
    assert.ok(res.conflicts.some((c) => c.kind === "conflict_modifier"));
  });

  it("t_first and t_last read the chainless copy", async () => {
    const res = await run(good({ ts: t(10) }), loose({ ts: t(5), usage: ausage({ speed: undefined }) }), loose({ ts: t(20), usage: ausage({ speed: undefined }) }));
    const r = res.responses[0] as ClaudeResponse;
    assert.equal(r.time.t_first_ns, parseInstantNs(t(5)));
    assert.equal(r.time.t_last_ns, parseInstantNs(t(20)));
    assert.equal(r.copies, 1); // the copies of the chain, the chainless ones belong to none
  });

  it("a chainless copy names no chain and is never an owner candidate", async () => {
    const B = "synthetic-session-b";
    const res = await parseC([
      cfile(A, [good({ ts: t(10) })]),
      cfile(B, [arec({ sid: B, uuid: "u-b", req: "k", msg: "m", ts: t(10) })]),
      cfile("synthetic-loose", [loose({ ts: t(1) })]),
    ]);
    assert.equal(res.responses.length, 2);
    // the chainless copy starts earliest but owns nothing: the owners are decided between A and B (a tie)
    assert.ok(res.responses.every((r) => r.ownership.ambiguous));
    assert.equal(res.integrity.chains.length, 2);
    const names = res.integrity.triggers.filter((x) => x.reason === "request_anomaly").flatMap((x) => (x.names === "provider" ? ["*"] : x.names));
    assert.deepEqual(names, []);
  });

  it("a key held by chainless copies only has no response", async () => {
    const res = await run(loose());
    assert.equal(res.responses.length, 0);
    assert.equal(res.coverage.responses_total, 0);
  });

  it("an excluded key taints the chains that hold a copy, not the chainless one", async () => {
    const res = await run(good(), loose({ msg: "m-other" }));
    const names = res.integrity.triggers.filter((x) => x.reason === "request_anomaly").flatMap((x) => (x.names === "provider" ? ["*"] : x.names));
    assert.deepEqual(names, [chainIdOf({ provider: "claude", root_session: A, thread: "main" })]);
  });
});

describe("S5.1: a record of an unlisted type projects to `other` and exactly seven common fields", () => {
  const rec = (over: Record<string, unknown> = {}): any => ({
    type: "zzz",
    uuid: "u1",
    parentUuid: "p1",
    logicalParentUuid: "l1",
    sessionId: SESS,
    agentId: "ag",
    timestamp: t(2),
    version: V,
    ...over,
  });
  const collapsed = async (a: any, b: any): Promise<number> => (await parseC([cfile(SESS, [a, b])])).coverage.lines_duplicate_collapsed;

  it("equal records collapse; a field outside the seven does not matter", async () => {
    assert.equal(await collapsed(rec(), rec()), 1);
    assert.equal(await collapsed(rec(), rec({ extra: 5, message: { content: "x" }, isSidechain: true, requestId: "r" })), 1);
  });

  it("each common field changed on its own makes two records", async () => {
    assert.equal(await collapsed(rec(), rec({ uuid: "u2" })), 0);
    assert.equal(await collapsed(rec(), rec({ parentUuid: "p2" })), 0);
    assert.equal(await collapsed(rec(), rec({ logicalParentUuid: "l2" })), 0);
    assert.equal(await collapsed(rec(), rec({ sessionId: "synthetic-other" })), 0);
    assert.equal(await collapsed(rec(), rec({ agentId: "ag2" })), 0);
    assert.equal(await collapsed(rec(), rec({ timestamp: t(3) })), 0);
    assert.equal(await collapsed(rec(), rec({ version: "2.1.286" })), 0);
  });

  it("each field has the states missing and bad (null is absent)", async () => {
    for (const f of ["parentUuid", "logicalParentUuid", "agentId", "uuid", "version"]) {
      assert.equal(await collapsed(rec({ [f]: null }), rec({ [f]: undefined })), 1, `${f} null = absent`);
      assert.equal(await collapsed(rec({ [f]: 5 }), rec({ [f]: undefined })), f === "version" ? 0 : 0, `${f} bad differs from missing`);
    }
    // S1.3b: a version that is absent is `missing`, one off the grammar is `unlisted`, and the two differ
    assert.equal(await collapsed(rec({ version: "x" }), rec({ version: undefined })), 0);
    assert.equal(await collapsed(rec({ version: "x" }), rec({ version: 5 })), 1);
  });
});

// ---------------------------------------------------------------------------
// Second internal review: S1.3b, S1.3c, S10.0, S10.1, S12.0
// ---------------------------------------------------------------------------

describe("S1.3b: bad and missing differ in the R4.11 comparison of two own session_metas", () => {
  const th = "synthetic-thread-t1";
  const base = (): TreeFile =>
    xfile("a", [cmeta(th, t(1), 0), ctc(t(2), 1, "tu"), ctur(t(3), 2, "r1", th, "tu", cu())]);
  const second = (payload: Record<string, unknown>): TreeFile => xfile("b", [cmeta(th, t(4), 5, payload)]);

  it("a bad forked_from_id or session_id against a missing one is stream_unresolved", async () => {
    const withBad = await parseX([base(), second({ forked_from_id: {} })]);
    assert.deepEqual(triggersOf(withBad, "stream_unresolved"), [[xcid(th)]]);
    const sess = await parseX([base(), second({ session_id: 5 })]);
    assert.deepEqual(triggersOf(sess, "stream_unresolved"), [[xcid(th)]]);
    // and the stream is tainted for the response
    assert.ok(withBad.integrity.triggers.some((x) => x.reason === "stream_unresolved"));
  });

  it("two bad values are one state, null is missing, an equal value agrees", async () => {
    const a = xfile("a", [cmeta(th, t(1), 0, { forked_from_id: 5 }), ctur(t(3), 2, "r1", th, "tu", cu())]);
    const b = xfile("b", [cmeta(th, t(4), 5, { forked_from_id: {} })]);
    assert.deepEqual(triggersOf(await parseX([a, b]), "stream_unresolved"), []);
    const c = xfile("c", [cmeta(th, t(4), 5, { forked_from_id: null })]);
    assert.deepEqual(triggersOf(await parseX([base(), c]), "stream_unresolved"), []);
  });
});

describe("S1.3b: a session_meta with a missing or bad id stays in the R4.11 analysis of its file", () => {
  it("its forked_from_id makes the parent copy non-own; it adds no own id and is an unattributed_record", async () => {
    const x = "synthetic-thread-x";
    for (const badId of [undefined, 5, ""]) {
      const idless = cmeta("ignored", t(2), 1, { forked_from_id: x });
      if (badId === undefined) delete idless.payload.id;
      else idless.payload.id = badId;
      const res = await parseX([xfile("a", [cmeta(x, t(1), 0), idless])]);
      assert.equal(res.files[0]?.stream_assignment, "unassigned", String(badId)); // X is a copied parent: no own id at all
      assert.ok(res.integrity.triggers.some((y) => y.reason === "unattributed_record" && y.names === "provider"), String(badId));
    }
    // without the id-less meta the same file is assigned to X
    const alone = await parseX([xfile("a", [cmeta(x, t(1), 0)])]);
    assert.equal(alone.files[0]?.stream_assignment, "assigned");
  });
});

describe("S1.3b: a version that is absent differs from one off the grammar", () => {
  it("Claude graph records and Codex session_metas", async () => {
    const lines = async (...r: any[]): Promise<number> => (await parseC([cfile(SESS, r)])).coverage.lines_duplicate_collapsed;
    const v = (x: unknown): any => arec({ uuid: "u1", patch: (r) => { if (x === undefined) delete r.version; else r.version = x; } });
    assert.equal(await lines(v("x"), v(undefined)), 0);
    assert.equal(await lines(v("x"), v(5)), 1); // both unlisted
    assert.equal(await lines(v(null), v(undefined)), 1);
    const th = "synthetic-thread-x";
    const meta = (x: unknown): any => cmeta(th, t(1), 0, { cli_version: x });
    const cx = async (a: any, b: any) => (await parseX([xfile(th, [a, b])])).coverage.lines_duplicate_collapsed;
    assert.equal(await cx(meta("zzz"), meta(undefined)), 0);
    assert.equal(await cx(meta("zzz"), meta(5)), 1);
  });
});

describe("S1.3c: journal records, non-object lines and cost-state", () => {
  const dir = `projects/synthetic-project/${SESS}/subagents/workflows/wf_run1`;
  const journal = (lines: unknown[]): TreeFile => ({ path: `${dir}/journal.jsonl`, content: jsonl(lines) });
  const dups = async (lines: unknown[]): Promise<number> => (await parseC([cfile(SESS, [arec({ uuid: "u1" })]), journal(lines)])).coverage.lines_duplicate_collapsed;

  it("a journal record projects to its type and agentId only", async () => {
    assert.equal(await dups([{ type: "started", agentId: "a", key: "k1" }, { type: "started", agentId: "a", label: "other" }]), 1);
    assert.equal(await dups([{ type: "started", agentId: "a" }, { type: "zzz", agentId: "a" }]), 0);
    assert.equal(await dups([{ type: "zzz", agentId: "a" }, { agentId: "a" }]), 0); // other against missing
    assert.equal(await dups([{ type: "zzz", agentId: "a" }, { type: 5, agentId: "a" }]), 1);
    assert.equal(await dups([{ type: "started", agentId: "a" }, { type: "started", agentId: "b" }]), 0);
    assert.equal(await dups([{ type: "started", agentId: 5 }, { type: "started" }]), 0); // bad against missing
    assert.equal(await dups([{ type: "started", agentId: null }, { type: "started" }]), 1);
  });

  it("every line that is not a JSON object is an equal record of type missing, in logs and journals", async () => {
    assert.equal(await dups(["5", "[1]", "null", '"s"']), 3);
    const main = await parseC([cfile(SESS, ["5", "[1]", "null", '"s"', arec({ uuid: "u1" })])]);
    assert.equal(main.coverage.lines_duplicate_collapsed, 3);
    assert.equal(main.coverage.unlisted_type_count, 4);
  });

  it("cost-state reads only the top-level modelUsage: five token members, counted per raw model key and member", async () => {
    const cost = (modelUsage: unknown, extra: Record<string, unknown> = {}): any => ({ type: "cost-state", uuid: "u-c", sessionId: SESS, timestamp: t(3), version: V, modelUsage, ...extra });
    const n = async (c: any): Promise<number> => (await parseC([cfile(SESS, [arec({ uuid: "u1" }), c])])).coverage.fields_range_failed;
    assert.equal(await n(cost({ "claude-opus-5-5": { inputTokens: -1, outputTokens: 1.5, cacheReadInputTokens: -2, cacheCreationInputTokens: -3, thinkingTokens: -4 } })), 5);
    // raw keys are never normalized: the same member under two keys that normalize alike counts twice
    assert.equal(await n(cost({ "claude-opus-5-5": { inputTokens: -1 }, "claude-opus-5-5-20260101": { inputTokens: -1 } })), 2);
    // other members are not tokens, the snake_case spelling and the nested alias are not read
    assert.equal(await n(cost({ m: { costUSD: -1, webSearchRequests: -1, input_tokens: -1 } })), 0);
    assert.equal(await n(cost(undefined, { costState: { modelUsage: { m: { inputTokens: -1 } } } })), 0);
    // a bad member (string) is not a range failure
    assert.equal(await n(cost({ m: { inputTokens: "5" } })), 0);
  });

  it("a cost-state record projects the common fields plus its modelUsage members", async () => {
    const cost = (over: Record<string, unknown> = {}): any => ({ type: "cost-state", uuid: "u-c", sessionId: SESS, timestamp: t(3), version: V, modelUsage: { m: { inputTokens: 1 } }, ...over });
    const c = async (a: any, b: any): Promise<number> => (await parseC([cfile(SESS, [a, b])])).coverage.lines_duplicate_collapsed;
    assert.equal(await c(cost(), cost()), 1);
    assert.equal(await c(cost(), cost({ isCompactSummary: true })), 1); // not a projected field of a cost-state record
    assert.equal(await c(cost(), cost({ modelUsage: { m: { inputTokens: 2 } } })), 0);
    assert.equal(await c(cost(), cost({ modelUsage: { m2: { inputTokens: 1 } } })), 0);
    assert.equal(await c(cost(), cost({ parentUuid: "p" })), 0);
  });

  it("advisorModel, serverClassifierRequest and content blocks are projected on user, system and attachment records too", async () => {
    for (const type of ["user", "system", "attachment"]) {
      const rec = (over: Record<string, unknown> = {}): any => ({ type, uuid: "u-x", sessionId: SESS, timestamp: t(3), version: V, ...over });
      const c = async (a: any, b: any): Promise<number> => (await parseC([cfile(SESS, [a, b])])).coverage.lines_duplicate_collapsed;
      assert.equal(await c(rec(), rec({ advisorModel: "claude-opus-5-5" })), 0, type);
      assert.equal(await c(rec({ advisorModel: "claude-opus-5-5-20260101" }), rec({ advisorModel: "claude-opus-5-5" })), 1, type);
      assert.equal(await c(rec(), rec({ serverClassifierRequest: {} })), 0, type);
      assert.equal(await c(rec({ serverClassifierRequest: 1 }), rec({ serverClassifierRequest: "x" })), 1, type);
      const blocks = (b: unknown[]): any => rec({ message: { content: b } });
      assert.equal(await c(blocks([{ type: "tool_use", id: "i1", name: "Agent" }]), blocks([{ type: "tool_use", id: "i2", name: "Agent" }])), 0, type);
      assert.equal(await c(blocks([{ type: "tool_use", id: "i1", name: "Agent" }]), blocks([{ type: "tool_use", id: "i1", name: "Zzz" }])), 0, type);
      assert.equal(await c(blocks([{ type: "text", text: "a" }]), blocks([{ type: "text", text: "b" }])), 1, type);
      assert.equal(await c(blocks([{ type: "tool_result", tool_use_id: "i1" }]), blocks([{ type: "tool_result", tool_use_id: "i2" }])), 0, type);
    }
  });
});

describe("S10.0: Claude discovery follows the layout exactly", () => {
  it("only the listed depths and names are discovered", () => {
    const yes = [
      ["p", "s1.jsonl"],
      ["p", "s1", "subagents", "agent-a1.jsonl"],
      ["p", "s1", "subagents", "agent-a1.meta.json"],
      ["p", "s1", "subagents", "agent-a1.prefix.json"],
      ["p", "s1", "workflows", "wf_x.json"],
      ["p", "s1", "subagents", "workflows", "wf_x", "agent-a1.jsonl"],
      ["p", "s1", "subagents", "workflows", "wf_x", "agent-a1.meta.json"],
      ["p", "s1", "subagents", "workflows", "wf_x", "journal.jsonl"],
    ];
    for (const s of yes) assert.notEqual(classifyClaude(s), null, s.join("/"));
    const no = [
      ["p", ".jsonl"], // empty stem
      ["p", "subagents", "agent-a1.jsonl"], // a project called subagents is not a session directory
      ["p", "s1", "x", "subagents", "agent-a1.jsonl"],
      ["p", "q", "s1", "subagents", "workflows", "wf_x", "agent-a1.jsonl"],
      ["p", "s1", "subagents", "x", "agent-a1.jsonl"],
      ["p", "s1", "subagents", "workflows", "x", "agent-a1.jsonl"], // not wf_
      ["p", "s1", "subagents", "workflows", "wf_x", "y", "agent-a1.jsonl"],
      ["p", "s1", "subagents", "workflows", "wf_x", "y", "journal.jsonl"],
      ["p", "s1", "subagents", "journal.jsonl"],
      ["p", "s1", "x", "workflows", "wf_x.json"],
      ["p", "s1", "workflows", "wf_.json"],
      ["p", "s1", "subagents", "agent-.jsonl"],
      ["p", "s1", "subagents", "agent-a1.other.json"],
    ];
    for (const s of no) assert.equal(classifyClaude(s), null, s.join("/"));
  });

  it("discover and the parser agree: a wrongly placed agent log is not a file of the scan", async () => {
    const root = writeTree([
      { path: `projects/p/${SESS}.jsonl`, content: jsonl([arec({ uuid: "u1" })]) },
      { path: `projects/p/subagents/agent-a1.jsonl`, content: jsonl([arec({ uuid: "u2", req: "r2", msg: "m2" })]) },
      { path: `projects/p/q/${SESS}/subagents/workflows/wf_x/agent-a1.jsonl`, content: jsonl([arec({ uuid: "u3", req: "r3", msg: "m3" })]) },
      { path: `projects/p/.jsonl`, content: jsonl([arec({ uuid: "u4", req: "r4", msg: "m4" })]) },
    ]);
    const d = await discover({ claudeDirs: [join(root, "projects")], codexDirs: [join(root, "none")], env: {}, home: root });
    assert.equal(d.files.length, 1);
    assert.equal((await parseClaude(d.files)).responses.length, 1);
  });
});

describe("S10.1: the workflow_agent kind follows any parsed record that names the chain", () => {
  const dir = `projects/synthetic-project/${SESS}/subagents`;
  const agent = (n: number, over: Partial<AOpts> = {}): any => arec({ uuid: `ua${n}`, req: `ra${n}`, msg: `ma${n}`, agent: "ag1", ...over });
  const kindOfAgent = async (wfLines: unknown[]): Promise<string | undefined> => {
    const res = await parseC([
      { path: `${dir}/agent-ag1.jsonl`, content: jsonl([agent(1)]) },
      { path: `${dir}/workflows/wf_run1/agent-ag1.jsonl`, content: jsonl(wfLines) },
    ]);
    return res.responses.find((r) => r.key === "ra1")?.kind;
  };

  it("a record of any type or version in a workflow directory names the chain", async () => {
    assert.equal(await kindOfAgent([]), "subagent");
    assert.equal(await kindOfAgent([{ type: "zzz", sessionId: SESS, agentId: "ag1", uuid: "m1" }]), "workflow_agent"); // mystery type
    assert.equal(await kindOfAgent([{ type: "cost-state", sessionId: SESS, agentId: "ag1", uuid: "m2", timestamp: t(3), version: V }]), "workflow_agent");
    assert.equal(await kindOfAgent([agent(2, { patch: (r) => { r.version = "2.1.290"; } })]), "workflow_agent"); // unsupported version
    // another agent id or another session does not name the chain
    assert.equal(await kindOfAgent([{ type: "zzz", sessionId: SESS, agentId: "other", uuid: "m3" }]), "subagent");
    assert.equal(await kindOfAgent([{ type: "zzz", sessionId: "synthetic-other", agentId: "ag1", uuid: "m4" }]), "subagent");
    // a record without a string sessionId names no chain
    assert.equal(await kindOfAgent([{ type: "zzz", agentId: "ag1", uuid: "m5" }]), "subagent");
  });

  it("the link of such a chain follows the workflow rules", async () => {
    const res = await parseC([
      { path: `${dir}/agent-ag1.jsonl`, content: jsonl([agent(1)]) },
      { path: `${dir}/workflows/wf_run1/agent-ag1.jsonl`, content: jsonl([{ type: "zzz", sessionId: SESS, agentId: "ag1", uuid: "m1" }]) },
    ]);
    assert.equal(res.links.find((l) => l.chain.thread === "ag1")?.kind, "workflow_agent");
  });
});

describe("S10.4: the prefix check fires when any own fork record has no valid history start", () => {
  const x = "synthetic-thread-x";
  const run = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    parseX([xfile(x, [cmeta(x, t(1), 0, a), cmeta(x, t(1), 1, b), ctc(t(2), 2, "turn-1"), ctur(t(3), 3, "resp-1", x, "turn-1", cu())])]);

  it("one fork record with a string history start unresolves the stream whatever the order or the other record", async () => {
    const good = { forked_from_id: "synthetic-parent", subagent_history_start_ordinal: 4 };
    const bad = { forked_from_id: "synthetic-parent", subagent_history_start_ordinal: "x" };
    const pairs: Array<[Record<string, unknown>, Record<string, unknown>]> = [[good, bad], [bad, good]];
    for (const [a, b] of pairs) {
      const res = await run(a, b);
      assert.deepEqual(triggersOf(res, "fork_prefix_unresolved"), [[xcid(x)]]);
      assert.equal(res.streams[0]?.fork?.prefix_resolved, false);
    }
  });

  it("a record without forked_from_id does not need a history start; two valid fork records resolve", async () => {
    const fork = { forked_from_id: "synthetic-parent", subagent_history_start_ordinal: 0 };
    const res = await run(fork, { thread_source: "user", subagent_history_start_ordinal: "x" });
    assert.deepEqual(triggersOf(res, "fork_prefix_unresolved"), []);
    assert.equal(res.streams[0]?.fork?.prefix_resolved, true);
    const two = await run(fork, { ...fork, thread_source: "user" });
    assert.deepEqual(triggersOf(two, "fork_prefix_unresolved"), []);
  });
});

// ---------------------------------------------------------------------------
// G1 round 6: S10.5a, S12.6b, S8.5a
// ---------------------------------------------------------------------------

describe("S10.5a: stream_start is the minimum instant over every parsed record that names the chain", () => {
  const A = "synthetic-session-a";
  const B = "synthetic-session-b";
  const early = (sid: string, ts: string, extra: Record<string, unknown> = {}): any => ({ type: "zzz", uuid: `u-early-${sid}`, sessionId: sid, timestamp: ts, ...extra });

  it("an early record of an unlisted type makes A the owner of a replayed key", async () => {
    const files = [
      cfile(A, [early(A, t(1)), arec({ sid: A, uuid: "ua", req: "k", msg: "mk", ts: t(10) })]),
      cfile(B, [arec({ sid: B, uuid: "ub0", req: "own-b", msg: "mb", ts: t(5) }), arec({ sid: B, uuid: "ub", req: "k", msg: "mk", ts: t(10) })]),
    ];
    const res = await parseC(files);
    const rows = claudeResp(res, "k");
    assert.equal(rows.find((r) => r.chain.root_session === A)?.ownership.role, "owner");
    assert.equal(rows.find((r) => r.chain.root_session === B)?.ownership.role, "replayed");
    assert.equal(res.streams.find((s) => s.chain.root_session === A)?.start_ns, parseInstantNs(t(1)));
    // by-kind totals: the key counts once
    const { view } = await analyzeTree(files, { since: "2025-01-01", until: "2027-01-01" });
    const total = view.totals.find((x) => x.provider === "claude")!;
    assert.equal(total.requests_total, 2); // k (owned by A) and own-b
    assert.equal(total.requests_by_kind.main, 2);
  });

  it("a cost-state record and an unsupported-version record count; another agentId or an invalid instant does not", async () => {
    const start = async (rec: any): Promise<bigint | null | undefined> =>
      (await parseC([cfile(A, [rec, arec({ sid: A, uuid: "ua", req: "k", msg: "mk", ts: t(10) })])])).streams.find((s) => s.chain.root_session === A)?.start_ns;
    assert.equal(await start({ type: "cost-state", uuid: "c", sessionId: A, timestamp: t(2), version: V, modelUsage: {} }), parseInstantNs(t(2)));
    assert.equal(await start(arec({ sid: A, uuid: "ux", req: "kx", msg: "mx", ts: t(3), patch: (r) => { r.version = "2.1.290"; } })), parseInstantNs(t(3)));
    assert.equal(await start(early(A, t(1), { agentId: "other" })), parseInstantNs(t(10)));
    assert.equal(await start(early(A, "2026-02-30T00:00:00Z")), parseInstantNs(t(10)));
    assert.equal(await start(early(A, t(4), { agentId: "main" })), parseInstantNs(t(4)));
  });
});

describe("S12.6b: duplicates are found across files", () => {
  it("the same journal line in two journal files counts one duplicate", async () => {
    const j = (run: string): TreeFile => ({ path: `projects/synthetic-project/${SESS}/subagents/workflows/wf_${run}/journal.jsonl`, content: jsonl([{ type: "started", agentId: "a" }]) });
    const main = cfile(SESS, [arec({ uuid: "u1" })]);
    const two = await parseC([main, j("r1"), j("r2")]);
    assert.equal(two.coverage.lines_duplicate_collapsed, 1);
    assert.equal(two.coverage.duplicate_records_collapsed, 1);
    const three = await parseC([main, j("r1"), j("r2"), j("r3")]);
    assert.equal(three.coverage.lines_duplicate_collapsed, 2);
    assert.equal(three.coverage.duplicate_records_collapsed, 1);
    const one = await parseC([main, j("r1")]);
    assert.equal(one.coverage.lines_duplicate_collapsed, 0);
  });

  it("the same log record in two files counts one duplicate (already conforming)", async () => {
    const rec = arec({ uuid: "u1" });
    const res = await parseC([cfile("synthetic-session-a", [rec]), cfile("synthetic-session-b", [rec])]);
    assert.equal(res.coverage.lines_duplicate_collapsed, 1);
    assert.equal(res.coverage.duplicate_records_collapsed, 1);
  });

  it("the same Codex record in two files counts one duplicate (already conforming)", async () => {
    const th = "synthetic-thread-x";
    const line = cmeta(th, t(1), 0);
    const res = await parseX([xfile("a", [line]), xfile("b", [line])]);
    assert.equal(res.coverage.lines_duplicate_collapsed, 1);
    assert.equal(res.coverage.duplicate_records_collapsed, 1);
  });
});

describe("S8.5a: every price row of every entry is validated at load with the 1 to 6 decimal grammar", () => {
  const find = (t: any, id: string): any => t.models.find((m: any) => m.id === id);

  it("seven decimals on an unverified row reject the table; six are fine", () => {
    const bad = tableCopy();
    find(bad, "gpt-5.1-codex").prices_usd_per_mtok = { input: "0.1234567", cached_input: "1", output: "1" };
    assert.throws(() => loadPriceBook(bad), PriceTableError);
    const ok = tableCopy();
    find(ok, "gpt-5.1-codex").prices_usd_per_mtok = { input: "0.123456", cached_input: "1", output: "1" };
    assert.doesNotThrow(() => loadPriceBook(ok));
  });

  it("a malformed Anthropic long_context price rejects the table, a well formed one does not", () => {
    const t1 = tableCopy();
    find(t1, "claude-opus-5-5").long_context.prices_usd_per_mtok = { input: "04", output: "1", cache_read: "1", cache_write_5m: "1", cache_write_1h: "1" };
    assert.throws(() => loadPriceBook(t1), PriceTableError);
    const t2 = tableCopy();
    find(t2, "claude-opus-5-5").long_context.prices_usd_per_mtok = { input: "1", output: "1.1234567", cache_read: "1", cache_write_5m: "1", cache_write_1h: "1" };
    assert.throws(() => loadPriceBook(t2), PriceTableError);
    const t3 = tableCopy();
    find(t3, "claude-opus-5-5").long_context.prices_usd_per_mtok = { input: "1", output: "1", cache_read: "1", cache_write_5m: "1", cache_write_1h: "1" };
    assert.doesNotThrow(() => loadPriceBook(t3));
  });

  it("tier, fast, service tier and OpenAI long context rows are checked too, verified or not", () => {
    const rows: Array<[string, (t: any) => void]> = [
      ["fast", (t) => { find(t, "claude-opus-5-5").fast.prices_usd_per_mtok.output = "40.0000001"; }],
      ["service tier", (t) => { find(t, "claude-opus-5-5").service_tier = { priority: { verified: false, prices_usd_per_mtok: { input: "1.1234567", output: "1", cache_read: "1", cache_write_5m: "1", cache_write_1h: "1" } } }; }],
      ["openai long context", (t) => { find(t, "gpt-6-sol").long_context.prices_usd_per_mtok.input = [4]; }],
      ["unverified claude entry", (t) => { find(t, "mythos-preview").prices_usd_per_mtok = { input: "1", output: "1", cache_read: 0.1, cache_write_5m: "1", cache_write_1h: "1" }; }],
    ];
    for (const [name, mutate] of rows) {
      const t1 = tableCopy();
      mutate(t1);
      assert.throws(() => loadPriceBook(t1), PriceTableError, name);
    }
  });
});

describe("S8.5a: a price row that is not an object rejects the table", () => {
  it("a string, number or array in place of a row of an unverified or verified entry", () => {
    for (const row of ["x", 5, [], [{ input: "1" }], true]) {
      const t1 = tableCopy();
      t1.models.find((m: any) => m.id === "gpt-5.1-codex").prices_usd_per_mtok = row;
      assert.throws(() => loadPriceBook(t1), PriceTableError, JSON.stringify(row));
      const t2 = tableCopy();
      t2.models.find((m: any) => m.id === "claude-opus-5-5").fast.prices_usd_per_mtok = row;
      assert.throws(() => loadPriceBook(t2), PriceTableError, JSON.stringify(row));
    }
    // an absent row (null) and an empty object on an unverified entry are not malformed values
    for (const row of [null, {}]) {
      const t3 = tableCopy();
      t3.models.find((m: any) => m.id === "gpt-5.1-codex").prices_usd_per_mtok = row;
      assert.doesNotThrow(() => loadPriceBook(t3), JSON.stringify(row));
    }
  });
});

// ---------------------------------------------------------------------------
// Report layer: coverage.versions bounds, R17.5 unlogged estimate; S8.5b load-time table validation
// ---------------------------------------------------------------------------

describe("coverage.versions in the JSON report is bounded and never throws", () => {
  const manyVersions = (n: number): Record<string, number> => {
    const v: Record<string, number> = {};
    for (let i = 0; i < n; i++) v[`1.${i}.0`] = i + 1;
    return v;
  };
  const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);

  it("65 and 300 versions: summary --json and doctor --json keep at most 256 entries and every line", async () => {
    const { view } = await analyzeTree([cfile(SESS, [arec({ uuid: "u1" })])], { since: "2025-01-01", until: "2027-01-01" });
    for (const n of [65, 300]) {
      const versions = { ...manyVersions(n), "not a version": 7, unlisted: 3, "9.9": 2 };
      const coverage = { ...view.coverage, versions };
      const j = JSON.parse(reportToJsonText({ ...view, coverage })) as { coverage: { versions: Array<{ version: string; lines: number }> } };
      const d = doctorCoverageToJson(coverage, view.drift) as { coverage: { versions: Array<{ version: string; lines: number }> } };
      for (const out of [j.coverage.versions, d.coverage.versions]) {
        assert.ok(out.length <= 256, `${n}: ${out.length}`);
        assert.equal(out.reduce((a, e) => a + e.lines, 0), sum(versions), `${n}: lines preserved`);
        const unlisted = out.find((e) => e.version === "unlisted");
        assert.ok(unlisted !== undefined && unlisted.lines >= 7 + 3 + 2, `${n}: invalid strings are merged into unlisted`);
        assert.equal(out.filter((e) => e.version === "unlisted").length, 1);
        assert.deepEqual(out.map((e) => e.version), [...out.map((e) => e.version)].sort());
      }
      if (n === 65) assert.equal(j.coverage.versions.length, 65 + 1); // nothing is cut below 256
      if (n === 300) {
        // the rest is cut by lines descending: the busiest versions stay
        const kept = new Set(j.coverage.versions.map((e) => e.version));
        assert.ok(kept.has("1.299.0") && !kept.has("1.0.0"));
      }
    }
  });
});

describe("R17.5: the unlogged estimate is printed with its label", () => {
  it("text coverage rows per bucket, signed; the JSON carries an enum-coded note", async () => {
    const { view } = await analyzeTree([cfile(SESS, [arec({ uuid: "u1" })])], { since: "2025-01-01", until: "2027-01-01" });
    const cl = { ...view.coverage_by_provider.claude, unlogged_tokens_estimate: { input_uncached: 1234n, cache_read: -5678n, cache_write: 0n, output: 0n } };
    const withEst = { ...view, coverage_by_provider: { ...view.coverage_by_provider, claude: cl } };
    const text = renderReport(withEst);
    assert.match(text, /unlogged tokens, input_uncached \(includes helper and classifier calls and logging gaps\)\s+\+1,234/);
    assert.match(text, /unlogged tokens, cache_read \(includes helper and classifier calls and logging gaps\)\s+-5,678/);
    assert.doesNotMatch(text, /unlogged tokens, output/); // a zero bucket in every column is not printed
    assert.doesNotMatch(renderReport(view), /unlogged tokens/);
    const j = JSON.parse(reportToJsonText(view)) as { coverage: Record<string, unknown> };
    assert.equal(j.coverage["unlogged_tokens_estimate_note"], "includes_helper_classifier_and_logging_gaps");
    const d = doctorCoverageToJson(view.coverage, view.drift) as { coverage: Record<string, unknown> };
    assert.equal(d.coverage["unlogged_tokens_estimate_note"], "includes_helper_classifier_and_logging_gaps");
  });
});

describe("S8.5b: load-time table validation refuses exactly the listed cases", () => {
  const entry = (t: any, id: string): any => t.models.find((m: any) => m.id === id);
  const refused = (t: unknown): boolean => {
    try {
      loadPriceBook(t as PricingTable);
      return false;
    } catch (e) {
      if (e instanceof PriceTableError) return true;
      throw e;
    }
  };
  const mutate = (fn: (t: any) => void): boolean => {
    const t = tableCopy();
    fn(t);
    return refused(t);
  };

  it("the shipped table loads", () => {
    assert.equal(refused(tableCopy()), false);
  });

  it("(1) table shape", () => {
    for (const bad of [null, 5, "x", []]) assert.equal(refused(bad), true, JSON.stringify(bad));
    assert.equal(mutate((t) => { t.table_version = "pt-2026-1-9"; }), true);
    assert.equal(mutate((t) => { t.table_version = 5; }), true);
    assert.equal(mutate((t) => { t.schema_version = "1"; }), true);
    assert.equal(mutate((t) => { t.models = {}; }), true);
    assert.equal(mutate((t) => { t.table_version = "pt-2026-10-09"; }), false);
  });

  it("(2) entry shape, provider, min_cacheable_tokens, price rows", () => {
    assert.equal(mutate((t) => { t.models.push("x"); }), true);
    assert.equal(mutate((t) => { t.models.push({ id: 5, provider: "openai" }); }), true);
    for (const p of [undefined, null, "x", 5]) assert.equal(mutate((t) => { entry(t, "gpt-5.2").provider = p; }), true, String(p));
    for (const m of [-1, 1.5, "512", {}]) assert.equal(mutate((t) => { entry(t, "claude-opus-5-5").min_cacheable_tokens = m; }), true, JSON.stringify(m));
    assert.equal(mutate((t) => { entry(t, "claude-opus-5-5").min_cacheable_tokens = null; }), false);
    assert.equal(mutate((t) => { entry(t, "claude-opus-5-5").min_cacheable_tokens = 0; }), false);
    assert.equal(mutate((t) => { entry(t, "gpt-5.1-codex").prices_usd_per_mtok = "x"; }), true);
    assert.equal(mutate((t) => { entry(t, "gpt-5.1-codex").prices_usd_per_mtok = { input: "1.1234567", cached_input: "1", output: "1" }; }), true);
  });

  it("(3) a verified entry needs a complete standard row; a write price may be null only for OpenAI", () => {
    for (const f of ["input", "output", "cache_read", "cache_write_5m", "cache_write_1h"]) {
      assert.equal(mutate((t) => { delete entry(t, "claude-sonnet-5-5").prices_usd_per_mtok[f]; }), true, f);
      assert.equal(mutate((t) => { entry(t, "claude-sonnet-5-5").prices_usd_per_mtok[f] = null; }), true, `${f} null`);
    }
    assert.equal(mutate((t) => { delete entry(t, "gpt-5.2").prices_usd_per_mtok.input; }), true);
    assert.equal(mutate((t) => { delete entry(t, "gpt-5.2").prices_usd_per_mtok.cached_input; }), true);
    assert.equal(mutate((t) => { entry(t, "gpt-5.2").prices_usd_per_mtok.cache_write = null; }), false);
    assert.equal(mutate((t) => { entry(t, "claude-sonnet-5-5").prices_usd_per_mtok = null; }), true);
    // an entry that is not verified at run time (no verified flag, or no effective date) is not refused for a missing row
    assert.equal(mutate((t) => { entry(t, "gpt-5.2").verified = false; delete entry(t, "gpt-5.2").prices_usd_per_mtok.input; }), false);
    assert.equal(mutate((t) => { delete t.verified_at; const e = entry(t, "gpt-5.2"); delete e.verified_at; delete e.prices_usd_per_mtok.input; }), false);
  });

  it("(4) every object under modifiers carries a boolean verified", () => {
    for (const v of [undefined, "true", 1, null]) {
      assert.equal(mutate((t) => { if (v === undefined) delete t.modifiers.geo_us.verified; else t.modifiers.geo_us.verified = v; }), true, String(v));
    }
    assert.equal(mutate((t) => { t.modifiers.batch = 5; }), true);
    assert.equal(mutate((t) => { t.modifiers.geo_us.verified = false; }), false);
  });

  it("(5) the R3.2 tests: ratio, documented multipliers, stored inherited multipliers", () => {
    assert.equal(mutate((t) => { entry(t, "claude-opus-5-5").prices_usd_per_mtok.cache_write_5m = "5.01"; }), true);
    assert.equal(mutate((t) => { entry(t, "claude-opus-5-5").fast.prices_usd_per_mtok.cache_read = "0.41"; }), true);
    assert.equal(mutate((t) => { entry(t, "claude-opus-5-5").multipliers.cache_read = "0.1"; }), true);
    assert.equal(mutate((t) => { entry(t, "claude-opus-5-5").fast.multipliers.cache_read = "0.1"; }), true);
    assert.equal(mutate((t) => { const m = entry(t, "claude-haiku-5-5"); m.tiers.high_multipliers.cache_write_1h = "3"; }), true);
  });

  it("(6) a table copy of C25, C26 or C32 that differs", () => {
    assert.equal(mutate((t) => { entry(t, "gpt-6-sol").long_context.threshold_input_tokens = 272001; }), true);
    assert.equal(mutate((t) => { entry(t, "claude-opus-5-5").long_context.threshold_input_tokens = 200000; }), true);
    assert.equal(mutate((t) => { entry(t, "claude-haiku-5-5").tiers.split_tokens = 1; }), true);
    assert.equal(mutate((t) => { t.modifiers.geo_us.multiplier = "1.2"; }), true);
    assert.equal(mutate((t) => { entry(t, "claude-opus-5-5").geo_us.multiplier = "1.2"; }), true);
    assert.equal(mutate((t) => { entry(t, "gpt-6-sol").long_context.threshold_input_tokens = 272000; }), false);
  });

  it("(7) two model ids anywhere with one normalized form", () => {
    assert.equal(mutate((t) => { entry(t, "claude-opus-5-5").model_ids.push("claude-opus-5-5-20260101"); }), true); // one entry
    assert.equal(mutate((t) => { entry(t, "claude-opus-5").model_ids.push("claude-opus-5-5-20260101"); }), true); // two entries
    assert.equal(mutate((t) => { entry(t, "claude-opus-5").model_ids.push("claude-opus-5-5"); }), true);
    assert.equal(mutate((t) => { entry(t, "claude-opus-5").id = "claude-opus-5-5-20260101"; }), true); // entry id against another entry's ids
    assert.equal(mutate((t) => { entry(t, "mythos-preview").model_ids = ["claude-opus-5-5-20260101"]; }), true); // unverified entries count too
    assert.equal(mutate((t) => { entry(t, "claude-opus-5-5").model_ids.push("claude-opus-5-5"); }), true); // the same string twice is two ids
    assert.equal(mutate((t) => { entry(t, "claude-opus-5-5").model_ids = ["claude-opus-5-5"]; }), false); // the entry id equal to its own member is one id
  });

  it("a missing or placeholder verified_at is never a refusal", () => {
    assert.equal(mutate((t) => { delete t.verified_at; }), false);
    assert.equal(mutate((t) => { entry(t, "claude-opus-5-5").verified_at = "TBD"; }), false);
    assert.equal(mutate((t) => { t.modifiers.geo_us.verified_at = 5; }), false);
  });
});

describe("S8.5b (3): any present price row of a verified entry must be complete", () => {
  const entry = (t: any, id: string): any => t.models.find((m: any) => m.id === id);
  const refused = (fn: (t: any) => void): boolean => {
    const t = tableCopy();
    fn(t);
    try {
      loadPriceBook(t);
      return false;
    } catch (e) {
      if (e instanceof PriceTableError) return true;
      throw e;
    }
  };

  it("fast, tiers.high, long_context and service_tier rows", () => {
    assert.equal(refused((t) => { delete entry(t, "claude-opus-5-5").fast.prices_usd_per_mtok.output; }), true);
    assert.equal(refused((t) => { delete entry(t, "claude-haiku-5-5").tiers.high.output; }), true);
    assert.equal(refused((t) => { delete entry(t, "gpt-6-luna").long_context.prices_usd_per_mtok.input; }), true);
    assert.equal(refused((t) => { entry(t, "claude-opus-5-5").long_context.prices_usd_per_mtok = { input: "1" }; }), true); // an Anthropic row too
    assert.equal(refused((t) => { entry(t, "claude-opus-5-5").service_tier = { batch: { verified: true, prices_usd_per_mtok: { input: "1" } } }; }), true);
    assert.equal(refused((t) => { entry(t, "claude-opus-5-5").service_tier = { batch: { verified: false, prices_usd_per_mtok: {} } }; }), true);
  });

  it("an absent row, or any row of an entry that is not verified, is not a refusal", () => {
    assert.equal(refused((t) => { entry(t, "claude-opus-5-5").fast = null; }), false);
    assert.equal(refused((t) => { entry(t, "claude-opus-5-5").service_tier = { batch: { verified: true } }; }), false);
    assert.equal(refused((t) => { const e = entry(t, "claude-opus-5-5"); e.verified = false; delete e.fast.prices_usd_per_mtok.output; }), false);
    assert.equal(refused((t) => { const e = entry(t, "gpt-6-luna"); e.verified = false; delete e.long_context.prices_usd_per_mtok.input; }), false);
  });
});
