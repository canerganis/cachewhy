// Terminal text of the accounting-only summary. Only integers, BigInt quantities and enum codes are printed (R14.6);
// no id, path, model alias or free text reaches this module. Spec: R16.1 (headline lines, denominators always
// printed, the taint warning of C36), R16.2 (dollar and counterfactual lines never summed), R16.4 (forbidden words),
// R16.5 (withheld), R17.2, R0.9 (taint lines).
//
// G1 prints no boundary, event or delta line (sections 7 to 11 are not computed) and says so.
import { PROVIDERS, REQUEST_KINDS, UNPRICED_TOKEN_REASONS } from "../model/types.js";
import type { CoverageCounters, DriftFinding, HeadlineFigures, ModelTotals, Provider, ProviderTotals, ReportInput } from "../model/types.js";
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

/** A model row whose responses are not verified (R2.10, R0.9 effect 1) says so in its label. */
function modelLabel(m: ModelTotals): string {
  if (m.model === null) return "(model unverified)";
  return m.model_verified ? m.model : `${m.model} (unverified)`;
}

type TaintView = HeadlineFigures["taint_by_provider"][Provider];

/**
 * The accounting-only line of R16.1 (the "Suspected prefix rebuilds" line has no events to report in G1). Counts are
 * scan-wide: `--agent` and `--project` never change them (R5.9).
 */
function taintLine(t: TaintView): string {
  return `  Taint, whole scan: ${formatInt(t.chains_tainted)} of ${formatInt(t.chains_total)} chains tainted (R0.9), their ${formatInt(t.responses_in_tainted_chains)} responses tokens only; ${formatInt(t.families_live_skipped)} live session families skipped.`;
}

/**
 * R16.1 first line. Printed for every provider over C36, shown or hidden by `--agent` and `--project`, exactly as the
 * taint share lines are (the shares are scan-wide, R5.9), and then before every other line.
 */
function warningLines(h: HeadlineFigures): string[] {
  const out: string[] = [];
  for (const p of PROVIDERS) {
    const t = h.taint_by_provider[p];
    if (!t.warn) continue;
    out.push(
      `Warning: ${formatPercentBig(BigInt(t.families_tainted), BigInt(t.families_total))} of ${PROVIDER_LABEL[p]} session families and ${formatPercentBig(t.tokens_in_tainted_chains, t.tokens_total)} of ${PROVIDER_LABEL[p]} tokens are tainted (R0.9); dollars below cover only untainted chains, and no event or boundary is computed in this version.`,
    );
  }
  return out;
}

/**
 * R3.9 revision 11.1: the priced share of tokens and the unpriced tokens by reason, largest first (equal amounts in the
 * fixed enum order of `tokens_unpriced_by_reason`), every non-zero reason, each with its share of the
 * total tokens. Token facts, not dollars, so a withheld provider prints them too.
 */
export function pricedShareLine(t: ProviderTotals): string {
  const priced = t.tokens_total - t.tokens_unpriced;
  const head = `  Priced share: ${formatPercentBig(priced, t.tokens_total)} of tokens (${formatBig(priced)} of ${formatBig(t.tokens_total)})`;
  const top = UNPRICED_TOKEN_REASONS.map((k, i) => ({ k, i, n: t.tokens_unpriced_by_reason[k] }))
    .filter((x) => x.n > 0n)
    .sort((a, b) => (a.n === b.n ? a.i - b.i : a.n > b.n ? -1 : 1));
  if (top.length === 0) return `${head}; no unpriced tokens.`;
  return `${head}; unpriced by reason: ${top.map((x) => `${x.k} ${formatPercentBig(x.n, t.tokens_total)} (${formatBig(x.n)})`).join(", ")}.`;
}

