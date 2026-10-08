// Claude Code source reader. Binding spec: docs/methodology.md (spec-1, revision 7).
//
// parseClaude(files, opts) turns the Claude files of `discover()` into Responses (one per (key, chain)),
// links, streams, markers and coverage counters. It applies, in order:
//   R1.2/R1.3/R1.4  structural allowlist, parse failures, record types
//   R2.1-R2.5, R2.12-R2.16  usage normalization, range check, BigInt only
//   R4.1-R4.3, R4.5-R4.7  keys, copy selection, retries, replay ownership
//   R5.1-R5.5, R5.9  chains, kinds, subagent and workflow linkage, helper tagging
//   R6.3, R6.4  start bounds inputs (t_first, t_last, t_asm, start_lo)
//   R10.1, R10.6, R10.7  diagnostics and prefix hints
//   R11.7  compact boundary records and the uuid index for the walks
//   R15.7  unverified versions are counted, never accounted
//   R17.1, R17.5, R17.6  coverage counters, unlogged-usage inputs, physical vs logical counters
//
// Privacy (R1.1): every free-text field is parsed and dropped. Ids stay in process memory only. A SHA-256 of the
// retained projection of a record is used transiently to collapse equal records (R4.12 equality); nothing else is
// hashed and nothing is exported.
//
// Order independence (R4.3, R4.10): files are put in a canonical order before indices are assigned, equal records are
// collapsed on their retained projection, every iteration over a collection that could depend on line or file order
// is over a sorted copy, and every tie-break is a total order.

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import type { DiscoveredFile } from "../discover.js";
import { mapWithLimit, newLineStats, readLines } from "../io/lines.js";
import {
  CLAUDE_FULL_VERSIONS,
  CONSTANTS,
  RESPONSE_FLAGS,
  chainKeyString,
  emptyCoverage,
} from "../model/types.js";
import type {
  AgentPrefixHint,
  Assumption,
  ChainKey,
  ClaudeCompactBoundary,
  ClaudeParseResult,
  ClaudeResponse,
  ClaudeUuidNode,
  ConflictKind,
  CostStateUsage,
  CoverageCounters,
  DedupConflict,
  DiagType,
  Diagnostics,
  Effort,
  Entrypoint,
  ExcludedRecord,
  ExclusionReason,
  FileInfo,
  Geo,
  Link,
  ModelAttribution,
  Modifiers,
  ParseClaude,
  ParseOptions,
  RequestKind,
  ResponseFlag,
  ServiceTier,
  Speed,
  StopReason,
  Stream,
  UnlinkedReason,
  UsageBuckets,
} from "../model/types.js";

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Ascending, null last. */
const cmpNum = (a: number | null, b: number | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
};
const cmpNullStr = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return cmpStr(a, b);
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const BUILD_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$/;
const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FULL_VERSIONS: ReadonlySet<string> = new Set<string>(CLAUDE_FULL_VERSIONS);
const DAY_MS = 86_400_000;
const MAX_SIDECAR_BYTES = 8 * 1024 * 1024;
const READ_CONCURRENCY = 8;

function parseTs(v: unknown): number | null {
  if (typeof v !== "string" || !ISO_RE.test(v)) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** R3.3: strip a trailing -YYYYMMDD. R14.3: anything that is not a plain model id becomes `unlisted`. */
function normModel(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const s = v.replace(/-\d{8}$/, "");
  return MODEL_RE.test(s) ? s : "unlisted";
}

function pick<T extends string>(v: unknown, allowed: readonly T[]): T | "other" | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  return "other";
}

/** A counter after R2.15: a bigint, or why it is not usable. */
type Cnt = bigint | "missing" | "bad" | "range";

function cnt(v: unknown): Cnt {
  if (v === undefined || v === null) return "missing";
  if (typeof v !== "number") return "bad";
  if (!Number.isSafeInteger(v) || v < 0) return "range";
  return BigInt(v);
}

const cntProj = (c: Cnt): string => (typeof c === "bigint" ? c.toString() : `~${c}`);
const isBig = (c: Cnt): c is bigint => typeof c === "bigint";

function sha(s: string): string {
  return createHash("sha256").update(s).digest("base64").slice(0, 22);
}

// ---------------------------------------------------------------------------
// record model (internal)
// ---------------------------------------------------------------------------

type BlockType = "text" | "tool_use" | "tool_result" | "thinking" | "other";
type ToolName = "Agent" | "Workflow" | "other";

interface Asst {
  key: string | null;
  msgId: string | null;
  model: string | null;
  isErr: boolean;
  hasUsage: boolean;
  i: Cnt;
  r: Cnt;
  wt: Cnt;
  w5: Cnt;
  w1: Cnt;
  hasCC: boolean;
  ccBad: boolean;
  o: Cnt;
  think: Cnt;
  iter: { i?: bigint; o?: bigint; r?: bigint; wt?: bigint } | null;
  /** Some counter of the R1.2 counter row failed R2.15 (R2.15, first sentence). */
  rangeFail: boolean;
  speed: Speed | null;
  hasSpeed: boolean;
  geo: Geo | null;
  tier: ServiceTier | null;
  stop: StopReason | null;
  diagType: DiagType | null;
  diagMissed: bigint | null;
  tools: Array<[string, ToolName]>;
  effort: Effort | null;
  perTurn: Effort | null;
  entry: Entrypoint | null;
  advisor: string | null;
  classifier: boolean;
  sidechain: boolean | null;
  /** Side fields (R2.15 last sentence) that failed the range check and were treated as absent. */
  sideRangeFailed: number;
}

interface SysData {
  boundary: boolean;
  trigger: "manual" | "auto" | "other" | null;
  pre: bigint | null;
  post: bigint | null;
}

interface CostData {
  /** Normalized model -> [input, output, cache_read, cache_write] (null = absent). */
  models: Array<[string, Array<bigint | null>]>;
}

type RecType = "assistant" | "user" | "system" | "attachment" | "cost-state" | "other";

interface Rec {
  d: string;
  type: RecType;
  /** assistant, user, system or attachment: takes part in the graph (R1.2). */
  graph: boolean;
  ver: string;
  supported: boolean;
  S: string;
  T: string;
  uuid: string | null;
  parent: string | null;
  lparent: string | null;
  ts: number | null;
  isSummary: boolean;
  files: number[];
  a?: Asst;
  sys?: SysData;
  cost?: CostData;
  /** Range failures of side fields of a system or cost record. */
  sideRangeFailed: number;
}

const chainStr = (S: string, T: string): string => `${S}\u0000${T}`;
const recChain = (r: Rec): string => chainStr(r.S, r.T);

const TOOL_NAMES = ["Agent", "Workflow"] as const;
const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;
const ENTRY_VALUES = ["claude-desktop", "cli", "sdk-cli"] as const;
const STOP_VALUES = ["tool_use", "end_turn", "stop_sequence", "refusal"] as const;
const BLOCK_VALUES = ["text", "tool_use", "tool_result", "thinking"] as const;
const DIAG_VALUES = [
  "messages_changed",
  "tools_changed",
  "system_changed",
  "model_changed",
  "previous_message_not_found",
  "unavailable",
] as const;

const KNOWN_TYPES: ReadonlySet<string> = new Set(["assistant", "user", "system", "attachment", "cost-state"]);

interface FileCtx {
  file: DiscoveredFile;
  idx: number;
  /** tool_use ids that some meta.json names (R5.3): only these are retained from tool_use blocks. */
  neededToolUse: ReadonlySet<string>;
}

interface Resolved {
  S: string;
  T: string;
}

function resolveChain(o: Obj, f: DiscoveredFile): Resolved {
  const S = str(o["sessionId"]) ?? f.sessionId ?? "";
  const agent = str(o["agentId"]) ?? f.agentId ?? null;
  return { S, T: agent ?? "main" };
}

