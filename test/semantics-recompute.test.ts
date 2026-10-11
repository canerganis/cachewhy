// Tests for scripts/recompute against docs/accounting-semantics.md (the checklist S1 to S11, spec revision 11.1).
// One focused test per checklist item that the recompute had to change. Every fixture is synthetic and written by hand
// from the checklist; nothing here imports from src/ (R13.1). Expected numbers are computed in the test.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recompute, recomputeFiles, toJson, type RecomputeResult } from "../scripts/recompute/index.mjs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
interface F {
  path: string;
  content: string;
  mtimeMs?: number;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const CV = "2.1.291"; // a fully supported Claude Code version
const XV = "0.160.1"; // a fully supported Codex CLI version
const RUN = Date.UTC(2026, 5, 1);

// ---------------------------------------------------------------------------
// A small price table in the layout of src/pricing/table.json, written by hand
// ---------------------------------------------------------------------------

const row = (input: string, output: string, read: string, w5: string, w1: string) => ({ input, output, cache_read: read, cache_write_5m: w5, cache_write_1h: w1 });
/** The documented multipliers of a listed model (R3.2, S8.5b (5)); fixtures store them so the table loads. */
const docMultipliers = (rawId: string): object | null => {
  const id = rawId.replace(/-[0-9]{8}$/, "");
  if (id.startsWith("claude-")) return { cache_read: ["claude-fable-5-1", "claude-mythos-5-1"].includes(id) ? "0.025" : ["claude-opus-5-5", "claude-sonnet-5-5"].includes(id) ? "0.05" : "0.1", cache_write_5m: "1.25", cache_write_1h: "2" };
  const m = /^gpt-([0-9]+)(?:\.([0-9]+))?(?:-|$)/.exec(id);
  if (m && (Number(m[1]) > 5 || (Number(m[1]) === 5 && Number(m[2] ?? 0) >= 6))) return { cached_input: id === "gpt-6.1-sol" ? "0.05" : "0.1", cache_write: "1.25" };
  return null;
};
const claudeEntry = (id: string, prices: object, extra: Obj = {}): Obj => ({
  id,
  provider: "anthropic",
  model_ids: [id],
  prices_usd_per_mtok: prices,
  tiers: null,
  long_context: null,
  fast: null,
  geo_us: { applies: true, multiplier: "1.1", verified: true },
  verified: true,
  verified_at: "2026-10-09",
  multipliers: docMultipliers(id),
  ...extra,
});
const gptEntry = (id: string, prices: object, lc: object | null): Obj => ({
  id,
  provider: "openai",
  model_ids: [id],
  prices_usd_per_mtok: prices,
  tiers: null,
  long_context: lc,
  fast: null,
  geo_us: null,
  verified: true,
  multipliers: docMultipliers(id),
  verified_at: "2026-10-09",
});
const SONNET = row("2", "10", "0.1", "2.5", "4");
const FAST = row("8", "40", "0.4", "10", "16");
function makeTable(over: Obj = {}, models: Obj[] | null = null): Obj {
  return {
    schema_version: 1,
    table_version: "pt-2026-10-09.1",
    verified_at: "2026-10-09",
    sources: { A1: "x", OM1: "y" },
    modifiers: { geo_us: { verified: true }, fast_with_geo_us: { verified: true } },
    models: models ?? [
      claudeEntry("claude-sonnet-5-5", SONNET),
      claudeEntry("claude-opus-5-5", row("4", "20", "0.2", "5", "8"), { fast: { prices_usd_per_mtok: FAST, verified: true, geo_us_applies: true } }),
      claudeEntry("claude-haiku-5-5", row("0.1", "0.5", "0.01", "0.125", "0.2"), {
        tiers: { split_tokens: 100000, high: row("0.5", "2.5", "0.05", "0.625", "1"), verified: true },
        fast: { prices_usd_per_mtok: row("0.2", "1", "0.02", "0.25", "0.4"), verified: true, geo_us_applies: true },
      }),
      gptEntry("gpt-6-sol", { input: "2", cached_input: "0.2", cache_write: "2.5", output: "10" }, {
        threshold_input_tokens: 272000,
        prices_usd_per_mtok: { input: "4", cached_input: "0.4", cache_write: "5", output: "15" },
        scope: "request",
        scope_verified: true,
        scope_source_id: "OM1",
        verified: true,
      }),
    ],
    ...over,
  };
}
const TABLE = makeTable();

// ---------------------------------------------------------------------------
// Claude line builders
// ---------------------------------------------------------------------------

/** An instant 2026-01-01T00:00:<sec>.<frac>Z with the given millisecond offset, as written text. */
const T = (sec: number, frac = "000") => `2026-01-01T00:00:${String(sec).padStart(2, "0")}.${frac}Z`;

interface CopyOpts {
  uuid?: string;
  sess?: string;
  agent?: string;
  req?: string | null;
  mid?: string;
  ts?: unknown;
  model?: unknown;
  usage?: Obj | null;
  final?: boolean;
  version?: string;
  extra?: Obj;
  msg?: Obj;
}
let uuidCounter = 0;
/** The full usage of a request: i=10, r=20, w5=30, w1=0, o=5. A non-final copy has no speed (R4.2). */
function usage(over: Obj = {}, final = true): Obj {
  const u: Obj = {
    input_tokens: 10,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 30,
    cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 0 },
    output_tokens: 5,
    ...(final ? { speed: "standard", inference_geo: "not_available", service_tier: "standard" } : {}),
    ...over,
  };
  for (const k of Object.keys(u)) if (u[k] === undefined) delete u[k];
  return u;
}
function copy(o: CopyOpts = {}): Obj {
  uuidCounter += 1;
  const rec: Obj = {
    type: "assistant",
    uuid: o.uuid ?? `synthetic-uuid-${uuidCounter}`,
    parentUuid: null,
    sessionId: o.sess ?? "synthetic-s1",
    timestamp: o.ts === undefined ? T(1) : o.ts,
    isSidechain: false,
    version: o.version ?? CV,
    message: { id: o.mid ?? "synthetic-m1", role: "assistant", model: o.model === undefined ? "claude-sonnet-5-5" : o.model, content: [{ type: "text", text: "x" }], ...(o.msg ?? {}) },
    ...(o.extra ?? {}),
  };
  if (o.req !== null) rec.requestId = o.req ?? "synthetic-r1";
  if (o.agent !== undefined) rec.agentId = o.agent;
  if (o.usage !== null) rec.message.usage = o.usage ?? usage();
  return rec;
}
const jsonl = (lines: Obj[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
const mainFile = (sess: string, lines: Obj[], mtimeMs?: number): F => ({ path: `projects/p/${sess}.jsonl`, content: jsonl(lines), ...(mtimeMs ? { mtimeMs } : {}) });

// ---------------------------------------------------------------------------
// Codex line builders
// ---------------------------------------------------------------------------

const CTS = (sec: number, frac = "000") => `2026-01-02T00:00:${String(sec).padStart(2, "0")}.${frac}Z`;
function xmeta(id: string, o: Obj = {}, env: Obj = {}): Obj {
  return {
    timestamp: CTS(0),
    type: "session_meta",
    ordinal: 0,
    payload: { id, session_id: id, timestamp: CTS(0), cli_version: XV, originator: "codex_cli", source: "cli", thread_source: "user", ...o },
    ...env,
  };
}
const xturn = (turn: string, model: unknown, ordinal: number, sec: number, env: Obj = {}): Obj => ({
  timestamp: CTS(sec),
  type: "turn_context",
  ordinal,
  payload: { turn_id: turn, root_turn_id: turn, model, effort: "medium" },
  ...env,
});
function xusage(over: Obj = {}): Obj {
  const u = { input_tokens: 1000, cached_input_tokens: 100, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 1050, ...over };
  for (const k of Object.keys(u)) if ((u as Obj)[k] === undefined) delete (u as Obj)[k];
  return u;
}
const xtur = (resp: string, thread: string, turn: string, ordinal: number, sec: number, usageObj: Obj | null = xusage(), env: Obj = {}, payloadExtra: Obj = {}): Obj => ({
  timestamp: CTS(sec),
  type: "token_usage_record",
  ordinal,
  payload: { response_id: resp, thread_id: thread, session_id: thread, turn_id: turn, ...(usageObj === null ? {} : { usage: usageObj }), ...payloadExtra },
  ...env,
});
const xfile = (name: string, lines: Obj[], mtimeMs?: number): F => ({ path: `sessions/2026/01/02/rollout-${name}.jsonl`, content: jsonl(lines), ...(mtimeMs ? { mtimeMs } : {}) });

// ---------------------------------------------------------------------------
// Run helpers
// ---------------------------------------------------------------------------

function run(files: F[], extra: Obj = {}): RecomputeResult {
  return recomputeFiles(files, { table: TABLE, runStartMs: RUN, ...extra });
}
function rows(r: RecomputeResult): Obj[] {
  return toJson(r, { perResponse: true, rawKeys: true }).responses as Obj[];
}
function rowOf(r: RecomputeResult, key: string): Obj {
  const [provider, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  const x = rows(r).find((e) => e.provider === provider && e.id === id);
  assert.ok(x, `row ${key} present`);
  return x;
}
const cov = (r: RecomputeResult, p: "claude" | "codex"): Obj => r.coverage[p] as Obj;

// ---------------------------------------------------------------------------
// S3: instants
// ---------------------------------------------------------------------------

describe("S3.1: the instant grammar and the calendar are checked without Date.parse", () => {
  const valid = [
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00.1Z",
    "2026-01-01T00:00:00.123456789Z",
    "2026-01-01T05:30:00+05:30",
    "2026-01-01T00:00:00-23:59",
    "2028-02-29T12:00:00Z",
    "2000-02-29T12:00:00Z",
    "0001-01-01T00:00:00Z",
    "9999-12-31T23:59:59.999999999Z",
  ];
  const invalid: Array<[string, unknown]> = [
    ["2026-02-30", "2026-02-30T00:00:00Z"],
    ["feb 29 not leap (1900)", "1900-02-29T00:00:00Z"],
    ["feb 29 not leap (2100)", "2100-02-29T00:00:00Z"],
    ["month 13", "2026-13-01T00:00:00Z"],
    ["day 00", "2026-01-00T00:00:00Z"],
    ["year 0000", "0000-01-01T00:00:00Z"],
    ["hour 24", "2026-01-01T24:00:00Z"],
    ["second 60", "2026-01-01T00:00:60Z"],
    ["minute 60", "2026-01-01T00:60:00Z"],
    ["10 fraction digits", "2026-01-01T00:00:00.1234567890Z"],
    ["empty fraction", "2026-01-01T00:00:00.Z"],
    ["lowercase t", "2026-01-01t00:00:00Z"],
    ["lowercase z", "2026-01-01T00:00:00z"],
    ["space separator", "2026-01-01 00:00:00Z"],
    ["no zone", "2026-01-01T00:00:00"],
    ["offset hour 24", "2026-01-01T00:00:00+24:00"],
    ["offset minute 60", "2026-01-01T00:00:00+05:60"],
    ["offset without colon", "2026-01-01T00:00:00+0530"],
    ["a number", 1767225600000],
    ["an object", { at: 1 }],
    ["a boolean", true],
    ["null", null],
  ];

  it("a request whose only copy has a valid instant is kept; every invalid or missing instant makes it usage_incomplete (R2.12 revision 11.1)", () => {
    const files: F[] = [];
    valid.forEach((v, i) => files.push(mainFile(`sv${i}`, [copy({ sess: `sv${i}`, req: `rv${i}`, mid: `mv${i}`, ts: v })])));
    invalid.forEach(([, v], i) => files.push(mainFile(`si${i}`, [copy({ sess: `si${i}`, req: `ri${i}`, mid: `mi${i}`, ts: v })])));
    files.push(mainFile("smissing", [copy({ sess: "smissing", req: "rmissing", mid: "mmissing", ts: undefined, extra: {} })].map((o) => (delete o.timestamp, o))));
    const r = run(files);
    const c = cov(r, "claude");
    assert.equal(c.responses_usage_incomplete, invalid.length + 1, "invalid + missing");
    assert.equal(r.providers.claude.totals.responses, valid.length);
    for (let i = 0; i < invalid.length; i++) assert.equal(rowOf(r, `claude:ri${i}`).status, "excluded:usage_incomplete", invalid[i]![0]);
    for (let i = 0; i < valid.length; i++) assert.equal(rowOf(r, `claude:rv${i}`).status, "counted", valid[i]);
  });
});

describe("S3.2, S3.3: instants are compared as nanoseconds, never truncated to milliseconds", () => {
  it("R4.4: two Codex occurrences of one response_id that differ only below a millisecond are conflict_attribution", () => {
    const a = xtur("x1", "synthetic-t1", "tn1", 2, 5, xusage(), { timestamp: "2026-01-02T00:00:05.1234567Z" });
    const b = xtur("x1", "synthetic-t1", "tn1", 2, 5, xusage(), { timestamp: "2026-01-02T00:00:05.1234568Z" });
    const same = xtur("x1", "synthetic-t1", "tn1", 2, 5, xusage(), { timestamp: "2026-01-02T00:00:05.12345670Z" });
    const head = [xmeta("synthetic-t1"), xturn("tn1", "gpt-6-sol", 1, 3)];
    const r = run([xfile("a", [...head, a, b])], { codexTierForTest: "standard" });
    assert.equal(cov(r, "codex").requests_conflict, 1);
    assert.deepEqual(cov(r, "codex").requests_conflict_by_kind, { conflict_attribution: 1 });
    assert.equal(r.providers.codex.totals.responses, 0);
    // 1234567 and 12345670 are the same instant (the fraction is right-padded): one response, no conflict
    const ok = run([xfile("a", [...head, a, same])], { codexTierForTest: "standard" });
    assert.equal(cov(ok, "codex").requests_conflict, 0);
    assert.equal(ok.providers.codex.totals.responses, 1);
  });

  it("R4.12 (c): timestamps that decrease by one microsecond fail the ordinal check", () => {
    const lines = [
      xmeta("synthetic-t2", {}, { timestamp: "2026-01-02T00:00:00.0000010Z" }),
      xturn("tn", "gpt-6-sol", 1, 1, { timestamp: "2026-01-02T00:00:01.0000020Z" }),
      xtur("x2", "synthetic-t2", "tn", 2, 2, xusage(), { timestamp: "2026-01-02T00:00:01.0000010Z" }),
    ];
    const r = run([xfile("b", lines)]);
    assert.equal(cov(r, "codex").chains_tainted_by_reason.ordinal_unverified, 1);
    // control: the same instants in order
    const ok = lines.map((l, i) => (i === 2 ? { ...l, timestamp: "2026-01-02T00:00:01.0000030Z" } : l));
    assert.equal(cov(run([xfile("b", ok)]), "codex").chains_tainted_by_reason.ordinal_unverified, 0);
  });

  it("R4.6: stream_start ties are decided at full precision (a sub-millisecond difference is no tie)", () => {
    const sharedA = copy({ sess: "sa", req: "shared", mid: "mshared", ts: "2026-01-01T00:00:05.0000001Z", usage: usage() });
    const sharedB = copy({ sess: "sb", req: "shared", mid: "mshared", ts: "2026-01-01T00:00:05.0000002Z", usage: usage() });
    const r = run([mainFile("sa", [sharedA]), mainFile("sb", [sharedB])]);
    const c = cov(r, "claude");
    assert.equal(c.replay_ownership_ambiguous, 0, "no tie: sa starts first");
    assert.equal(c.chains_tainted_by_reason.ownership_ambiguous, 0);
    assert.equal(r.providers.claude.totals.responses, 1);
    assert.equal(rows(r).find((x) => x.status === "counted")?.event, "2026-01-01T00:00:05.000Z");
    // control: the same instant in both streams is a tie
    const tie = run([mainFile("sa", [copy({ sess: "sa", req: "shared", mid: "mshared", ts: "2026-01-01T00:00:05.0000001Z" })]), mainFile("sb", [copy({ sess: "sb", req: "shared", mid: "mshared", ts: "2026-01-01T00:00:05.00000010Z" })])]);
    assert.equal(cov(tie, "claude").replay_ownership_ambiguous, 1);
  });

  it("S7.1: window membership is since * 10^6 <= t < until * 10^6 on the nanosecond value", () => {
    const at = (frac: string) => run([mainFile("w", [copy({ sess: "w", ts: `2026-01-01T00:00:00.${frac}Z` })])], { since: Date.UTC(2026, 0, 1, 0, 0, 0, 1), until: Date.UTC(2026, 0, 1, 0, 0, 0, 2) });
    assert.equal(at("000999999").providers.claude.totals.responses, 0, "one nanosecond before since");
    assert.equal(at("001000000").providers.claude.totals.responses, 1, "exactly since");
    assert.equal(at("001999999").providers.claude.totals.responses, 1, "one nanosecond before until");
    assert.equal(at("002000000").providers.claude.totals.responses, 0, "exactly until");
  });
});

// ---------------------------------------------------------------------------
// R2.12 revision 11.1: the event time is part of the usage row
// ---------------------------------------------------------------------------

describe("R2.12 revision 11.1 (G1 round 4 R13.2): a missing or bad timestamp makes the response usage_incomplete", () => {
  it("Claude: a copy without usage and without a valid timestamp makes the key usage_incomplete, with no window", () => {
    const good = copy({ ts: T(1), usage: usage({}, false) });
    const noUsageBadTs = copy({ ts: "2026-02-30T00:00:00Z", usage: null });
    const final = copy({ ts: T(2), usage: usage() });
    const r = run([mainFile("s1", [good, noUsageBadTs, final])]);
    const c = cov(r, "claude");
    assert.equal(c.responses_usage_incomplete, 1);
    assert.equal(r.providers.claude.totals.responses, 0);
    assert.deepEqual(c.chains_tainted_by_reason.request_anomaly, 1, "the chain is tainted");
    // the tokens are still reported: i + r + W + o over the usage-bearing copies
    assert.equal(c.tokens_in_incomplete_responses, String(10 + 20 + 30 + 5));
  });

  it("Claude: the order of exclusion is range, then incomplete (a bad timestamp included), then key_conflict", () => {
    // incomplete (bad timestamp) wins over conflict_input; range wins over incomplete
    const a = copy({ req: "r-a", mid: "m-a", ts: T(1), usage: usage() });
    const b = copy({ req: "r-a", mid: "m-a", ts: null, usage: usage({ input_tokens: 11 }) });
    const c1 = copy({ req: "r-b", mid: "m-b", ts: T(1), usage: usage() });
    const c2 = copy({ req: "r-b", mid: "m-b", ts: "bad", usage: usage({ output_tokens: -1 }) });
    const r = run([mainFile("s1", [a, b, c1, c2])]);
    assert.equal(rowOf(r, "claude:r-a").status, "excluded:usage_incomplete");
    assert.equal(rowOf(r, "claude:r-b").status, "excluded:usage_range_failed");
    assert.equal(cov(r, "claude").responses_usage_incomplete, 1);
    assert.equal(cov(r, "claude").responses_usage_range_failed, 1);
    assert.equal(cov(r, "claude").requests_conflict, 0, "conflict_input is not reached");
  });

  it("Codex: a token_usage_record whose envelope timestamp is missing or bad is usage_incomplete, with no window", () => {
    const head = [xmeta("synthetic-t3"), xturn("tn", "gpt-6-sol", 1, 1)];
    const okRec = xtur("ok", "synthetic-t3", "tn", 2, 2);
    const noTs = xtur("nots", "synthetic-t3", "tn", 3, 3);
    delete noTs.timestamp;
    const badTs = xtur("badts", "synthetic-t3", "tn", 4, 4, xusage(), { timestamp: "2026-01-02T24:00:00Z" });
    const r = run([xfile("c", [...head, okRec, noTs, badTs])], { codexTierForTest: "standard" });
    const c = cov(r, "codex");
    assert.equal(c.responses_usage_incomplete, 2);
    assert.equal(r.providers.codex.totals.responses, 1);
    // S6.3 Codex: I + O with every counter valid is in + out, once per response
    assert.equal(c.tokens_in_incomplete_responses, String(2 * (1000 + 50)));
    assert.equal(c.chains_tainted_by_reason.request_anomaly, 1);
  });
});

// ---------------------------------------------------------------------------
// S4.2, S6.3: BigInt and the incomplete token scalar
// ---------------------------------------------------------------------------

describe("S6.3: tokens_in_incomplete_responses is one scalar per provider, summed in BigInt (S4.2)", () => {
  it("Claude: i + r + W + o with the maximum of each field over the usage-bearing copies", () => {
    // copy A lacks output_tokens, copy B has output 2 and a larger cache read: the maxima are i=3, r=9, wt=40, o=2
    const a = copy({ req: "ra", mid: "ma", usage: { input_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 10 } } });
    const b = copy({ req: "ra", mid: "ma", usage: { input_tokens: 3, cache_read_input_tokens: 9, cache_creation_input_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 10 }, output_tokens: 2 } });
    // response rb: cache_creation_input_tokens missing, so W = w5 + w1 = 30 + 10; no output_tokens
    const c = copy({ req: "rb", mid: "mb", usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 10 } } });
    // response rc: wt is bad (a string), w5 valid, w1 bad: W = w5 only; output missing
    const d = copy({ req: "rc", mid: "mc", usage: { input_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: "x", cache_creation: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: "y" } } });
    const r = run([mainFile("s1", [a, b, c, d])]);
    const cc = cov(r, "claude");
    assert.equal(cc.responses_usage_incomplete, 3);
    assert.equal(cc.tokens_in_incomplete_responses, String(3 + 9 + 40 + 2 + (1 + 2 + 40) + (4 + 5 + 6)));
    // the per-field map stays as an extra output
    assert.equal(cc.tokens_in_incomplete_by_field.i, String(3 + 1 + 4));
  });

  it("Claude: a sum beyond 2^53 is exact (BigInt)", () => {
    const a = copy({ usage: { input_tokens: MAX_SAFE, cache_read_input_tokens: MAX_SAFE, cache_creation_input_tokens: MAX_SAFE, cache_creation: { ephemeral_5m_input_tokens: MAX_SAFE, ephemeral_1h_input_tokens: 0 } } });
    const r = run([mainFile("s1", [a])]);
    assert.equal(cov(r, "claude").tokens_in_incomplete_responses, (3n * BigInt(MAX_SAFE)).toString());
  });

  it("Codex: I + O, I = in when valid else c + cw, O = out when valid else rs; a valid inner counter is not added to a valid outer one", () => {
    const head = [xmeta("synthetic-t4"), xturn("tn", "gpt-6-sol", 1, 1)];
    // in missing: I = c + cw = 15; out valid: O = 7 (rs = 3 is not added)
    const r1 = xtur("r1", "synthetic-t4", "tn", 2, 2, xusage({ input_tokens: undefined, cached_input_tokens: 10, cache_write_input_tokens: 5, output_tokens: 7, reasoning_output_tokens: 3 }));
    // out missing: O = rs = 4; in valid: I = 100 (c = 60 is not added)
    const r2 = xtur("r2", "synthetic-t4", "tn", 3, 3, xusage({ input_tokens: 100, cached_input_tokens: 60, output_tokens: undefined, reasoning_output_tokens: 4 }));
    // both outer counters missing and no inner ones valid: 0 + c
    const r3 = xtur("r3", "synthetic-t4", "tn", 4, 4, xusage({ input_tokens: "n/a", cached_input_tokens: 9, cache_write_input_tokens: undefined, output_tokens: null, reasoning_output_tokens: undefined }));
    const r = run([xfile("d", [...head, r1, r2, r3])], { codexTierForTest: "standard" });
    const c = cov(r, "codex");
    assert.equal(c.responses_usage_incomplete, 3);
    assert.equal(c.tokens_in_incomplete_responses, String(15 + 7 + (100 + 4) + 9));
  });

  it("Codex: a sum beyond 2^53 is exact (BigInt)", () => {
    const head = [xmeta("synthetic-t5"), xturn("tn", "gpt-6-sol", 1, 1)];
    const r1 = xtur("r1", "synthetic-t5", "tn", 2, 2, xusage({ input_tokens: MAX_SAFE, output_tokens: MAX_SAFE, total_tokens: undefined }));
    const r = run([xfile("e", [...head, r1])], { codexTierForTest: "standard" });
    assert.equal(cov(r, "codex").tokens_in_incomplete_responses, (2n * BigInt(MAX_SAFE)).toString());
  });

  it("a range-failed response adds nothing, and a window thins the scalar like the other logical counters", () => {
    const a = copy({ req: "ra", mid: "ma", ts: T(1), usage: { input_tokens: 5, cache_read_input_tokens: 5, cache_creation_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 0 } } });
    const b = copy({ req: "rb", mid: "mb", ts: T(30), usage: { input_tokens: 7, cache_read_input_tokens: 7, cache_creation_input_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 0 } } });
    const bad = copy({ req: "rc", mid: "mc", ts: T(2), usage: { input_tokens: -1, cache_read_input_tokens: 5, cache_creation_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 0 } } });
    const files = [mainFile("s1", [a, b, bad])];
    assert.equal(cov(run(files), "claude").tokens_in_incomplete_responses, String(15 + 21));
    assert.equal(cov(run(files, { since: Date.UTC(2026, 0, 1, 0, 0, 10) }), "claude").tokens_in_incomplete_responses, String(21));
  });
});

