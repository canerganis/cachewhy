// Claude Code source reader. Binding spec: docs/methodology.md (spec-1, revision 11).
//
// parseClaude(files, opts) turns the Claude files of `discover()` into Responses (one per (key, chain)),
// links, streams, markers, coverage counters and the integrity facts of R0.9. It applies, in order:
//   R0.9  named chains, family groups, taint triggers and per-file facts (the parser only reports them)
//   R1.2/R1.3/R1.4  structural allowlist, parse failures, record types
//   R2.1-R2.5, R2.12-R2.16  usage normalization, range check, BigInt only
//   R3.12, R4.2  modifiers are read from the final copy only
//   R4.1-R4.3, R4.5-R4.7  keys, copy selection, retries, replay ownership
//   R4.11  identity is read per record from (sessionId, agentId or main), never from a path
//   R5.1-R5.5, R5.9  chains, kinds, subagent and workflow linkage, helper tagging, every file is read
//   R6.3, R6.4  start bounds inputs (t_first, t_last, t_asm, start_lo)
//   R10.1, R10.6, R10.7  diagnostics and prefix hints
//   R11.7  compact boundary records and the uuid index for the walks
//   R15.7  a request key is supported iff every copy in the scan is; unverified keys are counted, never accounted
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
import { instantProj, instantState, nsToMs } from "../window.js";
import {
  CLAUDE_FULL_VERSIONS,
  RESPONSE_FLAGS,
  TAINT_REASONS,
  chainIdOf,
  chainKeyString,
  emptyCoverage,
} from "../model/types.js";
import type {
  AgentPrefixHint,
  Assumption,
  ChainId,
  ChainKey,
  ClaudeCompactBoundary,
  ClaudeParseResult,
  ClaudeResponse,
  ClaudeUuidNode,
  LedgerCountField,
  LedgerEntry,
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
  FileFacts,
  FileInfo,
  Geo,
  IntegrityFacts,
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
  TaintTrigger,
  UnlinkedReason,
  UsageBuckets,
} from "../model/types.js";

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Ascending, null last. Instants are BigInt nanoseconds (S3.2). */
const cmpNum = (a: bigint | null, b: bigint | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
};
const msOf = (ns: bigint | null): number | null => (ns === null ? null : nsToMs(ns));
const cmpNullStr = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return cmpStr(a, b);
};

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const BUILD_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$/;
const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FULL_VERSIONS: ReadonlySet<string> = new Set<string>(CLAUDE_FULL_VERSIONS);
const MAX_SIDECAR_BYTES = 8 * 1024 * 1024;
const READ_CONCURRENCY = 8;

/** S1.1: a valid id is a non-empty JSON string. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** S1.1, S1.3, S5.1: projection text of an id, the raw string (kept in memory only) or its state `missing` / `bad`. */
function idProj(v: unknown): string {
  if (v === undefined || v === null) return "~missing";
  return typeof v === "string" && v.length > 0 ? `s${v}` : "~bad";
}

/** S5.1: a boolean field is its value or `missing` (absent, null or not a boolean). */
function boolProj(v: unknown): string {
  return typeof v === "boolean" ? (v ? "t" : "f") : "~missing";
}

/**
 * S2.1, S2.2 (Claude `message.model`, `advisorModel`). Not a string, empty or longer than 80 characters: no model.
 * The exact string `<synthetic>` is the reserved value `<synthetic>`. Otherwise strip one trailing `-YYYYMMDD`; a plain
 * model id is the normalized id, anything else is `unlisted`.
 */
function normModel(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > 80) return null;
  if (v === SYNTHETIC) return SYNTHETIC;
  const s = v.replace(/-[0-9]{8}$/, "");
  return MODEL_RE.test(s) ? s : "unlisted";
}
const SYNTHETIC = "<synthetic>";

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
  /** R4.11: the record carries a string `sessionId`. Without it the record has no chain (R0.9 `unattributed_record`). */
  hasSid: boolean;
  S: string;
  T: string;
  uuid: string | null;
  parent: string | null;
  lparent: string | null;
  /** Exact instant, nanoseconds (S3.2). Null when the timestamp is missing or not a valid instant (S3.4). */
  tn: bigint | null;
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
  /** The record's own `sessionId`, or "" when it has none (R0.9 `unattributed_record`). */
  S: string;
  T: string;
  hasSid: boolean;
}

/** R4.11: identity is read per record from `(sessionId, agentId or main)`. No fallback to the path of the file. */
function resolveChain(o: Obj): Resolved {
  const sid = str(o["sessionId"]);
  const agent = str(o["agentId"]);
  return { S: sid ?? "", T: agent ?? "main", hasSid: sid !== null };
}

