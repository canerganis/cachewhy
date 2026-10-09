// Report input builder: window totals, coverage (windowed where the spec says so), taint shares, drift and headline
// status. Accounting only. Spec: docs/methodology.md R5.8 (single count), R5.10 (baseline), R3.8 and R3.9 (money,
// unpriced share), R0.9 (taint effects and coverage), R16.1 (taint warning), R17.1 to R17.6 (coverage), R17.3 (drift).
//
// Scan-wide versus printed (R5.9): coverage, taint counters, drift and the taint warning are computed over every
// counted response of the scan. `--agent` and `--project` (the `ReportFilter`) narrow only `totals` and the headline
// figures, so a filter never changes a share or hides a tainted chain.
import { msToNs, windowContainsNs } from "../window.js";
import { countedResponseIndices } from "../graph/index.js";
import {
  ASSUMPTIONS,
  CONSTANTS,
  CONFLICT_KINDS,
  DRIFT_CODES,
  LEDGER_COUNT_FIELDS,
  PROVIDERS,
  REQUEST_KINDS,
  SCHEMA_ID,
  SPEC_ID,
  TAINT_REASONS,
  UNPRICED_TOKEN_REASONS,
  chainIdOf,
  contextTokens,
  emptyCoverage,
  mergeCoverage,
  responseTokens,
} from "../model/types.js";
import type {
  Assumption,
  BoundaryType,
  BucketSums,
  Chain,
  ChainId,
  CoverageCounters,
  DriftCode,
  DriftFinding,
  GraphNode,
  HeadlineFigures,
  ModelTotals,
  PricedResponse,
  Provider,
  ProviderTotals,
  ReportBuildArgs,
  ReportInput,
  RequestKind,
  Response,
  UnpricedModifierReason,
  UnpricedTokenReason,
} from "../model/types.js";

/** What is printed (R5.9). `chains` null means every chain of the shown providers. */
export interface ReportFilter {
  readonly providers: readonly Provider[];
  readonly chains: ReadonlySet<ChainId> | null;
}

/** The report input plus the providers whose totals are printed. */
export interface ReportView extends ReportInput {
  readonly shown_providers: readonly Provider[];
}

const ALL_PROVIDERS: ReportFilter = { providers: PROVIDERS, chains: null };

type Sums = { -readonly [K in keyof BucketSums]: bigint };

