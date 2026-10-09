// Tests for scripts/recompute (spec R13.1, R13.2). Every expected number below is computed by hand in the test
// from token counts and table prices; nothing here imports from src/. Fixtures come from the synthetic builder.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ClaudeProject, Clock, CodexHome, CodexThread, type GeneratedFile } from "../fixtures/builder.ts";
import * as meta from "../fixtures/metamorphic.ts";
import { allR09Fixtures, expectAt, r09Fixture6, RUN_START_MS, type R09Expect } from "../fixtures/r09.ts";
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
  modifiers: { geo_us: { verified: true }, fast_with_geo_us: { verified: true } }, // S8.2: geo us needs the table-level geo_us too
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
function run(files: GeneratedFile[], extra: { since?: string; until?: string; codexTierForTest?: "standard"; runStartMs?: number } = {}): RecomputeResult {
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
    assert.equal(byId(r, a.requestId).usd_pico, expA.toString());
    assert.equal(byId(r, b.requestId).usd_pico, expB.toString());
    assert.equal(t.usd_pico, (expA + expB).toString());
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
    assert.equal(row0.usd_pico, null);
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
    assert.equal(byId(r, std.requestId).usd_pico, sumStd.toString());
    assert.equal(byId(r, fast.requestId).usd_pico, sumFast.toString());
    assert.equal(byId(r, fastGeo.requestId).usd_pico, ((sumFast * 11n) / 10n).toString());
    assert.equal(byId(r, batch.requestId).unpriced_reason, "service_tier_unpriced");
    assert.equal(byId(r, weird.requestId).unpriced_reason, "speed_other");

    // geo on the standard row, on a model where geo is not verified, and on a table where fast_with_geo_us is not verified
    const g = claudeSession("claude-sonnet-5-5");
    const gus = g.m.request({ usage: { input: 10, write5m: 1000, output: 10, inferenceGeo: "us" } });
    const rg = run(g.p.files());
    assert.equal(byId(rg, gus.requestId).usd_pico, (((pico(10, "2") + pico(1000, "2.5") + pico(10, "10")) * 11n) / 10n).toString());
    const old = claudeSession("claude-sonnet-4-5");
    const ous = old.m.request({ usage: { input: 10, write5m: 1000, output: 10, inferenceGeo: "us" } });
    assert.equal(byId(run(old.p.files()), ous.requestId).unpriced_reason, "geo_other");
    const noFG = { ...TABLE, modifiers: { fast_with_geo_us: { verified: false } } };
    const rn = recomputeFiles(files, { table: noFG });
    assert.equal(byId(rn, fastGeo.requestId).unpriced_reason, "fast_geo_unverified");
    assert.equal(byId(rn, fast.requestId).usd_pico, sumFast.toString());
  });

  it("R3.12 fixture 2 and 5: modifiers come from the final copy; a missing geo or tier is modifier_unverified", () => {
    const { p, s } = claudeSession("claude-opus-5-5");
    const m = s.main;
    const std = m.request({ usage: { input: 0, write1h: 20000, output: 0 } });
    const fast = m.request({ usage: { input: 0, write1h: 20000, output: 0 }, finalSpeed: "fast" });
    const fastUs = m.request({ usage: { input: 0, write1h: 20000, output: 0, inferenceGeo: "us" }, finalSpeed: "fast" });
    const noGeo = m.request({ usage: { input: 0, write1h: 20000, output: 0 } });
    const noTier = m.request({ usage: { input: 0, write1h: 20000, output: 0 } });
    const noFinal = m.request({ usage: { input: 0, write1h: 20000, output: 0 }, finalSpeed: null, blocks: [{ type: "text" }, { type: "text" }] });
    let files = p.files();
    const strip = (rid: string, key: string) => {
      files = mapLines(files, () => true, (o) => {
        if (o.requestId === rid) delete o.message.usage[key];
        return o;
      });
    };
    strip(noGeo.requestId, "inference_geo");
    strip(noTier.requestId, "service_tier");
    const r = run(files);
    const h = pico(20000, "8"); // claude-opus-5-5 standard 1h write
    assert.equal(byId(r, std.requestId).usd_pico, h.toString());
    assert.equal(byId(r, fast.requestId).usd_pico, pico(20000, "16").toString());
    assert.equal(byId(r, fastUs.requestId).usd_pico, ((pico(20000, "16") * 11n) / 10n).toString());
    for (const x of [noGeo, noTier, noFinal]) {
      assert.equal(byId(r, x.requestId).usd_pico, null);
      assert.equal(byId(r, x.requestId).unpriced_reason, "modifier_unverified");
    }
    assert.equal(r.providers.claude.unpriced_by_reason["modifier_unverified"]?.responses, 3);
    // fixture 5: no final copy on a model without a fast row is unpriced as well
    const q = claudeSession("claude-sonnet-5-5");
    const nf = q.m.request({ usage: { input: 5, write5m: 100, output: 7 }, finalSpeed: null, blocks: [{ type: "text" }, { type: "text" }] });
    assert.equal(byId(run(q.p.files()), nf.requestId).unpriced_reason, "modifier_unverified");
  });


  it("Haiku 5.5 tier is chosen by total_input with the C26 boundary included in the low tier", () => {
    const { p, m } = claudeSession("claude-haiku-5-5");
    const low = m.request({ usage: { input: 10, write5m: 99990, output: 10 } }); // total_input = 100000
    const high = m.request({ usage: { input: 11, write5m: 99990, output: 10 } }); // 100001
    const r = run(p.files());
    assert.equal(byId(r, low.requestId).usd_pico, (pico(10, "0.1") + pico(99990, "0.125") + pico(10, "0.5")).toString());
    assert.equal(byId(r, high.requestId).usd_pico, (pico(11, "0.5") + pico(99990, "0.625") + pico(10, "2.5")).toString());
  });

  it("an unknown TTL write is unpriced bucket_unknown (R3.5); a bucket mismatch keeps the bucket sum and taints (R2.1, R0.9)", () => {
    const { p, m } = claudeSession();
    const old = m.request({ usage: { input: 5, cacheRead: 100, writeTotal: 200, omitCacheCreation: true, output: 40 } });
    const r = run(p.files());
    const o = byId(r, old.requestId);
    assert.equal(o.buckets.cache_write_unknown_ttl, "200");
    assert.equal(o.usd_pico, null); // no range exists: one number or none
    assert.equal(o.unpriced_reason, "bucket_unknown");
    assert.equal(o.tokens_unpriced, String(5 + 100 + 200 + 40));
    assert.equal(r.providers.claude.totals.usd_pico, "0");
    assert.deepEqual(r.providers.claude.unpriced_by_reason["bucket_unknown"], { responses: 1, tokens_unpriced: "345" });

    const q = claudeSession();
    const mis = q.m.request({ usage: { input: 5, write1h: 1796, writeTotal: 0, output: 40 } });
    const rm = run(q.p.files());
    const mm = byId(rm, mis.requestId);
    assert.deepEqual(mm.flags, ["bucket_mismatch"]);
    assert.equal(mm.buckets.cache_write_1h, "1796"); // the bucket sum is used
    assert.equal(mm.tainted, true); // R2.1: its chain yields tokens only
    assert.deepEqual(mm.taint_reasons, ["request_anomaly"]);
    assert.equal(mm.unpriced_reason, "chain_tainted");
    assert.equal(rm.coverage.claude["responses_bucket_mismatch"], 1);
  });

  describe("request anomalies taint the chains that hold a copy, not the session (R0.9 request_anomaly, revision 11.1)", () => {
    type Mut = (o: any) => void;
    const cases: Array<{
      name: string;
      blocks?: 1 | 2;
      nth: number;
      mutate: Mut;
      /** status of the anomalous response row, or null when it has no row at all */
      status: string | null;
      outputKept?: boolean;
    }> = [
      { name: "conflict_input", blocks: 2, nth: 0, mutate: (o) => (o.message.usage.input_tokens = 6), status: "excluded:conflict_input" },
      { name: "conflict_model", blocks: 2, nth: 0, mutate: (o) => (o.message.model = "claude-opus-5-5"), status: "excluded:conflict_model" },
      { name: "usage_range_failed", nth: 0, mutate: (o) => (o.message.usage.cache_read_input_tokens = MAX_SAFE + 1), status: "excluded:usage_range_failed" },
      { name: "usage_incomplete", nth: 0, mutate: (o) => delete o.message.usage.cache_read_input_tokens, status: "excluded:usage_incomplete" },
      { name: "key_conflict", blocks: 2, nth: 0, mutate: (o) => (o.message.id = "synthetic-msg-other"), status: "excluded:key_conflict" },
      { name: "unkeyed with a session", nth: 0, mutate: (o) => delete o.requestId, status: null },
      { name: "conflict_output", blocks: 2, nth: 0, mutate: (o) => (o.message.usage.speed = "standard"), status: "counted", outputKept: false },
      { name: "conflict_iterations", blocks: 2, nth: 1, mutate: (o) => (o.message.usage.iterations = [{ input_tokens: o.message.usage.input_tokens + 1 }]), status: "counted", outputKept: false },
      { name: "conflict_modifier", blocks: 2, nth: 0, mutate: (o) => (o.message.usage.inference_geo = "us"), status: "counted" },
    ];
    for (const c of cases) {
      it(`${c.name}: only the chain of the request is tainted; its linked subagent and the other session are not`, () => {
        const p = new ClaudeProject();
        const bad = p.session({ sessionId: "synthetic-session-bad", version: SUPPORTED, model: "claude-sonnet-5-5" });
        const good = bad.main.request({ requestId: "good", usage: { input: 5, write5m: 100, output: 10 } });
        const anom = bad.main.request({
          requestId: "anom",
          usage: { input: 7, write5m: 200, output: 20 },
          blocks: c.blocks === 2 ? [{ type: "text" }, { type: "text" }] : [{ type: "text" }],
        });
        const sub = bad.spawnAgent({ spawnDepth: 1, model: "claude-sonnet-5-5" }).agent.thread.request({ requestId: "sub", usage: { input: 3, write5m: 300, output: 30 } });
        const ok = p.session({ sessionId: "synthetic-session-ok", version: SUPPORTED, model: "claude-sonnet-5-5" }).main.request({ requestId: "ok", usage: { input: 9, write5m: 900, output: 90 } });
        let files = p.files();
        let seen = 0;
        files = mapLines(files, () => true, (o) => {
          if (o.requestId === anom.requestId) {
            if (seen === c.nth) c.mutate(o);
            seen += 1;
          }
          return o;
        });
        const r = run(files);
        for (const id of [good.requestId]) {
          const x = byId(r, id);
          assert.equal(x.status, "counted");
          assert.equal(x.tainted, true, id);
          assert.deepEqual(x.taint_reasons, ["request_anomaly"], id);
          assert.equal(x.model_source, "chain_tainted");
          assert.equal(x.usd_pico, null);
          assert.equal(x.unpriced_reason, "chain_tainted");
        }
        // revision 11.1: the linked subagent shares only the root session with the anomalous chain, so it stays clean
        const sb = byId(r, sub.requestId);
        assert.equal(sb.tainted, false);
        assert.equal(sb.usd_pico, (pico(3, "2") + pico(300, "2.5") + pico(30, "10")).toString());
        const o = byId(r, ok.requestId);
        assert.equal(o.tainted, false);
        assert.equal(o.usd_pico, (pico(9, "2") + pico(900, "2.5") + pico(90, "10")).toString());
        // accounting follows R4.2: conflicted input or model leaves the totals, output conflicts keep the tokens
        const row = rows(r).find((e) => e.id === anom.requestId);
        if (c.status === null) assert.equal(row, undefined);
        else {
          assert.equal(row?.status, c.status);
          if (c.status === "counted") {
            assert.equal(row?.tainted, true);
            if (c.outputKept === false) assert.equal(row?.buckets.output, null);
            assert.equal(row?.buckets.input_uncached, "7");
          }
        }
        const cov = r.coverage.claude;
        assert.equal(cov.chains_total, 3);
        assert.equal(cov.chains_tainted, 1);
        assert.equal(cov.chains_tainted_by_reason.request_anomaly, 1);
        assert.equal(cov.families_total, 2);
        assert.equal(cov.families_tainted, 1);
        const counted = c.status === "counted" ? 5 : 4; // good, the spawning request of the agent, sub, ok (and the anomalous one)
        assert.equal(cov.responses_in_tainted_chains, counted - 2); // the main chain only
        assert.equal(cov.requests_unpriced_tainted, counted - 2);
        assert.equal(r.providers.claude.totals.responses, counted);
        assert.equal(r.providers.claude.unpriced_by_reason["chain_tainted"]?.responses, counted - 2);
      });
    }
  });


  it("R0.9 fixture 2: 2.1.293, an unlisted version, then 2.1.293 again in one main chain (R15.7)", () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-mix", version: SUPPORTED, model: "claude-sonnet-5-5" });
    const a = s.main.request({ requestId: "va", usage: { input: 5, write5m: 100, output: 10 } });
    const b = s.main.request({ requestId: "vb", usage: { input: 6, write5m: 200, output: 20 } });
    const c = s.main.request({ requestId: "vc", usage: { input: 7, write5m: 300, output: 30 } });
    const other = p.session({ sessionId: "synthetic-session-clean", version: SUPPORTED, model: "claude-sonnet-5-5" }).main.request({ requestId: "vo", usage: { input: 1, write5m: 10, output: 2 } });
    const files = mapLines(p.files(), () => true, (o) => {
      if (o.requestId === b.requestId) o.version = "2.1.290";
      return o;
    });
    const r = run(files);
    // the supported requests keep their tokens in the totals, tainted and unpriced; the unlisted one adds nothing
    for (const x of [a, c]) {
      assert.equal(byId(r, x.requestId).status, "counted");
      assert.deepEqual(byId(r, x.requestId).taint_reasons, ["version_unverified"]);
      assert.equal(byId(r, x.requestId).unpriced_reason, "chain_tainted");
    }
    assert.equal(rows(r).some((e) => e.id === b.requestId), false);
    assert.equal(byId(r, other.requestId).tainted, false);
    assert.equal(r.providers.claude.totals.responses, 3);
    assert.equal(r.coverage.claude["requests_unverified_version"], 1);
    assert.equal(r.coverage.claude["lines_unverified_version"], 1);
    assert.equal(r.coverage.claude.chains_tainted_by_reason.version_unverified, 1);
    assert.equal(r.coverage.claude.chains_total, 2);
  });

  it("a request key with copies of two versions is unverified as a whole (R15.7)", () => {
    const { p, m } = claudeSession();
    const x = m.request({ requestId: "mixed", usage: { input: 5, write5m: 100, output: 10 }, blocks: [{ type: "text" }, { type: "text" }] });
    let n = 0;
    const files = mapLines(p.files(), () => true, (o) => {
      if (o.requestId === x.requestId) {
        if (n === 0) o.version = "2.1.290";
        n += 1;
      }
      return o;
    });
    const r = run(files);
    assert.equal(rows(r).length, 0, "the supported copy alone is not accounted");
    assert.equal(r.coverage.claude["requests_unverified_version"], 1);
    assert.equal(r.coverage.claude.chains_total, 1);
    assert.equal(r.coverage.claude.chains_tainted_by_reason.version_unverified, 1);
  });

  it("a whole session of an unlisted version is structurally read, tainted and not accounted (R15.7)", () => {
    const { p, m } = claudeSession("claude-sonnet-5-5", "2.1.290");
    m.request({ usage: { input: 5, write5m: 100, output: 10 } });
    const r = run(p.files());
    assert.equal(r.providers.claude.totals.responses, 0);
    assert.equal(r.coverage.claude["requests_unverified_version"], 1);
    assert.equal(r.coverage.claude.chains_total, 1);
    assert.equal(r.coverage.claude.chains_tainted, 1);
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
    // a range failure taints its session (R0.9), so it lives in a second session
    const bad = p
      .session({ sessionId: "synthetic-session-range", version: SUPPORTED, model: "claude-sonnet-5-5" })
      .main.request({ usage: { input: MAX_SAFE + 1, cacheRead: 0, write5m: 0, output: 1 } });
    const r = run(p.files());
    const M = BigInt(MAX_SAFE);
    const t = r.providers.claude.totals;
    assert.equal(t.responses, 2);
    assert.equal(t.tokens.input_uncached, (2n * M).toString());
    assert.equal(t.context_tokens, (6n * M).toString());
    const each = M * 2000000n + M * 100000n + M * 2500000n + M * 10000000n;
    assert.equal(t.usd_pico, (2n * each).toString());
    assert.equal(byId(r, big.requestId).status, "counted");
    assert.equal(byId(r, big2.requestId).status, "counted");
    assert.equal(byId(r, bad.requestId).status, "excluded:usage_range_failed");
    assert.equal(r.coverage.claude.chains_tainted, 1);
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
    assert.equal(byId(r, "r1").usd_pico, (pico(1000, "2") + pico(100, "10")).toString());
    assert.equal(byId(r, "r1").model_source, "own_turn");
    assert.equal(byId(r, "r2").usd_pico, (pico(200000, "4") + pico(100000, "0.4") + pico(1000, "15")).toString());
    // exactly C25 input stays on the standard row; cache write priced, normal = in - c - cw
    assert.equal(byId(r, "r3").usd_pico, (pico(269000, "2") + pico(2000, "0.2") + pico(1000, "2.5") + pico(5, "10")).toString());
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
      a.turnContext({ turnId: "ts" });
      a.tokenUsage({ responseId: "s1", usage: { input: 100000, output: 100 } });
      const b = new CodexThread({ threadId: "synthetic-thread-m", threadSource: "user", model: "gpt-5.4-mini" });
      b.turnContext({ turnId: "tm" });
      b.tokenUsage({ responseId: "m1", usage: { input: 100, output: 10 } });
      const c = new CodexThread({ threadId: "synthetic-thread-u", threadSource: "user", model: "codex-auto-review" });
      c.turnContext({ turnId: "tu" });
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
    assert.equal(r.providers.codex.totals.usd_pico, "0");
    assert.equal(r.providers.codex.totals.tokens_unpriced, String(100100 + 110 + 110));
  });

  it("verifies models only as R2.10 and R2.17 allow", () => {
    const files = codexFiles((home) => {
      // own turn with a settings marker between context and record: unsettled
      const a = new CodexThread({ threadId: "synthetic-thread-a", threadSource: "user", model: "gpt-6-sol" });
      a.turnContext({ turnId: "Ta" });
      a.eventMsg("thread_settings_applied");
      a.tokenUsage({ responseId: "a1", usage: { input: 1000, output: 10 } });
      // overlap: context B of turn Tc2 logged before the usage record of Tc1: Tc1 is still own_turn A
      const c = new CodexThread({ threadId: "synthetic-thread-c", threadSource: "user", model: "gpt-6-sol" });
      c.turnContext({ turnId: "Tc1" });
      c.turnContext({ turnId: "Tc2", model: "gpt-5.5" });
      c.tokenUsage({ responseId: "c1", usage: { input: 1000, output: 10 }, turnId: "Tc1" });
      // a turn with no context of its own, two models in the stream: carried_unverified
      c.tokenUsage({ responseId: "c2", usage: { input: 1000, output: 10 }, turnId: "Tc3" });
      // single model, no marker, no own context: carried_verified
      const d = new CodexThread({ threadId: "synthetic-thread-d", threadSource: "user", model: "gpt-6-sol" });
      d.turnContext({ turnId: "Td1" });
      d.turnContext({ turnId: "Td2" });
      d.tokenUsage({ responseId: "d1", usage: { input: 1000, output: 10 }, turnId: "Td3" });
      // no context at all
      const e = new CodexThread({ threadId: "synthetic-thread-e", threadSource: "user" });
      e.tokenUsage({ responseId: "e1", usage: { input: 1000, output: 10 }, turnId: "Te9" });
      for (const t of [a, c, d, e]) home.add(t);
    });
    const r = run(files);
    const src = (id: string) => byId(r, id).model_source;
    assert.equal(src("a1"), "own_turn_unsettled");
    assert.equal(src("c1"), "own_turn");
    assert.equal(src("c2"), "carried_unverified");
    assert.equal(src("d1"), "carried_verified");
    assert.equal(src("e1"), "none");
    assert.equal(byId(r, "a1").unpriced_reason, "model_unknown");
    assert.equal(byId(r, "d1").usd_pico, (pico(1000, "2") + pico(10, "10")).toString());
    assert.equal(byId(r, "c1").usd_pico, (pico(1000, "2") + pico(10, "10")).toString());
    assert.equal(r.coverage.codex["responses_model_unverified"], 3);
    assert.equal(r.coverage.codex.chains_tainted, 0);
  });

  it("R2.17 fixture 1: a second model in one turn is turn_model_conflicted, tainted, tokens only (R0.9)", () => {
    const files = codexFiles((home) => {
      const b = new CodexThread({ threadId: "synthetic-thread-b", threadSource: "user", model: "gpt-6-sol" });
      b.turnContext({ turnId: "Tb", model: "gpt-6-sol" });
      b.eventMsg("thread_settings_applied");
      b.turnContext({ turnId: "Tb", model: "gpt-5.5" });
      b.tokenUsage({ responseId: "b1", usage: { input: 1000, output: 10 }, turnId: "Tb" });
      const clean = new CodexThread({ threadId: "synthetic-thread-clean", threadSource: "user", model: "gpt-6-sol" });
      clean.turnContext({ turnId: "Tclean" });
      clean.tokenUsage({ responseId: "k1", usage: { input: 1000, output: 10 } });
      home.add(b);
      home.add(clean);
    });
    const r = run(files);
    const b1 = byId(r, "b1");
    assert.equal(b1.model_source, "chain_tainted");
    assert.deepEqual(b1.taint_reasons, ["turn_model_conflicted"]);
    assert.equal(b1.unpriced_reason, "chain_tainted");
    assert.equal(b1.buckets.input_uncached, "1000"); // tokens stay
    assert.equal(byId(r, "k1").tainted, false);
    assert.equal(byId(r, "k1").model_source, "own_turn");
    assert.equal(r.coverage.codex.chains_total, 2);
    assert.equal(r.coverage.codex.chains_tainted, 1);
    assert.equal(r.coverage.codex.chains_tainted_by_reason.turn_model_conflicted, 1);
  });

  it("a stream that fails R4.12 is ordinal_unverified and tainted; a duplicated line is no collision", () => {
    const build = () =>
      codexFiles((home) => {
        const t = new CodexThread({ threadId: "synthetic-thread-o", threadSource: "user", model: "gpt-6-sol" });
        t.turnContext({ turnId: "T1" });
        t.tokenUsage({ responseId: "o1", usage: { input: 1000, output: 10 }, turnId: "T2" });
        home.add(t);
      });
    const ok = run(build());
    assert.equal(byId(ok, "o1").model_source, "carried_verified");
    assert.equal(ok.coverage.codex.chains_tainted, 0);
    // duplicated line: still verified
    assert.equal(byId(run(dupLines(build())), "o1").model_source, "carried_verified");
    const tainted = (r: RecomputeResult) => {
      const x = byId(r, "o1");
      assert.equal(x.model_source, "chain_tainted");
      assert.deepEqual(x.taint_reasons, ["ordinal_unverified"]);
      assert.equal(x.buckets.input_uncached, "1000");
      assert.equal(r.coverage.codex.chains_tainted_by_reason.ordinal_unverified, 1);
    };
    // the usage record loses its ordinal: unverified stream
    tainted(
      run(
        mapLines(build(), () => true, (o) => {
          if (o.type === "token_usage_record") delete o.ordinal;
          return o;
        }),
      ),
    );
    // two contexts with the same ordinal and different models: collision
    const coll = mapLines(build(), () => true, (o) => {
      if (o.type === "turn_context") o.ordinal = 1;
      return o;
    });
    const withSecond = coll.map((f) => ({
      ...f,
      content: typeof f.content === "string" ? f.content + JSON.stringify({ timestamp: "2026-01-01T00:00:01.000Z", type: "turn_context", ordinal: 1, payload: { turn_id: "T5", model: "gpt-5.5" } }) + "\n" : f.content,
    }));
    tainted(run(withSecond));
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
    // R0.9: every anomaly taints its thread, so even the clean "ok" response keeps its tokens and gets no dollars;
    // the thread of the unlisted version is tainted version_unverified and adds nothing
    assert.deepEqual(byId(r, "ok").taint_reasons, ["request_anomaly"]);
    assert.equal(byId(r, "ok").unpriced_reason, "chain_tainted");
    assert.equal(r.coverage.codex.chains_tainted_by_reason.request_anomaly, 1);
    assert.equal(r.coverage.codex.chains_tainted_by_reason.version_unverified, 1);
    assert.equal(r.coverage.codex.chains_total, 2);
  });

  it("a default run prices no Codex response: tier gate modifier_unverified before the scope (R3.4, R3.6)", () => {
    const files = codexFiles((home) => {
      const a = new CodexThread({ threadId: "synthetic-thread-a", threadSource: "user", model: "gpt-6-sol" });
      a.turnContext({ turnId: "Ta" });
      a.tokenUsage({ responseId: "g1", usage: { input: 100000, cached: 10, output: 100 } });
      a.tokenUsage({ responseId: "g2", usage: { input: 300000, output: 100 } });
      const b = new CodexThread({ threadId: "synthetic-thread-b", threadSource: "user", model: "gpt-5.5" });
      b.turnContext({ turnId: "Tb" });
      b.tokenUsage({ responseId: "g3", usage: { input: 100000, output: 100 } });
      b.tokenUsage({ responseId: "g4", usage: { input: 300000, output: 100 } });
      home.add(a);
      home.add(b);
    });
    const dflt = recomputeFiles(files, { table: TABLE });
    for (const id of ["g1", "g2", "g3", "g4"]) assert.equal(byId(dflt, id).unpriced_reason, "modifier_unverified", id);
    assert.equal(dflt.providers.codex.totals.usd_pico, "0");
    assert.equal(dflt.providers.codex.unpriced_by_reason["long_context_scope"], undefined);
    // the same tokens with the test parameter (R3.10 fixture 5): gpt-5.5 session scope never priced, gpt-6-sol priced
    const std = run(files);
    assert.equal(JSON.stringify(std.providers.codex.totals.tokens), JSON.stringify(dflt.providers.codex.totals.tokens));
    assert.equal(byId(std, "g1").usd_pico, (pico(99990, "2") + pico(10, "0.2") + pico(100, "10")).toString());
    assert.equal(byId(std, "g2").usd_pico, (pico(300000, "4") + pico(100, "15")).toString());
    assert.equal(byId(std, "g3").unpriced_reason, "long_context_scope");
    assert.equal(byId(std, "g4").unpriced_reason, "long_context_scope");
  });

  it("R2.17 fixture 6: a stream conflict plus a conflicting turn model taints the families of X and Y, tokens kept", () => {
    // F1: session_meta(X), turn_context(A, T), usage record of T. F2: session_meta(Y), a usage record of X (turn T2),
    // a settings marker and turn_context(B, T). I(F2) = {X, Y}: a stream conflict, and TM(T) = {A, B}.
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
    for (const id of ["x1", "x2"]) {
      assert.equal(byId(r, id).model_source, "chain_tainted");
      assert.equal(byId(r, id).unpriced_reason, "chain_tainted");
      assert.deepEqual(byId(r, id).taint_reasons, ["stream_unresolved", "turn_model_conflicted"]);
    }
    assert.equal(r.coverage.codex["files_stream_conflict"], 1);
    assert.equal(r.coverage.codex.chains_total, 2); // X and Y
    assert.equal(r.coverage.codex.chains_tainted, 2);
    assert.equal(r.coverage.codex.families_total, 1);
    assert.equal(r.coverage.codex.families_tainted, 1);
    assert.equal(r.providers.codex.totals.tokens["input_uncached"], "3000"); // tokens stay in the totals
    assert.equal(accounting(run(shuffleFiles(files, 3))), accounting(r));
  });

  it("two own session_meta with one id that differ in session_id are stream_unresolved (R4.11)", () => {
    const a = new CodexThread({ threadId: "synthetic-thread-d", threadSource: "user", model: "gpt-6-sol", sessionId: "synthetic-session-1" });
    a.turnContext({ turnId: "Td" });
    a.tokenUsage({ responseId: "d1", usage: { input: 1000, output: 10 } });
    // a second own session_meta of the same id with another session_id, placed late so that ordinals do not collide
    const late = JSON.stringify({ timestamp: "2026-01-01T01:00:00.000Z", type: "session_meta", ordinal: 50, payload: { id: "synthetic-thread-d", session_id: "synthetic-session-2", cli_version: "0.158.0" } }) + "\n";
    const files: GeneratedFile[] = [...a.files(), { path: "sessions/2026/01/01/rollout-2026-01-01T01-00-00-synthetic-thread-d-b.jsonl", content: late }];
    const r = run(files);
    assert.deepEqual(byId(r, "d1").taint_reasons, ["stream_unresolved"]);
    assert.equal(r.coverage.codex.chains_tainted_by_reason.stream_unresolved, 1);
  });

  it("R0.9 fixture 1: the round 10 counterexample, three variants (R15.7)", () => {
    const START = Date.UTC(2026, 0, 1);
    const build = (variant: "a" | "b" | "c") => {
      const x = new CodexThread({ threadId: "synthetic-thread-x", sessionId: "synthetic-session-s", threadSource: "user", model: "gpt-6-sol", clock: new Clock(START, 1000) });
      x.turnContext({ turnId: "Tx" });
      x.tokenUsage({ responseId: "P", usage: { input: 30000, cached: 20000, output: 10 } });
      x.clock.advance(600_000);
      x.tokenUsage({ responseId: "C", usage: { input: 60000, cached: 0, output: 10 } });
      // the 0.159.0 file, between P and C in time
      const q = new CodexThread({
        threadId: variant === "a" ? "synthetic-thread-x" : "synthetic-thread-y",
        sessionId: "synthetic-session-s",
        cliVersion: "0.159.0",
        threadSource: "user",
        model: "gpt-6-sol",
        clock: new Clock(START + 60_000, 1000),
      });
      if (variant === "b") {
        q.tokenUsage({ responseId: "Q", usage: { input: 60000, cached: 60000, output: 0 } });
      } else {
        q.tokenUsage({ responseId: "Q", usage: { input: 60000, cached: 60000, output: 0 }, threadId: variant === "a" ? "synthetic-thread-x" : "synthetic-thread-y" });
      }
      let qFiles = q.files().map((f) => ({ ...f, path: f.path.replace(".jsonl", "-q.jsonl") }));
      if (variant === "b") {
        // a usage record without a thread_id
        qFiles = mapLines(qFiles, () => true, (o) => {
          if (o.type === "token_usage_record") delete o.payload.thread_id;
          return o;
        });
      }
      return [...x.files(), ...qFiles];
    };
    // (a) the 0.159.0 file holds session_meta(X): X is of an unverified version, nothing of X is accounted
    const a = run(build("a"));
    assert.equal(a.providers.codex.totals.responses, 0);
    assert.equal(a.coverage.codex["requests_unverified_version"], 3); // P, Q, C
    assert.equal(a.coverage.codex.chains_total, 1);
    assert.equal(a.coverage.codex.chains_tainted_by_reason.version_unverified, 1);
    // (b) session_meta(Y) and a usage record without a thread_id: unattributed_record taints every Codex chain
    const b = run(build("b"));
    assert.equal(b.coverage.codex.chains_total, 2);
    assert.equal(b.coverage.codex.chains_tainted, 2);
    assert.equal(b.coverage.codex.chains_tainted_by_reason.unattributed_record, 2);
    // Y is a stream of 0.159.0: version_unverified applies to Y and reaches X through the shared session_id (link i)
    assert.equal(b.coverage.codex.chains_tainted_by_reason.version_unverified, 2);
    assert.equal(b.providers.codex.totals.responses, 2); // P and C keep their tokens
    assert.equal(b.providers.codex.totals.tokens["input_uncached"], String(10000 + 60000));
    for (const id of ["P", "C"]) assert.equal(byId(b, id).unpriced_reason, "chain_tainted");
    assert.equal(b.coverage.codex["records_unkeyed"], 1);
    // (c) session_meta(Y) with readable ids: Y is unverified, the family of X and Y (shared session_id) is tainted
    const c = run(build("c"));
    assert.equal(c.coverage.codex.chains_total, 2);
    assert.equal(c.coverage.codex.families_total, 1);
    assert.equal(c.coverage.codex.chains_tainted, 2);
    assert.equal(c.coverage.codex.chains_tainted_by_reason.version_unverified, 2);
    assert.equal(c.providers.codex.totals.responses, 2);
    for (const id of ["P", "C"]) {
      assert.deepEqual(byId(c, id).taint_reasons, ["version_unverified"]);
      assert.equal(byId(c, id).usd_pico, null);
    }
    assert.equal(rows(c).some((e) => e.id === "Q"), false);
  });

  it("R0.9 fixture 4: an unreadable archive taints every Codex chain and no Claude chain; token totals are unchanged", () => {
    const home = new CodexHome();
    const t = new CodexThread({ threadId: "synthetic-thread-u", threadSource: "user", model: "gpt-6-sol" });
    t.turnContext({ turnId: "Tu" });
    t.tokenUsage({ responseId: "u1", usage: { input: 1000, output: 10 } });
    home.add(t);
    const { p, m } = claudeSession();
    m.request({ requestId: "cl1", usage: { input: 5, write5m: 100, output: 10 } });
    const bad: GeneratedFile = { path: "archived_sessions/rollout-2026-01-01T00-00-00-synthetic-thread-z.jsonl.zst", content: Buffer.from("not a zstd frame") };
    const base = run([...home.files(), ...p.files()]);
    const r = run([...home.files(), ...p.files(), bad]);
    assert.equal(r.coverage.codex["files_unreadable"], 1);
    assert.equal(r.coverage.codex.chains_tainted_by_reason.file_unreadable, 1);
    assert.equal(r.coverage.codex.chains_tainted, 1);
    assert.equal(byId(r, "u1").unpriced_reason, "chain_tainted");
    assert.equal(byId(r, "cl1").tainted, false);
    assert.equal(r.coverage.claude.chains_tainted, 0);
    assert.equal(JSON.stringify(r.providers.codex.totals.tokens), JSON.stringify(base.providers.codex.totals.tokens));
    assert.equal(JSON.stringify(r.providers.claude), JSON.stringify(base.providers.claude));
  });

  it("R0.9 fixture 5 and R2.9: a second file of the thread with only session_meta and token_count events is unlogged_usage", () => {
    const t = new CodexThread({ threadId: "synthetic-thread-n", threadSource: "user", model: "gpt-6-sol", sessionId: "synthetic-session-n" });
    t.turnContext({ turnId: "Tn" });
    t.tokenUsage({ responseId: "P", usage: { input: 30000, cached: 20000, output: 10 } });
    t.tokenUsage({ responseId: "C", usage: { input: 60000, output: 10 } });
    // the second file of the thread: session_meta and token_count events at later ordinals (no ordinal collision)
    const line = (type: string, ordinal: number, payload: object) => JSON.stringify({ timestamp: "2026-01-01T01:00:00.000Z", type, ordinal, payload }) + "\n";
    const second =
      line("session_meta", 50, { id: "synthetic-thread-n", session_id: "synthetic-session-n", cli_version: "0.158.0" }) +
      line("event_msg", 51, { type: "token_count" }) +
      line("event_msg", 52, { type: "token_count" });
    const files: GeneratedFile[] = [...t.files(), { path: "sessions/2026/01/01/rollout-2026-01-01T01-00-00-synthetic-thread-n-2.jsonl", content: second }];
    const r = run(files);
    assert.equal(r.coverage.codex["files_without_response_id"], 1);
    assert.equal(r.coverage.codex["token_count_events_without_response_id"], 2);
    assert.equal(r.coverage.codex.chains_tainted_by_reason.unlogged_usage, 1);
    assert.deepEqual(byId(r, "P").taint_reasons, ["unlogged_usage"]);
    assert.equal(r.providers.codex.totals.responses, 2);
  });

  it("R4.10 counter fixture: the five-record Codex file, every split position stored", () => {
    const t = new CodexThread({ threadId: "synthetic-thread-x", threadSource: "user", model: "gpt-6-sol" });
    t.eventMsg("token_count");
    t.turnContext({ turnId: "Tx" });
    t.tokenUsage({ responseId: "r1", usage: { input: 1000, output: 10 } });
    t.eventMsg("token_count");
    const whole = (t.files()[0]!.content as string).split("\n").filter(Boolean);
    assert.equal(whole.length, 5);
    // expected per split position: [files_without_response_id, token_count_events_without_response_id, X tainted]
    const expected: Record<number, [number, number, boolean]> = { 1: [0, 0, false], 2: [1, 1, true], 3: [1, 1, true], 4: [0, 0, false] };
    const un = run(t.files());
    assert.equal(un.coverage.codex["files_without_response_id"], 0);
    assert.equal(un.coverage.codex.chains_tainted, 0);
    for (let at = 1; at <= 4; at += 1) {
      const files: GeneratedFile[] = [
        { path: "sessions/2026/01/01/rollout-a.jsonl", content: whole.slice(0, at).join("\n") + "\n" },
        { path: "sessions/2026/01/01/rollout-b.jsonl", content: whole.slice(at).join("\n") + "\n" },
      ];
      const r = run(files);
      const [fw, ev, tainted] = expected[at]!;
      // split after record 4 leaves the second half with only a token_count event and no chain-naming record: the
      // half is not valid for R4.10 (each half must name a chain); its unlogged_usage taints the provider
      if (at === 4) {
        assert.equal(r.coverage.codex["files_without_response_id"], 1);
        assert.equal(r.coverage.codex.chains_tainted_by_reason.unlogged_usage, 1);
        continue;
      }
      assert.equal(r.coverage.codex["files_without_response_id"], fw, `files_without_response_id at ${at}`);
      assert.equal(r.coverage.codex["token_count_events_without_response_id"], ev, `events at ${at}`);
      assert.equal(r.coverage.codex.chains_tainted > 0, tainted, `X tainted at ${at}`);
      assert.equal(r.providers.codex.totals.tokens_total, un.providers.codex.totals.tokens_total, `tokens at ${at}`);
    }
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
    assert.equal(byId(r, "c1").usd_pico, (pico(1500, "2") + pico(500, "0.2") + pico(20, "10")).toString());
    assert.equal(byId(r, "c2").model_source, "carried_verified");
    assert.equal(r.coverage.codex.chains_tainted, 0);
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
        if (e.usd_pico !== null) assert.equal(e.usd_pico, w.usd_pico, `priced value at ${at} for ${e.id}`);
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
    assert.equal(byId(mixed, "c1").usd_pico, (pico(2000, "0.1") + pico(20, "0.5")).toString()); // model B
    assert.equal(byId(mixed, "c2").model_source, "carried_unverified");
    assert.equal(byId(mixed, "c3").model_source, "carried_unverified");
    const same = run(build("gpt-6-sol"));
    assert.equal(byId(same, "c2").model_source, "carried_verified");
    assert.equal(byId(same, "c2").usd_pico, (pico(2100, "2") + pico(30, "10")).toString());

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
          if (e.usd_pico !== null) assert.equal(e.usd_pico, w.usd_pico);
        }
        assert.equal(r.providers.codex.totals.tokens_total, run(build(own)).providers.codex.totals.tokens_total);
      }
      assert.ok(checked >= 3);
    }
  });

  it("the half holding only the copied parent session_meta is copy_exposed and taints the family of parent and child (R4.13)", () => {
    const whole = run(forkFiles());
    assert.equal(whole.coverage.codex.chains_tainted, 0);
    assert.equal(byId(whole, "p1").model_source, "own_turn");
    // Split the child file right after the copied parent session_meta (line index 1).
    const r = run(forkFiles(1));
    assert.equal(r.coverage.codex["files_copy_exposed"], 1);
    assert.equal(r.coverage.codex.chains_tainted_by_reason.copy_exposed, 2); // parent and child, one family
    assert.equal(r.coverage.codex.families_total, 1);
    for (const id of ["p1", "c1", "c2"]) {
      assert.equal(byId(r, id).model_source, "chain_tainted", id);
      assert.ok(byId(r, id).taint_reasons.includes("copy_exposed"), id);
      assert.equal(byId(r, id).unpriced_reason, "chain_tainted", id);
    }
    // tokens are unchanged
    assert.equal(r.providers.codex.totals.tokens["input_uncached"], whole.providers.codex.totals.tokens["input_uncached"]);
  });

  it("R15.7: a coverage-only file that forks a supported file with no usage record makes it copy_exposed", () => {
    // The supported file holds an own session_meta of X and no token_usage_record of X (a bare context file);
    // a coverage-only file (unlisted version) holds a session_meta that forks X. Nothing of it is accounted.
    const x = new CodexThread({ threadId: "synthetic-thread-x", threadSource: "user", model: "gpt-6-sol" });
    x.turnContext({ turnId: "Tx" });
    const other = new CodexThread({ threadId: "synthetic-thread-w", threadSource: "user", model: "gpt-6-sol" });
    other.turnContext({ turnId: "Tw" });
    other.tokenUsage({ responseId: "w1", usage: { input: 500, output: 5 } });
    const cov = new CodexThread({ threadId: "synthetic-thread-f", cliVersion: "0.154.0-alpha.6.2", forkedFromId: "synthetic-thread-x", emitMeta: false });
    cov.sessionMeta();
    cov.tokenUsage({ responseId: "f1", usage: { input: 9000, output: 90 } });
    const r = run([...x.files(), ...other.files(), ...cov.files()]);
    assert.equal(r.coverage.codex["files_copy_exposed"], 1);
    assert.equal(r.coverage.codex.chains_tainted_by_reason.copy_exposed, 2); // X and F share a family
    assert.equal(r.coverage.codex["requests_unverified_version"], 1);
    assert.equal(rows(r).some((e) => e.id === "f1"), false, "the coverage-only file adds nothing to any total");
    assert.equal(r.providers.codex.totals.responses, 1);
    assert.equal(byId(r, "w1").tainted, false);
  });
});


