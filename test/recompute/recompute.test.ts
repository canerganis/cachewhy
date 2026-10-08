// Tests for scripts/recompute (spec R13.1, R13.2). Every expected number below is computed by hand in the test
// from token counts and table prices; nothing here imports from src/. Fixtures come from the synthetic builder.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ClaudeProject, CodexHome, CodexThread, type GeneratedFile } from "../fixtures/builder.ts";
import { recompute, recomputeFiles, toJson, type RecomputeResult } from "../../scripts/recompute/index.mjs";

const SUPPORTED = "2.1.291";
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

// A small table in the shape of src/pricing/table.json (pt-2026-10-09 layout), written by hand.
const row = (input: string, output: string, read: string, w5: string, w1: string) => ({
  input,
  output,
  cache_read: read,
  cache_write_5m: w5,
  cache_write_1h: w1,
});
const geoOk = { applies: true, multiplier: "1.1", verified: true };
const claudeEntry = (id: string, prices: object, extra: object = {}) => ({
  id,
  provider: "anthropic",
  model_ids: [id],
  prices_usd_per_mtok: prices,
  tiers: null,
  long_context: null,
  fast: null,
  geo_us: geoOk,
  verified: true,
  verified_at: "2026-10-09",
  ...extra,
});
const gptEntry = (id: string, prices: object, lc: object | null) => ({
  id,
  provider: "openai",
  model_ids: [id],
  prices_usd_per_mtok: prices,
  tiers: null,
  long_context: lc,
  fast: null,
  geo_us: null,
  verified: true,
  verified_at: "2026-10-09",
});
const TABLE = {
  schema_version: 1,
  table_version: "pt-2026-10-09",
  verified_at: "2026-10-09",
  sources: { A1: "x", OM1: "y" },
  modifiers: { fast_with_geo_us: { verified: true } },
  models: [
    claudeEntry("claude-sonnet-5-5", row("2", "10", "0.1", "2.5", "4")),
    claudeEntry("claude-sonnet-4-5", row("3", "15", "0.3", "3.75", "6"), { geo_us: { applies: null, verified: false } }),
    claudeEntry("claude-opus-5-5", row("4", "20", "0.2", "5", "8"), {
      fast: { prices_usd_per_mtok: row("8", "40", "0.4", "10", "16"), verified: true, geo_us_applies: true },
    }),
    claudeEntry("claude-haiku-5-5", row("0.1", "0.5", "0.01", "0.125", "0.2"), {
      tiers: { split_tokens: 100000, high: row("0.5", "2.5", "0.05", "0.625", "1"), verified: true },
    }),
    gptEntry("gpt-6-sol", { input: "2", cached_input: "0.2", cache_write: "2.5", output: "10" }, {
      threshold_input_tokens: 272000,
      prices_usd_per_mtok: { input: "4", cached_input: "0.4", cache_write: "5", output: "15" },
      scope: "request",
      scope_verified: true,
      scope_source_id: "OM1",
      verified: true,
    }),
    gptEntry("gpt-6-luna", { input: "0.1", cached_input: "0.01", cache_write: "0.125", output: "0.5" }, {
      threshold_input_tokens: 272000,
      prices_usd_per_mtok: { input: "0.2", cached_input: "0.02", cache_write: "0.25", output: "0.75" },
      scope: "request",
      scope_verified: true,
      scope_source_id: "OM1",
      verified: true,
    }),
    gptEntry("gpt-5.5", { input: "5", cached_input: "0.5", cache_write: null, output: "30" }, {
      threshold_input_tokens: 272000,
      prices_usd_per_mtok: { input: "10", cached_input: "1", cache_write: null, output: "45" },
      scope: "session",
      scope_verified: true,
      scope_source_id: "OM1",
      verified: true,
    }),
    gptEntry("gpt-5.4-mini", { input: "0.75", cached_input: "0.075", cache_write: null, output: "4.5" }, null),
  ],
};

/** tokens * price (USD per MTok, decimal string) in picodollars, by hand. */
function pico(tokens: number | bigint, price: string): bigint {
  const [i = "0", f = ""] = price.split(".");
  const units = BigInt(i) * 1000000n + BigInt(f.padEnd(6, "0"));
  return BigInt(tokens) * units;
}

/** Default for these tests: the test-only Codex tier parameter is set (R3.4), so the row selection is exercised. */
function run(files: GeneratedFile[], extra: { versionPolicy?: "strict" | "all"; since?: string; until?: string; codexTierForTest?: "standard" } = {}): RecomputeResult {
  return recomputeFiles(files, { table: TABLE, codexTierForTest: "standard", ...extra });
}

function claudeSession(model = "claude-sonnet-5-5", version = SUPPORTED) {
  const p = new ClaudeProject();
  const s = p.session({ sessionId: "synthetic-session-t", version, model });
  return { p, s, m: s.main };
}

function rows(r: RecomputeResult) {
  return toJson(r, { perResponse: true, rawKeys: true }).responses as Array<Record<string, any>>;
}

function byId(r: RecomputeResult, id: string): Record<string, any> {
  const x = rows(r).find((e) => e.id === id);
  assert.ok(x, `response ${id} present`);
  return x;
}

/** Apply fn to every parsed line of the files whose path matches; fn returns the new object or null to drop it. */
function mapLines(files: GeneratedFile[], pred: (path: string) => boolean, fn: (o: any, idx: number) => any): GeneratedFile[] {
  return files.map((f) => {
    if (!pred(f.path) || typeof f.content !== "string") return f;
    const out: string[] = [];
    f.content
      .split("\n")
      .filter(Boolean)
      .forEach((l, idx) => {
        const o = fn(JSON.parse(l), idx);
        if (o !== null) out.push(JSON.stringify(o));
      });
    return { ...f, content: out.join("\n") + "\n" };
  });
}

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function shuffle<T>(a: T[], rnd: () => number): T[] {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [b[i], b[j]] = [b[j]!, b[i]!];
  }
  return b;
}

function shuffleFiles(files: GeneratedFile[], seed: number): GeneratedFile[] {
  const rnd = prng(seed);
  return shuffle(files, rnd).map((f) => {
    if (typeof f.content !== "string") return f;
    const lines = f.content.split("\n").filter(Boolean);
    return { ...f, content: shuffle(lines, rnd).join("\n") + "\n" };
  });
}

function dupLines(files: GeneratedFile[]): GeneratedFile[] {
  return files.map((f) => {
    if (typeof f.content !== "string") return f;
    const lines = f.content.split("\n").filter(Boolean);
    return { ...f, content: lines.flatMap((l, i) => (i % 2 === 0 ? [l, l] : [l])).join("\n") + "\n" };
  });
}

/** The accounting part of a result as a comparable string (physical counters left out). */
function accounting(r: RecomputeResult): string {
  const j = toJson(r, { perResponse: true, rawKeys: true });
  return JSON.stringify({ providers: j.providers, responses: j.responses });
}