const ZERO_SUMS = (): Sums => ({
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
  tokens: Sums;
  total_input: bigint;
  usd: bigint;
  tokens_unpriced: bigint;
  /** R3.9 revision 11.1: `tokens_unpriced` split by the first gate that refused the response. */
  unpriced_by_reason: Record<UnpricedTokenReason, bigint>;
  output_unknown: number;
}

const zeroReasonTokens = (): Record<UnpricedTokenReason, bigint> =>
  Object.fromEntries(UNPRICED_TOKEN_REASONS.map((k) => [k, 0n])) as Record<UnpricedTokenReason, bigint>;

const newAcc = (): Acc => ({
  responses: 0,
  priced: 0,
  tokens: ZERO_SUMS(),
  total_input: 0n,
  usd: 0n,
  tokens_unpriced: 0n,
  unpriced_by_reason: zeroReasonTokens(),
  output_unknown: 0,
});

/**
 * R3.9 revision 11.1: the reason of an unpriced response is the first gate that refused it, which is the order of
 * `priceResponse`. `not_owner` and `excluded` responses carry no tokens here, so they add 0 under `excluded`.
 */
function unpricedReasonOf(pr: PricedResponse): UnpricedTokenReason | null {
  if (pr.cost.pico !== null) return null;
  switch (pr.cost.reason) {
    case "chain_tainted":
    case "model_unknown":
    case "unknown_model":
    case "excluded":
      return pr.cost.reason;
    case "unpriced_modifier":
      return pr.modifier_reason ?? "modifier_unverified";
    default:
      return "excluded"; // not_owner: zero tokens
  }
}

function tokensTotal(a: Acc): bigint {
  return a.total_input + a.tokens.output + a.tokens.output_lower_bound_unknown;
}

interface ModelAcc {
  readonly model: string | null;
  readonly verified: boolean;
  readonly acc: Acc;
}

interface ProvAcc {
  all: Acc;
  byModel: Map<string, ModelAcc>;
  byKind: Record<RequestKind, number>;
  unknownModel: number;
  unpricedModifier: number;
  byModifier: Map<UnpricedModifierReason, number>;
  baseline: number;
  anyPriced: boolean;
  /** R0.9 coverage: counted responses of tainted chains. */
  taintedResponses: number;
  taintedTokens: bigint;
  unpricedTainted: number;
  /** R2.10 / R17.1 responses_model_unverified: counted responses whose model is not verified, tainted chains included. */
  modelUnverified: number;
}

function modelRow(m: ModelAcc): ModelTotals {
  const a = m.acc;
  return {
    model: m.model,
    model_verified: m.verified,
    responses: a.responses,
    requests_priced: a.priced,
    tokens: { ...a.tokens },
    total_input: a.total_input,
    tokens_total: tokensTotal(a),
    usd_pico: a.priced > 0 ? a.usd : null,
    tokens_unpriced: a.tokens_unpriced,
    output_unknown: a.output_unknown,
  };
}

/**
 * C36 (R16.1): true iff the tainted share of families, or of tokens, is strictly above `TAINT_WARN_SHARE`.
 * `t/total > num/den` is tested as `t * den > num * total` in BigInt (R2.16).
 */
export function taintWarn(families_tainted: number, families_total: number, tokens_tainted: bigint, tokens_total: bigint): boolean {
  const limit = CONSTANTS.TAINT_WARN_SHARE;
  return BigInt(families_tainted) * limit.den > limit.num * BigInt(families_total) || tokens_tainted * limit.den > limit.num * tokens_total;
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
      // R17.3: Codex files in conflict, unassigned or copy exposed against C10 of Codex files, or Codex families that
      // hold a chain tainted with reason `ordinal_unverified` against C10 of Codex families (revision 11.1: families,
      // not chains, so one failing stream with many subagent threads is not read as a format change).
      const bad = c.files_stream_conflict + c.files_unassigned_stream + c.files_copy_exposed;
      const filesTrip = BigInt(bad) * c10.den > c10.num * BigInt(c.files_total);
      const ordTrip = BigInt(c.families_ordinal_unverified) * c10.den > c10.num * BigInt(c.families_total);
      finding("drift_stream_integrity", p, bad, c.files_total, null, filesTrip || ordTrip);
    }
  }
  const order = (d: DriftFinding): number => PROVIDERS.indexOf(d.provider) * 10 + DRIFT_CODES.indexOf(d.code);
  return out.sort((a, b) => order(a) - order(b));
}

