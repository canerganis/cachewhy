// Tests for src/sources/codex.ts. Spec: docs/methodology.md (spec-1, revision 11). All data is synthetic.
//
// Layout:
//   1. helpers (tree writer, raw line builders, taint closure over the integrity facts, semantic projection, operators)
//   2. accounting (R2.6 to R2.9, R2.12, R2.15, R2.16, R2.13)
//   3. model attribution (R2.10, R2.17)
//   4. dedup conflicts (R4.4)
//   5. streams, identity, copy exposure, forks (R4.9, R4.11, R4.12, R4.13) and the integrity facts of R0.9
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
import { PHYSICAL_COVERAGE_COUNTERS, TAINT_REASONS, type CodexParseResult, type CodexResponse, type CoverageCounters, type TaintReason } from "../../src/model/types.js";
import { scenarios } from "../../scripts/gen-fixtures.ts";
import { CodexHome, CodexThread, zstdCompress, type CodexLine, type GeneratedFile } from "../fixtures/builder.ts";

// ---------------------------------------------------------------------------
// 1. helpers
// ---------------------------------------------------------------------------

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Every file gets this modification time unless the fixture sets one, so two trees of the same content compare equal. */
const PIN_MTIME_MS = Date.UTC(2026, 0, 2);

function writeTree(files: readonly GeneratedFile[]): string {
  const root = mkdtempSync(join(tmpdir(), "cachewhy-codex-"));
  roots.push(root);
  for (const f of files) {
    if (f.unavailable) continue;
    const abs = join(root, ...f.path.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
    const m = (f.mtimeMs ?? PIN_MTIME_MS) / 1000;
    utimesSync(abs, m, m);
  }
  return root;
}

interface Run {
  r: CodexParseResult;
  /** File index (the canonical order of the parser: sorted by absolute path) of a generated file. */
  indexOf: (generatedPath: string) => number;
}

async function runX(files: readonly GeneratedFile[]): Promise<Run> {
  const root = writeTree(files);
  const d = await discover({ codexDirs: [root], home: join(root, "no-home"), env: {} });
  const r = await parseCodex(d.files);
  const abs = files.filter((f) => !f.unavailable).map((f) => join(root, ...f.path.split("/")));
  const sorted = d.files.map((f) => f.path).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { r, indexOf: (gp) => sorted.indexOf(abs[files.filter((f) => !f.unavailable).findIndex((f) => f.path === gp)] as string) };
}

async function run(files: readonly GeneratedFile[]): Promise<CodexParseResult> {
  return (await runX(files)).r;
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
      integrity: { chains: r.integrity.chains, family_groups: r.integrity.family_groups, triggers: r.integrity.triggers },
      coverage: logicalCoverage(r.coverage),
    },
    bigintReplacer,
  );
}

// ---- R0.9 closure (test side) ---------------------------------------------------------------------------------------
// The graph owns the real taint computation. The tests of the parser only need the family closure over its facts, so a
// small union-find over IntegrityFacts is enough. Liveness is not modelled: every fixture here has a pinned mtime.

const thr = (id: string): string => id.slice("codex\u0000".length);

function familyMap(r: CodexParseResult): Map<string, string> {
  const parent = new Map<string, string>(r.integrity.chains.map((c) => [c, c]));
  const find = (x: string): string => {
    let y = x;
    while (parent.get(y) !== y) y = parent.get(y) as string;
    parent.set(x, y);
    return y;
  };
  for (const g of r.integrity.family_groups) {
    for (const c of g) assert.ok(parent.has(c), "a family group names only chains of the scan");
    for (let i = 1; i < g.length; i++) {
      const a = find(g[0] as string);
      const b = find(g[i] as string);
      if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
    }
  }
  return new Map([...parent.keys()].map((c) => [c, find(c)]));
}

/** Thread id to the set of reasons that taint it (family closure, provider-wide reasons). Untainted threads are absent. */
function taintOf(r: CodexParseResult): Map<string, Set<TaintReason>> {
  const fam = familyMap(r);
  const byFamily = new Map<string, Set<TaintReason>>();
  const providerWide = new Set<TaintReason>();
  const addFam = (c: string, reason: TaintReason): void => {
    const f = fam.get(c);
    if (f === undefined) return;
    let set = byFamily.get(f);
    if (set === undefined) byFamily.set(f, (set = new Set()));
    set.add(reason);
  };
  for (const t of r.integrity.triggers) {
    if (t.names === "provider") providerWide.add(t.reason);
    else for (const c of t.names) addFam(c, t.reason);
  }
  for (const f of r.integrity.files) {
    if (f.unparsed_lines === 0) continue;
    if (f.named_chains.length === 0) providerWide.add("unparsed_line");
    else for (const c of f.named_chains) addFam(c, "unparsed_line");
  }
  const out = new Map<string, Set<TaintReason>>();
  for (const c of r.integrity.chains) {
    const reasons = new Set<TaintReason>([...providerWide, ...(byFamily.get(fam.get(c) as string) ?? [])]);
    if (reasons.size > 0) out.set(thr(c), reasons);
  }
  return out;
}
const taintedSet = (r: CodexParseResult): string[] => [...taintOf(r).keys()].sort();
const reasonList = (r: CodexParseResult, thread: string): TaintReason[] =>
  TAINT_REASONS.filter((x) => taintOf(r).get(thread)?.has(x) === true);
/** The triggers of one reason, as sorted thread ids ("provider" for a trigger that names none). */
const namesOf = (r: CodexParseResult, reason: TaintReason): string[] =>
  r.integrity.triggers.filter((t) => t.reason === reason).flatMap((t) => (t.names === "provider" ? ["provider"] : t.names.map(thr))).sort();
const tokensOf = (r: CodexParseResult): string =>
  JSON.stringify(r.responses.map((x) => [x.key, x.exclusion, x.usage]).sort((p, q) => String(p[0]).localeCompare(String(q[0]))), bigintReplacer);
/** The verified models an output may use: verified by the parser and not tainted (the graph overrides the rest). */
function effectiveVerified(r: CodexParseResult): Map<string, string> {
  const t = taintOf(r);
  return new Map(r.responses.filter((x) => x.model.verified && !t.has(x.thread_id)).map((x) => [x.key, x.model.model as string]));
}

/** R4.10 op 5: a split file. Both halves keep the mtime (the tree writer pins every mtime). */
interface SplitCase {
  file: GeneratedFile;
  at: number;
  files: GeneratedFile[];
  halves: [GeneratedFile, GeneratedFile];
}
function splitCases(files: readonly GeneratedFile[]): SplitCase[] {
  const out: SplitCase[] = [];
  for (const f of files) {
    const ls = linesOf(f);
    for (let at = 1; at < ls.length; at++) {
      if (!carriesIdentity(ls.slice(0, at)) || !carriesIdentity(ls.slice(at))) continue;
      const halves = splitFile(f, at);
      out.push({ file: f, at, files: files.filter((g) => g !== f).concat(halves), halves });
    }
  }
  return out;
}

