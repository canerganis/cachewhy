// Report layer and CLI wiring: window parsing, drift (R17.3), the cachewhy/1 JSON writer (R14.3, R14.5, R17.1),
// the summary text (R16.4) and the commands. Synthetic data only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, mock } from "node:test";
import { promises as fsPromises } from "node:fs";
import { analyze } from "../src/analyze.ts";
import { EXIT, run, type CliIO } from "../src/cli.ts";
import { discover } from "../src/discover.ts";
import {
  CONSTANTS,
  COVERAGE_TOKEN_FIELDS,
  REQUEST_KINDS,
  TAINT_REASONS,
  emptyCoverage,
  type CoverageCounters,
  type Provider,
  type ReportInput,
} from "../src/model/types.ts";
import { formatBig, formatPercentBig, formatUsdPico } from "../src/report/format.ts";
import { buildReportInput, computeDrift, taintWarn } from "../src/report/input.ts";
import { coverageToJson, reportToJson, reportToJsonText } from "../src/report/json.ts";
import { renderReport } from "../src/report/text.ts";
import type { ReportView } from "../src/report/input.ts";
import { parseBound, resolveWindow } from "../src/window.ts";
import { scenarios } from "../scripts/gen-fixtures.ts";
import { ClaudeProject, CodexHome, IdGen, CodexThread, withRawLines, withTruncatedTail, writeFiles, type GeneratedFile } from "./fixtures/builder.ts";

const FIX = fileURLToPath(new URL("./fixtures/synthetic/", import.meta.url));
const claudeFix = join(FIX, "claude-basic");
const codexFix = join(FIX, "codex-basic");
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

function harness(env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const h: CliIO = { out: (s) => out.push(s), err: (s) => err.push(s), env, isTTY: false, now: () => NOW };
  return { h, out, err };
}

async function inputFor(dirs: { claude?: string; codex?: string }, since?: string, now = NOW): Promise<ReportView> {
  const found = await discover({ claudeDirs: dirs.claude ? [dirs.claude] : [], codexDirs: dirs.codex ? [dirs.codex] : [], env: {}, home: tmpdir() });
  const analysis = await analyze(found.files, { since, now_ms: now });
  return buildReportInput(
    {
      graph: analysis.graph,
      parsed: analysis.parsed,
      priced: analysis.priced,
      detection: analysis.detection,
      book: analysis.book,
      options: { command: "default", json: false, show_ids: false, demo: false, color: false },
      generated_at_ms: now,
      tool_version: "0.0.0",
    },
    analysis.filter,
  );
}

describe("window (R5.9)", () => {
  it("parses dates, instants and durations", () => {
    assert.equal(parseBound("2026-01-31", NOW), Date.UTC(2026, 0, 31));
    assert.equal(parseBound("2026-01-31T10:00:00Z", NOW), Date.UTC(2026, 0, 31, 10));
    assert.equal(parseBound("7d", NOW), NOW - 7 * 86_400_000);
    assert.equal(parseBound("24h", NOW), NOW - 24 * 3_600_000);
    assert.equal(parseBound("2w", NOW), NOW - 14 * 86_400_000);
    assert.equal(parseBound("yesterday", NOW), null);
    assert.equal(parseBound("2026-13-45", NOW), null);
  });

  it("resolves since and until; without since the window starts at the first event", () => {
    assert.deepEqual(resolveWindow({ since: "1d" }, NOW, 5), { since_ms: NOW - 86_400_000, until_ms: NOW });
    assert.deepEqual(resolveWindow({}, NOW, 5), { since_ms: 5, until_ms: NOW });
    assert.deepEqual(resolveWindow({}, NOW, null), { since_ms: NOW, until_ms: NOW });
    assert.equal(resolveWindow({ since: "2030-01-01", until: "2020-01-01" }, NOW, null), null);
    assert.equal(resolveWindow({ since: "junk" }, NOW, null), null);
  });
});

describe("drift (R17.3)", () => {
  const cov = (f: (c: CoverageCounters) => void): Record<Provider, CoverageCounters> => {
    const claude = emptyCoverage();
    const codex = emptyCoverage();
    claude.files_total = 1;
    codex.files_total = 1;
    f(claude);
    return { claude, codex };
  };
  const tripped = (by: Record<Provider, CoverageCounters>, code: string): boolean =>
    computeDrift(by).find((d) => d.code === code && d.provider === "claude")?.tripped ?? false;

  it("drift_unmappable and drift_no_key trip strictly above 1 percent (cross multiplication)", () => {
    for (const code of ["drift_unmappable", "drift_no_key"]) {
      const f = (n: number) => (c: CoverageCounters) => {
        c.records_usage_bearing = 200;
        if (code === "drift_unmappable") c.records_usage_unmappable = n;
        else c.records_unkeyed = n;
      };
      assert.equal(tripped(cov(f(2)), code), false, "exactly 1 percent does not exceed");
      assert.equal(tripped(cov(f(3)), code), true);
    }
  });

  it("drift_invariant counts invariant, range, bucket and key failures against 0.5 percent of responses", () => {
    const f = (inv: number, range: number, bucket: number, key: number) => (c: CoverageCounters) => {
      c.responses_total = 400;
      c.responses_usage_invariant_failed = inv;
      c.responses_usage_range_failed = range;
      c.responses_bucket_mismatch = bucket;
      c.requests_conflict_by_kind.key_conflict = key;
    };
    assert.equal(tripped(cov(f(1, 1, 0, 0)), "drift_invariant"), false, "2 of 400 is exactly 0.5 percent");
    assert.equal(tripped(cov(f(1, 1, 1, 0)), "drift_invariant"), true);
    assert.equal(tripped(cov(f(0, 0, 0, 3)), "drift_invariant"), true);
  });

  it("drift_no_final_marker needs more than C28 requests and no final marker", () => {
    const f = (total: number, marked: number) => (c: CoverageCounters) => {
      c.responses_total = total;
      c.requests_with_final_marker = marked;
    };
    assert.equal(tripped(cov(f(CONSTANTS.NO_FINAL_MARKER_MIN, 0)), "drift_no_final_marker"), false);
    assert.equal(tripped(cov(f(CONSTANTS.NO_FINAL_MARKER_MIN + 1, 0)), "drift_no_final_marker"), true);
    assert.equal(tripped(cov(f(1000, 1)), "drift_no_final_marker"), false);
  });

  it("drift_stream_integrity (Codex) reads physical file counts and the ordinal_unverified chain count (R17.3)", () => {
    const run2 = (f: (c: CoverageCounters) => void) => {
      const by = cov(() => undefined);
      f(by.codex);
      return computeDrift(by).find((d) => d.code === "drift_stream_integrity")?.tripped ?? false;
    };
    assert.equal(run2((c) => { c.files_total = 200; c.files_stream_conflict = 1; c.files_unassigned_stream = 1; }), false);
    assert.equal(run2((c) => { c.files_total = 200; c.files_stream_conflict = 1; c.files_unassigned_stream = 1; c.files_copy_exposed = 1; }), true);
    assert.equal(run2((c) => { c.files_total = 1000; c.chains_total = 100; c.chains_tainted_by_reason.ordinal_unverified = 2; }), true);
    assert.equal(run2((c) => { c.files_total = 1000; c.chains_total = 100; c.chains_tainted_by_reason.ordinal_unverified = 1; }), false);
    // other taint reasons never feed this drift code
    assert.equal(run2((c) => { c.files_total = 1000; c.chains_total = 100; c.chains_tainted_by_reason.request_anomaly = 50; }), false);
  });

  it("a provider with no input produces no finding", () => {
    const by = { claude: emptyCoverage(), codex: emptyCoverage() };
    assert.deepEqual(computeDrift(by), []);
  });
});