function parseAsst(o: Obj, ctx: FileCtx): { a: Asst; proj: unknown[] } {
  const m = isObj(o["message"]) ? o["message"] : undefined;
  const u = m !== undefined && isObj(m["usage"]) ? m["usage"] : undefined;
  const modelRaw = m?.["model"];
  const isErr = o["isApiErrorMessage"] === true || modelRaw === "<synthetic>";
  let sideRangeFailed = 0;

  // content blocks
  const blocks: Array<[BlockType, string | null, ToolName | null, string | null]> = [];
  const tools: Array<[string, ToolName]> = [];
  const content = m?.["content"];
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!isObj(b)) {
        blocks.push(["other", null, null, null]);
        continue;
      }
      const bt = (pick(b["type"], BLOCK_VALUES) ?? "other") as BlockType;
      if (bt === "tool_use") {
        const id = str(b["id"]);
        const nm = (pick(b["name"], TOOL_NAMES) ?? "other") as ToolName;
        blocks.push([bt, id, nm, null]);
        if (id !== null && ctx.neededToolUse.has(id)) tools.push([id, nm]);
      } else if (bt === "tool_result") {
        blocks.push([bt, null, null, str(b["tool_use_id"])]);
      } else {
        blocks.push([bt, null, null, null]);
      }
    }
  }

  // usage
  let i: Cnt = "missing";
  let r: Cnt = "missing";
  let wt: Cnt = "missing";
  let w5: Cnt = "missing";
  let w1: Cnt = "missing";
  let o2: Cnt = "missing";
  let think: Cnt = "missing";
  let hasCC = false;
  let ccBad = false;
  let iter: Asst["iter"] = null;
  let rangeFail = false;
  let speed: Speed | null = null;
  let geo: Geo | null = null;
  let tier: ServiceTier | null = null;
  let hasSpeed = false;
  if (u !== undefined) {
    i = cnt(u["input_tokens"]);
    r = cnt(u["cache_read_input_tokens"]);
    wt = cnt(u["cache_creation_input_tokens"]);
    o2 = cnt(u["output_tokens"]);
    const cc = u["cache_creation"];
    if (isObj(cc)) {
      hasCC = true;
      w5 = cnt(cc["ephemeral_5m_input_tokens"]);
      w1 = cnt(cc["ephemeral_1h_input_tokens"]);
    } else if (cc !== undefined && cc !== null) {
      ccBad = true;
    }
    const det = u["output_tokens_details"];
    if (isObj(det)) think = cnt(det["thinking_tokens"]);
    const its = u["iterations"];
    if (Array.isArray(its) && isObj(its[0])) {
      const it0 = its[0];
      iter = {};
      const take = (name: string, slot: "i" | "o" | "r" | "wt"): void => {
        const v = it0[name];
        if (typeof v !== "number" || !Number.isInteger(v)) return; // integer members only (R1.2)
        if (!Number.isSafeInteger(v) || v < 0) rangeFail = true;
        else (iter as NonNullable<Asst["iter"]>)[slot] = BigInt(v);
      };
      take("input_tokens", "i");
      take("output_tokens", "o");
      take("cache_read_input_tokens", "r");
      take("cache_creation_input_tokens", "wt");
    }
    for (const c of [i, r, wt, w5, w1, o2, think]) if (c === "range") rangeFail = true;
    const sp = u["speed"];
    if (sp !== undefined && sp !== null) hasSpeed = true;
    speed = pick(sp, ["standard", "fast"] as const) as Speed | null;
    geo = pick(u["inference_geo"], ["not_available", "us"] as const) as Geo | null;
    tier = pick(u["service_tier"], ["standard", "priority", "batch"] as const) as ServiceTier | null;
  }

  // stop reason
  let stop: StopReason | null = null;
  if (m !== undefined && "stop_reason" in m) {
    const sr = m["stop_reason"];
    stop = sr === null ? "null" : ((pick(sr, STOP_VALUES) ?? null) as StopReason | null);
  }

  // diagnostics (R10.1)
  let diagType: DiagType | null = null;
  let diagMissed: bigint | null = null;
  const dg = m?.["diagnostics"];
  if (isObj(dg)) {
    const cmr = dg["cache_miss_reason"];
    if (cmr !== undefined && cmr !== null) {
      if (isObj(cmr)) {
        const t = cmr["type"];
        diagType =
          typeof t === "string" && (DIAG_VALUES as readonly string[]).includes(t) ? (t as DiagType) : "other";
        const mc = cnt(cmr["cache_missed_input_tokens"]);
        if (isBig(mc)) diagMissed = mc;
        else if (mc === "range") sideRangeFailed++;
      } else {
        diagType = "other";
      }
    }
  }

  const effort = pick(o["effort"], EFFORT_VALUES) as Effort | null;
  const perTurn = pick(o["perTurnEffort"], EFFORT_VALUES) as Effort | null;
  const entry = pick(o["entrypoint"], ENTRY_VALUES) as Entrypoint | null;
  const advisor = normModel(o["advisorModel"]);
  const classifier = o["serverClassifierRequest"] !== undefined && o["serverClassifierRequest"] !== null;
  const sidechain = typeof o["isSidechain"] === "boolean" ? o["isSidechain"] : null;
  const model = normModel(modelRaw);
  const key = str(o["requestId"]);
  const msgId = m !== undefined ? str(m["id"]) : null;

  const a: Asst = {
    key,
    msgId,
    model,
    isErr,
    hasUsage: u !== undefined,
    i,
    r,
    wt,
    w5,
    w1,
    hasCC,
    ccBad,
    o: o2,
    think,
    iter,
    rangeFail,
    speed,
    hasSpeed,
    geo,
    tier,
    stop,
    diagType,
    diagMissed,
    tools,
    effort,
    perTurn,
    entry,
    advisor,
    classifier,
    sidechain,
    sideRangeFailed,
  };
  const proj: unknown[] = [
    key,
    msgId,
    model,
    isErr,
    u !== undefined,
    cntProj(i),
    cntProj(r),
    cntProj(wt),
    hasCC,
    ccBad,
    cntProj(w5),
    cntProj(w1),
    cntProj(o2),
    cntProj(think),
    iter === null ? null : [iter.i?.toString(), iter.o?.toString(), iter.r?.toString(), iter.wt?.toString()],
    rangeFail,
    speed,
    hasSpeed,
    geo,
    tier,
    stop,
    diagType,
    diagMissed === null ? null : diagMissed.toString(),
    blocks,
    effort,
    perTurn,
    entry,
    advisor,
    classifier,
    sidechain,
  ];
  return { a, proj };
}

function parseSys(o: Obj): { s: SysData; side: number; proj: unknown[] } {
  const boundary = o["subtype"] === "compact_boundary";
  let trigger: SysData["trigger"] = null;
  let pre: bigint | null = null;
  let post: bigint | null = null;
  let side = 0;
  if (boundary) {
    const cm = o["compactMetadata"];
    if (isObj(cm)) {
      trigger = pick(cm["trigger"], ["manual", "auto"] as const) as SysData["trigger"];
      const p = cnt(cm["preTokens"]);
      const q = cnt(cm["postTokens"]);
      if (isBig(p)) pre = p;
      else if (p === "range") side++;
      if (isBig(q)) post = q;
      else if (q === "range") side++;
    }
  }
  return {
    s: { boundary, trigger, pre, post },
    side,
    proj: [boundary, trigger, pre === null ? null : pre.toString(), post === null ? null : post.toString()],
  };
}

const COST_SLOTS: Array<[string, string]> = [
  ["inputTokens", "input_tokens"],
  ["outputTokens", "output_tokens"],
  ["cacheReadInputTokens", "cache_read_input_tokens"],
  ["cacheCreationInputTokens", "cache_creation_input_tokens"],
];

function parseCost(o: Obj): { c: CostData; side: number; proj: unknown[] } {
  const raw = isObj(o["modelUsage"])
    ? o["modelUsage"]
    : isObj(o["costState"]) && isObj((o["costState"] as Obj)["modelUsage"])
      ? ((o["costState"] as Obj)["modelUsage"] as Obj)
      : undefined;
  const models: CostData["models"] = [];
  let side = 0;
  if (raw !== undefined) {
    for (const [name, val] of Object.entries(raw)) {
      const model = normModel(name) ?? "unlisted";
      const slots: Array<bigint | null> = [];
      for (const [camel, snake] of COST_SLOTS) {
        const c = isObj(val) ? cnt(val[camel] ?? val[snake]) : "missing";
        if (isBig(c)) slots.push(c);
        else {
          if (c === "range") side++;
          slots.push(null);
        }
      }
      models.push([model, slots]);
    }
    models.sort((x, y) => cmpStr(x[0], y[0]));
  }
  return {
    c: { models },
    side,
    proj: models.map(([m, s]) => [m, s.map((v) => (v === null ? null : v.toString()))]),
  };
}

