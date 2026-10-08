// Report input builder: window totals, coverage (windowed where the spec says so), drift and headline status.
// Accounting only. Spec: docs/methodology.md R5.8 (single count), R5.10 (baseline), R3.8 and R3.9 (money, unpriced
// share), R17.1 to R17.6 (coverage), R17.3 (drift).
import { countedResponseIndices } from "../graph/index.js";
import {
  ASSUMPTIONS,
  CONSTANTS,
  DRIFT_CODES,
  PROVIDERS,
  REQUEST_KINDS,
  SCHEMA_ID,
  SPEC_ID,
  contextTokens,
  emptyCoverage,
  mergeCoverage,
} from "../model/types.js";
import type {
  Assumption,
  BoundaryType,
  BucketSums,
  BuildReportInput,
  Chain,
  CoverageCounters,
  DriftCode,
  DriftFinding,
  GraphNode,
  HeadlineFigures,
  ModelTotals,
  Provider,
  ProviderTotals,
  ReportInput,
  RequestKind,
  Response,
  UnpricedModifierReason,
} from "../model/types.js";
import { normalizeModelId } from "../pricing/index.js";

const ZERO_SUMS = (): { -readonly [K in keyof BucketSums]: bigint } => ({
  input_uncached: 0n,
  cache_read: 0n,
  cache_write_5m: 0n,
  cache_write_1h: 0n,
  cache_write_unknown_ttl: 0n,
  cache_write: 0n,
  output: 0n,
  output_lower_bound_unknown: 0n,
});

interface Acc {
  responses: number;
  priced: number;
  tokens: { -readonly [K in keyof BucketSums]: bigint };
  total_input: bigint;
  usd_lo: bigint;
  usd_hi: bigint;
  tokens_unpriced: bigint;
  output_unknown: number;
}

const newAcc = (): Acc => ({
  responses: 0,
  priced: 0,
  tokens: ZERO_SUMS(),
  total_input: 0n,
  usd_lo: 0n,
  usd_hi: 0n,
  tokens_unpriced: 0n,
  output_unknown: 0,
});

function tokensTotal(a: Acc): bigint {
  return a.total_input + a.tokens.output + a.tokens.output_lower_bound_unknown;
}

function modelRow(model: string | null, a: Acc): ModelTotals {
  return {
    model,
    responses: a.responses,
    requests_priced: a.priced,
    tokens: { ...a.tokens },
    total_input: a.total_input,
    tokens_total: tokensTotal(a),
    usd_pico: a.priced > 0 ? a.usd_lo : null,
    usd_pico_hi: a.priced > 0 ? a.usd_hi : null,
    tokens_unpriced: a.tokens_unpriced,
    output_unknown: a.output_unknown,
  };
}

