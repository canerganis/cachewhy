// Tests for src/sources/codex.ts. Spec: docs/methodology.md (spec-1, revision 7). All data is synthetic.
//
// Layout:
//   1. helpers (tree writer, raw line builders, semantic projection, metamorphic operators)
//   2. accounting (R2.6 to R2.9, R2.12, R2.15, R2.16, R2.13)
//   3. model attribution (R2.10, R2.17)
//   4. dedup conflicts (R4.4)
//   5. streams, identity, copy exposure, forks (R4.9, R4.11, R4.12, R4.13)
//   6. links, kinds, compactions, versions, thread totals
//   7. metamorphic suite (R4.10, R17.6, R17.7)
//   8. privacy canary (R1.1, R14.7)

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { discover } from "../../src/discover.js";
import { zstdSupported } from "../../src/io/lines.js";
import { parseCodex } from "../../src/sources/codex.js";
import { PHYSICAL_COVERAGE_COUNTERS, type CodexParseResult, type CodexResponse, type CoverageCounters } from "../../src/model/types.js";
import { scenarios } from "../../scripts/gen-fixtures.ts";
import { CodexHome, CodexThread, type CodexLine, type GeneratedFile } from "../fixtures/builder.ts";

// ---------------------------------------------------------------------------
// 1. helpers
// ---------------------------------------------------------------------------

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function writeTree(files: readonly GeneratedFile[]): string {
  const root = mkdtempSync(join(tmpdir(), "cachewhy-codex-"));
  roots.push(root);
  for (const f of files) {
    if (f.unavailable) continue;
    const abs = join(root, ...f.path.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
  return root;
}

async function run(files: readonly GeneratedFile[], opts?: Parameters<typeof parseCodex>[1]): Promise<CodexParseResult> {
  const root = writeTree(files);
  const d = await discover({ codexDirs: [root], home: join(root, "no-home"), env: {} });
  return parseCodex(d.files, opts);
}

/** Order of the DiscoveredFile list must not matter, so the tests feed it reversed and shuffled too. */
async function runWithOrder(files: readonly GeneratedFile[], order: "asc" | "desc" | "odd-even"): Promise<CodexParseResult> {
  const root = writeTree(files);
  const d = await discover({ codexDirs: [root], home: join(root, "no-home"), env: {} });
  let list = d.files.slice();
  if (order === "desc") list.reverse();
  if (order === "odd-even") list = [...list.filter((_, i) => i % 2 === 1), ...list.filter((_, i) => i % 2 === 0)];
  return parseCodex(list);
}

function thread(o: ConstructorParameters<typeof CodexThread>[0] = {}): CodexThread {
  return new CodexThread({ threadSource: "user", ...o });
}

function filesOf(...threads: CodexThread[]): GeneratedFile[] {
  const home = new CodexHome();
  for (const t of threads) home.add(t);
  return home.files();
}

function raw(name: string, lines: readonly (object | string)[]): GeneratedFile {
  const text = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
  return { path: `sessions/2026/01/01/rollout-2026-01-01T00-00-00-${name}.jsonl`, content: text };
}

const T0 = Date.UTC(2026, 0, 1);
const iso = (sec: number): string => new Date(T0 + sec * 1000).toISOString();

/** A hand written line. */
function ln(type: string, ordinal: number | null, sec: number, payload: object = {}): Record<string, unknown> {
  const l: Record<string, unknown> = { timestamp: iso(sec), type, payload };
  if (ordinal !== null) l["ordinal"] = ordinal;
  return l;
}
const metaP = (id: string, extra: object = {}): object => ({
  id, session_id: id, timestamp: iso(0), cli_version: "0.158.0", originator: "codex_cli", source: "cli", thread_source: "user", ...extra,
});
const tcP = (turn: string, model: string): object => ({ turn_id: turn, root_turn_id: turn, model, effort: "medium", comp_hash: "h", collaboration_mode: { mode: "default" } });
const usageP = (inp: number, c: number, cw: number, out: number, rs: number, total?: number): object => ({
  input_tokens: inp, cached_input_tokens: c, cache_write_input_tokens: cw, output_tokens: out, reasoning_output_tokens: rs, total_tokens: total ?? inp + out,
});
const turP = (rid: string | null, thread: string, turn: string, usage: object, extra: object = {}): object => ({
  ...(rid === null ? {} : { response_id: rid }), thread_id: thread, session_id: thread, turn_id: turn, usage, ...extra,
});

const byKey = (r: CodexParseResult, key: string): CodexResponse => {
  const x = r.responses.find((y) => y.key === key);
  assert.ok(x, `response ${key}`);
  return x;
};

const bigintReplacer = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? `${v.toString()}n` : v instanceof Set ? [...v].sort() : v);

/**
 * Counters that depend on how lines are grouped into files and are therefore physical in practice, although
 * src/model/types.ts does not list them in PHYSICAL_COVERAGE_COUNTERS: `versions` (line counts per version) and
 * `token_count_events_without_response_id` (events of files without a usage record, so a split can create such a file).
 */
const PHYSICAL_BY_NATURE = new Set<string>(["versions", "token_count_events_without_response_id"]);

function logicalCoverage(c: CoverageCounters): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (PHYSICAL_COVERAGE_COUNTERS.has(k as never) || PHYSICAL_BY_NATURE.has(k)) continue;
    out[k] = v;
  }
  return out;
}
function physicalCoverage(c: CoverageCounters): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    if (PHYSICAL_COVERAGE_COUNTERS.has(k as never) || PHYSICAL_BY_NATURE.has(k)) out[k] = v;
  }
  return out;
}

/** The semantic output (R4.10): everything except file indices and physical counters. */
function semantic(r: CodexParseResult): string {
  return JSON.stringify(
    {
      responses: r.responses.map((x) => ({ ...x, provenance: { from_copy_exposed_file: x.provenance.from_copy_exposed_file } })),
      excluded: r.excluded.map(({ files: _f, ...e }) => e),
      conflicts: r.conflicts.map(({ files: _f, ...c }) => c),
      links: r.links,
      streams: r.streams.map(({ files: _f, ...s }) => s),
      compactions: r.compactions,
      thread_totals: r.thread_totals,
      assumptions: r.assumptions,
      forked: r.forked_from_ids,
      coverage: logicalCoverage(r.coverage),
    },
    bigintReplacer,
  );
}

/** Context around the first difference of two strings, for readable failures. */
function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `differs at ${i}: [${a.slice(Math.max(0, i - 120), i + 160)}] vs [${b.slice(Math.max(0, i - 120), i + 160)}]`;
}
function same(actual: string, expected: string, label: string): void {
  if (actual !== expected) assert.fail(`${label}: ${firstDiff(actual, expected)}`);
}

// Seeded shuffle (no Math.random, so failures reproduce).
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const r = rng(seed);
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

const text = (f: GeneratedFile): string => (typeof f.content === "string" ? f.content : Buffer.from(f.content).toString("utf8"));
const linesOf = (f: GeneratedFile): string[] => text(f).split("\n").filter((l) => l.length > 0);
const withLines = (f: GeneratedFile, lines: readonly string[]): GeneratedFile => ({ path: f.path, content: lines.join("\n") + "\n" });

function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).reverse()) out[k] = reverseKeys(o[k]);
    return out;
  }
  return v;
}

const plain = (files: readonly GeneratedFile[]): GeneratedFile[] => files.filter((f) => typeof f.content === "string" && !f.path.endsWith(".zst"));

/** A file name that sorts directly after/before the original, so the canonical order stays predictable. */
function splitFile(f: GeneratedFile, at: number): [GeneratedFile, GeneratedFile] {
  const ls = linesOf(f);
  const stem = f.path.replace(/\.jsonl$/, "");
  return [
    { path: `${stem}-a.jsonl`, content: ls.slice(0, at).join("\n") + "\n" },
    { path: `${stem}-b.jsonl`, content: ls.slice(at).join("\n") + "\n" },
  ];
}
const carriesIdentity = (ls: readonly string[]): boolean => ls.some((l) => l.includes('"type":"session_meta"') || l.includes('"type":"token_usage_record"'));

// ---------------------------------------------------------------------------
// 2. accounting
// ---------------------------------------------------------------------------

