# Controlled experiments

Harness for the ground truth runs in spec section 12 (`docs/methodology.md`). It spawns `claude -p` or `codex exec` in a temp directory, applies one intervention, and records usage numbers and timestamps. It does not import anything from `src/` (R12.4), so the measurement is independent of cachewhy.

This directory is scaffolding. Nothing here has been run against a real product yet.

## Files

* `scenarios.ts`: scenarios P1 to P9 and N1 to N7 as data, the spec constants the harness needs, and the BigInt effect checks.
* `run.ts`: the runner. Dry run by default.

## Safe by default

```
node scripts/experiments/run.ts                      # prints the plan and the estimated model calls
node scripts/experiments/run.ts --scenarios P1,N1 --runs 5 --json
```

A dry run spawns nothing and costs nothing. To spawn anything you need both `--execute` and `--budget-calls N`. The runner refuses if the plan is larger than the budget, and it stops starting new steps once the observed call count reaches the budget.

## Execute

```
node scripts/experiments/run.ts --execute --budget-calls 200 \
  --scenarios P1,N1 --runs 5 \
  --claude-model <id> --min-cacheable <tokens>
```

Required flags depend on the scenarios: `--claude-model` and `--codex-model` for the providers used, `--claude-alt-model` or `--codex-alt-model` for P3 and P8, `--effort-base` and `--effort-alt` for P5, N4 and P7, `--mcp-config` for P4. Model ids are never hardcoded. Pass `--claude-bin` and `--codex-bin` with a real executable path if the commands are not directly spawnable (npm `.cmd` shims do not work without a shell).

Scenarios marked `needs_probe` are skipped unless `--allow-unprobed` is given. They depend on a flag, env var or headless behavior that must be confirmed for the pinned product version first (P4, N3, P5, N4, P6, N5, P7).

## Run protocol (R12.3)

1. Step 1, cold write. A fresh nonce and synthetic filler of `C30` (3) times the model minimum cacheable length. Checked: `K_1` must reach the filler target, otherwise the run is discarded as `filler_below_target`.
2. Step 2, warm hit. Precondition `10 * R_2 >= 9 * K_1`, computed in BigInt. A failing run is discarded before any wait or intervention, with its reason in `discarded`.
3. Step 3, one intervention, applied between step 2 and step 3. A pure wait is an intervention too. The expected label, criterion and planned wait are written to the manifest before step 1 runs.
4. Optional step 4 (`--recovery`).

The verdict is `effect_verified` or `no_effect`, computed from the harness counters only (`miss`: `2 * R_3 <= K_2`; `hit`: `10 * R_3 >= 9 * K_2`) and written to the manifest. The runner never runs cachewhy, so the verdict cannot depend on it.

## Dev and held-out split

* `--split dev` (default): 20 runs per scenario (`C15`). May be inspected and used for tuning.
* `--split heldout`: 40 runs per scenario as the starting target (`C12`). Refused unless the git tag `spec-freeze` exists and `docs/methodology.md` and `scripts/experiments` have no uncommitted changes. After the runs, hash the manifest set and commit the hash to `docs/audit-log.md` before any evaluation transcript is processed (R12.7). Never tune on this set. Keep generating runs until each claimed class has 40 scored predictions or the budget is spent; the per scenario count shown is only the pre-discard target.

## Output

Default root is `local/experiments`, which is gitignored. The runner refuses an output directory that git does not ignore.

```
<out>/<split>/<timestamp>/plan.json
<out>/<split>/<timestamp>/runs.jsonl          one summary line per run
<out>/<split>/<timestamp>/<split>-<id>-<n>/manifest.json
```

A manifest holds only: product version, model ids, settings, nonce, expected label and criterion, timestamps (harness send time and end time per step, intervention time), per request counters (input, cache read, cache write, output, subagent flag), the precondition, the verdict, and the discard reason. It holds no prompt text, no model output, no stderr, no session ids and no local paths. The nonce is synthetic and is the only key that links a manifest to a transcript on disk (it appears in the first prompt, so `grep` for it in the product logs to find the transcript). Temp working directories are deleted at the end of each run.

## Counters

* Claude: one request per distinct assistant message id in `--output-format stream-json`. `R` is `cache_read_input_tokens`, `W` is `cache_creation_input_tokens`, `K = R + W`. Messages with a parent tool use id are the subagent chain.
* Codex: `turn.completed` usage. `R` is `cached_input_tokens`. Codex reports no cache write, so `W` is derived as `input_tokens - cached_input_tokens` and `K` equals `input_tokens`.

## Assumptions to confirm before a real run

* CLI shapes: `claude -p --output-format stream-json --verbose --model M [--effort L] --session-id U` then `--resume U`, prompt on stdin; `codex exec [resume ID] --json --skip-git-repo-check -m M -` with `thread.started` and `turn.completed` events.
* `CLAUDE_CODE_PROMPT_CACHE_TTL` accepts `5m` and `1h`. The explicit subagent TTL variable (R12.2) is not set by this scaffold; add it before running N5.
* The N5 subagent criterion uses the subagent request's own `R` and `K`, since that chain has no step 2.
* `--min-cacheable` defaults to a conservative placeholder. Take the real per model value from `pricing/table.json` (not in the repository yet, it is added at D1; until then use the minimum cacheable lengths listed in `docs/methodology.md`).
* Run model calls are estimated per step from `expectedModelCalls` in `scenarios.ts`; observed calls replace the estimate during a run.
* Claude project history for temp working dirs lands in the product's normal log location. Those transcripts are what cachewhy is run on later; delete them yourself after the evaluation is done if you do not want to keep them.