/** R17.3. Ratios stay as numerator and denominator; each test is a BigInt cross multiplication (R2.16). */
export function computeDrift(byProvider: Readonly<Record<Provider, CoverageCounters>>): DriftFinding[] {
  const out: DriftFinding[] = [];
  const c10 = CONSTANTS.DRIFT_UNMAPPABLE;
  const c11 = CONSTANTS.DRIFT_INVARIANT;
  const finding = (code: DriftCode, provider: Provider, num: number, den: number, limit: { num: bigint; den: bigint } | null, force?: boolean): void => {
    const n = BigInt(num);
    const d = BigInt(den);
    // exceed: num/den > limit  <=>  num * limit.den > limit.num * den
    const tripped = force ?? (limit !== null && n * limit.den > limit.num * d);
    out.push({ code, provider, numerator: n, denominator: d, tripped });
  };
  for (const p of PROVIDERS) {
    const c = byProvider[p];
    const active = c.files_total > 0 || c.responses_total > 0 || c.records_usage_bearing > 0;
    if (!active) continue;
    finding("drift_unmappable", p, c.records_usage_unmappable, c.records_usage_bearing, c10);
    const invalid = c.responses_usage_invariant_failed + c.responses_usage_range_failed + c.responses_bucket_mismatch + c.requests_conflict_by_kind.key_conflict;
    finding("drift_invariant", p, invalid, c.responses_total, c11);
    finding("drift_no_key", p, c.records_unkeyed, c.records_usage_bearing, c10);
    if (p === "claude") {
      const trip = c.requests_with_final_marker === 0 && c.responses_total > CONSTANTS.NO_FINAL_MARKER_MIN;
      finding("drift_no_final_marker", p, c.requests_with_final_marker, c.responses_total, null, trip);
    } else {
      const bad = c.files_stream_conflict + c.files_unassigned_stream + c.files_copy_exposed;
      const filesTrip = BigInt(bad) * c10.den > c10.num * BigInt(c.files_total);
      const ordTrip = BigInt(c.streams_ordinal_unverified) * c10.den > c10.num * BigInt(c.streams_total);
      finding("drift_stream_integrity", p, bad, c.files_total, null, filesTrip || ordTrip);
    }
  }
  const order = (d: DriftFinding): number => PROVIDERS.indexOf(d.provider) * 10 + DRIFT_CODES.indexOf(d.code);
  return out.sort((a, b) => order(a) - order(b));
}