describe("accounting (R2.6 to R2.9)", () => {
  it("normal = in - cached - write, output keeps reasoning inside, cumulative fields are never summed", async () => {
    const t = thread({ threadId: "synthetic-thread-acc" });
    t.turnContext({ turnId: "t1" });
    t.tokenUsage({ responseId: "r1", usage: { input: 1000, cached: 300, cacheWrite: 200, output: 50, reasoning: 20 } });
    t.tokenUsage({ responseId: "r2", usage: { input: 2000, cached: 0, output: 10, reasoning: 0 } });
    const r = await run(filesOf(t));
    const a = byKey(r, "r1").usage!;
    assert.equal(a.input_uncached, 500n);
    assert.equal(a.cache_read, 300n);
    assert.equal(a.cache_write, 200n);
    assert.equal(a.cache_write_5m + a.cache_write_1h + a.cache_write_unknown_ttl, 0n);
    assert.equal(a.output, 50n);
    assert.equal(a.output_lower_bound, 50n);
    assert.equal(a.reasoning, 20n);
    assert.equal(a.reasoning_included_in_output, true);
    // The thread total of r2 is cumulative (3060) and must not appear as tokens of r2.
    const b = byKey(r, "r2");
    assert.equal(b.usage!.input_uncached, 2000n);
    assert.equal(b.usage!.output, 10n);
    assert.equal(b.thread_total, 3060n);
    assert.equal(r.coverage.responses_total, 2);
    assert.equal(r.coverage.requests_total, 2);
    assert.equal(r.coverage.records_usage_bearing, 2);
    assert.equal(byKey(r, "r1").modifiers.speed, null);
    assert.equal(byKey(r, "r1").ownership.role, "owner");
    assert.equal(byKey(r, "r1").time.gap_basis, "none");
    assert.equal(byKey(r, "r1").time.start_lo_ms, null);
  });

  it("fixture codex-basic: response values, compaction, a thread over two files, archived zst", async () => {
    const sc = scenarios.find((s) => s.name === "codex-basic")!;
    const files = sc.build();
    const r = await run(files);
    assert.equal(byKey(r, "synthetic-resp-1").usage!.input_uncached, 12000n);
    assert.equal(byKey(r, "synthetic-resp-1").usage!.output, 400n);
    assert.equal(byKey(r, "synthetic-resp-1").usage!.reasoning, 100n);
    assert.equal(byKey(r, "synthetic-resp-2").usage!.input_uncached, 600n);
    assert.equal(byKey(r, "synthetic-resp-2").usage!.cache_read, 12000n);
    assert.equal(r.compactions.length, 1);
    assert.equal(r.compactions[0]!.window_number, 1);
    assert.equal(r.compactions[0]!.in_copied_prefix, false);
    assert.equal(r.compactions[0]!.latest_usage_is_null, false);
    const main = r.streams.filter((s) => s.chain.thread === "synthetic-thread-main");
    assert.equal(main.length, 1);
    assert.equal(main[0]!.files.length, 2);
    assert.equal(main[0]!.ordinal_verified, true);
    if (zstdSupported()) {
      assert.equal(byKey(r, "synthetic-resp-a1").usage!.input_uncached, 2000n);
      assert.equal(r.files.filter((f) => f.archived && f.readable).length, 1);
      assert.equal(r.coverage.files_unreadable, 0);
    } else {
      assert.equal(r.coverage.files_unreadable, 1);
      assert.equal(r.files.filter((f) => f.archived && !f.readable).length, 1);
    }
  });

  it("archived .zst files are read through src/io/lines.ts, or counted as unreadable when zstd is missing", async (ctx) => {
    const t = thread({ threadId: "synthetic-thread-z" });
    t.turnContext({ turnId: "t1" });
    t.tokenUsage({ responseId: "rz", usage: { input: 500, output: 5 } });
    const home = new CodexHome();
    home.add(t, { archived: true, zstd: true });
    const files = home.files();
    const r = await run(files);
    if (files.some((f) => f.unavailable)) {
      ctx.diagnostic("no zstd compressor on this Node: only the unreadable path is exercised");
      assert.equal(r.coverage.files_unreadable, 0);
      return;
    }
    assert.equal(r.coverage.files_total, 1);
    assert.equal(r.files[0]!.archived, true);
    assert.equal(byKey(r, "rz").usage!.input_uncached, 500n);
  });

  it("a missing response_id is unkeyed: coverage loss, no tokens, an excluded record for the gap rule", async () => {
    const f = raw("unkeyed", [
      ln("session_meta", 0, 0, metaP("th-u")),
      ln("turn_context", 1, 1, tcP("t1", "gpt-x")),
      ln("token_usage_record", 2, 2, turP("r1", "th-u", "t1", usageP(100, 0, 0, 10, 0))),
      ln("token_usage_record", 3, 3, turP(null, "th-u", "t1", usageP(900, 0, 0, 90, 0))),
      ln("token_usage_record", 4, 4, turP("r3", "th-u", "t1", usageP(200, 0, 0, 20, 0))),
    ]);
    const r = await run([f]);
    assert.equal(r.responses.length, 2);
    assert.equal(r.coverage.records_unkeyed, 1);
    assert.equal(r.coverage.records_usage_bearing, 3);
    assert.equal(r.excluded.length, 1);
    assert.equal(r.excluded[0]!.reason, "unkeyed");
    assert.equal(r.excluded[0]!.event_ms, T0 + 3000);
    assert.equal(r.excluded[0]!.ordinal, 3);
    assert.equal(r.excluded[0]!.chain.thread, "th-u");
  });

  it("a file with token_count events but no token_usage_record contributes nothing (R2.9)", async () => {
    const f1 = raw("nocount", [
      ln("session_meta", 0, 0, metaP("th-n")),
      ln("event_msg", 1, 1, { type: "token_count", info: { total_token_usage: { input_tokens: 99999 } } }),
      ln("event_msg", 2, 2, { type: "token_count" }),
    ]);
    const r = await run([f1]);
    assert.equal(r.responses.length, 0);
    assert.equal(r.coverage.files_without_response_id, 1);
    assert.equal(r.coverage.token_count_events_without_response_id, 2);
    assert.equal(r.files[0]!.without_response_id, true);
    assert.equal(r.coverage.tokens_unpriced, 0n);
  });

  it("incomplete usage is never read as 0 (R2.12) and reports present counters", async () => {
    const u = usageP(100, 0, 0, 10, 0) as Record<string, unknown>;
    delete u["cache_write_input_tokens"];
    const f = raw("incomplete", [
      ln("session_meta", 0, 0, metaP("th-i")),
      ln("turn_context", 1, 1, tcP("t1", "gpt-x")),
      ln("token_usage_record", 2, 2, turP("ri", "th-i", "t1", u)),
      ln("token_usage_record", 3, 3, turP("ri2", "th-i", "t1", { input_tokens: "12", output_tokens: 3 })),
    ]);
    const r = await run([f]);
    const x = byKey(r, "ri");
    assert.equal(x.exclusion, "usage_incomplete");
    assert.equal(x.usage, null);
    assert.equal(byKey(r, "ri2").exclusion, "usage_incomplete");
    assert.equal(r.coverage.tokens_in_incomplete_responses, 100n + 10n + 3n);
    assert.equal(r.coverage.records_usage_unmappable, 2);
  });

  it("R2.15 range: MAX_SAFE_INTEGER passes, MAX_SAFE_INTEGER + 1, negative, fractional and string-free huge values fail", async () => {
    const MAX = Number.MAX_SAFE_INTEGER;
    const f = raw("range", [
      ln("session_meta", 0, 0, metaP("th-r")),
      ln("turn_context", 1, 1, tcP("t1", "gpt-x")),
      ln("token_usage_record", 2, 2, turP("max", "th-r", "t1", usageP(MAX, MAX, 0, 0, 0, MAX))),
      ln("token_usage_record", 3, 3, turP("over", "th-r", "t1", usageP(MAX + 1, 0, 0, 0, 0, MAX + 1))),
      ln("token_usage_record", 4, 4, turP("neg", "th-r", "t1", usageP(-1, 0, 0, 0, 0, -1))),
      ln("token_usage_record", 5, 5, turP("frac", "th-r", "t1", usageP(10.5, 0, 0, 0, 0, 10.5))),
    ]);
    const text2 = f.content as string;
    // 1e999 is valid JSON text that parses to Infinity.
    const g: GeneratedFile = {
      path: f.path.replace("range", "range2"),
      content: [
        JSON.stringify(ln("session_meta", 0, 0, metaP("th-r2"))),
        `{"timestamp":"${iso(1)}","type":"token_usage_record","ordinal":1,"payload":{"response_id":"inf","thread_id":"th-r2","session_id":"th-r2","turn_id":"t","usage":{"input_tokens":1e999,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0,"total_tokens":0}}}`,
      ].join("\n") + "\n",
    };
    void text2;
    const r = await run([f, g]);
    const mx = byKey(r, "max");
    assert.equal(mx.exclusion, null);
    assert.equal(mx.usage!.input_uncached, 0n); // in - c - cw, exact
    assert.equal(mx.usage!.cache_read, BigInt(MAX));
    for (const k of ["over", "neg", "frac", "inf"]) {
      assert.equal(byKey(r, k).exclusion, "usage_range_failed", k);
      assert.equal(byKey(r, k).usage, null);
    }
    assert.equal(r.coverage.responses_usage_range_failed, 4);
    assert.equal(r.coverage.tokens_in_invalid_responses, 0n); // raw values are not stored
  });

  it("R2.7 invariants: c + cw <= in, rs <= out, total == in + out, evaluated in BigInt", async () => {
    const f = raw("inv", [
      ln("session_meta", 0, 0, metaP("th-v")),
      ln("turn_context", 1, 1, tcP("t1", "gpt-x")),
      ln("token_usage_record", 2, 2, turP("ok", "th-v", "t1", usageP(100, 60, 40, 5, 5))),
      ln("token_usage_record", 3, 3, turP("cached", "th-v", "t1", usageP(100, 70, 40, 5, 0))),
      ln("token_usage_record", 4, 4, turP("rs", "th-v", "t1", usageP(100, 0, 0, 5, 6))),
      ln("token_usage_record", 5, 5, turP("total", "th-v", "t1", usageP(100, 0, 0, 5, 0, 106))),
    ]);
    const r = await run([f]);
    assert.equal(byKey(r, "ok").exclusion, null);
    assert.equal(byKey(r, "ok").usage!.input_uncached, 0n);
    for (const k of ["cached", "rs", "total"]) {
      assert.equal(byKey(r, k).exclusion, "usage_invariant_failed", k);
      assert.equal(byKey(r, k).usage, null);
    }
    assert.equal(r.coverage.responses_usage_invariant_failed, 3);
    assert.equal(r.coverage.tokens_in_invalid_responses, 105n * 3n);
  });

  it("sums across responses are BigInt: two responses at MAX_SAFE_INTEGER add exactly (R2.16)", async () => {
    const MAX = Number.MAX_SAFE_INTEGER;
    const f = raw("big", [
      ln("session_meta", 0, 0, metaP("th-big")),
      ln("turn_context", 1, 1, tcP("t1", "gpt-x")),
      ln("token_usage_record", 2, 2, turP("a", "th-big", "t1", usageP(MAX, 1, 1, 0, 0, MAX), { thread_token_usage: { total_tokens: MAX } })),
      ln("token_usage_record", 3, 3, turP("b", "th-big", "t1", usageP(MAX, 0, 0, 0, 0, MAX), { thread_token_usage: { total_tokens: MAX } })),
    ]);
    const r = await run([f]);
    assert.equal(byKey(r, "a").usage!.input_uncached, BigInt(MAX) - 2n);
    assert.equal(r.thread_totals[0]!.summed_total_tokens, 2n * BigInt(MAX));
    assert.equal(r.thread_totals[0]!.chain_complete, false); // the second cumulative total is not previous plus usage
  });

  it("a keyed record whose timestamp does not parse cannot be placed in time: usage_incomplete (assumption, see report)", async () => {
    const f = raw("badts", [
      ln("session_meta", 0, 0, metaP("th-bt")),
      { ...ln("token_usage_record", 1, 1, turP("r1", "th-bt", "T", usageP(10, 0, 0, 1, 0))), timestamp: "yesterday" },
    ]);
    const r = await run([f]);
    assert.equal(byKey(r, "r1").exclusion, "usage_incomplete");
    assert.equal(r.coverage.records_usage_unmappable, 1);
    assert.equal(r.streams[0]!.ordinal_verified, false);
  });

  it("two own session_metas of one id with different session_ids make the stream unverified", async () => {
    const f = raw("sess", [
      ln("session_meta", 0, 0, metaP("th-s", { session_id: "sess-1" })),
      ln("session_meta", 1, 1, metaP("th-s", { session_id: "sess-2" })),
      ln("token_usage_record", 2, 2, turP("r1", "th-s", "T", usageP(10, 0, 0, 1, 0))),
    ]);
    const r = await run([f]);
    assert.deepEqual(r.streams[0]!.integrity_reasons, ["divergent_session_meta"]);
    assert.equal(r.streams[0]!.chain.root_session, "sess-1");
  });

  it("an out-of-range thread total is treated as absent and counted (R2.15)", async () => {
    const f = raw("tt", [
      ln("session_meta", 0, 0, metaP("th-t")),
      ln("turn_context", 1, 1, tcP("t1", "gpt-x")),
      ln("token_usage_record", 2, 2, turP("r1", "th-t", "t1", usageP(10, 0, 0, 1, 0), { thread_token_usage: { total_tokens: -5 } })),
    ]);
    const r = await run([f]);
    assert.equal(byKey(r, "r1").thread_total, null);
    assert.equal(r.coverage.fields_range_failed, 1);
    assert.equal(byKey(r, "r1").exclusion, null);
  });
});

