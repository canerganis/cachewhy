// Conversation graph (spec sections 4.11, 5, 6 and the structural half of 9.2).
//
// buildGraph merges parse results into one Graph: chains keyed by R5.1, one logical stream per chain (R4.11),
// chain order (R6.1), previous request P(C) (R6.2), ties, excluded-between, the TTL set (R9.2), gap bounds
// (R6.4 to R6.6), the report window (R5.9, R5.10) and the cross-chain checks of the linkage rules (R5.3 to R5.7).
// It makes no eligibility, boundary or numeric decision (that is section 7) and reads no file.
//
// Inputs are plain parse results. Everything is keyed by identity (chain key, response key), never by physical file
// position, so the output does not depend on the order of the parse results, of the responses inside them, or on how
// a thread is split across files (R4.10, R4.11). Raw ids stay inside the process (R14.4).

import {
  ASSUMPTIONS,
  PROVIDERS,
  STREAM_INTEGRITY_REASONS,
  UNLINKED_REASONS,
  cachedPrefix,
  chainKeyString,
  countsInTotals,
} from "../model/types.js";
import type {
  Assumption,
  BuildGraph,
  Chain,
  ChainKey,
  ClaudeCompactBoundary,
  ClaudeParseResult,
  ClaudeUuidNode,
  CodexCompaction,
  EpochMs,
  ExcludedRecord,
  FileIndex,
  FileInfo,
  GapBounds,
  Graph,
  GraphNode,
  GraphOptions,
  Link,
  ParseResult,
  Provider,
  RequestKind,
  Response,
  Stream,
  StreamIntegrityReason,
  TtlSet,
  UnlinkedReason,
  UsageBuckets,
} from "../model/types.js";

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Code-unit string order. Never locale dependent, so output is identical on every machine. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpNum(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function providerRank(p: Provider): number {
  return PROVIDERS.indexOf(p);
}

function compareChainKeys(a: ChainKey, b: ChainKey): number {
  return providerRank(a.provider) - providerRank(b.provider) || cmp(a.root_session, b.root_session) || cmp(a.thread, b.thread);
}

function usageEqual(a: UsageBuckets | null, b: UsageBuckets | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.input_uncached === b.input_uncached &&
    a.cache_read === b.cache_read &&
    a.cache_write_5m === b.cache_write_5m &&
    a.cache_write_1h === b.cache_write_1h &&
    a.cache_write_unknown_ttl === b.cache_write_unknown_ttl &&
    a.cache_write === b.cache_write &&
    a.output === b.output &&
    a.output_lower_bound === b.output_lower_bound &&
    a.reasoning === b.reasoning
  );
}

