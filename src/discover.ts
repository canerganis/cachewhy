import { promises as fsp, realpath as realpathCb } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const realpath = promisify(realpathCb.native);

export type SourceKind =
  | "claude-main"
  | "claude-subagent"
  | "claude-subagent-meta"
  | "claude-subagent-prefix"
  | "claude-workflow-journal"
  | "claude-workflow-run"
  | "codex-rollout"
  | "codex-archived-zst";

export type SourceAgent = "claude" | "codex";

export interface DiscoveredFile {
  kind: SourceKind;
  agent: SourceAgent;
  /** Absolute path as found (not symlink-resolved). */
  path: string;
  /** Path relative to the root it was found under, with "/" separators. */
  relPath: string;
  /** Absolute root directory (projects/, sessions/ or archived_sessions/) it was found under. */
  root: string;
  size: number;
  mtimeMs: number;
  /** Claude: session uuid (main file stem, or the directory above subagents/ or workflows/). */
  sessionId?: string | undefined;
  /** Claude subagent, meta and prefix files: the id in agent-<id>. */
  agentId?: string | undefined;
  /** Claude workflow files: the id in wf_<runId>. */
  runId?: string | undefined;
  /** Claude subagent files living under subagents/workflows/wf_*. */
  workflowAgent?: boolean | undefined;
}

export type DiagnosticCode =
  | "root_missing"
  | "root_not_directory"
  | "root_duplicate"
  | "root_unreadable"
  | "dir_unreadable"
  | "file_unreadable"
  | "symlink_loop_skipped";

export interface Diagnostic {
  level: "info" | "warn";
  code: DiagnosticCode;
  path: string;
  message: string;
}

export interface DiscoverOptions {
  /** Explicit Claude locations (--claude-dir). Either a config dir containing projects/ or a projects dir. Replaces the defaults. */
  claudeDirs?: string[];
  /** Explicit Codex locations (--codex-dir). Either a CODEX_HOME style dir or a sessions or archived_sessions dir. Replaces the defaults. */
  codexDirs?: string[];
  /** Environment to read CLAUDE_CONFIG_DIR, CODEX_HOME and XDG_CONFIG_HOME from. Default process.env. */
  env?: Record<string, string | undefined>;
  /** Home directory. Default os.homedir(). */
  home?: string;
}

/**
 * `--project` membership (R5.9: an output filter, never a read filter). A project is a Claude project directory,
 * the first path segment under the scan root. Codex logs have none (R1.1).
 */
export function inProject(f: Pick<DiscoveredFile, "agent" | "relPath">, project: string): boolean {
  return f.agent === "claude" && f.relPath.split("/")[0] === project;
}

export interface DiscoverResult {
  files: DiscoveredFile[];
  diagnostics: Diagnostic[];
  /** Distinct, symlink-resolved roots that were actually scanned. */
  roots: { agent: SourceAgent; path: string }[];
}

interface Candidate {
  agent: SourceAgent;
  path: string;
  explicit: boolean;
}

type ClassifiedClaude = Pick<DiscoveredFile, "kind" | "sessionId" | "agentId" | "runId" | "workflowAgent">;

