// Seeded generator of synthetic Claude Code and Codex scan trees for the differential fuzz test
// (test/differential-fuzz.test.ts, spec R13.1 and R13.2). Everything is synthetic: ids start with "synthetic-" and no
// free text is written. No dependency, no clock, no environment: a scan is a pure function of (seed, knobs).
//
// Each generator mostly produces valid records. Features (valid but unusual input) and malformations (injected defects)
// are switched by named probabilities (`Knobs`). Every random decision consumes a fixed number of draws whatever its
// outcome (`Rng.chance`, `Rng.when`), so switching one knob off leaves the rest of the data of a seed unchanged. That
// makes shrinking a failing seed to a minimal reproducer a matter of zeroing knobs.
import type { GeneratedFile } from "../fixtures/builder.ts";
import { OLD_MTIME_MS, RECENT_MTIME_MS, RUN_START_MS } from "../fixtures/r09.ts";

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

/** mulberry32. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  /** One draw in [0, 1). */
  f(): number {
    return this.next();
  }
  /** One draw: integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  /** One draw. */
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)] as T;
  }
  /** One draw: true with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** One draw: an independent stream for a conditional block. */
  sub(): Rng {
    return new Rng(Math.floor(this.next() * 4294967296));
  }
  /** Two draws whatever happens: runs `fn` with an independent stream iff the roll falls under p. */
  when(p: number, fn: (r: Rng) => void): boolean {
    const hit = this.chance(p);
    const s = this.sub();
    if (hit) fn(s);
    return hit;
  }
}

// ---------------------------------------------------------------------------
// Knobs
// ---------------------------------------------------------------------------

/** Valid but unusual input. Both implementations must agree on these without any malformation. */
const FEATURES = {
  model_suffix: 0.3, // -YYYYMMDD on a model id
  c_multi_copy: 0.6, // several copies per requestId
  c_no_final: 0.2, // a request without a copy that carries usage.speed
  c_multi_final: 0.08, // several equal final copies
  c_no_cache_creation: 0.1, // old shape: only cache_creation_input_tokens
  c_iterations: 0.15, // usage.iterations[0] equal to the counters
  c_thinking: 0.1, // output_tokens_details.thinking_tokens
  c_fast_geo_tier: 0.35, // speed fast, geo us, tier priority or batch
  c_zero_usage: 0.04, // an all-zero request
  c_subagent: 0.5,
  c_workflow: 0.3,
  c_replay: 0.15, // copies of one session's requests in another session
  c_api_error: 0.06, // <synthetic> and isApiErrorMessage records
  c_other_records: 0.5, // user, system, attachment records
  c_max_safe: 0.05, // a counter exactly at MAX_SAFE_INTEGER
  c_unknown_model: 0.1, // a model with no table row
  x_multi_turn: 0.5,
  x_settings: 0.2, // thread_settings_applied markers
  x_fork: 0.25,
  x_spawn: 0.3,
  x_automation: 0.1,
  x_dup_equal: 0.1, // a byte-identical duplicated line
  x_long_ctx: 0.2, // input above the 272000 long-context threshold
  x_cache_write: 0.1,
  x_compacted: 0.1,
  x_token_count: 0.3, // event_msg token_count next to a record
  x_archived: 0.1,
  x_split_file: 0.1, // one thread over two files
  x_unknown_model: 0.08,
  x_two_models: 0.2, // different models in different turns
  io_crlf_bom: 0.06, // CRLF line endings and a UTF-8 BOM at the start of a log file (R1.3)
  c_cost_state: 0.15, // cost-state records with modelUsage members (R17.5)
  c_compact: 0.15, // compact_boundary system records with preTokens and postTokens
  c_cost_full: 0.5, // cost-state modelUsage with all 7 real members (thinkingTokens, webSearchRequests, fractional costUSD)
} as const;

/** Injected defects. */
const MALFORMATIONS = {
  ts_format: 0.25, // 0, 3, 6, 9 fractional digits and +hh:mm offsets
  ts_invalid: 0.04, // 2026-02-30, T24:00:00, :60 seconds, lowercase, no zone, too long
  ts_missing: 0.04, // absent, null, number
  ts_submillis: 0.1, // copies or occurrences that differ only beyond milliseconds
  model_odd: 0.05, // uppercase, overlong, empty, odd characters, non-string
  counter_bad: 0.05, // missing, null, "5", 1.5, -1, -0, MAX_SAFE+1, 1e300
  id_bad: 0.03, // empty, number, null, missing ids
  c_disagree_input: 0.04,
  c_disagree_output: 0.05,
  c_disagree_model: 0.03,
  c_disagree_msgid: 0.03,
  c_disagree_modifier: 0.04,
  c_zero_copy: 0.05, // one copy with all-zero usage
  c_no_usage_copy: 0.04, // one copy with no usage at all
  c_partial_cache_creation: 0.04,
  c_bucket_mismatch: 0.04,
  c_iterations_mismatch: 0.04,
  c_modifier_odd: 0.1, // geo/tier absent or other, speed other
  c_missing_request_id: 0.04,
  c_missing_session_id: 0.03,
  c_unsupported_version: 0.06,
  c_garbage_line: 0.04, // unparseable line in a file
  c_truncated_tail: 0.03,
  c_live_mtime: 0.5, // a file with an unparseable line is recent (live)
  c_replay_differ: 0.3, // a replayed copy whose counters differ (only with c_replay)
  c_bad_sidecar: 0.05, // broken meta.json or run json
  x_dup_differ: 0.08, // the same response_id with another usage, turn, thread, ordinal or timestamp
  x_missing_ordinal: 0.04,
  x_collide_ordinal: 0.03,
  x_decreasing_ts: 0.03,
  x_incomplete_usage: 0.05,
  x_invariant: 0.05, // c + cw > in, rs > out, total != in + out
  x_unsupported_version: 0.06,
  x_missing_thread_id: 0.03,
  x_missing_response_id: 0.03,
  x_token_count_only: 0.05, // a file with token_count events and no token_usage_record
  x_model_conflict: 0.05, // two models for one turn id
  x_stream_conflict: 0.04, // a record of another thread in a file, a second own session_meta
  x_bad_fork: 0.2, // a fork with a missing, wrong or non-integer subagent_history_start_ordinal
  x_garbage_line: 0.03,
  io_blank_lines: 0.08, // blank and whitespace-only lines inside a JSONL file
  c_cost_range: 0.3, // out-of-range modelUsage members (only with c_cost_state)
  c_compact_range: 0.3, // out-of-range preTokens or postTokens (only with c_compact)
  c_stray_sidecar: 0.06, // sidecars in the wrong directories
  c_agent_main: 0.04, // agentId set to the literal "main"
  c_nonbool_flags: 0.04, // isSidechain or isApiErrorMessage that is not a boolean
  c_iterations_nonarray: 0.05, // usage.iterations that is not an array of one object
  c_model_split: 0.1, // one Claude model with responses in a clean chain and in a tainted chain
  io_broken_symlink: 0.05, // a broken symlink with a log name (created only where the platform allows symlinks)
  c_early_records: 0.1, // records of other types before every assistant record, with replayed keys across sessions (ownership by stream_start)
  c_cross_dups: 0.1, // journal rows and log lines duplicated across two files
  c_stray_copy: 0.06, // extra copy of an existing requestId without sessionId (maybe no timestamp, other input or model)
  c_mystery_dups: 0.08, // unlisted-type records duplicated except parentUuid, logicalParentUuid or version
  x_total_range: 0.06, // thread_token_usage.total_tokens out of range while usage is valid
  c_cost_dupkey: 0.2, // two modelUsage keys that differ only by a date suffix (only with c_cost_state)
  c_cost_alias: 0.2, // costState.modelUsage alias record, which must be ignored (only with c_cost_state)
  c_compact_subtype: 0.2, // system record with compactMetadata.preTokens out of range and subtype other, absent or a number
  c_bad_layout: 0.08, // Claude files at wrong layouts (too deep, wrong parents, name .jsonl)
  c_dual_agent: 0.08, // one agent chain in subagents/ and in subagents/workflows/wf_w/ (the second holds one odd record)
  c_journal_dups: 0.25, // journal.jsonl rows that duplicate, or share agentId with another type
  io_nonobject_lines: 0.06, // JSON lines that are not objects: 5, [1], null, "x"
  c_other_fields: 0.15, // user, system, attachment records differing only in advisorModel, serverClassifierRequest, content ids
  x_meta_types: 0.06, // own session_meta with forked_from_id or session_id of the wrong type, and a session_meta without id
  x_dup_meta: 0.05, // second own session_meta of one thread, equal ordinal, no timestamp, other thread_source
} as const;

export type FeatureName = keyof typeof FEATURES;
export type MalformationName = keyof typeof MALFORMATIONS;
export type KnobName = FeatureName | MalformationName;
export type Knobs = Record<KnobName, number>;

export const FEATURE_NAMES = Object.keys(FEATURES) as FeatureName[];
export const MALFORMATION_NAMES = Object.keys(MALFORMATIONS) as MalformationName[];
export const KNOB_NAMES = [...FEATURE_NAMES, ...MALFORMATION_NAMES] as KnobName[];

function zeroed(names: readonly KnobName[]): Partial<Knobs> {
  const o: Partial<Knobs> = {};
  for (const n of names) o[n] = 0;
  return o;
}

export type Profile = "bare" | "valid" | "all";

/**
 * bare: nothing optional (plain records only). valid: every feature, no malformation. all: both. `scale` multiplies
 * every probability (capped at 1). `overrides` set single knobs after the profile.
 */
export function knobsFor(profile: Profile, overrides: Partial<Knobs> = {}, scale = 1): Knobs {
  const k: Partial<Knobs> = {};
  for (const n of FEATURE_NAMES) k[n] = profile === "bare" ? 0 : Math.min(1, FEATURES[n] * scale);
  for (const n of MALFORMATION_NAMES) k[n] = profile === "all" ? Math.min(1, MALFORMATIONS[n] * scale) : 0;
  // c_multi_copy and the live mtime are structural: bare keeps single-copy requests and old mtimes.
  return { ...(k as Knobs), ...overrides };
}

/** Every malformation switched off. */
export const NO_MALFORMATION: Partial<Knobs> = zeroed(MALFORMATION_NAMES);

// ---------------------------------------------------------------------------
// JSON text with a few literals that JSON.stringify cannot produce
// ---------------------------------------------------------------------------

const S_NEG0 = "@@NEG0@@";
const S_BIG = "@@BIG@@";
const S_FRAC0 = "@@FRAC0@@";
const S_EXP = "@@EXP@@";

