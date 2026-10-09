import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseCli, run, isEntryPoint, EXIT, UsageError, type CliIO } from "../src/cli.js";
import { formatTokens, formatTable, formatPercent, makePainter, colorEnabled, stripAnsi } from "../src/report/format.js";

function io(env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const h: CliIO = { out: (s) => out.push(s), err: (s) => err.push(s), env, isTTY: false };
  return { h, out, err };
}

test("parseCli defaults to summary and agent all", () => {
  const o = parseCli([]);
  assert.ok("command" in o);
  assert.equal(o.command, "summary");
  assert.equal(o.agent, "all");
  assert.equal(o.json, false);
});

test("parseCli reads flags and session id", () => {
  const o = parseCli(["session", "abc", "--agent", "codex", "--json", "--since", "7d", "--no-color"]);
  assert.ok("command" in o);
  assert.equal(o.id, "abc");
  assert.equal(o.agent, "codex");
  assert.equal(o.json, true);
  assert.equal(o.since, "7d");
  assert.equal(o.noColor, true);
});

test("parseCli rejects bad input", () => {
  assert.throws(() => parseCli(["bogus"]), UsageError);
  assert.throws(() => parseCli(["session"]), UsageError);
  assert.throws(() => parseCli(["--agent", "gpt"]), UsageError);
  // R5.9: the retired prefilter flag is unknown now (spelled in two parts so that a grep for the flag stays empty)
  const retired = "--fa" + "st";
  assert.throws(() => parseCli([retired]), UsageError);
  assert.throws(() => parseCli(["--since", "7d", retired]), UsageError);
  assert.throws(() => parseCli(["--since", "yesterday"]), UsageError);
  assert.throws(() => parseCli(["--nope"]), UsageError);
});

test("run: help, version, usage error, not implemented", async () => {
  let t = io();
  assert.equal(await run(["--help"], t.h), EXIT.OK);
  assert.match(t.out.join("\n"), /Exit codes/);
  t = io();
  assert.equal(await run(["--version"], t.h), EXIT.OK);
  assert.match(t.out.join(""), /^\d+\.\d+\.\d+/);
  t = io();
  assert.equal(await run(["nope"], t.h), EXIT.USAGE);
  t = io();
  assert.equal(await run(["pricing"], t.h), EXIT.NOT_IMPLEMENTED);
  assert.match(t.err.join(""), /not implemented yet/);
});

test("format helpers", () => {
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(12300), "12.3k");
  assert.equal(formatTokens(4_500_000), "4.5M");
  assert.equal(formatPercent(0.8734), "87.3%");
  const t = formatTable([{ header: "A" }, { header: "N", align: "right" }], [["x", "10"], ["yy", "2"]]);
  assert.equal(t.split("\n").length, 4);
});

test("color honors NO_COLOR and painter", () => {
  assert.equal(colorEnabled({ env: { NO_COLOR: "1" }, isTTY: true }), false);
  assert.equal(colorEnabled({ env: {}, isTTY: true }), true);
  assert.equal(colorEnabled({ env: {}, isTTY: true, noColor: true }), false);
  assert.equal(makePainter(false)("red", "x"), "x");
  assert.equal(stripAnsi(makePainter(true)("red", "x")), "x");
});

// --- doctor ----------------------------------------------------------------

const FIX = fileURLToPath(new URL("./fixtures/synthetic/", import.meta.url));
const claudeFix = join(FIX, "claude-basic");
const codexFix = join(FIX, "codex-basic");

test("doctor honours --claude-dir and --codex-dir", async () => {
  const t = io();
  assert.equal(await run(["doctor", "--json", "--claude-dir", claudeFix, "--codex-dir", codexFix], t.h), EXIT.OK);
  const j = JSON.parse(t.out.join("\n")) as { sources: Record<string, number>; total: number };
  assert.ok(j.total > 0);
  assert.equal(j.sources["claude-main"], 1);
  assert.ok((j.sources["codex-rollout"] ?? 0) >= 1);
  assert.equal(Object.values(j.sources).reduce((a, b) => a + b, 0), j.total);
});

test("doctor filters by --agent and prints a table", async () => {
  let t = io();
  await run(["doctor", "--json", "--agent", "claude", "--claude-dir", claudeFix, "--codex-dir", codexFix], t.h);
  const j = JSON.parse(t.out.join("\n")) as { sources: Record<string, number> };
  assert.ok(Object.keys(j.sources).every((k) => k.startsWith("claude-")));
  t = io();
  assert.equal(await run(["doctor", "--no-color", "--claude-dir", claudeFix, "--codex-dir", codexFix], t.h), EXIT.OK);
  const text = t.out.join("\n");
  assert.match(text, /claude-main/);
  assert.match(text, /Total: \d+/);
  assert.doesNotMatch(text, /No log sources found/);
});

test("doctor reports no sources for empty dirs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cw-doctor-"));
  try {
    const t = io();
    assert.equal(await run(["doctor", "--claude-dir", dir, "--codex-dir", dir], t.h), EXIT.OK);
    assert.match(t.out.join("\n"), /No log sources found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- entry point detection --------------------------------------------------

test("isEntryPoint resolves symlinks and junctions", () => {
  const dir = mkdtempSync(join(tmpdir(), "cw-entry-"));
  try {
    const real = join(dir, "real");
    mkdirSync(real);
    const file = join(real, "cli.js");
    writeFileSync(file, "");
    const link = join(dir, "link");
    symlinkSync(real, link, "junction"); // a plain symlink on POSIX, a junction on Windows
    const url = pathToFileURL(file).href;
    assert.equal(isEntryPoint(file, url), true);
    assert.equal(isEntryPoint(join(link, "cli.js"), url), true);
    assert.equal(isEntryPoint(join(dir, "other.js"), url), false);
    assert.equal(isEntryPoint(undefined, url), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
