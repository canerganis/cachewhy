// Metamorphic tests of the whole accounting pipeline (spec R4.10, R17.6, R17.7, R0.9, R2.17), over every R0.9 and
// R2.17 fixture of test/fixtures/r09.ts (exact stored expectations at every split position) and over the committed
// synthetic trees (the generic rules only). All data is synthetic. The run start is injected (R0.9): it is the
// `now_ms` of analyze(), never an environment variable or a flag.
//
// What is checked, per scan:
//   ops 1 to 4 (line shuffle, file shuffle, key reorder, line duplication): the semantic output is unchanged, every
//     physical counter is unchanged except the exact change that the table of R17.6 states for a duplicated line;
//   op 5 (split at every line boundary that R4.10 allows):
//     - a split that is not dissolving: tainted chains grow, verified models and priced responses only shrink with
//       equal values, tokens are identical, and the direction and conservation rules of R17.7 hold;
//     - a dissolving split: the record-set guarantees of R4.10 only;
//     - for the fixtures: the stored expectation of that position, compared exactly.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { scenarios } from "../../scripts/gen-fixtures.ts";
import { analyze, type Analysis } from "../../src/analyze.js";
import { discover, type DiscoveredFile } from "../../src/discover.js";
import { PHYSICAL_COVERAGE_COUNTERS, PROVIDERS, TAINT_REASONS, chainIdOf, countsInTotals, responseTokens } from "../../src/model/types.js";
import type { CoverageCounters, ModelSource, Provider, TaintReason } from "../../src/model/types.js";
import { writeFiles, type GeneratedFile } from "../fixtures/builder.ts";
import {
  duplicateLine,
  isDissolving,
  isLogFile,
  lineCount,
  reserializeReversedKeys,
  shuffleFiles,
  shuffleLines,
  splitAt,
  splitPositions,
  splitTail,
  splitView,
} from "../fixtures/metamorphic.ts";
import { OLD_MTIME_MS, RUN_START_MS, allR09Fixtures, expectAt, type R09Expect, type R09Fixture } from "../fixtures/r09.ts";

// ---------------------------------------------------------------------------
// running a scan and summarizing it
// ---------------------------------------------------------------------------