function splitList(v: string | undefined): string[] {
  if (!v) return [];
  // Comma separated per spec; also tolerate the platform path delimiter.
  return v
    .split(v.includes(",") ? "," : delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function key(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

async function claudeCandidates(
  opts: DiscoverOptions,
  env: Record<string, string | undefined>,
  home: string,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  if (opts.claudeDirs && opts.claudeDirs.length > 0) {
    for (const d of opts.claudeDirs) {
      const abs = resolve(d);
      const sub = join(abs, "projects");
      out.push({ agent: "claude", path: (await isDir(sub)) ? sub : abs, explicit: true });
    }
    return out;
  }
  for (const d of splitList(env["CLAUDE_CONFIG_DIR"])) {
    out.push({ agent: "claude", path: join(resolve(d), "projects"), explicit: true });
  }
  out.push({ agent: "claude", path: join(home, ".claude", "projects"), explicit: false });
  const xdgRaw = env["XDG_CONFIG_HOME"];
  const xdg = xdgRaw ? resolve(xdgRaw) : join(home, ".config");
  out.push({ agent: "claude", path: join(xdg, "claude", "projects"), explicit: false });
  return out;
}

async function codexCandidates(
  opts: DiscoverOptions,
  env: Record<string, string | undefined>,
  home: string,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const fromHome = (h: string, explicit: boolean): void => {
    out.push({ agent: "codex", path: join(h, "sessions"), explicit });
    out.push({ agent: "codex", path: join(h, "archived_sessions"), explicit });
  };
  if (opts.codexDirs && opts.codexDirs.length > 0) {
    for (const d of opts.codexDirs) {
      const abs = resolve(d);
      const name = basename(abs);
      const hasSub = (await isDir(join(abs, "sessions"))) || (await isDir(join(abs, "archived_sessions")));
      if (!hasSub && (name === "sessions" || name === "archived_sessions")) {
        out.push({ agent: "codex", path: abs, explicit: true });
      } else {
        fromHome(abs, true);
      }
    }
    return out;
  }
  const codexHome = env["CODEX_HOME"];
  if (codexHome) fromHome(resolve(codexHome), true);
  fromHome(join(home, ".codex"), false);
  return out;
}

const ROLLOUT_RE = /^rollout-.*\.jsonl$/;
const ROLLOUT_ZST_RE = /^rollout-.*\.jsonl\.zst$/;

/** Classify a Claude file given path segments relative to a projects/ root. Null for files we do not read. */
export function classifyClaude(segments: string[]): ClassifiedClaude | null {
  const name = segments[segments.length - 1] ?? "";
  const subIdx = segments.indexOf("subagents");
  if (subIdx >= 1 && subIdx < segments.length - 1) {
    const sessionId = segments[subIdx - 1];
    if (segments[subIdx + 1] === "workflows") {
      // Exactly subagents/workflows/wf_<runId>/<file>.
      const wf = /^wf_(.+)$/.exec(segments[subIdx + 2] ?? "");
      if (!wf || segments.length !== subIdx + 4) return null;
      const runId = wf[1];
      if (name === "journal.jsonl") return { kind: "claude-workflow-journal", sessionId, runId, workflowAgent: true } as ClassifiedClaude;
      const a = /^agent-(.+)\.jsonl$/.exec(name);
      if (a) return { kind: "claude-subagent", sessionId, agentId: a[1], runId, workflowAgent: true };
      return null;
    }
    if (segments.length !== subIdx + 2) return null;
    let m = /^agent-(.+)\.jsonl$/.exec(name);
    if (m) return { kind: "claude-subagent", sessionId, agentId: m[1] };
    m = /^agent-(.+)\.meta\.json$/.exec(name);
    if (m) return { kind: "claude-subagent-meta", sessionId, agentId: m[1] };
    m = /^agent-(.+)\.prefix\.json$/.exec(name);
    if (m) return { kind: "claude-subagent-prefix", sessionId, agentId: m[1] };
    return null;
  }
  // <project>/<session>.jsonl
  if (segments.length === 2 && name.endsWith(".jsonl")) {
    return { kind: "claude-main", sessionId: name.slice(0, -".jsonl".length) };
  }
  // <project>/<session>/workflows/wf_<runId>.json
  if (segments.length === 4 && segments[2] === "workflows") {
    const m = /^wf_(.+)\.json$/.exec(name);
    if (m) return { kind: "claude-workflow-run", sessionId: segments[1], runId: m[1] };
  }
  return null;
}

function classifyCodex(name: string): SourceKind | null {
  if (ROLLOUT_ZST_RE.test(name)) return "codex-archived-zst";
  if (ROLLOUT_RE.test(name)) return "codex-rollout";
  return null;
}

/**
 * Locate Claude Code and Codex log files. Never throws for missing or unreadable
 * directories: problems are returned as diagnostics. Roots are deduplicated by
 * resolved real path, and files by resolved real path, so symlinks, repeated
 * roots and nested roots yield each file once. Output is sorted by path.
 */
export async function discover(opts: DiscoverOptions = {}): Promise<DiscoverResult> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const diagnostics: Diagnostic[] = [];
  const files: DiscoveredFile[] = [];
  const roots: DiscoverResult["roots"] = [];
  const seenRoots = new Set<string>();
  const seenDirs = new Set<string>();
  const seenFiles = new Set<string>();

  /**
   * R0.9 `file_unreadable`: a directory that cannot be listed counts as a file that cannot be read. Its logs are
   * unknown, so it stays in the list as one unreadable entry (size and mtime unknown, so never live). The parser
   * fails to read it, counts it in `files_unreadable` and raises the trigger, which names no chain and taints the
   * provider of that root. The scan is never withheld as a whole for this.
   */
  function unreadableEntry(agent: SourceAgent, path: string, rootPath: string): void {
    const relPath = relative(rootPath, path).split(sep).join("/");
    files.push({ kind: agent === "claude" ? "claude-main" : "codex-rollout", agent, path, relPath, root: rootPath, size: 0, mtimeMs: 0 });
  }

  async function walk(c: Candidate, rootReal: string): Promise<void> {
    const rootPath = c.path;
    const stack: { dir: string; real: string }[] = [{ dir: rootPath, real: rootReal }];
    while (stack.length > 0) {
      const cur = stack.pop() as { dir: string; real: string };
      const dirKey = key(cur.real);
      if (seenDirs.has(dirKey)) {
        if (cur.dir !== rootPath) {
          diagnostics.push({ level: "info", code: "symlink_loop_skipped", path: cur.dir, message: "directory already visited" });
        }
        continue;
      }
      seenDirs.add(dirKey);
      let entries: Dirent[];
      try {
        entries = await fsp.readdir(cur.dir, { withFileTypes: true });
      } catch (e) {
        diagnostics.push({
          level: "warn",
          code: cur.dir === rootPath ? "root_unreadable" : "dir_unreadable",
          path: cur.dir,
          message: `cannot read directory: ${(e as NodeJS.ErrnoException).code ?? "error"}`,
        });
        unreadableEntry(c.agent, cur.dir, rootPath);
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const ent of entries) {
        const p = join(cur.dir, ent.name);
        let isDirectory = ent.isDirectory();
        let isFile = ent.isFile();
        if (ent.isSymbolicLink()) {
          try {
            const st = await fsp.stat(p);
            isDirectory = st.isDirectory();
            isFile = st.isFile();
          } catch {
            diagnostics.push({ level: "info", code: "file_unreadable", path: p, message: "broken symlink" });
            continue;
          }
        }
        if (isDirectory) {
          try {
            stack.push({ dir: p, real: await realpath(p) });
          } catch {
            diagnostics.push({ level: "warn", code: "dir_unreadable", path: p, message: "cannot resolve directory" });
            unreadableEntry(c.agent, p, rootPath);
          }
          continue;
        }
        if (!isFile) continue;
        const relPath = relative(rootPath, p).split(sep).join("/");
        let info: { kind: SourceKind } & Partial<ClassifiedClaude>;
        if (c.agent === "claude") {
          const cl = classifyClaude(relPath.split("/"));
          if (!cl) continue;
          info = cl;
        } else {
          const kind = classifyCodex(ent.name);
          if (!kind) continue;
          info = { kind };
        }
        try {
          const [st, fileReal] = await Promise.all([fsp.stat(p), realpath(p)]);
          const fileKey = key(fileReal);
          if (seenFiles.has(fileKey)) continue;
          seenFiles.add(fileKey);
          files.push({ ...info, agent: c.agent, path: p, relPath, root: rootPath, size: st.size, mtimeMs: st.mtimeMs });
        } catch (e) {
          diagnostics.push({
            level: "warn",
            code: "file_unreadable",
            path: p,
            message: `cannot stat: ${(e as NodeJS.ErrnoException).code ?? "error"}`,
          });
          // R0.9 file_unreadable: a log file that cannot be examined must not vanish from the scan. It stays in the
          // list (size and mtime unknown, so never live) so that the parser reports it as unreadable and taints the
          // provider.
          files.push({ ...info, agent: c.agent, path: p, relPath, root: rootPath, size: 0, mtimeMs: 0 });
        }
      }
    }
  }

  const candidates = [...(await claudeCandidates(opts, env, home)), ...(await codexCandidates(opts, env, home))];
  for (const c of candidates) {
    let real: string;
    try {
      real = await realpath(c.path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        diagnostics.push({ level: c.explicit ? "warn" : "info", code: "root_missing", path: c.path, message: "directory does not exist" });
      } else {
        diagnostics.push({ level: "warn", code: "root_unreadable", path: c.path, message: `cannot resolve: ${code ?? "error"}` });
        unreadableEntry(c.agent, c.path, c.path);
      }
      continue;
    }
    if (!(await isDir(real))) {
      diagnostics.push({ level: "warn", code: "root_not_directory", path: c.path, message: "not a directory" });
      continue;
    }
    const rootKey = `${c.agent}:${key(real)}`;
    if (seenRoots.has(rootKey)) {
      diagnostics.push({ level: "info", code: "root_duplicate", path: c.path, message: "same directory already scanned" });
      continue;
    }
    seenRoots.add(rootKey);
    roots.push({ agent: c.agent, path: real });
    await walk(c, real);
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, diagnostics, roots };
}
