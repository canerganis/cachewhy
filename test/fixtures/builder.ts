// Synthetic transcript builders for Claude Code and Codex logs.
//
// Rules for this file:
// - Everything generated is synthetic. All ids start with "synthetic-". No real paths, names or text.
// - Output is deterministic: ids come from counters, time from a fixed base instant plus offsets.
// - Only erasable TypeScript syntax (no enums, no parameter properties), so Node 22.18+ and Node 24 can
//   run it directly with type stripping. Relative imports use the .ts extension.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as zlib from 'node:zlib';

export const SYNTHETIC_PREFIX = 'synthetic-';
export const BASE_TIME_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue | undefined };
export type JsonObject = { [k: string]: JsonValue | undefined };

/** Deterministic id generator. `next('uuid')` gives "synthetic-uuid-0001", then "...-0002". */
export class IdGen {
  private counters = new Map<string, number>();
  private readonly ns: string;
  constructor(ns = '') {
    this.ns = ns ? `${ns}-` : '';
  }
  next(kind: string): string {
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    return `${SYNTHETIC_PREFIX}${this.ns}${kind}-${String(n).padStart(4, '0')}`;
  }
}

/** A clock that moves forward by `stepMs` per `tick()`, or jumps with `advance()` / `set()`. */
export class Clock {
  private ms: number;
  readonly stepMs: number;
  constructor(startMs = BASE_TIME_MS, stepMs = 1000) {
    this.ms = startMs;
    this.stepMs = stepMs;
  }
  tick(dtMs?: number): string {
    this.ms += dtMs ?? this.stepMs;
    return new Date(this.ms).toISOString();
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
  now(): number {
    return this.ms;
  }
}

export function toJsonl(records: readonly object[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
}

export interface GeneratedFile {
  /** Path relative to the output root, forward slashes. */
  path: string;
  content: string | Uint8Array;
  /**
   * For compressed files (.zst): the uncompressed text. Compressor output can differ between Node
   * versions, so consumers compare the decompressed content with this instead of the bytes.
   */
  plain?: string;
  /**
   * True when this Node cannot produce the file (no zstd). The path is still the real one, so the
   * set of expected names does not depend on the Node version. `content` is then the plain text and
   * must not be written to disk.
   */
  unavailable?: boolean;
}

/** Writes the files. Files this Node cannot produce (unavailable) are skipped. */
export function writeFiles(root: string, files: readonly GeneratedFile[]): void {
  for (const f of files) {
    if (f.unavailable) continue;
    const abs = join(root, ...f.path.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
}

/** zstd-compress with node:zlib when this Node has it (22.15+ / 23.8+ / 24). Returns null otherwise. */
export function zstdCompress(content: string): Uint8Array | null {
  const z = zlib as unknown as { zstdCompressSync?: (b: Uint8Array) => Uint8Array };
  if (typeof z.zstdCompressSync !== 'function') return null;
  return z.zstdCompressSync(Buffer.from(content, 'utf8'));
}

/** zstd-decompress to text with node:zlib. Returns null when this Node has no zstd. Throws on corrupt input. */
export function zstdDecompress(bytes: Uint8Array): string | null {
  const z = zlib as unknown as { zstdDecompressSync?: (b: Uint8Array) => Uint8Array };
  if (typeof z.zstdDecompressSync !== 'function') return null;
  return Buffer.from(z.zstdDecompressSync(bytes)).toString('utf8');
}

export type Compressor = (text: string) => Uint8Array | null;

/** One .zst file. The name is the same on every Node; the bytes exist only where zstd does. */
function zstdFile(path: string, text: string, compress: Compressor): GeneratedFile {
  const z = compress(text);
  if (z) return { path: `${path}.zst`, content: z, plain: text };
  return { path: `${path}.zst`, content: text, plain: text, unavailable: true };
}

// ---------------------------------------------------------------------------
// Canary planting (spec R14.7)
// ---------------------------------------------------------------------------
// With a canary, the generators write it into every field that the readers must drop (R1.2): message
// text, tool input and output, cwd, branch, slug, title, descriptions, worktree paths, unknown usage
// keys, unknown record types, odd model and version values, file and directory names, and a truncated
// last line. The committed trees are built WITHOUT a canary; tests build with a per run canary and write
// the tree to a temp dir, so no canary text is ever committed.

function canaryObj(c: string): JsonObject {
  return { note: c };
}

/** Returns a copy of a Claude record with the canary planted in every dropped field. */
export function plantClaudeRecord(rec: JsonObject, canary: string): JsonObject {
  const r = structuredClone(rec) as JsonObject;
  r.cwd = `/synthetic/${canary}`;
  r.gitBranch = `branch-${canary}`;
  r.slug = `slug-${canary}`;
  r.title = `title-${canary}`;
  if (r.type === 'system') r.content = canary;
  if (r.type === 'attachment') r.attachment = { type: 'synthetic-attachment', content: canary };
  const message = r.message as JsonObject | undefined;
  if (message && Array.isArray(message.content)) {
    message.content = (message.content as JsonObject[]).map((b) => {
      if (b.type === 'text') return { ...b, text: canary };
      if (b.type === 'thinking') return { ...b, thinking: canary, signature: canary };
      if (b.type === 'tool_use') return { ...b, input: { command: canary, path: canary } };
      if (b.type === 'tool_result') return { ...b, content: canary };
      return b;
    });
  }
  const usage = message?.usage as JsonObject | undefined;
  if (usage) {
    usage[`unknown_${canary}`] = 7;
    usage.server_tool_use = canaryObj(canary);
  }
  return r;
}

/** Extra Claude lines for canary trees: unknown type, odd model and version, truncated tail (no newline). */
function claudeCanaryExtras(sessionId: string, canary: string): { records: JsonObject[]; tail: string } {
  const records: JsonObject[] = [
    { type: `unknown-${canary}`, uuid: 'synthetic-uuid-canary-1', sessionId, payload: canary, timestamp: new Date(BASE_TIME_MS).toISOString() },
    {
      type: 'assistant',
      uuid: 'synthetic-uuid-canary-2',
      parentUuid: null,
      sessionId,
      timestamp: new Date(BASE_TIME_MS).toISOString(),
      version: `v-${canary}`,
      requestId: 'synthetic-req-canary-1',
      message: {
        id: 'synthetic-msg-canary-1',
        role: 'assistant',
        model: `model-${canary}`,
        content: [{ type: 'text', text: canary }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, [`unknown_${canary}`]: 1 },
      },
    },
  ];
  return { records, tail: `{"type":"user","message":{"content":"${canary}` };
}

/** Returns a copy of a Codex line with the canary planted in every dropped field. */
export function plantCodexLine(line: CodexLine, canary: string): CodexLine {
  const l = structuredClone(line);
  const p = l.payload;
  switch (l.type) {
    case 'session_meta':
      p.cwd = `/synthetic/${canary}`;
      p.base_instructions = canary;
      p.agent_nickname = canary;
      p.agent_path = canary;
      p.git = { branch: canary, repository_url: canary };
      break;
    case 'turn_context':
      p.cwd = `/synthetic/${canary}`;
      p.developer_instructions = canary;
      break;
    case 'response_item':
      p.content = canary;
      break;
    case 'event_msg':
      p.message = canary;
      break;
    case 'token_usage_record': {
      p.note = canary;
      for (const k of ['usage', 'turn_token_usage', 'thread_token_usage']) {
        const u = p[k] as JsonObject | undefined;
        if (u) u[`unknown_${canary}`] = 7;
      }
      break;
    }
    case 'compacted':
      p.message = canary;
      p.replacement_history = [canary];
      p.retained_context = [canary];
      break;
    default:
      break;
  }
  return l;
}

/** Extra Codex lines for canary trees: unknown type with odd model and version, truncated tail. */
function codexCanaryExtras(firstOrdinal: number, canary: string): { lines: CodexLine[]; tail: string } {
  const lines: CodexLine[] = [
    {
      timestamp: new Date(BASE_TIME_MS).toISOString(),
      type: `unknown-${canary}`,
      ordinal: firstOrdinal,
      payload: { model: `model-${canary}`, cli_version: `v-${canary}`, content: canary },
    },
  ];
  return { lines, tail: `{"type":"response_item","payload":{"content":"${canary}` };
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

export interface ClaudeUsageSpec {
  input?: number;
  output?: number;
  cacheRead?: number;
  write5m?: number;
  write1h?: number;
  /** Override top-level cache_creation_input_tokens (default write5m + write1h). Use for bucket_mismatch cases. */
  writeTotal?: number;
  /** Omit the cache_creation object (old shape): only cache_creation_input_tokens remains. */
  omitCacheCreation?: boolean;
  serviceTier?: string | null;
  inferenceGeo?: string | null;
  /** Emit usage.iterations[0] mirroring the counters. */
  iterations?: boolean;
  thinkingTokens?: number;
}

export type ClaudeBlockSpec =
  | { type: 'text' }
  | { type: 'thinking' }
  | { type: 'tool_use'; name?: string; id?: string };

export interface ClaudeRequestSpec {
  requestId?: string;
  messageId?: string;
  model?: string;
  usage?: ClaudeUsageSpec;
  /** Content blocks. One block is one record (copy). Default: a single text block. */
  blocks?: ClaudeBlockSpec[];
  stopReason?: string | null;
  /** usage.speed on the final copy. Default 'standard'. null omits it (no final copy exists). */
  finalSpeed?: string | null;
  /** output_tokens of the non-final copies, in order. Default: small increasing values below the final output. */
  partialOutputs?: number[];
  /** If true, the final copy is emitted first and partials after it (file order must not matter). */
  finalFirst?: boolean;
  /** Milliseconds to advance the clock before the first copy. */
  dtMs?: number;
  /** Mark as an API error record (synthetic model, isApiErrorMessage). */
  apiError?: boolean;
  /** message.diagnostics.cache_miss_reason on the final copy. */
  diagnostics?: { type: string; cacheMissedInputTokens?: number };
  /** Extra top-level fields merged into every copy (for example effort). */
  extra?: JsonObject;
}

export type ClaudeRecord = JsonObject;

export interface ClaudeRequestResult {
  requestId: string;
  messageId: string;
  toolUseIds: string[];
  records: ClaudeRecord[];
}

export interface ClaudeThreadOptions {
  sessionId: string;
  agentId?: string | null;
  version?: string;
  entrypoint?: string;
  model?: string;
  clock?: Clock;
  ids?: IdGen;
}

/** One logical Claude file: the main thread or one subagent. */
export class ClaudeThread {
  readonly sessionId: string;
  readonly agentId: string | null;
  readonly version: string;
  readonly entrypoint: string;
  readonly model: string;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly records: ClaudeRecord[] = [];

  constructor(o: ClaudeThreadOptions) {
    this.sessionId = o.sessionId;
    this.agentId = o.agentId ?? null;
    this.version = o.version ?? '2.1.293';
    this.entrypoint = o.entrypoint ?? 'cli';
    this.model = o.model ?? 'claude-sonnet-4-5';
    this.clock = o.clock ?? new Clock();
    this.ids = o.ids ?? new IdGen();
  }

  private base(type: string, timestamp: string): ClaudeRecord {
    const last = this.records[this.records.length - 1];
    const rec: ClaudeRecord = {
      type,
      uuid: this.ids.next('uuid'),
      parentUuid: last ? (last.uuid as string) : null,
      sessionId: this.sessionId,
      timestamp,
      isSidechain: this.agentId !== null,
      version: this.version,
      entrypoint: this.entrypoint,
    };
    if (this.agentId !== null) rec.agentId = this.agentId;
    return rec;
  }

  /**
   * A user record. With `toolResultFor`, a tool_result block that answers that tool_use id. With
   * `compactSummary`, an `isCompactSummary` record: put it right after compactBoundary() so that its
   * parent is the boundary (spec R11.7).
   */
  user(opts: { toolResultFor?: string; dtMs?: number; compactSummary?: boolean } = {}): ClaudeRecord {
    const rec = this.base('user', this.clock.tick(opts.dtMs));
    if (opts.compactSummary) rec.isCompactSummary = true;
    rec.message = {
      role: 'user',
      content: opts.toolResultFor
        ? [{ type: 'tool_result', tool_use_id: opts.toolResultFor, content: 'synthetic-tool-output' }]
        : [{ type: 'text', text: 'synthetic-user-text' }],
    };
    this.records.push(rec);
    return rec;
  }

  /** A compact_boundary system record. */
  compactBoundary(opts: { trigger?: string; preTokens?: number; postTokens?: number; dtMs?: number } = {}): ClaudeRecord {
    const last = this.records[this.records.length - 1];
    const rec = this.base('system', this.clock.tick(opts.dtMs));
    rec.subtype = 'compact_boundary';
    rec.parentUuid = null;
    rec.logicalParentUuid = last ? (last.uuid as string) : null;
    rec.content = 'synthetic-compact';
    rec.compactMetadata = {
      trigger: opts.trigger ?? 'auto',
      preTokens: opts.preTokens ?? 150000,
      postTokens: opts.postTokens ?? 12000,
    };
    this.records.push(rec);
    return rec;
  }

  /** A generic system record (for example subtype 'informational'). */
  system(subtype: string, opts: { dtMs?: number } = {}): ClaudeRecord {
    const rec = this.base('system', this.clock.tick(opts.dtMs));
    rec.subtype = subtype;
    rec.content = 'synthetic-system';
    this.records.push(rec);
    return rec;
  }

  attachment(opts: { dtMs?: number } = {}): ClaudeRecord {
    const rec = this.base('attachment', this.clock.tick(opts.dtMs));
    rec.attachment = { type: 'synthetic-attachment' };
    this.records.push(rec);
    return rec;
  }

  /**
   * One billed API response, written as one record per content block. Input and cache counters are
   * identical on every copy. Partial copies carry a smaller output_tokens and no speed; the final copy
   * carries the real output_tokens, speed and stop_reason.
   */
  request(spec: ClaudeRequestSpec = {}): ClaudeRequestResult {
    const requestId = spec.requestId ?? this.ids.next('req');
    const messageId = spec.messageId ?? this.ids.next('msg');
    const blocks: ClaudeBlockSpec[] = spec.blocks && spec.blocks.length ? spec.blocks : [{ type: 'text' }];
    const model = spec.apiError ? '<synthetic>' : (spec.model ?? this.model);
    const u = spec.usage ?? {};
    const output = u.output ?? 100;
    const w5 = u.write5m ?? 0;
    const w1 = u.write1h ?? 0;
    const toolUseIds: string[] = [];

    const copies: ClaudeRecord[] = [];
    blocks.forEach((b, idx) => {
      const isFinal = idx === blocks.length - 1;
      const partialDefault = Math.max(1, Math.min(output - 1, 1 + idx * 2));
      const outForCopy = isFinal ? output : (spec.partialOutputs?.[idx] ?? partialDefault);
      const rec = this.base('assistant', this.clock.tick(idx === 0 ? spec.dtMs : 5));
      let content: JsonObject;
      if (b.type === 'tool_use') {
        const id = b.id ?? this.ids.next('toolu');
        toolUseIds.push(id);
        content = { type: 'tool_use', id, name: b.name ?? 'Read', input: {} };
      } else if (b.type === 'thinking') {
        content = { type: 'thinking', thinking: 'synthetic-thinking' };
      } else {
        content = { type: 'text', text: 'synthetic-assistant-text' };
      }
      const usage: JsonObject = {
        input_tokens: u.input ?? 10,
        cache_creation_input_tokens: u.writeTotal ?? w5 + w1,
        cache_read_input_tokens: u.cacheRead ?? 0,
      };
      if (!u.omitCacheCreation) {
        usage.cache_creation = { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 };
      }
      usage.output_tokens = outForCopy;
      if (u.serviceTier !== undefined) usage.service_tier = u.serviceTier;
      else usage.service_tier = 'standard';
      if (u.inferenceGeo !== undefined) usage.inference_geo = u.inferenceGeo;
      else usage.inference_geo = 'not_available';
      const speed = spec.finalSpeed === undefined ? 'standard' : spec.finalSpeed;
      if (isFinal && speed !== null) usage.speed = speed;
      if (isFinal && u.thinkingTokens !== undefined) {
        usage.output_tokens_details = { thinking_tokens: u.thinkingTokens };
      }
      if (isFinal && u.iterations) {
        usage.iterations = [
          {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
            cache_creation_input_tokens: usage.cache_creation_input_tokens,
          },
        ];
      }
      const message: JsonObject = {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [content],
        stop_reason: isFinal ? (spec.stopReason === undefined ? (b.type === 'tool_use' ? 'tool_use' : 'end_turn') : spec.stopReason) : null,
        usage,
      };
      if (isFinal && spec.diagnostics) {
        message.diagnostics = {
          cache_miss_reason: {
            type: spec.diagnostics.type,
            ...(spec.diagnostics.cacheMissedInputTokens !== undefined
              ? { cache_missed_input_tokens: spec.diagnostics.cacheMissedInputTokens }
              : {}),
          },
        };
      }
      rec.requestId = requestId;
      rec.message = message;
      if (spec.apiError) rec.isApiErrorMessage = true;
      if (spec.extra) Object.assign(rec, spec.extra);
      this.records.push(rec);
      copies.push(rec);
    });

    if (spec.finalFirst && copies.length > 1) {
      // Move the final copy in front of the partials (file order must not matter to consumers).
      this.records.splice(this.records.length - copies.length, copies.length, copies[copies.length - 1]!, ...copies.slice(0, -1));
    }
    const ordered = this.records.slice(this.records.length - copies.length);
    return { requestId, messageId, toolUseIds, records: ordered };
  }

  /** Append the last `n` records again, byte-identical (a duplicated line). */
  duplicateLast(n = 1): void {
    const tail = this.records.slice(-n).map((r) => structuredClone(r));
    this.records.push(...tail);
  }

  /**
   * Append records copied from another thread: a replay region. uuid, timestamp, requestId and message are kept
   * verbatim, `sessionId` is the one of the copying thread (R4.6, R4.11: identity is read per record, and a key
   * seen in two logical streams is a replay; real logs behave this way).
   */
  replay(records: readonly ClaudeRecord[]): void {
    for (const r of records) {
      const c = structuredClone(r);
      c.sessionId = this.sessionId;
      this.records.push(c);
    }
  }

  /** JSONL text. With a canary: planted fields, extra lines and a truncated last line (no newline). */
  toJsonl(canary?: string): string {
    if (!canary) return toJsonl(this.records);
    const extras = this.agentId === null ? claudeCanaryExtras(this.sessionId, canary) : { records: [], tail: '' };
    const all = [...this.records.map((r) => plantClaudeRecord(r, canary)), ...extras.records];
    return toJsonl(all) + extras.tail;
  }
}

export interface ClaudeAgentMeta {
  toolUseId?: string | null;
  agentType?: string;
  model?: string;
  effort?: string;
  spawnDepth?: number;
  parentAgentId?: string;
  requestShape?: string;
}

/** Content of agent-<id>.prefix.json (Claude Code 2.1.293 agents). Only `state.*` is read (R1.2, R10.6). */
export interface ClaudePrefixSpec {
  model?: string;
  is1hCacheTTL?: boolean;
  buildVersion?: string;
  /** Hash text. null omits the key. Only its presence is read. */
  toolsHash?: string | null;
  callCount?: number;
  prevCacheReadTokens?: number;
}

export interface ClaudeAgentOptions extends ClaudeAgentMeta {
  agentId?: string;
  /** Write no meta.json at all. */
  omitMeta?: boolean;
  /** Put the file under subagents/workflows/wf_<runId>/ instead of subagents/. */
  workflowRunId?: string;
  /** Also write agent-<id>.prefix.json. */
  prefix?: ClaudePrefixSpec;
}

export interface ClaudeAgent {
  agentId: string;
  thread: ClaudeThread;
  meta: JsonObject | null;
  workflowRunId: string | null;
  prefix: ClaudePrefixSpec | null;
}

/** One workflow run: workflows/wf_<runId>.json plus subagents/workflows/wf_<runId>/journal.jsonl. */
export interface ClaudeWorkflowRunSpec {
  runId: string;
  /** status in the run JSON. Default 'completed'. */
  status?: string;
  /** Write the run JSON (default true). */
  json?: boolean;
  /** runId written inside the JSON when it must differ from the file name (mismatch case). */
  jsonRunId?: string;
  /** Journal entries (`type`, `agentId`). null or omitted writes no journal. */
  journal?: Array<{ type: string; agentId?: string }> | null;
}

export class ClaudeSession {
  readonly sessionId: string;
  readonly main: ClaudeThread;
  readonly agents: ClaudeAgent[] = [];
  readonly runs: ClaudeWorkflowRunSpec[] = [];
  private readonly ids: IdGen;
  private readonly clock: Clock;
  private readonly version: string;
  private readonly entrypoint: string;

  constructor(o: { sessionId: string; version?: string; entrypoint?: string; model?: string; clock?: Clock; ids?: IdGen }) {
    this.sessionId = o.sessionId;
    this.ids = o.ids ?? new IdGen();
    this.clock = o.clock ?? new Clock();
    this.version = o.version ?? '2.1.293';
    this.entrypoint = o.entrypoint ?? 'cli';
    this.main = new ClaudeThread({
      sessionId: o.sessionId,
      version: this.version,
      entrypoint: this.entrypoint,
      model: o.model,
      clock: this.clock,
      ids: this.ids,
    });
  }

  /** Create a subagent file. Does not touch any parent file; see spawnAgent for the linked case. */
  agent(o: ClaudeAgentOptions = {}): ClaudeAgent {
    const agentId = o.agentId ?? this.ids.next('agent');
    const thread = new ClaudeThread({
      sessionId: this.sessionId,
      agentId,
      version: this.version,
      entrypoint: this.entrypoint,
      model: o.model,
      clock: this.clock,
      ids: this.ids,
    });
    let meta: JsonObject | null = null;
    if (!o.omitMeta) {
      meta = {};
      if (o.toolUseId !== null && o.toolUseId !== undefined) meta.toolUseId = o.toolUseId;
      meta.agentType = o.agentType ?? 'general-purpose';
      if (o.model !== undefined) meta.model = o.model;
      if (o.effort !== undefined) meta.effort = o.effort;
      if (o.spawnDepth !== undefined) meta.spawnDepth = o.spawnDepth;
      if (o.parentAgentId !== undefined) meta.parentAgentId = o.parentAgentId;
      if (o.requestShape !== undefined) meta.requestShape = o.requestShape;
      meta.description = 'synthetic-description';
    }
    const a: ClaudeAgent = { agentId, thread, meta, workflowRunId: o.workflowRunId ?? null, prefix: o.prefix ?? null };
    this.agents.push(a);
    return a;
  }

  /** Declare a workflow run (run JSON and/or journal). Agents join it through agent({ workflowRunId }). */
  workflowRun(spec: ClaudeWorkflowRunSpec): ClaudeWorkflowRunSpec {
    this.runs.push(spec);
    return spec;
  }

  /**
   * Linked spawn: the parent thread emits a request whose tool_use block is named `Agent`, and a subagent
   * file is created whose meta.toolUseId equals that block's id.
   */
  spawnAgent(o: ClaudeAgentOptions & { parent?: ClaudeThread; parentRequest?: ClaudeRequestSpec } = {}): {
    agent: ClaudeAgent;
    toolUseId: string;
    parentRequest: ClaudeRequestResult;
  } {
    const parent = o.parent ?? this.main;
    const toolUseId = o.toolUseId ?? this.ids.next('toolu');
    const spec: ClaudeRequestSpec = { ...(o.parentRequest ?? {}) };
    const blocks = (spec.blocks ?? []).slice();
    blocks.push({ type: 'tool_use', name: 'Agent', id: toolUseId });
    spec.blocks = blocks;
    const parentRequest = parent.request(spec);
    const agent = this.agent({ ...o, toolUseId });
    return { agent, toolUseId, parentRequest };
  }

  /** Files of this session. With a canary (R14.7) dropped fields carry it and the project dir name too. */
  files(projectDir = 'synthetic-project', canary?: string): GeneratedFile[] {
    const out: GeneratedFile[] = [];
    const pd = canary ? `${projectDir}-${canary}` : projectDir;
    const base = `projects/${pd}/${this.sessionId}`;
    out.push({ path: `projects/${pd}/${this.sessionId}.jsonl`, content: this.main.toJsonl(canary) });
    for (const a of this.agents) {
      const dir = a.workflowRunId ? `${base}/subagents/workflows/wf_${a.workflowRunId}` : `${base}/subagents`;
      out.push({ path: `${dir}/agent-${a.agentId}.jsonl`, content: a.thread.toJsonl(canary) });
      if (a.meta) {
        const meta: JsonObject = canary ? { ...a.meta, description: canary, worktreePath: `/synthetic/${canary}` } : a.meta;
        out.push({ path: `${dir}/agent-${a.agentId}.meta.json`, content: JSON.stringify(meta) + '\n' });
      }
      if (a.prefix) {
        const state: JsonObject = {};
        if (a.prefix.model !== undefined) state.model = a.prefix.model;
        if (a.prefix.is1hCacheTTL !== undefined) state.is1hCacheTTL = a.prefix.is1hCacheTTL;
        if (a.prefix.buildVersion !== undefined) state.buildVersion = a.prefix.buildVersion;
        if (a.prefix.toolsHash !== null) state.toolsHash = a.prefix.toolsHash ?? 'synthetic-tools-hash';
        const prefix: JsonObject = {
          state,
          callCount: a.prefix.callCount ?? 2,
          prevCacheReadTokens: a.prefix.prevCacheReadTokens ?? 0,
          hashes: { system: 'synthetic-hash-system', tools: 'synthetic-hash-tools' },
        };
        if (canary) prefix.note = canary;
        out.push({ path: `${dir}/agent-${a.agentId}.prefix.json`, content: JSON.stringify(prefix) + '\n' });
      }
    }
    for (const run of this.runs) {
      if (run.json !== false) {
        const json: JsonObject = { runId: run.jsonRunId ?? run.runId, status: run.status ?? 'completed', label: 'synthetic-label', result: 'synthetic-result' };
        if (canary) {
          json.label = canary;
          json.result = canary;
        }
        out.push({ path: `${base}/workflows/wf_${run.runId}.json`, content: JSON.stringify(json) + '\n' });
      }
      if (run.journal) {
        const rows = run.journal.map((e) => {
          const row: JsonObject = { type: e.type, key: canary ?? 'synthetic-key', label: canary ?? 'synthetic-label', result: canary ?? 'synthetic-result' };
          if (e.agentId !== undefined) row.agentId = e.agentId;
          return row;
        });
        out.push({ path: `${base}/subagents/workflows/wf_${run.runId}/journal.jsonl`, content: toJsonl(rows) });
      }
    }
    return out;
  }
}

/** Collects several sessions into one `projects/` tree. */
export class ClaudeProject {
  readonly sessions: ClaudeSession[] = [];
  readonly projectDir: string;
  /** When set, files() plants this canary in every dropped field (R14.7). */
  readonly canary: string | undefined;
  private readonly ids: IdGen;
  constructor(o: { projectDir?: string; ids?: IdGen; canary?: string } = {}) {
    this.projectDir = o.projectDir ?? 'synthetic-project';
    this.ids = o.ids ?? new IdGen();
    this.canary = o.canary;
  }
  session(o: { sessionId?: string; version?: string; entrypoint?: string; model?: string; startMs?: number; stepMs?: number } = {}): ClaudeSession {
    const s = new ClaudeSession({
      sessionId: o.sessionId ?? this.ids.next('session'),
      version: o.version,
      entrypoint: o.entrypoint,
      model: o.model,
      clock: new Clock(o.startMs ?? BASE_TIME_MS, o.stepMs ?? 1000),
      ids: this.ids,
    });
    this.sessions.push(s);
    return s;
  }
  files(): GeneratedFile[] {
    return this.sessions.flatMap((s) => s.files(this.projectDir, this.canary));
  }
  writeTo(root: string): void {
    writeFiles(root, this.files());
  }
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

export interface CodexUsageSpec {
  input?: number;
  cached?: number;
  cacheWrite?: number;
  output?: number;
  reasoning?: number;
  /** Override total_tokens (default input + output). */
  total?: number;
}

export interface CodexLine {
  timestamp: string;
  type: string;
  ordinal: number;
  payload: JsonObject;
}

export interface CodexThreadOptions {
  threadId?: string;
  sessionId?: string;
  cliVersion?: string;
  originator?: string;
  /** 'cli' | 'exec' | ... or, for subagents, set `threadSpawn` / `subagentOther`. */
  source?: string;
  threadSource?: string | null;
  agentRole?: string;
  forkedFromId?: string;
  parentThreadId?: string;
  threadSpawn?: { parentThreadId: string; depth?: number };
  subagentOther?: string;
  subagentHistoryStartOrdinal?: number;
  model?: string;
  clock?: Clock;
  ids?: IdGen;
  /** Emit own session_meta at construction (default true). Forks use forkFrom(), which controls the order. */
  emitMeta?: boolean;
}

export class CodexThread {
  readonly threadId: string;
  readonly sessionId: string;
  readonly cliVersion: string;
  readonly model: string;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly lines: CodexLine[] = [];
  private readonly opts: CodexThreadOptions;
  private totals = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
  private turnId: string | null = null;
  private ordinal = 0;

  constructor(o: CodexThreadOptions = {}) {
    this.opts = o;
    this.ids = o.ids ?? new IdGen();
    this.clock = o.clock ?? new Clock();
    this.threadId = o.threadId ?? this.ids.next('thread');
    this.sessionId = o.sessionId ?? this.threadId;
    this.cliVersion = o.cliVersion ?? '0.158.0';
    this.model = o.model ?? 'gpt-5-codex';
    if (o.emitMeta !== false && o.forkedFromId === undefined) this.sessionMeta();
  }

  private push(type: string, payload: JsonObject, dtMs?: number): CodexLine {
    const line: CodexLine = { timestamp: this.clock.tick(dtMs), type, ordinal: this.ordinal++, payload };
    this.lines.push(line);
    return line;
  }

  /** The thread's own session_meta. */
  sessionMeta(): CodexLine {
    const o = this.opts;
    const payload: JsonObject = {
      id: this.threadId,
      session_id: this.sessionId,
      timestamp: new Date(this.clock.now()).toISOString(),
      cli_version: this.cliVersion,
      originator: o.originator ?? 'codex_cli',
      cwd: 'synthetic-cwd',
      base_instructions: 'synthetic-instructions',
    };
    if (o.threadSpawn) {
      payload.source = {
        subagent: {
          thread_spawn: {
            parent_thread_id: o.threadSpawn.parentThreadId,
            ...(o.threadSpawn.depth !== undefined ? { depth: o.threadSpawn.depth } : {}),
          },
        },
      };
    } else if (o.subagentOther !== undefined) {
      payload.source = { subagent: { other: o.subagentOther } };
    } else {
      payload.source = o.source ?? 'cli';
    }
    if (o.threadSource !== undefined) payload.thread_source = o.threadSource;
    if (o.agentRole !== undefined) payload.agent_role = o.agentRole;
    if (o.forkedFromId !== undefined) payload.forked_from_id = o.forkedFromId;
    if (o.parentThreadId !== undefined) payload.parent_thread_id = o.parentThreadId;
    if (o.subagentHistoryStartOrdinal !== undefined) {
      payload.subagent_history_start_ordinal = o.subagentHistoryStartOrdinal;
    }
    if (o.threadSpawn || o.subagentOther !== undefined) payload.agent_nickname = 'synthetic-nickname';
    return this.push('session_meta', payload);
  }

  turnContext(o: { turnId?: string; model?: string; effort?: string; compHash?: string | null; mode?: string } = {}): CodexLine {
    this.turnId = o.turnId ?? this.ids.next('turn');
    return this.push('turn_context', {
      turn_id: this.turnId,
      root_turn_id: this.turnId,
      model: o.model ?? this.model,
      effort: o.effort ?? 'medium',
      comp_hash: o.compHash === undefined ? 'synthetic-comp-hash-a' : o.compHash,
      collaboration_mode: { mode: o.mode ?? 'default' },
      cwd: 'synthetic-cwd',
    });
  }

  eventMsg(payloadType: string, dtMs?: number): CodexLine {
    return this.push('event_msg', { type: payloadType }, dtMs);
  }

  responseItem(payloadType: string, role?: string, dtMs?: number): CodexLine {
    const payload: JsonObject = { type: payloadType, content: 'synthetic-content' };
    if (payloadType === 'message') payload.role = role ?? 'assistant';
    return this.push('response_item', payload, dtMs);
  }

  /**
   * One billed response: a token_usage_record with last and running total usage, plus (optionally) the
   * matching event_msg token_count. Cumulative totals are tracked per builder unless `thread` is given.
   */
  tokenUsage(o: {
    responseId?: string;
    usage?: CodexUsageSpec;
    turnId?: string;
    /** Override thread id on the record (to build identity-conflict cases). */
    threadId?: string;
    emitTokenCountEvent?: boolean;
    dtMs?: number;
    /** Do not add this usage to the running totals (duplicate copies). */
    noAccumulate?: boolean;
  } = {}): { responseId: string; line: CodexLine } {
    const u = o.usage ?? {};
    const inp = u.input ?? 1000;
    const out = u.output ?? 100;
    const usage: JsonObject = {
      input_tokens: inp,
      cached_input_tokens: u.cached ?? 0,
      cache_write_input_tokens: u.cacheWrite ?? 0,
      output_tokens: out,
      reasoning_output_tokens: u.reasoning ?? 0,
      total_tokens: u.total ?? inp + out,
    };
    if (!o.noAccumulate) {
      this.totals.input += inp;
      this.totals.cached += u.cached ?? 0;
      this.totals.cacheWrite += u.cacheWrite ?? 0;
      this.totals.output += out;
      this.totals.reasoning += u.reasoning ?? 0;
      this.totals.total += u.total ?? inp + out;
    }
    const t = this.totals;
    const thread_token_usage: JsonObject = {
      input_tokens: t.input,
      cached_input_tokens: t.cached,
      cache_write_input_tokens: t.cacheWrite,
      output_tokens: t.output,
      reasoning_output_tokens: t.reasoning,
      total_tokens: t.total,
    };
    const responseId = o.responseId ?? this.ids.next('resp');
    const payload: JsonObject = {
      response_id: responseId,
      thread_id: o.threadId ?? this.threadId,
      session_id: this.sessionId,
      turn_id: o.turnId ?? this.turnId ?? 'synthetic-turn-none',
      usage,
      turn_token_usage: usage,
      thread_token_usage,
    };
    const line = this.push('token_usage_record', payload, o.dtMs);
    if (o.emitTokenCountEvent) this.eventMsg('token_count');
    return { responseId, line };
  }

  /** A compacted record. `latestTokenUsageRecord: null` marks a copy (R4.9). */
  compacted(o: { compactionResponseId?: string; windowId?: string; windowNumber?: number; latestTokenUsageRecord?: JsonObject | null } = {}): CodexLine {
    return this.push('compacted', {
      compaction_response_id: o.compactionResponseId ?? this.ids.next('compaction'),
      window_id: o.windowId ?? this.ids.next('window'),
      window_number: o.windowNumber ?? 1,
      latest_token_usage_record: o.latestTokenUsageRecord === undefined ? { response_id: 'synthetic-latest' } : o.latestTokenUsageRecord,
      message: 'synthetic-compaction-summary',
      replacement_history: [],
      retained_context: [],
    });
  }

  /**
   * Make this thread a fork of `parent`: copies the parent's session_meta and the first `prefixLen`
   * non-meta parent lines (never token_usage_record, as in real logs) into this thread, then writes the
   * fork's own session_meta. subagent_history_start_ordinal is the ordinal where the copied prefix ends.
   * Own session_meta position: 'after-prefix' (default) or 'first'.
   */
  static fork(
    parent: CodexThread,
    o: CodexThreadOptions & { prefixLen?: number; ownMetaPosition?: 'first' | 'after-prefix' },
  ): CodexThread {
    const prefix = parent.lines.filter((l) => l.type !== 'session_meta' && l.type !== 'token_usage_record').slice(0, o.prefixLen ?? 3);
    const parentMeta = parent.lines.find((l) => l.type === 'session_meta');
    const copiedCount = 1 + prefix.length;
    const fork = new CodexThread({
      ...o,
      forkedFromId: o.forkedFromId ?? parent.threadId,
      sessionId: o.sessionId ?? parent.sessionId,
      subagentHistoryStartOrdinal: o.subagentHistoryStartOrdinal ?? (o.ownMetaPosition === 'first' ? copiedCount + 1 : copiedCount),
      emitMeta: false,
      clock: o.clock ?? parent.clock,
      ids: o.ids ?? parent.ids,
    });
    if (o.ownMetaPosition === 'first') fork.sessionMeta();
    if (parentMeta) fork.push('session_meta', structuredClone(parentMeta.payload), 0);
    for (const l of prefix) fork.push(l.type, structuredClone(l.payload), 0);
    if (o.ownMetaPosition !== 'first') fork.sessionMeta();
    return fork;
  }

  toJsonl(): string {
    return toJsonl(this.lines);
  }

  /**
   * Render into one or more files. `splitAfter` lists line counts at which to cut, for example [3, 7]
   * gives lines 0..2, 3..6 and 7..end. Names are rollout-<n>-<threadId>.jsonl under sessions/2026/01/01/.
   */
  files(
    o: { archived?: boolean; splitAfter?: number[]; zstd?: boolean; canary?: string; compress?: Compressor } = {},
  ): GeneratedFile[] {
    const cuts = [0, ...(o.splitAfter ?? []), this.lines.length];
    const out: GeneratedFile[] = [];
    const compress = o.compress ?? zstdCompress;
    for (let i = 0; i < cuts.length - 1; i++) {
      const last = i === cuts.length - 2;
      let slice = this.lines.slice(cuts[i]!, cuts[i + 1]!);
      if (o.canary) slice = slice.map((l) => plantCodexLine(l, o.canary as string));
      const part = cuts.length > 2 ? `-part${i + 1}` : '';
      const name = `rollout-2026-01-01T00-00-00-${this.threadId}${part}${o.canary ? `-${o.canary}` : ''}.jsonl`;
      let text = toJsonl(slice);
      if (o.canary && last) {
        const extras = codexCanaryExtras(this.lines.length, o.canary);
        text += toJsonl(extras.lines) + extras.tail;
      }
      if (o.archived) {
        // The .zst name is the same on every Node. Without zstd the file is flagged unavailable.
        if (o.zstd) out.push(zstdFile(`archived_sessions/${name}`, text, compress));
        else out.push({ path: `archived_sessions/${name}`, content: text });
      } else {
        out.push({ path: `sessions/2026/01/01/${name}`, content: text });
      }
    }
    return out;
  }
}

export class CodexHome {
  readonly threads: Array<{ thread: CodexThread; archived: boolean; zstd: boolean; splitAfter?: number[] }> = [];
  /** When set, files() plants this canary in every dropped field (R14.7). */
  readonly canary: string | undefined;
  /** Compressor for archived .zst files. Default zstd from node:zlib. Tests pass one that returns null. */
  readonly compress: Compressor | undefined;
  constructor(o: { canary?: string; compress?: Compressor } = {}) {
    this.canary = o.canary;
    this.compress = o.compress;
  }
  add(thread: CodexThread, o: { archived?: boolean; zstd?: boolean; splitAfter?: number[] } = {}): CodexThread {
    this.threads.push({ thread, archived: o.archived ?? false, zstd: o.zstd ?? false, splitAfter: o.splitAfter });
    return thread;
  }
  files(): GeneratedFile[] {
    return this.threads.flatMap((t) =>
      t.thread.files({ archived: t.archived, zstd: t.zstd, splitAfter: t.splitAfter, canary: this.canary, compress: this.compress }),
    );
  }
  writeTo(root: string): void {
    writeFiles(root, this.files());
  }
}
