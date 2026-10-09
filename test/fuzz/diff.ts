// Runs src/ and scripts/recompute on one fuzz scan and compares everything both expose (spec R13.1, R13.2). Used by
// test/differential-fuzz.test.ts and by local triage scripts. All data is synthetic.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recompute, type RecomputeResult } from "../../scripts/recompute/index.mjs";
import { analyze } from "../../src/analyze.ts";
import { discover } from "../../src/discover.ts";
import { countedResponseIndices } from "../../src/graph/index.ts";
import { chainIdOf } from "../../src/model/types.ts";
import type { Provider } from "../../src/model/types.ts";
import { buildReportInput } from "../../src/report/input.ts";
import { writeFiles } from "../fixtures/builder.ts";
import { RUN_START_MS } from "../fixtures/r09.ts";
import { generateScan, knobsFor, windowFor, type FuzzScan, type Knobs, type WindowSpec } from "./gen.ts";

export interface Diff {
  path: string;
  src: unknown;
  rec: unknown;
}

const PROVIDERS: readonly Provider[] = ["claude", "codex"];

function show(v: unknown): string {
  if (v === undefined) return "undefined";
  if (typeof v === "bigint") return `${v}n`;
  try {
    return JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${x}n` : x));
  } catch {
    return String(v);
  }
}

export function formatDiff(d: Diff): string {
  return `${d.path}: src=${show(d.src)} recompute=${show(d.rec)}`;
}

const isZeroLike = (v: unknown): boolean =>
  v === undefined || v === null || v === 0 || v === "0" || v === false || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

function norm(v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

/** Deep comparison. A key that only one side has is ignored when its value is zero-like (sparse count maps). */
export function deepDiff(a: unknown, b: unknown, path: string, out: Diff[], commonOnly = false): void {
  const x = norm(a);
  const y = norm(b);
  if (x !== null && y !== null && typeof x === "object" && typeof y === "object" && Array.isArray(x) === Array.isArray(y)) {
    if (Array.isArray(x) && Array.isArray(y)) {
      const n = Math.max(x.length, y.length);
      for (let i = 0; i < n; i++) deepDiff(x[i], y[i], `${path}[${i}]`, out);
      return;
    }
    const ox = x as Record<string, unknown>;
    const oy = y as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(ox), ...Object.keys(oy)])].sort();
    for (const k of keys) {
      const inX = k in ox;
      const inY = k in oy;
      if (commonOnly && !(inX && inY)) continue;
      if (inX && inY) deepDiff(ox[k], oy[k], `${path}.${k}`, out);
      else if (!isZeroLike(inX ? ox[k] : oy[k])) out.push({ path: `${path}.${k}`, src: inX ? norm(ox[k]) : "<absent>", rec: inY ? norm(oy[k]) : "<absent>" });
    }
    return;
  }
  if (x !== y) out.push({ path, src: x, rec: y });
}

export interface RunOptions extends WindowSpec {
  tier?: boolean;
}

export interface BothResult {
  diffs: Diff[];
  /** Raw analysis results, for triage. */
  src?: { view: ReturnType<typeof buildReportInput>; analysis: Awaited<ReturnType<typeof analyze>> };
  rec?: RecomputeResult;
}

/** The run start and the file modification times are injected: every scan uses the same RUN_START_MS. */
export async function runBoth(scan: FuzzScan, opts: RunOptions): Promise<BothResult> {
  const dir = mkdtempSync(join(tmpdir(), "cw-fuzz-"));
  const diffs: Diff[] = [];
  try {
    writeFiles(dir, scan.files);
    let analysis: Awaited<ReturnType<typeof analyze>> | undefined;
    let view: ReturnType<typeof buildReportInput> | undefined;
    let rec: RecomputeResult | undefined;
    try {
      const found = await discover({ claudeDirs: [join(dir, "projects")], codexDirs: [dir], env: {}, home: dir });
      analysis = await analyze(found.files, { since: opts.since, until: opts.until, now_ms: RUN_START_MS, codex_tier_for_test: opts.tier ? "standard" : undefined });
      view = buildReportInput({
        graph: analysis.graph,
        parsed: analysis.parsed,
        priced: analysis.priced,
        detection: analysis.detection,
        book: analysis.book,
        options: { command: "default", json: false, show_ids: false, demo: false, color: false },
        generated_at_ms: RUN_START_MS,
        tool_version: "fuzz",
      });
    } catch (e) {
      diffs.push({ path: "<crash>", src: e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : String(e), rec: "<not run>" });
    }
    try {
      rec = recompute({
        claudeDirs: [join(dir, "projects")],
        codexDirs: [dir],
        since: opts.since ?? null,
        until: opts.until ?? new Date(RUN_START_MS).toISOString(),
        codexTierForTest: opts.tier ? "standard" : undefined,
        runStartMs: RUN_START_MS,
      });
    } catch (e) {
      diffs.push({ path: "<crash>", src: "<not run>", rec: e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : String(e) });
    }
    if (analysis && view && rec) compare(analysis, view, rec, diffs);
    return { diffs, src: analysis && view ? { view, analysis } : undefined, rec };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function compare(analysis: Awaited<ReturnType<typeof analyze>>, view: ReturnType<typeof buildReportInput>, rec: RecomputeResult, out: Diff[]): void {
  const g = analysis.graph;
  // ---- per response (counted set) ------------------------------------------------------------------------------
  const recBy = new Map(rec.responses.filter((r) => r.counted).map((r) => [`${r.provider}:${r.key}`, r]));
  const srcKeys = new Set<string>();
  const srcUnpriced: Record<Provider, Map<string, { responses: number; tokens_unpriced: bigint }>> = { claude: new Map(), codex: new Map() };
  const srcByKind: Record<Provider, Map<string, number>> = { claude: new Map(), codex: new Map() };
  for (const i of countedResponseIndices(g)) {
    const r = g.responses[i]!;
    const p = analysis.priced[i]!;
    const id = `${r.provider}:${r.key}`;
    srcKeys.add(id);
    const x = recBy.get(id);
    const at = `response[${id}]`;
    const reason = p.cost.pico === null ? (p.modifier_reason ?? p.cost.reason) : null;
    if (p.cost.pico === null) {
      const m = srcUnpriced[r.provider];
      const e = m.get(String(reason)) ?? { responses: 0, tokens_unpriced: 0n };
      e.responses += 1;
      e.tokens_unpriced += p.tokens_unpriced;
      m.set(String(reason), e);
    }
    srcByKind[r.provider].set(r.kind, (srcByKind[r.provider].get(r.kind) ?? 0) + 1);
    if (!x) {
      out.push({ path: `${at}.counted`, src: true, rec: "<not counted>" });
      continue;
    }
    const u = r.usage!;
    const b = x.buckets!;
    const srcRow = {
      buckets: { input_uncached: u.input_uncached, cache_read: u.cache_read, cache_write_5m: u.cache_write_5m, cache_write_1h: u.cache_write_1h, cache_write_unknown_ttl: u.cache_write_unknown_ttl, cache_write: u.cache_write, output: u.output, output_lower_bound: u.output_lower_bound },
      pico: p.cost.pico,
      reason,
      tokens_unpriced: p.cost.pico === null ? p.tokens_unpriced : 0n,
      kind: r.kind,
      model_source: r.model.source,
      model: r.model.verified ? r.model.model : null,
      tainted: g.taint[r.provider].chains.get(chainIdOf(r.chain))?.tainted ?? null,
      taint_reasons: [...(g.taint[r.provider].chains.get(chainIdOf(r.chain))?.reasons ?? [])],
    };
    const recRow = {
      buckets: { input_uncached: b.input_uncached, cache_read: b.cache_read, cache_write_5m: b.cache_write_5m, cache_write_1h: b.cache_write_1h, cache_write_unknown_ttl: b.cache_write_unknown_ttl, cache_write: b.cache_write, output: b.output, output_lower_bound: b.output_lower_bound },
      pico: x.price!.priced ? x.price!.pico : null,
      reason: x.price!.priced ? null : x.price!.reason,
      tokens_unpriced: x.price!.tokens_unpriced,
      kind: x.kind,
      model_source: x.model_source,
      model: ["own_turn", "carried_verified", "claude_explicit"].includes(String(x.model_source)) ? (x.model ?? null) : null,
      tainted: x.tainted,
      taint_reasons: x.taint_reasons,
    };
    deepDiff(srcRow, recRow, at, out);
  }
  for (const id of recBy.keys()) if (!srcKeys.has(id)) out.push({ path: `response[${id}].counted`, src: "<not counted>", rec: true });

  // ---- totals, per model, per kind, unpriced by reason ------------------------------------------------------------
  for (const p of PROVIDERS) {
    const t = view.totals.find((x) => x.provider === p)!;
    const rp = rec.providers[p];
    const srcTotals = {
      responses: t.requests_total,
      responses_priced: t.requests_priced,
      tokens: {
        input_uncached: t.tokens.input_uncached,
        cache_read: t.tokens.cache_read,
        cache_write_5m: t.tokens.cache_write_5m,
        cache_write_1h: t.tokens.cache_write_1h,
        cache_write_unknown_ttl: t.tokens.cache_write_unknown_ttl,
        cache_write: t.tokens.cache_write,
        output: t.tokens.output,
        output_lower_bound_unknown_output: t.tokens.output_lower_bound_unknown,
      },
      context_tokens: t.total_input,
      tokens_total: t.tokens_total,
      tokens_unpriced: t.tokens_unpriced,
      usd_pico: t.usd_pico ?? 0n,
    };
    const recTotals = { responses: rp.totals.responses, responses_priced: rp.totals.responses_priced, tokens: rp.totals.tokens, context_tokens: rp.totals.context_tokens, tokens_total: rp.totals.tokens_total, tokens_unpriced: rp.totals.tokens_unpriced, usd_pico: rp.totals.usd_pico };
    deepDiff(srcTotals, recTotals, `totals.${p}`, out);
    // per model: merge src rows by label
    const srcModels = new Map<string, { responses: number; responses_priced: number; tokens_unpriced: bigint; usd_pico: bigint; tokens_total: bigint; context_tokens: bigint }>();
    for (const m of t.models) {
      const label = m.model ?? "model_unknown";
      const e = srcModels.get(label) ?? { responses: 0, responses_priced: 0, tokens_unpriced: 0n, usd_pico: 0n, tokens_total: 0n, context_tokens: 0n };
      e.responses += m.responses;
      e.responses_priced += m.requests_priced;
      e.tokens_unpriced += m.tokens_unpriced;
      e.usd_pico += m.usd_pico ?? 0n;
      e.tokens_total += m.tokens_total;
      e.context_tokens += m.total_input;
      srcModels.set(label, e);
    }
    const recModels: Record<string, unknown> = {};
    for (const [label, a] of Object.entries(rp.by_model)) recModels[label] = { responses: a.responses, responses_priced: a.responses_priced, tokens_unpriced: a.tokens_unpriced, usd_pico: a.usd_pico, tokens_total: a.tokens_total, context_tokens: a.context_tokens };
    deepDiff(Object.fromEntries(srcModels), recModels, `by_model.${p}`, out);
    const kinds: Record<string, number> = {};
    for (const [k, n] of srcByKind[p]) kinds[k] = n;
    const recKinds: Record<string, number> = {};
    for (const [k, a] of Object.entries(rp.by_kind)) recKinds[k] = a.responses;
    deepDiff(kinds, recKinds, `by_kind.${p}`, out);
    const un: Record<string, unknown> = {};
    for (const [k, v] of srcUnpriced[p]) un[k] = { responses: v.responses, tokens_unpriced: v.tokens_unpriced };
    deepDiff(un, rp.unpriced_by_reason, `unpriced_by_reason.${p}`, out);
  }

  // ---- coverage: every field present in both ----------------------------------------------------------------------
  for (const p of PROVIDERS) {
    deepDiff(view.coverage_by_provider[p], rec.coverage[p], `coverage.${p}`, out, true);
  }
}

export interface SeedResult {
  seed: number;
  window: WindowSpec;
  tier: boolean;
  diffs: Diff[];
  scan: FuzzScan;
}

/** One seed end to end: generate, pick the window and the tier parameter from the seed, run both, compare. */
export async function runSeed(seed: number, knobs: Knobs, over: { window?: WindowSpec; tier?: boolean } = {}): Promise<SeedResult> {
  const scan = generateScan(seed, knobs);
  const w = windowFor(seed, scan);
  const window = over.window ?? w.window;
  const tier = over.tier ?? w.tier;
  const res = await runBoth(scan, { ...window, tier });
  return { seed, window, tier, diffs: res.diffs, scan };
}

export { knobsFor };
