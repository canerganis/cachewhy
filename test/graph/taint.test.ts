// Tests for src/graph/taint.ts (spec R0.9). Inputs are synthetic integrity facts: no log, no real id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTaint, isLiveFile } from "../../src/graph/taint.js";
import { CONSTANTS, TAINT_REASONS, chainIdOf } from "../../src/model/types.js";
import type { ChainId, ChainKey, FileFacts, IntegrityFacts, Provider, TaintReason, TaintTrigger } from "../../src/model/types.js";

const RUN = Date.UTC(2026, 5, 1, 12, 0, 0);
const C35_MS = CONSTANTS.LIVE_WINDOW_S * 1000;

const cl = (session: string, thread = "main"): ChainId => chainIdOf({ provider: "claude", root_session: session, thread } satisfies ChainKey);
const cx = (thread: string): ChainId => chainIdOf({ provider: "codex", root_session: "unused", thread } satisfies ChainKey);

function facts(provider: Provider, o: Partial<IntegrityFacts> = {}): IntegrityFacts {
  return { provider, chains: [], family_groups: [], triggers: [], files: [], ...o };
}

function file(index: number, provider: Provider, named: ChainId[], o: Partial<FileFacts> = {}): FileFacts {
  return { index, provider, mtime_ms: RUN - 86_400_000, named_chains: [...named].sort(), unparsed_lines: 0, readable: true, ...o };
}

const run = (f: IntegrityFacts, files: readonly FileFacts[] = f.files) => computeTaint(f, files, RUN);

// ---------------------------------------------------------------------------
// ChainId (R0.9)
// ---------------------------------------------------------------------------

test("R0.9 chainIdOf: Claude names session and agent, Codex names only the thread", () => {
  assert.equal(chainIdOf({ provider: "claude", root_session: "s", thread: "main" }), "claude\u0000s\u0000main");
  assert.equal(chainIdOf({ provider: "codex", root_session: "any session", thread: "t" }), "codex\u0000t");
  assert.equal(
    chainIdOf({ provider: "codex", root_session: "a", thread: "t" }),
    chainIdOf({ provider: "codex", root_session: "b", thread: "t" }),
    "divergent session ids of one Codex thread are one chain (R4.11)",
  );
});

// ---------------------------------------------------------------------------
// one case per reason, named and provider-wide (R0.9 table)
// ---------------------------------------------------------------------------

const TRIGGER_REASONS = TAINT_REASONS.filter((r): r is TaintTrigger["reason"] => r !== "unparsed_line");

for (const reason of TRIGGER_REASONS) {
  test(`R0.9 ${reason}: a trigger taints the family of the chain it names and no other family`, () => {
    const a = cl("s1");
    const a2 = cl("s1", "ag");
    const b = cl("s2");
    const t = run(
      facts("claude", { chains: [a, a2, b], family_groups: [[a, a2]], triggers: [{ reason, names: [a2] }] }),
    );
    for (const id of [a, a2]) {
      const c = t.chains.get(id);
      assert.equal(c?.tainted, true, id);
      assert.deepEqual(c?.reasons, [reason]);
    }
    assert.equal(t.chains.get(b)?.tainted, false);
    assert.deepEqual(t.chains.get(b)?.reasons, []);
    assert.equal(t.chains_total, 3);
    assert.equal(t.chains_tainted, 2);
    assert.equal(t.chains_tainted_by_reason[reason], 2);
    assert.equal(t.families_total, 2);
    assert.equal(t.families_tainted, 1);
    assert.deepEqual(t.provider_wide_reasons, []);
  });

  test(`R0.9 ${reason}: a trigger that names no chain taints every chain of the provider`, () => {
    const ids = [cx("t1"), cx("t2"), cx("t3")];
    const t = run(facts("codex", { chains: ids, family_groups: [[ids[0] as ChainId, ids[1] as ChainId]], triggers: [{ reason, names: "provider" }] }));
    for (const id of ids) assert.deepEqual(t.chains.get(id)?.reasons, [reason]);
    assert.equal(t.chains_tainted, 3);
    assert.equal(t.families_total, 2);
    assert.equal(t.families_tainted, 2);
    assert.deepEqual(t.provider_wide_reasons, [reason]);
  });
}