async function scan(files: readonly GeneratedFile[], order?: (xs: DiscoveredFile[]) => DiscoveredFile[]): Promise<Analysis> {
  const dir = mkdtempSync(join(tmpdir(), "cw-meta-"));
  try {
    writeFiles(dir, files);
    const found = await discover({ claudeDirs: [join(dir, "projects")], codexDirs: [dir], env: {}, home: dir });
    const list = order === undefined ? found.files : order(found.files);
    return await analyze(list, { now_ms: RUN_START_MS, codex_tier_for_test: "standard" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Row {
  readonly provider: Provider;
  readonly key: string;
  readonly tokens: bigint;
  readonly counted: boolean;
  readonly source: ModelSource;
  readonly model: string | null;
  readonly verified: boolean;
  readonly pico: bigint | null;
  readonly reason: string | null;
  readonly tainted: boolean;
}

interface Totals {
  tokens: bigint;
  counted: number;
  priced: number;
  tokens_unpriced: bigint;
  in_tainted: number;
  tokens_in_tainted: bigint;
  unpriced_tainted: number;
  unknown_model: number;
  model_unverified: number;
  /** R3.9 revision 11.1: unpriced tokens by the reason of the first refusing gate. */
  by_reason: Record<string, bigint>;
}

interface Summary {
  readonly chains: Map<string, readonly TaintReason[]>;
  readonly families: Map<string, number>;
  readonly rows: Map<string, Row>;
  readonly totals: Record<Provider, Totals>;
  readonly graph: Record<Provider, { chains_total: number; families_total: number; chains_tainted: number; families_tainted: number; by_reason: Record<TaintReason, number>; live: { families: number; responses: number; tokens: bigint } }>;
  readonly links: Record<Provider, string>;
  readonly parsed: Record<Provider, CoverageCounters>;
}

function summarize(a: Analysis): Summary {
  const g = a.graph;
  const rows = new Map<string, Row>();
  const totals = {} as Record<Provider, Totals>;
  for (const p of PROVIDERS) {
    totals[p] = { tokens: 0n, counted: 0, priced: 0, tokens_unpriced: 0n, in_tainted: 0, tokens_in_tainted: 0n, unpriced_tainted: 0, unknown_model: 0, model_unverified: 0, by_reason: {} };
  }
  g.responses.forEach((r, i) => {
    const node = g.nodes[i] as (typeof g.nodes)[number];
    const chain = g.chains[node.chain] as (typeof g.chains)[number];
    const pr = a.priced[i] as (typeof a.priced)[number];
    const counted = node.in_window && countsInTotals(r);
    const tokens = r.usage === null ? 0n : responseTokens(r.usage);
    const row: Row = {
      provider: r.provider,
      key: r.key,
      tokens,
      counted,
      source: r.model.source,
      model: r.model.model,
      verified: r.model.verified,
      pico: pr.cost.pico,
      reason: pr.cost.reason,
      tainted: chain.tainted,
    };
    rows.set(`${chainIdOf(r.chain)}\u0001${r.key}`, row);
    if (!counted) return;
    const t = totals[r.provider];
    t.counted++;
    t.tokens += tokens;
    if (row.pico !== null) t.priced++;
    else {
      t.tokens_unpriced += tokens;
      const why = pr.modifier_reason ?? pr.cost.reason ?? "excluded";
      t.by_reason[why] = (t.by_reason[why] ?? 0n) + tokens;
    }
    if (row.tainted) {
      t.in_tainted++;
      t.tokens_in_tainted += tokens;
    }
    if (row.reason === "chain_tainted") t.unpriced_tainted++;
    if (row.reason === "unknown_model") t.unknown_model++;
    if (!row.verified) t.model_unverified++;
  });
  const chains = new Map<string, readonly TaintReason[]>();
  const families = new Map<string, number>();
  const graph = {} as Summary["graph"];
  const links = {} as Summary["links"];
  for (const p of PROVIDERS) {
    for (const [id, ct] of g.taint[p].chains) {
      families.set(id, ct.family);
      if (!ct.live) chains.set(id, ct.reasons);
    }
    const c = g.coverage_by_provider[p];
    graph[p] = {
      chains_total: c.chains_total,
      families_total: c.families_total,
      chains_tainted: c.chains_tainted,
      families_tainted: c.families_tainted,
      by_reason: { ...c.chains_tainted_by_reason },
      live: { families: c.families_live_skipped, responses: c.responses_live_skipped, tokens: c.tokens_live_skipped },
    };
    links[p] = JSON.stringify([c.links_verified, c.links_directory_only, c.links_unlinked, c.links_unlinked_by_reason]);
  }
  const parsed = { claude: (a.claude as NonNullable<Analysis["claude"]>).coverage, codex: (a.codex as NonNullable<Analysis["codex"]>).coverage };
  return { chains, families, rows, totals, graph, links, parsed };
}

const keyOf = (r: Row): string => r.key;

/** Logical counters of the parsers (R17.6) as a comparable string: every counter that is not physical. */
function logicalCounters(c: CoverageCounters): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) {
    // `versions` is a map of line counts per version label: a line statistic, not a logical counter of R17.6.
    if (k === "versions" || PHYSICAL_COVERAGE_COUNTERS.has(k as never)) continue;
    out[k] = v;
  }
  return JSON.stringify(out, (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v));
}

function physicalCounters(c: CoverageCounters): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of PHYSICAL_COVERAGE_COUNTERS) out[k] = c[k];
  return out;
}

function plain(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (x instanceof Map ? [...x.entries()] : typeof x === "bigint" ? `${x}n` : x));
}

/** The semantic output as one comparable value: taint, models, dollars, totals, logical counters, live counters. */
function semantic(s: Summary): string {
  return plain({
    chains: [...s.chains.entries()].sort(),
    rows: [...s.rows.entries()].sort(),
    totals: s.totals,
    graph: s.graph,
    links: s.links,
    logical: { claude: logicalCounters(s.parsed.claude), codex: logicalCounters(s.parsed.codex) },
  });
}

// ---------------------------------------------------------------------------
// the stored expectation of a fixture
// ---------------------------------------------------------------------------

