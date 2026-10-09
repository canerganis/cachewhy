// Pricing tests (spec section 3). All data is synthetic: Response objects are built in memory with
// `synthetic-` ids, and the only real data is the shipped price table.
//
// Money in these tests is picodollars (1e-12 USD, R3.8). 1 USD = 1_000_000_000_000n.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { scenarios } from "../../scripts/gen-fixtures.ts";
import { analyze } from "../../src/analyze.ts";
import { discover } from "../../src/discover.ts";
import { ClaudeProject, writeFiles, type ClaudeRecord, type GeneratedFile } from "../fixtures/builder.ts";
import { allR09Fixtures } from "../fixtures/r09.ts";
import {
  DEFAULT_TABLE,
  PriceTableError,
  auditTable,
  billedTokens,
  documentedMultipliers,
  loadDefaultPriceBook,
  loadPriceBook,
  lookupModel,
  normalizeModelId,
  parseDecimal,
  parsePriceUnits,
  priceResponse,
} from "../../src/pricing/index.ts";
import {
  CONSTANTS,
  responseTokens,
  type ClaudeResponse,
  type CodexResponse,
  type Geo,
  type PriceBook,
  type PricedResponse,
  type PricingTable,
  type ResponseFlag,
  type ServiceTier,
  type Speed,
  type UsageBuckets,
} from "../../src/model/types.ts";

const USD = 1_000_000_000_000n;

// ---------------------------------------------------------------------------
// Synthetic builders
// ---------------------------------------------------------------------------

interface U {
  i?: bigint | number; // Claude i, Codex in - c - cw
  r?: bigint | number; // cache read / cached input
  w5?: bigint | number;
  w1?: bigint | number;
  wu?: bigint | number;
  cw?: bigint | number; // Codex cache write
  o?: bigint | number | null;
  reasoning?: bigint | number | null;
}

function usage(p: U): UsageBuckets {
  const b = (v: bigint | number | undefined): bigint => BigInt(v ?? 0);
  return {
    input_uncached: b(p.i),
    cache_read: b(p.r),
    cache_write_5m: b(p.w5),
    cache_write_1h: b(p.w1),
    cache_write_unknown_ttl: b(p.wu),
    cache_write: b(p.cw),
    output: p.o === null ? null : b(p.o ?? 0),
    output_lower_bound: p.o === null ? 7n : b(p.o ?? 0),
    reasoning: p.reasoning === undefined || p.reasoning === null ? null : BigInt(p.reasoning),
    reasoning_included_in_output: false,
  };
}

let seq = 0;
const time = { event_ms: 1, t_first_ms: 1, t_last_ms: 1, t_asm_ms: null, start_lo_ms: null, start_hi_ms: 1, gap_basis: "none" } as const;

interface ClaudeOpts {
  model?: string | null;
  verified?: boolean;
  usage?: U | null;
  /** Default: a final copy that carries speed standard, geo not_available, tier standard (R3.12). `null` is absent. */
  speed?: Speed | null;
  geo?: Geo | null;
  tier?: ServiceTier | null;
  source?: ClaudeResponse["model"]["source"];
  flags?: ResponseFlag[];
  role?: "owner" | "replayed";
  exclusion?: ClaudeResponse["exclusion"];
}

function claude(o: ClaudeOpts = {}): ClaudeResponse {
  const model = o.model === undefined ? "claude-sonnet-5-5" : o.model;
  const u = o.exclusion ? null : usage(o.usage ?? { i: 1000 });
  return {
    provider: "claude",
    key: `synthetic-req-${++seq}`,
    chain: { provider: "claude", root_session: "synthetic-session", thread: "main" },
    kind: "main",
    version: "2.1.293",
    support: "full",
    model: { candidate: model, verified: o.verified ?? true, source: o.source ?? "claude_explicit", model: (o.verified ?? true) ? model : null },
    usage: u,
    exclusion: o.exclusion ?? null,
    flags: o.flags ?? [],
    modifiers: {
      speed: o.speed === undefined ? "standard" : o.speed,
      inference_geo: o.geo === undefined ? "not_available" : o.geo,
      service_tier: o.tier === undefined ? "standard" : o.tier,
    },
    effort: null,
    time,
    ordinal: null,
    ownership: { role: o.role ?? "owner", ambiguous: false, owner_stream_start_ms: 1 },
    provenance: { files: [0], from_copy_exposed_file: false },
    message_id: "synthetic-msg",
    uuid: null,
    parent_uuid: null,
    is_sidechain: false,
    entrypoint: null,
    per_turn_effort: null,
    advisor_model: null,
    stop_reason: null,
    diag: null,
    copies: 1,
  };
}

interface CodexOpts {
  model?: string | null;
  verified?: boolean;
  source?: CodexResponse["model"]["source"];
  usage?: U | null;
  role?: "owner" | "replayed";
}

function codex(o: CodexOpts = {}): CodexResponse {
  const model = o.model === undefined ? "gpt-6-sol" : o.model;
  return {
    provider: "codex",
    key: `synthetic-resp-${++seq}`,
    chain: { provider: "codex", root_session: "synthetic-session", thread: "synthetic-thread" },
    kind: "main",
    version: "0.160.1",
    support: "full",
    model: { candidate: model, verified: o.verified ?? true, source: o.source ?? "own_turn", model: (o.verified ?? true) ? model : null },
    usage: usage(o.usage ?? { i: 1000 }),
    exclusion: null,
    flags: [],
    modifiers: { speed: null, inference_geo: null, service_tier: null },
    effort: null,
    time,
    ordinal: 1,
    ownership: { role: o.role ?? "owner", ambiguous: false, owner_stream_start_ms: 1 },
    provenance: { files: [0], from_copy_exposed_file: false },
    thread_id: "synthetic-thread",
    session_id: "synthetic-session",
    turn_id: null,
    root_turn_id: null,
    comp_hash: null,
    collaboration_mode: null,
    thread_total: null,
  };
}

// Table variants -------------------------------------------------------------

type Json = Record<string, any>;

function cloneTable(): Json {
  return structuredClone(DEFAULT_TABLE) as unknown as Json;
}

function entryOf(t: Json, id: string): Json {
  const e = (t.models as Json[]).find((m) => m.id === id);
  assert.ok(e, `entry ${id}`);
  return e;
}

/** Give a model a verified request scope (the only way a Codex response gets dollars, R3.10). */
function withScope(t: Json, id: string, scope: "request" | "session", extra: Json = {}): void {
  const e = entryOf(t, id);
  e.long_context = {
    ...(e.long_context ?? { threshold_input_tokens: 272000, prices_usd_per_mtok: null, verified: false, source_ids: ["O1"] }),
    scope,
    scope_verified: true,
    scope_source_id: "O1",
    ...extra,
  };
}

function book(t: Json): PriceBook {
  return loadPriceBook(t as PricingTable);
}

const DEFAULT_BOOK = loadDefaultPriceBook();

/** Codex responses are priced under the test-only tier parameter (R3.4); a default run is covered by its own tests. */
function price(r: ClaudeResponse | CodexResponse, b: PriceBook = DEFAULT_BOOK): PricedResponse {
  return priceResponse(r, b, r.provider === "codex" ? { codex_tier_for_test: "standard" } : undefined);
}

function usdPico(p: PricedResponse): bigint {
  assert.notEqual(p.cost.pico, null, `expected a price, got reason ${p.cost.reason} / ${p.modifier_reason}`);
  return p.cost.pico as bigint;
}

function assertUnpriced(p: PricedResponse, reason: string, modifier: string | null = null): void {
  assert.equal(p.cost.pico, null);
  assert.equal(p.cost.usd, null);
  assert.equal(p.cost.reason, reason);
  assert.equal(p.modifier_reason, modifier);
  assert.equal(p.rates, null);
}

// Independent oracle: price string to picodollars per token, with its own string splitting. -----------

function perToken(priceStr: string): bigint {
  const [a = "0", f = ""] = priceStr.split(".");
  assert.ok(f.length <= 6, "table price finer than 1e-6");
  return BigInt(a) * 1_000_000n + BigInt(f.padEnd(6, "0"));
}

// ---------------------------------------------------------------------------
// The shipped table: R3.1, R3.2, R3.7, R3.11, R7.2 expectation lists
// ---------------------------------------------------------------------------

