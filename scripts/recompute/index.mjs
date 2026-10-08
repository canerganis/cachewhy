#!/usr/bin/env node
// cachewhy independent recompute (spec R13.1 to R13.3).
//
// A second, deliberately separate implementation of the ACCOUNTING part of docs/methodology.md:
// unique responses (R4), token buckets per provider (R2), list-price equivalent (R3). It reads raw
// log files and the pricing table JSON. It imports nothing from src/ and nothing outside node:*.
// It does not detect events, boundaries or causes (sections 7 to 11).
//
// Written from the spec text, not from src/. Rule ids are cited where a rule is implemented.
// Plain Node ESM, zero dependencies. All token arithmetic and all money use BigInt (R2.16, R3.8).
//
// Codex dollars: R3.4 has a tier gate. No retained field shows the Codex service tier, so a default run gives
// every Codex response reason modifier_unverified and no dollars. The test-only API parameter
// `codexTierForTest: "standard"` (spec name codex_tier_for_test) marks the tier as verified Standard so that the
// row selection of R3.6 and R3.10 can be exercised. It is deliberately not a CLI flag or an environment variable.
//
// Usage:
//   node scripts/recompute/index.mjs --claude-dir <dir> [--claude-dir <dir>] --codex-dir <dir>
//        [--since <ISO instant or YYYY-MM-DD>] [--until <ISO instant or YYYY-MM-DD>]
//        [--table <table.json>] [--version-policy strict|all] [--per-response [--raw-keys]] [--out <file>]
//
// Output: one JSON document on stdout (or --out). Token amounts and money are decimal strings.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

function enumOf(v, allowed) {
  if (v === undefined || v === null) return null;
  return typeof v === "string" && allowed.includes(v) ? v : "other";
}