// ---------------------------------------------------------------------------
// 3. model attribution (R2.10, R2.17)
// ---------------------------------------------------------------------------

describe("model attribution (R2.10, R2.17)", () => {
  const attr = (r: CodexParseResult, k: string): [string, boolean, string | null] => {
    const m = byKey(r, k).model;
    return [m.source, m.verified, m.model];
  };

  it("own_turn: the context of the record's own turn verifies the model", async () => {
    const t = thread({ threadId: "th-a" });
    t.turnContext({ turnId: "T1", model: "gpt-6-luna" });
    t.tokenUsage({ responseId: "r1", turnId: "T1" });
    const r = await run(filesOf(t));
    assert.deepEqual(attr(r, "r1"), ["own_turn", true, "gpt-6-luna"]);
    assert.equal(byKey(r, "r1").model.candidate, "gpt-6-luna");
  });

  it("normalizes a trailing -YYYYMMDD and refuses off-pattern model ids", async () => {
    const t = thread({ threadId: "th-n" });
    t.turnContext({ turnId: "T1", model: "gpt-6-sol-20260101" });
    t.tokenUsage({ responseId: "r1", turnId: "T1" });
    t.turnContext({ turnId: "T2", model: "GPT 6 With Spaces" });
    t.tokenUsage({ responseId: "r2", turnId: "T2" });
    const r = await run(filesOf(t));
    assert.deepEqual(attr(r, "r1"), ["own_turn", true, "gpt-6-sol"]);
    // A context whose model cannot be normalized never verifies anything.
    assert.equal(byKey(r, "r2").model.verified, false);
    assert.equal(byKey(r, "r2").model.candidate, null);
    assert.equal(byKey(r, "r2").model.source, "own_turn_unsettled");
  });

  it("a settings marker between the context and the record gives own_turn_unsettled, never verified", async () => {
    const t = thread({ threadId: "th-b" });
    t.turnContext({ turnId: "T", model: "model-a" });
    t.eventMsg("thread_settings_applied");
    t.tokenUsage({ responseId: "r1", turnId: "T" });
    const r = await run(filesOf(t));
    assert.deepEqual(attr(r, "r1"), ["own_turn_unsettled", false, null]);
    assert.equal(byKey(r, "r1").model.candidate, "model-a");
    assert.equal(r.coverage.responses_model_unverified, 1);
    assert.equal(r.streams[0]!.has_settings_marker, true);
  });

  it("R2.17 fixture 1: context A, marker, context B, same turn: no verified model", async () => {
    const t = thread({ threadId: "th-c" });
    t.turnContext({ turnId: "T", model: "model-a" });
    t.eventMsg("thread_settings_applied");
    t.turnContext({ turnId: "T", model: "model-b" });
    t.tokenUsage({ responseId: "r1", turnId: "T" });
    const r = await run(filesOf(t));
    assert.deepEqual(attr(r, "r1"), ["own_turn_unsettled", false, null]);
    assert.equal(byKey(r, "r1").model.candidate, null);
  });

  it("two models inside one turn leave the turn unverified even without a marker", async () => {
    const t = thread({ threadId: "th-c2" });
    t.turnContext({ turnId: "T", model: "model-a" });
    t.turnContext({ turnId: "T", model: "model-b" });
    t.tokenUsage({ responseId: "r1", turnId: "T" });
    const r = await run(filesOf(t));
    assert.deepEqual(attr(r, "r1"), ["own_turn_unsettled", false, null]);
  });

  it("the settings marker position is unknown without ordinals: own_turn_unsettled; without any marker own_turn stays", async () => {
    const lines = (withMarker: boolean): GeneratedFile =>
      raw(withMarker ? "noord-m" : "noord-n", [
        ln("session_meta", null, 0, metaP("th-d")),
        ln("turn_context", null, 1, tcP("T", "model-a")),
        ...(withMarker ? [ln("event_msg", null, 2, { type: "thread_settings_applied" })] : []),
        ln("token_usage_record", null, 3, turP("r1", "th-d", "T", usageP(10, 0, 0, 1, 0))),
      ]);
    const marked = await run([lines(true)]);
    assert.equal(marked.streams[0]!.ordinal_verified, false);
    assert.deepEqual(attr(marked, "r1"), ["own_turn_unsettled", false, null]);
    const unmarked = await run([lines(false)]);
    assert.equal(unmarked.streams[0]!.ordinal_verified, false);
    assert.deepEqual(attr(unmarked, "r1"), ["own_turn", true, "model-a"]);
    assert.equal(unmarked.coverage.streams_ordinal_unverified, 1);
  });

  it("R2.17 fixture 2: a newer context of another turn does not unbind the record; a marker after the first own context does", async () => {
    const mk = (marker: boolean): CodexThread => {
      const t = thread({ threadId: "th-e" });
      t.turnContext({ turnId: "T1", model: "model-a" });
      if (marker) t.eventMsg("thread_settings_applied");
      t.turnContext({ turnId: "T2", model: "model-b" });
      t.tokenUsage({ responseId: "r1", turnId: "T1" });
      return t;
    };
    assert.deepEqual(attr(await run(filesOf(mk(false))), "r1"), ["own_turn", true, "model-a"]);
    assert.deepEqual(attr(await run(filesOf(mk(true))), "r1"), ["own_turn_unsettled", false, null]);
  });

  it("R2.17 fixture 3: a record of a turn without its own context after two models is carried_unverified", async () => {
    const t = thread({ threadId: "th-f" });
    t.turnContext({ turnId: "T1", model: "model-a" });
    t.turnContext({ turnId: "T2", model: "model-b" });
    t.tokenUsage({ responseId: "r3", turnId: "T3" });
    const r = await run(filesOf(t));
    assert.deepEqual(attr(r, "r3"), ["carried_unverified", false, null]);
    assert.equal(byKey(r, "r3").model.candidate, "model-b");
  });

  it("R2.17 fixture 4: one model everywhere and no marker gives carried_verified", async () => {
    const t = thread({ threadId: "th-g" });
    t.turnContext({ turnId: "T1", model: "model-a" });
    t.turnContext({ turnId: "T2", model: "model-a" });
    t.tokenUsage({ responseId: "r3", turnId: "T3" });
    const r = await run(filesOf(t));
    assert.deepEqual(attr(r, "r3"), ["carried_verified", true, "model-a"]);
  });

  it("a stream that ever had a marker carries nothing by position (R2.17 (b))", async () => {
    const t = thread({ threadId: "th-h" });
    t.turnContext({ turnId: "T1", model: "model-a" });
    t.tokenUsage({ responseId: "r1", turnId: "T1" });
    t.eventMsg("thread_settings_applied");
    t.tokenUsage({ responseId: "r2", turnId: "T2" });
    const r = await run(filesOf(t));
    // the marker lies after r1 and its context: R2.10 keeps r1 verified in an ordinal verified stream
    assert.deepEqual(attr(r, "r1"), ["own_turn", true, "model-a"]);
    assert.deepEqual(attr(r, "r2"), ["carried_unverified", false, null]);
  });

  it("source none: no context precedes the record", async () => {
    const t = thread({ threadId: "th-i" });
    t.tokenUsage({ responseId: "r0", turnId: "T0" });
    t.turnContext({ turnId: "T1", model: "model-a" });
    const r = await run(filesOf(t));
    assert.deepEqual(attr(r, "r0"), ["none", false, null]);
    assert.equal(byKey(r, "r0").model.candidate, null);
  });

  it("R4.12: two contexts with one ordinal and different models are a collision; a byte-identical duplicate is not", async () => {
    const base = [
      ln("session_meta", 0, 0, metaP("th-j")),
      ln("turn_context", 1, 1, tcP("T1", "model-a")),
      ln("token_usage_record", 3, 3, turP("r1", "th-j", "T2", usageP(10, 0, 0, 1, 0))),
    ];
    const dup = await run([raw("dup", [...base, base[1]!])]);
    assert.equal(dup.streams[0]!.ordinal_verified, true);
    assert.deepEqual(attr(dup, "r1"), ["carried_verified", true, "model-a"]);
    assert.equal(dup.coverage.lines_duplicate_collapsed, 1);
    assert.equal(dup.coverage.duplicate_records_collapsed, 1);
    const collide = await run([raw("collide", [...base, ln("turn_context", 1, 1, tcP("T9", "model-b"))])]);
    assert.equal(collide.streams[0]!.ordinal_verified, false);
    assert.deepEqual(attr(collide, "r1"), ["carried_unverified", false, null]);
    assert.equal(collide.coverage.streams_ordinal_unverified, 1);
  });

  it("R4.12 (c): timestamps that decrease along the ordinal order fail the stream; a missing ordinal on a decision record too", async () => {
    const dec = await run([
      raw("dec", [
        ln("session_meta", 0, 5, metaP("th-k")),
        ln("turn_context", 1, 1, tcP("T1", "model-a")),
        ln("token_usage_record", 2, 6, turP("r1", "th-k", "T2", usageP(10, 0, 0, 1, 0))),
      ]),
    ]);
    assert.equal(dec.streams[0]!.ordinal_verified, false);
    assert.equal(byKey(dec, "r1").model.source, "carried_unverified");
    const noOrd = await run([
      raw("noord2", [
        ln("session_meta", 0, 0, metaP("th-k2")),
        ln("turn_context", 1, 1, tcP("T1", "model-a")),
        ln("token_usage_record", null, 2, turP("r1", "th-k2", "T2", usageP(10, 0, 0, 1, 0))),
      ]),
    ]);
    assert.equal(noOrd.streams[0]!.ordinal_verified, false);
    // any other record that carries an ordinal must satisfy the same range
    const bad = await run([
      raw("badord", [
        ln("session_meta", 0, 0, metaP("th-k3")),
        ln("turn_context", 1, 1, tcP("T1", "model-a")),
        { ...ln("response_item", 2, 2), ordinal: -4 },
        ln("token_usage_record", 3, 3, turP("r1", "th-k3", "T2", usageP(10, 0, 0, 1, 0))),
      ]),
    ]);
    assert.equal(bad.streams[0]!.ordinal_verified, false);
  });

  it("carried across two files of one thread passes the check; a failing continuation file makes the thread unverified (Q21)", async () => {
    const f1 = raw("c1", [ln("session_meta", 0, 0, metaP("th-m")), ln("turn_context", 1, 1, tcP("T1", "model-a"))]);
    const good = raw("c2", [ln("token_usage_record", 2, 2, turP("r1", "th-m", "T2", usageP(10, 0, 0, 1, 0)))]);
    const r = await run([f1, good]);
    assert.equal(r.streams[0]!.files.length, 2);
    assert.equal(r.streams[0]!.ordinal_verified, true);
    assert.deepEqual(attr(r, "r1"), ["carried_verified", true, "model-a"]);
    const badFile = raw("c2", [ln("token_usage_record", 1, 2, turP("r1", "th-m", "T2", usageP(10, 0, 0, 1, 0)))]);
    const r2 = await run([f1, badFile]);
    assert.equal(r2.streams[0]!.ordinal_verified, false);
    assert.deepEqual(attr(r2, "r1"), ["carried_unverified", false, null]);
  });

  it("fork: a record carried from the copied prefix is inherited_prefix; an unresolved prefix is carried_unverified", async () => {
    const parent = thread({ threadId: "th-p" });
    parent.turnContext({ turnId: "TP", model: "model-a" });
    parent.responseItem("message", "user");
    parent.tokenUsage({ responseId: "rp", turnId: "TP" });
    const fork = CodexThread.fork(parent, { threadId: "th-f2", threadSource: "user", prefixLen: 2 });
    fork.tokenUsage({ responseId: "rf", turnId: "TF" }); // no own context: latest context lies in the copied prefix
    const r = await run(filesOf(parent, fork));
    assert.deepEqual(attr(r, "rf"), ["inherited_prefix", false, null]);
    assert.equal(byKey(r, "rf").model.candidate, "model-a");
    assert.deepEqual(attr(r, "rp"), ["own_turn", true, "model-a"]);

    // same fork, but its session_meta lacks subagent_history_start_ordinal: fork_prefix_unresolved
    const files = filesOf(parent, fork).map((f) => {
      if (!f.path.includes("th-f2")) return f;
      return withLines(f, linesOf(f).map((l) => l.replace(/,"subagent_history_start_ordinal":\d+/, "")));
    });
    const r2 = await run(files);
    assert.deepEqual(attr(r2, "rf"), ["carried_unverified", false, null]);
    assert.equal(r2.coverage.streams_fork_prefix_unresolved, 1);
    const st = r2.streams.find((s) => s.chain.thread === "th-f2")!;
    assert.equal(st.fork!.prefix_resolved, false);
    assert.equal(st.fork!.history_start_ordinal, null);
  });

  it("fork: a context at or after subagent_history_start_ordinal is carried_verified", async () => {
    const parent = thread({ threadId: "th-p3" });
    parent.turnContext({ turnId: "TP", model: "model-a" });
    parent.tokenUsage({ responseId: "rp", turnId: "TP" });
    const fork = CodexThread.fork(parent, { threadId: "th-f3", threadSource: "user", prefixLen: 1 });
    fork.turnContext({ turnId: "TF1", model: "model-a" });
    fork.tokenUsage({ responseId: "rf", turnId: "TF2" });
    const r = await run(filesOf(parent, fork));
    assert.deepEqual(attr(r, "rf"), ["carried_verified", true, "model-a"]);
  });

  it("a copy-exposed copy of a parent context with a different model never changes the parent (R4.13 (b))", async () => {
    const parent = thread({ threadId: "th-p4" });
    parent.turnContext({ turnId: "TP", model: "model-a" });
    parent.tokenUsage({ responseId: "rp1", turnId: "TP" });
    parent.tokenUsage({ responseId: "rp2", turnId: "TP2" });
    const fork = CodexThread.fork(parent, { threadId: "th-f4", threadSource: "user", prefixLen: 1 });
    fork.tokenUsage({ responseId: "rf", turnId: "TF" });
    const base = await run(filesOf(parent, fork));
    assert.deepEqual(attr(base, "rp2"), ["carried_verified", true, "model-a"]);
    // Half of the fork file holds only the copied parent meta and a copied parent context of another model.
    const files = filesOf(parent, fork);
    const forkFile = files.find((f) => f.path.includes("th-f4"))!;
    const ls = linesOf(forkFile);
    const copied = ls.slice(0, 2).map((l) => l.replace('"model":"model-a"', '"model":"model-z"'));
    const rest = ls.slice(2);
    const split = files.filter((f) => f !== forkFile).concat([
      { path: forkFile.path.replace(".jsonl", "-a.jsonl"), content: copied.join("\n") + "\n" },
      { path: forkFile.path.replace(".jsonl", "-b.jsonl"), content: rest.join("\n") + "\n" },
    ]);
    const r = await run(split);
    assert.equal(r.coverage.files_copy_exposed, 1);
    const p = r.streams.find((s) => s.chain.thread === "th-p4")!;
    assert.equal(p.integrity_unverified, true);
    assert.ok(p.integrity_reasons.includes("copy_exposed_file"));
    // The foreign model never becomes a candidate, and nothing is added to the verified set of the parent.
    // R2.10: an integrity_unverified stream verifies no model through any row, own_turn included.
    assert.equal(byKey(r, "rp1").model.model, null);
    assert.equal(byKey(r, "rp1").model.source, "stream_unverified");
    assert.equal(byKey(r, "rp2").model.verified, false);
    for (const x of r.responses) assert.notEqual(x.model.candidate, "model-z");
  });
});

