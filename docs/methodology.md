# cachewhy methodology (binding spec)

Status: draft for gate G0. Spec version `spec-1`, revision 3 (after G0 spec audit round 2, see `docs/audit-log.md`). Date: 2026-10-08.

This document is the binding technical specification. An implementer follows it. An auditor checks the implementation against it. Every rule is written so it can be tested. Where the recon could not settle a fact, the rule is conservative abstention and the fact is listed in section 18.

Conventions:

* MUST, MUST NOT and MAY are used in the RFC 2119 sense.
* Rule ids look like `R7.3`. Tests, audit findings and code comments cite rule ids.
* Constants are named `C1` to `C34` in section 0.3. A constant changes only through the procedure in section 0.4.
* "Request" means one billed model response. "Chain" is defined in section 5.
* "Token" always means an integer count taken from the log. Fractions of tokens never exist.
* Arithmetic (R2.16). All token arithmetic, every comparison of a token quantity with a constant, and all money use BigInt. A constant that is a ratio or a percentage is an exact rational `num/den`, and a ratio test is a cross-multiplication of BigInt values. Floating point is used only for display, for the Wilson intervals of section 12 (they take run counts, not tokens) and for numbers that no decision reads.

## 0. Scope

### 0.1 What cachewhy claims

cachewhy reads local Claude Code and Codex session logs and produces:

1. Token and list-price-equivalent accounting per response.
2. A per-chain timeline of cache reads and writes.
3. Events where a previously cached prefix was probably processed again ("suspected rebuilds").
4. For every event, candidate causes, each with an evidence level.
5. A token bound and, only when assumptions hold, a dollar delta for each suspected rebuild.

cachewhy does not claim an avoidable bill, a saving, or a complete explanation of every miss. Dollars are API list-price equivalents, never what a subscription user was charged.

### 0.2 Supported inputs

| Provider | Product versions with a fixture and a verified recon | Support level |
|---|---|---|
| Claude | Claude Code 2.1.286, 2.1.288, 2.1.289, 2.1.291, 2.1.293 | full |
| Codex | Codex CLI 0.157.1, 0.158.0, 0.159.2, 0.160.0, 0.160.1 (plain `.jsonl`) | full |
| Codex | Codex CLI 0.154.0-alpha.6.2 and any other version found only in archived `.zst` files | coverage only, see R15.7 |
| Any | A version not in the table above | coverage only, see R15.7 |

Runtime: Node 22 and 24, MIT license, zero runtime dependencies. Reading archived Codex `.zst` files needs the zstd decoder in `node:zlib`. If the running Node lacks it, archived files are counted in `coverage.files_unreadable` and never skipped silently (R17.1).

### 0.3 Constants (pre-registered)

All numeric decision thresholds live here. A number that changes a classification, an eligibility outcome, a price, an exclusion or an evaluation verdict and is not in this table is a defect in the spec. Scenario parameters (wait times, filler size) live in R12.5 and R12.2 and are frozen like constants. Per-model facts (prices, modifier multipliers, minimum cacheable lengths) live in `pricing/table.json` and are audited under G0-pricing (R15.1). Values marked "dev-tuned" were chosen from recon heuristics and MAY be adjusted using the development set only (section 12) before the freeze in 0.4.

| Id | Name | Value | Used in | Origin |
|---|---|---|---|---|
| C1 | `TAU_SUSPECT` | 1/2 (0.5) | R7.5 | dev-tuned, recon heuristic |
| C2 | `TAU_NORMAL` | 9/10 (0.9) | R7.5 | dev-tuned |
| C3 | `FLOOR_PREV` | 16384 tokens | R7.2 | dev-tuned, recon used 20k |
| C4 | retired | none | none | `U_ASM` (15 s) was a p90 of an observed lag, not a start bound. Removed in revision 2 (R6.4). Id kept so citations stay stable. |
| C5 | retired | none | none | `FALLBACK_START_LAG` (120 s) was a fixed guess. Removed in revision 2 (R6.4). |
| C6 | `TTL_5M` | 300 s | R9.2 | official docs |
| C7 | `TTL_1H` | 3600 s | R9.2 | official docs |
| C8 | `TTL_OPENAI_30M` | 1800 s | R9.6 | official docs |
| C9 | `TTL_OPENAI_24H` | 86400 s | R9.6 | official docs |
| C10 | `DRIFT_UNMAPPABLE` | 1 percent of usage-bearing records | R17.3 | fixed |
| C11 | `DRIFT_INVARIANT` | 0.5 percent of responses | R17.3 | fixed |
| C12 | `N_EVAL_MIN` | 40 predictions (`n = TP + FP`) per claimed class, and 40 effect-verified runs per negative control | R12.7 | fixed, from Wilson table in R12.6 |
| C13 | `PREC_LB` | 0.85 Wilson lower bound | R12.7 | fixed |
| C14 | `FP_UB` | 0.10 Wilson upper bound on negative controls | R12.7 | fixed |
| C15 | `N_DEV_MIN` | 20 runs per class | R12.7 | fixed |
| C16 | `COVERAGE_LB` | 0.50 Wilson lower bound | R12.8 | fixed |
| C17 | `RECON_TOKEN_TOL` | 1 percent | R13.4 | plan |
| C18 | `RECON_COST_TOL` | 2 percent | R13.4 | plan |
| C19 | `CODEX_INTERNAL_TOL` | 0.5 percent | R13.6 | plan |
| C20 | `USAGE_CACHE_PCT_TOL` | 1 percentage point | R13.7 | fixed |
| C21 | `EFFECT_MISS_MAX` | 1/2 (0.5) | R12.3 | fixed, harness-side effect criterion for positive runs |
| C22 | `HIT_MIN` | 9/10 (0.9) | R12.3 | fixed, harness-side warm-hit and no-miss criterion |
| C23 | `NO_EFFECT_MAX` | 0.2, maximum share of runs of a scenario without the expected effect | R12.3 | fixed |
| C24 | `UNPRICED_PARTIAL` | 10 percent of tokens | R3.9 | fixed |
| C25 | `CODEX_LONG_CTX` | 272000 input tokens | R3.4 | official docs |
| C26 | `HAIKU_TIER_SPLIT` | 100000 total input tokens | R3.4 | official docs |
| C27 | `COMPACT_WALK_HOPS` | 200 | R11.7 | fixed |
| C28 | `NO_FINAL_MARKER_MIN` | 100 requests | R17.3 | fixed |
| C29 | `FAST_PREFILTER_DAYS` | 7 days | R5.9 | fixed |
| C30 | `FILLER_MULT` | 3 times the model minimum cacheable length | R12.2 | fixed |
| C31 | `HANDCHECK_TOP` | 20 events | R12.9 | fixed |
| C32 | `GEO_US_MULT` | 11/10 | R3.4, R3.8 | official docs |
| C33 | `RECON_UNEXPLAINED_TOL` | 0.5 percent of tokens | R13.4 | fixed |
| C34 | `START_BOUND_VIOLATIONS_MAX` | 0 runs | R6.8 | fixed |

Every constant that is a percentage or a ratio is the exact rational given here, and decisions use the rational, never a decimal rendering: `C1 = 1/2`, `C2 = 9/10`, `C10 = 1/100`, `C11 = 1/200`, `C17 = 1/100`, `C18 = 1/50`, `C19 = 1/200`, `C20 = 1/100` (percentage point), `C21 = 1/2`, `C22 = 9/10`, `C23 = 1/5`, `C24 = 1/10`, `C33 = 1/200`. `C13`, `C14` and `C16` are bounds on Wilson intervals of run counts and are the only constants compared as floating point numbers.

### 0.4 Freeze procedure

1. Constants, scenario parameters and rules in this file are frozen by the git tag `spec-freeze` placed before any held-out evaluation run is generated (R12.7).
2. A result-affecting rule is any rule, table, enum or constant that can change accounting (tokens, dollars, coverage counts used in a claim), eligibility, abstention, boundary or cause classification, evaluation scoring, headline status or a claim made in a report or in the README. Explicitly this is: section 0.1 (claims), section 0.2 (the supported version matrix and the support levels), section 0.3, sections 1 to 11, all of section 12 and section 13, the schema of R14.5, R15.3 and R15.7 (version matrix behavior and narrowed claims), sections 16 and 17 (headline and drift rules), and every entry of `pricing/table.json`. Only the items listed as exempt in item 3 are not result-affecting. After the tag, a change to a result-affecting rule, including adding a version to the full-support table, demoting one, or changing how an unsupported version is handled, requires an entry in `docs/audit-log.md`, a new tag `spec-freeze-N`, and a new held-out evaluation set (for an added version, held-out runs on that exact version). Evaluation data that influenced a change is burned and MUST NOT be reused as evaluation data.
3. A change is exempt from item 2 only if it is wording or layout and a test shows that the semantic output (R4.10) on the frozen synthetic fixtures and on the corpus snapshot is identical before and after. The test result is recorded in the audit log entry for the change. Process rules that do not feed any output (the order of publication steps in R15.2, the CI provenance text in R15.4 and the license in R15.6) are also exempt, but still need an audit log entry.
4. Dev-tuning of `C1` to `C3` before the tag uses the development set only. Tuning after the tag is a change under item 2.

## 1. Inputs and the structural-read allowlist

R1.1. cachewhy reads every line as JSON. It MUST NOT retain, hash, index, log or export any message text, prompt text, tool input or output text, file path, project name, directory name, branch name, title, description, slug or other free text. Such fields are parsed and dropped.

R1.2. The only fields cachewhy reads and retains are listed below. A field not listed is dropped at parse time by the typed record readers.

Claude Code, fields read on every record type that takes part in the graph (`assistant`, `user`, `system`, `attachment`):

| Field | Type kept | Notes |
|---|---|---|
| `type` | enum | only `assistant`, `system`, `user`, `attachment`, other values map to `other` |
| `requestId`, `message.id` | string, used only as dedup key and hashed on output | assistant records, see R14.4 |
| `uuid`, `parentUuid`, `logicalParentUuid` | string, used only for graph edges | all record types; never exported raw. Needed for R6.4 and R11.7 |
| `sessionId`, `agentId` | string, graph keys | never exported raw |
| `timestamp` | ISO instant | all record types |
| `message.role` | enum `user`, `assistant`, else `other` | `user` records |
| `message.content[].type` | enum `text`, `tool_use`, `tool_result`, `thinking`, else `other` | the content is never read, only its type |
| `message.content[].tool_use_id` | string, graph key | `tool_result` blocks only, used only to pair a result with its `tool_use` |
| `version` | string matching `^[0-9]+\.[0-9]+\.[0-9]+$` | else `unlisted` |
| `isSidechain`, `isApiErrorMessage`, `isCompactSummary` | boolean | |
| `entrypoint` | enum `claude-desktop`, `cli`, `sdk-cli`, else `other` | |
| `effort`, `perTurnEffort` | enum `low`, `medium`, `high`, `xhigh`, `max`, else `other` | |
| `advisorModel` | model id (R14.3) | attribute only |
| `serverClassifierRequest` | presence boolean only | value dropped |
| `message.model` | model id (R14.3) | |
| `message.stop_reason` | enum `tool_use`, `end_turn`, `stop_sequence`, `refusal`, `null`, else `other` | |
| `message.usage.*` counters | integers, range checked by R2.15 | `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`, `cache_creation.ephemeral_1h_input_tokens`, `iterations[0].*` (integer members only), `output_tokens_details.thinking_tokens` |
| `message.usage.speed` | enum `standard`, `fast`, else `other` | pricing modifier, R3.4. Not an integer. |
| `message.usage.inference_geo` | enum `not_available`, `us`, else `other` | pricing modifier, R3.4. Not an integer. |
| `message.usage.service_tier` | enum `standard`, `priority`, `batch`, else `other` | pricing modifier, R3.4. Not an integer. |
| `message.diagnostics.cache_miss_reason` | `type` enum and `cache_missed_input_tokens` integer | see section 10 |
| `message.content[].type`, `.id`, `.name` | enum, string, enum | only for subagent linkage (R5.3); `name` kept only if it equals `Agent` or `Workflow`, else `other` |

Claude Code, other files:

| File | Fields kept |
|---|---|
| `agent-*.meta.json` | `toolUseId`, `parentAgentId`, `spawnDepth`, `agentType` (enum), `model` alias (enum, informational), `requestShape` (enum). `description`, `worktreePath` and every other key are dropped. |
| `workflows/wf_*.json` | `runId`, `status` (enum). Everything else dropped. |
| `subagents/workflows/wf_*/journal.jsonl` | `type`, `agentId`. `key`, `label`, `result` dropped. |
| `agent-*.prefix.json` | `state.model`, `state.is1hCacheTTL`, `state.buildVersion`, `state.toolsHash` presence only. See R10.6. |
| `system` records | `subtype` enum; for `compact_boundary`: `compactMetadata.trigger` (enum), `preTokens`, `postTokens`, `uuid`, `logicalParentUuid`. |
| `cost-state` records | `modelUsage.<model>` integer fields, used only for the coverage estimate in R17.5, never added to totals. |

Codex:

| Record | Fields kept |
|---|---|
| envelope | `timestamp`, `type`, `ordinal` |
| `session_meta` | `id`, `session_id`, `timestamp`, `cli_version`, `forked_from_id`, `parent_thread_id`, `source.subagent.thread_spawn.parent_thread_id` (graph key), `source.subagent.thread_spawn.depth` (integer, informational), `source.subagent.other` (presence boolean), `subagent_history_start_ordinal`, `originator` (enum), `source` kind (enum), `thread_source` (enum), `agent_role` (enum). Free text (`cwd`, `agent_nickname`, `agent_path`, `base_instructions`, `git`) dropped. |
| `turn_context` | `turn_id`, `root_turn_id`, `model`, `effort`, `comp_hash`, `collaboration_mode.mode`. Everything else dropped. |
| `token_usage_record` | `response_id`, `thread_id`, `session_id`, `turn_id`, `usage.*` (six integers). `turn_token_usage` and `thread_token_usage` are read only for R13.6. |
| `event_msg` | `payload.type` as an enum (`token_count`, `task_started`, `thread_settings_applied`, else `other`) and the envelope `ordinal` and `timestamp`. `token_count` payloads are read only to count events that lack a matching `token_usage_record` (R2.9). `thread_settings_applied` is read as a presence marker for R2.10. No other payload field is kept. |
| `compacted` | `compaction_response_id`, `window_id`, `window_number`, and whether `latest_token_usage_record` is null. `message`, `replacement_history`, `retained_context` dropped. |
| `response_item` | `payload.type` as an enum (`message`, `function_call`, `function_call_output`, `custom_tool_call_output`, `reasoning`, else `other`); for `payload.type = message` also `payload.role` as an enum (`user`, `assistant`, `developer`, `system`, else `other`); and the envelope `timestamp` and `ordinal`. Used for R6.5. The content is never read. |