// ---------------------------------------------------------------------------
// R0.9 global integrity abstention
// ---------------------------------------------------------------------------

const RUN = Date.UTC(2026, 5, 1);
const C35_MS = 600_000;

/** Give the files whose path matches the given modification time (R0.9 live test). */
function withMtime(files: GeneratedFile[], pred: (path: string) => boolean, mtimeMs: number): Array<GeneratedFile & { mtimeMs?: number }> {
  return files.map((f) => (pred(f.path) ? { ...f, mtimeMs } : f));
}

/** Append raw text to the content of the files whose path matches. */
function appendRaw(files: GeneratedFile[], pred: (path: string) => boolean, text: string): GeneratedFile[] {
  return files.map((f) => (pred(f.path) && typeof f.content === "string" ? { ...f, content: f.content + text } : f));
}

/** Two Claude sessions. Session A: main + one agent. Session B: main only. */
function claudeTwo() {
  const p = new ClaudeProject();
  const a = p.session({ sessionId: "synthetic-session-a", version: SUPPORTED, model: "claude-sonnet-5-5" });
  a.main.request({ requestId: "a-main", usage: { input: 5, write5m: 100, output: 10 } });
  const agent = a.spawnAgent({ agentId: "synthetic-agent-a1", spawnDepth: 1 });
  agent.agent.thread.request({ requestId: "a-sub", usage: { input: 3, write5m: 300, output: 30 } });
  const b = p.session({ sessionId: "synthetic-session-b", version: SUPPORTED, model: "claude-sonnet-5-5" });
  b.main.request({ requestId: "b-main", usage: { input: 9, write5m: 900, output: 90 } });
  const files = p.files();
  const isAgentFile = (path: string) => path.includes("agent-synthetic-agent-a1.jsonl");
  return { p, files, isAgentFile };
}