test("R0.9 unparsed_line: a file that is not live taints the chains it names, and nothing else", () => {
  const a = cl("s1");
  const b = cl("s2");
  const f = file(0, "claude", [a], { unparsed_lines: 3 });
  const t = run(facts("claude", { chains: [a, b], files: [f] }));
  assert.deepEqual(t.chains.get(a)?.reasons, ["unparsed_line"]);
  assert.equal(t.chains.get(b)?.tainted, false);
  assert.equal(t.chains_tainted_by_reason.unparsed_line, 1);
});

test("R0.9 unparsed_line: a file that names no chain taints the provider", () => {
  const a = cl("s1");
  const b = cl("s2");
  const f = file(0, "claude", [], { unparsed_lines: 1 });
  const t = run(facts("claude", { chains: [a, b], files: [f] }));
  assert.deepEqual(t.chains.get(a)?.reasons, ["unparsed_line"]);
  assert.deepEqual(t.chains.get(b)?.reasons, ["unparsed_line"]);
  assert.deepEqual(t.provider_wide_reasons, ["unparsed_line"]);
});

test("R0.9 file_unreadable: an unreadable file taints the provider even when the parser forgot the trigger", () => {
  const a = cl("s1");
  const t = run(facts("claude", { chains: [a], files: [file(0, "claude", [], { readable: false })] }));
  assert.deepEqual(t.chains.get(a)?.reasons, ["file_unreadable"]);
});

// ---------------------------------------------------------------------------
// reasons accumulate in spec order, counts are per reason
// ---------------------------------------------------------------------------

test("R0.9 a chain with several reasons counts once in the total and once under each reason, listed in spec order", () => {
  const a = cl("s1");
  const b = cl("s2");
  const t = run(
    facts("claude", {
      chains: [a, b],
      triggers: [
        { reason: "version_unverified", names: [a] },
        { reason: "copy_exposed", names: [a] },
        { reason: "request_anomaly", names: [a] },
        { reason: "request_anomaly", names: [a] },
      ],
    }),
  );
  assert.deepEqual(t.chains.get(a)?.reasons, ["copy_exposed", "request_anomaly", "version_unverified"]);
  assert.equal(t.chains_tainted, 1);
  assert.equal(t.chains_tainted_by_reason.copy_exposed, 1);
  assert.equal(t.chains_tainted_by_reason.request_anomaly, 1);
  assert.equal(t.chains_tainted_by_reason.version_unverified, 1);
  assert.equal(Object.values(t.chains_tainted_by_reason).reduce((x, y) => x + y, 0), 3);
});

// ---------------------------------------------------------------------------
// families (links i, ii, iii) and closure
// ---------------------------------------------------------------------------

test("R0.9 family closure: groups that share a chain merge, so a reason crosses (i), (ii) and (iii) links transitively", () => {
  const ids = ["a", "b", "c", "d", "e", "f"].map((x) => cx(x));
  const [a, b, c, d, e, f] = ids as [ChainId, ChainId, ChainId, ChainId, ChainId, ChainId];
  const t = run(
    facts("codex", {
      chains: ids,
      // (i) shared session: a-b. (ii) fork edge: b-c. (iii) shared response id: c-d. e and f stay alone.
      family_groups: [[a, b], [b, c], [c, d]],
      triggers: [{ reason: "stream_unresolved", names: [d] }],
    }),
  );
  for (const id of [a, b, c, d]) assert.equal(t.chains.get(id)?.tainted, true, id);
  for (const id of [e, f]) assert.equal(t.chains.get(id)?.tainted, false, id);
  assert.equal(t.chains.get(a)?.family, t.chains.get(d)?.family);
  assert.notEqual(t.chains.get(e)?.family, t.chains.get(f)?.family);
  assert.equal(t.families_total, 3);
  assert.equal(t.families_tainted, 1);
});

