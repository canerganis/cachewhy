import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { classifyClaude, discover, inProject } from "../src/discover.ts";

let tmp: string;
const S = "synthetic-session-0001";

function put(p: string, content = "{}\n"): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function layoutClaude(projects: string): void {
  put(join(projects, "proj-a", `${S}.jsonl`), '{"a":1}\n');
  put(join(projects, "proj-a", S, "subagents", "agent-abc.jsonl"));
  put(join(projects, "proj-a", S, "subagents", "agent-abc.meta.json"));
  put(join(projects, "proj-a", S, "subagents", "agent-abc.prefix.json"));
  put(join(projects, "proj-a", S, "subagents", "workflows", "wf_run1", "journal.jsonl"));
  put(join(projects, "proj-a", S, "subagents", "workflows", "wf_run1", "agent-w1.jsonl"));
  put(join(projects, "proj-a", S, "subagents", "workflows", "wf_run1", "agent-w1.meta.json"));
  put(join(projects, "proj-a", S, "subagents", "workflows", "wf_run1", "agent-w1.prefix.json"));
  put(join(projects, "proj-a", S, "subagents", "workflows", "wf_run1", "agent-w1.other.json"));
  put(join(projects, "proj-a", S, "workflows", "wf_run1.json"));
  put(join(projects, "proj-a", "notes.txt"));
  put(join(projects, "proj-a", S, "subagents", "other.txt"));
}

function layoutCodex(home: string): void {
  put(join(home, "sessions", "2026", "01", "02", "rollout-2026-01-02T00-00-00-x.jsonl"));
  put(join(home, "sessions", "2026", "01", "02", "unrelated.jsonl"));
  put(join(home, "archived_sessions", "rollout-2025-12-31T00-00-00-y.jsonl.zst"), "zst");
  put(join(home, "archived_sessions", "rollout-2025-12-30T00-00-00-z.jsonl"));
}

