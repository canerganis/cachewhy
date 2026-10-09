// Pricing (spec section 3, R3.1 to R3.11; binding spec: docs/methodology.md).
//
// Two entry points:
//   loadPriceBook(table)        validates a PricingTable and prepares integer price units (R3.8)
//   priceResponse(response, b)  prices one response from that response alone (R3.10: no neighbour matters)
//
// Arithmetic (R2.16, R3.8): prices are parsed from decimal strings into integers in units of 1e-6 USD
// per MTok, cost is `tokens * price_units` as BigInt in units of 1e-12 USD (picodollars). The geo
// multiplier C32 is applied once to the sum. No floating point number touches a token or a price.
//
// Treatment of unverified data (R3.1, R3.11): an object with `verified: false`, or with `verified: true`
// but no effective `verified_at`, is treated as absent and produces no dollars.

import tableJson from "./table.json" with { type: "json" };
import {
  CONSTANTS,
  contextTokens,
  pricedAmount,
  responseTokens,
  type LoadPriceBook,
  type LongContextPrice,
  type ModelPrice,
  type PriceBook,
  type PriceResponse,
  type PriceRow,
  type PriceRowKind,
  type PricedResponse,
  type PricingTable,
  type Rational,
  type ResolvedRates,
  type Response,
  type ServiceTier,
  type TableLongContext,
  type TableModelEntry,
  type TablePriceRow,
  type TableProvider,
  type TableVerifiable,
  type UnpricedModifierReason,
  type UnpricedReason,
  type UsageBuckets,
} from "../model/types.js";

// ---------------------------------------------------------------------------
// Decimal parsing (R3.8). Strings only, BigInt only.
// ---------------------------------------------------------------------------

const DECIMAL = /^([0-9]+)(?:\.([0-9]+))?$/;
const PRICE_SCALE = 1_000_000n; // price units are 1e-6 USD per MTok

/** Exact rational of a non-negative decimal string, or null when it is not one. */
export function parseDecimal(s: unknown): Rational | null {
  if (typeof s !== "string") return null;
  const m = DECIMAL.exec(s);
  if (m === null) return null;
  const frac = m[2] ?? "";
  return { num: BigInt((m[1] ?? "") + frac), den: 10n ** BigInt(frac.length) };
}

/** Price string to integer units of 1e-6 USD per MTok. Null when malformed or finer than 1e-6 (R3.8). */
export function parsePriceUnits(s: unknown): bigint | null {
  const r = parseDecimal(s);
  if (r === null || PRICE_SCALE % r.den !== 0n) return null;
  return r.num * (PRICE_SCALE / r.den);
}

/** R3.3. A trailing `-YYYYMMDD` is stripped. Matching is exact string equality afterwards. */
export function normalizeModelId(id: string): string {
  return id.replace(/-[0-9]{8}$/, "");
}

// ---------------------------------------------------------------------------
// Audit findings (R3.2, R3.11, schema)
// ---------------------------------------------------------------------------

export const TABLE_FINDING_CODES = [
  "schema", // malformed table, fatal
  "ratio", // R3.2 test (1), fatal
  "documented_multiplier", // R3.2 test (2), fatal
  "constant_mismatch", // table copy of a spec constant (C25, C26, C32) differs, fatal
  "r311_effective_date", // verified: true without an effective verified_at; treated as false at runtime
  "r311_scope", // scope_verified: true without date or source id; treated as false at runtime
] as const;
export type TableFindingCode = (typeof TABLE_FINDING_CODES)[number];

export interface TableFinding {
  readonly code: TableFindingCode;
  /** Location inside the table, for example `models[3].fast`. */
  readonly path: string;
  readonly fatal: boolean;
  readonly detail: string;
}

const FATAL: ReadonlySet<TableFindingCode> = new Set<TableFindingCode>([
  "schema",
  "ratio",
  "documented_multiplier",
  "constant_mismatch",
]);

const TABLE_VERSION = /^pt-[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]+)?$/;
const DATE_LIKE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}/;

class Collector {
  readonly findings: TableFinding[] = [];
  add(code: TableFindingCode, path: string, detail: string): void {
    this.findings.push({ code, path, fatal: FATAL.has(code), detail });
  }
}

// ---------------------------------------------------------------------------
// R3.11: effective verification
// ---------------------------------------------------------------------------

interface Ctx {
  readonly table: PricingTable;
  readonly c: Collector;
}

