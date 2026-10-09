// Seeded mutations of a copy of src/pricing/table.json for the table-mutation fuzz suite (spec R3.1, R3.2, R3.11, S8.1,
// S8.5). Pure: (seed) gives the same table and the same notes. Nothing is read except the shipped table.
import { readFileSync } from "node:fs";
import { CLAUDE_MODELS, CODEX_MODELS, Rng } from "./gen.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

const TABLE_PATH = new URL("../../src/pricing/table.json", import.meta.url);

export function shippedTable(): Obj {
  return JSON.parse(readFileSync(TABLE_PATH, "utf8")) as Obj;
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every price row of an entry: [owner object, key of the price row]. */
function priceRows(e: Obj): Array<[Obj, string]> {
  const rows: Array<[Obj, string]> = [];
  if (isObj(e.prices_usd_per_mtok)) rows.push([e, "prices_usd_per_mtok"]);
  if (isObj(e.fast) && isObj(e.fast.prices_usd_per_mtok)) rows.push([e.fast, "prices_usd_per_mtok"]);
  if (isObj(e.long_context) && isObj(e.long_context.prices_usd_per_mtok)) rows.push([e.long_context, "prices_usd_per_mtok"]);
  if (isObj(e.tiers) && isObj(e.tiers.high)) rows.push([e.tiers, "high"]);
  return rows;
}

const BAD_PRICES: readonly unknown[] = ["4.1234567", "04", "00.2", "0.20", "-1", "1e3", ".5", "5.", " 4", "4 ", "", "x", "0", "NaN", "4,5", 4, 0.2, null, true, [], {}];

type Mutation = (t: Obj, r: Rng) => string | null;

/** When set, entry picks prefer the models the generator can produce, so a mutation is more likely to be priced. */
let preferred: ReadonlySet<string> | null = null;

function entries(t: Obj, provider?: string): Obj[] {
  const all = (t.models as Obj[]).filter((e) => isObj(e) && (provider === undefined || e.provider === provider));
  if (preferred === null) return all;
  const pref = all.filter((e) => preferred!.has(String(e.id)));
  return pref.length > 0 ? pref : all;
}

function pickRow(t: Obj, r: Rng, provider?: string): { e: Obj; owner: Obj; key: string; field: string } | null {
  const es = entries(t, provider);
  const e = r.pick(es);
  const rows = priceRows(e);
  if (rows.length === 0) return null;
  const [owner, key] = r.pick(rows);
  const row = owner[key] as Obj;
  const fields = Object.keys(row);
  if (fields.length === 0) return null;
  return { e, owner, key, field: r.pick(fields) };
}

const MUTATIONS: Array<[string, Mutation]> = [
  [
    "entry_prices_scaled",
    (t, r) => {
      const e = r.pick(entries(t));
      const k = r.pick([2, 3, 10]);
      for (const [owner, key] of priceRows(e)) {
        const row = owner[key] as Obj;
        for (const f of Object.keys(row)) row[f] = String(Number((Number(row[f]) * k).toFixed(6)));
      }
      return `${e.id} all prices x${k} (ratios intact)`;
    },
  ],
  [
    "price_bad_string_or_type",
    (t, r) => {
      const p = pickRow(t, r);
      if (!p) return null;
      const v = r.pick(BAD_PRICES);
      (p.owner[p.key] as Obj)[p.field] = v;
      return `${p.e.id}.${p.key}.${p.field} = ${JSON.stringify(v)}`;
    },
  ],
  [
    "price_seven_decimals",
    (t, r) => {
      const p = pickRow(t, r);
      if (!p) return null;
      const cur = String((p.owner[p.key] as Obj)[p.field]);
      const v = `${cur.split(".")[0]}.${String(r.int(1000000, 9999999))}`;
      (p.owner[p.key] as Obj)[p.field] = v;
      return `${p.e.id}.${p.key}.${p.field} = ${v}`;
    },
  ],
  [
    "price_leading_zero",
    (t, r) => {
      const p = pickRow(t, r);
      if (!p) return null;
      const v = r.pick(["0", "00"]) + String((p.owner[p.key] as Obj)[p.field]);
      (p.owner[p.key] as Obj)[p.field] = v;
      return `${p.e.id}.${p.key}.${p.field} = ${v}`;
    },
  ],
  [
    "price_number_type",
    (t, r) => {
      const p = pickRow(t, r);
      if (!p) return null;
      (p.owner[p.key] as Obj)[p.field] = Number((p.owner[p.key] as Obj)[p.field]);
      return `${p.e.id}.${p.key}.${p.field} as a number`;
    },
  ],
  [
    "price_ratio_break",
    (t, r) => {
      const p = pickRow(t, r);
      if (!p) return null;
      const cur = Number((p.owner[p.key] as Obj)[p.field]);
      (p.owner[p.key] as Obj)[p.field] = String(cur + 0.01);
      return `${p.e.id}.${p.key}.${p.field} + 0.01 (R3.2 ratio)`;
    },
  ],
  [
    "price_field_removed",
    (t, r) => {
      const p = pickRow(t, r);
      if (!p) return null;
      delete (p.owner[p.key] as Obj)[p.field];
      return `${p.e.id}.${p.key}.${p.field} removed`;
    },
  ],
  [
    "unverified_entry_malformed_row",
    (t, r) => {
      const es = entries(t);
      const e = r.pick(es);
      e.verified = false;
      e.prices_usd_per_mtok = r.pick<unknown>([{ input: "x" }, null, {}, { input: 4 }, "x", { input: "4.12345678" }]);
      return `${e.id} unverified with malformed prices`;
    },
  ],
  [
    "anthropic_long_context_malformed",
    (t, r) => {
      const e = r.pick(entries(t, "anthropic"));
      e.long_context = r.pick<unknown>([{ surcharge: "none", prices_usd_per_mtok: { input: "x" }, verified: true }, { prices_usd_per_mtok: { input: 4 } }, "x", 5, [], { surcharge: "none", verified: "true" }, { prices_usd_per_mtok: { input: "8" }, verified: true, scope: "request", scope_verified: true }]);
      return `${e.id}.long_context malformed`;
    },
  ],
  [
    "verified_as_string",
    (t, r) => {
      const where = r.int(0, 3);
      const e = r.pick(entries(t));
      const v = r.pick<unknown>(["true", 1, "yes", "false", null, 0]);
      if (where === 0) e.verified = v;
      else if (where === 1 && isObj(e.fast)) e.fast.verified = v;
      else if (where === 2 && isObj(e.geo_us)) e.geo_us.verified = v;
      else if (isObj(e.long_context)) e.long_context.verified = v;
      else e.verified = v;
      return `${e.id} verified flag = ${JSON.stringify(v)} (slot ${where})`;
    },
  ],
  [
    "missing_dates",
    (t, r) => {
      const where = r.int(0, 3);
      const e = r.pick(entries(t));
      if (where === 0) delete t.verified_at;
      else if (where === 1) delete e.verified_at;
      else if (where === 2) e.verified_at = r.pick<unknown>(["", "today", "2026-13-45", 20261009, "2026-10-09T00:00:00Z", "26-10-09"]);
      else {
        delete t.verified_at;
        delete e.verified_at;
      }
      return `${e.id} dates (slot ${where})`;
    },
  ],
  [
    "duplicate_normalized_ids",
    (t, r) => {
      const es = entries(t);
      const a = r.pick(es);
      const b = r.pick(es);
      const suffix = r.pick(["", "-20251001", "-20260101"]);
      a.model_ids = [...(a.model_ids ?? []), `${(b.model_ids ?? [b.id])[0]}${suffix}`];
      return `${a.id}.model_ids gets ${(b.model_ids ?? [b.id])[0]}${suffix}`;
    },
  ],
  [
    "wrong_provider",
    (t, r) => {
      const e = r.pick(entries(t));
      e.provider = r.pick<unknown>(["openai", "anthropic", "x", null, 5]);
      return `${e.id}.provider = ${JSON.stringify(e.provider)}`;
    },
  ],
  [
    "geo_fast_flags",
    (t, r) => {
      const which = r.int(0, 6);
      const e = r.pick(entries(t, "anthropic"));
      if (which === 0) t.modifiers.geo_us.verified = false;
      else if (which === 1) t.modifiers.fast_with_geo_us.verified = r.pick<unknown>([false, "true", undefined]);
      else if (which === 2 && isObj(e.geo_us)) e.geo_us.applies = r.pick<unknown>([false, "true", 1]);
      else if (which === 3 && isObj(e.fast)) e.fast.geo_us_applies = r.pick<unknown>([false, "true", undefined]);
      else if (which === 4) e.geo_us = null;
      else if (which === 5 && isObj(e.fast)) e.fast.verified = r.pick<unknown>([false, "true"]);
      else e.fast = null;
      return `${e.id} geo/fast flag (case ${which})`;
    },
  ],
  [
    "openai_scope_flags",
    (t, r) => {
      const e = r.pick(entries(t, "openai"));
      if (!isObj(e.long_context)) return null;
      const which = r.int(0, 3);
      if (which === 0) e.long_context.scope = r.pick<unknown>(["session", "unknown", "x", null]);
      else if (which === 1) e.long_context.scope_verified = r.pick<unknown>([false, "true"]);
      else if (which === 2) delete e.long_context.scope_source_id;
      else e.long_context.threshold_input_tokens = r.pick<unknown>([1, 272001, "272000", null]);
      return `${e.id}.long_context scope case ${which}`;
    },
  ],
];

export const MUTATION_NAMES = MUTATIONS.map(([n]) => n);

/** The shipped table with 0 to 3 seeded mutations (one seed in ten has none: a control that must agree). */
export function mutateTable(seed: number): { table: Obj; notes: string[] } {
  const r = new Rng(((seed + 31) * 2246822519) >>> 0 || 1);
  const t = shippedTable();
  const notes: string[] = [];
  const n = r.chance(0.1) ? 0 : r.int(1, 3);
  preferred = r.chance(0.7) ? new Set<string>([...CLAUDE_MODELS, ...CODEX_MODELS]) : null;
  for (let i = 0; i < n; i++) {
    const [name, fn] = r.pick(MUTATIONS);
    const sub = r.sub();
    try {
      const note = fn(t, sub);
      if (note !== null) notes.push(`${name}: ${note}`);
    } catch {
      // a mutation that does not fit the table as mutated so far is skipped
    }
  }
  preferred = null;
  return { table: t, notes };
}

/** The shipped table with exactly one named mutation (for triage and reproducers). */
export function mutateOnly(seed: number, name: string): { table: Obj; notes: string[] } {
  const r = new Rng(((seed + 77) * 2246822519) >>> 0 || 1);
  const t = shippedTable();
  preferred = null;
  const m = MUTATIONS.find(([n]) => n === name);
  const notes: string[] = [];
  if (m) {
    try {
      const note = m[1](t, r);
      if (note !== null) notes.push(`${name}: ${note}`);
    } catch {
      // does not fit
    }
  }
  return { table: t, notes };
}
