#!/usr/bin/env node
// Repo privacy scan. Spec: docs/methodology.md R14.7 and R14.8.
//
// Scans git-tracked files, untracked files that are not ignored, and the `npm pack` file list for:
//   home-path    absolute Unix/macOS home paths and WSL mounts of user folders
//   win-path     Windows user profile paths (drive letter, Users folder, name)
//   uuid         UUID-like ids outside test/fixtures/synthetic/
//   canary       default CANARY_<16 hex> pattern plus any configured canary
//   pack-path    (pack list only) a path outside the package allowlist
//   pack-deps    package.json declares runtime dependencies
//
// Findings print as `rule path:line` and NEVER include the matched text.
// Exit codes: 0 clean, 1 findings, 2 usage or tooling error.
//
// Usage: node scripts/check-repo-privacy.mjs [options]
//   --root <dir>            repository root (default: git toplevel of the cwd)
//   --canary <text>         extra canary (repeatable). Also CACHEWHY_CANARIES (comma separated)
//   --canary-file <file>    JSON array or one canary per line (keep this file outside the repo)
//   --allow-name <name>     extra placeholder user name allowed after a home path (repeatable)
//   --pack-allow <prefix>   replace the pack path allowlist (repeatable). Default below.
//   --no-pack               skip the npm pack scan
//   --no-pack-allowlist     scan pack contents but skip the path allowlist and deps checks

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { resolve, join } from "node:path";
import process from "node:process";

const SYNTHETIC_PREFIX = "test/fixtures/synthetic/";
const DEFAULT_PACK_ALLOW = ["dist/", "README.md", "LICENSE", "package.json", "demo/"];
// UTF-16 files are decoded whole, so they are capped. UTF-8 files are scanned in chunks (any size)
// unless a single line exceeds MAX_LINE_BYTES. Files that cannot be scanned are counted and
// reported in the summary, never skipped silently.
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const HEAD_BYTES = 8192;
const DEFAULT_ALLOWED_NAMES = [
  "user", "username", "you", "your-name", "yourname", "name", "me", "example", "foo", "bar",
  "runner", "public", "default", "shared", "test", "tester", "someone", "alice", "bob", "dev",
];

const UNIX_HOME = /(?:^|[^A-Za-z0-9_.\-])\/(?:Users|home)\/([A-Za-z0-9._-]+)/g;
// Git Bash / MSYS / Cygwin style: /c/Users/<name>
const MSYS_HOME = /(?:^|[^A-Za-z0-9_.\-])\/[A-Za-z]\/Users\/([A-Za-z0-9._-]+)/gi;
// Root user's home: /root/<something>
const ROOT_HOME = /(?:^|[^A-Za-z0-9_.\-])\/root\/([A-Za-z0-9._-]+)/g;
const WSL_HOME = /\/mnt\/[a-z]\/Users\/([A-Za-z0-9._-]+)/gi;
const WIN_HOME = /[A-Za-z]:(?:\\|\/)+Users(?:\\|\/)+([A-Za-z0-9._-]+)/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const DEFAULT_CANARY = /CANARY_[0-9a-fA-F]{16}/;
const TRIVIAL_UUIDS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
]);

