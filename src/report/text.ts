// Terminal text of the accounting-only summary. Only integers, BigInt quantities and enum codes are printed (R14.6);
// no id, path, model alias or free text reaches this module. Spec: R16.1 (headline lines, denominators always
// printed), R16.2 (dollar and counterfactual lines never summed), R16.4 (forbidden words), R16.5 (withheld), R17.2.
import { PROVIDERS, REQUEST_KINDS } from "../model/types.js";
import type { CoverageCounters, DriftFinding, ModelTotals, Provider, ProviderTotals, RenderReport, ReportInput } from "../model/types.js";
import { formatBig, formatInt, formatPercentBig, formatTable, formatUsdPico, makePainter } from "./format.js";
import type { Painter } from "./format.js";

const PROVIDER_LABEL: Record<Provider, string> = { claude: "Claude", codex: "Codex" };

const DENOMINATOR: Record<Provider, string> = {
  claude: "input + cache read + cache write",
  codex: "input",
};

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function usdRange(lo: bigint, hi: bigint | null): string {
  if (hi === null || hi === lo) return formatUsdPico(lo);
  return `${formatUsdPico(lo)} to ${formatUsdPico(hi)}`;
}

function modelLabel(m: ModelTotals): string {
  return m.model === null ? "(model unverified)" : m.model;
}

function providerBlock(t: ProviderTotals, input: ReportInput, paint: Painter): string[] {
  const lines: string[] = [];
  const withheld = input.headline_status === "withheld";
  const partial = input.headline.partial_by_provider[t.provider];
  lines.push(paint("bold", PROVIDER_LABEL[t.provider]));
  const kinds = REQUEST_KINDS.filter((k) => t.requests_by_kind[k] > 0).map((k) => `${formatInt(t.requests_by_kind[k])} ${k}`);
  lines.push(`  Responses: ${formatInt(t.requests_total)}${kinds.length > 0 ? ` (${kinds.join(", ")})` : ""}. Each request key counts once (replayed copies and baseline excluded).`);
  lines.push(
    `  Cache read: ${formatPercentBig(t.tokens.cache_read, t.total_input)} (${formatBig(t.tokens.cache_read)} of ${formatBig(t.total_input)} input tokens; ${DENOMINATOR[t.provider]}).`,
  );
  const unknownOut = t.output_unknown > 0 ? `; ${formatInt(t.output_unknown)} responses have unknown output (lower bound ${formatBig(t.tokens.output_lower_bound_unknown)} tokens, not included)` : "";
  lines.push(`  Output: ${formatBig(t.tokens.output)} tokens${unknownOut}.`);
  const writes = t.tokens.cache_write_5m + t.tokens.cache_write_1h + t.tokens.cache_write_unknown_ttl + t.tokens.cache_write;
  lines.push(`  Cache write: ${formatBig(writes)} tokens${t.provider === "claude" ? ` (5m ${formatBig(t.tokens.cache_write_5m)}, 1h ${formatBig(t.tokens.cache_write_1h)}, unknown TTL ${formatBig(t.tokens.cache_write_unknown_ttl)})` : ""}.`);
  const unpricedShare = `${formatPercentBig(t.tokens_unpriced, t.tokens_total)} of tokens unpriced (${formatBig(t.tokens_unpriced)} of ${formatBig(t.tokens_total)})`;
  if (withheld) {
    lines.push(`  List-price equivalent: not printed (headline withheld); ${unpricedShare}.`);
  } else if (t.usd_pico === null) {
    lines.push(`  List-price equivalent: none priced, 0 of ${formatInt(t.requests_total)} responses; ${unpricedShare}.`);
  } else {
    lines.push(
      `  List-price equivalent: ${partial ? "partial " : ""}${usdRange(t.usd_pico, t.usd_pico_hi)} at table ${input.table_version} over ${formatInt(t.requests_priced)} of ${formatInt(t.requests_total)} responses; ${unpricedShare}.`,
    );
  }
  if (t.models.length > 0) {
    const rows = t.models.map((m) => [
      modelLabel(m),
      formatInt(m.responses),
      formatBig(m.tokens.input_uncached),
      formatBig(m.tokens.cache_read),
      formatBig(m.tokens.cache_write_5m + m.tokens.cache_write_1h + m.tokens.cache_write_unknown_ttl + m.tokens.cache_write),
      formatBig(m.tokens.output),
      withheld || m.usd_pico === null ? "-" : usdRange(m.usd_pico, m.usd_pico_hi),
      formatBig(m.tokens_unpriced),
    ]);
    lines.push(
      formatTable(
        [
          { header: "Model" },
          { header: "Responses", align: "right" },
          { header: "Input", align: "right" },
          { header: "Cache read", align: "right" },
          { header: "Cache write", align: "right" },
          { header: "Output", align: "right" },
          { header: "List-price equiv.", align: "right" },
          { header: "Unpriced tokens", align: "right" },
        ],
        rows,
        { indent: "  " },
      ),
    );
  }
  return lines;
}