// ---------------------------------------------------------------------------
// S6.1: independent conflicts and conflict_diagnostics
// ---------------------------------------------------------------------------

describe("S6.1: conflict_output and conflict_iterations are decided independently; conflict_diagnostics is counted without taint", () => {
  it("disagreeing final outputs and a disagreeing iterations[0] are both recorded", () => {
    const f1 = copy({ ts: T(1), usage: usage({ output_tokens: 5, iterations: [{ input_tokens: 99, output_tokens: 5 }] }) });
    const f2 = copy({ ts: T(2), usage: usage({ output_tokens: 6 }) });
    const r = run([mainFile("s1", [f1, f2])]);
    const c = cov(r, "claude");
    assert.deepEqual(c.requests_conflict_by_kind, { conflict_output: 1, conflict_iterations: 1 });
    assert.equal(c.requests_conflict, 1, "one request");
    const x = rowOf(r, "claude:synthetic-r1");
    assert.deepEqual(x.flags.filter((f: string) => f.startsWith("conflict")), ["conflict_iterations", "conflict_output"]);
    assert.equal(x.buckets.output, null, "output unknown");
    assert.equal(x.unpriced_reason, "chain_tainted");
    assert.equal(c.chains_tainted_by_reason.request_anomaly, 1);
  });

  it("an iterations conflict alone and an output conflict alone are still each recorded", () => {
    const itOnly = run([mainFile("s1", [copy({ usage: usage({ iterations: [{ cache_read_input_tokens: 21 }] }) })])]);
    assert.deepEqual(cov(itOnly, "claude").requests_conflict_by_kind, { conflict_iterations: 1 });
    const outOnly = run([mainFile("s1", [copy({ ts: T(1), usage: usage({ output_tokens: 5 }) }), copy({ ts: T(2), usage: usage({ output_tokens: 6 }) })])]);
    assert.deepEqual(cov(outOnly, "claude").requests_conflict_by_kind, { conflict_output: 1 });
  });

  it("conflict_diagnostics: two different non-null types over the copies are counted, with no exclusion and no taint", () => {
    const diag = (type: unknown) => ({ diagnostics: { cache_miss_reason: type === undefined ? null : { type, cache_missed_input_tokens: 100 } } });
    const a = copy({ ts: T(1), usage: usage({}, false), msg: diag("messages_changed") });
    const b = copy({ ts: T(2), usage: usage(), msg: diag("tools_changed") });
    const same = run([mainFile("s1", [copy({ ts: T(1), usage: usage({}, false), msg: diag("messages_changed") }), copy({ ts: T(2), usage: usage(), msg: diag("messages_changed") })])]);
    assert.deepEqual(cov(same, "claude").requests_conflict_by_kind, {});
    const r = run([mainFile("s1", [a, b])]);
    const c = cov(r, "claude");
    assert.deepEqual(c.requests_conflict_by_kind, { conflict_diagnostics: 1 });
    assert.equal(c.requests_conflict, 0, "not an exclusion conflict");
    assert.equal(c.chains_tainted, 0, "no taint");
    const x = rowOf(r, "claude:synthetic-r1");
    assert.equal(x.status, "counted");
    assert.equal(x.usd_pico, String(10n * 2000000n + 20n * 100000n + 30n * 2500000n + 5n * 10000000n), "priced");
    // a null cache_miss_reason takes part in no comparison; an unlisted type is `other`, a listed one is itself
    const withNull = run([mainFile("s1", [copy({ ts: T(1), usage: usage({}, false), msg: diag(undefined) }), copy({ ts: T(2), usage: usage(), msg: diag("tools_changed") })])]);
    assert.deepEqual(cov(withNull, "claude").requests_conflict_by_kind, {});
    const other = run([mainFile("s1", [copy({ ts: T(1), usage: usage({}, false), msg: diag("surprise") }), copy({ ts: T(2), usage: usage(), msg: diag("tools_changed") })])]);
    assert.deepEqual(cov(other, "claude").requests_conflict_by_kind, { conflict_diagnostics: 1 });
  });
});

// ---------------------------------------------------------------------------
// S3.5: ordinal check (c) and unverified versions
// ---------------------------------------------------------------------------

describe("S3.5: ordinal check (c) skips a record without a valid instant; unverified streams get version_unverified only", () => {
  it("a non-decision record with an ordinal and no valid instant fails nothing; an ordinal-decision record must have one", () => {
    const base = [xmeta("synthetic-t6"), xturn("tn", "gpt-6-sol", 1, 1), xtur("x", "synthetic-t6", "tn", 3, 3)];
    const item = (ts: unknown) => ({ timestamp: ts, type: "response_item", ordinal: 2, payload: { type: "message" } });
    for (const ts of ["2026-02-30T00:00:00Z", null, "bad", 12]) {
      const r = run([xfile("f", [...base, item(ts)])]);
      assert.equal(cov(r, "codex").chains_tainted_by_reason.ordinal_unverified, 0, String(ts));
    }
    // a response_item with a valid instant that decreases is still a decreasing timestamp
    const dec = { timestamp: CTS(0), type: "response_item", ordinal: 2, payload: {} };
    assert.equal(cov(run([xfile("f", [...base, dec])]), "codex").chains_tainted_by_reason.ordinal_unverified, 1);
    // an ordinal-decision record without a valid instant fails the stream
    const noTs = { ...xturn("tn2", "gpt-6-sol", 2, 2), timestamp: "2026-02-30T00:00:00Z" };
    assert.equal(cov(run([xfile("f", [...base, noTs])]), "codex").chains_tainted_by_reason.ordinal_unverified, 1);
    // a record with an out-of-range ordinal fails the stream whatever its type
    assert.equal(cov(run([xfile("f", [...base, { ...item(CTS(2)), ordinal: -1 }])]), "codex").chains_tainted_by_reason.ordinal_unverified, 1);
  });

  it("a stream of an unverified version gets version_unverified only: no ordinal_unverified, no fork_prefix_unresolved", () => {
    const parent = xmeta("synthetic-tp");
    const child = xmeta("synthetic-tc", { cli_version: "0.150.0", forked_from_id: "synthetic-tp" }, { ordinal: 0 });
    // the child has no ordinal on a decision record and no subagent_history_start_ordinal
    const noOrd = xturn("tn", "gpt-6-sol", 1, 1);
    delete noOrd.ordinal;
    const r = run([xfile("p", [parent, xturn("tp", "gpt-6-sol", 1, 1), xtur("p1", "synthetic-tp", "tp", 2, 2)]), xfile("c", [child, noOrd, xtur("c1", "synthetic-tc", "tn", 2, 2)])]);
    const c = cov(r, "codex");
    assert.equal(c.chains_tainted_by_reason.version_unverified, 2, "the family of the child: parent and child");
    assert.equal(c.chains_tainted_by_reason.ordinal_unverified, 0);
    assert.equal(c.chains_tainted_by_reason.fork_prefix_unresolved, 0);
    assert.equal(c.families_ordinal_unverified, 0);
    // control: the same child on a supported version fails both checks
    const sup = xmeta("synthetic-tc", { forked_from_id: "synthetic-tp" });
    const r2 = run([xfile("p", [parent, xturn("tp", "gpt-6-sol", 1, 1), xtur("p1", "synthetic-tp", "tp", 2, 2)]), xfile("c", [sup, noOrd, xtur("c1", "synthetic-tc", "tn", 2, 2)])]);
    assert.equal(cov(r2, "codex").families_ordinal_unverified, 1);
    assert.ok(cov(r2, "codex").chains_tainted_by_reason.ordinal_unverified >= 1);
    assert.ok(cov(r2, "codex").chains_tainted_by_reason.fork_prefix_unresolved >= 1);
  });
});

// ---------------------------------------------------------------------------
// S2: model ids
// ---------------------------------------------------------------------------

describe("S2.2, S2.4: model normal form", () => {
  it("S2.2: the model `<synthetic>` is the reserved value, distinct from an unlisted model, in the record equality projection", () => {
    // two api error records that differ only in the model: `<synthetic>` versus an unlisted string
    const err = (model: string, uuid: string) => copy({ uuid, req: null, mid: "me", model, usage: usage(), extra: { isApiErrorMessage: true } });
    const r = run([mainFile("s1", [err("<synthetic>", "u1"), err("<SYNTHETIC>", "u1"), err("<synthetic>", "u1")])]);
    assert.equal(cov(r, "claude").api_error_records, 2, "the reserved value and `unlisted` are two records; the repeated line is one");
  });

  it("S2.4: a table model id with a date suffix is looked up by its stripped form, and the suffix is stripped once", () => {
    const table = makeTable({}, [claudeEntry("claude-sonnet-5-5-20261001", SONNET)]);
    const files = [
      mainFile("s1", [copy({ req: "ra", mid: "ma", model: "claude-sonnet-5-5-20260101" })]),
      mainFile("s2", [copy({ sess: "s2", req: "rb", mid: "mb", model: "claude-sonnet-5-5" })]),
      // two suffixes: the normal form keeps the first one, which is no table id
      mainFile("s3", [copy({ sess: "s3", req: "rc", mid: "mc", model: "claude-sonnet-5-5-20260101-20260102" })]),
    ];
    const r = recomputeFiles(files, { table, runStartMs: RUN });
    assert.equal(rowOf(r, "claude:ra").unpriced_reason, undefined);
    assert.equal(rowOf(r, "claude:ra").model, "claude-sonnet-5-5");
    assert.notEqual(rowOf(r, "claude:rb").usd_pico, null);
    assert.equal(rowOf(r, "claude:rc").unpriced_reason, "unknown_model");
    assert.equal(rowOf(r, "claude:rc").model, "unlisted");
    // an over-long value has no model at all, and an unusable one is `unlisted`
    const odd = run([mainFile("s1", [copy({ req: "ra", mid: "ma", model: "m".repeat(81) }), copy({ req: "rb", mid: "mb", model: "UPPER" })])]);
    assert.equal(rowOf(odd, "claude:ra").model, "unlisted", "no model: model_unknown, reported with the unlisted label");
    assert.equal(rowOf(odd, "claude:ra").unpriced_reason, "model_unknown");
    assert.equal(rowOf(odd, "claude:rb").unpriced_reason, "unknown_model");
  });

  it("S2.2: unlisted is a model value; null takes part in no comparison", () => {
    const unl = (m: unknown, ts: string) => copy({ ts, model: m, usage: usage({}, ts === T(2)) });
    const same = run([mainFile("s1", [unl("UPPER", T(1)), unl("OTHER!", T(2))])]);
    assert.equal(cov(same, "claude").requests_conflict, 0, "two unlisted values agree");
    const diff = run([mainFile("s1", [unl("UPPER", T(1)), unl("claude-opus-5-5", T(2))])]);
    assert.deepEqual(cov(diff, "claude").requests_conflict_by_kind, { conflict_model: 1 });
    const nul = run([mainFile("s1", [unl(null, T(1)), unl("claude-sonnet-5-5", T(2))])]);
    assert.equal(cov(nul, "claude").requests_conflict, 0, "a null model is compared with nothing");
  });
});

// ---------------------------------------------------------------------------
// S5.1: the record equality projection
// ---------------------------------------------------------------------------

describe("S5.1, S1.3: the projection treats null and absence as one state and an empty container as an absent one", () => {
  const keyless = (extra: Obj, usageOver: Obj = {}) => copy({ req: null, mid: "mk", usage: usage(usageOver), extra, uuid: "uk" });

  it("output_tokens_details absent and present without thinking_tokens are one projection state", () => {
    const a = keyless({});
    const b = keyless({});
    b.message.usage.output_tokens_details = {};
    const c = keyless({});
    c.message.usage.output_tokens_details = null;
    const r = run([mainFile("s1", [a, b, c])]);
    assert.equal(cov(r, "claude").records_unkeyed, 1);
    // a thinking_tokens value is a leaf field: it separates records
    const d = keyless({});
    d.message.usage.output_tokens_details = { thinking_tokens: 3 };
    assert.equal(cov(run([mainFile("s1", [a, d])]), "claude").records_unkeyed, 2);
  });

  it("an absent agentId stays `missing`, distinct from the string `main`", () => {
    const a = keyless({});
    const b = keyless({ agentId: "main" });
    assert.equal(cov(run([mainFile("s1", [a, b])]), "claude").records_unkeyed, 2);
  });

  it("an id of the wrong type is `bad`, distinct from a missing one and from another bad one only by state", () => {
    const a = keyless({});
    const b = keyless({ parentUuid: 5 });
    const c = keyless({ parentUuid: { x: 1 } });
    const d = keyless({ parentUuid: null });
    const r = run([mainFile("s1", [a, b, c, d])]);
    assert.equal(cov(r, "claude").records_unkeyed, 2, "{absent, null} and {5, object}");
  });

  it("stop_reason null equals absent (S1.3); a diagnostics container without the leaf equals an absent one", () => {
    const a = keyless({});
    const b = keyless({});
    b.message.stop_reason = null;
    const c = keyless({});
    c.message.diagnostics = { cache_miss_reason: {} };
    const d = keyless({});
    d.message.diagnostics = {};
    assert.equal(cov(run([mainFile("s1", [a, b, c, d])]), "claude").records_unkeyed, 1);
  });

  it("booleans keep missing: isSidechain false and absent are two records", () => {
    const a = keyless({});
    const b = keyless({ isSidechain: false });
    b.isSidechain = false;
    const c = keyless({});
    delete c.isSidechain;
    assert.equal(cov(run([mainFile("s1", [b, c])]), "claude").records_unkeyed, 2);
  });
});

describe("S1.3, S1.4: Codex projection states", () => {
  // two session_meta records of one stream with the same ordinal collide unless their projections are equal
  const collide = (a: Obj, b: Obj) => run([xfile("m", [a, b, xturn("tn", "gpt-6-sol", 1, 1), xtur("x", "synthetic-tm", "tn", 2, 2)])]);

  it("JSON null equals absent for source, forked_from_id, thread_source and an object-valued thread_token_usage", () => {
    for (const field of ["source", "thread_source", "forked_from_id", "parent_thread_id", "agent_role", "originator"]) {
      const a = xmeta("synthetic-tm");
      const b = xmeta("synthetic-tm");
      delete a.payload[field];
      b.payload[field] = null;
      assert.equal(cov(collide(a, b), "codex").chains_tainted_by_reason.ordinal_unverified, 0, field);
    }
    // an unlisted value is a state of its own (`other`)
    const a = xmeta("synthetic-tm");
    const b = xmeta("synthetic-tm", { thread_source: "surprise" });
    delete a.payload.thread_source;
    assert.equal(cov(collide(a, b), "codex").chains_tainted_by_reason.ordinal_unverified, 1);
    // the cumulative objects: absent, null and {} differ only where S5.1 says (absent == null, {} has no members either)
    const t1 = xtur("x", "synthetic-tm", "tn", 2, 2);
    const t2 = xtur("x", "synthetic-tm", "tn", 2, 2, xusage(), {}, { thread_token_usage: null, turn_token_usage: null });
    const r = run([xfile("m", [xmeta("synthetic-tm"), xturn("tn", "gpt-6-sol", 1, 1), t1, t2])]);
    assert.equal(cov(r, "codex").requests_conflict, 0);
    const t3 = xtur("x", "synthetic-tm", "tn", 2, 2, xusage(), {}, { thread_token_usage: "str" });
    assert.equal(cov(run([xfile("m", [xmeta("synthetic-tm"), xturn("tn", "gpt-6-sol", 1, 1), t1, t3])]), "codex").requests_conflict, 1, "a cumulative object that is not an object is `bad`");
  });

  it("optional integers keep their states: missing, bad and range are three values", () => {
    const withHist = (v: unknown) => xmeta("synthetic-tm", { subagent_history_start_ordinal: v });
    const states: unknown[] = [undefined, "5", -1, 1.5, MAX_SAFE + 2, 3];
    const make = (v: unknown) => {
      const m = withHist(v);
      if (v === undefined) delete m.payload.subagent_history_start_ordinal;
      return m;
    };
    // null equals absent
    const nullM = withHist(null);
    assert.equal(cov(collide(make(undefined), nullM), "codex").chains_tainted_by_reason.stream_unresolved, 0);
    // "5" is bad; -1, 1.5 and 2^53 + 1 are range: two states, so bad and range differ, range and range agree
    const count = (a: unknown, b: unknown) => cov(collide(make(a), make(b)), "codex").chains_tainted_by_reason.stream_unresolved;
    assert.equal(count("5", -1), 1);
    assert.equal(count(-1, 1.5), 0);
    assert.equal(count(1.5, MAX_SAFE + 2), 0);
    assert.equal(count(undefined, "5"), 1);
    assert.equal(count(undefined, 3), 1);
    assert.equal(count(3, 3), 0);
    void states;
  });

  it("a turn_context without a model and one with an unlisted model are one projection state (S2.3)", () => {
    const a = xturn("tn", undefined, 1, 1);
    delete a.payload.model;
    const b = xturn("tn", "NOT A MODEL", 1, 1);
    const c = xturn("tn", null, 1, 1);
    const r = run([xfile("m", [xmeta("synthetic-tm"), a, b, c, xtur("x", "synthetic-tm", "tn", 2, 2)])]);
    assert.equal(cov(r, "codex").chains_tainted_by_reason.ordinal_unverified, 0);
  });
});