R1.3. Parse failures. A line that fails `JSON.parse` increments `coverage.lines_parse_error` and is dropped. The exception message MUST NOT be stored or printed, because V8 syntax errors can quote input text (R14.6). A final line without a terminating newline that fails to parse is counted separately in `coverage.lines_truncated_tail` and is not an error. BOM and CRLF are tolerated.

R1.4. Unknown record types are counted by a bounded enum (`known_type_count`, `unlisted_type_count`). The raw type string is never stored.

## 2. Provider normalization

### 2.1 Claude

Let `i = input_tokens`, `r = cache_read_input_tokens`, `w5 = cache_creation.ephemeral_5m_input_tokens`, `w1 = cache_creation.ephemeral_1h_input_tokens`, `wt = cache_creation_input_tokens`, `o = output_tokens`.

R2.1. Write tokens. If the `cache_creation` object exists, `w = w5 + w1`. If it is absent, `w = wt` and the write is bucketed `w_unknown_ttl`. If the object exists and `wt != w5 + w1`, the response is flagged `bucket_mismatch` (recon saw one such main request: `wt` was 0 and `w1` was 1796). The bucket sum is used for `w` and pricing, the response is excluded from rebuild detection (R7.2 E3) and counted in `coverage.responses_bucket_mismatch`.

R2.2. Total input: `total_input = i + r + w`, computed as BigInt (R2.16). Cache read share: `r / total_input`, computed as a BigInt quotient and rounded half up to one decimal of a percent for display only.

R2.3. Output. `o` is taken only from a final copy (R4.2). A request with no final copy has `output = unknown` and `output_lower_bound = max(o over copies)`. Recon: about 68 percent of subagent and workflow requests have no final copy. Dollar totals exclude output for such requests, and the headline says how many (R16.1). Rebuild deltas (section 8) do not depend on output.

R2.4. `output_tokens_details.thinking_tokens` is informational and is never added to `o`. Whether it is a subset of `o` is an open question (section 18, Q3).

R2.5. `service_tier`, `inference_geo`, `speed` are enum-valued pricing modifiers (R1.2), never counters. Their selection across copies is in R4.2 and their pricing effect is in R3.4.

### 2.2 Codex

Let `in = usage.input_tokens`, `c = usage.cached_input_tokens`, `cw = usage.cache_write_input_tokens`, `out = usage.output_tokens`, `rs = usage.reasoning_output_tokens`.

R2.6. Input semantics. `in` includes `c` (recon: `c <= in` in all 14,897 records). It is assumed to include `cw` (recon: `cw` is 0 in every record, so this cannot be shown from data; the assumption follows the official cost formula and is flagged in section 18, Q2). Normal input: `normal = in - c - cw`.

R2.7. Validity invariants, checked per response, after the range check of R2.15 has passed for every counter: `c + cw <= in`, `rs <= out`, `total_tokens == in + out`. A response failing any invariant is flagged `usage_invariant_failed`, is excluded from dollars and from rebuild detection, and counts toward `C11`. Its tokens are reported only in `coverage.tokens_in_invalid_responses`, never in totals.

R2.8. Output semantics. `out` includes `rs` (recon: `rs <= out` always and `total == in + out` when `rs > 0`). Cost uses `out` only. `rs` MUST NOT be added again. If a future fixture shows `total_tokens == in + out + rs`, invariant R2.7 fires and the headline closes under R17.3 until the spec is revised.

R2.9. Accounting source. The only accounting source is `token_usage_record.usage`, keyed by `response_id`. `event_msg/token_count` is never summed (recon: re-emissions and cumulative totals make it unsafe). A file that contains `token_count` events but zero `token_usage_record` records (recon: 39 files from one originator) is counted in `coverage.files_without_response_id` with the number of its `token_count` events, and contributes no tokens or dollars. Cumulative fields `turn_token_usage` and `thread_token_usage` are never summed.

R2.10. Model attribution. `token_usage_record` has no model field. Candidate model: the `turn_context.model` with the greatest `(timestamp, ordinal)` before the record in the same logical stream (R4.11). `model_source`:

| Value | Condition | Model verified? |
|---|---|---|
| `own_turn` | that `turn_context.turn_id` equals the record's `turn_id` (an id equality, which needs no ordinal) and the `turn_context` is a record of this stream (R4.11) | yes |
| `carried_verified` | the stream is `ordinal_verified` (R4.12) and not `integrity_unverified` (R4.11), the `turn_context` is an earlier turn of this thread, lies at or after `subagent_history_start_ordinal` (or the thread is not a fork, R4.9), and no `event_msg` of payload type `thread_settings_applied` lies between that `turn_context` and the record | yes |
| `carried_unverified` | same as `carried_verified` but a `thread_settings_applied` marker lies in between, or the stream is not `ordinal_verified` (R4.12, Q21), or it is `integrity_unverified` (R4.11), or it is a fork whose prefix is unresolved (R4.9) | no |
| `inherited_prefix` | the stream is `ordinal_verified` and the `turn_context` lies before `subagent_history_start_ordinal` (a copied prefix of another thread) | no |
| `none` | no `turn_context` precedes | no |

A response whose model is not verified has `model = model_unknown`: its tokens are reported, no dollars are produced (`unpriced_model`), and every pair that contains it abstains `model_unknown` (R7.2 E2). Dollars and events are produced only for verified models. The share of responses with an unverified model is printed in coverage (`responses_model_unverified`).

R2.11. Cache write TTL class for Codex is not reported. Write tokens are bucketed `w_openai`.

### 2.3 Missing and unknown data

R2.12. A missing or non-integer usage field is never treated as 0. The response is `usage_incomplete`. Its present integer fields that pass R2.15 are still reported as tokens in `coverage.tokens_in_incomplete_responses`, but it yields no dollars and no event. Exception: the `cache_creation` sub-object being absent follows R2.1.

R2.15. Counter range. Every usage counter used by this spec (all fields of the R1.2 counter row, and for Codex the six `usage` integers) MUST be an integer with `0 <= value <= Number.MAX_SAFE_INTEGER`, checked on the parsed value before any arithmetic. A negative, fractional, non-finite or unsafe value makes the response `usage_range_failed`. A response with `usage_range_failed` is removed from accounting and events entirely: it adds nothing to totals, dollars, events, boundaries or the TTL lineage, and is excluded as in R6.2. It counts toward `C11` and in `coverage.responses_usage_range_failed`. Its raw values are not stored. Any other token integer retained by R1.2 (`preTokens`, `postTokens`, `cache_missed_input_tokens`, `modelUsage` members) is range checked the same way; a failing value is treated as absent for its own purpose, does not fail a response, and is counted in `coverage.fields_range_failed`.

R2.16. Arithmetic on counters. Immediately after the range check of R2.15 passes, every counter is converted to BigInt, and from then on no `Number` arithmetic touches a token quantity. This covers single counters and every intermediate quantity: `i + r + w`, `r + w`, `in - c - cw`, `c + cw`, `K`, `ctx`, `D`, `L`, `W + U` and all sums across responses. Threshold comparisons use exact rational constants (section 0.3): for example `S >= C2` is `10 * R >= 9 * K_prev`, `S < C1` is `2 * R < K_prev`, and `tokens_unpriced > C24 * total_tokens` is `10 * tokens_unpriced > total_tokens`. Required tests: fixtures in which every counter, and then each of `i + r + w`, `r + w`, `in - c - cw` and `K_prev`, equals or exceeds `Number.MAX_SAFE_INTEGER` (the counters themselves at `MAX_SAFE_INTEGER` and at `MAX_SAFE_INTEGER + 1`, the latter failing R2.15), pairs placed exactly on, one token below and one token above each rational boundary of R7.5, and an exact equality check against `scripts/recompute` (R13.1).

R2.13. A missing `response_id` (Codex) or `requestId` (Claude, excluding `<synthetic>` error records) makes the record `unkeyed`. Unkeyed usage is counted in `coverage.records_unkeyed`, never in totals.

R2.14. `<synthetic>` records and any record with `isApiErrorMessage = true` are not requests. They are counted in `coverage.api_error_records`.

## 3. Pricing

R3.1. One mode only: repricing at the price table snapshot, named "list-price equivalent at table `<version>`". `pricing/table.json` stores `model`, `provider`, per-MTok prices as decimal strings, `modifiers`, `source_url`, `verified_at`. The table version is printed in every report.

R3.2. Prices are stored as absolute dollars per million tokens. Multipliers are not used at runtime. A test asserts the documented ratios hold in the table (read at 0.1x input by default, 0.05x for Opus 5.5 and Sonnet 5.5, 0.025x for Fable 5.1, 5m write 1.25x, 1h write 2x, OpenAI write 1.25x for GPT-5.6 and later, GPT-6.1 Sol read 0.05x).

R3.3. Model id normalization. A trailing `-YYYYMMDD` is stripped. Matching is exact string equality afterwards. Aliases (`opus`, `sonnet`, `fable`, `haiku` in `meta.json`) are never used for pricing. A model with no table row is `unknown_model`: its tokens are reported, its dollars are not produced, and `coverage.tokens_unpriced` includes it.

R3.4. Modifiers. A response is priced only if every modifier is resolved. The general rule: a modifier value that is unrecognized, that conflicts between copies (R4.2), or whose pricing effect is not defined in this table gives `unpriced_modifier`, and no dollars are produced for that response. A modifier is never guessed, and never defaulted except where a row below says so.

| Modifier | Rule |
|---|---|
| Claude `usage.speed` | Enum from R1.2, read from the final copy (R4.2). `standard` or absent: standard price. Absent is counted in `coverage.responses_speed_assumed` (recon: only final copies carry it). `fast`: use the table fast row if the model has one, else `unpriced_modifier`. `other`: `unpriced_modifier`. |
| Claude `usage.inference_geo` | Enum from R1.2. `not_available` or absent: no multiplier. `us`: multiply every price by `C32` (11/10) where the table says it applies to the model. `other`: `unpriced_modifier`. |
| Claude `usage.service_tier` | Enum from R1.2. `standard` or absent: no effect on price. `priority`, `batch` or `other`: `unpriced_modifier` unless the table row of the model has an explicit `service_tier` entry for that value with `verified_at`, in which case that entry is applied as a price row. The enum values are a closed set in the schema, not integers. |
| Claude batch | `service_tier = batch` is the only batch signal. Otherwise not observable, assumed not batch, printed as assumption `no_batch_assumed`. |
| Claude Haiku 5.5 tiers | The tier is chosen by `total_input` of the response: at most `C26` uses the low tier, above uses the high tier. |
| Codex long context | If the table row has a long-context entry with `verified_at` and `in > C25`, use it. If `in > C25` and the row has no such entry, `unpriced_modifier`. |
| Codex fast or priority tier | Not observable in recon. Standard tier assumed, printed as assumption `codex_standard_tier_assumed` (section 18, Q9). |
| Regional endpoint surcharge | Not observable. Printed as assumption `no_regional_surcharge_assumed`. |

R3.5. Claude cost of one response:

```
cost = i*p_in + r*p_read + w5*p_w5 + w1*p_w1 + wu*p_w5_or_w1_range + o*p_out
```

where `wu` is `w_unknown_ttl` priced as a range from `p_w5` to `p_w1` (the response then carries `cost_lo` and `cost_hi`), and the `o*p_out` term is omitted and flagged when output is unknown (R2.3).

R3.6. Codex cost of one response (the audit formula):

```
normal = in - c - cw
cost   = normal*p_in + c*p_cached + cw*p_write + out*p_out
```

If `cw > 0` and the model's `p_write` is `n/a`, the response is `unpriced_modifier`. If `cw == 0`, `p_write` is not needed. Reasoning is not priced separately (R2.8).

R3.7. Models seen in recon and their status (a Codex model is priced only when its attribution is verified, R2.10): Claude `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1`, `claude-haiku-4-5` and `claude-haiku-5-5` are priced from the table. Codex `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6-astra`, `gpt-5.6-luna`, `gpt-5.5` are priced. `codex-auto-review` and `gpt-5.3-codex-spark` have no table row and are `unknown_model`. The table in `pricing/table.json` is authoritative, this list is a test expectation for the table at G0-pricing.

R3.8. Arithmetic. Prices are parsed from decimal strings into integers in units of 1e-6 USD per MTok. Cost is `tokens * price_units` as BigInt in units of 1e-12 USD, multiplied by the numerator of `C32` and divided by its denominator once when `inference_geo` is `us`, then rounded half up to 1e-9 USD only at display. Sums are sums of BigInt. No `Number` is used for money. Two runs over the same input produce byte-identical money.

R3.9. Unpriced share. Every report prints `tokens_unpriced / total_tokens` per provider. If it exceeds `C24` for a provider, the headline dollar figure for that provider is prefixed `partial` (R16.1).

## 4. Deduplication and ownership

### 4.1 Keys

R4.1. Keys. Claude: `requestId`, with `message.id` as a consistency check (the mapping is 1 to 1 in recon, 40,794 unique of each, zero conflicts). If a `requestId` maps to two `message.id` values or the reverse, the request is `key_conflict` and excluded from totals. Codex: `response_id`. Keys are global across all files. Per-file dedup is forbidden.

### 4.2 Copy selection priority (per provider, per version)

R4.2. Claude, versions 2.1.286 to 2.1.293 (identical pattern in all five; a version with a different pattern needs its own row and a fixture before it is listed in section 0.2). One content block is one record, so a request has several copies.

