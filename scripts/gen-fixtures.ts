// Generates the synthetic example fixtures under test/fixtures/synthetic/.
//
//   node scripts/gen-fixtures.ts            write all scenarios
//   node scripts/gen-fixtures.ts --check    fail if files on disk differ from what would be generated
//
// Needs Node 22.18+ or 24 (native TypeScript type stripping). All data is synthetic.

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClaudeProject,
  CodexHome,
  CodexThread,
  writeFiles,
  zstdDecompress,
  type Compressor,
  type GeneratedFile,
} from '../test/fixtures/builder.ts';

export interface BuildOptions {
  /** Plant this canary in every field the readers must drop (spec R14.7). Committed trees use none. */
  canary?: string;
  /** Override the zstd compressor (tests simulate a Node without zstd with () => null). */
  compress?: Compressor;
}

export interface Scenario {
  name: string;
  description: string;
  build(opts?: BuildOptions): GeneratedFile[];
}

const MIN = 60_000;

function claudeBasic(opts: BuildOptions = {}): GeneratedFile[] {
  const p = new ClaudeProject({ canary: opts.canary });
  const s = p.session({ sessionId: 'synthetic-session-basic' });
  const m = s.main;
  m.user();
  // Cold start: all input is written (5m bucket), three content blocks give three copies.
  m.request({
    usage: { input: 5, cacheRead: 0, write5m: 20000, output: 300 },
    blocks: [{ type: 'thinking' }, { type: 'text' }, { type: 'tool_use', name: 'Read', id: 'synthetic-toolu-read-1' }],
  });
  m.user({ toolResultFor: 'synthetic-toolu-read-1' });
  // Warm turn: reads the previous context, writes a small 1h tail.
  m.request({ usage: { input: 8, cacheRead: 20000, write1h: 1500, output: 120 } });
  m.duplicateLast(); // one duplicated line
  m.user({ dtMs: 10 * MIN });
  // Rebuild after a gap: the cache was dropped.
  m.request({
    usage: { input: 6, cacheRead: 0, write5m: 21500, output: 90 },
    diagnostics: { type: 'cache_miss_reason_synthetic', cacheMissedInputTokens: 21500 },
  });
  m.compactBoundary({ trigger: 'manual', preTokens: 21500, postTokens: 4000 });
  // The summary record whose parent is the boundary binds it to the next request (R11.7).
  m.user({ compactSummary: true });
  m.request({ usage: { input: 7, cacheRead: 0, write5m: 4500, output: 60 }, finalSpeed: 'fast' });
  // Linked subagent (depth 1).
  const { agent } = s.spawnAgent({ agentType: 'general-purpose', model: 'sonnet', effort: 'medium', spawnDepth: 1 });
  agent.thread.user();
  agent.thread.request({ usage: { input: 4, cacheRead: 0, write5m: 8000, output: 200 } });
  agent.thread.request({ usage: { input: 4, cacheRead: 8000, write5m: 300, output: 50 } });
  // Unlinked subagent: meta without toolUseId.
  const orphan = s.agent({ agentType: 'general-purpose', toolUseId: null });
  orphan.thread.request({ usage: { input: 3, write5m: 1000, output: 10 } });
  // Bucket mismatch: cache_creation_input_tokens is 0 while the 1h bucket is non-zero.
  m.request({ usage: { input: 5, cacheRead: 4500, write1h: 1796, writeTotal: 0, output: 40 } });
  // Old shape without cache_creation object.
  m.request({ usage: { input: 5, cacheRead: 6300, writeTotal: 200, omitCacheCreation: true, output: 40 } });
  return p.files();
}

function claudeDepth2(opts: BuildOptions = {}): GeneratedFile[] {
  const p = new ClaudeProject({ canary: opts.canary });
  const s = p.session({ sessionId: 'synthetic-session-depth2' });
  s.main.user();
  s.main.request({ usage: { input: 3, write5m: 5000, output: 80 }, finalFirst: true, blocks: [{ type: 'text' }, { type: 'text' }] });
  const l1 = s.spawnAgent({ agentId: 'synthetic-agent-d1', spawnDepth: 1, agentType: 'general-purpose', model: 'opus', effort: 'high' });
  l1.agent.thread.request({ usage: { input: 3, write5m: 3000, output: 60 } });
  const l2 = s.spawnAgent({
    parent: l1.agent.thread,
    agentId: 'synthetic-agent-d2',
    spawnDepth: 2,
    parentAgentId: 'synthetic-agent-d1',
    agentType: 'general-purpose',
  });
  l2.agent.thread.request({ usage: { input: 3, write5m: 2000, output: 40 } });
  // Workflow agent: lives under subagents/workflows/wf_<run>/, never verified.
  const wf = s.agent({ agentId: 'synthetic-agent-wf1', workflowRunId: 'synthetic-run-1', omitMeta: true });
  wf.thread.request({ usage: { input: 3, write5m: 1000, output: 20 } });
  return p.files();
}

