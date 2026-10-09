// Hand-minimized record-level reproducers of the divergences between src/ and scripts/recompute that the differential
// fuzz test (test/differential-fuzz.test.ts) found. Synthetic data only. This file is not a test: run it to see which
// reproducers still diverge.
//
//   node --import tsx -e "import('./test/fuzz/repros.ts').then((m) => m.runRepros(process.argv[1]))" [id-prefix]
//
// Every reproducer is one or two tiny files. `cl` writes one Claude assistant copy (one JSONL line), `cxMeta` and
// `cxUse` write the Codex `session_meta` and `token_usage_record` lines. Counters default to 5/0/0/7 (Claude) and
// 100/10/0/7/1/107 (Codex), the instants to 2026-01-05T00:00:00Z.
import type { GeneratedFile } from "../fixtures/builder.ts";
import { formatDiff, runBoth } from "./diff.ts";
import type { FuzzScan } from "./gen.ts";

const OLD = Date.UTC(2026, 0, 2);
const T = (s: string): string => `2026-01-05T${s}Z`;

interface ClaudeOpts {
  req?: string | null;
  sess?: string | null;
  msg?: string;
  ts?: unknown;
  model?: string;
  agent?: string;
  noModel?: boolean;
  api?: boolean;
  usage?: Record<string, unknown>;
}

/** One Claude assistant record (one copy of a request). */
export function cl(o: ClaudeOpts = {}): string {
  const usage: Record<string, unknown> = {
    input_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    output_tokens: 7,
    inference_geo: "not_available",
    service_tier: "standard",
    speed: "standard",
    ...(o.usage ?? {}),
  };
  for (const k of Object.keys(usage)) if (usage[k] === undefined) delete usage[k];
  const rec: Record<string, unknown> = {
    type: "assistant",
    uuid: `u-${o.req ?? "r1"}`,
    sessionId: o.sess ?? "s1",
    timestamp: o.ts ?? T("00:00:00.000"),
    version: "2.1.293",
    requestId: o.req ?? "r1",
    message: { id: o.msg ?? `m-${o.req ?? "r1"}`, model: o.model ?? "claude-opus-5-5", stop_reason: "end_turn", usage },
  };
  const message = rec.message as Record<string, unknown>;
  if (o.req === null) delete rec.requestId;
  if (o.sess === null) delete rec.sessionId;
  if (o.noModel) delete message.model;
  if (o.api) {
    rec.isApiErrorMessage = true;
    message.model = "<synthetic>";
    delete message.usage;
  }
  if (o.agent) {
    rec.agentId = o.agent;
    rec.isSidechain = true;
  }
  return JSON.stringify(rec);
}

export const cxMeta = (id: string, o: { ver?: string; payload?: Record<string, unknown>; ord?: number } = {}, ts = T("00:00:00.000")): string =>
  JSON.stringify({ timestamp: ts, type: "session_meta", ordinal: o.ord ?? 0, payload: { id, session_id: id, cli_version: o.ver ?? "0.160.1", source: "cli", thread_source: "user", ...o.payload } });

export const cxUse = (resp: string, thread: string, ord: number | null, ts: string, u: Record<string, unknown> = {}): string =>
  JSON.stringify({
    timestamp: ts,
    type: "token_usage_record",
    ...(ord === null ? {} : { ordinal: ord }),
    payload: { response_id: resp, thread_id: thread, session_id: thread, turn_id: "tu", usage: { input_tokens: 100, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 1, total_tokens: 107, ...u } },
  });

const f = (path: string, lines: string[]): GeneratedFile => ({ path, content: `${lines.join("\n")}\n`, mtimeMs: OLD });
const S = "projects/p/s1.jsonl";
const X = (n: string): string => `sessions/2026/01/05/rollout-${n}.jsonl`;

export interface Repro {
  id: string;
  title: string;
  files: GeneratedFile[];
  opts: { since?: string; until?: string; tier?: boolean };
}

const AGENT_ITER = (out: number): Record<string, unknown>[] => [{ input_tokens: 5, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }];