/** Parse one JSON value into a record. Returns the record and its projection digest. */
function makeRec(v: unknown, ctx: FileCtx): Rec {
  const f = ctx.file;
  if (!isObj(v)) {
    return {
      d: sha(JSON.stringify(["nonobject", typeof v])),
      type: "other",
      graph: false,
      ver: "unlisted",
      supported: false,
      S: "",
      T: "main",
      uuid: null,
      parent: null,
      lparent: null,
      ts: null,
      isSummary: false,
      files: [],
      sideRangeFailed: 0,
    };
  }
  const tstr = typeof v["type"] === "string" ? v["type"] : "";
  const type: RecType = KNOWN_TYPES.has(tstr) ? (tstr as RecType) : "other";
  const ts = parseTs(v["timestamp"]);
  const uuid = str(v["uuid"]);
  if (type === "other") {
    // Unlisted type (R1.4): only the structural id and time are used for equality. The raw type is dropped.
    return {
      d: sha(JSON.stringify(["other", uuid, ts])),
      type,
      graph: false,
      ver: "unlisted",
      supported: false,
      S: "",
      T: "main",
      uuid: null,
      parent: null,
      lparent: null,
      ts: null,
      isSummary: false,
      files: [],
      sideRangeFailed: 0,
    };
  }
  const { S, T } = resolveChain(v, f);
  const verRaw = v["version"];
  const ver = typeof verRaw === "string" && VERSION_RE.test(verRaw) ? verRaw : "unlisted";
  const graph = type !== "cost-state";
  const supported = graph ? FULL_VERSIONS.has(ver) : true;
  const parent = str(v["parentUuid"]);
  const lparent = str(v["logicalParentUuid"]);
  const isSummary = v["isCompactSummary"] === true;
  const common: unknown[] = [type, uuid, parent, lparent, S, T, ts, ver, isSummary];
  const rec: Rec = {
    d: "",
    type,
    graph,
    ver,
    supported,
    S,
    T,
    uuid,
    parent,
    lparent,
    ts,
    isSummary,
    files: [],
    sideRangeFailed: 0,
  };
  let extra: unknown[] = [];
  if (type === "assistant") {
    const { a, proj } = parseAsst(v, ctx);
    rec.a = a;
    rec.sideRangeFailed = a.sideRangeFailed;
    extra = proj;
  } else if (type === "system") {
    const { s, side, proj } = parseSys(v);
    rec.sys = s;
    rec.sideRangeFailed = side;
    extra = proj;
  } else if (type === "cost-state") {
    const { c, side, proj } = parseCost(v);
    rec.cost = c;
    rec.sideRangeFailed = side;
    extra = proj;
  } else if (type === "user") {
    const msg = isObj(v["message"]) ? v["message"] : undefined;
    const role = pick(msg?.["role"], ["user", "assistant"] as const);
    const blocks: unknown[] = [];
    const content = msg?.["content"];
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!isObj(b)) {
          blocks.push(["other", null]);
          continue;
        }
        const bt = pick(b["type"], BLOCK_VALUES) ?? "other";
        blocks.push([bt, bt === "tool_result" ? str(b["tool_use_id"]) : null]);
      }
    }
    extra = [role, blocks];
  }
  // Fields read on every graph record (R1.2) that are not used downstream still take part in equality.
  const shared: unknown[] = graph
    ? [
        typeof v["isSidechain"] === "boolean" ? v["isSidechain"] : null,
        v["isApiErrorMessage"] === true,
        pick(v["entrypoint"], ENTRY_VALUES),
        pick(v["effort"], EFFORT_VALUES),
        pick(v["perTurnEffort"], EFFORT_VALUES),
      ]
    : [];
  rec.d = sha(JSON.stringify([common, shared, extra]));
  return rec;
}

// ---------------------------------------------------------------------------
// per-file reading
// ---------------------------------------------------------------------------

interface FileOut {
  idx: number;
  lines: number;
  parseErr: number;
  truncTail: number;
  known: number;
  unlisted: number;
  unverifiedLines: number;
  versions: Map<string, number>;
  fileVersions: Set<string>;
  supportedGraph: number;
  unreadable: boolean;
  byDigest: Map<string, { rec: Rec; n: number }>;
  /** Agent-file checks of R5.3 (2), over supported graph records. */
  sessMismatch: boolean;
  agentMismatch: boolean;
}

function newFileOut(idx: number): FileOut {
  return {
    idx,
    lines: 0,
    parseErr: 0,
    truncTail: 0,
    known: 0,
    unlisted: 0,
    unverifiedLines: 0,
    versions: new Map(),
    fileVersions: new Set(),
    supportedGraph: 0,
    unreadable: false,
    byDigest: new Map(),
    sessMismatch: false,
    agentMismatch: false,
  };
}

async function readJsonlFile(ctx: FileCtx): Promise<FileOut> {
  const out = newFileOut(ctx.idx);
  const stats = newLineStats();
  const f = ctx.file;
  const isAgentFile = f.kind === "claude-subagent" && f.workflowAgent !== true;
  for await (const line of readLines(f.path, { stats })) {
    out.lines++;
    let v: unknown;
    try {
      v = JSON.parse(line.text);
    } catch {
      // R1.3: the exception message is never stored.
      if (line.terminated) out.parseErr++;
      else out.truncTail++;
      continue;
    }
    const rec = makeRec(v, ctx);
    if (rec.type === "other") out.unlisted++;
    else out.known++;
    if (rec.graph) {
      out.versions.set(rec.ver, (out.versions.get(rec.ver) ?? 0) + 1);
      out.fileVersions.add(rec.ver);
      if (!rec.supported) out.unverifiedLines++;
      else {
        out.supportedGraph++;
        if (isAgentFile && isObj(v)) {
          if (v["sessionId"] !== f.sessionId) out.sessMismatch = true;
          if (v["agentId"] !== f.agentId) out.agentMismatch = true;
        }
      }
    }
    const e = out.byDigest.get(rec.d);
    if (e) e.n++;
    else out.byDigest.set(rec.d, { rec, n: 1 });
  }
  if (stats.error !== undefined) out.unreadable = true;
  return out;
}

async function readSmallJson(path: string): Promise<{ state: "ok"; value: unknown } | { state: "unreadable" } | { state: "parse_error" }> {
  let text: string;
  try {
    const st = await fsp.stat(path);
    if (st.size > MAX_SIDECAR_BYTES) return { state: "unreadable" };
    text = await fsp.readFile(path, "utf8");
  } catch {
    return { state: "unreadable" };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return { state: "ok", value: JSON.parse(text) };
  } catch {
    return { state: "parse_error" };
  }
}

// ---------------------------------------------------------------------------
// sidecars
// ---------------------------------------------------------------------------

interface MetaInfo {
  toolUseId: string | null;
  parentAgentId: string | null;
  depth: "absent" | "invalid" | number;
}

interface PrefixInfo {
  model: string | null;
  is1h: boolean | null;
  build: string | null;
  toolsHash: boolean;
}

function parseMeta(v: unknown): MetaInfo {
  const o = isObj(v) ? v : {};
  const d = o["spawnDepth"];
  let depth: MetaInfo["depth"] = "absent";
  if (d !== undefined && d !== null) depth = typeof d === "number" && Number.isSafeInteger(d) && d >= 0 ? d : "invalid";
  return { toolUseId: str(o["toolUseId"]), parentAgentId: str(o["parentAgentId"]), depth };
}

function parsePrefix(v: unknown): PrefixInfo {
  const o = isObj(v) ? v : {};
  const st = isObj(o["state"]) ? o["state"] : {};
  const b = st["buildVersion"];
  return {
    model: normModel(st["model"]),
    is1h: typeof st["is1hCacheTTL"] === "boolean" ? st["is1hCacheTTL"] : null,
    build: typeof b === "string" ? (BUILD_VERSION_RE.test(b) ? b : "unlisted") : null,
    toolsHash: st["toolsHash"] !== undefined && st["toolsHash"] !== null,
  };
}

// ---------------------------------------------------------------------------
// copy selection (R4.2, R4.3)
// ---------------------------------------------------------------------------

/** R4.3 total order for choosing among copies: (has_speed desc, output desc, timestamp asc, uuid asc, digest). */
function copyOrder(x: Rec, y: Rec): number {
  const ax = x.a as Asst;
  const ay = y.a as Asst;
  if (ax.hasSpeed !== ay.hasSpeed) return ax.hasSpeed ? -1 : 1;
  const ox = isBig(ax.o) ? ax.o : -1n;
  const oy = isBig(ay.o) ? ay.o : -1n;
  if (ox !== oy) return ox > oy ? -1 : 1;
  return cmpNum(x.ts, y.ts) || cmpNullStr(x.uuid, y.uuid) || cmpStr(x.d, y.d);
}