function assertExpect(s: Summary, e: R09Expect, label: string): void {
  const chains: Record<string, readonly TaintReason[]> = {};
  for (const [id, r] of [...s.chains.entries()].sort()) chains[id] = r;
  assert.deepEqual(chains, Object.fromEntries(Object.entries(e.chains).sort()), `${label}: chain taint reasons`);
  const sources: Record<string, ModelSource> = {};
  const verified: Record<string, string> = {};
  for (const r of s.rows.values()) {
    if (!r.counted) continue;
    sources[keyOf(r)] = r.source;
    if (r.verified && r.model !== null) verified[keyOf(r)] = r.model;
  }
  assert.deepEqual(sortObj(sources), sortObj(e.sources), `${label}: model_source`);
  assert.deepEqual(sortObj(verified), sortObj(e.verified), `${label}: verified models`);
  assert.equal(s.totals.claude.tokens, e.tokens.claude, `${label}: claude tokens`);
  assert.equal(s.totals.codex.tokens, e.tokens.codex, `${label}: codex tokens`);
  for (const p of PROVIDERS) {
    const live = e.live?.[p];
    assert.deepEqual(
      s.graph[p].live,
      live === undefined ? { families: 0, responses: 0, tokens: 0n } : { families: live.families, responses: live.responses, tokens: live.tokens },
      `${label}: ${p} live counters`,
    );
  }
  // R0.9 effect 2: a response of a tainted chain is unpriced with reason chain_tainted; the priced set is the verified set.
  for (const r of s.rows.values()) {
    if (!r.counted) continue;
    if (r.tainted) {
      assert.equal(r.pico, null, `${label}: a tainted response has no dollars`);
      assert.equal(r.reason, "chain_tainted", `${label}: unpriced reason of a tainted response`);
    } else {
      assert.equal(r.pico !== null, r.verified, `${label}: priced iff verified (${keyOf(r)})`);
    }
  }
  // chain counters agree with the reasons (R0.9 coverage)
  for (const p of PROVIDERS) {
    const mine = [...s.chains.entries()].filter(([id]) => id.startsWith(`${p}\u0000`));
    assert.equal(s.graph[p].chains_total, mine.length, `${label}: ${p} chains_total`);
    assert.equal(s.graph[p].chains_tainted, mine.filter(([, r]) => r.length > 0).length, `${label}: ${p} chains_tainted`);
    for (const reason of TAINT_REASONS) {
      assert.equal(s.graph[p].by_reason[reason], mine.filter(([, r]) => r.includes(reason)).length, `${label}: ${p} chains_tainted_by_reason.${reason}`);
    }
  }
  if (e.counters !== undefined) {
    assert.equal(s.parsed.codex.files_without_response_id, e.counters.files_without_response_id, `${label}: files_without_response_id`);
    assert.equal(s.parsed.codex.token_count_events_without_response_id, e.counters.token_count_events_without_response_id, `${label}: token_count_events_without_response_id`);
  }
}

function sortObj<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// ---------------------------------------------------------------------------
// R17.7 and R4.10 rules between an unsplit and a split scan
// ---------------------------------------------------------------------------