// ---------------------------------------------------------------------------
// S8: pricing gates
// ---------------------------------------------------------------------------

describe("S8.2: geo us needs the table-level modifiers.geo_us and the model's geo_us", () => {
  const geoUs = (extra: Obj = {}, model = "claude-sonnet-5-5") => mainFile("s1", [copy({ model, usage: usage({ inference_geo: "us", ...extra }) })]);
  const base = 10n * 2000000n + 20n * 100000n + 30n * 2500000n + 5n * 10000000n;

  it("priced with the multiplier when the table object and the model object are verified and apply", () => {
    const r = run([geoUs()]);
    assert.equal(rowOf(r, "claude:synthetic-r1").usd_pico, ((base * 11n + 5n) / 10n).toString());
  });

  it("without a verified table-level geo_us the response is unpriced geo_other", () => {
    for (const modifiers of [{ fast_with_geo_us: { verified: true } }, { geo_us: { verified: false }, fast_with_geo_us: { verified: true } }, { geo_us: { verified: true, verified_at: "n/a" }, fast_with_geo_us: { verified: true } }]) {
      const r = recomputeFiles([geoUs()], { table: makeTable({ modifiers }), runStartMs: RUN });
      assert.equal(rowOf(r, "claude:synthetic-r1").unpriced_reason, "geo_other", JSON.stringify(modifiers));
    }
    // a modifier object without a boolean verified refuses the table (S8.5b)
    assert.throws(() => recomputeFiles([geoUs()], { table: makeTable({ modifiers: { geo_us: { verified: "true" }, fast_with_geo_us: { verified: true } } }), runStartMs: RUN }), /table_malformed/);
    // the table's own date makes it effective (S8.1): no own verified_at needed
    const ok = recomputeFiles([geoUs()], { table: makeTable({ modifiers: { geo_us: { verified: true }, fast_with_geo_us: { verified: true } } }), runStartMs: RUN });
    assert.notEqual(rowOf(ok, "claude:synthetic-r1").usd_pico, null);
  });

  it("a model whose geo_us does not apply or is unverified is geo_other", () => {
    const noApply = makeTable({}, [claudeEntry("claude-sonnet-5-5", SONNET, { geo_us: { applies: false, verified: true } })]);
    assert.equal(rowOf(recomputeFiles([geoUs()], { table: noApply, runStartMs: RUN }), "claude:synthetic-r1").unpriced_reason, "geo_other");
    const unverified = makeTable({}, [claudeEntry("claude-sonnet-5-5", SONNET, { geo_us: { applies: true, verified: false } })]);
    assert.equal(rowOf(recomputeFiles([geoUs()], { table: unverified, runStartMs: RUN }), "claude:synthetic-r1").unpriced_reason, "geo_other");
  });

  it("fast with geo us needs the table geo_us, the model geo_us, fast_with_geo_us and fast.geo_us_applies === true", () => {
    const fastGeo = () => geoUs({ speed: "fast" }, "claude-opus-5-5");
    const fastBase = 10n * 8000000n + 20n * 400000n + 30n * 10000000n + 5n * 40000000n;
    const ok = run([fastGeo()]);
    assert.equal(rowOf(ok, "claude:synthetic-r1").usd_pico, ((fastBase * 11n + 5n) / 10n).toString());
    const reasons = (table: Obj) => rowOf(recomputeFiles([fastGeo()], { table, runStartMs: RUN }), "claude:synthetic-r1").unpriced_reason;
    assert.equal(reasons(makeTable({ modifiers: { fast_with_geo_us: { verified: true } } })), "fast_geo_unverified", "no table-level geo_us");
    assert.equal(reasons(makeTable({ modifiers: { geo_us: { verified: true } } })), "fast_geo_unverified", "no fast_with_geo_us");
    const noFlag = makeTable({}, [claudeEntry("claude-opus-5-5", row("4", "20", "0.2", "5", "8"), { fast: { prices_usd_per_mtok: FAST, verified: true, geo_us_applies: "true" } })]);
    assert.equal(reasons(noFlag), "fast_geo_unverified", "geo_us_applies must be the boolean true");
  });
});

describe("S8.3, R3.9: the gate order of the unpriced reason", () => {
  it("a fast response above the Haiku split is tier_unverified (the fast row has no tier row)", () => {
    const big = usage({ input_tokens: 100001, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, speed: "fast" });
    const small = usage({ input_tokens: 100000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, speed: "fast" });
    const r = run([mainFile("s1", [copy({ req: "big", mid: "mbig", model: "claude-haiku-5-5", usage: big }), copy({ sess: "s2", req: "small", mid: "msmall", model: "claude-haiku-5-5", usage: small })])]);
    assert.equal(rowOf(r, "claude:big").unpriced_reason, "tier_unverified");
    assert.equal(rowOf(r, "claude:small").unpriced_reason, undefined, "at the split the low tier applies, so the fast row prices it");
    assert.equal(rowOf(r, "claude:small").usd_pico, String(100000n * 200000n + 5n * 1000000n));
  });

  // R3.9 gate (6) is only reachable for a response whose output is unknown although a final copy exists, and every such
  // response (conflict_output, conflict_iterations) taints its chain and is refused by gate (1) first.
  it("the order is conflict_modifier, modifier_unverified, speed_other, geo_other, row gates, geo_other (us), bucket_unknown", () => {
    // each response fails every gate from its own one down; the first refusing gate takes all its tokens
    const noCC = (o: Obj) => ({ ...usage(o), cache_creation: undefined, cache_creation_input_tokens: 30 });
    const cases: Array<[string, string, Obj, Obj?]> = [
      // [request id, expected reason, final usage, extra copy usage]
      ["speed-other", "speed_other", usage({ speed: "weird", inference_geo: "other" })],
      ["geo-other", "geo_other", usage({ inference_geo: "other", service_tier: "priority" })],
      ["tier-priority", "service_tier_unpriced", usage({ service_tier: "priority", inference_geo: "us" })],
      ["fast-no-row", "speed_fast_no_row", usage({ speed: "fast", inference_geo: "us" })],
      ["bucket", "bucket_unknown", noCC({})],
    ];
    const lines = cases.map(([id, , u]) => copy({ sess: "s-" + id, req: id, mid: "m-" + id, model: "claude-sonnet-5-5", usage: u }));
    const files = cases.map(([id], i) => mainFile("s-" + id, [lines[i]!]));
    const r = run(files);
    for (const [id, reason] of cases) assert.equal(rowOf(r, `claude:${id}`).unpriced_reason, reason, id);
    // the amounts go to that reason only
    const unp = (r.coverage.claude as Obj).tokens_unpriced_by_reason as Record<string, string>;
    const sum = Object.values(unp).reduce((a, b) => a + BigInt(b), 0n);
    assert.equal(sum, BigInt(r.providers.claude.totals.tokens_unpriced));
  });
});

describe("S8.5a: a scope_source_id names a source iff it is an own key of the table's sources", () => {
  it("`constructor`, `toString` and `__proto__` are no sources", () => {
    const head = [xmeta("synthetic-tx"), xturn("tn", "gpt-6-sol", 1, 1), xtur("x1", "synthetic-tx", "tn", 2, 2)];
    const tableWith = (id: string) => makeTable({}, [gptEntry("gpt-6-sol", { input: "2", cached_input: "0.2", cache_write: "2.5", output: "10" }, { threshold_input_tokens: 272000, prices_usd_per_mtok: { input: "4", cached_input: "0.4", cache_write: "5", output: "15" }, scope: "request", scope_verified: true, scope_source_id: id, verified: true })]);
    for (const id of ["constructor", "toString", "__proto__", "hasOwnProperty", "missing-source"]) {
      const r = recomputeFiles([xfile("g", head)], { table: tableWith(id), runStartMs: RUN, codexTierForTest: "standard" });
      assert.equal(rowOf(r, "codex:x1").unpriced_reason, "long_context_scope", id);
    }
    const ok = recomputeFiles([xfile("g", head)], { table: tableWith("OM1"), runStartMs: RUN, codexTierForTest: "standard" });
    assert.notEqual(rowOf(ok, "codex:x1").usd_pico, null);
  });
});

// ---------------------------------------------------------------------------
// S7.5
// ---------------------------------------------------------------------------

describe("S7.5: replay_requests_excluded counts the replayed representations of accounted responses in the window", () => {
  it("one per non-owner chain holding a copy; excluded responses and responses outside the window add nothing", () => {
    // sa owns keys k1 (in the window), k2 (before the window) and k3 (incomplete: excluded); sb and sc replay k1
    const own = (sess: string, req: string, sec: number, u: Obj = usage()) => copy({ sess, req, mid: "m-" + req, ts: T(sec), usage: u });
    const sa = mainFile("sa", [own("sa", "k1", 20), own("sa", "k2", 1), own("sa", "k3", 21, usage({ output_tokens: undefined }))]);
    const sb = mainFile("sb", [own("sb", "k1", 30), own("sb", "k3", 31, usage({ output_tokens: undefined })), own("sb", "k2", 32)]);
    const sc = mainFile("sc", [own("sc", "k1", 40)]);
    const files = [sa, sb, sc];
    // before sa starts: stream starts decide the owner, so give sa the earliest record
    const all = run(files);
    assert.equal(cov(all, "claude").replay_requests_excluded, 2 + 1, "k1: sb and sc; k2: sb");
    const win = run(files, { since: Date.UTC(2026, 0, 1, 0, 0, 10) });
    assert.equal(cov(win, "claude").replay_requests_excluded, 2, "k2 is before the window");
    assert.equal(win.providers.claude.totals.responses, 1);
  });
});

// ---------------------------------------------------------------------------
// R5.10, S6.5: baseline and ledger times
// ---------------------------------------------------------------------------

describe("R5.10, S6.5: baseline counts the requests before since; an entry without a time is in every window", () => {
  it("baseline_requests_loaded counts accounted responses before `since`, not those after `until`", () => {
    const own = (req: string, sec: number) => copy({ req, mid: "m-" + req, ts: T(sec) });
    const files = [mainFile("s1", [own("before", 1), own("inside", 20), own("after", 50)])];
    const r = run(files, { since: Date.UTC(2026, 0, 1, 0, 0, 10), until: Date.UTC(2026, 0, 1, 0, 0, 30) });
    assert.equal(r.providers.claude.totals.responses, 1);
    assert.equal(cov(r, "claude").baseline_requests_loaded, 1);
  });

  it("an excluded response with no valid instant at all has no ledger time and is counted in every window", () => {
    const noTime = copy({ req: "range", mid: "m-range", ts: "2026-02-30T00:00:00Z", usage: usage({ input_tokens: -1 }) });
    const inside = copy({ req: "ok", mid: "m-ok", ts: T(20) });
    const files = [mainFile("s1", [noTime, inside])];
    for (const w of [{}, { since: Date.UTC(2026, 0, 1, 0, 0, 10), until: Date.UTC(2026, 0, 1, 0, 0, 30) }, { since: Date.UTC(2027, 0, 1) }]) {
      assert.equal(cov(run(files, w), "claude").responses_usage_range_failed, 1, JSON.stringify(w));
    }
  });
});

// ---------------------------------------------------------------------------
// S10: kinds
// ---------------------------------------------------------------------------

describe("S10.2, S10.3: Codex kind", () => {
  const oneThread = (id: string, meta: Obj | null) => {
    const lines: Obj[] = [];
    if (meta) lines.push(meta);
    lines.push(xturn("tn-" + id, "gpt-6-sol", 1, 1), xtur("r-" + id, id, "tn-" + id, 2, 2));
    return xfile(id, lines);
  };

  it("an unlisted thread_source and a missing one are `main`, never `unclassified`", () => {
    const files = [
      oneThread("t-user", xmeta("t-user")),
      oneThread("t-unlisted", xmeta("t-unlisted", { thread_source: "surprise" })),
      oneThread("t-missing", (() => { const m = xmeta("t-missing"); delete m.payload.thread_source; return m; })()),
      oneThread("t-null", xmeta("t-null", { thread_source: null })),
      oneThread("t-sub", xmeta("t-sub", { thread_source: "subagent" })),
      oneThread("t-agent", xmeta("t-agent", { thread_source: "agent_created_thread" })),
      oneThread("t-spawn", xmeta("t-spawn", { thread_source: "other-thing", source: { subagent: { thread_spawn: { parent_thread_id: "t-user", depth: 1 } } } })),
      oneThread("t-auto", xmeta("t-auto", { thread_source: "automation" })),
      oneThread("t-guard", xmeta("t-guard", { thread_source: "guardian_review" })),
    ];
    const r = run(files);
    const kind = (id: string) => rowOf(r, `codex:r-${id}`).kind;
    for (const id of ["t-user", "t-unlisted", "t-missing", "t-null"]) assert.equal(kind(id), "main", id);
    for (const id of ["t-sub", "t-agent", "t-spawn"]) assert.equal(kind(id), "subagent", id);
    assert.equal(kind("t-auto"), "helper");
    assert.equal(kind("t-guard"), "classifier");
    assert.equal(r.providers.codex.by_kind.unclassified, undefined);
    const sum = Object.values(r.providers.codex.by_kind).reduce((a, k) => a + k.responses, 0);
    assert.equal(sum, r.providers.codex.totals.responses, "per-kind subtotals sum to the total (R5.8)");
  });

  it("several own session_meta records are ordered by (ordinal value, then projection); the first describes the stream", () => {
    // two own session_meta of one id with different roles: the lower ordinal wins whichever comes first in the file
    const a = xmeta("t-two", { thread_source: "automation" }, { ordinal: 5 });
    const b = xmeta("t-two", { thread_source: "subagent" }, { ordinal: 2 });
    const lines = (m: Obj[]) => [...m, xturn("tn", "gpt-6-sol", 6, 6), xtur("r-two", "t-two", "tn", 7, 7)];
    // the two metas also differ in nothing the R4.11 comparison reads, so the stream is not in conflict
    for (const order of [[a, b], [b, a]]) {
      const r = run([xfile("two", lines(order))]);
      assert.equal(rowOf(r, "codex:r-two").kind, "subagent");
    }
    // equal ordinals: the projection decides, so the order of the lines never does
    const c = xmeta("t-eq", { thread_source: "automation" }, { ordinal: 0 });
    const d = xmeta("t-eq", { thread_source: "guardian_review" }, { ordinal: 0 });
    const kinds = [[c, d], [d, c]].map((m) => rowOf(run([xfile("eq", [...m, xtur("r-eq", "t-eq", "tn", 3, 3)])]), "codex:r-eq").kind);
    assert.equal(kinds[0], kinds[1]);
  });
});

describe("S10.1: Claude kind", () => {
  it("main for the main chain; workflow_agent iff a file of the chain lies under subagents/workflows/wf_*/, else subagent", () => {
    const sess = "ks";
    const lines = (agent: string | undefined, req: string, ts: string) => [copy({ sess, agent, req, mid: "m-" + req, ts })];
    const files: F[] = [
      { path: `projects/p/${sess}.jsonl`, content: jsonl(lines(undefined, "r-main", T(1))) },
      { path: `projects/p/${sess}/subagents/agent-a1.jsonl`, content: jsonl(lines("a1", "r-sub", T(2))) },
      { path: `projects/p/${sess}/subagents/workflows/wf_run1/agent-w1.jsonl`, content: jsonl(lines("w1", "r-wf", T(3))) },
      // a chain with records in a workflow file and in a plain subagent file is a workflow agent
      { path: `projects/p/${sess}/subagents/agent-w2.jsonl`, content: jsonl(lines("w2", "r-both-a", T(4))) },
      { path: `projects/p/${sess}/subagents/workflows/wf_run1/agent-w2.jsonl`, content: jsonl(lines("w2", "r-both-b", T(5))) },
      // records without an agentId in a subagent-path file belong to the main chain
      { path: `projects/p/${sess}/subagents/agent-a2.jsonl`, content: jsonl(lines(undefined, "r-nomain", T(6))) },
      // a main-path file holding records with an agentId: that chain is not main
      { path: `projects/p/${sess}x.jsonl`, content: jsonl([copy({ sess: sess + "x", agent: "a9", req: "r-agentinmain", mid: "m-9", ts: T(7) })]) },
    ];
    const r = run(files);
    const kind = (id: string) => rowOf(r, `claude:${id}`).kind;
    assert.equal(kind("r-main"), "main");
    assert.equal(kind("r-sub"), "subagent");
    assert.equal(kind("r-wf"), "workflow_agent");
    assert.equal(kind("r-both-a"), "workflow_agent");
    assert.equal(kind("r-both-b"), "workflow_agent");
    assert.equal(kind("r-nomain"), "main");
    assert.equal(kind("r-agentinmain"), "subagent");
  });
});

// ---------------------------------------------------------------------------
// Checklist revision: S2.3 (TM(T)), S10.4, S10.5, S12
// ---------------------------------------------------------------------------

/** A file recently modified with an unparseable line: its families are live (R0.9). */
const LIVE_MTIME = RUN - 1000;
const withGarbage = (f: F): F => ({ ...f, content: f.content + "{ not json\n", mtimeMs: LIVE_MTIME });

describe("S2.3: a null Codex context model is a member of TM(T)", () => {
  it("model A plus a null model (absent, empty, unlisted) is turn_model_conflicted; null alone is a one-member set", () => {
    const build = (second: unknown, first: unknown = "gpt-6-sol") => {
      const a = xturn("tn", first, 1, 1);
      const b = xturn("tn", second, 2, 2);
      if (second === undefined) delete b.payload.model;
      if (first === undefined) delete a.payload.model;
      return run([xfile("tm", [xmeta("synthetic-tt"), a, b, xtur("x", "synthetic-tt", "tn", 3, 3)])], { codexTierForTest: "standard" });
    };
    for (const second of [undefined, "", null, "NOT A MODEL", "x".repeat(81)]) {
      const r = build(second);
      assert.equal(cov(r, "codex").chains_tainted_by_reason.turn_model_conflicted, 1, JSON.stringify(second));
      assert.equal(r.providers.codex.totals.responses, 1, "tokens are kept");
    }
    // null and null only: one member, no conflict (but nothing is verified)
    const nulls = build("", "");
    assert.equal(cov(nulls, "codex").chains_tainted_by_reason.turn_model_conflicted, 0);
    assert.equal(rowOf(nulls, "codex:x").model_source, "own_turn_unsettled");
  });
});