function providerBlock(t: ProviderTotals, input: ReportInput, paint: Painter): string[] {
  const lines: string[] = [];
  const withheld = input.withheld_by_provider[t.provider] !== null;
  const partial = input.headline.partial_by_provider[t.provider];
  lines.push(paint("bold", withheld ? `${PROVIDER_LABEL[t.provider]} (unverified)` : PROVIDER_LABEL[t.provider]));
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
  const unknownOutput = t.output_unknown > 0 ? `; ${formatInt(t.output_unknown)} responses with unknown output are unpriced` : "";
  if (withheld) {
    lines.push(`  List-price equivalent: not printed (headline withheld); ${unpricedShare}${unknownOutput}.`);
  } else if (t.usd_pico === null) {
    lines.push(`  List-price equivalent: none priced, 0 of ${formatInt(t.requests_total)} responses; ${unpricedShare}${unknownOutput}.`);
  } else {
    lines.push(
      `  List-price equivalent: ${partial ? "partial " : ""}${formatUsdPico(t.usd_pico)} at table ${input.table_version} over ${formatInt(t.requests_priced)} of ${formatInt(t.requests_total)} responses; ${unpricedShare}${unknownOutput}.`,
    );
  }
  lines.push(pricedShareLine(t));
  lines.push(taintLine(input.headline.taint_by_provider[t.provider]));
  if (t.models.length > 0) {
    const rows = t.models.map((m) => [
      modelLabel(m),
      formatInt(m.responses),
      formatBig(m.tokens.input_uncached),
      formatBig(m.tokens.cache_read),
      formatBig(m.tokens.cache_write_5m + m.tokens.cache_write_1h + m.tokens.cache_write_unknown_ttl + m.tokens.cache_write),
      formatBig(m.tokens.output),
      withheld || m.usd_pico === null ? "-" : formatUsdPico(m.usd_pico),
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
          { header: "List-price equivalent", align: "right" },
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
  { label: "chains", get: (c) => c.chains_total, always: true },
  { label: "chains tainted (R0.9)", get: (c) => c.chains_tainted, always: true },
  { label: "session families", get: (c) => c.families_total, always: true },
  { label: "session families tainted", get: (c) => c.families_tainted, always: true },
  { label: "responses in tainted chains", get: (c) => c.responses_in_tainted_chains, always: true },
  { label: "tokens in tainted chains", get: (c) => c.tokens_in_tainted_chains, always: true },
  { label: "requests unpriced by taint", get: (c) => c.requests_unpriced_tainted, always: true },
  { label: "live session families skipped", get: (c) => c.families_live_skipped, always: true },
  { label: "responses of live families skipped", get: (c) => c.responses_live_skipped },
  { label: "tokens of live families skipped", get: (c) => c.tokens_live_skipped },
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

/**
 * Coverage table, per provider (R17.2). Zero rows are shown only where a zero is informative. With `taint`, the
 * tainted shares are printed per provider in every report (R16.1).
 */
export function renderCoverage(
  by: Readonly<Record<Provider, CoverageCounters>>,
  drift: readonly DriftFinding[],
  paint: Painter,
  taint?: HeadlineFigures["taint_by_provider"],
): string {
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
    if (r.label === "chains tainted (R0.9)") rows.push(...breakdown("reason", by[providers[0] as Provider].chains_tainted_by_reason, providers, by, (c) => c.chains_tainted_by_reason));
  }
  const out: string[] = [paint("bold", "Coverage"), formatTable([{ header: "Counter" }, ...providers.map((p) => ({ header: PROVIDER_LABEL[p], align: "right" as const }))], rows)];
  if (taint) {
    for (const p of providers) {
      const t = taint[p];
      const fam = `${formatInt(t.families_tainted)} of ${formatInt(t.families_total)} session families (${formatPercentBig(BigInt(t.families_tainted), BigInt(t.families_total))})`;
      const tok = `${formatBig(t.tokens_in_tainted_chains)} of ${formatBig(t.tokens_total)} tokens (${formatPercentBig(t.tokens_in_tainted_chains, t.tokens_total)})`;
      out.push(`${PROVIDER_LABEL[p]} taint share: ${fam}, ${tok}.`);
    }
  }
  const tripped = drift.filter((d) => d.tripped);
  if (tripped.length > 0) {
    out.push(paint("yellow", `Drift: ${tripped.map((d) => `${d.code} (${d.provider})`).join(", ")}`));
  }
  return out.join("\n");
}

/**
 * The summary text. `shown_providers` (set by `buildReportInput`) lists the providers whose totals are printed under
 * `--agent` and `--project` (R5.9); without it every provider with data is printed.
 */
export function renderReport(input: ReportInput & { readonly shown_providers?: readonly Provider[] }): string {
  const paint = makePainter(input.options.color);
  const h = input.headline;
  const lines: string[] = [];
  const shown = input.shown_providers ?? PROVIDERS;
  // R16.5 revision 11.1: when one provider is closed and the other is not, one line per closed provider comes first.
  if (input.headline_status === "partial") {
    for (const p of PROVIDERS) {
      const code = input.withheld_by_provider[p];
      if (code !== null) {
        lines.push(`Headline withheld for ${PROVIDER_LABEL[p]}: ${code}; its tokens below are unverified and none of its dollars is printed.`);
      }
    }
  }
  // R16.1: the warning is the first line of the output when any provider of the scan is over C36.
  lines.push(...warningLines(h));
  lines.push(paint("bold", "cachewhy summary") + " (token and list-price-equivalent accounting; rebuild events, boundaries and causes are not computed yet)");
  lines.push(
    `Scan window ${iso(input.window.since_ms)} to ${iso(input.window.until_ms)} (UTC). ${formatInt(h.n_total)} responses: ${formatInt(h.n_main)} main, ${formatInt(h.n_sub)} subagent, ${formatInt(h.n_wf)} workflow, ${formatInt(h.n_cx)} Codex.`,
  );
  if (input.headline_status === "withheld") {
    lines.push(paint("yellow", `Headline withheld: ${input.withheld_reason ?? "unknown"}`) + ". Token accounting below is unverified and no dollar figure is printed.");
  }
  for (const t of input.totals) {
    if (!shown.includes(t.provider)) continue;
    if (t.requests_total === 0 && input.coverage_by_provider[t.provider].files_total === 0) continue;
    lines.push("");
    lines.push(...providerBlock(t, input, paint));
  }
  lines.push("");
  const cov = renderCoverage(input.coverage_by_provider, input.drift, paint, h.taint_by_provider);
  if (cov) lines.push(cov);
  else lines.push("No Claude or Codex responses found.");
  lines.push("", "Rebuild events, boundaries, causes and deltas are not computed in this version, so none is printed.");
  if (input.assumptions.length > 0) lines.push("", `Assumptions: ${input.assumptions.join(", ")}`);
  return lines.join("\n");
}