function claudeWorkflow(opts: BuildOptions = {}): GeneratedFile[] {
  // Workflow linking (R5.4), prefix corroboration (R10.6) and a Workflow tool_use in the parent.
  const p = new ClaudeProject({ canary: opts.canary });
  const s = p.session({ sessionId: 'synthetic-session-workflow' });
  const m = s.main;
  m.user();
  // The parent calls the Workflow tool. The log has no structural field tying this call to a run.
  m.request({
    usage: { input: 5, cacheRead: 0, write5m: 6000, output: 90 },
    blocks: [{ type: 'text' }, { type: 'tool_use', name: 'Workflow', id: 'synthetic-toolu-workflow-1' }],
  });
  m.user({ toolResultFor: 'synthetic-toolu-workflow-1' });
  m.request({ usage: { input: 6, cacheRead: 6000, write5m: 300, output: 40 } });

  // Run 1: run JSON and a journal with a started entry for wfa only. wfa is linked(directory).
  // wfb lives in the same run directory but has no started entry, so it is unlinked.
  s.workflowRun({
    runId: 'synthetic-run-1',
    status: 'completed',
    journal: [
      { type: 'started', agentId: 'synthetic-agent-wfa' },
      { type: 'finished', agentId: 'synthetic-agent-wfa' },
    ],
  });
  const wfa = s.agent({ agentId: 'synthetic-agent-wfa', workflowRunId: 'synthetic-run-1', omitMeta: true });
  wfa.thread.request({ usage: { input: 3, write5m: 2000, output: 30 } });
  const wfb = s.agent({ agentId: 'synthetic-agent-wfb', workflowRunId: 'synthetic-run-1', omitMeta: true });
  wfb.thread.request({ usage: { input: 3, write5m: 1500, output: 25 } });

  // Run 2: a started entry but no run JSON, so wfc is unlinked.
  s.workflowRun({ runId: 'synthetic-run-2', json: false, journal: [{ type: 'started', agentId: 'synthetic-agent-wfc' }] });
  const wfc = s.agent({ agentId: 'synthetic-agent-wfc', workflowRunId: 'synthetic-run-2', omitMeta: true });
  wfc.thread.request({ usage: { input: 3, write5m: 1000, output: 20 } });

  // Run 3: the runId inside the JSON does not match the directory suffix, so wfd is unlinked.
  s.workflowRun({
    runId: 'synthetic-run-3',
    jsonRunId: 'synthetic-run-other',
    status: 'failed',
    journal: [{ type: 'started', agentId: 'synthetic-agent-wfd' }],
  });
  const wfd = s.agent({ agentId: 'synthetic-agent-wfd', workflowRunId: 'synthetic-run-3', omitMeta: true });
  wfd.thread.request({ usage: { input: 3, write5m: 800, output: 15 } });

  // A linked subagent with a prefix.json (agent-level corroboration: 1h TTL and the chain model).
  const lin = s.spawnAgent({
    agentType: 'general-purpose',
    model: 'sonnet',
    spawnDepth: 1,
    prefix: { model: 'claude-sonnet-4-5', is1hCacheTTL: true, buildVersion: '2.1.293', toolsHash: 'synthetic-tools-hash', callCount: 2 },
  });
  lin.agent.thread.request({ usage: { input: 4, write1h: 2000, output: 30 } });
  lin.agent.thread.request({ usage: { input: 4, cacheRead: 2000, write1h: 100, output: 20 } });
  // A prefix file without toolsHash and without state.model (presence only is read).
  const bare = s.agent({ agentId: 'synthetic-agent-bare', toolUseId: null, prefix: { is1hCacheTTL: false, toolsHash: null } });
  bare.thread.request({ usage: { input: 2, write5m: 500, output: 10 } });
  return p.files();
}