function assertSplitRules(base: Summary, split: Summary, label: string): void {
  // Taint monotonicity (R4.10): every tainted chain stays tainted, with at least its reasons.
  for (const [id, reasons] of base.chains) {
    const after = split.chains.get(id);
    assert.ok(after !== undefined, `${label}: chain kept`);
    for (const r of reasons) assert.ok(after.includes(r), `${label}: reason ${r} of a chain is not withdrawn`);
  }
  assert.equal(split.chains.size, base.chains.size, `${label}: chains_total unchanged`);
  // Identical per-response accounting: same responses, same tokens, same counted flag.
  assert.deepEqual([...split.rows.keys()].sort(), [...base.rows.keys()].sort(), `${label}: same responses`);
  for (const [k, row] of base.rows) {
    const after = split.rows.get(k) as Row;
    assert.equal(after.tokens, row.tokens, `${label}: tokens of a response`);
    assert.equal(after.counted, row.counted, `${label}: counted flag`);
    // Split monotonicity: verified and priced responses only shrink, with equal values on the common part.
    if (after.verified) {
      assert.ok(row.verified, `${label}: a split gains no verified model`);
      assert.equal(after.model, row.model);
    }
    if (after.pico !== null) {
      assert.equal(after.pico, row.pico, `${label}: a split gains no dollars and changes none`);
    }
    if (!row.tainted) {
      // A chain that stays untainted keeps exactly its unsplit output.
    }
  }
  for (const p of PROVIDERS) {
    const b = base.totals[p];
    const a = split.totals[p];
    // direction (R17.7)
    assert.ok(a.in_tainted >= b.in_tainted, `${label}: ${p} responses_in_tainted_chains may only increase`);
    assert.ok(a.tokens_in_tainted >= b.tokens_in_tainted, `${label}: ${p} tokens_in_tainted_chains may only increase`);
    assert.ok(a.unpriced_tainted >= b.unpriced_tainted, `${label}: ${p} requests_unpriced_tainted may only increase`);
    assert.ok(a.tokens_unpriced >= b.tokens_unpriced, `${label}: ${p} tokens_unpriced may only increase`);
    assert.ok(a.model_unverified >= b.model_unverified, `${label}: ${p} responses_model_unverified may only increase`);
    assert.ok(a.priced <= b.priced, `${label}: ${p} requests_priced may only decrease`);
    // R17.7 revision 11.1: the chain_tainted amount may only increase, every other reason amount may only decrease
    assert.ok((a.by_reason["chain_tainted"] ?? 0n) >= (b.by_reason["chain_tainted"] ?? 0n), `${label}: ${p} tokens_unpriced_by_reason.chain_tainted may only increase`);
    for (const k of new Set([...Object.keys(a.by_reason), ...Object.keys(b.by_reason)])) {
      if (k === "chain_tainted") continue;
      assert.ok((a.by_reason[k] ?? 0n) <= (b.by_reason[k] ?? 0n), `${label}: ${p} tokens_unpriced_by_reason.${k} may only decrease`);
    }
    assert.ok(a.unknown_model <= b.unknown_model, `${label}: ${p} requests_unknown_model may only decrease`);
    // conservation
    assert.equal(a.tokens, b.tokens, `${label}: ${p} token total`);
    assert.equal(a.counted, b.counted, `${label}: ${p} counted responses`);
    assert.equal(a.tokens_unpriced + sumPriced(split, p), b.tokens_unpriced + sumPriced(base, p), `${label}: ${p} priced plus unpriced tokens`);
    const g0 = base.graph[p];
    const g1 = split.graph[p];
    assert.ok(g1.chains_tainted >= g0.chains_tainted, `${label}: ${p} chains_tainted may only increase`);
    assert.ok(g1.families_tainted >= g0.families_tainted, `${label}: ${p} families_tainted may only increase`);
    for (const r of TAINT_REASONS) assert.ok(g1.by_reason[r] >= g0.by_reason[r], `${label}: ${p} reason count ${r} may only increase`);
    assert.equal(g1.chains_total, g0.chains_total, `${label}: ${p} chains_total`);
    assert.equal(g1.families_total, g0.families_total, `${label}: ${p} families_total`);
    assert.deepEqual(g1.live, g0.live, `${label}: ${p} live counters`);
    assert.equal(split.links[p], base.links[p], `${label}: ${p} links_*`);
    for (const f of ["requests_total", "responses_total", "requests_conflict", "requests_unverified_version"] as const) {
      assert.equal(split.parsed[p][f], base.parsed[p][f], `${label}: ${p} ${f}`);
    }
  }
  // A split that taints no new chain gives identical output, except the physical counters (R4.10 invariance).
  const grew = [...split.chains].some(([id, r]) => r.length > (base.chains.get(id) as readonly TaintReason[]).length);
  if (!grew) assert.equal(semantic(split), semantic(base), `${label}: a split that taints no new chain changes nothing`);
  // Physical line counters never change under a split (R17.6).
  for (const p of PROVIDERS) {
    const b = physicalCounters(base.parsed[p]);
    const a = physicalCounters(split.parsed[p]);
    for (const k of ["lines_total", "lines_parse_error", "lines_truncated_tail", "known_type_count", "unlisted_type_count", "lines_duplicate_collapsed", "duplicate_records_collapsed", "lines_unverified_version"]) {
      assert.equal(a[k], b[k], `${label}: ${p} ${k} is a line counter and a split does not change it`);
    }
  }
}