describe("formatting helpers use BigInt only", () => {
  it("groups digits, rounds half up, and prints picodollars", () => {
    assert.equal(formatBig(123456789012345678901234567890n), "123,456,789,012,345,678,901,234,567,890");
    assert.equal(formatBig(-1234n), "-1,234");
    assert.equal(formatPercentBig(1n, 3n), "33.3%");
    assert.equal(formatPercentBig(2n, 3n), "66.7%");
    assert.equal(formatPercentBig(1n, 0n), "n/a");
    assert.equal(formatUsdPico(0n), "$0.0000");
    assert.equal(formatUsdPico(1_234_567_890_000n), "$1.2346");
    assert.equal(formatUsdPico(1_234_500_000_000n + 50_000_000n), "$1.2346"); // half up at 1e-4
    assert.equal(formatUsdPico(12_345_678_900_000_000n), "$12,345.6789");
  });
});

describe("summary on the committed synthetic trees", () => {
  it("totals are consistent: kinds sum to the total (R5.8), models sum to the provider total", async () => {
    const input = await inputFor({ claude: claudeFix, codex: codexFix });
    for (const t of input.totals) {
      const byKind = REQUEST_KINDS.reduce((a, k) => a + t.requests_by_kind[k], 0);
      assert.equal(byKind, t.requests_total, `${t.provider}: kinds`);
      assert.equal(t.models.reduce((a, m) => a + m.responses, 0), t.requests_total, `${t.provider}: models`);
      assert.equal(t.models.reduce((a, m) => a + m.tokens.cache_read, 0n), t.tokens.cache_read);
      assert.equal(t.models.reduce((a, m) => a + m.tokens_unpriced, 0n), t.tokens_unpriced);
      assert.ok(t.tokens_unpriced <= t.tokens_total);
      assert.equal(t.tokens_total, t.total_input + t.tokens.output + t.tokens.output_lower_bound_unknown);
    }
    const h = input.headline;
    assert.equal(h.n_total, h.n_main + h.n_sub + h.n_wf + h.n_cx);
    assert.equal(input.coverage.requests_priced, input.totals.reduce((a, t) => a + t.requests_priced, 0));
    // priced + unpriced outcomes partition the counted responses
    const unpriced = input.coverage.requests_unknown_model + input.coverage.requests_unpriced_modifier;
    assert.ok(input.coverage.requests_priced + unpriced <= h.n_total);
    assert.equal(
      Object.values(input.coverage.requests_unpriced_modifier_by_reason).reduce((a, b) => a + b, 0),
      input.coverage.requests_unpriced_modifier,
    );
  });

  it("text output prints denominators, no forbidden words (R16.4), and the coverage block (R17.2)", async () => {
    const t = harness();
    assert.equal(await run(["--claude-dir", claudeFix, "--codex-dir", codexFix, "--no-color"], t.h), EXIT.OK);
    const text = t.out.join("\n");
    assert.match(text, /Cache read: \d+\.\d% \([\d,]+ of [\d,]+ input tokens; input \+ cache read \+ cache write\)/);
    assert.match(text, /Cache read: \d+\.\d% \([\d,]+ of [\d,]+ input tokens; input\)/);
    assert.match(text, /\nCoverage\n/);
    assert.match(text, /files scanned/);
    for (const w of ["avoidable", "saving", "saved", "wasted", "cost you", "overspend"]) assert.doesNotMatch(text.toLowerCase(), new RegExp(w));
    // every dollar figure is accompanied by "equivalent"
    if (/\$\d/.test(text)) assert.match(text, /List-price equivalent/);
  });

  it("the headline is withheld when drift trips, with no dollar figure (R16.5, R17.3)", async () => {
    const input = await inputFor({ claude: claudeFix });
    // claude-basic holds one bucket-mismatch response out of ten: above 0.5 percent
    assert.equal(input.headline_status, "withheld");
    assert.equal(input.withheld_reason, "drift_invariant");
    const text = renderReport(input);
    assert.match(text, /Headline withheld: drift_invariant/);
    assert.doesNotMatch(text, /\$\d/);
    const json = reportToJson(input) as { totals: Array<{ usd: string | null; models: Array<{ usd: string | null }> }> };
    for (const t of json.totals) {
      assert.equal(t.usd, null);
      for (const m of t.models) assert.equal(m.usd, null);
    }
  });

  it("dollars are printed when the headline is open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-rep-"));
    try {
      const claude = scenarios.find((s) => s.name === "claude-replay")!;
      writeFiles(dir, claude.build());
      const input = await inputFor({ claude: join(dir, "projects") });
      assert.equal(input.headline_status, "ok");
      const text = renderReport(input);
      assert.match(text, /List-price equivalent: .*\$[\d,]+\.\d{4} at table pt-/);
      assert.match(text, /over \d+ of \d+ responses/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cachewhy/1 JSON (R14.3, R14.5, R17.1)", () => {
  it("has the top-level fields of R14.5, empty events and boundaries, typed strings only", async () => {
    const t = harness();
    assert.equal(await run(["--json", "--claude-dir", claudeFix, "--codex-dir", codexFix], t.h), EXIT.OK);
    const j = JSON.parse(t.out.join("\n")) as Record<string, any>;
    assert.deepEqual(Object.keys(j), [
      "schema", "generated_at", "tool_version", "spec", "table_version", "window", "headline_status", "withheld_reason",
      "assumptions", "coverage", "totals", "events", "boundaries",
    ]);
    assert.equal(j.schema, "cachewhy/1");
    assert.equal(j.spec, "spec-1");
    assert.match(j.table_version, /^pt-[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]+)?$/);
    assert.equal(j.generated_at, new Date(NOW).toISOString());
    assert.deepEqual(j.events, []);
    assert.deepEqual(j.boundaries, []);
    for (const f of COVERAGE_TOKEN_FIELDS) assert.equal(typeof j.coverage[f], "string", f);
    for (const k of Object.keys(j.coverage.unlogged_tokens_estimate)) assert.equal(typeof j.coverage.unlogged_tokens_estimate[k], "string");
    for (const tot of j.totals) {
      for (const f of ["total_input", "tokens_total", "tokens_unpriced"]) assert.equal(typeof tot[f], "string");
      for (const v of Object.values(tot.tokens)) assert.equal(typeof v, "string");
      for (const m of tot.models) assert.ok(m.model === null || /^[a-z0-9][a-z0-9._-]{0,63}$/.test(m.model));
    }
    // no key outside the schema: every string value is an enum, number-like, a model id, version or instant
    const strings: string[] = [];
    (function walk(v: unknown): void {
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    })(j);
    for (const s of strings) assert.match(s, /^(-?\d+|[A-Za-z0-9_./:-]+)$/, "no free text");
  });

  it("R17.1: token amounts survive a lossless round trip as strings (MAX_SAFE_INTEGER + 2, 2^64 + 1, sums)", async () => {
    const input = await inputFor({ claude: claudeFix });
    const big = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    const huge = 2n ** 64n + 1n;
    let sum = 0n;
    for (let i = 0; i < 1000; i++) sum += BigInt(Number.MAX_SAFE_INTEGER);
    const coverage = { ...input.coverage, tokens_unpriced: big, tokens_in_incomplete_responses: huge, tokens_in_invalid_responses: sum };
    coverage.unlogged_tokens_estimate = { input_uncached: -huge, cache_read: big, cache_write: sum, output: 0n };
    const text = reportToJsonText({ ...input, coverage });
    // a parser that keeps strings: the field must be a quoted decimal in the text itself
    for (const [f, v] of [["tokens_unpriced", big], ["tokens_in_incomplete_responses", huge], ["tokens_in_invalid_responses", sum]] as const) {
      assert.ok(text.includes(`"${f}": "${v.toString()}"`), f);
    }
    const j = JSON.parse(text) as { coverage: Record<string, any> };
    assert.equal(BigInt(j.coverage.tokens_unpriced), big);
    assert.equal(BigInt(j.coverage.tokens_in_incomplete_responses), huge);
    assert.equal(BigInt(j.coverage.tokens_in_invalid_responses), sum);
    assert.equal(BigInt(j.coverage.unlogged_tokens_estimate.input_uncached), -huge);
    for (const f of COVERAGE_TOKEN_FIELDS) assert.equal(typeof j.coverage[f], "string");
  });

  it("the serializer refuses a value outside its field (a count above the safe range is a schema violation)", async () => {
    const input = await inputFor({ claude: claudeFix });
    const bad = { ...input, coverage: { ...input.coverage, lines_total: Number.MAX_SAFE_INTEGER + 1 } };
    assert.throws(() => reportToJson(bad), /E_SCHEMA_VIOLATION/);
  });

  it("coverage versions are an array of {version, lines}, and a model off the table is written as unlisted", async () => {
    const input = await inputFor({ claude: claudeFix });
    const cov = coverageToJson(input.coverage) as { versions: Array<{ version: string; lines: number }> };
    assert.ok(Array.isArray(cov.versions) && cov.versions.length > 0);
    const j = reportToJson(input) as { totals: Array<{ models: Array<{ model: string | null }> }> };
    const models = j.totals.flatMap((t) => t.models.map((m) => m.model));
    assert.ok(models.includes("unlisted"));
  });
});