function effectiveDate(obj: TableVerifiable, entry: TableVerifiable | null, table: PricingTable): string | null {
  const d = obj.verified_at ?? entry?.verified_at ?? table.verified_at;
  return typeof d === "string" && DATE_LIKE.test(d) ? d : null;
}

/** `verified: true` AND an effective date (own, entry, table). Anything else is `false` at runtime (R3.11). */
function isVerified(obj: TableVerifiable | null | undefined, entry: TableVerifiable | null, ctx: Ctx): boolean {
  if (obj === null || obj === undefined || obj.verified !== true) return false;
  return effectiveDate(obj, entry, ctx.table) !== null;
}

function auditVerified(
  obj: TableVerifiable | null | undefined,
  entry: TableVerifiable | null,
  path: string,
  ctx: Ctx,
): void {
  if (obj === null || obj === undefined || typeof obj !== "object") return;
  if (obj.verified === true && effectiveDate(obj, entry, ctx.table) === null) {
    ctx.c.add("r311_effective_date", path, "verified: true without an effective verified_at; treated as false");
  }
}

/** R3.10, R3.11. A scope is `request` or `session` only if scope_verified, an effective date and a source id of the table. */
function effectiveScope(
  lc: TableLongContext,
  entry: TableVerifiable,
  path: string | null,
  ctx: Ctx,
): "request" | "session" | "unknown" {
  const declared = lc.scope;
  if (declared !== "request" && declared !== "session") return "unknown";
  if (lc.scope_verified !== true) return "unknown";
  const dateOk = effectiveDate(lc, entry, ctx.table) !== null;
  const sid = lc.scope_source_id;
  const sourceOk = typeof sid === "string" && Object.prototype.hasOwnProperty.call(ctx.table.sources ?? {}, sid);
  if (!dateOk || !sourceOk) {
    if (path !== null) {
      ctx.c.add("r311_scope", path, "scope_verified: true needs an effective verified_at and a scope_source_id of the table; treated as false");
    }
    return "unknown";
  }
  return declared;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const EMPTY_ROW: PriceRow = {
  input: null,
  output: null,
  cache_read: null,
  cache_write_5m: null,
  cache_write_1h: null,
  cache_write: null,
};

interface RowParse {
  readonly row: PriceRow | null;
  readonly error: string | null;
}

/**
 * Parse a table price row into integer units. Anthropic needs all five prices. OpenAI needs input,
 * cached input and output; `cache_write` MAY be null (`n/a`, R3.6). A missing row is `{null, null}`.
 */
function parseRow(provider: TableProvider, p: TablePriceRow | null | undefined): RowParse {
  if (p === null || p === undefined) return { row: null, error: null };
  const get = (v: unknown, name: string, required: boolean): bigint | null | "bad" => {
    if (v === null || v === undefined) return required ? "bad" : null;
    const u = parsePriceUnits(v);
    return u === null ? "bad" : u;
  };
  const input = get(p.input, "input", true);
  const output = get(p.output, "output", true);
  if (provider === "anthropic") {
    const cr = get(p.cache_read, "cache_read", true);
    const w5 = get(p.cache_write_5m, "cache_write_5m", true);
    const w1 = get(p.cache_write_1h, "cache_write_1h", true);
    if (input === "bad" || output === "bad" || cr === "bad" || w5 === "bad" || w1 === "bad") {
      return { row: null, error: "anthropic row needs input, output, cache_read, cache_write_5m, cache_write_1h as decimal strings with at most 6 decimals" };
    }
    return { row: { input, output, cache_read: cr, cache_write_5m: w5, cache_write_1h: w1, cache_write: null }, error: null };
  }
  const ci = get(p.cached_input, "cached_input", true);
  const cw = get(p.cache_write, "cache_write", false);
  if (input === "bad" || output === "bad" || ci === "bad" || cw === "bad") {
    return { row: null, error: "openai row needs input, cached_input, output (and cache_write or null) as decimal strings with at most 6 decimals" };
  }
  return { row: { input, output, cache_read: ci, cache_write_5m: null, cache_write_1h: null, cache_write: cw }, error: null };
}

// ---------------------------------------------------------------------------
// R3.2 tests
// ---------------------------------------------------------------------------

const MULT_FIELDS: readonly (readonly [string, keyof PriceRow])[] = [
  ["cache_read", "cache_read"],
  ["cached_input", "cache_read"],
  ["cache_write_5m", "cache_write_5m"],
  ["cache_write_1h", "cache_write_1h"],
  ["cache_write", "cache_write"],
];

/** R3.2 test (1): each cache price of a row equals the input price of the same row times the stored multiplier. */
function ratioTest(
  multipliers: Readonly<Record<string, string | null>> | null | undefined,
  row: PriceRow,
  path: string,
  ctx: Ctx,
): void {
  if (multipliers === null || multipliers === undefined) return;
  if (row.input === null) return;
  for (const [mk, field] of MULT_FIELDS) {
    const raw = multipliers[mk];
    if (raw === null || raw === undefined) continue;
    const m = parseDecimal(raw);
    if (m === null) {
      ctx.c.add("schema", `${path}.multipliers.${mk}`, "multiplier is not a decimal string");
      continue;
    }
    const price = row[field];
    if (price === null) {
      ctx.c.add("ratio", `${path}.${field}`, "multiplier is stored but the row has no such price");
      continue;
    }
    if (price * m.den !== row.input * m.num) {
      ctx.c.add("ratio", `${path}.${field}`, "cache price is not input price times the stored multiplier");
    }
  }
}

/**
 * R3.2: a multiplier object a row stores beside itself (`fast.multipliers`, `tiers.high_multipliers`) must equal the
 * object of its entry: the same keys and, key by key, the same decimal value.
 */
function sameMultipliers(
  a: Readonly<Record<string, string | null>> | null | undefined,
  b: Readonly<Record<string, string | null>> | null | undefined,
): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  for (const k of ka) {
    const x = a[k];
    const y = b[k];
    if (x === null || y === null) {
      if (x !== y) return false;
      continue;
    }
    const dx = parseDecimal(x);
    const dy = parseDecimal(y);
    if (dx === null || dy === null || dx.num * dy.den !== dy.num * dx.den) return false;
  }
  return true;
}

