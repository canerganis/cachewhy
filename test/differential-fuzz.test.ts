// Differential fuzz test (spec R13.1, R13.2, docs/accounting-semantics.md): src/ and scripts/recompute are two
// independent implementations of the same spec and must agree EXACTLY on random synthetic transcripts, malformed ones
// included. All data is synthetic (test/fuzz/gen.ts); nothing is read from the home directory.
//
// Knobs for local runs (test-only, never read by src/ or scripts/):
//   CACHEWHY_FUZZ_SEEDS=2000          number of seeds per suite (default 300)
//   CACHEWHY_FUZZ_SEED=123            run exactly this one seed (reproduce a failure)
//   CACHEWHY_FUZZ_PROFILE=all         profile of the single-seed run: bare | valid | all (default all)
//   CACHEWHY_FUZZ_KNOBS=ts_format=0,counter_bad=0.5   override single knobs (probabilities)
//   CACHEWHY_FUZZ_SCALE=2             multiply every probability
// The table-mutation suite (test/fuzz/table.ts) uses seeds 1..min(N,200); reproduce one with runTableSeed(seed).
//
// A failure prints the seed, the window, the tier flag and the first differing field path with both values, so one
// seed reproduces it:  CACHEWHY_FUZZ_SEED=<seed> node --import tsx --test test/differential-fuzz.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDiff, runSeed, runTableSeed, type SeedResult } from "./fuzz/diff.ts";
import { KNOB_NAMES, knobsFor, type KnobName, type Knobs, type Profile } from "./fuzz/gen.ts";

const SEEDS = Math.max(1, Number.parseInt(process.env.CACHEWHY_FUZZ_SEEDS ?? "300", 10) || 300);
const ONE_SEED = process.env.CACHEWHY_FUZZ_SEED !== undefined ? Number.parseInt(process.env.CACHEWHY_FUZZ_SEED, 10) : null;
const SCALE = Number(process.env.CACHEWHY_FUZZ_SCALE ?? "1") || 1;
const MAX_REPORTED = 12;

function overrides(): Partial<Knobs> {
  const o: Partial<Knobs> = {};
  for (const part of (process.env.CACHEWHY_FUZZ_KNOBS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [name, value] = part.split("=");
    if (name !== undefined && value !== undefined && (KNOB_NAMES as string[]).includes(name)) o[name as KnobName] = Number(value);
  }
  return o;
}

function describeFailure(label: string, r: SeedResult): string {
  const first = r.diffs[0]!;
  return `[${label}] seed=${r.seed} window=${JSON.stringify(r.window)} tier=${r.tier} diffs=${r.diffs.length} first: ${formatDiff(first)}`;
}

async function sweep(label: string, profile: Profile, from: number, count: number, extraScale = 1): Promise<string[]> {
  const knobs = knobsFor(profile, overrides(), SCALE * extraScale);
  const failures: string[] = [];
  let failed = 0;
  for (let seed = from; seed < from + count; seed++) {
    const r = await runSeed(seed, knobs);
    if (r.diffs.length > 0) {
      failed += 1;
      if (failures.length < MAX_REPORTED) failures.push(describeFailure(label, r));
    }
  }
  if (failed > failures.length) failures.push(`... ${failed - failures.length} more failing seeds (${failed} of ${count})`);
  return failures;
}

describe("differential fuzz: src/ against scripts/recompute on random synthetic scans (R13.1, R13.2)", () => {
  if (ONE_SEED !== null) {
    it(`single seed ${ONE_SEED}`, async () => {
      const profile = (process.env.CACHEWHY_FUZZ_PROFILE ?? "all") as Profile;
      const r = await runSeed(ONE_SEED, knobsFor(profile, overrides(), SCALE));
      assert.equal(r.diffs.length, 0, `${describeFailure(profile, r)}\nall:\n${r.diffs.slice(0, 40).map(formatDiff).join("\n")}\nfeatures: ${r.scan.used.join(",")}`);
    });
    return;
  }

  it(`generator sanity: ${Math.min(SEEDS, 100)} bare seeds (plain records only, no feature, no malformation) agree exactly`, async () => {
    const failures = await sweep("bare", "bare", 1, Math.min(SEEDS, 100));
    assert.equal(failures.length, 0, `\n${failures.join("\n")}`);
  });

  it(`${SEEDS} valid seeds (every feature, no malformation) agree exactly`, async () => {
    const failures = await sweep("valid", "valid", 1, SEEDS);
    assert.equal(failures.length, 0, `\n${failures.join("\n")}`);
  });

  it(`${SEEDS} malformed seeds (features and injected defects) agree exactly`, async () => {
    const failures = await sweep("all", "all", 1, SEEDS);
    assert.equal(failures.length, 0, `\n${failures.join("\n")}`);
  });

  it(`${Math.min(SEEDS, 150)} dense seeds (all knobs at twice their probability) agree exactly`, async () => {
    const failures = await sweep("all x2", "all", 5001, Math.min(SEEDS, 150), 2);
    assert.equal(failures.length, 0, `\n${failures.join("\n")}`);
  });
  it(`${Math.min(SEEDS, 200)} table-mutation seeds: both implementations refuse the table, or both accept it and agree`, async () => {
    const failures: string[] = [];
    const n = Math.min(SEEDS, 200);
    let failed = 0;
    for (let seed = 1; seed <= n; seed++) {
      const r = await runTableSeed(seed);
      if (r.diffs.length === 0) continue;
      failed += 1;
      if (failures.length < MAX_REPORTED) failures.push(`[table] seed=${seed} tier=${r.tier} mutations=[${r.notes.join(" ; ")}] diffs=${r.diffs.length} first: ${formatDiff(r.diffs[0]!)}`);
    }
    if (failed > failures.length) failures.push(`... ${failed - failures.length} more failing seeds (${failed} of ${n})`);
    assert.equal(failures.length, 0, `\n${failures.join("\n")}`);
  });
});