interface CovRow {
  readonly label: string;
  readonly get: (c: CoverageCounters) => number | bigint;
  /** Print the row even when both providers show 0. */
  readonly always?: boolean;
}

const COVERAGE_ROWS: readonly CovRow[] = [
  { label: "files scanned", get: (c) => c.files_total, always: true },
  { label: "files unreadable", get: (c) => c.files_unreadable, always: true },
  { label: "lines read", get: (c) => c.lines_total, always: true },
  { label: "lines that failed to parse", get: (c) => c.lines_parse_error, always: true },
  { label: "truncated last lines", get: (c) => c.lines_truncated_tail },
  { label: "lines of unlisted record types", get: (c) => c.unlisted_type_count },
  { label: "lines of unverified versions", get: (c) => c.lines_unverified_version, always: true },
  { label: "requests of unverified versions", get: (c) => c.requests_unverified_version },
  { label: "usage records without a key", get: (c) => c.records_unkeyed, always: true },
  { label: "API error records", get: (c) => c.api_error_records },
  { label: "conflicting requests", get: (c) => c.requests_conflict, always: true },
  { label: "requests with out-of-range counters", get: (c) => c.responses_usage_range_failed, always: true },
  { label: "requests with bucket mismatch", get: (c) => c.responses_bucket_mismatch },
  { label: "tokens in incomplete responses", get: (c) => c.tokens_in_incomplete_responses },
  { label: "tokens in invalid responses", get: (c) => c.tokens_in_invalid_responses },
  { label: "replayed requests excluded", get: (c) => c.replay_requests_excluded },
  { label: "replay ownership ambiguous", get: (c) => c.replay_ownership_ambiguous },
  { label: "responses with unverified model", get: (c) => c.responses_model_unverified, always: true },
  { label: "requests with unknown output", get: (c) => c.output_unknown_requests, always: true },
  { label: "requests with no table row", get: (c) => c.requests_unknown_model, always: true },
  { label: "requests unpriced by modifier", get: (c) => c.requests_unpriced_modifier, always: true },
  { label: "requests priced", get: (c) => c.requests_priced, always: true },
  { label: "baseline requests loaded", get: (c) => c.baseline_requests_loaded },
  { label: "links verified", get: (c) => c.links_verified },
  { label: "links directory only", get: (c) => c.links_directory_only },
  { label: "links unlinked", get: (c) => c.links_unlinked, always: true },
  { label: "streams", get: (c) => c.streams_total, always: true },
  { label: "streams integrity unverified", get: (c) => c.streams_integrity_unverified },
  { label: "streams ordinal unverified", get: (c) => c.streams_ordinal_unverified },
  { label: "fork prefixes unresolved", get: (c) => c.streams_fork_prefix_unresolved },
  { label: "files with stream conflict", get: (c) => c.files_stream_conflict },
  { label: "files with no stream", get: (c) => c.files_unassigned_stream },
  { label: "files copy exposed", get: (c) => c.files_copy_exposed },
  { label: "files with no response id", get: (c) => c.files_without_response_id },
];