describe("recompute: global integrity abstention (R0.9)", () => {
  it("fixture 3: a parse error line in one subagent file taints every chain of that session, a second session stays clean", () => {
    const { files, isAgentFile } = claudeTwo();
    const bad = appendRaw(files, isAgentFile, "this is not json\n");
    const r = run(bad, { runStartMs: RUN });
    for (const id of ["a-main", "a-sub"]) {
      assert.deepEqual(byId(r, id).taint_reasons, ["unparsed_line"], id);
      assert.equal(byId(r, id).unpriced_reason, "chain_tainted", id);
    }
    assert.equal(byId(r, "b-main").tainted, false);
    assert.equal(byId(r, "b-main").usd_pico, (pico(9, "2") + pico(900, "2.5") + pico(90, "10")).toString());
    assert.equal(r.coverage.claude["lines_parse_error"], 1);
    assert.equal(r.coverage.claude.chains_total, 3);
    assert.equal(r.coverage.claude.chains_tainted, 2);
    assert.equal(r.coverage.claude.chains_tainted_by_reason.unparsed_line, 2);
    assert.equal(r.coverage.claude.families_total, 2);
    assert.equal(r.coverage.claude.families_tainted, 1);
    // a truncated tail (no terminating newline) is the same
    const tail = appendRaw(files, isAgentFile, '{"type":"assistant","message":{"usage":{"input_tok');
    const rt = run(tail, { runStartMs: RUN });
    assert.equal(rt.coverage.claude["lines_truncated_tail"], 1);
    assert.deepEqual(byId(rt, "a-sub").taint_reasons, ["unparsed_line"]);
    assert.equal(byId(rt, "b-main").tainted, false);
    // tokens are identical to the clean scan
    const clean = run(files, { runStartMs: RUN });
    assert.equal(JSON.stringify(r.providers.claude.totals.tokens), JSON.stringify(clean.providers.claude.totals.tokens));
  });

  it("a broken or empty sidecar (meta.json) names no chain and taints the provider (ambiguity 1)", () => {
    const { files } = claudeTwo();
    const broken = files.map((f) => (f.path.endsWith(".meta.json") ? { ...f, content: '{"toolUseId":"synthetic-toolu' } : f));
    const r = run(broken, { runStartMs: RUN });
    assert.equal(r.coverage.claude["sidecar_files_unparsed"], 1);
    for (const id of ["a-main", "a-sub", "b-main"]) assert.deepEqual(byId(r, id).taint_reasons, ["unparsed_line"], id);
    assert.equal(r.coverage.claude.chains_tainted, r.coverage.claude.chains_total);
    // a pretty-printed valid sidecar is fine
    const pretty = files.map((f) => (f.path.endsWith(".meta.json") ? { ...f, content: JSON.stringify(JSON.parse(f.content as string), null, 2) } : f));
    assert.equal(run(pretty, { runStartMs: RUN }).coverage.claude.chains_tainted, 0);
  });

  it("live files (C35): exactly 600 s before the run start is live, 600 s + 1 ms is not, a later mtime is live", () => {
    const { files, isAgentFile } = claudeTwo();
    const bad = appendRaw(files, isAgentFile, '{"truncated');
    const clean = run(files, { runStartMs: RUN });
    for (const [mtime, live] of [
      [RUN - C35_MS, true],
      [RUN - C35_MS - 1, false],
      [RUN - 1, true],
      [RUN + 5 * C35_MS, true],
    ] as const) {
      const r = run(withMtime(bad, isAgentFile, mtime), { runStartMs: RUN });
      const c = r.coverage.claude;
      if (live) {
        // the whole family of the chain named by the live file is skipped and counted; the other session is unchanged
        assert.equal(r.providers.claude.totals.responses, 1, `mtime ${mtime - RUN}`);
        assert.equal(rows(r).filter((e) => e.live_skipped).length, 3);
        assert.equal(c.families_live_skipped, 1);
        assert.equal(c.responses_live_skipped, 3);
        // everything of session A: the whole scan minus session B (9 + 900 + 90)
        assert.equal(c.tokens_live_skipped, (BigInt(clean.providers.claude.totals.tokens_total) - 999n).toString());
        assert.equal(c.chains_total, 1);
        assert.equal(c.families_total, 1);
        assert.equal(c.chains_tainted, 0);
        assert.equal(c.chains_tainted_by_reason.unparsed_line, 0, "a live file gives no unparsed_line taint");
        assert.equal(byId(r, "b-main").usd_pico, byId(clean, "b-main").usd_pico);
        assert.equal(byId(r, "a-main").status, "live_skipped");
        assert.equal(byId(r, "a-main").live_skipped, true);
      } else {
        assert.equal(c.families_live_skipped, 0, `mtime ${mtime - RUN}`);
        assert.equal(r.providers.claude.totals.responses, 4);
        assert.deepEqual(byId(r, "a-sub").taint_reasons, ["unparsed_line"]);
      }
    }
  });

  it("a file with an unparseable line that names no chain is never live and taints the provider", () => {
    const { files } = claudeTwo();
    const junk: GeneratedFile = { path: "projects/synthetic-project/synthetic-session-z.jsonl", content: "garbage\n" };
    const r = run(withMtime([...files, junk], (p) => p === junk.path, RUN), { runStartMs: RUN });
    assert.equal(r.coverage.claude.families_live_skipped, 0);
    assert.equal(r.coverage.claude.chains_tainted, r.coverage.claude.chains_total);
    assert.deepEqual(byId(r, "b-main").taint_reasons, ["unparsed_line"]);
  });

  it("without a file modification time nothing is live (R5.9: a modification time never includes or excludes a file)", () => {
    const { files, isAgentFile } = claudeTwo();
    const r = run(appendRaw(files, isAgentFile, "garbage\n"), { runStartMs: RUN });
    assert.equal(r.coverage.claude.families_live_skipped, 0);
    assert.equal(r.providers.claude.totals.responses, 4);
  });

  it("R0.9 fixture 6: a clean family next to a tainted one equals a scan of the clean family alone", () => {
    const { p, files, isAgentFile } = claudeTwo();
    void p;
    const tainted = appendRaw(files, isAgentFile, "garbage\n");
    const mixed = run(tainted, { runStartMs: RUN });
    const alone = run(files.filter((f) => !f.path.includes("synthetic-session-a")), { runStartMs: RUN });
    const pick = (r: RecomputeResult) => JSON.stringify(rows(r).filter((e) => e.id === "b-main"));
    assert.equal(pick(mixed), pick(alone));
    assert.equal(mixed.providers.claude.totals.responses, 4);
    assert.equal(alone.providers.claude.totals.usd_pico, byId(mixed, "b-main").usd_pico);
  });

  it("an assistant record without a string sessionId is unattributed: no accounting, the provider is tainted", () => {
    const { files, isAgentFile } = claudeTwo();
    const r = run(
      files.map((f) => {
        if (!isAgentFile(f.path) || typeof f.content !== "string") return f;
        return { ...f, content: f.content.split("\n").filter(Boolean).map((l) => { const o = JSON.parse(l); delete o.sessionId; return JSON.stringify(o); }).join("\n") + "\n" };
      }),
      { runStartMs: RUN },
    );
    // identity never comes from the path: the agent file's records join no chain and add nothing
    assert.equal(rows(r).some((e) => e.id === "a-sub"), false);
    assert.equal(r.coverage.claude.chains_total, 2); // sessions A (main) and B
    assert.equal(r.coverage.claude.chains_tainted, 2);
    assert.equal(r.coverage.claude.chains_tainted_by_reason.unattributed_record, 2);
    assert.equal(byId(r, "b-main").unpriced_reason, "chain_tainted");
  });

  it("an ownership tie (R4.6) taints every chain that holds a copy", () => {
    const p = new ClaudeProject();
    const t0 = Date.UTC(2026, 0, 1);
    const a = p.session({ sessionId: "synthetic-session-m", version: SUPPORTED, model: "claude-sonnet-5-5", startMs: t0 });
    a.main.user();
    const ra = a.main.request({ requestId: "tie", usage: { input: 5, write5m: 1000, output: 10 } });
    const b = p.session({ sessionId: "synthetic-session-n", version: SUPPORTED, model: "claude-sonnet-5-5", startMs: t0 });
    b.main.replay(a.main.records); // the whole record list: both streams start at the same instant
    const c = p.session({ sessionId: "synthetic-session-o", version: SUPPORTED, model: "claude-sonnet-5-5", startMs: t0 + 86_400_000 });
    c.main.request({ requestId: "other", usage: { input: 1, write5m: 10, output: 1 } });
    const r = run(p.files(), { runStartMs: RUN });
    assert.equal(r.coverage.claude["replay_ownership_ambiguous"], 1);
    assert.equal(byId(r, ra.requestId).tainted, true);
    assert.deepEqual(byId(r, ra.requestId).taint_reasons, ["ownership_ambiguous"]);
    assert.equal(r.coverage.claude.chains_tainted_by_reason.ownership_ambiguous, 2);
    assert.equal(byId(r, "other").tainted, false);
    assert.equal(r.providers.claude.totals.responses, 2, "the tokens are counted once");
  });

  it("family links: a shared request key (iii) carries a taint across sessions, a shared sessionId (i) across agents", () => {
    const p = new ClaudeProject();
    const a = p.session({ sessionId: "synthetic-session-a", version: SUPPORTED, model: "claude-sonnet-5-5", startMs: Date.UTC(2026, 0, 1) });
    a.main.user();
    const shared = a.main.request({ requestId: "shared", usage: { input: 5, write5m: 1000, output: 10 } });
    const bad = a.main.request({ requestId: "bad", usage: { input: 5, write5m: 100, output: 10, cacheRead: MAX_SAFE + 1 } });
    const b = p.session({ sessionId: "synthetic-session-b", version: SUPPORTED, model: "claude-sonnet-5-5", startMs: Date.UTC(2026, 0, 2) });
    b.main.replay(shared.records);
    b.main.request({ requestId: "b-own", usage: { input: 2, write5m: 20, output: 2 } });
    const c = p.session({ sessionId: "synthetic-session-c", version: SUPPORTED, model: "claude-sonnet-5-5", startMs: Date.UTC(2026, 0, 3) });
    c.main.request({ requestId: "c-own", usage: { input: 1, write5m: 10, output: 1 } });
    const r = run(p.files(), { runStartMs: RUN });
    assert.equal(rows(r).find((e) => e.id === bad.requestId)?.status, "excluded:usage_range_failed");
    // A and B share the key `shared`: one family, tainted by the anomaly in A
    assert.deepEqual(byId(r, "b-own").taint_reasons, ["request_anomaly"]);
    assert.deepEqual(byId(r, "shared").taint_reasons, ["request_anomaly"]);
    assert.equal(byId(r, "c-own").tainted, false);
    assert.equal(r.coverage.claude.chains_total, 3);
    assert.equal(r.coverage.claude.families_total, 2);
    assert.equal(r.coverage.claude.families_tainted, 1);
  });

  it("Codex: fork edges (ii), a shared session_id (i) and a shared response_id (iii) make families", () => {
    const home = new CodexHome();
    const parent = new CodexThread({ threadId: "synthetic-thread-p", sessionId: "synthetic-session-1", threadSource: "user", model: "gpt-6-sol" });
    parent.turnContext({ turnId: "Tp" });
    parent.tokenUsage({ responseId: "p1", usage: { input: 1000, output: 10 } });
    const child = new CodexThread({ threadId: "synthetic-thread-c", sessionId: "synthetic-session-9", threadSource: "subagent", threadSpawn: { parentThreadId: "synthetic-thread-p" }, model: "gpt-6-sol" });
    child.turnContext({ turnId: "Tc" });
    child.tokenUsage({ responseId: "c1", usage: { input: 1000, output: 10 } });
    const sess = new CodexThread({ threadId: "synthetic-thread-s", sessionId: "synthetic-session-1", threadSource: "user", model: "gpt-6-sol" });
    sess.turnContext({ turnId: "Ts" });
    sess.tokenUsage({ responseId: "s1", usage: { input: 1000, output: 10 } });
    const lone = new CodexThread({ threadId: "synthetic-thread-l", sessionId: "synthetic-session-5", threadSource: "user", model: "gpt-6-sol" });
    lone.turnContext({ turnId: "Tl" });
    lone.tokenUsage({ responseId: "l1", usage: { input: 1000, output: 10 } });
    for (const t of [parent, child, sess, lone]) home.add(t);
    // taint the spawn child with an invariant failure: parent (edge ii) and sess (shared session i with the parent) follow
    const files = mapLines(home.files(), () => true, (o) => {
      if (o.type === "token_usage_record" && o.payload.response_id === "c1") o.payload.usage.total_tokens = 7;
      return o;
    });
    const r = run(files, { runStartMs: RUN });
    assert.equal(byId(r, "c1").status, "excluded:usage_invariant_failed");
    for (const id of ["p1", "s1"]) assert.deepEqual(byId(r, id).taint_reasons, ["request_anomaly"], id);
    assert.equal(byId(r, "l1").tainted, false);
    assert.equal(r.coverage.codex.chains_total, 4);
    assert.equal(r.coverage.codex.families_total, 2);
    assert.equal(r.coverage.codex.chains_tainted, 3);
    // (iii) the same response id in two threads: both threads are one family, and a conflict names both
    const h2 = new CodexHome();
    const x = new CodexThread({ threadId: "synthetic-thread-x", threadSource: "user", model: "gpt-6-sol" });
    x.turnContext({ turnId: "Tx" });
    x.tokenUsage({ responseId: "same", usage: { input: 1000, output: 10 } });
    const y = new CodexThread({ threadId: "synthetic-thread-y", threadSource: "user", model: "gpt-6-sol" });
    y.turnContext({ turnId: "Ty" });
    y.tokenUsage({ responseId: "same", usage: { input: 1000, output: 10 } });
    const z = new CodexThread({ threadId: "synthetic-thread-z", threadSource: "user", model: "gpt-6-sol" });
    z.turnContext({ turnId: "Tz" });
    z.tokenUsage({ responseId: "z1", usage: { input: 1000, output: 10 } });
    for (const t of [x, y, z]) h2.add(t);
    const r2 = run(h2.files(), { runStartMs: RUN });
    assert.equal(byId(r2, "same").status, "excluded:conflict_attribution"); // equal usage, different thread (R4.4)
    assert.equal(r2.coverage.codex.chains_tainted_by_reason.request_anomaly, 2);
    assert.equal(byId(r2, "z1").tainted, false);
    assert.equal(r2.coverage.codex.families_total, 2);
  });

  it("Codex: fork_prefix_unresolved when the prefix cannot be cut (R4.9)", () => {
    const home = new CodexHome();
    const parent = new CodexThread({ threadId: "synthetic-thread-p", threadSource: "user", model: "gpt-6-sol" });
    parent.turnContext({ turnId: "Tp" });
    parent.tokenUsage({ responseId: "p1", usage: { input: 1000, output: 10 } });
    const child = CodexThread.fork(parent, { threadId: "synthetic-thread-c", threadSource: "user", prefixLen: 1, model: "gpt-6-sol" });
    child.turnContext({ turnId: "Tc" });
    child.tokenUsage({ responseId: "c1", usage: { input: 2000, output: 20 } });
    home.add(parent);
    home.add(child);
    const ok = run(home.files(), { runStartMs: RUN });
    assert.equal(ok.coverage.codex.chains_tainted, 0);
    const cut = mapLines(home.files(), () => true, (o) => {
      if (o.type === "session_meta" && o.payload.id === "synthetic-thread-c") delete o.payload.subagent_history_start_ordinal;
      return o;
    });
    const r = run(cut, { runStartMs: RUN });
    assert.equal(r.coverage.codex.chains_tainted_by_reason.fork_prefix_unresolved, 2); // the fork and its parent
    assert.deepEqual(byId(r, "c1").taint_reasons, ["fork_prefix_unresolved"]);
    assert.equal(byId(r, "p1").model_source, "chain_tainted");
  });

  it("Codex: an unassigned non-empty file, a session_meta without an id and a usage record without a thread_id taint the provider", () => {
    const mk = () => {
      const t = new CodexThread({ threadId: "synthetic-thread-g", threadSource: "user", model: "gpt-6-sol" });
      t.turnContext({ turnId: "Tg" });
      t.tokenUsage({ responseId: "g1", usage: { input: 1000, output: 10 } });
      return t.files();
    };
    const orphan: GeneratedFile = { path: "sessions/2026/01/01/rollout-orphan.jsonl", content: JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "response_item", ordinal: 0, payload: {} }) + "\n" };
    const r1 = run([...mk(), orphan], { runStartMs: RUN });
    assert.equal(r1.coverage.codex["files_unassigned_stream"], 1);
    assert.deepEqual(byId(r1, "g1").taint_reasons, ["unattributed_record"]);
    // an empty unassigned file is not a record
    const empty: GeneratedFile = { path: "sessions/2026/01/01/rollout-empty.jsonl", content: "" };
    const r0 = run([...mk(), empty], { runStartMs: RUN });
    assert.equal(r0.coverage.codex["files_unassigned_stream"], 1);
    assert.equal(r0.coverage.codex.chains_tainted, 0);
    // a session_meta without a string id
    const noId: GeneratedFile = { path: "sessions/2026/01/01/rollout-noid.jsonl", content: JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "session_meta", ordinal: 0, payload: { cli_version: "0.158.0" } }) + "\n" };
    assert.deepEqual(byId(run([...mk(), noId], { runStartMs: RUN }), "g1").taint_reasons, ["unattributed_record"]);
    // a usage record without a thread_id: unkeyed for accounting (R2.13) and unattributed
    const noThread = mapLines(mk(), () => true, (o) => {
      if (o.type === "token_usage_record") delete o.payload.thread_id;
      return o;
    });
    const rn = run(noThread, { runStartMs: RUN });
    assert.equal(rn.coverage.codex["records_unkeyed"], 1);
    assert.equal(rn.providers.codex.totals.responses, 0);
    assert.equal(rn.coverage.codex.chains_tainted, 1);
    assert.equal(rn.coverage.codex.chains_tainted_by_reason.unattributed_record, 1);
    // a usage record with a thread but no response id taints that thread (request_anomaly)
    const noResp = mapLines(mk(), () => true, (o) => {
      if (o.type === "token_usage_record") delete o.payload.response_id;
      return o;
    });
    const rr = run(noResp, { runStartMs: RUN });
    assert.equal(rr.coverage.codex["records_unkeyed"], 1);
    assert.equal(rr.coverage.codex.chains_tainted_by_reason.request_anomaly, 1);
  });

  it("Codex live files: the C35 boundary, a skipped family counted, the other family unchanged", () => {
    const build = () => {
      const home = new CodexHome();
      const a = new CodexThread({ threadId: "synthetic-thread-a", threadSource: "user", model: "gpt-6-sol" });
      a.turnContext({ turnId: "Ta" });
      a.tokenUsage({ responseId: "a1", usage: { input: 1000, output: 10 } });
      a.tokenUsage({ responseId: "a2", usage: { input: 1100, cached: 1000, output: 20 } });
      const b = new CodexThread({ threadId: "synthetic-thread-b", threadSource: "user", model: "gpt-6-sol" });
      b.turnContext({ turnId: "Tb" });
      b.tokenUsage({ responseId: "b1", usage: { input: 2000, output: 30 } });
      home.add(a);
      home.add(b);
      return home.files();
    };
    const isA = (p: string) => p.includes("synthetic-thread-a");
    const files = appendRaw(build(), isA, '{"type":"event_msg","payload":{"ty');
    const clean = run(build(), { runStartMs: RUN });
    const live = run(withMtime(files, isA, RUN - C35_MS), { runStartMs: RUN });
    assert.equal(live.coverage.codex.families_live_skipped, 1);
    assert.equal(live.coverage.codex.responses_live_skipped, 2);
    assert.equal(live.coverage.codex.tokens_live_skipped, String(1000 + 10 + 1100 + 20));
    assert.equal(live.providers.codex.totals.responses, 1);
    assert.equal(byId(live, "b1").usd_pico, byId(clean, "b1").usd_pico);
    assert.equal(live.coverage.codex.chains_total, 1);
    assert.equal(live.coverage.codex["lines_truncated_tail"], 1);
    const notLive = run(withMtime(files, isA, RUN - C35_MS - 1), { runStartMs: RUN });
    assert.equal(notLive.coverage.codex.families_live_skipped, 0);
    assert.deepEqual(byId(notLive, "a1").taint_reasons, ["unparsed_line"]);
    assert.equal(byId(notLive, "b1").tainted, false);
  });

  it("R0.9 tokens: tainted tokens are exact BigInt decimal strings beyond MAX_SAFE_INTEGER", () => {
    const p = new ClaudeProject();
    const s = p.session({ sessionId: "synthetic-session-big", version: SUPPORTED, model: "claude-sonnet-5-5" });
    s.main.request({ requestId: "big1", usage: { input: MAX_SAFE, cacheRead: MAX_SAFE, write5m: MAX_SAFE, output: MAX_SAFE } });
    s.main.request({ requestId: "big2", usage: { input: MAX_SAFE, cacheRead: MAX_SAFE, write5m: MAX_SAFE, output: MAX_SAFE } });
    s.main.request({ requestId: "range", usage: { input: MAX_SAFE + 1, cacheRead: 0, write5m: 0, output: 1 } });
    const r = run(p.files(), { runStartMs: RUN });
    const expect = 2n * 4n * BigInt(MAX_SAFE);
    assert.equal(r.coverage.claude.tokens_in_tainted_chains, expect.toString());
    assert.equal(r.providers.claude.totals.tokens_unpriced, expect.toString());
    assert.equal(typeof r.coverage.claude.tokens_in_tainted_chains, "string");
    assert.equal(r.coverage.claude.taint_warn, true); // all tokens are tainted
  });
});