function sumPriced(s: Summary, p: Provider): bigint {
  let n = 0n;
  for (const r of s.rows.values()) if (r.counted && r.provider === p && r.pico !== null) n += r.tokens;
  return n;
}

/** R4.10: what a dissolving split must still keep (the record-set guarantees). */
function assertDissolving(base: Summary, split: Summary, label: string): void {
  assert.deepEqual([...split.rows.keys()].sort(), [...base.rows.keys()].sort(), `${label}: same responses`);
  for (const [k, row] of base.rows) {
    const after = split.rows.get(k) as Row;
    assert.equal(after.tokens, row.tokens, `${label}: tokens of a response`);
    assert.equal(after.counted, row.counted, `${label}: counted flag`);
  }
  for (const p of PROVIDERS) assert.equal(split.totals[p].tokens, base.totals[p].tokens, `${label}: ${p} token total`);
  const recordSet: TaintReason[] = ["turn_model_conflicted", "request_anomaly", "ownership_ambiguous", "version_unverified", "unattributed_record", "file_unreadable"];
  for (const [id, reasons] of base.chains) {
    const after = split.chains.get(id) as readonly TaintReason[];
    for (const r of reasons) if (recordSet.includes(r)) assert.ok(after.includes(r), `${label}: record-set reason ${r} stays`);
  }
}

// ---------------------------------------------------------------------------
// the operations as test drivers
// ---------------------------------------------------------------------------

type Prov = "claude" | "codex";
const provOf = (f: GeneratedFile): Prov => (f.path.startsWith("projects/") ? "claude" : "codex");

function replaceFile(files: readonly GeneratedFile[], old: GeneratedFile, next: readonly GeneratedFile[]): GeneratedFile[] {
  const out: GeneratedFile[] = [];
  for (const f of files) {
    if (f === old) out.push(...next);
    else out.push(f);
  }
  return out;
}

const withMtime = (files: readonly GeneratedFile[]): GeneratedFile[] => files.map((f) => ({ ...f, mtimeMs: f.mtimeMs ?? OLD_MTIME_MS }));

/** Expected change of the physical counters for `k` extra copies of one line (R17.6 table). */
function assertDuplicateCounters(base: Summary, dup: Summary, line: string, k: number, hadExtra: boolean, inTail: boolean, label: string): void {
  for (const p of PROVIDERS) {
    const b = base.parsed[p];
    const a = dup.parsed[p];
    const delta = (f: keyof CoverageCounters): number => (a[f] as number) - (b[f] as number);
    let parsed = false;
    try {
      const v: unknown = JSON.parse(line);
      parsed = v !== null && typeof v === "object";
    } catch {
      parsed = false;
    }
    const touched = delta("lines_total") !== 0;
    if (!touched) {
      for (const f of PHYSICAL_COVERAGE_COUNTERS) assert.equal(delta(f), 0, `${label}: ${p} ${f} untouched provider`);
      continue;
    }
    assert.equal(delta("lines_total"), k, `${label}: ${p} lines_total`);
    if (!parsed || inTail) {
      assert.equal(delta("lines_parse_error"), k, `${label}: ${p} lines_parse_error`);
      for (const f of ["lines_duplicate_collapsed", "duplicate_records_collapsed", "known_type_count", "unlisted_type_count", "lines_unverified_version"] as const) {
        assert.equal(delta(f), 0, `${label}: ${p} ${f} for a line that fails to parse`);
      }
    } else {
      assert.equal(delta("lines_parse_error"), 0);
      assert.equal(delta("lines_duplicate_collapsed"), k, `${label}: ${p} lines_duplicate_collapsed`);
      assert.equal(delta("duplicate_records_collapsed"), hadExtra ? 0 : 1, `${label}: ${p} duplicate_records_collapsed`);
      assert.equal(delta("known_type_count") + delta("unlisted_type_count"), k, `${label}: ${p} type count`);
      assert.ok([0, k].includes(delta("lines_unverified_version")), `${label}: ${p} lines_unverified_version`);
      assert.ok([0, k].includes(delta("token_count_events_without_response_id")), `${label}: ${p} token_count events`);
    }
    for (const f of PHYSICAL_COVERAGE_COUNTERS) {
      if (["lines_total", "lines_parse_error", "lines_duplicate_collapsed", "duplicate_records_collapsed", "known_type_count", "unlisted_type_count", "lines_unverified_version", "token_count_events_without_response_id", "lines_truncated_tail"].includes(f)) continue;
      assert.equal(delta(f), 0, `${label}: ${p} ${f} is unchanged by a duplicated line`);
    }
  }
}