// ---------------------------------------------------------------------------
// 4. dedup conflicts (R4.4)
// ---------------------------------------------------------------------------

describe("duplicate response_id (R4.4)", () => {
  const two = (a: Record<string, unknown>, b: Record<string, unknown>, extraB: object = {}): GeneratedFile[] => [
    raw("dup-a", [ln("session_meta", 0, 0, metaP("th-1")), ln("turn_context", 1, 1, tcP("T", "model-a")), a]),
    raw("dup-b", [ln("session_meta", 0, 0, metaP("th-2", extraB)), ln("turn_context", 1, 1, tcP("T", "model-b")), b]),
  ];

  it("equal usage in two threads with different models: conflict_attribution, no dollars-bearing usage, no history entry", async () => {
    const u = usageP(100, 0, 0, 10, 0);
    const r = await run(two(ln("token_usage_record", 2, 2, turP("same", "th-1", "T", u)), ln("token_usage_record", 2, 2, turP("same", "th-2", "T", u))));
    const xs = r.responses.filter((x) => x.key === "same");
    assert.equal(xs.length, 2); // one excluded entry per (key, chain)
    for (const x of xs) {
      assert.equal(x.exclusion, "conflict_attribution");
      assert.equal(x.usage, null);
    }
    assert.equal(r.coverage.requests_conflict, 1);
    assert.equal(r.coverage.requests_conflict_by_kind.conflict_attribution, 1);
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0]!.effect, "excluded");
    assert.equal(r.coverage.responses_total, 1);
    assert.equal(r.coverage.responses_model_unverified, 0);
  });

  it("equal usage in one thread differing only in turn_id: conflict_attribution", async () => {
    const u = usageP(100, 0, 0, 10, 0);
    const f = raw("dup-c", [
      ln("session_meta", 0, 0, metaP("th-1")),
      ln("turn_context", 1, 1, tcP("T", "model-a")),
      ln("token_usage_record", 2, 2, turP("same", "th-1", "T", u)),
      ln("token_usage_record", 3, 3, turP("same", "th-1", "T2", u)),
    ]);
    const r = await run([f]);
    assert.equal(r.responses.length, 1);
    assert.equal(r.responses[0]!.exclusion, "conflict_attribution");
    assert.equal(r.responses[0]!.time.event_ms, T0 + 2000); // earliest position of the chain
    assert.equal(r.coverage.requests_conflict_by_kind.conflict_attribution, 1);
  });

  it("different usage under one response_id: conflict_usage", async () => {
    const f = raw("dup-d", [
      ln("session_meta", 0, 0, metaP("th-1")),
      ln("turn_context", 1, 1, tcP("T", "model-a")),
      ln("token_usage_record", 2, 2, turP("same", "th-1", "T", usageP(100, 0, 0, 10, 0))),
      ln("token_usage_record", 3, 3, turP("same", "th-1", "T", usageP(101, 0, 0, 10, 0))),
    ]);
    const r = await run([f]);
    assert.equal(r.responses[0]!.exclusion, "conflict_usage");
    assert.equal(r.coverage.requests_conflict_by_kind.conflict_usage, 1);
    assert.equal(r.coverage.requests_conflict, 1);
  });

  it("an identical duplicate record is one response, however many lines or files carry it", async () => {
    const rec = ln("token_usage_record", 2, 2, turP("same", "th-1", "T", usageP(100, 0, 0, 10, 0)));
    const r = await run([
      raw("dup-e", [ln("session_meta", 0, 0, metaP("th-1")), ln("turn_context", 1, 1, tcP("T", "model-a")), rec, rec, rec]),
      raw("dup-f", [rec]),
    ]);
    assert.equal(r.responses.length, 1);
    assert.equal(r.responses[0]!.exclusion, null);
    assert.equal(r.responses[0]!.usage!.input_uncached, 100n);
    assert.equal(r.coverage.lines_duplicate_collapsed, 3);
    assert.equal(r.coverage.duplicate_records_collapsed, 1);
    assert.equal(r.coverage.requests_conflict, 0);
    assert.deepEqual(r.responses[0]!.provenance.files, [0, 1]);
  });
});