// ---------------------------------------------------------------------------
// Metamorphic tests (R4.10, R17.6, R17.7)
// ---------------------------------------------------------------------------

/** R17.6 physical counters: they change under the operations below, exactly as the spec table says. */
const PHYSICAL = new Set([
  "files_total", "files_assigned_by_stream", "files_unassigned_stream", "files_stream_conflict", "files_copy_exposed",
  "files_unreadable", "files_without_response_id", "token_count_events_without_response_id", "lines_total",
  "lines_parse_error", "lines_truncated_tail", "known_type_count", "unlisted_type_count", "lines_unverified_version",
  "sidecar_files", "sidecar_files_unparsed", "lines_duplicate_collapsed", "duplicate_records_collapsed",
]);

/** The semantic output (R4.10): totals, responses and the logical coverage counters. */
function semantic(r: RecomputeResult): string {
  const j = toJson(r, { perResponse: true, rawKeys: true });
  const cov: Record<string, unknown> = {};
  for (const p of ["claude", "codex"] as const) {
    cov[p] = Object.fromEntries(Object.entries(j.coverage[p]).filter(([k]) => !PHYSICAL.has(k)));
  }
  return JSON.stringify({ providers: j.providers, responses: j.responses, coverage: cov });
}

function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as object).reverse().map(([k, x]) => [k, reverseKeys(x)]));
  }
  return v;
}