/** Natural "earliest copy" order: timestamp asc, uuid asc, digest. */
function earliestOrder(x: Rec, y: Rec): number {
  return cmpNum(x.ts, y.ts) || cmpNullStr(x.uuid, y.uuid) || cmpStr(x.d, y.d);
}

interface Shared {
  exclusion: ExclusionReason | null;
  usage: UsageBuckets | null;
  modifiers: Modifiers;
  flags: Set<ResponseFlag>;
  model: ModelAttribution;
  stop: StopReason | null;
  diag: Diagnostics | null;
  effort: Effort | null;
  perTurn: Effort | null;
  entry: Entrypoint | null;
  advisor: string | null;
  sidechain: boolean;
  msgId: string | null;
  hasFinal: boolean;
  conflicts: Array<{ kind: ConflictKind; effect: DedupConflict["effect"] }>;
  incompleteTokens: bigint;
  rangeFailed: boolean;
}

function firstNonNull<T>(copies: readonly Rec[], f: (a: Asst) => T | null): T | null {
  for (const c of copies) {
    const v = f(c.a as Asst);
    if (v !== null) return v;
  }
  return null;
}

function analyzeKey(allCopies: readonly Rec[], keyConflict: boolean): Shared {
  const ordered = [...allCopies].sort(copyOrder);
  const usageCopies = ordered.filter((c) => (c.a as Asst).hasUsage);
  const flags = new Set<ResponseFlag>();
  const conflicts: Shared["conflicts"] = [];
  const sh: Shared = {
    exclusion: null,
    usage: null,
    modifiers: { speed: null, inference_geo: null, service_tier: null },
    flags,
    model: { candidate: null, verified: false, source: "none", model: null },
    stop: null,
    diag: null,
    effort: firstNonNull(ordered, (a) => a.effort),
    perTurn: firstNonNull(ordered, (a) => a.perTurn),
    entry: firstNonNull(ordered, (a) => a.entry),
    advisor: firstNonNull(ordered, (a) => a.advisor),
    sidechain: ordered.some((c) => (c.a as Asst).sidechain === true),
    msgId: firstNonNull(ordered, (a) => a.msgId),
    hasFinal: usageCopies.some((c) => (c.a as Asst).hasSpeed),
    conflicts,
    incompleteTokens: 0n,
    rangeFailed: false,
  };
  if (ordered.some((c) => (c.a as Asst).classifier)) flags.add("classifier_attached");

  // model (R4.2: any copy, must be equal)
  const models = new Set<string>();
  for (const c of ordered) {
    const m = (c.a as Asst).model;
    if (m !== null) models.add(m);
  }
  let modelConflict = false;
  if (models.size === 1) {
    const m = [...models][0] as string;
    sh.model = { candidate: m, verified: true, source: "claude_explicit", model: m };
  } else if (models.size > 1) {
    modelConflict = true;
  }

  // exclusion ladder
  if (keyConflict) {
    sh.exclusion = "key_conflict";
    conflicts.push({ kind: "key_conflict", effect: "excluded" });
    return sh;
  }
  if (usageCopies.some((c) => (c.a as Asst).rangeFail)) {
    sh.exclusion = "usage_range_failed";
    sh.rangeFailed = true;
    return sh;
  }
  const incomplete = (c: Rec): boolean => {
    const a = c.a as Asst;
    if (c.ts === null || a.ccBad) return true;
    if (!isBig(a.i) || !isBig(a.r) || !isBig(a.wt)) return true;
    if (a.hasCC && (!isBig(a.w5) || !isBig(a.w1))) return true;
    return false;
  };
  if (usageCopies.length === 0 || usageCopies.some(incomplete)) {
    sh.exclusion = "usage_incomplete";
    // R2.12: present integer fields that pass R2.15 are reported in coverage.
    const p = usageCopies[0];
    if (p) {
      const a = p.a as Asst;
      let sum = 0n;
      if (isBig(a.i)) sum += a.i;
      if (isBig(a.r)) sum += a.r;
      if (a.hasCC) {
        if (isBig(a.w5)) sum += a.w5;
        if (isBig(a.w1)) sum += a.w1;
      } else if (isBig(a.wt)) sum += a.wt;
      if (isBig(a.o)) sum += a.o;
      sh.incompleteTokens = sum;
    }
    return sh;
  }
  // input counters of all copies must be equal (R4.2)
  const sig = (c: Rec): string => {
    const a = c.a as Asst;
    return [cntProj(a.i), cntProj(a.r), cntProj(a.wt), a.hasCC ? "cc" : "-", a.hasCC ? cntProj(a.w5) : "", a.hasCC ? cntProj(a.w1) : ""].join(",");
  };
  const sigs = new Set(usageCopies.map(sig));
  const inputConflict = sigs.size > 1;
  if (inputConflict) conflicts.push({ kind: "conflict_input", effect: "excluded" });
  if (modelConflict) conflicts.push({ kind: "conflict_model", effect: "excluded" });
  if (inputConflict || modelConflict) {
    sh.exclusion = inputConflict ? "conflict_input" : "conflict_model";
    return sh;
  }

  const p = usageCopies[0] as Rec;
  const pa = p.a as Asst;
  const i = pa.i as bigint;
  const r = pa.r as bigint;
  const wt = pa.wt as bigint;
  const w5 = pa.hasCC ? (pa.w5 as bigint) : 0n;
  const w1 = pa.hasCC ? (pa.w1 as bigint) : 0n;
  if (pa.hasCC) {
    if (wt !== w5 + w1) flags.add("bucket_mismatch"); // R2.1
  } else {
    flags.add("w_unknown_ttl");
  }

  // final copies (R2.3, R4.2)
  const finals = usageCopies.filter((c) => (c.a as Asst).hasSpeed);
  let output: bigint | null = null;
  let maxO = 0n;
  for (const c of usageCopies) {
    const o = (c.a as Asst).o;
    if (isBig(o) && o > maxO) maxO = o;
  }
  if (finals.length === 0) {
    flags.add("output_unknown");
  } else {
    const fo = finals.map((c) => (c.a as Asst).o);
    if (fo.some((x) => !isBig(x))) {
      flags.add("output_unknown");
    } else {
      const vals = new Set(fo.map((x) => (x as bigint).toString()));
      if (vals.size > 1) {
        flags.add("output_unknown");
        flags.add("conflict_output");
        conflicts.push({ kind: "conflict_output", effect: "output_unknown" });
      } else {
        output = fo[0] as bigint;
      }
    }
  }
  // iterations[0] must equal the top-level counters on shared keys (final copy)
  const pf = finals[0];
  if (pf) {
    const a = pf.a as Asst;
    const it = a.iter;
    if (it) {
      const bad =
        (it.i !== undefined && isBig(a.i) && it.i !== a.i) ||
        (it.o !== undefined && isBig(a.o) && it.o !== a.o) ||
        (it.r !== undefined && isBig(a.r) && it.r !== a.r) ||
        (it.wt !== undefined && isBig(a.wt) && it.wt !== a.wt);
      if (bad) {
        output = null;
        flags.add("output_unknown");
        flags.add("conflict_iterations");
        conflicts.push({ kind: "conflict_iterations", effect: "output_unknown" });
      }
    }
    sh.stop = a.stop;
  }

  // modifiers (R4.2, R3.4)
  let speed: Speed | null = null;
  let geo: Geo | null = null;
  let tier: ServiceTier | null = null;
  let modConflict = false;
  const sp = new Set(finals.map((c) => (c.a as Asst).speed ?? "other"));
  if (finals.length === 0) {
    flags.add("speed_assumed");
  } else if (sp.size === 1) {
    speed = [...sp][0] as Speed;
  } else {
    modConflict = true;
  }
  const gs = new Set<Geo>();
  const ts = new Set<ServiceTier>();
  for (const c of usageCopies) {
    const a = c.a as Asst;
    if (a.geo !== null) gs.add(a.geo);
    if (a.tier !== null) ts.add(a.tier);
  }
  if (gs.size === 1) geo = [...gs][0] as Geo;
  else if (gs.size > 1) modConflict = true;
  if (ts.size === 1) tier = [...ts][0] as ServiceTier;
  else if (ts.size > 1) modConflict = true;
  if (modConflict) {
    flags.add("conflict_modifier");
    conflicts.push({ kind: "conflict_modifier", effect: "unpriced_modifier" });
  }
  sh.modifiers = { speed, inference_geo: geo, service_tier: tier };

  // diagnostics (R4.2: union of non-null cache_miss_reason; two different types give no evidence)
  const dtypes = new Set<DiagType>();
  for (const c of ordered) {
    const t = (c.a as Asst).diagType;
    if (t !== null) dtypes.add(t);
  }
  if (dtypes.size > 1) {
    flags.add("conflict_diagnostics");
    conflicts.push({ kind: "conflict_diagnostics", effect: "no_diagnostics_evidence" });
  } else if (dtypes.size === 1) {
    const t = [...dtypes][0] as DiagType;
    const mv = new Set<string>();
    for (const c of ordered) {
      const a = c.a as Asst;
      if (a.diagType === t && a.diagMissed !== null) mv.add(a.diagMissed.toString());
    }
    // R10.7: kept only when every copy that reports an estimate agrees.
    const missed = mv.size === 1 ? BigInt([...mv][0] as string) : null;
    sh.diag = { type: t, missed_tokens_reported: missed };
  }

  const think = pf ? (pf.a as Asst).think : "missing";
  sh.usage = {
    input_uncached: i,
    cache_read: r,
    cache_write_5m: w5,
    cache_write_1h: w1,
    cache_write_unknown_ttl: pa.hasCC ? 0n : wt,
    cache_write: 0n,
    output,
    output_lower_bound: output !== null ? output : maxO,
    reasoning: isBig(think) ? think : null,
    reasoning_included_in_output: false,
  };
  if (sh.model.verified === false) {
    // No model on any copy: the model is not verified (R2.10 applies to Claude too, tokens kept, no dollars).
    sh.model = { candidate: null, verified: false, source: "none", model: null };
  }
  return sh;
}

