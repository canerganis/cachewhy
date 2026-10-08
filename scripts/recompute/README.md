# scripts/recompute

An independent second implementation of the accounting part of `docs/methodology.md`, for reconciliation (R13.1 to R13.3). It reads raw Claude Code and Codex logs plus the pricing table JSON and produces unique responses, token buckets and the list-price equivalent per provider, model, kind and bucket.

It does not import anything from `src/`. It is plain Node ESM with no dependencies, written from the spec text. It does not detect events, boundaries or causes (sections 7 to 11); the main implementation is checked against it on accounting only.

## Use

```
node scripts/recompute/index.mjs --claude-dir <dir> [--claude-dir <dir>] --codex-dir <dir>
     [--since <ISO instant | YYYY-MM-DD>] [--until <ISO instant | YYYY-MM-DD>]
     [--table <table.json>] [--version-policy strict|all]
     [--per-response [--raw-keys]] [--out <file>]
```

* `--claude-dir` takes a Claude config dir (containing `projects/`) or a `projects/` dir. `--codex-dir` takes a Codex home (`sessions/`, `archived_sessions/`) or one of those dirs. Nothing is read from the home directory unless you pass it.
* The window is `[since, until)` on event time in UTC (R5.9). Requests before `since` are loaded and add nothing (R5.10).
* `--table` defaults to `src/pricing/table.json` of the repository (read as data).
* `--version-policy strict` (default) applies R15.7: a product version outside section 0.2 is only counted. `all` treats every version as supported. It is only useful for synthetic data written with a version outside the table; the builder default is now `2.1.293`.
* `--per-response` adds one row per response with its buckets and picodollars. Ids are `h_` plus a 16 hex prefix of a SHA-256 of the key. `--raw-keys` prints raw keys and is for synthetic data only.
* Errors print one short code on stderr (`recompute: no_input_dir`), never an exception message (R14.6). Exit code 2.

There is deliberately no Codex tier flag. R3.4 says no retained field shows the Codex service tier, so a normal run gives every Codex response the reason `modifier_unverified` and no dollars. Tests exercise the row selection through the API parameter `codexTierForTest: "standard"` (spec name `codex_tier_for_test`), which is not a CLI flag or an environment variable.

## API

```js
import { recompute, recomputeFiles, toJson } from "./index.mjs";

const r = recompute({ claudeDirs, codexDirs, since, until, table, versionPolicy, codexTierForTest });
const r2 = recomputeFiles([{ path: "projects/p/s.jsonl", content }, { path: "sessions/2026/01/01/rollout-x.jsonl", content }], opts);
const doc = toJson(r, { perResponse: true, rawKeys: true });
```

`r.responses` holds every keyed response with BigInt buckets (`input_uncached`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `cache_write_unknown_ttl`, `cache_write`, `output` or null, `output_lower_bound`, `reasoning`) and either `{ priced: true, lo, hi }` in picodollars or `{ priced: false, reason }`. `lo` and `hi` differ only for an unknown TTL write (R3.5). The raw keys are for in-process comparison with `src/`. `toJson` hashes them unless asked not to.

## Output

```
schema, spec, table_version, version_policy, window, price_mode
providers.<claude|codex>:
  totals, by_model, by_kind      responses, responses_priced, responses_unpriced,
                                 tokens{input_uncached, cache_read, cache_write_5m, cache_write_1h,
                                        cache_write_unknown_ttl, cache_write, output,
                                        output_lower_bound_unknown_output},
                                 context_tokens, tokens_total, tokens_unpriced,
                                 unpriced_share_exceeds_c24, usd_pico_lo, usd_pico_hi
  unpriced_by_reason
coverage.<claude|codex>          counters, token amounts as decimal strings
```

All token amounts and money are decimal strings. Money is picodollars (1e-12 USD, R3.8). `by_kind` sums to the totals (R5.8). A model that is not in the table, or whose id does not match R14.3, is reported as `unlisted`; a Codex response without a verified model as `model_unknown`.

Definitions used where the spec leaves a choice:

