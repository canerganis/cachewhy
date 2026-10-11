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
    "dated_ids",
    (t, r) => {
      const e = r.pick(entries(t));
      const id = String(e.id);
      const dated = `${id}-${r.pick(["20251001", "20260101", "2025100", "202510011"])}`;
      const where = r.int(0, 2);
      if (where === 0) e.id = dated;
      else if (where === 1) e.model_ids = [dated];
      else {
        e.id = dated;
        e.model_ids = [...(Array.isArray(e.model_ids) ? e.model_ids : []), dated];
      }
      const wrong = r.chance(0.5);
      if (wrong) {
        const p = priceRows(e)[0];
        if (p) {
          const row = p[0][p[1]] as Obj;
          const k = Object.keys(row).find((x) => x.startsWith("cache") || x === "cached_input");
          if (k) row[k] = String(Number(row[k]) + 0.01);
        }
      }
      return `${id} dated ids (slot ${where}), cache price ${wrong ? "wrong" : "correct"}`;
    },
  ],
  [
    "anthropic_long_context_with_prices",
    (t, r) => {
      const e = r.pick(entries(t, "anthropic"));
      const base = isObj(e.prices_usd_per_mtok) ? (structuredClone(e.prices_usd_per_mtok) as Obj) : null;
      if (base === null) return null;
      const broken = r.chance(0.5);
      const k = r.pick([1, 2]);
      for (const f of Object.keys(base)) base[f] = String(Number((Number(base[f]) * k).toFixed(6)));
      if (broken) base.cache_read = String(Number(base.cache_read) + 0.01);
      e.long_context = { surcharge: "none", verified: true, prices_usd_per_mtok: base, ...(r.chance(0.5) ? { multipliers: structuredClone(e.multipliers ?? {}) } : {}) };
      return `${e.id} verified long_context with prices x${k}${broken ? ", ratio broken" : ""}`;
    },
  ],
  [
    "entry_multipliers_absent",
    (t, r) => {
      const e = r.pick(entries(t));
      if (r.chance(0.5)) delete e.multipliers;
      else e.multipliers = undefined;
      return `${e.id} multipliers absent`;
    },
  ],
  [
    "new_openai_ids",
    (t, r) => {
      const src = r.pick(entries(t, "openai"));
      const e = structuredClone(src) as Obj;
      const id = r.pick(["gpt-5.7", "gpt-5.10", "gpt-7", "gpt-5.7-sol", "gpt-5.10-luna", "gpt-7-sol", "gpt-5.9"]);
      e.id = id;
      e.model_ids = [id];
      if (r.chance(0.5) && isObj(e.prices_usd_per_mtok)) {
        // documented multipliers for GPT-5.6 and later: cached input 0.1x, cache write 1.25x
        const p = e.prices_usd_per_mtok as Obj;
        const input = Number(p.input);
        if (Number.isFinite(input)) {
          p.cached_input = String(Number((input * 0.1).toFixed(6)));
          p.cache_write = String(Number((input * 1.25).toFixed(6)));
        }
      }
      (t.models as Obj[]).push(e);
      return `new openai entry ${id} cloned from ${src.id}`;
    },
  ],
  [
    "row_container_not_object",
    (t, r) => {
      const e = r.pick(entries(t));
      const field = r.pick(["tiers", "fast", "long_context", "service_tier", "geo_us"]);
      const v = r.pick<unknown>([5, "x", [], true, 0, ""]);
      e[field] = v;
      return `${e.id}.${field} = ${JSON.stringify(v)}`;
    },
  ],
  [
    "model_ids_shape",
    (t, r) => {
      const e = r.pick(entries(t));
      const v = r.pick<unknown>(["x", 5, {}, null, [5], [null], [e.id, 5], [{}], [], ["", e.id]]);
      e.model_ids = v;
      return `${e.id}.model_ids = ${JSON.stringify(v)}`;
    },
  ],
  [
    "entry_id_own_member",
    (t, r) => {
      const e = r.pick(entries(t));
      const members: unknown[] = Array.isArray(e.model_ids) ? e.model_ids : [];
      const m = String(members[0] ?? e.id);
      const raw = r.chance(0.5);
      e.id = raw ? m : `${m}-20251001`;
      if (!raw) e.model_ids = [m, ...members.slice(1)];
      return `${m}: entry id ${raw ? "raw-equal" : "normalized-equal"} to its own member`;
    },
  ],
  [
    "verified_placeholder_incomplete",
    (t, r) => {
      const e = r.pick(entries(t));
      e.verified = true;
      e.verified_at = r.pick<unknown>(["TBD", "", "pending", "2026", "2026-1-1", null, "unverified"]);
      const p = priceRows(e)[0];
      if (p) {
        const row = p[0][p[1]] as Obj;
        const keys = Object.keys(row);
        if (keys.length > 0) delete row[r.pick(keys)];
      }
      return `${e.id} verified with placeholder date and an incomplete row`;
    },
  ],
  [
    "min_cacheable_tokens_range",
    (t, r) => {
      const e = r.pick(entries(t));
      const v = r.pick<unknown>([9007199254740992, 9007199254740991, -1, 1.5, "512", null, 0]);
      e.min_cacheable_tokens = v;
      return `${e.id}.min_cacheable_tokens = ${JSON.stringify(v)}`;
    },
  ],
  [
    "modifiers_container_not_object",
    (t, r) => {
      const v = r.pick<unknown>([5, [], null, "x", true]);
      t.modifiers = v;
      return `modifiers = ${JSON.stringify(v)}`;
    },
  ],
  [
    "unknown_members_in_rows",
    (t, r) => {
      const where = r.int(0, 2);
      const e = r.pick(entries(t));
      if (where === 0) {
        const p = pickRow(t, r);
        if (!p) return null;
        (p.owner[p.key] as Obj)[r.pick(["extra", "cache_write_30m", "input_batch"])] = r.pick<unknown>(["1", 1, null]);
        return `${p.e.id}.${p.key} gets an unknown member`;
      }
      const rows = isObj(e.prices_usd_per_mtok) ? structuredClone(e.prices_usd_per_mtok) : {};
      e.service_tier = { priority: { prices_usd_per_mtok: rows, verified: true, verified_at: "2026-10-09" } };
      if (where === 2) (e.service_tier.priority.prices_usd_per_mtok as Obj).unknown_member = "2";
      return `${e.id}.service_tier row (${where === 2 ? "with unknown member" : "plain"})`;
    },
  ],
  [
    "long_context_multipliers_not_object",
    (t, r) => {
      const e = r.pick(entries(t));
      if (!isObj(e.long_context)) return null;
      const v = r.pick<unknown>([5, "x", [], null, true]);
      e.long_context.multipliers = v;
      return `${e.id}.long_context.multipliers = ${JSON.stringify(v)}`;
    },
  ],
  [
    "multipliers_empty_or_partial",
    (t, r) => {
      const e = r.pick(entries(t));
      const where = r.int(0, 3);
      const v = r.pick<unknown>([{}, null, "x", [], 5, { cache_read: "0.1" }, { cache_write_5m: "1.25", cache_write_1h: "2" }]);
      if (where === 0) e.multipliers = v;
      else if (where === 1 && isObj(e.fast)) e.fast.multipliers = v;
      else if (where === 2 && isObj(e.long_context)) e.long_context.multipliers = v;
      else if (isObj(e.tiers)) e.tiers.high_multipliers = v;
      else e.multipliers = v;
      return `${e.id} multipliers (slot ${where}) = ${JSON.stringify(v)}`;
    },
  ],
  [
    "modifier_not_an_object",
    (t, r) => {
      const name = r.pick(["geo_us", "fast_with_geo_us", "openai_long_context", "batch", "openai_service_tier", "openai_regional_endpoint"]);
      const v = r.pick<unknown>([5, [], null, "x", true]);
      t.modifiers[name] = v;
      return `modifiers.${name} = ${JSON.stringify(v)}`;
    },
  ],
  [
    "entry_id_duplicates",
    (t, r) => {
      const es = entries(t);
      const a = r.pick(es);
      const b = r.pick(es);
      const suffix = r.pick(["", "-20251001"]);
      const target = r.chance(0.5) ? String(b.id) : String((b.model_ids ?? [b.id])[0]);
      a.id = `${target}${suffix}`;
      return `${a.id} (entry id) now equals ${target}${suffix}`;
    },
  ],
  [
    "table_level_constants",
    (t, r) => {
      const which = r.int(0, 3);
      if (which === 0) t.modifiers.openai_long_context.threshold_input_tokens = r.pick<unknown>([272001, 271999, "272000", null]);
      else if (which === 1) t.modifiers.geo_us.multiplier = r.pick<unknown>(["1.2", "1.10", 1.1, null]);
      else if (which === 2) t.modifiers.geo_us.constant = r.pick<unknown>(["C33", null, 5]);
      else t.modifiers.openai_long_context.constant = r.pick<unknown>(["C24", null]);
      return `table-level constant copy (case ${which})`;
    },
  ],
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
