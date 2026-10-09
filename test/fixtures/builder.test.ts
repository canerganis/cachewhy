import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeProject, CodexThread, CodexHome, IdGen, withRawLines, withTruncatedTail, zstdCompress, zstdDecompress, type GeneratedFile } from './builder.ts';
import { checkFixtures, checkFixturesDetailed, scenarios, writeAll, OUT_DIR } from '../../scripts/gen-fixtures.ts';

const zstdAvailable = zstdCompress('x') !== null;

function parse(file: GeneratedFile | undefined): Array<Record<string, any>> {
  assert.ok(file, 'file exists');
  return String(file.content).trim().split('\n').map((l) => JSON.parse(l));
}
const find = (files: GeneratedFile[], suffix: string) => files.find((f) => f.path.endsWith(suffix));

test('ids are deterministic and synthetic-prefixed', () => {
  const a = new IdGen();
  const b = new IdGen();
  assert.equal(a.next('req'), 'synthetic-req-0001');
  assert.equal(a.next('req'), 'synthetic-req-0002');
  assert.equal(b.next('req'), 'synthetic-req-0001');
});

test('claude request: one record per block, shared key, final copy carries speed and output', () => {
  const p = new ClaudeProject();
  const s = p.session({ sessionId: 'synthetic-session-t' });
  const r = s.main.request({
    usage: { input: 7, cacheRead: 100, write5m: 30, write1h: 20, output: 55 },
    blocks: [{ type: 'thinking' }, { type: 'text' }, { type: 'tool_use', name: 'Read' }],
  });
  assert.equal(r.records.length, 3);
  const msgs = r.records.map((x) => x.message as any);
  assert.ok(r.records.every((x) => x.requestId === r.requestId));
  assert.ok(msgs.every((m) => m.id === r.messageId));
  for (const m of msgs) {
    assert.equal(m.usage.input_tokens, 7);
    assert.equal(m.usage.cache_read_input_tokens, 100);
    assert.equal(m.usage.cache_creation_input_tokens, 50);
    assert.deepEqual(m.usage.cache_creation, { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 20 });
  }
  assert.deepEqual(msgs.map((m) => 'speed' in m.usage), [false, false, true]);
  assert.equal(msgs[2].usage.output_tokens, 55);
  assert.ok(msgs[0].usage.output_tokens < 55 && msgs[1].usage.output_tokens < 55);
  assert.equal(msgs[2].stop_reason, 'tool_use');
  assert.equal(r.toolUseIds.length, 1);
});

test('claude usage variants: bucket mismatch, missing cache_creation, no final copy, finalFirst', () => {
  const s = new ClaudeProject().session();
  const mm = s.main.request({ usage: { write1h: 1796, writeTotal: 0 } });
  assert.equal((mm.records[0]!.message as any).usage.cache_creation_input_tokens, 0);
  assert.equal((mm.records[0]!.message as any).usage.cache_creation.ephemeral_1h_input_tokens, 1796);
  const old = s.main.request({ usage: { writeTotal: 9, omitCacheCreation: true } });
  assert.equal('cache_creation' in (old.records[0]!.message as any).usage, false);
  const nf = s.main.request({ finalSpeed: null, blocks: [{ type: 'text' }, { type: 'text' }] });
  assert.ok(nf.records.every((x) => !('speed' in (x.message as any).usage)));
  const ff = s.main.request({ finalFirst: true, blocks: [{ type: 'text' }, { type: 'text' }] });
  assert.equal('speed' in (ff.records[0]!.message as any).usage, true);
});

