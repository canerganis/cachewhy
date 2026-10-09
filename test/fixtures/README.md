# Test fixtures

All fixtures are synthetic. Every id starts with `synthetic-`, every text field is a fixed placeholder, and no real path, user name, session id or transcript content appears anywhere. Do not copy real logs into this directory.

## Layout

| Path | What |
|---|---|
| `builder.ts` | Typed builders for Claude Code and Codex logs. |
| `builder.test.ts` | Tests for the builders and for the committed examples. |
| `metamorphic.ts` | The metamorphic operations of R4.10 and the dissolving-split test. |
| `r09.ts` | Fixtures of R0.9, R2.17, R2.9 and R4.12 with their stored expectations. |
| `synthetic/<scenario>/` | Generated example trees, shaped like `~/.claude` and `~/.codex`. |
| `../../scripts/gen-fixtures.ts` | Defines the scenarios and writes `synthetic/`. |

Regenerate and verify:

```
node scripts/gen-fixtures.ts           # rewrite synthetic/
node scripts/gen-fixtures.ts --check   # exit 1 if disk differs from the generator
```

Needs Node 22.18+ or 24 (native type stripping). The builder uses erasable TypeScript only and `.ts` import extensions. Output is deterministic: ids come from counters and time starts at 2026-01-01T00:00:00Z. The zstd example is compared by its decompressed text, not by bytes, because compressor output can differ between Node versions. Its file name is the same on every Node. On a Node without zstd (22.0 to 22.14) the check still verifies the name, reports the content comparison as skipped, and `gen-fixtures.ts` refuses to rewrite the trees instead of deleting the committed `.zst` file.

## Canary trees

`scenario.build({ canary })` plants a `CANARY_<hex16>` secret in every field the readers must drop (spec R14.7): message text, tool input and output, `cwd`, branch, slug, title, agent description and worktree path, run JSON and journal `label`, `result`, `key`, `prefix.json` extras, unknown usage keys, an unknown record type, odd model and version values, project and rollout file names, and a truncated last line. The committed trees are built without a canary. `test/privacy/canary.test.ts` builds canary trees into a temp dir, runs the CLI and the line readers over them, and runs the repo scanner on them.

## Scenarios

* `claude-basic`: partial and final copies, 5m and 1h writes, a duplicated line, a rebuild with diagnostics, `compact_boundary`, a linked subagent, an unlinked subagent, a bucket mismatch, the old shape without `cache_creation`.
* `claude-depth2`: depth 1 and depth 2 linked subagents, a workflow agent with no meta.
* `claude-workflow`: a `Workflow` tool_use, three workflow runs (run JSON plus journal, journal without run JSON, run JSON whose `runId` does not match), workflow agents that are and are not named by a `started` journal entry, linked and unlinked subagents with `prefix.json` files. `claude-basic` also has an `isCompactSummary` record after its `compact_boundary`.
* `claude-replay`: a second session that replays the first session's records, then adds its own.
* `codex-basic`: compaction, a thread split over two files, an archived `.jsonl.zst` thread.
* `codex-fork`: parent, fork with copied parent `session_meta` and prefix, a linked subagent fork, an unlinked subagent.

## Builder API

Claude:

```ts
const p = new ClaudeProject();
const s = p.session({ sessionId: 'synthetic-session-x' });
s.main.user();
const r = s.main.request({ usage: { input: 5, cacheRead: 0, write5m: 1000, write1h: 0, output: 80 }, blocks: [{ type: 'thinking' }, { type: 'text' }] });
s.main.compactBoundary({ trigger: 'auto', preTokens: 1000, postTokens: 100 });
const { agent } = s.spawnAgent({ agentType: 'general-purpose', model: 'sonnet', effort: 'high', spawnDepth: 1 });
agent.thread.request({ usage: { write5m: 500 } });
p.writeTo(dir); // or p.files()
```

One content block is one record. All copies of a request share `requestId`, `message.id` and the input and cache counters. Non-final copies have a smaller `output_tokens` and no `speed`. The final copy has the real `output_tokens`, `speed` and `stop_reason`.

