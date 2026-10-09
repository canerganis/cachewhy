// Types for scripts/recompute/index.mjs. The implementation is plain JavaScript on purpose, so it shares no
// code with src/ (spec R13.1). This file only describes the exported API for TypeScript callers (the tests).

export const SPEC_ID: "spec-1";
export const RECOMPUTE_SCHEMA: "cachewhy-recompute/1";

/** The closed taint enum of R0.9, in spec order. */
export type RecomputeTaintReason =
  | "stream_unresolved"
  | "copy_exposed"
  | "turn_model_conflicted"
  | "ordinal_unverified"
  | "fork_prefix_unresolved"
  | "request_anomaly"
  | "ownership_ambiguous"
  | "version_unverified"
  | "unparsed_line"
  | "unlogged_usage"
  | "unattributed_record"
  | "file_unreadable";

export interface RecomputeOptions {
  /** Claude config dirs (containing projects/) or projects dirs. */
  claudeDirs?: string[];
  /** Codex homes (sessions/, archived_sessions/) or one of those dirs. */
  codexDirs?: string[];
  /** Inclusive lower bound of the window: ISO instant, YYYY-MM-DD (UTC) or epoch ms. */
  since?: string | number | null;
  /** Exclusive upper bound. Same forms as `since`. */
  until?: string | number | null;
  /** Parsed pricing table object or a path to table.json. Default: src/pricing/table.json next to the repo root. */
  table?: object | string;
  /**
   * Test-only (R3.4): `standard` marks the Codex service tier as verified Standard so the row selection of R3.6 and
   * R3.10 runs. Without it every Codex response is unpriced with reason `modifier_unverified`. There is no CLI flag.
   */
  codexTierForTest?: "standard";
  /**
   * Test-only (R0.9, live families): the run start in epoch ms or as an ISO instant. Default: the clock, read once per
   * run. A file is live when it holds an unparseable line, names a chain, and its mtime is positive and at most 600 s before this
   * instant (a later mtime counts as live; a missing mtime, 0 or a failed stat never does). There is no CLI flag and no environment variable.
   * An ISO instant is parsed by the S3.1 grammar (1 to 9 fraction digits, calendar checked).
   */
  runStartMs?: number | string;
}

export interface RecomputeBuckets {
  input_uncached: bigint;
  cache_read: bigint;
  cache_write_5m: bigint;
  cache_write_1h: bigint;
  cache_write_unknown_ttl: bigint;
  /** Codex `cache_write_input_tokens` (R2.11). */
  cache_write: bigint;
  /** Null when output is unknown (R2.3). */
  output: bigint | null;
  /** Equal to `output` when known, else max(o over copies). */
  output_lower_bound: bigint;
  /** Codex reasoning_output_tokens, informational (R2.8). */
  reasoning: bigint | null;
}

/** One number only (R3.5): no range exists. `tokens_unpriced` is the response's tokens (context plus output or its lower bound). */
export type RecomputePrice =
  | { priced: true; pico: bigint; tokens_unpriced: 0n }
  | { priced: false; reason: string; tokens_unpriced: bigint };

export interface RecomputeResponse {
  provider: "claude" | "codex";
  /** Raw request key. Internal to the process: toJson hashes it unless asked not to. */
  key: string;
  /** True for a unique, kept response in the window of a live-free family that adds to the totals. */
  counted: boolean;
  /** `counted`, `live_skipped` or `excluded:<reason>`. */
  status: string;
  /** R0.9: the chain (owner stream) of a kept response, null for an excluded one. */
  chain?: string | null;
  /** R0.9: the family of the chain is tainted. Tainted responses keep their buckets and are unpriced `chain_tainted`. */
  tainted: boolean;
  taint_reasons: RecomputeTaintReason[];
  /** R0.9: the response belongs to a live family and was removed from the totals (`counted` is false). */
  live_skipped: boolean;
  kind?: string;
  model?: string | null;
  model_label?: string;
  model_source?: string;
  flags?: string[];
  buckets?: RecomputeBuckets;
  /** Event time (R5.9): floor of `event_ns` in milliseconds, for display. */
  event_ms?: number | null;
  /** S3.2: the exact event time in nanoseconds since the epoch. Never truncated to milliseconds before a comparison. */
  event_ns?: bigint | null;
  price?: RecomputePrice;
}

