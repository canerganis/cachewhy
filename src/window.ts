// Report window parsing (R5.9): `[since, until)` in UTC on event time. Pure, no I/O.
import type { TimeWindow } from "./model/types.js";

export const SINCE_RE = /^(\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?|\d+[dhw])$/;

const UNIT_MS = { h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

/**
 * One window bound. A duration (`7d`, `24h`, `2w`) is measured back from `now_ms`. A date or instant is UTC
 * (a bare date is midnight UTC). Returns null when the text does not denote a valid instant.
 */
export function parseBound(text: string, now_ms: number): number | null {
  const dur = /^(\d+)([dhw])$/.exec(text);
  if (dur) {
    const n = Number(dur[1]);
    const unit = UNIT_MS[dur[2] as keyof typeof UNIT_MS];
    const ms = now_ms - n * unit;
    return Number.isSafeInteger(n) && Number.isFinite(ms) ? ms : null;
  }
  if (!SINCE_RE.test(text)) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : /Z$/.test(text) ? text : `${text}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The report window. Without `since` the window starts at `earliest_ms` (the first event of the scan), so all
 * loaded requests count. `until` defaults to `now_ms`.
 */
export function resolveWindow(
  opts: { since?: string | undefined; until?: string | undefined },
  now_ms: number,
  earliest_ms: number | null,
): TimeWindow | null {
  const until = opts.until === undefined ? now_ms : parseBound(opts.until, now_ms);
  if (until === null) return null;
  let since: number | null;
  if (opts.since === undefined) since = earliest_ms === null ? until : Math.min(earliest_ms, until);
  else since = parseBound(opts.since, now_ms);
  if (since === null || since > until) return null;
  return { since_ms: since, until_ms: until };
}