describe("CLI commands", () => {
  it("summary is the default command; --demo and the other commands are not implemented yet", async () => {
    let t = harness();
    assert.equal(await run(["summary", "--claude-dir", claudeFix, "--codex-dir", codexFix], t.h), EXIT.OK);
    t = harness();
    assert.equal(await run(["--demo"], t.h), EXIT.NOT_IMPLEMENTED);
    t = harness();
    assert.equal(await run(["session", "x", "--claude-dir", claudeFix], t.h), EXIT.NOT_IMPLEMENTED);
  });

  it("an invalid or empty window is a usage error that prints no raw text", async () => {
    const t = harness();
    assert.equal(await run(["--since", "2030-01-01", "--until", "2020-01-01", "--claude-dir", claudeFix, "--codex-dir", codexFix], t.h), EXIT.USAGE);
    assert.match(t.err.join(""), /window is empty or invalid/);
    const u = harness();
    assert.equal(await run(["--until", "tomorrow"], u.h), EXIT.USAGE);
  });

  it("--agent and --project select files; --since keeps earlier requests as baseline", async () => {
    let t = harness();
    await run(["--json", "--agent", "claude", "--claude-dir", claudeFix, "--codex-dir", codexFix], t.h);
    const onlyClaude = JSON.parse(t.out.join("\n")) as { totals: Array<{ provider: string; requests_total: number }> };
    // a provider hidden by the filter is omitted, never printed as a zero entry (an all-zero row would read as zero usage)
    assert.deepEqual(onlyClaude.totals.map((x) => x.provider), ["claude"]);
    assert.ok(onlyClaude.totals.find((x) => x.provider === "claude")!.requests_total > 0);
    t = harness();
    await run(["--json", "--project", "no-such-project", "--claude-dir", claudeFix, "--codex-dir", codexFix], t.h);
    const none = JSON.parse(t.out.join("\n")) as { totals: Array<{ provider: string; requests_total: number }> };
    assert.deepEqual(none.totals.map((x) => [x.provider, x.requests_total]), [["claude", 0]]);
    t = harness();
    await run(["--json", "--project", "synthetic-project", "--claude-dir", claudeFix, "--codex-dir", codexFix], t.h);
    const one = JSON.parse(t.out.join("\n")) as { totals: Array<{ provider: string; requests_total: number }> };
    assert.ok(one.totals.find((x) => x.provider === "claude")!.requests_total > 0);
    assert.equal(one.totals.find((x) => x.provider === "codex"), undefined);
    t = harness();
    await run(["--json", "--agent", "codex", "--claude-dir", claudeFix, "--codex-dir", codexFix], t.h);
    const onlyCodex = JSON.parse(t.out.join("\n")) as { totals: Array<{ provider: string }> };
    assert.deepEqual(onlyCodex.totals.map((x) => x.provider), ["codex"]);
    // a window after every event: everything is baseline
    t = harness();
    await run(["--json", "--since", "2026-05-01", "--claude-dir", claudeFix, "--codex-dir", codexFix], t.h);
    const late = JSON.parse(t.out.join("\n")) as { totals: Array<{ requests_total: number }>; coverage: { baseline_requests_loaded: number } };
    assert.deepEqual(late.totals.map((x) => x.requests_total), [0, 0]);
    assert.ok(late.coverage.baseline_requests_loaded > 0);
  });

  it("doctor adds parse coverage and drift to its text and JSON", async () => {
    let t = harness();
    assert.equal(await run(["doctor", "--no-color", "--claude-dir", claudeFix, "--codex-dir", codexFix], t.h), EXIT.OK);
    const text = t.out.join("\n");
    assert.match(text, /Total: \d+/);
    assert.match(text, /Coverage/);
    assert.match(text, /lines that failed to parse/);
    t = harness();
    assert.equal(await run(["doctor", "--json", "--claude-dir", claudeFix, "--codex-dir", codexFix], t.h), EXIT.OK);
    const j = JSON.parse(t.out.join("\n")) as { coverage: { lines_total: number; tokens_unpriced: string }; drift: unknown[]; headline_status: string };
    assert.ok(j.coverage.lines_total > 0);
    assert.equal(typeof j.coverage.tokens_unpriced, "string");
    assert.ok(Array.isArray(j.drift));
  });

  it("CACHEWHY_NETGUARD=1 changes nothing in the output and makes no network call", () => {
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const args = ["--import", "tsx", cli, "--json", "--claude-dir", claudeFix, "--codex-dir", codexFix];
    const strip = (s: string): string => s.replace(/"generated_at": "[^"]+",?\n/, "").replace(/"(since|until)": "[^"]+",?\n/g, "");
    const plain = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, CACHEWHY_NETGUARD: "0" } });
    const guarded = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, CACHEWHY_NETGUARD: "1" } });
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(guarded.status, 0, guarded.stderr);
    assert.equal(strip(guarded.stdout), strip(plain.stdout));
    assert.equal(guarded.stderr, "");
  });
});

