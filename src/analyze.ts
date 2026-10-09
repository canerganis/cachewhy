// The analysis pipeline: discovered files -> parse results -> graph -> priced responses -> report input.
// Accounting only: sections 7 to 11 (events, boundaries, causes) are not run yet, so the detection result is empty.
//
// R5.9: every file of both providers is read, whatever the output filters say. `--agent` and `--project` select what
// is printed (totals and headline lines), never what is read, so taint, families and coverage are scan-wide.
import { inProject, type DiscoveredFile } from "./discover.js";
import { buildGraph } from "./graph/index.js";
import type {
  ChainId,
  ClaudeParseResult,
  CodexParseResult,
  DetectionResult,
  Graph,
  ParseResult,
  PriceBook,
  PricedResponse,
  Provider,
  TimeWindow,
} from "./model/types.js";
import { chainIdOf, emptyCoverage, PROVIDERS } from "./model/types.js";
import { loadDefaultPriceBook, priceResponse } from "./pricing/index.js";
import type { ReportFilter } from "./report/input.js";
import { parseClaude } from "./sources/claude.js";
import { parseCodex } from "./sources/codex.js";
import { resolveWindow } from "./window.js";

export interface AnalyzeOptions {
  /** `--since` / `--until` texts (R5.9). Without `since` the window starts at the first event of the scan. */
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  /**
   * The clock, read once per run by the caller. It is the run start of R0.9 (live families) and the base of duration
   * windows. Tests pass a fixed value. Never a CLI flag or an environment variable.
   */
  readonly now_ms: number;
  /** Output filter only (R5.9). Both providers are always parsed. */
  readonly agent?: "claude" | "codex" | "all";
  /** Output filter only (R5.9): a Claude project directory. Both providers are always parsed. */
  readonly project?: string | undefined;
  readonly book?: PriceBook;
  /** Test-only (R3.4). Never a CLI flag or an environment variable. */
  readonly codex_tier_for_test?: "standard";
}

export interface Analysis {
  readonly window: TimeWindow;
  readonly parsed: readonly ParseResult[];
  readonly claude: ClaudeParseResult | null;
  readonly codex: CodexParseResult | null;
  readonly graph: Graph;
  readonly book: PriceBook;
  /** Parallel to `graph.responses`. */
  readonly priced: readonly PricedResponse[];
  readonly detection: DetectionResult;
  /** What is printed (totals and headline lines). Coverage and taint shares ignore it (R5.9). */
  readonly filter: ReportFilter;
  /** Wall time per stage in milliseconds (diagnostic only). */
  readonly timings: { readonly parse_claude: number; readonly parse_codex: number; readonly graph: number; readonly price: number };
}

/** Empty detection result: the accounting-only pipeline produces no pairs, events or boundaries. */
export function emptyDetection(): DetectionResult {
  return { verdicts: [], events: [], boundaries: [], coverage: emptyCoverage(), assumptions: [] };
}

export class WindowError extends Error {}

/** The providers whose totals are printed under `--agent` and `--project` (Codex logs have no project, R1.1). */
export function shownProviders(agent: "claude" | "codex" | "all", project: string | undefined): readonly Provider[] {
  return PROVIDERS.filter((p) => (agent === "all" || agent === p) && (project === undefined || p === "claude"));
}

export async function analyze(files: readonly DiscoveredFile[], opts: AnalyzeOptions): Promise<Analysis> {
  const agent = opts.agent ?? "all";
  const book = opts.book ?? loadDefaultPriceBook();

  const explicit = opts.since !== undefined ? resolveWindow({ since: opts.since, until: opts.until }, opts.now_ms, null) : null;
  if (opts.since !== undefined && explicit === null) throw new WindowError("E_BAD_WINDOW");

  // R5.9: no prefilter, no window-based skipping. Every file of both providers is read.
  const t0 = performance.now();
  const claude = await parseClaude(files, {});
  const t1 = performance.now();
  const codex = await parseCodex(files, {});
  const t2 = performance.now();
  const parsed: ParseResult[] = [claude, codex];

  let window = explicit;
  if (window === null) {
    // R5.9: the first event of the scan. A record or response without a parsed timestamp has no event time (the
    // placeholder 0 of an excluded response is not one), so only entries with a known time count.
    let earliest: number | null = null;
    for (const p of parsed) for (const e of p.ledger) if (e.t_ms !== null && (earliest === null || e.t_ms < earliest)) earliest = e.t_ms;
    window = resolveWindow({ until: opts.until }, opts.now_ms, earliest);
    if (window === null) throw new WindowError("E_BAD_WINDOW");
  }

  const graph = buildGraph(parsed, { window, run_start_ms: opts.now_ms });
  const t3 = performance.now();
  const priceOpts = opts.codex_tier_for_test === "standard" ? ({ codex_tier_for_test: "standard" } as const) : undefined;
  const priced = graph.responses.map((r) => priceResponse(r, book, priceOpts));
  const t4 = performance.now();

  // `--project`: the chains that live in the project's files. Responses carry no project (R1.1), so the project's
  // files are structurally parsed on their own to name their chains. Only the printed totals use this set.
  let chains: Set<ChainId> | null = null;
  if (opts.project !== undefined) {
    const sub = await parseClaude(files.filter((f) => inProject(f, opts.project as string)), {});
    chains = new Set<ChainId>(sub.integrity.chains);
    for (const r of sub.responses) chains.add(chainIdOf(r.chain));
  }

  return {
    window,
    parsed,
    claude,
    codex,
    graph,
    book,
    priced,
    detection: emptyDetection(),
    filter: { providers: shownProviders(agent, opts.project), chains },
    timings: { parse_claude: t1 - t0, parse_codex: t2 - t1, graph: t3 - t2, price: t4 - t3 },
  };
}
