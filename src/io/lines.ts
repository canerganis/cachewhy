import { createReadStream } from "node:fs";
import { pipeline } from "node:stream";
import * as zlib from "node:zlib";

export interface LineRecord {
  /** Decoded line text without the line terminator (CR/LF stripped, BOM stripped). */
  text: string;
  /** 0-based line number within the (decompressed) stream, counting prefiltered-out lines. */
  ordinal: number;
  /** Byte offset of the line start within the (decompressed) stream, BOM bytes included. */
  offset: number;
  /** Byte length of the line without terminator (BOM excluded). */
  byteLength: number;
  /** False only for a final line that has no trailing newline (possibly truncated write). */
  terminated: boolean;
}

export interface LineStats {
  /** Total lines seen, including those skipped by the prefilter. */
  linesSeen: number;
  linesYielded: number;
  linesSkippedByPrefilter: number;
  /** Decompressed bytes consumed. */
  bytesRead: number;
  /** True when the last line had no newline terminator. It is still yielded with terminated=false. */
  finalLineUnterminated: boolean;
  /** Set when the file cannot be decoded on this Node build (coverage loss). Never thrown. */
  unsupported?: "zstd-unavailable";
  /** Set to the fixed code `read_failed` when the file could not be (fully) read (R0.2, R17.1). Never thrown, never exception text. */
  error?: "read_failed";
}

export interface ReadLinesOptions {
  /**
   * Cheap prefilter: a line is yielded only if its raw bytes contain at least one of these
   * substrings (UTF-8). Applied before decoding. Skipped lines still advance ordinal/offset.
   */
  prefilter?: string | readonly string[];
  /** Out-parameter filled while iterating. Final values are valid once iteration ends. */
  stats?: LineStats;
  /** Read buffer size for the file stream. Default 256 KiB. */
  highWaterMark?: number;
}

export function newLineStats(): LineStats {
  return {
    linesSeen: 0,
    linesYielded: 0,
    linesSkippedByPrefilter: 0,
    bytesRead: 0,
    finalLineUnterminated: false,
  };
}

/** True when this Node build can decompress zstd. */
export function zstdSupported(): boolean {
  return typeof (zlib as unknown as Record<string, unknown>).createZstdDecompress === "function";
}

const NL = 0x0a;
const CR = 0x0d;

function openStream(path: string, hwm: number, stats: LineStats): AsyncIterable<Buffer> | null {
  const isZst = path.toLowerCase().endsWith(".zst");
  if (isZst && !zstdSupported()) {
    stats.unsupported = "zstd-unavailable";
    return null;
  }
  const rs = createReadStream(path, { highWaterMark: hwm });
  if (!isZst) return rs;
  const dz = (zlib as unknown as { createZstdDecompress(): NodeJS.ReadWriteStream }).createZstdDecompress();
  // pipeline propagates errors and destroys both ends on early exit.
  return pipeline(rs, dz, () => {}) as unknown as AsyncIterable<Buffer>;
}

/**
 * Stream the lines of a file. Never reads the whole file into memory (only the current partial
 * line is buffered). Handles LF and CRLF, strips a leading UTF-8 BOM, decompresses .zst when
 * supported. I/O and decompression failures are reported via options.stats, not thrown.
 */
export async function* readLines(path: string, options: ReadLinesOptions = {}): AsyncGenerator<LineRecord> {
  const stats = options.stats ?? newLineStats();
  const needles =
    options.prefilter === undefined
      ? null
      : (typeof options.prefilter === "string" ? [options.prefilter] : [...options.prefilter]).map((s) =>
          Buffer.from(s, "utf8"),
        );

  const source = openStream(path, options.highWaterMark ?? 262144, stats);
  if (source === null) return;

  let pending: Buffer[] = [];
  let pendingLen = 0;
  let streamPos = 0; // bytes consumed from stream before the current chunk
  let lineStart = 0; // stream offset of current line start
  let ordinal = 0;

  // Set when the unterminated tail is empty once BOM and CR are stripped: not a line at all.
  let emptyTail = false;

  const emit = (raw: Buffer, terminated: boolean): LineRecord | null => {
    let buf = raw;
    let start = lineStart;
    if (ordinal === 0 && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      buf = buf.subarray(3);
      start += 3;
    }
    // CR is stripped on unterminated tails too (a file may end with "\r" and no "\n").
    if (buf.length > 0 && buf[buf.length - 1] === CR) buf = buf.subarray(0, buf.length - 1);
    if (!terminated && buf.length === 0) {
      emptyTail = true;
      return null;
    }
    const n = ordinal++;
    stats.linesSeen++;
    if (needles !== null && !needles.some((nd) => buf.includes(nd))) {
      stats.linesSkippedByPrefilter++;
      return null;
    }
    stats.linesYielded++;
    return { text: buf.toString("utf8"), ordinal: n, offset: start, byteLength: buf.length, terminated };
  };

  try {
    for await (const chunk of source) {
      const data = chunk as Buffer;
      let from = 0;
      for (;;) {
        const nl = data.indexOf(NL, from);
        if (nl === -1) break;
        let raw: Buffer;
        if (pending.length > 0) {
          pending.push(data.subarray(from, nl));
          raw = Buffer.concat(pending);
          pending = [];
          pendingLen = 0;
        } else {
          raw = data.subarray(from, nl);
        }
        const rec = emit(raw, true);
        lineStart = streamPos + nl + 1;
        from = nl + 1;
        if (rec) yield rec;
      }
      if (from < data.length) {
        const tail = data.subarray(from);
        pending.push(tail);
        pendingLen += tail.length;
      }
      streamPos += data.length;
      stats.bytesRead = streamPos;
    }
    if (pendingLen > 0) {
      const raw = Buffer.concat(pending);
      pending = [];
      const rec = emit(raw, false);
      if (!emptyTail) stats.finalLineUnterminated = true;
      if (rec) yield rec;
    }
  } catch {
    // A partial final line cannot be trusted after a read/decompress failure: dropped.
    // R14.6, R1.3: exception text can quote a path or input text, so only a fixed code is kept.
    stats.error = "read_failed";
  }
}

export interface LimitResult<R> {
  index: number;
  ok: boolean;
  value?: R;
  error?: unknown;
}

/**
 * Run fn over items with at most `limit` in flight. Results are returned in input order.
 * A rejection in fn is captured per item and never aborts the other items.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<LimitResult<R>[]> {
  const n = Math.max(1, Math.floor(limit) || 1);
  const results: LimitResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { index: i, ok: true, value: await fn(items[i] as T, i) };
      } catch (error) {
        results[i] = { index: i, ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

/** Convenience: process many files with N parallel line streams. */
export function processFiles<R>(
  paths: readonly string[],
  concurrency: number,
  fn: (path: string, lines: AsyncGenerator<LineRecord>, stats: LineStats) => Promise<R>,
  options: Omit<ReadLinesOptions, "stats"> = {},
): Promise<LimitResult<{ result: R; stats: LineStats }>[]> {
  return mapWithLimit(paths, concurrency, async (p) => {
    const stats = newLineStats();
    const result = await fn(p, readLines(p, { ...options, stats }), stats);
    return { result, stats };
  });
}