function sortedUnique(xs: readonly number[]): number[] {
  return [...new Set(xs)].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// file index normalisation
// ---------------------------------------------------------------------------

/**
 * Parsers may index a shared file list (disjoint indices across providers) or each their own list (overlapping
 * indices). If the index sets of the parse results are pairwise disjoint they are kept; otherwise each result is
 * shifted by the size of the earlier ones, so every FileIndex in the graph names exactly one file.
 */
function fileOffsets(parsed: readonly ParseResult[]): number[] {
  const sets = parsed.map((p) => {
    const s = new Set<number>();
    for (const f of p.files) s.add(f.index);
    for (const r of p.responses) for (const i of r.provenance.files) s.add(i);
    for (const e of p.excluded) for (const i of e.files) s.add(i);
    for (const st of p.streams) for (const i of st.files) s.add(i);
    return s;
  });
  const seen = new Set<number>();
  let overlap = false;
  for (const s of sets) {
    for (const i of s) {
      if (seen.has(i)) overlap = true;
    }
    for (const i of s) seen.add(i);
  }
  if (!overlap) return parsed.map(() => 0);
  const offsets: number[] = [];
  let next = 0;
  for (const s of sets) {
    offsets.push(next);
    let max = -1;
    for (const i of s) if (i > max) max = i;
    next += max + 1;
  }
  return offsets;
}

function shiftFiles(files: readonly FileIndex[], off: number): FileIndex[] {
  return off === 0 ? [...files] : files.map((i) => i + off);
}

function shiftResponse(r: Response, off: number): Response {
  if (off === 0) return r;
  return { ...r, provenance: { ...r.provenance, files: shiftFiles(r.provenance.files, off) } };
}

// ---------------------------------------------------------------------------
// duplicate responses inside one chain (idempotence of repeated input)
// ---------------------------------------------------------------------------

function compareCopies(a: Response, b: Response): number {
  const ra = a.ownership.role === "owner" ? 0 : 1;
  const rb = b.ownership.role === "owner" ? 0 : 1;
  return (
    ra - rb ||
    cmpNum(a.time.event_ms, b.time.event_ms) ||
    cmp(a.provenance.files.join(","), b.provenance.files.join(","))
  );
}

/**
 * Two occurrences of the same (provider, key, chain). The parsers already collapse these (R4.1, R4.2, R4.4); this
 * only keeps the graph well defined (and single-counted, R5.8) if a caller hands over overlapping results. Equal
 * counters collapse. Unequal counters are the conflict of R4.4 and the response is removed from accounting.
 */
function mergeSameKey(copies: Response[]): Response {
  const sorted = [...copies].sort(compareCopies);
  const first = sorted[0] as Response;
  const files = sortedUnique(sorted.flatMap((c) => [...c.provenance.files]));
  const exposed = sorted.some((c) => c.provenance.from_copy_exposed_file);
  const provenance = { files, from_copy_exposed_file: exposed };
  const excludedOne = sorted.find((c) => c.exclusion !== null);
  const keptOnes = sorted.filter((c) => c.exclusion === null);
  if (excludedOne !== undefined) {
    // A copy that was already removed stays removed. The conservative view wins.
    return { ...excludedOne, provenance };
  }
  const base = keptOnes[0] as Response;
  const allEqual = keptOnes.every((c) => usageEqual(c.usage, base.usage));
  if (allEqual) return { ...first, provenance };
  return {
    ...first,
    usage: null,
    exclusion: first.provider === "codex" ? "conflict_usage" : "conflict_input",
    provenance,
  };
}

// ---------------------------------------------------------------------------
// streams
// ---------------------------------------------------------------------------

function tri(values: readonly (boolean | null)[]): boolean | null {
  if (values.some((v) => v === false)) return false;
  if (values.some((v) => v === true)) return true;
  return null;
}

function orderedReasons(set: ReadonlySet<StreamIntegrityReason>): StreamIntegrityReason[] {
  return STREAM_INTEGRITY_REASONS.filter((r) => set.has(r));
}

/**
 * One Stream per chain (R4.11): all Stream records and all files of the same identity form one logical stream.
 * A chain with responses but no Stream record is never trusted: it is treated as unresolved (no guessing, R4.11).
 */
function mergeStreams(key: ChainKey, records: readonly Stream[], fileInfo: ReadonlyMap<number, FileInfo>, responses: readonly Response[]): Stream {
  const reasons = new Set<StreamIntegrityReason>();
  let unverified = false;
  let files: number[];
  let start: number | null;
  let ordinal: boolean | null;
  let fork = null as Stream["fork"];
  let settings = false;

  if (records.length === 0) {
    files = sortedUnique(responses.flatMap((r) => [...r.provenance.files]));
    const starts = responses.map((r) => r.ownership.owner_stream_start_ms).filter((x): x is EpochMs => x !== null);
    start = starts.length > 0 ? Math.min(...starts) : null;
    ordinal = key.provider === "codex" ? false : null;
    unverified = responses.length > 0;
    if (unverified) reasons.add("stream_missing");
  } else {
    const sorted = [...records].sort(
      (a, b) =>
        cmp(a.files.join(","), b.files.join(",")) ||
        cmpNum(a.start_ms ?? Infinity, b.start_ms ?? Infinity),
    );
    files = sortedUnique(sorted.flatMap((s) => [...s.files]));
    const starts = sorted.map((s) => s.start_ms).filter((x): x is EpochMs => x !== null);
    start = starts.length > 0 ? Math.min(...starts) : null;
    ordinal = key.provider === "claude" ? null : tri(sorted.map((s) => s.ordinal_verified));
    for (const s of sorted) {
      if (s.integrity_unverified) unverified = true;
      for (const r of s.integrity_reasons) reasons.add(r);
      if (s.has_settings_marker) settings = true;
      if (s.fork !== null) {
        if (fork === null) {
          fork = s.fork;
        } else if (
          fork.forked_from_id !== s.fork.forked_from_id ||
          fork.history_start_ordinal !== s.fork.history_start_ordinal
        ) {
          // R4.11: two own session_meta records with the same id that differ in forked_from_id or history start.
          unverified = true;
          reasons.add("divergent_session_meta");
        } else if (!s.fork.prefix_resolved) {
          fork = { ...fork, prefix_resolved: false };
        }
      }
    }
    // A stream where some parse result saw a fork and another did not is divergent too.
    if (fork !== null && sorted.some((s) => s.fork === null) && key.provider === "codex") {
      unverified = true;
      reasons.add("divergent_session_meta");
    }
  }

  // R4.13: a copy-exposed file makes every stream of that file integrity_unverified. Derived here from the file
  // facts as well, so the gate cannot be bypassed by a Stream record that forgot it.
  for (const i of files) {
    const fi = fileInfo.get(i);
    if (fi?.copy_exposed === true) {
      unverified = true;
      reasons.add("copy_exposed_file");
    }
  }
  if (reasons.size > 0) unverified = true;

  return {
    chain: key,
    provider: key.provider,
    files,
    start_ms: start,
    ordinal_verified: ordinal,
    integrity_unverified: unverified,
    integrity_reasons: orderedReasons(reasons),
    fork,
    has_settings_marker: settings,
  };
}

// ---------------------------------------------------------------------------
// links (R5.3 to R5.7). Cross-chain checks only: reading files is the parser's job.
// ---------------------------------------------------------------------------

const LINK_RANK = { unlinked: 0, directory: 1, verified: 2 } as const;

function defaultUnlinkedReason(provider: Provider, kind: "subagent" | "workflow_agent"): UnlinkedReason {
  if (kind === "workflow_agent") return "no_journal_entry";
  return provider === "claude" ? "no_meta" : "no_parent_id";
}

function pickLink(links: readonly Link[]): Link | null {
  if (links.length === 0) return null;
  // Several records for one chain: the least verified one wins (a link is only as good as its weakest evidence).
  return [...links].sort(
    (a, b) =>
      LINK_RANK[a.state] - LINK_RANK[b.state] ||
      cmp(a.reason ?? "", b.reason ?? "") ||
      cmp(a.parent === null ? "" : chainKeyString(a.parent), b.parent === null ? "" : chainKeyString(b.parent)),
  )[0] as Link;
}

function unlinked(link: Link, reason: UnlinkedReason, parent: ChainKey | null, isFork: boolean): Link {
  return { chain: link.chain, kind: link.kind, state: "unlinked", reason, parent, depth: link.depth, is_fork: isFork };
}

function validateLink(link: Link, stream: Stream, chains: ReadonlyMap<string, unknown>): Link {
  const provider = link.chain.provider;
  const isFork = provider === "codex" ? stream.fork !== null : link.is_fork;
  const base = { chain: link.chain, kind: link.kind, depth: link.depth, is_fork: isFork };
  const fallback = defaultUnlinkedReason(provider, link.kind);

  if (link.kind === "workflow_agent") {
    // R5.4: never verified. `directory` is the best a workflow agent can reach.
    if (link.state === "unlinked") return { ...base, state: "unlinked", reason: link.reason ?? fallback, parent: link.parent };
    return { ...base, state: "directory", reason: null, parent: link.parent };
  }

  // Subagent chains: `directory` does not exist for them (R5.3, R5.6).
  if (link.state !== "verified") return { ...base, state: "unlinked", reason: link.reason ?? fallback, parent: link.parent };

  const parent = link.parent;
  const parentKnown = parent !== null && parent !== undefined && chains.has(chainKeyString(parent));
  if (!parentKnown) return unlinked(link, "parent_file_missing", null, isFork);
  if (chainKeyString(parent) === chainKeyString(link.chain)) return unlinked(link, "parent_file_missing", null, isFork);

  if (provider === "claude") {
    // R5.3 item 2 and 3: same session; depth 1 or absent has the main file as parent, depth 2 an agent file.
    if (parent.root_session !== link.chain.root_session) return unlinked(link, "session_mismatch", parent, isFork);
    const parentIsMain = parent.thread === "main";
    const depth2 = link.depth === 2;
    if (depth2 === parentIsMain) return unlinked(link, "parent_agent_mismatch", parent, isFork);
  } else {
    // R5.6 item 4 (same session) and item 2 (a fork's parent is the spawn parent).
    if (parent.root_session !== link.chain.root_session) return unlinked(link, "root_mismatch", parent, isFork);
    if (stream.fork !== null && stream.fork.forked_from_id !== parent.thread) {
      return unlinked(link, "fork_parent_mismatch", parent, isFork);
    }
  }
  return { ...base, state: "verified", reason: null, parent };
}

// ---------------------------------------------------------------------------
// TTL sets (R9.2)
// ---------------------------------------------------------------------------

/** The eight possible sets are shared frozen objects, so a million nodes allocate nothing here. */
const TTL_SETS: readonly TtlSet[] = (() => {
  const out: TtlSet[] = [];
  for (let bits = 0; bits < 8; bits++) {
    out.push(Object.freeze({ has_5m: (bits & 1) !== 0, has_1h: (bits & 2) !== 0, ttl_unknown: (bits & 4) !== 0 }));
  }
  return out;
})();

// ---------------------------------------------------------------------------
// timing (R6.3 to R6.6)
// ---------------------------------------------------------------------------

function startHi(r: Response): number {
  return r.provider === "claude" ? r.time.t_first_ms : r.time.event_ms;
}

/** R6.4 for Claude; R6.5: always unknown for Codex. */
function startLo(r: Response, uuidIndex: ReadonlyMap<string, ClaudeUuidNode>): number | null {
  if (r.provider !== "claude") return null;
  let asm = r.time.t_asm_ms;
  if (asm === null && r.parent_uuid !== null) asm = uuidIndex.get(r.parent_uuid)?.ts_ms ?? null; // R6.3
  return asm !== null && asm <= r.time.t_first_ms ? asm : null;
}

function gapBounds(p: Response, c: Response, uuidIndex: ReadonlyMap<string, ClaudeUuidNode>): GapBounds {
  const loC = startLo(c, uuidIndex);
  const loP = startLo(p, uuidIndex);
  const min = loC === null ? null : Math.max(0, loC - startHi(p)); // clamped (R6.6)
  const max = loP === null ? null : startHi(c) - loP;
  return { min_ms: min, max_ms: max, basis: min !== null || max !== null ? "parent_record" : "none" };
}

// ---------------------------------------------------------------------------
// buildGraph
// ---------------------------------------------------------------------------

interface ChainBuild {
  key: ChainKey;
  ks: string;
  responses: Map<string, Response[]>;
  excluded: ExcludedRecord[];
  streams: Stream[];
  links: Link[];
}

type Item = { t: number; r: Response; e: null } | { t: number; r: null; e: ExcludedRecord };

function compareItems(a: Item, b: Item): number {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  if (a.r !== null && b.r !== null) return cmp(a.r.key, b.r.key);
  if (a.r !== null) return -1; // responses before keyless records at an equal instant (both are a tie anyway)
  if (b.r !== null) return 1;
  const ea = a.e as ExcludedRecord;
  const eb = b.e as ExcludedRecord;
  return (
    cmpNum(ea.ordinal ?? -1, eb.ordinal ?? -1) ||
    cmp(ea.reason, eb.reason) ||
    cmp(ea.files.join(","), eb.files.join(","))
  );
}

export const buildGraph: BuildGraph = (parsedIn: readonly ParseResult[], opts: GraphOptions): Graph => {
  const window = opts.window;
  // Same object twice is the same input; different objects are different inputs (offsets keep files distinct).
  const parsed = [...new Set(parsedIn)].sort((a, b) => providerRank(a.provider) - providerRank(b.provider));
  const offsets = fileOffsets(parsed);

  // ---- files ----------------------------------------------------------------------------------------------
  const fileInfos: FileInfo[] = [];
  parsed.forEach((p, k) => {
    const off = offsets[k] as number;
    for (const f of p.files) fileInfos.push({ ...f, index: f.index + off });
  });
  fileInfos.sort((a, b) => a.index - b.index);
  const fileInfo = new Map<number, FileInfo>();
  for (const f of fileInfos) if (!fileInfo.has(f.index)) fileInfo.set(f.index, f);

  // ---- group everything by chain key (R5.1). File membership plays no role. ---------------------------------
  const builds = new Map<string, ChainBuild>();
  const getBuild = (key: ChainKey): ChainBuild => {
    const ks = chainKeyString(key);
    let b = builds.get(ks);
    if (b === undefined) {
      b = { key, ks, responses: new Map(), excluded: [], streams: [], links: [] };
      builds.set(ks, b);
    }
    return b;
  };

  const assumptions = new Set<Assumption>();
  const uuidEntries: [string, ClaudeUuidNode][] = [];
  const boundaries = new Map<string, ClaudeCompactBoundary>();
  const compactions: CodexCompaction[] = [];

  parsed.forEach((p, k) => {
    const off = offsets[k] as number;
    for (const a of p.assumptions) assumptions.add(a);
    for (const r of p.responses) {
      const b = getBuild(r.chain);
      const list = b.responses.get(r.key);
      const moved = shiftResponse(r, off);
      if (list === undefined) b.responses.set(r.key, [moved]);
      else list.push(moved);
    }
    for (const e of p.excluded) getBuild(e.chain).excluded.push({ ...e, files: shiftFiles(e.files, off) });
    for (const s of p.streams) getBuild(s.chain).streams.push({ ...s, files: shiftFiles(s.files, off) });
    for (const l of p.links) getBuild(l.chain).links.push(l);
    const cp = p as Partial<ClaudeParseResult>;
    if (cp.uuid_index !== undefined) for (const e of cp.uuid_index) uuidEntries.push(e);
    if (cp.compact_boundaries !== undefined) {
      for (const cb of cp.compact_boundaries) {
        // R4.7: duplicated compact_boundary records collapse on uuid.
        if (!boundaries.has(cb.uuid)) boundaries.set(cb.uuid, cb);
      }
    }
    const xp = p as { compactions?: readonly CodexCompaction[] };
    if (xp.compactions !== undefined) compactions.push(...xp.compactions);
  });

  uuidEntries.sort((a, b) => cmp(a[0], b[0]));
  const uuidIndex = new Map<string, ClaudeUuidNode>();
  for (const [u, node] of uuidEntries) if (!uuidIndex.has(u)) uuidIndex.set(u, node);

  // ---- per chain: collapse repeated keys, merge streams -----------------------------------------------------
  const chainKeysSorted = [...builds.values()].sort((a, b) => compareChainKeys(a.key, b.key));
  const resolved = new Map<string, { responses: Map<string, Response>; stream: Stream }>();
  for (const b of chainKeysSorted) {
    const rs = new Map<string, Response>();
    for (const [k, list] of b.responses) rs.set(k, list.length === 1 ? (list[0] as Response) : mergeSameKey(list));
    resolved.set(b.ks, { responses: rs, stream: mergeStreams(b.key, b.streams, fileInfo, [...rs.values()]) });
  }

  // ---- R5.8, R4.6: every key contributes once to the grand total --------------------------------------------
  const byKey = new Map<string, { ks: string; key: string }[]>();
  for (const b of chainKeysSorted) {
    const entry = resolved.get(b.ks) as { responses: Map<string, Response>; stream: Stream };
    for (const r of entry.responses.values()) {
      const gk = `${r.provider}\u0000${r.key}`;
      const list = byKey.get(gk);
      const ref = { ks: b.ks, key: r.key };
      if (list === undefined) byKey.set(gk, [ref]);
      else list.push(ref);
    }
  }
  const replace = (ref: { ks: string; key: string }, next: Response): void => {
    (resolved.get(ref.ks) as { responses: Map<string, Response> }).responses.set(ref.key, next);
  };
  const lookup = (ref: { ks: string; key: string }): Response => {
    return (resolved.get(ref.ks) as { responses: Map<string, Response> }).responses.get(ref.key) as Response;
  };
  for (const refs of byKey.values()) {
    if (refs.length < 2) continue;
    const owners = refs.filter((ref) => lookup(ref).ownership.role === "owner");
    if (owners.length < 2) continue;
    const first = lookup(owners[0] as { ks: string; key: string });
    if (first.provider === "codex") {
      // R4.4: the same response_id owned by two threads is a conflict and leaves accounting entirely.
      const equal = owners.every((o) => usageEqual(lookup(o).usage, first.usage));
      for (const o of owners) {
        replace(o, { ...lookup(o), usage: null, exclusion: equal ? "conflict_attribution" : "conflict_usage" });
      }
      continue;
    }
    // R4.6: the owner is the stream with the earliest stream_start; ties make ownership ambiguous and the
    // smaller sessionId owns.
    const startOf = (o: { ks: string }): number => (resolved.get(o.ks) as { stream: Stream }).stream.start_ms ?? Infinity;
    const ranked = [...owners].sort((a, b) => {
      const ra = lookup(a);
      const rb = lookup(b);
      return cmpNum(startOf(a), startOf(b)) || cmp(ra.chain.root_session, rb.chain.root_session) || cmp(ra.chain.thread, rb.chain.thread);
    });
    const winner = ranked[0] as { ks: string; key: string };
    const winStart = startOf(winner);
    const tied = ranked.filter((o) => startOf(o) === winStart);
    const ambiguous = tied.length > 1;
    for (const o of ranked) {
      const r = lookup(o);
      const isTied = ambiguous && startOf(o) === winStart;
      const flags = isTied && !r.flags.includes("ownership_ambiguous") ? [...r.flags, "ownership_ambiguous" as const] : r.flags;
      replace(o, {
        ...r,
        flags,
        ownership: {
          role: o === winner ? "owner" : "replayed",
          ambiguous: r.ownership.ambiguous || isTied,
          owner_stream_start_ms: Number.isFinite(winStart) ? winStart : r.ownership.owner_stream_start_ms,
        },
      });
    }
  }

  // ---- chains, kinds, links ---------------------------------------------------------------------------------
  const chainKnown = new Map<string, true>();
  for (const b of chainKeysSorted) chainKnown.set(b.ks, true);

  const graphResponses: Response[] = [];
  const nodes: GraphNode[] = [];
  const chains: Chain[] = [];
  const excludedOut: ExcludedRecord[] = [];

  for (const b of chainKeysSorted) {
    const entry = resolved.get(b.ks) as { responses: Map<string, Response>; stream: Stream };
    const stream = entry.stream;

    const items: Item[] = [];
    for (const r of entry.responses.values()) items.push({ t: r.time.event_ms, r, e: null });
    const sortedExcluded = [...b.excluded].sort((x, y) => cmpNum(x.event_ms, y.event_ms));
    for (const e of sortedExcluded) items.push({ t: e.event_ms, r: null, e });
    items.sort(compareItems);

    // kind: a property of the chain (R5.2).
    const linkRaw = pickLink(b.links);
    const firstResp = items.find((it) => it.r !== null)?.r ?? null;
    let kind: RequestKind;
    // The parser's kind is the chain's kind (a Codex source.subagent.other thread has a link record and is still a
    // classifier or main chain, R5.2); the link kind is only the fallback when the chain has no response.
    if (firstResp !== null) kind = firstResp.kind;
    else if (linkRaw !== null) kind = linkRaw.kind;
    else kind = b.key.provider === "claude" && b.key.thread !== "main" ? "subagent" : "main";

    let link: Link | null = null;
    if (linkRaw !== null) {
      link = validateLink(linkRaw, stream, chainKnown);
    } else if (kind === "subagent" || kind === "workflow_agent") {
      link = validateLink(
        { chain: b.key, kind, state: "unlinked", reason: null, parent: null, depth: null, is_fork: false },
        stream,
        chainKnown,
      );
    }

    // ---- sweep in chain order ----
    const base = graphResponses.length;
    const order: number[] = [];
    let seq = 0;
    let lastKept: { idx: number; resp: Response } | null = null;
    let snap: TtlSet | null = null;
    let excludedSince = false;
    let m5 = false;
    let h1 = false;
    let unk = false;
    const isClaude = b.key.provider === "claude";
    const chainIndex = chains.length;
    const n = items.length;

    for (let i = 0; i < n; i++) {
      const it = items[i] as Item;
      if (it.r === null) {
        // Keyless / unverified-version / api-error records: removed requests (R6.2). Counters unreliable (R9.2 b).
        unk = true;
        excludedSince = true;
        excludedOut.push(it.e);
        continue;
      }
      const r = it.r;
      const tie = (i > 0 && (items[i - 1] as Item).t === it.t) || (i < n - 1 && (items[i + 1] as Item).t === it.t);
      const idx = base + seq;
      const inWindow = r.time.event_ms >= window.since_ms && r.time.event_ms < window.until_ms;
      graphResponses.push(r);
      order.push(idx);

      if (r.exclusion !== null || r.usage === null) {
        // A removed request (R6.2): never a P or a C, but it lies between and spoils the TTL set (R9.2 b).
        unk = true;
        excludedSince = true;
        nodes.push({
          response: idx,
          chain: chainIndex,
          seq,
          prev: null,
          prev_is_replayed: false,
          excluded_between: false,
          order_tie: tie,
          in_window: inWindow,
          ttl_set: null,
          gap: null,
        });
        seq++;
        continue;
      }

      const p = lastKept;
      nodes.push({
        response: idx,
        chain: chainIndex,
        seq,
        prev: p === null ? null : p.idx,
        prev_is_replayed: p !== null && p.resp.ownership.role === "replayed",
        // Without a P the flag still says that a removed request precedes C: its first-ness cannot be asserted.
        excluded_between: excludedSince,
        order_tie: tie,
        in_window: inWindow,
        ttl_set: isClaude && p !== null ? snap : null,
        gap: p === null ? null : gapBounds(p.resp, r, uuidIndex),
      });

      // Fold C into the running set (it becomes P for the next request). Claude only (R9.6).
      if (isClaude) {
        const u = r.usage;
        if (u.cache_write_5m > 0n) m5 = true;
        if (u.cache_write_1h > 0n) h1 = true;
        if (u.cache_write_unknown_ttl > 0n) unk = true;
        const kPrev = p === null ? 0n : cachedPrefix(p.resp.usage as UsageBuckets);
        if (u.cache_read > kPrev) unk = true; // R9.2 (a): the read cannot come from the chain's own cache
        snap = TTL_SETS[(m5 ? 1 : 0) | (h1 ? 2 : 0) | (unk ? 4 : 0)] as TtlSet;
      }
      lastKept = { idx, resp: r };
      excludedSince = false;
      seq++;
    }

    chains.push({ key: b.key, kind, link, stream, order });
  }

  // The graph keeps R6.2's "removed" records in one list in chain order.
  excludedOut.sort(
    (a, c) =>
      compareChainKeys(a.chain, c.chain) ||
      cmpNum(a.event_ms, c.event_ms) ||
      cmpNum(a.ordinal ?? -1, c.ordinal ?? -1) ||
      cmp(a.reason, c.reason) ||
      cmp(a.files.join(","), c.files.join(",")),
  );

  const assumptionList = ASSUMPTIONS.filter((a) => assumptions.has(a));
  const sortedBoundaries = [...boundaries.values()].sort(
    (a, c) => compareChainKeys(a.chain, c.chain) || cmp(a.uuid, c.uuid),
  );
  const sortedCompactions = [...compactions].sort(
    (a, c) =>
      compareChainKeys(a.chain, c.chain) ||
      cmpNum(a.ordinal ?? -1, c.ordinal ?? -1) ||
      cmpNum(a.ts_ms ?? -1, c.ts_ms ?? -1) ||
      cmpNum(a.window_number ?? -1, c.window_number ?? -1),
  );

  return {
    window,
    responses: graphResponses,
    nodes,
    chains,
    files: fileInfos,
    excluded: excludedOut,
    claude: { uuid_index: uuidIndex, compact_boundaries: sortedBoundaries },
    codex: { compactions: sortedCompactions },
    assumptions: assumptionList,
  };
};

// ---------------------------------------------------------------------------
// read-only helpers on a built graph
// ---------------------------------------------------------------------------

/**
 * Indices of the responses that add to the window totals: kept, the owner's copy (R4.7) and inside the window
 * (R5.9, R5.10). Each key appears at most once, so this is the single count of R5.8.
 */
export function countedResponseIndices(graph: Graph): number[] {
  const out: number[] = [];
  for (let i = 0; i < graph.responses.length; i++) {
    if ((graph.nodes[i] as GraphNode).in_window && countsInTotals(graph.responses[i] as Response)) out.push(i);
  }
  return out;
}

/** Counted responses per chain kind (R5.2). The values sum to `countedResponseIndices(graph).length` (R5.8). */
export function countedByKind(graph: Graph): Record<RequestKind, number> {
  const out: Record<RequestKind, number> = {
    main: 0,
    subagent: 0,
    workflow_agent: 0,
    helper: 0,
    classifier: 0,
    advisor: 0,
  };
  for (const i of countedResponseIndices(graph)) {
    const kind = (graph.chains[(graph.nodes[i] as GraphNode).chain] as Chain).kind;
    out[kind]++;
  }
  return out;
}

/**
 * Link counters after the graph's cross-chain checks. The parsers' `links_*` coverage counters were computed
 * before those checks, so the report builder should take these values for `links_verified`, `links_directory_only`,
 * `links_unlinked` and `links_unlinked_by_reason`.
 */
export function summarizeLinks(graph: Graph): {
  verified: number;
  directory: number;
  unlinked: number;
  unlinked_by_reason: Record<UnlinkedReason, number>;
} {
  const byReason = {} as Record<UnlinkedReason, number>;
  for (const r of UNLINKED_REASONS) byReason[r] = 0;
  let verified = 0;
  let directory = 0;
  let unlinkedCount = 0;
  for (const c of graph.chains) {
    const l = c.link;
    if (l === null) continue;
    if (l.state === "verified") verified++;
    else if (l.state === "directory") directory++;
    else {
      unlinkedCount++;
      if (l.reason !== null) byReason[l.reason]++;
    }
  }
  return { verified, directory, unlinked: unlinkedCount, unlinked_by_reason: byReason };
}