/** Re-serialize every parseable line with reversed key order (R4.10 op 4). Unparseable lines are kept. */
function reserializeReversed(files: GeneratedFile[]): GeneratedFile[] {
  return files.map((f) => {
    if (typeof f.content !== "string") return f;
    const out = f.content.split("\n").map((l) => {
      if (l.trim() === "") return l;
      try {
        return JSON.stringify(reverseKeys(JSON.parse(l)));
      } catch {
        return l;
      }
    });
    return { ...f, content: out.join("\n") };
  });
}

/** True when the line names a chain (R0.9): a Claude record with a sessionId, a Codex session_meta id or usage thread_id. */
function namesChain(line: string): boolean {
  try {
    const o = JSON.parse(line);
    if (typeof o.sessionId === "string") return true;
    if (o.type === "session_meta" && typeof o.payload?.id === "string") return true;
    if (o.type === "token_usage_record" && typeof o.payload?.thread_id === "string") return true;
  } catch {
    // not a record
  }
  return false;
}

/** Split one file at a line boundary; both halves keep the modification time (R4.10 op 5). Null when a half names no chain. */
function splitAt(files: Array<GeneratedFile & { mtimeMs?: number }>, index: number, k: number): Array<GeneratedFile & { mtimeMs?: number }> | null {
  const f = files[index]!;
  const lines = (f.content as string).split("\n").filter(Boolean);
  const a = lines.slice(0, k);
  const b = lines.slice(k);
  if (!a.some(namesChain) || !b.some(namesChain)) return null;
  const mk = (suffix: string, ls: string[]) => ({ ...f, path: f.path.replace(/\.jsonl$/, `-${suffix}.jsonl`), content: ls.join("\n") + "\n" });
  return [...files.slice(0, index), mk("part1", a), mk("part2", b), ...files.slice(index + 1)];
}

