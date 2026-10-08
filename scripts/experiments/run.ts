// Controlled experiment runner (spec section 12). Scaffolding only.
//
// Default is --dry-run: print the plan and the estimated number of model calls, spawn nothing.
// Real runs need both --execute and --budget-calls N.
//
// Independent measurement (R12.4): this file imports nothing from src/. It reads usage numbers from
// the product's own structured output and stores only numbers, timestamps and synthetic labels.
// It never writes prompt text, model output, stderr text, session ids or local paths.
//
// Run with Node 24:            node scripts/experiments/run.ts [flags]
// Run with Node 22.6 or newer: node --experimental-strip-types scripts/experiments/run.ts [flags]

import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  CONSTANTS, MIN_CACHEABLE_FALLBACK, SCENARIOS, callsPerRun, criterionOk, defaultRunsPerScenario,
  fillerTokens, findScenario, warmHitOk,
} from './scenarios.ts';
import type { Criterion, Provider, Scenario, Split } from './scenarios.ts';

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const HELP = `cachewhy experiment runner (dry-run by default)

Selection
  --split dev|heldout        dataset split (default dev). heldout needs the git tag spec-freeze.
  --scenarios P1,N1,...      scenario ids (default: all)
  --runs N                   runs per scenario (default: 20 for dev, 40 for heldout)
  --recovery                 also run step 4 (recovery check)

Execution (all required to spawn anything)
  --execute                  actually spawn claude -p / codex exec
  --budget-calls N           hard cap on model calls; refuses if the plan exceeds it
  --concurrency N            parallel runs, 1 to 8 (default 1). Useful for the long waits.
  --allow-unprobed           also run scenarios marked needs_probe

Fixed settings (R12.2), required with --execute for the providers involved
  --claude-model ID          main model for Claude runs
  --claude-alt-model ID      model used by the P3 intervention
  --codex-model ID           main model for Codex runs
  --codex-alt-model ID       model used by the P8 intervention
  --effort-base LEVEL        baseline effort, needed by P5, N4, P7
  --effort-alt LEVEL         effort used by the intervention, needed by P5, N4, P7
  --min-cacheable N          model minimum cacheable length in tokens (default ${MIN_CACHEABLE_FALLBACK}).
                             Check it against pricing/table.json. Filler is ${CONSTANTS.C30_FILLER_MULT} times this.
  --mcp-config PATH          synthetic MCP config for P4
  --claude-bin PATH          claude executable (default: claude)
  --codex-bin PATH           codex executable (default: codex)

Output
  --out DIR                  output root, must be git-ignored (default: local/experiments)
  --json                     print the plan as JSON
  --help
`;

interface Options {
  split: Split;
  scenarios: Scenario[];
  runs: number;
  recovery: boolean;
  execute: boolean;
  budgetCalls: number | null;
  concurrency: number;
  allowUnprobed: boolean;
  models: Record<Provider, { main?: string; alt?: string }>;
  effortBase?: string;
  effortAlt?: string;
  minCacheable: number;
  mcpConfig?: string;
  bins: Record<Provider, string>;
  out: string;
  json: boolean;
}

function fail(msg: string, code = 2): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

function posInt(name: string, v: string | undefined, dflt: number | null): number | null {
  if (v === undefined) return dflt;
  if (!/^[1-9][0-9]*$/.test(v)) fail(`${name} must be a positive integer`);
  return Number(v);
}

