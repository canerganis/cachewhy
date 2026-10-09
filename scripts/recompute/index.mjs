#!/usr/bin/env node
// cachewhy independent recompute (spec R13.1 to R13.3).
//
// A second, deliberately separate implementation of the ACCOUNTING part of docs/methodology.md (revision 11.1) and of the
// normal forms of docs/accounting-semantics.md (S1 to S11: BigInt instants and counters, record projections, gate order):
// unique responses (R4), token buckets per provider (R2), list-price equivalent (R3) and the global integrity
// abstention (R0.9: families, taint, live families). It reads raw log files and the pricing table JSON. It imports
// nothing from src/ and nothing outside node:*. It does not detect events, boundaries or causes (sections 6 to 11).
//
// Written from the spec text, not from src/. Rule ids are cited where a rule is implemented.
// Plain Node ESM, zero dependencies. All token arithmetic and all money use BigInt (R2.16, R3.8).
//
// Codex dollars: R3.4 has a tier gate. No retained field shows the Codex service tier, so a default run gives
// every Codex response reason modifier_unverified and no dollars. The test-only API parameter
// `codexTierForTest: "standard"` (spec name codex_tier_for_test) marks the tier as verified Standard so that the
// row selection of R3.6 and R3.10 can be exercised. The run start and the file modification times (R0.9, live
// families) are likewise API parameters only (`runStartMs`, `mtimeMs` on in-memory files). None of them is a CLI
// flag or an environment variable. The CLI reads the clock once and stats each file.
//
// Usage:
//   node scripts/recompute/index.mjs --claude-dir <dir> [--claude-dir <dir>] --codex-dir <dir>
//        [--since <ISO instant or YYYY-MM-DD>] [--until <ISO instant or YYYY-MM-DD>]
//        [--table <table.json>] [--per-response [--raw-keys]] [--out <file>]
//
// Output: one JSON document on stdout (or --out). Token amounts and money are decimal strings.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

// ---------------------------------------------------------------------------
// Constants (spec section 0.3, 0.2). Rationals are kept as [num, den] BigInt pairs (R2.16).
// ---------------------------------------------------------------------------

export const SPEC_ID = "spec-1";
export const RECOMPUTE_SCHEMA = "cachewhy-recompute/1";

const CLAUDE_FULL_VERSIONS = ["2.1.286", "2.1.288", "2.1.289", "2.1.291", "2.1.293"]; // section 0.2
const CODEX_FULL_VERSIONS = ["0.157.1", "0.158.0", "0.159.2", "0.160.0", "0.160.1"]; // section 0.2
const C24 = [1n, 10n]; // UNPRICED_PARTIAL
const C25 = 272000n; // CODEX_LONG_CTX
const C26 = 100000n; // HAIKU_TIER_SPLIT
const C32 = [11n, 10n]; // GEO_US_MULT
const C35_MS = 600000; // LIVE_WINDOW, 600 s (R0.9)
const C36 = [3n, 10n]; // TAINT_WARN_SHARE (reported through the counters; the warning itself is a report matter)
/** The closed enum of R0.9, in spec order. */
const TAINT_REASONS = [
  "stream_unresolved",
  "copy_exposed",
  "turn_model_conflicted",
  "ordinal_unverified",
  "fork_prefix_unresolved",
  "request_anomaly",
  "ownership_ambiguous",
  "version_unverified",
  "unparsed_line",
  "unlogged_usage",
  "unattributed_record",
  "file_unreadable",
];
/**
 * R3.9 (revision 11.1): the closed enum of unpriced token reasons in its fixed order. The first four are the gates
 * before the modifier checks; the rest is the reason list of requests_unpriced_modifier.
 */
const UNPRICED_TOKEN_ORDER = [
  "chain_tainted",
  "model_unknown",
  "unknown_model",
  "excluded",
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
  "bucket_unknown",
  "modifier_unverified",
];
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/; // R1.2 `version`
const DATE_SUFFIX_RE = /-\d{8}$/; // R3.3, S2.1: one trailing -YYYYMMDD, stripped once
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/; // R14.3, S2.1

// Reading states of a field (S1.1, S1.3, S4.1). A valid counter is a BigInt (S4.2): every later operation on it is BigInt.
// JSON null and absence are the same state `missing` (S1.3). `bad` is a present value of the wrong type or grammar,
// `range` a JSON number that fails the counter range (R2.15).
const MISSING = "missing";
const BAD = "bad";
const RANGE = "range";
const isBig = (x) => typeof x === "bigint";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** S1.1: an id is valid iff it is a JSON string of length 1 or more. Anything else is not usable as a key. */
const str = (v) => (typeof v === "string" && v.length > 0 ? v : null);

/** S4.1, S4.2, R2.15: read a counter. Range check on the parsed value, then BigInt at once. `-0` is 0. */
function ctr(v) {
  if (v === undefined || v === null) return MISSING;
  if (typeof v !== "number") return BAD;
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0 || v > MAX_SAFE) return RANGE;
  return BigInt(v);
}

/** Smallest and largest of a list of BigInt. Empty list: null. */
function minBig(xs) {
  let m = null;
  for (const x of xs) if (m === null || x < m) m = x;
  return m;
}
function maxBig(xs) {
  let m = null;
  for (const x of xs) if (m === null || x > m) m = x;
  return m;
}
/** Order of two BigInt-or-null values, null last. */
function cmpNullLast(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Instants (S3). Own grammar and calendar check, no Date.parse; the value is a BigInt count of nanoseconds.
// ---------------------------------------------------------------------------

const INSTANT_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(?:Z|([+-])([0-9]{2}):([0-9]{2}))$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const isLeapYear = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);

/** Days from 1970-01-01 to the proleptic Gregorian date (civil calendar algorithm on small integers). */
function daysFromCivil(y0, m, d) {
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** S3.1, S3.2: the instant as BigInt nanoseconds since the epoch, or null when v is not a valid instant. */
function instantNs(v) {
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
  const dim = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (day < 1 || day > dim) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offset = 0;
  if (m[8] !== undefined) {
    const oh = Number(m[9]);
    const om = Number(m[10]);
    if (oh > 23 || om > 59) return null;
    offset = (oh * 3600 + om * 60) * (m[8] === "-" ? -1 : 1);
  }
  const secs = daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second - offset;
  return BigInt(secs) * 1000000000n + BigInt((m[7] ?? "").padEnd(9, "0") || "0");
}

/** An instant field: the BigInt nanoseconds, `missing` (absent or null) or `bad` (S3.4: never 0 or the epoch). */
function instantOf(v) {
  if (v === undefined || v === null) return MISSING;
  return instantNs(v) ?? BAD;
}
/** Milliseconds (floor) of an instant in nanoseconds; for display and the live test only (S3.3). */
const nsToMs = (ns) => Number(ns / 1000000n - (ns % 1000000n < 0n ? 1n : 0n));

/** S2.1: the normal form of a raw model value; null is "no model". */
function modelNormal(v) {
  if (typeof v !== "string" || v.length === 0 || v.length > 80) return null;
  const id = v.replace(DATE_SUFFIX_RE, "");
  return MODEL_ID_RE.test(id) ? id : "unlisted";
}

/** S2.2: Claude `message.model` and `advisorModel`: no model is null, `<synthetic>` is the reserved value, else normal form. */
function claudeModel(v) {
  if (v === "<synthetic>") return "<synthetic>";
  return modelNormal(v);
}

/** S2.3: Codex `turn_context.model`: no model and `unlisted` both give null (no candidate model). */
function ctxModel(v) {
  const n = modelNormal(v);
  return n === "unlisted" ? null : n;
}

/** S2.4: a table model id is normalized the same way (date suffix stripped once) for lookup and labels. */
function tableModelId(v) {
  if (typeof v !== "string") return null;
  return v.replace(DATE_SUFFIX_RE, "");
}

/** S1.2: a listed string maps to itself, absent or null to null (`missing`), anything else to `other`. */
function enumOf(v, allowed) {
  if (v === undefined || v === null) return null;
  return typeof v === "string" && allowed.includes(v) ? v : "other";
}

// ---------------------------------------------------------------------------
// Projection building blocks (S5.1). A projection is an array; every element is one of: a string (valid id or enum
// member), null (`missing`), { s: "bad" | "range" } (a state), { b: "<decimal>" } (a BigInt value: counter or instant).
// Raw invalid values are never kept (R1.1, R14.6).
// ---------------------------------------------------------------------------

const stateOf = (x) => (isBig(x) ? { b: x.toString() } : x === MISSING ? null : { s: x });
/** S1.1: a valid id raw, `missing` for absent or null, `bad` otherwise. */
const idP = (v) => (typeof v === "string" && v.length > 0 ? v : v === undefined || v === null ? null : { s: BAD });
/** A boolean field: true or false, `missing`, or `bad` for a non-boolean. */
const boolP = (v) => (typeof v === "boolean" ? v : v === undefined || v === null ? null : { s: BAD });
/** An instant field in a projection (S3.2, S3.4). */
const instP = (v) => stateOf(instantOf(v));
const ctrP = (v) => stateOf(ctr(v));
/** The projection text of an array. */
const pjson = (arr) => JSON.stringify(arr);

// ---------------------------------------------------------------------------
// Line reading (R1.3): BOM and CRLF tolerated, an unterminated last line that fails to parse is
// a truncated tail and not an error. Parse failure messages are never kept (R14.6).
// ---------------------------------------------------------------------------

function* jsonLines(buf, cov) {
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  const n = buf.length;
  while (start < n) {
    let nl = buf.indexOf(0x0a, start);
    const terminated = nl !== -1;
    if (!terminated) nl = n;
    let end = nl;
    if (end > start && buf[end - 1] === 0x0d) end -= 1;
    const text = buf.toString("utf8", start, end);
    start = nl + 1;
    // R1.3, S12.6: a blank or whitespace-only terminated line is a line that fails JSON.parse (a parse error); only an
    // unterminated last line that is empty after removing a BOM and a CR is not a line.
    if (!terminated && text.length === 0) continue;
    cov.lines_total += 1;
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      if (terminated) cov.lines_parse_error += 1;
      else cov.lines_truncated_tail += 1;
      continue;
    }
    yield obj;
  }
}

// ---------------------------------------------------------------------------
// Discovery. Structure only; no file content is looked at here.
// ---------------------------------------------------------------------------

/**
 * S12.6a, the exact discovery layout (both implementations). Paths are relative to the projects/ root:
 *   <project>/<session>.jsonl                                              main log
 *   <project>/<session>/subagents/agent-<id>.jsonl                         subagent log
 *   <project>/<session>/subagents/workflows/wf_<run>/agent-<id>.jsonl      workflow agent log
 * Any other path is not discovered.
 */
function classifyClaude(segs) {
  const name = segs[segs.length - 1] ?? "";
  if (segs.length === 2) return /^.+\.jsonl$/.test(name) ? "main" : null;
  if (segs.length === 4 && segs[2] === "subagents") return /^agent-.+\.jsonl$/.test(name) ? "subagent" : null;
  if (segs.length === 6 && segs[2] === "subagents" && segs[3] === "workflows" && /^wf_.+$/.test(segs[4])) {
    return /^agent-.+\.jsonl$/.test(name) ? "workflow_agent" : null;
  }
  return null;
}

/**
 * Claude sidecar files that R1.2 reads, at the exact layout of S12.6a: `agent-<id>.meta.json` and `agent-<id>.prefix.json`
 * next to an agent log in either directory, `<project>/<session>/workflows/wf_<run>.json` and
 * `<project>/<session>/subagents/workflows/wf_<run>/journal.jsonl`. They hold no request and name no chain, but a sidecar
 * that fails to parse is a lost line (R1.3, R0.9 unparsed_line).
 */
function classifyClaudeSidecar(segs) {
  const name = segs[segs.length - 1] ?? "";
  const agentSide = /^agent-.+\.(meta|prefix)\.json$/.test(name);
  if (segs.length === 4 && segs[2] === "subagents" && agentSide) return "sidecar_json";
  if (segs.length === 6 && segs[2] === "subagents" && segs[3] === "workflows" && /^wf_.+$/.test(segs[4])) {
    if (agentSide) return "sidecar_json";
    if (name === "journal.jsonl") return "sidecar_lines";
  }
  if (segs.length === 4 && segs[2] === "workflows" && /^wf_.+\.json$/.test(name)) return "sidecar_json";
  return null;
}

const SIDECAR_MAX_BYTES = 8 * 1024 * 1024; // S12.6a
const ROLLOUT_RE = /^rollout-.*\.jsonl$/;
const ROLLOUT_ZST_RE = /^rollout-.*\.jsonl\.zst$/;

/**
 * Collect the files under `dir`. A directory that cannot be resolved or listed is reported through `onBad`: it counts as
 * a file that cannot be read (R0.9 file_unreadable), so its logs are unknown and the provider abstains.
 */
function walk(dir, out, onBad, seen = new Set()) {
  let ents;
  try {
    const real = realpathSync(dir);
    if (seen.has(real)) return false; // symlink loop or repeated directory
    seen.add(real);
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    onBad();
    return false;
  }
  ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of ents) {
    const p = join(dir, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        const st = statSync(p);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) walk(p, out, onBad, seen);
    else if (isFile) out.push(p);
  }
  return true;
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Entries: { provider, rel: string[], zst: boolean, mtimeMs: number | null, read(): Buffer }. */
function discoverEntries(claudeDirs, codexDirs, cov) {
  const entries = [];
  const seenFiles = new Set();
  const seenRoots = new Set();
  // A path that cannot be examined stays in the scan as one entry that fails to read (R0.9 file_unreadable). It names
  // no chain, so it is never live and taints the provider of its root.
  const unreadableEntry = (provider) =>
    entries.push({
      provider,
      rel: [],
      kind: provider === "claude" ? "main" : null,
      zst: false,
      mtimeMs: null,
      read: () => {
        throw new Error("file_unreadable");
      },
    });
  const addFiles = (provider, root) => {
    let real;
    try {
      real = realpathSync(root);
    } catch (e) {
      // A root that does not exist is routine. A root that exists but cannot be resolved is an unreadable directory.
      const code = e && typeof e === "object" ? e.code : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") unreadableEntry(provider);
      return;
    }
    if (!isDirectory(real)) return;
    const rootKey = `${provider}:${real}`;
    if (seenRoots.has(rootKey)) return;
    seenRoots.add(rootKey);
    const files = [];
    walk(root, files, () => unreadableEntry(provider));
    for (const f of files) {
      const rel = f.slice(root.length).split(/[\\/]+/).filter(Boolean);
      const name = rel[rel.length - 1] ?? "";
      let kind = null;
      let zst = false;
      if (provider === "claude") {
        kind = classifyClaude(rel) ?? classifyClaudeSidecar(rel);
        if (!kind) continue;
      } else {
        zst = ROLLOUT_ZST_RE.test(name);
        if (!zst && !ROLLOUT_RE.test(name)) continue;
      }
      let key;
      let mtimeMs = null;
      try {
        key = realpathSync(f);
        mtimeMs = statSync(f).mtimeMs; // R0.9: the only use of a modification time is the live test
      } catch {
        unreadableEntry(provider); // a log file that cannot be examined must not vanish from the scan
        continue;
      }
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);
      entries.push({ provider, rel, kind, zst, mtimeMs, read: () => readFileSync(f) });
    }
  };
  for (const d of claudeDirs ?? []) {
    const abs = resolve(d);
    addFiles("claude", isDirectory(join(abs, "projects")) ? join(abs, "projects") : abs);
  }
  for (const d of codexDirs ?? []) {
    const abs = resolve(d);
    const name = abs.split(/[\\/]/).pop();
    const hasSub = isDirectory(join(abs, "sessions")) || isDirectory(join(abs, "archived_sessions"));
    if (!hasSub && (name === "sessions" || name === "archived_sessions")) addFiles("codex", abs);
    else {
      addFiles("codex", join(abs, "sessions"));
      addFiles("codex", join(abs, "archived_sessions"));
    }
  }
  cov.files_discovered = entries.length;
  return entries;
}