function fmt(n: number | bigint): string {
  return typeof n === "bigint" ? formatBig(n) : formatInt(n);
}

function breakdown(label: string, rec: Readonly<Record<string, number>>, providers: readonly Provider[], by: Readonly<Record<Provider, CoverageCounters>>, pick: (c: CoverageCounters) => Readonly<Record<string, number>>): string[][] {
  const rows: string[][] = [];
  for (const k of Object.keys(rec)) {
    const vals = providers.map((p) => pick(by[p])[k] ?? 0);
    if (vals.every((v) => v === 0)) continue;
    rows.push([`  ${label}: ${k}`, ...vals.map((v) => formatInt(v))]);
  }
  return rows;
}

/** Coverage table, per provider (R17.2). Zero rows are shown only where a zero is informative. */
export function renderCoverage(by: Readonly<Record<Provider, CoverageCounters>>, drift: readonly DriftFinding[], paint: Painter): string {
  const providers = PROVIDERS.filter((p) => by[p].files_total > 0 || by[p].responses_total > 0);
  if (providers.length === 0) return "";
  const rows: string[][] = [];
  for (const r of COVERAGE_ROWS) {
    const vals = providers.map((p) => r.get(by[p]));
    if (!r.always && vals.every((v) => v === 0 || v === 0n)) continue;
    rows.push([r.label, ...vals.map(fmt)]);
    if (r.label === "conflicting requests") rows.push(...breakdown("kind", by[providers[0] as Provider].requests_conflict_by_kind, providers, by, (c) => c.requests_conflict_by_kind));
    if (r.label === "requests unpriced by modifier") rows.push(...breakdown("reason", by[providers[0] as Provider].requests_unpriced_modifier_by_reason, providers, by, (c) => c.requests_unpriced_modifier_by_reason));
    if (r.label === "links unlinked") rows.push(...breakdown("reason", by[providers[0] as Provider].links_unlinked_by_reason, providers, by, (c) => c.links_unlinked_by_reason));
  }
  const out: string[] = [paint("bold", "Coverage"), formatTable([{ header: "Counter" }, ...providers.map((p) => ({ header: PROVIDER_LABEL[p], align: "right" as const }))], rows)];
  const tripped = drift.filter((d) => d.tripped);
  if (tripped.length > 0) {
    out.push(paint("yellow", `Drift: ${tripped.map((d) => `${d.code} (${d.provider})`).join(", ")}`));
  }
  return out.join("\n");
}

export const renderReport: RenderReport = (input: ReportInput): string => {
  const paint = makePainter(input.options.color);
  const h = input.headline;
  const lines: string[] = [];
  lines.push(paint("bold", "cachewhy summary") + " (token and list-price-equivalent accounting; rebuild events and causes are not computed yet)");
  lines.push(
    `${iso(input.window.since_ms)} to ${iso(input.window.until_ms)} (UTC). ${formatInt(h.n_total)} responses: ${formatInt(h.n_main)} main, ${formatInt(h.n_sub)} subagent, ${formatInt(h.n_wf)} workflow, ${formatInt(h.n_cx)} Codex.`,
  );
  if (input.headline_status === "withheld") {
    lines.push(paint("yellow", `Headline withheld: ${input.withheld_reason ?? "unknown"}`) + ". Token accounting below is unverified and no dollar figure is printed.");
  }
  for (const t of input.totals) {
    if (t.requests_total === 0 && input.coverage_by_provider[t.provider].files_total === 0) continue;
    lines.push("");
    lines.push(...providerBlock(t, input, paint));
  }
  lines.push("");
  const cov = renderCoverage(input.coverage_by_provider, input.drift, paint);
  if (cov) lines.push(cov);
  else lines.push("No Claude or Codex responses found.");
  if (input.assumptions.length > 0) lines.push("", `Assumptions: ${input.assumptions.join(", ")}`);
  return lines.join("\n");
};
