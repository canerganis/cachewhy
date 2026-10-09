// Fixtures for the global integrity abstention (spec R0.9) and the model binding guards (R2.17), with their stored
// expectations. Everything is synthetic and deterministic (builder.ts).
//
// Each fixture is a set of generated files (the unsplit scan) plus:
//   - `expect`: the exact result of the unsplit scan: the taint reasons of every chain, the model_source of every
//     counted response, the verified model of each response that has one, and the token totals per provider;
//   - `positions`: the exact result at every split position where it differs from the unsplit one (R4.10 op 5,
//     R17.7). A position that is not listed has the unsplit expectation. `expectAt` answers for any position;
//   - `splittable`: the files that the metamorphic suite splits at every allowed line boundary.
//
// The expectations are derived by hand from the spec text, not from the code under test:
//   a response counts iff it is kept, owner, and in no live family; tokens are `responseTokens` (ctx plus output);
//   the priced set of these fixtures is the verified set, because every priced fixture uses a table model, a final
//   copy with speed, geo and tier (Claude) or `codex_tier_for_test` (Codex).
//
// Chain ids are `chainIdOf` keys (`claude\0<session>\0<agent|main>`, `codex\0<thread>`); the helpers are restated here
// so that the expectations do not depend on src/.

import { BASE_TIME_MS, ClaudeProject, Clock, CodexHome, CodexThread, withRawLines, withTruncatedTail } from './builder.ts';
import type { GeneratedFile } from './builder.ts';
import { claudeChainId, codexChainId } from './metamorphic.ts';
import { TAINT_REASONS } from '../../src/model/types.js';
import type { ModelSource, TaintReason } from '../../src/model/types.js';

/** The injected run start (R0.9). Every fixture time lies months before it. */
export const RUN_START_MS = Date.UTC(2026, 5, 1);
/** Modification time of a file that is not live (far before the run start). */
export const OLD_MTIME_MS = Date.UTC(2026, 0, 2);
/** Modification time of a file written 100 s before the run start (inside C35). */
export const RECENT_MTIME_MS = RUN_START_MS - 100_000;

/** Request-scoped long-context models (R3.10): the only Codex models that can be priced, under codex_tier_for_test. */
export const MODEL_A = 'gpt-6-sol';
export const MODEL_B = 'gpt-6-luna';
export const CLAUDE_MODEL = 'claude-sonnet-4-5';

export type Reasons = readonly TaintReason[];

/** Reasons in the order of the spec enum, whatever order they are given in. */
export function R(...reasons: TaintReason[]): TaintReason[] {
  return TAINT_REASONS.filter((r) => reasons.includes(r));
}

export interface LiveExpect {
  readonly families: number;
  readonly responses: number;
  readonly tokens: bigint;
}

export interface R09Expect {
  /** Every chain of the scan that is not in a live family -> its exact taint reasons (empty: not tainted). */
  readonly chains: Readonly<Record<string, Reasons>>;
  /** model_source of every counted response (kept, owner, not in a live family), by raw request or response key. */
  readonly sources: Readonly<Record<string, ModelSource>>;
  /** Verified normalized model of each counted response that has one. A key that is absent has no verified model. */
  readonly verified: Readonly<Record<string, string>>;
  /** Sum of `responseTokens` over the counted responses, per provider. */
  readonly tokens: { readonly claude: bigint; readonly codex: bigint };
  /** Live families skipped (R0.9), per provider. Absent means none. */
  readonly live?: Partial<Record<'claude' | 'codex', LiveExpect>>;
  /** Exact Codex physical counters of R2.9, where the fixture stores them. */
  readonly counters?: { readonly files_without_response_id: number; readonly token_count_events_without_response_id: number };
}

export interface R09Position {
  readonly file: string;
  /** Number of lines of the first half. */
  readonly at: number;
  /** R4.10: the split removes the only evidence that one file mixed identities. */
  readonly dissolving: boolean;
  readonly expect: R09Expect;
}

export interface R09Fixture {
  readonly name: string;
  /** Spec rules the fixture belongs to. */
  readonly rules: string;
  readonly files: GeneratedFile[];
  readonly expect: R09Expect;
  readonly positions: readonly R09Position[];
  /** Paths of the files split at every allowed boundary. */
  readonly splittable: readonly string[];
  /** R0.9 fixture (6): the clean family alone, for the "equal to a scan that holds only the clean family" check. */
  readonly clean_only?: { readonly files: GeneratedFile[]; readonly chains: readonly string[] };
}