interface ScanSpec {
  readonly label: string;
  readonly files: GeneratedFile[];
  readonly splittable: readonly string[];
}

/** Ops 1 to 4 on one scan. `base` is the summary of the unsplit scan. */
async function checkOps(spec: ScanSpec, base: Summary, dupStride: number): Promise<void> {
  const same = (s: Summary, label: string): void => {
    assert.equal(semantic(s), semantic(base), `${spec.label}: ${label} changes the semantic output`);
    for (const p of PROVIDERS) assert.deepEqual(physicalCounters(s.parsed[p]), physicalCounters(base.parsed[p]), `${spec.label}: ${label} changes a physical counter`);
  };
  // op 1: line shuffles
  for (const seed of [11, 12]) same(summarize(await scan(spec.files.map((f, i) => shuffleLines(f, seed * 100 + i)))), `line shuffle ${seed}`);
  // op 2: file order
  for (const seed of [21, 22]) same(summarize(await scan(spec.files, (xs) => shuffleFiles(xs, seed))), `file shuffle ${seed}`);
  same(summarize(await scan(spec.files, (xs) => [...xs].reverse())), "file order reversed");
  // op 4: key order
  same(summarize(await scan(spec.files.map((f) => reserializeReversedKeys(f)))), "key reorder");
  // op 3: line duplication, k = 1 and 3, on every stride-th line of every log file
  let n = 0;
  for (const file of spec.files) {
    if (!isLogFile(file)) continue;
    const { lines, tail } = splitTail(file.content as string);
    const all = tail === null ? lines : [...lines, tail];
    const texts = new Map<string, number>();
    for (const f of spec.files) {
      if (!isLogFile(f)) continue;
      const t = splitTail(f.content as string);
      for (const l of t.lines) texts.set(l, (texts.get(l) ?? 0) + 1);
    }
    for (let idx = 0; idx < all.length; idx++) {
      if (n++ % dupStride !== 0) continue;
      const k = idx % 2 === 0 ? 1 : 3;
      const dup = summarize(await scan(replaceFile(spec.files, file, [duplicateLine(file, idx, k)])));
      const label = `${spec.label}: duplicate line ${idx} x${k} of ${file.path.split("/").pop()}`;
      assert.equal(semantic(dup), semantic(base), `${label}: semantic output`);
      const line = all[idx] as string;
      assertDuplicateCounters(base, dup, line, k, (texts.get(line) ?? 0) > 1, tail !== null && idx === all.length - 1, label);
    }
  }
}