function parseAsst(o: Obj, ctx: FileCtx): { a: Asst; proj: unknown[] } {
  const m = isObj(o["message"]) ? o["message"] : undefined;
  const u = m !== undefined && isObj(m["usage"]) ? m["usage"] : undefined;
  const modelRaw = m?.["model"];
  const model = normModel(modelRaw);
  // R2.14: `<synthetic>` and `isApiErrorMessage = true` are not requests. The projection keeps the normalized model and
  // the raw boolean (S5.1); this derived flag is a decision input only.
  const isErr = o["isApiErrorMessage"] === true || model === SYNTHETIC;
  let sideRangeFailed = 0;

  // content blocks
  // S5.1: the projection keeps the block type (absent is `missing`, unlisted is `other`) and the ids with their states.
  const blocks: Array<[string | null, string | null, string | null, string | null]> = [];
  const tools: Array<[string, ToolName]> = [];
  const content = m?.["content"];
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!isObj(b)) {
        blocks.push(["other", null, null, null]);
        continue;
      }
      const btRaw = pick(b["type"], BLOCK_VALUES);
      const bt = (btRaw ?? "other") as BlockType;
      if (bt === "tool_use") {
        const id = str(b["id"]);
        const nmRaw = pick(b["name"], TOOL_NAMES);
        const nm = (nmRaw ?? "other") as ToolName;
        blocks.push([btRaw, idProj(b["id"]), nmRaw, null]);
        if (id !== null && ctx.neededToolUse.has(id)) tools.push([id, nm]);
      } else if (bt === "tool_result") {
        blocks.push([btRaw, null, null, idProj(b["tool_use_id"])]);
      } else {
        blocks.push([btRaw, null, null, null]);
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
  // R1.2, R17.6, S5.1: every integer member of iterations[0], by member name, as a decimal string or `range`; the
  // object itself is `missing` (absent or null) or `bad` (not an object). It takes part in record identity only
  // (hashed); the four shared members are the ones compared (R4.2) and kept.
  let iterMembers: [string, string][] | "missing" | "bad" = "missing";
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
    const it0Raw: unknown = Array.isArray(its) ? its[0] : undefined;
    if (it0Raw !== undefined && it0Raw !== null && !isObj(it0Raw)) iterMembers = "bad";
    if (isObj(it0Raw)) {
      const it0 = it0Raw;
      iter = {};
      iterMembers = [];
      // R1.2, R2.15: EVERY integer member of iterations[0] belongs to the counter row and is range checked. Only the
      // four members that share a key with the top-level usage are compared (R4.2) and kept.
      const slots: Record<string, "i" | "o" | "r" | "wt"> = {
        input_tokens: "i",
        output_tokens: "o",
        cache_read_input_tokens: "r",
        cache_creation_input_tokens: "wt",
      };
      for (const [name, v] of Object.entries(it0)) {
        if (typeof v !== "number" || !Number.isInteger(v)) continue; // integer members only (R1.2)
        if (!Number.isSafeInteger(v) || v < 0) {
          rangeFail = true;
          iterMembers.push([name, "range"]);
          continue;
        }
        iterMembers.push([name, BigInt(v).toString()]);
        const slot = Object.hasOwn(slots, name) ? slots[name] : undefined;
        if (slot !== undefined) (iter as NonNullable<Asst["iter"]>)[slot] = BigInt(v);
      }
      iterMembers.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    }
    for (const c of [i, r, wt, w5, w1, o2, think]) if (c === "range") rangeFail = true;
    const sp = u["speed"];
    if (sp !== undefined && sp !== null) hasSpeed = true;
    speed = pick(sp, ["standard", "fast"] as const) as Speed | null;
    geo = pick(u["inference_geo"], ["not_available", "us"] as const) as Geo | null;
    tier = pick(u["service_tier"], ["standard", "priority", "batch"] as const) as ServiceTier | null;
  }

  // stop reason
  // S1.3: JSON null and absence are the same state `missing`, so records that differ only there are one record and
  // must read alike.
  const stop = (m !== undefined ? pick(m["stop_reason"], STOP_VALUES) : null) as StopReason | null;

  // diagnostics (R10.1)
  // S1.2, S5.1: a container that is not retained (`diagnostics`, `cache_miss_reason`) contributes only its leaves, so an
  // absent container and a container without the leaf are the same state. An absent `type` is `missing` (no type
  // evidence for R4.2), an unlisted one is `other`; `cache_missed_input_tokens` keeps its counter state (S1.4).
  let diagType: DiagType | null = null;
  let diagMissed: bigint | null = null;
  let diagMissedSt: Cnt = "missing";
  const dg = m?.["diagnostics"];
  const cmrObj = isObj(dg) && isObj(dg["cache_miss_reason"]) ? (dg["cache_miss_reason"] as Obj) : undefined;
  if (cmrObj !== undefined) {
    diagType = pick(cmrObj["type"], DIAG_VALUES) as DiagType | null;
    diagMissedSt = cnt(cmrObj["cache_missed_input_tokens"]);
    if (isBig(diagMissedSt)) diagMissed = diagMissedSt;
    else if (diagMissedSt === "range") sideRangeFailed++;
  }

  const effort = pick(o["effort"], EFFORT_VALUES) as Effort | null;
  const perTurn = pick(o["perTurnEffort"], EFFORT_VALUES) as Effort | null;
  const entry = pick(o["entrypoint"], ENTRY_VALUES) as Entrypoint | null;
  const advisor = normModel(o["advisorModel"]);
  const classifier = o["serverClassifierRequest"] !== undefined && o["serverClassifierRequest"] !== null;
  const sidechain = typeof o["isSidechain"] === "boolean" ? o["isSidechain"] : null;
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
    idProj(o["requestId"]),
    idProj(m?.["id"]),
    model,
    boolProj(o["isApiErrorMessage"]),
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
    iterMembers,
    speed,
    geo,
    tier,
    stop,
    diagType,
    cntProj(diagMissedSt),
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
  const subtype = pick(o["subtype"], ["compact_boundary"] as const); // S1.2: missing (null) differs from other
  const boundary = subtype === "compact_boundary";
  let trigger: SysData["trigger"] = null;
  let pre: bigint | null = null;
  let post: bigint | null = null;
  let preSt: Cnt = "missing";
  let postSt: Cnt = "missing";
  let side = 0;
  if (boundary) {
    const cm = o["compactMetadata"];
    if (isObj(cm)) {
      trigger = pick(cm["trigger"], ["manual", "auto"] as const) as SysData["trigger"];
      preSt = cnt(cm["preTokens"]);
      postSt = cnt(cm["postTokens"]);
      if (isBig(preSt)) pre = preSt;
      else if (preSt === "range") side++;
      if (isBig(postSt)) post = postSt;
      else if (postSt === "range") side++;
    }
  }
  return {
    s: { boundary, trigger, pre, post },
    side,
    // S1.4, S5.1: preTokens and postTokens keep their counter states in the projection.
    proj: [subtype, trigger, cntProj(preSt), cntProj(postSt)],
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
  const projRows: Array<[string, string[]]> = [];
  let side = 0;
  if (raw !== undefined) {
    for (const [name, val] of Object.entries(raw)) {
      const model = normModel(name) ?? "unlisted";
      const slots: Array<bigint | null> = [];
      const states: string[] = [];
      for (const [camel, snake] of COST_SLOTS) {
        const c = isObj(val) ? cnt(val[camel] ?? val[snake]) : "missing";
        states.push(cntProj(c));
        if (isBig(c)) slots.push(c);
        else {
          if (c === "range") side++;
          slots.push(null);
        }
      }
      models.push([model, slots]);
      projRows.push([model, states]);
    }
    // Two keys can normalize to one model: the order must not depend on key order (R4.10), so ties break on the slots.
    models.sort((x, y) => cmpStr(x[0], y[0]) || cmpStr(JSON.stringify(x[1].map(String)), JSON.stringify(y[1].map(String))));
    projRows.sort((x, y) => cmpStr(x[0], y[0]) || cmpStr(JSON.stringify(x[1]), JSON.stringify(y[1])));
  }
  return { c: { models }, side, proj: projRows };
}

