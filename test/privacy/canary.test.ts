// Canary suite for the privacy helpers. Spec: docs/methodology.md R14.6, R14.7.
// All data is synthetic. Canaries are generated per run, never written as literals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { run, type CliIO } from "../../src/cli.ts";
import { readLines } from "../../src/io/lines.ts";
import { scenarios } from "../../scripts/gen-fixtures.ts";
import { writeFiles, type GeneratedFile } from "../fixtures/builder.ts";

import { IdRedactor, redactorFromArgs } from "../../src/util/redact.ts";
import {
  SafeError,
  formatError,
  parseJsonLineSafe,
  s,
  serialize,
  serializeToJson,
  stripControl,
  sanitizeForTerminal,
  fileLabel,
  modelIdSchema,
  versionSchema,
} from "../../src/util/sanitize.ts";

function makeCanary(): string {
  return `CANARY_${randomBytes(8).toString("hex")}`;
}

/** True if text contains the canary, its case variants, base64, URL-encoded, or any 8+ char substring. */
function leaks(text: string, canary: string): boolean {
  const forms = [
    canary,
    canary.toLowerCase(),
    canary.toUpperCase(),
    Buffer.from(canary).toString("base64"),
    Buffer.from(canary).toString("base64").replace(/=+$/, ""),
    encodeURIComponent(canary),
  ];
  for (const f of forms) {
    for (let i = 0; i + 8 <= f.length; i++) {
      if (text.includes(f.slice(i, i + 8))) return true;
    }
  }
  return false;
}

const HOME_X = "/ho" + "me/x/";

function syntheticLines(c: string): string[] {
  const full = [
    { type: "user", message: { role: "user", content: `please read ${c}` }, cwd: `/work/${c}`, gitBranch: `b-${c}` },
    { type: "assistant", message: { model: `m-${c}`, usage: { input_tokens: 5, [`extra_${c}`]: 7 } }, slug: c, title: c, version: `v-${c}` },
    { type: `unknown-${c}`, payload: { tool_input: c, tool_output: c } },
  ].map((o) => JSON.stringify(o));
  const truncated = `{"type":"user","message":{"content":"${c}`; // cut mid-string
  return [...full, truncated];
}

const eventSchema = s.object({
  id: s.pattern(/^e[0-9]+$/),
  kind: s.enum(["hit", "miss"] as const),
  model: modelIdSchema(new Set(["claude-test-1", "gpt-test-2"])),
  version: versionSchema,
  t: s.iso(),
  r: s.decimal(),
  n: s.int(0),
  ratio: s.number(3),
  note: s.nullable(s.enum(["a", "b"] as const)),
  tags: s.array(s.enum(["x", "y"] as const), 4),
});

test("serializer drops undeclared keys carrying canaries", () => {
  const c = makeCanary();
  const input = {
    id: "e1", kind: "hit", model: "claude-test-1", version: "1.2.3", t: "2026-01-02T03:04:05Z",
    r: 12n, n: 3, ratio: 0.12345, note: null, tags: ["x"],
    cwd: `/work/${c}`, title: c, [`extra_${c}`]: c, message: { content: c },
  };
  const out = serializeToJson(eventSchema, input);
  assert.equal(leaks(out, c), false);
  assert.deepEqual(Object.keys(JSON.parse(out)).sort(), Object.keys(eventSchema.fields).sort());
  assert.equal(JSON.parse(out).r, "12");
  assert.equal(JSON.parse(out).ratio, 0.123);
});

test("unknown model and version are replaced, never echoed", () => {
  const c = makeCanary();
  const out = JSON.parse(serializeToJson(eventSchema, {
    id: "e1", kind: "miss", model: c.toLowerCase(), version: `1.2.3-${c}x`, t: "2026-01-02T03:04:05Z",
    r: "0", n: 0, ratio: 0, note: "a", tags: [],
  })) as Record<string, unknown>;
  assert.equal(out.model, "unlisted");
  assert.equal(out.version, "unlisted");
  assert.equal(leaks(JSON.stringify(out), c), false);
});