function parseOptions(argv: string[]): Options {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        split: { type: 'string' }, scenarios: { type: 'string' }, runs: { type: 'string' },
        recovery: { type: 'boolean' }, execute: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
        'budget-calls': { type: 'string' }, concurrency: { type: 'string' },
        'allow-unprobed': { type: 'boolean' },
        'claude-model': { type: 'string' }, 'claude-alt-model': { type: 'string' },
        'codex-model': { type: 'string' }, 'codex-alt-model': { type: 'string' },
        'effort-base': { type: 'string' }, 'effort-alt': { type: 'string' },
        'min-cacheable': { type: 'string' }, 'mcp-config': { type: 'string' },
        'claude-bin': { type: 'string' }, 'codex-bin': { type: 'string' },
        out: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' },
      },
    }));
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'bad arguments');
  }
  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (values.execute && values['dry-run']) fail('--execute and --dry-run are mutually exclusive');
  const split = (values.split ?? 'dev') as string;
  if (split !== 'dev' && split !== 'heldout') fail('--split must be dev or heldout');

  const ids = typeof values.scenarios === 'string' ? values.scenarios.split(',').map((x) => x.trim()).filter(Boolean) : null;
  const scenarios: Scenario[] = [];
  if (ids === null) scenarios.push(...SCENARIOS);
  else {
    for (const id of ids) {
      const s = findScenario(id);
      if (!s) fail(`unknown scenario ${id}`);
      if (!scenarios.includes(s)) scenarios.push(s);
    }
  }
  const str = (k: string): string | undefined => (typeof values[k] === 'string' ? (values[k] as string) : undefined);
  return {
    split,
    scenarios,
    runs: posInt('--runs', str('runs'), defaultRunsPerScenario(split)) as number,
    recovery: values.recovery === true,
    execute: values.execute === true,
    budgetCalls: posInt('--budget-calls', str('budget-calls'), null),
    concurrency: Math.min(8, posInt('--concurrency', str('concurrency'), 1) as number),
    allowUnprobed: values['allow-unprobed'] === true,
    models: {
      claude: { main: str('claude-model'), alt: str('claude-alt-model') },
      codex: { main: str('codex-model'), alt: str('codex-alt-model') },
    },
    effortBase: str('effort-base'),
    effortAlt: str('effort-alt'),
    minCacheable: posInt('--min-cacheable', str('min-cacheable'), MIN_CACHEABLE_FALLBACK) as number,
    mcpConfig: str('mcp-config'),
    bins: { claude: str('claude-bin') ?? 'claude', codex: str('codex-bin') ?? 'codex' },
    out: str('out') ?? 'local/experiments',
    json: values.json === true,
  };
}

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------

interface PlanRow {
  id: string;
  provider: Provider;
  kind: string;
  expected: string | null;
  criterion: Criterion;
  runs: number;
  callsPerRun: number;
  totalCalls: number;
  waitSecondsPerRun: number;
  drive: string;
  willExecute: boolean;
}

/** Approximate non-wait time per run (CLI start, three requests), seconds. Plan display only. */
const OVERHEAD_SECONDS_PER_RUN = 60;

function buildPlan(o: Options) {
  const rows: PlanRow[] = o.scenarios.map((s) => {
    const sc: Scenario = o.recovery ? { ...s, recoveryCheck: true } : s;
    const per = callsPerRun(sc);
    return {
      id: s.id, provider: s.provider, kind: s.kind, expected: s.expected, criterion: s.criterion,
      runs: o.runs, callsPerRun: per, totalCalls: per * o.runs,
      waitSecondsPerRun: s.intervention.waitSeconds, drive: s.drive,
      willExecute: s.drive === 'ready' || o.allowUnprobed,
    };
  });
  const executing = rows.filter((r) => r.willExecute);
  const totalCalls = executing.reduce((a, r) => a + r.totalCalls, 0);
  const allCalls = rows.reduce((a, r) => a + r.totalCalls, 0);
  const serialSeconds = executing.reduce((a, r) => a + r.runs * (r.waitSecondsPerRun + OVERHEAD_SECONDS_PER_RUN), 0);
  return {
    split: o.split,
    runsPerScenario: o.runs,
    rows,
    estimatedModelCalls: totalCalls,
    estimatedModelCallsAllSelected: allCalls,
    estimatedWallSecondsAtConcurrency: Math.ceil(serialSeconds / o.concurrency),
    concurrency: o.concurrency,
    note: 'Runs per scenario are the pre-discard target. Discards and no_effect runs reduce the scored count; held-out generation continues up to the budget (R12.7).',
  };
}

