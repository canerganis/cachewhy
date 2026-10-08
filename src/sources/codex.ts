// Codex rollout parser (spec-1, revision 7). Binding spec: docs/methodology.md. Rule ids are cited in comments.
//
// Contract:
// - Reads `codex-*` files of a DiscoveredFile list (plain .jsonl and archived .jsonl.zst through src/io/lines.ts).
// - Never throws on bad input: failures become coverage counters (R1.3, R17.1).
// - Keeps only the fields of R1.2. Message text, paths and every other free text are parsed and dropped.
// - Accounting source is `token_usage_record.usage` keyed by `response_id` (R2.9). Cumulative totals are never summed.
// - Every decision is a function of the SET of distinct records (R4.12 equality), never of line order, file order or
//   how a thread is split over files (R4.10). Files are indexed in a canonical order (sorted by path) so that the
//   index is independent of the order of the input list.
//
// Output is deterministic: responses, streams, links and the other lists are sorted.

import { newLineStats, readLines } from "../io/lines.js";
import type { DiscoveredFile } from "../discover.js";
import {
  CODEX_FULL_VERSIONS,
  CONSTANTS,
  EFFORTS,
  emptyCoverage,
  type Assumption,
  type ChainKey,
  type CodexCompaction,
  type CodexParseResult,
  type CodexResponse,
  type CodexThreadTotal,
  type DedupConflict,
  type Effort,
  type ExcludedRecord,
  type FileInfo,
  type ForkInfo,
  type Link,
  type ModelAttribution,
  type ModelSource,
  type ParseCodex,
  type ParseOptions,
  type RequestKind,
  type ResponseFlag,
  type Stream,
  type StreamIntegrityReason,
  type SupportLevel,
  type UnlinkedReason,
  type UsageBuckets,
} from "../model/types.js";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const EMPTY: Obj = Object.freeze({}) as Obj;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A non-empty string id, else null. Ids exist only inside the process (R14.4). */
function idOf(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** R2.15 range check for an ordinal or an integer field: integer, 0 <= v <= MAX_SAFE_INTEGER. */
function safeInt(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** ISO instant to epoch ms, or null when it does not parse (R4.12 (a)). */
function parseInstant(v: unknown): number | null {
  if (typeof v !== "string" || v.length > 40 || !ISO_RE.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

const FULL_VERSIONS: ReadonlySet<string> = new Set<string>(CODEX_FULL_VERSIONS);
// R14.3 version form. R1.2 does not give a Codex form; 0.2 lists "0.154.0-alpha.6.2", which needs the suffix part.
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.]+)?$/;

function versionLabel(v: unknown): string {
  return typeof v === "string" && v.length <= 40 && VERSION_RE.test(v) ? v : "unlisted";
}

// R14.3 model id form. R3.3 normalization strips a trailing -YYYYMMDD.
const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
function normalizeModel(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 80) return null;
  const n = v.replace(/-\d{8}$/, "");
  return MODEL_RE.test(n) ? n : null;
}

function enumOf<T extends string>(v: unknown, allowed: readonly T[]): T | "other" | null {
  if (v === undefined || v === null) return null;
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : "other";
}

const SOURCE_KINDS = ["cli", "exec", "vscode", "mcp", "subagent"] as const;
const THREAD_SOURCES = ["user", "subagent", "agent_created_thread", "automation", "guardian_review"] as const;
const ORIGINATORS = ["codex_cli", "codex_exec", "codex_vscode", "codex_cli_rs", "codex_exec_rs"] as const;
const AGENT_ROLES = ["default", "worker", "explorer", "awaiter"] as const;
const EVENT_TYPES = ["token_count", "thread_settings_applied"] as const;

function boundedToken(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v) ? v : null;
}

const USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const;
const U_IN = 0;
const U_C = 1;
const U_CW = 2;
const U_OUT = 3;
const U_RS = 4;
const U_TOTAL = 5;

// ---------------------------------------------------------------------------
// Records (R1.2 allowlist, R4.12 projection)
// ---------------------------------------------------------------------------

type RecKind = "meta" | "tc" | "tur" | "compacted" | "marker" | "tokcount" | "generic";
type FieldState = "ok" | "range" | "missing";

interface MetaF {
  id: string | null;
  session_id: string | null;
  label: string; // bounded cli_version, `unlisted` when absent or off pattern
  forked_from_id: string | null;
  spawn_parent: string | null;
  spawn_depth: number | null;
  has_spawn: boolean;
  has_subagent: boolean;
  subagent_other: boolean;
  hist_start: number | null;
  thread_source: string | null;
  agent_role: string | null;
}
interface TcF {
  turn_id: string | null;
  root_turn_id: string | null;
  model: string | null; // normalized and valid, null = absent or invalid
  effort: Effort | null;
  comp_hash: string | null;
  collab: string | null;
}
interface TurF {
  response_id: string | null;
  thread_id: string | null;
  session_id: string | null;
  turn_id: string | null;
  u: number[]; // six counters, 0 where the state is not ok
  us: FieldState[];
  tt: number | null;
  tt_state: FieldState;
}
interface CompF {
  window_number: number | null;
  latest_null: boolean;
}

interface Rec {
  readonly kind: RecKind;
  readonly key: string;
  readonly ts: number | null;
  readonly ts_present: boolean;
  readonly ord: number | null;
  readonly ord_present: boolean;
  readonly meta?: MetaF;
  readonly tc?: TcF;
  readonly tur?: TurF;
  readonly comp?: CompF;
  /** Parsed lines that carry this record (physical, R17.6). */
  lines: number;
  readonly files: Set<number>;
}

interface Draft {
  kind: RecKind;
  known: boolean;
  key: string;
  ts: number | null;
  ts_present: boolean;
  ord: number | null;
  ord_present: boolean;
  meta?: MetaF;
  tc?: TcF;
  tur?: TurF;
  comp?: CompF;
}

function isDecision(r: Rec): boolean {
  return r.kind === "meta" || r.kind === "tc" || r.kind === "tur" || r.kind === "compacted" || r.kind === "marker";
}

function fieldState(v: unknown): FieldState {
  if (typeof v !== "number") return "missing";
  return Number.isSafeInteger(v) && v >= 0 ? "ok" : "range";
}