/** Parse one JSON value into a record. Returns the record and its projection digest. */
function makeRec(v: unknown, ctx: FileCtx): Rec {
  if (!isObj(v)) {
    return {
      d: sha(JSON.stringify(["nonobject", typeof v])),
      type: "other",
      graph: false,
      ver: "unlisted",
      supported: false,
      hasSid: false,
      S: "",
      T: "main",
      uuid: null,
      parent: null,
      lparent: null,
      tn: null,
      isSummary: false,
      files: [],
      sideRangeFailed: 0,
    };
  }
  const tstr = typeof v["type"] === "string" ? v["type"] : "";
  const type: RecType = KNOWN_TYPES.has(tstr) ? (tstr as RecType) : "other";
  // S3: an own parser decides validity; the value is the exact nanosecond count and its projection text.
  const tsSt = instantState(v["timestamp"]);
  const tn = typeof tsSt === "string" ? null : tsSt.ns;
  const tsP = instantProj(tsSt);
  const uuid = str(v["uuid"]);
  if (type === "other") {
    // Unlisted type (R1.4): the structural id, the time and the chain key are used for equality. The raw type is
    // dropped. The chain key is read so that the file names its chain (R0.9 "Named chains").
    const rc = resolveChain(v);
    return {
      // S1.2: an absent record type is `missing`, an unlisted one is `other`, and the two differ.
      d: sha(JSON.stringify([v["type"] === undefined || v["type"] === null ? "missing" : "other", idProj(v["uuid"]), tsP, idProj(v["sessionId"]), idProj(v["agentId"])])),
      type,
      graph: false,
      ver: "unlisted",
      supported: false,
      hasSid: rc.hasSid,
      S: rc.S,
      T: rc.T,
      uuid: null,
      parent: null,
      lparent: null,
      tn: null,
      isSummary: false,
      files: [],
      sideRangeFailed: 0,
    };
  }
  const { S, T, hasSid } = resolveChain(v);
  const verRaw = v["version"];
  const ver = typeof verRaw === "string" && VERSION_RE.test(verRaw) ? verRaw : "unlisted";
  const graph = type !== "cost-state";
  const supported = graph ? FULL_VERSIONS.has(ver) : true;
  const parent = str(v["parentUuid"]);
  const lparent = str(v["logicalParentUuid"]);
  const isSummary = v["isCompactSummary"] === true;
  // S5.1: ids are raw or their state, an absent agentId is `missing` and never the string `main` (the chain id still
  // uses `main`), the instant is its nanosecond value or its state, booleans are their value or `missing`.
  const common: unknown[] = [
    type,
    idProj(v["uuid"]),
    idProj(v["parentUuid"]),
    idProj(v["logicalParentUuid"]),
    idProj(v["sessionId"]),
    idProj(v["agentId"]),
    tsP,
    ver,
    boolProj(v["isCompactSummary"]),
  ];
  const rec: Rec = {
    d: "",
    type,
    graph,
    ver,
    supported,
    hasSid,
    S,
    T,
    uuid,
    parent,
    lparent,
    tn,
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
        const bt = pick(b["type"], BLOCK_VALUES);
        blocks.push([bt, bt === "tool_result" ? idProj(b["tool_use_id"]) : null]);
      }
    }
    extra = [role, blocks];
  }
  // Fields read on every graph record (R1.2) that are not used downstream still take part in equality.
  const shared: unknown[] = graph
    ? [
        boolProj(v["isSidechain"]),
        boolProj(v["isApiErrorMessage"]),
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
    // A one-line sidecar duplicated line by line is still readable: every non-empty line must parse on its own, so
    // line duplication cannot change the taint. An empty or otherwise broken sidecar is one unparsed line.
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) return { state: "parse_error" };
    let first: unknown;
    for (let k = 0; k < lines.length; k++) {
      try {
        const v: unknown = JSON.parse(lines[k] as string);
        if (k === 0) first = v;
      } catch {
        return { state: "parse_error" };
      }
    }
    return { state: "ok", value: first };
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
  return cmpNum(x.tn, y.tn) || cmpNullStr(x.uuid, y.uuid) || cmpStr(x.d, y.d);
}