export const REPROS: Repro[] = [
  { id: "C1a", title: "requests_total: windowed (second request is after since)", files: [f(S, [cl({ req: "r1" }), cl({ req: "r2", ts: T("00:10:00.000") })])], opts: { since: T("00:05:00.000") } },
  { id: "C1b", title: "requests_total: a range-failed request is not counted by src", files: [f(S, [cl({ req: "r1" }), cl({ req: "r2", ts: T("00:10:00.000"), usage: { input_tokens: 1.5 } })])], opts: {} },
  { id: "C2a", title: "files_total / lines_total: agent meta.json sidecar", files: [f(S, [cl({ req: "r1" })]), f("projects/p/s1/subagents/agent-a1.jsonl", [cl({ req: "r2", agent: "a1", ts: T("00:01:00.000") })]), f("projects/p/s1/subagents/agent-a1.meta.json", ['{"agentType":"general-purpose"}'])], opts: {} },
  { id: "C2b", title: "lines_truncated_tail: journal.jsonl with a truncated last line", files: [f(S, [cl({ req: "r1" })]), { path: "projects/p/s1/subagents/workflows/wf_w1/journal.jsonl", content: '{"type":', mtimeMs: OLD }], opts: {} },
  { id: "C3", title: "output_unknown_requests: single copy without usage.speed", files: [f(S, [cl({ req: "r1", usage: { speed: undefined } })])], opts: {} },
  { id: "C4", title: "baseline_requests_loaded: request after until", files: [f(S, [cl({ req: "r1" }), cl({ req: "r2", ts: T("00:10:00.000") })])], opts: { until: T("00:05:00.000") } },
  { id: "C5", title: "api_error_records: error record outside the window", files: [f(S, [cl({ req: "r1" }), cl({ req: "e1", ts: T("00:10:00.000"), api: true })])], opts: { until: T("00:05:00.000") } },
  { id: "C6a", title: "replay ownership of a conflicting (excluded) replayed request", files: [f(S, [cl({ req: "r1" })]), f("projects/p/s2.jsonl", [cl({ req: "r1", sess: "s2", usage: { input_tokens: 6 } })])], opts: {} },
  { id: "C6b", title: "replay_ownership_ambiguous: tied replay before since", files: [f(S, [cl({ req: "r1" })]), f("projects/p/s2.jsonl", [cl({ req: "r1", sess: "s2" })])], opts: { since: T("00:05:00.000") } },
  { id: "C7", title: "key_conflict counted although the request is already usage_incomplete", files: [f(S, [cl({ req: "r1", msg: "m1", usage: { cache_creation: { ephemeral_5m_input_tokens: 0 } } }), cl({ req: "r1", msg: "m2", ts: T("00:00:00.005") })])], opts: {} },
  { id: "C8", title: "key_conflict counted instead of usage_range_failed", files: [f(S, [cl({ req: "r1", msg: "m1" }), cl({ req: "r1", msg: "m2", ts: T("00:00:00.005"), usage: { input_tokens: 9007199254740993 } })])], opts: {} },
  { id: "C9", title: "records_unkeyed: no requestId and no sessionId", files: [f(S, [cl({ req: "r1" }), cl({ req: null, sess: null, ts: T("00:01:00.000") })])], opts: {} },
  { id: "C10", title: "by_model label of a Claude response without a model", files: [f(S, [cl({ req: "r1", noModel: true })])], opts: {} },
  { id: "C11a", title: "model id with two date suffixes, Claude (price lookup)", files: [f(S, [cl({ req: "r1", model: "claude-opus-5-5-20251001-20251001" })])], opts: {} },
  { id: "C11b", title: "model id with two date suffixes, Codex (price lookup, tier parameter)", files: [f(X("t1"), [cxMeta("t1"), JSON.stringify({ timestamp: T("00:00:30.000"), type: "turn_context", ordinal: 1, payload: { turn_id: "tu", model: "gpt-6-sol-20251001-20251001" } }), cxUse("x1", "t1", 2, T("00:01:00.000"))])], opts: { tier: true } },
  { id: "C12", title: "ordinal_unverified from a usage record of the stream inside a stream-conflict file", files: [f(X("t1"), [cxMeta("t1"), cxUse("x1", "t1", null, T("00:01:00.000")), cxUse("x2", "t2", 2, T("00:02:00.000"))])], opts: {} },
  { id: "C13", title: "kind of a Codex chain in a stream-conflict file", files: [f(X("t1"), [cxMeta("t1"), cxUse("x1", "t1", 1, T("00:01:00.000")), cxUse("x2", "t2", 2, T("00:02:00.000"))])], opts: {} },
  { id: "C14", title: "two own session_meta of one id that differ in thread_source (kind depends on file order)", files: [f(X("t1"), [cxMeta("t1", { payload: { thread_source: "automation" } }), cxUse("x1", "t1", 1, T("00:01:00.000"))]), f(X("t1-b"), [JSON.stringify({ timestamp: T("00:03:00.000"), type: "session_meta", ordinal: 0, payload: { id: "t1", session_id: "t1", cli_version: "0.160.1", source: "cli" } })])], opts: {} },
  { id: "C15a", title: "fork of an unverified version with subagent_history_start_ordinal -1", files: [f(X("t1"), [cxMeta("t1"), cxUse("x1", "t1", 1, T("00:01:00.000"))]), f(X("t2"), [cxMeta("t2", { ver: "0.159.0", ord: 5, payload: { forked_from_id: "t1", subagent_history_start_ordinal: -1 } }, T("00:02:00.000"))])], opts: {} },
  { id: "C15b", title: "unverified-version stream with colliding ordinals", files: [f(X("t1"), [cxMeta("t1", { ver: "0.159.0" }), cxUse("x1", "t1", 3, T("00:01:00.000")), cxUse("x2", "t1", 3, T("00:02:00.000"))])], opts: {} },
  { id: "C16a", title: "timestamp: only copy of a request has a non-ISO instant (second 60)", files: [f(S, [cl({ req: "r0" }), cl({ req: "r1", ts: "2026-01-05T00:01:60.000Z" })])], opts: {} },
  { id: "C16b", title: "timestamp: one of two copies has a non-string timestamp", files: [f(S, [cl({ req: "r1", usage: { speed: undefined, output_tokens: 1 } }), cl({ req: "r1", ts: 1767571200000 })])], opts: {} },
  { id: "C16c", title: "timestamp: Codex token_usage_record with second 60", files: [f(X("t1"), [cxMeta("t1"), cxUse("x1", "t1", 3, "2026-01-05T00:09:60.000Z")])], opts: {} },
  { id: "C16d", title: "timestamp grammar S3.1: Feb 30, T24:00:00Z, year 0000, 13 fraction digits (Claude), 10 digits (Codex)", files: [f(S, [cl({ req: "r1", ts: "2026-02-30T00:00:00.000Z" }), cl({ req: "r2", ts: "2026-01-05T24:00:00Z" }), cl({ req: "r3", ts: "0000-01-05T00:00:00.000Z" }), cl({ req: "r4", ts: "2026-01-05T00:00:00.1234567890123Z" })]), f(X("t1"), [cxMeta("t1"), cxUse("x1", "t1", 1, "2026-01-05T00:00:00.1234567890Z")])], opts: {} },
  { id: "C17", title: "conflict_output with iterations (both recorded?)", files: [f(S, [cl({ req: "r1", usage: { output_tokens: 7, iterations: AGENT_ITER(7) } }), cl({ req: "r1", ts: T("00:00:00.005"), usage: { output_tokens: 8, iterations: AGENT_ITER(8) } })])], opts: {} },
  { id: "C19", title: "timestamp: Codex token_usage_record on Feb 30 (calendar check, S3.1)", files: [f(X("t1"), [cxMeta("t1"), cxUse("x1", "t1", 1, "2026-02-30T00:31:06.000Z")])], opts: {} },
  { id: "C20", title: "tokens_in_incomplete_responses: Codex record without output_tokens but with reasoning_output_tokens (S6.3)", files: [f(X("t1"), [cxMeta("t1"), cxUse("x1", "t1", 1, T("00:01:00.000"), { output_tokens: undefined })])], opts: {} },
  { id: "C21", title: "fork_prefix_unresolved of a fork whose own session_meta sits in a stream-conflict file", files: [f(X("t2"), [cxMeta("t2", { ord: 6, payload: { forked_from_id: "t1", subagent_history_start_ordinal: -1 } }, T("00:02:00.000")), cxUse("x1", "t1", 9, T("00:01:00.000")), cxUse("x2", "t2", 14, T("00:03:00.000"))])], opts: {} },
  { id: "C22", title: "TM(T) must ignore a turn_context whose model has no usable id ('<synthetic>'), S2.3", files: [f(X("t1"), [cxMeta("t1"), JSON.stringify({ timestamp: T("00:00:11.000"), type: "turn_context", ordinal: 1, payload: { turn_id: "tu", model: "<synthetic>" } }), JSON.stringify({ timestamp: T("00:00:12.000"), type: "turn_context", ordinal: 2, payload: { turn_id: "tu", model: "gpt-6-sol" } }), cxUse("x1", "t1", 3, T("00:01:00.000"))])], opts: { tier: true } },
  { id: "C23", title: "baseline_requests_loaded counts a response of a live family (R0.9: removed entirely)", files: [{ path: S, content: `${cl({ req: "r1" })}\nnot json at all\n`, mtimeMs: Date.UTC(2026, 5, 1) - 100_000 }], opts: { since: T("00:05:00.000") } },
  { id: "C18", title: "equal-looking duplicate response_id (control: must agree)", files: [f(X("t1"), [cxMeta("t1"), cxUse("x1", "t1", 1, T("00:01:00.000")), cxUse("x1", "t1", 1, T("00:01:00.000"))])], opts: {} },
];

/** Runs the reproducers whose id starts with `prefix` (all by default) and prints the differing fields. */
export async function runRepros(prefix?: string): Promise<void> {
  for (const r of REPROS) {
    if (prefix && !r.id.startsWith(prefix)) continue;
    const scan: FuzzScan = { seed: 0, files: r.files, eventMs: [], minMs: 0, maxMs: 0, used: [] };
    const res = await runBoth(scan, r.opts);
    console.log(`## ${r.id} ${r.title} ${JSON.stringify(r.opts)}`);
    if (res.diffs.length === 0) console.log("   (agree)");
    for (const d of res.diffs.slice(0, 10)) console.log(`   ${formatDiff(d).slice(0, 230)}`);
  }
}