// ---------------------------------------------------------------------------
// main entry
// ---------------------------------------------------------------------------

interface ChainAgg {
  S: string;
  T: string;
  start: number | null;
  files: Set<number>;
  workflowFile: boolean;
}

const FLAG_ORDER: ReadonlyMap<ResponseFlag, number> = new Map(RESPONSE_FLAGS.map((f, i) => [f, i]));

export const parseClaude: ParseClaude = async (inputFiles: readonly DiscoveredFile[], opts: ParseOptions = {}): Promise<ClaudeParseResult> => {
  const cov: CoverageCounters = emptyCoverage();
  const assumptions = new Set<Assumption>();

  // ----- canonical file order (R4.3, R4.10): independent of the order the caller passed ---------------------
  const seenPaths = new Set<string>();
  const files: DiscoveredFile[] = [];
  for (const f of inputFiles) {
    if (f.agent !== "claude" || !f.kind.startsWith("claude-")) continue;
    if (seenPaths.has(f.path)) continue;
    seenPaths.add(f.path);
    files.push(f);
  }
  files.sort((a, b) => cmpStr(a.kind, b.kind) || cmpStr(a.relPath, b.relPath) || cmpStr(a.path, b.path));
  cov.files_total = files.length;

  const fileUnreadable: boolean[] = files.map(() => false);
  const fileLines: number[] = files.map(() => 0);
  const prefilterCut =
    opts.fastPrefilter === true && opts.window ? opts.window.since_ms - CONSTANTS.FAST_PREFILTER_DAYS * DAY_MS : null;
  if (prefilterCut !== null) assumptions.add("mtime_prefilter_on");

  // ----- phase 1: sidecars (meta, prefix, workflow run, workflow journal) ----------------------------------
  const metas = new Map<string, MetaInfo>(); // S\0agent
  const prefixes: Array<{ S: string; A: string; p: PrefixInfo }> = [];
  const runIds = new Map<string, string | null>(); // S\0run -> runId inside json
  const journalStarted = new Map<string, Set<string>>(); // S\0run -> started agent ids
  const journalSeen = new Set<string>();
  const sidecarIdx: number[] = [];
  files.forEach((f, i) => {
    if (f.kind === "claude-subagent-meta" || f.kind === "claude-subagent-prefix" || f.kind === "claude-workflow-run") sidecarIdx.push(i);
  });
  const sideRes = await mapWithLimit(sidecarIdx, READ_CONCURRENCY, async (i) => readSmallJson((files[i] as DiscoveredFile).path));
  const journalFiles = files.map((f, i) => ({ f, i })).filter((x) => x.f.kind === "claude-workflow-journal");
  const neededToolUse = new Set<string>();
  sideRes.forEach((res, n) => {
    const i = sidecarIdx[n] as number;
    const f = files[i] as DiscoveredFile;
    cov.lines_total += 1;
    fileLines[i] = 1;
    const val = res.ok ? res.value : undefined;
    if (val === undefined || val.state === "unreadable") {
      fileUnreadable[i] = true;
      cov.files_unreadable += 1;
      return;
    }
    if (val.state === "parse_error") {
      cov.lines_parse_error += 1;
      return;
    }
    const sess = f.sessionId ?? "";
    const v = val.value;
    if (f.kind === "claude-subagent-meta") {
      const k = chainStr(sess, f.agentId ?? "");
      if (!metas.has(k)) {
        const m = parseMeta(v);
        metas.set(k, m);
        if (m.toolUseId !== null) neededToolUse.add(m.toolUseId);
      }
    } else if (f.kind === "claude-subagent-prefix") {
      prefixes.push({ S: sess, A: f.agentId ?? "", p: parsePrefix(v) });
    } else {
      const k = chainStr(sess, f.runId ?? "");
      if (!runIds.has(k)) runIds.set(k, isObj(v) ? str(v["runId"]) : null);
    }
  });
  // journals are JSONL (R1.2: `type` and `agentId` only)
  const journalRes = await mapWithLimit(journalFiles, READ_CONCURRENCY, async ({ f, i }) => {
    const seenLines = new Map<string, number>();
    let lines = 0;
    let perr = 0;
    let tail = 0;
    const started: string[] = [];
    const stats = newLineStats();
    for await (const line of readLines(f.path, { stats })) {
      lines++;
      let v: unknown;
      try {
        v = JSON.parse(line.text);
      } catch {
        if (line.terminated) perr++;
        else tail++;
        continue;
      }
      const type = isObj(v) && v["type"] === "started" ? "started" : "other";
      const agent = isObj(v) ? str(v["agentId"]) : null;
      const d = sha(JSON.stringify([type, agent]));
      seenLines.set(d, (seenLines.get(d) ?? 0) + 1);
      if (type === "started" && agent !== null) started.push(agent);
    }
    return { i, f, lines, perr, tail, started, dupLines: [...seenLines.values()], unreadable: stats.error !== undefined };
  });
  for (const res of journalRes) {
    if (!res.ok || !res.value) {
      continue;
    }
    const j = res.value;
    cov.lines_total += j.lines;
    cov.lines_parse_error += j.perr;
    cov.lines_truncated_tail += j.tail;
    fileLines[j.i] = j.lines;
    for (const n of j.dupLines) {
      if (n >= 2) {
        cov.lines_duplicate_collapsed += n - 1;
        cov.duplicate_records_collapsed += 1;
      }
    }
    if (j.unreadable) {
      fileUnreadable[j.i] = true;
      cov.files_unreadable += 1;
    }
    const k = chainStr(j.f.sessionId ?? "", j.f.runId ?? "");
    journalSeen.add(k);
    let set = journalStarted.get(k);
    if (!set) journalStarted.set(k, (set = new Set()));
    for (const a of j.started) set.add(a);
  }
  // journal read failures that threw
  journalRes.forEach((res, n) => {
    if (!res.ok) {
      const entry = journalFiles[n] as { f: DiscoveredFile; i: number };
      fileUnreadable[entry.i] = true;
      cov.files_unreadable += 1;
    }
  });

  // ----- phase 2: JSONL files --------------------------------------------------------------------------------
  const jsonlIdx: number[] = [];
  files.forEach((f, i) => {
    if (f.kind === "claude-main" || f.kind === "claude-subagent") {
      if (prefilterCut !== null && f.mtimeMs < prefilterCut) return; // R5.9 --fast: not read
      jsonlIdx.push(i);
    }
  });
  const fileRes = await mapWithLimit(jsonlIdx, READ_CONCURRENCY, async (i) =>
    readJsonlFile({ file: files[i] as DiscoveredFile, idx: i, neededToolUse }),
  );
  const outs: FileOut[] = [];
  fileRes.forEach((res, n) => {
    const i = jsonlIdx[n] as number;
    if (res.ok && res.value) {
      outs.push(res.value);
    } else {
      fileUnreadable[i] = true;
      cov.files_unreadable += 1;
    }
  });
  outs.sort((a, b) => a.idx - b.idx);

  // ----- phase 3: global collapse of equal records (R4.12 equality, R17.6 definitions) -------------------------
  interface G {
    rec: Rec;
    files: Set<number>;
    lines: number;
  }
  const global = new Map<string, G>();
  const fileVersions: Array<Set<string>> = files.map(() => new Set<string>());
  const fileSupportedGraph: number[] = files.map(() => 0);
  const outByIdx = new Map<number, FileOut>();
  for (const out of outs) {
    outByIdx.set(out.idx, out);
    fileLines[out.idx] = out.lines;
    cov.lines_total += out.lines;
    cov.lines_parse_error += out.parseErr;
    cov.lines_truncated_tail += out.truncTail;
    cov.known_type_count += out.known;
    cov.unlisted_type_count += out.unlisted;
    cov.lines_unverified_version += out.unverifiedLines;
    for (const [v, n] of out.versions) cov.versions[v] = (cov.versions[v] ?? 0) + n;
    fileVersions[out.idx] = out.fileVersions;
    fileSupportedGraph[out.idx] = out.supportedGraph;
    if (out.unreadable) {
      fileUnreadable[out.idx] = true;
      cov.files_unreadable += 1;
    }
    for (const [d, e] of out.byDigest) {
      const g = global.get(d);
      if (g) {
        g.files.add(out.idx);
        g.lines += e.n;
      } else {
        global.set(d, { rec: e.rec, files: new Set([out.idx]), lines: e.n });
      }
    }
  }
  const recs: Rec[] = [];
  for (const g of global.values()) {
    if (g.lines >= 2) {
      cov.lines_duplicate_collapsed += g.lines - 1;
      cov.duplicate_records_collapsed += 1;
    }
    g.rec.files = [...g.files].sort((a, b) => a - b);
    recs.push(g.rec);
  }
  recs.sort((a, b) => cmpStr(a.d, b.d));
  const unverifiedVersionsSeen = recs.some((r) => r.graph && !r.supported);
  if (unverifiedVersionsSeen) assumptions.add("unverified_version");

  // ----- phase 4: chains / streams ---------------------------------------------------------------------------
  const chains = new Map<string, ChainAgg>();
  const supportedGraph = recs.filter((r) => r.graph && r.supported);
  for (const r of supportedGraph) {
    const k = recChain(r);
    let c = chains.get(k);
    if (!c) chains.set(k, (c = { S: r.S, T: r.T, start: null, files: new Set(), workflowFile: false }));
    if (r.ts !== null && (c.start === null || r.ts < c.start)) c.start = r.ts;
    for (const fi of r.files) {
      c.files.add(fi);
      if ((files[fi] as DiscoveredFile).workflowAgent === true) c.workflowFile = true;
    }
  }

  const pickOwner = (cs: readonly string[]): { owner: string; ambiguous: boolean; start: number | null } => {
    let best: string[] = [];
    let bestStart = Number.POSITIVE_INFINITY;
    for (const c of cs) {
      const s = (chains.get(c) as ChainAgg).start ?? Number.POSITIVE_INFINITY;
      if (s < bestStart) {
        best = [c];
        bestStart = s;
      } else if (s === bestStart) best.push(c);
    }
    if (best.length === 1) {
      return { owner: best[0] as string, ambiguous: false, start: bestStart === Number.POSITIVE_INFINITY ? null : bestStart };
    }
    best.sort((x, y) => {
      const a = chains.get(x) as ChainAgg;
      const b = chains.get(y) as ChainAgg;
      return cmpStr(a.S, b.S) || cmpStr(a.T, b.T);
    });
    return { owner: best[0] as string, ambiguous: true, start: bestStart === Number.POSITIVE_INFINITY ? null : bestStart };
  };

  // ----- uuid index and compact boundaries (R6.3, R11.7) --------------------------------------------------------
  const byUuid = new Map<string, Rec[]>();
  for (const r of supportedGraph) {
    if (r.uuid === null) continue;
    let l = byUuid.get(r.uuid);
    if (!l) byUuid.set(r.uuid, (l = []));
    l.push(r);
  }
  const uuidIndex = new Map<string, ClaudeUuidNode>();
  const compactBoundaries: ClaudeCompactBoundary[] = [];
  const chainKeyOf = (S: string, T: string): ChainKey => ({ provider: "claude", root_session: S, thread: T });
  const uuidKeys = [...byUuid.keys()].sort(cmpStr);
  for (const u of uuidKeys) {
    const cands = (byUuid.get(u) as Rec[]).slice().sort((x, y) => cmpNum(x.ts, y.ts) || cmpNullStr(x.parent, y.parent) || cmpStr(x.d, y.d));
    const first = cands[0] as Rec;
    const owner = pickOwner([...new Set(cands.map(recChain))].sort(cmpStr));
    const oc = chains.get(owner.owner) as ChainAgg;
    const isBoundary = cands.some((c) => c.sys?.boundary === true);
    uuidIndex.set(u, {
      uuid: u,
      parent_uuid: first.parent,
      logical_parent_uuid: first.lparent,
      ts_ms: first.ts,
      is_compact_summary: first.isSummary,
      is_compact_boundary: isBoundary,
      chain: chainKeyOf(oc.S, oc.T),
    });
    if (isBoundary) {
      const b = (cands.find((c) => c.sys?.boundary === true) as Rec).sys as SysData;
      compactBoundaries.push({
        chain: chainKeyOf(oc.S, oc.T),
        uuid: u,
        logical_parent_uuid: first.lparent,
        trigger: b.trigger,
        pre_tokens: b.pre,
        post_tokens: b.post,
        ts_ms: first.ts,
      });
    }
  }

  // ----- phase 5: requests --------------------------------------------------------------------------------------
  const byKey = new Map<string, Rec[]>();
  const unverifiedKeys = new Map<string, Map<string, number | null>>(); // key -> chain -> min ts
  const excluded: ExcludedRecord[] = [];
  const reqToMsg = new Map<string, Set<string>>();
  const msgToReq = new Map<string, Set<string>>();
  for (const r of recs) {
    if (r.type === "cost-state") {
      cov.fields_range_failed += r.sideRangeFailed;
      continue;
    }
    if (r.type !== "assistant") {
      if (r.supported) cov.fields_range_failed += r.sideRangeFailed;
      continue;
    }
    const a = r.a as Asst;
    if (!r.supported) {
      // R15.7: counted, never accounted.
      if (!a.isErr && a.key !== null) {
        let m = unverifiedKeys.get(a.key);
        if (!m) unverifiedKeys.set(a.key, (m = new Map()));
        const ck = recChain(r);
        const prev = m.get(ck);
        m.set(ck, prev === undefined ? r.ts : prev === null ? r.ts : r.ts === null ? prev : Math.min(prev, r.ts));
      }
      continue;
    }
    cov.fields_range_failed += r.sideRangeFailed;
    if (a.isErr) {
      cov.api_error_records += 1; // R2.14
      if (r.ts !== null && chains.has(recChain(r))) {
        excluded.push({ provider: "claude", chain: chainKeyOf(r.S, r.T), reason: "api_error", event_ms: r.ts, ordinal: null, files: r.files });
      }
      continue;
    }
    if (a.hasUsage) {
      cov.records_usage_bearing += 1;
      const gone = (c: Cnt): boolean => c === "missing" || c === "bad";
      const unmappable =
        r.ts === null || a.ccBad || gone(a.i) || gone(a.r) || gone(a.wt) || (a.hasCC && (gone(a.w5) || gone(a.w1)));
      if (unmappable) cov.records_usage_unmappable += 1;
    }
    if (a.key === null) {
      if (a.hasUsage) {
        cov.records_unkeyed += 1; // R2.13
        if (r.ts !== null) {
          excluded.push({ provider: "claude", chain: chainKeyOf(r.S, r.T), reason: "unkeyed", event_ms: r.ts, ordinal: null, files: r.files });
        }
      }
      continue;
    }
    let l = byKey.get(a.key);
    if (!l) byKey.set(a.key, (l = []));
    l.push(r);
    if (a.msgId !== null) {
      let s = reqToMsg.get(a.key);
      if (!s) reqToMsg.set(a.key, (s = new Set()));
      s.add(a.msgId);
      let t = msgToReq.get(a.msgId);
      if (!t) msgToReq.set(a.msgId, (t = new Set()));
      t.add(a.key);
    }
  }
  // R4.1: a requestId with two message ids, or a message id with two requestIds
  const conflictedKeys = new Set<string>();
  for (const [req, msgs] of reqToMsg) if (msgs.size > 1) conflictedKeys.add(req);
  for (const reqs of msgToReq.values()) if (reqs.size > 1) for (const q of reqs) conflictedKeys.add(q);

  const responses: ClaudeResponse[] = [];
  const conflicts: DedupConflict[] = [];
  const keyList = [...byKey.keys()].sort(cmpStr);
  const sinceMs = opts.window ? opts.window.since_ms : null;
  let anyStartLo = false;

  for (const key of keyList) {
    const copies = byKey.get(key) as Rec[];
    const sh = analyzeKey(copies, conflictedKeys.has(key));
    cov.responses_total += 1;
    cov.requests_total += 1;
    if (unverifiedKeys.has(key)) cov.requests_unverified_version += 1;
    if (sh.hasFinal) cov.requests_with_final_marker += 1;

    // ownership (R4.6)
    const chainSet = [...new Set(copies.map(recChain))].sort(cmpStr);
    const own = pickOwner(chainSet);
    const allFiles = [...new Set(copies.flatMap((c) => c.files))].sort((a, b) => a - b);
    if (chainSet.length > 1) {
      cov.replay_requests_excluded += chainSet.length - 1;
      if (own.ambiguous) cov.replay_ownership_ambiguous += 1;
    }
    for (const c of sh.conflicts) {
      conflicts.push({ provider: "claude", kind: c.kind, key, files: allFiles, effect: c.effect });
      cov.requests_conflict += 1;
      cov.requests_conflict_by_kind[c.kind] += 1;
      if (c.kind === "conflict_modifier") cov.requests_conflict_modifier += 1;
    }
    if (sh.exclusion === "usage_range_failed") cov.responses_usage_range_failed += 1;
    if (sh.exclusion === "usage_incomplete") cov.tokens_in_incomplete_responses += sh.incompleteTokens;
    if (sh.flags.has("bucket_mismatch")) cov.responses_bucket_mismatch += 1;
    if (sh.flags.has("speed_assumed")) cov.responses_speed_assumed += 1;
    if (sh.usage && sh.usage.output === null) cov.output_unknown_requests += 1;
    if (sh.exclusion === null && !sh.model.verified) cov.responses_model_unverified += 1;

    for (const cs of chainSet) {
      const agg = chains.get(cs) as ChainAgg;
      const mine = copies.filter((c) => recChain(c) === cs).sort(earliestOrder);
      const earliest = mine[0] as Rec;
      const tsList = mine.map((c) => c.ts).filter((t): t is number => t !== null);
      const tFirst = tsList.length > 0 ? Math.min(...tsList) : 0;
      const tLast = tsList.length > 0 ? Math.max(...tsList) : 0;
      const parentNode = earliest.parent !== null ? uuidIndex.get(earliest.parent) : undefined;
      const tAsm = parentNode?.ts_ms ?? null;
      const startLo = tAsm !== null && tAsm <= tFirst ? tAsm : null;
      if (startLo !== null) anyStartLo = true;
      const flags = new Set<ResponseFlag>(sh.flags);
      if (own.ambiguous) flags.add("ownership_ambiguous");
      let kind: RequestKind = "main";
      if (agg.T !== "main") kind = agg.workflowFile ? "workflow_agent" : "subagent";
      const role = cs === own.owner ? "owner" : "replayed";
      if (role === "owner" && sinceMs !== null && sh.exclusion === null && tFirst < sinceMs) cov.baseline_requests_loaded += 1;
      const r: ClaudeResponse = {
        provider: "claude",
        key,
        chain: chainKeyOf(agg.S, agg.T),
        kind,
        version: earliest.ver,
        support: "full",
        model: sh.model,
        usage: sh.usage,
        exclusion: sh.exclusion,
        flags: [...flags].sort((x, y) => (FLAG_ORDER.get(x) as number) - (FLAG_ORDER.get(y) as number)),
        modifiers: sh.modifiers,
        effort: sh.effort,
        time: {
          event_ms: tFirst,
          t_first_ms: tFirst,
          t_last_ms: tLast,
          t_asm_ms: tAsm,
          start_lo_ms: startLo,
          start_hi_ms: tFirst,
          gap_basis: startLo !== null ? "parent_record" : "none",
        },
        ordinal: null,
        ownership: { role, ambiguous: own.ambiguous, owner_stream_start_ms: own.start },
        provenance: { files: [...new Set(mine.flatMap((c) => c.files))].sort((a, b) => a - b), from_copy_exposed_file: false },
        message_id: sh.msgId,
        uuid: earliest.uuid,
        parent_uuid: earliest.parent,
        is_sidechain: sh.sidechain,
        entrypoint: sh.entry,
        per_turn_effort: sh.perTurn,
        advisor_model: sh.advisor,
        stop_reason: sh.stop,
        diag: sh.diag,
        copies: mine.length,
      };
      responses.push(r);
    }
  }
  // keys seen only in unverified versions (R15.7)
  for (const [key, m] of [...unverifiedKeys.entries()].sort((x, y) => cmpStr(x[0], y[0]))) {
    if (byKey.has(key)) continue;
    cov.requests_total += 1;
    cov.requests_unverified_version += 1;
    for (const [ck, ts] of [...m.entries()].sort((x, y) => cmpStr(x[0], y[0]))) {
      const agg = chains.get(ck);
      if (!agg || ts === null) continue; // a chain without a supported record has no stream to sit in
      excluded.push({ provider: "claude", chain: chainKeyOf(agg.S, agg.T), reason: "unverified_version", event_ms: ts, ordinal: null, files: [] });
    }
  }

  // ----- phase 6: links (R5.3, R5.4) -----------------------------------------------------------------------------
  // tool_use index: S\0id -> list of (thread, name)
  const toolIndex = new Map<string, Array<{ T: string; name: ToolName }>>();
  for (const r of supportedGraph) {
    if (!r.a || r.a.isErr) continue;
    for (const [id, name] of r.a.tools) {
      const k = chainStr(r.S, id);
      let l = toolIndex.get(k);
      if (!l) toolIndex.set(k, (l = []));
      l.push({ T: r.T, name });
    }
  }
  const links: Link[] = [];
  const chainKeysSorted = [...chains.keys()].sort(cmpStr);
  for (const ck of chainKeysSorted) {
    const agg = chains.get(ck) as ChainAgg;
    if (agg.T === "main") continue;
    const chain = chainKeyOf(agg.S, agg.T);
    // The agent file(s) that contributed records to this chain, in canonical order. Linkage is judged on them
    // because the directory (path) is the only place where meta.json, journal and run files live.
    const contributing = [...agg.files].sort((x, y) => x - y);
    const wfFiles = contributing.filter((fi) => (files[fi] as DiscoveredFile).workflowAgent === true);
    const agentFiles = contributing.filter((fi) => {
      const f = files[fi] as DiscoveredFile;
      return f.kind === "claude-subagent" && f.workflowAgent !== true;
    });
    let link: Link;
    if (wfFiles.length > 0) {
      // R5.4: never verified. `directory` iff the journal has a `started` entry for the agent and the run file agrees.
      const wf = files[wfFiles[0] as number] as DiscoveredFile;
      const runId = wf.runId ?? "";
      const rk = chainStr(wf.sessionId ?? "", runId);
      let state: Link["state"] = "directory";
      let reason: UnlinkedReason | null = null;
      if (!journalStarted.get(rk)?.has(agg.T)) {
        state = "unlinked";
        reason = "no_journal_entry";
      } else if (!runIds.has(rk)) {
        state = "unlinked";
        reason = "no_run_file";
      } else if (runIds.get(rk) !== runId && runIds.get(rk) !== `wf_${runId}`) {
        // Real run files carry the whole directory name (`wf_<id>`); the synthetic fixtures carry `<id>`. Both match.
        state = "unlinked";
        reason = "run_id_mismatch";
      }
      link = { chain, kind: "workflow_agent", state, reason, parent: null, depth: null, is_fork: false };
    } else {
      let reason: UnlinkedReason | null = null;
      let parent: ChainKey | null = null;
      let depth: number | null = null;
      const af = agentFiles.length > 0 ? (files[agentFiles[0] as number] as DiscoveredFile) : null;
      const meta = af ? metas.get(chainStr(af.sessionId ?? "", af.agentId ?? "")) : undefined;
      if (meta && typeof meta.depth === "number") depth = meta.depth;
      if (af === null) reason = "agent_mismatch"; // records name an agent id, but no agent file holds them
      else if (!meta) reason = "no_meta";
      else if (meta.toolUseId === null) reason = "no_tool_use_id";
      else if (agentFiles.some((fi) => outByIdx.get(fi)?.sessMismatch === true)) reason = "session_mismatch";
      else if (agentFiles.some((fi) => outByIdx.get(fi)?.agentMismatch === true)) reason = "agent_mismatch";
      else {
        // R5.3 (3): parent selection
        let parentThread: string | null = null;
        if (meta.depth === "absent" || meta.depth === 1) parentThread = "main";
        else if (meta.depth === 2) parentThread = meta.parentAgentId;
        if (parentThread === null || !chains.has(chainStr(agg.S, parentThread))) reason = "parent_file_missing";
        else {
          // R5.3 (4), (5)
          const hits = toolIndex.get(chainStr(agg.S, meta.toolUseId)) ?? [];
          const inParent = hits.filter((h) => h.T === parentThread);
          if (inParent.length === 0) reason = hits.length > 0 && meta.depth === 2 ? "parent_agent_mismatch" : "tool_use_not_found";
          else if (!inParent.some((h) => h.name === "Agent")) reason = "tool_name_unexpected";
          else parent = chainKeyOf(agg.S, parentThread);
        }
      }
      link = { chain, kind: "subagent", state: reason === null ? "verified" : "unlinked", reason, parent, depth, is_fork: false };
    }
    links.push(link);
    if (link.state === "verified") cov.links_verified += 1;
    else if (link.state === "directory") cov.links_directory_only += 1;
    else {
      cov.links_unlinked += 1;
      if (link.reason !== null) cov.links_unlinked_by_reason[link.reason] += 1;
    }
  }

  // ----- streams, files, prefix hints, cost-state ----------------------------------------------------------------
  const streams: Stream[] = chainKeysSorted.map((ck) => {
    const agg = chains.get(ck) as ChainAgg;
    return {
      chain: chainKeyOf(agg.S, agg.T),
      provider: "claude",
      files: [...agg.files].sort((a, b) => a - b),
      start_ms: agg.start,
      ordinal_verified: null,
      integrity_unverified: false,
      integrity_reasons: [],
      fork: null,
      has_settings_marker: false,
    };
  });
  cov.streams_total = streams.length;

  const prefixHints: AgentPrefixHint[] = prefixes
    .filter((p) => chains.has(chainStr(p.S, p.A)))
    .sort((x, y) => cmpStr(x.S, y.S) || cmpStr(x.A, y.A))
    .map((p) => ({
      chain: chainKeyOf(p.S, p.A),
      model: p.p.model,
      is_1h_cache_ttl: p.p.is1h,
      build_version: p.p.build,
      tools_hash_present: p.p.toolsHash,
    }));

  // cost-state: latest record per (session, model), summed over sessions (R17.5)
  const latest = new Map<string, { ts: number | null; sum: bigint; d: string; slots: Array<bigint | null>; S: string; model: string }>();
  for (const r of recs) {
    if (r.type !== "cost-state" || !r.cost) continue;
    for (const [model, slots] of r.cost.models) {
      const k = chainStr(r.S, model);
      const sum = slots.reduce<bigint>((s, v) => s + (v ?? 0n), 0n);
      const cur = latest.get(k);
      const newer = (x: number | null, y: number | null): boolean => x !== null && (y === null || x > y);
      const better =
        !cur ||
        newer(r.ts, cur.ts) ||
        (r.ts === cur.ts && (sum > cur.sum || (sum === cur.sum && cmpStr(r.d, cur.d) < 0)));
      if (better) latest.set(k, { ts: r.ts, sum, d: r.d, slots, S: r.S, model });
    }
  }
  const costByModel = new Map<string, { input: bigint; output: bigint; read: bigint; write: bigint }>();
  const costSessions = new Set<string>();
  for (const e of [...latest.values()].sort((x, y) => cmpStr(x.S, y.S) || cmpStr(x.model, y.model))) {
    costSessions.add(e.S);
    const cur = costByModel.get(e.model) ?? { input: 0n, output: 0n, read: 0n, write: 0n };
    cur.input += e.slots[0] ?? 0n;
    cur.output += e.slots[1] ?? 0n;
    cur.read += e.slots[2] ?? 0n;
    cur.write += e.slots[3] ?? 0n;
    costByModel.set(e.model, cur);
  }
  const costState: CostStateUsage[] = [...costByModel.entries()]
    .sort((x, y) => cmpStr(x[0], y[0]))
    .map(([model, v]) => ({ model, input_uncached: v.input, cache_read: v.read, cache_write: v.write, output: v.output }));
  if (costState.length > 0) {
    const logged = { input_uncached: 0n, cache_read: 0n, cache_write: 0n, output: 0n };
    for (const r of responses) {
      if (r.exclusion !== null || r.ownership.role !== "owner" || r.usage === null) continue;
      if (!costSessions.has(r.chain.root_session) || r.model.model === null || !costByModel.has(r.model.model)) continue;
      const u = r.usage;
      logged.input_uncached += u.input_uncached;
      logged.cache_read += u.cache_read;
      logged.cache_write += u.cache_write_5m + u.cache_write_1h + u.cache_write_unknown_ttl;
      logged.output += u.output ?? u.output_lower_bound;
    }
    const tot = { input_uncached: 0n, cache_read: 0n, cache_write: 0n, output: 0n };
    for (const c of costState) {
      tot.input_uncached += c.input_uncached;
      tot.cache_read += c.cache_read;
      tot.cache_write += c.cache_write;
      tot.output += c.output;
    }
    cov.unlogged_tokens_estimate.input_uncached = tot.input_uncached - logged.input_uncached;
    cov.unlogged_tokens_estimate.cache_read = tot.cache_read - logged.cache_read;
    cov.unlogged_tokens_estimate.cache_write = tot.cache_write - logged.cache_write;
    cov.unlogged_tokens_estimate.output = tot.output - logged.output;
  }

  if (anyStartLo) assumptions.add("parent_record_precedes_request");
  // Key order must not depend on line order.
  cov.versions = Object.fromEntries(Object.entries(cov.versions).sort((x, y) => cmpStr(x[0], y[0])));

  const fileInfos: FileInfo[] = files.map((f, i) => {
    const vs = [...(fileVersions[i] as Set<string>)].sort(cmpStr);
    const graphVs = vs.length;
    const anySupported = vs.some((v) => FULL_VERSIONS.has(v));
    return {
      index: i,
      provider: "claude",
      source_kind: f.kind,
      versions: vs,
      support: graphVs > 0 && !anySupported ? "coverage_only" : "full",
      readable: !(fileUnreadable[i] as boolean),
      archived: false,
      stream_assignment: "assigned",
      copy_exposed: false,
      without_response_id: false,
      lines: fileLines[i] as number,
    };
  });

  responses.sort((x, y) => cmpStr(x.key, y.key) || cmpStr(chainKeyString(x.chain), chainKeyString(y.chain)));
  conflicts.sort((x, y) => cmpStr(x.kind, y.kind) || cmpStr(x.key, y.key));
  excluded.sort(
    (x, y) =>
      cmpStr(chainKeyString(x.chain), chainKeyString(y.chain)) || x.event_ms - y.event_ms || cmpStr(x.reason, y.reason) || cmpStr(x.files.join(","), y.files.join(",")),
  );
  compactBoundaries.sort((x, y) => cmpStr(x.uuid, y.uuid));

  const assumptionOrder: readonly Assumption[] = ["parent_record_precedes_request", "unverified_version", "mtime_prefilter_on"];
  return {
    provider: "claude",
    responses,
    excluded,
    coverage: cov,
    conflicts,
    links,
    streams,
    files: fileInfos,
    assumptions: assumptionOrder.filter((a) => assumptions.has(a)),
    uuid_index: uuidIndex,
    compact_boundaries: compactBoundaries,
    prefix_hints: prefixHints,
    cost_state: costState,
  };
};