function rational(num: number, den: number): Rational {
  return { num: BigInt(num), den: BigInt(den) };
}

/** R3.2 test (2) data: the documented multipliers of a table entry id, or null when none are documented. */
export function documentedMultipliers(provider: TableProvider, id: string): Readonly<Record<string, Rational>> | null {
  if (provider === "anthropic") {
    let read = rational(1, 10);
    if (id === "claude-fable-5-1" || id === "claude-mythos-5-1") read = rational(1, 40);
    else if (id === "claude-opus-5-5" || id === "claude-sonnet-5-5") read = rational(1, 20);
    return { cache_read: read, cache_write_5m: rational(5, 4), cache_write_1h: rational(2, 1) };
  }
  const m = /^gpt-([0-9]+)(?:\.([0-9]+))?(?:-|$)/.exec(id);
  if (m === null) return null;
  const major = Number.parseInt(m[1] ?? "0", 10);
  const minor = Number.parseInt(m[2] ?? "0", 10);
  const laterThan56 = major > 5 || (major === 5 && minor >= 6);
  if (!laterThan56) return null;
  return { cached_input: id === "gpt-6.1-sol" ? rational(1, 20) : rational(1, 10), cache_write: rational(5, 4) };
}

function documentedTest(entry: TableModelEntry, path: string, ctx: Ctx): void {
  const doc = documentedMultipliers(entry.provider, entry.id);
  if (doc === null) return;
  const stored = entry.multipliers ?? null;
  for (const [k, want] of Object.entries(doc)) {
    const raw = stored === null ? undefined : stored[k];
    const have = parseDecimal(raw);
    if (have === null || have.num * want.den !== want.num * have.den) {
      ctx.c.add("documented_multiplier", `${path}.multipliers.${k}`, "stored multiplier differs from the documented list (R3.2)");
    }
  }
}

// ---------------------------------------------------------------------------
// loadPriceBook
// ---------------------------------------------------------------------------

const SERVICE_TIER_KEYS = ["priority", "batch"] as const;

