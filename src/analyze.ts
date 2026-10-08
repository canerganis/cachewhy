// The analysis pipeline: discovered files -> parse results -> graph -> priced responses -> report input.
// Accounting only: sections 7 to 11 (events, boundaries, causes) are not run yet, so the detection result is empty.
import type { DiscoveredFile } from "./discover.js";
import { buildGraph } from "./graph/index.js";
import type {
  ClaudeParseResult,
  CodexParseResult,
  DetectionResult,
  Graph,
  ParseResult,
  PriceBook,
  PricedResponse,
  TimeWindow,
} from "./model/types.js";
import { emptyCoverage } from "./model/types.js";
import { loadDefaultPriceBook, priceResponse } from "./pricing/index.js";
import { parseClaude } from "./sources/claude.js";
import { parseCodex } from "./sources/codex.js";
import { resolveWindow } from "./window.js";

export interface AnalyzeOptions {
  /** `--since` / `--until` texts (R5.9). Without `since` the window starts at the first event of the scan. */
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  /** Clock. Tests pass a fixed value. */
  readonly now_ms: number;
  /** `--fast` (R5.9): skip files older than `since` minus C29. Needs `since`. */
  readonly fast?: boolean;
  readonly agent?: "claude" | "codex" | "all";
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
  /** Wall time per stage in milliseconds (diagnostic only). */
  readonly timings: { readonly parse_claude: number; readonly parse_codex: number; readonly graph: number; readonly price: number };
}

/** Empty detection result: the accounting-only pipeline produces no pairs, events or boundaries. */
export function emptyDetection(): DetectionResult {
  return { verdicts: [], events: [], boundaries: [], coverage: emptyCoverage(), assumptions: [] };
}

export class WindowError extends Error {}

export async function analyze(files: readonly DiscoveredFile[], opts: AnalyzeOptions): Promise<Analysis> {
  const agent = opts.agent ?? "all";
  const book = opts.book ?? loadDefaultPriceBook();

  // The window is needed by the parsers only for the `--fast` prefilter, which needs an explicit `since`.
  const explicit = opts.since !== undefined ? resolveWindow({ since: opts.since, until: opts.until }, opts.now_ms, null) : null;
  if (opts.since !== undefined && explicit === null) throw new WindowError("E_BAD_WINDOW");
  const parseOpts = { window: explicit, fastPrefilter: opts.fast === true && explicit !== null, now_ms: opts.now_ms };

  const t0 = performance.now();
  const claude = agent === "codex" ? null : await parseClaude(files, parseOpts);
  const t1 = performance.now();
  const codex = agent === "claude" ? null : await parseCodex(files, parseOpts);
  const t2 = performance.now();
  const parsed: ParseResult[] = [];
  if (claude) parsed.push(claude);
  if (codex) parsed.push(codex);

  let window = explicit;
  if (window === null) {
    let earliest: number | null = null;
    for (const p of parsed) for (const r of p.responses) if (earliest === null || r.time.event_ms < earliest) earliest = r.time.event_ms;
    window = resolveWindow({ until: opts.until }, opts.now_ms, earliest);
    if (window === null) throw new WindowError("E_BAD_WINDOW");
  }

  const graph = buildGraph(parsed, { window });
  const t3 = performance.now();
  const priceOpts = opts.codex_tier_for_test === "standard" ? ({ codex_tier_for_test: "standard" } as const) : undefined;
  const priced = graph.responses.map((r) => priceResponse(r, book, priceOpts));
  const t4 = performance.now();

  return {
    window,
    parsed,
    claude,
    codex,
    graph,
    book,
    priced,
    detection: emptyDetection(),
    timings: { parse_claude: t1 - t0, parse_codex: t2 - t1, graph: t3 - t2, price: t4 - t3 },
  };
}