test("schema violations throw a SafeError that names the path only", () => {
  const c = makeCanary();
  const bad: Array<[string, unknown]> = [
    ["kind", c],
    ["id", c],
    ["t", c],
    ["r", c],
    ["n", c],
    ["tags", [c]],
  ];
  for (const [key, value] of bad) {
    const rec = {
      id: "e1", kind: "hit", model: "claude-test-1", version: "1.2.3", t: "2026-01-02T03:04:05Z",
      r: "1", n: 1, ratio: 1, note: null, tags: [] as unknown[], [key]: value,
    };
    assert.throws(() => serialize(eventSchema, rec), (e: unknown) => {
      assert.ok(e instanceof SafeError);
      const text = `${formatError(e)}|${(e as Error).message}|${(e as Error).stack?.split("\n")[0]}`;
      assert.equal(leaks(text, c), false);
      assert.match(formatError(e), /^E_SCHEMA_VIOLATION at \$\./);
      return true;
    });
  }
});

test("missing required field is a violation, optional is skipped", () => {
  const sc = s.object({ a: s.int(), b: s.int() }, ["b"]);
  assert.deepEqual(serialize(sc, { a: 1 }), { a: 1 });
  assert.throws(() => serialize(sc, { b: 1 }), SafeError);
});

test("prototype keys do not leak through the serializer", () => {
  const sc = s.object({ a: s.int() });
  const evil = JSON.parse('{"a":1,"__proto__":{"polluted":"yes"},"constructor":"x"}');
  const out = serialize(sc, evil) as Record<string, unknown>;
  assert.deepEqual(Object.keys(out), ["a"]);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
});

test("JSON parse errors on truncated canary lines never reach output", () => {
  const c = makeCanary();
  const lines = syntheticLines(c);
  let errors = 0;
  const outputs: string[] = [];
  lines.forEach((line, i) => {
    const r = parseJsonLineSafe(line, i + 1, fileLabel(1));
    if (!r.ok) {
      errors++;
      outputs.push(formatError(r.error), r.error.message, String(r.error.stack).split("\n")[0] as string);
    }
  });
  assert.equal(errors, 1);
  for (const o of outputs) assert.equal(leaks(o, c), false);
  assert.equal(outputs[0], "E_JSON_PARSE in file_1 line 4");
});

test("formatError never reads message of foreign exceptions", () => {
  const c = makeCanary();
  const foreign = new Error(`ENOENT: no such file ${HOME_X}${c}`);
  assert.equal(formatError(foreign), "E_INTERNAL");
  assert.equal(formatError({ message: c, toString: () => c }), "E_INTERNAL");
  assert.equal(formatError(c), "E_INTERNAL");
  assert.equal(formatError(null), "E_INTERNAL");
  try {
    JSON.parse(`{"a":"${c}`);
    assert.fail("expected parse error");
  } catch (e) {
    assert.equal(formatError(e), "E_INTERNAL");
  }
});

test("SafeError rejects free text in code, file and path", () => {
  const c = makeCanary();
  // Lowercase: an all-digit uppercase canary (about 1 in 2000 runs) would be a valid code.
  const e = new SafeError(c.toLowerCase(), { file: `${HOME_X}${c}`, path: c + " bad", line: -1, count: 1.5 });
  const text = `${formatError(e)}|${e.message}|${e.code}`;
  assert.equal(leaks(text, c), false);
  assert.match(formatError(e), /^E_BAD_CODE in file_\? line 0 count 0 at \$\?$/);
});

