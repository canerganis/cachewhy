// Report layer and CLI wiring: window parsing, drift (R17.3), the cachewhy/1 JSON writer (R14.3, R14.5, R17.1),
// the summary text (R16.4) and the commands. Synthetic data only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { analyze } from "../src/analyze.ts";
import { EXIT, run, type CliIO } from "../src/cli.ts";
import { discover } from "../src/discover.ts";
import {
  CONSTANTS,
  COVERAGE_TOKEN_FIELDS,
  REQUEST_KINDS,
  emptyCoverage,
  type CoverageCounters,
  type Provider,
  type ReportInput,
} from "../src/model/types.ts";
import { formatBig, formatPercentBig, formatUsdPico } from "../src/report/format.ts";
import { buildReportInput, computeDrift } from "../src/report/input.ts";
import { coverageToJson, reportToJson, reportToJsonText } from "../src/report/json.ts";
import { renderReport } from "../src/report/text.ts";
import { parseBound, resolveWindow } from "../src/window.ts";
import { scenarios } from "../scripts/gen-fixtures.ts";
import { writeFiles } from "./fixtures/builder.ts";

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

async function inputFor(dirs: { claude?: string; codex?: string }, since?: string): Promise<ReportInput> {
  const found = await discover({ claudeDirs: dirs.claude ? [dirs.claude] : [], codexDirs: dirs.codex ? [dirs.codex] : [], env: {}, home: tmpdir() });
  const analysis = await analyze(found.files, { since, now_ms: NOW });
  return buildReportInput({
    graph: analysis.graph,
    parsed: analysis.parsed,
    priced: analysis.priced,
    detection: analysis.detection,
    book: analysis.book,
    options: { command: "default", json: false, show_ids: false, demo: false, color: false },
    generated_at_ms: NOW,
    tool_version: "0.0.0",
  });
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

  it("drift_stream_integrity (Codex) reads physical file counts and ordinal-unverified streams", () => {
    const run2 = (f: (c: CoverageCounters) => void) => {
      const by = cov(() => undefined);
      f(by.codex);
      return computeDrift(by).find((d) => d.code === "drift_stream_integrity")?.tripped ?? false;
    };
    assert.equal(run2((c) => { c.files_total = 200; c.files_stream_conflict = 1; c.files_unassigned_stream = 1; }), false);
    assert.equal(run2((c) => { c.files_total = 200; c.files_stream_conflict = 1; c.files_unassigned_stream = 1; c.files_copy_exposed = 1; }), true);
    assert.equal(run2((c) => { c.files_total = 1000; c.streams_total = 100; c.streams_ordinal_unverified = 2; }), true);
    assert.equal(run2((c) => { c.files_total = 1000; c.streams_total = 100; c.streams_ordinal_unverified = 1; }), false);
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
    assert.equal(onlyClaude.totals.find((x) => x.provider === "codex")!.requests_total, 0);
    assert.ok(onlyClaude.totals.find((x) => x.provider === "claude")!.requests_total > 0);
    t = harness();
    await run(["--json", "--project", "no-such-project", "--claude-dir", claudeFix, "--codex-dir", codexFix], t.h);
    const none = JSON.parse(t.out.join("\n")) as { totals: Array<{ requests_total: number }> };
    assert.deepEqual(none.totals.map((x) => x.requests_total), [0, 0]);
    t = harness();
    await run(["--json", "--project", "synthetic-project", "--claude-dir", claudeFix, "--codex-dir", codexFix], t.h);
    const one = JSON.parse(t.out.join("\n")) as { totals: Array<{ provider: string; requests_total: number }> };
    assert.ok(one.totals.find((x) => x.provider === "claude")!.requests_total > 0);
    assert.equal(one.totals.find((x) => x.provider === "codex")!.requests_total, 0);
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