// ---------------------------------------------------------------------------
// 5. streams, identity, copy exposure, forks
// ---------------------------------------------------------------------------

describe("logical streams (R4.11, R4.13)", () => {
  it("R2.10 fixture: a stream-conflict file makes the clean file's response stream_unverified, same under shuffle and splits", async () => {
    const f1 = raw("sc-f1", [
      ln("session_meta", 0, 0, metaP("th-X")),
      ln("turn_context", 1, 1, tcP("T", "model-a")),
      ln("token_usage_record", 2, 2, turP("rX", "th-X", "T", usageP(100, 0, 0, 10, 0))),
    ]);
    const f2 = raw("sc-f2", [
      ln("session_meta", 0, 0, metaP("th-Y")),
      ln("token_usage_record", 1, 1, turP("rY", "th-X", "T2", usageP(50, 0, 0, 5, 0))),
      ln("event_msg", 2, 2, { type: "thread_settings_applied" }),
      ln("turn_context", 3, 3, tcP("T", "model-b")),
    ]);
    const r = await run([f1, f2]);
    assert.equal(r.coverage.files_stream_conflict, 1);
    const x = byKey(r, "rX");
    assert.deepEqual([x.model.source, x.model.verified, x.model.model], ["stream_unverified", false, null]);
    assert.equal(r.streams.find((st) => st.chain.thread === "th-X")!.integrity_unverified, true);
    // accounting never depends on the verdict: tokens are kept
    assert.equal(x.usage!.input_uncached, 100n);
    // shuffled file order: identical
    const r2 = await run([f2, f1]);
    assert.deepEqual(r2.responses.map((y) => [y.key, y.model.source, y.model.verified]), r.responses.map((y) => [y.key, y.model.source, y.model.verified]));
    // every split of f1 keeps the response unverified (a verified model never appears)
    for (let cut = 1; cut < 3; cut++) {
      const [a, b] = splitFile(f1, cut);
      const rs = await run([a, b, f2]);
      assert.equal(byKey(rs, "rX").model.verified, false, `split at ${cut}`);
    }
  });

  it("a file without any identity record is unassigned and contributes nothing", async () => {
    const f = raw("noid", [ln("response_item", 0, 0, { type: "message" }), ln("event_msg", 1, 1, { type: "task_started" })]);
    const r = await run([f]);
    assert.equal(r.coverage.files_unassigned_stream, 1);
    assert.equal(r.streams.length, 0);
    assert.equal(r.files[0]!.stream_assignment, "unassigned");
  });

  it("two identities in one file: conflict, usage still accounted by its own thread_id, both streams unverified", async () => {
    const f = raw("conf", [
      ln("session_meta", 0, 0, metaP("th-x")),
      ln("turn_context", 1, 1, tcP("T", "model-a")),
      ln("token_usage_record", 2, 2, turP("rx", "th-x", "T", usageP(100, 0, 0, 10, 0))),
      ln("token_usage_record", 3, 3, turP("ry", "th-y", "T", usageP(200, 0, 0, 20, 0))),
    ]);
    const g = raw("conf-y", [ln("session_meta", 0, 0, metaP("th-y"))]);
    const r = await run([f, g]);
    assert.equal(r.coverage.files_stream_conflict, 1);
    assert.equal(r.files.filter((x) => x.stream_assignment === "conflict").length, 1);
    assert.equal(byKey(r, "rx").usage!.input_uncached, 100n);
    assert.equal(byKey(r, "ry").usage!.input_uncached, 200n);
    for (const s of r.streams) {
      assert.equal(s.integrity_unverified, true);
      assert.ok(s.integrity_reasons.includes("file_stream_conflict"));
    }
    assert.equal(r.coverage.streams_integrity_unverified, 2);
    // Records other than session_meta and token_usage_record of a conflict file belong to no stream: no context for rx.
    assert.equal(byKey(r, "rx").model.verified, false);
  });

  it("two own session_metas with one id and different forked_from_id make the stream unverified", async () => {
    const f = raw("div", [
      ln("session_meta", 0, 0, metaP("th-d", { forked_from_id: "th-other", subagent_history_start_ordinal: 0 })),
      ln("session_meta", 1, 1, metaP("th-d")),
      ln("token_usage_record", 2, 2, turP("r1", "th-d", "T", usageP(10, 0, 0, 1, 0))),
    ]);
    const r = await run([f]);
    assert.equal(r.streams[0]!.integrity_unverified, true);
    assert.deepEqual(r.streams[0]!.integrity_reasons, ["divergent_session_meta"]);
  });

  it("a copied parent session_meta is not an own identity; the parent file that holds a usage record is not copy exposed", async () => {
    const sc = scenarios.find((s) => s.name === "codex-fork")!;
    const r = await run(sc.build());
    assert.equal(r.coverage.files_total, 4);
    assert.equal(r.coverage.files_assigned_by_stream, 4);
    assert.equal(r.coverage.files_copy_exposed, 0);
    assert.equal(r.coverage.files_stream_conflict, 0);
    assert.equal(r.streams.length, 4);
    assert.deepEqual([...r.forked_from_ids], ["synthetic-thread-parent"]);
    for (const s of r.streams) assert.equal(s.integrity_unverified, false);
  });

  it("a fork file split so that one half holds only the copied parent meta is copy exposed; the parent loses carried_verified, gains nothing", async () => {
    const parent = thread({ threadId: "th-pp" });
    parent.turnContext({ turnId: "TP", model: "model-a" });
    parent.tokenUsage({ responseId: "rp1", turnId: "TP" });
    parent.tokenUsage({ responseId: "rp2", turnId: "TP2" });
    const fork = CodexThread.fork(parent, { threadId: "th-ff", threadSource: "user", prefixLen: 1 });
    fork.tokenUsage({ responseId: "rf1", turnId: "TF" });
    const files = filesOf(parent, fork);
    const unsplit = await run(files);
    assert.equal(byKey(unsplit, "rp2").model.source, "carried_verified");
    const ff = files.find((f) => f.path.includes("th-ff"))!;
    const [a, b] = splitFile(ff, 1); // a = copied parent meta only
    const r = await run(files.filter((f) => f !== ff).concat([a, b]));
    assert.equal(r.coverage.files_copy_exposed, 1);
    assert.equal(r.files.filter((f) => f.copy_exposed).length, 1);
    assert.equal(r.streams.find((s) => s.chain.thread === "th-pp")!.integrity_unverified, true);
    assert.equal(byKey(r, "rp2").model.verified, false);
    assert.equal(byKey(r, "rp1").model.model, null); // R2.10: stream_unverified overrides own_turn
    assert.equal(byKey(r, "rp1").model.source, "stream_unverified");
    // the child is prefix_exposed (R4.13 (c)): its fork ancestors meet the copy-exposed file
    assert.equal(byKey(r, "rf1").model.source, "prefix_exposed");
    assert.equal(byKey(r, "rf1").model.verified, false);
    assert.ok(r.streams.find((s) => s.chain.thread === "th-ff")!.integrity_reasons.includes("prefix_exposed"));
    // tokens are identical
    assert.deepEqual(
      r.responses.map((x) => [x.key, x.usage]),
      unsplit.responses.map((x) => [x.key, x.usage]),
    );
    assert.equal(r.responses.find((x) => x.key === "rp1")!.provenance.from_copy_exposed_file, false);
  });

  it("R15.7 fixture: a coverage-only file that forks a supported file with an own session_meta and no usage record makes it copy exposed", async () => {
    const supported = raw("sup", [ln("session_meta", 0, 0, metaP("th-sup")), ln("turn_context", 1, 1, tcP("T", "model-a"))]);
    const covOnly = raw("cov", [
      ln("session_meta", 0, 1, metaP("th-cov", { cli_version: "0.154.0-alpha.6.2", forked_from_id: "th-sup" })),
      ln("token_usage_record", 1, 2, turP("rc", "th-cov", "T", usageP(10, 0, 0, 1, 0))),
    ]);
    const r = await run([supported, covOnly]);
    const sup = r.files.find((f) => f.copy_exposed);
    assert.ok(sup);
    assert.equal(r.coverage.files_copy_exposed, 1);
    assert.equal(r.responses.length, 0); // nothing accounted for the coverage-only file
    assert.equal(r.streams.length, 1); // no stream, link or accounting exists because of it
    assert.equal(r.streams[0]!.chain.thread, "th-sup");
    assert.equal(r.streams[0]!.integrity_unverified, true);
    assert.deepEqual([...r.forked_from_ids], ["th-sup"]);
    assert.equal(r.coverage.requests_unverified_version, 1);
    assert.equal(r.coverage.files_assigned_by_stream, 1);
  });
});