// ---------------------------------------------------------------------------
// R0.9 taint in the report (accounting only), R5.9 filters, R16.1 warning (C36), R17.1 token strings
// ---------------------------------------------------------------------------

/** A day before the run start: not live (C35 is 600 s). */
const OLD = NOW - 86_400_000;
const LIVE_MS = CONSTANTS.LIVE_WINDOW_S * 1000;

interface SessionSpec {
  id: string;
  /** Tokens of the one request of the session (responseTokens: input + output). At least 20. */
  tokens: number;
  /** A raw line that fails to parse (R1.3) or a truncated tail, in the session's main file. */
  bad?: "parse" | "tail";
  /** mtime of the main file of a bad session. Defaults to `OLD`. */
  badMtime?: number;
  project?: string;
}

/** One request per session. A bad session carries an unparseable line, so its family is tainted (R0.9 `unparsed_line`). */
function claudeScan(specs: readonly SessionSpec[]): GeneratedFile[] {
  // One IdGen for the whole scan: request ids, message ids and uuids must not collide across sessions.
  const ids = new IdGen();
  const projects = new Map<string, ClaudeProject>();
  specs.forEach((sp, k) => {
    const dir = sp.project ?? "synthetic-project";
    let proj = projects.get(dir);
    if (proj === undefined) projects.set(dir, (proj = new ClaudeProject({ projectDir: dir, ids })));
    const sess = proj.session({ sessionId: `synthetic-sess-${sp.id}`, version: "2.1.293", model: "claude-opus-5-5", startMs: Date.UTC(2026, 0, 1) + k * 3_600_000 });
    sess.main.user();
    sess.main.request({ requestId: `synthetic-req-${sp.id}`, usage: { input: sp.tokens - 10, output: 10 } });
  });
  const bad = new Map(specs.filter((sp) => sp.bad !== undefined).map((sp) => [`synthetic-sess-${sp.id}.jsonl`, sp]));
  const out: GeneratedFile[] = [];
  for (const proj of projects.values()) {
    for (const f of proj.files()) {
      let g: GeneratedFile = { ...f, mtimeMs: OLD };
      const sp = bad.get(f.path.split("/").pop() as string);
      if (sp !== undefined) {
        g = sp.bad === "parse" ? withRawLines(g, [{ at: 1, text: "{not json" }]) : withTruncatedTail(g);
        g = { ...g, mtimeMs: sp.badMtime ?? OLD };
      }
      out.push(g);
    }
  }
  return out;
}