describe("discover", () => {
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "cachewhy-discover-"));
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns diagnostics and no files when nothing exists", async () => {
    const home = join(tmp, "empty-home");
    mkdirSync(home);
    const r = await discover({ home, env: {} });
    assert.equal(r.files.length, 0);
    assert.ok(r.diagnostics.some((d) => d.code === "root_missing"));
    assert.ok(r.diagnostics.every((d) => d.level === "info"));
  });

  it("classifies a Claude tree from ~/.claude/projects", async () => {
    const home = join(tmp, "h1");
    layoutClaude(join(home, ".claude", "projects"));
    const r = await discover({ home, env: {} });
    const by = new Map(r.files.map((f) => [`${f.kind}:${f.relPath}`, f]));
    assert.equal(r.files.length, 9);
    const main = by.get(`claude-main:proj-a/${S}.jsonl`);
    assert.equal(main?.size, 8);
    assert.equal(main?.sessionId, S);
    assert.ok((main?.mtimeMs ?? 0) > 0);
    const sub = by.get(`claude-subagent:proj-a/${S}/subagents/agent-abc.jsonl`);
    assert.equal(sub?.agentId, "abc");
    assert.equal(sub?.workflowAgent, undefined);
    assert.ok(by.has(`claude-subagent-meta:proj-a/${S}/subagents/agent-abc.meta.json`));
    assert.ok(by.has(`claude-subagent-prefix:proj-a/${S}/subagents/agent-abc.prefix.json`));
    const j = by.get(`claude-workflow-journal:proj-a/${S}/subagents/workflows/wf_run1/journal.jsonl`);
    assert.equal(j?.runId, "run1");
    const wa = by.get(`claude-subagent:proj-a/${S}/subagents/workflows/wf_run1/agent-w1.jsonl`);
    assert.equal(wa?.workflowAgent, true);
    assert.ok(by.has(`claude-workflow-run:proj-a/${S}/workflows/wf_run1.json`));
    // S12.6: the JSON sidecars of a workflow agent are discovered files; an unknown name in that directory is not
    const wm = by.get(`claude-subagent-meta:proj-a/${S}/subagents/workflows/wf_run1/agent-w1.meta.json`);
    assert.equal(wm?.workflowAgent, true);
    assert.equal(wm?.agentId, "w1");
    assert.equal(wm?.runId, "run1");
    assert.equal(by.get(`claude-subagent-prefix:proj-a/${S}/subagents/workflows/wf_run1/agent-w1.prefix.json`)?.workflowAgent, true);
    assert.ok(![...by.keys()].some((k) => k.endsWith("agent-w1.other.json")));
  });

  it("classifyClaude ignores unknown shapes", () => {
    assert.equal(classifyClaude(["p", "x.txt"]), null);
    assert.equal(classifyClaude(["p", "s", "subagents", "x.jsonl"]), null);
    assert.equal(classifyClaude(["p", "s", "a", "b.jsonl"]), null);
  });

  it("reads CLAUDE_CONFIG_DIR as a comma separated list and dedupes repeats", async () => {
    const home = join(tmp, "h2");
    mkdirSync(home);
    const c1 = join(tmp, "cfg1");
    const c2 = join(tmp, "cfg2");
    layoutClaude(join(c1, "projects"));
    put(join(c2, "projects", "proj-b", "synthetic-session-0002.jsonl"));
    const r = await discover({ home, env: { CLAUDE_CONFIG_DIR: `${c1},${c2},${c1}` } });
    assert.equal(r.files.filter((f) => f.kind === "claude-main").length, 2);
    assert.equal(r.files.length, 10);
    assert.ok(r.diagnostics.some((d) => d.code === "root_duplicate"));
  });

  it("dedupes a symlinked root", async (t) => {
    const home = join(tmp, "h3");
    layoutClaude(join(home, ".claude", "projects"));
    mkdirSync(join(home, ".config", "claude"), { recursive: true });
    try {
      symlinkSync(join(home, ".claude", "projects"), join(home, ".config", "claude", "projects"), "junction");
    } catch {
      t.skip("symlinks not permitted");
      return;
    }
    const r = await discover({ home, env: {} });
    assert.equal(r.files.length, 9);
    assert.equal(r.roots.filter((x) => x.agent === "claude").length, 1);
    assert.ok(r.diagnostics.some((d) => d.code === "root_duplicate"));
  });

  it("does not loop on a symlinked directory cycle", async (t) => {
    const home = join(tmp, "h4");
    const projects = join(home, ".claude", "projects");
    put(join(projects, "p", `${S}.jsonl`));
    try {
      symlinkSync(projects, join(projects, "p", "loop"), "junction");
    } catch {
      t.skip("symlinks not permitted");
      return;
    }
    const r = await discover({ home, env: {} });
    assert.equal(r.files.length, 1);
  });

  it("finds Codex rollouts and archived zst via CODEX_HOME", async () => {
    const home = join(tmp, "h5");
    mkdirSync(home);
    const ch = join(tmp, "codex-home");
    layoutCodex(ch);
    const r = await discover({ home, env: { CODEX_HOME: ch } });
    const kinds = r.files.map((f) => `${f.kind}:${f.relPath}`).sort();
    assert.deepEqual(kinds, [
      "codex-archived-zst:rollout-2025-12-31T00-00-00-y.jsonl.zst",
      "codex-rollout:2026/01/02/rollout-2026-01-02T00-00-00-x.jsonl",
      "codex-rollout:rollout-2025-12-30T00-00-00-z.jsonl",
    ]);
  });

  it("falls back to ~/.codex", async () => {
    const home = join(tmp, "h6");
    layoutCodex(join(home, ".codex"));
    const r = await discover({ home, env: {} });
    assert.equal(r.files.length, 3);
  });

  it("explicit overrides replace defaults and accept config or projects dirs", async () => {
    const home = join(tmp, "h7");
    layoutClaude(join(home, ".claude", "projects"));
    const cfg = join(tmp, "ov-cfg");
    put(join(cfg, "projects", "p", "synthetic-session-0003.jsonl"));
    const direct = join(tmp, "ov-projects");
    put(join(direct, "p", "synthetic-session-0004.jsonl"));
    const sessionsOnly = join(tmp, "ov-codex", "sessions");
    put(join(sessionsOnly, "rollout-a.jsonl"));
    const r = await discover({ home, env: {}, claudeDirs: [cfg, direct], codexDirs: [sessionsOnly] });
    assert.equal(r.files.filter((f) => f.agent === "claude").length, 2);
    assert.equal(r.files.filter((f) => f.agent === "codex").length, 1);
    assert.ok(!r.files.some((f) => f.relPath.startsWith("proj-a")));
  });

  it("warns for a missing explicit dir and does not throw", async () => {
    const home = join(tmp, "h8");
    mkdirSync(home);
    const r = await discover({ home, env: {}, claudeDirs: [join(tmp, "nope")], codexDirs: [join(tmp, "nope2")] });
    assert.equal(r.files.length, 0);
    assert.ok(r.diagnostics.some((d) => d.level === "warn" && d.code === "root_missing"));
  });

  it("reports a file used as a root", async () => {
    const home = join(tmp, "h9");
    mkdirSync(home);
    const f = join(tmp, "afile");
    writeFileSync(f, "x");
    const r = await discover({ home, env: {}, claudeDirs: [f] });
    assert.ok(r.diagnostics.some((d) => d.code === "root_not_directory"));
  });

  it("inProject is a Claude project directory match and never matches a Codex file (R5.9 output filter)", () => {
    assert.equal(inProject({ agent: "claude", relPath: "proj-a/x.jsonl" }, "proj-a"), true);
    assert.equal(inProject({ agent: "claude", relPath: "proj-a/x.jsonl" }, "proj"), false);
    assert.equal(inProject({ agent: "claude", relPath: "proj-b/proj-a/x.jsonl" }, "proj-a"), false);
    assert.equal(inProject({ agent: "codex", relPath: "proj-a/x.jsonl" }, "proj-a"), false);
  });
});