function printPlan(o: Options, plan: ReturnType<typeof buildPlan>): void {
  if (o.json) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    return;
  }
  const out: string[] = [];
  out.push(`Plan: split=${plan.split}, ${plan.runsPerScenario} runs per scenario, concurrency ${plan.concurrency}`);
  out.push('');
  out.push(['id', 'prov', 'kind', 'expected', 'crit', 'runs', 'calls/run', 'calls', 'wait s', 'drive'].join('\t'));
  for (const r of plan.rows) {
    out.push([r.id, r.provider, r.kind, r.expected ?? '(none)', r.criterion, r.runs, r.callsPerRun, r.totalCalls,
      r.waitSecondsPerRun, r.willExecute ? r.drive : `${r.drive} (skipped)`].join('\t'));
  }
  out.push('');
  out.push(`Estimated model calls: ${plan.estimatedModelCalls}` +
    (plan.estimatedModelCallsAllSelected !== plan.estimatedModelCalls ? ` (${plan.estimatedModelCallsAllSelected} including needs_probe scenarios)` : ''));
  out.push(`Estimated wall time: about ${Math.ceil(plan.estimatedWallSecondsAtConcurrency / 60)} min (waits plus ~${OVERHEAD_SECONDS_PER_RUN} s per run)`);
  out.push(`Filler per run: about ${fillerTokens(o.minCacheable)} tokens (${CONSTANTS.C30_FILLER_MULT} x ${o.minCacheable})`);
  out.push('');
  out.push(o.execute ? 'Mode: EXECUTE' : 'Mode: dry run. Nothing was spawned.');
  if (!o.execute) {
    out.push(`To run for real add: --execute --budget-calls ${Math.max(plan.estimatedModelCalls, 1)}`);
    out.push('(see scripts/experiments/README.md for required model flags and the pre-flight checklist)');
  }
  process.stdout.write(out.join('\n') + '\n');
}

// ---------------------------------------------------------------------------------------------
// Pre-flight guards (execute mode only)
// ---------------------------------------------------------------------------------------------

function git(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() };
  } catch {
    return { ok: false, out: '' };
  }
}

function preflight(o: Options, plan: ReturnType<typeof buildPlan>): string {
  if (o.budgetCalls === null) fail('--execute requires --budget-calls N');
  if (plan.estimatedModelCalls > o.budgetCalls) {
    fail(`plan needs about ${plan.estimatedModelCalls} model calls, budget is ${o.budgetCalls}. Lower --runs or --scenarios, or raise the budget.`);
  }
  const running = o.scenarios.filter((s) => s.drive === 'ready' || o.allowUnprobed);
  if (running.length === 0) fail('nothing to execute: all selected scenarios are needs_probe (see --allow-unprobed)');
  const providers = new Set(running.map((s) => s.provider));
  for (const p of providers) {
    if (!o.models[p].main) fail(`--${p}-model is required`);
  }
  for (const s of running) {
    if (s.intervention.modelRole === 'alt' && !o.models[s.provider].alt) fail(`--${s.provider}-alt-model is required for ${s.id}`);
    if ((s.id === 'P5' || s.id === 'N4' || s.id === 'P7') && (!o.effortAlt || !o.effortBase)) fail(`--effort-base and --effort-alt are required for ${s.id}`);
    if (s.id === 'P4' && !o.mcpConfig) fail('--mcp-config is required for P4');
  }
  if (o.split === 'heldout') {
    const tag = git(['tag', '--list', 'spec-freeze']);
    if (!tag.ok || tag.out !== 'spec-freeze') fail('held-out runs are refused: git tag spec-freeze does not exist (spec section 0.4)');
    const dirty = git(['status', '--porcelain', '--', 'docs/methodology.md', 'scripts/experiments']);
    if (!dirty.ok || dirty.out !== '') fail('held-out runs are refused: docs/methodology.md or scripts/experiments has uncommitted changes');
  }
  const outRoot = resolve(o.out);
  if (!git(['check-ignore', '-q', '--', o.out]).ok) fail(`output dir ${o.out} is not git-ignored; refusing to write run data there`);
  mkdirSync(outRoot, { recursive: true });
  return outRoot;
}