/** In-memory entries from builder style paths: projects/..., sessions/..., archived_sessions/... */
function memoryEntries(files) {
  const entries = [];
  for (const f of files) {
    const segs = String(f.path).split("/").filter(Boolean);
    const content = typeof f.content === "string" ? Buffer.from(f.content, "utf8") : Buffer.from(f.content ?? "");
    const mtimeMs = typeof f.mtimeMs === "number" && Number.isFinite(f.mtimeMs) ? f.mtimeMs : null;
    const failRead = f.unreadable === true; // test hook: the file exists but cannot be read
    const read = () => {
      if (failRead) throw new Error("file_unreadable");
      return content;
    };
    if (segs[0] === "projects") {
      const rel = segs.slice(1);
      const kind = classifyClaude(rel) ?? classifyClaudeSidecar(rel);
      if (kind) entries.push({ provider: "claude", rel, kind, zst: false, mtimeMs, read });
    } else if (segs[0] === "sessions" || segs[0] === "archived_sessions") {
      const name = segs[segs.length - 1] ?? "";
      const zst = ROLLOUT_ZST_RE.test(name);
      if (zst || ROLLOUT_RE.test(name)) entries.push({ provider: "codex", rel: segs, kind: null, zst, mtimeMs, read });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Price book (R3.1 to R3.4, R3.8, R3.10 to R3.12), own parsing of the table JSON.
// ---------------------------------------------------------------------------

/** Decimal string to integer units of 1e-6 USD per MTok (R3.8). null stays null. */
function toUnits(v) {
  if (v === null || v === undefined) return null;
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(String(v));
  if (!m) throw new Error("table_price_malformed");
  return BigInt(m[1]) * 1000000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}

function claudeRow(p) {
  if (!isObj(p)) return null;
  const row = {
    input: toUnits(p.input),
    output: toUnits(p.output),
    cache_read: toUnits(p.cache_read),
    cache_write_5m: toUnits(p.cache_write_5m),
    cache_write_1h: toUnits(p.cache_write_1h),
  };
  return Object.values(row).some((x) => x === null) ? null : row;
}

function codexRow(p) {
  if (!isObj(p)) return null;
  const row = {
    input: toUnits(p.input),
    output: toUnits(p.output),
    cache_read: toUnits(p.cached_input),
    cache_write: toUnits(p.cache_write), // null allowed: n/a (R3.6)
  };
  return row.input === null || row.output === null || row.cache_read === null ? null : row;
}

/** R3.11: an effective verified_at is an ISO date, `YYYY-MM-DD`, optionally followed by a time. */
const ISO_DATE_PREFIX = /^[0-9]{4}-[0-9]{2}-[0-9]{2}/;

/** R3.11: an object with verified:true and an effective date. */
function verifiedObj(obj, entry, table) {
  if (!isObj(obj) || obj.verified !== true) return false;
  const date = obj.verified_at ?? entry?.verified_at ?? table.verified_at;
  return typeof date === "string" && ISO_DATE_PREFIX.test(date);
}

const PRICE_KEYS = ["input", "output", "cache_read", "cache_write_5m", "cache_write_1h", "cached_input", "cache_write"];
const PRICE_RE = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;

/** S8.5a: every price of a row is a JSON string of the price grammar; null is `n/a` (R3.6). Anything else is malformed. */
function checkPriceRow(row) {
  if (row === undefined || row === null) return;
  if (!isObj(row)) throw new Error("table_malformed");
  for (const k of PRICE_KEYS) {
    if (!(k in row)) continue;
    const v = row[k];
    if (v === null) continue;
    if (typeof v !== "string" || !PRICE_RE.test(v)) throw new Error("table_malformed");
  }
}

function loadBook(table) {
  if (!isObj(table) || !Array.isArray(table.models)) throw new Error("table_malformed");
  const byModel = new Map();
  for (const e of table.models) {
    if (!isObj(e)) continue;
    // S8.5a: the whole table is validated when it is loaded, verified or not, used or not
    checkPriceRow(e.prices_usd_per_mtok);
    if (isObj(e.fast)) checkPriceRow(e.fast.prices_usd_per_mtok);
    if (isObj(e.tiers)) checkPriceRow(e.tiers.high);
    if (isObj(e.long_context)) checkPriceRow(e.long_context.prices_usd_per_mtok);
    if (isObj(e.service_tier)) for (const v of Object.values(e.service_tier)) if (isObj(v)) checkPriceRow(v.prices_usd_per_mtok);
    const ids = Array.isArray(e.model_ids) ? e.model_ids : [];
    for (const raw of ids) {
      const id = tableModelId(raw); // S2.4: the table side is normalized the same way
      if (id === null) continue;
      if (byModel.has(id) && byModel.get(id) !== e) throw new Error("table_malformed"); // two entries with the same normalized model id
      byModel.set(id, e);
    }
  }
  return { table, byModel, version: typeof table.table_version === "string" ? table.table_version : "unlisted" };
}

/** Entry is usable when the entry itself is verified (R3.1) and has prices. */
function usableEntry(book, id, provider) {
  const e = id === null ? undefined : book.byModel.get(id);
  if (!e) return null;
  if (e.provider !== provider) return null; // S8.5a: an entry is used only for its own provider
  if (!verifiedObj(e, e, book.table)) return null;
  if (!isObj(e.prices_usd_per_mtok)) return null;
  return e;
}

function fastVerifiedModifier(book) {
  const m = book.table.modifiers?.fast_with_geo_us;
  return isObj(m) && verifiedObj(m, null, book.table);
}

/**
 * S8.2: geo `us` applies only if the table-level object modifiers.geo_us is verified (S8.1) AND the model entry's geo_us
 * object is verified (inheriting from the entry and the table) and has applies === true.
 */
function geoApplies(book, e) {
  const tableLevel = book.table.modifiers?.geo_us;
  if (!isObj(tableLevel) || !verifiedObj(tableLevel, null, book.table)) return false;
  return isObj(e.geo_us) && e.geo_us.applies === true && verifiedObj(e.geo_us, e, book.table);
}

/** R3.8: geo multiplier applied once to the sum; rounded half up to a whole picodollar. */
function applyGeo(pico, stats) {
  const num = pico * C32[0];
  if (num % C32[1] !== 0n) stats.geo_rounded += 1;
  return (num + C32[1] / 2n) / C32[1];
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const TOKEN_KEYS = [
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "cache_write_unknown_ttl",
  "cache_write",
  "output",
  "output_lower_bound_unknown_output",
];

function emptyAgg() {
  const tokens = {};
  for (const k of TOKEN_KEYS) tokens[k] = 0n;
  return {
    responses: 0,
    priced: 0,
    unpriced: 0,
    tokens,
    context_tokens: 0n,
    tokens_total: 0n,
    tokens_unpriced: 0n,
    usd_pico: 0n,
    reasoning_informational: 0n,
  };
}

/** `r` is a counted response: buckets, optional lb, price. */
function addToAgg(a, r) {
  const b = r.buckets;
  a.responses += 1;
  a.tokens.input_uncached += b.input_uncached;
  a.tokens.cache_read += b.cache_read;
  a.tokens.cache_write_5m += b.cache_write_5m;
  a.tokens.cache_write_1h += b.cache_write_1h;
  a.tokens.cache_write_unknown_ttl += b.cache_write_unknown_ttl;
  a.tokens.cache_write += b.cache_write;
  const ctxTokens =
    b.input_uncached + b.cache_read + b.cache_write_5m + b.cache_write_1h + b.cache_write_unknown_ttl + b.cache_write;
  a.context_tokens += ctxTokens;
  if (b.output !== null) {
    a.tokens.output += b.output;
    a.tokens_total += ctxTokens + b.output;
  } else {
    a.tokens.output_lower_bound_unknown_output += b.output_lower_bound;
    a.tokens_total += ctxTokens + b.output_lower_bound;
  }
  if (b.reasoning !== null) a.reasoning_informational += b.reasoning;
  if (r.price.priced) {
    a.priced += 1;
    a.usd_pico += r.price.pico;
  } else {
    a.unpriced += 1;
    a.tokens_unpriced += r.price.tokens_unpriced;
  }
}

function serializeAgg(a) {
  const tokens = {};
  for (const k of TOKEN_KEYS) tokens[k] = a.tokens[k].toString();
  return {
    responses: a.responses,
    responses_priced: a.priced,
    responses_unpriced: a.unpriced,
    tokens,
    context_tokens: a.context_tokens.toString(),
    tokens_total: a.tokens_total.toString(),
    tokens_unpriced: a.tokens_unpriced.toString(),
    // R3.9: exact cross-multiplication, `10 * tokens_unpriced > tokens_total`.
    unpriced_share_exceeds_c24: a.tokens_unpriced * C24[1] > a.tokens_total * C24[0],
    reasoning_informational: a.reasoning_informational.toString(),
    usd_pico: a.usd_pico.toString(),
  };
}

function sortedObject(map, fn) {
  const o = {};
  for (const k of [...map.keys()].sort()) o[k] = fn(map.get(k));
  return o;
}

function bump(map, k, n = 1) {
  map[k] = (map[k] ?? 0) + n;
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------


const SPEEDS = ["standard", "fast"];
const GEOS = ["not_available", "us"];
const TIERS = ["standard", "priority", "batch"];
const DIAG_TYPES = ["messages_changed", "tools_changed", "system_changed", "model_changed", "previous_message_not_found", "unavailable"];
const ITER_SHARED = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];

/** Chain ids (R0.9). Claude: session and agent. Codex: the thread alone (a thread can carry divergent session ids). */
const claudeChainId = (sess, agent) => `claude\u0000${sess}\u0000${agent ?? "main"}`;
const codexChainId = (thread) => `codex\u0000${thread}`;

const newLineCov = () => ({ lines_total: 0, lines_parse_error: 0, lines_truncated_tail: 0 });

function addTo(map, key, value) {
  let s = map.get(key);
  if (!s) map.set(key, (s = new Set()));
  s.add(value);
}

/** R15.7: a Claude record version has full support. */
function claudeSupported(version) {
  return typeof version === "string" && VERSION_RE.test(version) && CLAUDE_FULL_VERSIONS.includes(version);
}

/** Read one assistant copy (R1.2 counters, R2.1, R2.12, R2.15, R4.2). All counters are BigInt or a state (S4.2). */
function readClaudeCopy(rec) {
  // A copy without `message.usage` is still a copy of the request: it carries the message id and the model that the
  // key (R4.1) and model (R4.2) checks compare, so it is never dropped (R4.2, R13.2). It carries no counters.
  const msg = isObj(rec.message) ? rec.message : {};
  const usageless = !isObj(msg.usage);
  const u = usageless ? {} : msg.usage;
  const i = ctr(u.input_tokens);
  const r = ctr(u.cache_read_input_tokens);
  const wt = ctr(u.cache_creation_input_tokens);
  const o = ctr(u.output_tokens);
  let hasCC = false;
  let ccBad = false;
  let w5 = MISSING;
  let w1 = MISSING;
  const cc = u.cache_creation;
  if (cc === undefined || cc === null) {
    // absent: R2.1, w = wt in the unknown-TTL bucket
  } else if (isObj(cc)) {
    hasCC = true;
    w5 = ctr(cc.ephemeral_5m_input_tokens);
    w1 = ctr(cc.ephemeral_1h_input_tokens);
  } else {
    ccBad = true;
  }
  let extraRange = false;
  if (isObj(u.output_tokens_details) && ctr(u.output_tokens_details.thinking_tokens) === RANGE) extraRange = true;
  let it0 = null;
  if (Array.isArray(u.iterations) && isObj(u.iterations[0])) {
    it0 = {};
    for (const [k, v] of Object.entries(u.iterations[0])) {
      if (typeof v !== "number" || !Number.isInteger(v)) continue; // integer members only (R1.2)
      const x = ctr(v);
      if (x === RANGE) extraRange = true;
      else if (ITER_SHARED.includes(k)) it0[k] = x;
    }
  }
  const range = [i, r, wt, o, w5, w1].includes(RANGE) || extraRange;
  const incomplete = ccBad || [i, r, wt, o].some((x) => !isBig(x)) || (hasCC && (!isBig(w5) || !isBig(w1)));
  const speedPresent = u.speed !== undefined && u.speed !== null;
  // R4.2 diagnostics: the type of a non-null cache_miss_reason (S1.2: a listed type, `other`, or null when absent).
  const dg = isObj(msg.diagnostics) ? msg.diagnostics.cache_miss_reason : undefined;
  const diagType = isObj(dg) ? enumOf(dg.type, DIAG_TYPES) : null;
  return {
    rid: str(rec.requestId),
    mid: str(msg.id),
    usageless,
    chain: null,
    uuid: str(rec.uuid) ?? "",
    ts: null,
    model: claudeModel(msg.model),
    i, r, wt, o, w5, w1, hasCC,
    range,
    incomplete,
    it0,
    speedPresent,
    speed: enumOf(u.speed, SPEEDS),
    geo: enumOf(u.inference_geo, GEOS),
    tier: enumOf(u.service_tier, TIERS),
    diagType,
  };
}

/** Largest valid value of a field over the copies, or null when no copy has a valid one (S6.3). */
function maxPresent(copies, field) {
  return maxBig(copies.map((c) => c[field]).filter(isBig));
}

/** S6.3, Claude: i + r + W + o, W = wt when valid else the valid ones among w5 and w1; absent terms are 0. */
function claudeIncompleteScalar(pf) {
  const z = (k) => pf[k] ?? 0n;
  const W = pf.wt !== undefined ? pf.wt : z("w5") + z("w1");
  return z("i") + z("r") + W + z("o");
}

/**
 * Resolve the copies of one requestId into one response or an exclusion (R4.1, R4.2, R2.1 to R2.3).
 * Order of exclusion (S6.1): range (R2.15), incomplete (R2.12, a bad or missing timestamp of any copy included,
 * revision 11.1), key_conflict (R4.1), conflict_input and conflict_model (R4.2, both recorded, the first is the
 * exclusion). For a kept response conflict_output, conflict_iterations and conflict_modifier are decided independently
 * and every one that holds is recorded; conflict_diagnostics is recorded without taint. `anomaly` is true whenever R0.9
 * `request_anomaly` applies.
 */
function resolveClaude(allCopies, keyConflict) {
  // Counters are read from the copies that carry a usage object. A copy without one still takes part in the model
  // check below (R4.2, any copy), and a request with no usage-bearing copy at all is incomplete (R2.12).
  const copies = allCopies.filter((c) => !c.usageless);
  if (copies.some((c) => c.range)) return { excluded: "usage_range_failed", anomaly: true };
  if (copies.length === 0 || copies.some((c) => c.incomplete) || allCopies.some((c) => c.ts === null)) {
    const present_fields = {};
    for (const f of ["i", "r", "wt", "w5", "w1", "o"]) {
      const m = maxPresent(copies, f);
      if (m !== null) present_fields[f] = m;
    }
    return { excluded: "usage_incomplete", present_fields, tokens_incomplete: claudeIncompleteScalar(present_fields), anomaly: true };
  }
  if (keyConflict) return { excluded: "key_conflict", anomaly: true, conflicts: ["key_conflict"] };
  const c0 = copies[0];
  const conflicts = [];
  if (copies.some((c) => c.i !== c0.i || c.r !== c0.r || c.wt !== c0.wt || c.hasCC !== c0.hasCC || c.w5 !== c0.w5 || c.w1 !== c0.w1)) {
    conflicts.push("conflict_input");
  }
  const models = new Set(allCopies.map((c) => c.model).filter((m) => m !== null));
  if (models.size > 1) conflicts.push("conflict_model");
  if (conflicts.length > 0) return { excluded: conflicts[0], anomaly: true, conflicts };
  const model = models.size === 1 ? [...models][0] : null;

  const flags = [];
  // R2.1 write buckets
  const i = c0.i;
  const r = c0.r;
  let w5 = 0n;
  let w1 = 0n;
  let wu = 0n;
  if (c0.hasCC) {
    w5 = c0.w5;
    w1 = c0.w1;
    if (c0.wt !== w5 + w1) flags.push("bucket_mismatch");
  } else {
    wu = c0.wt;
    flags.push("w_unknown_ttl");
  }

  // R4.2 / R3.12: final copies, output, modifiers. conflict_output and conflict_iterations are independent (S6.1).
  const finals = copies.filter((c) => c.speedPresent);
  const outputLb = maxPresent(copies, "o") ?? 0n;
  let output = null;
  if (finals.length === 0) {
    flags.push("output_unknown");
  } else {
    const outputConflict = new Set(finals.map((c) => c.o)).size > 1;
    let iterConflict = false;
    for (const f of finals) {
      if (!f.it0) continue;
      const top = { input_tokens: f.i, output_tokens: f.o, cache_read_input_tokens: f.r, cache_creation_input_tokens: f.wt };
      for (const k of ITER_SHARED) if (k in f.it0 && f.it0[k] !== top[k]) iterConflict = true;
    }
    if (outputConflict) flags.push("conflict_output");
    if (iterConflict) flags.push("conflict_iterations");
    if (!outputConflict && !iterConflict) output = finals[0].o;
    else flags.push("output_unknown"); // S12.4: the output is unknown for any reason
  }
  // R4.2 / R3.12: the three modifiers come from the final copy alone. A non-final copy that carries a value the final
  // copy lacks, or a different one, is a disagreement. An absent value stays null: it is never defaulted.
  let mods = null;
  let modConflict = false;
  if (finals.length > 0) {
    const f0 = finals[0];
    if (finals.some((c) => c.speed !== f0.speed || c.geo !== f0.geo || c.tier !== f0.tier)) modConflict = true;
    for (const c of copies) {
      if (c.speedPresent) continue;
      if (c.geo !== null && c.geo !== f0.geo) modConflict = true;
      if (c.tier !== null && c.tier !== f0.tier) modConflict = true;
    }
    mods = { speed: f0.speed, geo: f0.geo, tier: f0.tier };
    if (modConflict) flags.push("conflict_modifier");
  }
  for (const f of ["conflict_output", "conflict_iterations", "conflict_modifier"]) if (flags.includes(f)) conflicts.push(f);
  // R4.2 diagnostics: two different non-null `type` values over the copies. No exclusion, no taint (R0.9, R10.4).
  const diagTypes = new Set(allCopies.map((c) => c.diagType).filter((t) => t !== null));
  if (diagTypes.size > 1) conflicts.push("conflict_diagnostics");
  const anomaly = flags.some((f) => ["bucket_mismatch", "conflict_output", "conflict_iterations", "conflict_modifier"].includes(f));
  return {
    excluded: null,
    anomaly,
    conflicts,
    model,
    flags,
    final: finals.length > 0,
    mods,
    modConflict,
    buckets: {
      input_uncached: i,
      cache_read: r,
      cache_write_5m: w5,
      cache_write_1h: w1,
      cache_write_unknown_ttl: wu,
      cache_write: 0n,
      output,
      output_lower_bound: output !== null ? output : outputLb,
      reasoning: null,
    },
  };
}

function unpriced(reason, bucketsTotal) {
  return { priced: false, reason, tokens_unpriced: bucketsTotal };
}

/**
 * R3.5, R3.4, R3.12: price one Claude response of an untainted chain. Gate order of R3.9 (revision 11.1): no model row
 * (R3.3), conflict_modifier, modifier_unverified (R3.12), speed_other, geo_other (value `other`), the row selection
 * (service tier row, fast row, Haiku high tier), geo_other where the table says geo does not apply, then an unknown
 * output (modifier_unverified), then the unknown TTL class (R3.5).
 */
function priceClaude(res, book, stats) {
  const b = res.buckets;
  const ctx = b.input_uncached + b.cache_read + b.cache_write_5m + b.cache_write_1h + b.cache_write_unknown_ttl;
  const tot = ctx + b.output_lower_bound; // lb equals output when output is known
  // S2.4: res.model is already in normal form; the table side was normalized when the book was built.
  const entry = usableEntry(book, res.model, "anthropic");
  if (!entry || claudeRow(entry.prices_usd_per_mtok) === null) return unpriced("unknown_model", tot); // R3.3
  if (res.modConflict) return unpriced("conflict_modifier", tot); // R4.2
  // R3.12: priced only with a final copy that carries speed, inference_geo and service_tier.
  if (!res.final || res.mods.geo === null || res.mods.tier === null) return unpriced("modifier_unverified", tot);
  const { speed, geo, tier } = res.mods;
  if (speed === "other") return unpriced("speed_other", tot);
  if (geo === "other") return unpriced("geo_other", tot);

  let row = claudeRow(entry.prices_usd_per_mtok);
  const hasTiers = isObj(entry.tiers);
  const aboveSplit = hasTiers && ctx > C26; // Haiku 5.5: tier by total_input = i + r + w (R2.2, R3.4), BigInt (S8.3)
  const nonStd = tier === "priority" || tier === "batch" || tier === "other";
  if (nonStd) {
    const st = isObj(entry.service_tier) && tier !== "other" ? entry.service_tier[tier] : undefined;
    const stRow = isObj(st) && verifiedObj(st, entry, book.table) ? claudeRow(st.prices_usd_per_mtok) : null;
    // The table defines a service tier row alone: a combination with fast or the geo multiplier is not defined.
    if (!stRow || speed === "fast" || geo === "us") return unpriced("service_tier_unpriced", tot);
    if (aboveSplit) return unpriced("tier_unverified", tot);
    row = stRow;
  } else if (speed === "fast") {
    const f = entry.fast;
    const fRow = isObj(f) && verifiedObj(f, entry, book.table) ? claudeRow(f.prices_usd_per_mtok) : null;
    if (!fRow) return unpriced("speed_fast_no_row", tot);
    // S8.2: fast with geo us needs the geo conditions plus modifiers.fast_with_geo_us verified and geo_us_applies.
    if (geo === "us" && !(fastVerifiedModifier(book) && f.geo_us_applies === true && geoApplies(book, entry))) {
      return unpriced("fast_geo_unverified", tot);
    }
    if (aboveSplit) return unpriced("tier_unverified", tot); // S8.3: a fast response above the Haiku split
    row = fRow;
  } else if (aboveSplit) {
    const hi = verifiedObj(entry.tiers, entry, book.table) ? claudeRow(entry.tiers.high) : null;
    if (!hi) return unpriced("tier_unverified", tot);
    row = hi;
  }
  if (geo === "us" && !geoApplies(book, entry)) return unpriced("geo_other", tot);
  // R3.9 gate (6) comes before gate (7): an unknown output is refused as modifier_unverified before the TTL class is
  // looked at. No partial output term exists (R3.5).
  if (b.output === null) return unpriced("modifier_unverified", tot);
  // R3.5: the write price depends on a TTL class the log does not show; one number only, so no range.
  if (b.cache_write_unknown_ttl > 0n) return unpriced("bucket_unknown", tot);

  let pico =
    b.input_uncached * row.input +
    b.cache_read * row.cache_read +
    b.cache_write_5m * row.cache_write_5m +
    b.cache_write_1h * row.cache_write_1h +
    b.output * row.output;
  if (geo === "us") pico = applyGeo(pico, stats);
  return { priced: true, pico, tokens_unpriced: 0n };
}

/** A sidecar (R1.2: meta, prefix, workflow run JSON, journal). It names no chain; a parse failure is a lost line. */
function readSidecar(ent, c, files) {
  c.files_total += 1; // S12.6: sidecars are discovered files
  let buf;
  try {
    buf = ent.read();
  } catch {
    c.files_unreadable += 1; // an unreadable file adds no line
    files.push({ mtimeMs: ent.mtimeMs, named: [], unparsed: 0, readable: false });
    return;
  }
  if (ent.kind === "sidecar_json" && buf.length > SIDECAR_MAX_BYTES) {
    // S12.6a: a JSON sidecar larger than 8 MiB is unreadable
    c.files_unreadable += 1;
    files.push({ mtimeMs: ent.mtimeMs, named: [], unparsed: 0, readable: false });
    return;
  }
  c.sidecar_files += 1;
  let unparsed = 0;
  if (ent.kind === "sidecar_json") {
    let text = buf.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    try {
      JSON.parse(text);
    } catch {
      // A line-duplicated one-line file is still readable line by line; anything else is a lost record: abstain.
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      let ok = lines.length > 0;
      for (const l of lines) {
        try {
          JSON.parse(l);
        } catch {
          ok = false;
          break;
        }
      }
      if (!ok) unparsed = 1; // an empty or broken JSON file
    }
    // S12.6: a JSON sidecar counts one line, and one parse error when it does not parse
    c.lines_total += 1;
    c.lines_parse_error += unparsed;
  } else {
    // S12.6, R1.3: journal.jsonl lines follow the line rules, truncated tail included
    const fc = newLineCov();
    for (const _ of jsonLines(buf, fc)) void _;
    unparsed = fc.lines_parse_error + fc.lines_truncated_tail;
    for (const k of ["lines_total", "lines_parse_error", "lines_truncated_tail"]) c[k] += fc[k];
  }
  if (unparsed > 0) c.sidecar_files_unparsed += 1;
  files.push({ mtimeMs: ent.mtimeMs, named: [], unparsed, readable: true });
}

/**
 * Identity of a Claude record for the logical counters (R17.6, R4.12). Two records are equal iff their projections
 * are equal field by field, where the projection is the tuple of every field that R1.2 retains for an assistant
 * record. A uuid alone, or any subset of the fields, is never enough: two records that share a uuid and differ in a
 * retained field are two records.
 */
const CLAUDE_GRAPH_TYPES = ["assistant", "system", "user", "attachment"];
const CLAUDE_KNOWN_TYPES = [...CLAUDE_GRAPH_TYPES, "cost-state"];

/** The content block projection of a message (R1.2: types, tool_use ids and names, tool_result ids; the content is never read). */
function blocksP(m) {
  const blocks = [];
  if (m !== null && Array.isArray(m.content)) {
    for (const b of m.content) {
      if (!isObj(b)) {
        blocks.push(["other", null, null, null]);
        continue;
      }
      const t = enumOf(b.type, ["text", "tool_use", "tool_result", "thinking"]);
      if (t === "tool_use") blocks.push([t, idP(b.id), enumOf(b.name, ["Agent", "Workflow"]), null]);
      else if (t === "tool_result") blocks.push([t, null, null, idP(b.tool_use_id)]);
      else blocks.push([t, null, null, null]);
    }
  } else if (m !== null && m.content !== undefined && m.content !== null) {
    return [{ s: BAD }]; // S1.3a: an array container that is present and not an array is bad
  }
  return blocks;
}

/**
 * Record equality projection of one Claude line (S5.1, R4.12): only the fields R1.2 retains for the record's own type,
 * each in its normal form. A non-object line and a record of an unlisted type project to their type alone.
 */
function claudeProjection(rec) {
  if (!isObj(rec)) return [null];
  const type = enumOf(rec.type, CLAUDE_KNOWN_TYPES);
  if (type === "cost-state") {
    // modelUsage.<model> integer members, as (model, member, value or range) triples sorted
    const out = [];
    const mu = rec.modelUsage;
    if (isObj(mu)) {
      for (const [model, members] of Object.entries(mu)) {
        if (!isObj(members)) continue;
        for (const [k, v] of Object.entries(members)) if (typeof v === "number") out.push([claudeModel(model), k, stateOf(ctr(v))]); // S4.1: a fractional number is `range`
      }
    }
    out.sort((x, y) => (pjson(x) < pjson(y) ? -1 : pjson(x) > pjson(y) ? 1 : 0));
    return [type, mu === undefined || mu === null ? null : isObj(mu) ? out : { s: BAD }];
  }
  // an unlisted type keeps only the fields R1.2 reads on all record types (ids, instants, session keys), under the type `other`
  const m = isObj(rec.message) ? rec.message : null;
  const version = rec.version === undefined || rec.version === null ? null : typeof rec.version === "string" && VERSION_RE.test(rec.version) ? rec.version : "unlisted";
  const common = [
    type === null || CLAUDE_GRAPH_TYPES.includes(type) ? type : "other",
    idP(rec.uuid),
    idP(rec.parentUuid),
    idP(rec.logicalParentUuid),
    idP(rec.sessionId),
    idP(rec.agentId),
    instP(rec.timestamp),
    version,
    boolP(rec.isCompactSummary),
    boolP(rec.isSidechain),
    boolP(rec.isApiErrorMessage),
    enumOf(rec.entrypoint, ["claude-desktop", "cli", "sdk-cli"]),
    enumOf(rec.effort, ["low", "medium", "high", "xhigh", "max"]),
    enumOf(rec.perTurnEffort, ["low", "medium", "high", "xhigh", "max"]),
    claudeModel(rec.advisorModel),
    rec.serverClassifierRequest !== undefined && rec.serverClassifierRequest !== null,
  ];
  if (type !== "user" && type !== "system" && type !== "assistant") return common;
  if (type === "user") return [...common, m !== null ? enumOf(m.role, ["user", "assistant"]) : null, blocksP(m)];
  if (type === "system") {
    const cm = isObj(rec.compactMetadata) ? rec.compactMetadata : null;
    return [...common, enumOf(rec.subtype, ["compact_boundary"]), cm !== null ? enumOf(cm.trigger, ["auto", "manual"]) : null, ctrP(cm?.preTokens), ctrP(cm?.postTokens)];
  }
  // assistant
  const u = m !== null && isObj(m.usage) ? m.usage : null;
  const cnt = ctrP;
  // S5.1: the integer members of iterations[0] as (name, value or range) pairs sorted by name; the object itself is
  // `missing` when absent or null and `bad` when not an object (S1.3a). A non-integer member is not an integer member.
  let iter;
  const itRaw = u !== null ? u.iterations : undefined;
  if (itRaw === undefined || itRaw === null) iter = null;
  else if (!Array.isArray(itRaw)) iter = { s: BAD };
  else if (itRaw[0] === undefined || itRaw[0] === null) iter = null;
  else if (!isObj(itRaw[0])) iter = { s: BAD };
  else {
    iter = [];
    for (const [k, v] of Object.entries(itRaw[0])) {
      if (typeof v !== "number" || !Number.isInteger(v)) continue;
      iter.push([k, stateOf(ctr(v))]);
    }
    iter.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  }
  // Containers that are not retained (diagnostics, cache_miss_reason, output_tokens_details) contribute only their
  // leaf fields (S5.1): an absent container and a container without the leaf are the same.
  const dg = m !== null && isObj(m.diagnostics) && isObj(m.diagnostics.cache_miss_reason) ? m.diagnostics.cache_miss_reason : null;
  const ccRaw = u !== null ? u.cache_creation : undefined;
  const cc = isObj(ccRaw) ? ccRaw : null;
  return [
    ...common,
    idP(rec.requestId),
    m !== null ? idP(m.id) : null,
    m !== null ? claudeModel(m.model) : null,
    m !== null ? enumOf(m.stop_reason, ["tool_use", "end_turn", "stop_sequence", "refusal"]) : null,
    u !== null,
    u !== null ? [cnt(u.input_tokens), cnt(u.cache_read_input_tokens), cnt(u.cache_creation_input_tokens), cnt(u.output_tokens)] : null,
    cc !== null ? [cnt(cc.ephemeral_5m_input_tokens), cnt(cc.ephemeral_1h_input_tokens)] : ccRaw === undefined || ccRaw === null ? null : { s: BAD },
    cnt(u !== null && isObj(u.output_tokens_details) ? u.output_tokens_details.thinking_tokens : undefined),
    iter,
    u !== null ? [enumOf(u.speed, SPEEDS), enumOf(u.inference_geo, GEOS), enumOf(u.service_tier, TIERS)] : null,
    [enumOf(dg?.type, DIAG_TYPES), cnt(dg?.cache_missed_input_tokens)],
    blocksP(m),
  ];
}

/** Hash of the record projection: the identity of a logical record (S5.2). */
function recordIdentity(rec) {
  return createHash("sha256").update(pjson(claudeProjection(rec))).digest("hex");
}

/** R2.15 non-counter integers of a Claude record that fail the range: the field names (S12.0). */
function claudeRangeFields(rec) {
  const out = [];
  if (!isObj(rec)) return out;
  const m = isObj(rec.message) ? rec.message : null;
  if (rec.type === "assistant") {
    const dg = m !== null && isObj(m.diagnostics) && isObj(m.diagnostics.cache_miss_reason) ? m.diagnostics.cache_miss_reason : null;
    if (dg !== null && ctr(dg.cache_missed_input_tokens) === RANGE) out.push("cache_missed_input_tokens");
  } else if (rec.type === "system") {
    const cm = isObj(rec.compactMetadata) ? rec.compactMetadata : null;
    if (cm !== null) for (const k of ["preTokens", "postTokens"]) if (ctr(cm[k]) === RANGE) out.push(k);
  } else if (rec.type === "cost-state" && isObj(rec.modelUsage)) {
    for (const [model, members] of Object.entries(rec.modelUsage)) {
      if (!isObj(members)) continue;
      for (const [k, v] of Object.entries(members)) if (typeof v === "number" && ctr(v) === RANGE) out.push(`mu:${claudeModel(model)}:${k}`);
    }
  }
  return out;
}

/** True the first time `key` is seen. */
function firstOf(set, key) {
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

function scanClaude(entries, cov, window) {
  const streams = new Map(); // chain id -> { sess, agent, start }
  const wfChains = new Set(); // S10.1: chains with a record in a file under subagents/workflows/wf_*/
  const requests = new Map(); // rid -> copies[] (usage-bearing copies of a supported version)
  const midToRids = new Map();
  const ridToMids = new Map();
  const holders = new Map(); // rid -> Set(chain id), every copy of any version (R15.7 structural read, R0.9 link iii)
  const sessChains = new Map(); // sessionId -> Set(chain id) (R0.9 link i)
  const unverifiedKeys = new Set();
  const logicalSeen = new Set(); // equal records count once in the logical counters (R17.6)
  const chains = new Set();
  const triggers = [];
  const files = [];
  cov.claude = { files_total: 0, files_unreadable: 0, lines_total: 0, lines_parse_error: 0, lines_truncated_tail: 0, known_type_count: 0, unlisted_type_count: 0, lines_unverified_version: 0, api_error_records: 0, records_unkeyed: 0, sidecar_files: 0, sidecar_files_unparsed: 0 };
  const c = cov.claude;
  const ledger = []; // event-time ledger of the logical counters that the window and live families thin out
  const dup = new Map(); // projection hash -> number of parsed lines (S5.2)
  for (const ent of entries) {
    if (ent.provider !== "claude") continue;
    if (ent.kind === "sidecar_json" || ent.kind === "sidecar_lines") {
      readSidecar(ent, c, files);
      continue;
    }
    c.files_total += 1;
    let buf;
    try {
      buf = ent.read();
    } catch {
      c.files_unreadable += 1;
      files.push({ mtimeMs: ent.mtimeMs, named: [], unparsed: 0, readable: false });
      continue;
    }
    const fc = newLineCov();
    const named = new Set();
    for (const rec of jsonLines(buf, fc)) {
      // S5.2, R17.6: the physical duplicate counters use the record projection of every parsed line
      const ident = recordIdentity(rec);
      dup.set(ident, (dup.get(ident) ?? 0) + 1);
      if (!isObj(rec)) {
        c.unlisted_type_count += 1;
        continue;
      }
      const type = rec.type;
      const graph = CLAUDE_GRAPH_TYPES.includes(type);
      const known = graph || type === "cost-state"; // S12.6a: cost-state is a known record type wherever it occurs
      if (known) c.known_type_count += 1;
      else c.unlisted_type_count += 1;
      // R4.11 / R0.9: identity is read per record from (sessionId, agentId or main), never from the path. S10.1: an
      // agentId that is missing, bad or the string `main` is the main chain.
      const sess = str(rec.sessionId);
      const agentRaw = str(rec.agentId);
      const agent = agentRaw === "main" ? null : agentRaw;
      const chain = sess === null ? null : claudeChainId(sess, agent);
      if (chain !== null) {
        chains.add(chain);
        named.add(chain);
        addTo(sessChains, sess, chain);
        if (ent.kind === "workflow_agent") wfChains.add(chain);
      } else if (graph) {
        triggers.push({ reason: "unattributed_record", names: "provider" }); // R0.9: no key, no accounting
      }
      const supported = claudeSupported(rec.version);
      if (!known) continue;
      const ts = instantNs(rec.timestamp); // S3: BigInt nanoseconds or null
      // S12.0, R2.15: non-counter integers that fail the range, once per logical record and field. A cost-state record
      // is not a request, so its version is not looked at.
      if (type === "cost-state" || (graph && supported)) {
        for (const f of claudeRangeFields(rec)) {
          if (firstOf(logicalSeen, `frf\u0000${ident}\u0000${f}`)) ledger.push({ t: ts, chain: type === "cost-state" ? null : chain, inc: { fields_range_failed: 1 }, kinds: [], tok: {}, tokInc: 0n, tokInvalid: 0n });
        }
      }
      if (!graph) continue;
      if (!supported) c.lines_unverified_version += 1;
      if (supported && chain !== null) {
        let st = streams.get(chain);
        if (!st) streams.set(chain, (st = { sess, agent, start: null }));
        if (ts !== null && (st.start === null || ts < st.start)) st.start = ts; // R4.6 stream_start
      }
      if (type !== "assistant") continue;
      const msg = isObj(rec.message) ? rec.message : null;
      // S12.0: logical records that carry a usage object, chainless ones included; unmappable ones are incomplete or range (S4.3).
      // API error records (isApiErrorMessage true or model <synthetic>) are not requests (R2.14) and are not counted here.
      const isApiError = rec.isApiErrorMessage === true || claudeModel(msg?.model) === "<synthetic>";
      if (!isApiError && msg !== null && isObj(msg.usage) && supported && firstOf(logicalSeen, `ub\u0000${ident}`)) {
        const cp = readClaudeCopy(rec);
        const inc = { records_usage_bearing: 1 };
        if (cp.range || cp.incomplete) inc.records_usage_unmappable = 1;
        ledger.push({ t: ts, chain, inc, kinds: [], tok: {}, tokInc: 0n, tokInvalid: 0n });
      }
      if (rec.isApiErrorMessage === true || claudeModel(msg?.model) === "<synthetic>") {
        if (supported && firstOf(logicalSeen, `api\u0000${ident}`)) {
          // R2.14, logical (R17.6), S12.1: a ledger counter, by event time in the window and outside live families
          ledger.push({ t: ts, chain, inc: { api_error_records: 1 }, kinds: [], tok: {}, tokInc: 0n, tokInvalid: 0n });
        }
        continue;
      }
      const rid = str(rec.requestId);
      if (rid === null) {
        // R2.13: the counter covers records that carry usage; the trigger is broader. A keyless non-error assistant
        // record with a string sessionId is an anomaly with or without usage, whatever its version: it taints its chain.
        if (msg && isObj(msg.usage) && supported && firstOf(logicalSeen, `unkeyed\u0000${ident}`)) {
          c.records_unkeyed += 1; // logical (R17.6)
          ledger.push({ t: ts, chain, inc: { records_unkeyed: 1 }, kinds: [], tok: {}, tokInc: 0n, tokInvalid: 0n });
        }
        if (chain !== null) triggers.push({ reason: "request_anomaly", names: [chain], scope: "chains" }); // R0.9 rev 11.1: chain scoped
        continue;
      }
      if (!supported) unverifiedKeys.add(rid); // R15.7: one unverified copy makes the key unverified
      if (chain === null) continue;
      addTo(holders, rid, chain);
      if (!supported) continue;
      const copy = readClaudeCopy(rec);
      copy.ts = ts;
      copy.chain = chain;
      let list = requests.get(copy.rid);
      if (!list) requests.set(copy.rid, (list = []));
      list.push(copy);
      if (copy.mid) {
        addTo(ridToMids, copy.rid, copy.mid);
        addTo(midToRids, copy.mid, copy.rid);
      }
    }
    for (const k of ["lines_total", "lines_parse_error", "lines_truncated_tail"]) c[k] += fc[k];
    files.push({ mtimeMs: ent.mtimeMs, named: [...named], unparsed: fc.lines_parse_error + fc.lines_truncated_tail, readable: true });
  }
  // R17.6: lines whose record equals an earlier one, and distinct records with at least one such line (physical counters)
  c.lines_duplicate_collapsed = 0;
  c.duplicate_records_collapsed = 0;
  for (const n of dup.values()) {
    if (n > 1) {
      c.lines_duplicate_collapsed += n - 1;
      c.duplicate_records_collapsed += 1;
    }
  }
  cov.claude_requests_unverified_version = unverifiedKeys.size;
  // R15.7 / R0.9 version_unverified: names every chain that holds a copy of an unverified key.
  for (const rid of [...unverifiedKeys].sort()) triggers.push({ reason: "version_unverified", names: [...(holders.get(rid) ?? [])] });

  // R0.9 family groups: link (i) a shared sessionId, link (iii) a shared request key.
  const groups = [];
  const keyGroups = []; // link (iii) alone: the scope of a chain scoped request_anomaly (rev 11.1)
  for (const s of sessChains.values()) if (s.size > 1) groups.push([...s]);
  for (const s of holders.values()) if (s.size > 1) {
    groups.push([...s]);
    keyGroups.push([...s]);
  }

  const out = [];
  const baseline = []; // accounted responses before `since` (R5.10, S12.5); live families are removed after the taint step
  cov.claude_responses = {
    requests_total: 0,
    responses_total: 0,
    requests_conflict: 0,
    requests_conflict_modifier: 0,
    requests_conflict_by_kind: {},
    responses_usage_range_failed: 0,
    responses_usage_incomplete: 0,
    tokens_in_incomplete_by_field: {},
    responses_bucket_mismatch: 0,
    output_unknown_requests: 0,
    requests_no_final_copy: 0,
    replay_requests_excluded: 0,
    replay_ownership_ambiguous: 0,
    baseline_requests_loaded: 0,
  };
  for (const rid of [...requests.keys()].sort()) {
    if (unverifiedKeys.has(rid)) continue; // R15.7: no accounting is derived from an unverified key
    const copies = requests.get(rid);
    const heldBy = [...(holders.get(rid) ?? [])];
    // R4.1: requestId and message.id are 1 to 1.
    let keyConflict = false;
    const mids = ridToMids.get(rid);
    if (mids) {
      if (mids.size > 1) keyConflict = true;
      for (const m of mids) if (midToRids.get(m).size > 1) keyConflict = true;
    }
    // S7.2, S6.5: t_first is the minimum valid instant over all copies of the key; a kept response has one for every copy.
    const tFirst = minBig(copies.map((cp) => cp.ts).filter(isBig));
    const inWindow = windowHas(window, tFirst);
    const res = resolveClaude(copies, keyConflict);
    // R4.6, S10.5: ownership is decided for every key held by two or more logical streams, excluded keys included. The
    // owner is the stream with the earliest stream_start; a tie is ownership_ambiguous (counter and taint).
    const sids = [...new Set(copies.map((cp) => cp.chain))];
    let owner = sids[0];
    let ambiguous = false;
    if (sids.length > 1) {
      const startOf = (st) => streams.get(st).start; // BigInt nanoseconds or null (null sorts last)
      const minStart = sids.map(startOf).reduce((x, y) => (cmpNullLast(x, y) <= 0 ? x : y));
      const tied = sids.filter((st) => startOf(st) === minStart);
      if (tied.length > 1) {
        ambiguous = true;
        tied.sort((x, y) => {
          const sa = streams.get(x);
          const sb = streams.get(y);
          const ka = `${sa.sess ?? ""}\u0001${sa.agent ?? "main"}`;
          const kb = `${sb.sess ?? ""}\u0001${sb.agent ?? "main"}`;
          return ka < kb ? -1 : ka > kb ? 1 : 0;
        });
      }
      owner = tied[0];
    }
    if (ambiguous) {
      triggers.push({ reason: "ownership_ambiguous", names: heldBy }); // R4.6, R0.9
      ledger.push({ t: tFirst, chain: owner, inc: { replay_ownership_ambiguous: 1 }, kinds: [], tok: {}, tokInc: 0n, tokInvalid: 0n });
    }
    const L = { t: tFirst, chain: heldBy[0] ?? null, inc: { responses_total: 1 }, kinds: [...(res.conflicts ?? [])], tok: {}, tokInc: 0n, tokInvalid: 0n };
    // R17.1: once per request, not once per code. conflict_diagnostics is a kind only: no exclusion, no taint (S6.1).
    if (L.kinds.some((k) => k !== "conflict_diagnostics")) L.inc.requests_conflict = 1;
    if (L.kinds.includes("conflict_modifier")) L.inc.requests_conflict_modifier = 1;
    ledger.push(L);
    if (res.anomaly) triggers.push({ reason: "request_anomaly", names: heldBy, scope: "chains" }); // R0.9 rev 11.1: chain scoped (plus link (iii) component), scan-wide (not windowed)
    if (res.excluded) {
      if (res.excluded === "usage_range_failed") L.inc.responses_usage_range_failed = 1;
      else if (res.excluded === "usage_incomplete") {
        L.inc.responses_usage_incomplete = 1;
        for (const [f, v] of Object.entries(res.present_fields)) L.tok[f] = v;
        L.tokInc = res.tokens_incomplete; // S6.3: one scalar per response
      }
      if (inWindow) out.push({ provider: "claude", key: rid, status: `excluded:${res.excluded}`, counted: false, chain: null });
      continue;
    }
    if (res.flags.includes("bucket_mismatch")) L.inc.responses_bucket_mismatch = 1;
    // S10.1: main for the main chain (agentId missing); otherwise workflow_agent iff a file of the chain lies under
    // subagents/workflows/wf_*/, else subagent.
    const ownerStream = streams.get(owner);
    const kind = ownerStream.agent === null ? "main" : wfChains.has(owner) ? "workflow_agent" : "subagent";
    if (!inWindow) {
      if (beforeWindow(window, tFirst)) baseline.push({ chain: owner }); // R5.10, S12.5
      continue;
    }
    // S7.5, S12.1: the replayed representations of an accounted response, one per non-owner chain that holds a copy
    if (sids.length > 1) ledger.push({ t: tFirst, chain: owner, inc: { replay_requests_excluded: sids.length - 1 }, kinds: [], tok: {}, tokInc: 0n, tokInvalid: 0n });
    out.push({
      provider: "claude",
      key: rid,
      kind,
      chain: owner,
      model: res.model,
      flags: res.flags,
      buckets: res.buckets,
      event_ms: tFirst === null ? null : nsToMs(tFirst),
      event_ns: tFirst,
      pr: res,
      counted: true,
      status: "counted",
    });
  }
  return { responses: out, baseline, facts: { chains, groups, keyGroups, triggers, files }, ledger };
}

// ---------------------------------------------------------------------------
// R0.9 Global integrity abstention: families, live families, taint.
// ---------------------------------------------------------------------------

/**
 * Input per provider:
 *   chains    Set of chain ids seen by a structural read of any version (R15.7).
 *   groups    arrays of chain ids that are linked: R0.9 links (i), (ii) and (iii). Each group is fully connected.
 *   keyGroups (optional) the groups of link (iii) alone. A trigger with scope "chains" (the request_anomaly of a Claude
 *             request, revision 11.1) taints the chains it names and every chain connected to them over keyGroups,
 *             transitively, and nothing else.
 *   triggers  { reason, names: string[] | "provider" } for every reason except unparsed_line and file_unreadable.
 *   files     { mtimeMs, named: string[], unparsed: number, readable: boolean } per physical file.
 * Output: per chain { family, tainted, reasons (spec enum order), live }, plus the counters of R0.9 "Coverage".
 * The result depends on sets only (sorted before use), so file order, line order and duplication cannot change it.
 */
function computeTaint(facts, runStartMs) {
  const ids = new Set(facts.chains);
  for (const f of facts.files) for (const n of f.named) ids.add(n);
  for (const t of facts.triggers) if (Array.isArray(t.names)) for (const n of t.names) ids.add(n);
  const order = [...ids].sort();
  const index = new Map(order.map((id, k) => [id, k]));
  const parent = order.map((_, k) => k);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };
  for (const g of facts.groups) {
    const m = g.filter((x) => index.has(x)).map((x) => index.get(x));
    for (let k = 1; k < m.length; k += 1) union(m[0], m[k]);
  }

  // Live files (R0.9): unparseable line, names a chain, modified at most C35 before the run start (a later mtime
  // counts as live). A file that names no chain is never live.
  const liveRoots = new Set();
  const triggers = [...facts.triggers];
  for (const f of facts.files) {
    if (!f.readable) {
      triggers.push({ reason: "file_unreadable", names: "provider" });
      continue;
    }
    if (f.unparsed <= 0) continue;
    // A missing mtime, an mtime of 0 and a failed stat all mean "never live".
    const live = f.named.length > 0 && typeof f.mtimeMs === "number" && f.mtimeMs > 0 && runStartMs - f.mtimeMs <= C35_MS;
    if (live) for (const n of f.named) liveRoots.add(find(index.get(n)));
    else triggers.push({ reason: "unparsed_line", names: f.named.length > 0 ? f.named : "provider" });
  }

  // Link (iii) adjacency, for the chain scoped reasons (revision 11.1). Walked by breadth first search.
  const keyAdj = new Map();
  for (const g of facts.keyGroups ?? []) {
    for (const a of g) {
      if (!keyAdj.has(a)) keyAdj.set(a, new Set());
      for (const b of g) if (a !== b) keyAdj.get(a).add(b);
    }
  }
  const keyComponent = (start) => {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const cur = queue.shift();
      for (const nb of keyAdj.get(cur) ?? []) if (!seen.has(nb)) (seen.add(nb), queue.push(nb));
    }
    return seen;
  };
  const chainReasons = new Map(); // chain id -> Set(reason), chain scoped reasons only

  // A reason taints every chain in the family of each chain it names; "provider" taints every chain.
  const famReasons = new Map(); // root -> Set(reason)
  const addReason = (root, reason) => {
    let s = famReasons.get(root);
    if (!s) famReasons.set(root, (s = new Set()));
    s.add(reason);
  };
  const roots = [...new Set(order.map((_, k) => find(k)))];
  for (const t of triggers) {
    if (t.names === "provider") for (const r of roots) addReason(r, t.reason);
    else if (t.scope === "chains") {
      for (const n of t.names) {
        if (!index.has(n)) continue;
        for (const m of keyComponent(n)) {
          if (!chainReasons.has(m)) chainReasons.set(m, new Set());
          chainReasons.get(m).add(t.reason);
        }
      }
    } else for (const n of t.names) if (index.has(n)) addReason(find(index.get(n)), t.reason);
  }

  // Family numbers by the smallest chain id of the family (deterministic).
  const famNo = new Map();
  for (let k = 0; k < order.length; k += 1) {
    const r = find(k);
    if (!famNo.has(r)) famNo.set(r, famNo.size);
  }
  const chainsOut = new Map();
  const byReason = Object.fromEntries(TAINT_REASONS.map((r) => [r, 0]));
  let chainsTotal = 0;
  let chainsTainted = 0;
  for (let k = 0; k < order.length; k += 1) {
    const r = find(k);
    const live = liveRoots.has(r);
    const set = famReasons.get(r);
    const own = chainReasons.get(order[k]);
    const reasons = TAINT_REASONS.filter((x) => set?.has(x) || own?.has(x));
    const tainted = reasons.length > 0;
    chainsOut.set(order[k], { family: famNo.get(r), tainted, reasons, live });
    if (live) continue; // live families are in none of the counters below (R0.9 Coverage)
    chainsTotal += 1;
    if (tainted) {
      chainsTainted += 1;
      for (const x of reasons) byReason[x] += 1;
    }
  }
  // A family is tainted iff any of its chains is; it is ordinal_unverified iff any of its chains holds that reason.
  const famTainted = new Set();
  const famOrdinal = new Set();
  for (let k = 0; k < order.length; k += 1) {
    const info = chainsOut.get(order[k]);
    if (info.tainted) famTainted.add(find(k));
    if (info.reasons.includes("ordinal_unverified")) famOrdinal.add(find(k));
  }
  let familiesTotal = 0;
  let familiesTainted = 0;
  let familiesOrdinal = 0;
  for (const r of roots) {
    if (liveRoots.has(r)) continue;
    familiesTotal += 1;
    if (famTainted.has(r)) familiesTainted += 1;
    if (famOrdinal.has(r)) familiesOrdinal += 1;
  }
  return {
    chains: chainsOut,
    chains_total: chainsTotal,
    chains_tainted: chainsTainted,
    chains_tainted_by_reason: byReason,
    families_total: familiesTotal,
    families_tainted: familiesTainted,
    families_ordinal_unverified: familiesOrdinal,
    families_live_skipped: liveRoots.size,
  };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

const CODEX_KNOWN = ["session_meta", "turn_context", "token_usage_record", "event_msg", "compacted", "response_item"];

// R1.2, R4.12: the Codex retained projection is typed. Every field is reduced to an enum member, a validated id, an
// instant, a bounded token or a counter state before it enters a projection; an invalid raw value is never kept (S5.1).
const CODEX_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.]+)?$/;
const CODEX_SOURCE_KINDS = ["cli", "exec", "vscode", "mcp", "subagent"];
const CODEX_THREAD_SOURCES = ["user", "subagent", "agent_created_thread", "automation", "guardian_review"];
const CODEX_ORIGINATORS = ["codex_cli", "codex_exec", "codex_vscode", "codex_cli_rs", "codex_exec_rs"];
const CODEX_AGENT_ROLES = ["default", "worker", "explorer", "awaiter"];
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const codexVersion = (v) => (typeof v === "string" && v.length <= 40 && CODEX_VERSION_RE.test(v) ? v : "unlisted");
/** A bounded token (comp_hash, collaboration mode): the token, `missing` (null) or `bad`. */
const tokenP = (v) => (typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v) ? v : v === undefined || v === null ? null : { s: BAD });

/** R1.2, S5.1: integer members of a cumulative counter object, sorted by name, as (name, value or range) pairs. */
function cumMembers(v) {
  if (v === undefined || v === null) return null; // missing
  if (!isObj(v)) return { s: BAD };
  const out = [];
  for (const k of Object.keys(v)) if (typeof v[k] === "number" && Number.isInteger(v[k])) out.push([k, stateOf(ctr(v[k]))]);
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

function parseCodexFile(buf, c, fc, dup) {
  const fd = { metas: [], ctxs: [], turs: [], markers: [], ordRecs: [], tokenCountEvents: 0, lines: 0 };
  for (const obj of jsonLines(buf, fc)) {
    fd.lines += 1;
    if (!isObj(obj)) {
      c.unlisted_type_count += 1;
      dup.set("[null]", (dup.get("[null]") ?? 0) + 1);
      continue;
    }
    const type = typeof obj.type === "string" ? obj.type : null;
    if (type !== null && CODEX_KNOWN.includes(type)) c.known_type_count += 1;
    else c.unlisted_type_count += 1;
    const payload = isObj(obj.payload) ? obj.payload : {};
    // S1.4: the envelope ordinal is an optional integer with the counter grammar and keeps its states.
    const ordS = ctr(obj.ordinal);
    const ord = isBig(ordS) ? ordS : null;
    const ordPresent = ordS !== MISSING;
    const tsS = instantOf(obj.timestamp); // S3: BigInt nanoseconds, `missing` or `bad`
    const tsNs = isBig(tsS) ? tsS : null;
    const base = [enumOf(obj.type, CODEX_KNOWN), stateOf(tsS), stateOf(ordS)];
    let proj = pjson(base);
    let decision = false;

    if (type === "session_meta") {
      decision = true;
      const src = payload.source;
      const sub = isObj(src) && isObj(src.subagent) ? src.subagent : null;
      const spawn = sub && isObj(sub.thread_spawn) ? sub.thread_spawn : null;
      const hs = ctr(payload.subagent_history_start_ordinal);
      const meta = {
        id: str(payload.id),
        sessionId: str(payload.session_id),
        cliVersion: codexVersion(payload.cli_version),
        forkedFrom: str(payload.forked_from_id),
        parentThreadId: str(payload.parent_thread_id),
        spawnParent: spawn ? str(spawn.parent_thread_id) : null,
        hasSpawn: spawn !== null,
        subOther: sub !== null && sub.other !== undefined && sub.other !== null, // presence; JSON null is absent (S1.3)
        histKey: stateOf(hs), // S1.4: value, missing, bad or range
        histStart: isBig(hs) ? hs : null,
        threadSource: enumOf(payload.thread_source, CODEX_THREAD_SOURCES),
        ord,
        tsNs,
      };
      // `source` kind (enum): a listed string, `subagent` for an object with a subagent object, `other` for anything else
      // present, missing for absent or null.
      const srcKind = src === undefined || src === null ? null : typeof src === "string" ? enumOf(src, CODEX_SOURCE_KINDS) : sub !== null ? "subagent" : "other";
      // The shape that R4.11 compares between own session_meta records of one id.
      meta.shape = pjson([idP(payload.session_id), idP(payload.forked_from_id), meta.histKey]);
      proj = pjson([...base, idP(payload.id), idP(payload.session_id), instP(payload.timestamp), meta.cliVersion, idP(payload.forked_from_id), idP(payload.parent_thread_id), spawn ? idP(spawn.parent_thread_id) : null, spawn ? ctrP(spawn.depth) : null, spawn !== null, sub !== null, meta.subOther, meta.histKey, enumOf(payload.originator, CODEX_ORIGINATORS), srcKind, meta.threadSource, enumOf(payload.agent_role, CODEX_AGENT_ROLES)]);
      meta.proj = proj;
      fd.metas.push(meta);
    } else if (type === "turn_context") {
      decision = true;
      const ctx = {
        turnId: str(payload.turn_id),
        model: ctxModel(payload.model),
        ord,
        tsNs,
      };
      proj = pjson([...base, idP(payload.turn_id), idP(payload.root_turn_id), ctx.model, enumOf(payload.effort, CODEX_EFFORTS), tokenP(payload.comp_hash), isObj(payload.collaboration_mode) ? tokenP(payload.collaboration_mode.mode) : null]);
      fd.ctxs.push(ctx);
    } else if (type === "token_usage_record") {
      decision = true;
      const u = isObj(payload.usage) ? payload.usage : {};
      const tu = isObj(payload.thread_token_usage) ? payload.thread_token_usage : {};
      const tur = {
        responseId: str(payload.response_id),
        threadId: str(payload.thread_id),
        sessionId: str(payload.session_id),
        turnId: str(payload.turn_id),
        in: ctr(u.input_tokens),
        c: ctr(u.cached_input_tokens),
        cw: ctr(u.cache_write_input_tokens),
        out: ctr(u.output_tokens),
        rs: ctr(u.reasoning_output_tokens),
        total: ctr(u.total_tokens),
        ord,
        tsNs,
      };
      const rawUsage = [tur.in, tur.c, tur.cw, tur.out, tur.rs, tur.total].map(stateOf);
      tur.usageKey = pjson(rawUsage);
      proj = pjson([...base, idP(payload.response_id), idP(payload.thread_id), idP(payload.session_id), idP(payload.turn_id), rawUsage, ctrP(tu.total_tokens), cumMembers(payload.thread_token_usage), cumMembers(payload.turn_token_usage)]);
      tur.proj = proj;
      fd.turs.push(tur);
    } else if (type === "event_msg") {
      const pt = enumOf(payload.type, ["token_count", "thread_settings_applied"]);
      proj = pjson([...base, pt]);
      if (pt === "token_count") fd.tokenCountEvents += 1;
      if (pt === "thread_settings_applied") {
        decision = true;
        fd.markers.push({ ord, tsNs });
      }
    } else if (type === "compacted") {
      decision = true;
      proj = pjson([...base, idP(payload.compaction_response_id), idP(payload.window_id), ctrP(payload.window_number), payload.latest_token_usage_record === null || payload.latest_token_usage_record === undefined]);
    }
    dup.set(proj, (dup.get(proj) ?? 0) + 1); // S5.2, R17.6: the physical duplicate counters
    if (decision || ordPresent) {
      // R4.12 (a): an ordinal-decision record needs a valid ordinal and a valid instant. Any other record that carries an
      // ordinal must only satisfy the ordinal range (S3.5: a non-decision record without a valid instant fails nothing).
      const bad = (decision && (!isBig(ordS) || tsNs === null)) || (ordPresent && !isBig(ordS));
      fd.ordRecs.push({ ord, tsNs, proj, bad });
    }
  }
  return fd;
}

/** R4.12: ordinal_verified for the records of one logical stream. */
function ordinalVerified(recs) {
  const byOrd = new Map();
  for (const r of recs) {
    if (r.bad) return false; // (a)
    const prev = byOrd.get(r.ord);
    if (prev === undefined) byOrd.set(r.ord, r);
    else if (prev.proj !== r.proj) return false; // (b) collision
  }
  // (c) S3.5: the ordinal-bearing records in ordinal order; a record without a valid instant is skipped.
  const sorted = [...byOrd.values()].filter((r) => r.tsNs !== null).sort((a, b) => (a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : 0));
  for (let k = 1; k < sorted.length; k += 1) if (sorted[k].tsNs < sorted[k - 1].tsNs) return false;
  return true;
}

/**
 * S10.2, S10.3: the kind of a Codex stream is decided over the SET of its own session_meta records (or of its copied ones
 * when it has none), with the precedence subagent, then helper, then classifier, then main. No record is picked and no order
 * of records, files or lines can change the result. An empty set is `main`.
 */
function codexKindOfSet(list) {
  if (list.some((m) => m.hasSpawn || m.threadSource === "subagent" || m.threadSource === "agent_created_thread")) return "subagent";
  if (list.some((m) => m.threadSource === "automation")) return "helper";
  if (list.some((m) => m.threadSource === "guardian_review")) return "classifier";
  return "main";
}

function scanCodex(entries, cov, window) {
  cov.codex = { files_total: 0, files_unreadable: 0, lines_total: 0, lines_parse_error: 0, lines_truncated_tail: 0, known_type_count: 0, unlisted_type_count: 0, files_without_response_id: 0, token_count_events_without_response_id: 0, files_unassigned_stream: 0, files_assigned_by_stream: 0, files_stream_conflict: 0, files_copy_exposed: 0, lines_unverified_version: 0 };
  const c = cov.codex;
  const files = [];
  const dup = new Map(); // projection -> number of parsed lines (S5.2)
  const factFiles = [];
  const triggers = [];
  for (const ent of entries) {
    if (ent.provider !== "codex") continue;
    c.files_total += 1;
    let buf;
    try {
      buf = ent.read();
      if (ent.zst) {
        if (typeof zlib.zstdDecompressSync !== "function") throw new Error("no_zstd");
        buf = zlib.zstdDecompressSync(buf);
      }
    } catch {
      c.files_unreadable += 1; // R0.2, R17.1: counted, never skipped silently; taints every Codex chain (R0.9)
      factFiles.push({ mtimeMs: ent.mtimeMs, named: [], unparsed: 0, readable: false });
      continue;
    }
    const fc = newLineCov();
    const fd = parseCodexFile(buf, c, fc, dup);
    for (const k of ["lines_total", "lines_parse_error", "lines_truncated_tail"]) c[k] += fc[k];
    fd.unparsed = fc.lines_parse_error + fc.lines_truncated_tail;
    fd.mtimeMs = ent.mtimeMs;
    // R0.9 named chains: every id of a session_meta in F (own or copied) and every thread_id of a usage record in F.
    fd.named = [...new Set([...fd.metas.map((m) => m.id), ...fd.turs.map((t) => t.threadId)].filter((x) => x !== null).map(codexChainId))].sort();
    if (fd.turs.length === 0 && fd.tokenCountEvents > 0) {
      c.files_without_response_id += 1; // R2.9
      c.token_count_events_without_response_id += fd.tokenCountEvents;
      triggers.push({ reason: "unlogged_usage", names: fd.named.length > 0 ? fd.named : "provider" });
    }
    factFiles.push({ mtimeMs: ent.mtimeMs, named: fd.named, unparsed: fd.unparsed, readable: true });
    files.push(fd);
  }

  // R4.11: own session_meta per file, identity sets.
  for (const fd of files) {
    fd.own = fd.metas.filter((m) => !fd.metas.some((o) => o !== m && o.forkedFrom !== null && o.forkedFrom === m.id));
    fd.ownIds = new Set(fd.own.map((m) => m.id).filter((x) => x !== null));
    fd.turIds = new Set(fd.turs.map((t) => t.threadId).filter((x) => x !== null));
    fd.I = new Set([...fd.ownIds, ...fd.turIds]);
  }
  // R4.13: FS over the whole scan, every file of every version.
  const FS = new Set();
  for (const fd of files) for (const m of fd.metas) if (m.forkedFrom !== null) FS.add(m.forkedFrom);
  for (const fd of files) {
    // R0.9 unattributed_record: a record whose chain key is missing (session_meta id, usage record thread_id).
    if (fd.metas.some((m) => m.id === null) || fd.turs.some((t) => t.threadId === null)) {
      triggers.push({ reason: "unattributed_record", names: "provider" });
    }
    fd.copyExposed = [...fd.ownIds].some((x) => FS.has(x) && !fd.turs.some((t) => t.threadId === x));
    if (fd.I.size === 1) {
      fd.assignment = "assigned";
      c.files_assigned_by_stream += 1;
    } else if (fd.I.size === 0) {
      fd.assignment = "unassigned";
      c.files_unassigned_stream += 1;
      if (fd.lines > 0) triggers.push({ reason: "unattributed_record", names: "provider" }); // R4.11: non-empty and unassigned
    } else {
      fd.assignment = "conflict";
      c.files_stream_conflict += 1;
      triggers.push({ reason: "stream_unresolved", names: [...fd.I].map(codexChainId) }); // R4.11
    }
    if (fd.copyExposed) {
      c.files_copy_exposed += 1;
      triggers.push({ reason: "copy_exposed", names: fd.named }); // R4.13
    }
  }

  // Own session_meta of the whole scan; all session_meta of the scan by id (versions, R15.7).
  const ownMetasById = new Map();
  const allMetasById = new Map();
  for (const fd of files) {
    for (const m of fd.metas) {
      if (m.id === null) continue;
      let l = allMetasById.get(m.id);
      if (!l) allMetasById.set(m.id, (l = []));
      l.push(m);
    }
    for (const m of fd.own) {
      if (m.id === null) continue;
      let l = ownMetasById.get(m.id);
      if (!l) ownMetasById.set(m.id, (l = []));
      l.push(m);
    }
  }
  // R4.11: two own session_meta with one id that differ in session_id, forked_from_id or subagent_history_start_ordinal.
  for (const [id, metas] of ownMetasById) {
    const shapes = new Set(metas.map((m) => m.shape));
    if (shapes.size > 1) triggers.push({ reason: "stream_unresolved", names: [codexChainId(id)] });
  }

  // R2.17 (d): TM(T) over every turn_context of every file; the files that hold a context or a usage record of T.
  const turns = new Map(); // turn id -> { models: Set, named: Set }
  const turn = (id) => {
    let t = turns.get(id);
    if (!t) turns.set(id, (t = { models: new Set(), named: new Set() }));
    return t;
  };
  for (const fd of files) {
    for (const x of fd.ctxs) {
      if (x.turnId === null) continue;
      const t = turn(x.turnId);
      t.models.add(x.model); // S2.3: a null model IS a member of TM(T): A plus null conflicts (conservative)
      for (const n of fd.named) t.named.add(n);
    }
    for (const x of fd.turs) {
      if (x.turnId === null) continue;
      for (const n of fd.named) turn(x.turnId).named.add(n);
    }
  }
  for (const t of turns.values()) if (t.models.size >= 2) triggers.push({ reason: "turn_model_conflicted", names: [...t.named] });

  // Logical streams: the files assigned to one id (R4.11).
  const streams = new Map();
  const getStream = (id) => {
    let s = streams.get(id);
    if (!s) {
      s = { id, files: [], ordRecs: [], ctxs: [], markers: [] };
      streams.set(id, s);
    }
    return s;
  };
  for (const fd of files) {
    if (fd.assignment !== "assigned") continue;
    const s = getStream([...fd.I][0]);
    s.files.push(fd);
    for (const x of fd.ordRecs) s.ordRecs.push(x);
    for (const x of fd.markers) s.markers.push(x);
    for (const x of fd.ctxs) s.ctxs.push(x); // G(S): EVERY context of the assigned files, a null (unusable) model included, copied prefix included (R2.17 (c))
  }
  // R15.7: V(S) is the cli_version of every session_meta with id = S, own or copied. Supported iff non-empty and all full.
  const supportedThread = (id) => {
    const metas = allMetasById.get(id) ?? [];
    return metas.length > 0 && metas.every((m) => m.cliVersion !== null && CODEX_FULL_VERSIONS.includes(m.cliVersion));
  };
  // S10.3: the set of own session_meta records of a thread, or (when it has none) of its copied ones, which are the
  // session_meta records with its id that are not own.
  const describingSet = (id) => {
    const own = id === null ? [] : (ownMetasById.get(id) ?? []);
    return own.length > 0 ? own : id === null ? [] : (allMetasById.get(id) ?? []);
  };
  for (const s of streams.values()) {
    const metas = ownMetasById.get(s.id) ?? [];
    s.supported = supportedThread(s.id);
    // S10.4: a fork iff an own session_meta of the id anywhere in the scan has a non-null forked_from_id; the prefix
    // ordinal is read from those own records and must be a valid integer on every one of them.
    const forked = metas.filter((m) => m.forkedFrom !== null);
    s.isFork = forked.length > 0;
    s.histStart = forked.length > 0 && forked.every((m) => m.histStart !== null) ? forked[0].histStart : null;
    // S3.5: a stream of an unverified version (R15.7) gets version_unverified only: no ordinal check, no fork prefix
    // check, no model attribution.
    s.ordinalVerified = s.supported ? ordinalVerified(s.ordRecs) : false;
    s.prefixResolved = !s.isFork || (s.ordinalVerified && s.histStart !== null); // R4.9
    if (s.supported && !s.ordinalVerified) triggers.push({ reason: "ordinal_unverified", names: [codexChainId(s.id)] }); // R4.12
    s.modelsOfCtx = new Set(s.ctxs.map((x) => x.model));
    s.ctxByTurn = new Map();
    for (const x of s.ctxs) {
      if (x.turnId === null) continue;
      let l = s.ctxByTurn.get(x.turnId);
      if (!l) s.ctxByTurn.set(x.turnId, (l = []));
      l.push(x);
    }
  }

  const threads = new Set();
  for (const id of allMetasById.keys()) threads.add(id);
  for (const fd of files) for (const t of fd.turs) if (t.threadId !== null) threads.add(t.threadId);
  for (const id of [...threads].sort()) if (!supportedThread(id)) triggers.push({ reason: "version_unverified", names: [codexChainId(id)] });
  // S10.4, R4.9: a thread is a fork iff an own session_meta of its id anywhere in the scan (any file, any assignment) has a
  // non-null forked_from_id. The prefix is unresolved when one of those records lacks a valid subagent_history_start_ordinal,
  // or when the thread's stream (if it has one) is not ordinal_verified. Supported versions only (R15.7).
  for (const [id, metas] of ownMetasById) {
    const forked = metas.filter((m) => m.forkedFrom !== null);
    if (forked.length === 0 || !supportedThread(id)) continue;
    const st = streams.get(id);
    const resolved = forked.every((m) => m.histStart !== null) && (st === undefined || st.ordinalVerified);
    if (!resolved) triggers.push({ reason: "fork_prefix_unresolved", names: [codexChainId(id)] });
  }

  // R2.10 / R2.17 model attribution for one usage record, before R0.9 (the parser's view, valid only for untainted chains).
  const attribute = (t) => {
    const s = t.threadId === null ? undefined : streams.get(t.threadId);
    if (!s) return { source: "none", verified: false, model: null };
    const own = t.turnId === null ? [] : (s.ctxByTurn.get(t.turnId) ?? []);
    if (own.length > 0) {
      const models = new Set(own.map((x) => x.model));
      if (models.size > 1) return { source: "own_turn_unsettled", verified: false, model: null };
      const model = [...models][0];
      // A context without a usable model is no model: the response is not verified (R2.17 (a)), as in src.
      if (model === null) return { source: "own_turn_unsettled", verified: false, model: null };
      if (s.markers.length > 0) {
        const posOk = s.ordinalVerified && t.ord !== null && own.every((x) => x.ord !== null);
        if (!posOk) return { source: "own_turn_unsettled", verified: false, model };
        const earliest = minBig(own.map((x) => x.ord));
        const lo = earliest < t.ord ? earliest : t.ord;
        const hi = earliest < t.ord ? t.ord : earliest;
        if (s.markers.some((m) => m.ord !== null && m.ord > lo && m.ord < hi)) return { source: "own_turn_unsettled", verified: false, model };
      }
      return { source: "own_turn", verified: true, model };
    }
    // carried: the context with the greatest (timestamp, ordinal) before the record
    let best = null;
    for (const x of s.ctxs) {
      if (x.tsNs === null || t.tsNs === null) continue;
      let before;
      if (x.tsNs !== t.tsNs) before = x.tsNs < t.tsNs;
      else before = x.ord !== null && t.ord !== null && x.ord < t.ord;
      if (!before) continue;
      if (best === null || x.tsNs > best.tsNs || (x.tsNs === best.tsNs && (x.ord ?? -1n) > (best.ord ?? -1n))) best = x;
    }
    if (best === null) return { source: "none", verified: false, model: null };
    if (s.isFork && s.prefixResolved && s.ordinalVerified && best.ord !== null && best.ord < s.histStart) {
      return { source: "inherited_prefix", verified: false, model: best.model };
    }
    const ok =
      s.ordinalVerified &&
      s.prefixResolved &&
      t.ord !== null &&
      best.ord !== null &&
      (!s.isFork || best.ord >= s.histStart) &&
      s.markers.length === 0 && // R2.17 (b): no settings marker anywhere in the stream
      s.modelsOfCtx.size === 1 && !s.modelsOfCtx.has(null); // R2.17 (b): one usable model over ALL contexts of G(S), none unusable
    return ok ? { source: "carried_verified", verified: true, model: best.model } : { source: "carried_unverified", verified: false, model: best.model };
  };

  // Usage records, grouped by response_id (R4.4). Unkeyed and unattributed records first (R2.13).
  const groups = new Map();
  const unverifiedKeys = new Set();
  const baseline = []; // accounted responses before `since` (S12.5)
  const ccov = (cov.codex_responses = {
    requests_total: 0,
    responses_total: 0,
    requests_conflict: 0,
    requests_conflict_by_kind: {},
    records_unkeyed: 0,
    requests_unverified_version: 0,
    responses_usage_range_failed: 0,
    responses_usage_incomplete: 0,
    responses_usage_invariant_failed: 0,
    tokens_in_incomplete_by_field: {},
    tokens_in_incomplete_responses: "0",
    tokens_in_invalid_responses: "0",
    baseline_requests_loaded: 0,
  });
  const unkeyedSeen = new Set();
  const usageSeen = new Set();
  const ledger = [];
  for (const fd of files) {
    for (const t of fd.turs) {
      // S12.0, S4.3: every token_usage_record is a usage-bearing record (one without a usage object is incomplete); logical,
      // chainless ones included; unmappable ones are incomplete or range
      if ((t.threadId === null || supportedThread(t.threadId)) && !usageSeen.has(t.proj)) {
        usageSeen.add(t.proj);
        const vals = [t.in, t.c, t.cw, t.out, t.rs, t.total];
        const inc = { records_usage_bearing: 1 };
        if (vals.some((x) => !isBig(x))) inc.records_usage_unmappable = 1;
        ledger.push({ t: t.tsNs, chain: t.threadId === null ? null : codexChainId(t.threadId), inc, kinds: [], tok: {}, tokInc: 0n, tokInvalid: 0n });
      }
      if (t.threadId === null) {
        // No chain key: unkeyed for accounting (R2.13, logical: equal records count once) and unattributed for R0.9
        // (provider trigger, above). It counts in records_unkeyed and not as unmappable.
        if (!unkeyedSeen.has(t.proj)) {
          unkeyedSeen.add(t.proj);
          ccov.records_unkeyed += 1;
          ledger.push({ t: t.tsNs, chain: null, inc: { records_unkeyed: 1 }, kinds: [], tok: {}, tokInc: 0n, tokInvalid: 0n });
        }
        continue;
      }
      if (!supportedThread(t.threadId)) {
        // R15.7: a record of an unverified stream is counted, never accounted, and no request-level rule runs on it:
        // the stream gets version_unverified only (no request_anomaly, no unkeyed count).
        c.lines_unverified_version += 1;
        if (t.responseId !== null) unverifiedKeys.add(t.responseId);
        continue;
      }
      if (t.responseId === null) {
        if (!unkeyedSeen.has(t.proj)) {
          unkeyedSeen.add(t.proj);
          ccov.records_unkeyed += 1; // R2.13, logical
          ledger.push({ t: t.tsNs, chain: codexChainId(t.threadId), inc: { records_unkeyed: 1 }, kinds: [], tok: {}, tokInc: 0n, tokInvalid: 0n });
        }
        triggers.push({ reason: "request_anomaly", names: [codexChainId(t.threadId)] }); // a thread without a response id
        continue;
      }
      let g = groups.get(t.responseId);
      if (!g) groups.set(t.responseId, (g = []));
      g.push({ t, attr: attribute(t) });
    }
  }
  ccov.requests_unverified_version = unverifiedKeys.size;
  // R17.6: lines whose record equals an earlier one, and distinct records with at least one such line (physical counters)
  c.lines_duplicate_collapsed = 0;
  c.duplicate_records_collapsed = 0;
  for (const n of dup.values()) {
    if (n > 1) {
      c.lines_duplicate_collapsed += n - 1;
      c.duplicate_records_collapsed += 1;
    }
  }

  // R0.9 family groups: (i) a shared session_id, (ii) fork and spawn edges, (iii) a response_id held by several threads.
  const universe = new Set(); // every chain (thread) seen by a structural read
  for (const id of threads) universe.add(codexChainId(id));
  const famGroups = [];
  const sessThreads = new Map();
  const respThreads = new Map();
  for (const fd of files) {
    for (const m of fd.metas) {
      if (m.id === null) continue;
      if (m.sessionId !== null) addTo(sessThreads, m.sessionId, codexChainId(m.id));
      for (const other of [m.forkedFrom, m.spawnParent]) {
        if (other !== null && other !== m.id && threads.has(other)) famGroups.push([codexChainId(m.id), codexChainId(other)]);
      }
    }
    for (const t of fd.turs) {
      if (t.threadId === null) continue;
      if (t.sessionId !== null) addTo(sessThreads, t.sessionId, codexChainId(t.threadId));
      if (t.responseId !== null) addTo(respThreads, t.responseId, codexChainId(t.threadId));
    }
  }
  for (const s of sessThreads.values()) if (s.size > 1) famGroups.push([...s]);
  for (const s of respThreads.values()) if (s.size > 1) famGroups.push([...s]);

  const out = [];
  for (const key of [...groups.keys()].sort()) {
    const occ = groups.get(key);
    const first = occ[0];
    const heldBy = [...new Set(occ.map((o) => codexChainId(o.t.threadId)))].sort();
    const allEqual = occ.every((o) => o.t.proj === first.t.proj && o.attr.verified === first.attr.verified && (!o.attr.verified || o.attr.model === first.attr.model));
    // R4.10, R5.9, R17.6: the event time of a request is computed from the whole record set of the key (the minimum over
    // every occurrence), never from the occurrence that happens to come first in file order. Equal occurrences share one
    // timestamp, so this is the usual time; conflicting occurrences get one time whatever the order of the files.
    const tNs = minBig(occ.map((o) => o.t.tsNs).filter(isBig));
    const inWindow = windowHas(window, tNs);
    const L = { t: tNs, chain: heldBy[0] ?? null, inc: { responses_total: 1 }, kinds: [], tok: {}, tokInc: 0n, tokInvalid: 0n };
    ledger.push(L);
    if (!allEqual) {
      triggers.push({ reason: "request_anomaly", names: heldBy }); // R4.4
      const usageEqual = occ.every((o) => o.t.usageKey === first.t.usageKey);
      const kind = usageEqual ? "conflict_attribution" : "conflict_usage";
      L.inc.requests_conflict = 1;
      L.kinds.push(kind);
      if (inWindow) out.push({ provider: "codex", key, status: `excluded:${kind}`, counted: false, chain: null });
      continue;
    }
    const { t, attr } = first;
    const vals = { in: t.in, c: t.c, cw: t.cw, out: t.out, rs: t.rs, total: t.total };
    const rangeFailed = Object.values(vals).includes(RANGE);
    // R2.12 revision 11.1: the envelope timestamp is part of the usage row; a missing or bad one is incomplete too.
    const incomplete = !rangeFailed && (Object.values(vals).some((x) => !isBig(x)) || t.tsNs === null);
    let invariantFailed = false;
    if (!rangeFailed && !incomplete) {
      invariantFailed = t.c + t.cw > t.in || t.rs > t.out || t.total !== t.in + t.out; // R2.7, BigInt (S4.2)
    }
    if (rangeFailed || incomplete || invariantFailed) triggers.push({ reason: "request_anomaly", names: heldBy }); // R2.7, R2.12, R2.15
    const dropRow = (status) => {
      if (inWindow) out.push({ provider: "codex", key, status, counted: false, chain: null });
    };
    if (rangeFailed) {
      L.inc.responses_usage_range_failed = 1; // R2.15
      dropRow("excluded:usage_range_failed");
      continue;
    }
    if (incomplete) {
      L.inc.responses_usage_incomplete = 1; // R2.12
      for (const [f, v] of Object.entries(vals)) if (isBig(v)) L.tok[f] = v;
      // S6.3: I + O, I = in when valid else the valid ones among c and cw; O = out when valid else rs when valid.
      const I = isBig(t.in) ? t.in : (isBig(t.c) ? t.c : 0n) + (isBig(t.cw) ? t.cw : 0n);
      const O = isBig(t.out) ? t.out : isBig(t.rs) ? t.rs : 0n;
      L.tokInc = I + O;
      dropRow("excluded:usage_incomplete");
      continue;
    }
    const inn = t.in;
    const cc = t.c;
    const cw = t.cw;
    const outT = t.out;
    const rs = t.rs;
    if (invariantFailed) {
      L.inc.responses_usage_invariant_failed = 1; // R2.7
      L.tokInvalid = inn + outT;
      dropRow("excluded:usage_invariant_failed");
      continue;
    }
    if (!inWindow) {
      if (beforeWindow(window, tNs)) baseline.push({ chain: codexChainId(t.threadId) }); // R5.10, S12.5
      continue;
    }
    const buckets = {
      input_uncached: inn - cc - cw,
      cache_read: cc,
      cache_write_5m: 0n,
      cache_write_1h: 0n,
      cache_write_unknown_ttl: 0n,
      cache_write: cw,
      output: outT,
      output_lower_bound: outT,
      reasoning: rs,
    };
    out.push({
      provider: "codex",
      key,
      kind: codexKindOfSet(describingSet(t.threadId)), // S10.2, S10.3
      chain: codexChainId(t.threadId),
      model: attr.verified ? attr.model : null,
      model_source: attr.source,
      flags: [],
      buckets,
      event_ms: tNs === null ? null : nsToMs(tNs),
      event_ns: tNs,
      attr,
      inn,
      counted: true,
      status: "counted",
    });
  }
  return { responses: out, baseline, facts: { chains: universe, groups: famGroups, triggers, files: factFiles }, ledger };
}

/** R3.6, R3.10: price one Codex response of an untainted chain. The tier gate comes first (R3.4), before R3.10. */
function priceCodex(r, book, tierVerified) {
  const b = r.buckets;
  const tot = r.inn + b.output;
  if (!tierVerified) return unpriced("modifier_unverified", tot); // R3.4: no retained field shows the Codex service tier
  if (!r.attr.verified) return unpriced("model_unknown", tot); // R2.10
  const entry = usableEntry(book, r.attr.model, "openai");
  if (!entry || codexRow(entry.prices_usd_per_mtok) === null) return unpriced("unknown_model", tot); // R3.3
  const lc = entry.long_context;
  const requestScoped =
    isObj(lc) &&
    lc.scope === "request" &&
    lc.scope_verified === true &&
    verifiedObj({ verified: true, verified_at: lc.verified_at }, entry, book.table) &&
    typeof lc.scope_source_id === "string" &&
    isObj(book.table.sources) &&
    Object.hasOwn(book.table.sources, lc.scope_source_id); // R3.10, R3.11, S8.5a: an own key of the table's sources
  if (!requestScoped) return unpriced("long_context_scope", tot);
  let row = codexRow(entry.prices_usd_per_mtok);
  if (r.inn > C25) {
    const lcRow = verifiedObj(lc, entry, book.table) ? codexRow(lc.prices_usd_per_mtok) : null;
    if (!lcRow) return unpriced("long_context_unverified", tot);
    row = lcRow;
  }
  if (b.cache_write > 0n && row.cache_write === null) return unpriced("cache_write_price_na", tot); // R3.6
  const pico =
    b.input_uncached * row.input +
    b.cache_read * row.cache_read +
    (b.cache_write > 0n ? b.cache_write * row.cache_write : 0n) +
    b.output * row.output;
  return { priced: true, pico, tokens_unpriced: 0n };
}

// ---------------------------------------------------------------------------
// Window (R5.9, R5.10): [since, until) on event time, UTC.
// ---------------------------------------------------------------------------

function windowActive(w) {
  return w.since !== null || w.until !== null;
}

/**
 * S7.1: a response is in the window iff its event time t (nanoseconds, BigInt) satisfies since * 10^6 <= t < until * 10^6.
 * An unknown time is in no active window here; the ledger counters treat an unknown time as in every window (S6.5).
 */
function windowHas(w, ns) {
  if (!windowActive(w)) return true;
  if (ns === null) return false;
  if (w.since !== null && ns < BigInt(w.since) * 1000000n) return false;
  if (w.until !== null && ns >= BigInt(w.until) * 1000000n) return false;
  return true;
}

/** R5.10: the event time lies before `since` (a baseline request). */
function beforeWindow(w, ns) {
  return w.since !== null && ns !== null && ns < BigInt(w.since) * 1000000n;
}

/** since and until are milliseconds since the epoch (S7.1): a number, a date (midnight UTC) or an ISO instant. */
function parseBound(v, name) {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`bad_${name}`);
    return Math.floor(v);
  }
  if (typeof v !== "string") throw new Error(`bad_${name}`);
  const ns = /^\d{4}-\d{2}-\d{2}$/.test(v) ? instantNs(`${v}T00:00:00Z`) : instantNs(v);
  if (ns === null) throw new Error(`bad_${name}`);
  return nsToMs(ns);
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function defaultTablePath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "pricing", "table.json");
}