function buildBook(table: PricingTable): { book: PriceBook; findings: readonly TableFinding[] } {
  const c = new Collector();
  const ctx: Ctx = { table, c };
  const models = new Map<string, ModelPrice>();

  if (typeof table !== "object" || table === null) {
    c.add("schema", "$", "table is not an object");
    return { book: { table_version: "", models, fast_with_geo_us_verified: false }, findings: c.findings };
  }
  if (typeof table.table_version !== "string" || !TABLE_VERSION.test(table.table_version)) {
    c.add("schema", "table_version", "table_version must match ^pt-YYYY-MM-DD(.N)?$");
  }
  if (typeof table.schema_version !== "number") c.add("schema", "schema_version", "schema_version must be a number");
  if (!Array.isArray(table.models)) {
    c.add("schema", "models", "models must be an array");
    return { book: { table_version: String(table.table_version), models, fast_with_geo_us_verified: false }, findings: c.findings };
  }

  // Table level modifiers.
  const modifiers = table.modifiers ?? {};
  const fastGeo = modifiers["fast_with_geo_us"];
  auditVerified(fastGeo, null, "modifiers.fast_with_geo_us", ctx);
  for (const [k, v] of Object.entries(modifiers)) {
    if (k !== "fast_with_geo_us") auditVerified(v, null, `modifiers.${k}`, ctx);
  }
  const geoMod = modifiers["geo_us"];
  if (geoMod !== undefined && geoMod["multiplier"] !== undefined && geoMod["multiplier"] !== null) {
    checkGeoMultiplier(geoMod["multiplier"], "modifiers.geo_us.multiplier", ctx);
  }
  const fastWithGeoVerified = isVerified(fastGeo, null, ctx);

  table.models.forEach((entry, idx) => {
    const path = `models[${idx}]`;
    if (typeof entry !== "object" || entry === null || typeof entry.id !== "string") {
      c.add("schema", path, "entry must be an object with a string id");
      return;
    }
    if (entry.provider !== "anthropic" && entry.provider !== "openai") {
      c.add("schema", `${path}.provider`, "provider must be anthropic or openai");
      return;
    }
    const provider = entry.provider;
    auditVerified(entry, null, path, ctx);
    const entryVerified = isVerified(entry, null, ctx);

    // Minimum cacheable length M (R7.2). Kept for unverified entries too: the R7.2 list includes Mythos 5.
    let minCacheable: bigint | null = null;
    const mc = entry.min_cacheable_tokens;
    if (mc !== null && mc !== undefined) {
      if (Number.isSafeInteger(mc) && mc >= 0) minCacheable = BigInt(mc);
      else c.add("schema", `${path}.min_cacheable_tokens`, "must be a non-negative integer or null");
    }

    // Standard row.
    const rawPrices = (entry.prices_usd_per_mtok ?? null) as TablePriceRow | null;
    const std = parseRow(provider, rawPrices);
    if (std.error !== null && entryVerified) c.add("schema", `${path}.prices_usd_per_mtok`, std.error);
    if (std.row === null && entryVerified) {
      c.add("schema", `${path}.prices_usd_per_mtok`, "a verified entry needs a standard price row");
    }
    if (std.row !== null) {
      ratioTest(entry.multipliers, std.row, `${path}.prices_usd_per_mtok`, ctx);
      documentedTest(entry, path, ctx);
    }

    // Fast row (every fast row is ratio tested, R3.2).
    let fast: PriceRow | null = null;
    if (entry.fast !== null && entry.fast !== undefined) {
      auditVerified(entry.fast, entry, `${path}.fast`, ctx);
      const f = parseRow(provider, entry.fast.prices_usd_per_mtok);
      // R3.2: the effective multipliers of a fast row are the ones stored beside it, else the entry's.
      const fastMult = entry.fast.multipliers ?? entry.multipliers;
      if (entry.fast.multipliers !== undefined && entry.fast.multipliers !== null && !sameMultipliers(entry.fast.multipliers, entry.multipliers)) {
        c.add("schema", `${path}.fast.multipliers`, "the stored fast multipliers differ from the multipliers of the entry (R3.2)");
      }
      if (f.row !== null) ratioTest(fastMult, f.row, `${path}.fast`, ctx);
      if (isVerified(entry.fast, entry, ctx)) {
        if (f.row === null) c.add("schema", `${path}.fast`, f.error ?? "verified fast object without prices");
        else fast = f.row;
      }
    }

    // Haiku style tiers (R3.4, C26).
    let tierHigh: PriceRow | null = null;
    let tierSplit: bigint | null = null;
    if (entry.tiers !== null && entry.tiers !== undefined) {
      auditVerified(entry.tiers, entry, `${path}.tiers`, ctx);
      if (!Number.isSafeInteger(entry.tiers.split_tokens) || BigInt(entry.tiers.split_tokens) !== CONSTANTS.HAIKU_TIER_SPLIT) {
        c.add("constant_mismatch", `${path}.tiers.split_tokens`, "must equal C26 (HAIKU_TIER_SPLIT)");
      }
      tierSplit = CONSTANTS.HAIKU_TIER_SPLIT;
      const t = parseRow(provider, entry.tiers.high);
      const highMult = entry.tiers.high_multipliers ?? entry.multipliers;
      if (
        entry.tiers.high_multipliers !== undefined &&
        entry.tiers.high_multipliers !== null &&
        !sameMultipliers(entry.tiers.high_multipliers, entry.multipliers)
      ) {
        c.add("schema", `${path}.tiers.high_multipliers`, "the stored high tier multipliers differ from the multipliers of the entry (R3.2)");
      }
      if (t.row !== null) ratioTest(highMult, t.row, `${path}.tiers.high`, ctx);
      if (isVerified(entry.tiers, entry, ctx)) {
        if (t.row === null) c.add("schema", `${path}.tiers.high`, t.error ?? "verified tiers object without a high row");
        else tierHigh = t.row;
      }
    }

    // Long context (R3.4 Codex rule, R3.10). Anthropic has no long-context rule: R3.4 defines none.
    let longContext: LongContextPrice | null = null;
    const lc = entry.long_context ?? null;
    if (lc !== null) {
      auditVerified(lc, entry, `${path}.long_context`, ctx);
      const scope = effectiveScope(lc, entry, `${path}.long_context`, ctx);
      if (provider === "openai") {
        if (
          lc.threshold_input_tokens !== undefined &&
          (!Number.isSafeInteger(lc.threshold_input_tokens) || BigInt(lc.threshold_input_tokens) !== CONSTANTS.CODEX_LONG_CTX)
        ) {
          c.add("constant_mismatch", `${path}.long_context.threshold_input_tokens`, "must equal C25 (CODEX_LONG_CTX)");
        }
        const pricesVerified = isVerified(lc, entry, ctx) && lc.prices_usd_per_mtok !== null && lc.prices_usd_per_mtok !== undefined;
        let lcRow: PriceRow | null = null;
        if (lc.prices_usd_per_mtok !== null && lc.prices_usd_per_mtok !== undefined) {
          const l = parseRow(provider, lc.prices_usd_per_mtok);
          // R3.2: a long-context row stores its own multiplier object; an absent one falls back to the entry's.
          if (l.row !== null && lc.verified === true) ratioTest(lc.multipliers ?? entry.multipliers, l.row, `${path}.long_context`, ctx);
          if (pricesVerified) {
            if (l.row === null) c.add("schema", `${path}.long_context`, l.error ?? "verified long_context without prices");
            else lcRow = l.row;
          }
        }
        longContext = { threshold: CONSTANTS.CODEX_LONG_CTX, prices_verified: pricesVerified && lcRow !== null, row: lcRow, scope };
      }
    }

    // Geo (R3.4, C32).
    let geoApplies = false;
    if (entry.geo_us !== null && entry.geo_us !== undefined) {
      auditVerified(entry.geo_us, entry, `${path}.geo_us`, ctx);
      if (entry.geo_us.multiplier !== null && entry.geo_us.multiplier !== undefined) {
        checkGeoMultiplier(entry.geo_us.multiplier, `${path}.geo_us.multiplier`, ctx);
      }
      geoApplies = isVerified(entry.geo_us, entry, ctx) && entry.geo_us.applies === true;
    }

    // Explicit service tier rows (R3.4).
    const serviceRows: Partial<Record<ServiceTier, PriceRow>> = {};
    if (entry.service_tier !== null && entry.service_tier !== undefined) {
      for (const [k, v] of Object.entries(entry.service_tier) as [string, (TableVerifiable & { readonly prices_usd_per_mtok: TablePriceRow }) | null | undefined][]) {
        const sp = `${path}.service_tier.${k}`;
        if (!(SERVICE_TIER_KEYS as readonly string[]).includes(k)) {
          c.add("schema", sp, "service_tier rows exist only for priority and batch");
          continue;
        }
        if (v === undefined || v === null) continue;
        auditVerified(v, entry, sp, ctx);
        const s = parseRow(provider, v.prices_usd_per_mtok);
        if (isVerified(v, entry, ctx)) {
          if (s.row === null) c.add("schema", sp, s.error ?? "verified service_tier row without prices");
          else serviceRows[k as ServiceTier] = s.row;
        }
      }
    }

    const mp: ModelPrice = {
      id: entry.id,
      provider,
      verified: entryVerified && std.row !== null,
      min_cacheable: minCacheable,
      standard: entryVerified && std.row !== null ? std.row : EMPTY_ROW,
      fast: entryVerified ? fast : null,
      tier_high: entryVerified ? tierHigh : null,
      tier_split: tierSplit,
      long_context: longContext,
      geo_us_applies: entryVerified && geoApplies,
      fast_geo_us_applies: entryVerified && fast !== null && entry.fast?.geo_us_applies === true,
      service_tier_rows: entryVerified ? serviceRows : {},
    };

    for (const raw of entry.model_ids ?? []) {
      if (typeof raw !== "string") {
        c.add("schema", `${path}.model_ids`, "model ids must be strings");
        continue;
      }
      const norm = normalizeModelId(raw);
      if (models.has(norm)) {
        c.add("schema", `${path}.model_ids`, "a normalized model id occurs in two entries");
        continue;
      }
      models.set(norm, mp);
    }
  });

  return {
    book: { table_version: String(table.table_version), models, fast_with_geo_us_verified: fastWithGeoVerified },
    findings: c.findings,
  };
}

