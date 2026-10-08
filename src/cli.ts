#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyze, WindowError, type Analysis } from "./analyze.js";
import { discover, type DiscoveredFile, type DiscoverOptions } from "./discover.js";
import { zstdSupported } from "./io/lines.js";
import { colorEnabled, formatInt, formatTable, makePainter, type Painter } from "./report/format.js";
import { buildReportInput } from "./report/input.js";
import { doctorCoverageToJson, reportToJsonText } from "./report/json.js";
import { renderCoverage, renderReport } from "./report/text.js";
import { formatError } from "./util/sanitize.js";
import { SINCE_RE } from "./window.js";
import type { ReportInput } from "./model/types.js";

/** Exit codes. */
export const EXIT = {
  OK: 0,
  /** Runtime failure (unexpected error, unreadable input). */
  FAILURE: 1,
  /** Usage error (unknown command or flag, bad flag value). */
  USAGE: 2,
  /** Command exists but is not implemented yet. */
  NOT_IMPLEMENTED: 3,
} as const;

export const COMMANDS = ["summary", "session", "evidence", "doctor", "pricing"] as const;
export type Command = (typeof COMMANDS)[number];
export type AgentFilter = "claude" | "codex" | "all";

export interface CliOptions {
  command: Command;
  /** Positional id for session and evidence. */
  id?: string;
  since?: string;
  until?: string;
  fast: boolean;
  agent: AgentFilter;
  project?: string;
  json: boolean;
  demo: boolean;
  claudeDir?: string;
  codexDir?: string;
  noColor: boolean;
}

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
  isTTY: boolean;
  /** Clock in epoch milliseconds. Default Date.now(). Tests pass a fixed value. */
  now?: () => number;
}

export const HELP = `cachewhy: offline prompt cache forensics for Claude Code and Codex logs

Usage:
  cachewhy [summary] [options]     Summary across sessions (default)
  cachewhy session <id> [options]  One session timeline
  cachewhy evidence <id> [options] Evidence behind each finding for a session
  cachewhy doctor [options]        List discovered log sources
  cachewhy pricing [options]       Show the pricing table in use

Options:
  --since <when>        Only count activity since a date (YYYY-MM-DD) or duration (7d, 24h, 2w).
                        Earlier requests are still read as baseline and add nothing to the totals
  --until <when>        Only count activity before this date or duration (default: now)
  --fast                Skip files not modified within 7 days before --since (adds an assumption)
  --agent <name>        claude, codex or all (default: all)
  --project <name>      Only include Claude sessions of this project directory (Codex logs have none)
  --json                Machine readable output
  --demo                Use built-in synthetic data instead of local logs
  --claude-dir <path>   Claude Code projects dir (default: ~/.claude/projects)
  --codex-dir <path>    Codex dir (default: ~/.codex)
  --no-color            Disable color (NO_COLOR is also respected)
  --version             Print version
  --help                Print this help

Exit codes:
  0  success
  1  runtime failure
  2  usage error
  3  command not implemented yet

Environment:
  CACHEWHY_NETGUARD=1   Install a guard that blocks all network access
  NO_COLOR              Disable color
`;

export class UsageError extends Error {}


export type ParsedCli = CliOptions | { help: true } | { version: true };