describe("S10.4: a fork is decided by an own session_meta anywhere in the scan", () => {
  it("the own session_meta of an id in a stream-conflict file still makes the thread a fork and its ordinal is read from it", () => {
    // the stream of fork-x has a clean assigned file (usage record only); its own session_meta lies in a conflict file
    const clean = xfile("clean", [xtur("rx", "fork-x", "tn", 1, 1)]);
    const conflict = (hist: unknown) => xfile("conf", [xmeta("fork-x", { forked_from_id: "parent-p", subagent_history_start_ordinal: hist }), xtur("ry", "other-y", "tn", 2, 2)]);
    const bad = run([clean, conflict(-1)]);
    assert.equal(cov(bad, "codex").files_stream_conflict, 1);
    assert.ok(cov(bad, "codex").chains_tainted_by_reason.fork_prefix_unresolved >= 1, "invalid ordinal on the own record in the conflict file");
    assert.equal(cov(run([clean, conflict(0)]), "codex").chains_tainted_by_reason.fork_prefix_unresolved, 0);
    // a thread with no assigned file has no stream to verify: only the ordinal of its own records decides
    const only = (hist: unknown) => xfile("conf2", [xmeta("fork-x", { forked_from_id: "parent-p", subagent_history_start_ordinal: hist }), xtur("rx", "fork-x", "tn", 1, 1), xtur("ry", "other-y", "tn", 2, 2)]);
    assert.ok(cov(run([only(-1)]), "codex").chains_tainted_by_reason.fork_prefix_unresolved >= 1);
    assert.equal(cov(run([only(0)]), "codex").chains_tainted_by_reason.fork_prefix_unresolved, 0);
    // an unsupported version gets version_unverified only
    const old = xfile("conf", [xmeta("fork-x", { cli_version: "0.150.0", forked_from_id: "parent-p", subagent_history_start_ordinal: -1 }), xtur("ry", "other-y", "tn", 2, 2)]);
    assert.equal(cov(run([clean, old]), "codex").chains_tainted_by_reason.fork_prefix_unresolved, 0);
    // control: a verified stream with a valid ordinal resolves the prefix
    const parent = xfile("par", [xmeta("parent-p"), xturn("tp", "gpt-6-sol", 1, 1), xtur("rp", "parent-p", "tp", 2, 2)]);
    const child = xfile("chi", [xmeta("fork-c", { forked_from_id: "parent-p", subagent_history_start_ordinal: 0 }), xturn("tc", "gpt-6-sol", 1, 1), xtur("rc", "fork-c", "tc", 2, 2)]);
    assert.equal(cov(run([parent, child]), "codex").chains_tainted_by_reason.fork_prefix_unresolved, 0);
    // the ordinal must be valid on every own record of the id, wherever the record lies
    const second = xfile("chi2", [xmeta("fork-c", { forked_from_id: "parent-p", subagent_history_start_ordinal: -1 }, { ordinal: 9 })]);
    assert.ok(cov(run([parent, child, second]), "codex").chains_tainted_by_reason.fork_prefix_unresolved >= 1);
  });
});

describe("S10.5: replay ownership applies to excluded keys too", () => {
  it("a tied key excluded as conflict_input still counts replay_ownership_ambiguous and taints with ownership_ambiguous", () => {
    const a = copy({ sess: "sa", req: "tie", mid: "m-tie", ts: T(5), usage: usage({ input_tokens: 10 }) });
    const b = copy({ sess: "sb", req: "tie", mid: "m-tie", ts: T(5), usage: usage({ input_tokens: 11 }) });
    const r = run([mainFile("sa", [a]), mainFile("sb", [b])]);
    const c = cov(r, "claude");
    assert.deepEqual(c.requests_conflict_by_kind, { conflict_input: 1 });
    assert.equal(c.replay_ownership_ambiguous, 1);
    assert.equal(c.chains_tainted_by_reason.ownership_ambiguous, 2);
    // excluded for another reason (incomplete) as well
    const inc = copy({ sess: "sb", req: "tie2", mid: "m-tie2", ts: T(6), usage: usage({ output_tokens: undefined }) });
    const inc2 = copy({ sess: "sa", req: "tie2", mid: "m-tie2", ts: T(6), usage: usage({ output_tokens: undefined }) });
    const r2 = run([mainFile("sa", [inc2]), mainFile("sb", [inc])]);
    assert.equal(cov(r2, "claude").replay_ownership_ambiguous, 1);
    // no tie: nothing counted for an excluded key
    const c2 = copy({ sess: "sa", req: "late", mid: "m-late", ts: T(1), usage: usage({ input_tokens: 10 }) });
    const d2 = copy({ sess: "sb", req: "late", mid: "m-late", ts: T(9), usage: usage({ input_tokens: 11 }) });
    const r3 = run([mainFile("sa", [c2]), mainFile("sb", [d2])]);
    assert.equal(cov(r3, "claude").replay_ownership_ambiguous, 0);
  });
});

describe("S12.1: windowed logical counters", () => {
  it("api_error_records, replay_ownership_ambiguous and replay_requests_excluded count by event time in the window; an unknown time is in every window", () => {
    const err = (uuid: string, ts: unknown) => copy({ uuid, req: null, mid: "me-" + uuid, ts, usage: usage(), extra: { isApiErrorMessage: true } });
    const files = [mainFile("s1", [err("e1", T(1)), err("e2", T(30)), err("e3", "bad")])];
    assert.equal(cov(run(files), "claude").api_error_records, 3);
    const w = { since: Date.UTC(2026, 0, 1, 0, 0, 10) };
    assert.equal(cov(run(files, w), "claude").api_error_records, 2, "T(30) and the unknown time");
    // ownership ties and replays follow the key's event time
    const tie = (sec: number, req: string) => [mainFile("sa" + req, [copy({ sess: "sa" + req, req, mid: "m" + req, ts: T(sec) })]), mainFile("sb" + req, [copy({ sess: "sb" + req, req, mid: "m" + req, ts: T(sec) })])];
    const fs2 = [...tie(1, "early"), ...tie(40, "late")];
    const all = cov(run(fs2), "claude");
    assert.equal(all.replay_ownership_ambiguous, 2);
    assert.equal(all.replay_requests_excluded, 2);
    const win = cov(run(fs2, w), "claude");
    assert.equal(win.replay_ownership_ambiguous, 1);
    assert.equal(win.replay_requests_excluded, 1);
  });

  it("live families are outside every ledger counter; an entry without a chain is never live", () => {
    const err = (uuid: string, sess: string) => copy({ uuid, sess, req: null, mid: "me-" + uuid, ts: T(1), usage: usage(), extra: { isApiErrorMessage: true } });
    const live = withGarbage(mainFile("sl", [err("e1", "sl"), copy({ sess: "sl", req: "rl", mid: "ml", ts: T(2) })]));
    const clean = mainFile("sc", [err("e2", "sc")]);
    const r = run([live, clean]);
    const c = cov(r, "claude");
    assert.equal(c.families_live_skipped, 1);
    assert.equal(c.api_error_records, 1, "only the clean session");
    // a record without any chain key is not in a live family
    const noChain = copy({ uuid: "e3", req: null, mid: "me-3", ts: T(1), usage: usage(), extra: { isApiErrorMessage: true } });
    delete noChain.sessionId;
    assert.equal(cov(run([live, mainFile("sn", [noChain])]), "claude").api_error_records, 1);
  });
});

describe("S12.2, S12.4, S12.5: counters over the accounted responses", () => {
  it("requests_total equals the totals response count: window and live families included", () => {
    const own = (sess: string, req: string, sec: number) => copy({ sess, req, mid: "m-" + req, ts: T(sec) });
    const bad = copy({ sess: "s1", req: "bad", mid: "m-bad", ts: T(25), usage: usage({ output_tokens: undefined }) });
    const files = [mainFile("s1", [own("s1", "a", 5), own("s1", "b", 20), bad]), withGarbage(mainFile("sl", [own("sl", "c", 21)]))];
    for (const w of [{}, { since: Date.UTC(2026, 0, 1, 0, 0, 10) }, { until: Date.UTC(2026, 0, 1, 0, 0, 10) }]) {
      const r = run(files, w);
      assert.equal(cov(r, "claude").requests_total, r.providers.claude.totals.responses, JSON.stringify(w));
    }
    assert.equal(cov(run(files), "claude").requests_total, 2, "a and b; bad is excluded, c is live");
    // Codex: same
    const x = [xmeta("synthetic-tr"), xturn("tn", "gpt-6-sol", 1, 1), xtur("r1", "synthetic-tr", "tn", 2, 2), xtur("r2", "synthetic-tr", "tn", 3, 30)];
    const rc = run([xfile("rt", x)], { since: Date.UTC(2026, 0, 2, 0, 0, 10) });
    assert.equal(cov(rc, "codex").requests_total, 1);
    assert.equal(rc.providers.codex.totals.responses, 1);
  });

  it("output_unknown_requests: accounted in-window responses with unknown output for any reason", () => {
    const noFinal = copy({ sess: "s1", req: "nofinal", mid: "m1", ts: T(20), usage: usage({}, false) });
    const confOut = [copy({ sess: "s2", req: "cout", mid: "m2", ts: T(21), usage: usage({ output_tokens: 5 }) }), copy({ sess: "s2", req: "cout", mid: "m2", ts: T(22), usage: usage({ output_tokens: 6 }) })];
    const confIt = copy({ sess: "s3", req: "cit", mid: "m3", ts: T(23), usage: usage({ iterations: [{ input_tokens: 99 }] }) });
    const ok = copy({ sess: "s4", req: "ok", mid: "m4", ts: T(24) });
    const early = copy({ sess: "s5", req: "early", mid: "m5", ts: T(1), usage: usage({}, false) });
    const files = [mainFile("s1", [noFinal]), mainFile("s2", confOut), mainFile("s3", [confIt]), mainFile("s4", [ok]), mainFile("s5", [early]), withGarbage(mainFile("s6", [copy({ sess: "s6", req: "live", mid: "m6", ts: T(25), usage: usage({}, false) })]))];
    assert.equal(cov(run(files), "claude").output_unknown_requests, 4, "nofinal, cout, cit, early; the live one is out");
    assert.equal(cov(run(files, { since: Date.UTC(2026, 0, 1, 0, 0, 10) }), "claude").output_unknown_requests, 3);
  });

  it("baseline_requests_loaded excludes live families", () => {
    const own = (sess: string, req: string, sec: number) => copy({ sess, req, mid: "m-" + req, ts: T(sec) });
    const files = [mainFile("s1", [own("s1", "a", 1)]), withGarbage(mainFile("sl", [own("sl", "b", 2)])), mainFile("s2", [own("s2", "c", 40)])];
    const r = run(files, { since: Date.UTC(2026, 0, 1, 0, 0, 10), until: Date.UTC(2026, 0, 1, 0, 0, 30) });
    assert.equal(cov(r, "claude").baseline_requests_loaded, 1);
    // Codex
    const mk = (id: string, live: boolean) => {
      const f = xfile(id, [xmeta(id), xturn("tn-" + id, "gpt-6-sol", 1, 1), xtur("r-" + id, id, "tn-" + id, 2, 2)]);
      return live ? withGarbage(f) : f;
    };
    const rc = run([mk("t-a", false), mk("t-live", true)], { since: Date.UTC(2026, 0, 2, 0, 0, 10) });
    assert.equal(cov(rc, "codex").baseline_requests_loaded, 1);
  });
});

describe("S12.6: sidecar files are files and lines", () => {
  const side = (path: string, content: string, extra: Obj = {}): F => ({ path, content, ...extra });
  const base = [mainFile("ss", [copy({ sess: "ss", req: "r1", mid: "m1" })])];

  it("every sidecar counts in files_total; a JSON sidecar is one line, and one parse error when it fails to parse", () => {
    const files = [
      ...base,
      side("projects/p/ss/subagents/agent-a.meta.json", '{"toolUseId":"x"}'),
      side("projects/p/ss/subagents/agent-a.prefix.json", '{"state":{}}'),
      side("projects/p/ss/workflows/wf_r.json", '{"runId":"r"}'),
    ];
    const c = cov(run(files), "claude");
    assert.equal(c.files_total, 4);
    assert.equal(c.lines_total, 1 + 3);
    assert.equal(c.lines_parse_error, 0);
    // a broken JSON sidecar: one line, one parse error, provider-wide unparsed_line taint
    const broken = run([...files, side("projects/p/ss/subagents/agent-b.meta.json", '{"toolUseId":')]);
    const cb = cov(broken, "claude");
    assert.equal(cb.files_total, 5);
    assert.equal(cb.lines_total, 5);
    assert.equal(cb.lines_parse_error, 1);
    assert.ok(cb.chains_tainted_by_reason.unparsed_line >= 1);
    // a recent broken sidecar is still not live (it names no chain)
    const recent = run([...files, side("projects/p/ss/subagents/agent-b.meta.json", '{"toolUseId":', { mtimeMs: LIVE_MTIME })]);
    assert.equal(cov(recent, "claude").families_live_skipped, 0);
    assert.ok(cov(recent, "claude").chains_tainted_by_reason.unparsed_line >= 1);
  });

  it("journal.jsonl lines follow R1.3: each line counts, a bad line is a parse error, a bad last line without newline is a truncated tail", () => {
    const j = "p/ss/subagents/workflows/wf_r/journal.jsonl";
    const ok = run([...base, side(`projects/${j}`, '{"type":"started","agentId":"a"}\n{"type":"done","agentId":"a"}\n')]);
    assert.equal(cov(ok, "claude").lines_total, 3);
    assert.equal(cov(ok, "claude").files_total, 2);
    const bad = run([...base, side(`projects/${j}`, '{"type":"started"}\n{ nope\n{"type":"done"}')]);
    const c = cov(bad, "claude");
    assert.equal(c.lines_total, 1 + 3);
    assert.equal(c.lines_parse_error, 1);
    assert.equal(c.lines_truncated_tail, 0, "the last line parses");
    const tail = run([...base, side(`projects/${j}`, '{"type":"started"}\n{"type":"do')]);
    assert.equal(cov(tail, "claude").lines_truncated_tail, 1);
    assert.equal(cov(tail, "claude").lines_parse_error, 0);
  });

  it("an unreadable sidecar counts in files_total and files_unreadable and adds no line", () => {
    const r = run([...base, { path: "projects/p/ss/subagents/agent-a.meta.json", content: "{}", unreadable: true } as F]);
    const c = cov(r, "claude");
    assert.equal(c.files_total, 2);
    assert.equal(c.files_unreadable, 1);
    assert.equal(c.lines_total, 1);
    assert.ok(c.chains_tainted_by_reason.file_unreadable >= 1);
  });
});

describe("S12.7: model rows of the totals are keyed by (model key, model_verified)", () => {
  it("a Claude response with no model at all is keyed `unlisted`; an unverified Codex response has the key model_unknown; both are unverified rows", () => {
    const r = run([mainFile("s1", [copy({ req: "nomodel", mid: "m1", model: null })])]);
    assert.deepEqual(Object.keys(r.providers.claude.by_model), ["unlisted:unverified"]);
    assert.deepEqual(r.providers.claude.by_model_rows.map((x) => [x.model, x.model_verified]), [["unlisted", false]]);
    const x = run([xfile("tm2", [xmeta("synthetic-tn"), xturn("tn", "gpt-6-sol", 1, 1), xturn("tn", "gpt-6-luna", 2, 2), xtur("x", "synthetic-tn", "tn", 3, 3)])]);
    assert.deepEqual(x.providers.codex.by_model_rows.map((y) => [y.model, y.model_verified]), [["model_unknown", false]]);
  });

  it("a model's clean responses and its tainted ones are two rows", () => {
    // session s1 is clean; session s2 holds an input conflict on another key, so its chain is tainted
    const ok = (sess: string, req: string) => copy({ sess, req, mid: "m-" + req, ts: T(5) });
    const bad = [copy({ sess: "s2", req: "bad", mid: "m-bad", ts: T(6) }), copy({ sess: "s2", req: "bad", mid: "m-bad", ts: T(7), usage: usage({ input_tokens: 11 }) })];
    const r = run([mainFile("s1", [ok("s1", "a")]), mainFile("s2", [ok("s2", "b"), ...bad])]);
    const rowsOf = r.providers.claude.by_model_rows.map((y) => [y.model, y.model_verified, y.responses]);
    assert.deepEqual(rowsOf, [["claude-sonnet-5-5", true, 1], ["claude-sonnet-5-5", false, 1]]);
    assert.deepEqual(Object.keys(r.providers.claude.by_model).sort(), ["claude-sonnet-5-5", "claude-sonnet-5-5:unverified"]);
    assert.equal(rowOf(r, "claude:a").model_verified, true);
    assert.equal(rowOf(r, "claude:b").model_verified, false);
    // the rows still add up to the totals
    assert.equal(r.providers.claude.by_model_rows.reduce((n, y) => n + y.responses, 0), r.providers.claude.totals.responses);
    // a model that is not in the table is `unlisted`, verified or not
    const u = run([mainFile("s1", [copy({ req: "u", mid: "mu", model: "claude-unheard-1" })])]);
    assert.deepEqual(u.providers.claude.by_model_rows.map((y) => [y.model, y.model_verified]), [["unlisted", true]]);
  });
});

// ---------------------------------------------------------------------------
// Checklist revision 3: S8.5a (table at load), R1.3 blank lines, S10.3 set, S12.0, S12.6a, S5.1, S10.1
// ---------------------------------------------------------------------------

describe("S8.5a: the whole table is validated at load time", () => {
  const entryWith = (over: Obj): Obj => claudeEntry("claude-sonnet-5-5", SONNET, over);
  const unused = (e: Obj): Obj => makeTable({}, [claudeEntry("claude-sonnet-5-5", SONNET), { ...claudeEntry("x-unused-9", row("1", "2", "3", "4", "5")), ...e }]);
  const load = (table: Obj) => () => recomputeFiles([], { table, runStartMs: RUN });

  it("a number, an array or a string of another form in any price row of any entry makes the table malformed", () => {
    const bad: Array<[string, Obj]> = [
      ["number input", { prices_usd_per_mtok: { ...row("1", "2", "3", "4", "5"), input: 3 } }],
      ["array price", { prices_usd_per_mtok: { ...row("1", "2", "3", "4", "5"), output: ["1"] } }],
      ["leading zero", { prices_usd_per_mtok: { ...row("1", "2", "3", "4", "5"), cache_read: "05" } }],
      ["7 fraction digits", { prices_usd_per_mtok: { ...row("1", "2", "3", "4", "5"), cache_read: "0.1234567" } }],
      ["empty", { prices_usd_per_mtok: { ...row("1", "2", "3", "4", "5"), input: "" } }],
      ["negative", { prices_usd_per_mtok: { ...row("1", "2", "3", "4", "5"), input: "-1" } }],
      ["fast row", { fast: { prices_usd_per_mtok: { ...row("1", "2", "3", "4", "5"), output: 2 }, verified: false } }],
      ["tiers.high", { tiers: { split_tokens: 1, high: { ...row("1", "2", "3", "4", "5"), input: 1 }, verified: false } }],
      ["long_context", { long_context: { prices_usd_per_mtok: { input: "1", output: 2 }, verified: false } }],
      ["service_tier row", { service_tier: { batch: { prices_usd_per_mtok: { ...row("1", "2", "3", "4", "5"), input: 1 }, verified: false } } }],
    ];
    for (const [name, e] of bad) assert.throws(load(unused(e)), /table_malformed/, name);
    // the entry is not used by any response and not verified: it still fails the load
    assert.doesNotThrow(load(unused({})), "control");
    assert.doesNotThrow(load(unused({ verified: false, prices_usd_per_mtok: { input: "1", output: "2", cache_read: "0", cache_write_5m: "0.5", cache_write_1h: null } })), "null is n/a on an unverified entry");
    assert.throws(load(unused({ prices_usd_per_mtok: { input: "1", output: "2", cache_read: "0", cache_write_5m: "0.5", cache_write_1h: null } })), /table_malformed/, "a verified entry needs a complete standard row");
  });

  it("two entries with the same normalized model id make the table malformed", () => {
    const dup = makeTable({}, [claudeEntry("claude-sonnet-5-5", SONNET), claudeEntry("claude-sonnet-5-5-20260101", SONNET)]);
    assert.throws(load(dup), /table_malformed/);
    const same = makeTable({}, [{ ...claudeEntry("claude-sonnet-5-5", SONNET), model_ids: ["claude-sonnet-5-5", "claude-sonnet-5-5-20260101"] }]);
    assert.throws(load(same), /table_malformed/, "two spellings of one normalized id in one entry (S8.5b 7)");
  });

  it("an entry is used only for its own provider", () => {
    const table = makeTable({}, [
      { ...gptEntry("claude-sonnet-5-5", { input: "2", cached_input: "0.2", cache_write: "2.5", output: "10" }, null), multipliers: {} },
      claudeEntry("gpt-6-sol", SONNET, { multipliers: {} }),
    ]);
    const c = recomputeFiles([mainFile("s1", [copy({})])], { table, runStartMs: RUN });
    assert.equal(rowOf(c, "claude:synthetic-r1").unpriced_reason, "unknown_model");
    const x = recomputeFiles([xfile("pv", [xmeta("synthetic-tp"), xturn("tn", "gpt-6-sol", 1, 1), xtur("x", "synthetic-tp", "tn", 2, 2)])], { table, runStartMs: RUN, codexTierForTest: "standard" });
    assert.equal(rowOf(x, "codex:x").unpriced_reason, "unknown_model");
  });
});