test('claude records: compact_boundary, duplicates and replay keep uuids and key fields', () => {
  const p = new ClaudeProject();
  const a = p.session({ sessionId: 'synthetic-session-a' });
  a.main.user();
  a.main.request();
  const cb = a.main.compactBoundary({ trigger: 'auto', preTokens: 10, postTokens: 5 });
  assert.equal(cb.type, 'system');
  assert.equal(cb.subtype, 'compact_boundary');
  assert.deepEqual(cb.compactMetadata, { trigger: 'auto', preTokens: 10, postTokens: 5 });
  assert.equal(cb.logicalParentUuid, a.main.records[1]!.uuid);
  const n = a.main.records.length;
  a.main.duplicateLast(2);
  assert.equal(a.main.records.length, n + 2);
  assert.deepEqual(a.main.records[n], a.main.records[n - 2]);
  const b = p.session({ sessionId: 'synthetic-session-b' });
  b.main.replay(a.main.records);
  assert.equal(b.main.records[0]!.sessionId, 'synthetic-session-b'); // the copying session owns the copy
  assert.equal(b.main.records[0]!.uuid, a.main.records[0]!.uuid);
  assert.equal(b.main.records[1]!.uuid, a.main.records[1]!.uuid);
});

test('claude subagent: linked spawn, meta shape, depth 2, workflow and unlinked variants', () => {
  const p = new ClaudeProject();
  const s = p.session({ sessionId: 'synthetic-session-s' });
  const l1 = s.spawnAgent({ agentId: 'synthetic-agent-1', agentType: 'x', model: 'sonnet', effort: 'high', spawnDepth: 1 });
  const l2 = s.spawnAgent({ parent: l1.agent.thread, agentId: 'synthetic-agent-2', spawnDepth: 2, parentAgentId: 'synthetic-agent-1' });
  l1.agent.thread.request();
  l2.agent.thread.request();
  const wf = s.agent({ agentId: 'synthetic-agent-3', workflowRunId: 'synthetic-run', omitMeta: true });
  wf.thread.request();
  s.agent({ agentId: 'synthetic-agent-4', toolUseId: null });
  const files = p.files();

  const meta1 = JSON.parse(String(find(files, 'agent-synthetic-agent-1.meta.json')!.content));
  assert.equal(meta1.toolUseId, l1.toolUseId);
  assert.deepEqual([meta1.agentType, meta1.model, meta1.effort, meta1.spawnDepth], ['x', 'sonnet', 'high', 1]);
  const meta2 = JSON.parse(String(find(files, 'agent-synthetic-agent-2.meta.json')!.content));
  assert.equal(meta2.parentAgentId, 'synthetic-agent-1');

  const main = parse(find(files, 'synthetic-session-s.jsonl'));
  const tu = main.flatMap((r) => r.message?.content ?? []).find((b: any) => b.type === 'tool_use' && b.id === l1.toolUseId);
  assert.equal(tu.name, 'Agent');
  const a1 = parse(find(files, 'agent-synthetic-agent-1.jsonl'));
  const a1tu = a1.flatMap((r) => r.message?.content ?? []).find((b: any) => b.type === 'tool_use' && b.id === l2.toolUseId);
  assert.equal(a1tu.name, 'Agent');
  assert.ok(a1.every((r) => r.agentId === 'synthetic-agent-1' && r.isSidechain === true && r.sessionId === 'synthetic-session-s'));

  assert.ok(files.some((f) => f.path.includes('/subagents/workflows/wf_synthetic-run/agent-synthetic-agent-3.jsonl')));
  assert.equal(find(files, 'agent-synthetic-agent-3.meta.json'), undefined);
  const meta4 = JSON.parse(String(find(files, 'agent-synthetic-agent-4.meta.json')!.content));
  assert.equal('toolUseId' in meta4, false);
});