* `tokens_total` of a response is `input_uncached + cache_read + all cache writes + output`, with `output_lower_bound` when output is unknown. `tokens_unpriced` is the `tokens_total` of the unpriced responses. R3.9 uses the cross-multiplication `10 * tokens_unpriced > tokens_total`.
* `usd_pico_lo` and `usd_pico_hi` are the sums over priced responses only. A priced response with an unusable output (`conflict_output`, `conflict_iterations`) carries no output term (R2.3).

## Rules implemented

| Area | Rules |
|---|---|
| Reading | R1.2 (only counters, enums and ids are kept), R1.3 (BOM, CRLF, truncated tail, no error text kept), R14.3 (model labels), R14.6 |
| Claude | R2.1 to R2.3, R2.5, R2.12 to R2.16, R3.12, R4.1 to R4.3, R4.5 to R4.8, R5.2, R5.8 to R5.10, R15.7 |
| Codex | R2.6 to R2.11, R2.13 to R2.17, R4.4, R4.9 to R4.13 (as far as accounting reads them), R5.2, R15.7 |
| Pricing | R3.1 to R3.8, R3.10 to R3.12 (tier gate, long-context scope, modifier verification), R3.9 |

Claude details. Copies are keyed by `requestId` across all files. The output comes from the final copy (a copy with `usage.speed`). Speed, geo and service tier come from the final copy alone; a response without one is `modifier_unverified` and tokens only (R3.12). `requestId` and `message.id` must be 1 to 1 (`key_conflict`). Input and cache counters must be equal over copies (`conflict_input`), models too (`conflict_model`). Counters outside `0..MAX_SAFE_INTEGER` remove the response (`usage_range_failed`), a missing counter makes it `usage_incomplete`. Ownership of a key seen in several logical streams goes to the stream with the earliest `stream_start` (R4.6); it changes the kind attribution only, never the totals.

Codex details. A `token_usage_record` is accounted by its own `thread_id` and `response_id`. Stream identity sets, copy-exposed files, `FS`, `prefix_exposed`, `ordinal_verified`, the overlap guards and the model sources of R2.10 are all recomputed from the raw records. An `integrity_unverified` stream verifies no model through any row. Duplicate `response_id` values are accepted only when every retained field and the attribution are equal (R4.4).

## Spec ambiguities hit

These are choices made here, listed so the other implementation can be compared on them. None of them changes anything on a clean log.

1. (Resolved) The builder default Claude version is now `2.1.293`, inside the section 0.2 table, so the committed Claude fixtures are accounted under `strict`.
2. (Resolved) The builder `replay()` now writes the copying session id, so a replay is a second logical stream under R4.11 and the copies are `replayed` (R4.6, R4.7).
3. R2.12 and R2.15 both name fractional values. Here a value that is not a JSON number is "missing" and a JSON number that fails the range or is fractional is a range failure. Range failure wins over incomplete.
4. Claude `cache_creation_input_tokens` is required even when the `cache_creation` object exists (a missing field is never 0).
5. Geo multiplication can leave a fraction of a picodollar. It is rounded half up once per response and counted in `coverage.claude.geo_rounded_responses`. The spec fixes no rounding at that level.
6. Several final copies with different modifier values are treated as `conflict_modifier`.
7. Codex support under R15.7 is decided per stream from the `cli_version` of its own `session_meta` records. A usage record whose thread has none, or no `thread_id`, is not accounted.
8. Codex kind: `thread_source` values other than the listed ones are reported as `unclassified`. `source.subagent.other` alone does not make a subagent, following the table of R5.2 literally.
9. A `turn_context` without a model is not a candidate. Settings markers of a copy-exposed file still count as markers (the conservative direction).
10. The unreliable-order case for R2.10: with markers present and the stream `ordinal_verified` but `integrity_unverified`, the row is `stream_unverified` (revision 9 settles this).
11. Reason labels of `unpriced_modifier` are chosen here when several apply. The order is table row, tier gate, then modifiers. Dollars do not depend on the order; reason counts do.