export interface RecomputeAgg {
  responses: number;
  responses_priced: number;
  responses_unpriced: number;
  tokens: Record<string, string>;
  context_tokens: string;
  tokens_total: string;
  tokens_unpriced: string;
  unpriced_share_exceeds_c24: boolean;
  reasoning_informational: string;
  /** Sum of the priced responses in picodollars (R3.8). */
  usd_pico: string;
}

export interface RecomputeProvider {
  totals: RecomputeAgg;
  /** S12.7: keyed by the model label, with `:unverified` appended for the unverified row of a model. */
  by_model: Record<string, RecomputeAgg>;
  /** S12.7: the same rows as a list of (model, model_verified) pairs. */
  by_model_rows: Array<RecomputeAgg & { model: string; model_verified: boolean }>;
  by_kind: Record<string, RecomputeAgg>;
  unpriced_by_reason: Record<string, { responses: number; tokens_unpriced: string }>;
}

/** The R0.9 coverage counters every provider carries (token amounts are decimal strings, R17.1). */
export interface RecomputeTaintCoverage {
  chains_total: number;
  chains_tainted: number;
  chains_tainted_by_reason: Record<RecomputeTaintReason, number>;
  families_total: number;
  families_tainted: number;
  /** R17.3 revision 11.1: families that hold a chain tainted with reason ordinal_unverified. */
  families_ordinal_unverified: number;
  /** R3.9 revision 11.1: unpriced tokens of the counted set by the first refusing gate (decimal strings, fixed enum order). */
  tokens_unpriced_by_reason: Record<string, string>;
  families_live_skipped: number;
  responses_in_tainted_chains: number;
  tokens_in_tainted_chains: string;
  requests_unpriced_tainted: number;
  responses_live_skipped: number;
  tokens_live_skipped: string;
  /** R16.1 / C36: 10 * tainted families > 3 * families, or 10 * tainted tokens > 3 * tokens (BigInt). */
  taint_warn: boolean;
  /** S6.3: tokens of the incomplete responses (R2.12) as one decimal string: Claude i + r + W + o, Codex I + O, all BigInt. */
  tokens_in_incomplete_responses: string;
  /** Extra output: the per-field maxima behind the scalar, decimal strings. */
  tokens_in_incomplete_by_field: Record<string, string>;
  /** S6.1: every conflict code of a request counted once per code, conflict_diagnostics included. */
  requests_conflict_by_kind: Record<string, number>;
  /** S12.0 and R17.6 counters (ledger counters are windowed, S12.1). */
  records_usage_bearing: number;
  records_usage_unmappable: number;
  fields_range_failed: number;
  requests_total: number;
  requests_priced: number;
  requests_unknown_model: number;
  lines_duplicate_collapsed: number;
  duplicate_records_collapsed: number;
}

export interface RecomputeResult {
  schema: typeof RECOMPUTE_SCHEMA;
  spec: typeof SPEC_ID;
  table_version: string;
  window: { since: string | null; until: string | null };
  price_mode: string;
  providers: { claude: RecomputeProvider; codex: RecomputeProvider };
  coverage: {
    claude: RecomputeTaintCoverage & Record<string, unknown>;
    codex: RecomputeTaintCoverage & Record<string, unknown>;
  };
  /** Every keyed response seen, counted, excluded or live-skipped. Not part of the JSON unless asked for. */
  responses: RecomputeResponse[];
}

export interface RecomputeJson {
  schema: string;
  spec: string;
  table_version: string;
  window: { since: string | null; until: string | null };
  price_mode: string;
  providers: RecomputeResult["providers"];
  coverage: RecomputeResult["coverage"];
  responses?: Array<Record<string, unknown>>;
}

export function recompute(opts?: RecomputeOptions): RecomputeResult;
/**
 * Files in the layout of the fixture builder: `projects/...`, `sessions/...`, `archived_sessions/...`. `mtimeMs` is the
 * file modification time (R0.9 live test, the only use of one); without it, or with 0, a file is never live.
 * `unreadable: true` is a test hook: the file exists but cannot be read (R0.9 `file_unreadable`).
 */
export function recomputeFiles(
  files: ReadonlyArray<{ path: string; content: string | Uint8Array; mtimeMs?: number; unreadable?: boolean }>,
  opts?: RecomputeOptions,
): RecomputeResult;
/**
 * `salt` is a test-only parameter (R14.4: 16 random bytes per call by default, never stored). `rawKeys` is an in-process
 * option for synthetic data; the CLI has no flag for it and refuses `--raw-keys`.
 */
export function toJson(result: RecomputeResult, opts?: { perResponse?: boolean; rawKeys?: boolean; salt?: string | Uint8Array }): RecomputeJson;