| Quantity | Chosen from | Rule when copies disagree |
|---|---|---|
| `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `ephemeral_5m`, `ephemeral_1h` | any copy | all copies MUST be equal. If not: `conflict_input`, request excluded from totals and events, listed in `coverage.requests_conflict`. |
| `output_tokens` | the final copy, defined as a copy with `usage.speed` present | If there are several final copies they MUST be equal, else `conflict_output` (output unknown, tokens otherwise kept). If no final copy exists: `output_unknown` with lower bound `max(o)`. |
| `stop_reason`, `speed`, `thinking_tokens`, `iterations[0]` | the final copy | `iterations[0]` MUST equal the top-level usage fields on the shared keys, else `conflict_iterations` (the response is kept, output unknown). |
| `speed`, `inference_geo`, `service_tier` (modifiers) | `speed`: the final copy. `inference_geo`, `service_tier`: the value present on any copy | Every copy that carries a modifier MUST carry the same value as the final copy (for `speed`) or the same value as every other carrying copy (for the others). A copy without the field is no conflict. A disagreement gives `conflict_modifier`: the response keeps its tokens but is `unpriced_modifier` (R3.4), and no dollars and no dollar delta are produced for it. It still takes part in event detection. |
| `model` | any copy | MUST be equal, else `conflict_model`, excluded. |
| `diagnostics` | union of non-null `cache_miss_reason` over copies | two different non-null `type` values: `conflict_diagnostics`, treated as no diagnostics evidence (R10.4). |
| `t_first`, `t_last` | min and max `timestamp` over copies | none |

R4.3. Selection MUST NOT depend on file order, line order, file name or modification time. Where a deterministic tie-break is needed, order copies by `(has_speed desc, output_tokens desc, timestamp asc, uuid asc)`.

R4.4. Codex, CLI 0.157.1 to 0.160.1. One `token_usage_record` per response. If a `response_id` occurs twice with identical `usage`, count once and keep the copy with the lexicographically smaller `(thread_id, ordinal)`. If the usage differs, `conflict_usage`, excluded from totals and events, counted in `coverage.requests_conflict`. Recon found no duplicate `response_id`, so any duplicate is also an anomaly counter.

### 4.3 Retries and distinct billed responses

R4.5. Two different keys are two billed responses even if their usage is identical. cachewhy MUST NOT merge them. A Claude API error record (rate limit, `<synthetic>`) is not a billed response (R2.14). No heuristic matching of "retry-looking" requests is allowed.

### 4.4 Replayed history and ownership

R4.6. Claude copies. A request key seen in more than one logical stream (R4.11; recon: 444 requests, from one pair of main files; the second file also repeats uuids inside itself) is a replay in every stream but one. A key seen several times inside one logical stream is a duplicate within that stream and is collapsed by R4.1 and R4.2, not a replay. The owner is the logical stream with the earliest `stream_start`, where `stream_start` is the minimum `timestamp` among the records of all files of that stream. A replayed record keeps its original uuid and timestamp, so timestamps cannot separate original from copy; `stream_start` can. Ties on `stream_start` make ownership `ambiguous`: the lexicographically smaller `sessionId` owns, every such request is counted in `coverage.replay_ownership_ambiguous`, and every event or boundary whose `P` or `C` is such a request abstains `ownership_ambiguous` (R7.2 E3).

R4.7. Replayed records count zero tokens, zero dollars, zero events and zero boundaries in the non-owning stream. They are not discarded from the stream's history: they remain as history for baseline and TTL lineage (R9.2) and as the marker of the replay region (R4.8). Duplicated non-assistant records (uuid seen twice) are collapsed on uuid. Duplicated `compact_boundary` records collapse on uuid and belong to the owning stream.

R4.8. Replay and the first own request. A replayed request is never a previous request `P` of an event (R6.2, R7.2 E1). The first own request after a replay region in a copying stream is a boundary of type `fork_inherit` (R11.6, R11.8). It is never a suspected rebuild and never an event, and no rebuild delta is computed for it, whatever its counters show. It is nevertheless a billed response of the owning stream: its tokens and its list-price-equivalent cost (R3.5, R3.6) enter the totals and the per-kind subtotals exactly like any other response (R5.8). Only the event and the delta computation are suppressed, never the accounting of the response itself. The next own request has the first own request as `P`. There is no `via_replay` event class. Required fixture: a fork whose first own response has positive counters, asserting that its tokens and dollars are in the totals, that it is a `fork_inherit` boundary, and that it has no delta.

R4.9. Codex forks. A Codex thread is a fork iff its own `session_meta` (R4.11) has a non-null `forked_from_id`. Fork detection never depends on a second `session_meta` being present in the same file, and never on the physical position of any record. The copied prefix of a fork is the set of records of the logical stream with `ordinal < subagent_history_start_ordinal` of the own `session_meta`. The prefix cut is applied only when the stream is `ordinal_verified` (R4.12) and the own `session_meta` carries `subagent_history_start_ordinal`; otherwise the prefix is `fork_prefix_unresolved`, counted in `coverage.streams_fork_prefix_unresolved`, and every model of the stream that is not `own_turn` is unverified (R2.10). Prefix records count zero tokens (recon: `token_usage_record` is never copied, so accounting never depends on the cut: a `token_usage_record` is accounted by its own `thread_id` and `response_id`, R2.9). The first own request of a fork is the request of the stream with the smallest event time (no ordinal is needed, because no `token_usage_record` lies in the prefix); a tie gives `order_tie`. It is a `fork_inherit` boundary (R4.8). `compacted` records in the prefix are replays and are ignored for event attribution. A `compacted` record elsewhere is owned by the logical stream where it first appears by `stream_start` (earliest `session_meta.timestamp`, a minimum, so independent of record order), and a copy has `latest_token_usage_record = null` or a prefix ordinal.

R4.10. Required metamorphic tests: shuffling lines within a file, shuffling file order, duplicating any line, splitting a file in two at a line boundary (each half keeping at least one record that carries a stream identity field, R4.11), and re-serializing JSON with different key order MUST NOT change the semantic output. The semantic output is the whole report (totals, events, boundaries, causes, delta fields, headline, coverage) after these normalizations only: (a) `generated_at` is ignored; (b) opaque ids `req_<hex>`, `chain_<N>`, `sess_<N>` are compared after replacing each hex part by its rank of first appearance in the deterministic order of R14.4, because the salt is random per run; (c) the coverage counters that count physical input shape may differ and are compared against the exact expected change: `files_total` and `files_assigned_by_stream` (file splitting), `lines_total` (line duplication), `lines_duplicate_collapsed` and `duplicate_records_collapsed` (line duplication). No other byte may differ. A test run MAY inject a fixed salt through the test-only function parameter (not an environment variable or CLI flag) to make hex parts comparable directly. Fork and identity fixtures (required): a Codex fork fixture (own `session_meta`, copied parent `session_meta`, copied prefix records, own records with positive-cost responses) and a Codex multi-file thread fixture are each (a) shuffled line by line and file by file, which MUST give identical semantic output, and (b) split at every line boundary such that each half keeps at least one record that carries a stream identity field, with the expected result of every split position stored in the fixture and compared exactly. For a split where every half resolves to one stream identity (R4.11) the output MUST be identical. For a split where a half has an identity set of two or more ids, token totals MUST still be identical (accounting is keyed by record identity), and for the affected streams dollars, events and boundaries MAY only be withdrawn, never added or changed, with the withdrawal traceable to `coverage.files_stream_conflict > 0` and abstain code `stream_unresolved`.

R4.11. Logical stream. A chain's records are read as one logical stream, independent of how they are split across physical files, of file order and of line order. Identity never comes from "the first record found".

* Claude: identity is read per record from `(sessionId, agentId or main)`.
* Codex: identity is resolved per file from an identity set. In a file `F`, a `session_meta` record `m` is non-own iff another `session_meta` in `F` has `forked_from_id == m.id` (the copied parent record of a fork); every other `session_meta` is own. `own_ids(F)` is the set of ids of own `session_meta` records, `tur_ids(F)` the set of `thread_id` values of `token_usage_record` records, and `I(F) = own_ids(F) union tur_ids(F)`. Both sets are order independent.
  * `|I(F)| = 1`: `F` is assigned to that stream.
  * `|I(F)| = 0`: `F` is counted in `coverage.files_unassigned_stream` and contributes no accounting.
  * `|I(F)| >= 2`: `F` is counted in `coverage.files_stream_conflict`. Its `token_usage_record` records are still accounted by their own `thread_id` and `response_id` (accounting never depends on file membership). Its other records (`turn_context`, `event_msg`, `response_item`, `compacted`) are assigned to no stream, and every stream whose id is in `I(F)` is `integrity_unverified`.
  * A stream is also `integrity_unverified` if it has two own `session_meta` records with the same id that differ in `forked_from_id` or `subagent_history_start_ordinal`.
  * Effect of `integrity_unverified`: every pair and boundary whose `P` or `C` is in the stream abstains `stream_unresolved` (R7.2 E3), and no model of the stream is `carried_verified` (R2.10). Counted in `coverage.streams_integrity_unverified`.

All files and records with the same resolved identity form one stream. Records of a stream are ordered by `(event_time, key)` for requests (R6.1) and by `uuid` as a tie-break for Claude records; where `ordinal` is used, R4.12 applies. A file with no stream identity field is never merged into another stream by guessing. Ownership (`stream_start`, R4.6), model attribution (R2.10), previous-request search (R6.2) and linkage lookups (R5.6) use the logical stream, never the physical file. A boundary of a physical file is therefore never a context boundary, and splitting or shuffling a file does not change ownership or model attribution, except where the identity set above cannot be resolved, in which case the stream abstains rather than guesses.

R4.12. Ordinal verification. For a Codex stream, `ordinal_verified` is a computed property of the logical stream, not an assumption. It is true iff all hold: (a) every record of the stream that carries an ordinal has an integer ordinal; (b) no two distinct records of the stream share an ordinal (records are the same only if envelope type, timestamp and payload type enum are equal, so a duplicated line is not a collision); (c) sorting the ordinal-bearing records of the stream by ordinal gives envelope timestamps that never decrease. This is evaluated over the whole stream across all of its files, so it is independent of file order and splitting. A stream that fails is `ordinal_unverified` and counted in `coverage.streams_ordinal_unverified`. Every decision that uses `ordinal` to order records, to cut a prefix, to bound a time or to bind a marker is conditional on `ordinal_verified`. When it is false: carried model attributions are `carried_unverified` (R2.10), the fork prefix is `fork_prefix_unresolved` (R4.9), `start_lo` is `unknown` with basis `none` (R6.5), a Codex compaction marker is `compaction_marker_unbound` (R11.7, hypothesis low, never `confirmed`), and requests with equal event time are `order_tie` (R6.1). A stream whose files all pass the check is `ordinal_verified` even if it spans several files; a fixture with a thread over two files passing the check and one failing it are required (Q21).

## 5. Conversation graph

### 5.1 Nodes, chains, kinds

R5.1. Chain key. `chain = (provider, root_session, thread)`:

| Provider | `root_session` | `thread` |
|---|---|---|
| Claude | `sessionId` of the main file (equals the parent directory uuid for agent files) | `main` for the main file, else the `agentId` |
| Codex | `session_meta.session_id` | `thread_id` (equals `session_meta.id`) |

Chains are not files. A chain is one logical stream (R4.11). A file contributes records to exactly one chain, except replayed records which are excluded from counts by R4.7.

R5.2. Request kind (enum):

| Kind | Claude rule | Codex rule |
|---|---|---|
| `main` | `isSidechain = false` | `thread_source` is `user` or null and the thread has no `thread_spawn` parent |
| `subagent` | file under `subagents/` but not under `workflows/` | `source.subagent.thread_spawn` present, or `thread_source` is `subagent` or `agent_created_thread` |
| `workflow_agent` | file under `subagents/workflows/wf_*/` | not used |
| `helper` | not logged as a request (R5.5) | `thread_source` is `automation` |
| `classifier` | not logged as a request (R5.5) | `thread_source` is `guardian_review` |
| `advisor` | not logged as a request (R5.5) | not used |

`kind` is a property of the chain. The `/usage` main-scope comparison (R13.7) uses only `kind = main`.

R5.3. Claude subagent linkage. For an `agent-<id>.jsonl` under `subagents/` (not workflows), all must hold for `linked(verified)`:

1. `meta.json` exists and has `toolUseId`.
2. Every record's `agentId` equals `<id>` and every `sessionId` equals the parent directory uuid.
3. Parent file selection: if `spawnDepth` is 1 or absent, the parent file is the session main file. If `spawnDepth` is 2, the parent file is `agent-<parentAgentId>.jsonl` in the same `subagents/` directory, and `parentAgentId` MUST be present.
4. The parent file contains an assistant content block with `type = tool_use`, `id = toolUseId` and `name = Agent`.
5. For depth 2, the agent that owns that `tool_use` has `agentId = parentAgentId`.

Any failure gives `unlinked` with one reason from the enum `no_meta`, `no_tool_use_id`, `session_mismatch`, `agent_mismatch`, `parent_file_missing`, `tool_use_not_found`, `tool_name_unexpected`, `parent_agent_mismatch`. The chain stays in totals. Its first request is classified by the table in R11.8 and never as `subagent_cold_start`.

R5.4. Claude workflow agents have no `toolUseId`, and the log offers no structural field (in the R1.2 allowlist) that ties a `Workflow` tool call to its run. Linking through the text of a tool result would need content that R1.1 forbids to retain, so no such test exists. Workflow agents are therefore never `linked(verified)`. They are `linked(directory)` if: the directory `wf_<runId>` has `journal.jsonl` with a `started` entry whose `agentId` equals the file's agent id, and `workflows/wf_<runId>.json` exists with `runId` equal to the directory suffix. They are `unlinked` otherwise. `linked(directory)` is reported separately (`links_directory_only`) and never counted as verified. The first request of a `linked(directory)` or unlinked workflow agent is a `first_observation` boundary, never `subagent_cold_start` (R11.5). If a future version logs a structural run link, adding it needs a spec revision and a fixture.

R5.5. Helper, classifier and advisor requests in Claude Code logs. `serverClassifierRequest` is an attribute (`classifier_attached = true`) of its parent request. The call itself is not logged and has no tokens in the transcript. `advisorModel` is an attribute of the request. Title generation and similar helpers produce no assistant record. These calls are a coverage loss, quantified only through R17.5.

R5.6. Codex linkage. A subagent thread is `linked(verified)` if all hold:

1. Its `session_meta` has `source.subagent.thread_spawn.parent_thread_id` (call it `pt`).
2. If `forked_from_id` is present, it equals `pt`.
3. A resolved logical stream (R4.11) whose identity equals `pt` exists in the scanned set (plain or archived). The test uses the stream identity, never the first record of a file.
4. The parent's `session_id` equals the child's `session_id`.

Failure gives `unlinked` with reason `no_parent_id`, `fork_parent_mismatch`, `parent_file_missing`, `root_mismatch`, or `other_source` (for `source.subagent.other`). A thread with `thread_source` in `{subagent, agent_created_thread}` and no `thread_spawn` is `unlinked` with `no_parent_id`. `depth` is informational and not verified.

R5.7. Class separation. A normal subagent (starts with its own context) and a fork (starts with a copied parent prefix: Codex own `session_meta` with `forked_from_id`, R4.9, Claude replay region per R4.8) are different classes. A fork's first own request is a `fork_inherit` boundary and nothing else (R4.8), even when the fork is also a linked subagent. A normal subagent's first request is a `subagent_cold_start` boundary only if `linked(verified)`, else a `first_observation` boundary. The single decision table is in R11.8.

R5.8. Single count. Every request key contributes to the grand total once (R4.1, R4.7), including the first own response of a fork and every other boundary response (R4.8). Per-kind subtotals sum to the grand total, and a test asserts it.

### 5.2 Window and baseline

R5.9. Event time of a request: Claude `t_first`, Codex the envelope `timestamp` of its `token_usage_record`. The report window `[since, until)` is evaluated in UTC on event time only. File modification time MUST NOT include or exclude any request. A flag `--fast` MAY skip files whose mtime is older than `since` minus `C29` and prints `mtime_prefilter_on` as an assumption.

R5.10. Baseline. All files are read in full. Requests before `since` are loaded and used as previous requests and for TTL lineage state (R9.3), but they contribute zero tokens, dollars and events to the window totals. An event is in the window iff its current request `C` is in the window; its previous request `P` MAY be before the window.

## 6. Ordering and timing

R6.1. Within a chain, requests are ordered by `(event_time asc, key asc)`. Two requests with equal event time are `tie`; any event whose `P` or `C` is part of a tie abstains with `order_tie`.

R6.2. Previous request. `P(C)` is the immediately preceding request of the logical stream, taken over all requests of the stream including replayed ones (R4.7), after removing only conflicted, unkeyed, incomplete, range-failed (R2.15), unverified-version (R15.7) and api-error requests. Replayed requests are not removed: if the immediately preceding request is replayed, then `P` is replayed and the pair is the boundary `fork_inherit` (R7.2 E1). If a removed request lies between `P` and `C`, the pair is `gap_has_excluded` and the event abstains (R7.2 E3).

R6.3. Claude timing variables of a request `R`:

```
t_first(R)  = min timestamp over copies
t_last(R)   = max timestamp over copies
t_asm(R)    = timestamp of the record named by parentUuid of the earliest copy, if it resolves in the global uuid index
```

R6.4. Start bounds (the true request start is not logged, so a bound exists only where a record that must precede the request exists):

```
start_lo(R) = t_asm(R)    if t_asm exists and t_asm <= t_first(R)     basis: parent_record
            = unknown     otherwise                                   basis: none