describe("R1.3, S12.6: blank lines", () => {
  const ok = () => jsonl([copy({})]);
  const run1 = (content: string) => run([{ path: "projects/p/s.jsonl", content }]);

  it("a blank or whitespace-only terminated line is a parse error and taints the chains of the file", () => {
    const r = run1(ok() + "\n   \n\t\n");
    const c = cov(r, "claude");
    assert.equal(c.lines_parse_error, 3);
    assert.equal(c.lines_total, 4);
    assert.ok(c.chains_tainted_by_reason.unparsed_line >= 1);
    assert.equal(cov(run1(ok()), "claude").lines_parse_error, 0);
    // CRLF terminated blank line
    assert.equal(cov(run1(ok().replace(/\n/g, "\r\n") + "\r\n"), "claude").lines_parse_error, 1);
  });

  it("only an unterminated last line that is empty after removing a BOM and a CR is not a line", () => {
    assert.equal(cov(run1(ok() + "\r"), "claude").lines_total, 1, "a lone CR at the end");
    assert.equal(cov(run1("﻿" + ok()), "claude").lines_total, 1, "BOM");
    assert.equal(cov(run1("﻿"), "claude").lines_total, 0, "a file of a BOM");
    const sp = cov(run1(ok() + "  "), "claude");
    assert.equal(sp.lines_total, 2, "spaces are a line");
    assert.equal(sp.lines_truncated_tail, 1);
    assert.equal(cov(run1(""), "claude").lines_total, 0);
  });

  it("the same rule holds for Codex logs and journals", () => {
    const x = jsonl([xmeta("synthetic-tb"), xturn("tn", "gpt-6-sol", 1, 1), xtur("x", "synthetic-tb", "tn", 2, 2)]);
    const r = run([{ path: "sessions/2026/01/02/rollout-b.jsonl", content: x + "\n \n" }]);
    assert.equal(cov(r, "codex").lines_parse_error, 2);
    assert.ok(cov(r, "codex").chains_tainted_by_reason.unparsed_line >= 1);
    const j = run([mainFile("ss", [copy({ sess: "ss" })]), { path: "projects/p/ss/subagents/workflows/wf_r/journal.jsonl", content: '{"type":"started"}\n\n' }]);
    assert.equal(cov(j, "claude").lines_parse_error, 1);
  });
});

describe("S10.3: kind is decided over the set of own session_meta records", () => {
  it("subagent beats helper beats classifier beats main, whatever the order of records and files", () => {
    const m = (src: string, ord: number, extra: Obj = {}) => xmeta("t-set", { thread_source: src, ...extra }, { ordinal: ord });
    const sets: Array<[string, Obj[]]> = [
      ["subagent", [m("automation", 0), m("subagent", 1), m("guardian_review", 2)]],
      ["subagent", [m("automation", 0), m("user", 1, { source: { subagent: { thread_spawn: { parent_thread_id: "p", depth: 1 } } } })]],
      ["helper", [m("guardian_review", 0), m("automation", 1), m("user", 2)]],
      ["classifier", [m("user", 0), m("guardian_review", 1)]],
      ["main", [m("user", 0), m("surprise", 1)]],
    ];
    for (const [want, metas] of sets) {
      for (const order of [metas, [...metas].reverse()]) {
        const r = run([xfile("set", [...order, xturn("tn", "gpt-6-sol", 9, 9), xtur("r-set", "t-set", "tn", 10, 10)])]);
        assert.equal(rowOf(r, "codex:r-set").kind, want);
      }
      // the metas in two files
      const r2 = run([xfile("seta", [metas[0]!]), xfile("setb", [...metas.slice(1), xturn("tn", "gpt-6-sol", 9, 9), xtur("r-set", "t-set", "tn", 10, 10)])]);
      assert.equal(rowOf(r2, "codex:r-set").kind, want, "two files");
    }
  });
});

describe("S12.6a, S12.0: cost-state is a known record type; fields_range_failed", () => {
  const sys = (over: Obj = {}, ts = T(1)) => ({ type: "system", uuid: "sy" + JSON.stringify(over).length, sessionId: "synthetic-s1", timestamp: ts, version: CV, subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 100, postTokens: 10, ...over } });
  const cost = (mu: Obj, ts: unknown = T(1)): Obj => ({ type: "cost-state", timestamp: ts, modelUsage: mu });

  it("cost-state counts as a known type and names no chain (no unattributed_record)", () => {
    const r = run([mainFile("s1", [copy({}), cost({ "claude-sonnet-5-5": { inputTokens: 5 } })])]);
    const c = cov(r, "claude");
    assert.equal(c.known_type_count, 2);
    assert.equal(c.unlisted_type_count, 0);
    assert.equal(c.chains_tainted_by_reason.unattributed_record, 0);
  });

  it("R2.15 non-counter integers that fail the range count once per logical record and field", () => {
    const diag = (n: unknown) => ({ diagnostics: { cache_miss_reason: { type: "messages_changed", cache_missed_input_tokens: n } } });
    const a = copy({ req: "ra", mid: "ma", ts: T(1), msg: diag(MAX_SAFE + 2) });
    const files = [
      mainFile("s1", [
        a,
        a, // the same record again: one logical record
        sys({ preTokens: -1, postTokens: 1.5 }),
        sys({ preTokens: "x", postTokens: 5 }, T(2)), // bad is not range
        cost({ "claude-sonnet-5-5": { inputTokens: 1e300, outputTokens: 5, cacheReadInputTokens: -3, cacheCreationInputTokens: 1.5 }, "claude-opus-5-5": { inputTokens: MAX_SAFE + 1 } }),
        cost({ "claude-sonnet-5-5": { inputTokens: 1e300, outputTokens: 5, cacheReadInputTokens: -3, cacheCreationInputTokens: 1.5 }, "claude-opus-5-5": { inputTokens: MAX_SAFE + 1 } }),
      ]),
    ];
    const c = cov(run(files), "claude");
    assert.equal(c.fields_range_failed, 1 + 2 + 4, "a fractional member is range too");
    // windowed by the record's timestamp; a cost-state without a time is in every window
    const w = cov(run([mainFile("s1", [sys({ preTokens: -1 }, T(5)), sys({ preTokens: -1, postTokens: -1 }, T(40)), cost({ m: { inputTokens: -1 } }, null)])], { since: Date.UTC(2026, 0, 1, 0, 0, 10) }), "claude");
    assert.equal(w.fields_range_failed, 2 + 1);
    // a failing value does not fail a response
    const ok = run([mainFile("s1", [a])]);
    assert.equal(ok.providers.claude.totals.responses, 1);
    assert.equal(cov(run([xfile("cx", [xmeta("synthetic-tq")])]), "codex").fields_range_failed, 0);
  });
});

describe("S12.0, R17.6: record, duplicate and priced counters", () => {
  it("records_usage_bearing and records_usage_unmappable count logical records, chainless ones included, by event time", () => {
    const okRec = copy({ req: "ra", mid: "ma", ts: T(1) });
    const noOut = copy({ req: "rb", mid: "mb", ts: T(2), usage: usage({ output_tokens: undefined }) });
    const range = copy({ req: "rc", mid: "mc", ts: T(3), usage: usage({ input_tokens: -1 }) });
    const noUsage = copy({ req: "rd", mid: "md", ts: T(4), usage: null });
    const chainless = copy({ req: "re", mid: "me", ts: T(5) });
    delete chainless.sessionId;
    const files = [mainFile("s1", [okRec, okRec, noOut, range, noUsage, chainless])];
    const c = cov(run(files), "claude");
    assert.equal(c.records_usage_bearing, 4);
    assert.equal(c.records_usage_unmappable, 2);
    assert.equal(cov(run(files, { since: Date.UTC(2026, 0, 1, 0, 0, 3) }), "claude").records_usage_bearing, 2);
    // Codex: the six usage integers
    const head = [xmeta("synthetic-tu"), xturn("tn", "gpt-6-sol", 1, 1)];
    const good = xtur("g", "synthetic-tu", "tn", 2, 2);
    const miss = xtur("m", "synthetic-tu", "tn", 3, 3, xusage({ output_tokens: undefined }));
    const rng = xtur("r", "synthetic-tu", "tn", 4, 4, xusage({ input_tokens: 1.5 }));
    const none = xtur("n", "synthetic-tu", "tn", 5, 5, null);
    const orphan = xtur("o", "x", "tn", 6, 6);
    delete orphan.payload.thread_id;
    const cx = cov(run([xfile("u", [...head, good, good, miss, rng, none, orphan])]), "codex");
    assert.equal(cx.records_usage_bearing, 5, "every token_usage_record is usage-bearing; one without a usage object is incomplete (S4.3)");
    assert.equal(cx.records_usage_unmappable, 3);
  });

  it("S12.0: API error records (isApiErrorMessage true or model <synthetic>) are not usage-bearing records; a Codex record with a bad timestamp is not unmappable", () => {
    const err = (uuid: string, extra: Obj) => copy({ uuid, req: null, mid: "me-" + uuid, ts: T(1), usage: usage({ input_tokens: -1 }), extra });
    const synth = err("e2", {});
    synth.message.model = "<synthetic>";
    const files = [mainFile("s1", [err("e1", { isApiErrorMessage: true }), synth, copy({ req: "ok", mid: "m-ok" })])];
    const c = cov(run(files), "claude");
    assert.equal(c.api_error_records, 2);
    assert.equal(c.records_usage_bearing, 1, "only the real request");
    assert.equal(c.records_usage_unmappable, 0);
    const x = [xmeta("synthetic-tz"), xturn("tn", "gpt-6-sol", 1, 1), xtur("r1", "synthetic-tz", "tn", 2, 2, xusage(), { timestamp: "bad" })];
    const cx = cov(run([xfile("z", x)]), "codex");
    assert.equal(cx.records_usage_bearing, 1);
    assert.equal(cx.records_usage_unmappable, 0, "R2.12 revision 11.1 makes the response incomplete, not the record unmappable");
  });

  it("lines_duplicate_collapsed and duplicate_records_collapsed follow the record projection (physical counters)", () => {
    const a = copy({ req: "ra", mid: "ma" });
    const sameButRole = JSON.parse(JSON.stringify(a));
    sameButRole.message.role = "user"; // message.role is not part of an assistant projection (S5.1)
    const user = (role: string) => ({ type: "user", uuid: "uu", sessionId: "synthetic-s1", timestamp: T(1), version: CV, message: { role, content: "x" } });
    const other = (extra: Obj) => ({ type: "mystery", ...extra }); // an unlisted type projects to its type alone
    const files = [mainFile("s1", [a, a, sameButRole, user("user"), user("user"), user("assistant"), other({ x: 1 }), other({ y: 2 }), [1], [2]])];
    const c = cov(run(files), "claude");
    assert.equal(c.lines_duplicate_collapsed, 2 + 1 + 1 + 1);
    assert.equal(c.duplicate_records_collapsed, 1 + 1 + 1 + 1);
    // Codex
    const x = [xmeta("synthetic-tv"), xmeta("synthetic-tv"), xturn("tn", "gpt-6-sol", 1, 1), { timestamp: CTS(2), type: "response_item", ordinal: 2, payload: { a: 1 } }, { timestamp: CTS(2), type: "response_item", ordinal: 2, payload: { b: 2 } }];
    const cx = cov(run([xfile("v", x)]), "codex");
    assert.equal(cx.lines_duplicate_collapsed, 2);
    assert.equal(cx.duplicate_records_collapsed, 2);
  });

  it("requests_with_final_marker, requests_priced and requests_unknown_model are taken over the accounted responses", () => {
    const fin = copy({ sess: "s1", req: "fin", mid: "m1", ts: T(20) });
    const noFin = copy({ sess: "s2", req: "nofin", mid: "m2", ts: T(21), usage: usage({}, false) });
    const unk = copy({ sess: "s3", req: "unk", mid: "m3", ts: T(22), model: "claude-unheard-1" });
    const early = copy({ sess: "s4", req: "early", mid: "m4", ts: T(1) });
    const files = [mainFile("s1", [fin]), mainFile("s2", [noFin]), mainFile("s3", [unk]), mainFile("s4", [early])];
    const c = cov(run(files), "claude");
    assert.equal(c.requests_with_final_marker, 3);
    assert.equal(c.requests_priced, 2);
    assert.equal(c.requests_unknown_model, 1);
    assert.equal(cov(run(files, { since: Date.UTC(2026, 0, 1, 0, 0, 10) }), "claude").requests_priced, 1);
    const cx = cov(run([xfile("w", [xmeta("synthetic-tw"), xturn("tn", "gpt-6-sol", 1, 1), xtur("x", "synthetic-tw", "tn", 2, 2)])], { codexTierForTest: "standard" }), "codex");
    assert.equal(cx.requests_priced, 1);
    assert.equal(cx.requests_unknown_model, 0);
  });
});

describe("S5.1: own-type fields only", () => {
  it("message.role is not part of an assistant projection; a non-boolean boolean field is `bad`", () => {
    const mk = (role: unknown, flag: unknown) => {
      const r = copy({ req: null, mid: "mk", uuid: "uk", usage: usage() });
      r.message.role = role;
      if (flag !== undefined) r.isSidechain = flag;
      return r;
    };
    assert.equal(cov(run([mainFile("s1", [mk("assistant", undefined), mk("user", undefined), mk(5, undefined)])]), "claude").records_unkeyed, 1);
    // bad versus missing versus a boolean
    assert.equal(cov(run([mainFile("s1", [mk("a", undefined), mk("a", "yes"), mk("a", 1), mk("a", false), mk("a", null)])]), "claude").records_unkeyed, 3);
    // a non-array iterations is bad; so is iterations[0] that is not an object
    const it = (v: unknown) => {
      const r = copy({ req: null, mid: "mk", uuid: "uk", usage: usage({ iterations: v }) });
      return r;
    };
    assert.equal(cov(run([mainFile("s1", [it("x"), it(5), it([5]), it(["y"]), it([{}]), it([]), it(undefined)])]), "claude").records_unkeyed, 3, "bad, an empty member list, missing");
  });
});

describe("S10.1: the string `main`, a missing and a bad agentId are all the main chain", () => {
  it("one chain and kind main, whatever file holds the records", () => {
    const rec = (agent: unknown, req: string, sec: number) => copy({ sess: "ks", req, mid: "m-" + req, ts: T(sec), agent: agent as string });
    const files: F[] = [
      { path: "projects/p/ks.jsonl", content: jsonl([rec(undefined, "r1", 1), rec("main", "r2", 2), rec(5, "r3", 3), rec(null, "r4", 4), rec("", "r5", 5)]) },
      { path: "projects/p/ks/subagents/agent-a.jsonl", content: jsonl([rec("main", "r6", 6)]) },
      { path: "projects/p/ks/subagents/workflows/wf_r/agent-w.jsonl", content: jsonl([rec("main", "r7", 7)]) },
    ];
    const r = run(files);
    assert.equal(cov(r, "claude").chains_total, 1);
    for (const id of ["r1", "r2", "r3", "r4", "r5", "r6", "r7"]) assert.equal(rowOf(r, `claude:${id}`).kind, "main", id);
    // a real agent id is another chain
    const r2 = run([...files, { path: "projects/p/ks/subagents/agent-b.jsonl", content: jsonl([rec("b", "r8", 8)]) }]);
    assert.equal(cov(r2, "claude").chains_total, 2);
    assert.equal(rowOf(r2, "claude:r8").kind, "subagent");
  });
});

describe("S12.6a: discovery layout and sidecar size", () => {
  const base = [mainFile("ss", [copy({ sess: "ss", req: "r1", mid: "m1" })])];
  const side = (path: string, content: string): F => ({ path, content });

  it("only the exact layout is discovered; a stray file anywhere else is not", () => {
    const stray = [
      side("projects/p/ss/other/agent-a.meta.json", "{}"),
      side("projects/p/ss/subagents/extra/agent-a.meta.json", "{}"),
      side("projects/p/ss/subagents/agent-a.txt", "{}"),
      side("projects/p/ss/workflows/sub/wf_r.json", "{}"),
      side("projects/p/ss/workflows/run.json", "{}"),
      side("projects/p/ss/subagents/workflows/wf_r/other.json", "{}"),
      side("projects/p/ss/subagents/workflows/wf_r/extra/journal.jsonl", "{}\n"),
      side("projects/p/ss/journal.jsonl", "{}\n"),
      side("projects/p/ss/subagents/workflows/agent-x.jsonl", jsonl([copy({ sess: "ss", req: "stray", mid: "ms" })])),
      side("projects/p/ss/extra/agent-x.jsonl", jsonl([copy({ sess: "ss", req: "stray2", mid: "ms2" })])),
      side("projects/top.jsonl", jsonl([copy({ sess: "top", req: "stray3", mid: "ms3" })])),
    ];
    const r = run([...base, ...stray]);
    assert.equal(cov(r, "claude").files_total, 1);
    assert.equal(r.providers.claude.totals.responses, 1);
    // the listed layout is discovered
    const good = [
      side("projects/p/ss/subagents/agent-a.meta.json", "{}"),
      side("projects/p/ss/subagents/agent-a.prefix.json", "{}"),
      side("projects/p/ss/subagents/workflows/wf_r/agent-w.meta.json", "{}"),
      side("projects/p/ss/subagents/workflows/wf_r/agent-w.prefix.json", "{}"),
      side("projects/p/ss/workflows/wf_r.json", "{}"),
      side("projects/p/ss/subagents/workflows/wf_r/journal.jsonl", "{}\n"),
    ];
    assert.equal(cov(run([...base, ...good]), "claude").files_total, 7);
  });

  it("a JSON sidecar over 8 MiB is unreadable and taints the provider; a smaller one is read", () => {
    const pad = (n: number) => '{"k":"' + "x".repeat(n) + '"}';
    const MiB8 = 8 * 1024 * 1024;
    const big = run([...base, side("projects/p/ss/subagents/agent-a.meta.json", pad(MiB8))]);
    const c = cov(big, "claude");
    assert.equal(c.files_unreadable, 1);
    assert.equal(c.lines_total, 1, "an unreadable file adds no line");
    assert.ok(c.chains_tainted_by_reason.file_unreadable >= 1);
    const fit = run([...base, side("projects/p/ss/subagents/agent-a.meta.json", pad(MiB8 - 20))]);
    assert.equal(cov(fit, "claude").files_unreadable, 0);
    assert.equal(cov(fit, "claude").lines_total, 2);
  });
});

// ---------------------------------------------------------------------------
// S6.0 chainless copies, R2.15 Codex thread total, S5.1 unlisted projection
// ---------------------------------------------------------------------------

