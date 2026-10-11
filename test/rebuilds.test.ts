import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, EXIT, type CliIO } from "../src/cli.js";
import { ClaudeProject } from "./fixtures/builder.ts";

function io(): { h: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { h: { out: (s) => out.push(s), err: (s) => err.push(s), env: {}, isTTY: false, now: () => Date.UTC(2026, 0, 2) }, out, err };
}

interface Json {
  events_total: number;
  by_level: Record<string, number>;
  events: { cause: string; evidence: string; rebuilt_tokens: string; usd: number | null }[];
}

async function rebuildsFor(build: (p: ClaudeProject) => void): Promise<Json> {
  const dir = mkdtempSync(join(tmpdir(), "cw-rebuilds-"));
  try {
    const p = new ClaudeProject();
    build(p);
    p.writeTo(dir);
    const t = io();
    const code = await run(["rebuilds", "--json", "--claude-dir", dir, "--codex-dir", join(dir, "none")], t.h);
    assert.equal(code, EXIT.OK, t.err.join("\n"));
    return JSON.parse(t.out.join("\n")) as Json;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MODEL = "claude-opus-5-5";

test("a warm chain has no rebuild", async () => {
  const j = await rebuildsFor((p) => {
    const s = p.session({ model: MODEL });
    s.main.request({ usage: { input: 5, write5m: 30000, output: 10 } });
    s.main.request({ usage: { input: 5, cacheRead: 30000, write5m: 500, output: 10 }, dtMs: 20_000 });
    s.main.request({ usage: { input: 5, cacheRead: 30500, write5m: 500, output: 10 }, dtMs: 20_000 });
  });
  assert.equal(j.events_total, 0);
});

test("an idle gap past the 5 minute TTL is a ttl_expired hypothesis", async () => {
  const j = await rebuildsFor((p) => {
    const s = p.session({ model: MODEL });
    s.main.request({ usage: { input: 5, write5m: 30000, output: 10 } });
    s.main.user({ dtMs: 12 * 60_000 });
    s.main.request({ usage: { input: 5, cacheRead: 0, write5m: 30500, output: 10 } });
  });
  assert.equal(j.events_total, 1);
  assert.equal(j.events[0]!.cause, "ttl_expired");
  assert.equal(j.events[0]!.evidence, "hypothesis");
  assert.equal(j.events[0]!.rebuilt_tokens, "30000");
  assert.ok(j.events[0]!.usd !== null && j.events[0]!.usd > 0);
});

test("a logged cache miss reason makes the event confirmed", async () => {
  const j = await rebuildsFor((p) => {
    const s = p.session({ model: MODEL });
    s.main.request({ usage: { input: 5, write5m: 30000, output: 10 } });
    s.main.request({ usage: { input: 5, cacheRead: 0, write5m: 30500, output: 10 }, dtMs: 10_000, diagnostics: { type: "tools_changed" } });
  });
  assert.equal(j.events_total, 1);
  assert.equal(j.events[0]!.cause, "tools_or_system_changed");
  assert.equal(j.events[0]!.evidence, "confirmed");
});

test("a short gap with no signal stays unknown", async () => {
  const j = await rebuildsFor((p) => {
    const s = p.session({ model: MODEL });
    s.main.request({ usage: { input: 5, write5m: 30000, output: 10 } });
    s.main.request({ usage: { input: 5, cacheRead: 0, write5m: 30500, output: 10 }, dtMs: 10_000 });
  });
  assert.equal(j.events_total, 1);
  assert.equal(j.events[0]!.cause, "unknown");
  assert.equal(j.by_level["unknown"], 1);
});

test("a shrinking context is compaction", async () => {
  const j = await rebuildsFor((p) => {
    const s = p.session({ model: MODEL });
    s.main.request({ usage: { input: 5, write5m: 80000, output: 10 } });
    s.main.request({ usage: { input: 5, cacheRead: 0, write5m: 9000, output: 10 }, dtMs: 10_000 });
  });
  assert.equal(j.events_total, 1);
  assert.equal(j.events[0]!.cause, "compaction_or_clear");
});

test("text output names the cause", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cw-rebuilds-"));
  try {
    const p = new ClaudeProject();
    const s = p.session({ model: MODEL });
    s.main.request({ usage: { input: 5, write5m: 30000, output: 10 } });
    s.main.user({ dtMs: 12 * 60_000 });
    s.main.request({ usage: { input: 5, cacheRead: 0, write5m: 30500, output: 10 } });
    p.writeTo(dir);
    const t = io();
    assert.equal(await run(["rebuilds", "--claude-dir", dir, "--codex-dir", join(dir, "none")], t.h), EXIT.OK);
    const text = t.out.join("\n");
    assert.match(text, /1 suspected prefix rebuilds/);
    assert.match(text, /idle past cache TTL: idle 12m, cache TTL 5m/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