/** R4.10: a split is dissolving iff the file was a stream conflict and every half has a smaller identity set, or the file names chains of two or more families and no half names chains of all of them. */
async function dissolving(base: Run, c: SplitCase, split: Run): Promise<boolean> {
  const bi = base.indexOf(c.file.path);
  const hi = c.halves.map((h) => split.indexOf(h.path));
  const fam = familyMap(base.r);
  const named = base.r.integrity.files[bi]!.named_chains;
  const famsOfFile = new Set(named.map((x) => fam.get(x)));
  const halfFams = hi.map((i) => new Set(split.r.integrity.files[i]!.named_chains.map((x) => fam.get(x) ?? x)));
  const second = famsOfFile.size >= 2 && !halfFams.some((h) => [...famsOfFile].every((f) => h.has(f as string)));
  const first = base.r.files[bi]!.stream_assignment === "conflict" && hi.every((i) => split.r.files[i]!.stream_assignment !== "conflict");
  return first || second;
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
/** R4.10 op 5: a half keeps at least one record that names a chain (a session_meta with a string id, or a usage record with a string thread_id). */
const carriesIdentity = (ls: readonly string[]): boolean =>
  ls.some((l) => {
    try {
      const o = JSON.parse(l) as { type?: unknown; payload?: { id?: unknown; thread_id?: unknown } };
      return (o.type === "session_meta" && typeof o.payload?.id === "string") || (o.type === "token_usage_record" && typeof o.payload?.thread_id === "string");
    } catch {
      return false;
    }
  });

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
    // R2.13, R0.9: an unkeyed record with a known chain taints that chain, and only that family
    assert.deepEqual(namesOf(r, "request_anomaly"), ["th-u"]);
    assert.deepEqual(taintedSet(r), ["th-u"]);
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
    // R2.9, R0.9 unlogged_usage: the chains named by the file
    assert.deepEqual(namesOf(r, "unlogged_usage"), ["th-n"]);
    assert.deepEqual(reasonList(r, "th-n"), ["unlogged_usage"]);
  });

  it("token_count events are counted as lines: a duplicated event adds one to the physical counter (R2.9, R17.6)", async () => {
    const ev = ln("event_msg", 1, 1, { type: "token_count" });
    const r = await run([raw("nocount-dup", [ln("session_meta", 0, 0, metaP("th-nd")), ev, ev, ln("event_msg", 2, 2, { type: "token_count" })])]);
    assert.equal(r.coverage.files_without_response_id, 1);
    assert.equal(r.coverage.token_count_events_without_response_id, 3);
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
    assert.deepEqual(namesOf(r, "request_anomaly"), ["th-i"]); // R2.12, R0.9
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
    assert.deepEqual(namesOf(r, "request_anomaly"), ["th-r", "th-r2"]); // R2.15, R0.9
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
    assert.deepEqual(namesOf(r, "request_anomaly"), ["th-v"]); // R2.7, R0.9
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
    assert.deepEqual(reasonList(r, "th-bt"), ["ordinal_unverified", "request_anomaly"]); // R4.12, R2.12
  });

  it("two own session_metas of one id with different session_ids: stream_unresolved naming that id (R4.11, R0.9)", async () => {
    const f = raw("sess", [
      ln("session_meta", 0, 0, metaP("th-s", { session_id: "sess-1" })),
      ln("session_meta", 1, 1, metaP("th-s", { session_id: "sess-2" })),
      ln("token_usage_record", 2, 2, turP("r1", "th-s", "T", usageP(10, 0, 0, 1, 0))),
    ]);
    const r = await run([f]);
    assert.deepEqual(namesOf(r, "stream_unresolved"), ["th-s"]);
    assert.deepEqual(taintedSet(r), ["th-s"]);
    // R5.1: the display root is the smallest session id, the identity is the thread only
    assert.equal(r.streams[0]!.chain.root_session, "sess-1");
    assert.deepEqual(r.integrity.chains, ["codex\u0000th-s"]);
    assert.equal(byKey(r, "r1").usage!.input_uncached, 10n); // accounting does not depend on the verdict
  });

  it("a session_meta without a string id, and a usage record without a thread_id, are unattributed: a provider trigger (R2.13, R0.9)", async () => {
    const f = raw("unattr", [
      ln("session_meta", 0, 0, metaP("th-ok")),
      ln("session_meta", 1, 1, { ...(metaP("x") as Record<string, unknown>), id: 7 }),
      ln("token_usage_record", 2, 2, turP("r-ok", "th-ok", "T", usageP(10, 0, 0, 1, 0))),
      ln("token_usage_record", 3, 3, { response_id: "r-nothread", session_id: "s", turn_id: "T", usage: usageP(900, 0, 0, 9, 0) }),
    ]);
    const r = await run([f]);
    assert.deepEqual(namesOf(r, "unattributed_record"), ["provider"]);
    assert.deepEqual(taintedSet(r), ["th-ok"]); // the provider reason taints every chain of the scan
    assert.deepEqual(reasonList(r, "th-ok"), ["unattributed_record"]);
    assert.equal(byKey(r, "r-ok").usage!.input_uncached, 10n); // tokens of the attributed record are kept
    assert.equal(r.responses.length, 1); // the record without a thread is unkeyed for accounting
    assert.equal(r.coverage.records_unkeyed, 1);
    assert.equal(r.coverage.records_usage_bearing, 2);
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
    // R4.12: the stream fails the check, so its chain is tainted and the graph replaces the row with chain_tainted
    assert.deepEqual(namesOf(unmarked, "ordinal_unverified"), ["th-d"]);
    assert.deepEqual(taintedSet(unmarked), ["th-d"]);
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
    assert.deepEqual(namesOf(collide, "ordinal_unverified"), ["th-j"]);
    assert.deepEqual(namesOf(dup, "ordinal_unverified"), []); // a byte-identical duplicate is not a collision
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
    // R4.9: a fork whose prefix cannot be cut is fork_prefix_unresolved and its family is tainted
    assert.deepEqual(namesOf(r2, "fork_prefix_unresolved"), ["th-f2"]);
    assert.deepEqual(taintedSet(r2), ["th-f2", "th-p"]);
    assert.deepEqual(namesOf(r, "fork_prefix_unresolved"), []);
    assert.deepEqual(taintedSet(r), []);
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

  it("a copy-exposed copy of a parent context with a different model taints the family of parent and child (R4.13, R2.17 (d))", async () => {
    const parent = thread({ threadId: "th-p4" });
    parent.turnContext({ turnId: "TP", model: "model-a" });
    parent.tokenUsage({ responseId: "rp1", turnId: "TP" });
    parent.tokenUsage({ responseId: "rp2", turnId: "TP2" });
    const fork = CodexThread.fork(parent, { threadId: "th-f4", threadSource: "user", prefixLen: 1 });
    fork.tokenUsage({ responseId: "rf", turnId: "TF" });
    const base = await run(filesOf(parent, fork));
    assert.deepEqual(attr(base, "rp2"), ["carried_verified", true, "model-a"]);
    assert.deepEqual(taintedSet(base), []);
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
    assert.equal(r.files.filter((f) => f.copy_exposed).length, 1);
    assert.deepEqual(namesOf(r, "copy_exposed"), ["th-p4"]); // the chains named by the exposed half
    // the turn TP now has two models in the scan: R2.17 (d)
    assert.deepEqual(namesOf(r, "turn_model_conflicted"), ["th-p4"]);
    // the family closure reaches the child through forked_from_id (R0.9 link ii)
    assert.deepEqual(taintedSet(r), ["th-f4", "th-p4"]);
    // the copied context shares its envelope ordinal with the parent's own context but differs in the model: an R4.12
    // collision inside the parent's logical stream, so the parent also fails the ordinal check
    assert.deepEqual(reasonList(r, "th-f4"), ["copy_exposed", "turn_model_conflicted", "ordinal_unverified"]);
    // nothing verified is added: the parser sees the foreign context in G(S) and drops the parent's own_turn
    assert.deepEqual(attr(r, "rp1"), ["own_turn_unsettled", false, null]);
    assert.equal(byKey(r, "rp1").model.candidate, null);
    assert.equal(byKey(r, "rp2").model.verified, false);
    assert.equal(effectiveVerified(r).size, 0);
    assert.equal(tokensOf(r), tokensOf(base)); // accounting is keyed by record identity
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
    // R4.4, R0.9: every stream that holds an occurrence is tainted
    assert.deepEqual(namesOf(r, "request_anomaly"), ["th-1", "th-2"]);
    assert.deepEqual(taintedSet(r), ["th-1", "th-2"]);
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
    assert.deepEqual(namesOf(r, "request_anomaly"), ["th-1"]);
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
    assert.deepEqual(namesOf(r, "request_anomaly"), ["th-1"]);
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
    assert.deepEqual(namesOf(r, "request_anomaly"), []);
  });

  it("the same response_id in two threads joins their families (R0.9 link iii)", async () => {
    const u = usageP(100, 0, 0, 10, 0);
    const r = await run(two(ln("token_usage_record", 2, 2, turP("same", "th-1", "T", u)), ln("token_usage_record", 2, 2, turP("same", "th-2", "T", u))));
    assert.deepEqual(r.integrity.family_groups, [["codex\u0000th-1", "codex\u0000th-2"]]);
  });
});

// ---------------------------------------------------------------------------
// 5. streams, identity, copy exposure, forks
// ---------------------------------------------------------------------------