describe("forks (R4.8, R4.9)", () => {
  it("fork facts, fork_first_own flag on the first own request only, prefix compactions marked", async () => {
    const parent = thread({ threadId: "th-p5" });
    parent.turnContext({ turnId: "TP", model: "model-a" });
    parent.compacted({ windowNumber: 1 });
    parent.tokenUsage({ responseId: "rp1", turnId: "TP" });
    const fork = CodexThread.fork(parent, { threadId: "th-f5", threadSource: "user", prefixLen: 2 });
    fork.turnContext({ turnId: "TF", model: "model-a" });
    fork.tokenUsage({ responseId: "rf1", turnId: "TF", usage: { input: 5000, output: 50 } });
    fork.tokenUsage({ responseId: "rf2", turnId: "TF" });
    fork.compacted({ windowNumber: 2, latestTokenUsageRecord: null });
    const r = await run(filesOf(parent, fork));
    const fi = r.streams.find((s) => s.chain.thread === "th-f5")!.fork!;
    assert.equal(fi.forked_from_id, "th-p5");
    assert.equal(fi.prefix_resolved, true);
    assert.equal(fi.history_start_ordinal, 3);
    assert.deepEqual(byKey(r, "rf1").flags, ["fork_first_own"]);
    assert.deepEqual(byKey(r, "rf2").flags, []);
    assert.deepEqual(byKey(r, "rp1").flags, []);
    // R4.8: the first own request is accounted like any other
    assert.equal(byKey(r, "rf1").usage!.input_uncached, 5000n);
    assert.equal(r.streams.find((s) => s.chain.thread === "th-p5")!.fork, null);
    // compactions: the parent's own, the copy in the fork prefix (a distinct record, found only in the fork file), the fork's own
    const own = r.compactions.filter((c) => c.chain.thread === "th-f5" && !c.in_copied_prefix);
    assert.equal(own.length, 1);
    assert.equal(own[0]!.latest_usage_is_null, true);
    assert.equal(r.compactions.length, 3);
    const copied = r.compactions.filter((c) => c.in_copied_prefix);
    assert.equal(copied.length, 1);
    assert.equal(copied[0]!.chain.thread, "th-f5");
  });

  it("two first own requests at the same instant are both flagged (the graph reports order_tie)", async () => {
    const f = raw("tie", [
      ln("session_meta", 0, 0, metaP("th-t", { forked_from_id: "th-par", subagent_history_start_ordinal: 1 })),
      ln("turn_context", 1, 1, tcP("T", "model-a")),
      ln("token_usage_record", 2, 2, turP("a", "th-t", "T", usageP(10, 0, 0, 1, 0))),
      ln("token_usage_record", 3, 2, turP("b", "th-t", "T", usageP(10, 0, 0, 1, 0))),
      ln("token_usage_record", 4, 3, turP("c", "th-t", "T", usageP(10, 0, 0, 1, 0))),
    ]);
    const r = await run([f]);
    assert.deepEqual(byKey(r, "a").flags, ["fork_first_own"]);
    assert.deepEqual(byKey(r, "b").flags, ["fork_first_own"]);
    assert.deepEqual(byKey(r, "c").flags, []);
  });
});

// ---------------------------------------------------------------------------
// 6. links, kinds, versions, thread totals
// ---------------------------------------------------------------------------

describe("linkage (R5.2, R5.6)", () => {
  const linkOf = (r: CodexParseResult, thread: string) => r.links.find((l) => l.chain.thread === thread)!;

  it("fixture codex-fork: verified fork subagent and an orphan with a missing parent", async () => {
    const r = await run(scenarios.find((s) => s.name === "codex-fork")!.build());
    const sub = linkOf(r, "synthetic-thread-sub");
    assert.equal(sub.state, "verified");
    assert.equal(sub.reason, null);
    assert.equal(sub.parent!.thread, "synthetic-thread-parent");
    assert.equal(sub.depth, 1);
    assert.equal(sub.is_fork, true);
    const orphan = linkOf(r, "synthetic-thread-orphan");
    assert.equal(orphan.state, "unlinked");
    assert.equal(orphan.reason, "parent_file_missing");
    assert.equal(r.links.length, 2); // main chains have no Link
    assert.equal(r.coverage.links_verified, 1);
    assert.equal(r.coverage.links_unlinked, 1);
    assert.equal(r.coverage.links_unlinked_by_reason.parent_file_missing, 1);
    assert.equal(r.coverage.links_directory_only, 0);
    assert.equal(byKey(r, "synthetic-resp-s1").kind, "subagent");
    assert.equal(byKey(r, "synthetic-resp-p1").kind, "main");
  });

  it("each failure reason of R5.6", async () => {
    const parent = raw("lp", [ln("session_meta", 0, 0, metaP("th-par", { session_id: "sess-1" }))]);
    const spawn = (parentId: string | null, extra: object = {}): object =>
      metaP("x", {
        session_id: "sess-1", thread_source: "subagent",
        source: { subagent: { thread_spawn: { ...(parentId === null ? {} : { parent_thread_id: parentId }), depth: 2 } } },
        ...extra,
      });
    const mk = async (id: string, payload: object): Promise<CodexParseResult["links"][number]> => {
      const p = { ...(payload as Record<string, unknown>), id };
      const r = await run([parent, raw(`l-${id}`, [ln("session_meta", 0, 1, p)])]);
      return linkOf(r, id);
    };
    const ok = await mk("c-ok", spawn("th-par"));
    assert.equal(ok.state, "verified");
    assert.equal(ok.depth, 2);
    assert.equal((await mk("c-np", spawn(null))).reason, "no_parent_id");
    assert.equal((await mk("c-fm", spawn("th-par", { forked_from_id: "th-else" }))).reason, "fork_parent_mismatch");
    assert.equal((await mk("c-pm", spawn("th-gone"))).reason, "parent_file_missing");
    assert.equal((await mk("c-rm", spawn("th-par", { session_id: "sess-2" }))).reason, "root_mismatch");
    const nosp = await mk("c-ns", metaP("x", { thread_source: "agent_created_thread" }));
    assert.equal(nosp.reason, "no_parent_id");
    const other = await mk("c-ot", metaP("x", { thread_source: "subagent", source: { subagent: { other: "review" } } }));
    assert.equal(other.reason, "other_source");
    const forkOk = await mk("c-fk", spawn("th-par", { forked_from_id: "th-par", subagent_history_start_ordinal: 0 }));
    assert.equal(forkOk.state, "verified");
    assert.equal(forkOk.is_fork, true);
  });

  it("a copied parent meta inside the child's file does not make the parent exist", async () => {
    const child = raw("only-child", [
      ln("session_meta", 0, 0, metaP("th-par")),
      ln("session_meta", 1, 1, metaP("c1", {
        session_id: "th-par", thread_source: "subagent", forked_from_id: "th-par", subagent_history_start_ordinal: 1,
        source: { subagent: { thread_spawn: { parent_thread_id: "th-par", depth: 1 } } },
      })),
    ]);
    const r = await run([child]);
    assert.equal(r.streams.length, 1);
    assert.equal(r.links[0]!.reason, "parent_file_missing");
  });

  it("request kinds by thread_source (R5.2)", async () => {
    const mk = (id: string, ts: string | null, extra: object = {}): GeneratedFile =>
      raw(`k-${id}`, [
        ln("session_meta", 0, 0, metaP(id, { ...(ts === null ? { thread_source: undefined } : { thread_source: ts }), ...extra })),
        ln("token_usage_record", 1, 1, turP(`r-${id}`, id, "T", usageP(10, 0, 0, 1, 0))),
      ]);
    const r = await run([mk("a", "user"), mk("b", null), mk("c", "automation"), mk("d", "guardian_review"), mk("e", "subagent"), mk("f", "agent_created_thread")]);
    const kinds = Object.fromEntries(r.responses.map((x) => [x.thread_id, x.kind]));
    assert.deepEqual(kinds, { a: "main", b: "main", c: "helper", d: "classifier", e: "subagent", f: "subagent" });
  });
});

