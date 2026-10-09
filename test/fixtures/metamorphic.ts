// Metamorphic operations on generated log files (spec R4.10) and the dissolving-split test.
//
// The five operations of R4.10, each a pure function of its inputs (a seed, never a clock):
//   1. shuffleLines(file, seed)           shuffle the lines of a file; a truncated tail stays the tail
//   2. shuffleFiles(files, seed)          shuffle the file order
//   3. duplicateLine(file, idx, k)        add k extra copies of one line, away from the end of the file
//   4. reserializeReversedKeys(file)      re-serialize every JSON line with the keys in reverse order
//   5. splitAt(file, idx, provider)       split in two at a line boundary; both halves keep the modification time
//
// Every operation keeps file modification times (R0.9: liveness is a file property). Compressed files cannot be
// edited at the text level and are returned unchanged by the line operations.
//
// Everything here works on the text of the generated file. It does not import src/, so it is an independent reading
// of R4.10, R4.11 and R0.9 "Named chains" (the dissolving test must not borrow its facts from the code under test).

import type { GeneratedFile } from './builder.ts';
import { joinLines, textLines } from './builder.ts';

export type MetaProvider = 'claude' | 'codex';

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const r = rng(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

const isText = (f: GeneratedFile): f is GeneratedFile & { content: string } => typeof f.content === 'string' && !f.path.endsWith('.zst');

/** True for the files the line operations act on: JSONL logs (not JSON sidecars, not archives). */
export function isLogFile(f: GeneratedFile): boolean {
  return isText(f) && f.path.endsWith('.jsonl') && !f.path.endsWith('/journal.jsonl');
}

/** Complete lines and the truncated tail (the part after the last line terminator, when there is one). */
export function splitTail(text: string): { lines: string[]; tail: string | null } {
  const { lines, endsWithNewline } = textLines(text);
  if (endsWithNewline || lines.length === 0) return { lines, tail: null };
  return { lines: lines.slice(0, -1), tail: lines[lines.length - 1] as string };
}

function rebuild(file: GeneratedFile, lines: readonly string[], tail: string | null): GeneratedFile {
  const body = joinLines(lines, true);
  return { ...file, content: tail === null ? body : body + tail, plain: undefined };
}

/** R4.10 op 1. */
export function shuffleLines(file: GeneratedFile, seed: number): GeneratedFile {
  if (!isLogFile(file)) return file;
  const { lines, tail } = splitTail(file.content as string);
  return rebuild(file, shuffled(lines, seed), tail);
}

/** R4.10 op 2. */
export function shuffleFiles<T>(files: readonly T[], seed: number): T[] {
  return shuffled(files, seed);
}

/**
 * R4.10 op 3. Insert `k` extra copies of line `idx` (0-based over the complete lines plus the tail as the last index),
 * each with its own terminator. Copies of a complete line go right after it. Copies of the truncated tail go before
 * the tail, so the original tail is still the last line and every copy is a parse error (R17.6).
 */
export function duplicateLine(file: GeneratedFile, idx: number, k: number): GeneratedFile {
  if (!isLogFile(file)) return file;
  const { lines, tail } = splitTail(file.content as string);
  const all = tail === null ? lines : [...lines, tail];
  if (idx < 0 || idx >= all.length) throw new Error('duplicateLine: index out of range');
  const copy = all[idx] as string;
  if (tail !== null && idx === all.length - 1) return rebuild(file, [...lines, ...Array<string>(k).fill(copy)], tail);
  const out = [...lines.slice(0, idx + 1), ...Array<string>(k).fill(copy), ...lines.slice(idx + 1)];
  return rebuild(file, out, tail);
}

function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).reverse()) out[k] = reverseKeys(o[k]);
    return out;
  }
  return v;
}

/** R4.10 op 4. Lines that do not parse (raw garbage, a truncated tail) are left byte for byte. */
export function reserializeReversedKeys(file: GeneratedFile): GeneratedFile {
  if (!isLogFile(file)) return file;
  const { lines, tail } = splitTail(file.content as string);
  const out = lines.map((l) => {
    try {
      return JSON.stringify(reverseKeys(JSON.parse(l)));
    } catch {
      return l;
    }
  });
  return rebuild(file, out, tail);
}