test("R0.9 a chain that only a group, a trigger or a file mentions is still a chain", () => {
  const a = cl("s1");
  const b = cl("s2");
  const c = cl("s3");
  const d = cl("s4");
  const t = run(facts("claude", { chains: [], family_groups: [[a, b]], triggers: [{ reason: "request_anomaly", names: [c] }], files: [file(0, "claude", [d])] }));
  assert.equal(t.chains_total, 4);
  assert.equal(t.families_total, 3);
  assert.equal(t.chains.get(c)?.tainted, true);
});

test("R0.9 chains of different providers never share a family, and a provider-wide reason does not cross", () => {
  const t = run(facts("claude", { chains: [cl("s")], triggers: [{ reason: "file_unreadable", names: "provider" }] }));
  assert.equal(t.provider, "claude");
  assert.equal(t.chains.size, 1);
});

test("R0.9 family numbers follow the sorted chain ids and do not depend on input order", () => {
  const ids = ["q", "b", "m", "a", "z"].map((x) => cl(x));
  const groups = [[cl("q"), cl("a")], [cl("m"), cl("z")]];
  const trig: TaintTrigger[] = [{ reason: "request_anomaly", names: [cl("z")] }];
  const t1 = run(facts("claude", { chains: ids, family_groups: groups, triggers: trig }));
  const t2 = run(
    facts("claude", {
      chains: [...ids].reverse(),
      family_groups: [...groups].reverse().map((g) => [...g].reverse()),
      triggers: [...trig].reverse(),
    }),
  );
  const fam = (t: ReturnType<typeof run>) => [...t.chains.values()].sort((x, y) => (x.chain < y.chain ? -1 : 1)).map((c) => [c.chain, c.family, c.tainted]);
  assert.deepEqual(fam(t1), fam(t2));
  // sorted ids: a, b, m, q, z. Families open in that order: {a,q}=0, {b}=1, {m,z}=2.
  assert.deepEqual(fam(t1).map((x) => x[1]), [0, 1, 2, 0, 2]);
});

// ---------------------------------------------------------------------------
// live files and live families (C35)
// ---------------------------------------------------------------------------

test("R0.9 live: a file with an unparsed line exactly C35 before the run start is live", () => {
  const f = file(0, "claude", [cl("s")], { unparsed_lines: 1, mtime_ms: RUN - C35_MS });
  assert.equal(isLiveFile(f, RUN), true);
});

test("R0.9 live: C35 + 1 ms before the run start is not live", () => {
  const f = file(0, "claude", [cl("s")], { unparsed_lines: 1, mtime_ms: RUN - C35_MS - 1 });
  assert.equal(isLiveFile(f, RUN), false);
});

test("R0.9 live: an mtime after the run start counts as live", () => {
  const f = file(0, "claude", [cl("s")], { unparsed_lines: 1, mtime_ms: RUN + 5_000 });
  assert.equal(isLiveFile(f, RUN), true);
});

test("R0.9 live: a recent file without an unparsed line is not live", () => {
  assert.equal(isLiveFile(file(0, "claude", [cl("s")], { mtime_ms: RUN }), RUN), false);
});

test("R0.9 live: a live file that names no chain is not live and taints the provider", () => {
  const a = cl("s1");
  const f = file(0, "claude", [], { unparsed_lines: 2, mtime_ms: RUN });
  assert.equal(isLiveFile(f, RUN), false);
  const t = run(facts("claude", { chains: [a], files: [f] }));
  assert.equal(t.families_live, 0);
  assert.deepEqual(t.chains.get(a)?.reasons, ["unparsed_line"]);
});