describe("recompute: Claude accounting", () => {
  it("collapses copies, takes output from the final copy, prices by hand-computed units", () => {
    const { p, m } = claudeSession();
    m.user();
    // A: three copies, final one carries the real output (R4.2).
    const a = m.request({
      usage: { input: 5, write5m: 20000, output: 300 },
      blocks: [{ type: 'thinking' }, { type: 'text' }, { type: 'text' }],
    });
    // B: duplicated line must not change anything (R4.1).
    const b = m.request({ usage: { input: 8, cacheRead: 20000, write1h: 1500, output: 120 } });
    m.duplicateLast();
    const r = run(p.files());
    const t = r.providers.claude.totals;
    assert.equal(t.responses, 2);
    assert.equal(t.tokens.input_uncached, "13");
    assert.equal(t.tokens.cache_read, "20000");
    assert.equal(t.tokens.cache_write_5m, "20000");
    assert.equal(t.tokens.cache_write_1h, "1500");
    assert.equal(t.tokens.output, "420");
    const expA = pico(5, "2") + pico(20000, "2.5") + pico(300, "10");
    const expB = pico(8, "2") + pico(20000, "0.1") + pico(1500, "4") + pico(120, "10");
    assert.equal(byId(r, a.requestId).usd_pico_lo, expA.toString());
    assert.equal(byId(r, b.requestId).usd_pico_lo, expB.toString());
    assert.equal(t.usd_pico_lo, (expA + expB).toString());
    assert.equal(t.usd_pico_hi, t.usd_pico_lo);
    assert.equal(t.tokens_unpriced, "0");
    assert.equal(r.providers.claude.by_model["claude-sonnet-5-5"]?.responses, 2);
    assert.equal(r.providers.claude.by_kind["main"]?.responses, 2);
  });

  it("is invariant under line shuffle, file order and duplicated lines", () => {
    const { p, s, m } = claudeSession();
    m.user();
    m.request({ usage: { input: 5, write5m: 20000, output: 300 }, blocks: [{ type: 'thinking' }, { type: 'text' }, { type: 'tool_use', id: "synthetic-toolu-x" }] });
    m.request({ usage: { input: 8, cacheRead: 20000, write1h: 1500, output: 120 }, finalFirst: true, blocks: [{ type: 'text' }, { type: 'text' }] });
    const sa = s.spawnAgent({ model: "claude-sonnet-5-5" });
    sa.agent.thread.request({ usage: { input: 4, write5m: 8000, output: 200 } });
    const files = p.files();
    const base = accounting(run(files));
    for (let seed = 1; seed <= 6; seed += 1) assert.equal(accounting(run(shuffleFiles(files, seed))), base);
    assert.equal(accounting(run(dupLines(files))), base);
  });

  it("a response with no final copy is tokens only: modifier_unverified (R3.12), output lower bound kept", () => {
    const { p, m } = claudeSession();
    const x = m.request({ usage: { input: 5, write5m: 1000, output: 77 }, finalSpeed: null, blocks: [{ type: 'text' }, { type: 'text' }] });
    const r = run(p.files());
    const row0 = byId(r, x.requestId);
    assert.equal(row0.unpriced_reason, "modifier_unverified");
    assert.equal(row0.usd_pico_lo, null);
    assert.equal(row0.buckets.output, null);
    assert.equal(row0.buckets.output_lower_bound, "77");
    const t = r.providers.claude.totals;
    assert.equal(t.tokens.output, "0");
    assert.equal(t.tokens.output_lower_bound_unknown_output, "77");
    assert.equal(t.tokens_unpriced, String(5 + 1000 + 77));
    assert.deepEqual(r.providers.claude.unpriced_by_reason["modifier_unverified"], { responses: 1, tokens_unpriced: "1082" });
  });

  it("applies fast, geo, geo on fast, tiers and refuses unverified combinations (R3.4, R3.8)", () => {
    const { p, s } = claudeSession("claude-opus-5-5");
    const m = s.main;
    const std = m.request({ usage: { input: 10, write1h: 20000, output: 100 } });
    const fast = m.request({ usage: { input: 10, write1h: 20000, output: 100 }, finalSpeed: "fast" });
    const fastGeo = m.request({ usage: { input: 10, write1h: 20000, output: 100, inferenceGeo: "us" }, finalSpeed: "fast" });
    const batch = m.request({ usage: { input: 10, write1h: 20000, output: 100, serviceTier: "batch" } });
    const weird = m.request({ usage: { input: 10, write1h: 20000, output: 100 }, finalSpeed: "turbo" });
    const files = p.files();
    const r = run(files);
    const sumStd = pico(10, "4") + pico(20000, "8") + pico(100, "20");
    const sumFast = pico(10, "8") + pico(20000, "16") + pico(100, "40");
    assert.equal(byId(r, std.requestId).usd_pico_lo, sumStd.toString());
    assert.equal(byId(r, fast.requestId).usd_pico_lo, sumFast.toString());
    assert.equal(byId(r, fastGeo.requestId).usd_pico_lo, ((sumFast * 11n) / 10n).toString());
    assert.equal(byId(r, batch.requestId).unpriced_reason, "service_tier_unpriced");
    assert.equal(byId(r, weird.requestId).unpriced_reason, "speed_other");

    // geo on the standard row, on a model where geo is not verified, and on a table where fast_with_geo_us is not verified
    const g = claudeSession("claude-sonnet-5-5");
    const gus = g.m.request({ usage: { input: 10, write5m: 1000, output: 10, inferenceGeo: "us" } });
    const rg = run(g.p.files());
    assert.equal(byId(rg, gus.requestId).usd_pico_lo, (((pico(10, "2") + pico(1000, "2.5") + pico(10, "10")) * 11n) / 10n).toString());
    const old = claudeSession("claude-sonnet-4-5");
    const ous = old.m.request({ usage: { input: 10, write5m: 1000, output: 10, inferenceGeo: "us" } });
    assert.equal(byId(run(old.p.files()), ous.requestId).unpriced_reason, "geo_unverified");
    const noFG = { ...TABLE, modifiers: { fast_with_geo_us: { verified: false } } };
    const rn = recomputeFiles(files, { table: noFG });
    assert.equal(byId(rn, fastGeo.requestId).unpriced_reason, "fast_geo_unverified");
    assert.equal(byId(rn, fast.requestId).usd_pico_lo, sumFast.toString());
  });

  it("Haiku 5.5 tier is chosen by total_input with the C26 boundary included in the low tier", () => {
    const { p, m } = claudeSession("claude-haiku-5-5");
    const low = m.request({ usage: { input: 10, write5m: 99990, output: 10 } }); // total_input = 100000
    const high = m.request({ usage: { input: 11, write5m: 99990, output: 10 } }); // 100001
    const r = run(p.files());
    assert.equal(byId(r, low.requestId).usd_pico_lo, (pico(10, "0.1") + pico(99990, "0.125") + pico(10, "0.5")).toString());
    assert.equal(byId(r, high.requestId).usd_pico_lo, (pico(11, "0.5") + pico(99990, "0.625") + pico(10, "2.5")).toString());
  });

  it("unknown TTL writes are priced as a range, bucket mismatch keeps the bucket sum (R2.1, R3.5)", () => {
    const { p, m } = claudeSession();
    const old = m.request({ usage: { input: 5, cacheRead: 100, writeTotal: 200, omitCacheCreation: true, output: 40 } });
    const mis = m.request({ usage: { input: 5, write1h: 1796, writeTotal: 0, output: 40 } });
    const r = run(p.files());
    const o = byId(r, old.requestId);
    const base = pico(5, "2") + pico(100, "0.1") + pico(40, "10");
    assert.equal(o.usd_pico_lo, (base + pico(200, "2.5")).toString());
    assert.equal(o.usd_pico_hi, (base + pico(200, "4")).toString());
    assert.equal(o.buckets.cache_write_unknown_ttl, "200");
    const mm = byId(r, mis.requestId);
    assert.deepEqual(mm.flags, ["bucket_mismatch"]);
    assert.equal(mm.buckets.cache_write_1h, "1796");
    assert.equal(mm.usd_pico_lo, (pico(5, "2") + pico(1796, "4") + pico(40, "10")).toString());
    assert.equal(r.coverage.claude["responses_bucket_mismatch"], 1);
  });

  it("excludes conflicts and bad records instead of guessing (R2.12 to R2.15, R4.1, R4.2, R15.7)", () => {
    const { p, m } = claudeSession();
    const good = m.request({ usage: { input: 5, write5m: 100, output: 10 } });
    const cIn = m.request({ usage: { input: 5, write5m: 100, output: 10 }, blocks: [{ type: 'text' }, { type: 'text' }] });
    const cModel = m.request({ usage: { input: 5, write5m: 100, output: 10 }, blocks: [{ type: 'text' }, { type: 'text' }] });
    const rng = m.request({ usage: { input: 5, write5m: 100, output: 10 } });
    const inc = m.request({ usage: { input: 5, write5m: 100, output: 10 } });
    const kc1 = m.request({ usage: { input: 5, write5m: 100, output: 10 }, blocks: [{ type: 'text' }, { type: 'text' }] });
    const unk = m.request({ usage: { input: 5, write5m: 100, output: 10 } });
    const api = m.request({ usage: { input: 5, write5m: 100, output: 10 }, apiError: true });
    const confOut = m.request({ usage: { input: 5, write5m: 100, output: 10 }, finalSpeed: "standard", blocks: [{ type: 'text' }, { type: 'text' }] });
    const mod = m.request({ usage: { input: 5, write5m: 100, output: 10 }, blocks: [{ type: 'text' }, { type: 'text' }] });
    let files = p.files();
    const mutate = (rid: string, nth: number, fn: (o: any) => void) => {
      let seen = 0;
      files = mapLines(files, () => true, (o) => {
        if (o.requestId === rid) {
          if (seen === nth) fn(o);
          seen += 1;
        }
        return o;
      });
    };
    mutate(cIn.requestId, 0, (o) => (o.message.usage.input_tokens = 6));
    mutate(cModel.requestId, 0, (o) => (o.message.model = "claude-opus-5-5"));
    mutate(rng.requestId, 0, (o) => (o.message.usage.cache_read_input_tokens = MAX_SAFE + 1));
    mutate(inc.requestId, 0, (o) => delete o.message.usage.cache_read_input_tokens);
    mutate(kc1.requestId, 0, (o) => (o.message.id = "synthetic-msg-other"));
    mutate(unk.requestId, 0, (o) => delete o.requestId);
    // conflict_output: two final copies with different output
    mutate(confOut.requestId, 0, (o) => (o.message.usage.speed = "standard"));
    // conflict_modifier: the partial copy carries geo us while the final copy does not
    mutate(mod.requestId, 0, (o) => (o.message.usage.inference_geo = "us"));
    const r = run(files);
    assert.equal(byId(r, good.requestId).status, "counted");
    assert.equal(byId(r, cIn.requestId).status, "excluded:conflict_input");
    assert.equal(byId(r, cModel.requestId).status, "excluded:conflict_model");
    assert.equal(byId(r, rng.requestId).status, "excluded:usage_range_failed");
    assert.equal(byId(r, inc.requestId).status, "excluded:usage_incomplete");
    assert.equal(byId(r, kc1.requestId).status, "excluded:key_conflict");
    assert.equal(rows(r).some((e) => e.id === unk.requestId), false);
    assert.equal(rows(r).some((e) => e.id === api.requestId), false);
    assert.equal(byId(r, mod.requestId).unpriced_reason, "conflict_modifier");
    const co = byId(r, confOut.requestId);
    assert.equal(co.buckets.output, null); // R4.2: output unknown, tokens kept
    assert.equal(co.output_excluded, true);
    assert.equal(co.usd_pico_lo, (pico(5, "2") + pico(100, "2.5")).toString());
    assert.equal(r.coverage.claude["records_unkeyed"], 1);
    assert.equal(r.coverage.claude["api_error_records"], 1);
    assert.equal(r.coverage.claude["tokens_in_incomplete_by_field"] !== undefined, true);
    // only good, confOut and mod add to the totals (the others are removed entirely)
    assert.equal(r.providers.claude.totals.responses, 3);
  });

  it("reads nothing from versions outside the full-support table (R15.7)", () => {
    const { p, m } = claudeSession("claude-sonnet-5-5", "2.1.290");
    m.request({ usage: { input: 5, write5m: 100, output: 10 } });
    const strict = run(p.files());
    assert.equal(strict.providers.claude.totals.responses, 0);
    assert.equal(strict.coverage.claude["requests_unverified_version"], 1);
    const all = run(p.files(), { versionPolicy: "all" });
    assert.equal(all.providers.claude.totals.responses, 1);
  });

  it("counts a replayed request once and keeps its tokens whole (R4.6, R4.7, R5.8)", () => {
    const p = new ClaudeProject();
    const a = p.session({ sessionId: "synthetic-session-origin", version: SUPPORTED, model: "claude-sonnet-5-5", startMs: Date.UTC(2026, 0, 1) });
    a.main.user();
    const ra = a.main.request({ usage: { input: 5, write5m: 10000, output: 100 } });
    const b = p.session({ sessionId: "synthetic-session-fork", version: SUPPORTED, model: "claude-sonnet-5-5", startMs: Date.UTC(2026, 0, 1, 1) });
    b.main.replay(a.main.records.slice(1)); // the origin starts strictly earlier (R4.6)
    b.main.user();
    const rb = b.main.request({ usage: { input: 5, cacheRead: 10000, write5m: 700, output: 150 } });
    const files = p.files();
    // The builder's replay() writes the copying session id (R4.6, R4.11): two logical streams, one replayed copy.
    const r2 = run(files);
    assert.equal(r2.providers.claude.totals.responses, 2);
    assert.equal(r2.coverage.claude["replay_requests_excluded"], 1);
    assert.equal(r2.coverage.claude["replay_ownership_ambiguous"], 0);
    assert.equal(byId(r2, rb.requestId).status, "counted");
  });

  it("window is [since, until) on event time and baseline requests add nothing (R5.9, R5.10)", () => {
    const { p, m } = claudeSession();
    const r1 = m.request({ usage: { input: 5, write5m: 100, output: 10 } }); // 00:00:01 + steps
    m.request({ usage: { input: 5, write5m: 100, output: 10 }, dtMs: 3600_000 });
    void r1;
    const files = p.files();
    assert.equal(run(files).providers.claude.totals.responses, 2);
    const w = run(files, { since: "2026-01-01T00:30:00Z" });
    assert.equal(w.providers.claude.totals.responses, 1);
    assert.equal(w.coverage.claude["baseline_requests_loaded"], 1);
    const none = run(files, { since: "2026-01-01", until: "2026-01-01T00:00:00Z" });
    assert.equal(none.providers.claude.totals.responses, 0);
    const day = run(files, { since: "2026-01-01", until: "2026-01-02" });
    assert.equal(day.providers.claude.totals.responses, 2);
  });

  it("keeps exact BigInt sums beyond Number.MAX_SAFE_INTEGER and rejects MAX_SAFE_INTEGER + 1 (R2.15, R2.16)", () => {
    const { p, m } = claudeSession();
    const big = m.request({ usage: { input: MAX_SAFE, cacheRead: MAX_SAFE, write5m: MAX_SAFE, output: MAX_SAFE } });
    const big2 = m.request({ usage: { input: MAX_SAFE, cacheRead: MAX_SAFE, write5m: MAX_SAFE, output: MAX_SAFE } });
    const bad = m.request({ usage: { input: MAX_SAFE + 1, cacheRead: 0, write5m: 0, output: 1 } });
    const r = run(p.files());
    const M = BigInt(MAX_SAFE);
    const t = r.providers.claude.totals;
    assert.equal(t.responses, 2);
    assert.equal(t.tokens.input_uncached, (2n * M).toString());
    assert.equal(t.context_tokens, (6n * M).toString());
    const each = M * 2000000n + M * 100000n + M * 2500000n + M * 10000000n;
    assert.equal(t.usd_pico_lo, (2n * each).toString());
    assert.equal(byId(r, big.requestId).status, "counted");
    assert.equal(byId(r, big2.requestId).status, "counted");
    assert.equal(byId(r, bad.requestId).status, "excluded:usage_range_failed");
  });
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function codexFiles(build: (home: CodexHome) => void): GeneratedFile[] {
  const home = new CodexHome();
  build(home);
  return home.files();
}

describe("recompute: Codex accounting", () => {
  it("prices own_turn responses at the standard and the request-scoped long-context row (R3.6, R3.10)", () => {
    const files = codexFiles((home) => {
      const t = new CodexThread({ threadId: "synthetic-thread-a", threadSource: "user", model: "gpt-6-sol" });
      t.turnContext({ turnId: "synthetic-turn-1" });
      t.tokenUsage({ responseId: "r1", usage: { input: 1000, cached: 0, output: 100, reasoning: 10 } });
      t.tokenUsage({ responseId: "r2", usage: { input: 300000, cached: 100000, output: 1000 } });
      t.tokenUsage({ responseId: "r3", usage: { input: 272000, cached: 2000, cacheWrite: 1000, output: 5 } });
      home.add(t);
    });
    const r = run(files);
    assert.equal(byId(r, "r1").usd_pico_lo, (pico(1000, "2") + pico(100, "10")).toString());
    assert.equal(byId(r, "r1").model_source, "own_turn");
    assert.equal(byId(r, "r2").usd_pico_lo, (pico(200000, "4") + pico(100000, "0.4") + pico(1000, "15")).toString());
    // exactly C25 input stays on the standard row; cache write priced, normal = in - c - cw
    assert.equal(byId(r, "r3").usd_pico_lo, (pico(269000, "2") + pico(2000, "0.2") + pico(1000, "2.5") + pico(5, "10")).toString());
    const t = r.providers.codex.totals;
    assert.equal(t.tokens.input_uncached, String(1000 + 200000 + 269000));
    assert.equal(t.tokens.cache_read, String(102000));
    assert.equal(t.tokens.cache_write, "1000");
    assert.equal(t.tokens.output, String(100 + 1000 + 5));
    assert.equal(t.reasoning_informational, "10"); // never added to output (R2.8)
    assert.equal(t.tokens_total, String(1000 + 100 + 300000 + 1000 + 272000 + 5));
  });

  it("leaves session scope models, models without a long-context object and unknown models unpriced", () => {
    const files = codexFiles((home) => {
      const a = new CodexThread({ threadId: "synthetic-thread-s", threadSource: "user", model: "gpt-5.5" });
      a.turnContext({ turnId: "t1" });
      a.tokenUsage({ responseId: "s1", usage: { input: 100000, output: 100 } });
      const b = new CodexThread({ threadId: "synthetic-thread-m", threadSource: "user", model: "gpt-5.4-mini" });
      b.turnContext({ turnId: "t1" });
      b.tokenUsage({ responseId: "m1", usage: { input: 100, output: 10 } });
      const c = new CodexThread({ threadId: "synthetic-thread-u", threadSource: "user", model: "codex-auto-review" });
      c.turnContext({ turnId: "t1" });
      c.tokenUsage({ responseId: "u1", usage: { input: 100, output: 10 } });
      home.add(a);
      home.add(b);
      home.add(c);
    });
    const r = run(files);
    assert.equal(byId(r, "s1").unpriced_reason, "long_context_scope");
    assert.equal(byId(r, "m1").unpriced_reason, "long_context_scope");
    assert.equal(byId(r, "u1").unpriced_reason, "unknown_model");
    assert.equal(r.providers.codex.totals.responses, 3);
    assert.equal(r.providers.codex.totals.usd_pico_lo, "0");
    assert.equal(r.providers.codex.totals.tokens_unpriced, String(100100 + 110 + 110));
  });

  it("verifies models only as R2.10 and R2.17 allow", () => {
    const files = codexFiles((home) => {
      // own turn with a settings marker between context and record: unsettled
      const a = new CodexThread({ threadId: "synthetic-thread-a", threadSource: "user", model: "gpt-6-sol" });
      a.turnContext({ turnId: "T" });
      a.eventMsg("thread_settings_applied");
      a.tokenUsage({ responseId: "a1", usage: { input: 1000, output: 10 } });
      // two models inside one turn: unsettled
      const b = new CodexThread({ threadId: "synthetic-thread-b", threadSource: "user", model: "gpt-6-sol" });
      b.turnContext({ turnId: "T", model: "gpt-6-sol" });
      b.turnContext({ turnId: "T", model: "gpt-5.5" });
      b.tokenUsage({ responseId: "b1", usage: { input: 1000, output: 10 } });
      // overlap: context B of turn T2 logged before the usage record of T1: T1 is still own_turn A
      const c = new CodexThread({ threadId: "synthetic-thread-c", threadSource: "user", model: "gpt-6-sol" });
      c.turnContext({ turnId: "T1" });
      c.turnContext({ turnId: "T2", model: "gpt-5.5" });
      c.tokenUsage({ responseId: "c1", usage: { input: 1000, output: 10 }, turnId: "T1" });
      // a turn with no context of its own, two models in the stream: carried_unverified
      c.tokenUsage({ responseId: "c2", usage: { input: 1000, output: 10 }, turnId: "T3" });
      // single model, no marker, no own context: carried_verified
      const d = new CodexThread({ threadId: "synthetic-thread-d", threadSource: "user", model: "gpt-6-sol" });
      d.turnContext({ turnId: "T1" });
      d.turnContext({ turnId: "T2" });
      d.tokenUsage({ responseId: "d1", usage: { input: 1000, output: 10 }, turnId: "T3" });
      // no context at all
      const e = new CodexThread({ threadId: "synthetic-thread-e", threadSource: "user" });
      e.tokenUsage({ responseId: "e1", usage: { input: 1000, output: 10 }, turnId: "T9" });
      for (const t of [a, b, c, d, e]) home.add(t);
    });
    const r = run(files);
    const src = (id: string) => byId(r, id).model_source;
    assert.equal(src("a1"), "own_turn_unsettled");
    assert.equal(src("b1"), "own_turn_unsettled");
    assert.equal(src("c1"), "own_turn");
    assert.equal(src("c2"), "carried_unverified");
    assert.equal(src("d1"), "carried_verified");
    assert.equal(src("e1"), "none");
    assert.equal(byId(r, "a1").unpriced_reason, "model_unknown");
    assert.equal(byId(r, "d1").usd_pico_lo, (pico(1000, "2") + pico(10, "10")).toString());
    assert.equal(byId(r, "c1").usd_pico_lo, (pico(1000, "2") + pico(10, "10")).toString());
    assert.equal(r.coverage.codex["responses_model_unverified"], 4);
  });

  it("an ordinal-unverified stream carries no model (R4.12), a duplicated line is no collision", () => {
    const build = (mutate: boolean) =>
      codexFiles((home) => {
        const t = new CodexThread({ threadId: "synthetic-thread-o", threadSource: "user", model: "gpt-6-sol" });
        t.turnContext({ turnId: "T1" });
        t.tokenUsage({ responseId: "o1", usage: { input: 1000, output: 10 }, turnId: "T2" });
        home.add(t);
        void mutate;
      });
    const ok = run(build(false));
    assert.equal(byId(ok, "o1").model_source, "carried_verified");
    // duplicated line: still verified
    assert.equal(byId(run(dupLines(build(false))), "o1").model_source, "carried_verified");
    // the usage record loses its ordinal: unverified stream
    const noOrd = mapLines(build(false), () => true, (o) => {
      if (o.type === "token_usage_record") delete o.ordinal;
      return o;
    });
    assert.equal(byId(run(noOrd), "o1").model_source, "carried_unverified");
    // two contexts with the same ordinal and different models: collision
    const coll = mapLines(build(false), () => true, (o, idx) => {
      if (o.type === "turn_context") o.ordinal = 1;
      if (idx === 2) return o;
      return o;
    });
    const withSecond = coll.map((f) => ({
      ...f,
      content: typeof f.content === "string" ? f.content + JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", type: "turn_context", ordinal: 1, payload: { turn_id: "T5", model: "gpt-5.5" } }) + "\n" : f.content,
    }));
    assert.equal(byId(run(withSecond), "o1").model_source, "carried_unverified");
  });

  it("removes conflicting duplicates, bad usage and unsupported versions (R2.7, R2.12, R2.15, R4.4, R15.7)", () => {
    const files = codexFiles((home) => {
      const a = new CodexThread({ threadId: "synthetic-thread-a", threadSource: "user", model: "gpt-6-sol" });
      a.turnContext({ turnId: "T1" });
      a.tokenUsage({ responseId: "ok", usage: { input: 1000, cached: 100, output: 10 } });
      a.tokenUsage({ responseId: "inv-cached", usage: { input: 100, cached: 200, output: 10 } });
      a.tokenUsage({ responseId: "inv-rs", usage: { input: 100, output: 10, reasoning: 11 } });
      a.tokenUsage({ responseId: "inv-total", usage: { input: 100, output: 10, total: 999 } });
      a.tokenUsage({ responseId: "rng", usage: { input: 100, output: 10 } });
      a.tokenUsage({ responseId: "inc", usage: { input: 100, output: 10 } });
      a.tokenUsage({ responseId: "dup", usage: { input: 100, output: 10 } });
      a.tokenUsage({ responseId: "dup", usage: { input: 100, output: 10 }, noAccumulate: true });
      a.tokenUsage({ responseId: "conf", usage: { input: 100, output: 10 } });
      a.tokenUsage({ responseId: "conf", usage: { input: 101, output: 10 } });
      const old = new CodexThread({ threadId: "synthetic-thread-old", threadSource: "user", model: "gpt-6-sol", cliVersion: "0.154.0-alpha.6.2" });
      old.turnContext({ turnId: "T1" });
      old.tokenUsage({ responseId: "oldv", usage: { input: 5000, output: 10 } });
      home.add(a);
      home.add(old);
    });
    const edited = mapLines(files, () => true, (o) => {
      if (o.type !== "token_usage_record") return o;
      const id = o.payload.response_id;
      if (id === "rng") o.payload.usage.input_tokens = MAX_SAFE + 1;
      if (id === "inc") delete o.payload.usage.cached_input_tokens;
      return o;
    });
    // "dup": the same record twice with identical fields is one response; ordinals differ in the builder, so
    // make the second line byte-identical to the first.
    let first: string | null = null;
    const final = edited.map((f) => {
      if (typeof f.content !== "string") return f;
      const lines = f.content.split("\n").filter(Boolean);
      const out: string[] = [];
      for (const l of lines) {
        const o = JSON.parse(l);
        if (o.type === "token_usage_record" && o.payload.response_id === "dup") {
          if (first === null) first = l;
          else {
            out.push(first);
            continue;
          }
        }
        out.push(l);
      }
      return { ...f, content: out.join("\n") + "\n" };
    });
    const r = run(final);
    const st = (id: string) => byId(r, id).status;
    assert.equal(st("ok"), "counted");
    assert.equal(st("inv-cached"), "excluded:usage_invariant_failed");
    assert.equal(st("inv-rs"), "excluded:usage_invariant_failed");
    assert.equal(st("inv-total"), "excluded:usage_invariant_failed");
    assert.equal(st("rng"), "excluded:usage_range_failed");
    assert.equal(st("inc"), "excluded:usage_incomplete");
    assert.equal(st("dup"), "counted");
    assert.equal(st("conf"), "excluded:conflict_usage");
    assert.equal(rows(r).some((e) => e.id === "oldv"), false);
    assert.equal(r.coverage.codex["requests_unverified_version"], 1);
    assert.equal(r.providers.codex.totals.responses, 2);
    assert.equal(r.coverage.codex["tokens_in_invalid_responses"], String(110 + 110 + 110));
    assert.equal(byId(r, "ok").buckets.input_uncached, "900");
  });

  it("a default run prices no Codex response: tier gate modifier_unverified before the scope (R3.4, R3.6)", () => {
    const files = codexFiles((home) => {
      const a = new CodexThread({ threadId: "synthetic-thread-a", threadSource: "user", model: "gpt-6-sol" });
      a.turnContext({ turnId: "T1" });
      a.tokenUsage({ responseId: "g1", usage: { input: 100000, cached: 10, output: 100 } });
      a.tokenUsage({ responseId: "g2", usage: { input: 300000, output: 100 } });
      const b = new CodexThread({ threadId: "synthetic-thread-b", threadSource: "user", model: "gpt-5.5" });
      b.turnContext({ turnId: "T1" });
      b.tokenUsage({ responseId: "g3", usage: { input: 100000, output: 100 } });
      b.tokenUsage({ responseId: "g4", usage: { input: 300000, output: 100 } });
      home.add(a);
      home.add(b);
    });
    const dflt = recomputeFiles(files, { table: TABLE });
    for (const id of ["g1", "g2", "g3", "g4"]) assert.equal(byId(dflt, id).unpriced_reason, "modifier_unverified", id);
    assert.equal(dflt.providers.codex.totals.usd_pico_lo, "0");
    assert.equal(dflt.providers.codex.unpriced_by_reason["long_context_scope"], undefined);
    // the same tokens with the test parameter (R3.10 fixture 5): gpt-5.5 session scope never priced, gpt-6-sol priced
    const std = run(files);
    assert.equal(JSON.stringify(std.providers.codex.totals.tokens), JSON.stringify(dflt.providers.codex.totals.tokens));
    assert.equal(byId(std, "g1").usd_pico_lo, (pico(99990, "2") + pico(10, "0.2") + pico(100, "10")).toString());
    assert.equal(byId(std, "g2").usd_pico_lo, (pico(300000, "4") + pico(100, "15")).toString());
    assert.equal(byId(std, "g3").unpriced_reason, "long_context_scope");
    assert.equal(byId(std, "g4").unpriced_reason, "long_context_scope");
  });

  it("an integrity_unverified stream verifies no model through any row (R2.10 stream_unverified)", () => {
    // F1: session_meta(X), turn_context(A, T), usage record of T. F2: session_meta(Y), a usage record of X (turn T2),
    // a settings marker and turn_context(B, T). I(F2) = {X, Y}: a stream conflict.
    const x = new CodexThread({ threadId: "synthetic-thread-x", threadSource: "user", model: "gpt-6-sol" });
    x.turnContext({ turnId: "T" });
    x.tokenUsage({ responseId: "x1", usage: { input: 1000, output: 10 } });
    const y = new CodexThread({ threadId: "synthetic-thread-y", threadSource: "user", model: "gpt-6-sol" });
    y.tokenUsage({ responseId: "x2", usage: { input: 2000, output: 20 }, threadId: "synthetic-thread-x", turnId: "T2" });
    y.eventMsg("thread_settings_applied");
    y.turnContext({ turnId: "T", model: "gpt-5.5" });
    const home = new CodexHome();
    home.add(x);
    home.add(y);
    const files = home.files();
    const r = run(files);
    assert.equal(byId(r, "x1").model_source, "stream_unverified");
    assert.equal(byId(r, "x1").unpriced_reason, "model_unknown");
    assert.equal(byId(r, "x2").model_source, "stream_unverified");
    assert.equal(r.coverage.codex["files_stream_conflict"], 1);
    assert.equal(r.providers.codex.totals.tokens["input_uncached"], "3000"); // tokens stay in the totals
    assert.equal(accounting(run(shuffleFiles(files, 3))), accounting(r));
  });

  it("reads an archived .zst thread and counts it (R0.2)", () => {
    const files: GeneratedFile[] = [];
    const home = new CodexHome();
    const t = new CodexThread({ threadId: "synthetic-thread-z", threadSource: "user", model: "gpt-6-sol" });
    t.turnContext({ turnId: "T1" });
    t.tokenUsage({ responseId: "z1", usage: { input: 1000, output: 10 } });
    home.add(t, { archived: true, zstd: true });
    files.push(...home.files());
    if (files.some((f) => f.unavailable)) return; // this Node cannot write zstd
    const r = run(files);
    assert.equal(r.providers.codex.totals.responses, 1);
  });

  it("counts a file with token_count events and no usage records as without response id (R2.9)", () => {
    const t = new CodexThread({ threadId: "synthetic-thread-n", threadSource: "user" });
    t.eventMsg("token_count");
    t.eventMsg("token_count");
    const r = run(new CodexHome().files().concat(t.files()));
    assert.equal(r.coverage.codex["files_without_response_id"], 1);
    assert.equal(r.providers.codex.totals.responses, 0);
  });
});

describe("recompute: Codex forks and splits (R4.9, R4.10, R4.13)", () => {
  function forkFiles(split?: number): GeneratedFile[] {
    const home = new CodexHome();
    const parent = new CodexThread({ threadId: "synthetic-thread-p", threadSource: "user", model: "gpt-6-sol" });
    parent.turnContext({ turnId: "TP" });
    parent.responseItem("message", "user");
    parent.tokenUsage({ responseId: "p1", usage: { input: 1000, output: 10 } });
    const child = CodexThread.fork(parent, { threadId: "synthetic-thread-c", threadSource: "user", prefixLen: 2, model: "gpt-6-sol" });
    child.turnContext({ turnId: "TC1" });
    child.tokenUsage({ responseId: "c1", usage: { input: 2000, cached: 500, output: 20 } });
    child.tokenUsage({ responseId: "c2", usage: { input: 2100, cached: 2000, output: 30 }, turnId: "TC2" });
    home.add(parent);
    home.add(child, split === undefined ? {} : { splitAfter: [split] });
    return home.files();
  }

  it("prices a fork's first own response and every other one; the copied prefix adds nothing", () => {
    const r = run(forkFiles());
    assert.equal(r.providers.codex.totals.responses, 3);
    assert.equal(byId(r, "c1").status, "counted");
    assert.equal(byId(r, "c1").usd_pico_lo, (pico(1500, "2") + pico(500, "0.2") + pico(20, "10")).toString());
    assert.equal(byId(r, "c2").model_source, "carried_verified");
    assert.equal(r.coverage.codex["streams_prefix_exposed"], 0);
  });

  it("is invariant under shuffling lines and files", () => {
    const files = forkFiles();
    const base = accounting(run(files));
    for (let seed = 11; seed <= 16; seed += 1) assert.equal(accounting(run(shuffleFiles(files, seed))), base);
  });

  it("a split never changes token totals and never adds a priced response or a verified model", () => {
    const whole = run(forkFiles());
    const wholeRows = new Map(rows(whole).map((e) => [e.id as string, e]));
    const childLines = forkFiles().find((f) => f.path.includes("synthetic-thread-c"))!.content as string;
    const n = childLines.split("\n").filter(Boolean).length;
    let checked = 0;
    for (let at = 1; at < n; at += 1) {
      const files = forkFiles(at);
      // each half must keep a record with a stream identity field (R4.10): a session_meta or a usage record
      const halves = files.filter((f) => f.path.includes("synthetic-thread-c"));
      const ok = halves.every((f) => (f.content as string).split("\n").some((l) => l.includes('"session_meta"') || l.includes('"token_usage_record"')));
      if (!ok) continue;
      checked += 1;
      const r = run(files);
      assert.equal(JSON.stringify(r.providers.codex.totals.tokens), JSON.stringify(whole.providers.codex.totals.tokens), `tokens at ${at}`);
      assert.equal(r.providers.codex.totals.responses, whole.providers.codex.totals.responses);
      for (const e of rows(r)) {
        const w = wholeRows.get(e.id as string);
        assert.ok(w, `response ${e.id} exists unsplit`);
        if (e.usd_pico_lo !== null) assert.equal(e.usd_pico_lo, w.usd_pico_lo, `priced value at ${at} for ${e.id}`);
        if (e.model_source === "own_turn" || e.model_source === "carried_verified") {
          assert.ok(w.model_source === "own_turn" || w.model_source === "carried_verified", `verified model at ${at} for ${e.id}`);
        }
      }
    }
    assert.ok(checked > 3);
  });

  it("a thread split over files at every line boundary gives identical accounting (R4.10)", () => {
    const build = (split?: number): GeneratedFile[] => {
      const t = new CodexThread({ threadId: "synthetic-thread-m", threadSource: "user", model: "gpt-6-sol" });
      t.turnContext({ turnId: "T1" });
      t.tokenUsage({ responseId: "a1", usage: { input: 1000, output: 10 }, turnId: "T1" });
      t.eventMsg("thread_settings_applied");
      t.turnContext({ turnId: "T2" });
      t.tokenUsage({ responseId: "a2", usage: { input: 1100, cached: 1000, output: 20 }, turnId: "T2" });
      t.tokenUsage({ responseId: "a3", usage: { input: 1200, cached: 1100, output: 30 }, turnId: "T3" });
      t.compacted();
      t.tokenUsage({ responseId: "a4", usage: { input: 900, output: 5 }, turnId: "T2" });
      const home = new CodexHome();
      home.add(t, split === undefined ? {} : { splitAfter: [split] });
      return home.files();
    };
    const whole = run(build());
    assert.equal(byId(whole, "a1").model_source, "own_turn");
    assert.equal(byId(whole, "a2").model_source, "own_turn");
    assert.equal(byId(whole, "a3").model_source, "carried_unverified");
    const n = (build()[0]!.content as string).split(String.fromCharCode(10)).filter(Boolean).length;
    let checked = 0;
    for (let at = 1; at < n; at += 1) {
      const files = build(at);
      const keeps = files.every((f) => (f.content as string).split(String.fromCharCode(10)).some((l) => l.includes('"session_meta"') || l.includes('"token_usage_record"')));
      if (!keeps) continue;
      checked += 1;
      assert.equal(accounting(run(files)), accounting(whole), `split at ${at}`);
      assert.equal(accounting(run(shuffleFiles(files, at))), accounting(whole), `shuffled split at ${at}`);
    }
    assert.ok(checked >= 4);
  });

  it("two-model fork (R2.17 fixture 5): exact results unsplit, and no split verifies a model the whole scan does not", () => {
    const build = (childOwnModel: string, split?: number): GeneratedFile[] => {
      const home = new CodexHome();
      const parent = new CodexThread({ threadId: "synthetic-thread-p", threadSource: "user", model: "gpt-6-sol" });
      parent.turnContext({ turnId: "TP" });
      parent.tokenUsage({ responseId: "p1", usage: { input: 1000, output: 10 } });
      const child = CodexThread.fork(parent, { threadId: "synthetic-thread-c", threadSource: "user", prefixLen: 1, model: "gpt-6-sol" });
      child.turnContext({ turnId: "T1", model: childOwnModel });
      child.tokenUsage({ responseId: "c1", usage: { input: 2000, output: 20 }, turnId: "T1" });
      child.tokenUsage({ responseId: "c2", usage: { input: 2100, output: 30 }, turnId: "T2" });
      child.tokenUsage({ responseId: "c3", usage: { input: 2200, output: 40 }, turnId: "T3" });
      home.add(parent);
      home.add(child, split === undefined ? {} : { splitAfter: [split] });
      return home.files();
    };
    const mixed = run(build("gpt-6-luna"));
    assert.equal(byId(mixed, "p1").model_source, "own_turn");
    assert.equal(byId(mixed, "c1").model_source, "own_turn");
    assert.equal(byId(mixed, "c1").usd_pico_lo, (pico(2000, "0.1") + pico(20, "0.5")).toString()); // model B
    assert.equal(byId(mixed, "c2").model_source, "carried_unverified");
    assert.equal(byId(mixed, "c3").model_source, "carried_unverified");
    const same = run(build("gpt-6-sol"));
    assert.equal(byId(same, "c2").model_source, "carried_verified");
    assert.equal(byId(same, "c2").usd_pico_lo, (pico(2100, "2") + pico(30, "10")).toString());

    for (const own of ["gpt-6-luna", "gpt-6-sol"]) {
      const whole = new Map(rows(run(build(own))).map((e) => [e.id as string, e]));
      const n = (build(own).find((f) => f.path.includes("synthetic-thread-c"))!.content as string).split(String.fromCharCode(10)).filter(Boolean).length;
      let checked = 0;
      for (let at = 1; at < n; at += 1) {
        const files = build(own, at);
        const halves = files.filter((f) => f.path.includes("synthetic-thread-c"));
        if (!halves.every((f) => (f.content as string).split(String.fromCharCode(10)).some((l) => l.includes('"session_meta"') || l.includes('"token_usage_record"')))) continue;
        checked += 1;
        const r = run(files);
        for (const e of rows(r)) {
          const w = whole.get(e.id as string)!;
          if (e.model_source === "own_turn" || e.model_source === "carried_verified") {
            assert.ok(w.model_source === "own_turn" || w.model_source === "carried_verified", `${own} split ${at}: ${e.id} verified only in the split`);
            assert.equal(e.model, w.model);
          }
          if (e.usd_pico_lo !== null) assert.equal(e.usd_pico_lo, w.usd_pico_lo);
        }
        assert.equal(r.providers.codex.totals.tokens_total, run(build(own)).providers.codex.totals.tokens_total);
      }
      assert.ok(checked >= 3);
    }
  });

  it("the half holding only the copied parent session_meta makes the child prefix_exposed", () => {
    // Split the child file right after the copied parent session_meta (line index 1).
    const r = run(forkFiles(1));
    assert.equal(r.coverage.codex["files_copy_exposed"], 1);
    assert.equal(r.coverage.codex["streams_prefix_exposed"], 1);
    assert.equal(byId(r, "c1").model_source, "prefix_exposed");
    assert.equal(byId(r, "c1").unpriced_reason, "model_unknown");
    // tokens are unchanged
    assert.equal(r.providers.codex.totals.tokens["input_uncached"], run(forkFiles()).providers.codex.totals.tokens["input_uncached"]);
  });
});

describe("recompute: structure, robustness, privacy", () => {
  it("per-kind and per-model subtotals sum to the grand total (R5.8)", () => {
    const { p, s, m } = claudeSession();
    m.request({ usage: { input: 5, write5m: 1000, output: 10 } });
    const sa = s.spawnAgent({ model: "claude-sonnet-5-5" });
    sa.agent.thread.request({ usage: { input: 4, write5m: 800, output: 20 } });
    const wf = s.agent({ agentId: "synthetic-agent-wf", workflowRunId: "synthetic-run-1", omitMeta: true, model: "claude-opus-5-5" });
    wf.thread.request({ usage: { input: 3, write5m: 500, output: 30 } });
    wf.thread.request({ usage: { input: 3, write5m: 500, output: 30 }, finalSpeed: null });
    const r = run(p.files());
    const c = r.providers.claude;
    assert.deepEqual(Object.keys(c.by_kind), ["main", "subagent", "workflow_agent"]);
    const sum = (parts: Record<string, any>, f: (a: any) => string) => Object.values(parts).reduce((a, x) => a + BigInt(f(x)), 0n).toString();
    for (const parts of [c.by_kind, c.by_model]) {
      assert.equal(sum(parts, (x) => x.tokens_total), c.totals.tokens_total);
      assert.equal(sum(parts, (x) => x.usd_pico_lo), c.totals.usd_pico_lo);
      assert.equal(sum(parts, (x) => x.tokens_unpriced), c.totals.tokens_unpriced);
      assert.equal(Object.values(parts).reduce((a, x) => a + x.responses, 0), c.totals.responses);
    }
    assert.equal(c.by_kind["workflow_agent"]?.responses, 2);
  });

  it("tolerates BOM, CRLF, blank lines, garbage lines and a truncated tail without keeping error text (R1.3)", () => {
    const { p, m } = claudeSession();
    m.request({ usage: { input: 5, write5m: 100, output: 10 } });
    const f = p.files()[0]!;
    const text = (f.content as string).replace(/\n/g, "\r\n");
    const content = "﻿" + text + "\r\n\r\nnot json at all\r\n" + '{"type":"assistant","message":{"usage":{"input_tok';
    const r = run([{ ...f, content }]);
    assert.equal(r.providers.claude.totals.responses, 1);
    assert.equal(r.coverage.claude["lines_parse_error"], 1);
    assert.equal(r.coverage.claude["lines_truncated_tail"], 1);
    assert.equal(JSON.stringify(toJson(r, { perResponse: true })).includes("not json"), false);
  });

  it("never throws on odd records and prints nothing from dropped fields (R1.1, R14.7)", () => {
    const rnd = prng(7);
    const junk = [null, 5, "x", [], {}, { type: "assistant" }, { type: "assistant", message: 5 }, { type: "assistant", requestId: "q", message: { usage: 7 } }, { type: "assistant", version: SUPPORTED, requestId: "q", message: { id: 1, model: 2, usage: { input_tokens: "5", cache_creation: 3 } } }, { type: "token_usage_record", payload: 5 }, { type: "session_meta", payload: { id: 5 } }, { type: "event_msg", payload: null }, { type: "turn_context", ordinal: "x", timestamp: 5 }];
    const files: GeneratedFile[] = [
      { path: "projects/p/s.jsonl", content: shuffle(junk, rnd).map((o) => JSON.stringify(o)).join("\n") + "\n" },
      { path: "sessions/2026/01/01/rollout-2026-01-01T00-00-00-x.jsonl", content: shuffle(junk, rnd).map((o) => JSON.stringify(o)).join("\n") + "\n" },
    ];
    const r = run(files);
    assert.equal(r.providers.claude.totals.responses, 0);
    assert.equal(r.providers.codex.totals.responses, 0);
    JSON.stringify(toJson(r, { perResponse: true }));
  });

  it("prints no canary from any dropped field (R14.7)", () => {
    const hex = randomBytes(8).toString("hex");
    const canary = `CANARY_${hex}`;
    const cp = new ClaudeProject({ canary });
    const cs = cp.session({ sessionId: "synthetic-session-c", version: SUPPORTED, model: "claude-sonnet-5-5" });
    cs.main.user();
    cs.main.request({ usage: { input: 5, write5m: 100, output: 10 } });
    const home = new CodexHome({ canary });
    const t = new CodexThread({ threadId: "synthetic-thread-k", threadSource: "user", model: "gpt-6-sol" });
    t.turnContext({ turnId: "T1" });
    t.tokenUsage({ responseId: "k1", usage: { input: 100, output: 5 } });
    home.add(t);
    const r = run([...cp.files(), ...home.files()]);
    const text = JSON.stringify(toJson(r, { perResponse: true }));
    assert.equal(r.providers.claude.totals.responses, 1);
    assert.equal(r.providers.codex.totals.responses, 1);
    for (const needle of [canary, canary.toLowerCase(), hex, "synthetic-"]) assert.equal(text.includes(needle), false, needle);
  });
});

describe("recompute: command line", () => {
  it("prints a JSON document for --claude-dir and --codex-dir with --since", () => {
    const tmp = mkdtempSync(join(tmpdir(), "cachewhy-recompute-"));
    try {
      const { p, m } = claudeSession();
      m.request({ usage: { input: 5, write5m: 1000, output: 10 } });
      p.writeTo(join(tmp, "claude"));
      const home = new CodexHome();
      const t = new CodexThread({ threadId: "synthetic-thread-cli", threadSource: "user", model: "gpt-6-sol" });
      t.turnContext({ turnId: "T1" });
      t.tokenUsage({ responseId: "cli1", usage: { input: 100, output: 5 } });
      home.add(t);
      home.writeTo(join(tmp, "codex"));
      const tablePath = join(tmp, "table.json");
      writeFileSync(tablePath, JSON.stringify(TABLE));
      const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "recompute", "index.mjs");
      const out = spawnSync(process.execPath, [script, "--claude-dir", join(tmp, "claude"), "--codex-dir", join(tmp, "codex"), "--since", "2026-01-01", "--table", tablePath], { encoding: "utf8" });
      assert.equal(out.status, 0, out.stderr);
      const doc = JSON.parse(out.stdout);
      assert.equal(doc.schema, "cachewhy-recompute/1");
      assert.equal(doc.table_version, "pt-2026-10-09");
      assert.equal(doc.providers.claude.totals.responses, 1);
      assert.equal(doc.providers.codex.totals.responses, 1);
      // R3.4 tier gate: the CLI has no tier parameter, so Codex dollars stay empty and the reason is named
      assert.equal(doc.providers.codex.totals.usd_pico_lo, "0");
      assert.equal(doc.providers.codex.unpriced_by_reason.modifier_unverified.responses, 1);
      assert.equal(doc.providers.codex.totals.tokens_unpriced, "105");
      assert.equal(doc.responses, undefined);
      // the same through the directory API
      const direct = recompute({ claudeDirs: [join(tmp, "claude")], codexDirs: [join(tmp, "codex")], since: "2026-01-01", table: TABLE });
      assert.equal(JSON.stringify(toJson(direct).providers), JSON.stringify(doc.providers));
      // errors print a code, not a message
      const bad = spawnSync(process.execPath, [script, "--nope"], { encoding: "utf8" });
      assert.equal(bad.status, 2);
      assert.equal(bad.stderr.trim(), "recompute: unknown_argument");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