describe("logical streams (R4.11, R4.13)", () => {
  it("R2.10 fixture: a stream-conflict file taints the family of the clean file's thread, at every shuffle and split", async () => {
    const f1 = raw("sc-f1", [
      ln("session_meta", 0, 0, metaP("th-X")),
      ln("turn_context", 1, 1, tcP("T", "model-a")),
      ln("token_usage_record", 2, 2, turP("rX", "th-X", "T", usageP(100, 0, 0, 10, 0))),
    ]);
    const f2 = raw("sc-f2", [
      ln("session_meta", 0, 0, metaP("th-Y", { session_id: "th-X" })),
      ln("token_usage_record", 1, 1, turP("rY", "th-X", "T2", usageP(50, 0, 0, 5, 0))),
      ln("event_msg", 2, 2, { type: "thread_settings_applied" }),
      ln("turn_context", 3, 3, tcP("T", "model-b")),
    ]);
    const r = await run([f1, f2]);
    assert.equal(r.coverage.files_stream_conflict, 1);
    assert.deepEqual(namesOf(r, "stream_unresolved"), ["th-X", "th-Y"]); // the ids of I(F)
    assert.deepEqual(namesOf(r, "turn_model_conflicted"), ["th-X", "th-Y"]); // TM(T) = {model-a, model-b}, R2.17 (d)
    assert.deepEqual(taintedSet(r), ["th-X", "th-Y"]);
    // accounting never depends on the verdict: tokens are kept, rY is accounted by its own thread_id
    assert.equal(byKey(r, "rX").usage!.input_uncached, 100n);
    assert.equal(byKey(r, "rY").usage!.input_uncached, 50n);
    // the contexts of the conflict file belong to no stream: the parser alone would verify rX, the graph overrides it
    assert.equal(effectiveVerified(r).size, 0);
    // shuffled file order: identical facts
    const r2 = await run([f2, f1]);
    assert.equal(semantic(r2), semantic(r));
    // every split of f1 keeps both chains tainted and the tokens identical
    for (let cut = 1; cut < 3; cut++) {
      const [a1, b1] = splitFile(f1, cut);
      const rs = await run([a1, b1, f2]);
      assert.deepEqual(taintedSet(rs), ["th-X", "th-Y"], `split at ${cut}`);
      assert.equal(tokensOf(rs), tokensOf(r));
      assert.equal(effectiveVerified(rs).size, 0, `split at ${cut}`);
    }
  });

  it("a file without any identity record is unassigned and contributes nothing; it taints every Codex chain (R4.11, R0.9)", async () => {
    const f = raw("noid", [ln("response_item", 0, 0, { type: "message" }), ln("event_msg", 1, 1, { type: "task_started" })]);
    const r = await run([f]);
    assert.equal(r.coverage.files_unassigned_stream, 1);
    assert.equal(r.streams.length, 0);
    assert.equal(r.files[0]!.stream_assignment, "unassigned");
    assert.deepEqual(namesOf(r, "unattributed_record"), ["provider"]);
    // an empty file is unassigned too, but it holds no record that could belong to any thread
    const empty = await run([{ path: "sessions/2026/01/01/rollout-2026-01-01T00-00-00-empty.jsonl", content: "" }]);
    assert.equal(empty.coverage.files_unassigned_stream, 1);
    assert.deepEqual(namesOf(empty, "unattributed_record"), []);
    // the provider trigger reaches the clean thread of another file
    const clean = raw("clean", [ln("session_meta", 0, 0, metaP("th-clean")), ln("token_usage_record", 1, 1, turP("rc", "th-clean", "T", usageP(10, 0, 0, 1, 0)))]);
    const both = await run([f, clean]);
    assert.deepEqual(reasonList(both, "th-clean"), ["unattributed_record"]);
    assert.equal(byKey(both, "rc").usage!.input_uncached, 10n);
  });

  it("two identities in one file: conflict, usage still accounted by its own thread_id, both families tainted (R4.11)", async () => {
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
    assert.deepEqual(namesOf(r, "stream_unresolved"), ["th-x", "th-y"]);
    assert.deepEqual(taintedSet(r), ["th-x", "th-y"]);
    // Records other than session_meta and token_usage_record of a conflict file belong to no stream: no context for rx.
    assert.equal(byKey(r, "rx").model.verified, false);
    assert.equal(r.streams.length, 2);
  });

  it("two own session_metas with one id and different forked_from_id: stream_unresolved naming that id (R4.11)", async () => {
    const f = raw("div", [
      ln("session_meta", 0, 0, metaP("th-d", { forked_from_id: "th-other", subagent_history_start_ordinal: 0 })),
      ln("session_meta", 1, 1, metaP("th-d")),
      ln("token_usage_record", 2, 2, turP("r1", "th-d", "T", usageP(10, 0, 0, 1, 0))),
    ]);
    const r = await run([f]);
    assert.deepEqual(namesOf(r, "stream_unresolved"), ["th-d"]);
    assert.deepEqual(taintedSet(r), ["th-d"]);
    // a difference in the history start alone is enough
    const g = raw("div2", [
      ln("session_meta", 0, 0, metaP("th-e", { forked_from_id: "th-par", subagent_history_start_ordinal: 0 })),
      ln("session_meta", 1, 1, metaP("th-e", { forked_from_id: "th-par", subagent_history_start_ordinal: 1 })),
    ]);
    assert.deepEqual(namesOf(await run([g]), "stream_unresolved"), ["th-e"]);
    // two own metas that agree on all three fields are no divergence even when other fields differ
    const h = raw("div3", [ln("session_meta", 0, 0, metaP("th-g")), ln("session_meta", 1, 1, metaP("th-g", { timestamp: iso(9) }))]);
    assert.deepEqual(namesOf(await run([h]), "stream_unresolved"), []);
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
    assert.deepEqual(r.integrity.triggers, []); // a clean scan has no trigger
    assert.deepEqual(taintedSet(r), []);
    // the fork, the subagent and the parent are one family through forked_from_id and the spawn edge (R0.9 link ii)
    const fam = familyMap(r);
    assert.equal(fam.get("codex\u0000synthetic-thread-sub"), fam.get("codex\u0000synthetic-thread-parent"));
  });

  it("R4.13: a fork file split so that one half holds only the copied parent meta is copy exposed; the family of parent and child is tainted", async () => {
    const parent = thread({ threadId: "th-pp" });
    parent.turnContext({ turnId: "TP", model: "model-a" });
    parent.tokenUsage({ responseId: "rp1", turnId: "TP" });
    parent.tokenUsage({ responseId: "rp2", turnId: "TP2" });
    const fork = CodexThread.fork(parent, { threadId: "th-ff", threadSource: "user", prefixLen: 1 });
    fork.tokenUsage({ responseId: "rf1", turnId: "TF" });
    const files = filesOf(parent, fork);
    const unsplit = await run(files);
    assert.equal(byKey(unsplit, "rp2").model.source, "carried_verified");
    assert.deepEqual(taintedSet(unsplit), []);
    const ff = files.find((f) => f.path.includes("th-ff"))!;
    const [a, b] = splitFile(ff, 1); // a = copied parent meta only
    const r = await run(files.filter((f) => f !== ff).concat([a, b]));
    assert.equal(r.coverage.files_copy_exposed, 1);
    assert.equal(r.files.filter((f) => f.copy_exposed).length, 1);
    assert.deepEqual(namesOf(r, "copy_exposed"), ["th-pp"]);
    assert.deepEqual(taintedSet(r), ["th-ff", "th-pp"]);
    // a copied record keeps the envelope of the parent's record, so once the copied meta joins the parent's stream it is
    // the parent's own session_meta again (equal records are one record, R4.12): copy exposure is the only reason
    assert.deepEqual(reasonList(r, "th-ff"), ["copy_exposed"]);
    assert.deepEqual(reasonList(r, "th-pp"), ["copy_exposed"]);
    assert.equal(effectiveVerified(r).size, 0); // neither gains a verified model
    // tokens are identical
    assert.equal(tokensOf(r), tokensOf(unsplit));
    assert.equal(r.responses.find((x) => x.key === "rp1")!.provenance.from_copy_exposed_file, false);
    // the half with the child's own meta and the copied context is not exposed: the parent id there is a copy
    const [a2, b2] = splitFile(ff, 3); // a2 = copied meta, copied context, own meta
    const r3 = await run(files.filter((f) => f !== ff).concat([a2, b2]));
    assert.equal(r3.coverage.files_copy_exposed, 0);
    assert.deepEqual(taintedSet(r3), []);
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
    assert.equal(sup.support, "full");
    assert.equal(r.coverage.files_copy_exposed, 1);
    assert.equal(r.responses.length, 0); // nothing accounted for the coverage-only file
    assert.equal(r.streams.length, 1); // no stream, link or accounting exists because of it
    assert.equal(r.streams[0]!.chain.thread, "th-sup");
    assert.deepEqual([...r.forked_from_ids], ["th-sup"]);
    assert.equal(r.coverage.requests_unverified_version, 1);
    assert.equal(r.coverage.files_assigned_by_stream, 2); // a coverage-only file is read with the same readers (R15.7)
    assert.deepEqual(namesOf(r, "copy_exposed"), ["th-sup"]);
    assert.deepEqual(namesOf(r, "version_unverified"), ["th-cov"]);
    assert.deepEqual(taintedSet(r), ["th-cov", "th-sup"]);
    assert.equal(r.files.filter((f) => f.support === "coverage_only").length, 1);
  });
});