export const buildReportInput: BuildReportInput = (args): ReportInput => {
  const { graph, parsed, priced, detection, book, options } = args;
  const win = graph.window;
  const counted = countedResponseIndices(graph);

  const kindOf = (i: number): RequestKind => (graph.chains[(graph.nodes[i] as GraphNode).chain] as Chain).kind;
  const known = new Set(book.models.keys());

  const prov = {} as Record<Provider, {
    all: Acc;
    byModel: Map<string | null, Acc>;
    byKind: Record<RequestKind, number>;
    unknownModel: number;
    unpricedModifier: number;
    byModifier: Map<UnpricedModifierReason, number>;
    baseline: number;
    anyPriced: boolean;
  }>;
  for (const p of PROVIDERS) {
    prov[p] = {
      all: newAcc(),
      byModel: new Map(),
      byKind: Object.fromEntries(REQUEST_KINDS.map((k) => [k, 0])) as Record<RequestKind, number>,
      unknownModel: 0,
      unpricedModifier: 0,
      byModifier: new Map(),
      baseline: 0,
      anyPriced: false,
    };
  }

  // Baseline: owner responses before the window (R5.10).
  for (let i = 0; i < graph.responses.length; i++) {
    const r = graph.responses[i] as Response;
    if (r.exclusion === null && r.ownership.role === "owner" && r.time.event_ms < win.since_ms) prov[r.provider].baseline++;
  }

  for (const i of counted) {
    const r = graph.responses[i] as Response;
    const pr = priced[i];
    const u = r.usage;
    if (u === null || pr === undefined) continue;
    const pv = prov[r.provider];
    pv.byKind[kindOf(i)]++;
    const modelKey: string | null =
      r.model.verified && r.model.model !== null
        ? known.has(normalizeModelId(r.model.model))
          ? normalizeModelId(r.model.model)
          : "unlisted"
        : null;
    let m = pv.byModel.get(modelKey);
    if (m === undefined) pv.byModel.set(modelKey, (m = newAcc()));
    for (const a of [pv.all, m]) {
      a.responses++;
      a.tokens.input_uncached += u.input_uncached;
      a.tokens.cache_read += u.cache_read;
      a.tokens.cache_write_5m += u.cache_write_5m;
      a.tokens.cache_write_1h += u.cache_write_1h;
      a.tokens.cache_write_unknown_ttl += u.cache_write_unknown_ttl;
      a.tokens.cache_write += u.cache_write;
      if (u.output !== null) a.tokens.output += u.output;
      else {
        a.tokens.output_lower_bound_unknown += u.output_lower_bound;
        a.output_unknown++;
      }
      a.total_input += contextTokens(u);
      a.tokens_unpriced += pr.tokens_unpriced;
      if (pr.cost.pico !== null) {
        a.priced++;
        a.usd_lo += pr.cost.pico;
        a.usd_hi += (pr.cost_hi ?? pr.cost).pico ?? pr.cost.pico;
      }
    }
    if (pr.cost.pico !== null) pv.anyPriced = true;
    else if (pr.cost.reason === "unknown_model") pv.unknownModel++;
    else if (pr.cost.reason === "unpriced_modifier") {
      pv.unpricedModifier++;
      if (pr.modifier_reason !== null) pv.byModifier.set(pr.modifier_reason, (pv.byModifier.get(pr.modifier_reason) ?? 0) + 1);
    }
  }

  // Coverage per provider: the parser counters (scan-wide), with the window-scoped and graph-level counters replaced.
  const covBy = {} as Record<Provider, CoverageCounters>;
  for (const p of PROVIDERS) {
    const parts = parsed.filter((x) => x.provider === p).map((x) => x.coverage);
    covBy[p] = parts.reduce((acc, c) => mergeCoverage(acc, c), emptyCoverage());
  }
  for (const p of PROVIDERS) {
    const c = covBy[p];
    const pv = prov[p];
    // Unverified-version keys are scan-wide and never in the window (R15.7): keep that surplus.
    const surplus = Math.max(0, c.requests_total - c.responses_total);
    c.requests_total = pv.all.responses + surplus;
    c.requests_priced = pv.all.priced;
    c.requests_unknown_model = pv.unknownModel;
    c.requests_unpriced_modifier = pv.unpricedModifier;
    for (const [k, v] of pv.byModifier) c.requests_unpriced_modifier_by_reason[k] = v;
    for (const k of Object.keys(c.requests_unpriced_modifier_by_reason) as UnpricedModifierReason[]) {
      if (!pv.byModifier.has(k)) c.requests_unpriced_modifier_by_reason[k] = 0;
    }
    c.tokens_unpriced = pv.all.tokens_unpriced;
    c.output_unknown_requests = pv.all.output_unknown;
    c.baseline_requests_loaded = pv.baseline;
    // Links and streams come from the graph, after its cross-chain checks and merges (R5.3 to R5.7, R4.11).
    c.links_verified = 0;
    c.links_directory_only = 0;
    c.links_unlinked = 0;
    for (const k of Object.keys(c.links_unlinked_by_reason) as (keyof typeof c.links_unlinked_by_reason)[]) c.links_unlinked_by_reason[k] = 0;
    c.streams_total = 0;
    c.streams_integrity_unverified = 0;
    c.streams_ordinal_unverified = 0;
    c.streams_fork_prefix_unresolved = 0;
    for (const ch of graph.chains) {
      if (ch.key.provider !== p) continue;
      c.streams_total++;
      if (ch.stream.integrity_unverified) c.streams_integrity_unverified++;
      if (ch.stream.ordinal_verified === false) c.streams_ordinal_unverified++;
      if (ch.stream.fork !== null && !ch.stream.fork.prefix_resolved) c.streams_fork_prefix_unresolved++;
      const l = ch.link;
      if (l === null) continue;
      if (l.state === "verified") c.links_verified++;
      else if (l.state === "directory") c.links_directory_only++;
      else {
        c.links_unlinked++;
        if (l.reason !== null) c.links_unlinked_by_reason[l.reason]++;
      }
    }
  }
  const coverage = mergeCoverage(covBy.claude, covBy.codex);
  const drift = computeDrift(covBy);
  const tripped = drift.filter((d) => d.tripped);

  const totals: ProviderTotals[] = PROVIDERS.map((p) => {
    const pv = prov[p];
    const models = [...pv.byModel.entries()]
      .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0))
      .map(([k, a]) => modelRow(k, a));
    return {
      provider: p,
      requests_by_kind: pv.byKind,
      requests_total: pv.all.responses,
      requests_priced: pv.all.priced,
      tokens: { ...pv.all.tokens },
      total_input: pv.all.total_input,
      tokens_total: tokensTotal(pv.all),
      models,
      usd_pico: pv.all.priced > 0 ? pv.all.usd_lo : null,
      usd_pico_hi: pv.all.priced > 0 ? pv.all.usd_hi : null,
      tokens_unpriced: pv.all.tokens_unpriced,
      output_unknown: pv.all.output_unknown,
    };
  });

  const cl = prov.claude;
  const cx = prov.codex;
  const zeroBoundaries = {} as Record<BoundaryType, number>;
  for (const b of ["model_switch", "context_reset", "subagent_cold_start", "fork_inherit", "first_observation"] as const) zeroBoundaries[b] = 0;
  const tokensTotalAll = tokensTotal(cl.all) + tokensTotal(cx.all);
  const usdAll = cl.all.priced + cx.all.priced > 0 ? cl.all.usd_lo + cx.all.usd_lo : null;
  const headline: HeadlineFigures = {
    n_total: cl.all.responses + cx.all.responses,
    n_main: cl.byKind.main,
    n_sub: cl.byKind.subagent,
    n_wf: cl.byKind.workflow_agent,
    n_cx: cx.all.responses,
    cache_read: cl.all.tokens.cache_read + cx.all.tokens.cache_read,
    total_input: cl.all.total_input + cx.all.total_input,
    by_provider: {
      claude: { cache_read: cl.all.tokens.cache_read, total_input: cl.all.total_input },
      codex: { cache_read: cx.all.tokens.cache_read, total_input: cx.all.total_input },
    },
    usd_pico: usdAll,
    n_priced: cl.all.priced + cx.all.priced,
    tokens_unpriced: cl.all.tokens_unpriced + cx.all.tokens_unpriced,
    tokens_total: tokensTotalAll,
    // R3.9 with C24 = 1/10: tokens_unpriced > C24 * total_tokens  <=>  10 * unpriced > total
    partial_by_provider: {
      claude: 10n * cl.all.tokens_unpriced > tokensTotal(cl.all),
      codex: 10n * cx.all.tokens_unpriced > tokensTotal(cx.all),
    },
    output_unknown: cl.all.output_unknown + cx.all.output_unknown,
    boundaries: zeroBoundaries,
    events: 0,
    pairs_eligible: 0,
    pairs_abstained: 0,
    pairs_grey: 0,
    by_evidence: { confirmed: 0, hypothesis: 0, high: 0, medium: 0, low: 0, unknown: 0 },
    e_d: 0,
    e_t: 0,
    e_cond: 0,
    l_all: 0n,
    l_d: 0n,
    l_t: 0n,
    hi_d: 0n,
    hi_c: 0n,
    clo_c: 0n,
  };

  const assumptionSet = new Set<Assumption>([...graph.assumptions, ...detection.assumptions]);
  if (cl.anyPriced) assumptionSet.add("no_batch_assumed");
  if (cl.anyPriced || cx.anyPriced) assumptionSet.add("no_regional_surcharge_assumed");

  return {
    schema: SCHEMA_ID,
    spec: SPEC_ID,
    generated_at_ms: args.generated_at_ms,
    tool_version: args.tool_version,
    table_version: book.table_version,
    window: win,
    headline_status: tripped.length > 0 ? "withheld" : "ok",
    withheld_reason: tripped.length > 0 ? (tripped[0] as DriftFinding).code : null,
    drift,
    assumptions: ASSUMPTIONS.filter((a) => assumptionSet.has(a)),
    coverage,
    coverage_by_provider: covBy,
    totals,
    headline,
    graph,
    priced,
    events: detection.events,
    boundaries: detection.boundaries,
    options,
  };
};