/** Parse argv (without node and script) into options. Throws UsageError. */
export function parseCli(argv: string[]): ParsedCli {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        since: { type: "string" },
        until: { type: "string" },
        fast: { type: "boolean" },
        agent: { type: "string" },
        project: { type: "string" },
        json: { type: "boolean" },
        demo: { type: "boolean" },
        "claude-dir": { type: "string" },
        "codex-dir": { type: "string" },
        "no-color": { type: "boolean" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const v = parsed.values;
  if (v.help) return { help: true };
  if (v.version) return { version: true };

  const [first, ...rest] = parsed.positionals;
  let command: Command = "summary";
  let id: string | undefined;
  if (first !== undefined) {
    if (!(COMMANDS as readonly string[]).includes(first)) throw new UsageError(`unknown command: ${first}`);
    command = first as Command;
  }
  if (command === "session" || command === "evidence") {
    id = rest[0];
    if (!id) throw new UsageError(`${command} requires a session id`);
    if (rest.length > 1) throw new UsageError(`unexpected argument: ${rest[1]}`);
  } else if (rest.length > 0) {
    throw new UsageError(`unexpected argument: ${rest[0]}`);
  }

  const agent = v.agent ?? "all";
  if (agent !== "claude" && agent !== "codex" && agent !== "all") {
    throw new UsageError(`--agent must be claude, codex or all (got ${agent})`);
  }
  if (v.since !== undefined && !SINCE_RE.test(v.since)) {
    throw new UsageError(`--since must be a date like 2026-01-31 or a duration like 7d, 24h, 2w (got ${v.since})`);
  }

  if (v.until !== undefined && !SINCE_RE.test(v.until)) {
    throw new UsageError(`--until must be a date like 2026-01-31 or a duration like 7d, 24h, 2w (got ${v.until})`);
  }

  return {
    command,
    id,
    since: v.since,
    until: v.until,
    fast: v.fast ?? false,
    agent,
    project: v.project,
    json: v.json ?? false,
    demo: v.demo ?? false,
    claudeDir: v["claude-dir"],
    codexDir: v["codex-dir"],
    noColor: v["no-color"] ?? false,
  };
}

export function readVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Map the CLI flags to discover() options. Typed, so a shape change in discover() fails typecheck. */
export function discoverOptionsFor(opts: CliOptions, env: CliIO["env"]): DiscoverOptions {
  const o: DiscoverOptions = { env };
  if (opts.claudeDir !== undefined) o.claudeDirs = [opts.claudeDir];
  if (opts.codexDir !== undefined) o.codexDirs = [opts.codexDir];
  return o;
}

/** --agent and --project selection. A project is a Claude project directory; Codex logs have none (R1.1). */
export function selectFiles(files: readonly DiscoveredFile[], opts: CliOptions): DiscoveredFile[] {
  return files.filter((f) => {
    if (opts.agent !== "all" && f.agent !== opts.agent) return false;
    if (opts.project !== undefined) return f.agent === "claude" && f.relPath.split("/")[0] === opts.project;
    return true;
  });
}

async function analyzeFor(opts: CliOptions, io: CliIO, list: readonly DiscoveredFile[]): Promise<{ analysis: Analysis; input: ReportInput }> {
  const now_ms = io.now ? io.now() : Date.now();
  const analysis = await analyze(list, { since: opts.since, until: opts.until, fast: opts.fast, agent: opts.agent, now_ms });
  const input = buildReportInput({
    graph: analysis.graph,
    parsed: analysis.parsed,
    priced: analysis.priced,
    detection: analysis.detection,
    book: analysis.book,
    options: { command: opts.command === "doctor" ? "doctor" : "default", json: opts.json, show_ids: false, demo: opts.demo, color: false },
    generated_at_ms: now_ms,
    tool_version: readVersion(),
  });
  return { analysis, input };
}

async function runSummary(opts: CliOptions, io: CliIO, color: boolean): Promise<number> {
  const found = await discover(discoverOptionsFor(opts, io.env));
  const list = selectFiles(found.files, opts);
  const { analysis, input } = await analyzeFor(opts, io, list);
  if (opts.json) {
    io.out(reportToJsonText(input, new Set(analysis.book.models.keys())));
    return EXIT.OK;
  }
  io.out(renderReport({ ...input, options: { ...input.options, color } }));
  return EXIT.OK;
}

async function runDoctor(opts: CliOptions, io: CliIO, paint: Painter): Promise<number> {
  const found = await discover(discoverOptionsFor(opts, io.env));
  const list = selectFiles(found.files, opts);
  const counts = new Map<string, number>();
  for (const f of list) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  const kinds = [...counts.keys()].sort();
  // Archived Codex logs need zstd, which older Node 22 builds lack. Surface the coverage loss.
  const zstdOk = zstdSupported();
  const unreadable = zstdOk ? 0 : (counts.get("codex-archived-zst") ?? 0);
  const parsed = list.length > 0 ? await analyzeFor(opts, io, list) : null;
  if (opts.json) {
    const cov = parsed ? doctorCoverageToJson(parsed.input.coverage, parsed.input.drift) : null;
    io.out(
      JSON.stringify(
        {
          sources: Object.fromEntries(kinds.map((k) => [k, counts.get(k)])),
          total: list.length,
          zstdSupported: zstdOk,
          unreadable,
          ...(parsed && cov
            ? { headline_status: parsed.input.headline_status, withheld_reason: parsed.input.withheld_reason, coverage: cov.coverage, drift: cov.drift }
            : {}),
        },
        null,
        2,
      ),
    );
    return EXIT.OK;
  }
  io.out(paint("bold", "cachewhy doctor"));
  if (kinds.length === 0) {
    io.out("No log sources found.");
    return EXIT.OK;
  }
  io.out(
    formatTable(
      [{ header: "Source kind" }, { header: "Count", align: "right" }],
      kinds.map((k) => [k, formatInt(counts.get(k) ?? 0)]),
    ),
  );
  io.out(`Total: ${formatInt(list.length)}`);
  if (unreadable > 0) {
    io.out(
      `Warning: ${formatInt(unreadable)} archived Codex log(s) cannot be read because this Node version has no zstd support (needs 22.15 or newer).`,
    );
  }
  if (parsed) {
    io.out("");
    io.out(renderCoverage(parsed.input.coverage_by_provider, parsed.input.drift, paint));
    for (const d of parsed.input.drift.filter((x) => x.tripped)) {
      io.out(`Drift ${d.code} (${d.provider}): ${d.numerator} of ${d.denominator}`);
    }
  }
  return EXIT.OK;
}

/** Run the CLI. Returns the exit code; never calls process.exit. */
export async function run(argv: string[], io: CliIO): Promise<number> {
  let opts: ParsedCli;
  try {
    opts = parseCli(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.err(`cachewhy: ${e.message}\nRun cachewhy --help for usage.`);
    return EXIT.USAGE;
  }
  if ("help" in opts) {
    io.out(HELP);
    return EXIT.OK;
  }
  if ("version" in opts) {
    io.out(readVersion());
    return EXIT.OK;
  }

  if (io.env["CACHEWHY_NETGUARD"] === "1") {
    const { installNetGuard } = await import("./util/netguard.js");
    installNetGuard();
  }

  const paint = makePainter(colorEnabled({ noColor: opts.noColor, env: io.env, isTTY: io.isTTY }));
  try {
    if (opts.command === "doctor") return await runDoctor(opts, io, paint);
    if (opts.command === "summary" && !opts.demo) return await runSummary(opts, io, paint.enabled);
    io.err(`cachewhy: ${opts.command} is not implemented yet`);
    return EXIT.NOT_IMPLEMENTED;
  } catch (e) {
    if (e instanceof WindowError) {
      io.err("cachewhy: the window is empty or invalid (check --since and --until)\nRun cachewhy --help for usage.");
      return EXIT.USAGE;
    }
    // Never print raw exception text: Node fs errors embed paths. formatError gives a safe code.
    io.err(`cachewhy: ${formatError(e)}`);
    return EXIT.FAILURE;
  }
}

/**
 * True when this module is the process entry point. Both sides are realpath-resolved: npm
 * links bin entries as symlinks (and Windows may use junctions), so argv[1] is often not the
 * real file path.
 */
export function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync.native(argv1) === realpathSync.native(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  run(process.argv.slice(2), {
    out: (s) => process.stdout.write(s + "\n"),
    err: (s) => process.stderr.write(s + "\n"),
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`cachewhy: ${formatError(e)}\n`);
      process.exitCode = EXIT.FAILURE;
    },
  );
}