interface Fx {
  name: string;
  files: GeneratedFile[];
  /** No file of the fixture is a stream conflict or mixes families, so no split dissolves (R4.10). */
  splittable: boolean;
}

function metamorphicCorpus(): Fx[] {
  const out: Fx[] = [];
  const two = claudeTwo();
  out.push({ name: "claude two sessions", files: two.files, splittable: true });
  out.push({ name: "claude two sessions with a parse error line", files: appendRaw(two.files, two.isAgentFile, "not json\n"), splittable: false });
  {
    const { p, m } = claudeSession();
    m.user();
    m.request({ requestId: "k1", usage: { input: 5, write5m: 1000, output: 10 }, blocks: [{ type: "text" }, { type: "text" }] });
    const bad = m.request({ requestId: "k2", usage: { input: 7, write5m: 200, output: 20 }, blocks: [{ type: "text" }, { type: "text" }] });
    m.request({ requestId: "k3", usage: { input: 9, cacheRead: 1000, writeTotal: 200, omitCacheCreation: true, output: 20 } });
    let n = 0;
    out.push({
      name: "claude anomaly and an unknown ttl write",
      files: mapLines(p.files(), () => true, (o) => {
        if (o.requestId === bad.requestId) {
          if (n === 0) o.message.usage.input_tokens = 99;
          n += 1;
        }
        return o;
      }),
      splittable: true,
    });
  }
  {
    const p = new ClaudeProject();
    const a = p.session({ sessionId: "synthetic-session-origin", version: SUPPORTED, model: "claude-sonnet-5-5", startMs: Date.UTC(2026, 0, 1) });
    a.main.user();
    a.main.request({ requestId: "ro", usage: { input: 5, write5m: 10000, output: 100 } });
    const b = p.session({ sessionId: "synthetic-session-fork", version: SUPPORTED, model: "claude-sonnet-5-5", startMs: Date.UTC(2026, 0, 1, 1) });
    b.main.replay(a.main.records.slice(1));
    b.main.user();
    b.main.request({ requestId: "rb", usage: { input: 5, cacheRead: 10000, write5m: 700, output: 150 } });
    out.push({ name: "claude replay", files: p.files(), splittable: true });
  }
  {
    const t = new CodexThread({ threadId: "synthetic-thread-m", threadSource: "user", model: "gpt-6-sol" });
    t.turnContext({ turnId: "T1" });
    t.tokenUsage({ responseId: "a1", usage: { input: 1000, output: 10 }, turnId: "T1" });
    t.eventMsg("thread_settings_applied");
    t.turnContext({ turnId: "T2" });
    t.tokenUsage({ responseId: "a2", usage: { input: 1100, cached: 1000, output: 20 }, turnId: "T2" });
    t.tokenUsage({ responseId: "a3", usage: { input: 1200, cached: 1100, output: 30 }, turnId: "T3" });
    t.compacted();
    t.tokenUsage({ responseId: "a4", usage: { input: 900, output: 5 }, turnId: "T2" });
    out.push({ name: "codex thread", files: t.files(), splittable: true });
  }
  {
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
    home.add(child);
    out.push({ name: "codex fork", files: home.files(), splittable: true });
  }
  {
    const t = new CodexThread({ threadId: "synthetic-thread-x", threadSource: "user", model: "gpt-6-sol" });
    t.eventMsg("token_count");
    t.turnContext({ turnId: "Tx" });
    t.tokenUsage({ responseId: "r1", usage: { input: 1000, output: 10 } });
    t.eventMsg("token_count");
    out.push({ name: "codex five-record counter fixture", files: t.files(), splittable: true });
  }
  {
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
    out.push({ name: "codex stream conflict (R2.17 fixture 6)", files: home.files(), splittable: false });
  }
  return out;
}

describe("recompute: metamorphic operations (R4.10, R17.6, R17.7)", () => {
  const corpus = metamorphicCorpus();
  const withMt = (fx: Fx) => fx.files.map((f) => ({ ...f, mtimeMs: RUN - 7 * 24 * 3600_000 }));

  for (const fx of corpus) {
    it(`${fx.name}: operations 1 to 4 leave the semantic output unchanged`, () => {
      const files = withMt(fx);
      const base = semantic(run(files, { runStartMs: RUN }));
      for (let seed = 1; seed <= 4; seed += 1) {
        assert.equal(semantic(run(shuffleFiles(files, seed), { runStartMs: RUN })), base, `shuffle ${seed}`);
      }
      assert.equal(semantic(run(reserializeReversed(files), { runStartMs: RUN })), base, "key order");
      // duplicate lines away from the end of a file; an unparseable line stays a physical effect only
      assert.equal(semantic(run(dupLines(files).map((f, i) => ({ ...f, mtimeMs: files[i]!.mtimeMs })), { runStartMs: RUN })), base, "duplicated lines");
    });

    if (!fx.splittable) continue;
    it(`${fx.name}: a split at every line boundary is monotone (R4.10 op 5, R17.7)`, () => {
      const files = withMt(fx);
      const whole = run(files, { runStartMs: RUN });
      const wholeRows = new Map(rows(whole).map((e) => [`${e.provider}:${e.id}`, e]));
      let checked = 0;
      for (let fi = 0; fi < files.length; fi += 1) {
        if (typeof files[fi]!.content !== "string" || !files[fi]!.path.endsWith(".jsonl")) continue;
        const n = (files[fi]!.content as string).split("\n").filter(Boolean).length;
        for (let k = 1; k < n; k += 1) {
          const split = splitAt(files, fi, k);
          if (split === null) continue;
          checked += 1;
          const r = run(split, { runStartMs: RUN });
          const label = `${files[fi]!.path} at ${k}`;
          for (const p of ["claude", "codex"] as const) {
            // token totals and per-response accounting are identical
            assert.equal(JSON.stringify(r.providers[p].totals.tokens), JSON.stringify(whole.providers[p].totals.tokens), `tokens ${label}`);
            assert.equal(r.providers[p].totals.responses, whole.providers[p].totals.responses, `responses ${label}`);
            const a = r.coverage[p];
            const b = whole.coverage[p];
            assert.equal(a.chains_total, b.chains_total, `chains_total ${label}`);
            assert.equal(a.families_total, b.families_total, `families_total ${label}`);
            assert.ok(a.chains_tainted >= b.chains_tainted, `taint monotone ${label}`);
            assert.ok(a.families_tainted >= b.families_tainted, `family taint monotone ${label}`);
            assert.ok(BigInt(a.tokens_in_tainted_chains) >= BigInt(b.tokens_in_tainted_chains));
            assert.ok(BigInt(a.tokens_live_skipped) === BigInt(b.tokens_live_skipped));
            // the direction rules: priced and verified sets can only shrink
            assert.ok(r.providers[p].totals.responses_priced <= whole.providers[p].totals.responses_priced, `priced ${label}`);
            assert.equal(BigInt(r.providers[p].totals.tokens_total), BigInt(whole.providers[p].totals.tokens_total));
          }
          for (const e of rows(r)) {
            const w = wholeRows.get(`${e.provider}:${e.id}`);
            assert.ok(w, `${label}: ${e.id} exists unsplit`);
            assert.equal(JSON.stringify(e.buckets ?? null), JSON.stringify(w.buckets ?? null), `${label}: buckets of ${e.id}`);
            if (w.tainted) assert.equal(e.tainted, true, `${label}: ${e.id} stays tainted`);
            if (e.usd_pico !== null) assert.equal(e.usd_pico, w.usd_pico, `${label}: priced value of ${e.id}`);
            if (e.model_source !== undefined && e.model_source !== "chain_tainted" && e.model_source !== "none") {
              const verified = ["own_turn", "carried_verified", "claude_explicit"].includes(e.model_source as string);
              if (verified) {
                assert.ok(["own_turn", "carried_verified", "claude_explicit"].includes(w.model_source), `${label}: ${e.id} verified only in the split`);
                assert.equal(e.model, w.model);
              }
            }
          }
          // a split that taints no new chain gives the identical output apart from the physical counters
          const reasons = (x: RecomputeResult) => JSON.stringify([x.coverage.claude.chains_tainted_by_reason, x.coverage.codex.chains_tainted_by_reason]);
          if (reasons(r) === reasons(whole)) {
            assert.equal(semantic(r), semantic(whole), `${label}: invariance`);
          }
        }
      }
      assert.ok(checked >= 1, `${fx.name}: checked ${checked}`);
    });
  }
});


// ---------------------------------------------------------------------------
// The stored R0.9 and R2.17 fixtures (test/fixtures/r09.ts) against the independent implementation
// ---------------------------------------------------------------------------

const VERIFIED_SOURCES = ["own_turn", "carried_verified", "claude_explicit"];

/** Compare one recompute result with a stored expectation: chains, reasons, sources, models, tokens, live counters. */
function assertR09(r: RecomputeResult, ex: R09Expect, label: string): void {
  for (const p of ["claude", "codex"] as const) {
    const mine = Object.entries(ex.chains).filter(([id]) => id.startsWith(`${p}\u0000`));
    const cov = r.coverage[p];
    assert.equal(cov.chains_total, mine.length, `${label}: ${p} chains_total`);
    assert.equal(cov.chains_tainted, mine.filter(([, rs]) => rs.length > 0).length, `${label}: ${p} chains_tainted`);
    for (const reason of TAINT_REASON_LIST) {
      const want = mine.filter(([, rs]) => rs.includes(reason)).length;
      assert.equal(cov.chains_tainted_by_reason[reason], want, `${label}: ${p} reason ${reason}`);
    }
    const lv = ex.live?.[p];
    assert.equal(cov.families_live_skipped, lv?.families ?? 0, `${label}: ${p} live families`);
    assert.equal(cov.responses_live_skipped, lv?.responses ?? 0, `${label}: ${p} live responses`);
    assert.equal(cov.tokens_live_skipped, (lv?.tokens ?? 0n).toString(), `${label}: ${p} live tokens`);
    assert.equal(r.providers[p].totals.tokens_total, ex.tokens[p].toString(), `${label}: ${p} tokens_total`);
  }
  const counted = r.responses.filter((x) => x.counted);
  assert.deepEqual(counted.map((x) => x.key).sort(), Object.keys(ex.sources).sort(), `${label}: counted responses`);
  for (const x of counted) {
    assert.equal(x.model_source, ex.sources[x.key], `${label}: model_source of ${x.key}`);
    const verified = VERIFIED_SOURCES.includes(x.model_source as string);
    if (verified) assert.equal(x.model, ex.verified[x.key], `${label}: model of ${x.key}`);
    else assert.equal(ex.verified[x.key], undefined, `${label}: ${x.key} has no verified model`);
    if (x.model_source === "chain_tainted") {
      assert.equal(x.price?.priced, false, `${label}: ${x.key} priced although tainted`);
      assert.equal((x.price as { reason: string }).reason, "chain_tainted");
      assert.equal(x.tainted, true);
    }
    // the reasons of the response are those of its chain
    const chainReasons = ex.chains[x.chain as string];
    if (chainReasons !== undefined) assert.deepEqual(x.taint_reasons, chainReasons, `${label}: reasons of ${x.key}`);
  }
  if (ex.counters) {
    assert.equal(r.coverage.codex["files_without_response_id"], ex.counters.files_without_response_id, `${label}: files_without_response_id`);
    assert.equal(r.coverage.codex["token_count_events_without_response_id"], ex.counters.token_count_events_without_response_id, `${label}: token_count_events`);
  }
}

