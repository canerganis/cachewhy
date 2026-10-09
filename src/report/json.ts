// The `cachewhy/1` JSON writer (R14.3, R14.5). Every output string goes through the allowlist serializer of
// `util/sanitize.ts`: values are copied only into declared fields, every string is an enum, a tool-generated id, a
// bounded model id or version, or an ISO instant, and every BigInt is a decimal string (R17.1). A new field needs a
// schema entry here, a test update and an allowlist entry (R14.3).
//
// Additions to the field list of R14.5 made for the accounting-only summary (documented here, covered by tests):
//   totals[].tokens_total, totals[].total_input, totals[].output_unknown, totals[].requests_priced,
//   totals[].models[] (per model rows, with model_verified), coverage.versions as an array of {version, lines},
//   coverage.chains_tainted_by_reason (R0.9, R17.1). There is no dollar range: a response is priced exactly or not at all
//   (R3.5).
// `events` and `boundaries` are empty arrays until sections 7 to 11 exist: the schema accepts no item, so adding one
// forces a schema change.
import {
  ASSUMPTIONS,
  COVERAGE_COUNT_FIELDS,
  COVERAGE_TOKEN_FIELDS,
  CONFLICT_KINDS,
  ABSTAIN_CODES,
  DRIFT_CODES,
  GATE_ABSTAIN_CODES,
  HEADLINE_STATUSES,
  PROVIDERS,
  REQUEST_KINDS,
  SCHEMA_ID,
  SPEC_ID,
  TAINT_REASONS,
  UNLINKED_REASONS,
  UNLOGGED_BUCKETS,
  UNPRICED_MODIFIER_REASONS,
  UNPRICED_TOKEN_REASONS,
} from "../model/types.js";
import type { CoverageCounters, DriftFinding, Provider, ProviderTotals, ReportInput } from "../model/types.js";
import { loadDefaultPriceBook } from "../pricing/index.js";
import { modelIdSchema, s, serialize, versionSchema } from "../util/sanitize.js";
import type { Schema } from "../util/sanitize.js";

const TABLE_VERSION_RE = /^pt-[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]+)?$/;

function intRecord<K extends string>(keys: readonly K[]): Schema {
  return s.object(Object.fromEntries(keys.map((k) => [k, s.int(0)])) as Record<string, Schema>);
}

/** A record of decimal strings (token amounts, R17.1), one entry per key. */
function decimalRecord<K extends string>(keys: readonly K[]): Schema {
  return s.object(Object.fromEntries(keys.map((k) => [k, s.decimal()])) as Record<string, Schema>);
}

function coverageSchema(): Schema {
  const fields: Record<string, Schema> = {};
  for (const f of COVERAGE_COUNT_FIELDS) fields[f] = s.int(0);
  for (const f of COVERAGE_TOKEN_FIELDS) fields[f] = s.decimal();
  fields["requests_unpriced_modifier_by_reason"] = intRecord(UNPRICED_MODIFIER_REASONS);
  // R3.9 revision 11.1: token amounts, so decimal strings (R17.1); the values sum to tokens_unpriced.
  fields["tokens_unpriced_by_reason"] = decimalRecord(UNPRICED_TOKEN_REASONS);
  fields["requests_conflict_by_kind"] = intRecord(CONFLICT_KINDS);
  fields["links_unlinked_by_reason"] = intRecord(UNLINKED_REASONS);
  fields["pairs_abstained_by_code"] = intRecord(ABSTAIN_CODES);
  fields["requests_gate_abstained_by_code"] = intRecord(GATE_ABSTAIN_CODES);
  // R0.9: a chain carrying several reasons counts once under each of them.
  fields["chains_tainted_by_reason"] = intRecord(TAINT_REASONS);
  // R17.5: signed decimal strings
  fields["unlogged_tokens_estimate"] = s.object(Object.fromEntries(UNLOGGED_BUCKETS.map((b) => [b, s.decimal()])));
  fields["versions"] = s.array(s.object({ version: versionSchema, lines: s.int(0) }), 64);
  return s.object(fields);
}

const SUM_FIELDS = [
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "cache_write_unknown_ttl",
  "cache_write",
  "output",
  "output_lower_bound_unknown",
] as const;

function tokensSchema(): Schema {
  return s.object(Object.fromEntries(SUM_FIELDS.map((f) => [f, s.decimal()])));
}

function totalsSchema(modelId: Schema): Schema {
  const model = s.object({
    // null: no model id is shown (unverified Codex). `unlisted`: not in the table (R3.3). A Claude row of a tainted
    // chain carries the candidate id with model_verified false (R0.9 effect 1).
    model: s.nullable(modelId),
    model_verified: s.boolean(),
    responses: s.int(0),
    requests_priced: s.int(0),
    tokens: tokensSchema(),
    total_input: s.decimal(),
    tokens_total: s.decimal(),
    usd: s.nullable(s.decimal()),
    tokens_unpriced: s.decimal(),
    output_unknown: s.int(0),
  });
  return s.object({
    provider: s.enum(PROVIDERS),
    requests_by_kind: intRecord(REQUEST_KINDS),
    requests_total: s.int(0),
    requests_priced: s.int(0),
    tokens: tokensSchema(),
    total_input: s.decimal(),
    tokens_total: s.decimal(),
    usd: s.nullable(s.decimal()),
    tokens_unpriced: s.decimal(),
    tokens_unpriced_by_reason: decimalRecord(UNPRICED_TOKEN_REASONS),
    output_unknown: s.int(0),
    models: s.array(model, 512),
  });
}