describe("versions (R15.7)", () => {
  it("a coverage-only version is counted, never accounted, and acts as an excluded request inside a supported thread", async () => {
    const sup = raw("v-sup", [
      ln("session_meta", 0, 0, metaP("th-v")),
      ln("turn_context", 1, 1, tcP("T", "model-a")),
      ln("token_usage_record", 2, 2, turP("r1", "th-v", "T", usageP(10, 0, 0, 1, 0))),
      ln("token_usage_record", 4, 4, turP("r3", "th-v", "T", usageP(10, 0, 0, 1, 0))),
    ]);
    const old = raw("v-old", [
      ln("session_meta", 0, 3, metaP("th-v", { cli_version: "0.1.0" })),
      ln("token_usage_record", 1, 3, turP("r2", "th-v", "T", usageP(900, 0, 0, 9, 0))),
      ln("token_usage_record", 2, 3, turP("r2b", "th-w", "T", usageP(900, 0, 0, 9, 0))),
    ]);
    const odd = raw("v-odd", [ln("session_meta", 0, 0, metaP("th-o", { cli_version: "not a version" })), ln("response_item", 1, 1)]);
    const r = await run([sup, old, odd]);
    assert.deepEqual(r.responses.map((x) => x.key).sort(), ["r1", "r3"]);
    assert.equal(r.coverage.requests_unverified_version, 2);
    assert.equal(r.coverage.lines_unverified_version, 5);
    assert.equal(r.coverage.versions["0.158.0"], 4);
    assert.equal(r.coverage.versions["0.1.0"], 3);
    assert.equal(r.coverage.versions["unlisted"], 2);
    assert.ok(r.assumptions.includes("unverified_version"));
    // r2 lies between r1 and r3 in the supported stream th-v: an excluded request (R6.2)
    assert.deepEqual(r.excluded.map((e) => [e.reason, e.chain.thread, e.event_ms]), [["unverified_version", "th-v", T0 + 3000]]);
    assert.equal(r.coverage.records_usage_bearing, 2);
    assert.equal(r.files.filter((f) => f.support === "coverage_only").length, 2);
    assert.equal(r.coverage.files_unassigned_stream, 0); // coverage-only files are not an identity problem
  });

  it("a thread whose own session_meta is missing from the scan is unversioned: coverage only", async () => {
    const half = raw("v-half", [ln("token_usage_record", 0, 1, turP("r1", "th-h", "T", usageP(10, 0, 0, 1, 0)))]);
    const r = await run([half]);
    assert.equal(r.responses.length, 0);
    assert.equal(r.streams.length, 0);
    assert.equal(r.coverage.requests_unverified_version, 1);
    assert.equal(r.coverage.files_assigned_by_stream, 1);
  });

  it("--fast skips files older than since minus 7 days and prints mtime_prefilter_on", async () => {
    const root = writeTree([
      raw("old", [ln("session_meta", 0, 0, metaP("th-old")), ln("token_usage_record", 1, 1, turP("ro", "th-old", "T", usageP(10, 0, 0, 1, 0)))]),
      raw("new", [ln("session_meta", 0, 0, metaP("th-new")), ln("token_usage_record", 1, 1, turP("rn", "th-new", "T", usageP(10, 0, 0, 1, 0)))]),
    ]);
    const d = await discover({ codexDirs: [root], home: join(root, "no-home"), env: {} });
    const since = Date.UTC(2026, 5, 1);
    for (const f of d.files) {
      const m = f.path.includes("-old") ? since - 8 * 86_400_000 : since - 6 * 86_400_000;
      utimesSync(f.path, m / 1000, m / 1000);
    }
    const d2 = await discover({ codexDirs: [root], home: join(root, "no-home"), env: {} });
    const win = { since_ms: since, until_ms: since + 86_400_000 };
    const fast = await parseCodex(d2.files, { window: win, fastPrefilter: true, now_ms: since });
    assert.deepEqual(fast.responses.map((x) => x.key), ["rn"]);
    assert.ok(fast.assumptions.includes("mtime_prefilter_on"));
    const full = await parseCodex(d2.files, { window: win });
    assert.deepEqual(full.responses.map((x) => x.key).sort(), ["rn", "ro"]);
    assert.ok(!full.assumptions.includes("mtime_prefilter_on"));
  });
});

describe("parse failures (R1.3, R1.4)", () => {
  it("counts parse errors, a truncated tail, unlisted types, BOM and CRLF; never throws", async () => {
    const f: GeneratedFile = {
      path: "sessions/2026/01/01/rollout-2026-01-01T00-00-00-bad.jsonl",
      content:
        "﻿" +
        [
          JSON.stringify(ln("session_meta", 0, 0, metaP("th-b"))),
          "{not json",
          JSON.stringify(ln("brand_new_type", 1, 1, { secret: "x" })),
          "[1,2]",
          JSON.stringify(ln("token_usage_record", 2, 2, turP("r1", "th-b", "T", usageP(10, 0, 0, 1, 0)))),
        ].join("\r\n") +
        '\r\n{"type":"response_item","payload":{"content":"cut',
    };
    const r = await run([f]);
    assert.equal(r.coverage.lines_total, 6);
    assert.equal(r.coverage.lines_parse_error, 1);
    assert.equal(r.coverage.lines_truncated_tail, 1);
    assert.equal(r.coverage.known_type_count, 2);
    assert.equal(r.coverage.unlisted_type_count, 2);
    assert.equal(byKey(r, "r1").exclusion, null);
  });

  it("a final line without newline that parses is a normal record", async () => {
    const f: GeneratedFile = {
      path: "sessions/2026/01/01/rollout-2026-01-01T00-00-00-nonl.jsonl",
      content: JSON.stringify(ln("session_meta", 0, 0, metaP("th-z"))) + "\n" + JSON.stringify(ln("token_usage_record", 1, 1, turP("r1", "th-z", "T", usageP(10, 0, 0, 1, 0)))),
    };
    const r = await run([f]);
    assert.equal(r.coverage.lines_truncated_tail, 0);
    assert.equal(r.responses.length, 1);
  });

  it("an unreadable file is counted and ignored; an empty input is an empty result", async () => {
    const r = await parseCodex([
      {
        kind: "codex-rollout", agent: "codex", path: join(tmpdir(), "cachewhy-does-not-exist", "rollout-x.jsonl"), relPath: "rollout-x.jsonl",
        root: tmpdir(), size: 0, mtimeMs: 0,
      },
      { kind: "claude-main", agent: "claude", path: "ignored", relPath: "ignored", root: "x", size: 0, mtimeMs: 0 },
    ]);
    assert.equal(r.coverage.files_total, 1);
    assert.equal(r.coverage.files_unreadable, 1);
    assert.equal(r.files[0]!.readable, false);
    assert.equal(r.responses.length, 0);
    const empty = await parseCodex([]);
    assert.equal(empty.coverage.files_total, 0);
  });
});

describe("thread totals (R13.6)", () => {
  it("complete chain, broken chain and a thread that starts in a continuation file", async () => {
    const t = thread({ threadId: "th-tt" });
    t.turnContext({ turnId: "T" });
    t.tokenUsage({ responseId: "r1", usage: { input: 100, output: 10 } });
    t.tokenUsage({ responseId: "r2", usage: { input: 200, output: 20 } });
    const ok = await run(filesOf(t));
    assert.equal(ok.thread_totals[0]!.chain_complete, true);
    assert.equal(ok.thread_totals[0]!.summed_total_tokens, 330n);
    assert.equal(ok.thread_totals[0]!.last_thread_total, 330n);
    assert.equal(ok.thread_totals[0]!.starts_in_continuation, false);
    const files = filesOf(t);
    const dropped = withLines(files[0]!, linesOf(files[0]!).filter((l) => !l.includes('"r1"') && !l.includes("response_id\":\"r1\"")));
    const cont = await run([dropped]);
    assert.equal(cont.thread_totals[0]!.starts_in_continuation, true);
    assert.equal(cont.thread_totals[0]!.chain_complete, false);
    assert.equal(cont.thread_totals[0]!.summed_total_tokens, 220n);
    assert.equal(cont.thread_totals[0]!.last_thread_total, 330n);
  });
});

// ---------------------------------------------------------------------------
// 7. metamorphic suite (R4.10, R17.6, R17.7)
// ---------------------------------------------------------------------------

/** A rich scenario: models, a marker, a compaction, an unkeyed record, a conflict pair, a fork, a linked subagent. */
function richFiles(): GeneratedFile[] {
  const parent = thread({ threadId: "th-rich" });
  parent.turnContext({ turnId: "T1", model: "model-a" });
  parent.responseItem("message", "user");
  parent.tokenUsage({ responseId: "rr1", turnId: "T1", usage: { input: 5000, cached: 0, cacheWrite: 1000, output: 100, reasoning: 30 }, emitTokenCountEvent: true });
  parent.tokenUsage({ responseId: "rr2", turnId: "T1", usage: { input: 5600, cached: 5000, output: 80 } });
  parent.compacted({ windowNumber: 1 });
  parent.turnContext({ turnId: "T2", model: "model-b" });
  parent.tokenUsage({ responseId: "rr3", turnId: "T2", usage: { input: 1200, cached: 0, output: 10 } });
  parent.eventMsg("thread_settings_applied");
  parent.tokenUsage({ responseId: "rr4", turnId: "T3", usage: { input: 1300, cached: 1200, output: 11 } });
  const fork = CodexThread.fork(parent, { threadId: "th-rich-fork", threadSource: "user", prefixLen: 3 });
  fork.turnContext({ turnId: "TF", model: "model-b" });
  fork.tokenUsage({ responseId: "rf1", turnId: "TF", usage: { input: 1500, cached: 1200, output: 20 } });
  fork.tokenUsage({ responseId: "rf2", turnId: "TF2", usage: { input: 1600, cached: 1500, output: 21 } });
  const sub = CodexThread.fork(parent, {
    threadId: "th-rich-sub", threadSource: "subagent", threadSpawn: { parentThreadId: "th-rich", depth: 1 }, prefixLen: 2,
  });
  sub.turnContext({ turnId: "TS", model: "model-a" });
  sub.tokenUsage({ responseId: "rs1", turnId: "TS", usage: { input: 700, output: 7 } });
  const home = new CodexHome();
  home.add(parent, { splitAfter: [5] });
  home.add(fork);
  home.add(sub);
  return home.files();
}

const SCENARIOS: Array<[string, () => GeneratedFile[]]> = [
  ["codex-basic", () => plain(scenarios.find((s) => s.name === "codex-basic")!.build())],
  ["codex-fork", () => scenarios.find((s) => s.name === "codex-fork")!.build()],
  ["rich", richFiles],
];