function draftOf(obj: unknown): Draft {
  const o = isObj(obj) ? obj : null;
  const type = o !== null && typeof o["type"] === "string" ? (o["type"] as string) : null;
  const tsRaw = o?.["timestamp"];
  const ordRaw = o?.["ordinal"];
  const ts_present = tsRaw !== undefined && tsRaw !== null;
  const ord_present = ordRaw !== undefined && ordRaw !== null;
  const ts = parseInstant(tsRaw);
  const ord = safeInt(ordRaw);
  const tsKey = ts !== null ? ts : ts_present ? "!" : null;
  const ordKey = ord !== null ? ord : ord_present ? "!" : null;
  const p = o !== null && isObj(o["payload"]) ? (o["payload"] as Obj) : EMPTY;
  const base = { ts, ts_present, ord, ord_present };

  switch (type) {
    case "session_meta": {
      const src = p["source"];
      let has_subagent = false;
      let has_spawn = false;
      let subagent_other = false;
      let spawn_parent: string | null = null;
      let spawn_depth: number | null = null;
      if (isObj(src) && isObj(src["subagent"])) {
        has_subagent = true;
        const sub = src["subagent"] as Obj;
        subagent_other = sub["other"] !== undefined;
        if (isObj(sub["thread_spawn"])) {
          has_spawn = true;
          const sp = sub["thread_spawn"] as Obj;
          spawn_parent = idOf(sp["parent_thread_id"]);
          spawn_depth = safeInt(sp["depth"]);
        }
      }
      const meta: MetaF = {
        id: idOf(p["id"]),
        session_id: idOf(p["session_id"]),
        label: versionLabel(p["cli_version"]),
        forked_from_id: idOf(p["forked_from_id"]),
        spawn_parent,
        spawn_depth,
        has_spawn,
        has_subagent,
        subagent_other,
        hist_start: safeInt(p["subagent_history_start_ordinal"]),
        thread_source: enumOf(p["thread_source"], THREAD_SOURCES),
        agent_role: enumOf(p["agent_role"], AGENT_ROLES),
      };
      const srcKind = typeof src === "string" ? enumOf(src, SOURCE_KINDS) : has_subagent ? "subagent" : src === undefined ? null : "other";
      const key = JSON.stringify([
        "session_meta", tsKey, ordKey, meta.id, meta.session_id, parseInstant(p["timestamp"]) ?? (p["timestamp"] === undefined ? null : "!"),
        meta.label, meta.forked_from_id, p["parent_thread_id"] === undefined ? null : idOf(p["parent_thread_id"]),
        meta.spawn_parent, meta.spawn_depth, meta.has_spawn, meta.has_subagent, meta.subagent_other,
        meta.hist_start, p["subagent_history_start_ordinal"] === undefined ? null : meta.hist_start ?? "!",
        enumOf(p["originator"], ORIGINATORS), srcKind, meta.thread_source, meta.agent_role,
      ]);
      return { kind: "meta", known: true, key, ...base, meta };
    }
    case "turn_context": {
      const effortRaw = enumOf(p["effort"], EFFORTS);
      const cm = p["collaboration_mode"];
      const mode = isObj(cm) ? boundedToken(cm["mode"]) : null;
      const tc: TcF = {
        turn_id: idOf(p["turn_id"]),
        root_turn_id: idOf(p["root_turn_id"]),
        model: normalizeModel(p["model"]),
        effort: effortRaw as Effort | null,
        comp_hash: boundedToken(p["comp_hash"]),
        collab: mode,
      };
      const key = JSON.stringify(["turn_context", tsKey, ordKey, tc.turn_id, tc.root_turn_id, tc.model, p["model"] === undefined ? 0 : 1, tc.effort, tc.comp_hash, tc.collab]);
      return { kind: "tc", known: true, key, ...base, tc };
    }
    case "token_usage_record": {
      const usage = isObj(p["usage"]) ? (p["usage"] as Obj) : EMPTY;
      const u: number[] = [];
      const us: FieldState[] = [];
      for (const f of USAGE_FIELDS) {
        const v = usage[f];
        const st = fieldState(v);
        us.push(st);
        u.push(st === "ok" ? (v as number) : 0);
      }
      const tu = p["thread_token_usage"];
      const ttRaw = isObj(tu) ? tu["total_tokens"] : undefined;
      const tt_state = fieldState(ttRaw);
      const tur: TurF = {
        response_id: idOf(p["response_id"]),
        thread_id: idOf(p["thread_id"]),
        session_id: idOf(p["session_id"]),
        turn_id: idOf(p["turn_id"]),
        u,
        us,
        tt: tt_state === "ok" ? (ttRaw as number) : null,
        tt_state,
      };
      const key = JSON.stringify([
        "token_usage_record", tsKey, ordKey, tur.response_id, tur.thread_id, tur.session_id, tur.turn_id,
        us.map((s, i) => (s === "ok" ? u[i] : s === "range" ? "r" : null)), tt_state === "ok" ? tur.tt : tt_state === "range" ? "r" : null,
      ]);
      return { kind: "tur", known: true, key, ...base, tur };
    }
    case "event_msg": {
      const pt = enumOf(p["type"], EVENT_TYPES);
      const kind: RecKind = pt === "thread_settings_applied" ? "marker" : pt === "token_count" ? "tokcount" : "generic";
      return { kind, known: true, key: JSON.stringify(["event_msg", tsKey, ordKey, pt === null ? "other" : pt]), ...base };
    }
    case "compacted": {
      const comp: CompF = { window_number: safeInt(p["window_number"]), latest_null: p["latest_token_usage_record"] === undefined || p["latest_token_usage_record"] === null };
      const key = JSON.stringify([
        "compacted", tsKey, ordKey, idOf(p["compaction_response_id"]), idOf(p["window_id"]),
        comp.window_number, p["window_number"] === undefined ? null : comp.window_number ?? "!", comp.latest_null,
      ]);
      return { kind: "compacted", known: true, key, ...base, comp };
    }
    case "response_item":
      // R1.2: no field is kept. Counted as a known type and dropped.
      return { kind: "generic", known: true, key: JSON.stringify(["response_item", tsKey, ordKey]), ...base };
    default:
      // R1.4: the raw type string is never stored; an unlisted type is the enum `other`.
      return { kind: "generic", known: false, key: JSON.stringify(["other", tsKey, ordKey]), ...base };
  }
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

interface ScannedFile {
  index: number;
  df: DiscoveredFile;
  readable: boolean;
  lines: number;
  parse_errors: number;
  truncated_tail: number;
  known: number;
  unlisted: number;
  recs: Set<Rec>;
  meta_lines: Map<string, number>;
  other_lines: number;
}

async function scanFile(df: DiscoveredFile, index: number, intern: Map<string, Rec>): Promise<ScannedFile> {
  const sf: ScannedFile = {
    index, df, readable: true, lines: 0, parse_errors: 0, truncated_tail: 0, known: 0, unlisted: 0,
    recs: new Set(), meta_lines: new Map(), other_lines: 0,
  };
  const stats = newLineStats();
  const drafts: Draft[] = [];
  let lines = 0;
  let parseErrors = 0;
  let tail = 0;
  try {
    for await (const ln of readLines(df.path, { stats })) {
      lines++;
      let obj: unknown;
      try {
        obj = JSON.parse(ln.text);
      } catch {
        // R1.3: the exception message is never stored.
        if (ln.terminated) parseErrors++;
        else tail++;
        continue;
      }
      drafts.push(draftOf(obj));
    }
  } catch {
    sf.readable = false;
  }
  if (stats.unsupported !== undefined || stats.error !== undefined) sf.readable = false;
  if (!sf.readable) return sf;
  sf.lines = lines;
  sf.parse_errors = parseErrors;
  sf.truncated_tail = tail;
  for (const d of drafts) {
    if (d.known) sf.known++;
    else sf.unlisted++;
    let rec = intern.get(d.key);
    if (rec === undefined) {
      const r: Rec = {
        kind: d.kind, key: d.key, ts: d.ts, ts_present: d.ts_present, ord: d.ord, ord_present: d.ord_present,
        ...(d.meta ? { meta: d.meta } : {}), ...(d.tc ? { tc: d.tc } : {}), ...(d.tur ? { tur: d.tur } : {}), ...(d.comp ? { comp: d.comp } : {}),
        lines: 0, files: new Set(),
      };
      intern.set(d.key, r);
      rec = r;
    }
    rec.lines++;
    rec.files.add(index);
    sf.recs.add(rec);
    if (d.kind === "meta" && d.meta) sf.meta_lines.set(d.meta.label, (sf.meta_lines.get(d.meta.label) ?? 0) + 1);
    else sf.other_lines++;
  }
  return sf;
}

// ---------------------------------------------------------------------------
// Analysis structures
// ---------------------------------------------------------------------------

interface FileA {
  sf: ScannedFile;
  /** R15.7: has session_meta records and none of a supported version. */
  coverage_only: boolean;
  own_ids: Set<string>;
  tur_ids: Set<string>;
  ident: Set<string>;
  assignment: "assigned" | "unassigned" | "conflict";
  copy_exposed: boolean;
  /** Stream id this file is assigned to (|I| = 1), else null. */
  stream: string | null;
  versions: string[];
  label: string; // label of non-meta lines (set after streams are known)
}

interface StreamB {
  id: string;
  files: Set<number>;
  assigned: number[];
  own_metas: Rec[];
  tur: Rec[];
  integrity: Set<StreamIntegrityReason>;
  supported: boolean;
  root: string;
  primary: Rec;
  label: string;
  ord_verified: boolean;
  fork: { from: string; hist: number | null; resolved: boolean } | null;
  tcs: Rec[]; // certain provenance, sorted by position
  tcs_by_turn: Map<string, Rec[]>;
  markers: Rec[]; // sorted by position
  single_model: string | null; // R2.17 (b): one valid model over all certain tcs (and the guard extras)
  /** Guard only: models of turn contexts held by files that may hold this stream's copied prefix (see guardExtras). */
  extra_models_by_turn: Map<string, Set<string | null>>;
  start_ms: number | null;
  chain: ChainKey;
}

function cmpPos(a: Rec, b: Rec): number {
  const at = a.ts ?? Number.NEGATIVE_INFINITY;
  const bt = b.ts ?? Number.NEGATIVE_INFINITY;
  if (at !== bt) return at < bt ? -1 : 1;
  const ao = a.ord ?? -1;
  const bo = b.ord ?? -1;
  return ao === bo ? 0 : ao < bo ? -1 : 1;
}

function cmpKey(a: Rec, b: Rec): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function sortedUnique<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)].sort();
}

