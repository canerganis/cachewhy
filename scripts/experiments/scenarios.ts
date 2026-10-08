// Experiment scenarios as data (spec R12.5). Independent of src/ on purpose (R12.4).
// Erasable TypeScript only (no enums, no parameter properties) so Node 22.6+ with
// --experimental-strip-types and Node 24 can run it directly.
//
// Wait times and all other parameters here are scenario parameters frozen by the
// spec-freeze tag (spec section 0.4). Changing them after the tag is a spec change.

export type Provider = 'claude' | 'codex';
export type Criterion = 'miss' | 'hit';
export type Split = 'dev' | 'heldout';

/** Spec constants used by the harness (section 0.3). Rationals are kept as num/den. */
export const CONSTANTS = {
  C12_N_EVAL_MIN: 40,
  C15_N_DEV_MIN: 20,
  /** C21 EFFECT_MISS_MAX = 1/2 */
  C21: { num: 1n, den: 2n },
  /** C22 HIT_MIN = 9/10 */
  C22: { num: 9n, den: 10n },
  /** C23 NO_EFFECT_MAX = 1/5 */
  C23: { num: 1n, den: 5n },
  /** C30 FILLER_MULT */
  C30_FILLER_MULT: 3,
} as const;

/**
 * One intervention, applied exactly once between step 2 and step 3 (R12.3).
 * Elapsed time is an intervention too: a pure wait changes nothing else.
 * Only the fields that differ from the baseline are set.
 */
export interface Intervention {
  /** Seconds to sleep before the step 3 request. 0 for none. */
  waitSeconds: number;
  /** Env vars changed for step 3 only. */
  env?: Record<string, string>;
  /** Extra CLI args for step 3 only (provider specific). Tokens like {{EFFORT_ALT}} are filled by the runner. */
  args?: string[];
  /** Use the alternate model at step 3 instead of the baseline model. */
  modelRole?: 'alt';
  /** Short plain description, written to the manifest as the intervention label. */
  label: string;
}

/** Settings fixed for all steps of a run (R12.2). */
export interface BaselineSettings {
  /** Value for CLAUDE_CODE_PROMPT_CACHE_TTL on Claude runs. Absent means product default. */
  claudeTtlEnv?: string;
}

export interface Scenario {
  id: string;
  provider: Provider;
  title: string;
  /** Scored label, or null for negative controls (expect no event). */
  expected: string | null;
  /** Effect criterion for the step 3 request (R12.3). */
  criterion: Criterion;
  /** Extra criterion for the first request of a subagent chain (N5 only). */
  subagentCriterion?: Criterion;
  kind: 'positive' | 'negative';
  baseline: BaselineSettings;
  intervention: Intervention;
  /** Whether step 4 (recovery check) is run. Optional in the spec, off by default. */
  recoveryCheck: boolean;
  /**
   * Model requests expected per step, used only for the call estimate. Step 3 of N5 spawns a
   * subagent so it is expected to cost more.
   */
  expectedModelCalls: { step1: number; step2: number; step3: number; step4: number };
  /**
   * 'ready': the CLI drive is straightforward. 'needs_probe': the exact flag, env var or headless
   * behavior for the pinned product version must be confirmed before execution (see README).
   * needs_probe scenarios are skipped at --execute unless --allow-unprobed is given.
   */
  drive: 'ready' | 'needs_probe';
  notes: string;
}