function checkGeoMultiplier(raw: unknown, path: string, ctx: Ctx): void {
  const m = parseDecimal(raw);
  const g = CONSTANTS.GEO_US_MULT;
  if (m === null || m.num * g.den !== g.num * m.den) {
    ctx.c.add("constant_mismatch", path, "geo multiplier must equal C32 (11/10)");
  }
}

/**
 * Every finding the table audit produces: R3.2 tests (1) and (2), R3.11, and schema checks. Fatal findings
 * make `loadPriceBook` throw. `r311_*` findings are not fatal: the object is treated as unverified at runtime.
 */
export function auditTable(table: PricingTable): readonly TableFinding[] {
  return buildBook(table).findings;
}

export class PriceTableError extends Error {
  readonly findings: readonly TableFinding[];
  constructor(findings: readonly TableFinding[]) {
    super(`invalid pricing table: ${findings.filter((f) => f.fatal).map((f) => `${f.code} at ${f.path}`).join("; ")}`);
    this.name = "PriceTableError";
    this.findings = findings;
  }
}

/** R3.1, R3.2, R3.8, R3.11. Throws `PriceTableError` on a malformed table or a failed R3.2 test. */
export const loadPriceBook: LoadPriceBook = (table) => {
  const { book, findings } = buildBook(table);
  if (findings.some((f) => f.fatal)) throw new PriceTableError(findings);
  return book;
};