describe("shipped table", () => {
  it("loads, has no audit finding, and prints its version (R3.1)", () => {
    assert.deepEqual(auditTable(DEFAULT_TABLE), []);
    assert.equal(DEFAULT_BOOK.table_version, DEFAULT_TABLE.table_version);
    assert.match(DEFAULT_BOOK.table_version, /^pt-[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]+)?$/);
  });

  it("R3.2 ratio test passes for the standard, fast, Haiku high and verified long-context rows", () => {
    const findings = auditTable(DEFAULT_TABLE).filter((f) => f.code === "ratio");
    assert.deepEqual(findings, []);
  });

  it("R3.2 documented-multiplier test passes and matches the documented list", () => {
    assert.deepEqual(auditTable(DEFAULT_TABLE).filter((f) => f.code === "documented_multiplier"), []);
    const read = (id: string) => documentedMultipliers("anthropic", id)?.cache_read;
    assert.deepEqual(read("claude-fable-5-1"), { num: 1n, den: 40n });
    assert.deepEqual(read("claude-mythos-5-1"), { num: 1n, den: 40n });
    assert.deepEqual(read("claude-opus-5-5"), { num: 1n, den: 20n });
    assert.deepEqual(read("claude-sonnet-5-5"), { num: 1n, den: 20n });
    assert.deepEqual(read("claude-haiku-4-5"), { num: 1n, den: 10n });
    assert.deepEqual(documentedMultipliers("openai", "gpt-6.1-sol")?.cached_input, { num: 1n, den: 20n });
    assert.deepEqual(documentedMultipliers("openai", "gpt-6-sol")?.cached_input, { num: 1n, den: 10n });
    assert.deepEqual(documentedMultipliers("openai", "gpt-5.6-luna")?.cache_write, { num: 5n, den: 4n });
    // GPT-5.5 and earlier: nothing documented, so nothing is tested.
    for (const id of ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5", "gpt-5-mini"]) {
      assert.equal(documentedMultipliers("openai", id), null, id);
    }
  });

  it("R3.11: every verified:true object has an effective verified_at; every scope_verified:true has a date and a source id", () => {
    assert.deepEqual(auditTable(DEFAULT_TABLE).filter((f) => f.code.startsWith("r311")), []);
    const t = DEFAULT_TABLE as unknown as Json;
    assert.match(String(t.verified_at), /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    for (const m of t.models as Json[]) {
      for (const k of ["tiers", "long_context", "fast", "geo_us"]) {
        const o = m[k] as Json | null;
        if (o && o.verified === true) assert.ok(o.verified_at ?? m.verified_at ?? t.verified_at, `${m.id}.${k}`);
        if (o && o.scope_verified === true) {
          assert.ok(o.scope_source_id && t.sources[o.scope_source_id], `${m.id}.${k} scope source`);
        }
      }
    }
  });

  it("R3.10: the verified scopes of the table (request for seven models, session for gpt-5.5 and gpt-5.4)", () => {
    const request = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
    for (const mp of DEFAULT_BOOK.models.values()) {
      if (mp.provider !== "openai") continue;
      if (request.includes(mp.id)) assert.equal(mp.long_context?.scope, "request", mp.id);
      else if (mp.id === "gpt-5.5" || mp.id === "gpt-5.4") assert.equal(mp.long_context?.scope, "session", mp.id);
      else assert.notEqual(mp.long_context?.scope, "request", mp.id);
    }
  });

  it("R3.7 expectation list: priced models are verified, the two unlisted models have no row", () => {
    for (const id of [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-fable-5-1",
      "claude-haiku-4-5",
      "claude-haiku-5-5",
      "gpt-6.1-sol",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-6-astra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]) {
      const mp = lookupModel(DEFAULT_BOOK, id);
      assert.ok(mp, id);
      assert.equal(mp.verified, true, id);
      assert.notEqual(mp.standard.input, null, id);
    }
    assert.equal(lookupModel(DEFAULT_BOOK, "codex-auto-review"), null);
    assert.equal(lookupModel(DEFAULT_BOOK, "gpt-5.3-codex-spark"), null);
  });

  it("R7.2 minimum cacheable lengths M match the expectation list", () => {
    const want: Record<string, number> = {
      "claude-fable-5-1": 512, "claude-mythos-5-1": 512, "claude-opus-5-5": 512, "claude-opus-5": 512,
      "claude-sonnet-5-5": 512, "claude-fable-5": 512, "claude-mythos-5": 512, "claude-haiku-5-5": 512,
      "claude-opus-4-8": 1024, "claude-sonnet-5": 1024, "claude-sonnet-4-6": 1024, "claude-sonnet-4-5": 1024,
      "claude-opus-4-1": 1024, "claude-opus-4": 1024, "claude-sonnet-4": 1024,
      "claude-opus-4-7": 2048,
      "claude-opus-4-6": 4096, "claude-opus-4-5": 4096, "claude-haiku-4-5": 4096,
      "gpt-6-astra": 1024, "gpt-6.1-sol": 1024, "gpt-6-sol": 1024, "gpt-6-luna": 1024,
      "gpt-5.6-sol": 1024, "gpt-5.6-terra": 1024, "gpt-5.6-luna": 1024,
    };
    for (const [id, m] of Object.entries(want)) {
      assert.equal(lookupModel(DEFAULT_BOOK, id)?.min_cacheable, BigInt(m), id);
    }
    // Mythos Preview states no model id, so it cannot be matched; its table entry still carries 2048.
    assert.equal(entryOf(DEFAULT_TABLE as unknown as Json, "mythos-preview").min_cacheable_tokens, 2048);
    // Earlier GPT models: unknown, which abstains (E6).
    for (const id of ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5"]) {
      assert.equal(lookupModel(DEFAULT_BOOK, id)?.min_cacheable, null, id);
    }
  });

  it("aliases are empty and never matched (R3.3)", () => {
    for (const m of ((DEFAULT_TABLE as unknown as Json).models as Json[])) assert.deepEqual(m.aliases, [], m.id);
    for (const alias of ["opus", "sonnet", "fable", "haiku", "mythos", "default"]) {
      assert.equal(lookupModel(DEFAULT_BOOK, alias), null, alias);
      assertUnpriced(price(claude({ model: alias })), "unknown_model");
    }
  });

  it("every price string is exact in 1e-6 USD units (R3.8)", () => {
    const walk = (o: unknown): void => {
      if (o === null || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o as Json)) {
        if (k === "prices_usd_per_mtok" || k === "high" || k === "approximate_prices_usd_per_mtok") {
          if (v) for (const s of Object.values(v as Json)) if (s !== null) assert.notEqual(parsePriceUnits(s), null, String(s));
        } else walk(v);
      }
    };
    walk(DEFAULT_TABLE);
  });

  it("verified:false entries are in the book but give no dollars", () => {
    // Mythos Preview states no model id, so it has no book key at all.
    assert.equal(lookupModel(DEFAULT_BOOK, "mythos-preview"), null);
    assert.equal(lookupModel(DEFAULT_BOOK, "gpt-5-codex")?.verified, false);
  });
});

// ---------------------------------------------------------------------------
// Parsing helpers (R3.3, R3.8)
// ---------------------------------------------------------------------------

describe("decimal and id helpers", () => {
  it("parsePriceUnits converts to integer micro-dollars and rejects what it cannot hold", () => {
    assert.equal(parsePriceUnits("10"), 10_000_000n);
    assert.equal(parsePriceUnits("0.125"), 125_000n);
    assert.equal(parsePriceUnits("0.000001"), 1n);
    assert.equal(parsePriceUnits("0"), 0n);
    for (const bad of ["0.0000001", "-1", "1e3", "1,5", "", ".5", "5.", " 5", null, 5, undefined]) {
      assert.equal(parsePriceUnits(bad), null, String(bad));
    }
  });
  it("parseDecimal is an exact rational", () => {
    assert.deepEqual(parseDecimal("0.025"), { num: 25n, den: 1000n });
    assert.deepEqual(parseDecimal("1.25"), { num: 125n, den: 100n });
    assert.deepEqual(parseDecimal("2"), { num: 2n, den: 1n });
  });
  it("normalizeModelId strips one trailing -YYYYMMDD only (R3.3)", () => {
    assert.equal(normalizeModelId("claude-opus-4-5-20251101"), "claude-opus-4-5");
    assert.equal(normalizeModelId("claude-sonnet-5-5"), "claude-sonnet-5-5");
    assert.equal(normalizeModelId("claude-haiku-4-5-2025"), "claude-haiku-4-5-2025");
    assert.equal(normalizeModelId("gpt-5.5"), "gpt-5.5");
  });
});

// ---------------------------------------------------------------------------
// Table audit: mutation tests for R3.2, R3.11 and schema
// ---------------------------------------------------------------------------

