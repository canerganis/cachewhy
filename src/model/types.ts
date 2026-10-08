// Shared domain types for cachewhy. Binding spec: docs/methodology.md (spec-1, revision 7).
//
// Rules for this file:
// - Types, enum value lists, the pre-registered constants (section 0.3) and a few pure helpers only.
//   No I/O, no parsing and no classification logic lives here.
// - Every token quantity is a bigint (R2.16). Every money amount is a bigint in picodollars
//   (1e-12 USD, R3.8). Epoch milliseconds (`*_ms`) are plain numbers: they are instants, not tokens.
// - Raw ids (request keys, uuids, session ids, agent ids, thread ids) exist only inside the process.
//   They are never exported; output code maps them to opaque ids (R14.4).
// - Nothing here may carry free text, paths, project names or message content (R1.1, R14.3).
//   `DiscoveredFile` (input only) holds paths; nothing derived from it in this file does.

import type { DiscoveredFile } from "../discover.js";

// ---------------------------------------------------------------------------
// 1. Primitives
// ---------------------------------------------------------------------------

export const PROVIDERS = ["claude", "codex"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Provider names as the pricing table spells them (src/pricing/table.json). */
export type TableProvider = "anthropic" | "openai";

/** A token count. Always a bigint after the range check of R2.15. */
export type Tokens = bigint;

/** Money in picodollars (1e-12 USD, R3.8). Always a bigint. */
export type Pico = bigint;

/** Epoch milliseconds (UTC). Instants only, never token quantities. */
export type EpochMs = number;

/** A decimal string of a BigInt. The serialization of every token or money amount (R14.5, R17.1). */
export type DecimalString = string;

/** Exact rational `num/den` (section 0.3). Decisions cross-multiply, they never divide (R2.16). */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

export function rat(num: bigint | number, den: bigint | number): Rational {
  return { num: BigInt(num), den: BigInt(den) };
}

/** Half-open report window [since, until) in UTC, evaluated on event time only (R5.9). */
export interface TimeWindow {
  readonly since_ms: EpochMs;
  readonly until_ms: EpochMs;
}

// ---------------------------------------------------------------------------
// 2. Pre-registered constants (section 0.3). The single source for every module.
// ---------------------------------------------------------------------------

/**
 * Constants C1 to C34 under their spec names. Retired ids C4 and C5 do not exist.
 * Seconds are plain numbers, token thresholds are bigint, ratios are exact rationals.
 * C13, C14 and C16 are Wilson bounds on run counts and are the only floats (section 0.3).
 */
export const CONSTANTS = {
  /** C1, R7.5 */ TAU_SUSPECT: rat(1, 2),
  /** C2, R7.5 */ TAU_NORMAL: rat(9, 10),
  /** C3, R7.2 E7 */ FLOOR_PREV: 16384n,
  /** C6, R9.4 */ TTL_5M_S: 300,
  /** C7, R9.4 */ TTL_1H_S: 3600,
  /** C8, R9.6 */ TTL_OPENAI_30M_S: 1800,
  /** C9, R9.6 */ TTL_OPENAI_24H_S: 86400,
  /** C10, R17.3 */ DRIFT_UNMAPPABLE: rat(1, 100),
  /** C11, R17.3 */ DRIFT_INVARIANT: rat(1, 200),
  /** C12, R12.7 */ N_EVAL_MIN: 40,
  /** C13, R12.7 (float) */ PREC_LB: 0.85,
  /** C14, R12.7 (float) */ FP_UB: 0.1,
  /** C15, R12.7 */ N_DEV_MIN: 20,
  /** C16, R12.8 (float) */ COVERAGE_LB: 0.5,
  /** C17, R13.4 */ RECON_TOKEN_TOL: rat(1, 100),
  /** C18, R13.4 */ RECON_COST_TOL: rat(1, 50),
  /** C19, R13.6 */ CODEX_INTERNAL_TOL: rat(1, 200),
  /** C20, R13.7 (percentage point) */ USAGE_CACHE_PCT_TOL: rat(1, 100),
  /** C21, R12.3 */ EFFECT_MISS_MAX: rat(1, 2),
  /** C22, R12.3 */ HIT_MIN: rat(9, 10),
  /** C23, R12.3 */ NO_EFFECT_MAX: rat(1, 5),
  /** C24, R3.9 */ UNPRICED_PARTIAL: rat(1, 10),
  /** C25, R3.4, R3.10 */ CODEX_LONG_CTX: 272000n,
  /** C26, R3.4 */ HAIKU_TIER_SPLIT: 100000n,
  /** C27, R11.7 */ COMPACT_WALK_HOPS: 200,
  /** C28, R17.3 */ NO_FINAL_MARKER_MIN: 100,
  /** C29, R5.9 */ FAST_PREFILTER_DAYS: 7,
  /** C30, R12.2 */ FILLER_MULT: 3,
  /** C31, R12.9 */ HANDCHECK_TOP: 20,
  /** C32, R3.4, R3.8 */ GEO_US_MULT: rat(11, 10),
  /** C33, R13.4 */ RECON_UNEXPLAINED_TOL: rat(1, 200),
  /** C34, R6.8 */ START_BOUND_VIOLATIONS_MAX: 0,
} as const;

/** Section 0.2, full support. Any other version is coverage only (R15.7). */
export const CLAUDE_FULL_VERSIONS = ["2.1.286", "2.1.288", "2.1.289", "2.1.291", "2.1.293"] as const;
export const CODEX_FULL_VERSIONS = ["0.157.1", "0.158.0", "0.159.2", "0.160.0", "0.160.1"] as const;

export const SPEC_ID = "spec-1" as const;
export const SCHEMA_ID = "cachewhy/1" as const;

export type SupportLevel = "full" | "coverage_only";

// ---------------------------------------------------------------------------
// 3. Enums (value lists are runtime constants so schemas and tests can iterate them)
// ---------------------------------------------------------------------------

/** R5.2. Kind is a property of the chain. */
export const REQUEST_KINDS = ["main", "subagent", "workflow_agent", "helper", "classifier", "advisor"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** R1.2 / R2.5 modifiers. An absent value is `null` on the Response, never one of these. */
export const SPEEDS = ["standard", "fast", "other"] as const;
export type Speed = (typeof SPEEDS)[number];
export const GEOS = ["not_available", "us", "other"] as const;
export type Geo = (typeof GEOS)[number];
export const SERVICE_TIERS = ["standard", "priority", "batch", "other"] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];

export const EFFORTS = ["low", "medium", "high", "xhigh", "max", "other"] as const;
export type Effort = (typeof EFFORTS)[number];

export const STOP_REASONS = ["tool_use", "end_turn", "stop_sequence", "refusal", "null", "other"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const ENTRYPOINTS = ["claude-desktop", "cli", "sdk-cli", "other"] as const;
export type Entrypoint = (typeof ENTRYPOINTS)[number];

/** R2.10 model_source values, plus `claude_explicit` for Claude (R14.5). */
export const MODEL_SOURCES = [
  "claude_explicit",
  "own_turn",
  "own_turn_unsettled",
  "carried_verified",
  "carried_unverified",
  "inherited_prefix",
  /** Fork whose fork ancestors meet a copy-exposed file (R4.13 (c)). Overrides every other row. Never verified. */
  "prefix_exposed",
  /** Stream is integrity_unverified for any other reason (R4.11). Overrides every other row. Never verified. */
  "stream_unverified",
  "none",
] as const;
export type ModelSource = (typeof MODEL_SOURCES)[number];

/**
 * Why a keyed response is removed from accounting and events (R6.2 "excluded"). A response with one of
 * these has `usage = null`; its tokens, where reportable, are only in coverage (R2.7, R2.12, R2.15).
 * `unverified_version`, `unkeyed` and `api_error` records are `ExcludedRecord`s, not Responses.
 */
export const EXCLUSION_REASONS = [
  "conflict_input", // R4.2
  "conflict_model", // R4.2
  "key_conflict", // R4.1
  "conflict_usage", // R4.4
  "conflict_attribution", // R4.4
  "usage_incomplete", // R2.12
  "usage_range_failed", // R2.15
  "usage_invariant_failed", // R2.7
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/** Records that are not Responses but still sit between P and C (R6.2). */
export const EXCLUDED_RECORD_REASONS = ["unkeyed", "api_error", "unverified_version"] as const;
export type ExcludedRecordReason = (typeof EXCLUDED_RECORD_REASONS)[number];

/** Non-exclusion flags on a kept response. */
export const RESPONSE_FLAGS = [
  "bucket_mismatch", // R2.1: kept and priced, excluded from detection and boundaries (E0)
  "w_unknown_ttl", // R2.1: cache_creation object absent
  "output_unknown", // R2.3: no final copy
  "conflict_output", // R4.2: output unknown, tokens kept
  "conflict_iterations", // R4.2: output unknown, response kept
  "conflict_modifier", // R4.2: unpriced_modifier
  "conflict_diagnostics", // R4.2, R10.4: no diagnostics evidence
  "speed_assumed", // R3.12: no final copy, so no verified speed, geo or tier (the name is historical: nothing is assumed)
  "classifier_attached", // R5.5
  "ownership_ambiguous", // R4.6
  "fork_first_own", // R4.8, R4.9: first own request after a replayed prefix
] as const;
export type ResponseFlag = (typeof RESPONSE_FLAGS)[number];

export const CONFLICT_KINDS = [
  "conflict_input",
  "conflict_output",
  "conflict_iterations",
  "conflict_modifier",
  "conflict_model",
  "conflict_diagnostics",
  "key_conflict",
  "conflict_usage",
  "conflict_attribution",
] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export const LINK_STATES = ["verified", "directory", "unlinked"] as const;
export type LinkState = (typeof LINK_STATES)[number];

export const CLAUDE_UNLINKED_REASONS = [
  "no_meta",
  "no_tool_use_id",
  "session_mismatch",
  "agent_mismatch",
  "parent_file_missing",
  "tool_use_not_found",
  "tool_name_unexpected",
  "parent_agent_mismatch",
] as const;
export const CODEX_UNLINKED_REASONS = [
  "no_parent_id",
  "fork_parent_mismatch",
  "parent_file_missing",
  "root_mismatch",
  "other_source",
] as const;
/** R5.4. Workflow agents that fail the directory test (spec lists only "unlinked"; these reasons are an implementation detail). */
export const WORKFLOW_UNLINKED_REASONS = ["no_journal_entry", "no_run_file", "run_id_mismatch"] as const;
export const UNLINKED_REASONS = [
  ...CLAUDE_UNLINKED_REASONS,
  "no_parent_id",
  "fork_parent_mismatch",
  "root_mismatch",
  "other_source",
  ...WORKFLOW_UNLINKED_REASONS,
] as const;
export type UnlinkedReason = (typeof UNLINKED_REASONS)[number];

export const STREAM_INTEGRITY_REASONS = [
  "file_stream_conflict", // R4.11 |I(F)| >= 2
  "copy_exposed_file", // R4.13
  "divergent_session_meta", // R4.11 same id, different forked_from_id or history start
  "prefix_exposed", // R4.13 (c) fork exposure
  "stream_missing", // a response whose chain has no Stream record (synthesized, unverified)
] as const;
export type StreamIntegrityReason = (typeof STREAM_INTEGRITY_REASONS)[number];

/** R7.2 E0 gate codes. Counted in coverage.requests_gate_abstained. */
export const GATE_ABSTAIN_CODES = [
  "stream_unresolved",
  "ownership_ambiguous",
  "order_tie",
  "conflict",
  "usage_incomplete",
  "usage_invalid",
  "unverified_version",
  "gap_has_excluded",
] as const;
export type GateAbstainCode = (typeof GATE_ABSTAIN_CODES)[number];

/** R7.2, R7.6. Superset of the gate codes. Counted in coverage.pairs_abstained. */
export const ABSTAIN_CODES = [
  ...GATE_ABSTAIN_CODES,
  "grey_partial",
  "short_prefix",
  "prev_no_cache",
  "model_unknown",
  "unknown_min_length",
] as const;
export type AbstainCode = (typeof ABSTAIN_CODES)[number];

/** R7.5 numeric outcome of an eligible pair. */
export const NUMERIC_OUTCOMES = ["normal", "grey", "suspect"] as const;
export type NumericOutcome = (typeof NUMERIC_OUTCOMES)[number];

/** R7.8 detector output per pair. */
export const PAIR_OUTCOMES = ["no_event", "event", "abstain", "boundary"] as const;
export type PairOutcome = (typeof PAIR_OUTCOMES)[number];

/** R11.8. The complete set of boundary types. */
export const BOUNDARY_TYPES = [
  "model_switch",
  "context_reset",
  "subagent_cold_start",
  "fork_inherit",
  "first_observation",
] as const;
export type BoundaryType = (typeof BOUNDARY_TYPES)[number];

/** R11.4 precedence order, highest first. `diagnostics-reported causes` map onto these same causes. */
export const CAUSES = [
  "compaction_or_clear",
  "model_switch",
  "tools_or_system_changed",
  "request_settings_changed",
  "ttl_expiry_compatible",
  "fork_inherit",
  "context_edit_or_prune",
  "unknown",
] as const;
export type Cause = (typeof CAUSES)[number];

export const EVIDENCE_LEVELS = ["observed", "hypothesis", "confirmed", "unknown"] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];
export const CONFIDENCES = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/** Enum-valued signals attached to candidates (R14.5 `signals[]`). New values need a schema change. */
export const SIGNALS = [
  "diag_tools_changed",
  "diag_system_changed",
  "diag_messages_changed",
  "diag_model_changed",
  "diag_no_baseline",
  "diag_unavailable",
  "diag_unrecognized",
  "structural_change_with_hit",
  "version_changed",
  "comp_hash_changed",
  "effort_changed",
  "speed_changed",
  "expiry_compatible",
  "partial_hit",
  "model_differs",
  "compact_boundary_bound",
  "compaction_marker_unbound",
  "compaction_size_inconsistent",
  "agent_prefix_corroboration",
] as const;
export type Signal = (typeof SIGNALS)[number];

/** R9.8 */
export const TTL_CLASSES = ["5m", "1h", "mixed", "unknown", "openai_30m", "openai_unknown"] as const;
export type TtlClass = (typeof TTL_CLASSES)[number];

/** R9.4. There is deliberately no exclusion value. */
export const EXPIRY_STATUSES = ["expiry_compatible", "expiry_ambiguous", "ttl_gap_unknown"] as const;
export type ExpiryStatus = (typeof EXPIRY_STATUSES)[number];

/** R6.4, R6.5. Codex is always `none`. */
export const GAP_BASES = ["parent_record", "none"] as const;
export type GapBasis = (typeof GAP_BASES)[number];

export const DELTA_STATUSES = ["ok", "tokens_only"] as const;
export type DeltaStatus = (typeof DELTA_STATUSES)[number];
export const DELTA_REASONS = [
  "unpriced_model",
  "unpriced_modifier",
  "bucket_unknown",
  "conflict",
  "diag_estimate_used",
  "tier_straddle",
] as const;
export type DeltaReason = (typeof DELTA_REASONS)[number];

/** R10.3 */
export const DIAG_TYPES = [
  "messages_changed",
  "tools_changed",
  "system_changed",
  "model_changed",
  "previous_message_not_found",
  "unavailable",
  "other",
] as const;
export type DiagType = (typeof DIAG_TYPES)[number];

/** Informational tags on a pair. Never abstain codes (R7.6, R10.4, R11.7). */
export const PAIR_TAGS = ["suffix_growth_only", "structural_change_with_hit", "compaction_size_inconsistent"] as const;
export type PairTag = (typeof PAIR_TAGS)[number];

/** Printed assumption codes (R14.5 `assumptions`). */
export const ASSUMPTIONS = [
  "no_batch_assumed",
  "no_regional_surcharge_assumed",
  "parent_record_precedes_request",
  "read_region_is_prefix_of_previous",
  "no_marker_means_unchanged_prefix",
  "codex_cached_prefix_lower_bound_only",
  "ttl_touch_is_previous_request",
  "claude_ttl_options_5m_1h",
  "diag_basis_is_chain_previous",
  "unverified_version",
  "mtime_prefilter_on",
] as const;
export type Assumption = (typeof ASSUMPTIONS)[number];

/** R17.3 */
export const DRIFT_CODES = [
  "drift_unmappable",
  "drift_invariant",
  "drift_no_key",
  "drift_no_final_marker",
  "drift_stream_integrity",
] as const;
export type DriftCode = (typeof DRIFT_CODES)[number];

export const HEADLINE_STATUSES = ["ok", "withheld"] as const;
export type HeadlineStatus = (typeof HEADLINE_STATUSES)[number];

// ---------------------------------------------------------------------------
// 4. Pricing table (JSON shape of src/pricing/table.json) and the prepared price book
// ---------------------------------------------------------------------------

/** Prices as decimal strings, USD per million tokens (R3.1). `null` is `n/a`. */
export interface TablePriceRow {
  readonly input?: string | null;
  readonly output?: string | null;
  readonly cache_read?: string | null;
  readonly cache_write_5m?: string | null;
  readonly cache_write_1h?: string | null;
  /** OpenAI naming. Mapped to `cache_read` in the PriceBook. */
  readonly cached_input?: string | null;
  /** OpenAI cache write. Mapped to `cache_write`. */
  readonly cache_write?: string | null;
}

export interface TableVerifiable {
  readonly verified?: boolean;
  readonly verified_at?: string;
  readonly source_ids?: readonly string[];
}

export interface TableLongContext extends TableVerifiable {
  /** Anthropic rows: `none` means the long context is billed at the standard row. */
  readonly surcharge?: string;
  readonly threshold_input_tokens?: number;
  readonly prices_usd_per_mtok?: TablePriceRow;
  /** R3.10. Absent means `unknown`. */
  readonly scope?: "request" | "session" | "unknown";
  readonly scope_verified?: boolean;
  readonly scope_source_id?: string;
}

export interface TableModelEntry extends TableVerifiable {
  readonly id: string;
  readonly provider: TableProvider;
  readonly model_ids?: readonly string[] | null;
  /** `null` for an entry that is present but unpriced (no verified row). */
  readonly prices_usd_per_mtok: TablePriceRow | null;
  readonly multipliers?: Readonly<Record<string, string | null>> | null;
  /** R7.2 `M`. `null` means unknown (E6 abstains). */
  readonly min_cacheable_tokens: number | null;
  readonly tiers?: (TableVerifiable & { readonly split_tokens: number; readonly high: TablePriceRow }) | null;
  readonly long_context?: TableLongContext | null;
  readonly fast?: (TableVerifiable & { readonly prices_usd_per_mtok: TablePriceRow }) | null;
  readonly geo_us?: (TableVerifiable & { readonly applies: boolean; readonly multiplier?: string }) | null;
  /** R3.4: explicit price rows per service tier value. */
  readonly service_tier?: Readonly<Partial<Record<ServiceTier, TableVerifiable & { readonly prices_usd_per_mtok: TablePriceRow }>>> | null;
}

export interface PricingTable extends TableVerifiable {
  readonly schema_version: number;
  /** Matches `^pt-[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]+)?$` (R14.5). */
  readonly table_version: string;
  readonly sources: Readonly<Record<string, string>>;
  readonly modifiers: Readonly<Record<string, TableVerifiable & { readonly [k: string]: unknown }>>;
  readonly models: readonly TableModelEntry[];
}

/**
 * One resolved price row in units of 1e-6 USD per MTok (R3.8). `null` is `n/a`.
 * Field names are provider neutral: `cache_read` is Claude cache read and Codex cached input.
 */
export interface PriceRow {
  readonly input: bigint | null;
  readonly output: bigint | null;
  readonly cache_read: bigint | null;
  readonly cache_write_5m: bigint | null;
  readonly cache_write_1h: bigint | null;
  /** OpenAI cache write price. */
  readonly cache_write: bigint | null;
}

export interface LongContextPrice {
  readonly threshold: bigint;
  /** Prices verified (R3.1, R3.11). Independent from the scope. */
  readonly prices_verified: boolean;
  readonly row: PriceRow | null;
  /** R3.10. `request` only if scope = request and scope_verified with date and source id. */
  readonly scope: "request" | "session" | "unknown";
}

/** One model of the prepared price book. Only `verified` objects are present; unverified ones are `null` (R3.1). */
export interface ModelPrice {
  readonly id: string;
  readonly provider: TableProvider;
  /** False means the whole entry is treated as absent (R3.1). */
  readonly verified: boolean;
  /** M of R7.2. `null` means unknown. */
  readonly min_cacheable: bigint | null;
  readonly standard: PriceRow;
  readonly fast: PriceRow | null;
  /** Haiku 5.5 high tier (R3.4) and the total_input split. */
  readonly tier_high: PriceRow | null;
  readonly tier_split: bigint | null;
  readonly long_context: LongContextPrice | null;
  readonly geo_us_applies: boolean;
  readonly service_tier_rows: Readonly<Partial<Record<ServiceTier, PriceRow>>>;
}

/** The prepared, validated table every pricing consumer reads (built from PricingTable by loadPriceBook). */
export interface PriceBook {
  readonly table_version: string;
  /** Key: normalized model id (R3.3). */
  readonly models: ReadonlyMap<string, ModelPrice>;
  /** Table modifier `fast_with_geo_us` verified (R3.4). */
  readonly fast_with_geo_us_verified: boolean;
}

// ---------------------------------------------------------------------------
// 5. Responses
// ---------------------------------------------------------------------------

/** Chain key (R5.1). Raw ids, internal only. */
export interface ChainKey {
  readonly provider: Provider;
  /** Claude `sessionId` of the main file. Codex `session_meta.session_id`. */
  readonly root_session: string;
  /** Claude `main` or the `agentId`. Codex `thread_id`. */
  readonly thread: string;
}

/** Canonical single string for a chain key, usable as a Map key. */
export function chainKeyString(k: ChainKey): string {
  return `${k.provider}\u0000${k.root_session}\u0000${k.thread}`;
}

/**
 * Normalized token buckets of one response (R2.1, R2.6). Names are provider neutral.
 *
 *            Claude                          Codex
 * input_uncached     i                       in - c - cw   (R2.6)
 * cache_read         r                       c
 * cache_write_5m     w5                      0
 * cache_write_1h     w1                      0
 * cache_write_unknown_ttl  wu (R2.1)         0
 * cache_write        0                       cw (bucket `w_openai`, R2.11)
 * output             o of the final copy     out (includes reasoning, R2.8)
 */
export interface UsageBuckets {
  readonly input_uncached: Tokens;
  readonly cache_read: Tokens;
  readonly cache_write_5m: Tokens;
  readonly cache_write_1h: Tokens;
  readonly cache_write_unknown_ttl: Tokens;
  readonly cache_write: Tokens;
  /** `null` when output is unknown (R2.3). */
  readonly output: Tokens | null;
  /** `max(o over copies)` for Claude without a final copy, else equal to `output`. */
  readonly output_lower_bound: Tokens;
  /** Codex `reasoning_output_tokens`, Claude `thinking_tokens`. Informational, never added (R2.4, R2.8). */
  readonly reasoning: Tokens | null;
  /** True for Codex (output already includes reasoning, R2.8). False for Claude (unknown, Q3). Never added either way. */
  readonly reasoning_included_in_output: boolean;
}

export interface Modifiers {
  /** `null` is absent (R3.4: standard assumed, flag `speed_assumed`). */
  readonly speed: Speed | null;
  readonly inference_geo: Geo | null;
  readonly service_tier: ServiceTier | null;
}

export interface ModelAttribution {
  /** Normalized id (R3.3) of the candidate model, or null when none exists. */
  readonly candidate: string | null;
  /** R2.10. Only a verified model is priced and eligible. */
  readonly verified: boolean;
  readonly source: ModelSource;
  /** The model that pricing and R7.2 E2 may use: `candidate` iff verified, else null (`model_unknown`). */
  readonly model: string | null;
}

export interface TimeInfo {
  /** R5.9: Claude `t_first`, Codex envelope timestamp of the `token_usage_record`. */
  readonly event_ms: EpochMs;
  readonly t_first_ms: EpochMs;
  readonly t_last_ms: EpochMs;
  /** R6.3. Timestamp of the record named by `parentUuid` of the earliest copy, if it resolves. */
  readonly t_asm_ms: EpochMs | null;
  /** R6.4, R6.5. Always null for Codex. */
  readonly start_lo_ms: EpochMs | null;
  readonly start_hi_ms: EpochMs;
  readonly gap_basis: GapBasis;
}

export interface Ownership {
  /** R4.6, R4.7. A replayed copy carries the owner's counters but counts zero (R4.7). */
  readonly role: "owner" | "replayed";
  /** R4.6: tied `stream_start`. Also appears as flag `ownership_ambiguous`. */
  readonly ambiguous: boolean;
  /** `stream_start` of the owning stream (R4.6). */
  readonly owner_stream_start_ms: EpochMs | null;
}

/** Index into ParseResult.files / Graph.files. Files are labelled `file_<N>` on output (R14.6). */
export type FileIndex = number;

export interface Provenance {
  /** Files that contributed a copy of this response. Sorted ascending. */
  readonly files: readonly FileIndex[];
  /** True if any contributing file is copy-exposed (R4.13). */
  readonly from_copy_exposed_file: boolean;
}

/** Claude diagnostics, one per response (R10.1, R10.4, R10.7). */
export interface Diagnostics {
  readonly type: DiagType;
  /** `api_reported_estimate`, never used in L, K or dollars (R10.7). */
  readonly missed_tokens_reported: Tokens | null;
}

export interface ResponseBase {
  readonly provider: Provider;
  /** Claude `requestId`, Codex `response_id`. Internal only (R14.4). */
  readonly key: string;
  readonly chain: ChainKey;
  readonly kind: RequestKind;
  /** Product version `x.y.z` or `unlisted` (R1.2). */
  readonly version: string;
  readonly support: SupportLevel;
  readonly model: ModelAttribution;
  /** Non-null iff `exclusion` is null. An excluded response has no usable counters (R2.7, R2.12, R2.15, R4.2, R4.4). */
  readonly usage: UsageBuckets | null;
  readonly exclusion: ExclusionReason | null;
  readonly flags: readonly ResponseFlag[];
  readonly modifiers: Modifiers;
  readonly effort: Effort | null;
  readonly time: TimeInfo;
  /** Codex envelope `ordinal` (R4.12), null when absent or Claude. */
  readonly ordinal: number | null;
  readonly ownership: Ownership;
  readonly provenance: Provenance;
}

export interface ClaudeResponse extends ResponseBase {
  readonly provider: "claude";
  /** `message.id`, consistency check only (R4.1). */
  readonly message_id: string | null;
  /** uuid of the earliest copy, graph edges only (R1.2, R6.3). */
  readonly uuid: string | null;
  readonly parent_uuid: string | null;
  readonly is_sidechain: boolean;
  readonly entrypoint: Entrypoint | null;
  readonly per_turn_effort: Effort | null;
  readonly advisor_model: string | null;
  readonly stop_reason: StopReason | null;
  readonly diag: Diagnostics | null;
  /** Number of copies seen (one content block is one record, R4.2). */
  readonly copies: number;
}

export interface CodexResponse extends ResponseBase {
  readonly provider: "codex";
  readonly thread_id: string;
  readonly session_id: string;
  readonly turn_id: string | null;
  readonly root_turn_id: string | null;
  /** Inferred meaning, hypothesis low only (Q15). */
  readonly comp_hash: string | null;
  readonly collaboration_mode: string | null;
  /** `thread_token_usage.total_tokens`, read only for R13.6. */
  readonly thread_total: Tokens | null;
}

export type Response = ClaudeResponse | CodexResponse;

/** A record that is not a Response but takes part in gap decisions (R6.2). No key, no counters. */
export interface ExcludedRecord {
  readonly provider: Provider;
  readonly chain: ChainKey;
  readonly reason: ExcludedRecordReason;
  readonly event_ms: EpochMs;
  readonly ordinal: number | null;
  readonly files: readonly FileIndex[];
}

/** R4.2, R4.4, R4.1: a disagreement between copies or occurrences. Never carries values. */
export interface DedupConflict {
  readonly provider: Provider;
  readonly kind: ConflictKind;
  /** Internal key, not exported. */
  readonly key: string;
  readonly files: readonly FileIndex[];
  /** What happened to the response (R4.2 table). */
  readonly effect: "excluded" | "output_unknown" | "unpriced_modifier" | "no_diagnostics_evidence";
}

/** True iff the response adds to totals, dollars and events: kept, and the owner's copy (R4.7, R5.8). */
export function countsInTotals(r: Response): boolean {
  return r.exclusion === null && r.ownership.role === "owner";
}

// Derived quantities of R7.1 (BigInt only, R2.16).

/** `ctx(X)`. Claude `i + r + w`, Codex `in`. Also the `total_input` of R2.2 and R3.4. */
export function contextTokens(u: UsageBuckets): Tokens {
  return u.input_uncached + u.cache_read + writeTokens(u);
}

/** All cache write buckets. Claude `w` (R2.1), Codex `cw`. */
export function writeTokens(u: UsageBuckets): Tokens {
  return u.cache_write_5m + u.cache_write_1h + u.cache_write_unknown_ttl + u.cache_write;
}

/** `K(X)`: what the counters prove was cached. Claude `r + w`, Codex `c + cw` (a lower bound for Codex, R7.1). */
export function cachedPrefix(u: UsageBuckets): Tokens {
  return u.cache_read + writeTokens(u);
}

/** `K_hi(X)`: Claude `r + w`, Codex `in` (an upper bound, R7.1). */
export function cachedPrefixUpper(provider: Provider, u: UsageBuckets): Tokens {
  return provider === "claude" ? cachedPrefix(u) : contextTokens(u);
}

// ---------------------------------------------------------------------------
// 6. Files, streams, links, structural markers
// ---------------------------------------------------------------------------

/** Per-file facts. No path, no name: only the opaque index (label `file_<N>`, R14.6). */
export interface FileInfo {
  readonly index: FileIndex;
  readonly provider: Provider;
  readonly source_kind: DiscoveredFile["kind"];
  /** Product versions seen in this file, bounded form of R1.2. */
  readonly versions: readonly string[];
  readonly support: SupportLevel;
  readonly readable: boolean;
  readonly archived: boolean;
  /** R4.11 */
  readonly stream_assignment: "assigned" | "unassigned" | "conflict";
  /** R4.13 */
  readonly copy_exposed: boolean;
  /** R2.9: Codex file with token_count events but no token_usage_record. */
  readonly without_response_id: boolean;
  readonly lines: number;
}

/** R4.9. Codex fork facts of a stream. */
export interface ForkInfo {
  /** Raw id of the parent, internal only. */
  readonly forked_from_id: string;
  readonly history_start_ordinal: number | null;
  /** False means `fork_prefix_unresolved` (R4.9). */
  readonly prefix_resolved: boolean;
}

/** A logical stream (R4.11). The chain of R5.1 is one logical stream. */
export interface Stream {
  readonly chain: ChainKey;
  readonly provider: Provider;
  readonly files: readonly FileIndex[];
  /** R4.6: minimum timestamp over all records of all files of the stream. */
  readonly start_ms: EpochMs | null;
  /** R4.12. Always null for Claude, which has no ordinal. */
  readonly ordinal_verified: boolean | null;
  /** R4.11, R4.13. Every request of such a stream abstains `stream_unresolved`. */
  readonly integrity_unverified: boolean;
  readonly integrity_reasons: readonly StreamIntegrityReason[];
  /** Codex only, null when the thread is not a fork (R4.9). */
  readonly fork: ForkInfo | null;
  /** Codex `thread_settings_applied` presence in the stream (R2.10, R2.17). */
  readonly has_settings_marker: boolean;
}

/** Linkage of an agent chain (R5.3, R5.4, R5.6). Main chains have no Link. */
export interface Link {
  readonly chain: ChainKey;
  readonly kind: "subagent" | "workflow_agent";
  readonly state: LinkState;
  readonly reason: UnlinkedReason | null;
  /** Parent chain when the parent was found. */
  readonly parent: ChainKey | null;
  /** Informational (R5.6). Claude `spawnDepth`, Codex `thread_spawn.depth`. */
  readonly depth: number | null;
  /** Codex fork (R4.9, R5.7): a fork's first own request is `fork_inherit` even when linked. */
  readonly is_fork: boolean;
}

/** One node of the Claude uuid graph (R11.7 walks). Duplicates collapsed on uuid (R4.7). */
export interface ClaudeUuidNode {
  readonly uuid: string;
  readonly parent_uuid: string | null;
  readonly logical_parent_uuid: string | null;
  readonly ts_ms: EpochMs | null;
  readonly is_compact_summary: boolean;
  readonly is_compact_boundary: boolean;
  readonly chain: ChainKey | null;
}

/** Claude `compact_boundary` system record (R1.2, R11.7). Duplicates collapsed on uuid, owned by the owning stream. */
export interface ClaudeCompactBoundary {
  readonly chain: ChainKey;
  readonly uuid: string;
  readonly logical_parent_uuid: string | null;
  readonly trigger: "manual" | "auto" | "other" | null;
  readonly pre_tokens: Tokens | null;
  readonly post_tokens: Tokens | null;
  readonly ts_ms: EpochMs | null;
}

/** Codex `compacted` record (R1.2, R4.9, R11.7). Never bound to a request. */
export interface CodexCompaction {
  readonly chain: ChainKey;
  readonly ordinal: number | null;
  readonly ts_ms: EpochMs | null;
  readonly window_number: number | null;
  readonly latest_usage_is_null: boolean;
  /** True when the record lies in a copied fork prefix (ignored for attribution, R4.9). */
  readonly in_copied_prefix: boolean;
}

/** R10.6. Agent-level corroboration only, never per request and never dollars. */
export interface AgentPrefixHint {
  readonly chain: ChainKey;
  readonly model: string | null;
  readonly is_1h_cache_ttl: boolean | null;
  readonly build_version: string | null;
  readonly tools_hash_present: boolean;
}

/** R17.5. Cumulative `cost-state.modelUsage` per model, for the coverage estimate only. */
export interface CostStateUsage {
  readonly model: string;
  readonly input_uncached: Tokens;
  readonly cache_read: Tokens;
  readonly cache_write: Tokens;
  readonly output: Tokens;
}

/** R13.6: last `thread_token_usage.total_tokens` of a thread and the sum of its accounted usage. */
export interface CodexThreadTotal {
  readonly chain: ChainKey;
  readonly last_thread_total: Tokens | null;
  readonly summed_total_tokens: Tokens;
  /** The record chain is complete (previous total plus usage), so equality is expected (R13.6). */
  readonly chain_complete: boolean;
  /** Starts in a continuation file: excluded and counted (R13.6). */
  readonly starts_in_continuation: boolean;
}

// ---------------------------------------------------------------------------
// 7. Coverage (section 17)
// ---------------------------------------------------------------------------

/** Plain integer counters. Names are exactly those of R17.1 (plus the numerators the drift codes of R17.3 need). */
export const COVERAGE_COUNT_FIELDS = [
  "files_total",
  "files_unreadable",
  "files_without_response_id",
  "token_count_events_without_response_id",
  "files_unassigned_stream",
  "files_assigned_by_stream",
  "files_stream_conflict",
  "files_copy_exposed",
  "lines_total",
  "lines_parse_error",
  "lines_truncated_tail",
  "known_type_count",
  "unlisted_type_count",
  "lines_duplicate_collapsed",
  "duplicate_records_collapsed",
  "lines_unverified_version",
  "records_unkeyed",
  "records_usage_bearing",
  /** Numerator of drift_unmappable (R17.3): logical usage-bearing records that cannot be mapped. */
  "records_usage_unmappable",
  "api_error_records",
  "requests_total",
  "responses_total",
  "requests_priced",
  "requests_unknown_model",
  "requests_unpriced_modifier",
  "requests_conflict",
  "requests_conflict_modifier",
  "requests_unverified_version",
  "requests_gate_abstained",
  "responses_bucket_mismatch",
  "responses_speed_assumed",
  "responses_usage_range_failed",
  /** Numerator part of drift_invariant: responses failing R2.7 (R2.15 and R2.1 and key conflicts are counted separately). */
  "responses_usage_invariant_failed",
  "responses_model_unverified",
  /** Denominator evidence of drift_no_final_marker (R17.3): requests with at least one copy carrying usage.speed. */
  "requests_with_final_marker",
  "output_unknown_requests",
  "baseline_requests_loaded",
  "replay_requests_excluded",
  "replay_ownership_ambiguous",
  "fields_range_failed",
  "links_verified",
  "links_directory_only",
  "links_unlinked",
  "streams_total",
  "streams_integrity_unverified",
  "streams_ordinal_unverified",
  "streams_fork_prefix_unresolved",
  "pairs_total",
  "pairs_eligible",
  "pairs_abstained",
  "pairs_gap_unknown",
  /** R7.8 outcome counts. */
  "pairs_no_event",
  "pairs_event",
  "pairs_boundary",
] as const;
export type CoverageCountField = (typeof COVERAGE_COUNT_FIELDS)[number];

/** Token-amount counters. Decimal strings on output, never JSON numbers (R17.1). */
export const COVERAGE_TOKEN_FIELDS = [
  "tokens_unpriced",
  "tokens_in_incomplete_responses",
  "tokens_in_invalid_responses",
] as const;
export type CoverageTokenField = (typeof COVERAGE_TOKEN_FIELDS)[number];

/** R17.6. Physical counters count the input as written. Every other counter is logical. */
export const PHYSICAL_COVERAGE_COUNTERS: ReadonlySet<CoverageCountField> = new Set<CoverageCountField>([
  "files_total",
  "files_assigned_by_stream",
  "files_unassigned_stream",
  "files_stream_conflict",
  "files_copy_exposed",
  "files_unreadable",
  "files_without_response_id",
  "token_count_events_without_response_id",
  "lines_total",
  "lines_parse_error",
  "lines_truncated_tail",
  "known_type_count",
  "unlisted_type_count",
  "lines_duplicate_collapsed",
  "duplicate_records_collapsed",
  "lines_unverified_version",
]);

/** Reasons under `requests_unpriced_modifier` (R3.4, R3.10). */
export const UNPRICED_MODIFIER_REASONS = [
  "conflict_modifier",
  "speed_other",
  "speed_fast_no_row",
  "fast_geo_unverified",
  "geo_other",
  "service_tier_unpriced",
  "long_context_scope",
  "long_context_unverified",
  "cache_write_price_na",
  "tier_unverified",
  /** R3.12 (Claude without a final copy) and R3.4 (every Codex response: the service tier is not observable). */
  "modifier_unverified",
] as const;
export type UnpricedModifierReason = (typeof UNPRICED_MODIFIER_REASONS)[number];

export const UNLOGGED_BUCKETS = ["input_uncached", "cache_read", "cache_write", "output"] as const;
export type UnloggedBucket = (typeof UNLOGGED_BUCKETS)[number];

export type CoverageCounters = Record<CoverageCountField, number> &
  Record<CoverageTokenField, Tokens> & {
    /** Reason counts. The totals are the matching plain counters (they must equal the sum). */
    requests_unpriced_modifier_by_reason: Record<UnpricedModifierReason, number>;
    requests_conflict_by_kind: Record<ConflictKind, number>;
    links_unlinked_by_reason: Record<UnlinkedReason, number>;
    pairs_abstained_by_code: Record<AbstainCode, number>;
    requests_gate_abstained_by_code: Record<GateAbstainCode, number>;
    /** R17.5. Signed (log minus sum of requests), decimal string on output. */
    unlogged_tokens_estimate: Record<UnloggedBucket, Tokens>;
    /** R15.7. Bounded version strings (`unlisted` for anything off pattern) with line counts. */
    versions: Record<string, number>;
  };

function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  const o = {} as Record<K, number>;
  for (const k of keys) o[k] = 0;
  return o;
}

export function emptyCoverage(): CoverageCounters {
  const c = {
    ...zeroCounts(COVERAGE_COUNT_FIELDS),
    tokens_unpriced: 0n,
    tokens_in_incomplete_responses: 0n,
    tokens_in_invalid_responses: 0n,
    requests_unpriced_modifier_by_reason: zeroCounts(UNPRICED_MODIFIER_REASONS),
    requests_conflict_by_kind: zeroCounts(CONFLICT_KINDS),
    links_unlinked_by_reason: zeroCounts(UNLINKED_REASONS),
    pairs_abstained_by_code: zeroCounts(ABSTAIN_CODES),
    requests_gate_abstained_by_code: zeroCounts(GATE_ABSTAIN_CODES),
    unlogged_tokens_estimate: { input_uncached: 0n, cache_read: 0n, cache_write: 0n, output: 0n },
    versions: {},
  };
  return c as CoverageCounters;
}

/** Field-wise sum. Used to combine the two providers (or parts of a scan). Pure, returns a new object. */
export function mergeCoverage(a: CoverageCounters, b: CoverageCounters): CoverageCounters {
  const out = emptyCoverage();
  for (const f of COVERAGE_COUNT_FIELDS) out[f] = a[f] + b[f];
  for (const f of COVERAGE_TOKEN_FIELDS) out[f] = a[f] + b[f];
  const addMap = <K extends string>(dst: Record<K, number>, x: Record<K, number>, y: Record<K, number>, keys: readonly K[]): void => {
    for (const k of keys) dst[k] = x[k] + y[k];
  };
  addMap(out.requests_unpriced_modifier_by_reason, a.requests_unpriced_modifier_by_reason, b.requests_unpriced_modifier_by_reason, UNPRICED_MODIFIER_REASONS);
  addMap(out.requests_conflict_by_kind, a.requests_conflict_by_kind, b.requests_conflict_by_kind, CONFLICT_KINDS);
  addMap(out.links_unlinked_by_reason, a.links_unlinked_by_reason, b.links_unlinked_by_reason, UNLINKED_REASONS);
  addMap(out.pairs_abstained_by_code, a.pairs_abstained_by_code, b.pairs_abstained_by_code, ABSTAIN_CODES);
  addMap(out.requests_gate_abstained_by_code, a.requests_gate_abstained_by_code, b.requests_gate_abstained_by_code, GATE_ABSTAIN_CODES);
  for (const k of UNLOGGED_BUCKETS) out.unlogged_tokens_estimate[k] = a.unlogged_tokens_estimate[k] + b.unlogged_tokens_estimate[k];
  for (const src of [a.versions, b.versions]) {
    for (const [v, n] of Object.entries(src)) out.versions[v] = (out.versions[v] ?? 0) + n;
  }
  return out;
}

/** One drift finding (R17.3). The ratio is kept as numerator and denominator, never a float. */
export interface DriftFinding {
  readonly code: DriftCode;
  readonly provider: Provider;
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly tripped: boolean;
}

// ---------------------------------------------------------------------------
// 8. Parser interfaces
// ---------------------------------------------------------------------------

export interface ParseOptions {
  /**
   * Report window. The parser reads all files in full (R5.10). It uses the window only for the optional mtime
   * prefilter (R5.9 `--fast`). Event times are never filtered by the parser.
   */
  readonly window?: TimeWindow | null;
  /** `--fast`: skip files with mtime older than `since` minus C29. Adds assumption `mtime_prefilter_on`. */
  readonly fastPrefilter?: boolean;
  /** Clock for the prefilter. Default Date.now(). Tests pass a fixed value. */
  readonly now_ms?: EpochMs;
}

/** Output common to both providers. */
export interface ParseResult {
  readonly provider: Provider;
  /** One entry per (provider, key, chain). Replayed copies are present with role `replayed` (R4.7). Unsorted. */
  readonly responses: readonly Response[];
  /** Keyless or unverified-version records that act as excluded requests between P and C (R6.2). */
  readonly excluded: readonly ExcludedRecord[];
  readonly coverage: CoverageCounters;
  readonly conflicts: readonly DedupConflict[];
  /** R5.3 to R5.6. One per agent chain. */
  readonly links: readonly Link[];
  readonly streams: readonly Stream[];
  readonly files: readonly FileInfo[];
  /** Assumption codes the parse itself requires (for example `unverified_version`, `mtime_prefilter_on`). */
  readonly assumptions: readonly Assumption[];
}

export interface ClaudeParseResult extends ParseResult {
  readonly provider: "claude";
  readonly responses: readonly ClaudeResponse[];
  /** Global uuid index for R6.3 and R11.7. Keyed by uuid. */
  readonly uuid_index: ReadonlyMap<string, ClaudeUuidNode>;
  readonly compact_boundaries: readonly ClaudeCompactBoundary[];
  readonly prefix_hints: readonly AgentPrefixHint[];
  readonly cost_state: readonly CostStateUsage[];
}

export interface CodexParseResult extends ParseResult {
  readonly provider: "codex";
  readonly responses: readonly CodexResponse[];
  readonly compactions: readonly CodexCompaction[];
  readonly thread_totals: readonly CodexThreadTotal[];
  /** R4.13: ids that occur as `forked_from_id` anywhere in the scan (internal, never exported). */
  readonly forked_from_ids: ReadonlySet<string>;
}

/**
 * parseClaude(files, opts): reads `claude-*` files of the DiscoveredFile list (main, subagent, meta, prefix,
 * workflow journal and run files), applies R1 to R5. Never throws on bad input: failures become coverage
 * counters (R1.3, R17.1). Codex files in `files` are ignored.
 */
export type ParseClaude = (files: readonly DiscoveredFile[], opts?: ParseOptions) => Promise<ClaudeParseResult>;

/** parseCodex(files, opts): reads `codex-*` files, plain and archived `.zst` (R0.2, R15.7). Claude files are ignored. */
export type ParseCodex = (files: readonly DiscoveredFile[], opts?: ParseOptions) => Promise<CodexParseResult>;

// ---------------------------------------------------------------------------
// 9. Graph
// ---------------------------------------------------------------------------

/** R9.2 chain TTL set up to and including `P`. */
export interface TtlSet {
  readonly has_5m: boolean;
  readonly has_1h: boolean;
  /** `ttl_unknown` flag of R9.2. */
  readonly ttl_unknown: boolean;
}

/** R6.6 gap bounds between P and C in milliseconds. `null` is unknown, never replaced by a default. */
export interface GapBounds {
  /** Clamped to 0 when negative. */
  readonly min_ms: number | null;
  readonly max_ms: number | null;
  readonly basis: GapBasis;
}

/**
 * Per-response graph facts. `Graph.nodes[i]` belongs to `Graph.responses[i]`. These are structural facts only:
 * the eligibility checks, boundary choice and numeric condition are computed later (R7).
 */
export interface GraphNode {
  /** Index into Graph.responses. */
  readonly response: number;
  /** Index into Graph.chains. */
  readonly chain: number;
  /** 0-based position in the chain order of R6.1. */
  readonly seq: number;
  /** Response index of `P(C)` (R6.2), null when C is first in its logical stream. May be a replayed response. */
  readonly prev: number | null;
  /** `P` exists and is a replayed request (R4.8, R7.2 E1). */
  readonly prev_is_replayed: boolean;
  /** An excluded request or record lies between P and C (R6.2, `gap_has_excluded`). */
  readonly excluded_between: boolean;
  /** Equal event time with a neighbour (R6.1, `order_tie`). */
  readonly order_tie: boolean;
  /** C's event time is inside the report window (R5.9, R5.10). */
  readonly in_window: boolean;
  /** R9.2 set over the stream up to and including P. Null when there is no P. */
  readonly ttl_set: TtlSet | null;
  /** R6.6. Null when there is no P. */
  readonly gap: GapBounds | null;
}

export interface Chain {
  readonly key: ChainKey;
  readonly kind: RequestKind;
  readonly link: Link | null;
  readonly stream: Stream;
  /** Response indices (into Graph.responses) in the order of R6.1: (event_time asc, key asc). */
  readonly order: readonly number[];
}

export interface Graph {
  readonly window: TimeWindow;
  readonly responses: readonly Response[];
  readonly nodes: readonly GraphNode[];
  readonly chains: readonly Chain[];
  readonly files: readonly FileInfo[];
  readonly excluded: readonly ExcludedRecord[];
  readonly claude: {
    readonly uuid_index: ReadonlyMap<string, ClaudeUuidNode>;
    readonly compact_boundaries: readonly ClaudeCompactBoundary[];
  };
  readonly codex: {
    readonly compactions: readonly CodexCompaction[];
  };
  /** Assumption codes carried from the parsers. */
  readonly assumptions: readonly Assumption[];
}

export interface GraphOptions {
  readonly window: TimeWindow;
}

/** buildGraph(parse results, opts): ownership, chain order, P(C), ties, excluded-between, TTL sets, gap bounds. */
export type BuildGraph = (parsed: readonly ParseResult[], opts: GraphOptions) => Graph;

// ---------------------------------------------------------------------------
// 10. Pricing results
// ---------------------------------------------------------------------------

/**
 * A priced amount. `pico` is the BigInt in picodollars (R3.8); `usd` is its decimal string, the serialization of
 * R14.5. Invariant: `usd === (pico === null ? null : pico.toString())`. Use `pricedAmount` to build one.
 */
export interface PricedAmount {
  readonly pico: Pico | null;
  readonly usd: DecimalString | null;
  /** Why `pico` is null. Null when priced. */
  readonly reason: UnpricedReason | null;
}

export const UNPRICED_REASONS = [
  "excluded", // response has no usable counters (exclusion != null)
  "not_owner", // replayed copy, counts zero (R4.7)
  "model_unknown", // model not verified (R2.10)
  "unknown_model", // no table row (R3.3)
  "unpriced_modifier", // see PricedResponse.modifier_reason
  "output_unknown", // only for the output term, R2.3
] as const;
export type UnpricedReason = (typeof UNPRICED_REASONS)[number];

export function pricedAmount(pico: Pico | null, reason: UnpricedReason | null = null): PricedAmount {
  return { pico, usd: pico === null ? null : pico.toString(), reason: pico === null ? (reason ?? "excluded") : null };
}

/** Which table row priced the response (R3.4). */
export const PRICE_ROW_KINDS = ["standard", "fast", "haiku_high", "long_context", "service_tier"] as const;
export type PriceRowKind = (typeof PRICE_ROW_KINDS)[number];

/** Rates actually applied, in 1e-6 USD per MTok, plus the geo multiplier. Needed by the delta (R8.5, R8.6). */
export interface ResolvedRates {
  readonly row: PriceRowKind;
  readonly input: bigint;
  readonly output: bigint;
  readonly cache_read: bigint;
  readonly cache_write_5m: bigint | null;
  readonly cache_write_1h: bigint | null;
  readonly cache_write: bigint | null;
  /** 1/1 or C32 (R3.8). Applied once to the sum. */
  readonly geo: Rational;
}

export interface PricedResponse {
  readonly provider: Provider;
  readonly key: string;
  readonly chain: ChainKey;
  readonly table_version: string;
  /**
   * Total cost (R3.5, R3.6). When `cost_hi` is non-null this is the low end (unknown TTL write priced at 5m).
   * The output term is omitted when output is unknown (`output_excluded`).
   */
  readonly cost: PricedAmount;
  /** High end of the range for `w_unknown_ttl` (R3.5). Null when there is no such write. */
  readonly cost_hi: PricedAmount | null;
  /** Output term left out because output is unknown (R2.3, R16.1). */
  readonly output_excluded: boolean;
  readonly modifier_reason: UnpricedModifierReason | null;
  /** Null when unpriced. */
  readonly rates: ResolvedRates | null;
  /** Tokens of this response counted as unpriced (R3.9). 0 when priced. */
  readonly tokens_unpriced: Tokens;
}

/** loadPriceBook(table): validates R3.2, R3.11 and prepares the integer price units (R3.8). Throws on a malformed table. */
export type LoadPriceBook = (table: PricingTable) => PriceBook;

/**
 * priceResponse(response, book): decides on the response alone (R3.10: no dependence on any other response).
 * Never throws. An excluded or replayed response yields an unpriced amount with the matching reason.
 */
export type PriceResponse = (response: Response, book: PriceBook, opts?: PriceOptions) => PricedResponse;

/**
 * Test-only pricing parameter (R3.4 Codex service tier). `codex_tier_for_test: "standard"` marks the Codex tier as
 * verified Standard so that the row selection of R3.6 and R3.10 can be exercised. It is never an environment
 * variable, a CLI flag or a log field.
 */
export interface PriceOptions {
  readonly codex_tier_for_test?: "standard";
}

// ---------------------------------------------------------------------------
// 11. Boundaries and rebuild events (placeholders: fields only, logic comes later)
// ---------------------------------------------------------------------------

/** One candidate cause (R11.4, R14.5). */
export interface CauseCandidate {
  readonly cause: Cause;
  readonly level: EvidenceLevel;
  /** Present iff level is `hypothesis` (R11.1). */
  readonly confidence: Confidence | null;
  readonly signals: readonly Signal[];
}

/** R8.1 to R8.6. All token and money values are BigInt. */
export interface EventDelta {
  /** `L`, unconditional upper bound. */
  readonly tokens_upper: Tokens;
  /** `L_pm`, conditional on read_region_is_prefix_of_previous. */
  readonly tokens_upper_if_prefix_match: Tokens;
  /** Always 0 (R8.2). */
  readonly tokens_lower: 0n;
  /** `L_if_unchanged` or null (R8.2). */
  readonly tokens_if_unchanged: Tokens | null;
  readonly usd_hi: Pico | null;
  readonly usd_if_unchanged_lo: Pico | null;
  readonly usd_point: Pico | null;
  readonly status: DeltaStatus;
  readonly reasons: readonly DeltaReason[];
}

export type LinkageKind = LinkState | "not_applicable";

/** Fields shared by events and boundaries (R14.5). */
export interface PairRef {
  readonly provider: Provider;
  readonly kind: RequestKind;
  readonly chain: ChainKey;
  /** Normalized model of C (R3.3). Null only for tokens-only boundaries whose model is unverified. */
  readonly model: string | null;
  /** Response index of C into Graph.responses. */
  readonly current: number;
  /** Response index of P, null for first-in-chain boundaries. */
  readonly previous: number | null;
  readonly t_ms: EpochMs;
  readonly linkage: LinkageKind;
  readonly model_source: ModelSource;
  readonly gap_basis: GapBasis;
}

/** Suspected prefix rebuild (R7.5 outcome `suspect`). Ids (`e<N>`) are assigned at output time. */
export interface RebuildEvent extends PairRef {
  readonly outcome: "suspect";
  readonly gap_min_ms: number | null;
  readonly gap_max_ms: number | null;
  /** `K_prev`, `K_hi_prev`, `R`, `W`, `U`, `D` (R7.1, R7.5). */
  readonly k_prev: Tokens;
  readonly k_hi_prev: Tokens;
  readonly r: Tokens;
  readonly w: Tokens;
  readonly u: Tokens;
  readonly d: Tokens;
  /** Display only (R2.16, R7.5). No decision reads it. */
  readonly reuse_ratio: number;
  readonly ttl_class: TtlClass;
  readonly expiry: ExpiryStatus;
  readonly candidates: readonly CauseCandidate[];
  /** Null when the top two candidates tie (R11.4). */
  readonly primary: Cause | null;
  readonly diag: Diagnostics | null;
  readonly delta: EventDelta;
  readonly tags: readonly PairTag[];
  readonly assumptions: readonly Assumption[];
}

/** Cache boundary (R11.6, R11.8). Gets no rebuild delta (R8.7). */
export interface Boundary extends PairRef {
  readonly type: BoundaryType;
  /** Cache read of C (R14.5). */
  readonly r: Tokens;
  readonly tags: readonly PairTag[];
}

/** Verdict of the detector for one pair (R7.8). */
export type PairVerdict =
  | { readonly outcome: "no_event"; readonly current: number; readonly tags: readonly PairTag[] }
  | { readonly outcome: "event"; readonly current: number; readonly event: RebuildEvent }
  | { readonly outcome: "abstain"; readonly current: number; readonly code: AbstainCode }
  | { readonly outcome: "boundary"; readonly current: number; readonly boundary: Boundary };

export interface DetectionResult {
  /** One verdict per response with a P or a first-in-chain boundary question; order follows Graph.responses. */
  readonly verdicts: readonly PairVerdict[];
  readonly events: readonly RebuildEvent[];
  readonly boundaries: readonly Boundary[];
  /** Counters the detector adds: pairs_*, requests_gate_abstained*, requests_priced (R7.8). */
  readonly coverage: CoverageCounters;
  readonly assumptions: readonly Assumption[];
}

/** detectEvents(graph, priced, book): sections 7 to 11. Placeholder signature, owned by a later worker. */
export type DetectEvents = (graph: Graph, priced: readonly PricedResponse[], book: PriceBook) => DetectionResult;

// ---------------------------------------------------------------------------
// 12. CLI report input
// ---------------------------------------------------------------------------

/** Token sums by bucket over a set of responses (R2.16: BigInt). */
export interface BucketSums {
  readonly input_uncached: Tokens;
  readonly cache_read: Tokens;
  readonly cache_write_5m: Tokens;
  readonly cache_write_1h: Tokens;
  readonly cache_write_unknown_ttl: Tokens;
  readonly cache_write: Tokens;
  readonly output: Tokens;
  /** Sum of `output_lower_bound` for requests with unknown output (R2.3). Not part of `output`. */
  readonly output_lower_bound_unknown: Tokens;
}

/**
 * Totals of one model of one provider. `model` is a normalized table id (R3.3), `unlisted` for a verified model
 * that has no table row, and `null` when the model is not verified (R2.10).
 */
export interface ModelTotals {
  readonly model: string | null;
  readonly responses: number;
  readonly requests_priced: number;
  readonly tokens: BucketSums;
  readonly total_input: Tokens;
  /** `total_input` plus output (the lower bound where the output is unknown): the denominator of R3.9. */
  readonly tokens_total: Tokens;
  readonly usd_pico: Pico | null;
  readonly usd_pico_hi: Pico | null;
  readonly tokens_unpriced: Tokens;
  readonly output_unknown: number;
}

/** Per-provider totals (R14.5 `totals`). Sums run over `countsInTotals` responses inside the window (R5.8, R5.10). */
export interface ProviderTotals {
  readonly provider: Provider;
  readonly requests_by_kind: Readonly<Record<RequestKind, number>>;
  readonly requests_total: number;
  readonly requests_priced: number;
  readonly tokens: BucketSums;
  /** `total_input` of R2.2 summed. */
  readonly total_input: Tokens;
  /** `total_input` plus `output` plus `output_lower_bound_unknown`: the denominator of R3.9. */
  readonly tokens_total: Tokens;
  /** One row per model, sorted by model id; the unverified row (`null`) last. */
  readonly models: readonly ModelTotals[];
  /** Picodollars, low end. Null when nothing was priced. */
  readonly usd_pico: Pico | null;
  /** High end when unknown-TTL writes exist (R3.5), else equal to `usd_pico`. */
  readonly usd_pico_hi: Pico | null;
  readonly tokens_unpriced: Tokens;
  /** Responses with unknown output (R16.1 `V`). */
  readonly output_unknown: number;
}

/** Numbers of the R16.1 headline template, named as there. Ratios stay as num/den. */
export interface HeadlineFigures {
  readonly n_total: number;
  readonly n_main: number;
  readonly n_sub: number;
  readonly n_wf: number;
  readonly n_cx: number;
  /** Cache read share: `cache_read / total_input` (R2.2). Per provider too (R16.2). */
  readonly cache_read: Tokens;
  readonly total_input: Tokens;
  readonly by_provider: Readonly<Record<Provider, { readonly cache_read: Tokens; readonly total_input: Tokens }>>;
  readonly usd_pico: Pico | null;
  readonly n_priced: number;
  readonly tokens_unpriced: Tokens;
  readonly tokens_total: Tokens;
  /** Per provider, for the `partial` prefix (R3.9). */
  readonly partial_by_provider: Readonly<Record<Provider, boolean>>;
  readonly output_unknown: number;
  /** Boundaries b1..b5 (R16.1). */
  readonly boundaries: Readonly<Record<BoundaryType, number>>;
  /** E, E_elig, E_abs, E_grey. */
  readonly events: number;
  readonly pairs_eligible: number;
  readonly pairs_abstained: number;
  readonly pairs_grey: number;
  /** By evidence (R16.1, R16.3, R11.9). */
  readonly by_evidence: {
    readonly confirmed: number;
    readonly hypothesis: number;
    readonly high: number;
    readonly medium: number;
    readonly low: number;
    readonly unknown: number;
  };
  /** Aggregates of R8.8 over EV_all, EV_d, EV_t, EV_c. */
  readonly e_d: number;
  readonly e_t: number;
  readonly e_cond: number;
  readonly l_all: Tokens;
  readonly l_d: Tokens;
  readonly l_t: Tokens;
  readonly hi_d: Pico;
  readonly hi_c: Pico;
  readonly clo_c: Pico;
}

export const REPORT_COMMANDS = ["default", "session", "evidence", "doctor", "pricing"] as const;
export type ReportCommand = (typeof REPORT_COMMANDS)[number];

export interface ReportOptions {
  readonly command: ReportCommand;
  readonly json: boolean;
  /** Raw ids to the terminal only; rejected with json or evidence (R14.4). */
  readonly show_ids: boolean;
  readonly demo: boolean;
  readonly color: boolean;
  /** Test only: fixed salt for opaque ids (R4.10). Not an env variable or CLI flag. */
  readonly salt_for_tests?: Uint8Array;
}

/**
 * Everything the report layer needs. Built by the analysis pipeline, consumed by the renderer and the
 * `cachewhy/1` JSON writer (R14.5). It holds raw ids inside `chain` and `responses`; the writer maps them to
 * opaque ids and converts every BigInt to a decimal string.
 */
export interface ReportInput {
  readonly schema: typeof SCHEMA_ID;
  readonly spec: typeof SPEC_ID;
  readonly generated_at_ms: EpochMs;
  readonly tool_version: string;
  readonly table_version: string;
  readonly window: TimeWindow;
  readonly headline_status: HeadlineStatus;
  readonly withheld_reason: DriftCode | null;
  readonly drift: readonly DriftFinding[];
  readonly assumptions: readonly Assumption[];
  /** Merged coverage (R17.2) and the per-provider parts (drift codes are per provider). */
  readonly coverage: CoverageCounters;
  readonly coverage_by_provider: Readonly<Record<Provider, CoverageCounters>>;
  readonly totals: readonly ProviderTotals[];
  readonly headline: HeadlineFigures;
  readonly graph: Graph;
  readonly priced: readonly PricedResponse[];
  readonly events: readonly RebuildEvent[];
  readonly boundaries: readonly Boundary[];
  readonly options: ReportOptions;
}

/** Arguments of buildReportInput. The parse results carry the coverage counters of the scan. */
export interface ReportBuildArgs {
  readonly graph: Graph;
  readonly parsed: readonly ParseResult[];
  readonly priced: readonly PricedResponse[];
  readonly detection: DetectionResult;
  readonly book: PriceBook;
  readonly options: ReportOptions;
  readonly generated_at_ms: EpochMs;
  readonly tool_version: string;
}

/** buildReportInput(args): headline figures, totals, coverage, drift, assumptions. */
export type BuildReportInput = (args: ReportBuildArgs) => ReportInput;

/** renderReport(input): the terminal text (headline of R16.1, or the withheld line of R16.5, plus coverage, R17.2). */
export type RenderReport = (input: ReportInput) => string;

/** The full pipeline as one set of signatures, for wiring in the CLI and for test doubles. */
export interface CachewhyModules {
  readonly parseClaude: ParseClaude;
  readonly parseCodex: ParseCodex;
  readonly buildGraph: BuildGraph;
  readonly loadPriceBook: LoadPriceBook;
  readonly priceResponse: PriceResponse;
  readonly detectEvents: DetectEvents;
  readonly buildReportInput: BuildReportInput;
  readonly renderReport: RenderReport;
}
