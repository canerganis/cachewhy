// Simple rebuild detector: walks every chain in order and flags a request whose cache read fell well below the prefix
// the previous request had cached. Each event gets one cause and an evidence level:
//   confirmed   Claude logged a cache miss reason for the request (diagnostics)
//   hypothesis  a signal in the logs fits (model switch, idle gap past the TTL, shrinking context, settings change)
//   unknown     nothing in the logs explains it
// Dollars are an API list-price equivalent of the extra cost (rebuilt tokens priced as writes or uncached input
// instead of cache reads), from the standard row of the model. They are an estimate, never a billed amount.
import type { Analysis } from "./analyze.js";
import {
  cachedPrefix,
  CONSTANTS,
  contextTokens,
  countsInTotals,
  type Confidence,
  type EvidenceLevel,
  type Provider,
  type RequestKind,
  type Response,
} from "./model/types.js";
import { lookupModel } from "./pricing/index.js";

export const REBUILD_CAUSES = [
  "model_switch",
  "compaction_or_clear",
  "tools_or_system_changed",
  "conversation_edited",
  "ttl_expired",
  "settings_changed",
  "unknown",
] as const;
export type RebuildCause = (typeof REBUILD_CAUSES)[number];

/** A previous prefix below this size is not worth flagging (small prefixes are often not cacheable at all). */
const MIN_PREV_PREFIX = 4096n;
/** Rebuilt tokens below this are noise. */
const MIN_REBUILT = 2048n;

export interface RebuildEvent {
  readonly provider: Provider;
  readonly kind: RequestKind;
  /** Opaque session label (root session id, shortened). */
  readonly session: string;
  readonly t_ms: number;
  readonly model: string | null;
  readonly prev_prefix: bigint;
  readonly cache_read: bigint;
  /** Tokens processed again that the previous request had cached. */
  readonly rebuilt: bigint;
  readonly gap_s: number | null;
  readonly cause: RebuildCause;
  readonly level: EvidenceLevel;
  readonly confidence: Confidence | null;
  /** Short human reason. */
  readonly detail: string;
  /** Extra list-price-equivalent USD, null when the model has no price row. */
  readonly usd: number | null;
}

export interface CauseTotals {
  readonly cause: RebuildCause;
  readonly events: number;
  readonly rebuilt: bigint;
  readonly usd: number;
}

export interface RebuildReport {
  readonly requests_checked: number;
  readonly events: readonly RebuildEvent[];
  readonly by_cause: readonly CauseTotals[];
  readonly by_level: Readonly<Record<EvidenceLevel, number>>;
  readonly rebuilt_total: bigint;
  readonly usd_total: number;
  readonly unpriced_events: number;
}

function modelOf(r: Response): string | null {
  return r.model.model ?? r.model.candidate;
}

/** USD for `tokens` at a rate in 1e-6 USD per MTok. */
function usdAt(tokens: bigint, rate: bigint): number {
  return Number(tokens * rate) / 1e12;
}

function extraUsd(a: Analysis, c: Response, rebuilt: bigint, ttl1h: boolean): number | null {
  const id = modelOf(c);
  if (id === null) return null;
  const mp = lookupModel(a.book, id);
  if (mp === null) return null;
  const row = mp.standard;
  if (row.cache_read === null) return null;
  const full = c.provider === "claude" ? (ttl1h ? row.cache_write_1h : row.cache_write_5m) : row.input;
  if (full === null) return null;
  return usdAt(rebuilt, full - row.cache_read);
}

function diagCause(c: Response): { cause: RebuildCause; detail: string } | null {
  if (c.provider !== "claude" || c.diag === null) return null;
  switch (c.diag.type) {
    case "model_changed":
      return { cause: "model_switch", detail: "Claude reported: model changed" };
    case "tools_changed":
      return { cause: "tools_or_system_changed", detail: "Claude reported: tool definitions changed" };
    case "system_changed":
      return { cause: "tools_or_system_changed", detail: "Claude reported: system prompt changed" };
    case "messages_changed":
      return { cause: "conversation_edited", detail: "Claude reported: earlier messages changed" };
    case "previous_message_not_found":
      return { cause: "ttl_expired", detail: "Claude reported: previous cache entry not found" };
    default:
      return null;
  }
}

function fmtGap(s: number): string {
  return s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s >= 60 ? `${Math.round(s / 60)}m` : `${Math.round(s)}s`;
}

