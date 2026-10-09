// Instants and the report window (R5.9; docs/accounting-semantics.md S3 and S7). Pure, no I/O.
//
// Instants are parsed by an own parser (S3.1): the grammar and the calendar are checked without `Date.parse`, which
// accepts `2026-02-30` and `T24:00`. The value of a valid instant is the exact BigInt count of nanoseconds since the
// epoch (S3.2). Nothing here truncates to milliseconds before a comparison; `nsToMs` is for display and for rules whose
// inputs are milliseconds anyway.
import type { TimeWindow } from "./model/types.js";

export const SINCE_RE = /^(\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?|\d+[dhw])$/;

const NS_PER_MS = 1_000_000n;
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function daysInMonth(y: number, m: number): number {
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return m === 2 && leap ? 29 : (MONTH_DAYS[m - 1] as number);
}

/** Days from 1970-01-01 to the proleptic Gregorian civil date (y, m, d). */
function daysFromCivil(y0: number, m: number, d: number): number {
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * S3.1, S3.2. A JSON string of at most 40 characters matching `YYYY-MM-DDThh:mm:ss[.f]Z` or `...+hh:mm` / `-hh:mm`
 * (`f` is 1 to 9 digits) with a valid proleptic Gregorian calendar, hour 00 to 23, minute and second 00 to 59, offset
 * hours 00 to 23 and offset minutes 00 to 59. Returns the exact nanoseconds since the epoch, or null when the value
 * is not a valid instant (a missing value is null as well; use `instantState` to tell them apart).
 */
export function parseInstantNs(v: unknown): bigint | null {
  if (typeof v !== "string" || v.length > 40) return null;
  const m = INSTANT_RE.exec(v);
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (year < 1 || month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offset = 0;
  if (m[8] === undefined) {
    const oh = Number(m[10]);
    const om = Number(m[11]);
    if (oh > 23 || om > 59) return null;
    offset = (oh * 3600 + om * 60) * (m[9] === "-" ? -1 : 1);
  }
  const secs = daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second - offset;
  const frac = BigInt((m[7] ?? "").padEnd(9, "0"));
  return BigInt(secs) * 1_000_000_000n + frac;
}

/** S1.3, S3.4: `missing` is absent or JSON null, `bad` is anything present that is not a valid instant. */
export type InstantState = { readonly ns: bigint } | "missing" | "bad";

export function instantState(v: unknown): InstantState {
  if (v === undefined || v === null) return "missing";
  const ns = parseInstantNs(v);
  return ns === null ? "bad" : { ns };
}

/** Projection text of an instant state: the exact nanoseconds, or the state. Equal instants give equal text (S3.2). */
export function instantProj(s: InstantState): string {
  return typeof s === "string" ? `~${s}` : `t${s.ns.toString()}`;
}

/** Floor of nanoseconds in milliseconds (floor, also before 1970). Display and ms-only rules (S3.3). */
export function nsToMs(ns: bigint): number {
  let q = ns / NS_PER_MS;
  if (ns % NS_PER_MS < 0n) q -= 1n;
  return Number(q);
}

/** Milliseconds as exact nanoseconds. Fractional milliseconds (never produced by the parsers) are kept to the microsecond. */
export function msToNs(ms: number): bigint {
  return Number.isInteger(ms) ? BigInt(ms) * NS_PER_MS : BigInt(Math.round(ms * 1000)) * 1000n;
}

/** S7.1: `since * 10^6 <= t < until * 10^6`, compared as BigInt. */
export function windowContainsNs(w: TimeWindow, tNs: bigint): boolean {
  return msToNs(w.since_ms) <= tNs && tNs < msToNs(w.until_ms);
}

const UNIT_MS = { h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
const BOUND_TIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?Z?$/;

/**
 * One window bound. A duration (`7d`, `24h`, `2w`) is measured back from `now_ms`. A date or instant is UTC
 * (a bare date is midnight UTC). Returns null when the text does not denote a valid instant (S3.1 calendar rules).
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
  let iso: string;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) iso = `${text}T00:00:00Z`;
  else {
    const t = BOUND_TIME_RE.exec(text);
    if (t === null) return null;
    iso = `${t[1]}T${t[2]}:${t[3]}:${t[4] ?? "00"}Z`;
  }
  const ns = parseInstantNs(iso);
  return ns === null ? null : nsToMs(ns);
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