const TAINT_REASON_LIST = [
  "stream_unresolved", "copy_exposed", "turn_model_conflicted", "ordinal_unverified", "fork_prefix_unresolved", "request_anomaly",
  "ownership_ambiguous", "version_unverified", "unparsed_line", "unlogged_usage", "unattributed_record", "file_unreadable",
] as const;

function runStored(files: GeneratedFile[]): RecomputeResult {
  // the default table of the repository (read as data), the test-only tier parameter and the injected run start
  return recomputeFiles(files, { codexTierForTest: "standard", runStartMs: RUN_START_MS });
}

describe("recompute: the stored R0.9 / R2.17 fixtures, unsplit, shuffled and at every split position", () => {
  for (const fx of allR09Fixtures()) {
    it(`${fx.name} (${fx.rules})`, () => {
      assertR09(runStored(fx.files), fx.expect, `${fx.name} unsplit`);
      // operations 1 and 2 (shuffles) and 4 (key order) leave the result unchanged
      const base = semantic(runStored(fx.files));
      for (let seed = 1; seed <= 3; seed += 1) assert.equal(semantic(runStored(meta.shuffleFiles(fx.files.map((f) => meta.shuffleLines(f, seed)), seed))), base, `${fx.name} shuffle ${seed}`);
      assert.equal(semantic(runStored(fx.files.map((f) => meta.reserializeReversedKeys(f)))), base, `${fx.name} key order`);
      // operation 5 at every allowed boundary of every splittable file, against the stored expectation of the position
      let positions = 0;
      for (const path of fx.splittable) {
        const idx = fx.files.findIndex((f) => f.path === path);
        const file = fx.files[idx]!;
        const provider = path.startsWith("projects/") ? "claude" : "codex";
        for (const at of meta.splitPositions(file, provider)) {
          const halves = meta.splitAt(file, at, provider)!;
          const files = [...fx.files.slice(0, idx), ...halves, ...fx.files.slice(idx + 1)];
          const { expect: ex } = expectAt(fx, path, at);
          assertR09(runStored(files), ex, `${fx.name} ${path} at ${at}`);
          positions += 1;
        }
      }
      void positions;
    });
  }

  it("fixture 6: the clean family's models, priced set and dollars equal a scan of the clean family alone", () => {
    const fx = r09Fixture6();
    assert.ok(fx.clean_only);
    const mixed = runStored(fx.files);
    const alone = runStored(fx.clean_only!.files);
    const clean = new Set(fx.clean_only!.chains);
    const pick = (r: RecomputeResult) =>
      JSON.stringify(
        r.responses
          .filter((x) => x.counted && clean.has(x.chain as string))
          .map((x) => [x.key, x.model_source, x.model, x.price?.priced ? x.price.pico.toString() : null, x.price?.priced ? null : (x.price as { reason: string }).reason])
          .sort(),
      );
    assert.equal(pick(mixed), pick(alone));
    assert.ok(r09Count(mixed, clean) > 0);
  });
});

function r09Count(r: RecomputeResult, chains: Set<string>): number {
  return r.responses.filter((x) => x.counted && chains.has(x.chain as string)).length;
}


// ---------------------------------------------------------------------------
// Answers of the revision 11 review (orchestrator): each rule below was a question in the previous round.
// ---------------------------------------------------------------------------

const NL = String.fromCharCode(10);