function loadTableArg(t) {
  if (isObj(t)) return t;
  const p = typeof t === "string" ? t : defaultTablePath();
  if (!existsSync(p)) throw new Error("table_not_found");
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Tokens of one counted response: context buckets plus output, or the output lower bound when output is unknown. */
function responseTokens(b) {
  return b.input_uncached + b.cache_read + b.cache_write_5m + b.cache_write_1h + b.cache_write_unknown_ttl + b.cache_write + (b.output !== null ? b.output : b.output_lower_bound);
}

/**
 * R0.9 effects on the responses of one provider, then the price. Live families are removed (counted only in their own
 * counters). A tainted chain keeps its buckets (effect 1) and gets no verified model and no dollars (effect 2).
 */
function applyTaint(provider, responses, taint, book, tierVerified, stats) {
  const co = {
    responses_in_tainted_chains: 0,
    tokens_in_tainted_chains: 0n,
    requests_unpriced_tainted: 0,
    responses_live_skipped: 0,
    tokens_live_skipped: 0n,
    responses_model_unverified: 0,
    model_source_counts: {},
  };
  for (const r of responses) {
    const info = r.chain === null ? null : (taint.chains.get(r.chain) ?? null);
    r.tainted = info !== null && info.tainted;
    r.taint_reasons = info === null ? [] : [...info.reasons];
    r.live_skipped = false;
    if (!r.counted) continue;
    const tokens = responseTokens(r.buckets);
    if (info.live) {
      r.counted = false;
      r.live_skipped = true;
      r.status = "live_skipped";
      co.responses_live_skipped += 1;
      co.tokens_live_skipped += tokens;
      continue;
    }
    if (info.tainted) {
      r.model_source = "chain_tainted";
      if (provider === "codex") r.model = null; // the Codex candidate is not kept; Claude keeps its record's model id
      r.price = unpriced("chain_tainted", tokens);
      co.responses_in_tainted_chains += 1;
      co.tokens_in_tainted_chains += tokens;
      co.requests_unpriced_tainted += 1;
    } else if (provider === "claude") {
      r.model_source = r.model === null ? "none" : "claude_explicit";
      r.price = r.model === null ? unpriced("model_unknown", tokens) : priceClaude(r.pr, book, stats);
    } else {
      r.model_source = r.attr.source;
      r.price = priceCodex(r, book, tierVerified);
    }
    if (provider === "codex") {
      bump(co.model_source_counts, r.model_source);
      if (!(r.model_source !== "chain_tainted" && r.attr.verified)) co.responses_model_unverified += 1;
    } else if (r.model_source === "chain_tainted" || r.model === null) {
      co.responses_model_unverified += 1; // R2.10 / R17.1, tainted chains included
    }
  }
  return co;
}

/**
 * R17.3 "in the window" and R0.9 "removed from the analysis entirely": the logical counters of the ledger are the sum of
 * the entries whose event time is in the window (an unknown time is in every window) and whose chain is not in a live
 * family. `requests_conflict` counts requests (one per request with any conflict code), the by-kind counts one per code.
 */
function foldLedger(provider, ledger, window, taint, cov) {
  const target = provider === "claude" ? cov.claude_responses : cov.codex_responses;
  const own = provider === "claude" ? cov.claude : null;
  target.responses_total = 0;
  target.records_usage_bearing = 0;
  target.records_usage_unmappable = 0;
  target.fields_range_failed = 0;
  target.requests_conflict = 0;
  if (provider === "claude") {
    target.requests_conflict_modifier = 0;
    target.replay_requests_excluded = 0;
    target.replay_ownership_ambiguous = 0;
  }
  target.requests_conflict_by_kind = {};
  target.responses_usage_range_failed = 0;
  target.responses_usage_incomplete = 0;
  target.tokens_in_incomplete_by_field = {};
  target.tokens_in_incomplete_responses = "0";
  if (provider === "claude") target.responses_bucket_mismatch = 0;
  else {
    target.responses_usage_invariant_failed = 0;
    target.tokens_in_invalid_responses = "0";
    target.records_unkeyed = 0;
  }
  if (own !== null) {
    own.records_unkeyed = 0;
    own.api_error_records = 0;
  }
  const tok = {};
  let invalid = 0n;
  let incomplete = 0n;
  for (const e of ledger) {
    if (e.t !== null && windowActive(window) && !windowHas(window, e.t)) continue;
    if (e.chain !== null && taint.chains.get(e.chain)?.live === true) continue;
    for (const [k, n] of Object.entries(e.inc)) {
      if ((k === "records_unkeyed" || k === "api_error_records") && own !== null) own[k] += n;
      else target[k] = (target[k] ?? 0) + n;
    }
    for (const k of e.kinds) bump(target.requests_conflict_by_kind, k);
    for (const [f, v] of Object.entries(e.tok)) tok[f] = (tok[f] ?? 0n) + v;
    invalid += e.tokInvalid;
    incomplete += e.tokInc;
  }
  for (const [f, v] of Object.entries(tok)) target.tokens_in_incomplete_by_field[f] = v.toString();
  target.tokens_in_incomplete_responses = incomplete.toString(); // S6.3: one scalar per provider
  if (provider === "codex") target.tokens_in_invalid_responses = invalid.toString();
}

function parseRunStart(v) {
  if (v === undefined || v === null) return Date.now(); // read once per run (R0.9)
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const ns = instantNs(v);
  if (ns === null) throw new Error("bad_run_start");
  return nsToMs(ns);
}

function run(entries, opts) {
  const window = { since: parseBound(opts.since, "since"), until: parseBound(opts.until, "until") };
  const book = loadBook(loadTableArg(opts.table));
  const runStartMs = parseRunStart(opts.runStartMs ?? opts.run_start_ms);
  const tierVerified = (opts.codexTierForTest ?? opts.codex_tier_for_test) === "standard";
  const cov = {};
  const scans = { claude: scanClaude(entries, cov, window), codex: scanCodex(entries, cov, window) };

  const stats = { geo_rounded: 0 };
  const taints = {};
  const effects = {};
  for (const provider of ["claude", "codex"]) {
    taints[provider] = computeTaint(scans[provider].facts, runStartMs);
    foldLedger(provider, scans[provider].ledger, window, taints[provider], cov);
    effects[provider] = applyTaint(provider, scans[provider].responses, taints[provider], book, tierVerified, stats);
  }

  // S12.2, S12.4, S12.5: counters taken over the accounted responses (live families already removed by the taint step)
  for (const provider of ["claude", "codex"]) {
    const target = provider === "claude" ? cov.claude_responses : cov.codex_responses;
    const counted = scans[provider].responses.filter((r) => r.counted);
    target.requests_total = counted.length;
    target.requests_priced = counted.filter((r) => r.price.priced).length;
    target.requests_unknown_model = counted.filter((r) => !r.price.priced && r.price.reason === "unknown_model").length;
    target.baseline_requests_loaded = scans[provider].baseline.filter((b) => taints[provider].chains.get(b.chain)?.live !== true).length;
    if (provider === "claude") {
      target.output_unknown_requests = counted.filter((r) => r.buckets.output === null).length;
      target.requests_no_final_copy = counted.filter((r) => !r.pr.final).length;
      target.requests_with_final_marker = counted.filter((r) => r.pr.final).length;
    }
  }

  const responses = [...scans.claude.responses, ...scans.codex.responses];
  const known = new Set();
  for (const id of book.byModel.keys()) known.add(id);
  // R14.3, S2.4: a label is the normalized model id when the table has a row for it, else `unlisted`.
  const modelLabel = (m) => (typeof m === "string" && known.has(m) ? m : "unlisted");

  const providers = {};
  const tokensTotal = {};
  const unpricedRaw = {};
  for (const provider of ["claude", "codex"]) {
    const total = emptyAgg();
    const byModel = new Map();
    const byKind = new Map();
    const unpricedReasons = new Map();
    unpricedRaw[provider] = unpricedReasons;
    for (const r of responses) {
      if (r.provider !== provider || !r.counted) continue;
      r.model_label = provider === "codex" && r.model === null ? "model_unknown" : modelLabel(r.model);
      addToAgg(total, r);
      const mk = r.model_label;
      if (!byModel.has(mk)) byModel.set(mk, emptyAgg());
      addToAgg(byModel.get(mk), r);
      if (!byKind.has(r.kind)) byKind.set(r.kind, emptyAgg());
      addToAgg(byKind.get(r.kind), r);
      if (!r.price.priced) {
        const u = unpricedReasons.get(r.price.reason) ?? { responses: 0, tokens_unpriced: 0n };
        u.responses += 1;
        u.tokens_unpriced += r.price.tokens_unpriced;
        unpricedReasons.set(r.price.reason, u);
      }
    }
    tokensTotal[provider] = total.tokens_total;
    providers[provider] = {
      totals: serializeAgg(total),
      by_model: sortedObject(byModel, serializeAgg),
      by_kind: sortedObject(byKind, serializeAgg),
      unpriced_by_reason: sortedObject(unpricedReasons, (u) => ({ responses: u.responses, tokens_unpriced: u.tokens_unpriced.toString() })),
    };
  }

  // R17.1 coverage. Chain and family counters are scan-wide per provider and exclude live families (R0.9). The
  // response-level counters are taken over the totals set: owner, non-excluded responses inside the window (ambiguity
  // logged in README: R0.9 does not say whether they are windowed).
  const taintCoverage = (provider) => {
    const t = taints[provider];
    const e = effects[provider];
    return {
      chains_total: t.chains_total,
      chains_tainted: t.chains_tainted,
      chains_tainted_by_reason: { ...t.chains_tainted_by_reason },
      families_total: t.families_total,
      families_tainted: t.families_tainted,
      families_live_skipped: t.families_live_skipped,
      responses_in_tainted_chains: e.responses_in_tainted_chains,
      tokens_in_tainted_chains: e.tokens_in_tainted_chains.toString(),
      requests_unpriced_tainted: e.requests_unpriced_tainted,
      families_ordinal_unverified: t.families_ordinal_unverified,
      // R3.9 revision 11.1: the unpriced tokens of the counted set by the first gate that refused each response.
      tokens_unpriced_by_reason: Object.fromEntries(
        UNPRICED_TOKEN_ORDER.map((k) => [k, (unpricedRaw[provider].get(k)?.tokens_unpriced ?? 0n).toString()]),
      ),
      responses_live_skipped: e.responses_live_skipped,
      tokens_live_skipped: e.tokens_live_skipped.toString(),
      // R16.1 / C36 by cross-multiplication: the warning is a report matter, the inputs are exact here.
      taint_warn: BigInt(t.families_tainted) * C36[1] > C36[0] * BigInt(t.families_total) || e.tokens_in_tainted_chains * C36[1] > C36[0] * tokensTotal[provider],
    };
  };
  const coverage = {
    claude: {
      ...cov.claude,
      ...cov.claude_responses,
      responses_model_unverified: effects.claude.responses_model_unverified,
      requests_unverified_version: cov.claude_requests_unverified_version,
      geo_rounded_responses: stats.geo_rounded,
      ...taintCoverage("claude"),
    },
    codex: {
      ...cov.codex,
      ...cov.codex_responses,
      responses_model_unverified: effects.codex.responses_model_unverified,
      model_source_counts: effects.codex.model_source_counts,
      ...taintCoverage("codex"),
    },
  };
  return {
    schema: RECOMPUTE_SCHEMA,
    spec: SPEC_ID,
    table_version: book.version,
    window: {
      since: window.since === null ? null : new Date(window.since).toISOString(),
      until: window.until === null ? null : new Date(window.until).toISOString(),
    },
    price_mode: `list-price equivalent at table ${book.version}`,
    providers,
    coverage,
    responses,
  };
}

/** Recompute from directories. opts: claudeDirs, codexDirs, since, until, table (object or path), runStartMs, codexTierForTest. */
export function recompute(opts = {}) {
  const cov = {};
  const entries = discoverEntries(opts.claudeDirs ?? [], opts.codexDirs ?? [], cov);
  return run(entries, opts);
}

/** Recompute from in-memory files: [{ path: "projects/...", content, mtimeMs? }, ...] in builder layout. */
export function recomputeFiles(files, opts = {}) {
  return run(memoryEntries(files), opts);
}

/**
 * JSON-safe form. Per-response rows are included only with perResponse. Request keys are replaced by
 * `req_<8 hex>`, the first 8 hex characters of sha256(salt || provider || key), where the salt is 16 random bytes
 * drawn per call and never stored or printed (R14.4). Rows are ordered by the raw key before it is hashed, so the
 * order does not depend on the salt. `salt` and `rawKeys` are in-process parameters for tests and for comparison
 * with src/ on synthetic data: neither has a CLI flag, and the CLI refuses `--raw-keys`.
 */
export function toJson(result, { perResponse = false, rawKeys = false, salt = undefined } = {}) {
  const saltBytes = salt === undefined ? randomBytes(16) : Buffer.from(salt);
  const opaque = (provider, key) => "req_" + createHash("sha256").update(saltBytes).update(provider + "\u0000" + key).digest("hex").slice(0, 8);
  const doc = {
    schema: result.schema,
    spec: result.spec,
    table_version: result.table_version,
    window: result.window,
    price_mode: result.price_mode,
    providers: result.providers,
    coverage: result.coverage,
  };
  if (perResponse) {
    const byKey = (a, b) => (a.provider !== b.provider ? (a.provider < b.provider ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    doc.responses = [...result.responses]
      .sort(byKey)
      .map((r) => {
        const row = { provider: r.provider, id: rawKeys ? r.key : opaque(r.provider, r.key), status: r.status };
        row.tainted = r.tainted === true;
        row.taint_reasons = [...(r.taint_reasons ?? [])];
        row.live_skipped = r.live_skipped === true;
        if (!r.counted) return row;
        row.kind = r.kind;
        row.model = r.model_label;
        row.model_source = r.model_source;
        if (r.flags.length) row.flags = [...r.flags].sort();
        const b = r.buckets;
        row.buckets = {
          input_uncached: b.input_uncached.toString(),
          cache_read: b.cache_read.toString(),
          cache_write_5m: b.cache_write_5m.toString(),
          cache_write_1h: b.cache_write_1h.toString(),
          cache_write_unknown_ttl: b.cache_write_unknown_ttl.toString(),
          cache_write: b.cache_write.toString(),
          output: b.output === null ? null : b.output.toString(),
          output_lower_bound: b.output_lower_bound.toString(),
        };
        row.event = r.event_ms === null || r.event_ms === undefined ? null : new Date(r.event_ms).toISOString();
        if (r.price.priced) {
          row.usd_pico = r.price.pico.toString();
        } else {
          row.usd_pico = null;
          row.unpriced_reason = r.price.reason;
          row.tokens_unpriced = r.price.tokens_unpriced.toString();
        }
        return row;
      });
  }
  return doc;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { claudeDirs: [], codexDirs: [], perResponse: false };
  for (let k = 0; k < argv.length; k += 1) {
    const a = argv[k];
    const next = () => {
      const v = argv[(k += 1)];
      if (v === undefined) throw new Error("missing_value");
      return v;
    };
    if (a === "--claude-dir") o.claudeDirs.push(next());
    else if (a === "--codex-dir") o.codexDirs.push(next());
    else if (a === "--since") o.since = next();
    else if (a === "--until") o.until = next();
    else if (a === "--table") o.table = next();
    else if (a === "--out") o.out = next();
    else if (a === "--per-response") o.perResponse = true;
    else if (a === "--raw-keys") throw new Error("raw_keys_rejected"); // R14.4: the output is JSON, raw ids never go into it
    else throw new Error("unknown_argument");
  }
  if (o.claudeDirs.length === 0 && o.codexDirs.length === 0) throw new Error("no_input_dir");
  return o;
}

function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
    const doc = toJson(recompute(o), o); // the run start is read once, inside run(); file mtimes are statted at discovery
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    if (o.out) writeFileSync(o.out, text);
    else process.stdout.write(text);
  } catch (e) {
    // R14.6: only a short code, never an exception message that could quote input.
    const code = e instanceof Error && /^[a-z_]+$/.test(e.message) ? e.message : "error";
    process.stderr.write(`recompute: ${code}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