const oneCall = { step1: 1, step2: 1, step3: 1, step4: 1 } as const;

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'P1', provider: 'claude', title: 'Wait past a fixed 5m TTL (330 s)',
    expected: 'ttl_expiry_compatible', criterion: 'miss', kind: 'positive',
    baseline: { claudeTtlEnv: '5m' },
    intervention: { waitSeconds: 330, label: 'wait 330 s' },
    recoveryCheck: false, expectedModelCalls: oneCall, drive: 'ready',
    notes: 'Main bucket with explicit 5m override.',
  },
  {
    id: 'N1', provider: 'claude', title: 'Wait inside a fixed 5m TTL (240 s)',
    expected: null, criterion: 'hit', kind: 'negative',
    baseline: { claudeTtlEnv: '5m' },
    intervention: { waitSeconds: 240, label: 'wait 240 s' },
    recoveryCheck: false, expectedModelCalls: oneCall, drive: 'ready',
    notes: 'Shorter than the TTL.',
  },
  {
    id: 'N2', provider: 'claude', title: 'Default 1h TTL, wait 330 s',
    expected: null, criterion: 'hit', kind: 'negative',
    baseline: { claudeTtlEnv: '1h' },
    intervention: { waitSeconds: 330, label: 'wait 330 s' },
    recoveryCheck: false, expectedModelCalls: oneCall, drive: 'ready',
    notes: '1h-vs-5m awareness: a 5m wait must not expire a 1h entry.',
  },
  {
    id: 'P2', provider: 'claude', title: 'Default 1h TTL, wait 3720 s',
    expected: 'ttl_expiry_compatible', criterion: 'miss', kind: 'positive',
    baseline: { claudeTtlEnv: '1h' },
    intervention: { waitSeconds: 3720, label: 'wait 3720 s' },
    recoveryCheck: false, expectedModelCalls: oneCall, drive: 'ready',
    notes: 'Long run. Use --concurrency; each run has its own nonce so entries cannot be shared.',
  },
  {
    id: 'P3', provider: 'claude', title: 'Switch model between step 2 and 3',
    expected: 'model_switch', criterion: 'miss', kind: 'positive',
    baseline: {},
    intervention: { waitSeconds: 0, modelRole: 'alt', label: 'switch model' },
    recoveryCheck: false, expectedModelCalls: oneCall, drive: 'ready',
    notes: 'Boundary scenario. Intervention must also show a miss.',
  },
  {
    id: 'P4', provider: 'claude', title: 'Add an MCP server so tools load upfront',
    expected: 'tools_or_system_changed', criterion: 'miss', kind: 'positive',
    baseline: {},
    intervention: { waitSeconds: 0, args: ['--mcp-config', '{{MCP_CONFIG}}', '--strict-mcp-config'], label: 'add MCP server' },
    recoveryCheck: false, expectedModelCalls: oneCall, drive: 'needs_probe',
    notes: 'Needs a local synthetic stdio MCP server. If the pinned version loads tools through tool search the run is invalid and dropped by manifest.',
  },
  {
    id: 'N3', provider: 'claude', title: 'Change only permission mode',
    expected: null, criterion: 'hit', kind: 'negative',
    baseline: {},
    intervention: { waitSeconds: 0, args: ['--permission-mode', 'plan'], label: 'change permission mode' },
    recoveryCheck: false, expectedModelCalls: oneCall, drive: 'needs_probe',
    notes: 'Documented as cache-preserving. An output style variant needs its own probe.',
  },
  {
    id: 'P5', provider: 'claude', title: 'Change effort on a model that invalidates on effort change',
    expected: 'request_settings_changed', criterion: 'miss', kind: 'positive',
    baseline: {},
    intervention: { waitSeconds: 0, args: ['--effort', '{{EFFORT_ALT}}'], label: 'change effort' },
    recoveryCheck: false, expectedModelCalls: oneCall, drive: 'needs_probe',
    notes: 'The model must be one that invalidates on effort change. Choose it with --model.',
  },
  {
    id: 'N4', provider: 'claude', title: 'Change effort on a cache-preserving model',
    expected: null, criterion: 'hit', kind: 'negative',
    baseline: {},
    intervention: { waitSeconds: 0, args: ['--effort', '{{EFFORT_ALT}}'], label: 'change effort' },
    recoveryCheck: false, expectedModelCalls: oneCall, drive: 'needs_probe',
    notes: 'Documented as cache-preserving for the listed model families. Choose the model with --model.',
  },
  {
    id: 'P6', provider: 'claude', title: '/compact',
    expected: 'compaction_or_clear', criterion: 'miss', kind: 'positive',
    baseline: {},
    intervention: { waitSeconds: 0, label: 'compact' },
    recoveryCheck: false, expectedModelCalls: { step1: 1, step2: 1, step3: 2, step4: 1 }, drive: 'needs_probe',
    notes: 'Only if /compact is drivable headless for the pinned version; otherwise the class is excluded from claims.',
  },
  {
    id: 'N5', provider: 'claude', title: 'Spawn a subagent from the main chain and continue',
    expected: null, criterion: 'hit', subagentCriterion: 'miss', kind: 'negative',
    baseline: {},
    intervention: { waitSeconds: 0, label: 'spawn subagent' },
    recoveryCheck: false, expectedModelCalls: { step1: 1, step2: 1, step3: 3, step4: 1 }, drive: 'needs_probe',
    notes: 'Main chain: hit. First request of the subagent chain: miss (boundary subagent_cold_start). The step 3 prompt asks for one subagent call.',
  },
  {
    id: 'P7', provider: 'codex', title: 'Change reasoning.effort via exec resume',
    expected: 'request_settings_changed', criterion: 'miss', kind: 'positive',
    baseline: {},
    intervention: { waitSeconds: 0, args: ['-c', 'model_reasoning_effort="{{EFFORT_ALT}}"'], label: 'change reasoning effort' },
    recoveryCheck: false, expectedModelCalls: oneCall, drive: 'needs_probe',
    notes: 'Config override key and accepted values must be confirmed for the pinned Codex version.',
  },
  {
    id: 'P8', provider: 'codex', title: 'Switch model',
    expected: 'model_switch', criterion: 'miss', kind: 'positive',
    baseline: {},
    intervention: { waitSeconds: 0, modelRole: 'alt', label: 'switch model' },
    recoveryCheck: false, expectedModelCalls: oneCall, drive: 'ready',
    notes: 'Boundary scenario. Intervention must also show a miss.',
  },
  {
    id: 'P9', provider: 'codex', title: 'Wait 1860 s on a model with the 30 minute TTL',
    expected: 'ttl_expiry_compatible', criterion: 'miss', kind: 'positive',
    baseline: {},
    intervention: { waitSeconds: 1860, label: 'wait 1860 s' },
    recoveryCheck: false, expectedModelCalls: oneCall, drive: 'ready',
    notes: 'The main model must be a gpt-6* or gpt-5.6* model (see --model).',
  },
  {
    id: 'N6', provider: 'codex', title: 'Wait 1500 s, same model',
    expected: null, criterion: 'hit', kind: 'negative',
    baseline: {},
    intervention: { waitSeconds: 1500, label: 'wait 1500 s' },
    recoveryCheck: false, expectedModelCalls: oneCall, drive: 'ready',
    notes: 'Shorter than 30 minutes.',
  },
  {
    id: 'N7', provider: 'codex', title: 'No change, immediate continue',
    expected: null, criterion: 'hit', kind: 'negative',
    baseline: {},
    intervention: { waitSeconds: 0, label: 'none' },
    recoveryCheck: false, expectedModelCalls: oneCall, drive: 'ready',
    notes: 'Baseline.',
  },
];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id.toUpperCase());
}