describe("forks (R4.8, R4.9)", () => {
  it("fork facts, fork_first_own flag on the first own request only, prefix compactions marked", async () => {
    const parent = thread({ threadId: "th-p5" });
    parent.turnContext({ turnId: "TP", model: "model-a" });
    parent.compacted({ windowNumber: 1 });
    parent.tokenUsage({ responseId: "rp1", turnId: "TP" });
    const fork = CodexThread.fork(parent, { threadId: "th-f5", threadSource: "user", prefixLen: 2 });
    // a copied compaction marks itself as a copy (no latest usage record), so it is a record of its own (R4.9)
    (fork.lines.find((l) => l.type === "compacted")!.payload as Record<string, unknown>)["latest_token_usage_record"] = null;
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
  it("a coverage-only thread is counted, never accounted; the supported thread next to it is untouched in accounting but its family is not", async () => {
    const sup = raw("v-sup", [
      ln("session_meta", 0, 0, metaP("th-v")),
      ln("turn_context", 1, 1, tcP("T", "model-a")),
      ln("token_usage_record", 2, 2, turP("r1", "th-v", "T", usageP(10, 0, 0, 1, 0))),
      ln("token_usage_record", 4, 4, turP("r3", "th-v", "T", usageP(10, 0, 0, 1, 0))),
    ]);
    const old = raw("v-old", [
      ln("session_meta", 0, 3, metaP("th-w", { cli_version: "0.1.0" })),
      ln("token_usage_record", 1, 3, turP("r2", "th-w", "T", usageP(900, 0, 0, 9, 0))),
    ]);
    const odd = raw("v-odd", [ln("session_meta", 0, 0, metaP("th-o", { cli_version: "not a version" })), ln("response_item", 1, 1)]);
    const r = await run([sup, old, odd]);
    assert.deepEqual(r.responses.map((x) => x.key).sort(), ["r1", "r3"]);
    assert.equal(r.coverage.requests_unverified_version, 1); // distinct keys
    assert.equal(r.coverage.lines_unverified_version, 1); // token_usage_record lines of unverified threads
    assert.equal(r.coverage.versions["0.158.0"], 4);
    assert.equal(r.coverage.versions["0.1.0"], 2);
    assert.equal(r.coverage.versions["unlisted"], 2);
    assert.ok(r.assumptions.includes("unverified_version"));
    // R15.7: an unverified record adds no excluded request and no stream; it only withdraws output through R0.9
    assert.deepEqual(r.excluded, []);
    assert.deepEqual(r.streams.map((x) => x.chain.thread), ["th-v"]);
    assert.deepEqual(namesOf(r, "version_unverified"), ["th-o", "th-w"]);
    assert.deepEqual(taintedSet(r), ["th-o", "th-w"]); // no link joins th-v to them
    assert.equal(r.coverage.records_usage_bearing, 2);
    assert.equal(r.files.filter((f) => f.support === "coverage_only").length, 2);
    assert.equal(r.coverage.files_unassigned_stream, 0); // coverage-only files are read like any other
  });

  it("V(S) is the set of every session_meta of the scan: one unlisted label makes the whole thread unverified, copies included (R15.7)", async () => {
    const sup = raw("v2-sup", [
      ln("session_meta", 0, 0, metaP("th-v")),
      ln("turn_context", 1, 1, tcP("T", "model-a")),
      ln("token_usage_record", 2, 2, turP("r1", "th-v", "T", usageP(10, 0, 0, 1, 0))),
      ln("token_usage_record", 4, 4, turP("r3", "th-v", "T", usageP(10, 0, 0, 1, 0))),
    ]);
    const old = raw("v2-old", [
      ln("session_meta", 0, 3, metaP("th-v", { cli_version: "0.1.0" })),
      ln("token_usage_record", 1, 3, turP("r2", "th-v", "T", usageP(900, 0, 0, 9, 0))),
    ]);
    const r = await run([sup, old]);
    assert.equal(r.responses.length, 0); // nothing of th-v is accounted, including r1 and r3 of the supported file
    assert.equal(r.streams.length, 0);
    assert.equal(r.coverage.requests_unverified_version, 3);
    assert.equal(r.coverage.lines_unverified_version, 3);
    assert.deepEqual(namesOf(r, "version_unverified"), ["th-v"]);
    assert.deepEqual(taintedSet(r), ["th-v"]);
    assert.equal(r.coverage.records_usage_bearing, 0);
    // order, duplication and splitting change neither status
    for (const files of [[old, sup], [sup, old, { ...old, path: old.path.replace("v2-old", "v2-old2") }]]) {
      const x = await run(files);
      assert.equal(x.responses.length, 0);
      assert.equal(x.coverage.requests_unverified_version, 3);
    }
    // a copied parent meta of an unlisted version in a fork file makes the parent unverified as well
    const parent = raw("v2-par", [ln("session_meta", 0, 0, metaP("th-par")), ln("token_usage_record", 1, 1, turP("rp", "th-par", "T", usageP(10, 0, 0, 1, 0)))]);
    const child = raw("v2-child", [
      ln("session_meta", 0, 1, metaP("th-par", { cli_version: "0.1.0" })),
      ln("session_meta", 1, 2, metaP("th-kid", { forked_from_id: "th-par", subagent_history_start_ordinal: 1 })),
    ]);
    const c = await run([parent, child]);
    assert.equal(c.responses.length, 0);
    assert.deepEqual(namesOf(c, "version_unverified"), ["th-par"]);
    assert.deepEqual(taintedSet(c), ["th-kid", "th-par"]); // the child is in the family through forked_from_id
  });

  it("a thread whose own session_meta is missing from the scan is unversioned: coverage only", async () => {
    const half = raw("v-half", [ln("token_usage_record", 0, 1, turP("r1", "th-h", "T", usageP(10, 0, 0, 1, 0)))]);
    const r = await run([half]);
    assert.equal(r.responses.length, 0);
    assert.equal(r.streams.length, 0);
    assert.equal(r.coverage.requests_unverified_version, 1);
    assert.equal(r.coverage.files_assigned_by_stream, 1);
    assert.deepEqual(namesOf(r, "version_unverified"), ["th-h"]);
  });

  it("R5.9: no prefilter exists. An old file is read and accounted, and the parser takes no window", async () => {
    const root = writeTree([
      raw("old", [ln("session_meta", 0, 0, metaP("th-old")), ln("token_usage_record", 1, 1, turP("ro", "th-old", "T", usageP(10, 0, 0, 1, 0)))]),
      raw("new", [ln("session_meta", 0, 0, metaP("th-new")), ln("token_usage_record", 1, 1, turP("rn", "th-new", "T", usageP(10, 0, 0, 1, 0)))]),
    ]);
    const since = Date.UTC(2026, 5, 1);
    const d = await discover({ codexDirs: [root], home: join(root, "no-home"), env: {} });
    for (const f of d.files) {
      const m = f.path.includes("-old") ? since - 400 * 86_400_000 : since - 6 * 86_400_000;
      utimesSync(f.path, m / 1000, m / 1000);
    }
    const d2 = await discover({ codexDirs: [root], home: join(root, "no-home"), env: {} });
    const r = await parseCodex(d2.files, {});
    assert.deepEqual(r.responses.map((x) => x.key).sort(), ["rn", "ro"]);
    assert.ok(!r.assumptions.includes("unverified_version"));
    assert.equal(r.coverage.files_total, 2);
    // the file modification time is reported as a fact for R0.9 and is not read by the parser's decisions
    assert.deepEqual(r.integrity.files.map((f) => f.mtime_ms).sort((a, b) => a - b), [since - 400 * 86_400_000, since - 6 * 86_400_000]);
    assert.deepEqual(r.files.map((f) => f.mtime_ms).sort((a, b) => a - b), r.integrity.files.map((f) => f.mtime_ms).sort((a, b) => a - b));
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
    // R1.3, R0.9: the file facts carry the lost lines and the chains the file names; liveness is the graph's decision
    assert.equal(r.integrity.files.length, 1);
    assert.equal(r.integrity.files[0]!.unparsed_lines, 2);
    assert.deepEqual(r.integrity.files[0]!.named_chains, ["codex\u0000th-b"]);
    assert.equal(r.integrity.files[0]!.readable, true);
    assert.equal(r.integrity.files[0]!.mtime_ms, PIN_MTIME_MS);
    assert.deepEqual(taintedSet(r), ["th-b"]); // unparsed_line, as the graph would derive it from the file facts
    assert.deepEqual(reasonList(r, "th-b"), ["unparsed_line"]);
    assert.deepEqual(r.integrity.triggers, []); // unparsed_line is derived from FileFacts, never a trigger
  });

  it("a duplicated unparseable line adds to the unparsed count of its file and nothing else (R17.6)", async () => {
    const mk = (n: number): GeneratedFile => raw("bad-dup", [ln("session_meta", 0, 0, metaP("th-bd")), ...Array(n).fill("{oops"), ln("token_usage_record", 1, 1, turP("r1", "th-bd", "T", usageP(10, 0, 0, 1, 0)))]);
    const one = await run([mk(1)]);
    const three = await run([mk(3)]);
    assert.equal(one.integrity.files[0]!.unparsed_lines, 1);
    assert.equal(three.integrity.files[0]!.unparsed_lines, 3);
    assert.equal(three.coverage.lines_parse_error, one.coverage.lines_parse_error + 2);
    assert.equal(three.coverage.lines_duplicate_collapsed, 0);
    assert.equal(tokensOf(three), tokensOf(one));
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
    assert.deepEqual(namesOf(r, "file_unreadable"), ["provider"]); // R0.9, R17.1
    assert.deepEqual(r.integrity.files.map((f) => [f.readable, f.unparsed_lines, f.named_chains.length]), [[false, 0, 0]]);
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

/** R17.6 counters of R2.9 after a split, from the line contents of the halves. */
function orphanCounts(files: readonly GeneratedFile[]): { files: number; events: number } {
  let nFiles = 0;
  let events = 0;
  for (const f of files) {
    const ls = linesOf(f);
    const tok = ls.filter((l) => l.includes('"type":"token_count"')).length;
    const hasTur = ls.some((l) => l.includes('"type":"token_usage_record"'));
    if (tok > 0 && !hasTur) {
      nFiles++;
      events += tok;
    }
  }
  return { files: nFiles, events };
}

describe("metamorphic: splitting at every line boundary (R4.10, R4.13, R17.7)", () => {
  for (const [name, build] of SCENARIOS) {
    it(`${name}: every split position obeys the split contract`, async () => {
      const files = plain(build());
      const base = await runX(files);
      const baseSem = semantic(base.r);
      const baseTokens = tokensOf(base.r);
      const baseTaint = new Set(taintedSet(base.r));
      const baseVerified = effectiveVerified(base.r);
      assert.equal(baseTaint.size, 0, `${name}: the unsplit scenario is clean`);
      let positions = 0;
      let unaffected = 0;
      let withdrawn = 0;
      for (const c of splitCases(files)) {
        positions++;
        const sp = await runX(c.files);
        const r = sp.r;
        const label = `${name} ${c.file.path} at ${c.at}`;
        // accounting is keyed by record identity: token totals are identical for every split, dissolving or not
        assert.equal(tokensOf(r), baseTokens, `${label}: tokens`);
        assert.equal(r.coverage.lines_total, base.r.coverage.lines_total, `${label}: lines_total`);
        assert.equal(r.coverage.known_type_count, base.r.coverage.known_type_count);
        assert.equal(r.coverage.files_total, base.r.coverage.files_total + 1);
        assert.equal(r.coverage.responses_total, base.r.coverage.responses_total);
        assert.equal(r.coverage.requests_total, base.r.coverage.requests_total);
        assert.equal(r.coverage.records_unkeyed, base.r.coverage.records_unkeyed);
        assert.equal(r.coverage.requests_conflict, base.r.coverage.requests_conflict);
        assert.equal(r.coverage.requests_unverified_version, base.r.coverage.requests_unverified_version);
        assert.equal(r.coverage.lines_unverified_version, base.r.coverage.lines_unverified_version);
        assert.equal(r.streams.length, base.r.streams.length);
        // R17.6: the two counters of R2.9 change by the exact rule
        const orphans = orphanCounts(c.files);
        assert.equal(r.coverage.files_without_response_id, orphans.files, `${label}: files_without_response_id`);
        assert.equal(r.coverage.token_count_events_without_response_id, orphans.events, `${label}: token_count events`);
        if (await dissolving(base, c, sp)) continue; // only the record-set guarantees above apply
        // taint monotonicity (R0.9): the tainted set can only grow
        const taint = new Set(taintedSet(r));
        for (const t of baseTaint) assert.ok(taint.has(t), `${label}: ${t} left the tainted set`);
        // split monotonicity: the verified set shrinks, with equal values on the common part
        for (const [k, m] of effectiveVerified(r)) assert.equal(baseVerified.get(k), m, `${label}: verified model of ${k} added or changed`);
        // structural facts do not depend on the split
        assert.equal(r.coverage.links_verified, base.r.coverage.links_verified, `${label}: links`);
        assert.equal(r.coverage.links_unlinked, base.r.coverage.links_unlinked);
        assert.deepEqual(r.integrity.chains, base.r.integrity.chains, `${label}: chains`);
        assert.deepEqual(familyMap(r), familyMap(base.r), `${label}: families`);
        if (taint.size === 0) {
          // invariance: a split that taints no new chain changes nothing but the physical counters
          unaffected++;
          same(semantic(r), baseSem, `${label}: untainted split must be identical`);
          assert.equal(r.coverage.files_assigned_by_stream, base.r.coverage.files_assigned_by_stream + 1);
        } else {
          withdrawn++;
          assert.ok(r.coverage.responses_model_unverified >= 0);
        }
      }
      assert.ok(positions > 5, `${name}: enough split positions (${positions})`);
      assert.ok(unaffected > 0, `${name}: some untainted splits (${unaffected})`);
      if (name !== "codex-basic") assert.ok(withdrawn > 0, `${name}: some withdrawing splits (${withdrawn})`);
    });
  }

  it("the multi-file thread of codex-basic: merging its two files gives the same semantic output", async () => {
    const files = plain(scenarios.find((s) => s.name === "codex-basic")!.build());
    const base = await run(files);
    const mainFiles = files.filter((f) => f.path.includes("synthetic-thread-main"));
    assert.equal(mainFiles.length, 2);
    const merged: GeneratedFile = { path: "sessions/2026/01/01/rollout-2026-01-01T00-00-00-synthetic-thread-main.jsonl", content: mainFiles.flatMap(linesOf).join("\n") + "\n" };
    const r = await run(files.filter((f) => !mainFiles.includes(f)).concat([merged]));
    assert.equal(semantic(r), semantic(base));
    assert.equal(r.coverage.files_total, base.coverage.files_total - 1);
  });
});

// ---------------------------------------------------------------------------
// 7b. R0.9, R2.17, R4.10 fixtures at parser level (every one shuffled, duplicated and split at every line boundary)
// ---------------------------------------------------------------------------

interface Fixture {
  name: string;
  files: GeneratedFile[];
}

/** Shuffle, file order, key order and duplication of a line leave the facts unchanged (R4.10 ops 1 to 4). */
async function checkOps(fx: Fixture): Promise<void> {
  const base = await run(fx.files);
  const sem = semantic(base);
  for (const seed of [11, 12]) {
    const r = await run(fx.files.map((f) => withLines(f, shuffled(linesOf(f), seed + f.path.length))));
    same(semantic(r), sem, `${fx.name}: line shuffle ${seed}`);
  }
  same(semantic(await runWithOrder(fx.files, "desc")), sem, `${fx.name}: file order`);
  const rekey = (l: string): string => {
    try {
      return JSON.stringify(reverseKeys(JSON.parse(l)));
    } catch {
      return l;
    }
  };
  same(semantic(await run(fx.files.map((f) => withLines(f, linesOf(f).map(rekey))))), sem, `${fx.name}: key order`);
  for (const [fi, f] of fx.files.entries()) {
    const ls = linesOf(f);
    const idx = Math.floor(ls.length / 2);
    if (idx >= ls.length - 1) continue;
    const dup = ls.slice(0, idx + 1).concat([ls[idx]!, ls[idx]!], ls.slice(idx + 1));
    same(semantic(await run(fx.files.map((g, gi) => (gi === fi ? withLines(g, dup) : g)))), sem, `${fx.name}: duplicated line ${idx} of file ${fi}`);
  }
}

/**
 * Every split position of every file: tokens identical; for a split that is not dissolving the tainted set contains the
 * unsplit one. \`expected\` is the stored expectation of the position, when the fixture gives one.
 */
async function checkSplits(
  fx: Fixture,
  expected?: (c: SplitCase, r: CodexParseResult, dissolved: boolean) => void,
): Promise<number> {
  const base = await runX(fx.files);
  const baseTaint = new Set(taintedSet(base.r));
  const baseTokens = tokensOf(base.r);
  const baseVerified = effectiveVerified(base.r);
  let n = 0;
  for (const c of splitCases(fx.files)) {
    n++;
    const sp = await runX(c.files);
    const label = `${fx.name}: ${c.file.path} at ${c.at}`;
    assert.equal(tokensOf(sp.r), baseTokens, `${label}: tokens`);
    const dis = await dissolving(base, c, sp);
    if (!dis) {
      const t = new Set(taintedSet(sp.r));
      for (const x of baseTaint) assert.ok(t.has(x), `${label}: ${x} left the tainted set`);
      for (const [k, m] of effectiveVerified(sp.r)) assert.equal(baseVerified.get(k), m, `${label}: verified model of ${k}`);
    }
    expected?.(c, sp.r, dis);
  }
  return n;
}

const usageBig = (inp: number, c: number): object => usageP(inp, c, 0, 10, 0);
const SESS = "sess-shared";

describe("R0.9 fixture (1): the round 10 counterexample, three variants", () => {
  const supportedFile = (): GeneratedFile =>
    raw("x-main", [
      ln("session_meta", 0, 0, metaP("th-X", { session_id: SESS })),
      ln("turn_context", 1, 1, tcP("T", "model-a")),
      ln("token_usage_record", 2, 10, turP("P", "th-X", "T", usageBig(30000, 20000), { session_id: SESS })),
      ln("token_usage_record", 3, 30, turP("C", "th-X", "T", usageBig(60000, 0), { session_id: SESS })),
    ]);
  const old = (name: string, lines: (object | string)[]): GeneratedFile => raw(name, lines);
  const variants: Record<string, Fixture> = {
    a: {
      name: "(1a)",
      files: [
        supportedFile(),
        old("x-159", [
          ln("session_meta", 0, 5, metaP("th-X", { session_id: SESS, cli_version: "0.159.0" })),
          ln("token_usage_record", 1, 20, turP("Q", "th-X", "T2", usageBig(60000, 60000), { session_id: SESS })),
        ]),
      ],
    },
    b: {
      name: "(1b)",
      files: [
        supportedFile(),
        old("x-159", [
          ln("session_meta", 0, 5, metaP("th-Y", { session_id: SESS, cli_version: "0.159.0" })),
          ln("token_usage_record", 1, 20, { response_id: "Q", session_id: SESS, turn_id: "T2", usage: usageBig(60000, 60000) }),
        ]),
      ],
    },
    c: {
      name: "(1c)",
      files: [
        supportedFile(),
        old("x-159", [
          ln("session_meta", 0, 5, metaP("th-Y", { session_id: SESS, cli_version: "0.159.0" })),
          ln("token_usage_record", 1, 20, turP("Q", "th-Y", "T2", usageBig(60000, 60000), { session_id: SESS })),
        ]),
      ],
    },
  };

  it("(a) the 0.159.0 file holds session_meta(X): X is of an unverified version, nothing of X is accounted", async () => {
    const fx = variants["a"]!;
    const r = await run(fx.files);
    assert.equal(r.responses.length, 0);
    assert.equal(r.streams.length, 0);
    assert.equal(r.coverage.requests_unverified_version, 3); // P, C and Q
    assert.deepEqual(namesOf(r, "version_unverified"), ["th-X"]);
    assert.deepEqual(taintedSet(r), ["th-X"]);
    await checkOps(fx);
    assert.ok((await checkSplits(fx, (_c, sp) => assert.equal(sp.responses.length, 0))) > 3);
  });

  it("(b) session_meta(Y) with the same session_id and a usage record without thread_id: a provider trigger, P and C keep their tokens", async () => {
    const fx = variants["b"]!;
    const r = await run(fx.files);
    assert.deepEqual(r.responses.map((x) => x.key), ["P", "C"]);
    assert.equal(byKey(r, "P").usage!.cache_read, 20000n);
    assert.equal(byKey(r, "C").usage!.input_uncached, 60000n);
    assert.deepEqual(namesOf(r, "unattributed_record"), ["provider"]);
    assert.deepEqual(namesOf(r, "version_unverified"), ["th-Y"]);
    assert.equal(r.coverage.records_unkeyed, 1);
    assert.deepEqual(taintedSet(r), ["th-X", "th-Y"]);
    assert.deepEqual(reasonList(r, "th-X"), ["version_unverified", "unattributed_record"]); // the family of Y, and the provider
    assert.equal(effectiveVerified(r).size, 0);
    await checkOps(fx);
    await checkSplits(fx);
  });

  it("(c) session_meta(Y) with readable ids: version_unverified names Y and the shared session_id links X and Y", async () => {
    const fx = variants["c"]!;
    const r = await run(fx.files);
    assert.deepEqual(r.responses.map((x) => x.key), ["P", "C"]);
    assert.equal(r.coverage.requests_unverified_version, 1); // Q
    assert.deepEqual(namesOf(r, "version_unverified"), ["th-Y"]);
    assert.deepEqual(r.integrity.family_groups, [["codex\u0000th-X", "codex\u0000th-Y"]]);
    assert.deepEqual(taintedSet(r), ["th-X", "th-Y"]);
    assert.deepEqual(reasonList(r, "th-X"), ["version_unverified"]);
    assert.equal(effectiveVerified(r).size, 0);
    await checkOps(fx);
    await checkSplits(fx);
  });
});

describe("R0.9 fixtures (4), (5), (6)", () => {
  const thread1 = (): GeneratedFile[] =>
    filesOf(
      (() => {
        const t = thread({ threadId: "th-ok" });
        t.turnContext({ turnId: "T", model: "model-a" });
        t.tokenUsage({ responseId: "P", turnId: "T", usage: { input: 30000, cached: 20000, output: 10 } });
        t.tokenUsage({ responseId: "C", turnId: "T", usage: { input: 60000, cached: 0, output: 10 } });
        return t;
      })(),
    );

  it("(4) an unreadable archived file taints every Codex chain; token totals are unchanged", async () => {
    const clean = thread1();
    const bad: GeneratedFile = { path: "archived_sessions/rollout-2026-01-01T00-00-00-broken.jsonl.zst", content: "this is not a zstd frame" };
    const without = await run(clean);
    const fx: Fixture = { name: "(4)", files: [...clean, bad] };
    const r = await run(fx.files);
    assert.equal(r.coverage.files_unreadable, 1);
    assert.equal(r.files.filter((f) => !f.readable).length, 1);
    assert.deepEqual(namesOf(r, "file_unreadable"), ["provider"]);
    assert.deepEqual(taintedSet(r), ["th-ok"]);
    assert.deepEqual(reasonList(r, "th-ok"), ["file_unreadable"]);
    assert.equal(tokensOf(r), tokensOf(without));
    assert.equal(r.integrity.files.filter((f) => !f.readable).length, 1);
    assert.deepEqual(taintedSet(without), []);
    await checkOps(fx);
    await checkSplits(fx);
  });

  it("(4) a truncated archive that yielded some lines before failing is unreadable as a whole: nothing of it is accounted (R0.2)", async (ctx) => {
    const t = thread({ threadId: "th-zt" });
    t.turnContext({ turnId: "T", model: "model-a" });
    for (let i = 0; i < 40; i++) t.tokenUsage({ responseId: `zt${i}`, turnId: "T", usage: { input: 1000 + i, output: 5 } });
    const text = filesOf(t)[0]!.content as string;
    const z = zstdCompress(text);
    if (z === null) {
      ctx.diagnostic("no zstd compressor on this Node: only the garbage-archive path is exercised");
      return;
    }
    const clean = thread1();
    const bad: GeneratedFile = { path: "archived_sessions/rollout-2026-01-01T00-00-00-trunc.jsonl.zst", content: z.subarray(0, Math.max(1, z.length - 6)) };
    const r = await run([...clean, bad]);
    assert.equal(r.coverage.files_unreadable, 1);
    assert.deepEqual(namesOf(r, "file_unreadable"), ["provider"]);
    assert.equal(r.responses.filter((x) => x.thread_id === "th-zt").length, 0); // no partial accounting of an unreadable file
    assert.deepEqual(r.responses.map((x) => x.key), ["P", "C"]);
  });

  it("(5) a second file of the thread with only session_meta and token_count events: unlogged_usage naming the thread", async () => {
    const main = raw("u-main", [
      ln("session_meta", 0, 0, metaP("th-u")),
      ln("turn_context", 1, 1, tcP("T", "model-a")),
      ln("token_usage_record", 2, 10, turP("P", "th-u", "T", usageBig(30000, 20000))),
      ln("token_usage_record", 3, 30, turP("C", "th-u", "T", usageBig(60000, 0))),
    ]);
    const second = raw("u-second", [
      ln("session_meta", 0, 0, metaP("th-u")),
      ln("event_msg", 4, 20, { type: "token_count" }),
      ln("event_msg", 5, 21, { type: "token_count" }),
    ]);
    const fx: Fixture = { name: "(5)", files: [main, second] };
    const r = await run(fx.files);
    assert.equal(r.coverage.files_without_response_id, 1);
    assert.equal(r.coverage.token_count_events_without_response_id, 2);
    assert.deepEqual(namesOf(r, "unlogged_usage"), ["th-u"]);
    assert.deepEqual(taintedSet(r), ["th-u"]);
    assert.deepEqual(r.responses.map((x) => x.key), ["P", "C"]);
    await checkOps(fx);
    await checkSplits(fx);
  });

  it("(6) a clean family and a tainted family in one scan: the clean family's facts equal those of a scan that holds only it", async () => {
    const cleanFiles = thread1();
    const dirty = raw("d-main", [
      ln("session_meta", 0, 0, metaP("th-dirty")),
      ln("turn_context", 1, 1, tcP("T9", "model-b")),
      ln("token_usage_record", 2, 2, turP("D1", "th-dirty", "T9", usageP(100, 200, 0, 5, 0))), // cached > input: R2.7
      ln("token_usage_record", 3, 3, turP("D2", "th-dirty", "T9", usageP(100, 0, 0, 5, 0))),
    ]);
    const alone = await run(cleanFiles);
    const fx: Fixture = { name: "(6)", files: [...cleanFiles, dirty] };
    const both = await run(fx.files);
    assert.deepEqual(taintedSet(both), ["th-dirty"]);
    assert.deepEqual(reasonList(both, "th-dirty"), ["request_anomaly"]);
    const pick = (r: CodexParseResult): string => JSON.stringify(r.responses.filter((x) => x.thread_id === "th-ok").map((x) => ({ ...x, provenance: null })), bigintReplacer);
    assert.equal(pick(both), pick(alone));
    assert.deepEqual([...effectiveVerified(both).keys()].sort(), [...effectiveVerified(alone).keys()].sort());
    assert.ok(effectiveVerified(both).size > 0);
    await checkOps(fx);
    await checkSplits(fx);
  });
});

describe("R4.10 counter fixture of R2.9: five records, stored values for every split position", () => {
  const five = (): GeneratedFile =>
    raw("five", [
      ln("session_meta", 0, 0, metaP("th-5")),
      ln("event_msg", 1, 1, { type: "token_count" }),
      ln("turn_context", 2, 2, tcP("T", "model-a")),
      ln("token_usage_record", 3, 3, turP("r5", "th-5", "T", usageP(100, 10, 0, 5, 0))),
      ln("event_msg", 4, 4, { type: "token_count" }),
    ]);

  it("unsplit: 0 and 0, untainted; after record 1: 0 and 0, untainted, identical output; after record 2 and 3: 1 and 1, unlogged_usage", async () => {
    const f = five();
    const base = await run([f]);
    assert.equal(base.coverage.files_without_response_id, 0);
    assert.equal(base.coverage.token_count_events_without_response_id, 0);
    assert.deepEqual(taintedSet(base), []);
    assert.deepEqual(effectiveVerified(base).get("r5"), "model-a");
    const stored: Record<number, { files: number; events: number; tainted: boolean }> = {
      1: { files: 0, events: 0, tainted: false },
      2: { files: 1, events: 1, tainted: true },
      3: { files: 1, events: 1, tainted: true },
    };
    const cases = splitCases([f]);
    assert.deepEqual(cases.map((c) => c.at), [1, 2, 3]); // after record 4 the second half names no chain (R4.10 op 5)
    for (const c of cases) {
      const r = await run(c.files);
      const e = stored[c.at]!;
      assert.equal(r.coverage.files_without_response_id, e.files, `after record ${c.at}`);
      assert.equal(r.coverage.token_count_events_without_response_id, e.events, `after record ${c.at}`);
      assert.deepEqual(taintedSet(r), e.tainted ? ["th-5"] : [], `after record ${c.at}`);
      if (e.tainted) assert.deepEqual(reasonList(r, "th-5"), ["unlogged_usage"]);
      assert.equal(tokensOf(r), tokensOf(base));
      assert.equal(effectiveVerified(r).size, e.tainted ? 0 : 1);
      if (!e.tainted) same(semantic(r), semantic(base), `after record ${c.at}`);
    }
  });
});

describe("R2.17 fixtures at parser level (exact model_source, triggers, every split position)", () => {
  const src = (r: CodexParseResult, k: string): [string, string | null, boolean] => {
    const m = byKey(r, k).model;
    return [m.source, m.candidate, m.verified];
  };
  const markerLine = (o: number, sec: number): Record<string, unknown> => ln("event_msg", o, sec, { type: "thread_settings_applied" });

  it("(1) context A, marker, context B, usage record of one turn: TM(T) = {A, B}, tokens only, at every position", async () => {
    const fx: Fixture = {
      name: "R2.17(1)",
      files: [
        raw("m1", [
          ln("session_meta", 0, 0, metaP("th-1")),
          ln("turn_context", 1, 1, tcP("T", "model-a")),
          markerLine(2, 2),
          ln("turn_context", 3, 3, tcP("T", "model-b")),
          ln("token_usage_record", 4, 4, turP("r", "th-1", "T", usageP(100, 0, 0, 5, 0))),
        ]),
      ],
    };
    const r = await run(fx.files);
    assert.deepEqual(src(r, "r"), ["own_turn_unsettled", null, false]);
    assert.deepEqual(namesOf(r, "turn_model_conflicted"), ["th-1"]);
    assert.deepEqual(taintedSet(r), ["th-1"]);
    await checkOps(fx);
    const n = await checkSplits(fx, (_c, sp) => {
      assert.deepEqual(taintedSet(sp), ["th-1"]);
      assert.equal(effectiveVerified(sp).size, 0);
    });
    assert.ok(n >= 3);
  });

  it("(2) a newer context of another turn does not unbind the record (own_turn); a marker after the first own context makes it own_turn_unsettled", async () => {
    const mk = (marker: boolean): Fixture => ({
      name: `R2.17(2) marker=${marker}`,
      files: [
        raw(marker ? "m2m" : "m2", [
          ln("session_meta", 0, 0, metaP("th-2")),
          ln("turn_context", 1, 1, tcP("T1", "model-a")),
          ...(marker ? [markerLine(2, 2)] : []),
          ln("turn_context", marker ? 3 : 2, 3, tcP("T2", "model-b")),
          ln("token_usage_record", marker ? 4 : 3, 4, turP("r", "th-2", "T1", usageP(100, 0, 0, 5, 0))),
        ]),
      ],
    });
    for (const marker of [false, true]) {
      const fx = mk(marker);
      const r = await run(fx.files);
      assert.deepEqual(src(r, "r"), marker ? ["own_turn_unsettled", "model-a", false] : ["own_turn", "model-a", true]);
      assert.deepEqual(taintedSet(r), []);
      await checkOps(fx);
      // a single thread in one file: every split leaves the stream, its model attribution and the taint unchanged
      await checkSplits(fx, (_c, sp) => {
        assert.deepEqual(src(sp, "r"), src(r, "r"));
        assert.deepEqual(taintedSet(sp), []);
      });
    }
  });

  it("(3) two models, then a record of a turn without its own context: carried_unverified; (4) one model and no marker: carried_verified", async () => {
    const mk = (m2: string): Fixture => ({
      name: `R2.17(3/4) ${m2}`,
      files: [
        raw(`m3-${m2}`, [
          ln("session_meta", 0, 0, metaP("th-3")),
          ln("turn_context", 1, 1, tcP("T1", "model-a")),
          ln("turn_context", 2, 2, tcP("T2", m2)),
          ln("token_usage_record", 3, 3, turP("r", "th-3", "T3", usageP(100, 0, 0, 5, 0))),
        ]),
      ],
    });
    const three = await run(mk("model-b").files);
    assert.deepEqual(src(three, "r"), ["carried_unverified", "model-b", false]);
    const four = await run(mk("model-a").files);
    assert.deepEqual(src(four, "r"), ["carried_verified", "model-a", true]);
    for (const fx of [mk("model-b"), mk("model-a")]) {
      await checkOps(fx);
      const base = await run(fx.files);
      await checkSplits(fx, (_c, sp) => {
        assert.deepEqual(src(sp, "r"), src(base, "r"));
        assert.deepEqual(taintedSet(sp), []);
      });
    }
  });

  describe("(5) the two-model fork", () => {
    const build = (childModel: string): { fx: Fixture; parentFile: string } => {
      const parent = thread({ threadId: "th-P" });
      parent.turnContext({ turnId: "TP", model: "model-a" });
      parent.tokenUsage({ responseId: "rp", turnId: "TP" });
      const fork = CodexThread.fork(parent, { threadId: "th-C", threadSource: "user", prefixLen: 1 });
      fork.turnContext({ turnId: "T1", model: childModel });
      fork.tokenUsage({ responseId: "r1", turnId: "T1" });
      fork.tokenUsage({ responseId: "r2", turnId: "T2" });
      fork.tokenUsage({ responseId: "r3", turnId: "T3" });
      return { fx: { name: `R2.17(5) child ${childModel}`, files: filesOf(parent, fork) }, parentFile: "th-P" };
    };

    it("child context B: r1 own_turn B, r2 and r3 carried_unverified (G(S) holds A and B)", async () => {
      const { fx } = build("model-b");
      const r = await run(fx.files);
      assert.deepEqual(src(r, "r1"), ["own_turn", "model-b", true]);
      assert.deepEqual(src(r, "r2"), ["carried_unverified", "model-b", false]);
      assert.deepEqual(src(r, "r3"), ["carried_unverified", "model-b", false]);
      assert.deepEqual(src(r, "rp"), ["own_turn", "model-a", true]);
      assert.deepEqual(taintedSet(r), []);
      await checkOps(fx);
    });

    it("child context A: r2 and r3 carried_verified A", async () => {
      const { fx } = build("model-a");
      const r = await run(fx.files);
      assert.deepEqual(src(r, "r2"), ["carried_verified", "model-a", true]);
      assert.deepEqual(taintedSet(r), []);
      await checkOps(fx);
    });

    it("stored result of every split position: positions 1 and 2 leave a half with only the copied parent meta (copy exposed, family of parent and child tainted); the others change nothing", async () => {
      for (const model of ["model-a", "model-b"]) {
        const { fx } = build(model);
        const base = await run(fx.files);
        const forkLines = fx.files.filter((f) => f.path.includes("th-C")).flatMap(linesOf);
        assert.ok(forkLines[0]!.includes('"id":"th-P"')); // the copied parent meta
        let seen = 0;
        await checkSplits(fx, (c, sp) => {
          if (!c.file.path.includes("th-C")) return;
          seen++;
          const exposed = c.at <= 2; // [copied meta] and [copied meta, copied context] hold no usage record of the parent
          assert.equal(sp.coverage.files_copy_exposed, exposed ? 1 : 0, `${model} at ${c.at}`);
          assert.deepEqual(taintedSet(sp), exposed ? ["th-C", "th-P"] : [], `${model} at ${c.at}`);
          assert.deepEqual(namesOf(sp, "copy_exposed"), exposed ? ["th-P"] : []);
          if (exposed) assert.equal(effectiveVerified(sp).size, 0);
          else assert.deepEqual([...effectiveVerified(sp)], [...effectiveVerified(base)]);
        });
        assert.equal(seen, forkLines.length - 1);
      }
    });

    it("copy_differs: the copied context carries another model; copy exposed at every exposed position, ordinal_unverified only where the copied context lands in the parent's stream", async () => {
      const parent = thread({ threadId: "th-P" });
      parent.turnContext({ turnId: "TP", model: "model-a" });
      parent.tokenUsage({ responseId: "rp", turnId: "TP" });
      const fork = CodexThread.fork(parent, { threadId: "th-C", threadSource: "user", prefixLen: 1 });
      (fork.lines[1]!.payload as Record<string, unknown>)["model"] = "model-b"; // the copy differs from the parent's genuine context
      fork.turnContext({ turnId: "T1", model: "model-b" });
      fork.tokenUsage({ responseId: "r1", turnId: "T1" });
      const fx: Fixture = { name: "R2.17(5) copy_differs", files: filesOf(parent, fork) };
      const base = await run(fx.files);
      // unsplit: the copy is in the fork's stream next to its own session_meta; TM(TP) = {A, B} taints the family
      assert.deepEqual(taintedSet(base), ["th-C", "th-P"]);
      assert.deepEqual(reasonList(base, "th-C"), ["turn_model_conflicted"]);
      assert.deepEqual(reasonList(base, "th-P"), ["turn_model_conflicted"]);
      let seen = 0;
      await checkSplits(fx, (c, sp) => {
        seen++;
        const inFork = c.file.path.includes("th-C");
        const exposed = c.at <= 2; // fork file: copied meta; copied meta and copied context. Parent file: first half has no usage record
        const want: TaintReason[] = exposed ? ["copy_exposed", "turn_model_conflicted"] : ["turn_model_conflicted"];
        // the copied context (model B) next to the parent's own context (model A) with the same ordinal: a collision (R4.12 (b))
        if (inFork && c.at === 2) want.push("ordinal_unverified");
        const label = `${inFork ? "fork" : "parent"} at ${c.at}`;
        assert.deepEqual(reasonList(sp, "th-C"), want, label);
        assert.deepEqual(reasonList(sp, "th-P"), want, label);
        assert.equal(effectiveVerified(sp).size, 0, label);
      });
      assert.ok(seen >= 6);
    });
  });

  // (6) and (7): shared session so that the families of X and Y are one family (the fixtures speak of "the families of X and Y")
  const fix6 = (): Fixture => ({
    name: "R2.17(6)",
    files: [
      raw("f6-1", [
        ln("session_meta", 0, 0, metaP("th-X", { session_id: SESS })),
        ln("turn_context", 1, 1, tcP("T", "model-a")),
        ln("token_usage_record", 2, 2, turP("rX", "th-X", "T", usageP(100, 0, 0, 10, 0), { session_id: SESS })),
      ]),
      raw("f6-2", [
        ln("session_meta", 0, 3, metaP("th-Y", { session_id: SESS })),
        ln("token_usage_record", 3, 4, turP("rQ", "th-X", "T2", usageP(50, 0, 0, 5, 0), { session_id: SESS })),
        markerLine(4, 5),
        ln("turn_context", 5, 6, tcP("T", "model-b")),
      ]),
    ],
  });

  it("(6) F2 is a stream conflict and TM(T) = {A, B}: X and Y are tainted unsplit and at every split position, tokens kept", async () => {
    const fx = fix6();
    const r = await run(fx.files);
    assert.deepEqual(taintedSet(r), ["th-X", "th-Y"]);
    assert.deepEqual(namesOf(r, "stream_unresolved"), ["th-X", "th-Y"]);
    await checkOps(fx);
    let dissolved = 0;
    const n = await checkSplits(fx, (_c, sp, dis) => {
      assert.equal(effectiveVerified(sp).size, 0);
      // tainted at every position, including the splits that give each half of F2 one identity (R2.17 (6))
      assert.deepEqual(taintedSet(sp), ["th-X", "th-Y"]);
      if (dis) {
        // a dissolving split leaves only the record-set reason (the stream conflict is gone)
        dissolved++;
        assert.deepEqual(reasonList(sp, "th-X"), ["turn_model_conflicted"]);
        assert.deepEqual(reasonList(sp, "th-Y"), ["turn_model_conflicted"]);
      }
    });
    assert.equal(n, 3); // F1 at 1 and 2, F2 at 1 (the other cuts of F2 leave a half that names no chain, R4.10 op 5)
    assert.ok(dissolved >= 1, "a split that gives each half of F2 one identity was exercised");
  });

  // Q < P < C in time. F2 is the earlier file and uses the low ordinals, F1 continues the ordinals from 4 on, so every stream that
  // results from a split keeps monotone timestamps along its ordinals.
  const fix7 = (): Fixture => ({
    name: "R2.17(7)",
    files: [
      raw("f7-1", [
        ln("session_meta", 4, 10, metaP("th-X", { session_id: SESS })),
        ln("turn_context", 5, 11, tcP("T", "model-a")),
        ln("token_usage_record", 6, 12, turP("P", "th-X", "T", usageP(30000, 20000, 0, 10, 0), { session_id: SESS })),
        ln("turn_context", 7, 13, tcP("TC", "model-b")),
        ln("token_usage_record", 8, 14, turP("C", "th-X", "TC", usageP(60000, 0, 0, 10, 0), { session_id: SESS })),
      ]),
      raw("f7-2", [
        ln("session_meta", 0, 0, metaP("th-Y", { session_id: SESS })),
        ln("turn_context", 1, 1, tcP("T", "model-b")),
        markerLine(2, 2),
        ln("token_usage_record", 3, 3, turP("Q", "th-X", "T2", usageP(60000, 60000, 0, 10, 0), { session_id: SESS })),
      ]),
    ],
  });

  it("(7) the split counterexample: TM(T) = {A, B} and P names X, so X is tainted at every position; no verified model for P, C or Q", async () => {
    const fx = fix7();
    const r = await run(fx.files);
    assert.deepEqual(taintedSet(r), ["th-X", "th-Y"]);
    assert.deepEqual(namesOf(r, "turn_model_conflicted"), ["th-X", "th-Y"]);
    assert.equal(effectiveVerified(r).size, 0);
    await checkOps(fx);
    const n = await checkSplits(fx, (_c, sp, dis) => {
      assert.ok(taintedSet(sp).includes("th-X"));
      assert.equal(effectiveVerified(sp).size, 0);
      if (dis) assert.deepEqual(reasonList(sp, "th-X"), ["turn_model_conflicted"]);
    });
    assert.ok(n >= 6);
  });

  const fix8 = (): Fixture => ({
    name: "R2.17(8)",
    files: [
      raw("f8-1", [
        ln("session_meta", 0, 0, metaP("th-X", { session_id: SESS })),
        ln("turn_context", 1, 1, tcP("T", "model-a")),
        ln("token_usage_record", 2, 2, turP("P", "th-X", "T", usageP(100, 0, 0, 10, 0), { session_id: SESS })),
      ]),
      raw("f8-2", [
        ln("session_meta", 0, 3, metaP("th-Y", { session_id: SESS })),
        markerLine(3, 4),
        ln("token_usage_record", 4, 5, turP("Q", "th-X", "T2", usageP(50, 0, 0, 5, 0), { session_id: SESS })),
      ]),
    ],
  });

  it("(8) the dissolving fixture: unsplit F2 is a stream conflict; both splits of F2 verify P as own_turn; splits of F1 keep the taint", async () => {
    const fx = fix8();
    const r = await run(fx.files);
    assert.deepEqual(namesOf(r, "stream_unresolved"), ["th-X", "th-Y"]);
    assert.deepEqual(taintedSet(r), ["th-X", "th-Y"]);
    assert.equal(effectiveVerified(r).size, 0);
    assert.deepEqual(src(r, "P"), ["own_turn", "model-a", true]); // the parser verifies it; the taint withdraws it
    const base = await runX(fx.files);
    const seen: string[] = [];
    await checkSplits(fx, (c, sp, dis) => {
      const key = `${c.file.path.includes("f8-2") ? "F2" : "F1"}@${c.at}`;
      seen.push(`${key}:${dis ? "dissolving" : "plain"}`);
      assert.equal(tokensOf(sp), tokensOf(base.r));
      if (c.file.path.includes("f8-2")) {
        assert.ok(dis, `${key} dissolves the stream conflict`);
        // stored: nothing is tainted any more, P is own_turn and verified, the marker lies after P
        assert.deepEqual(taintedSet(sp), [], key);
        assert.deepEqual(namesOf(sp, "stream_unresolved"), [], key);
        // after the meta of Y the marker joins the stream of X (Q carried_unverified); after the marker it stays with Y (Q carried_verified)
        if (c.at === 1) {
          assert.deepEqual([...effectiveVerified(sp)], [["P", "model-a"]], key);
          assert.deepEqual(src(sp, "Q"), ["carried_unverified", "model-a", false], key);
        } else {
          assert.deepEqual([...effectiveVerified(sp)], [["P", "model-a"], ["Q", "model-a"]], key);
          assert.deepEqual(src(sp, "Q"), ["carried_verified", "model-a", true], key);
        }
      } else {
        assert.ok(!dis, key);
        assert.deepEqual(taintedSet(sp), ["th-X", "th-Y"], key);
      }
    });
    assert.deepEqual(seen.sort(), ["F1@1:plain", "F1@2:plain", "F2@1:dissolving", "F2@2:dissolving"]);
  });
});

// ---------------------------------------------------------------------------
// 7b. answers of the orchestrator on revision 11 (stored decisions)
// ---------------------------------------------------------------------------

describe("revision 11 decisions", () => {
  it("R2.17 (d): a turn_context without a usable model is a null member of TM(T), so model A plus null is turn_model_conflicted", async () => {
    for (const bad of [undefined, 7, "Not A Model!"]) {
      const tcNoModel: Record<string, unknown> = { ...(tcP("T", "model-a") as Record<string, unknown>), model: bad };
      if (bad === undefined) delete tcNoModel["model"];
      const f = raw("nullm", [
        ln("session_meta", 0, 0, metaP("th-n")),
        ln("turn_context", 1, 1, tcP("T", "model-a")),
        ln("turn_context", 2, 2, tcNoModel),
        ln("token_usage_record", 3, 3, turP("r", "th-n", "T", usageP(10, 0, 0, 1, 0))),
      ]);
      const r = await run([f]);
      assert.deepEqual(namesOf(r, "turn_model_conflicted"), ["th-n"], String(bad));
      assert.equal(effectiveVerified(r).size, 0, String(bad));
      assert.equal(byKey(r, "r").usage!.input_uncached, 10n);
    }
    // two usable models that normalize to one id are no conflict
    const ok = raw("nullm-ok", [
      ln("session_meta", 0, 0, metaP("th-n")),
      ln("turn_context", 1, 1, tcP("T", "model-a")),
      ln("turn_context", 2, 2, tcP("T", "model-a-20250101")),
      ln("token_usage_record", 3, 3, turP("r", "th-n", "T", usageP(10, 0, 0, 1, 0))),
    ]);
    assert.deepEqual(namesOf(await run([ok]), "turn_model_conflicted"), []);
  });

  it("a top-level parent_thread_id of a session_meta is not a family link (R0.9 (ii) is closed)", async () => {
    const a = raw("pt-a", [ln("session_meta", 0, 0, metaP("th-a", { session_id: "s-a" })), ln("token_usage_record", 1, 1, turP("ra", "th-a", "T", usageP(10, 0, 0, 1, 0)))]);
    const b = raw("pt-b", [
      ln("session_meta", 0, 0, metaP("th-b", { session_id: "s-b", parent_thread_id: "th-a" })),
      ln("token_usage_record", 1, 1, turP("rb", "th-b", "T", usageP(10, 0, 0, 1, 0))),
    ]);
    const r = await run([a, b]);
    assert.deepEqual(r.integrity.family_groups, []);
    assert.notEqual(familyMap(r).get("codex\u0000th-a"), familyMap(r).get("codex\u0000th-b"));
  });

  it("R4.11: a missing session_id, forked_from_id or history start is a value of its own", async () => {
    const mk = (a: object, b: object) => [
      raw("mv-1", [ln("session_meta", 0, 0, metaP("th-m", a)), ln("token_usage_record", 2, 2, turP("r1", "th-m", "T", usageP(10, 0, 0, 1, 0)))]),
      raw("mv-2", [ln("session_meta", 1, 1, metaP("th-m", b)), ln("token_usage_record", 3, 3, turP("r2", "th-m", "T", usageP(10, 0, 0, 1, 0)))]),
    ];
    const cases: Array<[string, object, object]> = [
      ["session_id", { session_id: "s-1" }, { session_id: undefined }],
      ["forked_from_id", { forked_from_id: "th-par", subagent_history_start_ordinal: 1 }, { subagent_history_start_ordinal: 1 }],
      ["history start", { forked_from_id: "th-par", subagent_history_start_ordinal: 1 }, { forked_from_id: "th-par" }],
    ];
    for (const [what, a, b] of cases) {
      const r = await run(mk(a, b));
      assert.deepEqual(namesOf(r, "stream_unresolved"), ["th-m"], what);
    }
    // the same values in both are no conflict
    const same = await run(mk({ session_id: "s-1" }, { session_id: "s-1" }));
    assert.deepEqual(namesOf(same, "stream_unresolved"), []);
  });

  it("R15.7: request-level triggers and excluded records exist only for supported-version threads; an unverified thread gets version_unverified only", async () => {
    const f = raw("uv", [
      ln("session_meta", 0, 0, metaP("th-old", { cli_version: "0.1.0" })),
      ln("token_usage_record", 1, 1, turP(null, "th-old", "T", usageP(10, 0, 0, 1, 0))), // unkeyed
      ln("token_usage_record", 2, 2, turP("dup", "th-old", "T", usageP(10, 0, 0, 1, 0))),
      ln("token_usage_record", 3, 3, turP("dup", "th-old", "T", usageP(20, 0, 0, 1, 0))), // conflicting copy
      ln("token_usage_record", 4, 4, turP("bad", "th-old", "T", usageP(10, 5, 0, 1, 0, 99))), // invariant failure
    ]);
    const r = await run([f]);
    assert.deepEqual(r.integrity.triggers.map((t) => t.reason), ["version_unverified"]);
    assert.deepEqual(r.excluded, []);
    assert.deepEqual(r.responses, []);
    assert.deepEqual(r.conflicts, []);
    assert.equal(r.coverage.requests_conflict, 0);
    assert.equal(r.coverage.responses_usage_invariant_failed, 0);
    assert.equal(r.coverage.records_unkeyed, 0);
    assert.equal(r.coverage.records_usage_bearing, 0);
    assert.equal(r.coverage.lines_unverified_version, 4);
    assert.equal(r.coverage.requests_unverified_version, 2); // distinct keys of keyed records
    assert.ok(r.assumptions.includes("unverified_version"));
  });

  it("R15.7: the unverified_version assumption holds whenever an unverified chain exists, even one without a keyed request or usage line", async () => {
    const r = await run([raw("uv2", [ln("session_meta", 0, 0, metaP("th-old2", { cli_version: "0.1.0" }))])]);
    assert.equal(r.coverage.requests_unverified_version, 0);
    assert.equal(r.coverage.lines_unverified_version, 0);
    assert.ok(r.assumptions.includes("unverified_version"));
    const clean = await run([raw("uv3", [ln("session_meta", 0, 0, metaP("th-ok2"))])]);
    assert.ok(!clean.assumptions.includes("unverified_version"));
  });

  it("R2.13: a usage record without a thread_id counts as usage-bearing and unkeyed, not unmappable, and taints every Codex chain", async () => {
    const f = raw("nothr", [
      ln("session_meta", 0, 0, metaP("th-k")),
      ln("token_usage_record", 1, 1, turP("rk", "th-k", "T", usageP(10, 0, 0, 1, 0))),
      // no thread_id, and an incomplete usage object that would be unmappable if it had a thread
      ln("token_usage_record", 2, 2, { response_id: "rz", session_id: "s", turn_id: "T", usage: { input_tokens: 5 } }),
    ]);
    const r = await run([f]);
    assert.equal(r.coverage.records_usage_bearing, 2);
    assert.equal(r.coverage.records_unkeyed, 1);
    assert.equal(r.coverage.records_usage_unmappable, 0);
    assert.deepEqual(namesOf(r, "unattributed_record"), ["provider"]);
    assert.deepEqual(reasonList(r, "th-k"), ["unattributed_record"]);
    assert.deepEqual(r.excluded, []);
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