/** Op 5 on every splittable file at every allowed boundary. */
async function checkSplits(spec: ScanSpec, base: Summary, fx: R09Fixture | null): Promise<number> {
  let runs = 0;
  for (const path of spec.splittable) {
    const file = spec.files.find((f) => f.path === path) as GeneratedFile;
    const prov = provOf(file);
    const unsplitView = splitView(file.content as string, prov);
    for (const at of splitPositions(file, prov)) {
      const halves = splitAt(file, at, prov) as [GeneratedFile, GeneratedFile];
      const label = `${spec.label}: ${path.split("/").pop()} split at ${at}`;
      const split = summarize(await scan(replaceFile(spec.files, file, halves)));
      const views = [splitView(halves[0].content as string, prov), splitView(halves[1].content as string, prov)] as const;
      const dissolving = isDissolving(unsplitView, views, (id) => base.families.get(id));
      if (dissolving) assertDissolving(base, split, label);
      else assertSplitRules(base, split, label);
      assert.equal(split.parsed[prov].files_total, base.parsed[prov].files_total + 1, `${label}: files_total`);
      if (fx !== null) {
        const stored = expectAt(fx, path, at);
        if (stored.dissolving !== null) assert.equal(dissolving, stored.dissolving, `${label}: dissolving flag`);
        assertExpect(split, stored.expect, label);
      }
      runs++;
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// suites
// ---------------------------------------------------------------------------

describe("R0.9 and R2.17 fixtures through the whole pipeline", () => {
  for (const fx of allR09Fixtures()) {
    const spec: ScanSpec = { label: fx.name, files: withMtime(fx.files), splittable: fx.splittable };
    describe(fx.name, () => {
      it(`unsplit scan matches the stored expectation (${fx.rules})`, async () => {
        assertExpect(summarize(await scan(spec.files)), fx.expect, fx.name);
      });
      it("ops 1 to 4 (R4.10) leave the semantic output unchanged and change the physical counters only as R17.6 states", async () => {
        await checkOps(spec, summarize(await scan(spec.files)), 1);
      });
      it("op 5: every allowed split position matches its stored result and the R17.7 rules", async () => {
        const base = summarize(await scan(spec.files));
        assertExpect(base, fx.expect, fx.name);
        const runs = await checkSplits(spec, base, fx);
        assert.ok(runs > 0 || spec.splittable.length === 0 || fx.name === "r09-1b", `${fx.name}: at least one split position`);
      });
    });
  }

  it("R0.9 fixture (6): the clean family's models, priced set and dollars equal a scan of the clean family alone", async () => {
    const fx = allR09Fixtures().find((f) => f.name === "r09-6") as R09Fixture;
    const full = summarize(await scan(withMtime(fx.files)));
    const alone = summarize(await scan(withMtime((fx.clean_only as NonNullable<R09Fixture["clean_only"]>).files)));
    const clean = new Set((fx.clean_only as NonNullable<R09Fixture["clean_only"]>).chains);
    const project = (s: Summary): [string, Row][] => [...s.rows.entries()].filter(([k]) => clean.has(k.split("\u0001")[0] as string)).sort(([a], [b]) => (a < b ? -1 : 1));
    assert.deepEqual(plain(project(full)), plain(project(alone)));
    assert.ok(project(full).length > 0);
    assert.ok(project(full).every(([, r]) => r.verified && r.pico !== null));
    for (const id of clean) assert.deepEqual(full.chains.get(id), []);
  });
});

describe("committed synthetic trees", () => {
  for (const sc of scenarios) {
    const built = withMtime(sc.build());
    const spec: ScanSpec = {
      label: sc.name,
      files: built,
      splittable: built.filter((f) => isLogFile(f) && lineCount(f) > 1).map((f) => f.path),
    };
    describe(sc.name, () => {
      it("ops 1 to 4 leave the semantic output unchanged", async () => {
        await checkOps(spec, summarize(await scan(spec.files)), 4);
      });
      it("op 5: every allowed split of every file satisfies the R4.10 and R17.7 rules", async () => {
        await checkSplits(spec, summarize(await scan(spec.files)), null);
      });
    });
  }
});

describe("a split whose halves are both renamed (R17.7 links_*)", () => {
  // A Claude agent file is bound to its meta.json through the logical chain (the sessionId and agentId of its records,
  // R4.11, R5.3), not through the name of a physical file. Splitting an agent file into two files with new names leaves
  // no file with the agent's name, and R17.7 says the links_* counters do not change under a split.
  it("links_* do not change when both halves of an agent file get new names", async () => {
    const sc = scenarios.find((s) => s.name === "claude-basic") as (typeof scenarios)[number];
    const files = withMtime(sc.build());
    const base = summarize(await scan(files));
    const file = files.find((f) => f.path.endsWith("agent-synthetic-agent-0001.jsonl")) as GeneratedFile;
    const halves = splitAt(file, 1, "claude", "renamed") as [GeneratedFile, GeneratedFile];
    const split = summarize(await scan(replaceFile(files, file, halves)));
    assert.equal(split.links.claude, base.links.claude);
    assert.ok(JSON.parse(base.links.claude)[0] >= 1, "the unsplit scan has a verified link, so the comparison is not vacuous");
  });
});