function sha16(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
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

const ROLLOUT_RE = /^rollout-.*\.jsonl$/;
const ROLLOUT_ZST_RE = /^rollout-.*\.jsonl\.zst$/;

function walk(dir, out, seen = new Set()) {
  let ents;
  try {
    const real = realpathSync(dir);
    if (seen.has(real)) return false; // symlink loop or repeated directory
    seen.add(real);
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
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
    if (isDir) walk(p, out, seen);
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

/** Entries: { provider, rel: string[], zst: boolean, read(): Buffer }. */
function discoverEntries(claudeDirs, codexDirs, cov) {
  const entries = [];
  const seenFiles = new Set();
  const seenRoots = new Set();
  const addFiles = (provider, root) => {
    let real;
    try {
      real = realpathSync(root);
    } catch {
      return;
    }
    if (!isDirectory(real)) return;
    const rootKey = `${provider}:${real}`;
    if (seenRoots.has(rootKey)) return;
    seenRoots.add(rootKey);
    const files = [];
    walk(root, files);
    for (const f of files) {
      const rel = f.slice(root.length).split(/[\\/]+/).filter(Boolean);
      let key;
      try {
        key = realpathSync(f);
      } catch {
        continue;
      }
      if (seenFiles.has(key)) continue;
      const name = rel[rel.length - 1] ?? "";
      if (provider === "claude") {
        const kind = classifyClaude(rel);
        if (!kind) continue;
        seenFiles.add(key);
        entries.push({ provider, rel, kind, zst: false, read: () => readFileSync(f) });
      } else {
        const zst = ROLLOUT_ZST_RE.test(name);
        if (!zst && !ROLLOUT_RE.test(name)) continue;
        seenFiles.add(key);
        entries.push({ provider, rel, kind: null, zst, read: () => readFileSync(f) });
      }
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
    const content = typeof f.content === "string" ? Buffer.from(f.content, "utf8") : Buffer.from(f.content);
    if (segs[0] === "projects") {
      const rel = segs.slice(1);
      const kind = classifyClaude(rel);
      if (kind) entries.push({ provider: "claude", rel, kind, zst: false, read: () => content });
    } else if (segs[0] === "sessions" || segs[0] === "archived_sessions") {
      const name = segs[segs.length - 1] ?? "";
      const zst = ROLLOUT_ZST_RE.test(name);
      if (zst || ROLLOUT_RE.test(name)) entries.push({ provider: "codex", rel: segs, kind: null, zst, read: () => content });
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

/** R3.11: an object with verified:true and an effective date. */
function verifiedObj(obj, entry, table) {
  if (!isObj(obj) || obj.verified !== true) return false;
  const date = obj.verified_at ?? entry?.verified_at ?? table.verified_at;
  return typeof date === "string" && date.length > 0;
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
    output_excluded: 0,
    tokens,
    context_tokens: 0n,
    tokens_total: 0n,
    tokens_unpriced: 0n,
    usd_pico_lo: 0n,
    usd_pico_hi: 0n,
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
    a.usd_pico_lo += r.price.lo;
    a.usd_pico_hi += r.price.hi;
    if (r.price.output_excluded) a.output_excluded += 1;
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
    responses_priced_without_output_term: a.output_excluded,
    tokens,
    context_tokens: a.context_tokens.toString(),
    tokens_total: a.tokens_total.toString(),
    tokens_unpriced: a.tokens_unpriced.toString(),
    // R3.9: exact cross-multiplication, `10 * tokens_unpriced > tokens_total`.
    unpriced_share_exceeds_c24: a.tokens_unpriced * C24[1] > a.tokens_total * C24[0],
    reasoning_informational: a.reasoning_informational.toString(),
    usd_pico_lo: a.usd_pico_lo.toString(),
    usd_pico_hi: a.usd_pico_hi.toString(),
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

function claudeSupported(version, policy) {
  if (policy === "all") return true;
  return typeof version === "string" && VERSION_RE.test(version) && CLAUDE_FULL_VERSIONS.includes(version); // R15.7
}

/** Read one assistant copy (R1.2 counters, R2.1, R2.12, R2.15, R4.2). */
function readClaudeCopy(rec, kind) {
  const msg = rec.message;
  if (!isObj(msg) || !isObj(msg.usage)) return null; // not usage-bearing
  const u = msg.usage;
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
    sess: str(rec.sessionId),
    agent: str(rec.agentId),
    kind,
    uuid: str(rec.uuid) ?? "",
    ts: null,
    model: str(msg.model),
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
 * conflict_input and conflict_model (R4.2).
 */
function resolveClaude(copies, keyConflict) {
  if (copies.some((c) => c.range)) return { excluded: "usage_range_failed" };
  if (copies.some((c) => c.incomplete)) {
    const present_fields = {};
    for (const f of ["i", "r", "wt", "w5", "w1", "o"]) {
      const m = maxPresent(copies, f);
      if (m >= 0) present_fields[f] = BigInt(m);
    }
    return { excluded: "usage_incomplete", present_fields };
  }
  if (keyConflict) return { excluded: "key_conflict" };
  const c0 = copies[0];
  for (const c of copies) {
    if (c.i !== c0.i || c.r !== c0.r || c.wt !== c0.wt || c.hasCC !== c0.hasCC || c.w5 !== c0.w5 || c.w1 !== c0.w1) {
      return { excluded: "conflict_input" };
    }
  }
  const models = new Set(copies.map((c) => c.model).filter((m) => m !== null));
  if (models.size > 1) return { excluded: "conflict_model" };
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
  return {
    excluded: null,
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

/** R3.5, R3.4, R3.12: price one Claude response. */
function priceClaude(res, book, stats) {
  const b = res.buckets;
  const ctx = b.input_uncached + b.cache_read + b.cache_write_5m + b.cache_write_1h + b.cache_write_unknown_ttl;
  const tot = ctx + b.output_lower_bound; // lb equals output when output is known
  const entry = usableEntry(book, normalizeModel(res.model));
  if (!entry || claudeRow(entry.prices_usd_per_mtok) === null) return unpriced("unknown_model", tot); // R3.3
  if (!res.final) return unpriced("modifier_unverified", tot); // R3.12
  if (res.modConflict) return unpriced("conflict_modifier", tot); // R4.2
  const { speed, geo, tier } = res.mods;
  if (speed === "other") return unpriced("speed_other", tot);
  if (geo === "other") return unpriced("geo_other", tot);

  let row = claudeRow(entry.prices_usd_per_mtok);
  const nonStd = tier === "priority" || tier === "batch" || tier === "other";
  if (nonStd) {
    const st = isObj(entry.service_tier) ? entry.service_tier[tier] : undefined;
    const stRow = isObj(st) && verifiedObj(st, entry, book.table) ? claudeRow(st.prices_usd_per_mtok) : null;
    if (!stRow || speed === "fast") return unpriced("service_tier_unpriced", tot);
    row = stRow;
  } else if (speed === "fast") {
    const f = entry.fast;
    const fRow = isObj(f) && verifiedObj(f, entry, book.table) ? claudeRow(f.prices_usd_per_mtok) : null;
    if (!fRow) return unpriced("speed_fast_no_row", tot);
    if (geo === "us" && !(fastVerifiedModifier(book) && f.geo_us_applies === true && geoApplies(book, entry))) {
      return unpriced("fast_geo_unverified", tot);
    }
    row = fRow;
  } else if (isObj(entry.tiers)) {
    // Haiku 5.5 tier by total_input = i + r + w (R2.2, R3.4)
    if (ctx > C26) {
      const hi = verifiedObj(entry.tiers, entry, book.table) ? claudeRow(entry.tiers.high) : null;
      if (!hi) return unpriced("tier_unverified", tot);
      row = hi;
    }
  }
  if (geo === "us" && !geoApplies(book, entry)) return unpriced("geo_unverified", tot);

  const base =
    b.input_uncached * row.input +
    b.cache_read * row.cache_read +
    b.cache_write_5m * row.cache_write_5m +
    b.cache_write_1h * row.cache_write_1h;
  const out = b.output !== null ? b.output * row.output : 0n; // R2.3: omitted when output is unknown
  let lo = base + out + b.cache_write_unknown_ttl * row.cache_write_5m; // R3.5 range ends
  let hi = base + out + b.cache_write_unknown_ttl * row.cache_write_1h;
  if (geo === "us") {
    lo = applyGeo(lo, stats);
    hi = applyGeo(hi, stats);
  }
  return { priced: true, lo, hi, output_excluded: b.output === null, tokens_unpriced: 0n };
}

function scanClaude(entries, opts, cov, window) {
  const policy = opts.versionPolicy;
  const streams = new Map(); // streamId -> { sess, agent, start }
  const requests = new Map(); // rid -> copies[]
  const midToRids = new Map();
  const ridToMids = new Map();
  const unverifiedKeys = new Set();
  cov.claude = { files_total: 0, files_unreadable: 0, lines_total: 0, lines_parse_error: 0, lines_truncated_tail: 0, known_type_count: 0, unlisted_type_count: 0, lines_unverified_version: 0, api_error_records: 0, records_unkeyed: 0 };
  const c = cov.claude;
  for (const ent of entries) {
    if (ent.provider !== "claude") continue;
    c.files_total += 1;
    let buf;
    try {
      buf = ent.read();
    } catch {
      c.files_unreadable += 1;
      continue;
    }
    for (const rec of jsonLines(buf, c)) {
      if (!isObj(rec)) {
        c.unlisted_type_count += 1;
        continue;
      }
      const type = rec.type;
      const known = type === "assistant" || type === "user" || type === "system" || type === "attachment";
      if (known) c.known_type_count += 1;
      else c.unlisted_type_count += 1;
      if (!known) continue;
      if (!claudeSupported(rec.version, policy)) {
        c.lines_unverified_version += 1;
        if (type === "assistant" && str(rec.requestId)) unverifiedKeys.add(rec.requestId); // R15.7
        continue;
      }
      const sess = str(rec.sessionId);
      const agent = str(rec.agentId);
      const sid = `${sess ?? ""}\u0000${agent ?? "main"}`;
      const ts = parseTs(rec.timestamp);
      let st = streams.get(sid);
      if (!st) streams.set(sid, (st = { sess, agent, start: null }));
      if (ts !== null && (st.start === null || ts < st.start)) st.start = ts; // R4.6 stream_start
      if (type !== "assistant") continue;
      const msg = isObj(rec.message) ? rec.message : null;
      if (rec.isApiErrorMessage === true || msg?.model === "<synthetic>") {
        c.api_error_records += 1; // R2.14
        continue;
      }
      if (!str(rec.requestId)) {
        if (msg && isObj(msg.usage)) c.records_unkeyed += 1; // R2.13
        continue;
      }
      const copy = readClaudeCopy(rec, ent.kind);
      if (!copy) continue;
      copy.ts = ts;
      copy.sid = sid;
      let list = requests.get(copy.rid);
      if (!list) requests.set(copy.rid, (list = []));
      list.push(copy);
      if (copy.mid) {
        let s = ridToMids.get(copy.rid);
        if (!s) ridToMids.set(copy.rid, (s = new Set()));
        s.add(copy.mid);
        let t = midToRids.get(copy.mid);
        if (!t) midToRids.set(copy.mid, (t = new Set()));
        t.add(copy.rid);
      }
    }
  }
  cov.claude_requests_unverified_version = unverifiedKeys.size;

  const out = [];
  const stats = { geo_rounded: 0 };
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
    const copies = requests.get(rid);
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
    if (res.excluded) {
      if (!inWindow) continue;
      ccov.requests_total += 1;
      if (res.excluded === "usage_range_failed") ccov.responses_usage_range_failed += 1;
      else if (res.excluded === "usage_incomplete") {
        ccov.responses_usage_incomplete += 1;
        for (const [f, v] of Object.entries(res.present_fields)) {
          ccov.tokens_in_incomplete_by_field[f] = (BigInt(ccov.tokens_in_incomplete_by_field[f] ?? 0) + v).toString();
        }
      } else {
        ccov.requests_conflict += 1;
        bump(ccov.requests_conflict_by_kind, res.excluded);
      }
      out.push({ provider: "claude", key: rid, status: `excluded:${res.excluded}`, counted: false });
      continue;
    }
    // R4.6: ownership by earliest stream_start; a key in several streams is a replay in all but one.
    const sids = [...new Set(copies.map((cp) => cp.sid))];
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
    const ownerCopies = copies.filter((cp) => cp.sid === owner);
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
    ccov.requests_total += 1;
    if (sids.length > 1) ccov.replay_requests_excluded += sids.length - 1;
    if (ambiguous) ccov.replay_ownership_ambiguous += 1;
    if (res.flags.includes("bucket_mismatch")) ccov.responses_bucket_mismatch += 1;
    if (!res.final) ccov.requests_no_final_copy += 1; // R3.12: tokens only
    else if (res.buckets.output === null) ccov.output_unknown_requests += 1; // R2.3: final copy, no usable output
    const price = priceClaude(res, book_ref.book, stats);
    out.push({
      provider: "claude",
      key: rid,
      kind,
      model: res.model,
      flags: res.flags,
      buckets: res.buckets,
      event_ms: tFirst,
      price,
      counted: true,
      status: "counted",
    });
  }
  cov.geo_rounded_claude = stats.geo_rounded;
  return out;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

const CODEX_KNOWN = ["session_meta", "turn_context", "token_usage_record", "event_msg", "compacted", "response_item"];

function parseCodexFile(buf, c) {
  const fd = { metas: [], ctxs: [], turs: [], markers: [], ordRecs: [], tokenCountEvents: 0, lines: 0 };
  for (const obj of jsonLines(buf, c)) {
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
    const tsMs = parseTs(obj.timestamp);
    const tsKey = tsMs !== null ? tsMs : JSON.stringify(obj.timestamp ?? null);
    const base = [type ?? "other", tsKey, ordPresent ? (ordValid ? ordRaw : "bad") : null];
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
        cliVersion: str(payload.cli_version),
        forkedFrom: str(payload.forked_from_id),
        parentThreadId: str(payload.parent_thread_id),
        spawnParent: spawn ? str(spawn.parent_thread_id) : null,
        hasSpawn: spawn !== null,
        subOther: sub !== null && "other" in sub,
        histStartRaw: payload.subagent_history_start_ordinal,
        threadSource: str(payload.thread_source),
        ord,
        tsMs,
      };
      const hs = ctr(meta.histStartRaw);
      meta.histStart = hs >= 0 ? hs : null;
      proj = JSON.stringify([...base, meta.id, meta.sessionId, str(payload.timestamp), meta.cliVersion, meta.forkedFrom, meta.parentThreadId, meta.spawnParent, spawn?.depth ?? null, meta.subOther, meta.histStartRaw ?? null, str(payload.originator), typeof src === "string" ? src : isObj(src) ? "object" : null, meta.threadSource, str(payload.agent_role)]);
      fd.metas.push(meta);
    } else if (type === "turn_context") {
      decision = true;
      const ctx = {
        turnId: str(payload.turn_id),
        model: normalizeModel(str(payload.model)),
        ord,
        tsMs,
      };
      proj = JSON.stringify([...base, ctx.turnId, str(payload.root_turn_id), str(payload.model), str(payload.effort), str(payload.comp_hash), isObj(payload.collaboration_mode) ? str(payload.collaboration_mode.mode) : null]);
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
      const rawUsage = [u.input_tokens, u.cached_input_tokens, u.cache_write_input_tokens, u.output_tokens, u.reasoning_output_tokens, u.total_tokens].map((x) => (x === undefined ? "undef" : x));
      tur.usageKey = JSON.stringify(rawUsage);
      proj = JSON.stringify([...base, tur.responseId, tur.threadId, tur.sessionId, tur.turnId, rawUsage, tu.total_tokens ?? null]);
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
      proj = JSON.stringify([...base, str(payload.compaction_response_id), str(payload.window_id), typeof payload.window_number === "number" ? payload.window_number : null, payload.latest_token_usage_record === null || payload.latest_token_usage_record === undefined]);
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

function scanCodex(entries, opts, cov, window) {
  const policy = opts.versionPolicy;
  cov.codex = { files_total: 0, files_unreadable: 0, lines_total: 0, lines_parse_error: 0, lines_truncated_tail: 0, known_type_count: 0, unlisted_type_count: 0, files_without_response_id: 0, token_count_events_in_such_files: 0, files_unassigned_stream: 0, files_assigned_by_stream: 0, files_stream_conflict: 0, files_copy_exposed: 0 };
  const c = cov.codex;
  const files = [];
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
      c.files_unreadable += 1;
      continue;
    }
    const fd = parseCodexFile(buf, c);
    if (fd.turs.length === 0 && fd.tokenCountEvents > 0) {
      c.files_without_response_id += 1; // R2.9
      c.token_count_events_in_such_files += fd.tokenCountEvents;
    }
    files.push(fd);
  }

  // R4.11: own session_meta per file, identity sets.
  for (const fd of files) {
    fd.own = fd.metas.filter((m) => !fd.metas.some((o) => o !== m && o.forkedFrom !== null && o.forkedFrom === m.id));
    fd.ownIds = new Set(fd.own.map((m) => m.id).filter((x) => x !== null));
    fd.turIds = new Set(fd.turs.map((t) => t.threadId).filter((x) => x !== null));
    fd.I = new Set([...fd.ownIds, ...fd.turIds]);
  }
  // R4.13: FS over the whole scan.
  const FS = new Set();
  for (const fd of files) for (const m of fd.metas) if (m.forkedFrom !== null) FS.add(m.forkedFrom);
  for (const fd of files) {
    fd.copyExposed = [...fd.ownIds].some((x) => FS.has(x) && !fd.turs.some((t) => t.threadId === x));
    if (fd.I.size === 1) {
      fd.assignment = "assigned";
      c.files_assigned_by_stream += 1;
    } else if (fd.I.size === 0) {
      fd.assignment = "unassigned";
      c.files_unassigned_stream += 1;
    } else {
      fd.assignment = "conflict";
      c.files_stream_conflict += 1;
    }
    if (fd.copyExposed) c.files_copy_exposed += 1;
  }

  // Own session_meta of the whole scan (for versions, forks, FA(S)).
  const ownMetasById = new Map();
  for (const fd of files) {
    for (const m of fd.own) {
      if (m.id === null) continue;
      let l = ownMetasById.get(m.id);
      if (!l) ownMetasById.set(m.id, (l = []));
      l.push(m);
    }
  }
  const copyExposedOwnIds = new Set();
  for (const fd of files) if (fd.copyExposed) for (const x of fd.ownIds) copyExposedOwnIds.add(x);

  // Logical streams.
  const streams = new Map();
  const getStream = (id) => {
    let s = streams.get(id);
    if (!s) {
      s = { id, files: [], ordRecs: [], ctxs: [], markers: [], integrity: false };
      streams.set(id, s);
    }
    return s;
  };
  for (const fd of files) {
    if (fd.assignment === "conflict") for (const id of fd.I) getStream(id).integrity = true; // R4.11
    if (fd.assignment !== "assigned") continue;
    const id = [...fd.I][0];
    const s = getStream(id);
    s.files.push(fd);
    for (const x of fd.ordRecs) s.ordRecs.push(x);
    for (const x of fd.markers) s.markers.push(x); // conservative: markers of any file count
    if (!fd.copyExposed) for (const x of fd.ctxs) if (x.model !== null) s.ctxs.push(x); // certain provenance (R4.13 (b))
    if (fd.copyExposed && fd.ownIds.has(id) && FS.has(id)) s.integrity = true; // R4.13 (a)
  }
  for (const fd of files) {
    if (fd.assignment === "assigned" && fd.copyExposed) {
      for (const x of fd.ownIds) if (FS.has(x)) getStream(x).integrity = true;
    }
  }
  const scov = (cov.codex_streams = { streams_integrity_unverified: 0, streams_ordinal_unverified: 0, streams_fork_prefix_unresolved: 0, streams_prefix_exposed: 0 });
  const faCache = new Map();
  const forkAncestors = (id) => {
    if (faCache.has(id)) return faCache.get(id);
    const set = new Set();
    const metas = ownMetasById.get(id) ?? [];
    const queue = metas.map((m) => m.forkedFrom).filter((x) => x !== null);
    while (queue.length) {
      const x = queue.pop();
      if (set.has(x)) continue;
      set.add(x);
      for (const m of ownMetasById.get(x) ?? []) if (m.forkedFrom !== null) queue.push(m.forkedFrom);
    }
    faCache.set(id, set);
    return set;
  };
  for (const s of streams.values()) {
    const metas = ownMetasById.get(s.id) ?? [];
    s.meta = [...metas].sort((a, b) => (a.ord ?? Infinity) - (b.ord ?? Infinity))[0] ?? null;
    s.versions = [...new Set(metas.map((m) => m.cliVersion))];
    // R4.11: same id with differing fork fields is integrity_unverified.
    if (new Set(metas.map((m) => `${m.forkedFrom}|${m.histStartRaw ?? ""}`)).size > 1) s.integrity = true;
    s.ordinalVerified = ordinalVerified(s.ordRecs);
    s.isFork = metas.some((m) => m.forkedFrom !== null);
    const hs = metas.find((m) => m.forkedFrom !== null)?.histStart ?? null;
    s.histStart = hs;
    s.prefixResolved = !s.isFork || (s.ordinalVerified && hs !== null); // R4.9
    // R4.13 (c): prefix_exposed
    s.prefixExposed = false;
    if (s.isFork) for (const x of forkAncestors(s.id)) if (copyExposedOwnIds.has(x)) s.prefixExposed = true;
    if (s.prefixExposed) s.integrity = true;
    s.supported = policy === "all" ? true : s.versions.length > 0 && s.versions.every((v) => v !== null && CODEX_FULL_VERSIONS.includes(v)); // R15.7
    s.kind = codexKind(s.meta);
    s.modelsOfCtx = new Set(s.ctxs.map((x) => x.model));
    s.ctxByTurn = new Map();
    for (const x of s.ctxs) {
      if (x.turnId === null) continue;
      let l = s.ctxByTurn.get(x.turnId);
      if (!l) s.ctxByTurn.set(x.turnId, (l = []));
      l.push(x);
    }
    if (s.integrity) scov.streams_integrity_unverified += 1;
    if (!s.ordinalVerified) scov.streams_ordinal_unverified += 1;
    if (s.isFork && !s.prefixResolved) scov.streams_fork_prefix_unresolved += 1;
    if (s.prefixExposed) scov.streams_prefix_exposed += 1;
  }
  // A thread id with own session_meta but no assigned file still has a version for tur accounting.
  const versionOfThread = (id) => {
    const s = streams.get(id);
    if (s) return s.supported;
    if (policy === "all") return true;
    const metas = ownMetasById.get(id) ?? [];
    return metas.length > 0 && metas.every((m) => m.cliVersion !== null && CODEX_FULL_VERSIONS.includes(m.cliVersion));
  };

  // R2.10 / R2.17 model attribution for one usage record.
  const attribute = (t) => {
    const s = t.threadId === null ? undefined : streams.get(t.threadId);
    if (!s) return { source: "none", verified: false, model: null };
    // R2.10: an integrity_unverified stream verifies no model through any row. prefix_exposed keeps its own name.
    if (s.prefixExposed) return { source: "prefix_exposed", verified: false, model: null };
    if (s.integrity) return { source: "stream_unverified", verified: false, model: null };
    const own = t.turnId === null ? [] : (s.ctxByTurn.get(t.turnId) ?? []);
    if (own.length > 0) {
      const models = new Set(own.map((x) => x.model));
      if (models.size > 1) return { source: "own_turn_unsettled", verified: false, model: null, why: "two_models_in_turn" };
      const model = [...models][0];
      if (s.markers.length > 0) {
        const posOk = s.ordinalVerified && !s.integrity && t.ord !== null;
        if (!posOk) return { source: "own_turn_unsettled", verified: false, model, why: "marker_position_unknown" };
        const earliest = Math.min(...own.map((x) => x.ord));
        const lo = Math.min(earliest, t.ord);
        const hi = Math.max(earliest, t.ord);
        if (s.markers.some((m) => m.ord !== null && m.ord > lo && m.ord < hi)) return { source: "own_turn_unsettled", verified: false, model, why: "marker_between" };
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
      !s.integrity &&
      s.prefixResolved &&
      t.ord !== null &&
      best.ord !== null &&
      (!s.isFork || best.ord >= s.histStart) &&
      s.markers.length === 0 && // R2.17 (b): no settings marker anywhere in the stream
      s.modelsOfCtx.size === 1; // R2.17 (b): one model over all certain contexts
    return ok ? { source: "carried_verified", verified: true, model: best.model } : { source: "carried_unverified", verified: false, model: best.model };
  };

  // Usage records, grouped by response_id (R4.4).
  const groups = new Map();
  const unverifiedKeys = new Set();
  const ccov = (cov.codex_responses = {
    requests_total: 0,
    requests_conflict: 0,
    requests_conflict_by_kind: {},
    records_unkeyed: 0,
    records_no_thread_id: 0,
    requests_unverified_version: 0,
    responses_usage_range_failed: 0,
    responses_usage_incomplete: 0,
    responses_usage_invariant_failed: 0,
    tokens_in_incomplete_by_field: {},
    tokens_in_invalid_responses: "0",
    responses_model_unverified: 0,
    model_source_counts: {},
    own_turn_unsettled_by_reason: {},
    baseline_requests_loaded: 0,
    requests_no_event_time: 0,
  });
  const unkeyedSeen = new Set();
  for (const fd of files) {
    for (const t of fd.turs) {
      if (t.responseId === null) {
        if (!unkeyedSeen.has(t.proj)) {
          unkeyedSeen.add(t.proj);
          ccov.records_unkeyed += 1; // R2.13
        }
        continue;
      }
      if (t.threadId === null) {
        ccov.records_no_thread_id += 1;
        continue;
      }
      if (!versionOfThread(t.threadId)) {
        unverifiedKeys.add(t.responseId);
        continue;
      }
      let g = groups.get(t.responseId);
      if (!g) groups.set(t.responseId, (g = []));
      g.push({ t, attr: attribute(t) });
    }
  }
  ccov.requests_unverified_version = unverifiedKeys.size;

  const out = [];
  let invalidTokens = 0n;
  for (const key of [...groups.keys()].sort()) {
    const occ = groups.get(key);
    const first = occ[0];
    const allEqual = occ.every((o) => o.t.proj === first.t.proj && o.attr.verified === first.attr.verified && (!o.attr.verified || o.attr.model === first.attr.model));
    const tMs = first.t.tsMs;
    const inWindow = windowHas(window, tMs);
    if (!allEqual) {
      const usageEqual = occ.every((o) => o.t.usageKey === first.t.usageKey);
      const kind = usageEqual ? "conflict_attribution" : "conflict_usage";
      if (inWindow) {
        ccov.requests_total += 1;
        ccov.requests_conflict += 1;
        bump(ccov.requests_conflict_by_kind, kind);
      }
      out.push({ provider: "codex", key, status: `excluded:${kind}`, counted: false });
      continue;
    }
    const { t, attr } = first;
    const s = streams.get(t.threadId);
    if (!inWindow) {
      if (windowActive(window) && tMs !== null) ccov.baseline_requests_loaded += 1;
      else if (windowActive(window)) ccov.requests_no_event_time += 1;
      continue;
    }
    ccov.requests_total += 1;
    const vals = { in: t.in, c: t.c, cw: t.cw, out: t.out, rs: t.rs, total: t.total };
    if (Object.values(vals).includes(RANGE)) {
      ccov.responses_usage_range_failed += 1; // R2.15
      out.push({ provider: "codex", key, status: "excluded:usage_range_failed", counted: false });
      continue;
    }
    if (Object.values(vals).includes(MISSING)) {
      ccov.responses_usage_incomplete += 1; // R2.12
      for (const [f, v] of Object.entries(vals)) {
        if (v >= 0) ccov.tokens_in_incomplete_by_field[f] = (BigInt(ccov.tokens_in_incomplete_by_field[f] ?? 0) + BigInt(v)).toString();
      }
      out.push({ provider: "codex", key, status: "excluded:usage_incomplete", counted: false });
      continue;
    }
    const inn = BigInt(t.in);
    const cc = BigInt(t.c);
    const cw = BigInt(t.cw);
    const outT = BigInt(t.out);
    const rs = BigInt(t.rs);
    if (cc + cw > inn || rs > outT || BigInt(t.total) !== inn + outT) {
      ccov.responses_usage_invariant_failed += 1; // R2.7
      invalidTokens += inn + outT;
      out.push({ provider: "codex", key, status: "excluded:usage_invariant_failed", counted: false });
      continue;
    }
    bump(ccov.model_source_counts, attr.source);
    if (attr.why) bump(ccov.own_turn_unsettled_by_reason, attr.why);
    if (!attr.verified) ccov.responses_model_unverified += 1;
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
    const price = priceCodex(attr, buckets, inn, book_ref.book, opts.codexTierForTest === "standard");
    out.push({
      provider: "codex",
      key,
      kind: s ? s.kind : "unclassified",
      model: attr.verified ? attr.model : null,
      model_source: attr.source,
      flags: [],
      buckets,
      event_ms: tMs,
      price,
      counted: true,
      status: "counted",
    });
  }
  ccov.tokens_in_invalid_responses = invalidTokens.toString();
  return out;
}

/** R3.6, R3.10: price one Codex response. */
function priceCodex(attr, b, inn, book, tierVerified) {
  const tot = inn + b.output;
  if (!attr.verified) return unpriced("model_unknown", tot); // R2.10
  const entry = usableEntry(book, attr.model);
  if (!entry || codexRow(entry.prices_usd_per_mtok) === null) return unpriced("unknown_model", tot); // R3.3
  // R3.4 tier gate: no retained field shows the Codex service tier, so a default run prices nothing. The gate
  // is evaluated before R3.10 (reason modifier_unverified, never long_context_scope).
  if (!tierVerified) return unpriced("modifier_unverified", tot);
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
  if (inn > C25) {
    const lcRow = verifiedObj(lc, entry, book.table) ? codexRow(lc.prices_usd_per_mtok) : null;
    if (!lcRow) return unpriced("long_context_unverified", tot);
    row = lcRow;
  }
  if (b.cache_write > 0n && row.cache_write === null) return unpriced("cache_write_price_na", tot); // R3.6
  const cost =
    b.input_uncached * row.input +
    b.cache_read * row.cache_read +
    (b.cache_write > 0n ? b.cache_write * row.cache_write : 0n) +
    b.output * row.output;
  return { priced: true, lo: cost, hi: cost, output_excluded: false, tokens_unpriced: 0n };
}

// ---------------------------------------------------------------------------
// Window (R5.9, R5.10): [since, until) on event time, UTC.
// ---------------------------------------------------------------------------

const book_ref = { book: null };

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

function emptyCov() {
  return {};
}

function run(entries, opts) {
  const policy = opts.versionPolicy === "all" ? "all" : "strict";
  const window = { since: parseBound(opts.since, "since"), until: parseBound(opts.until, "until") };
  const book = loadBook(loadTableArg(opts.table));
  book_ref.book = book;
  const cov = emptyCov();
  const o = { versionPolicy: policy, codexTierForTest: (opts.codexTierForTest ?? opts.codex_tier_for_test) === "standard" ? "standard" : null };
  const claude = scanClaude(entries, o, cov, window);
  const codex = scanCodex(entries, o, cov, window);

  const responses = [...claude, ...codex];
  const known = new Set();
  for (const id of book.byModel.keys()) known.add(id);
  const modelLabel = (m) => {
    const n = normalizeModel(m);
    return n !== null && MODEL_ID_RE.test(n) && known.has(n) ? n : "unlisted"; // R14.3
  };

  const providers = {};
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
    providers[provider] = {
      totals: serializeAgg(total),
      by_model: sortedObject(byModel, serializeAgg),
      by_kind: sortedObject(byKind, serializeAgg),
      unpriced_by_reason: sortedObject(unpricedReasons, (u) => ({ responses: u.responses, tokens_unpriced: u.tokens_unpriced.toString() })),
    };
  }

  const coverage = {
    claude: { ...cov.claude, ...cov.claude_responses, requests_unverified_version: cov.claude_requests_unverified_version, geo_rounded_responses: cov.geo_rounded_claude },
    codex: { ...cov.codex, ...cov.codex_streams, ...cov.codex_responses },
  };
  return {
    schema: RECOMPUTE_SCHEMA,
    spec: SPEC_ID,
    table_version: book.version,
    version_policy: policy,
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

/** Recompute from directories. opts: claudeDirs, codexDirs, since, until, table (object or path), versionPolicy. */
export function recompute(opts = {}) {
  const cov = {};
  const entries = discoverEntries(opts.claudeDirs ?? [], opts.codexDirs ?? [], cov);
  return run(entries, opts);
}

/** Recompute from in-memory files: [{ path: "projects/...", content }, ...] in builder layout. */
export function recomputeFiles(files, opts = {}) {
  return run(memoryEntries(files), opts);
}

/** JSON-safe form. Per-response rows are included only with perResponse; keys are hashed unless rawKeys. */
export function toJson(result, { perResponse = false, rawKeys = false } = {}) {
  const doc = {
    schema: result.schema,
    spec: result.spec,
    table_version: result.table_version,
    version_policy: result.version_policy,
    window: result.window,
    price_mode: result.price_mode,
    providers: result.providers,
    coverage: result.coverage,
  };
  if (perResponse) {
    doc.responses = result.responses
      .map((r) => {
        const row = { provider: r.provider, id: rawKeys ? r.key : `h_${sha16(`${r.provider}\u0000${r.key}`)}`, status: r.status };
        if (!r.counted) return row;
        row.kind = r.kind;
        row.model = r.model_label;
        if (r.model_source) row.model_source = r.model_source;
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
          row.usd_pico_lo = r.price.lo.toString();
          row.usd_pico_hi = r.price.hi.toString();
          row.output_excluded = r.price.output_excluded;
        } else {
          row.usd_pico_lo = null;
          row.usd_pico_hi = null;
          row.unpriced_reason = r.price.reason;
          row.tokens_unpriced = r.price.tokens_unpriced.toString();
        }
        return row;
      })
      .sort((a, b) => (a.provider + a.id < b.provider + b.id ? -1 : a.provider + a.id > b.provider + b.id ? 1 : 0));
  }
  return doc;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { claudeDirs: [], codexDirs: [], perResponse: false, rawKeys: false };
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
    else if (a === "--version-policy") o.versionPolicy = next();
    else if (a === "--out") o.out = next();
    else if (a === "--per-response") o.perResponse = true;
    else if (a === "--raw-keys") o.rawKeys = true;
    else throw new Error("unknown_argument");
  }
  if (o.versionPolicy !== undefined && o.versionPolicy !== "strict" && o.versionPolicy !== "all") throw new Error("bad_version_policy");
  if (o.claudeDirs.length === 0 && o.codexDirs.length === 0) throw new Error("no_input_dir");
  return o;
}

function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
    const doc = toJson(recompute(o), o);
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