test("stripControl removes C0, C1, ESC sequences and bidi controls", () => {
  const c = makeCanary();
  const dirty =
    `a\u{0}b\u{7}c\u{1b}[31mred\u{1b}[0m\u{1b}]0;title\u{7}d\u{9b}e\u{202E}fg\u{2066}h\u{85}i\u{7f}j\r\nk${c}`;
  const clean = stripControl(dirty);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(clean, /[\u{0}-\u{1F}\u{7F}-\u{9F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u);
  assert.equal(clean, `abcreddefghijk${c}`);
  assert.equal(sanitizeForTerminal("x".repeat(500), 10), "x".repeat(10));
});

test("stripControl handles an unterminated OSC and lone ESC", () => {
  assert.equal(stripControl("a\u001b]8;;http://x"), "a");
  assert.equal(stripControl("a\u001b"), "a");
  assert.equal(stripControl("a\u001bMb"), "ab");
});

test("redactor output never contains raw ids and uses the documented shapes", () => {
  const c = makeCanary();
  const r = new IdRedactor();
  const ids = [c, c.toLowerCase(), `${c}-2`];
  const out = [r.request(ids[0] as string), r.chain(ids[0] as string), r.session(ids[0] as string),
    r.chain(ids[1] as string), r.chain(ids[2] as string), r.chain(ids[0] as string)];
  assert.match(out[0] as string, /^req_[0-9a-f]{8}$/);
  assert.deepEqual(out.slice(1), ["chain_1", "sess_1", "chain_2", "chain_3", "chain_1"]);
  for (const o of out) assert.equal(leaks(o, c), false);
  assert.equal(leaks(JSON.stringify(r) + String(r), c), false);
});

test("salt is per run, stable only on request, and not exposed", () => {
  const id = "synthetic-id-1";
  const a = new IdRedactor();
  const b = new IdRedactor();
  assert.notEqual(a.request(id), b.request(id)); // 2^-32 flake chance, accepted
  const x = new IdRedactor({ stableSalt: "seed" });
  const y = redactorFromArgs(["--stable-salt", "seed"]);
  const z = redactorFromArgs(["--stable-salt=other"]);
  assert.equal(x.request(id), y.request(id));
  assert.notEqual(x.request(id), z.request(id));
  assert.equal(a.stable, false);
  assert.equal(x.stable, true);
  assert.deepEqual(Object.keys(a), ["stable"]);
  assert.throws(() => new IdRedactor({ stableSalt: "" }), SafeError);
  assert.throws(() => redactorFromArgs(["--stable-salt"]), SafeError);
  assert.throws(() => a.request(""), SafeError);
});

test("end to end: planted canaries never survive sanitize + serialize + errors", () => {
  const c = makeCanary();
  const redactor = new IdRedactor();
  const sessionSchema = s.object({ session: s.pattern(/^sess_[0-9]+$/), request: s.pattern(/^req_[0-9a-f]{8}$/), n: s.int(0) });
  const emitted: string[] = [];
  syntheticLines(c).forEach((line, i) => {
    const p = parseJsonLineSafe(line, i + 1, fileLabel(0));
    if (!p.ok) {
      emitted.push(formatError(p.error));
      return;
    }
    const rec = p.value as Record<string, unknown>;
    emitted.push(serializeToJson(sessionSchema, {
      session: redactor.session(String(rec["slug"] ?? rec["cwd"] ?? `row-${i}`)),
      request: redactor.request(String(rec["title"] ?? rec["gitBranch"] ?? `row-${i}`)),
      n: i,
      ...rec,
    }));
  });
  assert.equal(emitted.length, 4);
  for (const e of emitted) assert.equal(leaks(stripControl(e), c), false);
});

// --- repo scanner ----------------------------------------------------------

const scriptPath = fileURLToPath(new URL("../../scripts/check-repo-privacy.mjs", import.meta.url));

/**
 * Files are written untracked, as in a fresh working tree. Pass `track` to `git add` selected
 * files, so both the tracked and the untracked paths of the scanner are exercised.
 */
function scan(files: Record<string, string | Buffer>, extra: string[] = [], track: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "cw-priv-"));
  try {
    const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, body);
    }
    if (track.length > 0) git("add", "--", ...track);
    return spawnSync(process.execPath, [scriptPath, "--root", dir, "--no-pack", ...extra], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const winRoot = ["C:", "Users", "someperson", "proj"].join("\\");
const unixRoot = ["", "home", "someperson", "proj"].join("/");
const macRoot = ["", "Users", "someperson"].join("/");
const uuid = ["123e4567", "e89b", "42d3", "a456", "426614174000"].join("-");

test("scanner passes clean synthetic trees and placeholders", () => {
  const r = scan({
    "README.md": `see ~/.claude and ${["", "Users", "<user>"].join("/")} and ${["", "home", "user"].join("/")}\n`,
    "test/fixtures/synthetic/a.jsonl": `{"id":"${uuid}"}\n`,
    "src/a.ts": "export {};\n",
  });
  assert.equal(r.status, 0, r.stderr);
});

test("scanner flags home paths, Windows paths, uuids and canaries without echoing them", () => {
  const c = makeCanary();
  const r = scan({
    "a.md": `${winRoot}\n`,
    "b.md": `${unixRoot}\n`,
    "c.md": `${macRoot}\n`,
    "d.json": `{"id":"${uuid}"}\n`,
    "e.txt": `${c}\n`,
    "src/f.ts": `const p = "${winRoot.replace(/\\/g, "\\\\")}";\n`,
  });
  assert.equal(r.status, 1);
  for (const rule of ["win-path a.md:1", "home-path b.md:1", "home-path c.md:1", "uuid d.json:1", "canary e.txt:1", "win-path src/f.ts:1"]) {
    assert.ok(r.stderr.includes(rule), `${rule}\n${r.stderr}`);
  }
  for (const secret of ["someperson", uuid, c]) assert.equal(r.stderr.includes(secret), false);
});

test("scanner honours configured canaries and their encodings", () => {
  const c = makeCanary().replace("CANARY_", "SECRETWORD");
  const r = scan(
    { "x.txt": `${Buffer.from(c).toString("base64")}\n`, "y.txt": `${c.toLowerCase()}\n`, "z.txt": "clean\n" },
    ["--canary", c],
  );
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("canary x.txt:1"));
  assert.ok(r.stderr.includes("canary y.txt:1"));
  assert.equal(r.stderr.includes("z.txt"), false);
});