test('codex thread: envelope, usage record, running totals, invariants', () => {
  const t = new CodexThread({ threadId: 'synthetic-thread-t' });
  t.turnContext({ turnId: 'synthetic-turn-1' });
  const r1 = t.tokenUsage({ responseId: 'synthetic-resp-1', usage: { input: 100, cached: 40, output: 10, reasoning: 5 } });
  const r2 = t.tokenUsage({ responseId: 'synthetic-resp-2', usage: { input: 200, cached: 100, output: 20 } });
  assert.deepEqual(t.lines.map((l) => l.ordinal), [0, 1, 2, 3]);
  assert.equal(t.lines[0]!.type, 'session_meta');
  const p1 = r1.line.payload as any;
  assert.equal(p1.response_id, 'synthetic-resp-1');
  assert.equal(p1.thread_id, 'synthetic-thread-t');
  assert.equal(p1.turn_id, 'synthetic-turn-1');
  assert.equal(p1.usage.total_tokens, 110);
  assert.ok(p1.usage.reasoning_output_tokens <= p1.usage.output_tokens);
  const p2 = r2.line.payload as any;
  assert.equal(p2.thread_token_usage.total_tokens, p1.usage.total_tokens + p2.usage.total_tokens);
  assert.equal(p2.thread_token_usage.input_tokens, 300);
});

test('codex fork: copied parent meta, prefix without usage records, history start ordinal', () => {
  const parent = new CodexThread({ threadId: 'synthetic-thread-p' });
  parent.turnContext();
  parent.responseItem('message', 'user');
  parent.tokenUsage({ usage: { input: 10, output: 1 } });
  parent.responseItem('message', 'assistant');
  const fork = CodexThread.fork(parent, { threadId: 'synthetic-thread-f', prefixLen: 3 });
  const metas = fork.lines.filter((l) => l.type === 'session_meta');
  assert.equal(metas.length, 2);
  const own = metas.find((m) => m.payload.id === 'synthetic-thread-f')!;
  const copied = metas.find((m) => m.payload.id === 'synthetic-thread-p')!;
  assert.equal(own.payload.forked_from_id, 'synthetic-thread-p');
  assert.equal(copied.payload.forked_from_id, undefined);
  // A copied record keeps the envelope of the parent's record (timestamp and ordinal). The parent's usage record at
  // ordinal 3 is not copied, so the copied prefix has a gap and the fork's own lines start after the last copied ordinal.
  assert.equal(own.payload.subagent_history_start_ordinal, 5);
  assert.ok(fork.lines.every((l) => l.type !== 'token_usage_record'));
  const prefix = fork.lines.filter((l) => (l.ordinal ?? -1) < 5);
  assert.equal(prefix.length, 4);
  assert.deepEqual(fork.lines.map((l) => l.ordinal), [0, 1, 2, 4, 5]);
  assert.equal(own.ordinal, 5);
  const original = parent.lines.filter((l) => l.type !== 'token_usage_record');
  for (const copy of fork.lines.slice(0, 4)) {
    const orig = original.find((l) => l.ordinal === copy.ordinal)!;
    assert.equal(copy.timestamp, orig.timestamp);
    assert.deepEqual(copy, orig);
  }
  const first = CodexThread.fork(parent, { threadId: 'synthetic-thread-f2', ownMetaPosition: 'first', prefixLen: 2 });
  assert.equal(first.lines[0]!.payload.id, 'synthetic-thread-f2');
});

test('codex subagent meta: thread_spawn, other, and compaction copy marker', () => {
  const sub = new CodexThread({ threadId: 'synthetic-thread-s', threadSource: 'subagent', threadSpawn: { parentThreadId: 'synthetic-thread-p', depth: 2 } });
  const src = (sub.lines[0]!.payload as any).source;
  assert.deepEqual(src, { subagent: { thread_spawn: { parent_thread_id: 'synthetic-thread-p', depth: 2 } } });
  const other = new CodexThread({ subagentOther: 'synthetic-kind' });
  assert.deepEqual((other.lines[0]!.payload as any).source, { subagent: { other: 'synthetic-kind' } });
  const c = sub.compacted({ latestTokenUsageRecord: null });
  assert.equal((c.payload as any).latest_token_usage_record, null);
});