/** The table shipped with the tool (`src/pricing/table.json`). */
export const DEFAULT_TABLE: PricingTable = tableJson as unknown as PricingTable;

let defaultBook: PriceBook | null = null;
/** The prepared price book of the shipped table, built once. */
export function loadDefaultPriceBook(): PriceBook {
  defaultBook ??= loadPriceBook(DEFAULT_TABLE);
  return defaultBook;
}

/** Look up a model id (R3.3 normalization, exact match, aliases never used). Null when there is no row at all. */
export function lookupModel(book: PriceBook, modelId: string): ModelPrice | null {
  return book.models.get(normalizeModelId(modelId)) ?? null;
}

// ---------------------------------------------------------------------------
// priceResponse
// ---------------------------------------------------------------------------

/**
 * The tokens of a response that R3.9 counts in `tokens_unpriced` when it is unpriced. This is the single
 * per-response token measure of the model (`responseTokens`): the input side plus the output, or the observed
 * output lower bound when the output is unknown (R2.3). It is the same measure as the headline denominator.
 */
export function billedTokens(u: UsageBuckets): bigint {
  return responseTokens(u);
}

interface Selected {
  readonly kind: PriceRowKind;
  readonly row: PriceRow;
  readonly geo: Rational;
}
interface Refusal {
  readonly modifier: UnpricedModifierReason;
}

const NO_GEO: Rational = { num: 1n, den: 1n };