/** R4.12: ordinal_verified is a computed property of the logical stream. */
function ordinalVerified(recs: readonly Rec[]): boolean {
  const byOrd = new Map<number, Rec>();
  for (const r of recs) {
    if (isDecision(r)) {
      if (r.ord === null || r.ts === null) return false; // (a)
    } else if (r.ord_present && r.ord === null) {
      return false; // (a) any other record that carries an ordinal must satisfy the same range
    }
    if (r.ord !== null) {
      const prev = byOrd.get(r.ord);
      if (prev !== undefined && prev !== r) return false; // (b) equal records are one record, so a distinct one is a collision
      byOrd.set(r.ord, r);
    }
  }
  const ords = [...byOrd.keys()].sort((x, y) => x - y);
  let last = Number.NEGATIVE_INFINITY;
  for (const o of ords) {
    const ts = (byOrd.get(o) as Rec).ts;
    if (ts === null) continue;
    if (ts < last) return false; // (c)
    last = ts;
  }
  return true;
}

// ---------------------------------------------------------------------------
// parseCodex
// ---------------------------------------------------------------------------

export async function parseCodex(files: readonly DiscoveredFile[], opts: ParseOptions = {}): Promise<CodexParseResult> {
  const cov = emptyCoverage();
  const assumptions = new Set<Assumption>();

  // Canonical file order: independent of the order of the input list (R4.10).
  let input = files.filter((f) => f.agent === "codex").slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // R5.9 --fast: skip files whose mtime is older than `since` minus C29.
  if (opts.fastPrefilter === true && opts.window) {
    const cutoff = opts.window.since_ms - CONSTANTS.FAST_PREFILTER_DAYS * 86_400_000;
    input = input.filter((f) => f.mtimeMs >= cutoff);
    assumptions.add("mtime_prefilter_on");
  }

  const intern = new Map<string, Rec>();
  const scanned: ScannedFile[] = [];
  for (let i = 0; i < input.length; i++) {
    const df = input[i] as DiscoveredFile;
    try {
      scanned.push(await scanFile(df, i, intern));
    } catch {
      scanned.push({ index: i, df, readable: false, lines: 0, parse_errors: 0, truncated_tail: 0, known: 0, unlisted: 0, recs: new Set(), meta_lines: new Map(), other_lines: 0 });
    }
  }

  // ---- physical counters (R17.6) -----------------------------------------
  cov.files_total = scanned.length;
  for (const sf of scanned) {
    if (!sf.readable) {
      cov.files_unreadable++;
      continue;
    }
    cov.lines_total += sf.lines;
    cov.lines_parse_error += sf.parse_errors;
    cov.lines_truncated_tail += sf.truncated_tail;
    cov.known_type_count += sf.known;
    cov.unlisted_type_count += sf.unlisted;
  }
  for (const rec of intern.values()) {
    if (rec.lines > 1) {
      cov.lines_duplicate_collapsed += rec.lines - 1;
      cov.duplicate_records_collapsed++;
    }
  }

  // ---- FS (R4.13): every forked_from_id of any session_meta of any version ------------------------------------
  const FS = new Set<string>();
  for (const rec of intern.values()) {
    if (rec.kind === "meta" && rec.meta && rec.meta.forked_from_id !== null) FS.add(rec.meta.forked_from_id);
  }

  // ---- per-file identity (R4.11, R4.13, R15.7) ----------------------------------------------------------------
  const fileA: FileA[] = [];
  for (const sf of scanned) {
    if (!sf.readable) continue;
    const metas = [...sf.recs].filter((r) => r.kind === "meta" && r.meta);
    const supportedMetas = metas.filter((r) => FULL_VERSIONS.has((r.meta as MetaF).label) && (r.meta as MetaF).id !== null);
    const supportedAny = metas.some((r) => FULL_VERSIONS.has((r.meta as MetaF).label));
    const coverage_only = metas.length > 0 && !supportedAny;
    const own_ids = new Set<string>();
    const tur_ids = new Set<string>();
    if (!coverage_only) {
      // R4.11: a session_meta is non-own iff another (distinct) session_meta of the file forks from its id.
      for (const m of supportedMetas) {
        const mid = (m.meta as MetaF).id as string;
        const nonOwn = supportedMetas.some((m2) => m2 !== m && (m2.meta as MetaF).forked_from_id === mid);
        if (!nonOwn) own_ids.add(mid);
      }
      for (const r of sf.recs) if (r.kind === "tur" && r.tur && r.tur.thread_id !== null) tur_ids.add(r.tur.thread_id);
    }
    const ident = new Set<string>([...own_ids, ...tur_ids]);
    let assignment: FileA["assignment"] = ident.size === 1 ? "assigned" : ident.size === 0 ? "unassigned" : "conflict";
    // R4.13 copy exposure.
    let copy_exposed = false;
    if (!coverage_only) {
      for (const x of own_ids) {
        if (FS.has(x) && !tur_ids.has(x)) copy_exposed = true;
      }
    }
    if (coverage_only) assignment = "unassigned";
    fileA.push({
      sf, coverage_only, own_ids, tur_ids, ident, assignment, copy_exposed,
      stream: !coverage_only && assignment === "assigned" ? (ident.values().next().value as string) : null,
      versions: sortedUnique(metas.map((r) => (r.meta as MetaF).label)),
      label: "unlisted",
    });
  }
  const fileAByIndex = new Map<number, FileA>(fileA.map((f) => [f.sf.index, f]));

  for (const fa of fileA) {
    if (fa.coverage_only) continue;
    if (fa.assignment === "assigned") cov.files_assigned_by_stream++;
    else if (fa.assignment === "unassigned") cov.files_unassigned_stream++;
    else cov.files_stream_conflict++;
    if (fa.copy_exposed) cov.files_copy_exposed++;
  }

  // ---- logical streams (R4.11) ---------------------------------------------------------------------------------
  const builds = new Map<string, StreamB>();
  const ensure = (id: string): StreamB => {
    let s = builds.get(id);
    if (s === undefined) {
      s = {
        id, files: new Set(), assigned: [], own_metas: [], tur: [], integrity: new Set(), supported: false, root: id,
        primary: undefined as unknown as Rec, label: "unlisted", ord_verified: false, fork: null, tcs: [], tcs_by_turn: new Map(),
        markers: [], single_model: null, extra_models_by_turn: new Map(), start_ms: null, chain: { provider: "codex", root_session: id, thread: id },
      };
      builds.set(id, s);
    }
    return s;
  };
  const turRecs: Rec[] = [];
  for (const fa of fileA) {
    if (fa.coverage_only) continue;
    for (const id of fa.ident) {
      const s = ensure(id);
      s.files.add(fa.sf.index);
      if (fa.assignment === "conflict") s.integrity.add("file_stream_conflict");
      if (fa.assignment === "assigned") s.assigned.push(fa.sf.index);
    }
    // R4.13 (a): every stream whose id is in own_ids(F) intersect FS, for a copy-exposed F
    if (fa.copy_exposed) for (const x of fa.own_ids) if (FS.has(x)) ensure(x).integrity.add("copy_exposed_file");
    // own session_metas of this file (also in a conflict file, R4.11: the identity is read from them)
    const metas = [...fa.sf.recs].filter((r) => r.kind === "meta" && r.meta);
    const supportedMetas = metas.filter((r) => FULL_VERSIONS.has((r.meta as MetaF).label) && (r.meta as MetaF).id !== null);
    for (const m of supportedMetas) {
      const mid = (m.meta as MetaF).id as string;
      if (fa.own_ids.has(mid) && !ensure(mid).own_metas.includes(m)) ensure(mid).own_metas.push(m);
    }
  }
  // token_usage_records: accounted by their own thread_id, whatever the file (R2.9, R4.11)
  for (const rec of intern.values()) {
    if (rec.kind !== "tur" || !rec.tur) continue;
    turRecs.push(rec);
  }
  turRecs.sort(cmpKey);
  const verifiedFileOf = (rec: Rec): boolean => [...rec.files].some((fi) => {
    const fa = fileAByIndex.get(fi);
    return fa !== undefined && !fa.coverage_only;
  });
  for (const rec of turRecs) {
    const tur = rec.tur as TurF;
    if (!verifiedFileOf(rec) || tur.thread_id === null) continue;
    ensure(tur.thread_id).tur.push(rec);
  }

  const streams: StreamB[] = [];
  for (const s of [...builds.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    s.own_metas.sort(cmpKey);
    s.supported = s.own_metas.length > 0; // R15.7: a stream exists only through a supported own session_meta
    if (!s.supported) continue;
    streams.push(s);
  }
  const streamById = new Map<string, StreamB>(streams.map((s) => [s.id, s]));

  for (const s of streams) {
    // primary own meta: the one with a fork reference if any, deterministic by key
    s.primary = s.own_metas.find((m) => (m.meta as MetaF).forked_from_id !== null) ?? (s.own_metas[0] as Rec);
    const sessionIds = sortedUnique(s.own_metas.map((m) => (m.meta as MetaF).session_id).filter((x): x is string => x !== null));
    if (sessionIds.length > 1) s.integrity.add("divergent_session_meta");
    const forks = new Set(s.own_metas.map((m) => (m.meta as MetaF).forked_from_id));
    const hists = new Set(s.own_metas.map((m) => (m.meta as MetaF).hist_start));
    if (forks.size > 1 || hists.size > 1) s.integrity.add("divergent_session_meta"); // R4.11
    let root = sessionIds[0];
    if (root === undefined) {
      const turSessions = sortedUnique(s.tur.map((r) => (r.tur as TurF).session_id).filter((x): x is string => x !== null));
      root = turSessions[0] ?? s.id;
    }
    s.root = root;
    s.chain = { provider: "codex", root_session: root, thread: s.id };
    s.label = sortedUnique(s.own_metas.map((m) => (m.meta as MetaF).label))[0] ?? "unlisted";

    // Guard extras (split monotonicity, R4.10, R4.13). A copy-exposed file whose copied prefix may belong to this fork,
    // and a file that resolves to several identities including this one, hold records that this stream cannot be
    // shown not to own. They are never candidates (certain provenance only) but they count in every guard:
    // the ordinal check (R4.12), the one-model guards (R2.17) and the settings markers (R2.10). In an unsplit scan
    // such files are absent in the normal case, so the rule equals the spec text there.
    const forkFrom = (s.primary.meta as MetaF).forked_from_id;
    const extraRecs = new Set<Rec>();
    for (const fa of fileA) {
      if (fa.coverage_only || fa.stream === s.id) continue;
      const exposedPrefix = fa.copy_exposed && forkFrom !== null && fa.own_ids.has(forkFrom);
      const multi = fa.assignment === "conflict" && fa.ident.has(s.id);
      if (exposedPrefix || multi) for (const r of fa.sf.recs) extraRecs.add(r);
    }
    // records of the stream (R4.11): assigned files, own session_metas, its token_usage_records
    const recSet = new Set<Rec>();
    for (const fi of s.assigned) for (const r of (fileAByIndex.get(fi) as FileA).sf.recs) recSet.add(r);
    for (const m of s.own_metas) recSet.add(m);
    for (const r of s.tur) recSet.add(r);
    for (const r of extraRecs) recSet.add(r);
    const recs = [...recSet];
    s.ord_verified = ordinalVerified(recs);
    let start: number | null = null;
    for (const r of recs) if (r.ts !== null && (start === null || r.ts < start)) start = r.ts;
    s.start_ms = start;

    // certain-provenance turn contexts (R4.13 (b)) and markers
    const exposedFiles = new Set(s.assigned.filter((fi) => (fileAByIndex.get(fi) as FileA).copy_exposed));
    const certain = new Set<Rec>();
    const markerSet = new Set<Rec>();
    for (const fi of s.assigned) {
      const fa = fileAByIndex.get(fi) as FileA;
      for (const r of fa.sf.recs) {
        if (r.kind === "marker") markerSet.add(r);
        if (r.kind === "tc" && !exposedFiles.has(fi)) {
          // a record shared with a copy-exposed file is still certain through the file that is not exposed
          certain.add(r);
        }
      }
    }
    s.tcs = [...certain].sort((a, b) => cmpPos(a, b) || cmpKey(a, b));
    for (const r of extraRecs) if (r.kind === "marker") markerSet.add(r);
    s.markers = [...markerSet].sort((a, b) => cmpPos(a, b) || cmpKey(a, b));
    for (const r of extraRecs) {
      if (r.kind !== "tc" || certain.has(r)) continue;
      const t = (r.tc as TcF).turn_id;
      if (t === null) continue;
      let set = s.extra_models_by_turn.get(t);
      if (!set) s.extra_models_by_turn.set(t, (set = new Set()));
      set.add((r.tc as TcF).model);
    }
    for (const tc of s.tcs) {
      const t = (tc.tc as TcF).turn_id;
      if (t === null) continue;
      const arr = s.tcs_by_turn.get(t);
      if (arr) arr.push(tc);
      else s.tcs_by_turn.set(t, [tc]);
    }
    const models = new Set<string>();
    let anyInvalid = false;
    const seeModel = (m: string | null): void => {
      if (m === null) anyInvalid = true;
      else models.add(m);
    };
    for (const tc of s.tcs) seeModel((tc.tc as TcF).model);
    for (const r of extraRecs) if (r.kind === "tc" && !certain.has(r)) seeModel((r.tc as TcF).model);
    s.single_model = !anyInvalid && models.size === 1 ? ([...models][0] as string) : null;

    // fork facts (R4.9)
    const pm = s.primary.meta as MetaF;
    if (pm.forked_from_id !== null) {
      const resolved = s.ord_verified && pm.hist_start !== null;
      s.fork = { from: pm.forked_from_id, hist: pm.hist_start, resolved };
    }
  }

  // ---- R4.13 (c): fork exposure -----------------------------------------------------------------------------------
  // A fork stream S is prefix_exposed iff a copy-exposed file has an own id that is a fork ancestor of S. FA(S) is the
  // forked_from_id of S and, recursively, the forked_from_id of every own session_meta of the scan whose id is already
  // in FA(S) (a cycle stops the recursion). A set property of the scan, independent of order.
  {
    const exposedOwn = new Set<string>();
    for (const fa of fileA) if (fa.copy_exposed) for (const x of fa.own_ids) exposedOwn.add(x);
    if (exposedOwn.size > 0) {
      const forkParents = new Map<string, Set<string>>();
      for (const fa of fileA) {
        if (fa.coverage_only) continue;
        for (const r of fa.sf.recs) {
          if (r.kind !== "meta" || !r.meta) continue;
          const m = r.meta as MetaF;
          if (m.id === null || m.forked_from_id === null || !fa.own_ids.has(m.id) || !FULL_VERSIONS.has(m.label)) continue;
          let set = forkParents.get(m.id);
          if (!set) forkParents.set(m.id, (set = new Set()));
          set.add(m.forked_from_id);
        }
      }
      for (const st of streams) {
        if (st.fork === null) continue;
        const fa = new Set<string>([st.fork.from]);
        const queue = [st.fork.from];
        while (queue.length > 0) {
          const id = queue.pop() as string;
          for (const up of forkParents.get(id) ?? []) {
            if (!fa.has(up)) {
              fa.add(up);
              queue.push(up);
            }
          }
        }
        if ([...fa].some((x) => exposedOwn.has(x))) st.integrity.add("prefix_exposed");
      }
    }
  }

  // ---- unlisted-version copies of copy exposure for copy-exposed streams, versions per file ---------------------
  // line labels for lines that are not session_meta (R15.7)
  for (const fa of fileA) {
    const metas = [...fa.sf.recs].filter((r) => r.kind === "meta" && r.meta);
    const own = metas.filter((r) => fa.own_ids.has((r.meta as MetaF).id ?? "\u0000"));
    const pick = fa.coverage_only ? metas : own.length > 0 ? own : metas;
    const labels = sortedUnique(pick.map((r) => (r.meta as MetaF).label));
    if (labels.length > 0) fa.label = labels[0] as string;
    else if (fa.stream !== null && streamById.has(fa.stream)) fa.label = (streamById.get(fa.stream) as StreamB).label;
    else fa.label = "unlisted";
  }
  for (const fa of fileA) {
    for (const [label, n] of fa.sf.meta_lines) {
      cov.versions[label] = (cov.versions[label] ?? 0) + n;
      if (!FULL_VERSIONS.has(label)) cov.lines_unverified_version += n;
    }
    if (fa.sf.other_lines > 0) {
      cov.versions[fa.label] = (cov.versions[fa.label] ?? 0) + fa.sf.other_lines;
      if (!FULL_VERSIONS.has(fa.label)) cov.lines_unverified_version += fa.sf.other_lines;
    }
  }

  for (const s of streams) {
    cov.streams_total++;
    if (!s.ord_verified) cov.streams_ordinal_unverified++;
    if (s.fork && !s.fork.resolved) cov.streams_fork_prefix_unresolved++;
  }

  // ---- files without response id (R2.9) ------------------------------------------------------------------------
  const orphanTokenCounts = new Set<Rec>();
  for (const sf of scanned) {
    if (!sf.readable) continue;
    let hasTur = false;
    const tokcounts: Rec[] = [];
    for (const r of sf.recs) {
      if (r.kind === "tur") hasTur = true;
      else if (r.kind === "tokcount") tokcounts.push(r);
    }
    if (tokcounts.length > 0 && !hasTur) {
      cov.files_without_response_id++;
      for (const r of tokcounts) orphanTokenCounts.add(r);
    }
  }
  cov.token_count_events_without_response_id = orphanTokenCounts.size;

  // ---- model attribution (R2.10, R2.17) ------------------------------------------------------------------------
  interface Attr {
    source: ModelSource;
    candidate: string | null;
    verified: boolean;
    ctx: Rec | null;
  }
  const attribute = (s: StreamB, rec: Rec): Attr => {
    const tur = rec.tur as TurF;
    // R2.10: an integrity_unverified stream verifies no model through any row. These two rows override all others.
    if (s.integrity.has("prefix_exposed")) return { source: "prefix_exposed", candidate: null, verified: false, ctx: null };
    if (s.integrity.size > 0) return { source: "stream_unverified", candidate: null, verified: false, ctx: null };
    const hasMarker = s.markers.length > 0;
    const own = tur.turn_id !== null ? s.tcs_by_turn.get(tur.turn_id) : undefined;
    if (own !== undefined && own.length > 0) {
      const earliest = own[0] as Rec; // tcs_by_turn inherits the position order of s.tcs
      const ms = new Set(own.map((t) => (t.tc as TcF).model));
      for (const m of s.extra_models_by_turn.get(tur.turn_id as string) ?? []) ms.add(m);
      const single = ms.size === 1 ? ([...ms][0] as string | null) : null;
      let settingsExcluded = !hasMarker;
      if (hasMarker && s.ord_verified && s.integrity.size === 0 && earliest.ord !== null && rec.ord !== null) {
        // "between" is symmetric: a usage record can be logged before the context of its own turn.
        let eo = earliest.ord;
        for (const t of own) if ((t.ord ?? Number.POSITIVE_INFINITY) < eo) eo = t.ord as number;
        const lo = Math.min(eo, rec.ord);
        const hi = Math.max(eo, rec.ord);
        settingsExcluded = !s.markers.some((m) => m.ord !== null && m.ord > lo && m.ord < hi);
      }
      if (single !== null && settingsExcluded) return { source: "own_turn", candidate: single, verified: true, ctx: earliest };
      return { source: "own_turn_unsettled", candidate: single, verified: false, ctx: earliest };
    }
    // carried: the context with the greatest (timestamp, ordinal) before the record (R2.10)
    let lo = 0;
    let hi = s.tcs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cmpPos(s.tcs[mid] as Rec, rec) < 0) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return { source: "none", candidate: null, verified: false, ctx: null };
    const tc = s.tcs[lo - 1] as Rec;
    const cand = (tc.tc as TcF).model;
    if (s.ord_verified && s.fork && s.fork.resolved && tc.ord !== null && s.fork.hist !== null && tc.ord < s.fork.hist) {
      return { source: "inherited_prefix", candidate: cand, verified: false, ctx: tc };
    }
    const verified =
      s.ord_verified && s.integrity.size === 0 && (s.fork === null || (s.fork.resolved && tc.ord !== null && s.fork.hist !== null && tc.ord >= s.fork.hist)) &&
      s.single_model !== null && !hasMarker;
    return { source: verified ? "carried_verified" : "carried_unverified", candidate: cand, verified, ctx: tc };
  };

  // ---- classify every token_usage_record Rec ------------------------------------------------------------------
  const excluded: ExcludedRecord[] = [];
  const unverifiedKeys = new Set<string>();
  const verifiedKeyed = new Map<string, Rec[]>(); // response_id -> distinct Recs (mappable, supported version)

  const filesOf = (rec: Rec): number[] => [...rec.files].sort((a, b) => a - b);
  for (const rec of turRecs) {
    const tur = rec.tur as TurF;
    const verifiedFile = verifiedFileOf(rec);
    const stream = tur.thread_id !== null ? streamById.get(tur.thread_id) : undefined;
    const versionOk = verifiedFile && (tur.thread_id === null || stream !== undefined);
    if (!versionOk) {
      // R15.7: coverage only. Counted, never accounted.
      if (tur.response_id !== null) unverifiedKeys.add(tur.response_id);
      if (stream !== undefined) {
        excluded.push({ provider: "codex", chain: stream.chain, reason: "unverified_version", event_ms: rec.ts ?? 0, ordinal: rec.ord, files: filesOf(rec) });
      }
      continue;
    }
    cov.records_usage_bearing++;
    if (tur.tt_state === "range") cov.fields_range_failed++;
    if (tur.response_id === null) {
      cov.records_unkeyed++; // R2.13
      if (stream !== undefined) {
        excluded.push({ provider: "codex", chain: stream.chain, reason: "unkeyed", event_ms: rec.ts ?? 0, ordinal: rec.ord, files: filesOf(rec) });
      }
      continue;
    }
    if (tur.thread_id === null) {
      cov.records_usage_unmappable++; // cannot be mapped to a chain, accounted nowhere
      continue;
    }
    if (tur.us.some((x) => x === "missing") || rec.ts === null) cov.records_usage_unmappable++; // R2.12, R17.3 drift_unmappable
    const arr = verifiedKeyed.get(tur.response_id);
    if (arr) arr.push(rec);
    else verifiedKeyed.set(tur.response_id, [rec]);
  }
  cov.requests_unverified_version = unverifiedKeys.size;
  if (cov.requests_unverified_version > 0 || cov.lines_unverified_version > 0) assumptions.add("unverified_version");

  // ---- responses ----------------------------------------------------------------------------------------------
  const responses: CodexResponse[] = [];
  const conflicts: DedupConflict[] = [];
  const attrCache = new Map<Rec, Attr>();
  const attrOf = (rec: Rec): Attr => {
    let a = attrCache.get(rec);
    if (a === undefined) {
      a = attribute(streamById.get((rec.tur as TurF).thread_id as string) as StreamB, rec);
      attrCache.set(rec, a);
    }
    return a;
  };

  const build = (rec: Rec, exclusion: CodexResponse["exclusion"], usage: UsageBuckets | null, extraFiles: readonly number[]): CodexResponse => {
    const tur = rec.tur as TurF;
    const stream = streamById.get(tur.thread_id as string) as StreamB;
    const a = attrOf(rec);
    const ctxTc = a.ctx?.tc;
    const ev = rec.ts ?? 0;
    const fileList = extraFiles.length > 0 ? [...new Set([...filesOf(rec), ...extraFiles])].sort((x, y) => x - y) : filesOf(rec);
    const model: ModelAttribution = { candidate: a.candidate, verified: a.verified, source: a.source, model: a.verified ? a.candidate : null };
    const flags: ResponseFlag[] = [];
    return {
      provider: "codex",
      key: tur.response_id as string,
      chain: stream.chain,
      kind: kindOf(stream),
      version: stream.label,
      support: "full" as SupportLevel,
      model,
      usage,
      exclusion,
      flags,
      modifiers: { speed: null, inference_geo: null, service_tier: null },
      effort: ctxTc?.effort ?? null,
      time: { event_ms: ev, t_first_ms: ev, t_last_ms: ev, t_asm_ms: null, start_lo_ms: null, start_hi_ms: ev, gap_basis: "none" },
      ordinal: rec.ord,
      ownership: { role: "owner", ambiguous: false, owner_stream_start_ms: stream.start_ms },
      provenance: { files: fileList, from_copy_exposed_file: fileList.some((fi) => (fileAByIndex.get(fi) as FileA).copy_exposed) },
      thread_id: stream.id,
      session_id: tur.session_id ?? stream.root,
      turn_id: tur.turn_id,
      root_turn_id: ctxTc?.root_turn_id ?? null,
      comp_hash: ctxTc?.comp_hash ?? null,
      collaboration_mode: ctxTc?.collab ?? null,
      thread_total: tur.tt !== null ? BigInt(tur.tt) : null,
    };
  };

  const keys = [...verifiedKeyed.keys()].sort();
  for (const key of keys) {
    const recs = (verifiedKeyed.get(key) as Rec[]).slice().sort(cmpKey);
    cov.requests_total++;
    cov.responses_total++;
    if (recs.length > 1) {
      // R4.4: not every occurrence is the same record.
      const sameUsage = recs.every((r) => usageKey(r) === usageKey(recs[0] as Rec));
      const kind = sameUsage ? "conflict_attribution" : "conflict_usage";
      cov.requests_conflict++;
      cov.requests_conflict_by_kind[kind]++;
      const allFiles = [...new Set(recs.flatMap((r) => filesOf(r)))].sort((x, y) => x - y);
      conflicts.push({ provider: "codex", kind, key, files: allFiles, effect: "excluded" });
      // one excluded entry per (key, chain), at the earliest position of that chain
      const perChain = new Map<string, Rec>();
      for (const r of recs) {
        const cs = chainStr(streamById.get((r.tur as TurF).thread_id as string) as StreamB);
        const cur = perChain.get(cs);
        if (cur === undefined || cmpPos(r, cur) < 0) perChain.set(cs, r);
      }
      for (const r of perChain.values()) responses.push(build(r, kind, null, allFiles));
      continue;
    }
    const rec = recs[0] as Rec;
    const tur = rec.tur as TurF;
    const st = tur.us;
    const missing = st.some((x) => x === "missing") || rec.ts === null;
    const range = st.some((x) => x === "range");
    if (missing) {
      // R2.12: never treated as 0. Present counters that pass R2.15 are reported (input and output are the base fields).
      if (st[U_IN] === "ok") cov.tokens_in_incomplete_responses += BigInt(tur.u[U_IN] as number);
      if (st[U_OUT] === "ok") cov.tokens_in_incomplete_responses += BigInt(tur.u[U_OUT] as number);
      responses.push(build(rec, "usage_incomplete", null, []));
      continue;
    }
    if (range) {
      // R2.15: removed from accounting entirely, raw values not stored.
      cov.responses_usage_range_failed++;
      responses.push(build(rec, "usage_range_failed", null, []));
      continue;
    }
    const inn = BigInt(tur.u[U_IN] as number);
    const c = BigInt(tur.u[U_C] as number);
    const cw = BigInt(tur.u[U_CW] as number);
    const out = BigInt(tur.u[U_OUT] as number);
    const rs = BigInt(tur.u[U_RS] as number);
    const total = BigInt(tur.u[U_TOTAL] as number);
    // R2.7 validity invariants, all in BigInt (R2.16)
    if (c + cw > inn || rs > out || total !== inn + out) {
      cov.responses_usage_invariant_failed++;
      cov.tokens_in_invalid_responses += inn + out;
      responses.push(build(rec, "usage_invariant_failed", null, []));
      continue;
    }
    const usage: UsageBuckets = {
      input_uncached: inn - c - cw, // R2.6
      cache_read: c,
      cache_write_5m: 0n,
      cache_write_1h: 0n,
      cache_write_unknown_ttl: 0n,
      cache_write: cw, // R2.11 bucket w_openai
      output: out, // R2.8: includes reasoning
      output_lower_bound: out,
      reasoning: rs,
      reasoning_included_in_output: true,
    };
    responses.push(build(rec, null, usage, []));
  }

  // ---- fork_first_own flag (R4.8, R4.9) ------------------------------------------------------------------------
  const byChain = new Map<string, CodexResponse[]>();
  for (const r of responses) {
    const cs = chainKeyOf(r.chain);
    const arr = byChain.get(cs);
    if (arr) arr.push(r);
    else byChain.set(cs, [r]);
  }
  const finalResponses: CodexResponse[] = [];
  for (const s of streams) {
    const list = byChain.get(chainKeyOf(s.chain)) ?? [];
    if (s.fork && list.length > 0) {
      const kept = list.filter((r) => r.exclusion === null);
      if (kept.length > 0) {
        let minT = Number.POSITIVE_INFINITY;
        for (const r of kept) if (r.time.event_ms < minT) minT = r.time.event_ms;
        for (const r of list) {
          if (r.exclusion === null && r.time.event_ms === minT) {
            finalResponses.push({ ...r, flags: [...r.flags, "fork_first_own"] });
          } else finalResponses.push(r);
        }
        continue;
      }
    }
    for (const r of list) finalResponses.push(r);
  }
  finalResponses.sort((a, b) => {
    const ca = chainKeyOf(a.chain);
    const cb = chainKeyOf(b.chain);
    if (ca !== cb) return ca < cb ? -1 : 1;
    if (a.time.event_ms !== b.time.event_ms) return a.time.event_ms - b.time.event_ms;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  for (const r of finalResponses) {
    if (r.exclusion === null && !r.model.verified) cov.responses_model_unverified++;
  }
  conflicts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  excluded.sort((a, b) => {
    const ca = chainKeyOf(a.chain);
    const cb = chainKeyOf(b.chain);
    if (ca !== cb) return ca < cb ? -1 : 1;
    if (a.event_ms !== b.event_ms) return a.event_ms - b.event_ms;
    if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
    return (a.ordinal ?? -1) - (b.ordinal ?? -1);
  });

  // ---- streams, links, compactions, thread totals ---------------------------------------------------------------
  for (const s of streams) if (s.integrity.size > 0) cov.streams_integrity_unverified++;

  const streamOut: Stream[] = streams.map((s) => {
    const fork: ForkInfo | null = s.fork ? { forked_from_id: s.fork.from, history_start_ordinal: s.fork.hist, prefix_resolved: s.fork.resolved } : null;
    return {
      chain: s.chain,
      provider: "codex",
      files: [...s.files].sort((a, b) => a - b),
      start_ms: s.start_ms,
      ordinal_verified: s.ord_verified,
      integrity_unverified: s.integrity.size > 0,
      integrity_reasons: [...s.integrity].sort(),
      fork,
      has_settings_marker: s.markers.length > 0,
    };
  });

  const links: Link[] = [];
  for (const s of streams) {
    const kind = kindOf(s);
    const pm = s.primary.meta as MetaF;
    if (kind !== "subagent" && !pm.has_subagent) continue; // R5.6: a source.subagent.other thread is checked for linkage too
    let reason: UnlinkedReason | null = null;
    let parent: ChainKey | null = null;
    if (pm.subagent_other && !pm.has_spawn) reason = "other_source";
    else if (pm.spawn_parent === null) reason = "no_parent_id"; // R5.6: also thread_source subagent without thread_spawn
    else if (pm.forked_from_id !== null && pm.forked_from_id !== pm.spawn_parent) reason = "fork_parent_mismatch";
    else {
      const ps = streamById.get(pm.spawn_parent);
      if (ps === undefined) reason = "parent_file_missing";
      else if (ps.root !== s.root) reason = "root_mismatch";
      else parent = ps.chain;
    }
    links.push({
      chain: s.chain,
      kind: "subagent",
      state: reason === null ? "verified" : "unlinked",
      reason,
      parent,
      depth: pm.spawn_depth,
      is_fork: pm.forked_from_id !== null,
    });
    if (reason === null) cov.links_verified++;
    else {
      cov.links_unlinked++;
      cov.links_unlinked_by_reason[reason]++;
    }
  }

  const compactions: CodexCompaction[] = [];
  {
    // R4.9: owned by the logical stream where it first appears by stream_start (a minimum, order independent).
    const seen = new Map<Rec, StreamB[]>();
    for (const s of streams) {
      for (const fi of s.assigned) {
        for (const r of (fileAByIndex.get(fi) as FileA).sf.recs) {
          if (r.kind !== "compacted") continue;
          const arr = seen.get(r);
          if (arr) {
            if (!arr.includes(s)) arr.push(s);
          } else seen.set(r, [s]);
        }
      }
    }
    for (const [r, owners] of seen) {
      owners.sort((a, b) => {
        const as = a.start_ms ?? Number.POSITIVE_INFINITY;
        const bs = b.start_ms ?? Number.POSITIVE_INFINITY;
        if (as !== bs) return as - bs;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      const o = owners[0] as StreamB;
      const comp = r.comp as CompF;
      compactions.push({
        chain: o.chain,
        ordinal: r.ord,
        ts_ms: r.ts,
        window_number: comp.window_number,
        latest_usage_is_null: comp.latest_null,
        in_copied_prefix: o.fork !== null && o.fork.resolved && o.fork.hist !== null && r.ord !== null && r.ord < o.fork.hist,
      });
    }
    compactions.sort((a, b) => {
      const ca = chainKeyOf(a.chain);
      const cb = chainKeyOf(b.chain);
      if (ca !== cb) return ca < cb ? -1 : 1;
      return (a.ordinal ?? -1) - (b.ordinal ?? -1) || (a.ts_ms ?? 0) - (b.ts_ms ?? 0);
    });
  }

  // R13.6 inputs
  const thread_totals: CodexThreadTotal[] = [];
  for (const s of streams) {
    const list = byChain.get(chainKeyOf(s.chain)) ?? [];
    if (list.length === 0) continue;
    const kept = list.filter((r) => r.exclusion === null);
    if (kept.length === 0) continue;
    // keep the record order: by (event time, ordinal, key)
    kept.sort((a, b) => a.time.event_ms - b.time.event_ms || (a.ordinal ?? -1) - (b.ordinal ?? -1) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let summed = 0n;
    let prev = 0n;
    let complete = list.length === kept.length;
    for (const r of kept) {
      const u = r.usage as UsageBuckets;
      const own = u.input_uncached + u.cache_read + u.cache_write + (u.output as bigint);
      summed += own;
      if (r.thread_total === null || r.thread_total !== prev + own) complete = false;
      prev = r.thread_total ?? prev + own;
    }
    const first = kept[0] as CodexResponse;
    const fu = first.usage as UsageBuckets;
    const firstOwn = fu.input_uncached + fu.cache_read + fu.cache_write + (fu.output as bigint);
    const last = kept[kept.length - 1] as CodexResponse;
    thread_totals.push({
      chain: s.chain,
      last_thread_total: last.thread_total,
      summed_total_tokens: summed,
      chain_complete: complete,
      starts_in_continuation: first.thread_total !== null && first.thread_total !== firstOwn,
    });
  }

  // ---- files ---------------------------------------------------------------------------------------------------
  const fileInfos: FileInfo[] = scanned.map((sf) => {
    const fa = fileAByIndex.get(sf.index);
    if (!sf.readable || fa === undefined) {
      return {
        index: sf.index, provider: "codex", source_kind: sf.df.kind, versions: [], support: "coverage_only", readable: false,
        archived: sf.df.kind === "codex-archived-zst", stream_assignment: "unassigned", copy_exposed: false, without_response_id: false, lines: 0,
      };
    }
    let hasTur = false;
    let hasTok = false;
    for (const r of sf.recs) {
      if (r.kind === "tur") hasTur = true;
      else if (r.kind === "tokcount") hasTok = true;
    }
    let support: SupportLevel = "coverage_only";
    if (!fa.coverage_only) {
      const metaSupported = [...sf.recs].some((r) => r.kind === "meta" && r.meta && FULL_VERSIONS.has(r.meta.label));
      support = metaSupported || (fa.stream !== null && streamById.has(fa.stream)) ? "full" : "coverage_only";
    }
    return {
      index: sf.index, provider: "codex", source_kind: sf.df.kind, versions: fa.versions, support, readable: true,
      archived: sf.df.kind === "codex-archived-zst", stream_assignment: fa.assignment, copy_exposed: fa.copy_exposed,
      without_response_id: hasTok && !hasTur, lines: sf.lines,
    };
  });

  return {
    provider: "codex",
    responses: finalResponses,
    excluded,
    coverage: cov,
    conflicts,
    links,
    streams: streamOut,
    files: fileInfos,
    assumptions: [...assumptions].sort(),
    compactions,
    thread_totals,
    forked_from_ids: FS,
  };
}

// ---------------------------------------------------------------------------
// Helpers shared by the assembly code
// ---------------------------------------------------------------------------

function usageKey(rec: Rec): string {
  const t = rec.tur as TurF;
  return JSON.stringify([t.us.map((s, i) => (s === "ok" ? t.u[i] : s === "range" ? "r" : null))]);
}

function chainKeyOf(k: ChainKey): string {
  return `${k.provider}\u0000${k.root_session}\u0000${k.thread}`;
}

function chainStr(s: StreamB): string {
  return chainKeyOf(s.chain);
}

/** R5.2 request kind of a Codex chain, from the stream's own session_meta. */
function kindOf(s: StreamB): RequestKind {
  const m = s.primary.meta as MetaF;
  // R5.2: thread_spawn present, or thread_source subagent / agent_created_thread. `source.subagent.other` alone does not
  // make a subagent (it only gives the link reason other_source, R5.6), so a guardian_review thread stays a classifier.
  if (m.has_spawn || m.thread_source === "subagent" || m.thread_source === "agent_created_thread") return "subagent";
  if (m.thread_source === "automation") return "helper";
  if (m.thread_source === "guardian_review") return "classifier";
  return "main";
}

// Compile-time check that the exported function has the shared interface (src/model/types.ts).
export const parseCodexTyped: ParseCodex = parseCodex;