Codex:

```ts
const t = new CodexThread({ threadId: 'synthetic-thread-x', threadSource: 'user' });
t.turnContext({ turnId: 'synthetic-turn-1' });
t.tokenUsage({ responseId: 'synthetic-resp-1', usage: { input: 1000, cached: 0, output: 100, reasoning: 10 } });
t.compacted();
const fork = CodexThread.fork(t, { threadId: 'synthetic-thread-y', prefixLen: 3 });
const home = new CodexHome();
home.add(t, { splitAfter: [4] });
home.writeTo(dir); // or home.files()
```

`tokenUsage` keeps running totals, so `thread_token_usage` equals the previous total plus `usage`. `CodexThread.fork` copies the parent `session_meta` and the first `prefixLen` parent lines (never a `token_usage_record`), keeping the envelope (timestamp and ordinal) of every copied record, then writes the fork's own `session_meta` with `forked_from_id` and `subagent_history_start_ordinal`.

## Writing edge cases

Use the escape hatches instead of editing generated files: `writeTotal` (bucket mismatch), `omitCacheCreation`, `finalSpeed: null` (no final copy), `finalFirst`, `apiError`, `duplicateLast()`, `replay()`, `spawnAgent` versus `agent({ toolUseId: null })`, `workflowRunId`, `omitMeta`, `splitAfter`, and the `threadId` override on `tokenUsage` for identity conflicts.

## Integrity fixtures (R0.9, R2.17, R4.10)

Spec revision 11 adds a global integrity abstention (R0.9). The builder grew the pieces to build its cases, and two files hold the fixtures and the metamorphic operations.

Builder additions:

* `GeneratedFile.mtimeMs` is written to disk by `writeFiles` (live families read file modification times, R0.9). `CodexHome.add(thread, { mtimeMs })` and `CodexThread.files({ mtimeMs })` give every part of a split thread the same time.
* `withRawLines(file, [{ at, text }])` inserts lines that do not parse (each with its own terminator). `withTruncatedTail(file)` appends a last line without terminator, the way a session being written leaves it.
* Claude: `request({ version })` sets the version of one request, `extra: { sessionId: undefined }` removes a key (`requestId` and `sessionId` too), `extra: { sessionId: 7 }` retypes it. `user`, `system` and `attachment` take `extra` as well.
* Codex: `sessionMeta({ id, sessionId, cliVersion, forkedFromId, subagentHistoryStartOrdinal, ordinal })` writes any `session_meta` (a `null` removes the field), `tokenUsage({ omitThreadId, omitResponseId, ordinal })`, `turnContext({ ordinal })`, `settingsApplied()`, `tokenCount()`, a generic `line(type, payload)`, and `ordinalStart` to give two builders of one thread disjoint ordinal ranges. An `ordinal` of `null` removes the envelope ordinal.

`metamorphic.ts` has the five operations of R4.10 (`shuffleLines`, `shuffleFiles`, `duplicateLine`, `reserializeReversedKeys`, `splitAt`), the allowed split positions (`splitPositions`), and `isDissolving`, which restates the dissolving test of R4.10 on the text of the files (named chains and the identity set `I(F)` of R4.11), so it does not borrow facts from the code under test. A split keeps the file modification time in both halves and refuses a position that leaves a half without a record that names a chain. For Claude, the second half keeps the file name and lives in a second project directory, because the linkage rules of R5.3 read the session and agent ids from the path.

`r09.ts` exports the fixtures of R0.9 (1a, 1b, 1c, 2, 3 with a parse error or a truncated tail, each also live, 4, 5, 6), the fixtures (1) to (8) of R2.17 (with the variants of (2) and (5)), the five-record counter fixture of R2.9, and two R4.12 fixtures. Each carries the files of the unsplit scan, `expect` (taint reasons of every chain, `model_source` and verified model of every counted response, token totals per provider, live counters) and `positions` (the exact result at the split positions where it differs from the unsplit one; `expectAt` answers for any position). The expectations are derived from the spec text by hand. The whole set is run through `analyze()` by `test/metamorphic/pipeline.test.ts`.