/** Claude row selection (R3.4, R3.12). A modifier is never guessed and never defaulted. */
function selectClaudeRow(r: Response, mp: ModelPrice, u: UsageBuckets, book: PriceBook): Selected | Refusal {
  const speed = r.modifiers.speed;
  const geo = r.modifiers.inference_geo;
  const tier = r.modifiers.service_tier;

  if (r.flags.includes("conflict_modifier")) return { modifier: "conflict_modifier" }; // R4.2
  // R3.12: all three modifiers are read from a final copy that carries them. Nothing is defaulted: an absent value
  // (or no final copy at all) is unverified, never a standard price and never a range.
  if (r.flags.includes("no_final_copy") || speed === null || geo === null || tier === null) {
    return { modifier: "modifier_unverified" };
  }
  if (speed === "other") return { modifier: "speed_other" };
  if (geo === "other") return { modifier: "geo_other" };

  const geoUs = geo === "us";
  // Haiku 5.5 high tier applies by total_input (R3.4, C26). A tiered model has no combined fast or service tier row.
  const aboveSplit = mp.tier_split !== null && contextTokens(u) > mp.tier_split;

  let kind: PriceRowKind = "standard";
  let row: PriceRow = mp.standard;

  if (tier === "priority" || tier === "batch" || tier === "other") {
    const tr = tier === "other" ? undefined : mp.service_tier_rows[tier];
    if (tr === undefined) return { modifier: "service_tier_unpriced" };
    // The table defines the service tier row alone. A combination with fast or the geo multiplier is not defined: no dollars.
    if (speed === "fast" || geoUs) return { modifier: "service_tier_unpriced" };
    if (aboveSplit) return { modifier: "tier_unverified" };
    kind = "service_tier";
    row = tr;
  } else if (speed === "fast") {
    if (mp.fast === null) return { modifier: "speed_fast_no_row" };
    // R3.4: the geo multiplier applies to a fast row only when the table modifier fast_with_geo_us is verified, the
    // fast row of the model carries geo_us_applies: true and the model's geo_us is verified and applies.
    if (geoUs && !(book.fast_with_geo_us_verified && mp.fast_geo_us_applies && mp.geo_us_applies)) return { modifier: "fast_geo_unverified" };
    if (aboveSplit) return { modifier: "tier_unverified" };
    kind = "fast";
    row = mp.fast;
  } else if (aboveSplit) {
    if (mp.tier_high === null) return { modifier: "tier_unverified" };
    kind = "haiku_high";
    row = mp.tier_high;
  }

  if (geoUs && !mp.geo_us_applies) return { modifier: "geo_other" }; // table does not say the geo multiplier applies
  return { kind, row, geo: geoUs ? CONSTANTS.GEO_US_MULT : NO_GEO };
}

/** Codex row selection (R3.4 Codex long context, R3.10). Decided from the model row and this response's `in` only. */
function selectCodexRow(mp: ModelPrice, u: UsageBuckets): Selected | Refusal {
  const lc = mp.long_context;
  if (lc === null || lc.scope !== "request") return { modifier: "long_context_scope" };
  const inTokens = contextTokens(u); // Codex `in`
  if (inTokens <= CONSTANTS.CODEX_LONG_CTX) return { kind: "standard", row: mp.standard, geo: NO_GEO };
  if (!lc.prices_verified || lc.row === null) return { modifier: "long_context_unverified" };
  return { kind: "long_context", row: lc.row, geo: NO_GEO };
}

/**
 * R3.5, R3.6. `bucket_unknown`: the write price depends on a TTL class the log does not show, so no single number
 * exists and no range is produced. `write_na`: a needed price is `n/a` (cache write). The output term is never omitted:
 * the caller has already refused a response whose output is unknown.
 */
function computeCost(u: UsageBuckets, row: PriceRow, output: bigint): bigint | "bucket_unknown" | "write_na" | "row_incomplete" {
  if (row.input === null || row.output === null || row.cache_read === null) return "row_incomplete";
  if (u.cache_write_unknown_ttl > 0n) return "bucket_unknown";
  let cost = u.input_uncached * row.input + u.cache_read * row.cache_read + output * row.output;
  if (u.cache_write_5m > 0n) {
    if (row.cache_write_5m === null) return "write_na";
    cost += u.cache_write_5m * row.cache_write_5m;
  }
  if (u.cache_write_1h > 0n) {
    if (row.cache_write_1h === null) return "write_na";
    cost += u.cache_write_1h * row.cache_write_1h;
  }
  if (u.cache_write > 0n) {
    if (row.cache_write === null) return "write_na"; // R3.6: cw > 0 and p_write n/a
    cost += u.cache_write * row.cache_write;
  }
  return cost;
}