/** Natural "earliest copy" order: timestamp asc, uuid asc, digest. */
function earliestOrder(x: Rec, y: Rec): number {
  return cmpNum(x.tn, y.tn) || cmpNullStr(x.uuid, y.uuid) || cmpStr(x.d, y.d);
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

  // exclusion ladder (S6.1): range, then incomplete (a copy without a valid timestamp included), then key_conflict,
  // then conflict_input and conflict_model. Only the first code is recorded and counted.
  if (usageCopies.some((c) => (c.a as Asst).rangeFail)) {
    sh.exclusion = "usage_range_failed";
    sh.rangeFailed = true;
    return sh;
  }
  const incomplete = (c: Rec): boolean => {
    const a = c.a as Asst;
    if (a.ccBad) return true;
    // R2.12: output_tokens is a counter of the R1.2 row like the others. A copy that lacks it (or holds a non-integer)
    // makes the request incomplete, a final copy included: a missing value is never treated as 0.
    if (!isBig(a.i) || !isBig(a.r) || !isBig(a.wt) || !isBig(a.o)) return true;
    if (a.hasCC && (!isBig(a.w5) || !isBig(a.w1))) return true;
    return false;
  };
  // Revision 11.1 (R2.12): any copy, usage-bearing or not, whose timestamp is missing or not a valid instant makes the
  // request incomplete, because its window membership cannot be decided.
  if (usageCopies.length === 0 || usageCopies.some(incomplete) || ordered.some((c) => c.tn === null)) {
    sh.exclusion = "usage_incomplete";
    // R2.12, S6.3: the present integer fields that pass R2.15 are reported. Each field is the maximum of its valid
    // values over the usage-bearing copies (BigInt), the total is i + r + W + o with W = cache_creation_input_tokens
    // when valid, else the valid ones of w5 and w1. Each term counts once.
    const maxOf = (get: (a: Asst) => Cnt): bigint | null => {
      let m: bigint | null = null;
      for (const c of usageCopies) {
        const v = get(c.a as Asst);
        if (isBig(v) && (m === null || v > m)) m = v;
      }
      return m;
    };
    const mi = maxOf((a) => a.i);
    const mr = maxOf((a) => a.r);
    const mo = maxOf((a) => a.o);
    const mwt = maxOf((a) => a.wt);
    const w = mwt !== null ? mwt : (maxOf((a) => a.w5) ?? 0n) + (maxOf((a) => a.w1) ?? 0n);
    sh.incompleteTokens = (mi ?? 0n) + (mr ?? 0n) + w + (mo ?? 0n);
    return sh;
  }
  if (keyConflict) {
    sh.exclusion = "key_conflict";
    conflicts.push({ kind: "key_conflict", effect: "excluded" });
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
  // iterations[0] must equal the top-level counters on shared keys, on EVERY final copy (R4.2): a disagreement on any
  // of them is a conflict, whatever the order of the copies. The stop reason is read from the first final copy.
  const pf = finals[0];
  if (pf) {
    const iterBad = finals.some((c) => {
      const a = c.a as Asst;
      const it = a.iter;
      if (!it) return false;
      return (
        (it.i !== undefined && isBig(a.i) && it.i !== a.i) ||
        (it.o !== undefined && isBig(a.o) && it.o !== a.o) ||
        (it.r !== undefined && isBig(a.r) && it.r !== a.r) ||
        (it.wt !== undefined && isBig(a.wt) && it.wt !== a.wt)
      );
    });
    if (iterBad) {
      output = null;
      flags.add("output_unknown");
      flags.add("conflict_iterations");
      conflicts.push({ kind: "conflict_iterations", effect: "output_unknown" });
    }
    sh.stop = (pf.a as Asst).stop;
  }

  // modifiers (R4.2, R3.12): speed, inference_geo and service_tier are read from the final copy only. A response
  // without a final copy has no verified modifier: nothing is assumed, all three stay null and the flag is set.
  let speed: Speed | null = null;
  let geo: Geo | null = null;
  let tier: ServiceTier | null = null;
  let modConflict = false;
  if (finals.length === 0) {
    flags.add("no_final_copy");
  } else {
    const nonFinal = usageCopies.filter((c) => !(c.a as Asst).hasSpeed);
    // The final copies must agree with each other (a final copy that lacks a value another one carries is a
    // disagreement), and a non-final copy that carries a value must carry the final copy's value (R4.2).
    const resolve = <T extends string>(get: (a: Asst) => T | null): T | null => {
      const fv = new Set<T | null>(finals.map((c) => get(c.a as Asst)));
      if (fv.size > 1) {
        modConflict = true;
        return null;
      }
      const v = [...fv][0] ?? null;
      for (const c of nonFinal) {
        const x = get(c.a as Asst);
        if (x !== null && x !== v) {
          modConflict = true;
          return null;
        }
      }
      return v;
    };
    speed = resolve((a) => a.speed);
    geo = resolve((a) => a.geo);
    tier = resolve((a) => a.tier);
  }
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
  /** stream_start, exact nanoseconds (R4.6, S3.3). */
  start: bigint | null;
  files: Set<number>;
  workflowFile: boolean;
}

const FLAG_ORDER: ReadonlyMap<ResponseFlag, number> = new Map(RESPONSE_FLAGS.map((f, i) => [f, i]));

export const parseClaude: ParseClaude = async (inputFiles: readonly DiscoveredFile[], _opts: ParseOptions = {}): Promise<ClaudeParseResult> => {
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
  /** Lines of each physical file that failed to parse, a truncated tail included (R1.3, R0.9 FileFacts). */
  const fileUnparsed: number[] = files.map(() => 0);

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
      fileUnparsed[i] = 1; // R0.9: a sidecar that fails to parse names no chain, so its taint is provider-wide
      return;
    }
    const sess = f.sessionId ?? "";
    const v = val.value;
    if (f.workflowAgent === true && (f.kind === "claude-subagent-meta" || f.kind === "claude-subagent-prefix")) {
      // S12.6, R5.4: a workflow agent sidecar is counted (file, line, parse error) and read for nothing: workflow agents
      // never link by toolUseId, so its fields enter no link, no tool_use filter and no prefix hint.
    } else if (f.kind === "claude-subagent-meta") {
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
    fileUnparsed[j.i] = j.perr + j.tail;
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
      jsonlIdx.push(i); // R5.9: every file is read, whatever its modification time
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
    fileUnparsed[out.idx] = out.parseErr + out.truncTail;
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

  // ----- R0.9 integrity inputs: named chains, chain ids, triggers ------------------------------------------------
  // Every parsed record of any version with a string `sessionId` names a chain (structural read, R15.7). The sets
  // below are built from sets of collapsed records, so line order, file order and duplication cannot change them.
  const chainKeyOf = (S: string, T: string): ChainKey => ({ provider: "claude", root_session: S, thread: T });
  const cidOf = (S: string, T: string): ChainId => chainIdOf(chainKeyOf(S, T));
  const seenChains = new Set<ChainId>();
  const bySession = new Map<string, Set<ChainId>>(); // R0.9 link (i)
  const named: Array<Set<ChainId>> = files.map(() => new Set<ChainId>());
  const triggerMap = new Map<string, TaintTrigger>();
  const addTrigger = (reason: TaintTrigger["reason"], names: Iterable<ChainId> | "provider", scope: "family" | "chains" = "family"): void => {
    if (names === "provider") {
      triggerMap.set(`${reason}\u0000*`, { reason, names: "provider" });
      return;
    }
    const list = [...new Set(names)].sort(cmpStr);
    if (list.length === 0) return;
    // Revision 11.1: the scope is part of the identity of a trigger (only a Claude request_anomaly is chain scoped).
    triggerMap.set(`${reason}\u0000${scope}\u0000${list.join("\u0001")}`, scope === "chains" ? { reason, names: list, scope } : { reason, names: list });
  };
  for (const r of recs) {
    if (!r.hasSid) {
      // R0.9 `unattributed_record`: an assistant, user, system or attachment record whose sessionId is missing or
      // not a string. It contributes nothing to accounting and taints every Claude chain.
      if (r.graph) addTrigger("unattributed_record", "provider");
      continue;
    }
    const id = cidOf(r.S, r.T);
    seenChains.add(id);
    let g = bySession.get(r.S);
    if (!g) bySession.set(r.S, (g = new Set()));
    g.add(id);
    for (const fi of r.files) named[fi]?.add(id);
  }

  // ----- phase 4: chains / streams ---------------------------------------------------------------------------
  const chains = new Map<string, ChainAgg>();
  const supportedGraph = recs.filter((r) => r.graph && r.hasSid && r.supported);
  for (const r of supportedGraph) {
    const k = recChain(r);
    let c = chains.get(k);
    if (!c) chains.set(k, (c = { S: r.S, T: r.T, start: null, files: new Set(), workflowFile: false }));
    if (r.tn !== null && (c.start === null || r.tn < c.start)) c.start = r.tn;
    for (const fi of r.files) {
      c.files.add(fi);
      if ((files[fi] as DiscoveredFile).workflowAgent === true) c.workflowFile = true;
    }
  }

  const pickOwner = (cs: readonly string[]): { owner: string; ambiguous: boolean; start: bigint | null } => {
    // R4.6: the earliest stream_start owns; a chain without any valid instant never wins against one with an instant.
    let best: string[] = [];
    let bestStart: bigint | null = null;
    for (const c of cs) {
      const s = (chains.get(c) as ChainAgg).start;
      if (best.length === 0 || cmpNum(s, bestStart) < 0) {
        best = [c];
        bestStart = s;
      } else if (cmpNum(s, bestStart) === 0) best.push(c);
    }
    if (best.length === 1) {
      return { owner: best[0] as string, ambiguous: false, start: bestStart };
    }
    best.sort((x, y) => {
      const a = chains.get(x) as ChainAgg;
      const b = chains.get(y) as ChainAgg;
      return cmpStr(a.S, b.S) || cmpStr(a.T, b.T);
    });
    return { owner: best[0] as string, ambiguous: true, start: bestStart };
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
  const uuidKeys = [...byUuid.keys()].sort(cmpStr);
  for (const u of uuidKeys) {
    const cands = (byUuid.get(u) as Rec[]).slice().sort((x, y) => cmpNum(x.tn, y.tn) || cmpNullStr(x.parent, y.parent) || cmpStr(x.d, y.d));
    const first = cands[0] as Rec;
    const owner = pickOwner([...new Set(cands.map(recChain))].sort(cmpStr));
    const oc = chains.get(owner.owner) as ChainAgg;
    const isBoundary = cands.some((c) => c.sys?.boundary === true);
    // R6.3: a uuid that names records with different timestamps or parents does not resolve.
    const unresolved = cands.some((c) => c.tn !== first.tn || c.parent !== first.parent || c.lparent !== first.lparent);
    uuidIndex.set(u, {
      uuid: u,
      parent_uuid: unresolved ? null : first.parent,
      logical_parent_uuid: unresolved ? null : first.lparent,
      ts_ms: unresolved ? null : msOf(first.tn),
      ts_ns: unresolved ? null : first.tn,
      is_compact_summary: first.isSummary,
      is_compact_boundary: isBoundary,
      chain: chainKeyOf(oc.S, oc.T),
      unresolved,
    });
    if (isBoundary) {
      const b = (cands.find((c) => c.sys?.boundary === true) as Rec).sys as SysData;
      compactBoundaries.push({
        chain: chainKeyOf(oc.S, oc.T),
        uuid: u,
        logical_parent_uuid: unresolved ? null : first.lparent,
        trigger: b.trigger,
        pre_tokens: b.pre,
        post_tokens: b.post,
        ts_ms: unresolved ? null : msOf(first.tn),
      });
    }
  }

  // ----- phase 5: requests --------------------------------------------------------------------------------------
  // R15.7: a request key is supported iff every copy of it in the scan carries a version with full support. All
  // copies of every version are read to decide this; only keys with no unsupported copy are accounted.
  const byKey = new Map<string, Rec[]>(); // supported copies of a key
  const keyChains = new Map<string, Map<string, bigint | null>>(); // key -> chain -> min instant, copies of any version
  const unverifiedKeySet = new Set<string>();
  const excluded: ExcludedRecord[] = [];
  const ledger: LedgerEntry[] = []; // event-time ledger of the logical counters (LEDGER_COUNT_FIELDS)
  const reqToMsg = new Map<string, Set<string>>();
  const msgToReq = new Map<string, Set<string>>();
  const noteCopy = (key: string, ck: string, ts: bigint | null): void => {
    let m = keyChains.get(key);
    if (!m) keyChains.set(key, (m = new Map()));
    const prev = m.get(ck);
    m.set(ck, prev === undefined || prev === null ? ts : ts === null ? prev : ts < prev ? ts : prev);
  };
  // Ledger entry of a record or response at the exact instant `tn`; `t_ms` is its floor (S3.3).
  const at = (tn: bigint | null): { t_ms: number | null; t_ns: bigint | null } => ({ t_ms: msOf(tn), t_ns: tn });
  for (const r of recs) {
    if (r.type === "cost-state") {
      cov.fields_range_failed += r.sideRangeFailed;
      if (r.sideRangeFailed > 0) ledger.push({ ...at(r.tn), chain: null, n: { fields_range_failed: r.sideRangeFailed } });
      continue;
    }
    // R0.9 `unattributed_record`: no chain, no accounting, no counters. Its version still counts for the key
    // (R15.7: every copy of the key decides, whatever the chain of the copy): a copy of an unsupported version
    // makes the key unverified, so a supported peer cannot enter the totals next to it.
    if (!r.hasSid) {
      if (r.type === "assistant") {
        const sa = r.a as Asst;
        if (!r.supported) {
          if (!sa.isErr && sa.key !== null) unverifiedKeySet.add(sa.key);
        } else if (sa.isErr) {
          // R2.14: an API error record is counted whatever its chain key (no chain, so its ledger entry is never live).
          cov.api_error_records += 1;
          ledger.push({ ...at(r.tn), chain: null, n: { api_error_records: 1 } });
        } else if (sa.hasUsage && sa.key === null) {
          // S12.3: a usage-bearing record without a valid key is unkeyed whatever its chain key; one that also lacks a
          // chain key is `unattributed_record` as well (added above). No chain, so the ledger entry is never live.
          cov.records_unkeyed += 1;
          ledger.push({ ...at(r.tn), chain: null, n: { records_unkeyed: 1 } });
        }
      }
      continue;
    }
    if (r.type !== "assistant") {
      if (r.supported) {
        cov.fields_range_failed += r.sideRangeFailed;
        if (r.sideRangeFailed > 0) ledger.push({ ...at(r.tn), chain: cidOf(r.S, r.T), n: { fields_range_failed: r.sideRangeFailed } });
      }
      continue;
    }
    const a = r.a as Asst;
    const ck = recChain(r);
    if (!r.supported) {
      // Counted and structurally read, never accounted (R15.7).
      if (!a.isErr) {
        if (a.key !== null) {
          unverifiedKeySet.add(a.key);
          noteCopy(a.key, ck, r.tn);
        } else {
          addTrigger("request_anomaly", [cidOf(r.S, r.T)], "chains"); // R2.13: an unkeyed record with a known chain (chain scoped, R0.9 rev 11.1)
        }
      }
      continue;
    }
    cov.fields_range_failed += r.sideRangeFailed;
    if (r.sideRangeFailed > 0) ledger.push({ ...at(r.tn), chain: cidOf(r.S, r.T), n: { fields_range_failed: r.sideRangeFailed } });
    if (a.isErr) {
      cov.api_error_records += 1; // R2.14
      ledger.push({ ...at(r.tn), chain: cidOf(r.S, r.T), n: { api_error_records: 1 } });
      if (r.tn !== null && chains.has(ck)) {
        excluded.push({ provider: "claude", chain: chainKeyOf(r.S, r.T), reason: "api_error", event_ms: nsToMs(r.tn), event_ns: r.tn, ordinal: null, files: r.files });
      }
      continue;
    }
    const recN: { -readonly [K in LedgerCountField]?: number } = {};
    if (a.hasUsage) {
      cov.records_usage_bearing += 1;
      recN.records_usage_bearing = 1;
      const gone = (c: Cnt): boolean => c === "missing" || c === "bad";
      const unmappable =
        r.tn === null || a.ccBad || gone(a.i) || gone(a.r) || gone(a.wt) || gone(a.o) || (a.hasCC && (gone(a.w5) || gone(a.w1)));
      if (unmappable) {
        cov.records_usage_unmappable += 1;
        recN.records_usage_unmappable = 1;
      }
    }
    if (a.key === null) {
      // R2.13: unkeyed. The chain is known (string sessionId), so it is tainted (R0.9 `request_anomaly`).
      addTrigger("request_anomaly", [cidOf(r.S, r.T)], "chains");
      if (a.hasUsage) {
        cov.records_unkeyed += 1;
        recN.records_unkeyed = 1;
        ledger.push({ ...at(r.tn), chain: cidOf(r.S, r.T), n: recN });
        if (r.tn !== null) {
          excluded.push({ provider: "claude", chain: chainKeyOf(r.S, r.T), reason: "unkeyed", event_ms: nsToMs(r.tn), event_ns: r.tn, ordinal: null, files: r.files });
        }
      }
      continue;
    }
    if (a.hasUsage) ledger.push({ ...at(r.tn), chain: cidOf(r.S, r.T), n: recN });
    let l = byKey.get(a.key);
    if (!l) byKey.set(a.key, (l = []));
    l.push(r);
    noteCopy(a.key, ck, r.tn);
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
  const keyList = [...byKey.keys()].filter((k) => !unverifiedKeySet.has(k)).sort(cmpStr);
  let anyStartLo = false;
  const chainIdOfAgg = (cs: string): ChainId => {
    const agg = chains.get(cs) as ChainAgg;
    return cidOf(agg.S, agg.T);
  };

  for (const key of keyList) {
    const copies = byKey.get(key) as Rec[];
    const sh = analyzeKey(copies, conflictedKeys.has(key));
    cov.responses_total += 1;
    cov.requests_total += 1;
    const keyN: { -readonly [K in LedgerCountField]?: number } = { responses_total: 1 };
    if (sh.hasFinal) {
      cov.requests_with_final_marker += 1;
      keyN.requests_with_final_marker = 1;
    }

    // ownership (R4.6)
    const chainSet = [...new Set(copies.map(recChain))].sort(cmpStr);
    const own = pickOwner(chainSet);
    const allFiles = [...new Set(copies.flatMap((c) => c.files))].sort((a, b) => a - b);
    if (chainSet.length > 1) {
      // S7.5: replayed representations of accounted (not excluded) responses only. The ledger entry below carries the
      // request time, so the windowed counter counts the accounted responses of the window.
      if (sh.exclusion === null) {
        cov.replay_requests_excluded += chainSet.length - 1;
        keyN.replay_requests_excluded = chainSet.length - 1;
      }
      if (own.ambiguous) {
        cov.replay_ownership_ambiguous += 1;
        keyN.replay_ownership_ambiguous = 1;
      }
    }
    // R0.9 `request_anomaly` and `ownership_ambiguous` name every chain that holds a copy.
    const anomaly =
      sh.exclusion === "usage_range_failed" ||
      sh.exclusion === "usage_incomplete" ||
      sh.conflicts.some((c) => c.kind !== "conflict_diagnostics") ||
      sh.flags.has("bucket_mismatch");
    if (anomaly) addTrigger("request_anomaly", chainSet.map(chainIdOfAgg), "chains"); // chain scoped: no family propagation (R0.9 rev 11.1)
    if (chainSet.length > 1 && own.ambiguous) addTrigger("ownership_ambiguous", chainSet.map(chainIdOfAgg));
    // R17.1 requests_conflict counts requests: one per request with at least one conflict code except
    // `conflict_diagnostics` (no exclusion, no taint, R4.2). The per-code counts stay in requests_conflict_by_kind.
    for (const c of sh.conflicts) {
      conflicts.push({ provider: "claude", kind: c.kind, key, files: allFiles, effect: c.effect });
      cov.requests_conflict_by_kind[c.kind] += 1;
      if (c.kind === "conflict_modifier") {
        cov.requests_conflict_modifier += 1;
        keyN.requests_conflict_modifier = 1;
      }
    }
    if (sh.conflicts.some((c) => c.kind !== "conflict_diagnostics")) {
      cov.requests_conflict += 1;
      keyN.requests_conflict = 1;
    }
    if (sh.exclusion === "usage_range_failed") {
      cov.responses_usage_range_failed += 1;
      keyN.responses_usage_range_failed = 1;
    }
    if (sh.exclusion === "usage_incomplete") cov.tokens_in_incomplete_responses += sh.incompleteTokens;
    if (sh.flags.has("bucket_mismatch")) {
      cov.responses_bucket_mismatch += 1;
      keyN.responses_bucket_mismatch = 1;
    }
    // R6.3, R4.2, R5.9: the times of a request are min and max over EVERY copy of the key, whatever chain holds the
    // copy. The owner and the replay streams then carry one and the same event time, so the window and the ledger
    // cannot depend on which stream owns the request.
    // Exact instants (S3.2): BigInt nanoseconds, never truncated before a comparison. A key without any valid instant is
    // `usage_incomplete` and never accounted; its placeholder time is the epoch and is read by no decision.
    const allTs = copies.map((c) => c.tn).filter((t): t is bigint => t !== null);
    let reqFirstN: bigint | null = null;
    let reqLastN: bigint | null = null;
    for (const t of allTs) {
      if (reqFirstN === null || t < reqFirstN) reqFirstN = t;
      if (reqLastN === null || t > reqLastN) reqLastN = t;
    }
    const reqFirst = reqFirstN ?? 0n;
    const reqLast = reqLastN ?? 0n;
    {
      ledger.push({
        ...at(reqFirstN),
        chain: chainIdOfAgg(own.owner),
        n: keyN,
        conflict_kinds: sh.conflicts.map((c) => c.kind),
        tokens_incomplete: sh.exclusion === "usage_incomplete" ? sh.incompleteTokens : 0n,
      });
    }
    if (sh.usage && sh.usage.output === null) cov.output_unknown_requests += 1;
    if (sh.exclusion === null && !sh.model.verified) cov.responses_model_unverified += 1;

    for (const cs of chainSet) {
      const agg = chains.get(cs) as ChainAgg;
      const mine = copies.filter((c) => recChain(c) === cs).sort(earliestOrder);
      const earliest = mine[0] as Rec;
      const tFirst = reqFirst;
      const tLast = reqLast;
      const parentNode = earliest.parent !== null ? uuidIndex.get(earliest.parent) : undefined;
      const tAsm = parentNode?.ts_ns ?? null;
      // R6.4 (S3.3): the guard compares exact instants.
      const startLo = tAsm !== null && reqFirstN !== null && tAsm <= tFirst ? tAsm : null;
      if (startLo !== null) anyStartLo = true;
      const flags = new Set<ResponseFlag>(sh.flags);
      if (own.ambiguous) flags.add("ownership_ambiguous");
      let kind: RequestKind = "main";
      if (agg.T !== "main") kind = agg.workflowFile ? "workflow_agent" : "subagent";
      const role = cs === own.owner ? "owner" : "replayed";
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
          event_ms: nsToMs(tFirst),
          t_first_ms: nsToMs(tFirst),
          t_last_ms: nsToMs(tLast),
          t_asm_ms: msOf(tAsm),
          start_lo_ms: msOf(startLo),
          start_hi_ms: nsToMs(tFirst),
          gap_basis: startLo !== null ? "parent_record" : "none",
          event_ns: tFirst,
          t_first_ns: tFirst,
          t_last_ns: tLast,
          t_asm_ns: tAsm,
          start_lo_ns: startLo,
        },
        ordinal: null,
        ownership: { role, ambiguous: own.ambiguous, owner_stream_start_ms: msOf(own.start), owner_stream_start_ns: own.start },
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
  // R15.7: unverified keys (some copy of a version without full support) are counted, never accounted. Every chain
  // that holds a copy is tainted (R0.9 `version_unverified`).
  for (const key of [...unverifiedKeySet].sort(cmpStr)) {
    cov.requests_total += 1;
    cov.requests_unverified_version += 1;
    const m = keyChains.get(key) ?? new Map<string, bigint | null>();
    addTrigger(
      "version_unverified",
      [...m.keys()].map((ck) => {
        const [S, T] = ck.split("\u0000") as [string, string];
        return cidOf(S, T);
      }),
    );
    for (const [ck, ts] of [...m.entries()].sort((x, y) => cmpStr(x[0], y[0]))) {
      const agg = chains.get(ck);
      if (!agg || ts === null) continue; // a chain without a supported record has no stream to sit in
      excluded.push({ provider: "claude", chain: chainKeyOf(agg.S, agg.T), reason: "unverified_version", event_ms: nsToMs(ts), event_ns: ts, ordinal: null, files: [] });
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
      // R4.11, R5.3: the sidecar is bound to the logical chain, never to the name of a physical file. The chain's own
      // ids (the `sessionId` and `agentId` of its records) name the meta.json that belongs to it, so a split of an
      // agent file into files with other names (R4.10, R17.7: no links_* counter changes) leaves the link as it was.
      // Only a chain that has no meta of its own falls back to the meta that the name of its first file points at,
      // which is how a file that holds records of another agent or session is still reported (R5.3 item 2).
      const ownMeta = metas.get(chainStr(agg.S, agg.T));
      const meta = ownMeta ?? (af ? metas.get(chainStr(af.sessionId ?? "", af.agentId ?? "")) : undefined);
      if (meta && typeof meta.depth === "number") depth = meta.depth;
      if (af === null) reason = "agent_mismatch"; // records name an agent id, but no agent file holds them
      else if (!meta) reason = "no_meta";
      else if (meta.toolUseId === null) reason = "no_tool_use_id";
      else if (ownMeta === undefined && agentFiles.some((fi) => outByIdx.get(fi)?.sessMismatch === true)) reason = "session_mismatch";
      else if (ownMeta === undefined && agentFiles.some((fi) => outByIdx.get(fi)?.agentMismatch === true)) reason = "agent_mismatch";
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
      start_ms: msOf(agg.start),
      start_ns: agg.start,
      ordinal_verified: null,
      fork: null,
      has_settings_marker: false,
    };
  });

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
  const latest = new Map<string, { ts: bigint | null; sum: bigint; d: string; slots: Array<bigint | null>; S: string; model: string }>();
  for (const r of recs) {
    if (r.type !== "cost-state" || !r.cost) continue;
    for (const [model, slots] of r.cost.models) {
      const k = chainStr(r.S, model);
      const sum = slots.reduce<bigint>((s, v) => s + (v ?? 0n), 0n);
      const cur = latest.get(k);
      const newer = (x: bigint | null, y: bigint | null): boolean => x !== null && (y === null || x > y);
      const better =
        !cur ||
        newer(r.tn, cur.ts) ||
        (r.tn === cur.ts && (sum > cur.sum || (sum === cur.sum && cmpStr(r.d, cur.d) < 0)));
      if (better) latest.set(k, { ts: r.tn, sum, d: r.d, slots, S: r.S, model });
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
      mtime_ms: f.mtimeMs,
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
      cmpStr(chainKeyString(x.chain), chainKeyString(y.chain)) ||
      cmpNum(x.event_ns ?? null, y.event_ns ?? null) ||
      cmpStr(x.reason, y.reason) ||
      cmpStr(x.files.join(","), y.files.join(",")),
  );
  compactBoundaries.sort((x, y) => cmpStr(x.uuid, y.uuid));

  // ----- R0.9 integrity facts -----------------------------------------------------------------------------------
  // R15.7 structural reads feed only the family relation and the taint, which can only withdraw output.
  const groupSet = new Map<string, readonly ChainId[]>();
  const keyGroupSet = new Map<string, readonly ChainId[]>(); // link (iii) alone: the scope of a chain scoped request_anomaly
  const addGroup = (ids: Iterable<ChainId>, set: Map<string, readonly ChainId[]> = groupSet): void => {
    const g = [...new Set(ids)].sort(cmpStr);
    if (g.length >= 2) set.set(g.join("\u0001"), g); // a group of one links nothing
  };
  for (const g of bySession.values()) addGroup(g); // link (i): a shared sessionId
  for (const m of keyChains.values()) {
    // link (iii): copies of one request key (Claude replays, R4.6)
    const keyIds = [...m.keys()].map((ck) => cidOf(...(ck.split("\u0000") as [string, string])));
    addGroup(keyIds, keyGroupSet);
    addGroup(keyIds);
  }
  fileUnreadable.forEach((u) => {
    if (u) addTrigger("file_unreadable", "provider"); // R17.1: the file cannot be read, its records are unknown
  });
  const fileFacts: FileFacts[] = files.map((f, i) => ({
    index: i,
    provider: "claude",
    mtime_ms: f.mtimeMs,
    named_chains: [...(named[i] as Set<ChainId>)].sort(cmpStr),
    unparsed_lines: fileUnparsed[i] as number,
    readable: !(fileUnreadable[i] as boolean),
  }));
  const reasonOrder: ReadonlyMap<string, number> = new Map(TAINT_REASONS.map((r, i) => [r, i]));
  const trigKey = (t: TaintTrigger): string => (t.names === "provider" ? "*" : `${t.scope ?? "family"}\u0000${t.names.join("\u0001")}`);
  const integrity: IntegrityFacts = {
    provider: "claude",
    chains: [...seenChains].sort(cmpStr),
    family_groups: [...groupSet.values()].sort((x, y) => cmpStr(x.join("\u0001"), y.join("\u0001"))),
    key_groups: [...keyGroupSet.values()].sort((x, y) => cmpStr(x.join("\u0001"), y.join("\u0001"))),
    triggers: [...triggerMap.values()].sort(
      (x, y) => (reasonOrder.get(x.reason) as number) - (reasonOrder.get(y.reason) as number) || cmpStr(trigKey(x), trigKey(y)),
    ),
    files: fileFacts,
  };
  const assumptionOrder: readonly Assumption[] = ["parent_record_precedes_request", "unverified_version"];
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
    integrity,
    ledger,
  };
};