// ---------------------------------------------------------------------------------------------
// Measurement types
// ---------------------------------------------------------------------------------------------

/** Counters as decimal strings so JSON round-trips exactly (BigInt inside). */
interface Req {
  at: string; // harness wall-clock time the usage record was read
  subagent: boolean;
  input: bigint; // uncached input tokens
  read: bigint; // R: cache read
  write: bigint; // W: cache creation (Codex: derived as input - cached)
  output: bigint;
}

interface StepResult {
  step: 1 | 2 | 3 | 4;
  sentAt: string;
  endedAt: string;
  exitCode: number | null;
  requests: Req[];
}

const big = (v: unknown): bigint => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? BigInt(Math.trunc(v)) : 0n);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Claude stream-json: one request per distinct assistant message id; the result line is a total. */
function parseClaudeLine(line: string, seen: Set<string>, now: string): Req | null {
  let j: unknown;
  try { j = JSON.parse(line); } catch { return null; }
  if (!isObj(j) || j.type !== 'assistant' || !isObj(j.message)) return null;
  const m = j.message;
  const id = typeof m.id === 'string' ? m.id : null;
  if (id === null || seen.has(id) || !isObj(m.usage)) return null;
  seen.add(id);
  const u = m.usage;
  return {
    at: now, subagent: j.parent_tool_use_id != null,
    input: big(u.input_tokens), read: big(u.cache_read_input_tokens), write: big(u.cache_creation_input_tokens),
    output: big(u.output_tokens),
  };
}

/** Codex exec --json: turn.completed carries usage. input_tokens includes cached_input_tokens. */
function parseCodexLine(line: string, now: string): { req: Req | null; thread: string | null } {
  let j: unknown;
  try { j = JSON.parse(line); } catch { return { req: null, thread: null }; }
  if (!isObj(j)) return { req: null, thread: null };
  if (j.type === 'thread.started' && typeof j.thread_id === 'string') return { req: null, thread: j.thread_id };
  if (j.type === 'turn.completed' && isObj(j.usage)) {
    const u = j.usage;
    const input = big(u.input_tokens);
    const cached = big(u.cached_input_tokens);
    return { req: { at: now, subagent: false, input: 0n, read: cached, write: input > cached ? input - cached : 0n, output: big(u.output_tokens) }, thread: null };
  }
  return { req: null, thread: null };
}

// ---------------------------------------------------------------------------------------------
// Prompts and invocation
// ---------------------------------------------------------------------------------------------

const WORDS = ['amber', 'basalt', 'cedar', 'delta', 'ember', 'fjord', 'garnet', 'harbor', 'iris', 'jade', 'kelp', 'lumen',
  'maple', 'nickel', 'onyx', 'pearl', 'quartz', 'raven', 'slate', 'tundra', 'umber', 'violet', 'willow', 'zephyr'];

/** Synthetic filler. Starts with the nonce so concurrent runs cannot share cache entries (R12.2). */
function makeFiller(nonce: string, tokens: number): string {
  let x = parseInt(nonce.slice(0, 8), 16) >>> 0;
  const n = Math.ceil(tokens * 1.2); // short common words are roughly one token each; K_1 is checked afterwards
  const parts: string[] = [`Run nonce ${nonce}. Reference text follows and needs no analysis.`];
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    parts.push(WORDS[x % WORDS.length] as string);
  }
  return parts.join(' ');
}

const ACK = 'Reply with the single word: ok';

function stepPrompt(s: Scenario, step: 1 | 2 | 3 | 4, filler: string): string {
  if (step === 1) return `${filler}\n\n${ACK}`;
  if (step === 3 && s.id === 'P6') return '/compact';
  if (step === 3 && s.id === 'N5') return 'Use one subagent to reply with the single word ok, then reply with the single word: ok';
  return ACK;
}

const children = new Set<ChildProcess>();