test("scanner covers untracked files, tracked files, and skips ignored ones", () => {
  const r = scan(
    {
      ".gitignore": "ignored.md\n",
      "tracked.md": `${winRoot}\n`,
      "untracked.md": `${unixRoot}\n`,
      "ignored.md": `${winRoot}\n`,
    },
    [],
    [".gitignore", "tracked.md"],
  );
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("win-path tracked.md:1"), r.stderr);
  assert.ok(r.stderr.includes("home-path untracked.md:1"), r.stderr);
  assert.equal(r.stderr.includes("ignored.md"), false);
});

test("scanner flags MSYS (/c/Users) and /root home paths", () => {
  const msys = ["", "c", "Users", "someperson", "x"].join("/");
  const root = ["", "root", "work", "proj"].join("/");
  const r = scan({ "m.md": `see ${msys} and\n`, "r.md": `at ${root}\n`, "ok.md": "the /root of the tree\n" });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("home-path m.md:1"), r.stderr);
  assert.ok(r.stderr.includes("home-path r.md:1"), r.stderr);
  assert.equal(r.stderr.includes("ok.md"), false);
  assert.equal(r.stderr.includes("someperson"), false);
});

test("scanner decodes UTF-16 text and reports skipped binaries", () => {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${winRoot}\r\n`, "utf16le")]);
  const noBom = Buffer.from(`ok\n${winRoot}\n`, "utf16le");
  const be = Buffer.from(`${unixRoot}\n`, "utf16le");
  be.swap16();
  const binary = Buffer.from([0, 1, 2, 3, 0, 0, 255, 254, 0, 9, 0, 0, 0, 0, 7, 7]);
  const r = scan({ "le.txt": le, "nobom.txt": noBom, "be.txt": Buffer.concat([Buffer.from([0xfe, 0xff]), be]), "blob.bin": binary });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("win-path le.txt:1"), r.stderr);
  assert.ok(r.stderr.includes("win-path nobom.txt:2"), r.stderr);
  assert.ok(r.stderr.includes("home-path be.txt:1"), r.stderr);
  assert.equal(r.stderr.includes("blob.bin"), false);
  assert.match(r.stderr, /content not scanned: 1 binary, 0 oversize/);
  const clean = scan({ "blob.bin": binary });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /content not scanned: 1 binary, 0 oversize/);
});

test("scanner reads large files in chunks and reports the right line", () => {
  const filler = "x".repeat(1000) + "\n";
  const body = filler.repeat(2500) + `${winRoot}\n`; // about 2.5 MiB, finding after chunk boundaries
  const r = scan({ "big.log": body });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("win-path big.log:2501"), r.stderr);
});

// --- canary trees from the fixture generator (R14.7) ------------------------

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Build all scenarios with a per run canary and write them to a temp dir. */
function canaryTrees(canary: string): { dir: string; files: Map<string, GeneratedFile[]> } {
  const dir = mkdtempSync(join(tmpdir(), "cw-canary-tree-"));
  const files = new Map<string, GeneratedFile[]>();
  for (const sc of scenarios) {
    const built = sc.build({ canary });
    files.set(sc.name, built);
    writeFiles(join(dir, sc.name), built);
  }
  return { dir, files };
}

/** Text of a generated file: plain text for .zst files, content otherwise. */
const textOf = (f: GeneratedFile): string => f.plain ?? String(f.content);

test("generator plants the canary in every dropped field of every file kind", () => {
  const c = makeCanary();
  const { dir, files } = canaryTrees(c);
  try {
    const all = [...files.values()].flat();
    const by = (suffix: string) => all.filter((f) => f.path.endsWith(suffix));
    const has = (f: GeneratedFile, needle: string) => textOf(f).includes(needle);

    const mains = all.filter((f) => /projects\/[^/]+\/[^/]+\.jsonl$/.test(f.path));
    assert.ok(mains.length >= 4);
    for (const f of mains) {
      for (const needle of [
        `"cwd":"/synthetic/${c}"`, `"gitBranch":"branch-${c}"`, `"slug":"slug-${c}"`, `"title":"title-${c}"`,
        `"text":"${c}"`, `unknown_${c}`, `"type":"unknown-${c}"`, `model-${c}`, `"version":"v-${c}"`,
      ]) {
        assert.ok(has(f, needle), `${f.path} lacks ${needle.replace(c, "<canary>")}`);
      }
      // Truncated last line: no trailing newline, cut inside a string, carries the canary.
      const text = textOf(f);
      assert.equal(text.endsWith("\n"), false);
      const last = text.slice(text.lastIndexOf("\n") + 1);
      assert.ok(last.includes(c));
      assert.throws(() => JSON.parse(last));
      // Project directory names carry the canary too.
      assert.ok(f.path.split("/")[1]!.includes(c));
    }
    const allText = all.map(textOf).join("\n");
    assert.ok(allText.includes(`"input":{"command":"${c}"`), "tool_use input");
    assert.ok(allText.includes(`"tool_use_id":`) && allText.includes(`"content":"${c}"`), "tool_result content");
    assert.ok(allText.includes(`"thinking":"${c}"`), "thinking");

    for (const f of by(".meta.json")) {
      const m = JSON.parse(textOf(f));
      assert.equal(m.description, c);
      assert.equal(m.worktreePath, `/synthetic/${c}`);
    }
    const runs = all.filter((f) => /\/workflows\/wf_[^/]+\.json$/.test(f.path) && !f.path.includes("/subagents/"));
    assert.ok(runs.length >= 2);
    for (const f of runs) {
      const j = JSON.parse(textOf(f));
      assert.deepEqual([j.label, j.result], [c, c]);
    }
    const journals = by("/journal.jsonl");
    assert.ok(journals.length >= 3);
    for (const f of journals) {
      for (const row of textOf(f).trim().split("\n").map((l) => JSON.parse(l))) assert.deepEqual([row.key, row.label, row.result], [c, c, c]);
    }
    const prefixes = by(".prefix.json");
    assert.ok(prefixes.length >= 2);
    for (const f of prefixes) assert.equal(JSON.parse(textOf(f)).note, c);

    const codex = all.filter((f) => f.path.includes("rollout-"));
    assert.ok(codex.length >= 6);
    assert.ok(codex.every((f) => f.path.includes(c)), "codex file names carry the canary");
    const codexText = codex.map(textOf).join("\n");
    for (const needle of [
      `"base_instructions":"${c}"`, `"agent_nickname":"${c}"`, `"agent_path":"${c}"`, `"cwd":"/synthetic/${c}"`,
      `"developer_instructions":"${c}"`, `"content":"${c}"`, `"message":"${c}"`, `"replacement_history":["${c}"]`,
      `unknown_${c}`, `"type":"unknown-${c}"`, `model-${c}`, `"cli_version":"v-${c}"`,
    ]) {
      assert.ok(codexText.includes(needle), `codex lacks ${needle.replace(c, "<canary>")}`);
    }
    // The archived .zst is checked through its plain text, and its name carries the canary.
    const z = codex.find((f) => f.path.endsWith(".zst"));
    assert.ok(z?.plain?.includes(c));
    // Every available file is on disk (a Node without zstd skips only the unavailable .zst bytes).
    assert.equal(walk(dir).length, all.filter((f) => !f.unavailable).length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canary trees: every command output and every error path stays clean", async () => {
  const c = makeCanary();
  const { dir } = canaryTrees(c);
  try {
    const outputs: string[] = [];
    const harness = (): { h: CliIO; out: string[]; err: string[] } => {
      const out: string[] = [];
      const err: string[] = [];
      return { h: { out: (x) => out.push(x), err: (x) => err.push(x), env: {}, isTTY: false }, out, err };
    };
    const none = join(dir, "does-not-exist");
    for (const sc of scenarios) {
      const root = join(dir, sc.name);
      const dirs = sc.name.startsWith("codex") ? ["--codex-dir", root, "--claude-dir", none] : ["--claude-dir", root, "--codex-dir", none];
      for (const extra of [[], ["--json"], ["--agent", "claude"], ["--agent", "codex", "--json"], ["--no-color"]]) {
        const t = harness();
        assert.equal(await run(["doctor", ...extra, ...dirs], t.h), 0);
        outputs.push(...t.out, ...t.err);
      }
    }
    for (const argv of [["pricing"], ["summary", "--demo"], ["session", "synthetic-x"], ["evidence", "synthetic-x"], ["nope"], ["--since", "bad"], ["doctor", "--agent", "bad"]]) {
      const t = harness();
      await run(argv, t.h);
      outputs.push(...t.out, ...t.err);
    }
    assert.ok(outputs.length > 10);
    for (const o of outputs) assert.equal(leaks(o, c), false, o.slice(0, 80));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canary trees: truncated lines and unknown records never reach safe output", async () => {
  const c = makeCanary();
  const { dir, files } = canaryTrees(c);
  try {
    let truncated = 0;
    for (const [name, built] of files) {
      for (const f of built) {
        if (f.unavailable || !/\.jsonl(\.zst)?$/.test(f.path)) continue;
        let n = 0;
        for await (const rec of readLines(join(dir, name, ...f.path.split("/")))) {
          n++;
          const r = parseJsonLineSafe(rec.text, rec.ordinal + 1, "file_1");
          if (!r.ok) {
            truncated++;
            assert.equal(rec.terminated, false, "only the last line is cut");
            const shown = formatError(r.error);
            assert.equal(leaks(shown, c), false);
            assert.equal(shown, `E_JSON_PARSE in file_1 line ${rec.ordinal + 1}`);
          }
        }
        assert.ok(n > 0, f.path);
      }
    }
    // One truncated tail per Claude main file and per last Codex file of each thread.
    assert.ok(truncated >= 8, `truncated lines seen: ${truncated}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repo scanner flags a canary tree and accepts the committed trees", () => {
  const c = makeCanary();
  const { dir } = canaryTrees(c);
  try {
    const rels = walk(dir).map((p) => relative(dir, p).split("\\").join("/"));
    const body: Record<string, string | Buffer> = {};
    for (const rel of rels.filter((r) => !r.endsWith(".zst"))) body[`tree/${rel}`] = readFileSync(join(dir, ...rel.split("/")));
    const r = scan(body);
    assert.equal(r.status, 1);
    assert.ok(/canary tree\/claude-basic\/projects\/\S*\.jsonl:\d+/.test(r.stderr), r.stderr.slice(0, 400));
    assert.ok(/canary tree\/claude-basic\/projects\/\S*:name/.test(r.stderr), "directory names are scanned");
    assert.equal(r.stderr.includes(c), false);
    // The committed trees are built without a canary: the scanner accepts them.
    const committed = scan(
      Object.fromEntries(
        scenarios.flatMap((sc) =>
          sc.build().filter((f) => !f.unavailable && f.plain === undefined).map((f) => [`test/fixtures/synthetic/${sc.name}/${f.path}`, textOf(f)]),
        ),
      ),
    );
    assert.equal(committed.status, 0, committed.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