function jsonLine(o: unknown): string {
  return JSON.stringify(o)
    .split(`"${S_NEG0}"`).join("-0")
    .split(`"${S_BIG}"`).join("9007199254740993")
    .split(`"${S_FRAC0}"`).join("5.0")
    .split(`"${S_EXP}"`).join("1E2");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** A counter value that is wrong in some way. `undefined` removes the key. */
function badCounter(r: Rng, v: number): unknown {
  return r.pick<unknown>([undefined, null, String(v), "5", 1.5, v + 0.5, -1, S_NEG0, MAX_SAFE, MAX_SAFE + 1, 1e300, S_BIG, S_FRAC0, S_EXP, true, {}, []]);
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

const pad = (n: number, w: number): string => String(n).padStart(w, "0");

const OFFSETS: readonly number[] = [0, 330, -480, 60, -60, 525, 840];

function offsetText(min: number): string {
  if (min === 0) return "Z";
  const a = Math.abs(min);
  return `${min < 0 ? "-" : "+"}${pad(Math.floor(a / 60), 2)}:${pad(a % 60, 2)}`;
}

/** The instant `ms` written with `digits` fractional digits (0, 3, 6, 9; sub-millisecond digits from `sub`) and an offset. */
export function fmtInstant(ms: number, digits: number, offsetMin: number, sub: string, zeroOffsetAsPlus = false): string {
  const local = new Date(ms + offsetMin * 60000).toISOString(); // YYYY-MM-DDThh:mm:ss.mmmZ
  const head = local.slice(0, 19);
  const milli = local.slice(20, 23);
  let frac = "";
  if (digits === 3) frac = `.${milli}`;
  else if (digits === 6) frac = `.${milli}${sub.slice(0, 3)}`;
  else if (digits === 9) frac = `.${milli}${sub.slice(0, 6)}`;
  // digits === 0: the instant is floored to the second, so it is written only when the milliseconds are 0 (caller's choice)
  const off = offsetMin === 0 && zeroOffsetAsPlus ? "+00:00" : offsetText(offsetMin);
  return `${head}${frac}${off}`;
}

export const INVALID_MAKERS: ReadonlyArray<(ms: number) => unknown> = [
  (ms) => new Date(ms).toISOString().replace(/-\d\d-\d\dT/, "-02-30T"),
  (ms) => new Date(ms).toISOString().replace(/T\d\d:\d\d:\d\d/, "T24:00:00"),
  (ms) => new Date(ms).toISOString().replace(/:\d\d\.(\d{3})Z$/, ":60.$1Z"),
  (ms) => new Date(ms).toISOString().replace(/-\d\d-(\d\d)T/, "-13-$1T"),
  (ms) => new Date(ms).toISOString().replace(/-\d\dT/, "-00T"),
  (ms) => new Date(ms).toISOString().replace("T", "t"),
  (ms) => new Date(ms).toISOString().replace("Z", "z"),
  (ms) => new Date(ms).toISOString().replace("T", " "),
  (ms) => new Date(ms).toISOString().replace("Z", ""),
  (ms) => `${new Date(ms).toISOString().slice(0, -1)}1234567890Z`, // 13 fraction digits
  (ms) => `${new Date(ms).toISOString().slice(0, -1)}+24:00`,
  (ms) => `${new Date(ms).toISOString().slice(0, -1)}+05:60`,
  (ms) => new Date(ms).toISOString().slice(0, 10),
  (ms) => new Date(ms).toISOString().replace(/^\d{4}/, "0000"),
  (ms) => `${new Date(ms).toISOString()}${" ".repeat(40)}`,
  () => "not a time",
  () => "",
  () => 1767225600000,
  (ms) => ({ at: ms }),
];

export interface TsKnobs {
  ts_format: number;
  ts_invalid: number;
  ts_missing: number;
}

/**
 * The timestamp value written for the nominal instant `ms`. Returns `undefined` to omit the key. Always consumes the
 * same number of draws.
 */
export function tsValue(r: Rng, k: TsKnobs, ms: number): unknown {
  const roll = r.f();
  const pickA = r.f();
  const pickB = r.f();
  const sub = String(Math.floor(r.f() * 1e6)).padStart(6, "0");
  const canon = new Date(ms).toISOString();
  if (roll < k.ts_missing) return pickA < 0.4 ? undefined : pickA < 0.7 ? null : pickA < 0.85 ? ms : { t: 1 };
  if (roll < k.ts_missing + k.ts_invalid) return INVALID_MAKERS[Math.floor(pickA * INVALID_MAKERS.length)]!(ms);
  if (roll < k.ts_missing + k.ts_invalid + k.ts_format) {
    const digits = pickA < 0.25 ? 0 : pickA < 0.5 ? 3 : pickA < 0.75 ? 6 : 9;
    const off = OFFSETS[Math.floor(pickB * OFFSETS.length)] as number;
    // 0 digits floors to the second: the nominal instant moves by up to 999 ms, which is fine (it is the written value)
    const base = digits === 0 ? Math.floor(ms / 1000) * 1000 : ms;
    return fmtInstant(base, digits, off, sub, pickB > 0.9);
  }
  return canon;
}

/** A timestamp that differs from `ms` only beyond milliseconds. */
function subMilli(r: Rng, ms: number): string {
  const sub = String(r.int(1, 999999)).padStart(6, "0");
  return fmtInstant(ms, r.chance(0.5) ? 6 : 9, 0, sub);
}

// ---------------------------------------------------------------------------
// Model ids
// ---------------------------------------------------------------------------

export const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5", "claude-haiku-5-5", "claude-sonnet-4-5", "claude-opus-4-1"] as const;
export const CODEX_MODELS = ["gpt-6-sol", "gpt-6-luna", "gpt-5.5", "gpt-6.1-sol", "gpt-5.3-codex", "gpt-5-codex", "gpt-6-astra", "gpt-5.6-luna"] as const;

function modelValue(r: Rng, k: Knobs, base: string): unknown {
  const suffix = r.chance(k.model_suffix);
  const odd = r.chance(k.model_odd);
  const pick = r.f();
  const date = `${pad(r.int(2025, 2026), 4)}${pad(r.int(1, 12), 2)}${pad(r.int(1, 28), 2)}`;
  let m: unknown = base;
  if (suffix) m = `${base}-${date}`;
  if (odd) {
    const up = String(m).toUpperCase();
    const odds: unknown[] = [
      up,
      "",
      `${base}-${"x".repeat(80)}`,
      `${base}-2025101`, // 7 digits: not a date suffix
      `${base}-202510011`, // 9 digits
      `${base}-20251001-20251001`, // suffix stripped once
      ` ${base}`,
      `${base}\u00e9`,
      `.${base}`,
      "-",
      7,
      null,
      { id: base },
      "<synthetic>",
      "unlisted/model",
    ];
    m = odds[Math.floor(pick * odds.length)];
  }
  return m;
}

// ---------------------------------------------------------------------------
// Scan result
// ---------------------------------------------------------------------------

export interface FuzzScan {
  seed: number;
  files: GeneratedFile[];
  /** Nominal event instants (ms) of the generated requests before any timestamp mutation. */
  eventMs: number[];
  minMs: number;
  maxMs: number;
  /** Features that fired, for triage. */
  used: string[];
  /** Relative paths to create as broken symlinks (skipped where the platform refuses symlinks). */
  links?: string[];
}

interface Ctx {
  r: Rng;
  k: Knobs;
  files: GeneratedFile[];
  eventMs: number[];
  used: Set<string>;
  links: string[];
  counters: Map<string, number>;
  baseMs: number;
}

function nextId(c: Ctx, kind: string): string {
  const n = (c.counters.get(kind) ?? 0) + 1;
  c.counters.set(kind, n);
  return `synthetic-${kind}-${pad(n, 4)}`;
}

function used(c: Ctx, name: string): void {
  c.used.add(name);
}

/** An id value that is sometimes bad (S1.1). `undefined` omits the key. */
function idValue(c: Ctx, v: string): unknown {
  const r = c.r;
  const hit = r.chance(c.k.id_bad);
  const pick = r.f();
  if (!hit) return v;
  used(c, "id_bad");
  return pick < 0.3 ? undefined : pick < 0.5 ? null : pick < 0.7 ? "" : pick < 0.85 ? 12345 : { id: v };
}

/** R1.3: BOM and CRLF are tolerated. Always consumes two draws. */
function ioVariant(c: Ctx, body: string): string {
  const hit = c.r.chance(c.k.io_crlf_bom);
  const bom = c.r.chance(0.5);
  if (!hit) return body;
  used(c, "io_crlf_bom");
  const t = body.split("\n").join("\r\n");
  return bom ? `﻿${t}` : t;
}

/** Blank and whitespace-only lines inside a JSONL body. Constant draws (five per call). */
function blankLines(c: Ctx, lines: string[]): void {
  const hit = c.r.chance(c.k.io_blank_lines);
  const n = c.r.int(1, 3);
  const p1 = c.r.f();
  const p2 = c.r.f();
  const p3 = c.r.f();
  if (!hit) return;
  used(c, "io_blank_lines");
  const fills = ["", "   ", "\t", "\t  \t", "\r"];
  for (const pp of [p1, p2, p3].slice(0, n)) lines.splice(Math.floor(pp * (lines.length + 1)), 0, fills[Math.floor(pp * 1000) % fills.length]!);
}

/** JSON lines that are not objects. Constant draws. */
function nonObjectLines(c: Ctx, lines: string[]): void {
  const hit = c.r.chance(c.k.io_nonobject_lines);
  const n = c.r.int(1, 3);
  const p1 = c.r.f();
  const p2 = c.r.f();
  const p3 = c.r.f();
  if (!hit) return;
  used(c, "io_nonobject_lines");
  const fills = ["5", "[1]", "null", '"x"', "true", "[]"];
  for (const pp of [p1, p2, p3].slice(0, n)) lines.splice(Math.floor(pp * (lines.length + 1)), 0, fills[Math.floor(pp * 1000) % fills.length]!);
}

function setOrDelete(o: Obj, key: string, v: unknown): void {
  if (v === undefined) delete o[key];
  else o[key] = v;
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

const SUPPORTED_CLAUDE = ["2.1.286", "2.1.288", "2.1.289", "2.1.291", "2.1.293"] as const;
const UNSUPPORTED_CLAUDE: readonly unknown[] = ["2.1.290", "2.0.1", "3.0.0", "2.1.293-beta", "garbage", "", 2, null, "2.1"];

interface ClaudeThread {
  sessionId: string;
  agentId: string | null;
  records: Obj[];
  clock: number;
  version: string;
  /** Records of the requests (all copies), by requestId, for replays. */
  byRequest: Map<string, Obj[]>;
}

function claudeBase(c: Ctx, th: ClaudeThread, type: string, ms: number): Obj {
  const k = c.k;
  const rec: Obj = { type };
  rec.uuid = nextId(c, "uuid");
  const last = th.records[th.records.length - 1];
  rec.parentUuid = last ? last.uuid : null;
  rec.sessionId = th.sessionId;
  const t = tsValue(c.r, k, ms);
  if (t !== undefined) rec.timestamp = t;
  rec.isSidechain = th.agentId !== null;
  const nonBool = c.r.chance(k.c_nonbool_flags);
  const nonBoolVal = c.r.pick<unknown>(["true", "false", 1, 0, null, "yes", {}]);
  const agentMain = c.r.chance(k.c_agent_main);
  if (nonBool) {
    used(c, "c_nonbool_flags");
    rec.isSidechain = nonBoolVal;
  }
  rec.version = th.version;
  rec.entrypoint = "cli";
  if (th.agentId !== null) rec.agentId = th.agentId;
  if (agentMain) {
    used(c, "c_agent_main");
    rec.agentId = "main";
  }
  return rec;
}

interface UsageSpec {
  i: number;
  r: number;
  w5: number;
  w1: number;
  o: number;
}

function drawUsage(c: Ctx): UsageSpec {
  const r = c.r;
  const big = r.chance(c.k.c_max_safe);
  const zero = r.chance(c.k.c_zero_usage);
  const cacheHeavy = r.chance(0.5);
  const rBig = r.int(0, 200000);
  const rSmall = r.int(0, 2000);
  const w5Has = r.chance(0.6);
  const w5Val = r.int(0, 20000);
  const w1Has = r.chance(0.2);
  const w1Val = r.int(0, 5000);
  const u: UsageSpec = { i: r.int(0, 60), r: cacheHeavy ? rBig : rSmall, w5: w5Has ? w5Val : 0, w1: w1Has ? w1Val : 0, o: r.int(1, 4000) };
  if (zero) return { i: 0, r: 0, w5: 0, w1: 0, o: 0 };
  const which = r.pick(["i", "r", "w5", "o"] as const);
  if (big) {
    used(c, "c_max_safe");
    // keep the cache_creation total (w5 + w1) at most MAX_SAFE: a valid counter, not a range failure
    u[which] = MAX_SAFE;
    if (which === "w5") u.w1 = 0;
  }
  return u;
}

function usageObject(spec: UsageSpec, wt: number, withCreation: boolean, out: number): Obj {
  const u: Obj = { input_tokens: spec.i, cache_creation_input_tokens: wt, cache_read_input_tokens: spec.r };
  if (withCreation) u.cache_creation = { ephemeral_5m_input_tokens: spec.w5, ephemeral_1h_input_tokens: spec.w1 };
  u.output_tokens = out;
  return u;
}

const COUNTER_PATHS: ReadonlyArray<readonly (string | number)[]> = [
  ["input_tokens"],
  ["cache_creation_input_tokens"],
  ["cache_read_input_tokens"],
  ["output_tokens"],
  ["cache_creation", "ephemeral_5m_input_tokens"],
  ["cache_creation", "ephemeral_1h_input_tokens"],
];

/** One request: its copies as records. */
function claudeRequest(c: Ctx, th: ClaudeThread, opts: { forceId?: string; tool?: { id: string; name: string } | null }): Obj[] {
  const r = c.r;
  const k = c.k;
  const requestId = opts.forceId ?? nextId(c, "req");
  const messageId = nextId(c, "msg");
  th.clock += r.chance(0.1) ? r.int(120, 900) * 1000 : r.int(1, 40) * 1000;
  const t0 = th.clock;
  c.eventMs.push(t0);

  // model
  const unknown = r.chance(k.c_unknown_model);
  const baseModel = unknown ? "claude-future-9" : r.pick(CLAUDE_MODELS);
  if (unknown) used(c, "c_unknown_model");
  const model = modelValue(r, k, baseModel);

  const spec = drawUsage(c);
  const nCopies = r.chance(k.c_multi_copy) ? r.pick([2, 2, 3, 4]) : 1;
  const noFinal = r.chance(k.c_no_final);
  const multiFinal = r.chance(k.c_multi_final) && nCopies >= 2;
  const noCreation = r.chance(k.c_no_cache_creation);
  const mismatch = r.chance(k.c_bucket_mismatch);
  const partialCreation = r.chance(k.c_partial_cache_creation);
  const iterations = r.chance(k.c_iterations);
  const thinking = r.chance(k.c_thinking);
  const iterNonArray = r.chance(k.c_iterations_nonarray);
  const iterPick = r.f();
  const apiNonBool = r.chance(k.c_nonbool_flags);
  const apiNonBoolVal = r.pick<unknown>(["true", "false", 1, 0, null, "yes", {}]);
  const fast = r.chance(k.c_fast_geo_tier);
  const oddMod = r.chance(k.c_modifier_odd);
  const modPick = [r.f(), r.f(), r.f()];
  const apiError = r.chance(k.c_api_error);
  const noUsageIdx = r.chance(k.c_no_usage_copy) ? r.int(0, nCopies - 1) : -1;
  const zeroIdx = r.chance(k.c_zero_copy) ? r.int(0, nCopies - 1) : -1;
  const dIn = r.chance(k.c_disagree_input);
  const dOut = r.chance(k.c_disagree_output);
  const dModel = r.chance(k.c_disagree_model);
  const dMsg = r.chance(k.c_disagree_msgid);
  const dMod = r.chance(k.c_disagree_modifier);
  const itMismatch = r.chance(k.c_iterations_mismatch);
  const missReq = r.chance(k.c_missing_request_id);
  const missSess = r.chance(k.c_missing_session_id);
  const badVersion = r.chance(k.c_unsupported_version);
  const badVersionWhole = r.chance(0.5);
  const badVersionPick = r.f();
  const subms = r.chance(k.ts_submillis);
  const badCounterCopies: Array<{ idx: number; pickv: number }> = [];
  for (let i = 0; i < nCopies; i++) {
    const hit = r.chance(k.counter_bad);
    const pv = r.f();
    if (hit) badCounterCopies.push({ idx: i, pickv: pv });
  }
  const usageBadIdx = r.chance(k.counter_bad * 0.15) ? r.int(0, nCopies - 1) : -1;
  const usageBadVal = r.pick<unknown>(["x", 5, [], null, true]);
  const wt = mismatch ? spec.w5 + spec.w1 + r.int(1, 50) : spec.w5 + spec.w1;
  if (mismatch) used(c, "c_bucket_mismatch");

  // modifiers of the final copy
  const speed: unknown = oddMod && modPick[0]! < 0.2 ? "turbo" : fast && modPick[0]! < 0.5 ? "fast" : "standard";
  let geo: unknown = fast && modPick[1]! < 0.5 ? "us" : "not_available";
  let tier: unknown = fast && modPick[2]! < 0.4 ? (modPick[2]! < 0.2 ? "priority" : "batch") : "standard";
  if (oddMod) {
    if (modPick[1]! < 0.3) geo = modPick[1]! < 0.15 ? undefined : "eu";
    if (modPick[2]! > 0.7) tier = modPick[2]! > 0.85 ? undefined : "flex";
  }

  const copies: Obj[] = [];
  for (let i = 0; i < nCopies; i++) {
    const isFinalIdx = !noFinal && (i === nCopies - 1 || (multiFinal && i === nCopies - 2));
    const out = isFinalIdx ? spec.o : Math.max(0, Math.min(spec.o - 1, 1 + i * 2));
    const useCreation = !noCreation;
    const usage = usageObject(spec, wt, useCreation, out);
    if (useCreation && partialCreation && i === 0) {
      if (modPick[0]! > 0.8) usage.cache_creation = modPick[1]! < 0.5 ? 5 : modPick[1]! < 0.8 ? null : "x"; // present but not an object
      else delete (usage.cache_creation as Obj).ephemeral_1h_input_tokens;
    }
    if (geo !== undefined) usage.inference_geo = geo;
    if (tier !== undefined) usage.service_tier = tier;
    if (isFinalIdx) {
      usage.speed = speed;
      if (iterations) {
        const it: Obj = {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
        };
        if (itMismatch) it.input_tokens = (it.input_tokens as number) + 1;
        usage.iterations = [it];
      }
      if (thinking) usage.output_tokens_details = { thinking_tokens: Math.min(out, r.int(0, 100)) };
      if (iterNonArray) {
        used(c, "c_iterations_nonarray");
        const one = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
        const odd: unknown[] = [one, "x", 5, null, [], [5], [null], [one, one], { 0: one }];
        usage.iterations = odd[Math.floor(iterPick * odd.length)];
      }
    }
    copies.push(usage);
  }
  if (itMismatch && iterations) used(c, "c_iterations_mismatch");
  // disagreements
  if (dIn && nCopies >= 2) {
    used(c, "c_disagree_input");
    const j = r.int(0, nCopies - 1);
    const which = r.pick(["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const);
    copies[j]![which] = (copies[j]![which] as number) + 1;
  }
  if (dOut && nCopies >= 2) {
    used(c, "c_disagree_output");
    // two final copies that disagree on output (or one final that disagrees with the partial pattern)
    const a = copies[nCopies - 1]!;
    const b = copies[nCopies - 2]!;
    if (b.speed === undefined) b.speed = a.speed ?? "standard";
    b.output_tokens = (a.output_tokens as number) + r.int(1, 9);
  }
  if (dMod && nCopies >= 2) {
    used(c, "c_disagree_modifier");
    const j = r.int(0, nCopies - 2);
    const which = r.pick(["inference_geo", "service_tier", "speed"] as const);
    const cur = copies[j]![which];
    copies[j]![which] = which === "inference_geo" ? (cur === "us" ? "not_available" : "us") : which === "service_tier" ? (cur === "standard" ? "priority" : "standard") : cur === "fast" ? "standard" : "fast";
  }
  if (zeroIdx >= 0) {
    used(c, "c_zero_copy");
    const z = copies[zeroIdx]!;
    z.input_tokens = 0;
    z.cache_read_input_tokens = 0;
    z.cache_creation_input_tokens = 0;
    z.output_tokens = 0;
    if (z.cache_creation) z.cache_creation = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 };
  }
  for (const b of badCounterCopies) {
    used(c, "counter_bad");
    const copy = copies[b.idx]!;
    const paths: Array<readonly (string | number)[]> = [...COUNTER_PATHS];
    if (copy.iterations) for (const f of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) paths.push(["iterations", 0, f]);
    if (copy.output_tokens_details) paths.push(["output_tokens_details", "thinking_tokens"]);
    const path = paths[Math.floor(b.pickv * paths.length) % paths.length]!;
    let o: Obj = copy;
    for (let d = 0; d < path.length - 1; d++) {
      const nxt = o[path[d]!];
      if (nxt === undefined || nxt === null || typeof nxt !== "object") {
        o = {};
        break;
      }
      o = nxt as Obj;
    }
    const last = path[path.length - 1]!;
    const cur = typeof o[last] === "number" ? (o[last] as number) : 0;
    const choices = [undefined, null, String(cur), "5", 1.5, cur + 0.5, -1, S_NEG0, MAX_SAFE, MAX_SAFE + 1, 1e300, S_BIG, S_FRAC0, S_EXP, true, {}, []] as unknown[];
    setOrDelete(o, String(last), choices[Math.floor((b.pickv * 997) % 1 * choices.length)]);
  }

  // records
  const out: Obj[] = [];
  const multiBlockCount = nCopies;
  for (let i = 0; i < nCopies; i++) {
    const rec = claudeBase(c, th, "assistant", t0 + i * 5);
    if (subms && nCopies > 1 && rec.timestamp !== undefined) {
      // same millisecond, different sub-millisecond digits
      used(c, "ts_submillis");
      rec.timestamp = fmtInstant(t0, 9, 0, String(100000 + i * 111111).slice(0, 6));
    }
    if (!missReq || (i > 0 && r.chance(0.5))) rec.requestId = idValue(c, requestId);
    else {
      used(c, "c_missing_request_id");
    }
    if (rec.requestId === undefined) delete rec.requestId;
    if (missSess && i === multiBlockCount - 1) {
      used(c, "c_missing_session_id");
      delete rec.sessionId;
    }
    if (badVersion && (badVersionWhole || i === nCopies - 1)) {
      used(c, "c_unsupported_version");
      rec.version = UNSUPPORTED_CLAUDE[Math.floor(badVersionPick * UNSUPPORTED_CLAUDE.length)];
    }
    let block: Obj = { type: "text", text: "synthetic-assistant-text" };
    if (i === nCopies - 1 && opts.tool) block = { type: "tool_use", id: opts.tool.id, name: opts.tool.name, input: {} };
    else if (i === 0 && nCopies > 1 && r.chance(0.3)) block = { type: "thinking", thinking: "synthetic-thinking" };
    const isFinalIdx = copies[i]!.speed !== undefined;
    const msg: Obj = {
      id: dMsg && i === 0 && nCopies >= 2 ? nextId(c, "msg") : messageId,
      type: "message",
      role: "assistant",
      model: apiError ? "<synthetic>" : dModel && i === 0 && nCopies >= 2 ? modelValue(r, k, r.pick(CLAUDE_MODELS)) : model,
      content: [block],
      stop_reason: isFinalIdx ? (block.type === "tool_use" ? "tool_use" : "end_turn") : null,
    };
    if (dMsg && i === 0 && nCopies >= 2) used(c, "c_disagree_msgid");
    if (dModel && i === 0 && nCopies >= 2) used(c, "c_disagree_model");
    if (i !== noUsageIdx) msg.usage = i === usageBadIdx ? usageBadVal : copies[i];
    else used(c, "c_no_usage_copy");
    rec.message = msg;
    if (apiError) {
      used(c, "c_api_error");
      rec.isApiErrorMessage = true;
      if (r.chance(0.5)) delete msg.usage;
    }
    if (apiNonBool) {
      used(c, "c_nonbool_flags");
      rec.isApiErrorMessage = apiNonBoolVal;
    }
    out.push(rec);
  }
  const strayHit = r.chance(k.c_stray_copy);
  const strayVariant = r.int(0, 3);
  const strayFrom = r.int(0, out.length - 1);
  const strayModel = modelValue(r, k, r.pick(CLAUDE_MODELS));
  if (strayHit) {
    used(c, "c_stray_copy");
    const src = out[strayFrom]!;
    const extra: Obj = structuredClone(src);
    extra.uuid = nextId(c, "uuid");
    delete extra.sessionId;
    if (strayVariant === 1) delete extra.timestamp;
    else if (strayVariant === 2 && extra.message?.usage && typeof extra.message.usage.input_tokens === "number") extra.message.usage.input_tokens += 1;
    else if (strayVariant === 3 && extra.message) extra.message.model = strayModel;
    out.push(extra);
  }
  for (const rec of out) th.records.push(rec);
  th.byRequest.set(requestId, out);
  return out;
}

function claudeOther(c: Ctx, th: ClaudeThread): void {
  const r = c.r;
  th.clock += r.int(1, 5) * 1000;
  const type = r.pick(["user", "system", "attachment", "user", "mystery"] as const);
  const rec = claudeBase(c, th, type, th.clock);
  if (r.chance(c.k.c_missing_session_id)) {
    used(c, "c_missing_session_id");
    delete rec.sessionId;
  }
  if (type === "user") rec.message = { role: "user", content: [{ type: "text", text: "synthetic-user-text" }] };
  else if (type === "system") {
    rec.subtype = "informational";
    rec.content = "synthetic-system";
  } else if (type === "attachment") rec.attachment = { type: "synthetic-attachment" };
  th.records.push(rec);
  const ofHit = r.chance(c.k.c_other_fields);
  const ofVariants = [r.int(0, 3), r.int(0, 3)];
  if (ofHit && type !== "mystery") {
    used(c, "c_other_fields");
    for (const v of ofVariants) {
      const d: Obj = structuredClone(rec);
      if (v === 0) d.advisorModel = r.pick(CLAUDE_MODELS);
      else if (v === 1) d.serverClassifierRequest = r.pick<unknown>([true, false, {}, "x"]);
      else if (v === 2) d.message = { role: "user", content: [{ type: "tool_result", tool_use_id: "synthetic-toolu-a" }] };
      else d.message = { role: "user", content: [{ type: "tool_use", id: "synthetic-toolu-b", name: "Agent" }] };
      th.records.push(d);
    }
  }
  // unlisted-type records that are duplicates except for parentUuid, logicalParentUuid or version
  const dupHit = r.chance(c.k.c_mystery_dups);
  const dupVariant = r.int(0, 2);
  const dupCount = r.int(1, 2);
  if (dupHit) {
    used(c, "c_mystery_dups");
    const base: Obj = { type: "mystery", uuid: nextId(c, "uuid"), parentUuid: "synthetic-parent-a", logicalParentUuid: "synthetic-logical-a", sessionId: th.sessionId, timestamp: new Date(th.clock).toISOString(), version: th.version };
    th.records.push(base);
    for (let i = 0; i < dupCount; i++) {
      const d: Obj = { ...base };
      if (dupVariant === 0) d.parentUuid = `synthetic-parent-${i}`;
      else if (dupVariant === 1) d.logicalParentUuid = `synthetic-logical-${i}`;
      else d.version = i === 0 ? "2.1.288" : "9.9.9";
      th.records.push(d);
    }
  }
}

interface ClaudeAgentFile {
  agentId: string;
  thread: ClaudeThread;
  meta: Obj | null;
  metaRaw?: string;
  workflowRun: string | null;
}

interface ClaudeSessionOut {
  proj: string;
  sessionId: string;
  main: ClaudeThread;
  agents: ClaudeAgentFile[];
  runs: Array<{ runId: string; json: string | null; journal: string | null }>;
}

const RANGE_BAD: readonly unknown[] = [-1, 1.5, MAX_SAFE + 1, 1e300, "5", null, S_BIG];

/** cost-state record (R17.5): modelUsage members, some out of range with c_cost_range. Constant draws. */
function claudeCostState(c: Ctx, th: ClaudeThread): void {
  const r = c.r;
  const has = r.chance(c.k.c_cost_state);
  const bad = r.chance(c.k.c_cost_range);
  const full = r.chance(c.k.c_cost_full);
  const dupKey = r.chance(c.k.c_cost_dupkey);
  const alias = r.chance(c.k.c_cost_alias);
  const badPick = r.f();
  const badSlot = r.int(0, 4);
  const nModels = r.int(1, 2);
  const names = full ? ["inputTokens", "outputTokens", "thinkingTokens", "cacheReadInputTokens", "cacheCreationInputTokens"] : ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"];
  const body: Obj = {};
  for (let i = 0; i < nModels; i++) {
    const m = r.pick(CLAUDE_MODELS);
    const u: Obj = {};
    for (const n of names) u[n] = r.int(0, 50000);
    const web = r.int(0, 5);
    const usd = Math.round(r.f() * 100000) / 10000;
    if (full) {
      u.webSearchRequests = web;
      u.costUSD = usd;
    }
    if (bad && i === 0) {
      used(c, "c_cost_range");
      u[names[badSlot % names.length]!] = RANGE_BAD[Math.floor(badPick * RANGE_BAD.length)];
    }
    body[m] = u;
    if (dupKey && i === 0) {
      used(c, "c_cost_dupkey");
      body[`${m}-20251001`] = { ...u, inputTokens: typeof u.inputTokens === "number" ? u.inputTokens + 1 : 1 };
    }
  }
  const t = r.int(1, 30) * 1000;
  if (!has) return;
  used(c, "c_cost_state");
  th.clock += t;
  const rec = claudeBase(c, th, "cost-state", th.clock);
  rec.modelUsage = body;
  th.records.push(rec);
  if (alias) {
    used(c, "c_cost_alias");
    const rec2 = claudeBase(c, th, "cost-state", th.clock + 1000);
    rec2.costState = { modelUsage: structuredClone(body) };
    th.records.push(rec2);
  }
}

/** compact_boundary system record with preTokens and postTokens, some out of range with c_compact_range. */
function claudeCompact(c: Ctx, th: ClaudeThread): void {
  const r = c.r;
  const has = r.chance(c.k.c_compact);
  const bad = r.chance(c.k.c_compact_range);
  const badPick = r.f();
  const which = r.chance(0.5);
  const pre = r.int(1000, 200000);
  const post = r.int(100, 20000);
  const subBad = r.chance(c.k.c_compact_subtype);
  const subPick = r.int(0, 3);
  const t = r.int(1, 30) * 1000;
  if (!has) return;
  used(c, "c_compact");
  th.clock += t;
  const last = th.records[th.records.length - 1];
  const rec = claudeBase(c, th, "system", th.clock);
  rec.subtype = "compact_boundary";
  rec.parentUuid = null;
  rec.logicalParentUuid = last ? last.uuid : null;
  rec.content = "synthetic-compact";
  const meta: Obj = { trigger: "auto", preTokens: pre, postTokens: post };
  if (bad) {
    used(c, "c_compact_range");
    meta[which ? "preTokens" : "postTokens"] = RANGE_BAD[Math.floor(badPick * RANGE_BAD.length)];
  }
  if (subBad) {
    used(c, "c_compact_subtype");
    meta.preTokens = RANGE_BAD[Math.floor(badPick * RANGE_BAD.length)];
    if (subPick === 0) rec.subtype = "other";
    else if (subPick === 1) delete rec.subtype;
    else if (subPick === 2) rec.subtype = 5;
    else rec.subtype = null;
  }
  rec.compactMetadata = meta;
  th.records.push(rec);
}

function newThread(c: Ctx, sessionId: string, agentId: string | null, startMs: number, version: string): ClaudeThread {
  return { sessionId, agentId, records: [], clock: startMs, version, byRequest: new Map() };
}

function genClaudeSession(c: Ctx, idx: number): ClaudeSessionOut {
  const r = c.r;
  const k = c.k;
  const sessionId = nextId(c, "session");
  const proj = `synthetic-project-${r.int(1, 2)}`;
  const version = r.pick(SUPPORTED_CLAUDE);
  const start = c.baseMs + idx * r.int(1, 20) * 60000 + r.int(0, 600) * 1000;
  const main = newThread(c, sessionId, null, start, version);
  const out: ClaudeSessionOut = { proj, sessionId, main, agents: [], runs: [] };

  const nReq = r.int(1, 5);
  const wantAgent = r.chance(k.c_subagent) ? r.int(1, 2) : 0;
  const agentToolIds: string[] = [];
  for (let a = 0; a < wantAgent; a++) agentToolIds.push(nextId(c, "toolu"));
  const agentSlots = new Set<number>();
  for (let a = 0; a < wantAgent; a++) agentSlots.add(r.int(0, nReq - 1));
  let nextTool = 0;
  if (r.chance(k.c_other_records)) claudeOther(c, main);
  for (let q = 0; q < nReq; q++) {
    let tool: { id: string; name: string } | null = null;
    if (agentSlots.has(q) && nextTool < agentToolIds.length) tool = { id: agentToolIds[nextTool++]!, name: "Agent" };
    claudeRequest(c, main, { tool });
    if (r.chance(k.c_other_records)) claudeOther(c, main);
  }
  while (nextTool < agentToolIds.length) nextTool++;
  claudeCostState(c, main);
  claudeCompact(c, main);
  // subagents
  for (let a = 0; a < wantAgent; a++) {
    const agentId = nextId(c, "agent");
    const th = newThread(c, sessionId, agentId, main.clock + r.int(1, 30) * 1000, version);
    const n = r.int(1, 3);
    for (let q = 0; q < n; q++) claudeRequest(c, th, {});
    const meta: Obj = { toolUseId: agentToolIds[a], agentType: "general-purpose", model: "haiku", description: "synthetic-description" };
    const f: ClaudeAgentFile = { agentId, thread: th, meta, workflowRun: null };
    if (r.chance(k.c_bad_sidecar)) {
      used(c, "c_bad_sidecar");
      f.metaRaw = r.pick(["{", "[]", "null", '{"toolUseId":5,"spawnDepth":"x"}', ""]);
    }
    out.agents.push(f);
  }
  // workflow agents
  if (r.chance(k.c_workflow)) {
    used(c, "c_workflow");
    const runId = nextId(c, "run");
    const n = r.int(1, 2);
    const journal: Obj[] = [];
    for (let a = 0; a < n; a++) {
      const agentId = nextId(c, "agent");
      const th = newThread(c, sessionId, agentId, main.clock + r.int(1, 60) * 1000, version);
      const nr = r.int(1, 3);
      for (let q = 0; q < nr; q++) claudeRequest(c, th, {});
      const f: ClaudeAgentFile = { agentId, thread: th, meta: r.chance(0.7) ? { agentType: "general-purpose", description: "synthetic-description" } : null, workflowRun: runId };
      out.agents.push(f);
      journal.push({ type: "agent_started", agentId, key: "synthetic-key", label: "synthetic-label", result: "synthetic-result" });
    }
    if (r.chance(k.c_journal_dups)) {
      used(c, "c_journal_dups");
      const first = journal[0];
      if (first) {
        journal.push({ ...first });
        journal.push({ ...first, type: "agent_finished" });
        journal.push({ ...first, type: "mystery" });
      }
    }
    let json: string | null = JSON.stringify({ runId, status: "completed", label: "synthetic-label" }) + "\n";
    let jl: string | null = journal.map((j) => JSON.stringify(j)).join("\n") + "\n";
    if (r.chance(k.c_bad_sidecar)) {
      used(c, "c_bad_sidecar");
      json = r.pick(["{", '{"runId":5}', "[]", null]);
      if (r.chance(0.5)) jl = r.pick(["not json\n", '{"type":', null]);
    }
    out.runs.push({ runId, json, journal: jl });
  }
  return out;
}

function replayClaude(c: Ctx, sessions: ClaudeSessionOut[]): void {
  const r = c.r;
  if (sessions.length < 2) return;
  const aIdx = r.int(0, sessions.length - 1);
  let bIdx = r.int(0, sessions.length - 1);
  if (bIdx === aIdx) bIdx = (aIdx + 1) % sessions.length;
  const a = sessions[aIdx]!;
  const b = sessions[bIdx]!;
  const keys = [...a.main.byRequest.keys()];
  if (keys.length === 0) return;
  used(c, "c_replay");
  const nTake = r.int(1, keys.length);
  const mutate = r.chance(c.k.c_replay_differ);
  const atEnd = r.chance(0.5);
  const copies: Obj[] = [];
  for (let i = 0; i < nTake; i++) {
    const recs = a.main.byRequest.get(keys[i]!) ?? [];
    for (const rec of recs) {
      const cl = structuredClone(rec);
      cl.sessionId = b.sessionId;
      if (mutate && cl.message?.usage && typeof cl.message.usage.input_tokens === "number") cl.message.usage.input_tokens += 1;
      copies.push(cl);
    }
  }
  if (atEnd) b.main.records.push(...copies);
  else b.main.records.splice(0, 0, ...copies);
}

function claudeFiles(c: Ctx, sessions: readonly ClaudeSessionOut[]): void {
  const r = c.r;
  const k = c.k;
  const text = (recs: Obj[]): { text: string; garbage: boolean } => {
    const lines = recs.map(jsonLine);
    let garbage = false;
    if (r.chance(k.c_garbage_line)) {
      used(c, "c_garbage_line");
      garbage = true;
      lines.splice(r.int(0, lines.length), 0, r.pick(["not json at all", '{"type":"assistant","message":', "}{", "\u0000"]));
    }
    blankLines(c, lines);
    nonObjectLines(c, lines);
    let body = lines.join("\n") + "\n";
    if (r.chance(k.c_truncated_tail)) {
      used(c, "c_truncated_tail");
      garbage = true;
      body += '{"type":"user","message":{"content":"synthetic-trunc';
    }
    return { text: ioVariant(c, body), garbage };
  };
  const mtime = (garbage: boolean): number => {
    if (garbage && r.chance(k.c_live_mtime)) {
      used(c, "c_live_mtime");
      return r.chance(0.2) ? RUN_START_MS + 3_600_000 : RECENT_MTIME_MS;
    }
    return OLD_MTIME_MS;
  };
  for (const s of sessions) {
    const base = `projects/${s.proj}/${s.sessionId}`;
    const t = text(s.main.records);
    c.files.push({ path: `projects/${s.proj}/${s.sessionId}.jsonl`, content: t.text, mtimeMs: mtime(t.garbage) });
    for (const a of s.agents) {
      const dir = a.workflowRun ? `${base}/subagents/workflows/wf_${a.workflowRun}` : `${base}/subagents`;
      const ta = text(a.thread.records);
      c.files.push({ path: `${dir}/agent-${a.agentId}.jsonl`, content: ta.text, mtimeMs: mtime(ta.garbage) });
      if (a.metaRaw !== undefined) c.files.push({ path: `${dir}/agent-${a.agentId}.meta.json`, content: a.metaRaw, mtimeMs: OLD_MTIME_MS });
      else if (a.meta) c.files.push({ path: `${dir}/agent-${a.agentId}.meta.json`, content: JSON.stringify(a.meta) + "\n", mtimeMs: OLD_MTIME_MS });
    }
    for (const run of s.runs) {
      if (run.json !== null) c.files.push({ path: `${base}/workflows/wf_${run.runId}.json`, content: run.json, mtimeMs: OLD_MTIME_MS });
      if (run.journal !== null) c.files.push({ path: `${base}/subagents/workflows/wf_${run.runId}/journal.jsonl`, content: run.journal, mtimeMs: OLD_MTIME_MS });
    }
  }
  strayClaudeSidecars(c, sessions);
  badClaudeLayouts(c, sessions);
  dualAgentFiles(c, sessions);
}

/** Sidecars in places no reader looks at. Constant draws. */
function strayClaudeSidecars(c: Ctx, sessions: readonly ClaudeSessionOut[]): void {
  const r = c.r;
  const hit = c.r.chance(c.k.c_stray_sidecar);
  const pick = r.int(0, 5);
  const s = sessions[r.int(0, sessions.length - 1)];
  if (!hit || !s) return;
  used(c, "c_stray_sidecar");
  const base = `projects/${s.proj}/${s.sessionId}`;
  const nl = "\n";
  const meta = JSON.stringify({ toolUseId: "synthetic-toolu-stray", agentType: "general-purpose" }) + nl;
  const run = JSON.stringify({ runId: "stray", status: "completed" }) + nl;
  const row = JSON.stringify({ type: "agent_started", agentId: "synthetic-agent-stray" }) + nl;
  const files: Array<[string, string]> = [
    [`projects/${s.proj}/agent-synthetic-agent-stray.meta.json`, meta],
    [`${base}/subagents/extra/agent-synthetic-agent-stray.meta.json`, meta],
    [`${base}/workflows/wf_stray/wf_stray.json`, run],
    [`${base}/journal.jsonl`, row],
    [`${base}/subagents/agent-synthetic-agent-stray.prefix.json`, JSON.stringify({ state: { model: "claude-opus-5-5" } }) + nl],
    [`${base}/subagents/workflows/journal.jsonl`, row],
  ];
  const [path, content] = files[pick]!;
  c.files.push({ path, content, mtimeMs: OLD_MTIME_MS });
}

/** Claude files at wrong layouts. Constant draws. */
function badClaudeLayouts(c: Ctx, sessions: readonly ClaudeSessionOut[]): void {
  const r = c.r;
  const hit = r.chance(c.k.c_bad_layout);
  const picks = [r.int(0, 5), r.int(0, 5)];
  const s = sessions[r.int(0, sessions.length - 1)];
  const sub = r.sub();
  if (!hit || !s) return;
  used(c, "c_bad_layout");
  const base = `projects/${s.proj}/${s.sessionId}`;
  const th = newThread(c, s.sessionId, "synthetic-agent-layout", s.main.clock + 5000, s.main.version);
  claudeRequest({ ...c, r: sub }, th, {});
  const body = th.records.map(jsonLine).join("\n") + "\n";
  const broken = `{"type":"agent_started","agentId":"synthetic-agent-layout"}\nnot json\n{"type":`;
  const variants: Array<[string, string]> = [
    [`projects/${s.proj}/subagents/agent-synthetic-agent-layout.jsonl`, body],
    [`${base}/x/subagents/agent-synthetic-agent-layout.jsonl`, body],
    [`${base}/subagents/workflows/wf_deep/deeper/agent-synthetic-agent-layout.jsonl`, body],
    [`projects/${s.proj}/.jsonl`, body],
    [`${base}/x/subagents/agent-synthetic-agent-layout.meta.json`, broken],
    [`${base}/x/subagents/workflows/wf_deep/journal.jsonl`, broken],
  ];
  for (const pk of new Set(picks)) {
    const [path, content] = variants[pk]!;
    c.files.push({ path, content, mtimeMs: OLD_MTIME_MS });
  }
}

/** The same agent chain in subagents/ and in subagents/workflows/wf_dual/, the second file holding one odd record. */
function dualAgentFiles(c: Ctx, sessions: readonly ClaudeSessionOut[]): void {
  const r = c.r;
  const hit = r.chance(c.k.c_dual_agent);
  const kind = r.int(0, 2);
  const sub = r.sub();
  const s = sessions.find((x) => x.agents.some((a) => a.workflowRun === null));
  if (!hit || !s) return;
  const a = s.agents.find((x) => x.workflowRun === null)!;
  used(c, "c_dual_agent");
  const th = newThread(c, s.sessionId, a.agentId, a.thread.clock + 3000, kind === 2 ? "2.0.1" : s.main.version);
  let recs: Obj[];
  if (kind === 0) {
    const rec = claudeBase({ ...c, r: sub }, th, "mystery", th.clock);
    recs = [rec];
  } else if (kind === 1) {
    const rec = claudeBase({ ...c, r: sub }, th, "cost-state", th.clock);
    rec.modelUsage = { "claude-opus-5-5": { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } };
    recs = [rec];
  } else {
    claudeRequest({ ...c, r: sub }, th, {});
    recs = th.records;
  }
  c.files.push({ path: `projects/${s.proj}/${s.sessionId}/subagents/workflows/wf_dual/agent-${a.agentId}.jsonl`, content: recs.map(jsonLine).join("\n") + "\n", mtimeMs: OLD_MTIME_MS });
}

/** Early records of other types (unlisted, cost-state, user, system, unsupported versions) in one Claude stream. */
function earlyClaudeRecords(c: Ctx, sessions: ClaudeSessionOut[]): void {
  const r = c.r;
  const hit = r.chance(c.k.c_early_records);
  const target = r.int(0, sessions.length - 1);
  const n = r.int(1, 3);
  const lead = r.int(60, 3600) * 1000;
  const kinds = [r.int(0, 4), r.int(0, 4), r.int(0, 4)];
  const unsup = r.chance(0.5);
  const doReplay = r.chance(0.7);
  const sub = r.sub();
  const s = sessions[target];
  if (!hit || !s) return;
  used(c, "c_early_records");
  const sc: Ctx = { ...c, r: sub };
  let first = c.baseMs;
  const stamps = s.main.records.map((x) => (typeof x.timestamp === "string" ? Date.parse(x.timestamp) : Number.NaN)).filter((x) => Number.isFinite(x) && x > Date.UTC(2025, 0, 1) && x < Date.UTC(2030, 0, 1)); // ignore mutated timestamps such as year 0000
  if (stamps.length > 0) first = Math.min(...stamps);
  const th = newThread(sc, s.sessionId, null, first - lead, unsup ? "2.0.1" : s.main.version);
  for (const kd of kinds.slice(0, n)) {
    th.clock += 1000;
    if (kd === 4) {
      claudeRequest(sc, th, {});
      continue;
    }
    const type = ["mystery", "cost-state", "user", "system"][kd]!;
    const rec = claudeBase(sc, th, type, th.clock);
    if (type === "cost-state") rec.modelUsage = { "claude-opus-5-5": { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } };
    else if (type === "user") rec.message = { role: "user", content: [{ type: "text", text: "synthetic-user-text" }] };
    else if (type === "system") rec.subtype = "informational";
    th.records.push(rec);
  }
  s.main.records.splice(0, 0, ...th.records);
  if (doReplay && sessions.length >= 2) replayClaude(sc, sessions);
}

/** Journal rows and log lines duplicated across two files. Constant draws. */
function crossFileDups(c: Ctx, provider: "claude" | "codex", from: number): void {
  const r = c.r;
  const hit = r.chance(c.k.c_cross_dups);
  const nLines = r.int(1, 4);
  const picks = [r.f(), r.f(), r.f(), r.f(), r.f(), r.f()];
  const journalHit = r.chance(0.5);
  if (!hit) return;
  used(c, "c_cross_dups");
  const logs = c.files.slice(from).filter((f) => typeof f.content === "string" && f.path.endsWith(".jsonl") && !f.path.endsWith("journal.jsonl"));
  if (logs.length >= 2) {
    const ai = Math.floor(picks[0]! * logs.length);
    const bi = (ai + 1 + Math.floor(picks[1]! * (logs.length - 1))) % logs.length;
    const a = logs[ai]!;
    const b = logs[bi]!;
    const aLines = String(a.content).split("\n").map((l) => l.replace(/^\ufeff/, "").replace(/\r$/, "")).filter((l) => l.trim() !== "");
    const bLines = String(b.content).split("\n");
    for (let i = 0; i < nLines && aLines.length > 0; i++) {
      const line = aLines[Math.floor(picks[2 + (i % 4)]! * aLines.length)]!;
      bLines.splice(1 + Math.floor(picks[(i + 3) % 6]! * Math.max(1, bLines.length - 1)), 0, line);
    }
    b.content = bLines.join("\n");
  }
  if (provider === "claude" && journalHit) {
    const main = c.files.slice(from).find((f) => /^projects\/[^/]+\/[^/]+\.jsonl$/.test(f.path));
    if (main) {
      const base = main.path.replace(/\.jsonl$/, "");
      const row = (type: string): string => JSON.stringify({ type, agentId: "synthetic-agent-xdup", key: "synthetic-key" });
      const nl = "\n";
      c.files.push({ path: `${base}/subagents/workflows/wf_xa/journal.jsonl`, content: [row("agent_started"), row("agent_started"), row("agent_finished")].join(nl) + nl, mtimeMs: OLD_MTIME_MS });
      c.files.push({ path: `${base}/subagents/workflows/wf_xb/journal.jsonl`, content: [row("agent_started"), row("mystery")].join(nl) + nl, mtimeMs: OLD_MTIME_MS });
    }
  }
}

/** One model with responses in a clean chain and in a tainted chain (a range-failed sibling request taints the chain). */
function modelSplitClaude(c: Ctx): void {
  const r = c.r;
  const hit = r.chance(c.k.c_model_split);
  const model = r.pick(CLAUDE_MODELS);
  const nClean = r.int(1, 2);
  const nTainted = r.int(1, 2);
  const sub = r.sub();
  if (!hit) return;
  used(c, "c_model_split");
  const sc: Ctx = { ...c, r: sub, k: { ...c.k, ...NO_MALFORMATION } as Knobs };
  const proj = "synthetic-project-split";
  const start = c.baseMs + r.int(0, 3600) * 1000;
  const make = (clean: boolean): void => {
    const sid = nextId(c, "session");
    const th = newThread(sc, sid, null, start, "2.1.293");
    const n = clean ? nClean : nTainted + 1;
    for (let i = 0; i < n; i++) {
      const recs = claudeRequest(sc, th, { tool: null });
      for (const rec of recs) {
        if (rec.message) rec.message.model = model;
        if (!clean && i === n - 1 && rec.message?.usage && typeof rec.message.usage === "object") rec.message.usage.input_tokens = 1.5; // range failure taints the chain
      }
    }
    c.files.push({ path: `projects/${proj}/${sid}.jsonl`, content: th.records.map(jsonLine).join("\n") + "\n", mtimeMs: OLD_MTIME_MS });
  };
  make(true);
  make(false);
}

function genClaude(c: Ctx): void {
  const r = c.r;
  const from = c.files.length;
  const n = r.int(1, 3);
  const sessions: ClaudeSessionOut[] = [];
  for (let i = 0; i < n; i++) sessions.push(genClaudeSession(c, i));
  if (r.chance(c.k.c_replay)) replayClaude(c, sessions);
  earlyClaudeRecords(c, sessions);
  claudeFiles(c, sessions);
  modelSplitClaude(c);
  crossFileDups(c, "claude", from);
  const linkHit = r.chance(c.k.io_broken_symlink);
  const linkPick = r.int(0, 1);
  if (linkHit) {
    used(c, "io_broken_symlink");
    c.links.push(linkPick === 0 ? "projects/synthetic-project-1/broken-link.jsonl" : "sessions/2026/01/01/rollout-2026-01-01T00-00-00-synthetic-thread-broken.jsonl");
  }
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

const SUPPORTED_CODEX = ["0.157.1", "0.158.0", "0.159.2", "0.160.0", "0.160.1"] as const;
const UNSUPPORTED_CODEX: readonly unknown[] = ["0.159.0", "0.154.0-alpha.6.2", "1.0.0", "garbage", "", 5, null];

interface CxLine {
  timestamp?: unknown;
  type: string;
  ordinal?: unknown;
  payload: Obj;
  /** Nominal instant, before mutation. */
  ms: number;
}

interface CxThread {
  id: string;
  sessionId: string;
  version: string;
  lines: CxLine[];
  clock: number;
  ordinal: number;
  turnId: string | null;
  model: string;
  total: { input: number; cached: number; cw: number; output: number; reasoning: number; total: number };
  respIds: string[];
  archived: boolean;
  /** Extra files (raw text) written beside the thread file. */
  extra: Array<{ name: string; text: string }>;
}

function cxPush(c: Ctx, th: CxThread, type: string, payload: Obj, dtMs?: number): CxLine {
  th.clock += dtMs ?? c.r.int(1, 30) * 1000;
  const line: CxLine = { type, ordinal: th.ordinal++, payload, ms: th.clock };
  th.lines.push(line);
  return line;
}

function cxMeta(c: Ctx, th: CxThread, o: { threadSource?: string | null; spawnParent?: string; depth?: number; forkedFrom?: string; histStart?: unknown; role?: string }): CxLine {
  const payload: Obj = {
    id: th.id,
    session_id: th.sessionId,
    timestamp: new Date(th.clock).toISOString(),
    cli_version: th.version,
    originator: "codex_cli",
    cwd: "synthetic-cwd",
    base_instructions: "synthetic-instructions",
  };
  if (o.spawnParent !== undefined) payload.source = { subagent: { thread_spawn: { parent_thread_id: o.spawnParent, depth: o.depth ?? 1 } } };
  else payload.source = "cli";
  if (o.threadSource !== undefined && o.threadSource !== null) payload.thread_source = o.threadSource;
  if (o.role !== undefined) payload.agent_role = o.role;
  if (o.forkedFrom !== undefined) payload.forked_from_id = o.forkedFrom;
  if (o.histStart !== undefined) payload.subagent_history_start_ordinal = o.histStart;
  return cxPush(c, th, "session_meta", payload, 1000);
}

function drawCodexUsage(c: Ctx): Obj {
  const r = c.r;
  const k = c.k;
  const long = r.chance(k.x_long_ctx);
  const cw = r.chance(k.x_cache_write);
  const inp = long ? r.int(272000 - 2, 272000 + 3000) : r.chance(0.5) ? r.int(100, 5000) : r.int(5000, 200000);
  const cached = r.int(0, inp);
  const cwv = cw ? r.int(0, inp - cached) : 0;
  const out = r.int(1, 3000);
  const rs = r.int(0, out);
  if (long) used(c, "x_long_ctx");
  return { input_tokens: inp, cached_input_tokens: cached, cache_write_input_tokens: cwv, output_tokens: out, reasoning_output_tokens: rs, total_tokens: inp + out };
}

const USAGE_FIELDS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"] as const;

function mutateCodexUsage(c: Ctx, u: Obj): void {
  const r = c.r;
  const k = c.k;
  // counter_bad
  const bad = r.chance(k.counter_bad);
  const f = r.pick(USAGE_FIELDS);
  const pv = r.f();
  if (bad) {
    used(c, "counter_bad");
    const cur = typeof u[f] === "number" ? (u[f] as number) : 0;
    const choices = [undefined, null, String(cur), "5", 1.5, cur + 0.5, -1, S_NEG0, MAX_SAFE, MAX_SAFE + 1, 1e300, S_BIG, S_FRAC0, S_EXP, true, {}, []] as unknown[];
    setOrDelete(u, f, choices[Math.floor(pv * choices.length)]);
  }
  // incomplete: input missing but cached valid
  if (r.chance(k.x_incomplete_usage)) {
    used(c, "x_incomplete_usage");
    const which = r.pick(["input_tokens", "output_tokens", "cached_input_tokens", "total_tokens"] as const);
    delete u[which];
  }
  // invariant violations
  const inv = r.chance(k.x_invariant);
  const kind = r.int(0, 2);
  if (inv) {
    used(c, "x_invariant");
    if (kind === 0 && typeof u.input_tokens === "number") u.cached_input_tokens = u.input_tokens + 1;
    else if (kind === 1 && typeof u.output_tokens === "number") u.reasoning_output_tokens = u.output_tokens + 1;
    else u.total_tokens = (typeof u.total_tokens === "number" ? u.total_tokens : 0) + 1;
  }
}

function cxUsageRecord(c: Ctx, th: CxThread): CxLine {
  const r = c.r;
  const k = c.k;
  const usage = drawCodexUsage(c);
  const respId = nextId(c, "resp");
  th.respIds.push(respId);
  th.total.input += usage.input_tokens;
  th.total.cached += usage.cached_input_tokens;
  th.total.cw += usage.cache_write_input_tokens;
  th.total.output += usage.output_tokens;
  th.total.reasoning += usage.reasoning_output_tokens;
  th.total.total += usage.total_tokens;
  const tt = th.total;
  const payload: Obj = {
    response_id: respId,
    thread_id: th.id,
    session_id: th.sessionId,
    turn_id: th.turnId ?? "synthetic-turn-none",
    usage,
    turn_token_usage: { ...usage },
    thread_token_usage: {
      input_tokens: tt.input,
      cached_input_tokens: tt.cached,
      cache_write_input_tokens: tt.cw,
      output_tokens: tt.output,
      reasoning_output_tokens: tt.reasoning,
      total_tokens: tt.total,
    },
  };
  const totalHit = r.chance(k.x_total_range);
  const totalPick = r.int(0, 3);
  if (totalHit) {
    used(c, "x_total_range");
    (payload.thread_token_usage as Obj).total_tokens = [-1, 1.5, MAX_SAFE + 1, "5"][totalPick];
  }
  const line = cxPush(c, th, "token_usage_record", payload);
  c.eventMs.push(line.ms);
  mutateCodexUsage(c, payload.usage as Obj);
  if (r.chance(k.counter_bad * 0.15)) {
    used(c, "counter_bad");
    payload.usage = r.pick<unknown>(["x", 5, [], null, true]);
  }
  if (r.chance(k.x_missing_response_id)) {
    used(c, "x_missing_response_id");
    if (r.chance(0.5)) delete payload.response_id;
    else payload.response_id = r.pick<unknown>([null, "", 7]);
  }
  if (r.chance(k.x_missing_thread_id)) {
    used(c, "x_missing_thread_id");
    if (r.chance(0.5)) delete payload.thread_id;
    else payload.thread_id = r.pick<unknown>([null, "", 7]);
  }
  if (r.chance(k.id_bad)) {
    used(c, "id_bad");
    payload.turn_id = r.pick<unknown>([undefined, null, "", 3]);
    if (payload.turn_id === undefined) delete payload.turn_id;
  }
  return line;
}

function genCodexTurns(c: Ctx, th: CxThread, baseModel: string): void {
  const r = c.r;
  const k = c.k;
  const nTurns = r.chance(k.x_multi_turn) ? r.int(2, 3) : 1;
  let model = baseModel;
  for (let t = 0; t < nTurns; t++) {
    th.turnId = nextId(c, "turn");
    if (t > 0 && r.chance(k.x_two_models)) model = r.pick(CODEX_MODELS);
    let mval: unknown = model;
    if (r.chance(k.x_unknown_model)) {
      mval = "codex-auto-review";
      used(c, "x_unknown_model");
    }
    mval = modelValue(r, k, String(mval));
    cxPush(c, th, "turn_context", {
      turn_id: th.turnId,
      root_turn_id: th.turnId,
      model: mval,
      effort: "medium",
      comp_hash: "synthetic-comp-hash",
      collaboration_mode: { mode: "default" },
      cwd: "synthetic-cwd",
    });
    if (r.chance(k.x_model_conflict)) {
      used(c, "x_model_conflict");
      cxPush(c, th, "turn_context", {
        turn_id: th.turnId,
        root_turn_id: th.turnId,
        model: r.pick(CODEX_MODELS),
        effort: "medium",
        comp_hash: "synthetic-comp-hash",
        collaboration_mode: { mode: "default" },
      });
    }
    if (r.chance(k.x_settings)) {
      used(c, "x_settings");
      cxPush(c, th, "event_msg", { type: "thread_settings_applied" });
    }
    cxPush(c, th, "response_item", { type: "message", role: "assistant", content: "synthetic-content" });
    const nResp = r.int(1, 3);
    for (let q = 0; q < nResp; q++) {
      cxUsageRecord(c, th);
      if (r.chance(k.x_token_count)) cxPush(c, th, "event_msg", { type: "token_count" });
      if (r.chance(k.x_settings * 0.5)) cxPush(c, th, "event_msg", { type: "thread_settings_applied" });
    }
    if (r.chance(k.x_compacted)) {
      used(c, "x_compacted");
      cxPush(c, th, "compacted", { compaction_response_id: nextId(c, "compaction"), window_id: nextId(c, "window"), window_number: 1, latest_token_usage_record: r.chance(0.5) ? null : { response_id: "synthetic-latest" }, message: "synthetic", replacement_history: [], retained_context: [] });
    }
  }
}

function newCx(c: Ctx, o: { id?: string; sessionId?: string; startMs: number; version?: string }): CxThread {
  const r = c.r;
  const id = o.id ?? nextId(c, "thread");
  const bad = r.chance(c.k.x_unsupported_version);
  const pickv = r.f();
  let version: string = o.version ?? r.pick(SUPPORTED_CODEX);
  let versionAny: unknown = version;
  if (bad) {
    used(c, "x_unsupported_version");
    versionAny = UNSUPPORTED_CODEX[Math.floor(pickv * UNSUPPORTED_CODEX.length)];
    version = versionAny as string;
  }
  return {
    id,
    sessionId: o.sessionId ?? id,
    version,
    lines: [],
    clock: o.startMs,
    ordinal: 0,
    turnId: null,
    model: r.pick(CODEX_MODELS),
    total: { input: 0, cached: 0, cw: 0, output: 0, reasoning: 0, total: 0 },
    respIds: [],
    archived: r.chance(c.k.x_archived),
    extra: [],
  };
}

function genCodex(c: Ctx): void {
  const r = c.r;
  const from = c.files.length;
  const k = c.k;
  const threads: CxThread[] = [];
  const nRoots = r.int(1, 2);
  for (let i = 0; i < nRoots; i++) {
    const start = c.baseMs + i * r.int(1, 15) * 60000 + r.int(0, 600) * 1000;
    const parent = newCx(c, { startMs: start });
    cxMeta(c, parent, { threadSource: r.pick(["user", "user", null]) });
    genCodexTurns(c, parent, parent.model);
    threads.push(parent);
    // fork
    if (r.chance(k.x_fork)) {
      used(c, "x_fork");
      const prefix = parent.lines.filter((l) => l.type !== "session_meta" && l.type !== "token_usage_record").slice(0, r.int(1, 4));
      const parentMeta = parent.lines.find((l) => l.type === "session_meta");
      const copied: CxLine[] = parentMeta ? [parentMeta, ...prefix] : prefix;
      let after = copied.length;
      for (const l of copied) if (typeof l.ordinal === "number" && l.ordinal + 1 > after) after = l.ordinal + 1;
      const child = newCx(c, { startMs: parent.clock + 1000, sessionId: parent.sessionId });
      child.ordinal = after;
      const ownFirst = r.chance(0.3);
      const hist = ownFirst ? after + 1 : after;
      let histVal: unknown = hist;
      if (r.chance(k.x_bad_fork)) {
        used(c, "x_bad_fork");
        histVal = r.pick<unknown>([undefined, "3", 1.5, -1, MAX_SAFE + 1, hist + 100, 0, null]);
      }
      const lines: CxLine[] = [];
      if (ownFirst) {
        const m = cxMeta(c, child, { threadSource: "user", forkedFrom: parent.id, histStart: histVal });
        if (histVal === undefined) delete m.payload.subagent_history_start_ordinal;
        lines.push(...child.lines.splice(0));
        for (const l of copied) lines.push(structuredClone(l));
      } else {
        for (const l of copied) lines.push(structuredClone(l));
        const m = cxMeta(c, child, { threadSource: "user", forkedFrom: parent.id, histStart: histVal });
        if (histVal === undefined) delete m.payload.subagent_history_start_ordinal;
        lines.push(...child.lines.splice(0));
      }
      child.lines = lines;
      genCodexTurns(c, child, r.chance(0.5) ? parent.model : r.pick(CODEX_MODELS));
      threads.push(child);
    } else {
      r.sub();
    }
    // spawn
    if (r.chance(k.x_spawn)) {
      used(c, "x_spawn");
      const sameSession = r.chance(0.5);
      const child = newCx(c, { startMs: parent.clock + 1000, sessionId: sameSession ? parent.sessionId : undefined });
      cxMeta(c, child, { threadSource: r.pick(["subagent", "agent_created_thread", null]), spawnParent: parent.id, depth: 1, role: "worker" });
      genCodexTurns(c, child, child.model);
      threads.push(child);
    } else {
      r.sub();
    }
    if (r.chance(k.x_automation)) {
      used(c, "x_automation");
      const child = newCx(c, { startMs: parent.clock + 1000 });
      cxMeta(c, child, { threadSource: r.pick(["automation", "guardian_review"]) });
      genCodexTurns(c, child, child.model);
      threads.push(child);
    } else {
      r.sub();
    }
  }
  mutateCodex(c, threads);
  codexFiles(c, threads);
  crossFileDups(c, "codex", from);
}

function mutateCodex(c: Ctx, threads: CxThread[]): void {
  const r = c.r;
  const k = c.k;
  // 1. line level mutations of envelope fields
  for (const th of threads) {
    for (let i = 0; i < th.lines.length; i++) {
      const l = th.lines[i]!;
      const tsv = tsValue(r, k, l.ms);
      if (tsv === undefined) delete l.timestamp;
      else l.timestamp = tsv;
      const mo = r.chance(k.x_missing_ordinal);
      const co = r.chance(k.x_collide_ordinal);
      const dt = r.chance(k.x_decreasing_ts);
      const odd = r.f();
      if (mo) {
        used(c, "x_missing_ordinal");
        if (odd < 0.7) delete l.ordinal;
        else l.ordinal = odd < 0.8 ? "7" : odd < 0.9 ? 1.5 : -1;
      }
      if (co && i > 0) {
        used(c, "x_collide_ordinal");
        l.ordinal = th.lines[i - 1]!.ordinal;
      }
      if (dt && i > 0) {
        used(c, "x_decreasing_ts");
        l.timestamp = new Date(th.lines[i - 1]!.ms - 60000).toISOString();
      }
    }
  }
  // 2. duplicates of a token_usage_record (after the mutation, so an equal copy is byte-identical)
  const extraByThread = new Map<CxThread, CxLine[]>();
  for (const th of threads) {
    const out: CxLine[] = [];
    for (const l of th.lines) {
      out.push(l);
      if (l.type !== "token_usage_record") {
        r.sub();
        r.sub();
        continue;
      }
      const eq = r.chance(k.x_dup_equal);
      const differ = r.chance(k.x_dup_differ);
      const sub = r.sub();
      if (eq) {
        used(c, "x_dup_equal");
        out.push(structuredClone(l));
      }
      if (differ) {
        used(c, "x_dup_differ");
        const d = structuredClone(l);
        const kind = sub.int(0, 6);
        const p = d.payload;
        if (kind === 0 && typeof p.usage?.output_tokens === "number") p.usage.output_tokens += 1;
        else if (kind === 1) p.turn_id = nextId(c, "turn");
        else if (kind === 2) {
          const t = typeof l.timestamp === "string" ? Date.parse(l.timestamp) : Number.NaN;
          d.timestamp = subMilli(sub, Number.isNaN(t) ? l.ms : t);
        } else if (kind === 3) d.ordinal = (typeof l.ordinal === "number" ? l.ordinal : 0) + 1000;
        else if (kind === 4) p.thread_id = threads[(threads.indexOf(th) + 1) % threads.length]!.id;
        else if (kind === 5) p.session_id = nextId(c, "session");
        else if (typeof p.usage?.input_tokens === "number") p.usage.input_tokens += 1;
        if (sub.chance(0.3) && threads.length > 1) {
          const other = threads[(threads.indexOf(th) + 1) % threads.length]!;
          const arr = extraByThread.get(other) ?? [];
          arr.push(d);
          extraByThread.set(other, arr);
        } else out.push(d);
      }
    }
    th.lines = out;
  }
  for (const [th, arr] of extraByThread) th.lines.push(...arr);
  // 3. unknown record type, stream conflicts
  for (const th of threads) {
    const metaTypes = r.chance(k.x_meta_types);
    const metaVariant = r.int(0, 3);
    const metaWrong = r.pick<unknown>([{}, 5, [], "x"]);
    if (metaTypes) {
      const first = th.lines.find((l) => l.type === "session_meta");
      if (first) {
        used(c, "x_meta_types");
        const p2: Obj = structuredClone(first.payload);
        if (metaVariant === 0) p2.forked_from_id = metaWrong;
        else if (metaVariant === 1) p2.session_id = metaWrong;
        else if (metaVariant === 2) {
          delete p2.id;
          p2.forked_from_id = th.id;
          p2.subagent_history_start_ordinal = 2;
        } else {
          p2.forked_from_id = metaWrong;
          p2.subagent_history_start_ordinal = metaWrong;
        }
        th.lines.push({ type: "session_meta", ordinal: th.ordinal++, timestamp: new Date(th.clock + 500).toISOString(), ms: th.clock + 500, payload: p2 });
      }
    }
    const dupMeta = r.chance(k.x_dup_meta);
    const dupMetaSrc = r.chance(0.5);
    if (dupMeta) {
      const first = th.lines.find((l) => l.type === "session_meta");
      if (first) {
        used(c, "x_dup_meta");
        const p2: Obj = structuredClone(first.payload);
        p2.thread_source = dupMetaSrc ? "automation" : "user";
        if (p2.thread_source === first.payload.thread_source) delete p2.thread_source;
        const dup: CxLine = { type: "session_meta", ordinal: first.ordinal, ms: first.ms, payload: p2 };
        th.lines.push(dup);
      }
    }
    if (r.chance(0.05)) th.lines.push({ type: "mystery", ordinal: th.ordinal++, timestamp: new Date(th.clock).toISOString(), payload: { model: "synthetic", cli_version: "synthetic" }, ms: th.clock });
    if (r.chance(k.x_stream_conflict)) {
      used(c, "x_stream_conflict");
      const other = threads[(threads.indexOf(th) + 1) % threads.length]!;
      if (other !== th) {
        th.lines.push({ type: "token_usage_record", ordinal: th.ordinal++, timestamp: new Date(th.clock + 1000).toISOString(), ms: th.clock + 1000, payload: { response_id: nextId(c, "resp"), thread_id: other.id, session_id: other.sessionId, turn_id: "synthetic-turn-x", usage: drawCodexUsage(c) } });
      } else {
        const m = th.lines.find((l) => l.type === "session_meta");
        if (m) th.lines.push({ type: "session_meta", ordinal: th.ordinal++, timestamp: new Date(th.clock + 1000).toISOString(), ms: th.clock + 1000, payload: { ...structuredClone(m.payload), session_id: nextId(c, "session") } });
      }
    }
  }
}

function codexFiles(c: Ctx, threads: CxThread[]): void {
  const r = c.r;
  const k = c.k;
  const toObj = (l: CxLine): Obj => {
    const o: Obj = {};
    if (l.timestamp !== undefined) o.timestamp = l.timestamp;
    o.type = l.type;
    if (l.ordinal !== undefined) o.ordinal = l.ordinal;
    o.payload = l.payload;
    return o;
  };
  for (const th of threads) {
    const lines = th.lines.map((l) => jsonLine(toObj(l)));
    let garbage = false;
    if (r.chance(k.x_garbage_line)) {
      used(c, "x_garbage_line");
      garbage = true;
      lines.splice(r.int(0, lines.length), 0, r.pick(["not json at all", '{"type":"token_usage_record","payload":', "}{"]));
    }
    blankLines(c, lines);
    nonObjectLines(c, lines);
    let splits: number[] = [];
    if (r.chance(k.x_split_file) && lines.length > 2) {
      used(c, "x_split_file");
      splits = [r.int(1, lines.length - 1)];
    }
    const cuts = [0, ...splits, lines.length];
    for (let i = 0; i < cuts.length - 1; i++) {
      const part = cuts.length > 2 ? `-part${i + 1}` : "";
      const name = `rollout-2026-01-01T00-00-00-${th.id}${part}.jsonl`;
      const body = ioVariant(c, lines.slice(cuts[i]!, cuts[i + 1]!).join("\n") + "\n");
      const live = garbage && r.chance(k.c_live_mtime);
      const mt = live ? RECENT_MTIME_MS : OLD_MTIME_MS;
      c.files.push({ path: `${th.archived ? "archived_sessions" : "sessions/2026/01/01"}/${name}`, content: body, mtimeMs: mt });
    }
    if (r.chance(k.x_token_count_only)) {
      used(c, "x_token_count_only");
      const lead = { timestamp: new Date(th.clock + 1000).toISOString(), type: "session_meta", ordinal: 0, payload: { id: th.id, session_id: th.sessionId, cli_version: th.version, originator: "codex_cli", source: "cli" } };
      const ev = { timestamp: new Date(th.clock + 2000).toISOString(), type: "event_msg", ordinal: 1, payload: { type: "token_count" } };
      c.files.push({ path: `sessions/2026/01/01/rollout-2026-01-01T00-00-00-${th.id}-counts.jsonl`, content: `${JSON.stringify(lead)}\n${JSON.stringify(ev)}\n`, mtimeMs: OLD_MTIME_MS });
    }
    if (r.chance(0.04)) {
      // a file with no identity at all
      c.files.push({ path: `sessions/2026/01/01/rollout-2026-01-01T00-00-00-${th.id}-orphan.jsonl`, content: `${JSON.stringify({ timestamp: new Date(th.clock).toISOString(), type: "event_msg", ordinal: 0, payload: { type: "token_count" } })}\n`, mtimeMs: OLD_MTIME_MS });
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The scan of one seed. A pure function of (seed, knobs). */
export function generateScan(seed: number, knobs: Knobs): FuzzScan {
  const r = new Rng((seed * 2654435761) >>> 0 || 1);
  const c: Ctx = {
    r,
    k: knobs,
    files: [],
    eventMs: [],
    used: new Set(),
    links: [],
    counters: new Map(),
    baseMs: Date.UTC(2026, 0, 1) + r.int(0, 20) * 86_400_000,
  };
  // The two providers draw from independent streams so that a knob of one does not move the data of the other.
  const cl = r.sub();
  const cx = r.sub();
  genClaude({ ...c, r: cl });
  genCodex({ ...c, r: cx });
  // event instants are nominal: never let a mutated timestamp drag a window bound out of 2025 to 2030
  for (let i = c.eventMs.length - 1; i >= 0; i--) if (!(c.eventMs[i]! > Date.UTC(2025, 0, 1) && c.eventMs[i]! < Date.UTC(2030, 0, 1))) c.eventMs.splice(i, 1);
  c.eventMs.sort((x, y) => x - y);
  const ev = c.eventMs.length > 0 ? c.eventMs : [c.baseMs];
  return { seed, files: c.files, eventMs: c.eventMs, minMs: Math.min(...ev), maxMs: Math.max(...ev), used: [...c.used].sort(), links: c.links };
}

export interface WindowSpec {
  since?: string;
  until?: string;
}

/**
 * A window that cuts through the data. Half of the seeds get none. The bounds are ISO instants with milliseconds, a
 * bare date, or exactly the instant of a generated event (the [since, until) boundary).
 */
export function windowFor(seed: number, scan: FuzzScan): { window: WindowSpec; tier: boolean } {
  const r = new Rng(((seed + 7919) * 40503) >>> 0 || 1);
  const windowed = r.chance(0.5);
  const tier = r.chance(0.25);
  const form = r.f();
  const a = r.f();
  const b = r.f();
  const exact = r.chance(0.3);
  const span = Math.max(1, scan.maxMs - scan.minMs);
  const pickInstant = (frac: number): number => {
    if (exact && scan.eventMs.length > 0) return scan.eventMs[Math.min(scan.eventMs.length - 1, Math.floor(frac * scan.eventMs.length))]!;
    return Math.floor(scan.minMs + frac * span);
  };
  if (!windowed) return { window: {}, tier };
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const w: WindowSpec = {};
  if (form < 0.45) {
    w.since = new Date(pickInstant(lo)).toISOString();
    w.until = new Date(Math.max(pickInstant(hi), pickInstant(lo) + (exact ? 0 : 1))).toISOString();
  } else if (form < 0.7) w.since = new Date(pickInstant(a)).toISOString();
  else if (form < 0.85) w.until = new Date(pickInstant(a) + 1).toISOString();
  else {
    // day granularity
    w.since = new Date(scan.minMs + Math.floor(a * span)).toISOString().slice(0, 10);
  }
  if (w.since !== undefined && w.until !== undefined && Date.parse(w.until) < Date.parse(w.since.length === 10 ? `${w.since}T00:00:00Z` : w.since)) w.until = w.since.length === 10 ? `${w.since}T23:59:59Z` : w.since;
  return { window: w, tier };
}