describe("metamorphic: shuffle, reorder, re-serialize, duplicate (R4.10, R17.6)", () => {
  for (const [name, build] of SCENARIOS) {
    it(`${name}: line shuffle, file order and key order do not change any output`, async () => {
      const files = build();
      const base = await run(files);
      const baseSem = semantic(base);
      const basePhys = JSON.stringify(physicalCoverage(base.coverage), bigintReplacer);
      assert.ok(base.responses.length > 0);
      for (const seed of [1, 2, 3, 4, 5]) {
        const shuf = files.map((f) => withLines(f, shuffled(linesOf(f), seed * 31 + f.path.length)));
        const r = await run(shuf);
        same(semantic(r), baseSem, `line shuffle seed ${seed}`);
        assert.equal(JSON.stringify(physicalCoverage(r.coverage), bigintReplacer), basePhys, `physical counters under shuffle ${seed}`);
      }
      for (const order of ["desc", "odd-even"] as const) {
        const r = await runWithOrder(files, order);
        same(semantic(r), baseSem, `file order ${order}`);
        assert.equal(JSON.stringify(r.files), JSON.stringify(base.files), `file indices ${order}`);
      }
      const rekey = files.map((f) => withLines(f, linesOf(f).map((l) => JSON.stringify(reverseKeys(JSON.parse(l))))));
      const rk = await run(rekey);
      same(semantic(rk), baseSem, "key order");
      assert.equal(JSON.stringify(physicalCoverage(rk.coverage), bigintReplacer), basePhys);
    });

    it(`${name}: duplicating a line adds k to the physical line counters and changes no logical counter`, async () => {
      const files = build();
      const base = await run(files);
      const baseSem = semantic(base);
      for (const [fi, f] of files.entries()) {
        const ls = linesOf(f);
        for (const idx of [0, Math.floor(ls.length / 2), ls.length - 2].filter((i) => i >= 0 && i < ls.length - 1)) {
          for (const k of [1, 3]) {
            const dup = ls.slice(0, idx + 1).concat(Array(k).fill(ls[idx]!), ls.slice(idx + 1));
            const r = await run(files.map((g, gi) => (gi === fi ? withLines(g, dup) : g)));
            same(semantic(r), baseSem, `dup file ${fi} line ${idx} k=${k}`);
            const c = r.coverage;
            const b = base.coverage;
            assert.equal(c.lines_total, b.lines_total + k);
            assert.equal(c.known_type_count, b.known_type_count + k);
            assert.equal(c.lines_duplicate_collapsed, b.lines_duplicate_collapsed + k);
            assert.ok(c.duplicate_records_collapsed === b.duplicate_records_collapsed || c.duplicate_records_collapsed === b.duplicate_records_collapsed + 1);
            assert.equal(c.lines_parse_error, b.lines_parse_error);
            assert.equal(c.files_total, b.files_total);
          }
        }
      }
    });
  }

  it("a duplicated unparseable line is counted again by design (R17.6)", async () => {
    const f = raw("bad2", [ln("session_meta", 0, 0, metaP("th-q")), "{oops", "{oops", ln("token_usage_record", 1, 1, turP("r1", "th-q", "T", usageP(10, 0, 0, 1, 0)))]);
    const r = await run([f]);
    assert.equal(r.coverage.lines_parse_error, 2);
    assert.equal(r.coverage.lines_duplicate_collapsed, 0);
  });
});

describe("metamorphic: splitting at every line boundary (R4.10, R4.13, R17.7)", () => {
  for (const [name, build] of SCENARIOS) {
    it(`${name}: every split position obeys the split contract`, async () => {
      const files = plain(build());
      const base = await run(files);
      const baseSem = semantic(base);
      const tokensOf = (r: CodexParseResult): string =>
        JSON.stringify(r.responses.map((x) => [x.key, x.exclusion, x.usage]).sort((p, q) => String(p[0]).localeCompare(String(q[0]))), bigintReplacer);
      const baseTokens = tokensOf(base);
      const verifiedOf = (r: CodexParseResult): Map<string, string> => new Map(r.responses.filter((x) => x.model.verified).map((x) => [x.key, x.model.model!]));
      const baseVerified = verifiedOf(base);
      let positions = 0;
      let unaffected = 0;
      let withdrawn = 0;
      for (const [fi, f] of files.entries()) {
        const ls = linesOf(f);
        for (let at = 1; at < ls.length; at++) {
          if (!carriesIdentity(ls.slice(0, at)) || !carriesIdentity(ls.slice(at))) continue;
          positions++;
          const [a, b] = splitFile(f, at);
          const r = await run(files.filter((_, i) => i !== fi).concat([a, b]));
          const label = `${name} file ${fi} at ${at}`;
          // token totals are identical for every split (accounting is keyed by record identity)
          assert.equal(tokensOf(r), baseTokens, `${label}: tokens`);
          assert.equal(r.coverage.lines_total, base.coverage.lines_total, `${label}: lines_total`);
          assert.equal(r.coverage.known_type_count, base.coverage.known_type_count);
          assert.equal(r.coverage.files_total, base.coverage.files_total + 1);
          assert.equal(r.coverage.responses_total, base.coverage.responses_total);
          assert.equal(r.coverage.requests_total, base.coverage.requests_total);
          const resolved = r.coverage.files_stream_conflict === 0 && r.coverage.files_copy_exposed === 0 && r.coverage.files_unassigned_stream === 0;
          if (resolved) {
            // every half resolves to one identity and none is copy exposed: nothing changes
            unaffected++;
            same(semantic(r), baseSem, `${label}: resolved split must be identical`);
            assert.equal(r.coverage.files_assigned_by_stream, base.coverage.files_assigned_by_stream + 1);
          } else {
            withdrawn++;
            // monotone: verified models, verified links and integrity only move towards withdrawal, values on the common part are equal
            for (const [k, m] of verifiedOf(r)) assert.equal(baseVerified.get(k), m, `${label}: verified model of ${k} added or changed`);
            assert.ok(r.coverage.responses_model_unverified >= base.coverage.responses_model_unverified, `${label}: unverified models`);
            assert.ok(r.coverage.streams_integrity_unverified >= base.coverage.streams_integrity_unverified, `${label}: integrity`);
            assert.ok(r.coverage.links_verified <= base.coverage.links_verified, `${label}: links`);
            assert.equal(r.coverage.links_verified + r.coverage.links_unlinked, base.coverage.links_verified + base.coverage.links_unlinked);
            const baseIntegrity = new Map(base.streams.map((s) => [s.chain.thread, s.integrity_unverified]));
            for (const s of r.streams) if (baseIntegrity.get(s.chain.thread)) assert.equal(s.integrity_unverified, true, `${label}: integrity of ${s.chain.thread}`);
            assert.equal(r.coverage.streams_total, base.coverage.streams_total);
            assert.equal(r.coverage.records_unkeyed, base.coverage.records_unkeyed);
            assert.equal(r.coverage.requests_conflict, base.coverage.requests_conflict);
          }
        }
      }
      assert.ok(positions > 5, `${name}: enough split positions (${positions})`);
      assert.ok(unaffected > 0, `${name}: some resolved splits (${unaffected})`);
      if (name !== "codex-basic") assert.ok(withdrawn > 0, `${name}: some withdrawing splits (${withdrawn})`);
    });
  }

  it("the multi-file thread of codex-basic: any cut keeps one identity per half and changes nothing", async () => {
    const files = plain(scenarios.find((s) => s.name === "codex-basic")!.build());
    const base = await run(files);
    // the thread is already split in two files in the fixture: merging gives the same semantic output
    const mainFiles = files.filter((f) => f.path.includes("synthetic-thread-main"));
    assert.equal(mainFiles.length, 2);
    const merged: GeneratedFile = { path: "sessions/2026/01/01/rollout-2026-01-01T00-00-00-synthetic-thread-main.jsonl", content: mainFiles.flatMap(linesOf).join("\n") + "\n" };
    const r = await run(files.filter((f) => !mainFiles.includes(f)).concat([merged]));
    assert.equal(semantic(r), semantic(base));
    assert.equal(r.coverage.files_total, base.coverage.files_total - 1);
  });
});

// ---------------------------------------------------------------------------
// 8. privacy canary (R1.1, R14.7)
// ---------------------------------------------------------------------------

describe("privacy", () => {
  it("no canary planted in dropped fields, file names, odd versions or models survives into the result", async () => {
    const canary = ["CANARY", "0123456789abcdef"].join("_"); // built at run time: the repo scanner rejects a literal canary
    const home = new CodexHome({ canary });
    const t = thread({ threadId: "th-canary" });
    t.turnContext({ turnId: "T1", model: "model-a" });
    t.responseItem("message", "user");
    t.tokenUsage({ responseId: "rc1", turnId: "T1", usage: { input: 100, output: 5 }, emitTokenCountEvent: true });
    t.compacted();
    home.add(t, { splitAfter: [3] });
    const files = home.files();
    assert.ok(files.some((f) => f.path.includes(canary)), "canary reaches file names");
    assert.ok(files.some((f) => text(f).includes(canary)), "canary reaches record content");
    const r = await run(files);
    assert.equal(byKey(r, "rc1").usage!.input_uncached, 100n);
    assert.ok(r.coverage.unlisted_type_count >= 1);
    assert.ok(r.coverage.lines_truncated_tail >= 1);
    const dump = JSON.stringify(r, bigintReplacer);
    for (const needle of [canary, canary.toLowerCase(), canary.slice(0, 8), canary.slice(7, 15), Buffer.from(canary).toString("base64")]) {
      assert.ok(!dump.includes(needle), `no ${needle} in output`);
    }
    // the odd version of the unlisted record is not a version of any stream
    assert.deepEqual(Object.keys(r.coverage.versions).sort(), ["0.158.0"]);
  });

  it("the result carries no path or file name", async () => {
    const r = await run(filesOf(thread({ threadId: "th-pp1" })));
    const dump = JSON.stringify(r, bigintReplacer);
    assert.ok(!dump.includes("rollout-"));
    assert.ok(!dump.includes("cachewhy-codex-"));
    assert.ok(!dump.includes("sessions"));
  });
});

// keep the CodexLine type referenced for the fixtures API used above
export type { CodexLine };