describe("S6.0: a supported Claude copy without a sessionId is still a copy of its key", () => {
  /** A valid response in session s1 plus a second copy with the same requestId and no sessionId. */
  const withChainless = (over: CopyOpts, mutate: (r: Obj) => void = () => {}, good: CopyOpts = {}) => {
    const a = copy({ sess: "s1", req: "k", mid: "mk", ts: T(5), ...good });
    const b = copy({ sess: "s1", req: "k", mid: "mk", ts: T(6), ...over });
    delete b.sessionId;
    mutate(b);
    return run([mainFile("s1", [a]), { path: "projects/p/orphan.jsonl", content: jsonl([b]) }]);
  };
  const status = (r: RecomputeResult) => rowOf(r, "claude:k").status;
  const conflicts = (r: RecomputeResult) => (rowOf(r, "claude:k").flags as string[]).filter((f) => f.startsWith("conflict"));

  it("a missing timestamp, a range or incomplete counter make the response excluded", () => {
    assert.equal(status(withChainless({}, (b) => delete b.timestamp)), "excluded:usage_incomplete");
    assert.equal(status(withChainless({ ts: "2026-02-30T00:00:00Z" })), "excluded:usage_incomplete");
    assert.equal(status(withChainless({ usage: usage({ output_tokens: undefined }) })), "excluded:usage_incomplete");
    assert.equal(status(withChainless({ usage: usage({ input_tokens: -1 }) })), "excluded:usage_range_failed");
    // a copy without usage and without a timestamp (the audit example)
    assert.equal(status(withChainless({ usage: null }, (b) => delete b.timestamp)), "excluded:usage_incomplete");
    const r = withChainless({}, (b) => delete b.timestamp);
    assert.equal(r.providers.claude.totals.responses, 0);
    assert.equal(cov(r, "claude").responses_usage_incomplete, 1);
    assert.equal(cov(r, "claude").chains_tainted_by_reason.request_anomaly, 1, "the chain that holds the other copy");
  });

  it("key_conflict, conflict_input and conflict_model exclude the response", () => {
    assert.equal(status(withChainless({ mid: "other-message" })), "excluded:key_conflict");
    assert.equal(status(withChainless({ usage: usage({ input_tokens: 11 }) })), "excluded:conflict_input");
    assert.equal(status(withChainless({ model: "claude-opus-5-5" })), "excluded:conflict_model");
    const r = withChainless({ usage: usage({ input_tokens: 11 }) });
    assert.deepEqual(cov(r, "claude").requests_conflict_by_kind, { conflict_input: 1 });
  });

  it("conflict_output, conflict_iterations, conflict_modifier and conflict_diagnostics read a chainless copy", () => {
    assert.deepEqual(conflicts(withChainless({ usage: usage({ output_tokens: 6 }) })), ["conflict_output"]);
    assert.deepEqual(conflicts(withChainless({ usage: usage({ iterations: [{ input_tokens: 99 }] }) })), ["conflict_iterations"]);
    assert.deepEqual(conflicts(withChainless({ usage: usage({ inference_geo: "us" }) })), ["conflict_modifier"]);
    // a chainless non-final copy that carries a modifier the final copy does not
    assert.deepEqual(conflicts(withChainless({ usage: usage({ service_tier: "priority" }, false) })), ["conflict_modifier"]);
    const dg = (type: string) => ({ diagnostics: { cache_miss_reason: { type } } });
    const d = withChainless({ msg: dg("tools_changed") }, () => {}, { msg: dg("messages_changed") });
    assert.deepEqual(cov(d, "claude").requests_conflict_by_kind, { conflict_diagnostics: 1 });
  });

  it("t_first reads the chainless copy; an unverified chainless copy makes the key unverified; the copy is never an owner and names no chain", () => {
    // the chainless copy is the earliest: t_first is T(1)
    const w = withChainless({ ts: T(1) }, () => {}, { ts: T(30) });
    assert.equal(rowOf(w, "claude:k").event, "2026-01-01T00:00:01.000Z");
    const inWin = recomputeFiles([mainFile("s1", [copy({ sess: "s1", req: "k", mid: "mk", ts: T(30) })])], { table: TABLE, runStartMs: RUN, since: Date.UTC(2026, 0, 1, 0, 0, 10) });
    assert.equal(inWin.providers.claude.totals.responses, 1);
    // with the earlier chainless copy, the key lies before the window
    const a = copy({ sess: "s1", req: "k", mid: "mk", ts: T(30) });
    const b = copy({ sess: "s1", req: "k", mid: "mk", ts: T(1) });
    delete b.sessionId;
    const before = recomputeFiles([mainFile("s1", [a]), { path: "projects/p/orphan.jsonl", content: jsonl([b]) }], { table: TABLE, runStartMs: RUN, since: Date.UTC(2026, 0, 1, 0, 0, 10) });
    assert.equal(before.providers.claude.totals.responses, 0);
    assert.equal(cov(before, "claude").baseline_requests_loaded, 1);
    // unverified version on the chainless copy
    const u = withChainless({ version: "1.0.0" });
    assert.equal(cov(u, "claude").requests_unverified_version, 1);
    assert.equal(u.providers.claude.totals.responses, 0);
    // a key whose copies are all chainless is owned by nobody: not accounted, and no chain is named
    const only = copy({ req: "k2", mid: "m2" });
    delete only.sessionId;
    const r = run([{ path: "projects/p/orphan.jsonl", content: jsonl([only]) }]);
    assert.equal(r.providers.claude.totals.responses, 0);
    assert.equal(cov(r, "claude").chains_total, 0);
  });
});

describe("R2.15, S12.0: Codex thread_token_usage.total_tokens out of range", () => {
  it("adds 1 to fields_range_failed once per logical record, windowed and outside live families; the response is kept", () => {
    const head = [xmeta("synthetic-tt2"), xturn("tn", "gpt-6-sol", 1, 1)];
    const rec = (resp: string, ord: number, sec: number, total: unknown) => xtur(resp, "synthetic-tt2", "tn", ord, sec, xusage(), {}, { thread_token_usage: { total_tokens: total } });
    const files = [xfile("tt", [...head, rec("a", 2, 2, -1), rec("a", 2, 2, -1), rec("b", 3, 30, 1.5), rec("c", 4, 31, 5), rec("d", 5, 32, MAX_SAFE + 2)])];
    const r = run(files);
    assert.equal(cov(r, "codex").fields_range_failed, 3);
    assert.equal(r.providers.codex.totals.responses, 4, "R2.15 for this field removes nothing");
    assert.equal(cov(run(files, { since: Date.UTC(2026, 0, 2, 0, 0, 10) }), "codex").fields_range_failed, 2);
    const live = withGarbage(xfile("tt", [...head, rec("a", 2, 2, -1)]));
    assert.equal(cov(run([live]), "codex").fields_range_failed, 0);
    // a string total is bad, not range
    assert.equal(cov(run([xfile("tt", [...head, rec("a", 2, 2, "x")])]), "codex").fields_range_failed, 0);
  });
});

describe("S5.1: a record of an unlisted type projects to `other` and exactly seven common fields", () => {
  it("only uuid, parentUuid, logicalParentUuid, sessionId, agentId, timestamp and version separate two unlisted records", () => {
    const base = { type: "mystery", uuid: "u1", parentUuid: "p1", logicalParentUuid: "l1", sessionId: "synthetic-s1", agentId: "a1", timestamp: T(1), version: CV };
    const dupCount = (...recs: Obj[]) => cov(run([mainFile("s1", recs)]), "claude").lines_duplicate_collapsed;
    // fields outside the seven do not matter
    assert.equal(dupCount(base, { ...base, isSidechain: true, entrypoint: "cli", effort: "high", advisorModel: "x", requestId: "r", message: { role: "user" }, extra: 1 }), 1);
    assert.equal(dupCount(base, { ...base, type: "other-mystery" }), 1, "the type is `other` whatever the unlisted string");
    // each of the seven separates
    for (const [k, v] of [["uuid", "u2"], ["parentUuid", "p2"], ["logicalParentUuid", "l2"], ["sessionId", "synthetic-s2"], ["agentId", "a2"], ["timestamp", T(2)], ["version", "2.1.288"]] as const) {
      assert.equal(dupCount(base, { ...base, [k]: v }), 0, k);
    }
    // a listed type keeps its own fields (attachment: the common fields of the graph types)
    const att = { ...base, type: "attachment" };
    assert.equal(dupCount(att, { ...att, isSidechain: true }), 0);
  });
});

// ---------------------------------------------------------------------------
// S12.0 cost-state members, S1.3b, S1.3c, S7.0
// ---------------------------------------------------------------------------

describe("S12.0: fields_range_failed reads only the listed paths", () => {
  const cost = (mu: Obj, ts: unknown = T(1)): Obj => ({ type: "cost-state", timestamp: ts, modelUsage: mu });
  const sys = (over: Obj, subtype: string | null = "compact_boundary"): Obj => ({ type: "system", uuid: "sy", sessionId: "synthetic-s1", timestamp: T(1), version: CV, ...(subtype === null ? {} : { subtype }), compactMetadata: { trigger: "auto", ...over } });
  const frf = (...lines: Obj[]) => cov(run([mainFile("s1", lines)]), "claude").fields_range_failed;

  it("only the five token members of each raw model key of the top-level modelUsage count; costUSD and other members do not", () => {
    // a real cost-state record carries a fractional costUSD: it is not a token and is not checked
    assert.equal(frf(cost({ "claude-sonnet-5-5": { inputTokens: 5, outputTokens: 6, costUSD: 0.0123, webSearchRequests: 1.5, contextWindow: -1 } })), 0);
    const all = { inputTokens: -1, outputTokens: 1.5, cacheReadInputTokens: MAX_SAFE + 2, cacheCreationInputTokens: -2, thinkingTokens: 1e300 };
    assert.equal(frf(cost({ k: all })), 5);
    // a string is bad, not range
    assert.equal(frf(cost({ k: { inputTokens: "5", outputTokens: null } })), 0);
    // model keys are raw: two spellings of one model are two fields
    assert.equal(frf(cost({ "claude-x-20260101": { inputTokens: -1 }, "claude-x": { inputTokens: -1 }, "Claude-X": { inputTokens: -1 } })), 3);
    // no other path is read: a nested modelUsage or a top-level member is ignored
    assert.equal(frf({ type: "cost-state", timestamp: T(1), inputTokens: -1, nested: { modelUsage: { k: { inputTokens: -1 } } } }), 0);
    // once per logical record and field
    const r = cost({ k: { inputTokens: -1, outputTokens: -1 } });
    assert.equal(frf(r, r), 2);
  });

  it("preTokens and postTokens are range checked on a compact_boundary system record only", () => {
    assert.equal(frf(sys({ preTokens: -1, postTokens: -1 })), 2);
    assert.equal(frf(sys({ preTokens: -1, postTokens: -1 }, "other_subtype")), 0);
    assert.equal(frf(sys({ preTokens: -1, postTokens: -1 }, null)), 0);
  });
});

describe("S1.3c: projections of journal, cost-state, graph attributes and non-object lines", () => {
  const dups = (...recs: unknown[]) => {
    const content = recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
    return cov(run([{ path: "projects/p/s.jsonl", content }]), "claude");
  };

  it("non-object lines are all equal records of type missing", () => {
    const c = dups(5, [1], null, "x", 5);
    assert.equal(c.lines_duplicate_collapsed, 4);
    assert.equal(c.duplicate_records_collapsed, 1);
    assert.equal(dups(5, [1], null).lines_duplicate_collapsed, 2);
  });

  it("a journal record projects to its type and agentId only; equal lines collapse", () => {
    const base = [mainFile("ss", [copy({ sess: "ss" })])];
    const j = (lines: Obj[]): F => ({ path: "projects/p/ss/subagents/workflows/wf_r/journal.jsonl", content: jsonl(lines) });
    const c = cov(run([...base, j([{ type: "started", agentId: "a", label: "x" }, { type: "started", agentId: "a", label: "y", result: "z" }, { type: "started", agentId: "b" }, { type: "surprise", agentId: "a" }, { type: "other-surprise", agentId: "a" }, { type: "started" }, { type: "started", agentId: null }])]), "claude");
    // collapsed: the second line (same as the first), the fifth (an unlisted type is `other`, like the fourth), the last
    // (a null agentId is missing, like an absent one)
    assert.equal(c.lines_duplicate_collapsed, 3);
    assert.equal(c.duplicate_records_collapsed, 3);
  });

  it("a cost-state record projects to the common fields plus its modelUsage token members; other members do not matter", () => {
    const base = { type: "cost-state", uuid: "c1", sessionId: "synthetic-s1", timestamp: T(1), version: CV, modelUsage: { k: { inputTokens: 5, costUSD: 0.5 } } };
    const n = (...recs: Obj[]) => dups(...recs).lines_duplicate_collapsed;
    assert.equal(n(base, { ...base, modelUsage: { k: { inputTokens: 5, costUSD: 9.9, webSearchRequests: 3 } } }), 1);
    assert.equal(n(base, { ...base, modelUsage: { k: { inputTokens: 6 } } }), 0);
    assert.equal(n(base, { ...base, modelUsage: { K: { inputTokens: 5 } } }), 0, "raw model keys");
    assert.equal(n(base, { ...base, uuid: "c2" }), 0);
    assert.equal(n(base, { ...base, isSidechain: true, entrypoint: "cli" }), 1, "attribute fields are not common fields of a cost-state");
  });

  it("advisorModel, serverClassifierRequest and content block type, id and name are projected on all four graph types", () => {
    const g = (type: string, over: Obj = {}) => ({ type, uuid: "g1", sessionId: "synthetic-s1", timestamp: T(1), version: CV, ...over });
    const n = (...recs: Obj[]) => dups(...recs).lines_duplicate_collapsed;
    for (const t of ["assistant", "user", "system", "attachment"]) {
      const a = g(t);
      assert.equal(n(a, { ...a }), 1, t + " control");
      assert.equal(n(a, { ...a, advisorModel: "claude-opus-5-5" }), 0, t + " advisorModel");
      assert.equal(n(a, { ...a, serverClassifierRequest: {} }), 0, t + " serverClassifierRequest");
      const blk = (b: Obj) => ({ ...a, message: { content: [b] } });
      assert.equal(n(blk({ type: "text" }), blk({ type: "thinking" })), 0, t + " block type");
      assert.equal(n(blk({ type: "tool_use", id: "i1", name: "Agent" }), blk({ type: "tool_use", id: "i2", name: "Agent" })), 0, t + " block id");
      assert.equal(n(blk({ type: "tool_use", id: "i1", name: "Agent" }), blk({ type: "tool_use", id: "i1", name: "Workflow" })), 0, t + " block name");
      assert.equal(n(blk({ type: "tool_use", id: "i1", name: "Zzz" }), blk({ type: "tool_use", id: "i1", name: "Yyy" })), 1, t + " unlisted names are `other`");
      assert.equal(n(blk({ type: "text", id: "i1" }), blk({ type: "text", id: "i2" })), 0, t + " id on any block type");
    }
  });
});

describe("S7.0: since after until is a usage error", () => {
  it("since > until throws; since == until is an empty window", () => {
    const files = [mainFile("s1", [copy({ ts: T(5) })])];
    const t = (sec: number) => Date.UTC(2026, 0, 1, 0, 0, sec);
    assert.throws(() => run(files, { since: t(10), until: t(5) }), /bad_window/);
    assert.throws(() => run(files, { since: "2026-01-02", until: "2026-01-01" }), /bad_window/);
    const empty = run(files, { since: t(5), until: t(5) });
    assert.equal(empty.providers.claude.totals.responses, 0);
    assert.equal(run(files, { since: t(5), until: t(6) }).providers.claude.totals.responses, 1);
    assert.equal(run(files, { since: t(10) }).providers.claude.totals.responses, 0, "an open end is no error");
  });
});

describe("S1.3b: id states in the R4.11 comparison; id-less session_meta; version states", () => {
  const meta2 = (over: Obj, ord = 0) => xmeta("synthetic-ti", over, { ordinal: ord });
  const stream = (...metas: Obj[]) => run([xfile("ids", [...metas, xturn("tn", "gpt-6-sol", 5, 5), xtur("x", "synthetic-ti", "tn", 6, 6)])]);

  it("a bad value and a missing value of session_id, forked_from_id or the ordinal differ in the comparison of two own session_meta records", () => {
    const miss = (f: string) => {
      const m = meta2({});
      delete m.payload[f];
      return m;
    };
    for (const f of ["session_id", "forked_from_id", "subagent_history_start_ordinal"]) {
      const bad = meta2({ [f]: 5 });
      assert.equal(cov(stream(miss(f), bad), "codex").chains_tainted_by_reason.stream_unresolved, 1, f + " missing vs bad");
      assert.equal(cov(stream(meta2({ [f]: 5 }), meta2({ [f]: { x: 1 } })), "codex").chains_tainted_by_reason.stream_unresolved, f === "subagent_history_start_ordinal" ? 1 : 0, f + " bad vs bad");
      assert.equal(cov(stream(miss(f), meta2({ [f]: null })), "codex").chains_tainted_by_reason.stream_unresolved, 0, f + " missing vs null");
    }
  });

  it("a session_meta without a usable id is still a session_meta of its file: it adds no id, is unattributed, and its forked_from_id makes the forked record non-own", () => {
    const idless = (over: Obj = {}) => {
      const m = xmeta("x", over, { ordinal: 1 });
      delete m.payload.id;
      return m;
    };
    // the id-less record forks synthetic-tp: the copied parent record of the same file is non-own
    const parent = xmeta("synthetic-tp");
    const child = xmeta("synthetic-tc", { forked_from_id: "synthetic-tp" }, { ordinal: 2 });
    const r = run([xfile("a", [parent, idless({ forked_from_id: "synthetic-tp" }), xturn("tn", "gpt-6-sol", 3, 3), xtur("x1", "synthetic-tp", "tn", 4, 4)])]);
    const c = cov(r, "codex");
    assert.equal(c.files_stream_conflict, 0, "the parent is non-own, so the file has one identity");
    assert.equal(c.files_assigned_by_stream, 1);
    assert.ok(c.chains_tainted_by_reason.unattributed_record >= 1);
    // a bad id (a number) behaves the same
    const bad = idless({ forked_from_id: "synthetic-tp" });
    bad.payload.id = 7;
    assert.equal(cov(run([xfile("a", [parent, bad, xturn("tn", "gpt-6-sol", 3, 3), xtur("x1", "synthetic-tp", "tn", 4, 4)])]), "codex").files_assigned_by_stream, 1);
    // control: without the forking record the same two metas are two own ids
    const two = run([xfile("a", [parent, child, xtur("x1", "synthetic-tc", "tn", 4, 4)])]);
    assert.equal(cov(two, "codex").files_assigned_by_stream, 1, "the parent copy is non-own because the child forks it");
    // an id-less record that forks nothing is own and adds no id: the file keeps its one identity from the usage record
    const r2 = run([xfile("b", [idless(), xturn("tn", "gpt-6-sol", 3, 3), xtur("x2", "synthetic-tp", "tn", 4, 4)])]);
    assert.equal(cov(r2, "codex").files_assigned_by_stream, 1);
  });

  it("an absent version is `missing` and one outside the grammar is `unlisted`; the two differ (Claude and Codex)", () => {
    const rec = (version: unknown): Obj => {
      const r = copy({ req: null, mid: "mk", uuid: "uk", usage: usage() });
      if (version === undefined) delete r.version;
      else r.version = version;
      return r;
    };
    const dup = (...recs: Obj[]) => cov(run([mainFile("s1", recs)]), "claude");
    assert.equal(dup(rec(undefined), rec("not a version")).lines_duplicate_collapsed, 0);
    assert.equal(dup(rec(undefined), rec(null)).lines_duplicate_collapsed, 1);
    assert.equal(dup(rec("not a version"), rec(5)).lines_duplicate_collapsed, 1);
    const cm = (v: unknown): Obj => {
      const m = xmeta("synthetic-tv2");
      if (v === undefined) delete m.payload.cli_version;
      else m.payload.cli_version = v;
      return m;
    };
    const cdup = (...ms: Obj[]) => cov(run([xfile("v", ms)]), "codex").lines_duplicate_collapsed;
    assert.equal(cdup(cm(undefined), cm("garbage")), 0);
    assert.equal(cdup(cm(undefined), cm(null)), 1);
    assert.equal(cdup(cm("garbage"), cm(9)), 1);
  });
});

// ---------------------------------------------------------------------------
// Round 6: S10.5a stream_start, S12.6b duplicate scope, S8.5a unverified rows
// ---------------------------------------------------------------------------