/** The expectation at a split position (the stored one, else the unsplit one). */
export function expectAt(fx: R09Fixture, file: string, at: number): { expect: R09Expect; dissolving: boolean | null } {
  const p = fx.positions.find((q) => q.file === file && q.at === at);
  return p === undefined ? { expect: fx.expect, dissolving: null } : { expect: p.expect, dissolving: p.dissolving };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const stamp = (files: GeneratedFile[], mtimeMs: number): GeneratedFile[] => files.map((f) => ({ ...f, mtimeMs: f.mtimeMs ?? mtimeMs }));
const renamed = (f: GeneratedFile, suffix: string): GeneratedFile => ({ ...f, path: f.path.replace(/\.jsonl$/, `-${suffix}.jsonl`) });

/** Tokens of a Claude request (final copy): i + r + w + o. */
const ct = (u: { input?: number; cacheRead?: number; write5m?: number; write1h?: number; output?: number } = {}): bigint =>
  BigInt((u.input ?? 10) + (u.cacheRead ?? 0) + (u.write5m ?? 0) + (u.write1h ?? 0) + (u.output ?? 100));
/** Tokens of a Codex response: in + out. */
const xt = (u: { input?: number; output?: number } = {}): bigint => BigInt((u.input ?? 1000) + (u.output ?? 100));

interface Resp {
  readonly key: string;
  readonly tokens: bigint;
  /** model_source when the chain is not tainted. */
  readonly source: ModelSource;
  /** Verified model when the chain is not tainted. */
  readonly model?: string;
}

function build(
  provider: 'claude' | 'codex',
  chains: ReadonlyArray<readonly [string, Reasons]>,
  resp: readonly Resp[],
  opts: { tainted?: boolean; live?: R09Expect['live']; counters?: R09Expect['counters'] } = {},
): R09Expect {
  const sources: Record<string, ModelSource> = {};
  const verified: Record<string, string> = {};
  let tokens = 0n;
  for (const r of resp) {
    tokens += r.tokens;
    if (opts.tainted === true) {
      sources[r.key] = 'chain_tainted';
    } else {
      sources[r.key] = r.source;
      if (r.model !== undefined) verified[r.key] = r.model;
    }
  }
  const out: R09Expect = {
    chains: Object.fromEntries(chains.map(([id, rs]) => [id, [...rs]])),
    sources,
    verified,
    tokens: { claude: provider === 'claude' ? tokens : 0n, codex: provider === 'codex' ? tokens : 0n },
    ...(opts.live !== undefined ? { live: opts.live } : {}),
    ...(opts.counters !== undefined ? { counters: opts.counters } : {}),
  };
  return out;
}

/** Same expectation with other chains, responses and counters (for fixtures that mix providers). */
function merge(a: R09Expect, b: R09Expect): R09Expect {
  return {
    chains: { ...a.chains, ...b.chains },
    sources: { ...a.sources, ...b.sources },
    verified: { ...a.verified, ...b.verified },
    tokens: { claude: a.tokens.claude + b.tokens.claude, codex: a.tokens.codex + b.tokens.codex },
    ...(a.live !== undefined || b.live !== undefined ? { live: { ...a.live, ...b.live } } : {}),
    ...(a.counters !== undefined || b.counters !== undefined ? { counters: (a.counters ?? b.counters) as NonNullable<R09Expect['counters']> } : {}),
  };
}

function cth(id: string, o: Partial<ConstructorParameters<typeof CodexThread>[0]> = {}): CodexThread {
  return new CodexThread({ threadId: `synthetic-thread-${id}`, threadSource: 'user', model: MODEL_A, ...o });
}
const xid = (id: string): string => codexChainId(`synthetic-thread-${id}`);
const textPaths = (files: readonly GeneratedFile[]): string[] =>
  files.filter((f) => typeof f.content === 'string' && f.path.endsWith('.jsonl') && !f.path.endsWith('/journal.jsonl')).map((f) => f.path);
const home = (...ts: CodexThread[]): GeneratedFile[] => {
  const h = new CodexHome();
  for (const t of ts) h.add(t);
  return h.files();
};
const pathOf = (t: CodexThread): string => (t.files()[0] as GeneratedFile).path;

// ---------------------------------------------------------------------------
// R0.9 fixture (1): the round 10 counterexample, three variants
// ---------------------------------------------------------------------------

/**
 * Codex thread X with a supported file holding P (in 30000, c 20000) and C (in 60000, c 0), and a file of CLI 0.159.0
 * holding Q (in 60000, c 60000) between them in time.
 *   (a) the 0.159.0 file has session_meta(X): X is of an unverified version, nothing of X is accounted;
 *   (b) it has session_meta(Y) with the session id of X and a token_usage_record without thread_id: unattributed_record
 *       taints every Codex chain; Y is of an unverified version too, and shares the family of X;
 *   (c) it has session_meta(Y) and a readable record of Y: the family of X and Y is tainted by version_unverified.
 * In no variant is the event with L = 30000 produced; here: no verified model, no dollar, P and C keep their tokens
 * (variants b and c).
 */
export function r09Fixture1(variant: 'a' | 'b' | 'c'): R09Fixture {
  const clock = new Clock(BASE_TIME_MS, 1000);
  const session = 'synthetic-session-xy';
  const x = cth('x', { sessionId: session, clock });
  x.turnContext({ turnId: 'synthetic-turn-1' });
  x.tokenUsage({ responseId: 'synthetic-resp-p', usage: { input: 30000, cached: 20000, output: 100 } });
  // F2 is written between P and C in time. Its ordinals lie between those of P and C, so the stream stays ordered.
  const z =
    variant === 'a'
      ? cth('x', { sessionId: session, clock, cliVersion: '0.159.0', ordinalStart: 10 })
      : cth('y', { sessionId: session, clock, cliVersion: '0.159.0', ordinalStart: 10 });
  if (variant === 'a') z.tokenUsage({ responseId: 'synthetic-resp-q', usage: { input: 60000, cached: 60000, output: 100 } });
  if (variant === 'b') z.tokenUsage({ responseId: 'synthetic-resp-q', omitThreadId: true, usage: { input: 60000, cached: 60000, output: 100 } });
  if (variant === 'c') z.tokenUsage({ responseId: 'synthetic-resp-q', usage: { input: 60000, cached: 60000, output: 100 } });
  x.tokenUsage({ responseId: 'synthetic-resp-c', ordinal: 20, usage: { input: 60000, cached: 0, output: 100 } });

  const f1 = home(x)[0] as GeneratedFile;
  const f2 = renamed(home(z)[0] as GeneratedFile, 'cli159');
  const P = xt({ input: 30000, output: 100 });
  const C = xt({ input: 60000, output: 100 });
  const accounted: Resp[] = [
    { key: 'synthetic-resp-p', tokens: P, source: 'own_turn', model: MODEL_A },
    { key: 'synthetic-resp-c', tokens: C, source: 'own_turn', model: MODEL_A },
  ];
  let expect: R09Expect;
  if (variant === 'a') {
    // V(X) holds the unlisted 0.159.0: X is unsupported and none of P, Q, C is accounted (R15.7).
    expect = build('codex', [[xid('x'), R('version_unverified')]], [], { tainted: true });
  } else if (variant === 'b') {
    expect = build(
      'codex',
      [
        [xid('x'), R('unattributed_record', 'version_unverified')],
        [xid('y'), R('unattributed_record', 'version_unverified')],
      ],
      accounted,
      { tainted: true },
    );
  } else {
    expect = build('codex', [[xid('x'), R('version_unverified')], [xid('y'), R('version_unverified')]], accounted, { tainted: true });
  }
  const files = stamp([f1, f2], OLD_MTIME_MS);
  return {
    name: `r09-1${variant}`,
    rules: 'R0.9 (1), R15.7, R2.13',
    files,
    expect,
    positions: [],
    splittable: textPaths(files),
  };
}

// ---------------------------------------------------------------------------
// R0.9 fixture (2): a Claude session with an unlisted version between two supported requests
// ---------------------------------------------------------------------------

export function r09Fixture2(): R09Fixture {
  const p = new ClaudeProject();
  const s = p.session({ sessionId: 'synthetic-session-v', model: CLAUDE_MODEL });
  const u1 = { input: 10, write5m: 5000, output: 100 };
  const u2 = { input: 11, cacheRead: 5000, write5m: 40, output: 60 };
  const u3 = { input: 12, cacheRead: 5040, write5m: 300, output: 80 };
  const ua = { input: 9, write5m: 700, output: 50 };
  s.main.request({ requestId: 'synthetic-req-v1', usage: u1 });
  s.main.request({ requestId: 'synthetic-req-v2', usage: u2, version: '2.1.999' });
  s.main.request({ requestId: 'synthetic-req-v3', usage: u3 });
  const ag = s.agent({ agentId: 'synthetic-agent-v1' });
  ag.thread.request({ requestId: 'synthetic-req-va', usage: ua });
  const files = stamp(p.files(), OLD_MTIME_MS);
  const main = claudeChainId('synthetic-session-v');
  const agent = claudeChainId('synthetic-session-v', 'synthetic-agent-v1');
  const expect = build(
    'claude',
    [[main, R('version_unverified')], [agent, R('version_unverified')]],
    [
      { key: 'synthetic-req-v1', tokens: ct(u1), source: 'claude_explicit', model: CLAUDE_MODEL },
      { key: 'synthetic-req-v3', tokens: ct(u3), source: 'claude_explicit', model: CLAUDE_MODEL },
      { key: 'synthetic-req-va', tokens: ct(ua), source: 'claude_explicit', model: CLAUDE_MODEL },
    ],
    { tainted: true },
  );
  return { name: 'r09-2', rules: 'R0.9 (2), R15.7', files, expect, positions: [], splittable: textPaths(files) };
}

// ---------------------------------------------------------------------------
// R0.9 fixture (3): a parse error line, or a truncated tail, in one subagent file; a second session stays clean
// ---------------------------------------------------------------------------

export function r09Fixture3(kind: 'parse_error' | 'tail', live: boolean): R09Fixture {
  const p = new ClaudeProject();
  const s1 = p.session({ sessionId: 'synthetic-session-e1', model: CLAUDE_MODEL });
  const s2 = p.session({ sessionId: 'synthetic-session-e2', model: CLAUDE_MODEL, startMs: BASE_TIME_MS + 3_600_000 });
  const ua = { input: 10, write5m: 4000, output: 100 };
  const ub = { input: 11, cacheRead: 4000, write5m: 60, output: 90 };
  const uc = { input: 12, write5m: 800, output: 40 };
  const ud = { input: 13, write5m: 900, output: 70 };
  const ue = { input: 14, cacheRead: 900, write5m: 20, output: 30 };
  s1.main.request({ requestId: 'synthetic-req-e1m1', usage: ua });
  const a1 = s1.agent({ agentId: 'synthetic-agent-e1' });
  a1.thread.request({ requestId: 'synthetic-req-e1a1', usage: uc });
  a1.thread.request({ requestId: 'synthetic-req-e1a2', usage: ub });
  s1.main.request({ requestId: 'synthetic-req-e1m2', usage: ud });
  s2.main.request({ requestId: 'synthetic-req-e2m1', usage: ue });
  const b1 = s2.agent({ agentId: 'synthetic-agent-e2' });
  b1.thread.request({ requestId: 'synthetic-req-e2b1', usage: ud });
  let files = p.files();
  const agentFile = files.find((f) => f.path.endsWith('agent-synthetic-agent-e1.jsonl')) as GeneratedFile;
  const damaged =
    kind === 'parse_error' ? withRawLines(agentFile, [{ at: 1, text: 'synthetic-not-json' }]) : withTruncatedTail(agentFile);
  files = stamp(files.map((f) => (f === agentFile ? { ...damaged, mtimeMs: live ? RECENT_MTIME_MS : OLD_MTIME_MS } : f)), OLD_MTIME_MS);

  const s1main = claudeChainId('synthetic-session-e1');
  const s1agent = claudeChainId('synthetic-session-e1', 'synthetic-agent-e1');
  const s2main = claudeChainId('synthetic-session-e2');
  const s2agent = claudeChainId('synthetic-session-e2', 'synthetic-agent-e2');
  const s1resp: Resp[] = [
    { key: 'synthetic-req-e1m1', tokens: ct(ua), source: 'claude_explicit', model: CLAUDE_MODEL },
    { key: 'synthetic-req-e1a1', tokens: ct(uc), source: 'claude_explicit', model: CLAUDE_MODEL },
    { key: 'synthetic-req-e1a2', tokens: ct(ub), source: 'claude_explicit', model: CLAUDE_MODEL },
    { key: 'synthetic-req-e1m2', tokens: ct(ud), source: 'claude_explicit', model: CLAUDE_MODEL },
  ];
  const s2resp: Resp[] = [
    { key: 'synthetic-req-e2m1', tokens: ct(ue), source: 'claude_explicit', model: CLAUDE_MODEL },
    { key: 'synthetic-req-e2b1', tokens: ct(ud), source: 'claude_explicit', model: CLAUDE_MODEL },
  ];
  const clean = build('claude', [[s2main, []], [s2agent, []]], s2resp);
  const s1Tokens = s1resp.reduce((a, r) => a + r.tokens, 0n);
  const expect = live
    ? { ...clean, live: { claude: { families: 1, responses: s1resp.length, tokens: s1Tokens } } }
    : merge(build('claude', [[s1main, R('unparsed_line')], [s1agent, R('unparsed_line')]], s1resp, { tainted: true }), clean);
  return {
    name: `r09-3-${kind}${live ? '-live' : ''}`,
    rules: 'R0.9 (3), R1.3, live families',
    files,
    expect,
    positions: [],
    splittable: textPaths(files),
  };
}

// ---------------------------------------------------------------------------
// R0.9 fixture (4): an unreadable archived Codex file
// ---------------------------------------------------------------------------

export function r09Fixture4(): R09Fixture {
  const p = new ClaudeProject();
  const s = p.session({ sessionId: 'synthetic-session-u', model: CLAUDE_MODEL });
  const uc = { input: 10, write5m: 3000, output: 100 };
  s.main.request({ requestId: 'synthetic-req-u1', usage: uc });
  const x = cth('ux');
  x.turnContext({ turnId: 'synthetic-turn-u1' });
  x.tokenUsage({ responseId: 'synthetic-resp-u1', usage: { input: 2000, output: 50 } });
  x.tokenUsage({ responseId: 'synthetic-resp-u2', usage: { input: 2500, cached: 2000, output: 70 } });
  // Bytes that are not a zstd frame: unreadable on every Node (and unreadable anyway on a Node without zstd).
  const bad: GeneratedFile = {
    path: 'archived_sessions/rollout-2026-01-01T00-00-00-synthetic-thread-ubad.jsonl.zst',
    content: new Uint8Array([0x6e, 0x6f, 0x74, 0x20, 0x7a, 0x73, 0x74, 0x64, 0x0a]),
  };
  const files = stamp([...p.files(), ...home(x), bad], OLD_MTIME_MS);
  const expect = merge(
    build('claude', [[claudeChainId('synthetic-session-u'), []]], [{ key: 'synthetic-req-u1', tokens: ct(uc), source: 'claude_explicit', model: CLAUDE_MODEL }]),
    build(
      'codex',
      [[xid('ux'), R('file_unreadable')]],
      [
        { key: 'synthetic-resp-u1', tokens: xt({ input: 2000, output: 50 }), source: 'own_turn', model: MODEL_A },
        { key: 'synthetic-resp-u2', tokens: xt({ input: 2500, output: 70 }), source: 'own_turn', model: MODEL_A },
      ],
      { tainted: true },
    ),
  );
  return { name: 'r09-4', rules: 'R0.9 (4), R0.2, R17.1', files, expect, positions: [], splittable: textPaths(files) };
}

// ---------------------------------------------------------------------------
// R0.9 fixture (5): a thread whose second file holds only session_meta and token_count events
// ---------------------------------------------------------------------------

export function r09Fixture5(): R09Fixture {
  const x = cth('lg');
  x.turnContext({ turnId: 'synthetic-turn-l1' });
  x.tokenUsage({ responseId: 'synthetic-resp-l1', usage: { input: 3000, output: 100 } });
  x.tokenUsage({ responseId: 'synthetic-resp-l2', usage: { input: 3500, cached: 3000, output: 120 } });
  const cut = x.lines.length;
  x.sessionMeta();
  x.tokenCount();
  x.tokenCount();
  const h = new CodexHome();
  h.add(x, { splitAfter: [cut] });
  const files = stamp(h.files(), OLD_MTIME_MS);
  const expect = build(
    'codex',
    [[xid('lg'), R('unlogged_usage')]],
    [
      { key: 'synthetic-resp-l1', tokens: xt({ input: 3000 }), source: 'own_turn', model: MODEL_A },
      { key: 'synthetic-resp-l2', tokens: xt({ input: 3500, output: 120 }), source: 'own_turn', model: MODEL_A },
    ],
    { tainted: true, counters: { files_without_response_id: 1, token_count_events_without_response_id: 2 } },
  );
  return { name: 'r09-5', rules: 'R0.9 (5), R2.9', files, expect, positions: [], splittable: textPaths(files) };
}

// ---------------------------------------------------------------------------
// R0.9 fixture (6): a clean family and a tainted family in one scan
// ---------------------------------------------------------------------------

export function r09Fixture6(): R09Fixture {
  // Claude: a clean session and a session with a bucket mismatch (request_anomaly).
  const p = new ClaudeProject();
  const sc = p.session({ sessionId: 'synthetic-session-c', model: CLAUDE_MODEL });
  const st = p.session({ sessionId: 'synthetic-session-t', model: CLAUDE_MODEL, startMs: BASE_TIME_MS + 7_200_000 });
  const c1 = { input: 10, write5m: 6000, output: 100 };
  const c2 = { input: 11, cacheRead: 6000, write5m: 50, output: 80 };
  sc.main.request({ requestId: 'synthetic-req-c1', usage: c1 });
  sc.main.request({ requestId: 'synthetic-req-c2', usage: c2 });
  // The recon case: wt = 0 while w1 = 1796. The bucket sum is used for the tokens (R2.1).
  st.main.request({ requestId: 'synthetic-req-t1', usage: { input: 10, write1h: 1796, writeTotal: 0, output: 100 } });
  // Codex: a clean thread and a thread with a turn model conflict.
  const clock = new Clock(BASE_TIME_MS, 1000);
  const cx = cth('cc', { clock });
  cx.turnContext({ turnId: 'synthetic-turn-c1' });
  cx.tokenUsage({ responseId: 'synthetic-resp-c1', usage: { input: 4000, output: 100 } });
  cx.tokenUsage({ responseId: 'synthetic-resp-c2', usage: { input: 4200, cached: 4000, output: 90 } });
  const tz = cth('tt', { clock: new Clock(BASE_TIME_MS + 7_200_000, 1000) });
  tz.turnContext({ turnId: 'synthetic-turn-z1', model: MODEL_A });
  tz.settingsApplied();
  tz.turnContext({ turnId: 'synthetic-turn-z1', model: MODEL_B });
  tz.tokenUsage({ responseId: 'synthetic-resp-t1', usage: { input: 5000, output: 100 } });

  const claudeClean = stamp(p.files().filter((f) => f.path.includes('synthetic-session-c')), OLD_MTIME_MS);
  const claudeTaint = stamp(p.files().filter((f) => f.path.includes('synthetic-session-t')), OLD_MTIME_MS);
  const codexClean = stamp(home(cx), OLD_MTIME_MS);
  const codexTaint = stamp(home(tz), OLD_MTIME_MS);
  const files = [...claudeClean, ...claudeTaint, ...codexClean, ...codexTaint];
  const expect = merge(
    merge(
      build(
        'claude',
        [[claudeChainId('synthetic-session-c'), []]],
        [
          { key: 'synthetic-req-c1', tokens: ct(c1), source: 'claude_explicit', model: CLAUDE_MODEL },
          { key: 'synthetic-req-c2', tokens: ct(c2), source: 'claude_explicit', model: CLAUDE_MODEL },
        ],
      ),
      build(
        'claude',
        [[claudeChainId('synthetic-session-t'), R('request_anomaly')]],
        [{ key: 'synthetic-req-t1', tokens: ct({ input: 10, write1h: 1796, output: 100 }), source: 'claude_explicit', model: CLAUDE_MODEL }],
        { tainted: true },
      ),
    ),
    merge(
      build(
        'codex',
        [[xid('cc'), []]],
        [
          { key: 'synthetic-resp-c1', tokens: xt({ input: 4000 }), source: 'own_turn', model: MODEL_A },
          { key: 'synthetic-resp-c2', tokens: xt({ input: 4200, output: 90 }), source: 'own_turn', model: MODEL_A },
        ],
      ),
      build('codex', [[xid('tt'), R('turn_model_conflicted')]], [{ key: 'synthetic-resp-t1', tokens: xt({ input: 5000 }), source: 'own_turn', model: MODEL_A }], {
        tainted: true,
      }),
    ),
  );
  return {
    name: 'r09-6',
    rules: 'R0.9 (6)',
    files,
    expect,
    positions: [],
    splittable: textPaths(files),
    clean_only: { files: [...claudeClean, ...codexClean], chains: [claudeChainId('synthetic-session-c'), xid('cc')] },
  };
}

// ---------------------------------------------------------------------------
// R2.9 counter fixture (R4.10): the five-record Codex file
// ---------------------------------------------------------------------------

/**
 * One Codex file with, in order: 1 session_meta(X), 2 token_count, 3 turn_context, 4 token_usage_record(X),
 * 5 token_count. Unsplit and split after 1: both R2.9 counters are 0 and X is untainted. Split after 2 and after 3:
 * both counters are 1 (the first half holds one token_count and no token_usage_record), X is tainted unlogged_usage,
 * its verified model is withdrawn, the tokens are identical. A split after 4 would leave a half with no chain-naming
 * record, so it is not a split of R4.10.
 */
export function r09CounterFixture(): R09Fixture {
  const x = cth('ct');
  x.tokenCount();
  x.turnContext({ turnId: 'synthetic-turn-k1' });
  x.tokenUsage({ responseId: 'synthetic-resp-k1', usage: { input: 2000, cached: 1000, output: 100 } });
  x.tokenCount();
  const files = stamp(home(x), OLD_MTIME_MS);
  const path = pathOf(x);
  const resp: Resp[] = [{ key: 'synthetic-resp-k1', tokens: xt({ input: 2000 }), source: 'own_turn', model: MODEL_A }];
  const clean = build('codex', [[xid('ct'), []]], resp, { counters: { files_without_response_id: 0, token_count_events_without_response_id: 0 } });
  const taintedOne = build('codex', [[xid('ct'), R('unlogged_usage')]], resp, {
    tainted: true,
    counters: { files_without_response_id: 1, token_count_events_without_response_id: 1 },
  });
  return {
    name: 'r09-counter',
    rules: 'R2.9, R4.10, R17.6, R17.7',
    files,
    expect: clean,
    positions: [
      { file: path, at: 1, dissolving: false, expect: clean },
      { file: path, at: 2, dissolving: false, expect: taintedOne },
      { file: path, at: 3, dissolving: false, expect: taintedOne },
    ],
    splittable: textPaths(files),
  };
}

// ---------------------------------------------------------------------------
// R2.17 fixtures (1) to (8)
// ---------------------------------------------------------------------------

function single(name: string, rules: string, t: CodexThread, chain: string, resp: Resp[], reasons: Reasons = [], tainted = false): R09Fixture {
  const files = stamp(home(t), OLD_MTIME_MS);
  return {
    name,
    rules,
    files,
    expect: build('codex', [[chain, reasons]], resp, { tainted: tainted || reasons.length > 0 }),
    positions: [],
    splittable: textPaths(files),
  };
}

/** (1) turn_context(A, T), thread_settings_applied, turn_context(B, T), a usage record of turn T: TM(T) = {A, B}. */
export function r217Fixture1(): R09Fixture {
  const t = cth('o1');
  t.turnContext({ turnId: 'synthetic-turn-t', model: MODEL_A });
  t.settingsApplied();
  t.turnContext({ turnId: 'synthetic-turn-t', model: MODEL_B });
  t.tokenUsage({ responseId: 'synthetic-resp-o1', turnId: 'synthetic-turn-t', usage: { input: 3000, output: 100 } });
  return single('r217-1', 'R2.17 (1), (d)', t, xid('o1'), [{ key: 'synthetic-resp-o1', tokens: xt({ input: 3000 }), source: 'own_turn_unsettled' }], R('turn_model_conflicted'));
}

/** (2) turn_context(A, T1), turn_context(B, T2), usage of T1: own_turn A; with a marker after the first context: own_turn_unsettled. */
export function r217Fixture2(withMarker: boolean): R09Fixture {
  const t = cth('o2');
  t.turnContext({ turnId: 'synthetic-turn-1', model: MODEL_A });
  if (withMarker) t.settingsApplied();
  t.turnContext({ turnId: 'synthetic-turn-2', model: MODEL_B });
  t.tokenUsage({ responseId: 'synthetic-resp-o2', turnId: 'synthetic-turn-1', usage: { input: 3000, output: 100 } });
  const resp: Resp = withMarker
    ? { key: 'synthetic-resp-o2', tokens: xt({ input: 3000 }), source: 'own_turn_unsettled' }
    : { key: 'synthetic-resp-o2', tokens: xt({ input: 3000 }), source: 'own_turn', model: MODEL_A };
  return single(withMarker ? 'r217-2-marker' : 'r217-2', 'R2.17 (2), (a), R2.10', t, xid('o2'), [resp]);
}

/** (3) turn_context(A, T1), turn_context(B, T2), usage of a turn T3 without a context: carried_unverified. */
export function r217Fixture3(): R09Fixture {
  const t = cth('o3');
  t.turnContext({ turnId: 'synthetic-turn-1', model: MODEL_A });
  t.turnContext({ turnId: 'synthetic-turn-2', model: MODEL_B });
  t.tokenUsage({ responseId: 'synthetic-resp-o3', turnId: 'synthetic-turn-3', usage: { input: 3000, output: 100 } });
  return single('r217-3', 'R2.17 (3), (b)', t, xid('o3'), [{ key: 'synthetic-resp-o3', tokens: xt({ input: 3000 }), source: 'carried_unverified' }]);
}

/** (4) the same stream with model A in every context and no marker: carried_verified. */
export function r217Fixture4(): R09Fixture {
  const t = cth('o4');
  t.turnContext({ turnId: 'synthetic-turn-1', model: MODEL_A });
  t.turnContext({ turnId: 'synthetic-turn-2', model: MODEL_A });
  t.tokenUsage({ responseId: 'synthetic-resp-o4', turnId: 'synthetic-turn-3', usage: { input: 3000, output: 100 } });
  return single('r217-4', 'R2.17 (4), (b)', t, xid('o4'), [{ key: 'synthetic-resp-o4', tokens: xt({ input: 3000 }), source: 'carried_verified', model: MODEL_A }]);
}

/**
 * (5) the two-model fork. A parent file (turn_context(A, TP) and a usage record of the parent) and a fork file with the
 * copied parent session_meta, the copied turn_context(A, TP) in the prefix, the child's own session_meta, an own
 * turn_context(childModel, T1), a usage record of T1 (own_turn) and usage records of T2 and T3 without an own-turn context.
 *   'two_models'  child context B: T2 and T3 are carried_unverified (G(S) holds A and B)
 *   'same_model'  child context A: T2 and T3 are carried_verified A
 *   'copy_differs' the copied context carries B while the parent's genuine one is A: TM(TP) = {A, B} taints the family
 * A half of either file that holds the parent's session_meta and no usage record of the parent is copy-exposed (R4.13):
 * the family of parent and child is tainted at those positions.
 */
export function r217Fixture5(variant: 'two_models' | 'same_model' | 'copy_differs'): R09Fixture {
  const clock = new Clock(BASE_TIME_MS, 1000);
  const session = 'synthetic-session-fk';
  const parent = cth('fp', { sessionId: session, clock });
  parent.turnContext({ turnId: 'synthetic-turn-tp', model: MODEL_A });
  parent.tokenUsage({ responseId: 'synthetic-resp-rp', usage: { input: 1000, output: 100 } });
  const child = CodexThread.fork(parent, { threadId: 'synthetic-thread-fc', prefixLen: 1, threadSource: 'user' });
  if (variant === 'copy_differs') {
    // The copied context is the second line of the fork file (after the copied parent session_meta).
    (child.lines[1] as unknown as { payload: { model: string } }).payload.model = MODEL_B;
  }
  // The copied records keep the envelope of the originals (the builder does it), so a copy of the parent's session_meta or context
  // that lands in a file of its own equals the parent's record (R4.12 equality) and is not an ordinal collision.
  for (const i of [0, 1]) (child.lines[i] as { timestamp: string }).timestamp = (parent.lines[i] as { timestamp: string }).timestamp;
  const childModel = variant === 'same_model' ? MODEL_A : MODEL_B;
  child.turnContext({ turnId: 'synthetic-turn-1', model: childModel });
  child.tokenUsage({ responseId: 'synthetic-resp-ra', turnId: 'synthetic-turn-1', usage: { input: 2000, output: 100 } });
  child.tokenUsage({ responseId: 'synthetic-resp-rb', turnId: 'synthetic-turn-2', usage: { input: 3000, output: 100 } });
  child.tokenUsage({ responseId: 'synthetic-resp-rc', turnId: 'synthetic-turn-3', usage: { input: 4000, output: 100 } });
  const files = stamp(home(parent, child), OLD_MTIME_MS);
  const parentPath = pathOf(parent);
  const childPath = pathOf(child);
  const resp: Resp[] = [
    { key: 'synthetic-resp-rp', tokens: xt({ input: 1000 }), source: 'own_turn', model: MODEL_A },
    { key: 'synthetic-resp-ra', tokens: xt({ input: 2000 }), source: 'own_turn', model: childModel },
    variant === 'same_model'
      ? { key: 'synthetic-resp-rb', tokens: xt({ input: 3000 }), source: 'carried_verified', model: MODEL_A }
      : { key: 'synthetic-resp-rb', tokens: xt({ input: 3000 }), source: 'carried_unverified' },
    variant === 'same_model'
      ? { key: 'synthetic-resp-rc', tokens: xt({ input: 4000 }), source: 'carried_verified', model: MODEL_A }
      : { key: 'synthetic-resp-rc', tokens: xt({ input: 4000 }), source: 'carried_unverified' },
  ];
  const chains = (rs: Reasons): Array<readonly [string, Reasons]> => [[xid('fp'), rs], [xid('fc'), rs]];
  const unsplitReasons = variant === 'copy_differs' ? R('turn_model_conflicted') : [];
  const exposedReasons = variant === 'copy_differs' ? R('copy_exposed', 'turn_model_conflicted') : R('copy_exposed');
  // copy_differs, fork file split after the copied context: the copy (model B) lands in the stream of the parent next to
  // the parent's own context (model A) with the same ordinal: a collision (R4.12 (b)), so the stream is also ordinal_unverified.
  const exposedCollision = build('codex', chains(R('copy_exposed', 'turn_model_conflicted', 'ordinal_unverified')), resp, { tainted: true });
  const expect = build('codex', chains(unsplitReasons), resp, { tainted: unsplitReasons.length > 0 });
  const exposed = build('codex', chains(exposedReasons), resp, { tainted: true });
  const positions: R09Position[] = [];
  // Fork file: lines are 0 copied parent session_meta, 1 copied context, 2 own session_meta, 3 own context, 4..6 usage.
  // Positions 1 and 2 leave a half with the copied parent session_meta, no own session_meta and no usage record of the
  // parent: copy-exposed. From position 3 on the first half holds the own session_meta, so it is not.
  positions.push({ file: childPath, at: 1, dissolving: false, expect: exposed });
  positions.push({ file: childPath, at: 2, dissolving: false, expect: variant === 'copy_differs' ? exposedCollision : exposed });
  // Parent file: lines are 0 session_meta, 1 context, 2 usage. A first half without the usage record is copy-exposed.
  for (const at of [1, 2]) positions.push({ file: parentPath, at, dissolving: false, expect: exposed });
  return {
    name: `r217-5-${variant}`,
    rules: 'R2.17 (5), R4.13, R4.9, R4.10',
    files,
    expect,
    positions,
    splittable: textPaths(files),
  };
}

/** F1 and F2 builders shared by fixtures (6) to (8). X and Y share a session id, so they share a family (R0.9 (i)). */
function xyThreads(f2Start: number, f1Start: number, f1Ordinal: number, f2Ordinal: number): { x: CodexThread; y: CodexThread } {
  const session = 'synthetic-session-xy';
  const x = cth('x', { sessionId: session, clock: new Clock(f1Start, 1000), ordinalStart: f1Ordinal });
  const y = cth('y', { sessionId: session, clock: new Clock(f2Start, 1000), ordinalStart: f2Ordinal });
  return { x, y };
}

/**
 * (6) F1 holds session_meta(X), turn_context(A, T) and the usage record of turn T of X. F2 holds session_meta(Y), a usage
 * record with thread_id = X (turn T2), a marker and turn_context(B, T). F2 is a stream conflict and TM(T) = {A, B}.
 * Unsplit: stream_unresolved and turn_model_conflicted for X and Y. The only split of F2 (after session_meta(Y)) gives
 * each half one identity: a dissolving split, after which only the record-set reason remains. No dollar, tokens kept.
 */
export function r217Fixture6(): R09Fixture {
  const t0 = BASE_TIME_MS;
  const { x, y } = xyThreads(t0 + 60_000, t0, 10, 100);
  x.turnContext({ turnId: 'synthetic-turn-t', model: MODEL_A });
  x.tokenUsage({ responseId: 'synthetic-resp-x1', turnId: 'synthetic-turn-t', usage: { input: 3000, output: 100 } });
  y.tokenUsage({ responseId: 'synthetic-resp-x2', threadId: x.threadId, turnId: 'synthetic-turn-t2', usage: { input: 3300, output: 100 } });
  y.settingsApplied();
  y.turnContext({ turnId: 'synthetic-turn-t', model: MODEL_B });
  const f1 = home(x)[0] as GeneratedFile;
  const f2 = home(y)[0] as GeneratedFile;
  const files = stamp([f1, f2], OLD_MTIME_MS);
  const resp: Resp[] = [
    { key: 'synthetic-resp-x1', tokens: xt({ input: 3000 }), source: 'own_turn', model: MODEL_A },
    { key: 'synthetic-resp-x2', tokens: xt({ input: 3300 }), source: 'carried_unverified' },
  ];
  const mk = (rs: Reasons): R09Expect => build('codex', [[xid('x'), rs], [xid('y'), rs]], resp, { tainted: true });
  return {
    name: 'r217-6',
    rules: 'R2.17 (6), R4.11, R4.10 dissolving',
    files,
    expect: mk(R('stream_unresolved', 'turn_model_conflicted')),
    positions: [{ file: f2.path, at: 1, dissolving: true, expect: mk(R('turn_model_conflicted')) }],
    splittable: textPaths(files),
  };
}

/**
 * (7) F1 holds session_meta(X), turn_context(A, T), the usage record P of X in turn T, turn_context(B, TC) and the usage
 * record C of X in turn TC. F2 holds session_meta(Y), turn_context(B, T), a marker and a usage record Q with
 * thread_id = X in turn T2. Times: Q < P < C. TM(T) = {A, B} and P names X, so X is tainted at every position, among
 * them the split after the marker that gives the halves of F2 the identities {Y} and {X}.
 */
export function r217Fixture7(): R09Fixture {
  const t0 = BASE_TIME_MS;
  const session = 'synthetic-session-xy';
  // F2 is earlier in time (Q is the earliest request) and uses the low ordinals; F1 uses ordinals from 10 on.
  const y = cth('y', { sessionId: session, clock: new Clock(t0, 1000), ordinalStart: 0 });
  const x = cth('x', { sessionId: session, clock: new Clock(t0 + 3_600_000, 1000), ordinalStart: 10 });
  y.turnContext({ turnId: 'synthetic-turn-t', model: MODEL_B });
  y.settingsApplied();
  y.tokenUsage({ responseId: 'synthetic-resp-q', threadId: x.threadId, turnId: 'synthetic-turn-t2', usage: { input: 3300, output: 100 } });
  x.turnContext({ turnId: 'synthetic-turn-t', model: MODEL_A });
  x.tokenUsage({ responseId: 'synthetic-resp-p', turnId: 'synthetic-turn-t', usage: { input: 3000, output: 100 } });
  x.turnContext({ turnId: 'synthetic-turn-tc', model: MODEL_B });
  x.tokenUsage({ responseId: 'synthetic-resp-c', turnId: 'synthetic-turn-tc', usage: { input: 3600, output: 100 } });
  const f1 = home(x)[0] as GeneratedFile;
  const f2 = home(y)[0] as GeneratedFile;
  const files = stamp([f1, f2], OLD_MTIME_MS);
  const resp: Resp[] = [
    { key: 'synthetic-resp-q', tokens: xt({ input: 3300 }), source: 'carried_unverified' },
    { key: 'synthetic-resp-p', tokens: xt({ input: 3000 }), source: 'own_turn', model: MODEL_A },
    { key: 'synthetic-resp-c', tokens: xt({ input: 3600 }), source: 'own_turn', model: MODEL_B },
  ];
  const mk = (rs: Reasons): R09Expect => build('codex', [[xid('x'), rs], [xid('y'), rs]], resp, { tainted: true });
  const after = mk(R('turn_model_conflicted'));
  return {
    name: 'r217-7',
    rules: 'R2.17 (7), R4.10 dissolving',
    files,
    expect: mk(R('stream_unresolved', 'turn_model_conflicted')),
    positions: [1, 2, 3].map((at) => ({ file: f2.path, at, dissolving: true, expect: after })),
    splittable: textPaths(files),
  };
}

/**
 * (8) the dissolving fixture without a conflicting context. F1 holds session_meta(X), turn_context(A, T) and the usage
 * record P of X in turn T. F2 holds session_meta(Y), a marker and a usage record Q with thread_id = X (turn T2).
 * Unsplit, F2 is a stream conflict and the families of X and Y are tainted (stream_unresolved). The split after
 * session_meta(Y) puts the marker into the stream of X: P is own_turn A and Q is carried_unverified (a marker exists).
 * The split between the marker and Q leaves the marker in the stream of Y: P is own_turn A, Q is carried_verified A.
 */
export function r217Fixture8(): R09Fixture {
  const t0 = BASE_TIME_MS;
  const { x, y } = xyThreads(t0 + 60_000, t0, 10, 20);
  x.turnContext({ turnId: 'synthetic-turn-t', model: MODEL_A });
  x.tokenUsage({ responseId: 'synthetic-resp-p', turnId: 'synthetic-turn-t', usage: { input: 3000, output: 100 } });
  y.settingsApplied();
  y.tokenUsage({ responseId: 'synthetic-resp-q', threadId: x.threadId, turnId: 'synthetic-turn-t2', usage: { input: 3300, output: 100 } });
  const f1 = home(x)[0] as GeneratedFile;
  const f2 = home(y)[0] as GeneratedFile;
  const files = stamp([f1, f2], OLD_MTIME_MS);
  const P = xt({ input: 3000 });
  const Q = xt({ input: 3300 });
  const unsplit = build(
    'codex',
    [[xid('x'), R('stream_unresolved')], [xid('y'), R('stream_unresolved')]],
    [
      { key: 'synthetic-resp-p', tokens: P, source: 'own_turn', model: MODEL_A },
      { key: 'synthetic-resp-q', tokens: Q, source: 'carried_unverified' },
    ],
    { tainted: true },
  );
  const clean = (q: Resp): R09Expect =>
    build('codex', [[xid('x'), []], [xid('y'), []]], [{ key: 'synthetic-resp-p', tokens: P, source: 'own_turn', model: MODEL_A }, q]);
  return {
    name: 'r217-8',
    rules: 'R2.17 (8), R4.10 dissolving, Q33',
    files,
    expect: unsplit,
    positions: [
      { file: f2.path, at: 1, dissolving: true, expect: clean({ key: 'synthetic-resp-q', tokens: Q, source: 'carried_unverified' }) },
      { file: f2.path, at: 2, dissolving: true, expect: clean({ key: 'synthetic-resp-q', tokens: Q, source: 'carried_verified', model: MODEL_A }) },
    ],
    splittable: textPaths(files),
  };
}

// ---------------------------------------------------------------------------
// R4.12 fixtures: a thread over two files that passes, and a stream that fails the ordinal check
// ---------------------------------------------------------------------------

/** A thread over two files whose ordinals are monotone: ordinal_verified, nothing tainted (Q21). */
export function r412TwoFilesFixture(): R09Fixture {
  const x = cth('tf');
  x.turnContext({ turnId: 'synthetic-turn-f1' });
  x.tokenUsage({ responseId: 'synthetic-resp-f1', usage: { input: 2000, output: 100 } });
  const cut = x.lines.length;
  x.tokenUsage({ responseId: 'synthetic-resp-f2', usage: { input: 2400, cached: 2000, output: 100 } });
  const h = new CodexHome();
  h.add(x, { splitAfter: [cut] });
  const files = stamp(h.files(), OLD_MTIME_MS);
  return {
    name: 'r412-two-files',
    rules: 'R4.12, Q21, R4.10',
    files,
    expect: build('codex', [[xid('tf'), []]], [
      { key: 'synthetic-resp-f1', tokens: xt({ input: 2000 }), source: 'own_turn', model: MODEL_A },
      { key: 'synthetic-resp-f2', tokens: xt({ input: 2400 }), source: 'own_turn', model: MODEL_A },
    ]),
    positions: [],
    splittable: textPaths(files),
  };
}

/** Two turn_context records of different models with the same ordinal, timestamp and payload type: a collision. */
export function r412CollisionFixture(): R09Fixture {
  const x = cth('oc');
  x.turnContext({ turnId: 'synthetic-turn-1', model: MODEL_A, ordinal: 50, dtMs: 1000 });
  x.turnContext({ turnId: 'synthetic-turn-2', model: MODEL_B, ordinal: 50, dtMs: 0 });
  x.tokenUsage({ responseId: 'synthetic-resp-oc', turnId: 'synthetic-turn-1', ordinal: 60, usage: { input: 2000, output: 100 } });
  return single('r412-collision', 'R4.12', x, xid('oc'), [{ key: 'synthetic-resp-oc', tokens: xt({ input: 2000 }), source: 'own_turn' }], R('ordinal_unverified'));
}

// ---------------------------------------------------------------------------
// the whole set
// ---------------------------------------------------------------------------

export function allR09Fixtures(): R09Fixture[] {
  return [
    r09Fixture1('a'),
    r09Fixture1('b'),
    r09Fixture1('c'),
    r09Fixture2(),
    r09Fixture3('parse_error', false),
    r09Fixture3('tail', false),
    r09Fixture3('parse_error', true),
    r09Fixture3('tail', true),
    r09Fixture4(),
    r09Fixture5(),
    r09Fixture6(),
    r09CounterFixture(),
    r217Fixture1(),
    r217Fixture2(false),
    r217Fixture2(true),
    r217Fixture3(),
    r217Fixture4(),
    r217Fixture5('two_models'),
    r217Fixture5('same_model'),
    r217Fixture5('copy_differs'),
    r217Fixture6(),
    r217Fixture7(),
    r217Fixture8(),
    r412TwoFilesFixture(),
    r412CollisionFixture(),
  ];
}