/** `include` limits which requests are reported (`--agent`, `--project`); every chain is still walked. */
export function detectRebuilds(a: Analysis, include: (r: Response) => boolean = () => true): RebuildReport {
  const { graph } = a;
  const events: RebuildEvent[] = [];
  let checked = 0;

  for (const node of graph.nodes) {
    if (node.prev === null || !node.in_window) continue;
    const c = graph.responses[node.response]!;
    const p = graph.responses[node.prev]!;
    if (!countsInTotals(c) || c.usage === null || p.usage === null || !include(c)) continue;
    checked++;

    const kPrev = cachedPrefix(p.usage);
    if (kPrev < MIN_PREV_PREFIX) continue;
    const read = c.usage.cache_read;
    // suspect: less than half of the previous cached prefix was read back
    if (read * 2n >= kPrev) continue;
    const ctxC = contextTokens(c.usage);
    const reusable = ctxC < kPrev ? ctxC : kPrev;
    const rebuilt = reusable - read;
    if (rebuilt < MIN_REBUILT) continue;

    const gapS = node.gap?.min_ms != null ? node.gap.min_ms / 1000 : (c.time.event_ms - p.time.event_ms) / 1000;
    const ttl1h = c.provider === "claude" && node.ttl_set?.has_1h === true && node.ttl_set.has_5m === false;
    const ttlS = c.provider === "claude" ? (ttl1h ? CONSTANTS.TTL_1H_S : CONSTANTS.TTL_5M_S) : CONSTANTS.TTL_OPENAI_30M_S;
    const mPrev = modelOf(p);
    const mCur = modelOf(c);

    let cause: RebuildCause = "unknown";
    let level: EvidenceLevel = "unknown";
    let confidence: Confidence | null = null;
    let detail = "no signal in the logs explains it";

    const diag = diagCause(c);
    if (diag !== null) {
      ({ cause, detail } = diag);
      level = "confirmed";
    } else if (mPrev !== null && mCur !== null && mPrev !== mCur) {
      cause = "model_switch";
      level = "hypothesis";
      confidence = "high";
      detail = `model ${mPrev} -> ${mCur}`;
    } else if (ctxC * 10n < kPrev * 7n) {
      cause = "compaction_or_clear";
      level = "hypothesis";
      confidence = "medium";
      detail = `context shrank from ${kPrev} to ${ctxC} tokens`;
    } else if (gapS > ttlS) {
      cause = "ttl_expired";
      level = "hypothesis";
      confidence = gapS > ttlS * 1.2 ? "high" : "medium";
      detail = `idle ${fmtGap(gapS)}, cache TTL ${fmtGap(ttlS)}`;
    } else if (p.effort !== c.effort && p.effort !== null && c.effort !== null) {
      cause = "settings_changed";
      level = "hypothesis";
      confidence = "medium";
      detail = `effort ${p.effort} -> ${c.effort}`;
    } else if (p.version !== c.version) {
      cause = "tools_or_system_changed";
      level = "hypothesis";
      confidence = "low";
      detail = `${c.provider === "claude" ? "Claude Code" : "Codex"} ${p.version} -> ${c.version}`;
    }

    events.push({
      provider: c.provider,
      kind: c.kind,
      session: c.chain.root_session.slice(0, 8),
      t_ms: c.time.event_ms,
      model: mCur,
      prev_prefix: kPrev,
      cache_read: read,
      rebuilt,
      gap_s: Number.isFinite(gapS) ? gapS : null,
      cause,
      level,
      confidence,
      detail,
      usd: extraUsd(a, c, rebuilt, ttl1h),
    });
  }

  events.sort((x, y) => (y.usd ?? -1) - (x.usd ?? -1) || (y.rebuilt > x.rebuilt ? 1 : y.rebuilt < x.rebuilt ? -1 : 0));

  const byCause = new Map<RebuildCause, { events: number; rebuilt: bigint; usd: number }>();
  const byLevel: Record<EvidenceLevel, number> = { observed: 0, hypothesis: 0, confirmed: 0, unknown: 0 };
  let rebuiltTotal = 0n;
  let usdTotal = 0;
  let unpriced = 0;
  for (const e of events) {
    const t = byCause.get(e.cause) ?? { events: 0, rebuilt: 0n, usd: 0 };
    t.events++;
    t.rebuilt += e.rebuilt;
    t.usd += e.usd ?? 0;
    byCause.set(e.cause, t);
    byLevel[e.level]++;
    rebuiltTotal += e.rebuilt;
    if (e.usd === null) unpriced++;
    else usdTotal += e.usd;
  }
  const by_cause = REBUILD_CAUSES.filter((c) => byCause.has(c))
    .map((cause) => ({ cause, ...byCause.get(cause)! }))
    .sort((x, y) => y.usd - x.usd || y.events - x.events);

  return {
    requests_checked: checked,
    events,
    by_cause,
    by_level: byLevel,
    rebuilt_total: rebuiltTotal,
    usd_total: usdTotal,
    unpriced_events: unpriced,
  };
}
