import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { readLines, newLineStats, mapWithLimit, processFiles, zstdSupported, zstdDetectsTruncation } from "../../src/io/lines.js";
import type { LineRecord, ReadLinesOptions } from "../../src/io/lines.js";

const dir = mkdtempSync(join(tmpdir(), "cachewhy-lines-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

async function collect(path: string, opts: ReadLinesOptions = {}): Promise<LineRecord[]> {
  const out: LineRecord[] = [];
  for await (const l of readLines(path, opts)) out.push(l);
  return out;
}

test("LF lines with offsets and ordinals", async () => {
  const p = join(dir, "a.jsonl");
  writeFileSync(p, "ab\ncde\n\nf\n");
  const got = await collect(p);
  assert.deepEqual(
    got.map((l) => [l.text, l.ordinal, l.offset, l.terminated]),
    [["ab", 0, 0, true], ["cde", 1, 3, true], ["", 2, 7, true], ["f", 3, 8, true]],
  );
});

test("CRLF and BOM are stripped, offsets stay byte-exact", async () => {
  const p = join(dir, "b.jsonl");
  writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x\r\ny\r\n")]));
  const got = await collect(p);
  assert.deepEqual(got.map((l) => l.text), ["x", "y"]);
  assert.equal(got[0]!.offset, 3);
  assert.equal(got[1]!.offset, 6);
});

test("unterminated final line is yielded and reported, not thrown", async () => {
  const p = join(dir, "c.jsonl");
  writeFileSync(p, '{"a":1}\n{"b":');
  const stats = newLineStats();
  const got = await collect(p, { stats });
  assert.equal(got.length, 2);
  assert.equal(got[1]!.terminated, false);
  assert.equal(stats.finalLineUnterminated, true);
  assert.equal(stats.error, undefined);
});

test("multibyte characters split across chunks decode correctly", async () => {
  const p = join(dir, "d.jsonl");
  const line = "é€\u{1F600}".repeat(50);
  writeFileSync(p, `${line}\n${line}\n`);
  const got = await collect(p, { highWaterMark: 7 });
  assert.deepEqual(got.map((l) => l.text), [line, line]);
  assert.equal(got[1]!.offset, Buffer.byteLength(line) + 1);
});

test("prefilter skips lines but keeps ordinals and offsets", async () => {
  const p = join(dir, "e.jsonl");
  writeFileSync(p, "one usage\ntwo\nthree usage\n");
  const stats = newLineStats();
  const got = await collect(p, { prefilter: ["usage"], stats });
  assert.deepEqual(got.map((l) => [l.text, l.ordinal, l.offset]), [["one usage", 0, 0], ["three usage", 2, 14]]);
  assert.equal(stats.linesSeen, 3);
  assert.equal(stats.linesSkippedByPrefilter, 1);
});

test("missing file is reported in stats as a fixed code, never as exception text or a path (R0.2, R14.6, R17.1)", async () => {
  const stats = newLineStats();
  const got = await collect(join(dir, "nope.jsonl"), { stats });
  assert.equal(got.length, 0);
  assert.equal(stats.error, "read_failed");
  assert.ok(!JSON.stringify(stats).includes("nope"));
});

test("a directory where a file is expected is reported per file and never thrown (R0.2)", async () => {
  const stats = newLineStats();
  const got = await collect(dir, { stats });
  assert.equal(got.length, 0);
  assert.equal(stats.error, "read_failed");
});

test("a truncated zstd frame never throws and is reported, so the caller can mark the file unreadable (R0.9 file_unreadable)", { skip: !zstdDetectsTruncation() && "this Node does not report truncated zstd frames" }, async () => {
  const p = join(dir, "partial.jsonl.zst");
  const good = (zlib as unknown as { zstdCompressSync(b: Buffer): Buffer }).zstdCompressSync(Buffer.from("l1\nl2\n".repeat(50)));
  writeFileSync(p, good.subarray(0, Math.max(1, good.length - 4)));
  const stats = newLineStats();
  const got = await collect(p, { stats });
  assert.equal(stats.error, "read_failed");
  assert.ok(got.length <= 100);
});

test("zstd file: decoded when supported, else reported unsupported", async () => {
  const p = join(dir, "f.jsonl.zst");
  const stats = newLineStats();
  if (zstdSupported()) {
    const z = (zlib as unknown as { zstdCompressSync(b: Buffer): Buffer }).zstdCompressSync(Buffer.from("l1\nl2\n"));
    writeFileSync(p, z);
    const got = await collect(p, { stats });
    assert.deepEqual(got.map((l) => l.text), ["l1", "l2"]);
  } else {
    writeFileSync(p, "irrelevant");
    const got = await collect(p, { stats });
    assert.equal(got.length, 0);
    assert.equal(stats.unsupported, "zstd-unavailable");
  }
});

test("corrupt zstd reports error instead of throwing", { skip: !zstdSupported() }, async () => {
  const p = join(dir, "g.jsonl.zst");
  writeFileSync(p, "not zstd data at all");
  const stats = newLineStats();
  const got = await collect(p, { stats });
  assert.equal(got.length, 0);
  assert.ok(stats.error);
});

test("mapWithLimit respects the concurrency cap and captures errors", async () => {
  let active = 0;
  let peak = 0;
  const res = await mapWithLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    if (n === 3) throw new Error("boom");
    return n * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(res.map((r) => r.ok), [true, true, false, true, true, true]);
  assert.equal(res[5]!.value, 12);
});

test("processFiles streams many files with stats", async () => {
  const paths: string[] = [];
  for (let i = 0; i < 5; i++) {
    const p = join(dir, `m${i}.jsonl`);
    writeFileSync(p, "a\nb\n");
    paths.push(p);
  }
  const res = await processFiles(paths, 2, async (_p, lines) => {
    let n = 0;
    for await (const _ of lines) n++;
    return n;
  });
  assert.ok(res.every((r) => r.ok && r.value!.result === 2 && r.value!.stats.linesSeen === 2));
});

test("a trailing CR on an unterminated final line is stripped", async () => {
  const p = join(dir, "cr-eof.jsonl");
  writeFileSync(p, "a\r\nb\r");
  const stats = newLineStats();
  const got = await collect(p, { stats });
  assert.deepEqual(got.map((l) => [l.text, l.terminated, l.byteLength]), [["a", true, 1], ["b", false, 1]]);
  assert.equal(stats.finalLineUnterminated, true);
});

test("a BOM-only file yields no lines, like an empty file", async () => {
  const bom = join(dir, "bom-only.jsonl");
  writeFileSync(bom, Buffer.from([0xef, 0xbb, 0xbf]));
  const empty = join(dir, "empty.jsonl");
  writeFileSync(empty, "");
  for (const p of [bom, empty]) {
    const stats = newLineStats();
    assert.deepEqual(await collect(p, { stats }), []);
    assert.equal(stats.linesSeen, 0);
    assert.equal(stats.finalLineUnterminated, false);
  }
});

test("a lone CR after the last newline is not a phantom line", async () => {
  const p = join(dir, "lone-cr.jsonl");
  writeFileSync(p, "a\n\r");
  const stats = newLineStats();
  const got = await collect(p, { stats });
  assert.deepEqual(got.map((l) => l.text), ["a"]);
  assert.equal(stats.finalLineUnterminated, false);
});