export const buildReportInput = (args: ReportBuildArgs, filter: ReportFilter = ALL_PROVIDERS): ReportView => {
  const { graph, parsed, priced, detection, book, options } = args;
  const win = graph.window;
  const counted = countedResponseIndices(graph);

  const chainOf = (i: number): Chain => graph.chains[(graph.nodes[i] as GraphNode).chain] as Chain;
  const known = new Set(book.models.keys());

  /**
   * Model row key (R5.8, R0.9 effect 1). A verified model is keyed by its normalized id, or `unlisted` when the table
   * has no row (R3.3). An unverified Claude response keeps its candidate for the token breakdown (tainted chains
   * included) and is flagged `model_verified: false`; an unverified Codex response has no key (`null`).
   */
  const modelKey = (r: Response): { model: string | null; verified: boolean } => {
    const verified = r.model.verified && r.model.model !== null;
    const raw = verified ? r.model.model : r.provider === "claude" ? r.model.candidate : null;
    // S12.7: a Claude response with no model at all is keyed `unlisted` (R14.3); an unverified Codex one has no key.
    if (raw === null) return { model: r.provider === "claude" ? "unlisted" : null, verified };
    // S2.4: the id was normalized once at read time and is matched as is.
    return { model: known.has(raw) ? raw : "unlisted", verified };
  };

  /** One pass over the counted responses, restricted to the responses `keep` accepts. */
  const accumulate = (keep: (r: Response) => boolean): Record<Provider, ProvAcc> => {
    const prov = {} as Record<Provider, ProvAcc>;
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
        taintedResponses: 0,
        taintedTokens: 0n,
        unpricedTainted: 0,
        modelUnverified: 0,
      };
    }
    // Baseline: owner responses before the window (R5.10).
    for (let i = 0; i < graph.responses.length; i++) {
      const r = graph.responses[i] as Response;
      // S7.1, S12.5: before `since`, compared on the exact instant (BigInt)
      if (r.exclusion === null && r.ownership.role === "owner" && (r.time.event_ns ?? msToNs(r.time.event_ms)) < msToNs(win.since_ms) && keep(r)) prov[r.provider].baseline++;
    }
    for (const i of counted) {
      const r = graph.responses[i] as Response;
      const pr = priced[i];
      const u = r.usage;
      if (u === null || pr === undefined || !keep(r)) continue;
      const pv = prov[r.provider];
      pv.byKind[chainOf(i).kind]++;
      const mk = modelKey(r);
      const rowKey = `${mk.model ?? ""}|${mk.model === null ? "n" : "m"}|${mk.verified ? "v" : "u"}`;
      let m = pv.byModel.get(rowKey);
      if (m === undefined) pv.byModel.set(rowKey, (m = { model: mk.model, verified: mk.verified, acc: newAcc() }));
      for (const a of [pv.all, m.acc]) {
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
        const why = unpricedReasonOf(pr);
        if (why !== null) a.unpriced_by_reason[why] += pr.tokens_unpriced;
        if (pr.cost.pico !== null) {
          a.priced++;
          a.usd += pr.cost.pico;
        }
      }
      if (!r.model.verified) pv.modelUnverified++;
      if (chainOf(i).tainted) {
        pv.taintedResponses++;
        pv.taintedTokens += responseTokens(u);
      }
      if (pr.cost.pico !== null) pv.anyPriced = true;
      else if (pr.cost.reason === "unknown_model") pv.unknownModel++;
      else if (pr.cost.reason === "chain_tainted") pv.unpricedTainted++;
      else if (pr.cost.reason === "unpriced_modifier") {
        pv.unpricedModifier++;
        if (pr.modifier_reason !== null) pv.byModifier.set(pr.modifier_reason, (pv.byModifier.get(pr.modifier_reason) ?? 0) + 1);
      }
    }
    return prov;
  };

  const scan = accumulate(() => true);
  const shownSet = new Set<Provider>(filter.providers);
  const unfiltered = filter.chains === null && shownSet.size === PROVIDERS.length;
  const shown = unfiltered
    ? scan
    : accumulate((r) => shownSet.has(r.provider) && (filter.chains === null || filter.chains.has(chainIdOf(r.chain))));

  // Coverage per provider: the parser counters (scan-wide), with the window-scoped and graph-level counters replaced.
  const covBy = {} as Record<Provider, CoverageCounters>;

  /**
   * R17.3 "in the window" and R0.9 "removed from the analysis entirely": the logical counters of the ledger are rebuilt
   * from the entries whose event time is in [since, until) (an unknown time is in every window) and whose chain is not
   * in a live family. Drift and the printed coverage then speak of the same responses as the totals do.
   */
  const applyLedger = (c: CoverageCounters, p: Provider): void => {
    const chainsOf = graph.taint[p].chains;
    for (const f of LEDGER_COUNT_FIELDS) c[f] = 0;
    for (const k of CONFLICT_KINDS) c.requests_conflict_by_kind[k] = 0;
    c.tokens_in_incomplete_responses = 0n;
    c.tokens_in_invalid_responses = 0n;
    for (const x of parsed) {
      if (x.provider !== p) continue;
      for (const e of x.ledger) {
        // S7.1: an entry with a known instant is in the window iff since * 10^6 <= t < until * 10^6 (BigInt)
        const tNs = e.t_ns !== undefined ? e.t_ns : e.t_ms === null ? null : msToNs(e.t_ms);
        if (tNs !== null && !windowContainsNs(win, tNs)) continue;
        if (e.chain !== null && chainsOf.get(e.chain)?.live === true) continue;
        for (const f of LEDGER_COUNT_FIELDS) c[f] += e.n[f] ?? 0;
        if (e.conflict_kinds !== undefined) for (const k of e.conflict_kinds) c.requests_conflict_by_kind[k] += 1;
        if (e.tokens_incomplete !== undefined) c.tokens_in_incomplete_responses += e.tokens_incomplete;
        if (e.tokens_invalid !== undefined) c.tokens_in_invalid_responses += e.tokens_invalid;
      }
    }
  };
  for (const p of PROVIDERS) {
    const parts = parsed.filter((x) => x.provider === p).map((x) => x.coverage);
    covBy[p] = parts.reduce((acc, c) => mergeCoverage(acc, c), emptyCoverage());
  }
  for (const p of PROVIDERS) {
    const c = covBy[p];
    const pv = scan[p];
    applyLedger(c, p);
    // S12.2: the accounted responses of the window (owner, supported, not excluded, not live); unverified-version keys are
    // counted in requests_unverified_version only.
    c.requests_total = pv.all.responses;
    // R2.10: counted after the taint override (a tainted chain has no verified model), not from the parser's as-if-
    // untainted attribution, so it moves only with taint (R17.7).
    c.responses_model_unverified = pv.modelUnverified;
    c.requests_priced = pv.all.priced;
    c.requests_unknown_model = pv.unknownModel;
    c.requests_unpriced_modifier = pv.unpricedModifier;
    for (const k of Object.keys(c.requests_unpriced_modifier_by_reason) as UnpricedModifierReason[]) {
      c.requests_unpriced_modifier_by_reason[k] = pv.byModifier.get(k) ?? 0;
    }
    c.tokens_unpriced = pv.all.tokens_unpriced;
    for (const k of UNPRICED_TOKEN_REASONS) c.tokens_unpriced_by_reason[k] = pv.all.unpriced_by_reason[k];
    c.output_unknown_requests = pv.all.output_unknown;
    c.baseline_requests_loaded = pv.baseline;
    // Chains, families, links and live counters come from the graph, after taint and the cross-chain checks
    // (R0.9, R5.3 to R5.7). Live families are in none of the chain and family counters (R0.9 Coverage).
    const g = graph.coverage_by_provider[p];
    c.chains_total = g.chains_total;
    c.chains_tainted = g.chains_tainted;
    for (const k of TAINT_REASONS) c.chains_tainted_by_reason[k] = g.chains_tainted_by_reason[k];
    c.families_total = g.families_total;
    c.families_tainted = g.families_tainted;
    c.families_ordinal_unverified = g.families_ordinal_unverified;
    c.families_live_skipped = g.families_live_skipped;
    c.responses_live_skipped = g.responses_live_skipped;
    c.tokens_live_skipped = g.tokens_live_skipped;
    c.links_verified = g.links_verified;
    c.links_directory_only = g.links_directory_only;
    c.links_unlinked = g.links_unlinked;
    for (const k of Object.keys(c.links_unlinked_by_reason) as (keyof typeof c.links_unlinked_by_reason)[]) {
      c.links_unlinked_by_reason[k] = g.links_unlinked_by_reason[k];
    }
    // Response level taint counters (R0.9 Coverage), over the counted set (owner, kept, in the window).
    c.responses_in_tainted_chains = pv.taintedResponses;
    c.tokens_in_tainted_chains = pv.taintedTokens;
    c.requests_unpriced_tainted = pv.unpricedTainted;
  }
  const coverage = mergeCoverage(covBy.claude, covBy.codex);
  const drift = computeDrift(covBy);
  const tripped = drift.filter((d) => d.tripped);
  // R17.3 revision 11.1: drift is decided per provider and closes that provider only. A provider with input has a
  // drift finding; a provider without input is neither open nor closed for the status.
  const withheldBy = { claude: null, codex: null } as Record<Provider, DriftCode | null>;
  for (const p of PROVIDERS) withheldBy[p] = tripped.find((d) => d.provider === p)?.code ?? null;
  const withInput = PROVIDERS.filter((p) => drift.some((d) => d.provider === p));
  const closed = PROVIDERS.filter((p) => withheldBy[p] !== null);
  const headlineStatus: ReportInput["headline_status"] = closed.length === 0 ? "ok" : closed.length >= withInput.length ? "withheld" : "partial";

  const totals: ProviderTotals[] = PROVIDERS.map((p) => {
    const pv = shown[p];
    const models = [...pv.byModel.values()]
      .sort((a, b) => {
        if (a.model !== b.model) return a.model === null ? 1 : b.model === null ? -1 : a.model < b.model ? -1 : 1;
        return a.verified === b.verified ? 0 : a.verified ? -1 : 1;
      })
      .map(modelRow);
    return {
      provider: p,
      requests_by_kind: pv.byKind,
      requests_total: pv.all.responses,
      requests_priced: pv.all.priced,
      tokens: { ...pv.all.tokens },
      total_input: pv.all.total_input,
      tokens_total: tokensTotal(pv.all),
      models,
      usd_pico: pv.all.priced > 0 ? pv.all.usd : null,
      tokens_unpriced: pv.all.tokens_unpriced,
      tokens_unpriced_by_reason: { ...pv.all.unpriced_by_reason },
      output_unknown: pv.all.output_unknown,
    };
  });

  const cl = shown.claude;
  const cx = shown.codex;
  const zeroBoundaries = {} as Record<BoundaryType, number>;
  for (const b of ["model_switch", "context_reset", "subagent_cold_start", "fork_inherit", "first_observation"] as const) zeroBoundaries[b] = 0;
  // R16.5 revision 11.1: with one provider closed (`partial`), the headline lines carry the figures of the open provider
  // only; the closed provider's tokens stay in its own totals block.
  const inHead = (p: Provider): boolean => headlineStatus !== "partial" || withheldBy[p] === null;
  const hc = inHead("claude");
  const hx = inHead("codex");
  const zeroAcc = newAcc();
  const hcl = hc ? cl.all : zeroAcc;
  const hcx = hx ? cx.all : zeroAcc;
  const tokensTotalAll = tokensTotal(hcl) + tokensTotal(hcx);
  // The headline dollar figure sums the open providers only (R17.3 revision 11.1); a closed provider adds none.
  const openPriced = (p: Provider): number => (withheldBy[p] === null ? shown[p].all.priced : 0);
  const usdAll = openPriced("claude") + openPriced("codex") > 0 ? (withheldBy.claude === null ? cl.all.usd : 0n) + (withheldBy.codex === null ? cx.all.usd : 0n) : null;

  // R16.1 / C36: the shares are scan-wide per provider.
  const taintFor = (p: Provider): HeadlineFigures["taint_by_provider"][Provider] => {
    const c = covBy[p];
    const total = tokensTotal(scan[p].all);
    return {
      chains_total: c.chains_total,
      chains_tainted: c.chains_tainted,
      families_total: c.families_total,
      families_tainted: c.families_tainted,
      responses_in_tainted_chains: c.responses_in_tainted_chains,
      tokens_in_tainted_chains: c.tokens_in_tainted_chains,
      tokens_total: total,
      families_live_skipped: c.families_live_skipped,
      warn: taintWarn(c.families_tainted, c.families_total, c.tokens_in_tainted_chains, total),
    };
  };
  const taintBy: HeadlineFigures["taint_by_provider"] = { claude: taintFor("claude"), codex: taintFor("codex") };

  const headline: HeadlineFigures = {
    n_total: hcl.responses + hcx.responses,
    n_main: hc ? cl.byKind.main : 0,
    n_sub: hc ? cl.byKind.subagent : 0,
    n_wf: hc ? cl.byKind.workflow_agent : 0,
    n_cx: hcx.responses,
    cache_read: hcl.tokens.cache_read + hcx.tokens.cache_read,
    total_input: hcl.total_input + hcx.total_input,
    by_provider: {
      claude: { cache_read: cl.all.tokens.cache_read, total_input: cl.all.total_input },
      codex: { cache_read: cx.all.tokens.cache_read, total_input: cx.all.total_input },
    },
    usd_pico: usdAll,
    n_priced: hcl.priced + hcx.priced,
    tokens_unpriced: hcl.tokens_unpriced + hcx.tokens_unpriced,
    tokens_total: tokensTotalAll,
    // R3.9 with C24 = 1/10: tokens_unpriced > C24 * total_tokens  <=>  10 * unpriced > total
    partial_by_provider: {
      claude: 10n * cl.all.tokens_unpriced > tokensTotal(cl.all),
      codex: 10n * cx.all.tokens_unpriced > tokensTotal(cx.all),
    },
    output_unknown: hcl.output_unknown + hcx.output_unknown,
    taint_by_provider: taintBy,
    // Sections 7 to 11 are not computed in G1: the event fields stay at zero.
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
  for (const x of parsed) for (const a of x.assumptions) assumptionSet.add(a);
  // A dollar figure is printed only for an open provider that has a priced response (R16.5, R17.3).
  if ((withheldBy.claude === null && cl.anyPriced) || (withheldBy.codex === null && cx.anyPriced)) assumptionSet.add("no_regional_surcharge_assumed");
  if (PROVIDERS.some((p) => covBy[p].families_live_skipped > 0)) assumptionSet.add("live_session_skipped");
  if (PROVIDERS.some((p) => covBy[p].requests_unverified_version > 0 || covBy[p].lines_unverified_version > 0)) assumptionSet.add("unverified_version");

  return {
    schema: SCHEMA_ID,
    spec: SPEC_ID,
    generated_at_ms: args.generated_at_ms,
    tool_version: args.tool_version,
    table_version: book.table_version,
    window: win,
    headline_status: headlineStatus,
    withheld_reason: tripped.length > 0 ? (tripped[0] as DriftFinding).code : null,
    withheld_by_provider: withheldBy,
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
    shown_providers: PROVIDERS.filter((p) => shownSet.has(p)),
  };
};
