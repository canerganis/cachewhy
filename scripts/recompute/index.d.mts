// Types for scripts/recompute/index.mjs. The implementation is plain JavaScript on purpose, so it shares no
// code with src/ (spec R13.1). This file only describes the exported API for TypeScript callers (the tests).

export const SPEC_ID: "spec-1";
export const RECOMPUTE_SCHEMA: "cachewhy-recompute/1";

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
  /** `strict` (default) applies R15.7. `all` treats every product version as supported (synthetic fixtures only). */
  versionPolicy?: "strict" | "all";
  /**
   * Test-only (R3.4): `standard` marks the Codex service tier as verified Standard so the row selection of R3.6 and
   * R3.10 runs. Without it every Codex response is unpriced with reason `modifier_unverified`. There is no CLI flag.
   */
  codexTierForTest?: "standard";
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

export type RecomputePrice =
  | { priced: true; lo: bigint; hi: bigint; output_excluded: boolean; tokens_unpriced: 0n }
  | { priced: false; reason: string; tokens_unpriced: bigint };

export interface RecomputeResponse {
  provider: "claude" | "codex";
  /** Raw request key. Internal to the process: toJson hashes it unless asked not to. */
  key: string;
  /** True for a unique, kept response in the window that adds to the totals. */
  counted: boolean;
  /** `counted` or `excluded:<reason>`. */
  status: string;
  kind?: string;
  model?: string | null;
  model_label?: string;
  model_source?: string;
  flags?: string[];
  buckets?: RecomputeBuckets;
  event_ms?: number | null;
  price?: RecomputePrice;
}

export interface RecomputeAgg {
  responses: number;
  responses_priced: number;
  responses_unpriced: number;
  responses_priced_without_output_term: number;
  tokens: Record<string, string>;
  context_tokens: string;
  tokens_total: string;
  tokens_unpriced: string;
  unpriced_share_exceeds_c24: boolean;
  reasoning_informational: string;
  usd_pico_lo: string;
  usd_pico_hi: string;
}

export interface RecomputeProvider {
  totals: RecomputeAgg;
  by_model: Record<string, RecomputeAgg>;
  by_kind: Record<string, RecomputeAgg>;
  unpriced_by_reason: Record<string, { responses: number; tokens_unpriced: string }>;
}

export interface RecomputeResult {
  schema: typeof RECOMPUTE_SCHEMA;
  spec: typeof SPEC_ID;
  table_version: string;
  version_policy: "strict" | "all";
  window: { since: string | null; until: string | null };
  price_mode: string;
  providers: { claude: RecomputeProvider; codex: RecomputeProvider };
  coverage: { claude: Record<string, unknown>; codex: Record<string, unknown> };
  /** Every keyed response seen, counted or excluded. Not part of the JSON unless asked for. */
  responses: RecomputeResponse[];
}

export interface RecomputeJson {
  schema: string;
  spec: string;
  table_version: string;
  version_policy: string;
  window: { since: string | null; until: string | null };
  price_mode: string;
  providers: RecomputeResult["providers"];
  coverage: RecomputeResult["coverage"];
  responses?: Array<Record<string, unknown>>;
}

export function recompute(opts?: RecomputeOptions): RecomputeResult;
/** Files in the layout of the fixture builder: `projects/...`, `sessions/...`, `archived_sessions/...`. */
export function recomputeFiles(
  files: ReadonlyArray<{ path: string; content: string | Uint8Array }>,
  opts?: RecomputeOptions,
): RecomputeResult;
export function toJson(result: RecomputeResult, opts?: { perResponse?: boolean; rawKeys?: boolean }): RecomputeJson;