function claudeReplay(opts: BuildOptions = {}): GeneratedFile[] {
  // Session B starts from a copy of session A's records (same uuids, requestIds, timestamps), then adds its own.
  const p = new ClaudeProject({ canary: opts.canary });
  const a = p.session({ sessionId: 'synthetic-session-origin', startMs: Date.UTC(2026, 0, 1) });
  a.main.user();
  a.main.request({ usage: { input: 5, write5m: 10000, output: 100 } });
  a.main.user();
  a.main.request({ usage: { input: 5, cacheRead: 10000, write5m: 500, output: 100 } });
  const b = p.session({ sessionId: 'synthetic-session-fork', startMs: Date.UTC(2026, 0, 1, 1) });
  b.main.replay(a.main.records);
  b.main.user();
  // First own response of the fork: positive counters, must still be counted.
  b.main.request({ usage: { input: 5, cacheRead: 10500, write5m: 700, output: 150 } });
  b.main.request({ usage: { input: 5, cacheRead: 11200, write5m: 100, output: 50 } });
  return p.files();
}

function codexBasic(opts: BuildOptions = {}): GeneratedFile[] {
  const home = new CodexHome({ canary: opts.canary, compress: opts.compress });
  const t = new CodexThread({ threadId: 'synthetic-thread-main', threadSource: 'user' });
  t.turnContext({ turnId: 'synthetic-turn-1' });
  t.eventMsg('task_started');
  t.responseItem('message', 'user');
  t.tokenUsage({ responseId: 'synthetic-resp-1', usage: { input: 12000, cached: 0, output: 400, reasoning: 100 }, emitTokenCountEvent: true });
  t.responseItem('function_call');
  t.responseItem('function_call_output');
  t.tokenUsage({ responseId: 'synthetic-resp-2', usage: { input: 12600, cached: 12000, output: 200, reasoning: 20 }, emitTokenCountEvent: true });
  t.turnContext({ turnId: 'synthetic-turn-2', compHash: 'synthetic-comp-hash-b' });
  t.tokenUsage({ responseId: 'synthetic-resp-3', usage: { input: 13000, cached: 0, output: 150, reasoning: 0 } });
  t.compacted({ windowNumber: 1 });
  t.tokenUsage({ responseId: 'synthetic-resp-4', usage: { input: 3000, cached: 0, output: 80 } });
  home.add(t, { splitAfter: [6] });
  const archived = new CodexThread({ threadId: 'synthetic-thread-archived', threadSource: 'user' });
  archived.turnContext({ turnId: 'synthetic-turn-a1' });
  archived.tokenUsage({ responseId: 'synthetic-resp-a1', usage: { input: 2000, output: 100 } });
  home.add(archived, { archived: true, zstd: true });
  return home.files();
}

function codexFork(opts: BuildOptions = {}): GeneratedFile[] {
  const home = new CodexHome({ canary: opts.canary, compress: opts.compress });
  const parent = new CodexThread({ threadId: 'synthetic-thread-parent', threadSource: 'user' });
  parent.turnContext({ turnId: 'synthetic-turn-p1' });
  parent.responseItem('message', 'user');
  parent.tokenUsage({ responseId: 'synthetic-resp-p1', usage: { input: 9000, output: 300 } });
  parent.responseItem('message', 'assistant');
  parent.tokenUsage({ responseId: 'synthetic-resp-p2', usage: { input: 9400, cached: 9000, output: 200 } });
  home.add(parent);

  // Plain fork: copied parent session_meta + copied prefix, no token_usage_record in the prefix.
  const fork = CodexThread.fork(parent, { threadId: 'synthetic-thread-fork', threadSource: 'user', prefixLen: 3 });
  fork.turnContext({ turnId: 'synthetic-turn-f1' });
  fork.tokenUsage({ responseId: 'synthetic-resp-f1', usage: { input: 9700, cached: 9400, output: 120 } });
  fork.tokenUsage({ responseId: 'synthetic-resp-f2', usage: { input: 9900, cached: 9700, output: 90 } });
  home.add(fork);

  // Linked subagent that is also a fork.
  const sub = CodexThread.fork(parent, {
    threadId: 'synthetic-thread-sub',
    threadSource: 'subagent',
    threadSpawn: { parentThreadId: parent.threadId, depth: 1 },
    agentRole: 'worker',
    prefixLen: 2,
  });
  sub.turnContext({ turnId: 'synthetic-turn-s1' });
  sub.tokenUsage({ responseId: 'synthetic-resp-s1', usage: { input: 9500, cached: 0, output: 70 } });
  home.add(sub);

  // Subagent with its own context (not a fork), parent missing from the scan.
  const orphan = new CodexThread({
    threadId: 'synthetic-thread-orphan',
    sessionId: 'synthetic-session-elsewhere',
    threadSource: 'subagent',
    threadSpawn: { parentThreadId: 'synthetic-thread-missing', depth: 1 },
  });
  orphan.turnContext({ turnId: 'synthetic-turn-o1' });
  orphan.tokenUsage({ responseId: 'synthetic-resp-o1', usage: { input: 1500, output: 30 } });
  home.add(orphan);
  return home.files();
}