/** Multiply by `g` and divide by its denominator once, half up (R3.8). Exact for every price of at most 5 decimals. */
function applyGeo(x: bigint, g: Rational): bigint {
  if (g.num === g.den) return x;
  return (2n * x * g.num + g.den) / (2n * g.den);
}

function isRefusal(x: Selected | Refusal): x is Refusal {
  return "modifier" in x;
}

/**
 * R3.1 to R3.12. Prices one response from the response alone (no neighbour, file, session or other response
 * can change the result). Never throws. Gate order, first match wins: excluded, not_owner, chain_tainted (R0.9
 * effect 2), the Codex tier gate (R3.4, before R3.10), model_unknown, unknown_model, then the modifier and row
 * checks (unpriced_modifier).
 */
export const priceResponse: PriceResponse = (response, book, opts): PricedResponse => {
  const u = response.usage;
  const base = {
    provider: response.provider,
    key: response.key,
    chain: response.chain,
    table_version: book.table_version,
  } as const;
  const unpriced = (reason: UnpricedReason, modifier: UnpricedModifierReason | null): PricedResponse => ({
    ...base,
    cost: pricedAmount(null, reason),
    modifier_reason: modifier,
    rates: null,
    tokens_unpriced: u === null ? 0n : responseTokens(u),
  });

  // 1. Excluded: no usable counters, adds nothing.
  if (response.exclusion !== null || u === null) return { ...unpriced("excluded", null), tokens_unpriced: 0n };
  // 2. R4.7: a replayed copy counts zero tokens, zero dollars.
  if (response.ownership.role === "replayed") return { ...unpriced("not_owner", null), tokens_unpriced: 0n };
  // 3. R0.9 effect 2: a response of a tainted chain keeps its buckets, has no verified model and no dollars. No other
  //    reason is reported for it, whatever its modifiers, its model or a conflict flag are.
  if (response.model.source === "chain_tainted") return unpriced("chain_tainted", null);
  // 4. R3.4 tier gate: no retained field shows the Codex service tier, so a default run prices no Codex response,
  //    whatever its model, `in` and scope, before R3.10 is looked at.
  if (response.provider === "codex" && opts?.codex_tier_for_test !== "standard") {
    return unpriced("unpriced_modifier", "modifier_unverified");
  }
  // 5. R2.10: an unverified model yields no dollars and takes part in no other response's pricing.
  const modelId = response.model.verified ? response.model.model : null;
  if (modelId === null) return unpriced("model_unknown", null);

  // 6. R3.3: no row, a row of the other provider, or a verified:false entry is `unknown_model`.
  const mp = lookupModel(book, modelId);
  const wantProvider: TableProvider = response.provider === "claude" ? "anthropic" : "openai";
  if (mp === null || mp.provider !== wantProvider || !mp.verified) return unpriced("unknown_model", null);

  // 7. Modifier and row checks.
  const sel = response.provider === "claude" ? selectClaudeRow(response, mp, u, book) : selectCodexRow(mp, u);
  if (isRefusal(sel)) return unpriced("unpriced_modifier", sel.modifier);
  // R3.5: an unknown output has no priced form, because no partial output term exists. It occurs only without a final
  // copy (R2.3), where the modifiers are already unverified (R3.12); a response that reaches this line with an unknown
  // output is refused the same way.
  if (u.output === null) return unpriced("unpriced_modifier", "modifier_unverified");

  const cost = computeCost(u, sel.row, u.output);
  if (cost === "row_incomplete") return unpriced("unknown_model", null);
  if (cost === "bucket_unknown") return unpriced("unpriced_modifier", "bucket_unknown");
  if (cost === "write_na") return unpriced("unpriced_modifier", "cache_write_price_na");

  const rates: ResolvedRates = {
    row: sel.kind,
    input: sel.row.input ?? 0n,
    output: sel.row.output ?? 0n,
    cache_read: sel.row.cache_read ?? 0n,
    cache_write_5m: sel.row.cache_write_5m,
    cache_write_1h: sel.row.cache_write_1h,
    cache_write: sel.row.cache_write,
    geo: sel.geo,
  };
  return {
    ...base,
    cost: pricedAmount(applyGeo(cost, sel.geo)),
    modifier_reason: null,
    rates,
    tokens_unpriced: 0n,
  };
};