/** Runs per scenario for a split. Dev: C15 (20). Held-out: C12 target (40) before discards. */
export function defaultRunsPerScenario(split: Split): number {
  return split === 'dev' ? CONSTANTS.C15_N_DEV_MIN : CONSTANTS.C12_N_EVAL_MIN;
}

export function callsPerRun(s: Scenario): number {
  const c = s.expectedModelCalls;
  return c.step1 + c.step2 + c.step3 + (s.recoveryCheck ? c.step4 : 0);
}

/**
 * Fallback minimum cacheable prompt length in tokens when the model is unknown. This is a
 * placeholder: the operator must check it against pricing/table.json (R15.1) and pass
 * --min-cacheable. The filler is C30 times this value, so too large is safe and too small is not.
 */
export const MIN_CACHEABLE_FALLBACK = 4096;

export function fillerTokens(minCacheable: number): number {
  return minCacheable * CONSTANTS.C30_FILLER_MULT;
}

/** Ratio checks in BigInt (R2.16, R12.3). Counters are non-negative integers. */
export function warmHitOk(r2: bigint, k1: bigint): boolean {
  // 10 * R_2 >= 9 * K_1
  return k1 > 0n && r2 * CONSTANTS.C22.den >= CONSTANTS.C22.num * k1;
}
export function criterionOk(c: Criterion, r3: bigint, k2: bigint): boolean {
  if (c === 'miss') return r3 * CONSTANTS.C21.den <= CONSTANTS.C21.num * k2; // 2 * R_3 <= K_2
  return k2 > 0n && r3 * CONSTANTS.C22.den >= CONSTANTS.C22.num * k2; // 10 * R_3 >= 9 * K_2
}
