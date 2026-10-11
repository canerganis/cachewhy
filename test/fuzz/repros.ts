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
import { shippedTable } from "./table.ts";
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
  { id: "C24a", title: "stray copy of an existing requestId without sessionId", files: [f(S, [cl({ req: "r1" }), cl({ req: "r1", sess: null, ts: T("00:00:00.005") })])], opts: {} },
  { id: "C24b", title: "stray copy without sessionId, other input and no timestamp", files: [f(S, [cl({ req: "r1" }), JSON.stringify({ ...JSON.parse(cl({ req: "r1", usage: { input_tokens: 6 } })), sessionId: undefined, timestamp: undefined, uuid: "u-x" })])], opts: {} },
  { id: "C25", title: "unlisted-type records equal except parentUuid / logicalParentUuid / version", files: [f(S, [cl({ req: "r1" }), JSON.stringify({ type: "mystery", uuid: "m1", sessionId: "s1", timestamp: T("00:00:01.000"), parentUuid: "a", logicalParentUuid: "x", version: "2.1.293" }), JSON.stringify({ type: "mystery", uuid: "m1", sessionId: "s1", timestamp: T("00:00:01.000"), parentUuid: "b", logicalParentUuid: "x", version: "2.1.293" }), JSON.stringify({ type: "mystery", uuid: "m1", sessionId: "s1", timestamp: T("00:00:01.000"), parentUuid: "a", logicalParentUuid: "y", version: "2.1.293" }), JSON.stringify({ type: "mystery", uuid: "m1", sessionId: "s1", timestamp: T("00:00:01.000"), parentUuid: "a", logicalParentUuid: "x", version: "9.9.9" })])], opts: {} },
  { id: "C26", title: "Codex thread_token_usage.total_tokens out of range (-1, 1.5, 2^53) with valid usage", files: [f(X("t1"), [cxMeta("t1"), ...[-1, 1.5, 9007199254740992].map((v, i) => JSON.stringify({ ...JSON.parse(cxUse(`x${i}`, "t1", i + 1, T(`00:0${i + 1}:00.000`))), payload: { ...JSON.parse(cxUse(`x${i}`, "t1", i + 1, T("00:00:00.000"))).payload, thread_token_usage: { total_tokens: v } } }))])], opts: {} },
  ...[
    ["a", "projects/p/subagents/agent-a1.jsonl"],
    ["b", "projects/p/s1/x/subagents/agent-a1.jsonl"],
    ["c", "projects/p/s1/subagents/workflows/wf_w/deeper/agent-a1.jsonl"],
    ["d", "projects/p/.jsonl"],
    ["e", "projects/p/s1/subagents/agent-a1.jsonl"],
  ].map(([k, path]): Repro => ({ id: `C27${k}`, title: `Claude request file at layout ${path}`, files: [f(S, [cl({ req: "r0" })]), f(path!, [cl({ req: "r1", agent: "a1", ts: T("00:01:00.000") })])], opts: {} })),
  { id: "C27f", title: "deep meta.json and journal.jsonl with a broken line", files: [f(S, [cl({ req: "r0" })]), f("projects/p/s1/x/subagents/agent-a1.meta.json", ['{"type":"agent_started"}', "not json", '{"type":']), f("projects/p/s1/x/subagents/workflows/wf_w/journal.jsonl", ['{"type":"agent_started","agentId":"a1"}', "not json", '{"type":'])], opts: {} },
  { id: "C28", title: "two own session_meta of one id with different fork fields (forked_from_id t1/x, history ordinal 4 / string)", files: [f(X("t2"), [cxMeta("t2", { ord: 3, payload: { session_id: "t1", forked_from_id: "t1", subagent_history_start_ordinal: 4 } }), cxMeta("t2", { ord: 19, payload: { session_id: "t1", forked_from_id: "x", subagent_history_start_ordinal: "x" } }, T("00:00:05.000")), cxUse("x1", "t2", 20, T("00:01:00.000"))])], opts: {} },
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

// ---------------------------------------------------------------------------
// Pricing-table reproducers: both implementations must refuse the table, or both accept it and agree (S8.5a).
// ---------------------------------------------------------------------------

type Tbl = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const entry = (t: Tbl, id: string): Tbl => (t.models as Tbl[]).find((m) => m.id === id)!;