describe("table audit", () => {
  const codes = (t: Json) => auditTable(t as PricingTable).map((f) => `${f.code}@${f.path}`);

  it("R3.2 (1) ratio: a changed cache price is caught on the standard row", () => {
    const t = cloneTable();
    entryOf(t, "claude-sonnet-5-5").prices_usd_per_mtok.cache_write_5m = "2.6";
    assert.deepEqual(codes(t), ["ratio@models[11].prices_usd_per_mtok.cache_write_5m"]);
    assert.throws(() => loadPriceBook(t as PricingTable), PriceTableError);
  });

  it("R3.2 (1) ratio: a fast row is tested against the fast input price, not the standard one", () => {
    const t = cloneTable();
    entryOf(t, "claude-opus-5-5").fast.prices_usd_per_mtok.cache_read = "0.2"; // standard-row value
    assert.ok(codes(t).some((c) => c.startsWith("ratio@") && c.endsWith(".fast.cache_read")));
    const ok = cloneTable(); // the shipped fast row passes: 8 * 0.05 = 0.4
    assert.equal(entryOf(ok, "claude-opus-5-5").fast.prices_usd_per_mtok.cache_read, "0.4");
    assert.deepEqual(codes(ok), []);
  });

  it("R3.2 (1) ratio: the Haiku 5.5 high tier row is tested", () => {
    const t = cloneTable();
    entryOf(t, "claude-haiku-5-5").tiers.high.cache_write_1h = "1.1";
    assert.ok(codes(t).some((c) => c.startsWith("ratio@") && c.endsWith(".tiers.high.cache_write_1h")));
  });

  it("R3.2 (1) ratio: a verified long-context row is tested, an unverified one is not", () => {
    const t = cloneTable();
    entryOf(t, "gpt-6-sol").long_context.prices_usd_per_mtok.cached_input = "0.5";
    assert.ok(codes(t).some((c) => c.startsWith("ratio@") && c.includes(".long_context.")));
    const t2 = cloneTable();
    entryOf(t2, "gpt-6-sol").long_context.prices_usd_per_mtok.cached_input = "0.5";
    entryOf(t2, "gpt-6-sol").long_context.verified = false;
    assert.deepEqual(codes(t2), []);
  });

  it("R3.2 (2) documented list: a consistent but wrong multiplier fails (the Sonnet 5.5 secondary-copy case)", () => {
    const t = cloneTable();
    const e = entryOf(t, "claude-sonnet-5-5");
    e.prices_usd_per_mtok.cache_read = "0.2";
    e.multipliers.cache_read = "0.1";
    const c = codes(t);
    assert.equal(c.filter((x) => x.startsWith("ratio@")).length, 0, "ratio test alone passes");
    assert.ok(c.some((x) => x.startsWith("documented_multiplier@") && x.endsWith(".multipliers.cache_read")));
    assert.throws(() => loadPriceBook(t as PricingTable), PriceTableError);
  });

  it("R3.2 (2) documented list: GPT-6.1 Sol must store 0.05 and a missing multiplier fails", () => {
    const t = cloneTable();
    const e = entryOf(t, "gpt-6.1-sol");
    e.prices_usd_per_mtok.cached_input = "0.2";
    e.multipliers.cached_input = "0.1";
    assert.ok(codes(t).some((x) => x.startsWith("documented_multiplier@")));
    const t2 = cloneTable();
    entryOf(t2, "gpt-6-luna").multipliers = null;
    assert.ok(codes(t2).some((x) => x.startsWith("documented_multiplier@")));
  });

  it("R3.2 (2) documented list: a model outside the lists stores none and is not tested", () => {
    const t = cloneTable();
    const e = entryOf(t, "gpt-5.5");
    e.multipliers = { cached_input: null, cache_write: null };
    assert.deepEqual(codes(t), []);
  });

  it("geo multiplier is applied at runtime and a stored copy must equal C32", () => {
    const t = cloneTable();
    entryOf(t, "claude-opus-5-5").geo_us.multiplier = "1.2";
    assert.ok(codes(t).some((x) => x.startsWith("constant_mismatch@") && x.endsWith(".geo_us.multiplier")));
  });

  it("tier split and long-context threshold copies must equal C26 and C25", () => {
    const t = cloneTable();
    entryOf(t, "claude-haiku-5-5").tiers.split_tokens = 200000;
    entryOf(t, "gpt-6-sol").long_context.threshold_input_tokens = 200000;
    const c = codes(t);
    assert.ok(c.some((x) => x.endsWith(".tiers.split_tokens")));
    assert.ok(c.some((x) => x.endsWith(".long_context.threshold_input_tokens")));
  });

  it("schema: malformed prices, duplicate ids and a bad version are rejected", () => {
    const bad = (mutate: (t: Json) => void) => {
      const t = cloneTable();
      mutate(t);
      assert.throws(() => loadPriceBook(t as PricingTable), PriceTableError);
    };
    bad((t) => { entryOf(t, "claude-opus-5-5").prices_usd_per_mtok.input = "four"; });
    bad((t) => { entryOf(t, "claude-opus-5-5").prices_usd_per_mtok.input = "4.0000001"; });
    bad((t) => { entryOf(t, "claude-opus-5-5").prices_usd_per_mtok.output = null; });
    bad((t) => { entryOf(t, "claude-opus-5-5").prices_usd_per_mtok = null; });
    bad((t) => { entryOf(t, "claude-opus-5").model_ids.push("claude-opus-5-5-20251101"); });
    bad((t) => { t.table_version = "2026-10-08"; });
    bad((t) => { t.models = {}; });
    bad((t) => { entryOf(t, "claude-opus-5-5").provider = "mistral"; });
    bad((t) => { entryOf(t, "claude-opus-5-5").min_cacheable_tokens = 12.5; });
    bad((t) => { entryOf(t, "claude-opus-5-5").service_tier = { standard: { verified: true, prices_usd_per_mtok: {} } }; });
    assert.throws(() => loadPriceBook(null as unknown as PricingTable), PriceTableError);
  });

  it("schema: an unverified OpenAI long-context object with no prices is fine", () => {
    const t = cloneTable();
    const lc = entryOf(t, "gpt-5.6-sol").long_context;
    lc.verified = false;
    lc.prices_usd_per_mtok = null;
    assert.deepEqual(codes(t), []);
    assert.equal(lookupModel(book(t), "gpt-5.6-sol")?.long_context?.prices_verified, false);
  });

  it("R3.11: verified:true with no effective date is treated as false at runtime, is a finding, and is not fatal", () => {
    const t = cloneTable();
    delete t.verified_at;
    delete entryOf(t, "claude-sonnet-5-5").verified_at;
    const findings = auditTable(t as PricingTable);
    assert.ok(findings.some((f) => f.code === "r311_effective_date" && f.path === "models[11]" && !f.fatal));
    const b = book(t);
    assertUnpriced(price(claude({ model: "claude-sonnet-5-5" }), b), "unknown_model");
    // Another entry still inherits nothing and is demoted too (no table date), but one with its own date survives.
    assert.equal(lookupModel(b, "claude-opus-5-5")?.verified, true, "entry with its own verified_at");
  });

  it("R3.11: a nested object with an invalid own date is demoted (fast row)", () => {
    const t = cloneTable();
    entryOf(t, "claude-opus-5-5").fast.verified_at = "someday";
    assert.ok(codes(t).some((x) => x.startsWith("r311_effective_date@") && x.endsWith(".fast")));
    assertUnpriced(price(claude({ model: "claude-opus-5-5", speed: "fast" }), book(t)), "unpriced_modifier", "speed_fast_no_row");
  });

  it("R3.11: nested objects inherit the date of their entry, then of the table", () => {
    const t = cloneTable();
    assert.equal(entryOf(t, "claude-opus-5-5").fast.verified_at, undefined);
    assert.deepEqual(codes(t), []);
    assert.equal(lookupModel(book(t), "claude-opus-5-5")?.fast?.input, 8_000_000n);
  });

  it("R3.11: scope_verified needs a date and a scope_source_id that names a source of the table", () => {
    const noId = cloneTable();
    withScope(noId, "gpt-6-sol", "request");
    delete entryOf(noId, "gpt-6-sol").long_context.scope_source_id;
    assert.ok(codes(noId).some((x) => x.startsWith("r311_scope@")));
    assert.equal(lookupModel(book(noId), "gpt-6-sol")?.long_context?.scope, "unknown");

    const badId = cloneTable();
    withScope(badId, "gpt-6-sol", "request", { scope_source_id: "Z9" });
    assert.ok(codes(badId).some((x) => x.startsWith("r311_scope@")));
    assert.equal(lookupModel(book(badId), "gpt-6-sol")?.long_context?.scope, "unknown");

    const noDate = cloneTable();
    delete noDate.verified_at;
    delete entryOf(noDate, "gpt-6-sol").verified_at;
    entryOf(noDate, "gpt-6-sol").verified = true;
    entryOf(noDate, "gpt-6-sol").long_context.verified_at = "n/a";
    withScope(noDate, "gpt-6-sol", "request");
    assert.equal(lookupModel(book(noDate), "gpt-6-sol")?.long_context?.scope, "unknown");

    const ok = cloneTable();
    withScope(ok, "gpt-6-sol", "request");
    assert.deepEqual(codes(ok), []);
    assert.equal(lookupModel(book(ok), "gpt-6-sol")?.long_context?.scope, "request");
  });

  it("R3.10: a scope without scope_verified is unknown, and verifying prices does not verify scope", () => {
    const t = cloneTable();
    const lc = entryOf(t, "gpt-6-sol").long_context;
    assert.equal(lc.verified, true);
    lc.scope = "request"; // declared but not verified
    lc.scope_verified = false;
    const mp = lookupModel(book(t), "gpt-6-sol");
    assert.equal(mp?.long_context?.prices_verified, true);
    assert.equal(mp?.long_context?.scope, "unknown");
  });
});

// ---------------------------------------------------------------------------
// Claude pricing: R3.4, R3.5, R3.8 worked examples
// ---------------------------------------------------------------------------