describe("S10.5a: stream_start is the minimum valid instant over every parsed record that names the chain", () => {
  const shared = (sess: string, ts: string, mid = "mshared") => copy({ sess, req: "shared", mid, ts });
  const owned = (r: RecomputeResult) => rows(r).find((x) => x.id === "shared" && x.provider === "claude");

  it("an early record of an unlisted type makes its stream the owner of a replayed key", () => {
    // stream B's first graph record is at T(5); stream A's earliest record is an unlisted-type record at T(1), its graph
    // record of the key is later than B's. A owns the key.
    const early = { type: "mystery", uuid: "m1", sessionId: "sa", timestamp: T(1), version: CV };
    const r = run([mainFile("sa", [early as Obj, shared("sa", T(9))]), mainFile("sb", [shared("sb", T(5))])]);
    assert.equal(cov(r, "claude").replay_ownership_ambiguous, 0);
    assert.equal(owned(r)?.kind, "main");
    assert.equal(cov(r, "claude").replay_requests_excluded, 1);
    // control: without the early record B starts first and owns it (the response is counted once either way)
    const ctl = run([mainFile("sa", [shared("sa", T(9))]), mainFile("sb", [shared("sb", T(5))])]);
    assert.equal(cov(ctl, "claude").replay_requests_excluded, 1);
    // who owns it shows in the chain: ask for the model-free per-chain count through the taint of a conflict instead
    const own = (extra: Obj[]) => {
      const a = copy({ sess: "sa", req: "shared", mid: "mshared", ts: T(9), usage: usage({ input_tokens: 10 }) });
      const b = copy({ sess: "sb", req: "shared", mid: "mshared", ts: T(5), usage: usage({ input_tokens: 10 }) });
      return run([mainFile("sa", [...extra, a]), mainFile("sb", [b])]);
    };
    const withEarly = own([early as Obj]);
    const without = own([]);
    const chainOf = (res: RecomputeResult) => (res.responses.find((x) => x.counted && x.key === "shared")?.chain ?? "").split("\u0000")[1];
    assert.equal(chainOf(withEarly), "sa");
    assert.equal(chainOf(without), "sb");
  });

  it("a cost-state record, a record of an unsupported version and a record without a graph type all count; an invalid instant does not", () => {
    const a = copy({ sess: "sa", req: "shared", mid: "mshared", ts: T(9) });
    const b = copy({ sess: "sb", req: "shared", mid: "mshared", ts: T(5) });
    const chainOf = (extra: Obj[]) => {
      const res = run([mainFile("sa", [...extra, a]), mainFile("sb", [b])]);
      return (res.responses.find((x) => x.counted && x.key === "shared")?.chain ?? "").split("\u0000")[1];
    };
    assert.equal(chainOf([]), "sb");
    assert.equal(chainOf([{ type: "cost-state", sessionId: "sa", timestamp: T(1), modelUsage: {} }]), "sa");
    assert.equal(chainOf([{ type: "user", uuid: "u", sessionId: "sa", timestamp: T(1), version: "1.0.0" }]), "sa", "any version");
    assert.equal(chainOf([{ type: "user", uuid: "u", sessionId: "sa", timestamp: "2026-02-30T00:00:00Z", version: CV }]), "sb", "an invalid instant takes no part");
    // the record must name the chain: another session id or another agent id does not
    assert.equal(chainOf([{ type: "mystery", uuid: "u", sessionId: "other", timestamp: T(1) }]), "sb");
    assert.equal(chainOf([{ type: "mystery", uuid: "u", sessionId: "sa", agentId: "ag", timestamp: T(1) }]), "sb");
    assert.equal(chainOf([{ type: "mystery", uuid: "u", sessionId: "sa", agentId: "main", timestamp: T(1) }]), "sa", "agentId main is the main chain");
    // a tie at full precision is still a tie
    const tie = run([mainFile("sa", [{ type: "mystery", uuid: "u", sessionId: "sa", timestamp: T(5) } as Obj, a]), mainFile("sb", [b])]);
    assert.equal(cov(tie, "claude").replay_ownership_ambiguous, 1);
  });
});

describe("S12.6b: the duplicate counters compare across files", () => {
  it("the same started line in two journal files, and the same record in two logs, are duplicates", () => {
    const j = (run: string) => ({ path: `projects/p/ss/subagents/workflows/wf_${run}/journal.jsonl`, content: '{"type":"started","agentId":"a"}\n' }) as F;
    const base = [mainFile("ss", [copy({ sess: "ss" })])];
    const c = cov(run([...base, j("r1"), j("r2")]), "claude");
    assert.equal(c.lines_duplicate_collapsed, 1);
    assert.equal(c.duplicate_records_collapsed, 1);
    const three = cov(run([...base, j("r1"), j("r2"), j("r3")]), "claude");
    assert.equal(three.lines_duplicate_collapsed, 2);
    assert.equal(three.duplicate_records_collapsed, 1);
    // another agentId is another record
    const other = { path: "projects/p/ss/subagents/workflows/wf_r3/journal.jsonl", content: '{"type":"started","agentId":"b"}\n' } as F;
    assert.equal(cov(run([...base, j("r1"), j("r2"), other]), "claude").lines_duplicate_collapsed, 1);
    // logs across files; and Codex across files
    const rec = copy({ sess: "dup" });
    assert.equal(cov(run([mainFile("dup", [rec]), { path: "projects/q/dup.jsonl", content: jsonl([rec]) }]), "claude").lines_duplicate_collapsed, 1);
    const cx = [xmeta("synthetic-td"), xturn("tn", "gpt-6-sol", 1, 1)];
    assert.equal(cov(run([xfile("d1", cx), xfile("d2", cx)]), "codex").lines_duplicate_collapsed, 2);
    assert.equal(cov(run([xfile("d1", cx), xfile("d2", cx)]), "codex").duplicate_records_collapsed, 2);
  });
});

describe("S8.5a: unverified rows and long-context prices reject the table", () => {
  const load = (table: Obj) => () => recomputeFiles([], { table, runStartMs: RUN });
  const withRows = (e: Obj) => makeTable({}, [claudeEntry("claude-sonnet-5-5", SONNET), { ...claudeEntry("x-unused-8", row("1", "2", "3", "4", "5")), verified: false, ...e }]);

  it("0.1234567 on an unverified row rejects the table", () => {
    const bad = { ...row("1", "2", "3", "4", "5"), cache_read: "0.1234567" };
    assert.throws(load(withRows({ prices_usd_per_mtok: bad })), /table_malformed/);
    assert.throws(load(withRows({ fast: { prices_usd_per_mtok: bad, verified: false } })), /table_malformed/);
    assert.throws(load(withRows({ tiers: { split_tokens: 1, high: bad, verified: false } })), /table_malformed/);
    assert.doesNotThrow(load(withRows({ prices_usd_per_mtok: { ...bad, cache_read: "0.123456" } })), "six digits are fine");
  });

  it("malformed Anthropic long_context prices reject the table", () => {
    for (const lc of [
      { prices_usd_per_mtok: { input: 3, output: "4" }, verified: false },
      { prices_usd_per_mtok: { input: "3", output: "0.1234567" }, verified: false },
      { prices_usd_per_mtok: { input: "03" }, verified: true },
      { prices_usd_per_mtok: { input: ["3"] }, verified: false },
    ]) assert.throws(load(withRows({ long_context: lc })), /table_malformed/, JSON.stringify(lc));
    assert.doesNotThrow(load(withRows({ long_context: { surcharge: "none", verified: true } })), "a long_context without prices is fine");
  });
});

// ---------------------------------------------------------------------------
// S8.5b: load-time table validation
// ---------------------------------------------------------------------------

describe("S8.5b: a table is refused at load iff one of the listed conditions holds", () => {
  const load = (table: Obj) => () => recomputeFiles([], { table, runStartMs: RUN });
  const HAIKU = (extra: Obj = {}) => claudeEntry("claude-haiku-5-5", row("0.1", "0.5", "0.01", "0.125", "0.2"), { multipliers: { cache_read: "0.1", cache_write_5m: "1.25", cache_write_1h: "2" }, ...extra });
  const base = (over: Obj = {}): Obj => makeTable({}, [claudeEntry("claude-sonnet-5-5", SONNET), HAIKU(), ...(over.models ?? [])]);

  it("the shipped table loads, and so do the test tables", () => {
    assert.doesNotThrow(() => recomputeFiles([], { runStartMs: RUN }));
    assert.doesNotThrow(load(TABLE));
    assert.doesNotThrow(load(base()));
  });

  it("(1) the table shape: version grammar, schema version, models array", () => {
    for (const v of ["pt-sem", "2026-10-09", "pt-2026-10-9", "pt-2026-10-09.", "pt-2026-10-09.x", 5, null, undefined]) assert.throws(load({ ...TABLE, table_version: v }), /table_malformed/, String(v));
    for (const v of ["pt-2026-10-09", "pt-2026-10-09.12"]) assert.doesNotThrow(load({ ...TABLE, table_version: v }), v);
    for (const v of ["1", null, undefined]) assert.throws(load({ ...TABLE, schema_version: v }), /table_malformed/, String(v));
    assert.throws(load({ ...TABLE, models: {} }), /table_malformed/);
  });

  it("(2) an entry needs a string id, a known provider and a sane min_cacheable_tokens; a present price row must be an object", () => {
    const e = (over: Obj) => makeTable({}, [{ ...claudeEntry("claude-sonnet-5-5", SONNET), ...over }]);
    assert.throws(load(makeTable({}, [5 as unknown as Obj])), /table_malformed/);
    assert.throws(load(e({ id: 5 })), /table_malformed/);
    for (const p of ["x", null, 5, undefined, "OpenAI"]) assert.throws(load(e({ provider: p })), /table_malformed/, String(p));
    for (const m of [-1, 1.5, "512", true]) assert.throws(load(e({ min_cacheable_tokens: m })), /table_malformed/, String(m));
    for (const m of [0, 512, null, undefined]) assert.doesNotThrow(load(e({ min_cacheable_tokens: m })), String(m));
    assert.throws(load(e({ prices_usd_per_mtok: "x", verified: false })), /table_malformed/);
    assert.doesNotThrow(load(e({ prices_usd_per_mtok: { ...SONNET, input: null }, verified: false })), "a null price is not a refusal on an unverified entry");
  });

  it("(3) a verified entry needs a complete standard row; an unverified entry may have holes", () => {
    const e = (over: Obj) => makeTable({}, [{ ...claudeEntry("claude-sonnet-5-5", SONNET), ...over }]);
    for (const k of Object.keys(SONNET)) {
      assert.throws(load(e({ prices_usd_per_mtok: { ...SONNET, [k]: null } })), /table_malformed/, k + " null");
      const gone = { ...SONNET } as Obj;
      delete gone[k];
      assert.throws(load(e({ prices_usd_per_mtok: gone })), /table_malformed/, k + " missing");
      assert.doesNotThrow(load(e({ verified: false, prices_usd_per_mtok: gone })), k + " missing, unverified");
    }
    assert.throws(load(e({ prices_usd_per_mtok: null })), /table_malformed/, "no row at all");
    // OpenAI: the write price may be null or absent (n/a)
    const g = (row2: Obj, over: Obj = {}) => makeTable({}, [{ ...gptEntry("gpt-5.5", row2, null), ...over }]);
    assert.doesNotThrow(load(g({ input: "5", cached_input: "0.5", cache_write: null, output: "30" })));
    assert.doesNotThrow(load(g({ input: "5", cached_input: "0.5", output: "30" })), "an absent write price is n/a, like null");
    assert.throws(load(g({ input: "5", cached_input: null, cache_write: null, output: "30" })), /table_malformed/);
  });

  it("(3) any other price row of a verified entry that is present must be complete too", () => {
    const std = { cache_read: "0.1", cache_write_5m: "1.25", cache_write_1h: "2" };
    const full = row("0.2", "1", "0.02", "0.25", "0.4");
    const without = (r: Obj, k: string): Obj => {
      const c = { ...r };
      delete c[k];
      return c;
    };
    for (const k of Object.keys(full)) {
      const fast = (r: Obj, verified = true) => makeTable({}, [HAIKU({ verified, fast: { prices_usd_per_mtok: r, verified: true } })]);
      assert.doesNotThrow(load(fast(full)), "complete fast row");
      assert.throws(load(fast(without(full, k))), /table_malformed/, "fast " + k);
      if (k === "output") assert.doesNotThrow(load(fast(without(full, k), false)), "an unverified entry may have holes: fast " + k); // a missing input or cache price fails the ratio test whatever the verification
      const hi = row("0.5", "2.5", "0.05", "0.625", "1");
      assert.throws(load(makeTable({}, [HAIKU({ tiers: { split_tokens: 100000, high: without(hi, k), verified: true } })])), /table_malformed/, "tiers.high " + k);
      assert.throws(load(makeTable({}, [HAIKU({ service_tier: { batch: { prices_usd_per_mtok: without(full, k), verified: true } } })])), /table_malformed/, "service_tier " + k);
    }
    // an OpenAI long-context row: the write price may be null or absent
    const lc = (prices: Obj) => makeTable({}, [gptEntry("gpt-5.5", { input: "5", cached_input: "0.5", cache_write: null, output: "30" }, { threshold_input_tokens: 272000, prices_usd_per_mtok: prices, scope: "session", scope_verified: true, scope_source_id: "OM1", verified: true })]);
    assert.doesNotThrow(load(lc({ input: "10", cached_input: "1", cache_write: null, output: "45" })));
    assert.doesNotThrow(load(lc({ input: "10", cached_input: "1", output: "45" })), "lc cache_write absent is n/a");
    assert.throws(load(lc({ input: "10", cached_input: "1", cache_write: null })), /table_malformed/, "lc output missing");
    // a long-context object without prices has no row to complete
    assert.doesNotThrow(load(makeTable({}, [claudeEntry("claude-sonnet-5-5", SONNET, { long_context: { surcharge: "none", verified: true } })])));
    void std;
  });

  it("(4) an object under modifiers without a boolean verified refuses the table", () => {
    for (const v of [undefined, "true", 1, null]) {
      assert.throws(load({ ...TABLE, modifiers: { ...TABLE.modifiers, extra: { verified: v } } }), /table_malformed/, String(v));
    }
    assert.doesNotThrow(load({ ...TABLE, modifiers: { ...TABLE.modifiers, extra: { verified: false } } }));
    // a member that is not an object is refused (S8.5b 4)
    for (const v of [5, "x", null, [], true]) assert.throws(load({ ...TABLE, modifiers: { ...TABLE.modifiers, geo_us: v } }), /table_malformed/, JSON.stringify(v));
  });

  it("(5) R3.2: the ratio test runs on the standard, fast, high tier and verified long-context rows", () => {
    assert.throws(load(makeTable({}, [HAIKU({ prices_usd_per_mtok: row("0.1", "0.5", "0.011", "0.125", "0.2") })])), /table_malformed/, "standard cache read");
    assert.throws(load(makeTable({}, [HAIKU({ prices_usd_per_mtok: row("0.1", "0.5", "0.01", "0.126", "0.2") })])), /table_malformed/, "5m write");
    assert.throws(load(makeTable({}, [HAIKU({ prices_usd_per_mtok: row("0.1", "0.5", "0.01", "0.125", "0.21") })])), /table_malformed/, "1h write");
    // fast and tiers inherit the entry multipliers when they store none
    const fast = (p: Obj, extra: Obj = {}) => HAIKU({ fast: { prices_usd_per_mtok: p, verified: true, ...extra } });
    assert.doesNotThrow(load(makeTable({}, [fast(row("0.2", "1", "0.02", "0.25", "0.4"))])), "control");
    assert.throws(load(makeTable({}, [fast(row("0.2", "1", "0.03", "0.25", "0.4"))])), /table_malformed/, "fast row, inherited");
    const high = (p: Obj, extra: Obj = {}) => HAIKU({ tiers: { split_tokens: 100000, high: p, verified: true, ...extra } });
    assert.doesNotThrow(load(makeTable({}, [high(row("0.5", "2.5", "0.05", "0.625", "1"))])), "control");
    assert.throws(load(makeTable({}, [high(row("0.5", "2.5", "0.05", "0.625", "1.1"))])), /table_malformed/, "high tier row");
    // a row with a stored multiplier object of its own uses it; no object, no test
    assert.doesNotThrow(load(makeTable({}, [claudeEntry("x-model", row("2", "10", "5", "5", "5"))])), "an unlisted model without multipliers: no ratio test");
    const gpt = (lcPrices: Obj, verified = true) => makeTable({}, [gptEntry("gpt-6-sol", { input: "2", cached_input: "0.2", cache_write: "2.5", output: "10" }, { threshold_input_tokens: 272000, prices_usd_per_mtok: lcPrices, multipliers: { cached_input: "0.1", cache_write: "1.25" }, scope: "request", scope_verified: true, scope_source_id: "OM1", verified })].map((x) => ({ ...x, multipliers: { cached_input: "0.1", cache_write: "1.25" } })));
    assert.doesNotThrow(load(gpt({ input: "4", cached_input: "0.4", cache_write: "5", output: "15" })), "control");
    assert.throws(load(gpt({ input: "4", cached_input: "0.41", cache_write: "5", output: "15" })), /table_malformed/, "verified long-context row");
    assert.doesNotThrow(load(gpt({ input: "4", cached_input: "0.41", cache_write: "5", output: "15" }, false)), "an unverified long-context row is not tested");
  });

  it("(5) R3.2: the documented multipliers", () => {
    const m = (id: string, mult: Obj, p: Obj) => makeTable({}, [claudeEntry(id, p, { multipliers: mult })]);
    const std = { cache_read: "0.1", cache_write_5m: "1.25", cache_write_1h: "2" };
    assert.doesNotThrow(load(m("claude-sonnet-4-6", std, row("3", "15", "0.3", "3.75", "6"))));
    // a consistent but undocumented multiplier fails the documented list
    assert.throws(load(m("claude-sonnet-4-6", { ...std, cache_read: "0.2" }, row("3", "15", "0.6", "3.75", "6"))), /table_malformed/, "cache read 0.2");
    assert.throws(load(m("claude-sonnet-4-6", { ...std, cache_write_5m: "1.5" }, row("3", "15", "0.3", "4.5", "6"))), /table_malformed/, "5m write 1.5");
    assert.throws(load(m("claude-sonnet-4-6", { ...std, cache_write_1h: "3" }, row("3", "15", "0.3", "3.75", "9"))), /table_malformed/, "1h write 3");
    // 0.05 for Opus 5.5 and Sonnet 5.5, 0.025 for Fable 5.1 and Mythos 5.1
    assert.doesNotThrow(load(m("claude-opus-5-5", { ...std, cache_read: "0.05" }, row("4", "20", "0.2", "5", "8"))));
    assert.throws(load(m("claude-opus-5-5", std, row("4", "20", "0.4", "5", "8"))), /table_malformed/, "opus 5.5 stored at 0.1");
    assert.throws(load(m("claude-sonnet-5-5", std, row("2", "10", "0.2", "2.5", "4"))), /table_malformed/, "sonnet 5.5 stored at 0.1");
    assert.doesNotThrow(load(m("claude-fable-5-1", { ...std, cache_read: "0.025" }, row("10", "50", "0.25", "12.5", "20"))));
    assert.throws(load(m("claude-mythos-5-1", std, row("10", "50", "1", "12.5", "20"))), /table_malformed/, "mythos 5.1 stored at 0.1");
    // OpenAI: 1.25 write and 0.1 cached from GPT-5.6 on, 0.05 for gpt-6.1-sol; earlier models store none
    const o = (id: string, mult: Obj, p: Obj) => makeTable({}, [{ ...gptEntry(id, p, null), multipliers: mult }]);
    assert.doesNotThrow(load(o("gpt-5.6-sol", { cached_input: "0.1", cache_write: "1.25" }, { input: "2", cached_input: "0.2", cache_write: "2.5", output: "10" })));
    assert.throws(load(o("gpt-5.6-sol", { cached_input: "0.2", cache_write: "1.25" }, { input: "2", cached_input: "0.4", cache_write: "2.5", output: "10" })), /table_malformed/, "gpt-5.6 cached 0.2");
    assert.throws(load(o("gpt-6.1-sol", { cached_input: "0.1", cache_write: "1.25" }, { input: "2", cached_input: "0.2", cache_write: "2.5", output: "10" })), /table_malformed/, "gpt-6.1-sol needs 0.05");
    assert.doesNotThrow(load(o("gpt-6.1-sol", { cached_input: "0.05", cache_write: "1.25" }, { input: "2", cached_input: "0.1", cache_write: "2.5", output: "10" })));
    assert.doesNotThrow(load(o("gpt-5.5", { cached_input: "0.2", cache_write: "1.5" }, { input: "5", cached_input: "1", cache_write: "7.5", output: "30" })), "outside the list: not tested by the list (the ratio still holds)");
  });

  it("(5) a long_context object's own multipliers are read only by the ratio test of a row that has prices (T11)", () => {
    const withLc = (lc: Obj) => makeTable({}, [HAIKU({ long_context: lc })]);
    // an Anthropic long_context with an empty, partial or odd multipliers object and no prices: not a refusal
    for (const m of [{}, { cache_read: "0.9" }, null]) {
      assert.doesNotThrow(load(withLc({ surcharge: "none", verified: true, multipliers: m })), JSON.stringify(m));
    }
    // a multipliers value that is no object is a malformed table whatever it is for (S8.5b d)
    for (const m of [[], "x", 5]) assert.throws(load(withLc({ surcharge: "none", verified: true, multipliers: m })), /table_malformed/, JSON.stringify(m));
    // with prices the ratio test reads it
    const lcRow = row("1", "2", "0.5", "1.25", "2");
    assert.throws(load(withLc({ prices_usd_per_mtok: lcRow, verified: true, multipliers: { cache_read: "0.1" } })), /table_malformed/, "ratio 0.5 vs 0.1");
    assert.doesNotThrow(load(withLc({ prices_usd_per_mtok: lcRow, verified: true, multipliers: { cache_read: "0.5" } })), "a partial object that holds");
    assert.doesNotThrow(load(withLc({ prices_usd_per_mtok: lcRow, verified: false, multipliers: { cache_read: "0.1" } })), "an unverified row is not tested");
    // the inherited copies must list every documented multiplier (they equal the entry's, which does)
    const std = { cache_read: "0.1", cache_write_5m: "1.25", cache_write_1h: "2" };
    assert.throws(load(makeTable({}, [HAIKU({ fast: { prices_usd_per_mtok: row("0.2", "1", "0.02", "0.25", "0.4"), multipliers: { cache_read: "0.1" }, verified: true } })])), /table_malformed/, "partial fast.multipliers");
    void std;
  });

  it("(5) an inherited multiplier object that differs from the entry's refuses the table", () => {
    const std = { cache_read: "0.1", cache_write_5m: "1.25", cache_write_1h: "2" };
    const fastRow = row("0.2", "1", "0.02", "0.25", "0.4");
    assert.doesNotThrow(load(makeTable({}, [HAIKU({ fast: { prices_usd_per_mtok: fastRow, multipliers: { ...std }, verified: true } })])), "equal");
    assert.throws(load(makeTable({}, [HAIKU({ fast: { prices_usd_per_mtok: fastRow, multipliers: { ...std, cache_read: "0.2" }, verified: true } })])), /table_malformed/, "fast.multipliers");
    assert.throws(load(makeTable({}, [HAIKU({ tiers: { split_tokens: 100000, high: row("0.5", "2.5", "0.05", "0.625", "1"), high_multipliers: { ...std, cache_write_1h: "3" }, verified: true } })])), /table_malformed/, "tiers.high_multipliers");
    // stored inherited object but no multipliers on the entry
    assert.throws(load(makeTable({}, [claudeEntry("x-haiku", row("0.1", "0.5", "0.01", "0.125", "0.2"), { multipliers: null, fast: { prices_usd_per_mtok: fastRow, multipliers: std, verified: true } })])), /table_malformed/);
  });

  it("(6) a table copy of C25, C26 or C32 that differs refuses the table", () => {
    const lc = (t: unknown) => makeTable({}, [gptEntry("gpt-6-sol", { input: "2", cached_input: "0.2", cache_write: "2.5", output: "10" }, { threshold_input_tokens: t, scope: "request", scope_verified: true, scope_source_id: "OM1", verified: false })]);
    assert.doesNotThrow(load(lc(272000)));
    for (const t of [272001, 271999, "272000", 0]) assert.throws(load(lc(t)), /table_malformed/, "C25 " + String(t));
    assert.doesNotThrow(load(lc(null)), "a null copy is no copy");
    const tier = (n: unknown) => makeTable({}, [HAIKU({ tiers: { split_tokens: n, high: row("0.5", "2.5", "0.05", "0.625", "1"), verified: true } })]);
    assert.doesNotThrow(load(tier(100000)));
    for (const n of [100001, 99999, "100000"]) assert.throws(load(tier(n)), /table_malformed/, "C26 " + String(n));
    assert.doesNotThrow(load(tier(null)), "a null copy is no copy");
    const geo = (m: unknown) => makeTable({}, [claudeEntry("claude-sonnet-5-5", SONNET, { geo_us: { applies: true, multiplier: m, verified: true } })]);
    assert.doesNotThrow(load(geo("1.1")));
    assert.doesNotThrow(load(geo("1.10")));
    assert.doesNotThrow(load(geo(null)), "an entry without a geo multiplier");
    for (const m of ["1.2", "1.11", 1.1, "11/10", ""]) assert.throws(load(geo(m)), /table_malformed/, "C32 " + String(m));
    assert.throws(load(makeTable({ modifiers: { ...TABLE.modifiers, geo_us: { verified: true, multiplier: "1.2" } } })), /table_malformed/, "table-level C32");
    // table-level copies (S8.5b 6): modifiers.openai_long_context.threshold_input_tokens is C25, modifiers.geo_us.multiplier is C32
    const olc = (v: unknown) => makeTable({ modifiers: { ...TABLE.modifiers, openai_long_context: { verified: true, threshold_input_tokens: v } } });
    assert.doesNotThrow(load(olc(272000)));
    for (const v of [272001, "272000", 1]) assert.throws(load(olc(v)), /table_malformed/, "table-level C25 " + String(v));
    for (const v of [null, undefined]) assert.doesNotThrow(load(olc(v)), "absent or null is no copy");
    for (const v of [null, undefined]) assert.doesNotThrow(load(makeTable({ modifiers: { ...TABLE.modifiers, geo_us: { verified: true, multiplier: v } } })), "geo null/absent");
    assert.doesNotThrow(load(makeTable({ modifiers: { ...TABLE.modifiers, geo_us: { verified: true, multiplier: "1.1" } } })));
  });

  it("(5) a model the documented list names must store every listed multiplier", () => {
    const std = { cache_read: "0.1", cache_write_5m: "1.25", cache_write_1h: "2" };
    const m = (mult: Obj) => makeTable({}, [claudeEntry("claude-sonnet-4-6", row("3", "15", "0.3", "3.75", "6"), { multipliers: mult })]);
    assert.doesNotThrow(load(m(std)));
    assert.throws(load(m({})), /table_malformed/, "empty multipliers");
    for (const v of [[], "x", 5, true, null]) assert.throws(load(m(v as Obj)), /table_malformed/, "multipliers = " + JSON.stringify(v));
    for (const k of Object.keys(std)) {
      const part = { ...std } as Obj;
      delete part[k];
      assert.throws(load(m(part)), /table_malformed/, "partial without " + k);
      assert.throws(load(m({ ...std, [k]: null })), /table_malformed/, k + " null");
    }
    // no multiplier object at all is not tested; an unlisted OpenAI model may store nulls or nothing
    assert.doesNotThrow(load(makeTable({}, [claudeEntry("claude-sonnet-4-6", row("3", "15", "0.3", "3.75", "6"))])));
    const o = (id: string, mult: Obj) => makeTable({}, [{ ...gptEntry(id, { input: "2", cached_input: "0.2", cache_write: "2.5", output: "10" }, null), multipliers: mult }]);
    assert.doesNotThrow(load(o("gpt-5.5", {})));
    assert.doesNotThrow(load(o("gpt-5.5", { cached_input: null, cache_write: null })));
    assert.throws(load(o("gpt-5.6-sol", {})), /table_malformed/, "gpt-5.6 names the list");
    assert.throws(load(o("gpt-6-sol", { cached_input: "0.1" })), /table_malformed/, "gpt-6 partial");
  });

  it("(7) the entry id is a model id too", () => {
    const e = (id: string, ids: string[]) => ({ ...claudeEntry("claude-sonnet-5-5", SONNET), id, model_ids: ids });
    // an id that is also a member counts once
    assert.doesNotThrow(load(makeTable({}, [e("claude-sonnet-5-5", ["claude-sonnet-5-5"])])));
    // an id that equals a member of another entry
    assert.throws(load(makeTable({}, [e("claude-sonnet-5-5", ["claude-sonnet-5-5"]), e("other-id", ["claude-sonnet-5-5-20260101"])])), /table_malformed/, "member of another entry");
    assert.throws(load(makeTable({}, [e("claude-sonnet-5-5", ["claude-sonnet-5-5"]), e("claude-sonnet-5-5-20260101", [])])), /table_malformed/, "id of another entry, normalized");
    assert.throws(load(makeTable({}, [e("a-model", []), e("a-model", [])])), /table_malformed/, "the same id twice");
    assert.doesNotThrow(load(makeTable({}, [e("a-model", []), e("b-model", [])])), "ids without members");
  });

  it("(7) two model ids with one normalized form anywhere refuse the table", () => {
    assert.throws(load(makeTable({}, [claudeEntry("claude-sonnet-5-5", SONNET), claudeEntry("claude-sonnet-5-5-20260101", SONNET)])), /table_malformed/, "two entries");
    assert.throws(load(makeTable({}, [{ ...claudeEntry("claude-sonnet-5-5", SONNET), model_ids: ["claude-sonnet-5-5", "claude-sonnet-5-5-20260101"] }])), /table_malformed/, "one entry");
    assert.throws(load(makeTable({}, [{ ...claudeEntry("claude-sonnet-5-5", SONNET), model_ids: ["claude-sonnet-5-5", "claude-sonnet-5-5"] }])), /table_malformed/, "the same string twice");
    assert.doesNotThrow(load(makeTable({}, [{ ...claudeEntry("claude-sonnet-5-5", SONNET), model_ids: ["claude-sonnet-5-5-20260101-20260102", "claude-sonnet-5-5"] }])), "a double suffix strips once: a different id");
  });

  it("a missing or placeholder verified_at is never a refusal; it makes the object unverified", () => {
    const t = makeTable({}, [claudeEntry("claude-sonnet-5-5", SONNET, { verified_at: "n/a" })]);
    delete t.verified_at;
    assert.doesNotThrow(load(t));
    const r = recomputeFiles([mainFile("s1", [copy({})])], { table: t, runStartMs: RUN });
    assert.equal(rowOf(r, "claude:synthetic-r1").unpriced_reason, "unknown_model");
  });
});