// ---------------------------------------------------------------------------
// what a line names (R0.9 "Named chains") and the identity set of a file (R4.11)
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function parseLine(l: string): Rec | null {
  try {
    const v: unknown = JSON.parse(l);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Claude chain id (types.chainIdOf, restated here so this file stays independent of src/). */
export const claudeChainId = (session: string, agent = 'main'): string => `claude\u0000${session}\u0000${agent}`;
export const codexChainId = (thread: string): string => `codex\u0000${thread}`;

/** The chain ids a single parsed line names, or []. */
export function linesNamed(rec: Rec, provider: MetaProvider): string[] {
  if (provider === 'claude') {
    const s = str(rec.sessionId);
    if (s === null) return [];
    return [claudeChainId(s, str(rec.agentId) ?? 'main')];
  }
  const p = (rec.payload ?? {}) as Rec;
  if (rec.type === 'session_meta') {
    const id = str(p.id);
    return id === null ? [] : [codexChainId(id)];
  }
  if (rec.type === 'token_usage_record') {
    const t = str(p.thread_id);
    return t === null ? [] : [codexChainId(t)];
  }
  return [];
}

export interface SplitView {
  /** R0.9 named chains of the file. */
  readonly named: ReadonlySet<string>;
  /** R4.11 identity set I(F) = own_ids union tur_ids (Codex). Empty for Claude. */
  readonly identity: ReadonlySet<string>;
  /** The file holds at least one parsed record. */
  readonly nonEmpty: boolean;
}

/** Named chains and identity set of the text of one file. */
export function splitView(text: string, provider: MetaProvider): SplitView {
  const { lines } = splitTail(text);
  const named = new Set<string>();
  const metas: Array<{ id: string; forked: string | null }> = [];
  const tur = new Set<string>();
  let nonEmpty = false;
  for (const l of lines) {
    const rec = parseLine(l);
    if (rec === null) continue;
    nonEmpty = true;
    for (const n of linesNamed(rec, provider)) named.add(n);
    if (provider === 'codex') {
      const p = (rec.payload ?? {}) as Rec;
      if (rec.type === 'session_meta' && str(p.id) !== null) metas.push({ id: str(p.id) as string, forked: str(p.forked_from_id) });
      if (rec.type === 'token_usage_record' && str(p.thread_id) !== null) tur.add(str(p.thread_id) as string);
    }
  }
  const identity = new Set<string>();
  if (provider === 'codex') {
    const forkedFrom = new Set(metas.map((m) => m.forked).filter((x): x is string => x !== null));
    // A session_meta is non-own iff another session_meta in the file names it as forked_from_id.
    for (const m of metas) if (!forkedFrom.has(m.id)) identity.add(codexChainId(m.id));
    for (const t of tur) identity.add(codexChainId(t));
  }
  return { named, identity, nonEmpty };
}

/**
 * R4.10 op 5. Null when a half would keep no record that names a chain (the split is not allowed).
 *
 * Naming: with 'continuation' (the default) the first half keeps the path of the split file. For Codex the second half is
 * <name>.part2.jsonl, a continuation file. For Claude the second half keeps the file name (the session and agent ids of
 * R5.3 items 1 and 2 are read from it) and lives in a second project directory <project>-part2, so no name check of the
 * linkage rules sees a difference. With 'renamed' both halves get new names (-s1, -s2). The linkage of a Claude agent chain is bound to the
 * chain (the ids in its records) and not to a file name, so the links_* counters stay the same (R17.7).
 */
export function splitAt(
  file: GeneratedFile,
  idx: number,
  provider: MetaProvider,
  naming: 'continuation' | 'renamed' = 'continuation',
): [GeneratedFile, GeneratedFile] | null {
  if (!isLogFile(file)) return null;
  const { lines, tail } = splitTail(file.content as string);
  const all = tail === null ? lines : [...lines, tail];
  if (idx < 1 || idx >= all.length) return null;
  const a = all.slice(0, idx);
  const b = all.slice(idx);
  const textA = joinLines(a, true);
  // A truncated tail stays the tail of its half: the second half keeps its last line without terminator.
  const textB = tail === null ? joinLines(b, true) : joinLines(b, false);
  if (splitView(textA, provider).named.size === 0 || splitView(textB, provider).named.size === 0) return null;
  const base = file.path.replace(/\.jsonl$/, '');
  const mk = (path: string, content: string): GeneratedFile => {
    const out: GeneratedFile = { path, content };
    if (file.mtimeMs !== undefined) out.mtimeMs = file.mtimeMs;
    return out;
  };
  if (naming === 'renamed') return [mk(`${base}-s1.jsonl`, textA), mk(`${base}-s2.jsonl`, textB)];
  if (provider === 'claude') {
    const parts = file.path.split('/');
    if (parts.length >= 3 && parts[0] === 'projects') parts[1] = `${parts[1]}-part2`;
    return [mk(file.path, textA), mk(parts.join('/'), textB)];
  }
  return [mk(file.path, textA), mk(`${base}.part2.jsonl`, textB)];
}

/** Every split position that R4.10 allows for this file. */
export function splitPositions(file: GeneratedFile, provider: MetaProvider): number[] {
  if (!isLogFile(file)) return [];
  const { lines, tail } = splitTail(file.content as string);
  const n = lines.length + (tail === null ? 0 : 1);
  const out: number[] = [];
  for (let i = 1; i < n; i++) if (splitAt(file, i, provider) !== null) out.push(i);
  return out;
}

/** Number of lines of a log file, a truncated tail included. */
export function lineCount(file: GeneratedFile): number {
  const { lines, tail } = splitTail(file.content as string);
  return lines.length + (tail === null ? 0 : 1);
}

/**
 * R4.10: a split is dissolving iff the split file is a stream conflict (`I(F)` of two or more ids) and every half has a
 * smaller identity set, or the split file names chains of two or more families and no half names chains of all of them.
 * `familyOf` maps a chain id to its family (a property of the record set, so the unsplit scan's families serve for the
 * split scan too); an id it does not know is a family of its own.
 */
export function isDissolving(
  unsplit: SplitView,
  halves: readonly [SplitView, SplitView],
  familyOf: (id: string) => number | string | undefined,
): boolean {
  if (unsplit.identity.size >= 2 && halves.every((h) => h.identity.size < unsplit.identity.size)) return true;
  const fams = (v: SplitView): Set<string> => new Set([...v.named].map((id) => String(familyOf(id) ?? `own:${id}`)));
  const all = fams(unsplit);
  if (all.size >= 2) {
    const full = halves.some((h) => {
      const f = fams(h);
      return f.size === all.size && [...all].every((x) => f.has(x));
    });
    if (!full) return true;
  }
  return false;
}