function reportSchema(modelId: Schema): Schema {
  return s.object({
    schema: s.const(SCHEMA_ID),
    generated_at: s.iso(),
    tool_version: s.pattern(/^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$/),
    spec: s.const(SPEC_ID),
    table_version: s.pattern(TABLE_VERSION_RE),
    window: s.object({ since: s.iso(), until: s.iso() }),
    headline_status: s.enum(HEADLINE_STATUSES),
    withheld_reason: s.nullable(s.enum(DRIFT_CODES)),
    // R17.3 revision 11.1: one entry per provider, the tripped code or null.
    withheld_by_provider: s.object(Object.fromEntries(PROVIDERS.map((p) => [p, s.nullable(s.enum(DRIFT_CODES))])) as Record<string, Schema>),
    assumptions: s.array(s.enum(ASSUMPTIONS), 64),
    coverage: coverageSchema(),
    totals: s.array(totalsSchema(modelId), 8),
    events: s.array(s.object({}), 0),
    boundaries: s.array(s.object({}), 0),
  });
}

function driftSchema(): Schema {
  return s.array(
    s.object({
      code: s.enum(DRIFT_CODES),
      provider: s.enum(PROVIDERS),
      numerator: s.decimal(),
      denominator: s.decimal(),
      tripped: s.boolean(),
    }),
    32,
  );
}

/** serialize() without the deep generic inference of Infer<Schema>. */
const ser = serialize as unknown as (schema: Schema, value: unknown) => unknown;

const iso = (ms: number): string => new Date(ms).toISOString();

/** Coverage in output form: `versions` becomes a sorted array. Pure. */
export function coverageToJson(c: CoverageCounters): Record<string, unknown> {
  const out: Record<string, unknown> = { ...c };
  out["versions"] = Object.entries(c.versions)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([version, lines]) => ({ version, lines }));
  return out;
}

/** Model ids allowed in the output: the ids of the price table (public facts) and `unlisted` (R3.3, R14.3). */
function allowedModelIds(known: ReadonlySet<string> | undefined): Schema {
  const ids = new Set<string>(["unlisted"]);
  for (const id of known ?? loadDefaultPriceBook().models.keys()) ids.add(id);
  return modelIdSchema(ids);
}

function totalsToJson(t: ProviderTotals, hideUsd: boolean): Record<string, unknown> {
  const usd = (x: bigint | null): bigint | null => (hideUsd ? null : x);
  return {
    provider: t.provider,
    requests_by_kind: t.requests_by_kind,
    requests_total: t.requests_total,
    requests_priced: t.requests_priced,
    tokens: t.tokens,
    total_input: t.total_input,
    tokens_total: t.tokens_total,
    usd: usd(t.usd_pico),
    tokens_unpriced: t.tokens_unpriced,
    tokens_unpriced_by_reason: t.tokens_unpriced_by_reason,
    output_unknown: t.output_unknown,
    models: t.models.map((m) => ({
      model: m.model,
      model_verified: m.model_verified,
      responses: m.responses,
      requests_priced: m.requests_priced,
      tokens: m.tokens,
      total_input: m.total_input,
      tokens_total: m.tokens_total,
      usd: usd(m.usd_pico),
      tokens_unpriced: m.tokens_unpriced,
      output_unknown: m.output_unknown,
    })),
  };
}

/**
 * The report object in schema form. Throws a `SafeError` (code `E_SCHEMA_VIOLATION`, path only) if a value does not
 * fit its declared field. A provider whose headline is withheld (R17.3, per provider since revision 11.1) has no dollar figure written (R16.5): the usd of its totals and model rows is null, while the other provider keeps its dollars.
 */
export function reportToJson(input: ReportInput & { readonly shown_providers?: readonly Provider[] }, knownModels?: ReadonlySet<string>): unknown {
  // A provider hidden by `--agent` or `--project` is omitted: an all-zero entry would read as zero usage, which is
  // false (R5.9). A shown provider with no activity in the window keeps its zero entry.
  const shown = input.shown_providers ?? PROVIDERS;
  const value = {
    schema: input.schema,
    generated_at: iso(input.generated_at_ms),
    tool_version: input.tool_version,
    spec: input.spec,
    table_version: input.table_version,
    window: { since: iso(input.window.since_ms), until: iso(input.window.until_ms) },
    headline_status: input.headline_status,
    withheld_reason: input.withheld_reason,
    withheld_by_provider: input.withheld_by_provider,
    assumptions: input.assumptions,
    coverage: coverageToJson(input.coverage),
    totals: input.totals.filter((t) => shown.includes(t.provider)).map((t) => totalsToJson(t, input.withheld_by_provider[t.provider] !== null)),
    events: [],
    boundaries: [],
  };
  return ser(reportSchema(allowedModelIds(knownModels)), value);
}

export function reportToJsonText(input: ReportInput & { readonly shown_providers?: readonly Provider[] }, knownModels?: ReadonlySet<string>, space = 2): string {
  return JSON.stringify(reportToJson(input, knownModels), null, space);
}

/** Coverage and drift only, for `doctor --json` (R14.6: the doctor prints coverage and drift counters only). */
export function doctorCoverageToJson(coverage: CoverageCounters, drift: readonly DriftFinding[]): { coverage: unknown; drift: unknown } {
  return {
    coverage: ser(coverageSchema(), coverageToJson(coverage)),
    drift: ser(
      driftSchema(),
      drift.map((d) => ({ code: d.code, provider: d.provider, numerator: d.numerator, denominator: d.denominator, tripped: d.tripped })),
    ),
  };
}