describe("S12.6c: a path of the layout that cannot be read is a discovered, unreadable file", () => {
  it("a broken symbolic link at a log path counts in files_total and files_unreadable and taints the provider; one outside the layout does not", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "cw-s126c-"));
    try {
      mkdirSync(join(dir, "projects", "p", "x"), { recursive: true });
      mkdirSync(join(dir, "sessions", "2026", "01", "02"), { recursive: true });
      writeFileSync(join(dir, "projects", "p", "ok.jsonl"), jsonl([copy({ sess: "ok" })]));
      writeFileSync(join(dir, "sessions", "2026", "01", "02", "rollout-ok.jsonl"), jsonl([xmeta("synthetic-tl"), xturn("tn", "gpt-6-sol", 1, 1), xtur("x1", "synthetic-tl", "tn", 2, 2)]));
      try {
        symlinkSync(join(dir, "nowhere"), join(dir, "projects", "p", "broken.jsonl"));
      } catch {
        t.skip("symbolic links are not available here");
        return;
      }
      symlinkSync(join(dir, "nowhere"), join(dir, "sessions", "2026", "01", "02", "rollout-broken.jsonl"));
      const r = recompute({ claudeDirs: [dir], codexDirs: [dir], table: TABLE, runStartMs: RUN });
      const c = cov(r, "claude");
      assert.equal(c.files_total, 2);
      assert.equal(c.files_unreadable, 1);
      assert.equal(c.lines_total, 1, "an unreadable file adds no line");
      assert.ok(c.chains_tainted_by_reason.file_unreadable >= 1, "provider taint");
      const x = cov(r, "codex");
      assert.equal(x.files_total, 2);
      assert.equal(x.files_unreadable, 1);
      assert.ok(x.chains_tainted_by_reason.file_unreadable >= 1);
      // outside the layout: not discovered, not counted
      symlinkSync(join(dir, "nowhere"), join(dir, "projects", "p", "x", "stray.jsonl"));
      symlinkSync(join(dir, "nowhere"), join(dir, "projects", "p", "notes.txt"));
      const r2 = recompute({ claudeDirs: [dir], table: TABLE, runStartMs: RUN });
      assert.equal(cov(r2, "claude").files_total, 2);
      assert.equal(cov(r2, "claude").files_unreadable, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("S8.5b further details (a) to (e)", () => {
  const load = (table: Obj) => () => recomputeFiles([], { table, runStartMs: RUN });
  const HAIKU = (extra: Obj = {}) => claudeEntry("claude-haiku-5-5", row("0.1", "0.5", "0.01", "0.125", "0.2"), extra);

  it("(d) a present tiers, fast, long_context, service_tier or multipliers value that is not an object refuses the table", () => {
    for (const v of [5, [], "x", true]) {
      for (const key of ["tiers", "fast", "long_context", "service_tier", "multipliers"]) {
        assert.throws(load(makeTable({}, [HAIKU({ [key]: v })])), /table_malformed/, `${key} = ${JSON.stringify(v)}`);
      }
      assert.throws(load(makeTable({}, [HAIKU({ fast: { prices_usd_per_mtok: row("0.2", "1", "0.02", "0.25", "0.4"), multipliers: v, verified: true } })])), /table_malformed/, "fast.multipliers");
      assert.throws(load(makeTable({}, [HAIKU({ tiers: { split_tokens: 100000, high: row("0.5", "2.5", "0.05", "0.625", "1"), high_multipliers: v, verified: true } })])), /table_malformed/, "tiers.high_multipliers");
      assert.throws(load(makeTable({}, [HAIKU({ long_context: { prices_usd_per_mtok: row("1", "2", "0.1", "1.25", "2"), multipliers: v, verified: true } })])), /table_malformed/, "priced verified long_context.multipliers");
    }
    for (const key of ["tiers", "fast", "long_context", "service_tier"]) assert.doesNotThrow(load(makeTable({}, [HAIKU({ [key]: null })])), key + " null is absent");
  });

  it("(d) the tier gate: a present tiers value never prices a request above the split at the low row", () => {
    const files = [mainFile("s1", [copy({ model: "claude-haiku-5-5", usage: usage({ input_tokens: 150000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }) })])];
    // a non-object tiers refuses the table at load, so no response is priced from it
    for (const v of [5, [], "x"]) assert.throws(() => recomputeFiles(files, { table: makeTable({}, [HAIKU({ tiers: v })]), runStartMs: RUN }), /table_malformed/);
    const r = recomputeFiles(files, { table: makeTable({}, [HAIKU({ tiers: { split_tokens: 100000, high: row("0.5", "2.5", "0.05", "0.625", "1"), verified: true } })]), runStartMs: RUN });
    assert.equal(rowOf(r, "claude:synthetic-r1").usd_pico, String(150000n * 500000n + 5n * 2500000n), "the high tier row");
  });

  it("(b) a model the list names with no multipliers object at all fails; GPT-5.6 and later means (major, minor) >= (5, 6)", () => {
    const gpt = (id: string, mult: Obj | null | undefined) => {
      const e = gptEntry(id, { input: "2", cached_input: "0.2", cache_write: "2.5", output: "10" }, null);
      if (mult === undefined) delete e.multipliers;
      else e.multipliers = mult;
      return makeTable({}, [e]);
    };
    const claude = (mult: Obj | null | undefined) => {
      const e = claudeEntry("claude-sonnet-4-6", row("3", "15", "0.3", "3.75", "6"));
      if (mult === undefined) delete e.multipliers;
      else e.multipliers = mult;
      return makeTable({}, [e]);
    };
    assert.throws(load(claude(undefined)), /table_malformed/, "Claude, absent");
    assert.throws(load(claude(null)), /table_malformed/, "Claude, null");
    for (const id of ["gpt-5.6-sol", "gpt-5.7-sol", "gpt-5.10-sol", "gpt-6-sol", "gpt-6.1-sol", "gpt-7-sol", "gpt-10-luna", "gpt-6"]) {
      assert.throws(load(gpt(id, undefined)), /table_malformed/, id + " absent");
    }
    for (const id of ["gpt-5.5", "gpt-5.4", "gpt-5-mini", "gpt-5", "gpt-5.1-codex", "gpt-4o", "o3"]) {
      assert.doesNotThrow(load(gpt(id, undefined)), id + " is not named by the list");
      assert.doesNotThrow(load(gpt(id, { cached_input: null, cache_write: null })), id + " nulls");
    }
    // the documented values apply to the newer ids too
    assert.throws(load(gpt("gpt-7-sol", { cached_input: "0.2", cache_write: "1.25" })), /table_malformed/);
    // an entry is named by any of its ids
    const multi = gptEntry("gpt-5.5", { input: "2", cached_input: "0.2", cache_write: "2.5", output: "10" }, null);
    multi.model_ids = ["gpt-5.5", "gpt-6-sol"];
    delete multi.multipliers;
    assert.throws(load(makeTable({}, [multi])), /table_malformed/, "a model_ids member names the list");
  });

  it("(e) the entry id counts once only when it is raw-equal to a model_ids member", () => {
    const e = (id: string, ids: string[]) => ({ ...claudeEntry("claude-opus-5-5", row("4", "20", "0.2", "5", "8")), id, model_ids: ids });
    assert.doesNotThrow(load(makeTable({}, [e("claude-opus-5-5", ["claude-opus-5-5"])])));
    assert.throws(load(makeTable({}, [e("claude-opus-5-5", ["claude-opus-5-5-20251001"])])), /table_malformed/, "id and a dated member are two ids of one normalized form");
    assert.throws(load(makeTable({}, [e("claude-opus-5-5-20251001", ["claude-opus-5-5"])])), /table_malformed/);
    assert.doesNotThrow(load(makeTable({}, [e("claude-opus-5-5", [])])), "an id without members");
  });

  it("(a) verified means effective verification: a placeholder or missing date makes the entry unverified, so its holes are not refused", () => {
    const hole = (over: Obj, tableDate: string | null = "2026-10-09") => {
      const t = makeTable({}, [claudeEntry("x-model", { ...SONNET, output: null }, { multipliers: null, ...over })]);
      if (tableDate === null) delete t.verified_at;
      else t.verified_at = tableDate;
      return t;
    };
    assert.throws(load(hole({})), /table_malformed/, "verified with a date: the hole is refused");
    assert.doesNotThrow(load(hole({ verified_at: "TBD" })), "own date is a placeholder");
    assert.doesNotThrow(load(hole({ verified_at: undefined }, null)), "no date at all");
    assert.doesNotThrow(load(hole({ verified_at: undefined }, "TBD")), "the table date is a placeholder");
    assert.throws(load(hole({ verified_at: undefined }, "2026-10-09")), /table_malformed/, "the table date is effective");
    // a verified long-context row needs an effective date to be ratio tested
    const lcDate = (date: string) => makeTable({}, [gptEntry("gpt-6-sol", { input: "2", cached_input: "0.2", cache_write: "2.5", output: "10" }, { threshold_input_tokens: 272000, prices_usd_per_mtok: { input: "4", cached_input: "0.9", cache_write: "5", output: "15" }, verified: true, verified_at: date, scope: "request", scope_verified: true, scope_source_id: "OM1" })]);
    assert.throws(load(lcDate("2026-10-09")), /table_malformed/);
    assert.doesNotThrow(load(lcDate("TBD")), "a placeholder date: the row is unverified and not ratio tested");
  });

  it("(d) min_cacheable_tokens is a safe non-negative integer or null; model_ids is an array of strings; a service-tier row has only prices", () => {
    const e = (over: Obj) => makeTable({}, [claudeEntry("claude-sonnet-5-5", SONNET, over)]);
    for (const v of [2 ** 53, 1e300, -1, 1.5, "512"]) assert.throws(load(e({ min_cacheable_tokens: v })), /table_malformed/, String(v));
    for (const v of [0, 512, 2 ** 53 - 1, null]) assert.doesNotThrow(load(e({ min_cacheable_tokens: v })), String(v));
    for (const v of ["claude-sonnet-5-5", 5, {}, [5], ["a", null], [["a"]]]) assert.throws(load(e({ model_ids: v })), /table_malformed/, JSON.stringify(v));
    const st = (rowObj: Obj) => e({ verified: false, service_tier: { batch: { prices_usd_per_mtok: rowObj, verified: false } } }); // unverified: a partial row is no completeness failure
    assert.doesNotThrow(load(st({ input: "1", output: "2", extra_price: null })));
    assert.throws(load(st({ input: "1", output: "2", extra_price: 5 })), /table_malformed/, "any member of a service-tier row");
    assert.throws(load(st({ input: "1", surcharge: "1.2345678" })), /table_malformed/);
    // an ordinary price row only checks the named price members
    assert.doesNotThrow(load(e({ prices_usd_per_mtok: { ...SONNET, note: "free text" } })));
  });
});