export const TABLE_REPROS: Array<{ id: string; title: string; mutate: (t: Tbl) => void }> = [
  { id: "T1", title: "verified entry: a price value is null", mutate: (t) => { entry(t, "claude-opus-4").prices_usd_per_mtok.input = null; } },
  { id: "T2", title: "verified entry: a price row key is missing", mutate: (t) => { delete entry(t, "claude-opus-5-5").prices_usd_per_mtok.output; } },
  { id: "T3", title: "R3.2 ratio: cache_read price off by 0.01", mutate: (t) => { const p = entry(t, "claude-opus-4").prices_usd_per_mtok; p.cache_read = String(Number(p.cache_read) + 0.01); } },
  { id: "T4", title: "entry provider is not anthropic or openai", mutate: (t) => { entry(t, "claude-opus-4-1").provider = "x"; } },
  { id: "T5", title: "OpenAI long_context.threshold_input_tokens differs from C25", mutate: (t) => { entry(t, "gpt-6-astra").long_context.threshold_input_tokens = 272001; } },
  { id: "T6", title: "the same normalized id twice inside one entry's model_ids", mutate: (t) => { const e = entry(t, "claude-sonnet-4-6"); e.model_ids = [...e.model_ids, "claude-sonnet-4-6-20251001"]; } },
  { id: "T7", title: "unverified entry whose price row is the string 'x'", mutate: (t) => { const e = entry(t, "claude-sonnet-4-6"); e.verified = false; e.prices_usd_per_mtok = "x"; } },
  { id: "T9", title: "entry.multipliers is the string 'x'", mutate: (t) => { entry(t, "claude-opus-5-5").multipliers = "x"; } },
  { id: "T10", title: "entry.multipliers is an empty object", mutate: (t) => { entry(t, "claude-opus-5-5").multipliers = {}; } },
  { id: "T11", title: "claude-sonnet-4-6 long_context.multipliers is an empty object", mutate: (t) => { const e = entry(t, "claude-sonnet-4-6"); e.long_context = { ...(e.long_context ?? {}), multipliers: {} }; } },
  { id: "T12", title: "modifiers.geo_us is the number 5", mutate: (t) => { t.modifiers.geo_us = 5; } },
  { id: "T13", title: "table-level modifiers.geo_us.multiplier = '1.2' (copy of C32)", mutate: (t) => { t.modifiers.geo_us.multiplier = "1.2"; } },
  { id: "T14", title: "table-level modifiers.openai_long_context.threshold_input_tokens = 272001 (copy of C25)", mutate: (t) => { t.modifiers.openai_long_context.threshold_input_tokens = 272001; } },
  { id: "T15", title: "entry id equals another entry's model id", mutate: (t) => { entry(t, "claude-opus-4-1").id = "claude-opus-5-5"; } },
  { id: "T16", title: "documented model with a dated entry id and dated model_ids (cache prices correct), S2.4", mutate: (t) => { const e = entry(t, "claude-mythos-5-1"); e.id = "claude-mythos-5-1-20251001"; e.model_ids = ["claude-mythos-5-1-20251001"]; } },
  { id: "T17", title: "new unverified OpenAI entry gpt-5.9 cloned from gpt-5-codex (no prices, no multipliers)", mutate: (t) => { const e = structuredClone(entry(t, "gpt-5-codex")); e.id = "gpt-5.9"; e.model_ids = ["gpt-5.9"]; t.models.push(e); } },
  { id: "T18", title: "control: new verified OpenAI entry gpt-5.7 with the documented multipliers", mutate: (t) => { const e = structuredClone(entry(t, "gpt-5.6-luna")); e.id = "gpt-5.7"; e.model_ids = ["gpt-5.7"]; t.models.push(e); } },
  { id: "T19", title: "documented model whose model_ids start with an empty string: ['', 'claude-fable-5-1']", mutate: (t) => { entry(t, "claude-fable-5-1").model_ids = ["", "claude-fable-5-1"]; } },
  { id: "T20", title: "documented model with only a dated model_ids member (entry id undated)", mutate: (t) => { entry(t, "claude-opus-5-5").model_ids = ["claude-opus-5-5-20251001"]; } },
  { id: "T21", title: "gpt-5.5 multipliers = {cache_read: '0.1'} (wrong key for OpenAI)", mutate: (t) => { entry(t, "gpt-5.5").multipliers = { cache_read: "0.1" }; } },
  { id: "T22", title: "claude-opus-4-7 verified with placeholder date TBD, a price key removed and multipliers absent", mutate: (t) => { const e = entry(t, "claude-opus-4-7"); e.verified = true; e.verified_at = "TBD"; delete e.prices_usd_per_mtok.output; delete e.multipliers; } },
  { id: "T23", title: "claude-opus-4-7 multipliers absent only", mutate: (t) => { delete entry(t, "claude-opus-4-7").multipliers; } },
  { id: "T24", title: "claude-opus-4-7 placeholder date TBD only (row complete)", mutate: (t) => { entry(t, "claude-opus-4-7").verified_at = "TBD"; } },
  { id: "T25", title: "documented model, model_ids = ['claude-opus-5-5-2025100'] (7-digit suffix is no date suffix), entry id undated", mutate: (t) => { entry(t, "claude-opus-5-5").model_ids = ["claude-opus-5-5-2025100"]; } },
  { id: "T26", title: "documented model, model_ids = ['claude-opus-5-5-202510011'] (9-digit suffix), entry id undated", mutate: (t) => { entry(t, "claude-opus-5-5").model_ids = ["claude-opus-5-5-202510011"]; } },
  { id: "T8", title: "control: all prices of one entry doubled (ratios intact)", mutate: (t) => { const e = entry(t, "claude-opus-5-5"); for (const row of [e.prices_usd_per_mtok, e.fast.prices_usd_per_mtok]) for (const k of Object.keys(row)) row[k] = String(Number(row[k]) * 2); } },
];

/** Runs the table reproducers on a small generated scan and prints how each side took the table. */
export async function runTableRepros(): Promise<void> {
  const { generateScan, knobsFor } = await import("./gen.ts");
  const scan = generateScan(5, knobsFor("valid"));
  for (const r of TABLE_REPROS) {
    const t = shippedTable();
    r.mutate(t);
    const res = await runBoth(scan, { tier: true, table: t });
    const verdict = (x: string | null | undefined): string => (x ? "rejects" : "accepts");
    console.log(`## ${r.id} ${r.title}: src ${verdict(res.rejected?.src)}, recompute ${verdict(res.rejected?.rec)}${res.diffs.length > 0 && res.rejected?.src === res.rejected?.rec ? " (outputs differ)" : ""}`);
  }
}