start_hi(R) = t_first(R)
```

No offset, percentile or default lag is applied. The bound `start_lo` is the timestamp of the record that the request is built on, which exists before the request is sent. That is a causal premise, not a log fact, so it is printed as assumption `parent_record_precedes_request` and is checked experimentally by R6.8. When `start_lo(R)` is `unknown`, every gap statement that needs it is `unknown` (R6.6). Constants `C4` and `C5` are retired.

R6.5. Codex timing. `start_hi(R) = ts(token_usage_record of R)`. If the stream is not `ordinal_verified` (R4.12) or is `integrity_unverified` (R4.11), `start_lo(R)` is `unknown` with basis `none`, and the rest of this rule does not apply. Otherwise `start_lo(R)` is the greatest envelope `timestamp` among records of the logical stream with `ordinal` between `P.ordinal` and `R.ordinal` whose type is a `response_item` with `payload.type = message` and `payload.role = user`, a `function_call_output`, a `custom_tool_call_output`, or an `event_msg` with `payload.type = task_started`. These are inputs that the request contains, so the request cannot start before them (basis `input_record`). If none exists, `start_lo(R)` is `unknown`; the timestamp of the previous response is not used as a fallback, because a retry or a parallel response is not excluded.

R6.6. Gap bounds between `P` and `C`:

```
gap_min = start_lo(C) - start_hi(P)     unknown if start_lo(C) is unknown
gap_max = start_hi(C) - start_lo(P)     unknown if start_lo(P) is unknown
```

Gaps are intervals, never points, and either end may be `unknown` (serialized as `null`). Negative `gap_min` is clamped to 0. An unknown end is never replaced by a default. Every time-based decision treats an unknown end as in R9.4: with `gap_min` unknown there is no `expiry_compatible` statement; with `gap_max` unknown there is no `expiry_excluded` statement; with both unknown there is no TTL statement (`ttl_gap_unknown`).

R6.7. Documentation of timestamps. The report states that `t_first` is the time the first content block finished streaming, not request start, that `start_lo` is a causal bound resting on assumption `parent_record_precedes_request`, and that all time-based statements are interval-based.

R6.8. Start bound validation. In the controlled runs (section 12) the harness records its own wall-clock time of sending each request. Requests are matched to log records by the run manifest. For every verified run, `start_lo(R) <= harness_send_time(R)` MUST hold wherever `start_lo(R)` is known. The number of runs with a violation is reported per provider. If it exceeds `C34` for a provider, the bound is declared unvalidated: `start_lo` is `unknown` for that provider in all output, no `ttl_expiry_compatible` candidate is emitted for it, and the TTL classes of that provider are described as uncalibrated.

## 7. Suspected rebuild decision rule

### 7.1 Variables

R7.1. All quantities in this section and in section 8 are BigInt (R2.16). For request `X`:

```
Claude:  ctx(X) = i + r + w            K(X) = r + w     (cached prefix estimate after X)
Codex:   ctx(X) = in                   K(X) = c + cw    (a lower bound, see below)
```

For Codex the estimate `K` excludes the part of the newest content that was cached implicitly but not reported, so it is a lower bound of the cached prefix. A lower bound can only reduce the number of events, which is the conservative direction. For the current request: `R = r` (Claude) or `R = c` (Codex), `W = w` or `cw`, `U = i` (Claude) or `in - c - cw` (Codex). With `P` the previous request: `K_prev = K(P)`.

### 7.2 Eligibility

R7.2. A pair `(P, C)` is eligible only if all checks pass. The first failing check gives the abstain or boundary code in the third column. Checks run in this order.

| Check | Condition | If failed |
|---|---|---|
| E1 | `P` exists in the same logical stream (R6.2); if `P` is a replayed request the pair is the boundary `fork_inherit` (R4.8) | the boundary of the table in R11.8 (`fork_inherit`, `subagent_cold_start` or `first_observation`) |
| E2 | the models of `P` and `C` are verified (R2.10: Claude always, Codex `own_turn` or `carried_verified`), neither is `model_unknown`, and `model(P) == model(C)` after R3.3 normalization | if both verified and different: boundary `model_switch`; else abstain `model_unknown` (a model whose continuity cannot be verified never produces a pair verdict, a boundary or a dollar figure) |
| E3 | neither `P` nor `C` is conflicted, incomplete, invariant-failed, range-failed, `bucket_mismatch`, `ownership_ambiguous` (R4.6), or in an `integrity_unverified` stream (R4.11, code `stream_unresolved`), and no excluded request lies between them (R6.2) | abstain with the specific code |
| E4 | not a tie (R6.1) and `t_first(C) > t_first(P)` (Claude) | abstain `order_tie` |
| E5 | `K_prev > 0`, meaning `P` read or wrote cache | abstain `prev_no_cache` |
| E6 | `model` has a minimum cacheable length `M` in the table | abstain `unknown_min_length` |
| E7 | `K_prev >= max(M, C3)` | abstain `short_prefix` |
| E8 | `ctx(C) >= K_prev` | boundary `context_reset` (the context shrank below the previous cached prefix; compaction, clear or pruning, section 11) |
| E9 | `C` has valid usage fields `R, W, U` | abstain `usage_incomplete` |

`M` comes from `pricing/table.json`, which is authoritative and is audited with its sources under G0-pricing (R15.1). The following list is the test expectation for the table, not a second source: 512 for Fable 5.1, Mythos 5.1, Opus 5.5, Opus 5, Sonnet 5.5, Fable 5, Mythos 5, Haiku 5.5. 1024 for Opus 4.8, Sonnet 5, Sonnet 4.6, Sonnet 4.5, Opus 4.1, Opus 4, Sonnet 4. 2048 for Opus 4.7 and Mythos Preview. 4096 for Opus 4.6, Opus 4.5, Haiku 4.5. Codex: 1024 for models priced with cache write (GPT-5.6 and later), and for earlier models the table value `unknown`, which abstains.

R7.3. Same speed and same TTL context are not required for eligibility. A change of `speed` or `effort` is a candidate cause (R11), not an abstain.

R7.4. Removed in revision 2. A replayed previous request makes the pair a `fork_inherit` boundary (E1) and is never eligible. The id is kept so citations stay stable.

### 7.3 The numeric condition

R7.5. For an eligible pair compute, with BigInt:

```
D = max(K_prev - R, 0)    shortfall
S = R / K_prev            reuse ratio (display only, never tested directly)
```

Then exactly one outcome, decided by cross-multiplication with the rational constants (R2.16):

| Outcome | Condition |
|---|---|
| `normal` | `S >= C2`, that is `10 * R >= 9 * K_prev`. No event. |
| `grey` | `C1 <= S < C2`, that is `2 * R >= K_prev` and `10 * R < 9 * K_prev`. Abstain `grey_partial`. Counted in `coverage.pairs_abstained`. No event. |
| `suspect` | `S < C1`, that is `2 * R < K_prev`. A suspected prefix rebuild event. |

R7.6. Abstain conditions as a list, each with a code, all testable:

| Code | Meaning |
|---|---|
| `grey_partial` | partial hit between `C1` and `C2`, which new content or breakpoint placement can explain |
| `short_prefix` | prefix below `max(M, C3)`, so cacheability or noise cannot be separated |
| `suffix_growth_only` | informational tag on a `normal` outcome where `W + U > K_prev` (large new suffix, intact prefix); growth is never a rebuild and produces no event |
| `shrink` | `ctx(C) < K_prev`, reported as boundary `context_reset` |
| `order_tie`, `prev_no_cache`, `model_unknown`, `unknown_min_length`, `usage_incomplete`, plus the E3 codes | as in R7.2 |

R7.7. By construction the event never uses the new suffix as lost prefix: no bound of section 8 exceeds `K_prev`, and none exceeds `W + U`, so growth beyond the previous prefix is never counted as rebuilt.

R7.8. Output of the detector for each pair is one of `no_event`, `event`, `abstain(code)`, `boundary(type)`. Counts of each go to `coverage`. The headline denominators are in section 16.

## 8. Rebuilt token bound and dollar delta

### 8.1 Token bound

R8.1. For a `suspect` event compute two bounds (BigInt):

```
L    = min(K_prev, W + U)    unconditional upper bound
L_pm = min(D, W + U)         upper bound conditional on assumption read_region_is_prefix_of_previous
```

`L` makes no assumption about what the `R` read tokens matched. At most the whole previous cached prefix can have been processed again, so `L` never exceeds `K_prev`, and the tokens processed again are inside the uncached tokens `W + U` of `C`, so `L` never exceeds `W + U`. This is needed because `D = K_prev - R` is a bound only if the `R` tokens read are the first `R` positions of the prefix of `P`. Example: `K_prev = 20000`, `C` reads `R = 8000` tokens from an unrelated cache entry, and the 20000 old tokens are processed again. Then `D = 12000` is below the true figure of 20000, while `L = min(20000, W + U) = 20000` holds. `L_pm` is the tighter figure under the assumption that the read region is a prefix of the previous prefix (printed as assumption `read_region_is_prefix_of_previous`); under E8, `W + U >= D`, so `L_pm = D`. `L_pm <= L` always. Neither is a measurement: the log does not prove that the content of the prefix was unchanged. `L` is the only token bound used in the observational range.

R8.2. Observational lower bound. The log cannot show that a prefix was unchanged: the absence of a marker is not evidence of an unchanged prefix. Therefore the observational lower bound is always `L_lo = 0`, for every event. A separate, explicitly conditional metric `L_if_unchanged` is defined: `L_if_unchanged = L_pm` if no structural marker is observed between `P` and `C`, else `null` (an unchanged prefix implies that the read region is a prefix of the previous prefix, so the prefix-match assumption is part of it). Structural markers are: a diagnostics structural type (R10.3), `version` changed (Claude), `comp_hash` changed (Codex), a compaction marker bound to `C` (R11.7), `effort` changed on a model that does not preserve cache on effort change (R11.5), `speed` changed, and for Claude 2.1.293 agents a `toolsHash` or `model` difference where R10.6 applies. Whenever `L_if_unchanged` is not `null` the report prints assumption `no_marker_means_unchanged_prefix` next to it. `L_if_unchanged` is never presented as a lower bound, never used in the observational range, and always labelled "if the prefix was unchanged".

R8.3. Tokens-only output. Every suspect event reports `L` (unconditional upper bound), `L_pm` (upper bound conditional on prefix match), `L_lo = 0` (observational lower bound) and `L_if_unchanged` (conditional, or `null`). This is always produced.

### 8.2 Dollar delta

R8.4. A dollar delta is produced only if all of the following hold, otherwise `usd = null` and `delta_status = tokens_only` with reason codes:

| Assumption | Reason code if false |
|---|---|
| A1: model of `C` is priced and all modifiers resolved (R3.4) | `unpriced_model` or `unpriced_modifier` |
| A2: for Claude, `cache_creation` buckets present on `C` and `bucket_mismatch` false | `bucket_unknown` |
| A3: `P` and `C` have no conflicts (E3) | `conflict` |
| A4: the event is `suspect` and passed every eligibility check | not applicable (no event) |
| A5: `K_prev` rests on `P` counters only, never on diagnostics estimates | `diag_estimate_used` (a hard error if ever triggered) |
| A6: tier of `C` is the tier used (Haiku 5.5, Codex long context), no tier change between `P` and `C` | `tier_straddle` |

R8.5. Positional bucket allocation, valid only under assumption `read_region_is_prefix_of_previous`. The rebuilt tokens then sit directly after the read region, in position order. Claude: allocate to `w1` first, then `w5`, then `U`. Codex: allocate to `cw` first, then `U`. It is applied to `L_pm` and never to `L`. For each bucket `b` with allocation `L_b`:

```
delta_b = L_b * (p_b - p_read)
delta   = sum over b of delta_b
```

with `p_b` the input price for `U`, the 5m write price for `w5`, the 1h write price for `w1`, and for Codex the write price for `cw` and the input price for `U`. All `p_b > p_read` in the table, so each term is positive.

R8.6. Range. Compute these values with allocation caps `(w1, w5, U)` (Claude) or `(cw, U)` (Codex):

* `usd_hi`: the allocation of the unconditional `L` that puts the most tokens into the highest `p_b - p_read` bucket first, up to its cap, regardless of position. It assumes nothing about the read region. This is the observational upper bound. A test asserts `usd_if_unchanged_lo <= usd_point <= usd_hi` wherever all three exist.
* The observational lower bound is `0`, because `L_lo = 0` (R8.2). It is not serialized as a field.
* `usd_if_unchanged_lo`: only when `L_if_unchanged` is not `null`: the allocation of `L_if_unchanged` that puts the most tokens into the lowest `p_b - p_read` bucket first, up to its cap. Otherwise `null`.
* `usd_point`: only when `L_if_unchanged` is not `null`: the positional allocation of R8.5, using `L_pm`. Otherwise `null`.

The observational range is `[0, usd_hi]`. The conditional range, shown only with its assumption, is `[usd_if_unchanged_lo, usd_hi]`. `usd_point` is printed in `--json` and `evidence` but not in the headline. The words "saving", "avoidable" and "cost you" are forbidden in output (R16.4).

R8.7. Forbidden dollar sources. Dollars are never computed from `cache_missed_input_tokens` or from any diagnostics token estimate. No rebuild delta is ever computed for `boundary` items (`model_switch`, `context_reset`, `subagent_cold_start`, `fork_inherit`, `first_observation`). This forbids the delta only: the list-price-equivalent cost of the boundary response itself is accounted normally under section 3 and R4.8, and is not a delta. A model switch is never priced as a saving at the new model's read price.

R8.8. Aggregation. `delta` sums only over events with `delta_status = ok`. `usd_hi` values are summed into the observational upper bound. `usd_if_unchanged_lo` values are summed into the conditional lower bound only over events where it is not `null`, and the headline states over how many events. The headline reports the count of events with and without a dollar delta (section 16).

## 9. TTL

### 9.1 Claude

R9.1. TTL class comes from write buckets only: `w5 > 0` means 5m, `w1 > 0` means 1h. Recon: main chains write 1h only, subagent and workflow chains write 5m only, no request mixes. The implementation MUST NOT assume this and MUST handle mixed buckets.

R9.2. Lineage state. For each chain keep an ordered list of segments `(end_position, ttl_class)` covering `[0, K]`. When request `X` is processed, positions `[0, R_X]` keep their classes (read refreshes at the same class, no upgrade). The write region is appended after `R_X` in this order: `w1` positions first with class `1h`, then `w5` positions with class `5m`, because the official ordering rule puts longer TTL entries first. `w_unknown_ttl` is appended with class `unknown`. If `R_X < previous K`, segments beyond `R_X` are truncated before appending. Segment lists are rebuilt from baseline requests (R5.10) and from replayed requests of the stream (R4.7), which count nothing but carry the counters of the owner's copy.

R9.3. Touch assumption. Every position up to `K(P)` is treated as last touched by `P`. This may understate the true gap for an inner breakpoint entry, which only makes the expiry claim harder. The report prints assumption `ttl_touch_is_previous_request`.

R9.4. Expiry test for a suspect event or a `grey` pair. The possible TTL is kept as a range, never collapsed to one value, because the two statements need opposite directions of conservatism: a compatibility claim must hold even for the largest possible TTL, and an exclusion claim must hold even for the smallest possible TTL. Let `q = R + 1` be the first position of the previous prefix that was not read. Take the segment containing `q`. Its class gives the range `[T_lo, T_hi]`:

| Class | `T_lo` (smallest possible TTL, used for exclusion) | `T_hi` (largest possible TTL, used for compatibility) |
|---|---|---|
| `5m` | `C6` | `C6` |
| `1h` | `C7` | `C7` |
| `mixed` or `unknown` | `C6` | `C7` |

For `mixed` and `unknown` the range rests on the assumption that Claude offers only the 5m and 1h options, printed as assumption `claude_ttl_options_5m_1h`. Then:

* `expiry_compatible` iff `gap_min` is known and `gap_min > T_hi`.
* `expiry_excluded` iff `T_lo` is defined, `gap_max` is known and `gap_max <= T_lo`.
* Otherwise `expiry_ambiguous`.

Example: a segment of class `unknown` with a gap interval of `[600 s, 600 s]` is `expiry_ambiguous`, not excluded, because the real TTL may be 300 s. An exclusion is never produced where `T_lo` is undefined (an unbounded uncertainty, as for the OpenAI rows of R9.6 without a documented minimum). If `gap_min` is unknown there is no compatibility statement, if `gap_max` is unknown there is no exclusion statement, and if both are unknown the pair has no TTL statement (`ttl_gap_unknown`). When `q` has no segment (lineage unknown), no expiry statement is made (`ttl_class_unknown`). Only `expiry_compatible` creates a `ttl_expiry_compatible` candidate. The C4 and C5 offsets of revision 1 do not exist, and a bound the provider validation of R6.8 rejects is `unknown`. Required fixtures: segments of each class with gap intervals on both sides of `T_lo` and `T_hi`, including the 300 s versus 600 s case above.

R9.5. A time-based cause is at most `ttl_expiry_compatible` (a hypothesis, R11.3). It MUST NOT be `confirmed`, because request start is inferred and refresh by an intermediate hit on a different chain is not visible.

### 9.2 OpenAI

R9.6. TTL by model family for Codex.

| Model family | `T_lo` (exclusion) | `T_hi` (compatibility) |
|---|---|---|
| `gpt-6*`, `gpt-5.6*` | `C8` | `C8` (30 minutes; the docs say eligible at least 30 minutes after the latest write or reuse, so a gap at or below `C8` is excluded, and `gap_min > C8` is compatible, not proof, because no maximum is documented, Q10) |
| `gpt-5.5`, `gpt-5.4`, `gpt-5.2`, `gpt-5.1*`, `gpt-5`, `gpt-5-codex`, `gpt-4.1` | undefined (no guaranteed minimum is documented for `in_memory` retention, so no exclusion is ever made) | `C9` (retention is `in_memory` up to 1 hour or `24h` and the setting is not logged, so the larger value is used) |
| any other model | undefined | undefined, no TTL statement |

The tests of R9.4 apply with these ranges.

R9.7. Codex reads and writes both refresh retention. `K(P)` positions are treated as touched at `P`, same as R9.3.

R9.8. Mixed or unknown TTL is preserved: a segment list never collapses `mixed` into `5m` or `1h`, and the output field `ttl_class` takes the values `5m`, `1h`, `mixed`, `unknown`, `openai_30m`, `openai_unknown`.

## 10. Diagnostics

R10.1. Source. `message.diagnostics` (Claude). Recon: present on every assistant record, null on about 99.8 percent, non-null on 72 unique requests. The `cache_miss_reason.type` values seen are `previous_message_not_found`, `messages_changed`, `tools_changed`, `model_changed`, `unavailable`, `system_changed`. Absence is the normal case and carries no information. The adapter is optional: all outputs MUST be valid with it entirely absent.

R10.2. Three separate facts are recorded, never merged into one flag:

| Fact | Field | Meaning |
|---|---|---|
| Structural change reported | `diag.type` | what the API says differs from its comparison basis |
| Cache usage observed | counters of `C` and `S` | what the billing counters show |
| Causal interpretation | `candidates[].level` | derived by R11 |

R10.3. Interpretation table.

| `diag.type` | Structural change observed? | May support cause |
|---|---|---|
| `messages_changed` | yes | `context_edit_or_prune` |
| `tools_changed` | yes | `tools_or_system_changed` |
| `system_changed` | yes | `tools_or_system_changed` |
| `model_changed` | yes | `model_switch` |
| `previous_message_not_found` | no (the API had no basis to compare) | none; recorded as `diag_no_baseline`; the event stays `unknown` unless other signals exist |
| `unavailable` | no | none; recorded as `diag_unavailable` |
| `null` or absent | no | none |
| `pending` or any value not listed | no | none; recorded as `diag_unrecognized` (never observed in recon) |

R10.4. What a diagnostics record is. The API reports that its comparison basis differs in some structural way. The fact "the API reported type X on request `C`" is `observed`. It is not shown that the comparison basis was the request `P` of the chain, because the comparison request is not identified in the log. Therefore a diagnostics type never makes a cause `confirmed`. It supports a `hypothesis` for the mapped cause (R10.3), at most with confidence `high` (R11.3), and only if the counters of `C` also show a `suspect` event under section 7 for the pair `(P, C)`. A structural type with `S >= C2` (`10 * R >= 9 * K_prev`) is recorded as `structural_change_with_hit` (observed), counted separately from rebuild events, and gets no cause and no dollars. Two different non-null types on one request give `conflict_diagnostics` and no evidence.

R10.5. Chain match. The hypothesis of R10.4 additionally requires that `P` is the immediately preceding request in the chain (R6.2) and that the diagnostics was not `previous_message_not_found`. The report prints assumption `diag_basis_is_chain_previous` for every diagnostics-based hypothesis. The assumption is not verifiable from logs. Promoting a diagnostics type to `confirmed` needs a log field that identifies the compared request, a fixture showing it, and a spec revision (Q22).

R10.6. Local prefix hash files (`agent-*.prefix.json`, Claude Code 2.1.293 agents only). Recon: one file per agent, with hashes, `callCount` and `prevCacheReadTokens`, and it is not shown to be per request. v1 uses them only as agent-level corroboration: `state.is1hCacheTTL` against the write buckets observed, and `state.model` against the model of the chain. They never create a per-request structural-change claim and never produce dollars (Q4).

R10.7. `cache_missed_input_tokens`, when present, is stored as `diag.missed_tokens_reported` with role `api_reported_estimate`. It is never used in `L`, `K_prev`, dollars or reconciliation.

## 11. Cause taxonomy and evidence levels

### 11.1 Levels

R11.1. Evidence levels:

| Level | Definition |
|---|---|
| `observed` | A fact visible in fields or counters of the request pair or chain. No claim about what caused a cache miss. |
| `hypothesis` | A signal compatible with a mechanism the official docs describe. Always carries `confidence` in `{low, medium, high}`. |
| `confirmed` | A direct local marker that by documented mechanism determines the invalidation: only a bound compaction marker under R11.7. An API diagnostics type is never `confirmed` (R10.4); it is `observed` as a report and at most `hypothesis` as a cause. |
| `unknown` | No candidate with any signal. |

R11.2. Caps. Pairs with ambiguous ownership abstain before any level is assigned (R4.6), so no cap for them is needed. Any class that has not met the G3 bounds (R12.7) is capped to `hypothesis` (low) in default output, and the docs list it as uncalibrated.

R11.3. Confidence of a hypothesis, deterministic: `high` if exactly one candidate has a signal and the signal is a hard field (version changed, API diagnostics type with the counters condition of R10.4, bound-but-unconfirmed marker); `medium` if exactly one candidate has a signal and it is soft (expiry compatibility, partial-hit pattern); `low` if two or more candidates have signals, or the class is uncalibrated.

R11.4. Multiple candidates are always kept. Output has `candidates` (all, ordered by the precedence list below) and `primary`. `primary` is the candidate with the highest level, then highest confidence, then earliest in the precedence list. If the top two candidates tie on level and confidence, `primary = null` and the event is shown as `multiple`.

Precedence: `compaction_or_clear`, diagnostics-reported causes (`model_switch`, `tools_or_system_changed`, `context_edit_or_prune` with a diagnostics signal), `model_switch`, `tools_or_system_changed`, `request_settings_changed`, `ttl_expiry_compatible`, `fork_inherit`, `context_edit_or_prune`, `unknown`.

### 11.2 Signals per cause

R11.5. Each row gives the exact signal and the highest level it can reach. A cause row applies to a `suspect` event, or to a boundary when the row says so.

| Cause | Exact signal | Max level |
|---|---|---|
| `model_switch` (boundary, not a rebuild event) | `model(C) != model(P)` in the same chain, both verified (R2.10, R7.2 E2). Per-model caches are documented. | `observed`; a `diag.type = model_changed` on the same pair adds `hypothesis` high as a cause note, still a boundary |
| `tools_or_system_changed` | (a) `diag.type` in `{tools_changed, system_changed}` with the counters condition of R10.4; (b) Claude `version(C) != version(P)`; (c) Codex `comp_hash(C) != comp_hash(P)`, both non-null | (a) `hypothesis` high (API report, comparison basis unverified, R10.4); (b) `hypothesis` high (documented upgrade invalidation); (c) `hypothesis` low (the meaning of `comp_hash` is inferred, Q15) |
| `request_settings_changed` (added to the plan taxonomy) | Claude: `effort` differs between `P` and `C` on a model that does not preserve cache on effort change, or `usage.speed` differs. Codex: `turn_context.effort` differs. The effort-preserving Claude models are Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1; on them an effort change is no signal. | `hypothesis` medium |
| `ttl_expiry_compatible` | `expiry_compatible` per R9.4 or R9.6 | `hypothesis` medium, never `confirmed` (R9.5) |
| `compaction_or_clear` | A `compact_boundary` record (Claude) or an own `compacted` record (Codex) bound to `C` under R11.7 | `confirmed` if bound; `hypothesis` low if the marker exists in the chain between the two request times but binding failed (`compaction_marker_unbound`) |
| `subagent_cold_start` (boundary) | row 2 of the table in R11.8: `C` is the first request of a `linked(verified)` chain of kind `subagent` (never `workflow_agent`, R5.4), whatever its cache read `R` is | `observed` |
| `fork_inherit` (boundary) | row 1 of the table in R11.8: `C` is the first own request after a replayed prefix (R4.8, R4.9). It is only a boundary, never an event | `observed` |
| `first_observation` (boundary) | row 3 of the table in R11.8: `C` is the first request of a `main` chain with no earlier data, or of an `unlinked` or `linked(directory)` agent chain, or of a workflow agent | `observed` |
| `context_edit_or_prune` | partial hit: `0 < R < K_prev` and `S < C1`, or `diag.type = messages_changed` with the counters condition. The Claude record field `input_transformations` (thinking dropped) is present on about three quarters of all records, so it carries no signal and MUST NOT be used. | partial-hit signal: `hypothesis` low; with `messages_changed`: `hypothesis` high (R10.4) |
| `unknown` | none of the above has a signal | `unknown` |

R11.6. Boundaries. `model_switch`, `context_reset` (E8), `first_in_chain` types (`subagent_cold_start`, `fork_inherit`, `first_observation`) are cache boundary events. They are listed in the timeline, counted in the headline under "cache boundaries", get no rebuild delta, and are not counted as suspected rebuilds. The response of a boundary is still a billed response and is accounted in totals and dollars like any other (R4.8, R8.7). The boundary type of a response is chosen only by the table in R11.8.

R11.7. Compaction binding. Claude: let `b` be a `compact_boundary` record. Walk `parentUuid` ancestors of the earliest copy of `C`, up to `C27` hops. `b` is bound to `C` iff the walk meets a record with `isCompactSummary = true` whose parent is `b`, and the same walk from `P` does not meet it. If the walk breaks (an unresolved uuid) the marker is unbound. Presence of a `compact_boundary` in the same file is not sufficient. Codex: an own `compacted` record (not in a copied prefix, R4.9) is bound to the first `token_usage_record` of the same thread with a greater `ordinal`, and only if the stream is `ordinal_verified` (R4.12) and not `integrity_unverified` (R4.11). Otherwise the marker is `compaction_marker_unbound` (hypothesis low, never `confirmed`), because the order of the marker and the request is then not established. A `compact_boundary` whose `preTokens` and `postTokens` are present but where `ctx(C)` exceeds `postTokens` by more than `K_prev` (BigInt) is flagged `compaction_size_inconsistent` and stays unbound.

R11.8. Boundary decision table. This is the only place that chooses a boundary type; R4.8, R5.7, R7.2 and R11.5 refer to it. The enum is exactly the boundary `type` enum of R14.5: `model_switch`, `context_reset`, `subagent_cold_start`, `fork_inherit`, `first_observation`. Rows are tested in order for a request `C`, and the first row that matches decides.

| Row | Condition on `C` | Result |
|---|---|---|
| 1 | `C` is the first own request after a replayed prefix: Claude, `P(C)` is a replayed request (R4.8); Codex, `C` is the first request of a fork stream (R4.9). Applies even if the chain is also a `linked(verified)` subagent | boundary `fork_inherit` |
| 2 | `C` has no `P` in its logical stream, the chain is of kind `subagent` and `linked(verified)` (R5.3, R5.6), and row 1 does not apply | boundary `subagent_cold_start`, whatever `R` is. The name marks the start of the chain's own context, not an empty cache: a first response that already carries a cache hit keeps this type and reports the hit in the boundary field `r`. It is never inferred from `R == 0` or `R < M` |
| 3 | `C` has no `P` in its logical stream and rows 1 and 2 do not apply: first request of a `main` chain with no earlier data, of an `unlinked` or `linked(directory)` agent chain, or of a workflow agent (R5.4). A new session file after `/clear` is indistinguishable from a new session and lands here (Q8) | boundary `first_observation` |
| 4 | `P` exists, E1 passed, and `model(P) != model(C)` with both verified (R7.2 E2, which runs before E3) | boundary `model_switch` |
| 5 | `P` exists, passed E1 to E7, and `ctx(C) < K_prev` (R7.2 E8) | boundary `context_reset` |

There is no separate `cold_start`, `after_reset` or `first_in_chain.kind` value: a request after a bound compaction is a `context_reset` boundary in row 5 if the context shrank, otherwise an ordinary pair where `compaction_or_clear` is a candidate cause (R11.5). `first_in_chain` is only a name for the family of rows 1 to 3. If none of the rows matches, the pair goes on to the numeric condition of R7.5.

R11.9. Counts by level in the headline sum to the number of suspected rebuild events, with no event counted twice.

## 12. Controlled experiments and accuracy gates

### 12.1 Experiment design

R12.1. Ground truth comes only from controlled single-intervention runs. LLM labelling is not ground truth. Natural logs are never used as labelled data (R12.9), and this includes natural requests that carry API diagnostics (R12.10). A label is only a ground truth for a run if the effect check of R12.3 passed.

R12.2. Fixed per-run settings, recorded in the run manifest: product version (exact), model id, TTL class (set explicitly with `CLAUDE_CODE_PROMPT_CACHE_TTL` for the main bucket, and the explicit subagent TTL variable for subagent runs), `FORCE_PROMPT_CACHING_5M` unset or set, effort, fast mode off, MCP and plugin set, permission mode, working directory content, prompt text (synthetic filler of at least `C30` times the model's minimum cacheable length plus a fixed run nonce so concurrent runs cannot share cache entries).

R12.3. Run protocol. Step 1 cold write. Step 2 warm hit: this is the warm-hit precondition and it is measured with the harness's independent counters, in BigInt (R2.16): `R_2 >= C22 * K_1`, that is `10 * R_2 >= 9 * K_1`. A run that fails the precondition is discarded before any intervention and recorded in `discarded_runs` with its reason. Discard rate is published. Step 3 intervention: exactly one change, applied between step 2 and step 3. Step 4 optional recovery check. The manifest records the intervention timestamp and the expected observation, which is stated before the run.

Effect check. An intervention label is not a ground truth until the intended effect is shown by the harness's independent counters (R12.4), with the criterion fixed in the scenario table (R12.5) before the run. With `K_2 = R_2 + W_2` and `R_3` taken from the harness counters of the step 3 request:

| Criterion | Verified iff | Used by |
|---|---|---|
| `miss` | `R_3 <= C21 * K_2`, that is `2 * R_3 <= K_2` | positive scenarios and boundary scenarios in R12.5 |
| `hit` | `R_3 >= C22 * K_2`, that is `10 * R_3 >= 9 * K_2` | negative controls |

The harness writes its verdict (`effect_verified` or `no_effect`) into the manifest before cachewhy is run on the transcript of that run, so the verdict cannot depend on cachewhy output. A `no_effect` run is not a failure of cachewhy and not a success. It gets no label, is excluded from precision and coverage, and is reported separately per scenario with its count and share. A positive scenario whose `no_effect` share exceeds `C23` is `invalid` and its class cannot be claimed. A negative control run in which the harness saw a miss is `no_effect` too and is never counted as a false positive.

R12.4. Independent measurement. The harness measures usage from the product's own structured output (`claude -p --output-format stream-json` result usage, `codex exec --json` events), through code in `scripts/experiments/` that imports nothing from `src/`. cachewhy is then run on the transcripts and its output is compared with the manifest. The harness also records its own wall-clock send time of each request for R6.8. The harness stores no message text; fixtures store structure and numbers only.

### 12.2 Scenarios

R12.5. Scenario list. Positive scenarios produce one expected cause. Negative controls expect no event (a hit).

| Id | Provider | Scenario | Expected | Notes |
|---|---|---|---|---|
| P1 | Claude | wait longer than TTL with TTL fixed to 5m: wait 330 s | `ttl_expiry_compatible` | main bucket with explicit 5m override |
| N1 | Claude | same setup, wait 240 s | no event | shorter than TTL |
| N2 | Claude | default 1h main TTL, wait 330 s | no event | 1h-vs-5m awareness: a 5m wait must not expire a 1h entry |
| P2 | Claude | default 1h TTL, wait 3720 s | `ttl_expiry_compatible` | long run, parallelized across nonces; if `n` cannot reach C12 the class is uncalibrated |
| P3 | Claude | switch model between step 2 and 3 | boundary `model_switch` | |
| P4 | Claude | add an MCP server so tools load upfront | `tools_or_system_changed` hypothesis | if the version loads tools through tool search, the run is invalid and is dropped by manifest |
| N3 | Claude | change only permission mode or output style | no event | documented as cache-preserving |
| P5 | Claude | change effort on a model that invalidates on effort change | `request_settings_changed` | |
| N4 | Claude | change effort on Opus 5.5, Sonnet 5.5, Haiku 5.5 or Fable 5.1 | no event | documented as cache-preserving |
| P6 | Claude | `/compact` | `compaction_or_clear` | only if drivable in headless mode for the pinned version; otherwise the class is excluded from claims |
| N5 | Claude | spawn a subagent from the main chain and continue | main chain: no event; subagent chain: boundary `subagent_cold_start` | parent cache is documented to stay intact |
| P7 | Codex | change `reasoning.effort` via exec resume | `request_settings_changed` | |
| P8 | Codex | switch model | boundary `model_switch` | |
| P9 | Codex | wait 1860 s on a `gpt-6*` or `gpt-5.6*` model | `ttl_expiry_compatible` | |
| N6 | Codex | wait 1500 s same model | no event | shorter than 30 minutes |
| N7 | Codex | no change, immediate continue | no event | baseline |

Effect criteria (R12.3): P1 to P9 use `miss` (P3 and P8 are boundary scenarios whose intervention also must show `miss`). N1 to N4, N6 and N7 use `hit`. N5 uses `hit` for the main chain and `miss` for the first request of the subagent chain. The wait times and all other parameters in this table are scenario parameters frozen under section 0.4. In a positive or boundary scenario, "expected" is the label that is scored; it is scored only on runs with `effect_verified`.

R12.6. Wilson 95 percent interval: `lb, ub = (p + z^2/2n +/- z*sqrt(p(1-p)/n + z^2/4n^2)) / (1 + z^2/n)` with `z = 1.96`. Reference values for planning:

| n | all correct, lower bound | one error, lower bound | two errors, lower bound | zero false positives, upper bound |
|---|---|---|---|---|
| 20 | 0.839 | 0.764 | 0.699 | 0.161 |
| 30 | 0.886 | 0.833 | 0.787 | 0.114 |
| 40 | 0.912 | 0.871 | 0.835 | 0.088 |
| 60 | 0.940 | 0.911 | 0.886 | 0.060 |
| 80 | 0.954 | 0.933 | 0.913 | 0.046 |

### 12.3 Dev set, eval set, and the pre-registered G3 bounds

R12.7. Datasets and bounds.

Definitions. The scoring population is the set of runs that passed the warm-hit precondition and have `effect_verified` (R12.3). The prediction unit is one run: cachewhy is applied to the transcript of the run and its output for the intervention pair `(P = step 2 request, C = step 3 request)` is read. The prediction of the run is the `primary` cause of the event or boundary for that pair. Non-primary candidates are never scored. If there is no event or boundary, or `primary` is `null`, or the pair abstains, the run has no prediction; it counts toward coverage (R12.8), not toward precision. For a class `K`:

* `TP_K`: runs whose prediction is `K` and whose expected label (R12.5) is `K`.
* `FP_K`: runs whose prediction is `K` and whose expected label is not `K`. This includes runs of other positive scenarios and any prediction on a negative control (a negative control expects no event and no prediction).
* `n_K = TP_K + FP_K`. Precision is `TP_K / n_K` with Wilson interval on `n_K`. The `n` in every Wilson computation of this spec is the count of the scored predictions, never the number of runs.

Negative controls are scored by violation, independent of `primary`. A violation is any of the following on the intervention pair `(P, C)` of a run that is `effect_verified` (a negative control that expects no event and no boundary: N1 to N4, N6, N7): the pair yields an `event` (outcome `suspect`), or yields any boundary. Whether `primary` is `null`, whether the candidates tie, and what `primary` is have no bearing: a wrong event with `primary = null` (for example two equally ranked candidates) is a violation exactly like one with a named cause. An abstention (including `grey`) is not a violation and counts toward coverage only. For N5 the same test is applied to the main chain pair (any event or any boundary is a violation), and to the first request of the subagent chain, where an event or any boundary type other than `subagent_cold_start` or `first_observation` is a violation. A violation whose `primary` is non-null is also an `FP` of that class in `FP_K`; a violation with `primary = null` is an `FP` of no class and still counts as a violation. Required fixtures: a negative-control transcript that produces an event with two equally ranked candidates (`primary = null`), and one that produces an unexpected boundary, each asserted to be counted as a violation.

Bounds.

1. Development set: at least `C15 = 20` runs per scenario. Used to tune `C1` to `C3` and to debug. May be inspected freely.
2. Evaluation set: generated only after tag `spec-freeze`. Runs are generated until each claimed class has `n_K >= C12 = 40` scored predictions and each negative control has at least `C12 = 40` runs with `effect_verified`, or until the run budget in the manifest is exhausted. Its manifest is hashed (sha256) and the hash committed to `docs/audit-log.md` before any evaluation transcript is processed. The evaluation set is never used for tuning.
3. G3 passes for a class iff `n_K >= 40` and the Wilson lower bound of precision is at least `C13 = 0.85` (with `n_K = 40` this allows one error).
4. G3 passes for a negative control iff the number of runs with a violation (defined above, independent of `primary`) is 0 of at least 40 runs with `effect_verified`, giving a Wilson upper bound of 0.088, which is at most `C14 = 0.10`. Violations with a non-null `primary` also count as `FP` of the predicted class in item 3.
5. A class with `n_K < 40` or a failed bound is not claimed. It remains in output as `hypothesis` low and is listed as uncalibrated (R11.2). A claimed class with a mixed result is described by its bounds, never by its point estimate alone. `no_effect` runs, discarded runs and invalid scenarios are reported next to every claim (R12.8).

R12.8. Coverage. For each class, coverage is the fraction of scoring-population runs (R12.7: warm precondition passed and `effect_verified`) of that class's positive scenarios for which cachewhy emitted a non-abstaining prediction. The Wilson interval uses `n` equal to the number of those runs. A class with coverage lower bound below `C16 = 0.50` is described as "detected in some runs only" and cannot appear in the README headline. Abstention is allowed, there is no `unknown` quota, and a low coverage never counts as an error in precision. `docs/accuracy.md` reports precision, coverage, abstention reasons, dollar-weighted error on events with `delta_status = ok`, the discard rate, and per scenario the `no_effect` count and share.

R12.9. Natural data. Dogfood logs measure only coverage, abstention rates, the share of `unknown`, and a hand check of the `C31` events with the largest `L`, each marked agree, disagree or unresolved. These are not precision numbers and are published as such.

R12.10. Diagnostics-based hypotheses. Natural requests that carry diagnostics (rare in recon: 72) are not labelled data and are never used to calibrate or to validate (R12.1, R12.9). They are counted for coverage only. A diagnostics-based hypothesis is calibrated only on controlled runs in which an intervention is expected to make the API report a type (for example P3 and P4 in R12.5), scored under R12.7. Unless a class reaches the R12.7 bounds on such runs, docs word the signal as "reported by the API", never "validated" or "confirmed".

## 13. Reconciliation

R13.1. Independent recompute. `scripts/recompute` is a separate implementation that reads raw files and applies sections 2 to 4 and section 8 without importing from `src/`. It outputs per-response buckets, token totals, and dollars. It MUST be written from this document, not from `src/`.

R13.2. Exact equality on synthetic fixtures. For every synthetic fixture, `src/` and `scripts/recompute` agree exactly on every integer bucket and every money unit (R3.8). Any difference is a failure.

R13.3. On the real-corpus snapshot, per-response buckets and picodollar values MUST also agree exactly between `src/` and `scripts/recompute`. Because both are written by the same team, this is necessary but not sufficient, so R13.4 and R13.7 apply.

R13.4. ccusage comparison. A pinned exact ccusage version (recorded in `reconcile.lock.json`, never `@latest`), a frozen log snapshot (manifest of file names and sha256 of each file), UTC as timezone, and the price table version are recorded. The comparison is per day, per model, per kind (main, subagent, workflow, Codex thread) and per bucket (input, read, write, output). Differences are broken down into named categories and each category carries a token count:

| Category | Expected source |
|---|---|
| `dedup_rule` | ccusage keeps the first copy by message and request id, which for subagent requests is a partial copy with output at message_start value |
| `subagent_scope` | files ccusage skips or includes |
| `no_final_output` | R2.3 requests, where cachewhy reports a lower bound |
| `pricing_table` | different price source |
| `window_tz` | boundary differences |
| `unknown_model` | R3.3 |
| `unexplained` | everything else |

Reconcile passes iff: input, read and write token totals differ by at most `C17 = 1 percent` after removing `dedup_rule` and `no_final_output`, cost differs by at most `C18 = 2 percent` on the common priced set, and `unexplained` is at most `C33` of tokens. Tolerances apply to totals only after the breakdown is published, so offsetting errors are visible as separate lines.

R13.5. Scopes are reconciled separately: main thread, helper, subagent, workflow. A pass on the sum with a failure on one scope is a failure.

R13.6. Codex internal consistency. Sum of `usage` per thread against the last `thread_token_usage` of that thread: within `C19 = 0.5 percent`, and exact where the record chain is complete (recon: equal to previous plus `usage` in 13,850 of 13,851). Threads that start in a continuation file are excluded and counted.

R13.7. `/usage` comparison. Scope is the main conversation only (`kind = main`), because `/usage` reports "Prompt cache (main)". The user supplies `/usage` values for 5 sessions at D6. Compared: request count, percent of input served from cache (`r / total_input`) within `C20 = 1 percentage point`, token sums within `C17`. The `/usage` misses and expected-rebuild counts use an unpublished definition, so they are shown side by side and are informational, not a gate.

R13.8. Output of reconcile is a typed report with the same allowlist rules as R14.

## 14. Privacy

R14.1. Promise text: "cachewhy does not analyze, store, or export message content." Statements about parsing: lines are fully parsed as JSON, and the retained fields are listed in R1.2.

R14.2. Network. The statement is: "after the package is installed, analysis makes no network calls." Proof: (1) the CLI runs under Linux `unshare -n` (or a container with `--network none`) in CI and passes the whole suite; (2) on all three operating systems, a preloaded guard (`node --require`) replaces `net.Socket.prototype.connect`, `dns` lookups, `http`, `https`, `http2`, `dgram`, `fetch` and `child_process` spawn with functions that record and throw, and the test asserts zero recorded calls. Grep for network APIs is a supplement and is not proof.

R14.3. Typed output schema. Every string in `--json` and `evidence` output comes from one of: an enum defined in the schema; an opaque id generated by the tool; a model id matching `^[a-z0-9][a-z0-9._-]{0,63}$` and present in the table or replaced by `unlisted`; a version matching `^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$` or `unlisted`; an ISO instant. Free-text fields do not exist. A new field requires a schema change, a test update, and an allowlist entry.

R14.4. Identifiers. Request keys, uuids, session ids, agent ids and thread ids are replaced in `--json` and `evidence` by `req_<8 hex>`, `chain_<N>`, `sess_<N>` where hex is the first 8 hex characters of `sha256(salt || id)` and `salt` is 16 random bytes generated per run and never stored. `<N>` follows first appearance in a deterministic order. A `--show-ids` flag prints raw local ids to the terminal only. It is rejected when combined with `--json` or `evidence`.

R14.5. Schema `cachewhy/1`, top-level fields:

| Field | Type |
|---|---|
| `schema` | const `"cachewhy/1"` |
| `generated_at` | ISO instant |
| `tool_version` | semver string |
| `spec` | const `"spec-1"` |
| `table_version` | string matching `^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]+)?$` |
| `window` | `{since: ISO, until: ISO}` |
| `headline_status` | enum `ok`, `withheld` |
| `withheld_reason` | enum or null (R17.3) |
| `assumptions` | array of enum codes |
| `coverage` | object of non-negative integers named in section 17 |
| `totals` | array of per-provider objects: provider enum, request counts by kind, token sums by bucket as decimal strings (BigInt, R2.16), `usd` integer picodollars as decimal string or null, `tokens_unpriced` as a decimal string |
| `events` | array of event objects |
| `boundaries` | array of boundary objects |

Event object: `id` (`e<N>`), `provider`, `kind`, `chain`, `model`, `t` (ISO), `gap_min_s`, `gap_max_s` (integers or null), `k_prev`, `r`, `w`, `u`, `d` (these five as decimal strings, BigInt), `reuse_ratio` (number, 3 decimals, display only, no decision reads it, R2.16), `outcome` (enum), `abstain_code` (enum or null), `ttl_class` (enum), `candidates` (array of `{cause, level, confidence, signals[]}` with enum values), `primary` (cause enum or null), `diag` (`{type enum, missed_tokens_reported int or null, role const}` or null), `delta` (`{tokens_upper, tokens_upper_if_prefix_match, tokens_lower, tokens_if_unchanged, usd_hi, usd_if_unchanged_lo, usd_point, status, reasons[]}`; `tokens_upper` is `L` and `tokens_upper_if_prefix_match` is `L_pm` (R8.1), token values as decimal strings because they are BigInt; `tokens_lower` is always 0 (R8.2); `tokens_if_unchanged`, `usd_if_unchanged_lo` and `usd_point` are conditional and null when R8.2 gives null; money as decimal strings or null), `linkage` (enum), `model_source` (enum from R2.10 or `claude_explicit`), `gap_basis` (enum `parent_record`, `input_record`, `none`). Boundary objects carry the same identifying fields, the cache read `r` of `C` as a decimal string, and a `type` enum (`model_switch`, `context_reset`, `subagent_cold_start`, `fork_inherit`, `first_observation`), which is the complete set chosen by the table in R11.8.

R14.6. Errors and debug. Error and warning messages are built from enum codes, integers (counts, line numbers) and opaque file labels (`file_<N>`). They MUST NOT contain raw lines, raw JSON error messages (R1.3), file paths, directory names, raw ids or exception text from I/O or parsing. The `doctor` command prints coverage and drift counters only. A debug flag, if present, follows the same rule. Terminal output passes through a sanitizer that removes C0 and C1 control characters, ESC sequences and bidirectional control characters from any string that is not an enum or tool-generated id.

R14.7. Canary tests. The fixture generator plants secrets of the form `CANARY_<random hex 16>` in: message text, tool input and output, `cwd`, branch name, slug, title, agent description, `meta.json` description and worktree path, file and directory names, model field values, `version` values, unknown extra keys in `usage`, unknown record types, truncated JSON lines whose truncated part contains a canary, and values of the fields that R1.2 drops. The suite runs every command (`default`, `session`, `evidence`, `doctor`, `pricing`, `--demo`, `--json`, errors forced by corrupted input) and asserts that stdout, stderr, the written JSON files and the evidence files contain no canary, nor its lowercase, uppercase, base64, URL-encoded or any substring of 8 or more characters. The same scan runs on the `npm pack` tarball and on the repository tree in CI.

R14.8. Package audit. `npm pack --dry-run --json` output is compared with an allowlist of files (`dist/`, `README.md`, `LICENSE`, `package.json`, the demo data directory). Any other path fails. `dependencies` MUST be empty. The repository contains only synthetic fixtures or anonymized experiment fixtures, and CI fails if a fixture contains any key outside the schema in R1.2 or a string longer than 64 characters that is not an id or enum.

R14.9. Writes. cachewhy writes only to a path the user passed with `--out`, and never writes caches, telemetry or temp files containing log-derived data.

## 15. Release gates

### 15.1 Gates

R15.1. Gate PASS means: an audit by `gpt-6.1-sol` at high effort (backup `gpt-6-sol` high) with the audited content embedded in the prompt (sandbox locks block file reads), a verdict of PASS, zero open P0 and P1 findings, and a log entry in `docs/audit-log.md` with date, audited commit sha, sha256 of the embedded content and the verdict. Accounting and privacy findings cannot be waived. Each gate requires the previous gate PASS.

G0 has two parts and passes only when both pass. An audit that did not receive the content of a part cannot pass it, and the log entry states which parts were embedded.

* G0-spec: this specification.
* G0-pricing: the full versioned content of `pricing/table.json` (prices as decimal strings, `modifiers`, `service_tier` entries, per-model minimum cacheable lengths `M`, long-context and tier entries, `source_url`, `verified_at`), the source citations for every row, and the pricing rules R3.1 to R3.9 and R7.2. The audit checks each price, modifier rule and minimum length against its source, and checks that the R3.2 ratio test and the R3.7 expectation list hold for the table. `pricing/table.json` is added at D1; until it exists, G0-pricing is `not run` and G0 cannot PASS.

| Gate | Scope |
|---|---|
| G0 | G0-spec and G0-pricing, as defined above |
| G1 | Parser, normalization, dedup, graph, linkage, metamorphic tests (R4.10), synthetic exact-equality tests, coverage output |
| G2 | Independent recompute (R13.1 to R13.3), ccusage and Codex reconciliation (R13.4 to R13.6), event detector reimplementation agreement on the corpus snapshot |
| G3 | Accuracy bounds of R12.7, coverage report, hand check of top events |
| G4 | Privacy and release: canary suite, no-network suite, package audit, OS and Node matrix green, provenance dry run, registry smoke test plan |

### 15.2 What each public step requires

R15.2. Publication steps and their required gates:

| Step | Required | Extra conditions |
|---|---|---|
| npm name reservation with tag `next` | G0 PASS | package contains only `package.json`, `README.md`, `LICENSE`; `npm pack --dry-run` file list audited; version `0.0.0-next.0`; published with `--tag next` and never tagged `latest`; this is the only allowed manual publish |
| Public repository | G0, G1, G2, G3, G4 all PASS | CI green on three operating systems |
| npm `latest` publish | G0 to G4 PASS | publish only from CI on a version tag, with provenance; first to tag `next`, registry smoke test in a clean environment, then `npm dist-tag add` to `latest` |
| Show HN and other announcements | G0 to G4 PASS, `latest` published and smoke tested | `docs/accuracy.md` numbers identical to the G3 report; headline claims in the post are traceable to evidence-level counts |

R15.3. Scope narrowing. If a provider, cause class, command or claim is removed to pass a gate, the narrowed claim list (README claims, CLI help, `docs/accuracy.md` classes) is audited again before the next step in R15.2. Any accuracy patch after launch goes through the same audit.

R15.4. Provenance. Releases are built by a CI workflow triggered by a version tag from `main`, using npm trusted publishing (OIDC, `id-token: write`, no long-lived token in the repo), `npm publish --provenance`. After publish, CI runs `npm audit signatures` and checks the attestation exists in the registry for the published version. A release without verified provenance is withdrawn.

R15.5. Runtime matrix. Node 22 and 24, Windows, macOS and Linux. Zstd support in `node:zlib` is verified at G1 and the minimum Node 22 minor is recorded in `package.json` `engines`.

R15.6. License: MIT, copyright 2026 Muhammet Can Erganis, file `LICENSE`.

R15.7. Version matrix behavior. For a log whose product version is not in section 0.2 with full support, the dedup, copy-selection and ownership semantics of R4 are not verified for that version, so no accounting is derived from it. cachewhy reads such records only to count them: `requests_unverified_version` (distinct keys, counted without selecting copies), `lines_unverified_version`, and the list of version strings in the bounded form of R1.2 with counts. They add nothing to totals, dollars, events, boundaries, lineage or the headline denominators. The report prints assumption `unverified_version`. `events` and `boundaries` contain no entry for them, and a request of an unverified version that lies between `P` and `C` of a supported pair is an excluded request (R6.2). Adding a version to the full-support table needs a synthetic fixture for it and a spec revision.

## 16. Headline format

R16.1. Template. Fields in angle brackets are computed; the denominator is always printed.

```
<since> to <until> (UTC). <N> responses: <n_main> main, <n_sub> subagent, <n_wf> workflow, <n_cx> Codex.
Cache read: <p>% of <T> input tokens (Claude: input + cache read + cache write; Codex: input).
List-price equivalent: $<A> at table <table_version> over <N_priced> of <N> responses; <U>% of tokens unpriced; output excluded for <V> responses with unknown output.
Cache boundaries: <b1> model switches, <b2> context resets, <b3> cold starts, <b4> first observations, <b5> fork inheritances.
Suspected prefix rebuilds: <E> from <E_elig> eligible pairs (<E_abs> abstained, <E_grey> grey).
By evidence: <E_c> confirmed, <E_h> hypothesis (<hh> high, <hm> medium, <hl> low), <E_u> unknown.
Counterfactual delta, assumption-bound: up to $<hi> (observational bound, lower bound $0) over <E_d> events; <E_t> events tokens-only (<L_sum> tokens, sum of the unconditional upper bound L of R8.1).
If the prefix was unchanged (assumption no_marker_means_unchanged_prefix): $<clo> to $<hi> over <E_cond> of those events.
```

R16.2. The list-price-equivalent figure and the counterfactual delta are on separate lines and are never added together or summed in one number. Claude and Codex percentages are also printed per provider.

R16.3. The counts satisfy `E = E_c + E_h + E_u`, `E_h = hh + hm + hl`, `E_d + E_t = E`, and `E_cond <= E_d` (the conditional-line event count never exceeds the events with a dollar delta). A test asserts them. "Observed" appears in the event listing, not as a fourth headline category, because every event is observed by definition (counters).

R16.4. Forbidden words in headline and docs text produced by the tool: "avoidable", "saving", "saved", "wasted", "cost you", "overspend". The word "equivalent" accompanies every dollar figure.

R16.5. If `headline_status = withheld`, the headline is replaced by `Headline withheld: <reason code>`, and coverage is still printed.

## 17. Coverage and schema drift

R17.1. `coverage` counters (all integers): `files_total`, `files_unreadable`, `files_without_response_id`, `lines_total`, `lines_parse_error`, `lines_truncated_tail`, `known_type_count`, `unlisted_type_count`, `records_unkeyed`, `api_error_records`, `requests_total`, `requests_priced`, `requests_unknown_model`, `requests_unpriced_modifier`, `requests_conflict`, `responses_bucket_mismatch`, `responses_speed_assumed`, `output_unknown_requests`, `tokens_unpriced`, `tokens_in_incomplete_responses`, `replay_requests_excluded`, `replay_ownership_ambiguous`, `links_verified`, `links_directory_only`, `links_unlinked` (with reason counts), `pairs_total`, `pairs_eligible`, `pairs_abstained` (with code counts), `requests_unverified_version`, `lines_unverified_version`, `baseline_requests_loaded`, `responses_usage_range_failed`, `tokens_in_invalid_responses`, `responses_model_unverified`, `files_unassigned_stream`, `files_assigned_by_stream`, `lines_duplicate_collapsed`, `duplicate_records_collapsed`, `requests_conflict_modifier`, `pairs_gap_unknown`, `files_stream_conflict`, `streams_integrity_unverified`, `streams_ordinal_unverified`, `streams_fork_prefix_unresolved`, `fields_range_failed`.

R17.2. Coverage is printed in the main report, not only in `doctor`.

R17.3. Critical drift closes the headline (`headline_status = withheld`) when any of these holds for a provider in the window:

| Code | Condition |
|---|---|
| `drift_unmappable` | usage-bearing records that cannot be mapped to the required integer fields exceed `C10` (1 percent) of usage-bearing records |
| `drift_invariant` | responses failing R2.7 or R2.15, R2.1 mismatch or key conflicts exceed `C11` (0.5 percent) of responses |
| `drift_no_key` | `records_unkeyed` exceeds `C10` of usage-bearing records |
| `drift_no_final_marker` | for Claude: no copy in the window has `usage.speed` while more than `C28` requests exist, which suggests the final-copy marker moved |
| `drift_stream_integrity` | for Codex: files in `files_stream_conflict` plus `files_unassigned_stream` exceed `C10` of Codex files (`100 * (conflict + unassigned) > files`), or streams in `streams_ordinal_unverified` exceed `C10` of Codex streams, which suggests the identity or `ordinal` semantics moved |

When closed, accounting totals are still printed with the label `unverified`, no dollar headline is printed, and `doctor` prints the code.

R17.4. Non-critical gaps (missing optional fields, unknown optional types, unlinked agents) never close the headline but always show in coverage.

R17.5. Unlogged usage estimate. For Claude, `cost-state.modelUsage` cumulative values per model are compared with the sum of logged requests per model. The difference is printed in coverage as `unlogged_tokens_estimate` per bucket, with the label "includes helper and classifier calls and logging gaps". It is never added to totals or dollars.

## 18. Open questions

Each item has a conservative rule in the spec. Resolution requires evidence listed here.

1. Q1. Partial-only Claude requests (about 68 percent of subagent and workflow requests) have no final copy, so output tokens are unknown. Rule: output unknown, lower bound reported, dollars exclude output (R2.3). Resolve by finding where final usage is logged, or from workflow totals or `cost-state` deltas.
2. Q2. Codex `cache_write_input_tokens` is 0 in the whole corpus. Whether `input_tokens` includes writes is assumed from the official formula, not shown from data. Rule: apply `normal = in - c - cw` (R2.6), invariant `c + cw <= in`, tested on synthetic fixtures only. Resolve with a real log containing `cw > 0`.
3. Q3. Claude `thinking_tokens` may or may not be inside `output_tokens`. Rule: not added (R2.4). Resolve through ccusage reconciliation and a controlled run.
4. Q4. `prefix.json` is not shown to be per request. Rule: agent-level corroboration only (R10.6).
5. Q5. The trigger for the one forked or resumed Claude file pair is unknown (resume, fork or relocate). Rule: ownership by earliest logical stream start, ties ambiguous (R4.6, R4.11).
6. Q6. Classifier call tokens are not in transcripts, and whether `cost-state` includes them is unknown. Rule: coverage estimate only (R17.5).
7. Q7. Diagnostics are sparse (72 requests, absent on 277 of 336 recon-detected drops), `pending` was never observed, and diagnostics may be absent in some versions. Rule: absence is normal, no inference from absence (R10.1).
8. Q8. No `/clear` event was observed, so its marker is unverified. Rule: a new session file after `/clear` is a `first_observation`.
9. Q9. Codex fast or priority tier and service tier are not identified in logs. Rule: standard tier assumed and printed (R3.4).
10. Q10. The TTL of the GPT-6 family is taken from the GPT-5.6 and later documentation. Rule: `C8`, claim `expiry_compatible` only (R9.6).
11. Q11. Codex model attribution relies on the latest preceding `turn_context`. 783 turns have none of their own, and `thread_settings_applied` may change a model without a `turn_context`. Rule: `model_source` recorded (R2.10). Only `own_turn` and `carried_verified` are priced and eligible; `carried_unverified`, `inherited_prefix` and `none` are `model_unknown`, no dollars, and pairs abstain. Resolve by finding where a model change without a `turn_context` is logged, which would make more carried models verifiable.
12. Q12. `C1` to `C3` are heuristics from recon (50 percent, 20k previous context). Rule: dev-set tuning only before freeze; sensitivity at 8192 and 32768 for `C3` is reported in `docs/accuracy.md`.
13. Q13. `usage.speed` is missing on partial-only requests, so fast mode cannot be detected for them. Rule: standard assumed and counted (R3.4).
14. Q14. `inference_geo` was only ever `not_available`. The Claude `service_tier` values seen in recon are not enumerated here, and the set `standard`, `priority`, `batch` is a schema closed set with `other`. Rule: any value without a priced table entry is unpriced; batch is recognized only through `service_tier` (R3.4).
15. Q15. The meaning of Codex `comp_hash` is inferred from how it co-varies with the model. Rule: `hypothesis` low only (R11.5).
16. Q16. Request start is not logged in either product. Rule: interval gaps only (R6.4 to R6.6).
17. Q17. Node zstd support minor version, and whether npm lets a trusted publisher be configured before the first publish. Rule: verified at G1 and G4. If not possible, the reservation publish is the single manual publish (R15.2).
18. Q18. ccusage pinned version and its exact dedup rule. Resolve at D6 by running the pinned version on the frozen snapshot.
19. Q19. Whether `/compact`, adding an MCP server, and effort changes can be driven headlessly with `claude -p` for the pinned version. Rule: classes that cannot be driven are excluded from claims (R12.5).
20. Q20. Whether `thinking_dropped` input transformations or other fields could discriminate edit or prune events. Rule: not used (R11.5).
21. Q21. Whether Codex `ordinal` is monotone within a thread across continuation files. Rule: it is not assumed. Each stream is checked at run time (R4.12): ordinals must be unique and sorting by them must not decrease the timestamps. A stream that fails has carried models `carried_unverified` (R2.10), `start_lo` unknown (R6.5), compaction unbound (R11.7) and no fork prefix cut (R4.9). Resolve with fixtures of a thread spanning two files that pass and fail the check.
22. Q22. Whether any log field identifies the request that API diagnostics compared against. Rule: none assumed, diagnostics never `confirmed` (R10.4, R10.5).
23. Q23. Whether the timestamp of the record a Claude request is built on always precedes the request send time. Rule: used as a causal bound only under assumption `parent_record_precedes_request` and validated per provider by R6.8; otherwise gap bounds are unknown.
24. Q24. Whether a copied parent `session_meta` of a Codex fork can be told from the own one by any field. Rule: only through the in-file `forked_from_id` reference (R4.11); a file that cannot be resolved to one stream identity makes its streams `integrity_unverified` and they abstain. Resolve by finding a field that marks a copied record.
25. Q25. Whether the range of Claude TTL options is only 5m and 1h. Rule: assumed and printed as `claude_ttl_options_5m_1h` (R9.4); the exclusion statement relies on `T_lo = C6`, so a shorter option would void exclusions and a longer one would void compatibility claims.

## 19. Resolution map for the G0 audit findings

| G0 finding | Resolved in |
|---|---|
| P0 Codex cache write double pricing | R2.6, R3.6, R2.7 |
| P1 Codex output semantics, missing response_id, missing modifiers | R2.8, R2.9, R2.12, R2.13, R3.4, R17.1 |
| P1 No decision rule for suspected rebuild | R7.2 to R7.8 |
| P1 `L_bucket` unmeasurable, growth counted as loss | R7.7, R8.1 to R8.8 |
| P1 Diagnostics read as confirmed cause | R10.2 to R10.7, R11.5 |
| P1 TTL: writes do not explain every read, mixed TTL, elapsed time | R9.1 to R9.8, R6.4 to R6.6 |
| P1 Dedup priority table, Codex linkage, replayed fork ownership | R4.2 to R4.9, R5.3 to R5.7 |
| P1 Experiments: no real miss, TTL setting, warm hit, negative controls | R12.1 to R12.5 |
| P1 Dev and eval sets, G3 bounds, coverage | R12.6 to R12.10, section 0.3 |
| P1 Reconciliation: shared parser errors, `/usage` scope | R13.1 to R13.8 |
| P1 Privacy: allowlist, error paths, canaries | R14.1 to R14.9, R1.1 to R1.4 |
| P1 Release gates, version matrix, provenance | R15.1 to R15.7 |
| P2 Headline denominators, evidence levels, dollar meaning | R16.1 to R16.5 |

## 20. Resolution map for G0 spec audit round 1

| Round 1 finding | Resolved in |
|---|---|
| P1 Counter range, negative values | R2.15, R2.7, R2.12, R17.1, R17.3 |
| P1 `speed`, `inference_geo`, `service_tier` typing, copy conflicts, tier pricing | R1.2, R2.5, R3.4, R4.2 |
| P1 Codex model continuity | R2.10, R7.2 E2, R3.7, Q11 |
| P1 Allowlist gaps, workflow link without text | R1.2, R5.4, R6.5, R11.5 |
| P1 File splitting, ownership, model context | R4.6, R4.9, R4.10, R4.11, R2.10 |
| P1 Replay and fork contradictions | R4.7, R4.8, R5.7, R6.2, R7.2 E1, R7.4, R11.2, R11.5, R11.8 |
| P1 Start bound, TTL from p90 and fixed lag | R6.4 to R6.8, R9.4, section 0.3 (C4, C5 retired, C34) |
| P1 Diagnostics read as confirmed | R10.4, R10.5, R11.1, R11.5, R12.10, Q22 |
| P1 Lower bound from marker absence | R8.2, R8.3, R8.6, R8.8, R14.5, R16.1 |
| P1 Intervention label without effect | R12.1, R12.3, R12.5, section 0.3 (C21 to C23) |
| P1 Precision denominator, `n`, natural diagnostics | R12.7, R12.8, R12.10 |
| P1 Unsupported versions | R15.7, R0.2 |
| P1 G0 without the pricing table | R15.1, R7.2, R3.7 |
| P2 Metamorphic equality | R4.10, R4.11, R14.4 |
| P2 Threshold table and change procedure | section 0.3 (C21 to C34), section 0.4 |

## 21. Resolution map for G0 spec audit round 2

| Round 2 finding | Resolved in |
|---|---|
| P1 Intermediate sums beyond the safe integer range | R2.15, R2.16, R7.1, R7.5, R12.3, section 0.3 (rational constants), R14.5 |
| P1 Codex stream identity and fork detection depend on record or file order | R4.9, R4.10, R4.11, R5.6, R2.10, R17.1, R17.3, Q24 |
| P1 First own fork response removed from pricing | R4.8, R5.8, R8.7, R11.6 |
| P1 Unknown TTL and unsafe exclusion | R9.4, R9.6, R6.6, Q25 |
| P1 Shortfall `D` is not an unconditional bound | R8.1 to R8.3, R8.5, R8.6, R14.5, R16.1 |
| P1 Negative control escapes through `primary = null` | R12.7 |
| P1 Unverified ordinals still bound times and bind compaction | R4.12, R2.10, R4.9, R6.5, R11.7, R17.1, Q21 |
| P1 Freeze scope misses result-affecting rules | section 0.4 |
| P2 Boundary decision for the first subagent response, `after_reset` missing from the schema | R11.5, R11.6, R11.8, R14.5, R5.7 |