describe("recompute: answers of the revision 11 review", () => {
  it("Claude: a keyless assistant record with a sessionId taints its chain with or without usage, whatever its version; the counter counts usage only", () => {
    const { files } = claudeTwo();
    const isB = (path: string) => path.includes("synthetic-session-b");
    const keyless = (fn: (o: any) => void) =>
      mapLines(files, isB, (o) => {
        if (o.type === "assistant" && o.requestId === "b-main") {
          delete o.requestId;
          fn(o);
        }
        return o;
      });
    const withUsage = run(keyless(() => {}), { runStartMs: RUN });
    assert.equal(withUsage.coverage.claude["records_unkeyed"], 1);
    assert.equal(withUsage.coverage.claude.chains_tainted_by_reason.request_anomaly, 1);
    const noUsage = run(keyless((o) => delete o.message.usage), { runStartMs: RUN });
    assert.equal(noUsage.coverage.claude["records_unkeyed"], 0, "the counter covers records that carry usage");
    assert.equal(noUsage.coverage.claude.chains_tainted_by_reason.request_anomaly, 1, "the trigger does not need usage");
    const oldVersion = run(keyless((o) => (o.version = "0.0.1")), { runStartMs: RUN });
    assert.equal(oldVersion.coverage.claude["records_unkeyed"], 0);
    assert.equal(oldVersion.coverage.claude.chains_tainted_by_reason.request_anomaly, 1, "whatever its version");
    // session A is a different family and stays clean
    assert.equal(byId(noUsage, "a-main").tainted, false);
    // an API error record is not an anomaly
    const apiError = run(keyless((o) => (o.isApiErrorMessage = true)), { runStartMs: RUN });
    assert.equal(apiError.coverage.claude.chains_tainted, 0);
  });

  it("Claude sidecars: an empty sidecar is unreadable, a line-duplicated one-line sidecar is readable, a truncated journal line abstains", () => {
    const { files } = claudeTwo();
    const metaPath = files.find((f) => f.path.endsWith(".meta.json"))!.path;
    const one = JSON.stringify({ toolUseId: "synthetic-toolu-1" });
    const asMeta = (content: string) => files.map((f) => (f.path === metaPath ? { ...f, content } : f));
    assert.equal(run(asMeta(""), { runStartMs: RUN }).coverage.claude.chains_tainted, 3, "empty sidecar");
    assert.equal(run(asMeta(NL + NL), { runStartMs: RUN }).coverage.claude.chains_tainted, 3, "blank sidecar");
    assert.equal(run(asMeta(one + NL + one + NL), { runStartMs: RUN }).coverage.claude.chains_tainted, 0, "line-duplicated one-line sidecar");
    assert.equal(run(asMeta(one + NL + '{"toolUse'), { runStartMs: RUN }).coverage.claude.chains_tainted, 3, "a half line is a lost record");
    // a workflow journal: a truncated last line names no chain, so it is never live and taints every Claude chain
    const journal = "projects/synthetic-project/synthetic-session-a/subagents/workflows/wf_synthetic/journal.jsonl";
    const withJournal = (content: string, mtimeMs: number) => [...files, { path: journal, content, mtimeMs }];
    assert.equal(run(withJournal(one + NL, RUN), { runStartMs: RUN }).coverage.claude.chains_tainted, 0);
    const cut = run(withJournal(one + NL + '{"step":', RUN), { runStartMs: RUN });
    assert.equal(cut.coverage.claude.chains_tainted, cut.coverage.claude.chains_total);
    assert.equal(cut.coverage.claude.chains_tainted_by_reason.unparsed_line, 3);
    assert.equal(cut.coverage.claude.families_live_skipped, 0, "a recent mtime does not make a chainless file live");
  });

  it("an mtime of 0, a missing mtime and a failed stat mean never live", () => {
    const { files, isAgentFile } = claudeTwo();
    const bad = appendRaw(files, isAgentFile, "garbage" + NL);
    // a run start so early that 0 would be inside the live window if it counted
    for (const mtimeMs of [0, undefined]) {
      const stamped = mtimeMs === undefined ? bad : withMtime(bad, isAgentFile, mtimeMs);
      const r = run(stamped, { runStartMs: 1000 });
      assert.equal(r.coverage.claude.families_live_skipped, 0, `mtime ${mtimeMs}`);
      assert.deepEqual(byId(r, "a-sub").taint_reasons, ["unparsed_line"]);
    }
    const live = run(withMtime(bad, isAgentFile, 1), { runStartMs: 1000 });
    assert.equal(live.coverage.claude.families_live_skipped, 1, "any positive mtime inside the window is live");
  });

  it("an unreadable file or directory names no chain and taints the provider of its root, not the other provider", () => {
    const { files } = claudeTwo();
    const t = new CodexThread({ threadId: "synthetic-thread-u", threadSource: "user", model: "gpt-6-sol" });
    t.turnContext({ turnId: "Tu" });
    t.tokenUsage({ responseId: "u1", usage: { input: 100, output: 1 } });
    const broken = { path: "projects/synthetic-project/synthetic-session-q.jsonl", content: "", unreadable: true };
    const r = run([...files, ...t.files(), broken], { runStartMs: RUN });
    assert.equal(r.coverage.claude["files_unreadable"], 1);
    assert.equal(r.coverage.claude.chains_tainted, r.coverage.claude.chains_total);
    assert.equal(r.coverage.claude.chains_tainted_by_reason.file_unreadable, 3);
    assert.equal(r.coverage.codex.chains_tainted, 0);
    assert.equal(r.providers.claude.totals.tokens_total, run(files, { runStartMs: RUN }).providers.claude.totals.tokens_total, "tokens are kept");
  });

  it("a root that does not exist taints nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-rec-"));
    try {
      const r = recompute({ claudeDirs: [join(dir, "nothing")], codexDirs: [join(dir, "none")], table: TABLE });
      assert.equal(r.coverage.claude.chains_total, 0);
      assert.equal(r.coverage.codex.chains_total, 0);
      assert.equal(r.coverage.claude["files_unreadable"], 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Codex R2.17 (d), S2.3: a turn_context without a usable model is a null member of TM(T), so model A plus null conflicts", () => {
    const build = (second: "none" | "same" | "empty") => {
      let seen = 0;
      return mapLines(
        codexFiles((home) => {
          const t = new CodexThread({ threadId: "synthetic-thread-n", threadSource: "user", model: "gpt-6-sol" });
          t.turnContext({ turnId: "Tn" });
          t.turnContext({ turnId: "Tn" });
          t.tokenUsage({ responseId: "n1", usage: { input: 1000, output: 10 }, turnId: "Tn" });
          home.add(t);
        }),
        () => true,
        (o) => {
          if (o.type === "turn_context") {
            seen += 1;
            if (seen === 2 && second === "none") delete o.payload.model;
            if (seen === 2 && second === "empty") o.payload.model = "";
          }
          return o;
        },
      );
    };
    for (const second of ["none", "empty"] as const) {
      const r = run(build(second), { runStartMs: RUN });
      assert.deepEqual(byId(r, "n1").taint_reasons, ["turn_model_conflicted"], second);
      assert.equal(byId(r, "n1").buckets.input_uncached, "1000");
    }
    const same = run(build("same"), { runStartMs: RUN });
    assert.equal(same.coverage.codex.chains_tainted, 0);
    assert.equal(byId(same, "n1").model_source, "own_turn");
  });

  it("Codex R4.11: a missing session_id or forked_from_id is a value of its own and conflicts with a present one", () => {
    const base = () =>
      codexFiles((home) => {
        const t = new CodexThread({ threadId: "synthetic-thread-m", sessionId: "synthetic-session-m", threadSource: "user", model: "gpt-6-sol" });
        t.turnContext({ turnId: "Tm" });
        t.tokenUsage({ responseId: "m1", usage: { input: 1000, output: 10 } });
        home.add(t);
      });
    // a second file with only an own session_meta of the same id, differing in one field (or not at all)
    const withSecondMeta = (drop: "none" | "session_id") => {
      const files = base();
      const metaLine = (files[0]!.content as string).split(NL).find((l) => l.includes('"session_meta"'))!;
      const o = JSON.parse(metaLine);
      if (drop !== "none") delete o.payload[drop];
      return [...files, { path: "sessions/2026/01/01/rollout-2026-01-01T00-00-00-synthetic-thread-m-second.jsonl", content: JSON.stringify(o) + NL }];
    };
    assert.equal(run(withSecondMeta("none"), { runStartMs: RUN }).coverage.codex.chains_tainted_by_reason.stream_unresolved, 0);
    const miss = run(withSecondMeta("session_id"), { runStartMs: RUN });
    assert.equal(miss.coverage.codex.chains_tainted_by_reason.stream_unresolved, 1);
    assert.ok(byId(miss, "m1").taint_reasons.includes("stream_unresolved"));
  });

  it("Codex: request-level triggers are emitted only for supported-version threads; an unverified thread gets version_unverified only", () => {
    const files = codexFiles((home) => {
      const t = new CodexThread({ threadId: "synthetic-thread-v", threadSource: "user", model: "gpt-6-sol", cliVersion: "0.159.0" });
      t.turnContext({ turnId: "Tv" });
      t.tokenUsage({ responseId: "v1", usage: { input: 1000, output: 10 } });
      t.tokenUsage({ responseId: "v2", usage: { input: 2000, output: 20 } });
      home.add(t);
    });
    // one usage record loses its response id, one gets a range failure
    let n = 0;
    const odd = mapLines(files, () => true, (o) => {
      if (o.type === "token_usage_record") {
        n += 1;
        if (n === 1) delete o.payload.response_id;
        else o.payload.usage.input_tokens = MAX_SAFE + 1;
      }
      return o;
    });
    const r = run(odd, { runStartMs: RUN });
    assert.deepEqual(
      Object.entries(r.coverage.codex.chains_tainted_by_reason).filter(([, v]) => v > 0).map(([k]) => k),
      ["version_unverified"],
    );
    assert.equal(r.coverage.codex["records_unkeyed"], 0, "no request-level rule runs on an unverified record");
    assert.equal(r.coverage.codex["lines_unverified_version"], 2, "both usage lines are counted, keyed or not");
    assert.equal(r.coverage.codex["requests_unverified_version"], 1);
    assert.equal(r.providers.codex.totals.responses, 0);
    // the same records in a supported thread do trigger
    const supported = mapLines(odd, () => true, (o) => {
      if (o.type === "session_meta") o.payload.cli_version = "0.160.1";
      return o;
    });
    const s = run(supported, { runStartMs: RUN });
    assert.equal(s.coverage.codex.chains_tainted_by_reason.request_anomaly, 1);
    assert.equal(s.coverage.codex.chains_tainted_by_reason.version_unverified, 0);
    assert.equal(s.coverage.codex["records_unkeyed"], 1);
  });

  it("windowing: the logical counters follow the window, chain and family counters stay scan-wide (R17.3, R0.9)", () => {
    const { p, m } = claudeSession();
    m.request({ requestId: "w-old", usage: { input: 5, write5m: 100, output: 10 } });
    m.request({ requestId: "w-new", usage: { input: 5, write5m: 100, output: 10 }, dtMs: 3600_000 });
    // the old request carries a range failure
    const files = mapLines(p.files(), () => true, (o) => {
      if (o.type === "assistant" && o.requestId === "w-old") o.message.usage.cache_read_input_tokens = MAX_SAFE + 1;
      return o;
    });
    const all = run(files, { runStartMs: RUN });
    const win = run(files, { since: "2026-01-01T00:30:00Z", runStartMs: RUN });
    assert.equal(all.coverage.claude["responses_usage_range_failed"], 1);
    assert.equal(win.coverage.claude["responses_usage_range_failed"], 0, "the range failure lies before the window");
    assert.equal(win.coverage.claude["requests_total"], 1, "S12.2: requests_total is the accounted responses in the window");
    // the chain is tainted by the out-of-window anomaly (chain counters are scan-wide) and the in-window response counts
    assert.equal(win.coverage.claude.chains_tainted, 1);
    assert.equal(win.coverage.claude.responses_in_tainted_chains, 1);
    assert.equal(win.providers.claude.totals.responses, 1);
  });

  it("an unknown output with a final copy is never priced as modifier_unverified: the path cannot fire on any stored fixture", () => {
    const seen: RecomputeResult[] = [];
    for (const fx of allR09Fixtures()) seen.push(runStored(fx.files));
    seen.push(run(claudeTwo().files, { runStartMs: RUN }));
    let checked = 0;
    for (const r of seen) {
      for (const x of r.responses) {
        if (!x.counted || x.provider !== "claude" || x.tainted) continue;
        checked += 1;
        if (x.buckets!.output === null) assert.ok(x.flags!.includes("output_unknown"), "output is unknown only without a final copy");
      }
    }
    assert.ok(checked > 0);
    // a conflicting output among final copies makes the output unknown too, and then the chain is tainted
    const { p, m } = claudeSession();
    m.request({ requestId: "co", usage: { input: 5, write5m: 100, output: 10 } });
    const dup = p.files().map((f) => {
      if (typeof f.content !== "string") return f;
      const lines = f.content.split(NL).filter(Boolean);
      const extra = lines
        .filter((l) => l.includes('"requestId":"co"'))
        .map((l) => {
          const o = JSON.parse(l);
          o.message.usage.output_tokens = 11;
          o.uuid = `${o.uuid}-b`;
          return JSON.stringify(o);
        });
      return { ...f, content: [...lines, ...extra].join(NL) + NL };
    });
    const r = run(dup, { runStartMs: RUN });
    const x = byId(r, "co");
    assert.equal(x.tainted, true);
    assert.equal(x.unpriced_reason, "chain_tainted");
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
      assert.equal(sum(parts, (x) => x.usd_pico), c.totals.usd_pico);
      assert.equal(sum(parts, (x) => x.tokens_unpriced), c.totals.tokens_unpriced);
      assert.equal(Object.values(parts).reduce((a, x) => a + x.responses, 0), c.totals.responses);
    }
    assert.equal(c.by_kind["workflow_agent"]?.responses, 2);
  });

  it("tolerates BOM, CRLF, counts blank lines as parse errors, garbage lines and a truncated tail without keeping error text (R1.3)", () => {
    const { p, m } = claudeSession();
    m.request({ usage: { input: 5, write5m: 100, output: 10 } });
    const f = p.files()[0]!;
    const text = (f.content as string).replace(/\n/g, "\r\n");
    const content = "﻿" + text + "\r\n\r\nnot json at all\r\n" + '{"type":"assistant","message":{"usage":{"input_tok';
    const r = run([{ ...f, content }]);
    assert.equal(r.providers.claude.totals.responses, 1);
    assert.equal(r.coverage.claude["lines_parse_error"], 3, "S12.6: two blank terminated lines and the garbage line");
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
      assert.equal(doc.providers.codex.totals.usd_pico, "0");
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
      // test-only parameters and removed modes are function parameters only, never flags (R0.9, R15.7)
      for (const flag of ["--run-start", "--version-policy", "--codex-tier", "--mtime", "--fast"]) {
        const x = spawnSync(process.execPath, [script, "--claude-dir", join(tmp, "claude"), flag, "1"], { encoding: "utf8" });
        assert.equal(x.status, 2, flag);
        assert.equal(x.stderr.trim(), "recompute: unknown_argument", flag);
      }
      // the coverage carries the R0.9 counters, token amounts as decimal strings
      assert.equal(doc.coverage.claude.chains_total, 1);
      assert.equal(doc.coverage.claude.chains_tainted, 0);
      assert.equal(doc.coverage.codex.tokens_in_tainted_chains, "0");
      assert.equal(doc.coverage.codex.tokens_live_skipped, "0");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("recompute: G1 round 1 (Sol audit)", () => {
  const T0 = "2026-01-01T00:00:10.000Z";
  /** Build records that share a uuid, a timestamp and a message id; `variants` edit one record each. */
  function sameUuidFiles(kind: "unkeyed" | "api_error", variants: Array<(o: any) => void>, duplicateFirst: boolean): GeneratedFile[] {
    const { p, m } = claudeSession();
    variants.forEach((_, k) => {
      if (kind === "api_error") m.request({ requestId: `e${k}`, apiError: true, usage: { input: 5, output: 10 } });
      else m.request({ requestId: `x${k}`, usage: { input: 5, write5m: 100, output: 10 } });
    });
    let seen = 0;
    const files = mapLines(p.files(), () => true, (o) => {
      if (o.type !== "assistant") return o;
      const edit = variants[seen++]!;
      if (kind === "unkeyed") delete o.requestId;
      else o.requestId = "synthetic-same-request";
      o.uuid = "synthetic-same-uuid";
      o.timestamp = T0;
      o.parentUuid = "synthetic-same-parent";
      o.message.id = "synthetic-same-message";
      edit(o);
      return o;
    });
    if (!duplicateFirst) return files;
    return files.map((f) => {
      const lines = (f.content as string).split("\n").filter(Boolean);
      const first = lines.find((l) => l.includes('"type":"assistant"'))!;
      return { ...f, content: [...lines, first].join("\n") + "\n" };
    });
  }

  it("R17.6: unkeyed records that share a uuid and differ in a retained field are counted separately; equal records count once", () => {
    const other = sameUuidFiles("unkeyed", [() => {}, (o) => (o.message.usage.input_tokens = 6)], false);
    assert.equal(run(other, { runStartMs: RUN }).coverage.claude["records_unkeyed"], 2, "same uuid, different usage: two records");
    const sameDup = sameUuidFiles("unkeyed", [() => {}, (o) => (o.message.usage.input_tokens = 6)], true);
    assert.equal(run(sameDup, { runStartMs: RUN }).coverage.claude["records_unkeyed"], 2, "a byte-identical duplicate adds nothing");
    const equal = sameUuidFiles("unkeyed", [() => {}, () => {}], false);
    assert.equal(run(equal, { runStartMs: RUN }).coverage.claude["records_unkeyed"], 1, "equal projections collapse");
    // fields outside the old narrow subset still separate records: the stop reason and a content block type
    const stop = sameUuidFiles("unkeyed", [() => {}, (o) => (o.message.stop_reason = "refusal")], false);
    assert.equal(run(stop, { runStartMs: RUN }).coverage.claude["records_unkeyed"], 2);
    const blocks = sameUuidFiles("unkeyed", [() => {}, (o) => (o.message.content = [{ type: "thinking" }])], false);
    assert.equal(run(blocks, { runStartMs: RUN }).coverage.claude["records_unkeyed"], 2);
  });

  it("R17.6: API error records that share a uuid and differ in a retained field are counted separately", () => {
    const diff = sameUuidFiles("api_error", [() => {}, (o) => (o.effort = "high")], false);
    assert.equal(run(diff, { runStartMs: RUN }).coverage.claude["api_error_records"], 2);
    const equal = sameUuidFiles("api_error", [() => {}, () => {}], true);
    assert.equal(run(equal, { runStartMs: RUN }).coverage.claude["api_error_records"], 1);
  });

  it("R14.4: per-response ids are req_<8 hex> of a salted hash; a salt per call, the order does not depend on it", () => {
    const { p, m } = claudeSession();
    for (const k of ["k3", "k1", "k2"]) m.request({ requestId: k, usage: { input: 5, write5m: 100, output: 10 } });
    const r = run(p.files());
    const a = toJson(r, { perResponse: true }).responses as Array<Record<string, any>>;
    const b = toJson(r, { perResponse: true }).responses as Array<Record<string, any>>;
    assert.equal(a.length, 3);
    for (const x of a) assert.match(x.id, /^req_[0-9a-f]{8}$/);
    assert.notDeepEqual(a.map((x) => x.id), b.map((x) => x.id), "a fresh random salt per call");
    const fixed1 = toJson(r, { perResponse: true, salt: "synthetic-salt-1" }).responses as Array<Record<string, any>>;
    const fixed1b = toJson(r, { perResponse: true, salt: "synthetic-salt-1" }).responses as Array<Record<string, any>>;
    const fixed2 = toJson(r, { perResponse: true, salt: "synthetic-salt-2" }).responses as Array<Record<string, any>>;
    assert.deepEqual(fixed1, fixed1b, "the same salt gives the same ids");
    assert.notDeepEqual(fixed1.map((x) => x.id), fixed2.map((x) => x.id));
    // rows are ordered by the raw key before hashing: the buckets column reads k1, k2, k3 for every salt
    const raw = toJson(r, { perResponse: true, rawKeys: true }).responses as Array<Record<string, any>>;
    assert.deepEqual(raw.map((x) => x.id), ["k1", "k2", "k3"]);
    for (const salted of [a, b, fixed1, fixed2]) assert.deepEqual(salted.map((x) => JSON.stringify(x.buckets)), raw.map((x) => JSON.stringify(x.buckets)));
    // no raw key and no key text in a salted document
    for (const key of ["k1", "k2", "k3"]) assert.equal(JSON.stringify(a).includes(`"${key}"`), false);
  });

  it("R14.4: the command line refuses --raw-keys, with or without --out, and writes no file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "cachewhy-recompute-"));
    try {
      const { p, m } = claudeSession();
      m.request({ requestId: "synthetic-raw-key-probe", usage: { input: 5, write5m: 1000, output: 10 } });
      p.writeTo(join(tmp, "claude"));
      const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "recompute", "index.mjs");
      const outFile = join(tmp, "out.json");
      for (const extra of [["--raw-keys"], ["--per-response", "--raw-keys"], ["--per-response", "--raw-keys", "--out", outFile]]) {
        const x = spawnSync(process.execPath, [script, "--claude-dir", join(tmp, "claude"), ...extra], { encoding: "utf8" });
        assert.equal(x.status, 2, extra.join(" "));
        assert.equal(x.stderr.trim(), "recompute: raw_keys_rejected");
        assert.equal(x.stdout, "");
      }
      assert.equal(existsSync(outFile), false, "no file is written");
      // a normal --out run writes salted ids only
      const ok = spawnSync(process.execPath, [script, "--claude-dir", join(tmp, "claude"), "--per-response", "--out", outFile], { encoding: "utf8" });
      assert.equal(ok.status, 0, ok.stderr);
      const text = readFileSync(outFile, "utf8");
      assert.equal(text.includes("synthetic-raw-key-probe"), false);
      assert.match(JSON.parse(text).responses[0].id, /^req_[0-9a-f]{8}$/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