export const scenarios: Scenario[] = [
  { name: 'claude-basic', description: 'Main file with partial/final copies, 5m/1h writes, rebuild, compact boundary, linked and unlinked subagent, bucket mismatch.', build: claudeBasic },
  { name: 'claude-depth2', description: 'Depth 1 and depth 2 linked subagents plus a workflow agent.', build: claudeDepth2 },
  { name: 'claude-workflow', description: 'Workflow runs (run JSON, journal, linked(directory) and unlinked agents), a Workflow tool_use, prefix.json files.', build: claudeWorkflow },
  { name: 'claude-replay', description: 'A second session that replays the first session records, then adds its own.', build: claudeReplay },
  { name: 'codex-basic', description: 'Codex thread with compaction split over two files, plus an archived zstd thread.', build: codexBasic },
  { name: 'codex-fork', description: 'Codex parent, fork, linked subagent fork and an unlinked subagent.', build: codexFork },
];

export const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'synthetic');

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

function asBuffer(c: string | Uint8Array): Buffer {
  return typeof c === 'string' ? Buffer.from(c, 'utf8') : Buffer.from(c);
}

export interface CheckOptions extends BuildOptions {
  /** Override the zstd decompressor (tests simulate a Node without zstd with () => null). */
  decompress?: (bytes: Uint8Array) => string | null;
}

export interface CheckReport {
  /** Differences between generated output and disk. Empty means in sync. */
  problems: string[];
  /** Files whose content could not be compared on this Node (no zstd). Their names are still checked. */
  skipped: string[];
}

/** Compare the committed trees with the generator. Names always; content decompressed for .zst. */
export function checkFixturesDetailed(outDir = OUT_DIR, opts: CheckOptions = {}): CheckReport {
  const decompress = opts.decompress ?? zstdDecompress;
  const problems: string[] = [];
  const skipped: string[] = [];
  const expected = new Set<string>();
  for (const sc of scenarios) {
    for (const f of sc.build(opts)) {
      const rel = `${sc.name}/${f.path}`;
      expected.add(rel);
      const abs = join(outDir, ...rel.split('/'));
      if (!existsSync(abs)) {
        problems.push(`missing ${rel}`);
      } else if (f.plain !== undefined) {
        // Compressor output differs between Node versions: compare the decompressed text instead.
        let actual: string | null;
        try {
          actual = decompress(readFileSync(abs));
        } catch {
          problems.push(`differs ${rel}`);
          continue;
        }
        if (actual === null) skipped.push(rel);
        else if (actual !== f.plain) problems.push(`differs ${rel}`);
      } else if (!readFileSync(abs).equals(asBuffer(f.content))) {
        problems.push(`differs ${rel}`);
      }
    }
  }
  for (const abs of listFiles(outDir)) {
    const rel = relative(outDir, abs).split('\\').join('/');
    if (!expected.has(rel)) problems.push(`unexpected ${rel}`);
  }
  return { problems, skipped };
}

/** Returns a list of differences between generated output and disk. Empty means in sync. */
export function checkFixtures(outDir = OUT_DIR, opts: CheckOptions = {}): string[] {
  return checkFixturesDetailed(outDir, opts).problems;
}

export function writeAll(outDir = OUT_DIR, opts: BuildOptions = {}): number {
  const built = scenarios.map((sc) => ({ sc, files: sc.build(opts) }));
  const missing = built.flatMap((b) => b.files.filter((f) => f.unavailable).map((f) => `${b.sc.name}/${f.path}`));
  if (missing.length > 0) {
    // Rewriting would delete the committed .zst files, so refuse instead of writing a partial tree.
    throw new Error(`zstd is required to regenerate fixtures (Node 22.15 or newer). Cannot produce: ${missing.join(', ')}`);
  }
  let n = 0;
  for (const { sc, files } of built) {
    rmSync(join(outDir, sc.name), { recursive: true, force: true });
    writeFiles(join(outDir, sc.name), files);
    n += files.length;
  }
  return n;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const { problems, skipped } = checkFixturesDetailed();
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    for (const rel of skipped) console.log(`skipped content check (this Node has no zstd): ${rel}`);
    console.log('fixtures in sync');
  } else {
    console.log(`wrote ${writeAll()} files to ${OUT_DIR}`);
  }
}
