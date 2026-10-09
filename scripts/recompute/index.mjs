#!/usr/bin/env node
// cachewhy independent recompute (spec R13.1 to R13.3).
//
// A second, deliberately separate implementation of the ACCOUNTING part of docs/methodology.md (revision 11):
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
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/; // R1.2 `version`
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_SUFFIX_RE = /-\d{8}$/; // R3.3
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/; // R14.3

// Counter reading codes (R2.12, R2.15). A non-negative return value is the counter itself.
const MISSING = -1; // absent, null or not a JSON number: never treated as 0 (R2.12)
const RANGE = -2; // number that fails 0 <= v <= MAX_SAFE_INTEGER or is not an integer (R2.15)

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v.length > 0 ? v : null);

/** R2.15: range check on the parsed value, before any arithmetic. */
function ctr(v) {
  if (typeof v !== "number") return MISSING;
  if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0 || v > MAX_SAFE) return RANGE;
  return v + 0; // folds -0 into 0
}

/** Strict ISO instant to epoch ms, else null. */
function parseTs(v) {
  if (typeof v !== "string" || !ISO_RE.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

function normalizeModel(m) {
  return typeof m === "string" ? m.replace(DATE_SUFFIX_RE, "") : null; // R3.3
}

/** R3.3, R14.3: the normalized model of a Claude copy. The date suffix is stripped before copies are compared (R4.2), so
 * claude-opus-5-5 and claude-opus-5-5-20261009 are one model; a string that is no plain model id is `unlisted`. */
function claudeModel(v) {
  if (typeof v !== "string" || v.length === 0) return null;
  const id = v.replace(DATE_SUFFIX_RE, "");
  return MODEL_ID_RE.test(id) ? id : "unlisted";
}

/** R3.3, R14.3: the normalized model of a Codex `turn_context`; a missing or unusable id is null (never a model). */
function ctxModel(v) {
  if (typeof v !== "string" || v.length > 80) return null;
  const n = v.replace(DATE_SUFFIX_RE, "");
  return MODEL_ID_RE.test(n) ? n : null;
}

function enumOf(v, allowed) {
  if (v === undefined || v === null) return null;
  return typeof v === "string" && allowed.includes(v) ? v : "other";
}

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
    if (text.trim().length === 0) continue;
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

/** Claude: classify a path relative to a projects/ root. Null for files that hold no requests. */
function classifyClaude(segs) {
  const name = segs[segs.length - 1] ?? "";
  const sub = segs.indexOf("subagents");
  if (sub >= 1 && sub < segs.length - 1) {
    if (segs[sub + 1] === "workflows") {
      if (segs.length !== sub + 4) return null;
      if (!/^wf_.+$/.test(segs[sub + 2] ?? "")) return null;
      return /^agent-.+\.jsonl$/.test(name) ? "workflow_agent" : null;
    }
    if (segs.length !== sub + 2) return null;
    return /^agent-.+\.jsonl$/.test(name) ? "subagent" : null;
  }
  if (segs.length === 2 && name.endsWith(".jsonl")) return "main";
  return null;
}

/**
 * Claude sidecar files that R1.2 reads (agent meta and prefix JSON, workflow run JSON, workflow journal). They hold no
 * request and name no chain, but a sidecar that fails to parse is a lost line (R1.3, R0.9 unparsed_line).
 */
function classifyClaudeSidecar(segs) {
  const name = segs[segs.length - 1] ?? "";
  const sub = segs.indexOf("subagents");
  if (sub >= 1 && sub < segs.length - 1 && /^agent-.+\.(meta|prefix)\.json$/.test(name)) return "sidecar_json";
  const wf = segs.indexOf("workflows");
  if (wf >= 1 && wf === segs.length - 2 && /^wf_.+\.json$/.test(name)) return "sidecar_json";
  if (name === "journal.jsonl" && segs.length >= 4 && segs[segs.length - 2].startsWith("wf_") && segs[segs.length - 3] === "workflows") {
    return "sidecar_lines";
  }
  return null;
}

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

function loadBook(table) {
  if (!isObj(table) || !Array.isArray(table.models)) throw new Error("table_malformed");
  const byModel = new Map();
  for (const e of table.models) {
    if (!isObj(e)) continue;
    const ids = Array.isArray(e.model_ids) ? e.model_ids : [];
    for (const id of ids) if (typeof id === "string" && !byModel.has(id)) byModel.set(id, e);
  }
  return { table, byModel, version: typeof table.table_version === "string" ? table.table_version : "unlisted" };
}

/** Entry is usable when the entry itself is verified (R3.1) and has prices. */
function usableEntry(book, id) {
  const e = id === null ? undefined : book.byModel.get(id);
  if (!e) return null;
  if (!verifiedObj(e, e, book.table)) return null;
  if (!isObj(e.prices_usd_per_mtok)) return null;
  return e;
}

function fastVerifiedModifier(book) {
  const m = book.table.modifiers?.fast_with_geo_us;
  return isObj(m) && verifiedObj(m, null, book.table);
}

function geoApplies(book, e) {
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

/** Read one assistant copy (R1.2 counters, R2.1, R2.12, R2.15, R4.2). */
function readClaudeCopy(rec, kind) {
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
  if (isObj(u.output_tokens_details) && typeof u.output_tokens_details.thinking_tokens === "number") {
    if (ctr(u.output_tokens_details.thinking_tokens) === RANGE) extraRange = true;
  }
  let it0 = null;
  if (Array.isArray(u.iterations) && isObj(u.iterations[0])) {
    it0 = {};
    for (const [k, v] of Object.entries(u.iterations[0])) {
      if (typeof v !== "number" || !Number.isInteger(v)) continue; // integer members only (R1.2)
      if (v < 0 || v > MAX_SAFE) extraRange = true;
      else if (ITER_SHARED.includes(k)) it0[k] = v + 0;
    }
  }
  const range = [i, r, wt, o, w5, w1].includes(RANGE) || extraRange;
  const incomplete = ccBad || [i, r, wt, o].includes(MISSING) || (hasCC && (w5 === MISSING || w1 === MISSING));
  const speedPresent = u.speed !== undefined && u.speed !== null;
  return {
    rid: str(rec.requestId),
    mid: str(msg.id),
    kind,
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
  };
}

const present = (n) => n >= 0;

function maxPresent(copies, field) {
  let m = -1;
  for (const c of copies) if (present(c[field]) && c[field] > m) m = c[field];
  return m;
}

/**
 * Resolve the copies of one requestId into one response or an exclusion (R4.1, R4.2, R2.1 to R2.3).
 * Precedence of exclusions: range (R2.15), incomplete (R2.12), key_conflict (R4.1),
 * conflict_input and conflict_model (R4.2). `anomaly` is true whenever R0.9 `request_anomaly` applies:
 * an exclusion, or a kept response with bucket_mismatch, conflict_output, conflict_iterations or conflict_modifier.
 */
function resolveClaude(allCopies, keyConflict) {
  // Counters are read from the copies that carry a usage object. A copy without one still takes part in the model
  // check below (R4.2, any copy), and a request with no usage-bearing copy at all is incomplete (R2.12).
  const copies = allCopies.filter((c) => !c.usageless);
  if (copies.some((c) => c.range)) return { excluded: "usage_range_failed", anomaly: true };
  if (copies.length === 0 || copies.some((c) => c.incomplete)) {
    const present_fields = {};
    for (const f of ["i", "r", "wt", "w5", "w1", "o"]) {
      const m = maxPresent(copies, f);
      if (m >= 0) present_fields[f] = BigInt(m);
    }
    return { excluded: "usage_incomplete", present_fields, anomaly: true };
  }
  if (keyConflict) return { excluded: "key_conflict", anomaly: true, conflicts: ["key_conflict"] };
  const c0 = copies[0];
  // R4.2: every conflict code of the request is recorded (an input and a model conflict are both reported); the
  // first of them in this order is the exclusion.
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
  const i = BigInt(c0.i);
  const r = BigInt(c0.r);
  let w5 = 0n;
  let w1 = 0n;
  let wu = 0n;
  if (c0.hasCC) {
    w5 = BigInt(c0.w5);
    w1 = BigInt(c0.w1);
    if (BigInt(c0.wt) !== w5 + w1) flags.push("bucket_mismatch");
  } else {
    wu = BigInt(c0.wt);
    flags.push("w_unknown_ttl");
  }

  // R4.2 / R3.12: final copies, output, modifiers.
  const finals = copies.filter((c) => c.speedPresent);
  const outputLb = BigInt(maxPresent(copies, "o"));
  let output = null;
  if (finals.length === 0) {
    flags.push("output_unknown");
  } else if (new Set(finals.map((c) => c.o)).size > 1) {
    flags.push("conflict_output");
  } else {
    let iterOk = true;
    for (const f of finals) {
      if (!f.it0) continue;
      const top = { input_tokens: f.i, output_tokens: f.o, cache_read_input_tokens: f.r, cache_creation_input_tokens: f.wt };
      for (const k of ITER_SHARED) if (k in f.it0 && f.it0[k] !== top[k]) iterOk = false;
    }
    if (iterOk) output = BigInt(finals[0].o);
    else flags.push("conflict_iterations");
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
 * R3.5, R3.4, R3.12: price one Claude response of an untainted chain. Gate order as the spec reads: no table row
 * (R3.3), conflicts, an unverified modifier (R3.12), then row selection, then the unknown TTL class (R3.5).
 */
function priceClaude(res, book, stats) {
  const b = res.buckets;
  const ctx = b.input_uncached + b.cache_read + b.cache_write_5m + b.cache_write_1h + b.cache_write_unknown_ttl;
  const tot = ctx + b.output_lower_bound; // lb equals output when output is known
  const entry = usableEntry(book, normalizeModel(res.model));
  if (!entry || claudeRow(entry.prices_usd_per_mtok) === null) return unpriced("unknown_model", tot); // R3.3
  if (res.modConflict) return unpriced("conflict_modifier", tot); // R4.2
  // R3.12: priced only with a final copy that carries speed, inference_geo and service_tier.
  if (!res.final || res.mods.geo === null || res.mods.tier === null) return unpriced("modifier_unverified", tot);
  const { speed, geo, tier } = res.mods;
  if (speed === "other") return unpriced("speed_other", tot);
  if (geo === "other") return unpriced("geo_other", tot);

  let row = claudeRow(entry.prices_usd_per_mtok);
  const hasTiers = isObj(entry.tiers);
  const aboveSplit = hasTiers && ctx > C26; // Haiku 5.5: tier by total_input = i + r + w (R2.2, R3.4)
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
    if (geo === "us" && !(fastVerifiedModifier(book) && f.geo_us_applies === true && geoApplies(book, entry))) {
      return unpriced("fast_geo_unverified", tot);
    }
    row = fRow;
  } else if (aboveSplit) {
    const hi = verifiedObj(entry.tiers, entry, book.table) ? claudeRow(entry.tiers.high) : null;
    if (!hi) return unpriced("tier_unverified", tot);
    row = hi;
  }
  if (geo === "us" && !geoApplies(book, entry)) return unpriced("geo_other", tot);
  // R3.5: the write price depends on a TTL class the log does not show; one number only, so no range.
  if (b.cache_write_unknown_ttl > 0n) return unpriced("bucket_unknown", tot);
  // No partial output term exists (R3.5): an unknown output is only reachable without a final copy, handled above.
  if (b.output === null) return unpriced("modifier_unverified", tot);

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
  let buf;
  try {
    buf = ent.read();
  } catch {
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
  } else {
    const fc = newLineCov();
    for (const _ of jsonLines(buf, fc)) void _;
    unparsed = fc.lines_parse_error + fc.lines_truncated_tail;
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
function recordIdentity(rec) {
  const m = isObj(rec.message) ? rec.message : null;
  const u = m !== null && isObj(m.usage) ? m.usage : null;
  const cc = u !== null && isObj(u.cache_creation) ? u.cache_creation : null;
  const cnt = (v) => [ctr(v), v === undefined || v === null ? "m" : typeof v === "number" ? "" : "b"];
  const model = claudeModel;
  const version = typeof rec.version === "string" && VERSION_RE.test(rec.version) ? rec.version : "unlisted";
  const blocks = [];
  if (m !== null && Array.isArray(m.content)) {
    for (const b of m.content) {
      if (!isObj(b)) {
        blocks.push(["other", null, null, null]);
        continue;
      }
      const t = enumOf(b.type, ["text", "tool_use", "tool_result", "thinking"]) ?? "other";
      if (t === "tool_use") blocks.push([t, str(b.id), enumOf(b.name, ["Agent", "Workflow"]) ?? "other", null]);
      else if (t === "tool_result") blocks.push([t, null, null, str(b.tool_use_id)]);
      else blocks.push([t, null, null, null]);
    }
  }
  let iter = null;
  if (u !== null && Array.isArray(u.iterations) && isObj(u.iterations[0])) {
    // R1.2, R17.6: every in-range integer member, by member name (an out-of-range member is the range state).
    iter = [];
    let bad = false;
    for (const [k, v] of Object.entries(u.iterations[0])) {
      if (typeof v !== "number" || !Number.isInteger(v)) continue;
      if (ctr(v) === RANGE) bad = true;
      else iter.push([k, String(v + 0)]);
    }
    iter.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    iter = [iter, bad];
  }
  let diag = null;
  const dg = m !== null && isObj(m.diagnostics) ? m.diagnostics.cache_miss_reason : undefined;
  if (dg !== undefined && dg !== null) {
    diag = isObj(dg)
      ? [enumOf(dg.type, ["messages_changed", "tools_changed", "system_changed", "model_changed", "previous_message_not_found", "unavailable"]), ...cnt(dg.cache_missed_input_tokens)]
      : ["other"];
  }
  const stop = m !== null && "stop_reason" in m ? (m.stop_reason === null ? "null" : enumOf(m.stop_reason, ["tool_use", "end_turn", "stop_sequence", "refusal"])) : null;
  const projection = [
    str(rec.type),
    str(rec.uuid),
    str(rec.parentUuid),
    str(rec.logicalParentUuid),
    str(rec.sessionId),
    str(rec.agentId),
    parseTs(rec.timestamp),
    version,
    rec.isCompactSummary === true,
    typeof rec.isSidechain === "boolean" ? rec.isSidechain : null,
    rec.isApiErrorMessage === true,
    enumOf(rec.entrypoint, ["claude-desktop", "cli", "sdk-cli"]),
    enumOf(rec.effort, ["low", "medium", "high", "xhigh", "max"]),
    enumOf(rec.perTurnEffort, ["low", "medium", "high", "xhigh", "max"]),
    model(rec.advisorModel),
    rec.serverClassifierRequest !== undefined && rec.serverClassifierRequest !== null,
    str(rec.requestId),
    m !== null ? str(m.id) : null,
    m !== null ? model(m.model) : null,
    stop,
    u !== null,
    u !== null ? [cnt(u.input_tokens), cnt(u.cache_read_input_tokens), cnt(u.cache_creation_input_tokens), cnt(u.output_tokens)] : null,
    cc !== null ? [cnt(cc.ephemeral_5m_input_tokens), cnt(cc.ephemeral_1h_input_tokens)] : cc === null && u !== null && u.cache_creation !== undefined && u.cache_creation !== null ? "bad" : null,
    u !== null && isObj(u.output_tokens_details) ? cnt(u.output_tokens_details.thinking_tokens) : null,
    iter,
    u !== null ? [u.speed === undefined || u.speed === null ? null : enumOf(u.speed, SPEEDS), enumOf(u.inference_geo, GEOS), enumOf(u.service_tier, TIERS)] : null,
    diag,
    blocks,
  ];
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

/** True the first time `key` is seen. */
function firstOf(set, key) {
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

function scanClaude(entries, cov, window) {
  const streams = new Map(); // chain id -> { sess, agent, start }
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
      if (!isObj(rec)) {
        c.unlisted_type_count += 1;
        continue;
      }
      const type = rec.type;
      const known = type === "assistant" || type === "user" || type === "system" || type === "attachment";
      if (known) c.known_type_count += 1;
      else c.unlisted_type_count += 1;
      // R4.11 / R0.9: identity is read per record from (sessionId, agentId or main), never from the path.
      const sess = str(rec.sessionId);
      const agent = str(rec.agentId);
      const chain = sess === null ? null : claudeChainId(sess, agent);
      if (chain !== null) {
        chains.add(chain);
        named.add(chain);
        addTo(sessChains, sess, chain);
      } else if (known) {
        triggers.push({ reason: "unattributed_record", names: "provider" }); // R0.9: no key, no accounting
      }
      const supported = claudeSupported(rec.version);
      if (!known) continue;
      if (!supported) c.lines_unverified_version += 1;
      const ts = parseTs(rec.timestamp);
      if (supported && chain !== null) {
        let st = streams.get(chain);
        if (!st) streams.set(chain, (st = { sess, agent, start: null }));
        if (ts !== null && (st.start === null || ts < st.start)) st.start = ts; // R4.6 stream_start
      }
      if (type !== "assistant") continue;
      const msg = isObj(rec.message) ? rec.message : null;
      if (rec.isApiErrorMessage === true || msg?.model === "<synthetic>") {
        if (supported && firstOf(logicalSeen, `api\u0000${recordIdentity(rec)}`)) c.api_error_records += 1; // R2.14, logical (R17.6)
        continue;
      }
      const rid = str(rec.requestId);
      if (rid === null) {
        // R2.13: the counter covers records that carry usage; the trigger is broader. A keyless non-error assistant
        // record with a string sessionId is an anomaly with or without usage, whatever its version: it taints its chain.
        if (msg && isObj(msg.usage) && supported && firstOf(logicalSeen, `unkeyed\u0000${recordIdentity(rec)}`)) {
          c.records_unkeyed += 1; // logical (R17.6)
          ledger.push({ t: ts, chain, inc: { records_unkeyed: 1 }, kinds: [], tok: {}, tokInvalid: 0n });
        }
        if (chain !== null) triggers.push({ reason: "request_anomaly", names: [chain] });
        continue;
      }
      if (!supported) unverifiedKeys.add(rid); // R15.7: one unverified copy makes the key unverified
      if (chain === null) continue;
      addTo(holders, rid, chain);
      if (!supported) continue;
      const copy = readClaudeCopy(rec, ent.kind);
      if (!copy) continue;
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
  cov.claude_requests_unverified_version = unverifiedKeys.size;
  // R15.7 / R0.9 version_unverified: names every chain that holds a copy of an unverified key.
  for (const rid of [...unverifiedKeys].sort()) triggers.push({ reason: "version_unverified", names: [...(holders.get(rid) ?? [])] });

  // R0.9 family groups: link (i) a shared sessionId, link (iii) a shared request key.
  const groups = [];
  for (const s of sessChains.values()) if (s.size > 1) groups.push([...s]);
  for (const s of holders.values()) if (s.size > 1) groups.push([...s]);

  const out = [];
  const ccov = (cov.claude_responses = {
    requests_total: 0,
    requests_conflict: 0,
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
    requests_no_event_time: 0,
  });
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
    let tFirst = null;
    for (const cp of copies) if (cp.ts !== null && (tFirst === null || cp.ts < tFirst)) tFirst = cp.ts;
    const inWindow = windowHas(window, tFirst);
    const res = resolveClaude(copies, keyConflict);
    const L = { t: tFirst, chain: heldBy[0] ?? null, inc: {}, kinds: [...(res.conflicts ?? [])], tok: {}, tokInvalid: 0n };
    if (L.kinds.length > 0) L.inc.requests_conflict = 1; // R17.1: once per request, not once per code
    ledger.push(L);
    if (res.anomaly) triggers.push({ reason: "request_anomaly", names: heldBy }); // R0.9, scan-wide (not windowed)
    // Record-level counters (requests_total, the anomaly counters) are scan-wide: no window, live families included.
    ccov.requests_total += 1;
    if (res.excluded) {
      if (res.excluded === "usage_range_failed") L.inc.responses_usage_range_failed = 1;
      else if (res.excluded === "usage_incomplete") {
        L.inc.responses_usage_incomplete = 1;
        for (const [f, v] of Object.entries(res.present_fields)) L.tok[f] = v;
      }
      if (inWindow) out.push({ provider: "claude", key: rid, status: `excluded:${res.excluded}`, counted: false, chain: null });
      continue;
    }
    // R4.6: ownership by earliest stream_start; a key in several streams is a replay in all but one.
    const sids = [...new Set(copies.map((cp) => cp.chain))];
    let owner = sids[0];
    let ambiguous = false;
    if (sids.length > 1) {
      const startOf = (s) => streams.get(s).start ?? Infinity;
      const minStart = Math.min(...sids.map(startOf));
      const tied = sids.filter((s) => startOf(s) === minStart);
      if (tied.length > 1) {
        ambiguous = true;
        tied.sort((a, b) => {
          const sa = streams.get(a);
          const sb = streams.get(b);
          const ka = `${sa.sess ?? ""}\u0001${sa.agent ?? "main"}`;
          const kb = `${sb.sess ?? ""}\u0001${sb.agent ?? "main"}`;
          return ka < kb ? -1 : ka > kb ? 1 : 0;
        });
      }
      owner = tied[0];
    }
    if (ambiguous) triggers.push({ reason: "ownership_ambiguous", names: heldBy }); // R4.6, R0.9
    if (ambiguous) ccov.replay_ownership_ambiguous += 1;
    if (res.flags.includes("bucket_mismatch")) L.inc.responses_bucket_mismatch = 1;
    const ownerCopies = copies.filter((cp) => cp.chain === owner);
    ownerCopies.sort((a, b) => {
      const ta = a.ts ?? Infinity;
      const tb = b.ts ?? Infinity;
      return ta !== tb ? (ta < tb ? -1 : 1) : a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0;
    });
    const kind = ownerCopies[0].kind;
    if (!inWindow) {
      if (windowActive(window) && tFirst !== null) ccov.baseline_requests_loaded += 1;
      else if (windowActive(window)) ccov.requests_no_event_time += 1;
      continue;
    }
    if (sids.length > 1) ccov.replay_requests_excluded += sids.length - 1;
    if (!res.final) ccov.requests_no_final_copy += 1; // R3.12: tokens only
    else if (res.buckets.output === null) ccov.output_unknown_requests += 1; // R2.3: final copy, no usable output
    out.push({
      provider: "claude",
      key: rid,
      kind,
      chain: owner,
      model: res.model,
      flags: res.flags,
      buckets: res.buckets,
      event_ms: tFirst,
      pr: res,
      counted: true,
      status: "counted",
    });
  }
  return { responses: out, facts: { chains, groups, triggers, files }, ledger };
}

// ---------------------------------------------------------------------------
// R0.9 Global integrity abstention: families, live families, taint.
// ---------------------------------------------------------------------------

/**
 * Input per provider:
 *   chains    Set of chain ids seen by a structural read of any version (R15.7).
 *   groups    arrays of chain ids that are linked: R0.9 links (i), (ii) and (iii). Each group is fully connected.
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
    else for (const n of t.names) if (index.has(n)) addReason(find(index.get(n)), t.reason);
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
    const reasons = TAINT_REASONS.filter((x) => set?.has(x));
    const tainted = reasons.length > 0;
    chainsOut.set(order[k], { family: famNo.get(r), tainted, reasons, live });
    if (live) continue; // live families are in none of the counters below (R0.9 Coverage)
    chainsTotal += 1;
    if (tainted) {
      chainsTainted += 1;
      for (const x of reasons) byReason[x] += 1;
    }
  }
  let familiesTotal = 0;
  let familiesTainted = 0;
  for (const r of roots) {
    if (liveRoots.has(r)) continue;
    familiesTotal += 1;
    if (famReasons.has(r)) familiesTainted += 1;
  }
  return {
    chains: chainsOut,
    chains_total: chainsTotal,
    chains_tainted: chainsTainted,
    chains_tainted_by_reason: byReason,
    families_total: familiesTotal,
    families_tainted: familiesTainted,
    families_live_skipped: liveRoots.size,
  };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

const CODEX_KNOWN = ["session_meta", "turn_context", "token_usage_record", "event_msg", "compacted", "response_item"];

/** Every file is parsed with the same readers whatever its version (R15.7 structural reads). `c` takes the type counters, `fc` the line counters. */
// R1.2, R4.12: the Codex retained projection is typed. Every field is reduced to an enum member, a validated id, an
// instant, a bounded token or a counter state before it enters a projection; an invalid raw value is never kept.
const CODEX_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CODEX_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.]+)?$/;
const CODEX_SOURCE_KINDS = ["cli", "exec", "vscode", "mcp", "subagent"];
const CODEX_THREAD_SOURCES = ["user", "subagent", "agent_created_thread", "automation", "guardian_review"];
const CODEX_ORIGINATORS = ["codex_cli", "codex_exec", "codex_vscode", "codex_cli_rs", "codex_exec_rs"];
const CODEX_AGENT_ROLES = ["default", "worker", "explorer", "awaiter"];
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function codexInstant(v) {
  if (typeof v !== "string" || v.length > 40 || !CODEX_ISO_RE.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}
/** An instant field of a payload: the instant, "!" when present and invalid, null when absent. */
const instantState = (v) => (v === undefined || v === null ? null : codexInstant(v) ?? "!");
const codexVersion = (v) => (typeof v === "string" && v.length <= 40 && CODEX_VERSION_RE.test(v) ? v : "unlisted");
const boundedToken = (v) => (typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v) ? v : null);
/** A counter field reduced to its state: the counter, "r" (range) or null (missing, R2.12, R2.15). */
const counterState = (v) => {
  const x = ctr(v);
  return x === MISSING ? null : x === RANGE ? "r" : x;
};
/** An optional counter field of a payload: null when absent, else the counter, "r" or "!" (not a number). */
const optCounter = (v) => {
  if (v === undefined || v === null) return null;
  const x = ctr(v);
  return x === MISSING ? "!" : x === RANGE ? "r" : x;
};

/** R1.2, R4.12: integer members of a cumulative counter object, sorted by name, as a stable string. */
function cumMembers(v) {
  if (!isObj(v)) return v === undefined ? null : "!";
  const out = [];
  for (const k of Object.keys(v)) if (typeof v[k] === "number" && Number.isInteger(v[k])) out.push([k, counterState(v[k])]);
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(out);
}

function parseCodexFile(buf, c, fc) {
  const fd = { metas: [], ctxs: [], turs: [], markers: [], ordRecs: [], tokenCountEvents: 0, lines: 0 };
  for (const obj of jsonLines(buf, fc)) {
    fd.lines += 1;
    if (!isObj(obj)) {
      c.unlisted_type_count += 1;
      continue;
    }
    const type = typeof obj.type === "string" ? obj.type : null;
    if (type !== null && CODEX_KNOWN.includes(type)) c.known_type_count += 1;
    else c.unlisted_type_count += 1;
    const payload = isObj(obj.payload) ? obj.payload : {};
    const ordRaw = obj.ordinal;
    const ordPresent = ordRaw !== undefined && ordRaw !== null;
    const ordValid = ordPresent && typeof ordRaw === "number" && Number.isInteger(ordRaw) && ordRaw >= 0 && ordRaw <= MAX_SAFE;
    const ord = ordValid ? ordRaw : null;
    const tsMs = codexInstant(obj.timestamp);
    const tsKey = tsMs !== null ? tsMs : obj.timestamp === undefined || obj.timestamp === null ? null : "!";
    const known = type !== null && CODEX_KNOWN.includes(type);
    const base = [known ? type : "other", tsKey, ordPresent ? (ordValid ? ordRaw : "!") : null];
    let proj = JSON.stringify(base);
    let decision = false;

    if (type === "session_meta") {
      decision = true;
      const src = payload.source;
      const sub = isObj(src) && isObj(src.subagent) ? src.subagent : null;
      const spawn = sub && isObj(sub.thread_spawn) ? sub.thread_spawn : null;
      const meta = {
        id: str(payload.id),
        sessionId: str(payload.session_id),
        cliVersion: codexVersion(payload.cli_version),
        forkedFrom: str(payload.forked_from_id),
        parentThreadId: str(payload.parent_thread_id),
        spawnParent: spawn ? str(spawn.parent_thread_id) : null,
        hasSpawn: spawn !== null,
        subOther: sub !== null && "other" in sub,
        histStartRaw: payload.subagent_history_start_ordinal,
        threadSource: enumOf(payload.thread_source, CODEX_THREAD_SOURCES),
        ord,
        tsMs,
      };
      const hs = ctr(meta.histStartRaw);
      meta.histStart = hs >= 0 ? hs : null;
      meta.histKey = optCounter(meta.histStartRaw);
      const srcKind = typeof src === "string" ? enumOf(src, CODEX_SOURCE_KINDS) : sub !== null ? "subagent" : src === undefined ? null : "other";
      proj = JSON.stringify([...base, meta.id, meta.sessionId, instantState(payload.timestamp), meta.cliVersion, meta.forkedFrom, meta.parentThreadId, meta.spawnParent, spawn ? optCounter(spawn.depth) : null, spawn !== null, sub !== null, meta.subOther, meta.histKey, enumOf(payload.originator, CODEX_ORIGINATORS), srcKind, meta.threadSource, enumOf(payload.agent_role, CODEX_AGENT_ROLES)]);
      fd.metas.push(meta);
    } else if (type === "turn_context") {
      decision = true;
      const ctx = {
        turnId: str(payload.turn_id),
        model: ctxModel(payload.model),
        ord,
        tsMs,
      };
      proj = JSON.stringify([...base, ctx.turnId, str(payload.root_turn_id), ctx.model, payload.model === undefined ? 0 : 1, enumOf(payload.effort, CODEX_EFFORTS), boundedToken(payload.comp_hash), isObj(payload.collaboration_mode) ? boundedToken(payload.collaboration_mode.mode) : null]);
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
        tsMs,
      };
      const rawUsage = [u.input_tokens, u.cached_input_tokens, u.cache_write_input_tokens, u.output_tokens, u.reasoning_output_tokens, u.total_tokens].map(counterState);
      tur.usageKey = JSON.stringify(rawUsage);
      proj = JSON.stringify([...base, tur.responseId, tur.threadId, tur.sessionId, tur.turnId, rawUsage, counterState(tu.total_tokens), cumMembers(payload.thread_token_usage), cumMembers(payload.turn_token_usage)]);
      tur.proj = proj;
      fd.turs.push(tur);
    } else if (type === "event_msg") {
      const pt = enumOf(payload.type, ["token_count", "thread_settings_applied"]);
      proj = JSON.stringify([...base, pt]);
      if (pt === "token_count") fd.tokenCountEvents += 1;
      if (pt === "thread_settings_applied") {
        decision = true;
        fd.markers.push({ ord, tsMs });
      }
    } else if (type === "compacted") {
      decision = true;
      proj = JSON.stringify([...base, str(payload.compaction_response_id), str(payload.window_id), optCounter(payload.window_number), payload.latest_token_usage_record === null || payload.latest_token_usage_record === undefined]);
    }
    if (decision || ordPresent) {
      const bad = (decision && (!ordValid || tsMs === null)) || (ordPresent && (!ordValid || tsMs === null));
      fd.ordRecs.push({ ord, tsMs, proj, bad });
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
  const sorted = [...byOrd.values()].sort((a, b) => a.ord - b.ord);
  for (let k = 1; k < sorted.length; k += 1) if (sorted[k].tsMs < sorted[k - 1].tsMs) return false; // (c)
  return true;
}

function codexKind(meta) {
  if (!meta) return "unclassified";
  if (meta.hasSpawn || meta.threadSource === "subagent" || meta.threadSource === "agent_created_thread") return "subagent"; // R5.2
  if (meta.threadSource === "automation") return "helper";
  if (meta.threadSource === "guardian_review") return "classifier";
  if (meta.threadSource === null || meta.threadSource === "user") return "main";
  return "unclassified";
}

function scanCodex(entries, cov, window) {
  cov.codex = { files_total: 0, files_unreadable: 0, lines_total: 0, lines_parse_error: 0, lines_truncated_tail: 0, known_type_count: 0, unlisted_type_count: 0, files_without_response_id: 0, token_count_events_without_response_id: 0, files_unassigned_stream: 0, files_assigned_by_stream: 0, files_stream_conflict: 0, files_copy_exposed: 0, lines_unverified_version: 0 };
  const c = cov.codex;
  const files = [];
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
    const fd = parseCodexFile(buf, c, fc);
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
    const shapes = new Set(metas.map((m) => JSON.stringify([m.sessionId, m.forkedFrom, m.histKey])));
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
      t.models.add(x.model); // a missing or unusable model is a null member of TM(T): A plus null conflicts (R2.17 (d))
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
  for (const s of streams.values()) {
    const metas = ownMetasById.get(s.id) ?? [];
    s.meta = [...metas].sort((a, b) => (a.ord ?? Infinity) - (b.ord ?? Infinity))[0] ?? null;
    s.ordinalVerified = ordinalVerified(s.ordRecs);
    s.isFork = metas.some((m) => m.forkedFrom !== null);
    s.histStart = metas.find((m) => m.forkedFrom !== null)?.histStart ?? null;
    s.prefixResolved = !s.isFork || (s.ordinalVerified && s.histStart !== null); // R4.9
    if (!s.ordinalVerified) triggers.push({ reason: "ordinal_unverified", names: [codexChainId(s.id)] }); // R4.12
    if (s.isFork && !s.prefixResolved) triggers.push({ reason: "fork_prefix_unresolved", names: [codexChainId(s.id)] }); // R4.9
    s.kind = codexKind(s.meta);
    s.modelsOfCtx = new Set(s.ctxs.map((x) => x.model));
    s.ctxByTurn = new Map();
    for (const x of s.ctxs) {
      if (x.turnId === null) continue;
      let l = s.ctxByTurn.get(x.turnId);
      if (!l) s.ctxByTurn.set(x.turnId, (l = []));
      l.push(x);
    }
  }

  // R15.7: V(S) is the cli_version of every session_meta with id = S, own or copied. Supported iff non-empty and all full.
  const supportedThread = (id) => {
    const metas = allMetasById.get(id) ?? [];
    return metas.length > 0 && metas.every((m) => m.cliVersion !== null && CODEX_FULL_VERSIONS.includes(m.cliVersion));
  };
  const threads = new Set();
  for (const id of allMetasById.keys()) threads.add(id);
  for (const fd of files) for (const t of fd.turs) if (t.threadId !== null) threads.add(t.threadId);
  for (const id of [...threads].sort()) if (!supportedThread(id)) triggers.push({ reason: "version_unverified", names: [codexChainId(id)] });

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
        const posOk = s.ordinalVerified && t.ord !== null;
        if (!posOk) return { source: "own_turn_unsettled", verified: false, model };
        const earliest = Math.min(...own.map((x) => x.ord));
        const lo = Math.min(earliest, t.ord);
        const hi = Math.max(earliest, t.ord);
        if (s.markers.some((m) => m.ord !== null && m.ord > lo && m.ord < hi)) return { source: "own_turn_unsettled", verified: false, model };
      }
      return { source: "own_turn", verified: true, model };
    }
    // carried: the context with the greatest (timestamp, ordinal) before the record
    let best = null;
    for (const x of s.ctxs) {
      if (x.tsMs === null || t.tsMs === null) continue;
      let before;
      if (x.tsMs !== t.tsMs) before = x.tsMs < t.tsMs;
      else before = x.ord !== null && t.ord !== null && x.ord < t.ord;
      if (!before) continue;
      if (best === null || x.tsMs > best.tsMs || (x.tsMs === best.tsMs && (x.ord ?? -1) > (best.ord ?? -1))) best = x;
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
  const ccov = (cov.codex_responses = {
    requests_total: 0,
    requests_conflict: 0,
    requests_conflict_by_kind: {},
    records_unkeyed: 0,
    requests_unverified_version: 0,
    responses_usage_range_failed: 0,
    responses_usage_incomplete: 0,
    responses_usage_invariant_failed: 0,
    tokens_in_incomplete_by_field: {},
    tokens_in_invalid_responses: "0",
    baseline_requests_loaded: 0,
    requests_no_event_time: 0,
  });
  const unkeyedSeen = new Set();
  const ledger = [];
  for (const fd of files) {
    for (const t of fd.turs) {
      if (t.threadId === null) {
        // No chain key: unkeyed for accounting (R2.13, logical: equal records count once) and unattributed for R0.9
        // (provider trigger, above). It counts in records_unkeyed and not as unmappable.
        if (!unkeyedSeen.has(t.proj)) {
          unkeyedSeen.add(t.proj);
          ccov.records_unkeyed += 1;
          ledger.push({ t: t.tsMs, chain: null, inc: { records_unkeyed: 1 }, kinds: [], tok: {}, tokInvalid: 0n });
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
          ledger.push({ t: t.tsMs, chain: codexChainId(t.threadId), inc: { records_unkeyed: 1 }, kinds: [], tok: {}, tokInvalid: 0n });
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
    let tMs = null;
    for (const o of occ) if (o.t.tsMs !== null && (tMs === null || o.t.tsMs < tMs)) tMs = o.t.tsMs;
    const inWindow = windowHas(window, tMs);
    const L = { t: tMs, chain: heldBy[0] ?? null, inc: {}, kinds: [], tok: {}, tokInvalid: 0n };
    ledger.push(L);
    if (!allEqual) {
      triggers.push({ reason: "request_anomaly", names: heldBy }); // R4.4
      const usageEqual = occ.every((o) => o.t.usageKey === first.t.usageKey);
      const kind = usageEqual ? "conflict_attribution" : "conflict_usage";
      ccov.requests_total += 1; // scan-wide diagnostic count of keys
      L.inc.requests_conflict = 1;
      L.kinds.push(kind);
      if (inWindow) out.push({ provider: "codex", key, status: `excluded:${kind}`, counted: false, chain: null });
      continue;
    }
    const { t, attr } = first;
    const s = streams.get(t.threadId);
    const vals = { in: t.in, c: t.c, cw: t.cw, out: t.out, rs: t.rs, total: t.total };
    const rangeFailed = Object.values(vals).includes(RANGE);
    const incomplete = !rangeFailed && Object.values(vals).includes(MISSING);
    let invariantFailed = false;
    if (!rangeFailed && !incomplete) {
      invariantFailed = BigInt(t.c) + BigInt(t.cw) > BigInt(t.in) || BigInt(t.rs) > BigInt(t.out) || BigInt(t.total) !== BigInt(t.in) + BigInt(t.out);
    }
    if (rangeFailed || incomplete || invariantFailed) triggers.push({ reason: "request_anomaly", names: heldBy }); // R2.7, R2.12, R2.15
    ccov.requests_total += 1; // scan-wide (see above)
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
      for (const [f, v] of Object.entries(vals)) if (v >= 0) L.tok[f] = BigInt(v);
      dropRow("excluded:usage_incomplete");
      continue;
    }
    const inn = BigInt(t.in);
    const cc = BigInt(t.c);
    const cw = BigInt(t.cw);
    const outT = BigInt(t.out);
    const rs = BigInt(t.rs);
    if (invariantFailed) {
      L.inc.responses_usage_invariant_failed = 1; // R2.7
      L.tokInvalid = inn + outT;
      dropRow("excluded:usage_invariant_failed");
      continue;
    }
    if (!inWindow) {
      if (windowActive(window) && tMs !== null) ccov.baseline_requests_loaded += 1;
      else if (windowActive(window)) ccov.requests_no_event_time += 1;
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
      kind: s ? s.kind : "unclassified",
      chain: codexChainId(t.threadId),
      model: attr.verified ? attr.model : null,
      model_source: attr.source,
      flags: [],
      buckets,
      event_ms: tMs,
      attr,
      inn,
      counted: true,
      status: "counted",
    });
  }
  return { responses: out, facts: { chains: universe, groups: famGroups, triggers, files: factFiles }, ledger };
}

/** R3.6, R3.10: price one Codex response of an untainted chain. The tier gate comes first (R3.4), before R3.10. */
function priceCodex(r, book, tierVerified) {
  const b = r.buckets;
  const tot = r.inn + b.output;
  if (!tierVerified) return unpriced("modifier_unverified", tot); // R3.4: no retained field shows the Codex service tier
  if (!r.attr.verified) return unpriced("model_unknown", tot); // R2.10
  const entry = usableEntry(book, r.attr.model);
  if (!entry || codexRow(entry.prices_usd_per_mtok) === null) return unpriced("unknown_model", tot); // R3.3
  const lc = entry.long_context;
  const requestScoped =
    isObj(lc) &&
    lc.scope === "request" &&
    lc.scope_verified === true &&
    verifiedObj({ verified: true, verified_at: lc.verified_at }, entry, book.table) &&
    typeof lc.scope_source_id === "string" &&
    isObj(book.table.sources) &&
    lc.scope_source_id in book.table.sources; // R3.10, R3.11
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

function windowHas(w, ms) {
  if (!windowActive(w)) return true;
  if (ms === null) return false;
  if (w.since !== null && ms < w.since) return false;
  if (w.until !== null && ms >= w.until) return false;
  return true;
}

function parseBound(v, name) {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return Date.parse(`${v}T00:00:00.000Z`);
  const ms = parseTs(v);
  if (ms === null) throw new Error(`bad_${name}`);
  return ms;
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
  target.requests_conflict = 0;
  target.requests_conflict_by_kind = {};
  target.responses_usage_range_failed = 0;
  target.responses_usage_incomplete = 0;
  target.tokens_in_incomplete_by_field = {};
  if (provider === "claude") target.responses_bucket_mismatch = 0;
  else {
    target.responses_usage_invariant_failed = 0;
    target.tokens_in_invalid_responses = "0";
    target.records_unkeyed = 0;
  }
  if (own !== null) own.records_unkeyed = 0;
  const tok = {};
  let invalid = 0n;
  for (const e of ledger) {
    if (e.t !== null && windowActive(window) && !windowHas(window, e.t)) continue;
    if (e.chain !== null && taint.chains.get(e.chain)?.live === true) continue;
    for (const [k, n] of Object.entries(e.inc)) {
      if (k === "records_unkeyed" && own !== null) own.records_unkeyed += n;
      else target[k] += n;
    }
    for (const k of e.kinds) bump(target.requests_conflict_by_kind, k);
    for (const [f, v] of Object.entries(e.tok)) tok[f] = (tok[f] ?? 0n) + v;
    invalid += e.tokInvalid;
  }
  for (const [f, v] of Object.entries(tok)) target.tokens_in_incomplete_by_field[f] = v.toString();
  if (provider === "codex") target.tokens_in_invalid_responses = invalid.toString();
}

function parseRunStart(v) {
  if (v === undefined || v === null) return Date.now(); // read once per run (R0.9)
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const ms = parseTs(v);
  if (ms === null) throw new Error("bad_run_start");
  return ms;
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

  const responses = [...scans.claude.responses, ...scans.codex.responses];
  const known = new Set();
  for (const id of book.byModel.keys()) known.add(id);
  const modelLabel = (m) => {
    const n = normalizeModel(m);
    return n !== null && MODEL_ID_RE.test(n) && known.has(n) ? n : "unlisted"; // R14.3
  };

  const providers = {};
  const tokensTotal = {};
  for (const provider of ["claude", "codex"]) {
    const total = emptyAgg();
    const byModel = new Map();
    const byKind = new Map();
    const unpricedReasons = new Map();
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
        row.event = r.event_ms === null ? null : new Date(r.event_ms).toISOString();
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