test('codex multi-file split and archived zstd', () => {
  const t = new CodexThread({ threadId: 'synthetic-thread-m' });
  for (let i = 0; i < 4; i++) t.tokenUsage();
  const files = t.files({ splitAfter: [2] });
  assert.equal(files.length, 2);
  const lines = files.flatMap((f) => String(f.content).trim().split('\n'));
  assert.equal(lines.length, t.lines.length);
  const arch = new CodexHome();
  arch.add(t, { archived: true, zstd: true });
  const f = arch.files()[0]!;
  assert.ok(f.path.startsWith('archived_sessions/'));
  // The name is the same on every Node. Without zstd the file is flagged, not renamed.
  assert.ok(f.path.endsWith('.zst'));
  assert.equal(f.plain, arch.threads[0]!.thread.toJsonl());
  assert.equal(f.unavailable === true, !zstdAvailable);
});

test('codex archived zstd without zstd support keeps the name and is flagged unavailable', () => {
  const t = new CodexThread({ threadId: 'synthetic-thread-n' });
  t.tokenUsage();
  const home = new CodexHome({ compress: () => null });
  home.add(t, { archived: true, zstd: true });
  const f = home.files()[0]!;
  assert.ok(f.path.endsWith('.jsonl.zst'));
  assert.equal(f.unavailable, true);
  assert.equal(f.plain, t.toJsonl());
  const dir = mkdtempSync(join(tmpdir(), 'cachewhy-fx-'));
  try {
    home.writeTo(dir);
    assert.equal(existsSync(join(dir, ...f.path.split('/'))), false, 'unavailable files are not written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex archived zstd round-trips through decompression', { skip: zstdAvailable ? false : 'this Node has no zstd (needs 22.15+)' }, () => {
  const t = new CodexThread({ threadId: 'synthetic-thread-z' });
  t.tokenUsage();
  t.compacted();
  const home = new CodexHome();
  home.add(t, { archived: true, zstd: true });
  const f = home.files()[0]!;
  assert.equal(f.unavailable, undefined);
  assert.equal(zstdDecompress(f.content as Uint8Array), t.toJsonl());
});

test('privacy: every generated string id and text is synthetic', () => {
  const bad = /(?:[A-Za-z]:\\|\/Users\/|\/home\/)/;
  for (const sc of scenarios) {
    for (const f of sc.build()) {
      assert.ok(!bad.test(f.path), f.path);
      const text = f.plain ?? String(f.content);
      assert.ok(!bad.test(text), f.path);
      for (const line of text.trim().split('\n')) {
        for (const m of line.matchAll(/"(?:id|session_id|sessionId|agentId|requestId|response_id|thread_id|turn_id|toolUseId|forked_from_id|parent_thread_id|uuid)":"([^"]+)"/g)) {
          assert.ok(m[1]!.startsWith('synthetic-'), `${f.path}: ${m[1]}`);
        }
      }
    }
  }
});

test('generated builds are deterministic', () => {
  for (const sc of scenarios) {
    const a = sc.build().map((f) => `${f.path}\n${Buffer.from(f.content).toString('base64')}`);
    const b = sc.build().map((f) => `${f.path}\n${Buffer.from(f.content).toString('base64')}`);
    assert.deepEqual(a, b, sc.name);
  }
});

test('committed synthetic fixtures match the generator', () => {
  assert.deepEqual(checkFixtures(), []);
});

test('fixture check compares names and decompressed zstd content, and skips only content without zstd', () => {
  // Simulated Node without zstd: names still match, the .zst file is reported as skipped.
  const sim = checkFixturesDetailed(OUT_DIR, { compress: () => null, decompress: () => null });
  assert.deepEqual(sim.problems, []);
  assert.equal(sim.skipped.length, 1);
  assert.ok(sim.skipped[0]!.endsWith('.jsonl.zst'));
  // Real run: nothing skipped where zstd exists.
  const real = checkFixturesDetailed();
  assert.deepEqual(real.problems, []);
  assert.equal(real.skipped.length, zstdAvailable ? 0 : 1);
  // Regenerating without zstd must refuse instead of deleting the committed .zst file.
  const dir = mkdtempSync(join(tmpdir(), 'cachewhy-fx-'));
  try {
    assert.throws(() => writeAll(dir, { compress: () => null }), /zstd is required/);
    assert.equal(existsSync(join(dir, 'codex-basic')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow runs, journal, prefix.json and compact summary shapes', () => {
  const p = new ClaudeProject();
  const s = p.session({ sessionId: 'synthetic-session-wf' });
  s.main.user();
  s.main.compactBoundary();
  const sum = s.main.user({ compactSummary: true });
  const boundary = s.main.records[1]!;
  assert.equal(sum.isCompactSummary, true);
  assert.equal(sum.parentUuid, boundary.uuid);
  s.workflowRun({ runId: 'synthetic-run-a', status: 'completed', journal: [{ type: 'started', agentId: 'synthetic-agent-a' }] });
  s.workflowRun({ runId: 'synthetic-run-b', json: false });
  s.workflowRun({ runId: 'synthetic-run-c', jsonRunId: 'synthetic-run-x' });
  s.agent({ agentId: 'synthetic-agent-a', workflowRunId: 'synthetic-run-a', omitMeta: true });
  s.agent({ agentId: 'synthetic-agent-p', prefix: { model: 'm', is1hCacheTTL: true, buildVersion: '2.1.293', toolsHash: null } });
  const files = p.files();
  const run = JSON.parse(String(find(files, '/workflows/wf_synthetic-run-a.json')!.content));
  assert.deepEqual([run.runId, run.status], ['synthetic-run-a', 'completed']);
  assert.equal(find(files, '/workflows/wf_synthetic-run-b.json'), undefined);
  assert.equal(JSON.parse(String(find(files, '/workflows/wf_synthetic-run-c.json')!.content)).runId, 'synthetic-run-x');
  const journal = parse(find(files, '/subagents/workflows/wf_synthetic-run-a/journal.jsonl'));
  assert.deepEqual([journal[0]!.type, journal[0]!.agentId], ['started', 'synthetic-agent-a']);
  assert.equal(find(files, '/wf_synthetic-run-b/journal.jsonl'), undefined);
  const prefix = JSON.parse(String(find(files, 'agent-synthetic-agent-p.prefix.json')!.content));
  assert.deepEqual(prefix.state, { model: 'm', is1hCacheTTL: true, buildVersion: '2.1.293' });
});

test('committed trees contain the R1.2 file shapes the readers need', () => {
  const claude = scenarios.find((s) => s.name === 'claude-workflow')!.build();
  const paths = claude.map((f) => f.path);
  assert.ok(paths.some((x) => x.includes('/workflows/wf_') && x.endsWith('.json') && !x.includes('/subagents/')), 'workflow run json');
  assert.ok(paths.some((x) => x.endsWith('/journal.jsonl')), 'journal');
  assert.ok(paths.some((x) => x.endsWith('.prefix.json')), 'prefix json');
  const main = String(find(claude, 'synthetic-session-workflow.jsonl')!.content);
  assert.ok(main.includes('"name":"Workflow"'), 'Workflow tool_use');
  const basic = String(find(scenarios.find((s) => s.name === 'claude-basic')!.build(), 'synthetic-session-basic.jsonl')!.content);
  assert.ok(basic.includes('"isCompactSummary":true'), 'isCompactSummary');
});

test('writeTo writes the tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cachewhy-fx-'));
  try {
    const p = new ClaudeProject();
    p.session({ sessionId: 'synthetic-session-w' }).main.request();
    p.writeTo(dir);
    const path = join(dir, 'projects', 'synthetic-project', 'synthetic-session-w.jsonl');
    assert.ok(existsSync(path));
    assert.ok(readFileSync(path, 'utf8').endsWith('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R0.9 builder additions: mtimes, raw lines, truncated tails, record-level overrides
// ---------------------------------------------------------------------------

test('R0.9 builder: a file mtime is written to disk and every split part keeps it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cachewhy-fx-'));
  try {
    const t = new CodexThread({ threadId: 'synthetic-thread-m' });
    t.turnContext();
    t.tokenUsage();
    t.tokenUsage();
    const when = Date.UTC(2026, 1, 3, 4, 5, 6);
    const home = new CodexHome();
    home.add(t, { splitAfter: [2], mtimeMs: when });
    const files = home.files();
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => f.mtimeMs === when));
    home.writeTo(dir);
    const abs = join(dir, ...files[0]!.path.split('/'));
    assert.equal(Math.round(statSync(abs).mtimeMs / 1000), when / 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R0.9 builder: raw lines are inserted with their own terminator and a truncated tail has none', () => {
  const t = new CodexThread({ threadId: 'synthetic-thread-r' });
  t.tokenUsage();
  const file = t.files()[0]!;
  const withGarbage = withRawLines(file, [{ at: 1, text: 'not json' }, { at: 1, text: 'also not json' }]);
  const lines = String(withGarbage.content).split('\n');
  assert.equal(lines.length, 5, 'meta, two raw lines, usage, trailing empty');
  assert.equal(lines[1], 'also not json');
  assert.equal(lines[2], 'not json');
  assert.ok(String(withGarbage.content).endsWith('\n'));
  const cut = withTruncatedTail(file);
  assert.ok(!String(cut.content).endsWith('\n'));
  assert.throws(() => JSON.parse(String(cut.content).split('\n').pop()!));
});

test('R0.9 builder: claude records can lose or retype sessionId and requestId, and a request has its own version', () => {
  const p = new ClaudeProject();
  const s = p.session({ sessionId: 'synthetic-session-o' });
  s.main.request({ extra: { sessionId: undefined } });
  s.main.request({ extra: { sessionId: 7 } });
  s.main.request({ extra: { requestId: undefined }, version: '9.9.9' });
  s.main.user({ extra: { sessionId: undefined } });
  const recs = parse(p.files()[0]);
  assert.equal(recs[0]!.sessionId, undefined);
  assert.equal(recs[1]!.sessionId, 7);
  assert.equal(recs[2]!.requestId, undefined);
  assert.equal(recs[2]!.version, '9.9.9');
  assert.equal(recs[3]!.type, 'user');
  assert.equal(recs[3]!.version, '2.1.293');
  assert.equal(recs[3]!.sessionId, undefined);
});

test('R0.9 builder: codex metas, usage records and ordinals can be shaped', () => {
  const t = new CodexThread({ threadId: 'synthetic-thread-c', emitMeta: false });
  t.sessionMeta({ cliVersion: '0.159.0' });
  t.sessionMeta({ id: null });
  t.turnContext({ turnId: 'synthetic-turn-c', model: 'gpt-5-codex', ordinal: null });
  t.settingsApplied({ ordinal: 40 });
  t.tokenCount();
  t.tokenUsage({ omitThreadId: true });
  t.tokenUsage({ omitResponseId: true, ordinal: null });
  const [meta1, meta2, ctx, marker, count, noThread, noResp] = t.lines;
  assert.equal(meta1!.payload.cli_version, '0.159.0');
  assert.equal(meta1!.payload.id, 'synthetic-thread-c');
  assert.equal('id' in meta2!.payload && meta2!.payload.id !== undefined, false);
  assert.equal(ctx!.ordinal, undefined);
  assert.equal(marker!.ordinal, 40);
  assert.deepEqual(marker!.payload, { type: 'thread_settings_applied' });
  assert.deepEqual(count!.payload, { type: 'token_count' });
  assert.equal(noThread!.payload.thread_id, undefined);
  assert.equal(noResp!.payload.response_id, undefined);
  assert.equal(noResp!.ordinal, undefined);
  assert.equal(noThread!.ordinal, 5, 'the counter keeps running past an explicit ordinal and a removed one');
});