function fail(msg) {
  process.stderr.write(`check-repo-privacy: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const o = {
    root: null, canaries: [], canaryFiles: [], allowNames: [], packAllow: [],
    pack: true, packAllowlist: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) fail(`missing value for ${a}`);
      return v;
    };
    if (a === "--root") o.root = val();
    else if (a === "--canary") o.canaries.push(val());
    else if (a === "--canary-file") o.canaryFiles.push(val());
    else if (a === "--allow-name") o.allowNames.push(val().toLowerCase());
    else if (a === "--pack-allow") o.packAllow.push(val());
    else if (a === "--no-pack") o.pack = false;
    else if (a === "--no-pack-allowlist") o.packAllowlist = false;
    else fail(`unknown option ${a}`);
  }
  return o;
}

function run(cmd, args, cwd) {
  // shell on Windows so npm.cmd resolves; arguments are fixed strings, never user input.
  const win = process.platform === "win32";
  const opts = { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, shell: win };
  const r = win ? spawnSync([cmd, ...args].join(" "), opts) : spawnSync(cmd, args, opts);
  if (r.status !== 0) fail(`${cmd} ${args[0]} failed with status ${r.status}`);
  return r.stdout;
}

function canaryVariants(c) {
  const out = new Set();
  const add = (x) => { if (x.length >= 8) out.add(x.toLowerCase()); };
  add(c);
  add(Buffer.from(c, "utf8").toString("base64").replace(/=+$/, ""));
  add(encodeURIComponent(c));
  return [...out];
}

function loadCanaries(o) {
  const list = [...o.canaries];
  if (process.env.CACHEWHY_CANARIES) list.push(...process.env.CACHEWHY_CANARIES.split(","));
  for (const f of o.canaryFiles) {
    let text;
    try { text = readFileSync(f, "utf8"); } catch { fail("cannot read canary file"); }
    try {
      const j = JSON.parse(text);
      if (!Array.isArray(j)) throw new Error("x");
      list.push(...j.map(String));
    } catch {
      list.push(...text.split(/\r?\n/));
    }
  }
  const variants = [];
  for (const c of list.map((x) => x.trim()).filter(Boolean)) {
    if (c.length < 8) fail("configured canaries must be at least 8 characters");
    variants.push(...canaryVariants(c));
  }
  return variants;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A path as shown in findings. A path can itself carry a secret (a home path, a uuid or a canary in a
 * directory name), and findings must never echo matched text, so matches are replaced by ***.
 */
function maskPath(norm, ctx) {
  let out = norm;
  for (const re of [UNIX_HOME, MSYS_HOME, ROOT_HOME, WSL_HOME, WIN_HOME, UUID]) out = out.replace(re, "***");
  out = out.replace(new RegExp(DEFAULT_CANARY.source, "gi"), "***");
  for (const v of ctx.canaryVariants) out = out.replace(new RegExp(escapeRe(v), "gi"), "***");
  return out;
}

/** Scan text. startLine is the 1-based number of the first line of `text`. Returns the line count. */
function scanText(rel, text, ctx, hits, startLine = 1) {
  const norm = rel.replace(/\\/g, "/");
  const synthetic = norm.startsWith(SYNTHETIC_PREFIX);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    const ln = i + startLine;
    const rules = new Set();
    for (const re of [UNIX_HOME, MSYS_HOME, ROOT_HOME, WSL_HOME, WIN_HOME]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        if (!ctx.allowedNames.has(m[1].toLowerCase())) {
          rules.add(re === WIN_HOME ? "win-path" : "home-path");
        }
      }
    }
    if (!synthetic) {
      UUID.lastIndex = 0;
      let m;
      while ((m = UUID.exec(line)) !== null) {
        if (!TRIVIAL_UUIDS.has(m[0].toLowerCase())) { rules.add("uuid"); break; }
      }
    }
    if (DEFAULT_CANARY.test(line)) rules.add("canary");
    if (ctx.canaryVariants.length > 0) {
      const lower = line.toLowerCase();
      if (ctx.canaryVariants.some((v) => lower.includes(v))) rules.add("canary");
    }
    for (const r of rules) hits.push(`${r} ${maskPath(norm, ctx)}:${ln}`);
  }
  return lines.length - 1;
}

/** Classify by the first bytes: utf8, utf16le, utf16be or binary. */
function classify(head) {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return "utf16le";
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return "utf16be";
  if (!head.includes(0)) return "utf8";
  // BOM-less UTF-16 of mostly ASCII text: NUL bytes sit on one byte parity.
  let even = 0;
  let odd = 0;
  for (let i = 0; i < head.length; i++) {
    if (head[i] === 0) { if (i % 2 === 0) even++; else odd++; }
  }
  const nuls = even + odd;
  if (nuls * 4 >= head.length && Math.max(even, odd) * 10 >= nuls * 9) return odd > even ? "utf16le" : "utf16be";
  return "binary";
}

function decodeUtf16(buf, kind) {
  let b = buf;
  if (b.length >= 2 && ((kind === "utf16le" && b[0] === 0xff && b[1] === 0xfe) || (kind === "utf16be" && b[0] === 0xfe && b[1] === 0xff))) {
    b = b.subarray(2);
  }
  if (b.length % 2 === 1) b = b.subarray(0, b.length - 1);
  if (kind === "utf16le") return b.toString("utf16le");
  const swapped = Buffer.from(b);
  swapped.swap16();
  return swapped.toString("utf16le");
}

/** Read a file in chunks and scan complete lines, so large files are scanned without loading them whole. */
function scanUtf8Stream(abs, rel, ctx, hits) {
  const fd = openSync(abs, "r");
  try {
    const chunk = Buffer.alloc(CHUNK_BYTES);
    let carry = Buffer.alloc(0);
    let line = 1;
    for (;;) {
      const n = readSync(fd, chunk, 0, CHUNK_BYTES, null);
      if (n === 0) break;
      const buf = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, n)]) : Buffer.from(chunk.subarray(0, n));
      const nl = buf.lastIndexOf(0x0a);
      if (nl === -1) {
        if (buf.length > MAX_LINE_BYTES) return false;
        carry = buf;
        continue;
      }
      line += scanText(rel, buf.subarray(0, nl + 1).toString("utf8"), ctx, hits, line);
      carry = Buffer.from(buf.subarray(nl + 1));
    }
    if (carry.length > 0) scanText(rel, carry.toString("utf8"), ctx, hits, line);
    return true;
  } finally {
    closeSync(fd);
  }
}

function scanFile(root, rel, ctx, hits, skipped) {
  // Scan the name as text (line 0), then the content.
  const before = hits.length;
  scanText(rel, rel, ctx, hits);
  for (let i = before; i < hits.length; i++) hits[i] = hits[i].replace(/:1$/, ":name");
  const abs = join(root, rel);
  let st;
  try { st = statSync(abs); } catch { return; }
  if (!st.isFile()) return;
  const norm = rel.replace(/\\/g, "/");
  const head = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
  if (head.length > 0) {
    const fd = openSync(abs, "r");
    try { readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
  }
  const kind = classify(head);
  if (kind === "binary") { skipped.binary.add(norm); return; }
  if (kind === "utf8") {
    if (!scanUtf8Stream(abs, rel, ctx, hits)) skipped.oversize.add(norm);
    return;
  }
  if (st.size > MAX_SCAN_BYTES) { skipped.oversize.add(norm); return; }
  scanText(rel, decodeUtf16(readFileSync(abs), kind), ctx, hits);
}

function packAllowed(path, allow) {
  const p = path.replace(/\\/g, "/");
  return allow.some((a) => (a.endsWith("/") ? p.startsWith(a) : p === a));
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const cwd = o.root ? resolve(o.root) : process.cwd();
  const root = o.root ? cwd : run("git", ["rev-parse", "--show-toplevel"], cwd).trim();
  const ctx = {
    allowedNames: new Set([...DEFAULT_ALLOWED_NAMES, ...o.allowNames]),
    canaryVariants: loadCanaries(o),
  };
  const hits = [];
  const skipped = { binary: new Set(), oversize: new Set() };

  // Tracked files plus untracked files that are not ignored: a file is scanned before it is committed.
  const listed = run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root)
    .split("\0")
    .filter(Boolean);
  const tracked = [...new Set(listed)];
  for (const rel of tracked) scanFile(root, rel, ctx, hits, skipped);

  let packCount = 0;
  if (o.pack) {
    if (!existsSync(join(root, "package.json"))) fail("no package.json for the pack scan");
    const raw = run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], root);
    let packed;
    try { packed = JSON.parse(raw)[0].files.map((f) => f.path); } catch { fail("cannot parse npm pack output"); }
    const allow = o.packAllow.length > 0 ? o.packAllow : DEFAULT_PACK_ALLOW;
    for (const rel of packed) {
      packCount++;
      if (o.packAllowlist && !packAllowed(rel, allow)) hits.push(`pack-path ${maskPath(rel.replace(/\\/g, "/"), ctx)}:name`);
      scanFile(root, rel, ctx, hits, skipped);
    }
    if (o.packAllowlist) {
      try {
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
        if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) hits.push("pack-deps package.json:dependencies");
      } catch { fail("cannot parse package.json"); }
    }
  }

  const skipNote =
    skipped.binary.size + skipped.oversize.size > 0
      ? `; content not scanned: ${skipped.binary.size} binary, ${skipped.oversize.size} oversize`
      : "";
  const unique = [...new Set(hits)];
  if (unique.length > 0) {
    process.stderr.write(`check-repo-privacy: ${unique.length} finding(s)${skipNote}\n`);
    for (const h of unique) process.stderr.write(`  ${h}\n`);
    process.exit(1);
  }
  process.stdout.write(`check-repo-privacy: clean (${tracked.length} files, ${packCount} packed${skipNote})\n`);
  for (const p of skipped.oversize) process.stdout.write(`  oversize, not scanned: ${maskPath(p, ctx)}\n`);
}

main();