interface Invocation {
  provider: Provider;
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin: string;
}

/** Spawns one CLI call. Returns requests parsed from stdout. stdout and stderr text is never stored. */
function runCli(inv: Invocation, step: StepResult['step'], onThread: (t: string) => void): Promise<StepResult> {
  return new Promise((resolveP) => {
    const seen = new Set<string>();
    const requests: Req[] = [];
    const sentAt = new Date().toISOString();
    const child = spawn(inv.bin, inv.args, { cwd: inv.cwd, env: inv.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    children.add(child);
    let buf = '';
    const handle = (line: string): void => {
      if (line === '') return;
      const now = new Date().toISOString();
      if (inv.provider === 'claude') {
        const r = parseClaudeLine(line, seen, now);
        if (r) requests.push(r);
      } else {
        const { req, thread } = parseCodexLine(line, now);
        if (req) requests.push(req);
        if (thread) onThread(thread);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    const done = (code: number | null): void => {
      children.delete(child);
      handle(buf);
      resolveP({ step, sentAt, endedAt: new Date().toISOString(), exitCode: code, requests });
    };
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
    child.stdin.on('error', () => undefined);
    child.stdin.end(inv.stdin);
  });
}

function fill(args: string[], o: Options): string[] {
  return args.map((a) => a.replaceAll('{{EFFORT_ALT}}', o.effortAlt ?? '').replaceAll('{{MCP_CONFIG}}', o.mcpConfig ?? ''));
}

function buildInvocation(o: Options, s: Scenario, step: StepResult['step'], ctx: { cwd: string; sessionId: string | null; claudeUuid: string; prompt: string }): Invocation {
  const intervened = step === 3;
  const modelIds = o.models[s.provider];
  const model = intervened && s.intervention.modelRole === 'alt' ? modelIds.alt : modelIds.main;
  const extra = intervened ? fill(s.intervention.args ?? [], o) : [];
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.FORCE_PROMPT_CACHING_5M; // recorded as "unset" in the manifest (R12.2)
  delete env.CLAUDE_CODE_PROMPT_CACHE_TTL;
  if (s.provider === 'claude' && s.baseline.claudeTtlEnv) env.CLAUDE_CODE_PROMPT_CACHE_TTL = s.baseline.claudeTtlEnv;
  if (intervened) Object.assign(env, s.intervention.env ?? {});

  if (s.provider === 'claude') {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model as string];
    if (o.effortBase && !(intervened && extra.includes('--effort'))) args.push('--effort', o.effortBase);
    args.push(...extra);
    args.push(...(step === 1 ? ['--session-id', ctx.claudeUuid] : ['--resume', ctx.claudeUuid]));
    return { provider: 'claude', bin: o.bins.claude, args, env, cwd: ctx.cwd, stdin: ctx.prompt };
  }
  const base = ['exec'];
  if (step !== 1) base.push('resume', ctx.sessionId as string);
  base.push('--json', '--skip-git-repo-check', '-m', model as string);
  if (step === 1) base.push('--sandbox', 'read-only');
  const hasEffortOverride = extra.some((a) => a.startsWith('model_reasoning_effort'));
  if (o.effortBase && !(intervened && hasEffortOverride)) base.push('-c', `model_reasoning_effort="${o.effortBase}"`);
  base.push(...extra, '-');
  return { provider: 'codex', bin: o.bins.codex, args: base, env, cwd: ctx.cwd, stdin: ctx.prompt };
}

// ---------------------------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const str = (b: bigint): string => b.toString();
const reqOut = (r: Req) => ({ at: r.at, subagent: r.subagent, input: str(r.input), read: str(r.read), write: str(r.write), output: str(r.output) });
const K = (r: Req): bigint => r.read + r.write;

interface Budget { limit: number; spent: number; }

async function runOne(o: Options, s: Scenario, index: number, runDir: string, budget: Budget, productVersion: string): Promise<{ status: string; observedCalls: number }> {
  const label = `${o.split}-${s.id}-${String(index + 1).padStart(3, '0')}`;
  const dir = join(runDir, label);
  mkdirSync(dir, { recursive: true });
  const nonce = randomBytes(8).toString('hex'); // synthetic; the only key linking a manifest to a transcript
  const cwd = mkdtempSync(join(tmpdir(), 'cachewhy-exp-'));
  const modelIds = o.models[s.provider];
  const recovery = o.recovery || s.recoveryCheck;
  const filler = makeFiller(nonce, fillerTokens(o.minCacheable));
  const ctx = { cwd, sessionId: null as string | null, claudeUuid: randomUUID(), prompt: '' };

  const manifest: Record<string, unknown> = {
    schema: 1,
    run: label,
    scenario: s.id,
    provider: s.provider,
    split: o.split,
    nonce,
    productVersion,
    settings: {
      model: modelIds.main ?? null,
      altModel: s.intervention.modelRole === 'alt' ? modelIds.alt ?? null : null,
      ttlEnv: s.provider === 'claude' ? s.baseline.claudeTtlEnv ?? null : null,
      force5mCaching: 'unset',
      effortBase: o.effortBase ?? null,
      effortAlt: o.effortAlt ?? null,
      fastMode: 'off',
      minCacheableTokens: o.minCacheable,
      fillerMult: CONSTANTS.C30_FILLER_MULT,
      workingDirContent: 'empty',
    },
    // Stated before the run (R12.3).
    expected: {
      label: s.expected,
      criterion: s.criterion,
      subagentCriterion: s.subagentCriterion ?? null,
      intervention: s.intervention.label,
      plannedWaitSeconds: s.intervention.waitSeconds,
    },
    status: 'started',
    startedAt: new Date().toISOString(),
  };
  const save = (): void => writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  save();

  const steps: StepResult[] = [];
  let observed = 0;
  const finish = (status: string, extra: Record<string, unknown> = {}): { status: string; observedCalls: number } => {
    Object.assign(manifest, extra, { status, steps: steps.map((st) => ({ ...st, requests: st.requests.map(reqOut) })), finishedAt: new Date().toISOString() });
    save();
    appendFileSync(join(runDir, 'runs.jsonl'), JSON.stringify({ run: label, scenario: s.id, status, ...(extra.discarded ? { discarded: extra.discarded } : {}), ...(extra.verdict ? { verdict: extra.verdict } : {}) }) + '\n');
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
    return { status, observedCalls: observed };
  };

  const doStep = async (step: StepResult['step']): Promise<StepResult | null> => {
    const need = s.expectedModelCalls[`step${step}` as 'step1' | 'step2' | 'step3' | 'step4'];
    if (budget.spent + need > budget.limit) return null;
    ctx.prompt = stepPrompt(s, step, filler);
    const inv = buildInvocation(o, s, step, ctx);
    const res = await runCli(inv, step, (t) => { ctx.sessionId = t; });
    steps.push(res);
    observed += Math.max(res.requests.length, 1);
    budget.spent += Math.max(res.requests.length, 1);
    return res;
  };

  // Step 1: cold write.
  const s1 = await doStep(1);
  if (s1 === null) return finish('budget_exhausted', { discarded: { reason: 'budget_exhausted' } });
  const r1 = s1.requests.find((r) => !r.subagent);
  if (s1.exitCode !== 0 || !r1) return finish('discarded', { discarded: { reason: 'step1_invocation_failed' } });
  if (s.provider === 'codex' && !ctx.sessionId) return finish('discarded', { discarded: { reason: 'step1_no_thread' } });
  const k1 = K(r1);
  if (k1 < BigInt(fillerTokens(o.minCacheable))) return finish('discarded', { discarded: { reason: 'filler_below_target', k1: str(k1) } });

  // Step 2: warm hit precondition, before any intervention.
  const s2 = await doStep(2);
  if (s2 === null) return finish('budget_exhausted', { discarded: { reason: 'budget_exhausted' } });
  const r2 = s2.requests.find((r) => !r.subagent);
  if (s2.exitCode !== 0 || !r2) return finish('discarded', { discarded: { reason: 'step2_invocation_failed' } });
  const warm = warmHitOk(r2.read, k1);
  manifest.precondition = { warmHit: warm, rule: '10*R2 >= 9*K1', r2: str(r2.read), k1: str(k1) };
  if (!warm) return finish('discarded', { discarded: { reason: 'warm_hit_precondition_failed' } });
  const k2 = K(r2);

  // Intervention: exactly one change, applied between step 2 and step 3.
  if (s.intervention.waitSeconds > 0) await sleep(s.intervention.waitSeconds * 1000);
  manifest.interventionAt = new Date().toISOString();

  const s3 = await doStep(3);
  if (s3 === null) return finish('budget_exhausted', { discarded: { reason: 'budget_exhausted' } });
  const r3 = s3.requests.find((r) => !r.subagent);
  if (s3.exitCode !== 0 || !r3) return finish('discarded', { discarded: { reason: 'step3_invocation_failed' } });

  // Harness verdict, written before cachewhy ever sees the transcript (R12.3).
  const mainOk = criterionOk(s.criterion, r3.read, k2);
  let verdict = mainOk ? 'effect_verified' : 'no_effect';
  const detail: Record<string, unknown> = { main: { criterion: s.criterion, ok: mainOk, r3: str(r3.read), k2: str(k2) } };
  if (s.subagentCriterion) {
    const sub = s3.requests.find((r) => r.subagent);
    // Assumption: the subagent chain has no prior step, so its criterion uses its own R and K.
    const subOk = sub ? criterionOk(s.subagentCriterion, sub.read, K(sub)) : false;
    detail.subagent = { criterion: s.subagentCriterion, found: Boolean(sub), ok: subOk };
    if (!subOk) verdict = 'no_effect';
  }

  if (recovery) await doStep(4);
  return finish('complete', { verdict, verdictDetail: detail });
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

function productVersion(provider: Provider, bin: string): string {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }).trim().slice(0, 64);
  } catch {
    return fail(`could not run ${provider} --version using "${bin}"`);
  }
}

async function main(): Promise<void> {
  const o = parseOptions(process.argv.slice(2));
  const plan = buildPlan(o);
  printPlan(o, plan);
  if (!o.execute) return;

  const outRoot = preflight(o, plan);
  const running = o.scenarios.filter((s) => s.drive === 'ready' || o.allowUnprobed);
  const versions: Partial<Record<Provider, string>> = {};
  for (const p of new Set(running.map((s) => s.provider))) versions[p] = productVersion(p, o.bins[p]);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(outRoot, o.split, stamp);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify({ ...plan, versions, budgetCalls: o.budgetCalls }, null, 2) + '\n');
  if (!existsSync(runDir)) fail('could not create output directory');

  const budget: Budget = { limit: o.budgetCalls as number, spent: 0 };
  const queue: Array<{ s: Scenario; i: number }> = [];
  // Interleave scenarios so a stopped session still has a balanced partial set.
  for (let i = 0; i < o.runs; i++) for (const s of running) queue.push({ s, i });

  const stop = (): void => {
    for (const c of children) c.kill();
    process.stderr.write('interrupted; child processes killed. Partial manifests remain in the output dir.\n');
    process.exit(130);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const tally: Record<string, number> = {};
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const res = await runOne(o, job.s, job.i, runDir, budget, versions[job.s.provider] as string);
      tally[res.status] = (tally[res.status] ?? 0) + 1;
      process.stdout.write(`${job.s.id} #${job.i + 1}: ${res.status} (calls so far ${budget.spent}/${budget.limit})\n`);
    }
  };
  await Promise.all(Array.from({ length: o.concurrency }, () => worker()));
  process.stdout.write(`Done. ${JSON.stringify(tally)}; model calls observed ${budget.spent}/${budget.limit}. Output: ${o.out}/${o.split}/${stamp}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : 'unexpected failure'}\n`);
  process.exit(1);
});