test("R0.9 live: the unparseable lines of a live file give no unparsed_line taint, and its family is live and uncounted", () => {
  const a = cl("s1");
  const b = cl("s1", "ag");
  const c = cl("s2");
  const f = file(0, "claude", [b], { unparsed_lines: 4, mtime_ms: RUN - 1000 });
  const t = run(facts("claude", { chains: [a, b, c], family_groups: [[a, b]], files: [f] }));
  assert.equal(t.chains.get(a)?.live, true);
  assert.equal(t.chains.get(b)?.live, true);
  assert.equal(t.chains.get(c)?.live, false);
  assert.equal(t.chains.get(a)?.tainted, false);
  assert.equal(t.chains.get(b)?.tainted, false);
  assert.equal(t.families_live, 1);
  assert.equal(t.families_total, 1);
  assert.equal(t.chains_total, 1);
  assert.equal(t.chains_tainted, 0);
  assert.equal(t.families_tainted, 0);
});

test("R0.9 live: a tainted live family is still live, and is excluded from every tainted count", () => {
  const a = cl("s1");
  const b = cl("s2");
  const t = run(
    facts("claude", {
      chains: [a, b],
      triggers: [{ reason: "request_anomaly", names: [a] }],
      files: [file(0, "claude", [a], { unparsed_lines: 1, mtime_ms: RUN })],
    }),
  );
  assert.equal(t.chains.get(a)?.live, true);
  assert.equal(t.chains.get(a)?.tainted, true);
  assert.equal(t.chains_tainted, 0);
  assert.equal(t.chains_tainted_by_reason.request_anomaly, 0);
  assert.equal(t.families_tainted, 0);
  assert.equal(t.chains_total, 1);
});

test("R0.9 live: a provider-wide reason taints the other family and not the counts of the live one", () => {
  const a = cl("s1");
  const b = cl("s2");
  const t = run(
    facts("claude", {
      chains: [a, b],
      triggers: [{ reason: "file_unreadable", names: "provider" }],
      files: [file(0, "claude", [a], { unparsed_lines: 1, mtime_ms: RUN })],
    }),
  );
  assert.equal(t.chains_total, 1);
  assert.equal(t.chains_tainted, 1);
  assert.equal(t.chains_tainted_by_reason.file_unreadable, 1);
  assert.equal(t.families_live, 1);
});

test("R0.9 live: a non-live file with unparsed lines taints even when another file of the same chain is live", () => {
  // The chain is in a live family, so it is skipped anyway; a second family stays tainted by its own old file.
  const a = cl("s1");
  const b = cl("s2");
  const t = run(
    facts("claude", {
      chains: [a, b],
      files: [file(0, "claude", [a], { unparsed_lines: 1, mtime_ms: RUN }), file(1, "claude", [b], { unparsed_lines: 1, mtime_ms: RUN - 2 * C35_MS })],
    }),
  );
  assert.equal(t.chains.get(a)?.live, true);
  assert.deepEqual(t.chains.get(b)?.reasons, ["unparsed_line"]);
});

test("R0.9 the run start is a parameter: the same facts are live at one run start and not at a later one", () => {
  const a = cl("s1");
  const f = file(0, "claude", [a], { unparsed_lines: 1, mtime_ms: RUN });
  const fa = facts("claude", { chains: [a], files: [f] });
  assert.equal(computeTaint(fa, [f], RUN + C35_MS).chains.get(a)?.live, true);
  assert.equal(computeTaint(fa, [f], RUN + C35_MS + 1).chains.get(a)?.live, false);
  assert.deepEqual(computeTaint(fa, [f], RUN + C35_MS + 1).chains.get(a)?.reasons, ["unparsed_line"]);
});

test("R0.9 an empty scan has no chains and no taint", () => {
  const t = run(facts("codex"));
  assert.equal(t.chains.size, 0);
  assert.equal(t.chains_total + t.families_total + t.families_live + t.chains_tainted + t.families_tainted, 0);
  for (const r of TAINT_REASONS) assert.equal(t.chains_tainted_by_reason[r as TaintReason], 0);
});