async function scanReport(files: readonly GeneratedFile[], now = NOW): Promise<ReportView> {
  const dir = mkdtempSync(join(tmpdir(), "cw-taint-"));
  try {
    writeFiles(dir, files);
    return await inputFor({ claude: join(dir, "projects") }, undefined, now);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function scanJson(files: readonly GeneratedFile[], argv: string[] = [], now = NOW): Promise<Record<string, any>> {
  const dir = mkdtempSync(join(tmpdir(), "cw-taint-"));
  try {
    writeFiles(dir, files);
    const t = harness();
    t.h.now = () => now;
    assert.equal(await run(["--json", "--claude-dir", join(dir, "projects"), "--codex-dir", join(dir, "no-codex"), ...argv], t.h), EXIT.OK, t.err.join(""));
    return JSON.parse(t.out.join("\n")) as Record<string, any>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("taint in the report (R0.9, accounting only)", () => {
  it("R0.9 fixture (6): a tainted family keeps its tokens, has no dollars, and the clean family equals a clean-only scan", async () => {
    const clean: SessionSpec = { id: "clean", tokens: 1000 };
    const both = await scanJson(claudeScan([clean, { id: "bad", tokens: 400, bad: "parse" }]));
    const alone = await scanJson(claudeScan([clean]));
    const cl = (j: Record<string, any>) => j.totals.find((t: any) => t.provider === "claude");
    // accounting: the tainted tokens are in the totals (R0.9 effect 1)
    assert.equal(cl(both).requests_total, 2);
    assert.equal(BigInt(cl(both).tokens_total), 1400n);
    // dollars: only the clean family, exactly as in the clean-only scan
    assert.equal(cl(both).usd, cl(alone).usd);
    assert.notEqual(cl(both).usd, null);
    assert.equal(cl(both).requests_priced, 1);
    // the tainted tokens are unpriced (R0.9 effect 2, R3.9) and counted under requests_unpriced_tainted
    assert.equal(BigInt(cl(both).tokens_unpriced), 400n);
    assert.equal(both.coverage.requests_unpriced_tainted, 1);
    assert.equal(both.coverage.requests_unpriced_modifier, cl(alone).requests_unpriced_modifier ?? 0);
    assert.equal(both.coverage.chains_total, 2);
    assert.equal(both.coverage.chains_tainted, 1);
    assert.equal(both.coverage.chains_tainted_by_reason.unparsed_line, 1);
    assert.equal(both.coverage.families_total, 2);
    assert.equal(both.coverage.families_tainted, 1);
    assert.equal(both.coverage.responses_in_tainted_chains, 1);
    assert.equal(both.coverage.tokens_in_tainted_chains, "400");
    // the model rows: the verified row equals the clean-only row; the tainted row is flagged and has no dollars
    const verified = cl(both).models.filter((m: any) => m.model_verified);
    assert.deepEqual(verified, cl(alone).models);
    const unverified = cl(both).models.filter((m: any) => !m.model_verified);
    assert.equal(unverified.length, 1);
    assert.equal(unverified[0].usd, null);
    assert.equal(unverified[0].requests_priced, 0);
    assert.equal(BigInt(unverified[0].tokens_unpriced), 400n);
  });

  it("a parse error in one session taints every chain of that session and not a second session (R0.9 fixture 3)", async () => {
    for (const bad of ["parse", "tail"] as const) {
      const j = await scanJson(claudeScan([{ id: "a", tokens: 100 }, { id: "b", tokens: 100, bad }]));
      assert.equal(j.coverage.families_total, 2, bad);
      assert.equal(j.coverage.families_tainted, 1, bad);
      assert.equal(j.coverage.chains_tainted_by_reason.unparsed_line, 1, bad);
      assert.equal(j.coverage.requests_unpriced_tainted, 1, bad);
    }
  });

  it("text: the taint line, the unverified model label, no dollar for tainted responses, and the accounting-only statement", async () => {
    const input = await scanReport(claudeScan([{ id: "a", tokens: 1000 }, { id: "b", tokens: 400, bad: "parse" }]));
    const text = renderReport(input);
    assert.match(text, /Taint, whole scan: 1 of 2 chains tainted \(R0\.9\), their 1 responses tokens only; 0 live session families skipped\./);
    assert.match(text, /claude-opus-5-5 \(unverified\)/);
    assert.match(text, /Rebuild events, boundaries, causes and deltas are not computed in this version/);
    assert.match(text, /chains tainted \(R0\.9\) +1/);
    assert.match(text, /reason: unparsed_line +1/);
    assert.match(text, /Claude taint share: 1 of 2 session families \(50\.0%\), 400 of 1,400 tokens \(28\.6%\)\./);
    assert.match(text, /over 1 of 2 responses; 28\.6% of tokens unpriced \(400 of 1,400\)/);
    // R3.9: more than 10 percent of the tokens are unpriced (the tainted ones), so the dollar figure is partial
    assert.match(text, /List-price equivalent: partial \$/);
    for (const line of text.split("\n")) if (/\$\d/.test(line)) assert.match(line, /equivalent|\$[\d,.]+ +\d/, line);
    for (const w of ["avoidable", "saving", "saved", "wasted", "cost you", "overspend"]) assert.doesNotMatch(text.toLowerCase(), new RegExp(w));
  });

  it("C36 warning: families and tokens each trip strictly above 3/10 (BigInt cross multiplication)", () => {
    // families only
    assert.equal(taintWarn(3, 10, 0n, 1000n), false);
    assert.equal(taintWarn(4, 13, 0n, 1000n), true);
    assert.equal(taintWarn(30, 100, 0n, 1000n), false);
    assert.equal(taintWarn(31, 100, 0n, 1000n), true);
    // tokens only: exactly 3/10 does not exceed, one token more does
    assert.equal(taintWarn(0, 10, 300n, 1000n), false);
    assert.equal(taintWarn(0, 10, 301n, 1001n), true);
    assert.equal(taintWarn(0, 10, 301n, 1003n), true);
    assert.equal(taintWarn(0, 10, 301n, 1004n), false);
    // beyond the safe integer range
    const big = 10n ** 30n;
    assert.equal(taintWarn(0, 10, 3n * big, 10n * big), false);
    assert.equal(taintWarn(0, 10, 3n * big + 1n, 10n * big + 1n), true);
    // nothing at all
    assert.equal(taintWarn(0, 0, 0n, 0n), false);
  });

  it("C36 warning end to end, families: 3 of 10 sessions tainted is quiet, 4 of 10 leads with the warning", async () => {
    const mk = (nBad: number): SessionSpec[] =>
      Array.from({ length: 10 }, (_, k) => (k < nBad ? { id: `s${k}`, tokens: 20, bad: "parse" as const } : { id: `s${k}`, tokens: 1000 }));
    const quiet = renderReport(await scanReport(claudeScan(mk(3))));
    assert.doesNotMatch(quiet, /Warning:/);
    const loud = renderReport(await scanReport(claudeScan(mk(4))));
    assert.match(loud.split("\n")[0] as string, /^Warning: 40\.0% of Claude session families and \d+\.\d% of Claude tokens are tainted \(R0\.9\)/);
  });

  it("C36 warning end to end, tokens: exactly 3/10 of the tokens is quiet, one token more leads with the warning", async () => {
    const mk = (taintedTokens: number): SessionSpec[] => [
      { id: "t", tokens: taintedTokens, bad: "parse" },
      ...Array.from({ length: 7 }, (_, k) => ({ id: `c${k}`, tokens: 100 })),
    ];
    const quiet = await scanReport(claudeScan(mk(300)));
    assert.equal(quiet.headline.taint_by_provider.claude.tokens_in_tainted_chains, 300n);
    assert.equal(quiet.headline.taint_by_provider.claude.tokens_total, 1000n);
    assert.equal(quiet.headline.taint_by_provider.claude.warn, false);
    assert.doesNotMatch(renderReport(quiet), /Warning:/);
    const loud = await scanReport(claudeScan(mk(301)));
    assert.equal(loud.headline.taint_by_provider.claude.warn, true);
    const first = renderReport(loud).split("\n")[0] as string;
    assert.match(first, /^Warning: 12\.5% of Claude session families and 30\.1% of Claude tokens are tainted \(R0\.9\)/);
  });

  it("live families (C35): exactly 600 s before the run start is live, 600 s and 1 ms is not; the live family is skipped and counted", async () => {
    const mk = (mtime: number): GeneratedFile[] => claudeScan([{ id: "a", tokens: 1000 }, { id: "b", tokens: 400, bad: "tail", badMtime: mtime }]);
    const live = await scanJson(mk(NOW - LIVE_MS));
    const cl = (j: Record<string, any>) => j.totals.find((t: any) => t.provider === "claude");
    assert.equal(live.coverage.families_live_skipped, 1);
    assert.equal(live.coverage.responses_live_skipped, 1);
    assert.equal(live.coverage.tokens_live_skipped, "400");
    assert.equal(live.coverage.chains_total, 1, "a live family is in no chain or family counter");
    assert.equal(live.coverage.chains_tainted, 0);
    assert.equal(live.coverage.families_total, 1);
    assert.equal(cl(live).requests_total, 1);
    assert.equal(BigInt(cl(live).tokens_total), 1000n);
    assert.ok(live.assumptions.includes("live_session_skipped"));
    // the other family is unchanged: same figures as a scan that holds only it
    const alone = await scanJson(claudeScan([{ id: "a", tokens: 1000 }]));
    assert.equal(cl(live).usd, cl(alone).usd);
    assert.deepEqual(cl(live).models, cl(alone).models);
    const text = renderReport(await scanReport(mk(NOW - LIVE_MS)));
    assert.match(text, /1 live session families skipped/);
    assert.match(text, /Assumptions: .*live_session_skipped/);

    const stale = await scanJson(mk(NOW - LIVE_MS - 1));
    assert.equal(stale.coverage.families_live_skipped, 0);
    assert.equal(stale.coverage.families_tainted, 1);
    assert.equal(cl(stale).requests_total, 2);
    assert.ok(!stale.assumptions.includes("live_session_skipped"));
    // a file modified after the run start is live as well
    const future = await scanJson(mk(NOW + 5_000));
    assert.equal(future.coverage.families_live_skipped, 1);
  });

  it("C36 shares and counters ignore --agent and --project (R5.9); the filters narrow only what is printed", async () => {
    const files = claudeScan([
      { id: "a1", tokens: 1000, project: "synthetic-proj-a" },
      { id: "a2", tokens: 400, bad: "parse", project: "synthetic-proj-a" },
      { id: "b1", tokens: 700, project: "synthetic-proj-b" },
    ]);
    const all = await scanJson(files);
    const proj = await scanJson(files, ["--project", "synthetic-proj-b"]);
    const cl = (j: Record<string, any>) => j.totals.find((t: any) => t.provider === "claude");
    assert.equal(cl(all).requests_total, 3);
    assert.equal(cl(proj).requests_total, 1);
    assert.equal(BigInt(cl(proj).tokens_total), 700n);
    // coverage and taint stay scan-wide
    assert.deepEqual(proj.coverage, all.coverage);
    // the project that holds the tainted session shows its tainted tokens in the totals
    const a = await scanJson(files, ["--project", "synthetic-proj-a"]);
    assert.equal(cl(a).requests_total, 2);
    assert.equal(BigInt(cl(a).tokens_unpriced), 400n);
    assert.deepEqual(a.coverage, all.coverage);
  });
});

describe("--agent reads every file (R5.9)", () => {
  it("--agent claude still reads the Codex files: Codex coverage is non-zero and only Claude totals are printed", async () => {
    const t = harness();
    assert.equal(await run(["--json", "--agent", "claude", "--claude-dir", claudeFix, "--codex-dir", codexFix], t.h), EXIT.OK);
    const j = JSON.parse(t.out.join("\n")) as { coverage: { files_total: number; lines_total: number }; totals: Array<{ provider: string; requests_total: number }> };
    const both = harness();
    assert.equal(await run(["--json", "--claude-dir", claudeFix, "--codex-dir", codexFix], both.h), EXIT.OK);
    const k = JSON.parse(both.out.join("\n")) as typeof j;
    assert.deepEqual(j.coverage, k.coverage, "coverage is scan-wide and does not depend on the filter");
    assert.ok(j.coverage.files_total > 2);
    assert.deepEqual(j.totals.map((x) => x.provider), ["claude"], "the hidden provider is omitted from the JSON totals");
    assert.ok(j.totals.find((x) => x.provider === "claude")!.requests_total > 0);
    const text = harness();
    await run(["--agent", "claude", "--no-color", "--claude-dir", claudeFix, "--codex-dir", codexFix], text.h);
    const out = text.out.join("\n");
    assert.match(out, /^Claude( \(unverified\))?$/m);
    assert.doesNotMatch(out, /^Codex( \(unverified\))?$/m, "the Codex block is not printed");
    assert.match(out, /files scanned +\d+ +\d+/, "the Codex column is still in coverage");
  });

  it("the retired prefilter flag is rejected (R5.9)", async () => {
    const retired = "--fa" + "st";
    const t = harness();
    assert.equal(await run([retired, "--since", "7d", "--claude-dir", claudeFix], t.h), EXIT.USAGE);
    assert.match(t.err.join(""), /Run cachewhy --help/);
    const h = harness();
    await run(["--help"], h.h);
    assert.ok(!h.out.join("\n").includes(retired));
  });
});

describe("cachewhy/1 JSON, revision 11 fields", () => {
  it("coverage carries chains_tainted as an integer and its reasons as an object of integers; models carry model_verified; no usd_hi", async () => {
    const j = await scanJson(claudeScan([{ id: "a", tokens: 1000 }, { id: "b", tokens: 400, bad: "parse" }]));
    assert.equal(typeof j.coverage.chains_tainted, "number");
    assert.deepEqual(Object.keys(j.coverage.chains_tainted_by_reason), [...TAINT_REASONS]);
    for (const v of Object.values(j.coverage.chains_tainted_by_reason)) assert.ok(Number.isInteger(v));
    for (const f of ["tokens_in_tainted_chains", "tokens_live_skipped"]) assert.equal(typeof j.coverage[f], "string", f);
    for (const t of j.totals) {
      assert.ok(!("usd_hi" in t));
      for (const m of t.models) {
        assert.equal(typeof m.model_verified, "boolean");
        assert.ok(!("usd_hi" in m));
      }
    }
    assert.ok(!j.assumptions.includes("no_batch_assumed"));
    assert.ok(j.assumptions.includes("no_regional_surcharge_assumed"));
  });

  it("R17.1: tokens_in_tainted_chains and tokens_live_skipped round trip as strings (MAX_SAFE_INTEGER + 2, 2^64 + 1, sum of maxima)", async () => {
    const input = await inputFor({ claude: claudeFix });
    const big = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    const huge = 2n ** 64n + 1n;
    let sum = 0n;
    for (let i = 0; i < 1000; i++) sum += BigInt(Number.MAX_SAFE_INTEGER);
    for (const [a, b] of [[big, huge], [huge, sum], [sum, big]] as const) {
      const coverage = { ...input.coverage, tokens_in_tainted_chains: a, tokens_live_skipped: b };
      const text = reportToJsonText({ ...input, coverage });
      assert.ok(text.includes(`"tokens_in_tainted_chains": "${a.toString()}"`));
      assert.ok(text.includes(`"tokens_live_skipped": "${b.toString()}"`));
      const j = JSON.parse(text) as { coverage: Record<string, unknown> };
      assert.equal(BigInt(j.coverage["tokens_in_tainted_chains"] as string), a);
      assert.equal(BigInt(j.coverage["tokens_live_skipped"] as string), b);
      assert.equal(typeof j.coverage["tokens_in_tainted_chains"], "string");
      assert.equal(typeof j.coverage["tokens_live_skipped"], "string");
    }
    // a number in a token field is a schema violation
    const bad = { ...input, coverage: { ...input.coverage, tokens_in_tainted_chains: 5 as unknown as bigint } };
    assert.throws(() => reportToJson(bad), /E_SCHEMA_VIOLATION/);
    const bad2 = { ...input, coverage: { ...input.coverage, tokens_live_skipped: 5 as unknown as bigint } };
    assert.throws(() => reportToJson(bad2), /E_SCHEMA_VIOLATION/);
  });

  it("two runs with the same injected clock give byte-equal output on every committed synthetic tree", async () => {
    const dirs = ["claude-basic", "claude-depth2", "claude-replay", "claude-workflow", "codex-basic", "codex-fork"];
    for (const d of dirs) {
      const args = d.startsWith("claude") ? ["--claude-dir", join(FIX, d), "--codex-dir", join(FIX, "no-codex")] : ["--claude-dir", join(FIX, "no-claude"), "--codex-dir", join(FIX, d)];
      const one = harness();
      const two = harness();
      assert.equal(await run(["--json", ...args], one.h), EXIT.OK, d);
      assert.equal(await run(["--json", ...args], two.h), EXIT.OK, d);
      assert.equal(one.out.join("\n"), two.out.join("\n"), d);
    }
  });
});

describe("Codex taint in the report", () => {
  it("an unreadable archive taints every Codex chain and leaves the token totals unchanged (R0.9 fixture 4)", async () => {
    const mkHome = (withBad: boolean): GeneratedFile[] => {
      const home = new CodexHome();
      const th = new CodexThread({ threadId: "synthetic-thread-u1", sessionId: "synthetic-session-u1", cliVersion: "0.160.1", model: "gpt-6-sol" });
      th.turnContext({ turnId: "tu1" });
      th.tokenUsage({ responseId: "u1", usage: { input: 1000, cached: 500, output: 10 } });
      home.add(th);
      const files = home.files().map((f) => ({ ...f, mtimeMs: OLD }));
      if (withBad) files.push({ path: "archived_sessions/rollout-2026-01-01T00-00-00-synthetic-bad.jsonl.zst", content: "not zstd data", mtimeMs: OLD });
      return files;
    };
    const run1 = async (files: GeneratedFile[]): Promise<Record<string, any>> => {
      const dir = mkdtempSync(join(tmpdir(), "cw-cxu-"));
      try {
        writeFiles(dir, files);
        const t = harness();
        assert.equal(await run(["--json", "--claude-dir", join(dir, "no-claude"), "--codex-dir", dir], t.h), EXIT.OK, t.err.join(""));
        return JSON.parse(t.out.join("\n")) as Record<string, any>;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const clean = await run1(mkHome(false));
    const bad = await run1(mkHome(true));
    const cx = (j: Record<string, any>) => j.totals.find((t: any) => t.provider === "codex");
    assert.equal(bad.coverage.files_unreadable, 1);
    assert.equal(bad.coverage.chains_tainted_by_reason.file_unreadable, bad.coverage.chains_total);
    assert.equal(bad.coverage.chains_tainted, bad.coverage.chains_total);
    assert.ok(bad.coverage.chains_total >= 1);
    assert.equal(clean.coverage.chains_tainted, 0);
    assert.deepEqual(cx(bad).tokens, cx(clean).tokens, "token totals unchanged");
    assert.equal(cx(bad).requests_total, cx(clean).requests_total);
    assert.equal(cx(bad).usd, null);
  });
});

describe("scan-wide warning and window label", () => {
  it("C36 warning: a hidden provider over the share still leads the output, as its share line does (R16.1, R5.9)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-hid-"));
    try {
      const specs: SessionSpec[] = Array.from({ length: 10 }, (_, k) => (k < 4 ? { id: `s${k}`, tokens: 20, bad: "parse" as const } : { id: `s${k}`, tokens: 1000 }));
      writeFiles(dir, claudeScan(specs));
      const text = async (extra: string[]): Promise<string> => {
        const t = harness();
        assert.equal(await run(["--no-color", ...extra, "--claude-dir", join(dir, "projects"), "--codex-dir", join(dir, "no-codex")], t.h), EXIT.OK, t.err.join(""));
        return t.out.join("\n");
      };
      for (const extra of [[], ["--agent", "claude"], ["--agent", "codex"]]) {
        const out = await text(extra);
        assert.match(out.split("\n")[0] as string, /^Warning: 40\.0% of Claude session families/, extra.join(" "));
        assert.match(out, /Claude taint share: 4 of 10 session families/, extra.join(" "));
      }
      const hidden = await text(["--agent", "codex"]);
      assert.doesNotMatch(hidden, /^Claude( \(unverified\))?$/m, "the Claude block stays hidden");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the first line of the totals names the scan window; without --since it starts at the first event", async () => {
    const t = harness();
    assert.equal(await run(["--no-color", "--claude-dir", claudeFix, "--codex-dir", codexFix], t.h), EXIT.OK);
    const line = t.out.join("\n").split("\n").find((l) => /\(UTC\)/.test(l)) as string;
    assert.match(line, /^Scan window \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z to 2026-06-01T12:00:00Z \(UTC\)\. /);
    const s = harness();
    assert.equal(await run(["--no-color", "--since", "2026-03-01", "--claude-dir", claudeFix, "--codex-dir", codexFix], s.h), EXIT.OK);
    assert.match(s.out.join("\n"), /^Scan window 2026-03-01T00:00:00Z to 2026-06-01T12:00:00Z \(UTC\)\. /m);
  });
});

describe("unreadable directories (R0.9 file_unreadable)", () => {
  /** Makes `readdir` fail with EACCES for the directories `denied` accepts; everything else is real. */
  function denyReaddir(denied: (p: string) => boolean): void {
    const real = fsPromises.readdir.bind(fsPromises);
    mock.method(fsPromises, "readdir", async (p: unknown, ...rest: unknown[]) => {
      if (typeof p === "string" && denied(p)) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return (real as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    });
  }

  const specs: SessionSpec[] = [
    { id: "a", tokens: 1000, project: "synthetic-proj-a" },
    { id: "b", tokens: 700, project: "synthetic-proj-b" },
  ];

  for (const [name, denyDirName] of [["a project directory (dir_unreadable)", "synthetic-proj-b"], ["the scan root (root_unreadable)", "projects"]] as const) {
    it(`${name}: counted as one unreadable file, taints every chain of that provider only, and the scan is not withheld`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "cw-udir-"));
      try {
        writeFiles(dir, claudeScan(specs));
        const base = await scanJson(claudeScan(specs));
        denyReaddir((p) => p.replace(/[\/]+$/, "").endsWith(denyDirName));
        const t = harness();
        const code = await run(["--json", "--claude-dir", join(dir, "projects"), "--codex-dir", join(dir, "no-codex")], t.h);
        mock.restoreAll();
        assert.equal(code, EXIT.OK, t.err.join(""));
        const j = JSON.parse(t.out.join("\n")) as Record<string, any>;
        assert.equal(j.coverage.files_unreadable, 1);
        assert.equal(j.headline_status, "ok", "the CLI is not withheld as a whole");
        assert.equal(j.coverage.chains_tainted_by_reason.file_unreadable, j.coverage.chains_total);
        assert.equal(j.coverage.chains_tainted, j.coverage.chains_total);
        // what could be read is still accounted
        const readable = denyDirName === "projects" ? 0 : 1;
        const cl = (x: Record<string, any>) => x.totals.find((r: any) => r.provider === "claude");
        assert.equal(cl(j).requests_total, denyDirName === "projects" ? 0 : base.totals.find((r: any) => r.provider === "claude").requests_total - readable);
        assert.equal(cl(j).usd, null, "a tainted chain has no dollars");
      } finally {
        mock.restoreAll();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("an unreadable Claude directory leaves every Codex chain clean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-udir2-"));
    try {
      const home = new CodexHome();
      const th = new CodexThread({ threadId: "synthetic-thread-d1", sessionId: "synthetic-session-d1", cliVersion: "0.160.1", model: "gpt-6-sol" });
      th.turnContext({ turnId: "td1" });
      th.tokenUsage({ responseId: "d1", usage: { input: 1000, cached: 500, output: 10 } });
      home.add(th);
      writeFiles(dir, [...claudeScan(specs), ...home.files().map((f) => ({ ...f, path: `codex/${f.path}`, mtimeMs: OLD }))]);
      denyReaddir((p) => p.endsWith("synthetic-proj-b"));
      const t = harness();
      const code = await run(["--json", "--claude-dir", join(dir, "projects"), "--codex-dir", join(dir, "codex")], t.h);
      mock.restoreAll();
      assert.equal(code, EXIT.OK, t.err.join(""));
      const j = JSON.parse(t.out.join("\n")) as Record<string, any>;
      assert.equal(j.coverage.files_unreadable, 1);
      const byProv = (await inputFor({ claude: join(dir, "projects"), codex: join(dir, "codex") })).coverage_by_provider;
      assert.equal(byProv.codex.chains_tainted, 0);
    } finally {
      mock.restoreAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("money display (R3.8)", () => {
  it("a nonzero amount that rounds to zero at four decimals is never printed as zero", () => {
    assert.equal(formatUsdPico(0n), "$0.0000");
    assert.equal(formatUsdPico(1n), "<$0.0001");
    assert.equal(formatUsdPico(49_999_999n), "<$0.0001"); // just below half of 1e-4 USD
    assert.equal(formatUsdPico(50_000_000n), "$0.0001"); // half up
    assert.equal(formatUsdPico(100_000_000n), "$0.0001");
  });
});