describe("Claude cost (R3.5)", () => {
  it("worked example: cold start on Sonnet 5.5 (input 2, 5m write 2.5, output 10 per MTok)", () => {
    // 5*2 + 20000*2.5 + 300*10 per million = 5*2e6 + 20000*2.5e6 + 300*1e7 picodollars
    const p = price(claude({ usage: { i: 5, w5: 20000, o: 300 } }));
    assert.equal(usdPico(p), 53_010_000_000n); // 0.05301 USD
    assert.equal(p.cost.usd, "53010000000");
    assert.equal(p.tokens_unpriced, 0n);
    assert.equal(p.table_version, DEFAULT_TABLE.table_version);
    // R3.5: a single number or nothing. The result carries no range and no partial-output marker.
    assert.deepEqual(Object.keys(p).sort(), ["chain", "cost", "key", "modifier_reason", "provider", "rates", "table_version", "tokens_unpriced"]);
    assert.equal(p.rates?.row, "standard");
    assert.deepEqual(p.rates?.geo, { num: 1n, den: 1n });
  });

  it("worked example: warm turn with a 1h write (read 0.1, 1h write 4)", () => {
    // 8*2e6 + 20000*1e5 + 1500*4e6 + 120*1e7
    const p = price(claude({ usage: { i: 8, r: 20000, w1: 1500, o: 120 } }));
    assert.equal(usdPico(p), 9_216_000_000n);
  });

  it("every bucket is priced at its own rate (Opus 4.1: 15 / 18.75 / 30 / 1.5 / 75)", () => {
    const p = price(claude({ model: "claude-opus-4-1", usage: { i: 1, r: 1, w5: 1, w1: 1, o: 1 } }));
    assert.equal(usdPico(p), 15_000_000n + 1_500_000n + 18_750_000n + 30_000_000n + 75_000_000n);
  });

  it("R3.5: unknown-TTL writes are unpriced bucket_unknown, with no range, and their tokens count as unpriced", () => {
    const p = price(claude({ usage: { i: 10, wu: 1000, o: 5 } }));
    assertUnpriced(p, "unpriced_modifier", "bucket_unknown");
    assert.equal(p.tokens_unpriced, 10n + 1000n + 5n);
  });

  it("R3.5: an unknown-TTL write mixed with 5m and 1h writes is unpriced as a whole", () => {
    const p = price(claude({ usage: { w5: 100, w1: 200, wu: 300, o: 0 } }));
    assertUnpriced(p, "unpriced_modifier", "bucket_unknown");
    assert.equal(p.tokens_unpriced, 600n);
    // with geo us the answer is the same: no number exists to multiply
    assertUnpriced(price(claude({ geo: "us", usage: { wu: 1, o: 0 } })), "unpriced_modifier", "bucket_unknown");
  });

  it("R3.5: a known zero output is priced; an unknown output has no priced form (no partial output term)", () => {
    const zero = price(claude({ usage: { i: 1000, o: 0 } }));
    assert.equal(usdPico(zero), 2_000_000_000n);
    // thinking tokens are never priced separately (R2.4)
    const th = price(claude({ usage: { i: 1000, o: 10, reasoning: 999999 } }));
    assert.equal(usdPico(th), 2_000_000_000n + 100_000_000n);
    // Without a final copy the output is unknown and the response is modifier_unverified (R3.12), never an input-only price.
    const unknown = price(claude({ flags: ["no_final_copy", "output_unknown"], speed: null, geo: null, tier: null, usage: { i: 1000, o: null } }));
    assertUnpriced(unknown, "unpriced_modifier", "modifier_unverified");
    assert.equal(unknown.tokens_unpriced, 1000n + 7n);
    // Defence in depth: an unknown output on a response that otherwise passes every gate is refused, not priced without output.
    const odd = price(claude({ usage: { i: 1000, o: null } }));
    assertUnpriced(odd, "unpriced_modifier", "modifier_unverified");
    assert.equal(odd.tokens_unpriced, 1007n);
  });

  it("R2.1: with a clean model source, a bucket_mismatch response is priced by its bucket sum (unit level; the pipeline taints the chain)", () => {
    const p = price(claude({ flags: ["bucket_mismatch"], usage: { w1: 1796, i: 1 } }));
    assert.equal(usdPico(p), 1796n * 4_000_000n + 2_000_000n);
  });

  it("R0.9 effect 2: model_source chain_tainted is unpriced chain_tainted whatever the model, modifiers or conflict flags are", () => {
    const shape: U = { i: 1000, r: 20, w5: 30, w1: 40, wu: 50, o: 60 };
    const cases: ClaudeResponse[] = [
      claude({ source: "chain_tainted", usage: shape }),
      claude({ source: "chain_tainted", verified: false, model: null, usage: shape }),
      claude({ source: "chain_tainted", model: "claude-future-9", usage: shape }),
      claude({ source: "chain_tainted", speed: "other", geo: "other", tier: "other", usage: shape }),
      claude({ source: "chain_tainted", speed: null, geo: null, tier: null, flags: ["no_final_copy"], usage: shape }),
      claude({ source: "chain_tainted", flags: ["conflict_modifier", "bucket_mismatch", "conflict_output"], usage: shape }),
      claude({ source: "chain_tainted", model: "claude-opus-5-5", speed: "fast", geo: "us", usage: shape }),
      claude({ source: "chain_tainted", usage: { i: 1000, o: null } }),
    ];
    for (const r of cases) {
      const p = price(r);
      assert.equal(p.cost.pico, null);
      assert.equal(p.cost.reason, "chain_tainted");
      assert.equal(p.modifier_reason, null);
      assert.equal(p.rates, null);
      assert.equal(p.tokens_unpriced, responseTokens(r.usage!));
    }
    assert.equal(price(cases[0]!).tokens_unpriced, 1000n + 20n + 30n + 40n + 50n + 60n);
    // Codex: the taint gate comes before the tier gate, so the reason is chain_tainted in a default run and under the test parameter
    const c = codex({ source: "chain_tainted", model: null, verified: false, usage: { i: 300000, o: 5 } });
    for (const opts of [undefined, { codex_tier_for_test: "standard" as const }]) {
      const p = priceResponse(c, DEFAULT_BOOK, opts);
      assertUnpriced(p, "chain_tainted");
      assert.equal(p.tokens_unpriced, 300005n);
    }
    // excluded and replayed responses keep their own reasons before the taint gate
    assertUnpriced(price(claude({ source: "chain_tainted", exclusion: "conflict_input" })), "excluded");
    assertUnpriced(price(claude({ source: "chain_tainted", role: "replayed" })), "not_owner");
  });

  it("R3.12: a Claude response without a final copy is unpriced modifier_unverified, whatever the model", () => {
    const nf = { flags: ["no_final_copy" as const, "output_unknown" as const], speed: null, geo: null, tier: null };
    const sonnet = price(claude({ ...nf, usage: { w1: 1796, i: 1, o: null } }));
    assertUnpriced(sonnet, "unpriced_modifier", "modifier_unverified");
    assert.equal(sonnet.tokens_unpriced, 1797n + 7n);
    // fixture (5): no final copy on a model without a fast row (claude-sonnet-5-5) is modifier_unverified as well
    assertUnpriced(price(claude({ ...nf, model: "claude-sonnet-5-5", usage: { i: 5, o: null } })), "unpriced_modifier", "modifier_unverified");
    // fixture (1): the example with C lacking a final copy
    const nofinal = price(claude({ ...nf, model: "claude-opus-5-5", usage: { w1: 20000, o: null } }));
    assertUnpriced(nofinal, "unpriced_modifier", "modifier_unverified");
    assert.equal(nofinal.tokens_unpriced, 20007n);
    // the flag alone decides, even if the modifier fields look complete
    assertUnpriced(price(claude({ flags: ["no_final_copy"], usage: { i: 5, o: 1 } })), "unpriced_modifier", "modifier_unverified");
    // an unknown model still reports unknown_model before the modifier checks
    assertUnpriced(price(claude({ model: "claude-future-9", flags: ["no_final_copy"] })), "unknown_model");
  });

  it("R3.12 fixture (2): standard, fast and fast with geo us on claude-opus-5-5 give the exact picodollars of the table", () => {
    // K_prev = 20000, R = 0, w1 = 20000, U = 0, output 0.
    const final = (speed: Speed, geo: Geo) => price(claude({ model: "claude-opus-5-5", speed, geo, usage: { w1: 20000, o: 0 } }));
    const std = final("standard", "not_available");
    const fast = final("fast", "not_available");
    const fastGeo = final("fast", "us");
    assert.equal(usdPico(std), 160_000_000_000n);
    assert.equal(usdPico(fast), 320_000_000_000n);
    assert.equal(usdPico(fastGeo), 352_000_000_000n); // fast_with_geo_us is verified in the shipped table
    assert.deepEqual(fastGeo.rates?.geo, CONSTANTS.GEO_US_MULT);
    assert.equal(fastGeo.rates?.row, "fast");
    // the same figures from the table strings, not from literals
    const e = entryOf(DEFAULT_TABLE as unknown as Json, "claude-opus-5-5");
    assert.equal(usdPico(std), 20000n * perToken(e.prices_usd_per_mtok.cache_write_1h));
    assert.equal(usdPico(fast), 20000n * perToken(e.fast.prices_usd_per_mtok.cache_write_1h));
    assert.equal(usdPico(fastGeo), (20000n * perToken(e.fast.prices_usd_per_mtok.cache_write_1h) * 11n) / 10n);
  });

  it("R3.12: a final copy that lacks inference_geo, service_tier or speed is modifier_unverified; nothing is defaulted", () => {
    for (const o of [{ geo: null }, { tier: null }, { speed: null }, { geo: null, tier: null }] as const) {
      const p = price(claude({ ...o, usage: { i: 1000, o: 1 } }));
      assertUnpriced(p, "unpriced_modifier", "modifier_unverified");
      assert.equal(p.tokens_unpriced, 1001n);
    }
    assert.notEqual(price(claude({ usage: { i: 1000, o: 1 } })).cost.pico, null);
    // a disagreement between copies is reported as conflict_modifier, before the unverified check
    assertUnpriced(price(claude({ flags: ["conflict_modifier"], geo: null, usage: { i: 1 } })), "unpriced_modifier", "conflict_modifier");
  });

  it("R3.4 tier gate: a default run prices no Codex response, before R3.10 (reason modifier_unverified)", () => {
    for (const model of ["gpt-6-sol", "gpt-5.5", "gpt-6.1-sol"]) {
      for (const inn of [100000, 300000]) {
        const p = priceResponse(codex({ model, usage: { i: inn, o: 5 } }), DEFAULT_BOOK);
        assertUnpriced(p, "unpriced_modifier", "modifier_unverified");
        assert.equal(p.tokens_unpriced, BigInt(inn) + 5n);
      }
    }
    // The gate comes before the model checks (R3.4: "whatever its model"): in a default run an unknown model or an
    // unverified attribution is modifier_unverified too. Under the test parameter they are reported as before.
    assertUnpriced(priceResponse(codex({ model: "codex-auto-review" }), DEFAULT_BOOK), "unpriced_modifier", "modifier_unverified");
    assertUnpriced(priceResponse(codex({ model: "gpt-6-sol", verified: false }), DEFAULT_BOOK), "unpriced_modifier", "modifier_unverified");
    assertUnpriced(price(codex({ model: "codex-auto-review" })), "unknown_model");
    assertUnpriced(price(codex({ model: "gpt-6-sol", verified: false })), "model_unknown");
    // under the test parameter a request-scoped model is priced, a session-scoped one is long_context_scope
    const t = cloneTable();
    withScope(t, "gpt-6-sol", "request");
    assert.notEqual(price(codex({ model: "gpt-6-sol", usage: { i: 1000, o: 1 } }), book(t)).cost.pico, null);
    assertUnpriced(price(codex({ model: "gpt-5.5", usage: { i: 1000, o: 1 } })), "unpriced_modifier", "long_context_scope");
  });

  it("dated model ids are normalized before the match (R3.3)", () => {
    const a = price(claude({ model: "claude-sonnet-5-5-20260101" }));
    const b = price(claude({ model: "claude-sonnet-5-5" }));
    assert.equal(usdPico(a), usdPico(b));
  });

  it("matches the independent oracle for every verified Claude entry and several usage shapes", () => {
    const shapes: U[] = [
      { i: 1, r: 2, w5: 3, w1: 4, o: 5 },
      { i: 123456, r: 789, w5: 0, w1: 42, o: 31337 },
      { i: 0, r: 99999, w5: 1, w1: 0, o: 0 },
      { i: 17, r: 0, w5: 50000, w1: 0, o: 4 },
    ];
    const t = DEFAULT_TABLE as unknown as Json;
    let n = 0;
    for (const e of t.models as Json[]) {
      if (e.provider !== "anthropic" || !e.verified || e.model_ids.length === 0) continue;
      const p = e.prices_usd_per_mtok as Record<string, string>;
      for (const s of shapes) {
        const resp = claude({ model: e.model_ids[0], usage: s });
        const total = BigInt(s.i ?? 0) + BigInt(s.r ?? 0) + BigInt(s.w5 ?? 0) + BigInt(s.w1 ?? 0);
        // Haiku 5.5 high tier is exercised separately; shapes here stay at or below 100000 except one.
        const row = e.tiers && total > 100000n ? (e.tiers.high as Record<string, string>) : p;
        const want =
          BigInt(s.i ?? 0) * perToken(row.input!) +
          BigInt(s.r ?? 0) * perToken(row.cache_read!) +
          BigInt(s.w5 ?? 0) * perToken(row.cache_write_5m!) +
          BigInt(s.w1 ?? 0) * perToken(row.cache_write_1h!) +
          BigInt(s.o ?? 0) * perToken(row.output!);
        assert.equal(usdPico(price(resp)), want, `${e.id} ${JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
        n++;
      }
    }
    assert.ok(n >= 19 * shapes.length);
  });
});

describe("Claude modifiers (R3.4)", () => {
  it("speed standard: standard price; fast: the fast row (Opus 5.5 fast 8 in, 0.4 read, 40 out); absent speed is modifier_unverified (R3.12)", () => {
    const base = { usage: { i: 1000, r: 2000, o: 100 } };
    const std = price(claude({ model: "claude-opus-5-5", ...base }));
    assert.equal(usdPico(std), 1000n * 4_000_000n + 2000n * 200_000n + 100n * 20_000_000n);
    assert.equal(usdPico(price(claude({ model: "claude-opus-5-5", speed: "standard", ...base }))), usdPico(std));
    assertUnpriced(price(claude({ model: "claude-opus-5-5", speed: null, ...base })), "unpriced_modifier", "modifier_unverified");
    const fast = price(claude({ model: "claude-opus-5-5", speed: "fast", ...base }));
    assert.equal(usdPico(fast), 1000n * 8_000_000n + 2000n * 400_000n + 100n * 40_000_000n);
    assert.equal(fast.rates?.row, "fast");
    assert.equal(fast.rates?.input, 8_000_000n);
  });

  it("fast on a model without a fast row is unpriced_modifier speed_fast_no_row", () => {
    assertUnpriced(price(claude({ model: "claude-sonnet-5-5", speed: "fast" })), "unpriced_modifier", "speed_fast_no_row");
    assertUnpriced(price(claude({ model: "claude-opus-4-7", speed: "fast" })), "unpriced_modifier", "speed_fast_no_row");
  });

  it("speed other is unpriced", () => {
    assertUnpriced(price(claude({ speed: "other" })), "unpriced_modifier", "speed_other");
  });

  it("fast with geo us: priced only when the table modifier fast_with_geo_us is verified", () => {
    const r = () => claude({ model: "claude-opus-5-5", speed: "fast", geo: "us", usage: { i: 1000, o: 0 } });
    const off = cloneTable();
    off.modifiers.fast_with_geo_us = { ...off.modifiers.fast_with_geo_us, verified: false };
    assertUnpriced(price(r(), book(off)), "unpriced_modifier", "fast_geo_unverified");
    const p = price(r()); // verified in the shipped table
    assert.equal(usdPico(p), 8_800_000_000n); // 1000 * 8e6 * 11/10
    assert.deepEqual(p.rates?.geo, CONSTANTS.GEO_US_MULT);
    assert.equal(p.rates?.row, "fast");
    // verified:true without an effective date is demoted (R3.11): here the table date makes it effective, so remove it
    const t2 = cloneTable();
    delete t2.verified_at;
    t2.modifiers.fast_with_geo_us = { verified: true };
    for (const e of t2.models as Json[]) if (e.id !== "claude-opus-5-5") delete e.verified_at;
    assertUnpriced(price(r(), book(t2)), "unpriced_modifier", "fast_geo_unverified");
  });

  it("geo us multiplies every price by C32 once, where the table says it applies", () => {
    const p = price(claude({ model: "claude-opus-5-5", geo: "us", usage: { i: 1000, r: 10, w5: 3, w1: 7, o: 11 } }));
    const base = 1000n * 4_000_000n + 10n * 200_000n + 3n * 5_000_000n + 7n * 8_000_000n + 11n * 20_000_000n;
    assert.equal(usdPico(p), (base * 11n) / 10n);
    assert.equal((base * 11n) % 10n, 0n, "exact for prices of at most 5 decimals");
    assert.deepEqual(p.rates?.geo, { num: 11n, den: 10n });
    assert.equal(usdPico(price(claude({ model: "claude-opus-5-5", geo: "not_available", usage: { i: 1000 } }))), 4_000_000_000n);
  });

  it("geo us on a model where the table does not say it applies is unpriced; geo other is unpriced", () => {
    assertUnpriced(price(claude({ model: "claude-opus-4-5", geo: "us" })), "unpriced_modifier", "geo_other");
    assertUnpriced(price(claude({ model: "claude-haiku-4-5", geo: "us" })), "unpriced_modifier", "geo_other");
    assertUnpriced(price(claude({ geo: "other" })), "unpriced_modifier", "geo_other");
    assert.notEqual(price(claude({ model: "claude-opus-4-5", geo: "not_available" })).cost.pico, null);
    // an absent geo on the final copy is not "no multiplier": it is unverified (R3.12)
    assertUnpriced(price(claude({ model: "claude-opus-4-5", geo: null })), "unpriced_modifier", "modifier_unverified");
  });

  it("the geo division rounds half up when a price has 6 decimals (R3.8)", () => {
    // A consistent synthetic row: input 20 units, read 1 unit (0.05x), 5m 25 units, 1h 40 units.
    const t = cloneTable();
    const e = entryOf(t, "claude-opus-5-5");
    e.fast = null;
    e.prices_usd_per_mtok = { input: "0.00002", output: "0.0001", cache_read: "0.000001", cache_write_5m: "0.000025", cache_write_1h: "0.00004" };
    const b = book(t);
    const read = (n: number) => usdPico(price(claude({ model: "claude-opus-5-5", geo: "us", usage: { r: n, o: 0 } }), b));
    assert.equal(read(5), 6n); // 5.5 rounds up
    assert.equal(read(4), 4n); // 4.4 rounds down
    assert.equal(read(10), 11n); // exact
    assert.equal(usdPico(price(claude({ model: "claude-opus-5-5", usage: { r: 5, o: 0 } }), b)), 5n); // no geo, no division
  });

  it("service_tier: standard has no effect; absent is modifier_unverified (R3.12); priority, batch and other are unpriced by default", () => {
    const base = { usage: { i: 1000, o: 0 } as U };
    assert.equal(usdPico(price(claude({ tier: "standard", ...base }))), 2_000_000_000n);
    assertUnpriced(price(claude({ tier: null, ...base })), "unpriced_modifier", "modifier_unverified");
    for (const tier of ["priority", "batch", "other"] as const) {
      assertUnpriced(price(claude({ tier, ...base })), "unpriced_modifier", "service_tier_unpriced");
    }
  });

  it("service_tier: an explicit verified row with a date is applied as a price row", () => {
    const t = cloneTable();
    entryOf(t, "claude-sonnet-5-5").service_tier = {
      priority: {
        verified: true,
        verified_at: "2026-10-08",
        source_ids: ["A1"],
        prices_usd_per_mtok: { input: "3", output: "15", cache_read: "0.15", cache_write_5m: "3.75", cache_write_1h: "6" },
      },
    };
    const b = book(t);
    const p = price(claude({ tier: "priority", usage: { i: 1000, o: 10 } }), b);
    assert.equal(usdPico(p), 3_000_000_000n + 150_000_000n);
    assert.equal(p.rates?.row, "service_tier");
    assertUnpriced(price(claude({ tier: "batch", usage: { i: 1 } }), b), "unpriced_modifier", "service_tier_unpriced");
    // combined with fast or geo: the table defines no combination
    assertUnpriced(price(claude({ tier: "priority", speed: "fast", usage: { i: 1 } }), b), "unpriced_modifier", "service_tier_unpriced");
    assertUnpriced(price(claude({ tier: "priority", geo: "us", usage: { i: 1 } }), b), "unpriced_modifier", "service_tier_unpriced");
    // an unverified row is absent
    entryOf(t, "claude-sonnet-5-5").service_tier.priority.verified = false;
    assertUnpriced(price(claude({ tier: "priority", usage: { i: 1 } }), book(t)), "unpriced_modifier", "service_tier_unpriced");
  });

  it("conflicting copies (flag conflict_modifier) are unpriced even when the values look priceable (R4.2)", () => {
    const p = price(claude({ flags: ["conflict_modifier"], usage: { i: 1000 } }));
    assertUnpriced(p, "unpriced_modifier", "conflict_modifier");
    assert.equal(p.tokens_unpriced, 1000n);
  });

  it("Haiku 5.5 tiers by total_input = i + r + w, split at C26 = 100000 (R3.4)", () => {
    const low = price(claude({ model: "claude-haiku-5-5", usage: { i: 100000, o: 0 } }));
    assert.equal(usdPico(low), 100000n * 100_000n); // 0.1 per MTok
    assert.equal(low.rates?.row, "standard");
    const high = price(claude({ model: "claude-haiku-5-5", usage: { i: 100001, o: 0 } }));
    assert.equal(usdPico(high), 100001n * 500_000n);
    assert.equal(high.rates?.row, "haiku_high");
    // the split reads the sum of input, read and writes, not input alone
    const split = price(claude({ model: "claude-haiku-5-5", usage: { i: 50000, r: 40000, w5: 10001, o: 100 } }));
    assert.equal(split.rates?.row, "haiku_high");
    assert.equal(usdPico(split), 50000n * 500_000n + 40000n * 50_000n + 10001n * 625_000n + 100n * 2_500_000n);
    const atSplit = price(claude({ model: "claude-haiku-5-5", usage: { i: 50000, r: 40000, w1: 10000, o: 0 } }));
    assert.equal(atSplit.rates?.row, "standard");
    // other models have no tier
    assert.equal(price(claude({ model: "claude-haiku-4-5", usage: { i: 900000 } })).rates?.row, "standard");
  });

  it("Haiku 5.5 with an unverified high tier: at or below the split priced, above unpriced tier_unverified", () => {
    const t = cloneTable();
    entryOf(t, "claude-haiku-5-5").tiers.verified = false;
    const b = book(t);
    assert.notEqual(price(claude({ model: "claude-haiku-5-5", usage: { i: 100000 } }), b).cost.pico, null);
    assertUnpriced(price(claude({ model: "claude-haiku-5-5", usage: { i: 100001 } }), b), "unpriced_modifier", "tier_unverified");
  });

  it("Haiku 5.5 high tier with geo us multiplies the high row", () => {
    const p = price(claude({ model: "claude-haiku-5-5", geo: "us", usage: { i: 200000, o: 0 } }));
    assert.equal(usdPico(p), (200000n * 500_000n * 11n) / 10n);
  });
});

// ---------------------------------------------------------------------------
// Model resolution and unpriced reasons
// ---------------------------------------------------------------------------

describe("model resolution and reasons (R2.10, R3.3, R3.9)", () => {
  it("unknown model: no dollars, tokens counted as unpriced (including known output)", () => {
    const p = price(claude({ model: "claude-future-9", usage: { i: 10, r: 20, w5: 30, w1: 40, wu: 50, o: 60 } }));
    assertUnpriced(p, "unknown_model");
    assert.equal(p.tokens_unpriced, 10n + 20n + 30n + 40n + 50n + 60n);
  });

  it("unknown model with unknown output: the output lower bound is counted (responseTokens)", () => {
    const p = price(claude({ model: "claude-future-9", usage: { i: 10, o: null } }));
    assert.equal(p.tokens_unpriced, 10n + 7n);
  });

  it("verified:false entries (Mythos 5, GPT-5 Codex) are unknown_model, and so are provider mismatches", () => {
    assertUnpriced(price(claude({ model: "mythos-preview" })), "unknown_model");
    assertUnpriced(price(codex({ model: "gpt-5-codex" })), "unknown_model");
    assertUnpriced(price(claude({ model: "gpt-5.5" })), "unknown_model");
    assertUnpriced(price(codex({ model: "claude-sonnet-5-5" })), "unknown_model");
    assertUnpriced(price(codex({ model: "codex-auto-review" })), "unknown_model");
    assertUnpriced(price(codex({ model: "gpt-5.3-codex-spark" })), "unknown_model");
  });

  it("an unverified model attribution is model_unknown even when a candidate exists (R2.10)", () => {
    const c = price(codex({ model: "gpt-5.5", verified: false, usage: { i: 300000, o: 5 } }));
    assertUnpriced(c, "model_unknown");
    assert.equal(c.tokens_unpriced, 300005n);
    assertUnpriced(price(claude({ verified: false, usage: { i: 1 } })), "model_unknown");
    assertUnpriced(price(claude({ model: null, verified: true, usage: { i: 1 } })), "model_unknown");
  });

  it("an excluded response has no counters and adds nothing to unpriced tokens", () => {
    const p = price(claude({ exclusion: "conflict_input" }));
    assertUnpriced(p, "excluded");
    assert.equal(p.tokens_unpriced, 0n);
  });

  it("a replayed copy counts zero dollars and zero tokens (R4.7)", () => {
    const p = price(claude({ role: "replayed", usage: { i: 5000, o: 5 } }));
    assertUnpriced(p, "not_owner");
    assert.equal(p.tokens_unpriced, 0n);
  });

  it("billedTokens equals responseTokens: input side plus the output (the lower bound when the output is unknown)", () => {
    assert.equal(billedTokens(usage({ i: 1, r: 2, w5: 3, w1: 4, wu: 5, cw: 6, o: 7 })), 28n);
    assert.equal(billedTokens(usage({ i: 1, o: null })), 1n + 7n);
    for (const u of [usage({ i: 1, r: 2, w5: 3, w1: 4, wu: 5, cw: 6, o: 7 }), usage({ i: 9, o: null }), usage({ o: 0 })]) {
      assert.equal(billedTokens(u), responseTokens(u));
    }
  });

  it("PricedAmount invariant: usd is the decimal string of pico, null together with a reason", () => {
    const priced = price(claude({ usage: { i: 3 } }));
    assert.equal(priced.cost.usd, priced.cost.pico?.toString());
    assert.equal(priced.cost.reason, null);
    const un = price(claude({ model: "nope" }));
    assert.equal(un.cost.usd, null);
    assert.equal(un.cost.reason, "unknown_model");
  });
});

// ---------------------------------------------------------------------------
// Codex pricing: R3.6, R3.10 with its four required fixtures
// ---------------------------------------------------------------------------

describe("Codex with the shipped table (scope per model)", () => {
  it("every model that is not request-scoped is unpriced long_context_scope at any input size (R3.10)", () => {
    for (const mp of DEFAULT_BOOK.models.values()) {
      if (mp.provider !== "openai" || !mp.verified || mp.long_context?.scope === "request") continue;
      for (const inTokens of [1n, 100000n, 272000n, 272001n, 300000n]) {
        const p = price(codex({ model: mp.id, usage: { i: inTokens, o: 10 } }));
        assertUnpriced(p, "unpriced_modifier", "long_context_scope");
        assert.equal(p.tokens_unpriced, inTokens + 10n);
      }
    }
  });
});

describe("Codex cost (R3.6)", () => {
  const t = cloneTable();
  withScope(t, "gpt-6-sol", "request");
  withScope(t, "gpt-5.5", "request");
  const b = book(t);

  it("worked example: normal = in - c - cw, then audit formula", () => {
    // in 1000, c 400, cw 100: normal 500
    const p = price(codex({ usage: { i: 500, r: 400, cw: 100, o: 50 } }), b);
    assert.equal(usdPico(p), 500n * 2_000_000n + 400n * 200_000n + 100n * 2_500_000n + 50n * 10_000_000n); // 1.83e9
    assert.equal(usdPico(p), 1_830_000_000n);
    assert.equal(p.rates?.row, "standard");
    assert.equal(p.rates?.cache_write, 2_500_000n);
    assert.equal(p.rates?.cache_write_5m, null);
  });

  it("reasoning tokens are never priced again (R2.8)", () => {
    const a = price(codex({ usage: { i: 500, r: 400, o: 50, reasoning: 0 } }), b);
    const c = price(codex({ usage: { i: 500, r: 400, o: 50, reasoning: 50 } }), b);
    assert.equal(usdPico(a), usdPico(c));
  });

  it("cw > 0 with a price of n/a is unpriced_modifier; cw == 0 needs no write price", () => {
    assertUnpriced(price(codex({ model: "gpt-5.5", usage: { i: 100, cw: 1, o: 1 } }), b), "unpriced_modifier", "cache_write_price_na");
    const ok = price(codex({ model: "gpt-5.5", usage: { i: 100000, r: 5, o: 100 } }), b);
    assert.equal(usdPico(ok), 100000n * 5_000_000n + 5n * 500_000n + 100n * 30_000_000n);
  });

  it("long context boundary: in <= C25 is standard, in > C25 uses the verified long-context row", () => {
    const at = price(codex({ usage: { i: 272000, o: 100 } }), b);
    assert.equal(at.rates?.row, "standard");
    assert.equal(usdPico(at), 272000n * 2_000_000n + 100n * 10_000_000n);
    const above = price(codex({ usage: { i: 272001, o: 100 } }), b);
    assert.equal(above.rates?.row, "long_context");
    assert.equal(usdPico(above), 272001n * 4_000_000n + 100n * 15_000_000n);
    // in counts the cached part too: in = i + c + cw
    const viaCached = price(codex({ usage: { i: 1, r: 272000, o: 0 } }), b);
    assert.equal(viaCached.rates?.row, "long_context");
    assert.equal(usdPico(viaCached), 1n * 4_000_000n + 272000n * 400_000n);
  });

  it("a long-context price row without a write price: cw > 0 above C25 is unpriced (R3.6)", () => {
    assertUnpriced(
      price(codex({ model: "gpt-5.5", usage: { i: 272001, cw: 1 } }), b),
      "unpriced_modifier",
      "cache_write_price_na",
    );
  });

  it("matches the independent oracle across Codex models once scope is verified", () => {
    const tt = cloneTable();
    const ids: string[] = [];
    for (const e of (tt.models as Json[]).filter((m) => m.provider === "openai" && m.verified && m.prices_usd_per_mtok)) {
      withScope(tt, e.id, "request");
      ids.push(e.id);
    }
    const bb = book(tt);
    for (const id of ids) {
      const p = (entryOf(tt, id).prices_usd_per_mtok as Record<string, string | null>);
      const shapes: U[] = [{ i: 1000, r: 0, o: 1 }, { i: 12345, r: 999, o: 77 }, { i: 5, r: 100000, o: 0 }];
      for (const s of shapes) {
        const want =
          BigInt(s.i ?? 0) * perToken(p.input!) + BigInt(s.r ?? 0) * perToken(p.cached_input!) + BigInt(s.o ?? 0) * perToken(p.output!);
        assert.equal(usdPico(price(codex({ model: id, usage: s }), bb)), want, id);
      }
    }
    assert.ok(ids.length >= 12);
  });
});

describe("R3.10 required fixtures", () => {
  const triple = (model: string) => [
    codex({ model, usage: { i: 100000, o: 100 } }),
    codex({ model, usage: { i: 300000, o: 100 } }),
    codex({ model, usage: { i: 100000, o: 100 } }),
  ];

  it("(1) session scope: all three unpriced long_context_scope", () => {
    const t = cloneTable();
    withScope(t, "gpt-6-sol", "session");
    for (const r of triple("gpt-6-sol")) assertUnpriced(price(r, book(t)), "unpriced_modifier", "long_context_scope");
  });

  it("(1) request scope with verified long-context prices: only the middle response uses the long-context row", () => {
    const t = cloneTable();
    withScope(t, "gpt-6-sol", "request");
    const [a, mid, c] = triple("gpt-6-sol").map((r) => price(r, book(t)));
    assert.equal(usdPico(a!), 100000n * 2_000_000n + 100n * 10_000_000n);
    assert.equal(a!.rates?.row, "standard");
    assert.equal(mid!.rates?.row, "long_context");
    assert.equal(usdPico(mid!), 300000n * 4_000_000n + 100n * 15_000_000n);
    assert.equal(usdPico(c!), usdPico(a!));
  });

  it("(1) request scope with unverified long-context prices: middle is unpriced, the other two are priced", () => {
    const t = cloneTable();
    withScope(t, "gpt-5.6-sol", "request");
    entryOf(t, "gpt-5.6-sol").long_context.verified = false; // long-context prices unverified for this model
    const [a, mid, c] = triple("gpt-5.6-sol").map((r) => price(r, book(t)));
    assert.equal(usdPico(a!), 100000n * 4_000_000n + 100n * 20_000_000n);
    assertUnpriced(mid!, "unpriced_modifier", "long_context_unverified");
    assert.equal(mid!.tokens_unpriced, 300100n);
    assert.equal(usdPico(c!), usdPico(a!));
  });

  it("(1) no long-context object at all behaves like an unknown scope", () => {
    const t = cloneTable();
    assert.equal(entryOf(t, "gpt-5.4-mini").long_context, null);
    assertUnpriced(price(codex({ model: "gpt-5.4-mini", usage: { i: 1000 } }), book(t)), "unpriced_modifier", "long_context_scope");
  });

  it("(2) a price never depends on files that were or were not scanned: the 100000-token response prices the same alone", () => {
    const sessionBook = (() => { const t = cloneTable(); withScope(t, "gpt-6-sol", "session"); return book(t); })();
    const requestBook = (() => { const t = cloneTable(); withScope(t, "gpt-6-sol", "request"); return book(t); })();
    const main = codex({ usage: { i: 100000, o: 100 } });
    const sub = codex({ usage: { i: 300000, o: 100 } });
    // priced alone, then priced together with the other file's response in either order: identical per response
    const alone = [price(main, sessionBook), price(main, requestBook)];
    const together = [sub, main].map((r) => [price(r, sessionBook), price(r, requestBook)]);
    assertUnpriced(alone[0]!, "unpriced_modifier", "long_context_scope");
    assertUnpriced(together[1]![0]!, "unpriced_modifier", "long_context_scope");
    assert.equal(usdPico(alone[1]!), usdPico(together[1]![1]!));
    assert.equal(usdPico(alone[1]!), 100000n * 2_000_000n + 100n * 10_000_000n);
  });

  it("(3) the audit-log case: gpt-5.5 at 100000 in and 100 out is 0.503 USD on a request scope, unpriced on a session scope, never 1.0045 USD", () => {
    const followUp = codex({ model: "gpt-5.5", usage: { i: 100000, o: 100 } });
    const unknownBig = codex({ model: "gpt-5.5", verified: false, usage: { i: 300000, o: 100 } });
    const s = cloneTable();
    withScope(s, "gpt-5.5", "session");
    assertUnpriced(price(followUp, book(s)), "unpriced_modifier", "long_context_scope");
    const r = cloneTable();
    withScope(r, "gpt-5.5", "request");
    const rb = book(r);
    assert.equal(usdPico(price(followUp, rb)), 503_000_000_000n); // 0.503 USD
    assert.equal(price(followUp, rb).cost.usd, "503000000000");
    assertUnpriced(price(unknownBig, rb), "model_unknown"); // the model-unknown response yields no dollars
    assert.notEqual(usdPico(price(followUp, rb)), 1_004_500_000_000n);
    // the long-context price of the same tokens is the 1.0045 USD figure (10 per MTok in, 45 out)
    assert.equal(100000n * 10_000_000n + 100n * 45_000_000n, 1_004_500_000_000n);
    // pricing the unverified neighbour first or last changes nothing
    const order1 = [price(unknownBig, rb), price(followUp, rb)];
    const order2 = [price(followUp, rb), price(unknownBig, rb)];
    assert.equal(order1[1]!.cost.pico, order2[0]!.cost.pico);
  });

  it("(4) an unscanned archive or coverage-only file cannot change a price: only the response and the table decide", () => {
    // The pricing function has no input but (response, book); the same call twice is byte identical.
    const t = cloneTable();
    withScope(t, "gpt-6-sol", "request");
    const b2 = book(t);
    const r = codex({ usage: { i: 123456, r: 7, o: 3 } });
    const one = price(r, b2);
    const two = price(r, b2);
    assert.equal(JSON.stringify(one, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)), JSON.stringify(two, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)));
  });
});

describe("R3.10 fixtures: every one also has a default run (R3.4 tier gate)", () => {
  /** Default run: no test parameter. Usd null, reason modifier_unverified, tokens unchanged. */
  const defaultRun = (r: CodexResponse, b: PriceBook = DEFAULT_BOOK): void => {
    const p = priceResponse(r, b);
    assertUnpriced(p, "unpriced_modifier", "modifier_unverified");
    assert.equal(p.tokens_unpriced, responseTokens(r.usage!));
  };

  it("(1) three responses at 100000, 300000, 100000: session scope, request scope, unverified long-context prices", () => {
    const triple = (model: string) => [100000, 300000, 100000].map((n) => codex({ model, usage: { i: n, o: 100 } }));
    const s = cloneTable();
    withScope(s, "gpt-6-sol", "session");
    const rq = cloneTable();
    withScope(rq, "gpt-6-sol", "request");
    const un = cloneTable();
    withScope(un, "gpt-6-sol", "request");
    entryOf(un, "gpt-6-sol").long_context.verified = false;
    const rows = (b: PriceBook) => triple("gpt-6-sol").map((r) => price(r, b));
    // test parameter on clean inputs
    for (const x of rows(book(s))) assertUnpriced(x, "unpriced_modifier", "long_context_scope");
    const [a, mid, c] = rows(book(rq));
    assert.equal(a!.rates?.row, "standard");
    assert.equal(mid!.rates?.row, "long_context");
    assert.equal(usdPico(c!), usdPico(a!));
    const [ua, umid, uc] = rows(book(un));
    assert.notEqual(ua!.cost.pico, null);
    assertUnpriced(umid!, "unpriced_modifier", "long_context_unverified");
    assert.notEqual(uc!.cost.pico, null);
    // default run on the same inputs: no dollars anywhere, reason modifier_unverified, unchanged tokens
    for (const b of [book(s), book(rq), book(un)]) for (const r of triple("gpt-6-sol")) defaultRun(r, b);
  });

  it("(2) a 100000-token response prices alone: request scope priced, session scope unpriced, default run unpriced", () => {
    const main = codex({ usage: { i: 100000, o: 100 } });
    const rq = cloneTable();
    withScope(rq, "gpt-6-sol", "request");
    const ss = cloneTable();
    withScope(ss, "gpt-6-sol", "session");
    assert.equal(usdPico(price(main, book(rq))), 100000n * perToken("2") + 100n * perToken("10"));
    assertUnpriced(price(main, book(ss)), "unpriced_modifier", "long_context_scope");
    // the absent sub-thread file or a 300000-token request elsewhere changes nothing: the call has no other input
    const sub = codex({ usage: { i: 300000, o: 100 } });
    assert.equal(usdPico(price(main, book(rq))), usdPico(price(main, book(rq))));
    assert.notEqual(price(sub, book(rq)).cost.pico, null);
    defaultRun(main, book(rq));
    defaultRun(main, book(ss));
    defaultRun(sub, book(rq));
  });

  it("(5) gpt-5.5 and gpt-6-sol at 100000 and 300000 input tokens, with the shipped table", () => {
    const row = (id: string) => entryOf(DEFAULT_TABLE as unknown as Json, id);
    const sol = row("gpt-6-sol");
    for (const n of [100000, 300000]) {
      const g55 = codex({ model: "gpt-5.5", usage: { i: n, o: 0 } });
      const g6 = codex({ model: "gpt-6-sol", usage: { i: n, o: 0 } });
      assertUnpriced(price(g55), "unpriced_modifier", "long_context_scope");
      const p = price(g6);
      const rowKind = n > 272000 ? "long_context" : "standard";
      const prices = n > 272000 ? sol.long_context.prices_usd_per_mtok : sol.prices_usd_per_mtok;
      assert.equal(p.rates?.row, rowKind);
      assert.equal(usdPico(p), BigInt(n) * perToken(prices.input));
      defaultRun(g55);
      defaultRun(g6);
    }
    // the rows the spec names: standard 2 / 0.2 / 2.5 / 10, long context 4 / 0.4 / 5 / 15
    assert.deepEqual(
      [sol.prices_usd_per_mtok.input, sol.prices_usd_per_mtok.cached_input, sol.prices_usd_per_mtok.cache_write, sol.prices_usd_per_mtok.output],
      ["2", "0.2", "2.5", "10"],
    );
    assert.deepEqual(
      [sol.long_context.prices_usd_per_mtok.input, sol.long_context.prices_usd_per_mtok.cached_input, sol.long_context.prices_usd_per_mtok.cache_write, sol.long_context.prices_usd_per_mtok.output],
      ["4", "0.4", "5", "15"],
    );
  });
});

// ---------------------------------------------------------------------------
// Arithmetic (R2.16, R3.8)
// ---------------------------------------------------------------------------

describe("arithmetic is BigInt only (R2.16, R3.8)", () => {
  it("counters at Number.MAX_SAFE_INTEGER and above stay exact", () => {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    const p = price(claude({ usage: { i: max, r: max, w5: max, w1: max, o: max } }));
    const want = max * (2_000_000n + 100_000n + 2_500_000n + 4_000_000n + 10_000_000n);
    assert.equal(usdPico(p), want);
    const big = 2n ** 64n + 1n;
    const q = price(claude({ usage: { i: big, r: big, o: big } }));
    assert.equal(usdPico(q), big * (2_000_000n + 100_000n + 10_000_000n));
    assert.equal(q.cost.usd, (big * 12_100_000n).toString());
    const sum = max * 40n; // many maximal counters summed
    const r = price(claude({ usage: { i: sum } }));
    assert.equal(usdPico(r), sum * 2_000_000n);
  });

  it("geo multiplication on huge counts is exact", () => {
    const max = BigInt(Number.MAX_SAFE_INTEGER) * 1000n;
    const p = price(claude({ model: "claude-opus-5-5", geo: "us", usage: { i: max, o: 0 } }));
    assert.equal(usdPico(p), (max * 4_000_000n * 11n) / 10n);
  });

  it("two runs over the same input give byte-identical money (R3.8)", () => {
    const shapes: U[] = [{ i: 1, r: 2, w5: 3 }, { wu: 9, o: 4 }, { i: 999999, o: null }];
    const run = () => shapes.map((s) => price(claude({ usage: s }))).map((p) => `${p.cost.usd}/${p.cost.reason}/${p.modifier_reason}`).join("|");
    assert.equal(run(), run());
  });

  it("pricing one response does not depend on any other: shuffled order gives per-response identical results", () => {
    const rs = [
      claude({ usage: { i: 10, w5: 5 } }),
      claude({ model: "claude-haiku-5-5", usage: { i: 120000 } }),
      claude({ model: "nope" }),
      claude({ role: "replayed" }),
      claude({ usage: { wu: 3, o: 1 } }),
    ];
    const forward = rs.map((r) => price(r));
    const backward = [...rs].reverse().map((r) => price(r)).reverse();
    for (let i = 0; i < rs.length; i++) {
      assert.deepEqual(forward[i], backward[i]);
    }
  });

  it("source check: no floating point in the pricing module (R3.8)", () => {
    const src = readFileSync(fileURLToPath(new URL("../../src/pricing/index.ts", import.meta.url)), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
      .join("\n");
    for (const banned of [/parseFloat/, /\.toFixed/, /Math\./, /\bNumber\(/]) {
      assert.doesNotMatch(code, banned, String(banned));
    }
  });
});

// ---------------------------------------------------------------------------
// Doc / table consistency
// ---------------------------------------------------------------------------

describe("docs/pricing.md matches the table flags it describes", () => {
  const md = readFileSync(fileURLToPath(new URL("../../docs/pricing.md", import.meta.url)), "utf8");

  it("names the table version and every verified Claude fast row", () => {
    assert.match(md, /pt-2026-10-09/);
    for (const id of ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]) assert.match(md, new RegExp(id));
    for (const mp of DEFAULT_BOOK.models.values()) {
      if (mp.fast && mp.provider === "anthropic") assert.ok(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"].includes(mp.id), mp.id);
    }
  });
});

// ---------------------------------------------------------------------------
// R3.5 defence in depth: the unknown-output refusal never fires on a fixture
// ---------------------------------------------------------------------------

describe("R3.5: the output-null refusal after row selection never fires on any fixture", () => {
  const NOW_MS = Date.UTC(2026, 5, 1);
  const OLD_MS = Date.UTC(2026, 0, 2);

  /**
   * A response with an unknown output must already be refused by a gate before the output check (tainted chain,
   * no final copy, missing modifier, tier gate). Black-box test: give the response a known zero output. If that
   * variant is priced, the refusal came from the output check itself, which the spec does not allow to be reached.
   */
  async function outputNullRefusalsOf(files: readonly GeneratedFile[], tier: "standard" | undefined): Promise<{ seen: number; reached: number }> {
    const dir = mkdtempSync(join(tmpdir(), "cw-price-"));
    try {
      writeFiles(dir, files.map((f) => ({ ...f, mtimeMs: f.mtimeMs ?? OLD_MS })));
      const found = await discover({ claudeDirs: [join(dir, "projects")], codexDirs: [dir], env: {}, home: dir });
      const analysis = await analyze(found.files, { now_ms: NOW_MS, codex_tier_for_test: tier });
      const opts = tier === "standard" ? ({ codex_tier_for_test: "standard" } as const) : undefined;
      let seen = 0;
      let reached = 0;
      for (const r of analysis.graph.responses) {
        const u = r.usage;
        if (u === null || u.output !== null) continue;
        seen++;
        const withZero = { ...r, usage: { ...u, output: 0n } } as typeof r;
        const p = priceResponse(withZero, analysis.book, opts);
        if (p.cost.pico !== null) reached++;
      }
      return { seen, reached };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("on the committed scenarios and the stored R0.9 / R2.17 fixtures, in the default run and under the tier test parameter", async () => {
    const sets: Array<{ name: string; files: GeneratedFile[] }> = [
      ...scenarios.map((sc) => ({ name: sc.name, files: sc.build() })),
      ...allR09Fixtures().map((fx) => ({ name: fx.name, files: fx.files })),
    ];
    // Output-null shapes the committed trees do not hold: no final copy, and two final copies that disagree on the output.
    const p = new ClaudeProject();
    const sess = p.session({ sessionId: "synthetic-session-out", version: "2.1.293", model: "claude-sonnet-5-5", startMs: Date.UTC(2026, 0, 1) });
    sess.main.user();
    sess.main.request({ requestId: "ok", usage: { input: 5, output: 20 } });
    sess.main.request({ requestId: "nf", finalSpeed: null, usage: { input: 5, write5m: 100, output: 7 }, blocks: [{ type: "text" }, { type: "text" }] });
    const co = sess.main.request({ requestId: "co", usage: { input: 5, output: 90 }, blocks: [{ type: "text" }, { type: "text" }] });
    ((co.records[0] as ClaudeRecord).message as { usage: { speed: string } }).usage.speed = "standard";
    sets.push({ name: "synthetic output-null shapes", files: p.files() });
    let seen = 0;
    for (const set of sets) {
      for (const tier of [undefined, "standard"] as const) {
        const r = await outputNullRefusalsOf(set.files, tier);
        assert.equal(r.reached, 0, `${set.name} (${tier ?? "default"}): an unknown-output response passed every gate`);
        seen += r.seen;
      }
    }
    assert.ok(seen > 0, "the fixtures contain responses with an unknown output, so the check is not vacuous");
  });
});

describe("R3.2 the effective multiplier object of a row, and the stored copies", () => {
  const findings = (t: Json) => auditTable(t as PricingTable).filter((f) => f.fatal).map((f) => `${f.code}@${f.path}`);

  it("the shipped table stores fast.multipliers and tiers.high_multipliers equal to the entry's, and passes", () => {
    const t = cloneTable();
    const opus = entryOf(t, "claude-opus-5-5");
    assert.deepEqual(opus.fast.multipliers, opus.multipliers);
    assert.deepEqual(entryOf(t, "claude-haiku-5-5").tiers.high_multipliers, entryOf(t, "claude-haiku-5-5").multipliers);
    assert.deepEqual(findings(t), []);
  });

  it("a corrupted stored fast.multipliers or tiers.high_multipliers is a fatal schema finding", () => {
    const f = cloneTable();
    entryOf(f, "claude-opus-5-5").fast.multipliers.cache_read = "0.5";
    assert.ok(findings(f).some((x) => x.startsWith("schema@models[") && x.endsWith(".fast.multipliers")), findings(f).join(","));
    assert.throws(() => book(f), PriceTableError);
    const h = cloneTable();
    entryOf(h, "claude-haiku-5-5").tiers.high_multipliers.cache_read = "0.5";
    assert.ok(findings(h).some((x) => x.startsWith("schema@models[") && x.endsWith(".tiers.high_multipliers")), findings(h).join(","));
    assert.throws(() => book(h), PriceTableError);
    // a missing key is a difference too
    const m = cloneTable();
    delete entryOf(m, "claude-opus-5-5").fast.multipliers.cache_write_1h;
    assert.ok(findings(m).length > 0);
  });

  it("the ratio test of a long-context row uses the multipliers stored in that row", () => {
    const t = cloneTable();
    const sol = entryOf(t, "gpt-6-sol");
    assert.ok(sol.long_context.multipliers, "the row stores its own object");
    // changing the stored object alone (the prices stay) breaks the ratio of the row against its own multipliers
    sol.long_context.multipliers.cached_input = "0.5";
    assert.ok(findings(t).some((x) => x.startsWith("ratio@") && x.includes(".long_context.")), findings(t).join(","));
    // a row that stores a different object than its entry, consistent with its own prices, is accepted
    const u = cloneTable();
    const e = entryOf(u, "gpt-6-sol");
    e.long_context.multipliers = { cached_input: "0.2", cache_write: "1.25" };
    e.long_context.prices_usd_per_mtok.cached_input = String((Number(e.long_context.prices_usd_per_mtok.input) * 0.2));
    assert.deepEqual(findings(u), []);
  });
});

describe("R3.4 fast with geo us needs geo_us_applies on the fast row", () => {
  const r = () => claude({ model: "claude-opus-5-5", speed: "fast", geo: "us", usage: { i: 1000, o: 1 } });
  it("fast.geo_us_applies false or absent, or the entry geo_us not applying: fast_geo_unverified", () => {
    for (const how of ["false", "absent", "entry"] as const) {
      const t = cloneTable();
      const e = entryOf(t, "claude-opus-5-5");
      if (how === "false") e.fast.geo_us_applies = false;
      else if (how === "absent") delete e.fast.geo_us_applies;
      else e.geo_us.applies = false;
      assertUnpriced(price(r(), book(t)), "unpriced_modifier", "fast_geo_unverified");
    }
    assert.equal(usdPico(price(r())), 8_844_000_000n);
  });
});

describe("R3.11 an effective verified_at is an ISO date", () => {
  it("a placeholder string is no date: the entry is unverified, and a scope date is no scope date", () => {
    const t = cloneTable();
    entryOf(t, "claude-opus-5-5").verified_at = "n/a";
    assert.ok(auditTable(t as PricingTable).some((f) => f.code === "r311_effective_date" && !f.fatal));
    assertUnpriced(price(claude({ model: "claude-opus-5-5" }), book(t)), "unknown_model");
  });
});
