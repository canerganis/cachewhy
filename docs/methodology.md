# cachewhy methodology (binding spec)

Status: draft for gate G0. Spec version `spec-1`, revision 11 (after G0 spec audit round 10, see `docs/audit-log.md`). Date: 2026-10-09.

This document is the binding technical specification. An implementer follows it. An auditor checks the implementation against it. Every rule is written so it can be tested. Where the recon could not settle a fact, the rule is conservative abstention and the fact is listed in section 18.

Conventions:

* MUST, MUST NOT and MAY are used in the RFC 2119 sense.
* Rule ids look like `R7.3`. Tests, audit findings and code comments cite rule ids.
* Constants are named `C1` to `C36` in section 0.3. A constant changes only through the procedure in section 0.4.
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

Runtime: Node 22 and 24, MIT license, zero runtime dependencies. Reading archived Codex `.zst` files needs the zstd decoder in `node:zlib`. If the running Node lacks it, archived files are counted in `coverage.files_unreadable`, never skipped silently (R17.1), and taint every Codex chain (R0.9).

### 0.3 Constants (pre-registered)

All numeric decision thresholds live here. A number that changes a classification, an eligibility outcome, a price, an exclusion or an evaluation verdict and is not in this table is a defect in the spec. Scenario parameters (wait times, filler size) live in R12.5 and R12.2 and are frozen like constants. Per-model facts (prices, modifier multipliers, minimum cacheable lengths) live in `pricing/table.json` and are audited under G0-pricing (R15.1). Values marked "dev-tuned" were chosen from recon heuristics and MAY be adjusted using the development set only (section 12) before the freeze in 0.4.

| Id | Name | Value | Used in | Origin |
|---|---|---|---|---|
| C1 | `TAU_SUSPECT` | 1/2 (0.5) | R7.5 | dev-tuned, recon heuristic |
| C2 | `TAU_NORMAL` | 9/10 (0.9) | R7.5 | dev-tuned |
| C3 | `FLOOR_PREV` | 16384 tokens | R7.2 | dev-tuned, recon used 20k |
| C4 | retired | none | none | `U_ASM` (15 s) was a p90 of an observed lag, not a start bound. Removed in revision 2 (R6.4). Id kept so citations stay stable. |
| C5 | retired | none | none | `FALLBACK_START_LAG` (120 s) was a fixed guess. Removed in revision 2 (R6.4). |
| C6 | `TTL_5M` | 300 s | R9.4 | official docs |
| C7 | `TTL_1H` | 3600 s | R9.4 | official docs |
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
| C25 | `CODEX_LONG_CTX` | 272000 input tokens | R3.4, R3.10 | official docs |
| C26 | `HAIKU_TIER_SPLIT` | 100000 total input tokens | R3.4 | official docs |
| C27 | `COMPACT_WALK_HOPS` | 200 | R11.7 | fixed. A walk that reaches this limit is `unknown`, never "absent" |
| C28 | `NO_FINAL_MARKER_MIN` | 100 requests | R17.3 | fixed |
| C29 | retired | none | none | `FAST_PREFILTER_DAYS` served the `--fast` mtime prefilter, which could skip a file holding a request between `P` and `C`. Removed in revision 11 (R5.9). |
| C30 | `FILLER_MULT` | 3 times the model minimum cacheable length | R12.2 | fixed |
| C31 | `HANDCHECK_TOP` | 20 events | R12.9 | fixed |
| C32 | `GEO_US_MULT` | 11/10 | R3.4, R3.8 | official docs |
| C33 | `RECON_UNEXPLAINED_TOL` | 0.5 percent of tokens | R13.4 | fixed |
| C34 | `START_BOUND_VIOLATIONS_MAX` | 0 runs | R6.8 | fixed |
| C35 | `LIVE_WINDOW` | 600 s | R0.9 | fixed. A file with an unparseable line modified at most this long before the run start belongs to a session being written |
| C36 | `TAINT_WARN_SHARE` | 3/10 | R16.1 | fixed. Share of families or of tokens in tainted chains above which the headline leads with a warning |

Every constant that is a percentage or a ratio is the exact rational given here, and decisions use the rational, never a decimal rendering: `C1 = 1/2`, `C2 = 9/10`, `C10 = 1/100`, `C11 = 1/200`, `C17 = 1/100`, `C18 = 1/50`, `C19 = 1/200`, `C20 = 1/100` (percentage point), `C21 = 1/2`, `C22 = 9/10`, `C23 = 1/5`, `C24 = 1/10`, `C33 = 1/200`, `C36 = 3/10`. `C13`, `C14` and `C16` are bounds on Wilson intervals of run counts and are the only constants compared as floating point numbers.

### 0.4 Freeze procedure

1. Constants, scenario parameters and rules in this file are frozen by the git tag `spec-freeze` placed before any held-out evaluation run is generated (R12.7).
2. A result-affecting rule is any rule, table, enum or constant that can change accounting (tokens, dollars, coverage counts used in a claim), eligibility, abstention, boundary or cause classification, evaluation scoring, headline status or a claim made in a report or in the README. Explicitly this is: section 0.1 (claims), section 0.2 (the supported version matrix and the support levels), section 0.3, section 0.5 (R0.9), sections 1 to 11, all of section 12 and section 13, the schema of R14.5, R15.3 and R15.7 (version matrix behavior and narrowed claims), sections 16 and 17 (headline and drift rules), and every entry of `pricing/table.json`. Only the items listed as exempt in item 3 are not result-affecting. After the tag, a change to a result-affecting rule, including adding a version to the full-support table, demoting one, or changing how an unsupported version is handled, requires an entry in `docs/audit-log.md`, a new tag `spec-freeze-N`, and a new held-out evaluation set (for an added version, held-out runs on that exact version). Evaluation data that influenced a change is burned and MUST NOT be reused as evaluation data.
3. A change is exempt from item 2 only if it is wording or layout and a test shows that the semantic output (R4.10) on the frozen synthetic fixtures and on the corpus snapshot is identical before and after. The test result is recorded in the audit log entry for the change. Process rules that do not feed any output (the order of publication steps in R15.2, the CI provenance text in R15.4 and the license in R15.6) are also exempt, but still need an audit log entry.
4. Dev-tuning of `C1` to `C3` before the tag uses the development set only. Tuning after the tag is a change under item 2.

### 0.5 Global integrity abstention

R0.9. Global integrity abstention. This rule is evaluated before every rule that produces a verified model (R2.10), a dollar figure (sections 3 and 8), a pair verdict, an event or a boundary (sections 7 and 11), a cause, a TTL statement (section 9) or a link used for a boundary (section 5), and it takes precedence over all of them. Reason: every earlier finding in which an anomaly still reached a number had the same shape. The anomaly was judged locally (one pair, one file, one turn), while the number rested on a wider context (the order of the stream, the guard set of a model, the chain TTL set, the replay owner). This rule judges the wider context instead: a number is produced only if every record that could belong to its context was read, parsed, attributed to a chain and verified. Abstaining costs coverage, never correctness.

Family. Two chains (R5.1) are linked when (i) they share a root session: Claude the `sessionId` of their records, Codex any `session_id` carried by a `session_meta` whose `id` is the chain's thread or by a `token_usage_record` of the chain; (ii) a `session_meta` whose `id` is one of them names the other as `forked_from_id` or as `source.subagent.thread_spawn.parent_thread_id`; or (iii) they hold copies of the same request key (R4.1; Claude replays, R4.6). The family of a chain is its connected component under these links. A chain of an unverified version (R15.7) is a chain for this purpose. Families are computed from every parsed record of the scan, whatever its version, file or position, so they do not depend on file boundaries, file order or line order.

Named chains. A file `F` names, for Claude, the chain of every parsed record of `F` that has a string `sessionId`, and for Codex, every `id` of a `session_meta` in `F` (own or copied) and every `thread_id` of a `token_usage_record` in `F`.

Live families. A session that is being written usually ends in a partial line, which would taint it on every scan. A file `F` is live iff it holds a line that fails to parse (R1.3, a truncated tail or any other line) and its modification time is at most `C35` before the run start. Every family that contains a chain named by a live file is live. A live family is removed from the analysis entirely: its responses add nothing to totals, dollars, events, boundaries or headline denominators, and it is counted in `coverage.families_live_skipped`, `responses_live_skipped` and `tokens_live_skipped`, with assumption `live_session_skipped` printed. Its records are still read for the record-set relations below, which can only withdraw output. The unparseable lines of a live file give no `unparsed_line` taint; a live file that names no chain is not live and taints the provider as below. This is the only use of a file modification time in this spec (R5.9). The run start is read once per run, and tests inject it, together with file modification times, through test-only function parameters, never an environment variable or CLI flag. Liveness is a file property that line shuffles, line duplication and key order do not change, and a split gives both halves the modification time of the split file (R4.10).

Taint. A chain is tainted iff at least one reason below applies to it. A reason taints every chain in the family of each chain it names, and a reason that names no chain taints every chain of the provider. The provider of a file is the provider of the scan root it was found under. The reasons are a closed enum:

| Reason | Trigger | Chains it names |
|---|---|---|
| `stream_unresolved` | a Codex file with `I(F)` of two or more ids, or two own `session_meta` records with the same `id` that differ in `session_id`, `forked_from_id` or `subagent_history_start_ordinal` (R4.11) | the ids of `I(F)`; that id |
| `copy_exposed` | a copy-exposed Codex file (R4.13) | the chains named by `F` |
| `turn_model_conflicted` | a turn id `T` whose model set `TM(T)` has two or more members (R2.17 (d)) | the chains named by every file that holds a `turn_context` or a `token_usage_record` with turn id `T` |
| `ordinal_unverified` | a Codex stream that fails R4.12 | that stream |
| `fork_prefix_unresolved` | a Codex fork whose prefix cannot be cut (R4.9) | that stream |
| `request_anomaly` | a request that is conflicted (R4.1 `key_conflict`, every `conflict_*` code of R4.2 except `conflict_diagnostics`, R4.4), incomplete (R2.12), invariant-failed (R2.7), range-failed (R2.15), `bucket_mismatch` (R2.1) or unkeyed with a known chain (R2.13) | every chain that holds a copy or an occurrence of it |
| `ownership_ambiguous` | a replayed request whose owner is a tie (R4.6) | every chain that holds a copy of it |
| `version_unverified` | a request or stream of a version without full support (R15.7) | the chain of that request; that stream |
| `unparsed_line` | a line of a file `F` that is not live fails to parse, a truncated tail included (R1.3) | the chains named by `F` |
| `unlogged_usage` | a Codex file that holds a `token_count` event and no `token_usage_record` (R2.9) | the chains named by `F` |
| `unattributed_record` | a record of a type that carries a chain key (Claude `assistant`, `user`, `system`, `attachment`: `sessionId`; Codex `session_meta`: `id`; `token_usage_record`: `thread_id`) whose key is missing or not a string, or a non-empty Codex file whose identity set `I(F)` is empty (R4.11) | none |
| `file_unreadable` | a file under a scan root that cannot be read or decompressed (R17.1) | none |

Effect on a tainted chain:

1. Accounting only. Each unique response of the chain is accounted by sections 2 to 4 and R15.7 exactly as in an untainted chain: its tokens enter the totals and buckets, and a response that another rule excludes from totals stays excluded. Claude responses keep the model id of their record for token breakdowns; it is used for no price and no pair decision.
2. No verified model and no dollars. `model_source` is `chain_tainted` (R2.10), every response is unpriced with reason `chain_tainted` and counted in `requests_unpriced_tainted` instead of any other unpriced reason, and its tokens count in `tokens_unpriced` (R3.9).
3. No pair verdict, event, boundary, cause, TTL statement or rebuild delta. Every request of the chain abstains at the gate E0 of R7.2 with code `chain_tainted`, before any boundary is chosen.
4. No use by another chain. No rule reads a tainted chain to verify, price or order anything of another chain. Its records are still read as taint sources and for the record-set relations (families, `FS` of R4.13, `TM(T)` of R2.17 (d)), which can only withdraw output. A link (R5.3, R5.6) is a structural fact computed for every chain and counted in `links_*`; it decides a boundary only in an untainted chain, and a parent and its linked children are in one family, so an untainted chain never rests on a tainted parent.

Coverage: `chains_total`, `chains_tainted` with a count per reason (a chain carrying several reasons counts once in the total and once under each of its reasons), `families_total`, `families_tainted`, `responses_in_tainted_chains`, `tokens_in_tainted_chains` and `requests_unpriced_tainted` (R17.1). Live families (above) are in none of these and are counted only in their own counters. The headline states the tainted share and leads with a warning when it exceeds `C36` (R16.1).

Split and order behavior (R4.10, R17.7). Every trigger is either a property of the record set or a file condition that a split at a line boundary can create but not remove, as long as the split is not dissolving (R4.10), and the family relation is a property of the record set. So line shuffles, file shuffles, line duplication and key order change no taint, and a non-dissolving split can only add tainted chains, never remove one. The output of an untainted chain depends only on its own records, the files assigned to it (R4.11) and record-set relations, so a chain that stays untainted after a split keeps exactly its unsplit output.

Required fixtures (each also shuffled, line-duplicated and split at every line boundary, R4.10): (1) the round 10 counterexample: Codex thread `X` with a supported file holding `P` (`in = 30000`, `c = 20000`) and `C` (`in = 60000`, `c = 0`), and a file of CLI 0.159.0 holding `Q` (`in = 60000`, `c = 60000`) between them in time, in three variants: the 0.159.0 file has `session_meta(X)` (then `X` is of an unverified version, R15.7, and has no accounting and no event); it has `session_meta(Y)` with the same `session_id` and a `token_usage_record` without a `thread_id` (`unattributed_record`: every Codex chain is tainted, `P` and `C` keep their tokens, no event); it has `session_meta(Y)` with readable ids (the family of `X` and `Y` is tainted by `version_unverified`, no event). In no variant is the event with `L = 30000` produced. (2) A Claude session whose main chain has requests of 2.1.293, then of an unlisted version, then of 2.1.293 again: every chain of the session is tainted, the tokens of the supported requests are in the totals, no event, boundary or dollar. (3) A parse error line, and separately a truncated tail, in one subagent file: every chain of that session is tainted and a second session of the scan is not. (4) An unreadable archived Codex file: every Codex chain is tainted, no Claude chain is, and token totals are unchanged. (5) A Codex thread with `P` and `C` in one file and a second file of the same thread holding only `session_meta` and `token_count` events: tainted `unlogged_usage`, no event. (6) A clean family and a tainted family in one scan: the clean family's events, models and dollars equal those of a scan that holds only the clean family.

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
| `token_usage_record` | `response_id`, `thread_id`, `session_id`, `turn_id`, `usage.*` (six integers). `thread_token_usage.total_tokens` (one integer, called `thread_total`) is read only for R13.6; `turn_token_usage` and the other members of `thread_token_usage` are read only for R13.6. |
| `event_msg` | `payload.type` as an enum (`token_count`, `thread_settings_applied`, else `other`; `task_started` is `other` since revision 5) and the envelope `ordinal` and `timestamp`. `token_count` payloads are read only to count events that lack a matching `token_usage_record` (R2.9). `thread_settings_applied` is read as a presence marker for R2.10. No other payload field is kept. |
| `compacted` | `compaction_response_id`, `window_id`, `window_number`, and whether `latest_token_usage_record` is null. `message`, `replacement_history`, `retained_context` dropped. |
| `response_item` | No field is kept. The record is parsed, counted as a known type (R1.4) and dropped. Revision 4 read its payload type and role for the Codex start bound; revision 5 does not (R6.5: a Codex input record cannot be tied to a specific request), so nothing is retained and no `response_item` takes part in any ordinal decision (R4.12). |

R1.3. Parse failures. A line that fails `JSON.parse` increments `coverage.lines_parse_error` and is dropped. The exception message MUST NOT be stored or printed, because V8 syntax errors can quote input text (R14.6). A final line without a terminating newline that fails to parse is counted separately in `coverage.lines_truncated_tail`. Both kinds taint the chains named by their file (R0.9 `unparsed_line`), because the lost line can be a request of those chains. BOM and CRLF are tolerated. `lines_parse_error` and `lines_truncated_tail` are physical counters (R17.6): a line that cannot be parsed has no retained projection, so it cannot be compared with another line (comparing or hashing its text would break R1.1), and a duplicated unparseable line is counted again by design. No drift code (R17.3) reads them.

R1.4. Unknown record types are counted by a bounded enum (`known_type_count`, `unlisted_type_count`). The raw type string is never stored. Both are physical counters (R17.6): they count parsed lines, so a duplicated line adds to them. The logical record counts (R17.6) are taken after collapsing equal records and do not change under duplication.

## 2. Provider normalization

### 2.1 Claude

Let `i = input_tokens`, `r = cache_read_input_tokens`, `w5 = cache_creation.ephemeral_5m_input_tokens`, `w1 = cache_creation.ephemeral_1h_input_tokens`, `wt = cache_creation_input_tokens`, `o = output_tokens`.

R2.1. Write tokens. If the `cache_creation` object exists, `w = w5 + w1`. If it is absent, `w = wt` and the write is bucketed `w_unknown_ttl`. If the object exists and `wt != w5 + w1`, the response is flagged `bucket_mismatch` (recon saw one such main request: `wt` was 0 and `w1` was 1796). The bucket sum is used for `w`, the response is counted in `coverage.responses_bucket_mismatch`, and its chain is tainted (R0.9 `request_anomaly`), so it yields tokens only.

R2.2. Total input: `total_input = i + r + w`, computed as BigInt (R2.16). Cache read share: `r / total_input`, computed as a BigInt quotient and rounded half up to one decimal of a percent for display only.

R2.3. Output. `o` is taken only from a final copy (R4.2). A request with no final copy has `output = unknown` and `output_lower_bound = max(o over copies)`. Recon: about 68 percent of subagent and workflow requests have no final copy. A request with no final copy is also not priced at all: speed, geo and tier are read only from a final copy, so its price row is unverified (R3.12), and it is tokens-only. The headline count of responses with unknown output (R16.1) therefore covers only responses that have a final copy and still lack a usable output (`conflict_output`, `conflict_iterations`). Rebuild deltas (section 8) do not depend on output, but they do depend on the price row of `P` and `C` (R8.4).

R2.4. `output_tokens_details.thinking_tokens` is informational and is never added to `o`. Whether it is a subset of `o` is an open question (section 18, Q3).

R2.5. `service_tier`, `inference_geo`, `speed` are enum-valued pricing modifiers (R1.2), never counters. Their selection across copies is in R4.2 and their pricing effect is in R3.4.

### 2.2 Codex

Let `in = usage.input_tokens`, `c = usage.cached_input_tokens`, `cw = usage.cache_write_input_tokens`, `out = usage.output_tokens`, `rs = usage.reasoning_output_tokens`.

R2.6. Input semantics. `in` includes `c` (recon: `c <= in` in all 14,897 records). It is assumed to include `cw` (recon: `cw` is 0 in every record, so this cannot be shown from data; the assumption follows the official cost formula and is flagged in section 18, Q2). Normal input: `normal = in - c - cw`.

R2.7. Validity invariants, checked per response, after the range check of R2.15 has passed for every counter: `c + cw <= in`, `rs <= out`, `total_tokens == in + out`. A response failing any invariant is flagged `usage_invariant_failed`, taints its chain (R0.9 `request_anomaly`) and counts toward `C11`. Its tokens are reported only in `coverage.tokens_in_invalid_responses`, never in totals.

R2.8. Output semantics. `out` includes `rs` (recon: `rs <= out` always and `total == in + out` when `rs > 0`). Cost uses `out` only. `rs` MUST NOT be added again. If a future fixture shows `total_tokens == in + out + rs`, invariant R2.7 fires and the headline closes under R17.3 until the spec is revised.

R2.9. Accounting source. The only accounting source is `token_usage_record.usage`, keyed by `response_id`. `event_msg/token_count` is never summed (recon: re-emissions and cumulative totals make it unsafe). A file that contains `token_count` events but zero `token_usage_record` records (recon: 39 files from one originator) is counted in `coverage.files_without_response_id` (a physical file counter, R17.6) and its `token_count` events in `coverage.token_count_events_without_response_id` (a physical line counter), and contributes no tokens or dollars. Such a file also taints the chains it names (R0.9 `unlogged_usage`), because its responses can belong to a thread whose other files are in the scan, and a request missing between `P` and `C` would make the pair wrong. The test is made per physical file, so splitting a file that holds both kinds can create a half that holds only `token_count` events: that half is counted and taints the chains it names. This split effect is stated in R17.6 and R17.7 and stored per position in the fixtures of R4.10; it changes no token total and only withdraws output. Cumulative fields `turn_token_usage` and `thread_token_usage` are never summed.

R2.10. Model attribution. `token_usage_record` has no model field. This rule runs only for a stream that is not tainted (R0.9); every response of a tainted chain has `model_source = chain_tainted`. In an untainted stream every ordinal-decision record has a verified ordinal (R4.12), so "before", "between", "earliest" and "earlier" below are taken in ordinal order. The `turn_context` records considered are those of the guard context set `G(S)` of the stream (R2.17 (c)). Candidate model: for `own_turn` and `own_turn_unsettled`, the model of the contexts of the record's own turn (R2.17 (a)); for every other row, the latest context before the record. The latest context is never taken as the context of an overlapping request (R2.17). `model_source`:

| Value | Condition | Model verified? |
|---|---|---|
| `own_turn` | a context of `G(S)` has `turn_id` equal to the record's `turn_id` (an id equality), every context of `G(S)` with that turn id carries one model (R2.17 (a)), and no `event_msg` of payload type `thread_settings_applied` of the stream lies between the earliest of them and the record | yes |
| `own_turn_unsettled` | the same id equality, but such a marker lies in between, or the contexts of the turn carry two or more models. A later context of the same turn never repairs this row, because the log does not show which context the response was generated with (R2.17) | no |
| `carried_verified` | the context is of an earlier turn of this thread, lies at or after `subagent_history_start_ordinal` (or the thread is not a fork, R4.9), no marker lies between it and the record, and the guard of R2.17 (b) holds (one model over `G(S)` and no marker anywhere in the stream) | yes |
| `carried_unverified` | as `carried_verified`, but a marker lies in between or R2.17 (b) fails | no |
| `inherited_prefix` | the context lies before `subagent_history_start_ordinal` (a copied prefix of another thread) | no |
| `chain_tainted` | the chain is tainted (R0.9). Overrides every other row | no |
| `none` | no context precedes | no |

The rows `prefix_exposed` and `stream_unverified` of revision 10 are removed: both are subsumed by `chain_tainted`, because a copy-exposed file taints the family of the parent and of every fork of it, and a stream conflict, a divergent `session_meta` or a turn model conflict taints the family of every chain it names (R0.9).

A settings change inside a turn is treated like one across turns: the old model is never carried over a marker, whatever the `turn_id` says, and a second model inside one turn leaves every response of that turn unverified. Required fixtures: a stream `turn_context(A, turn T)`, `thread_settings_applied`, `token_usage_record(turn T)` (`own_turn_unsettled`, no dollars, pairs abstain `model_unknown`), the same stream with a second `turn_context(B, turn T)` after the marker (`TM(T) = {A, B}`, tainted, R2.17 (d)), the first stream with its ordinals removed (tainted `ordinal_unverified`, R4.12), and the overlap fixtures of R2.17.

A response whose model is not verified has `model = model_unknown`: its tokens are reported, no dollars are produced (`unpriced_model`), and every pair that contains it abstains `model_unknown` (R7.2 E2). Dollars and events are produced only for verified models. A response with `model_unknown` takes part in no pricing decision of any other response: R3.10 decides each response on its own attribution and its own `in`, so an unverified neighbour cannot change a price. The share of responses with an unverified model is printed in coverage (`responses_model_unverified`, tainted chains included).

R2.11. Cache write TTL class for Codex is not reported. Write tokens are bucketed `w_openai`.

### 2.3 Missing and unknown data

R2.12. A missing or non-integer usage field is never treated as 0. The response is `usage_incomplete`. Its present integer fields that pass R2.15 are still reported as tokens in `coverage.tokens_in_incomplete_responses`, it yields no dollars, and its chain is tainted (R0.9 `request_anomaly`). Exception: the `cache_creation` sub-object being absent follows R2.1.

R2.15. Counter range. Every usage counter used by this spec (all fields of the R1.2 counter row, and for Codex the six `usage` integers) MUST be an integer with `0 <= value <= Number.MAX_SAFE_INTEGER`, checked on the parsed value before any arithmetic. A negative, fractional, non-finite or unsafe value makes the response `usage_range_failed`. A response with `usage_range_failed` is removed from accounting entirely (it adds nothing to totals or dollars) and taints its chain (R0.9 `request_anomaly`). It counts toward `C11` and in `coverage.responses_usage_range_failed`. Its raw values are not stored. Any other token integer retained by R1.2 (`preTokens`, `postTokens`, `cache_missed_input_tokens`, `modelUsage` members) is range checked the same way; a failing value is treated as absent for its own purpose, does not fail a response, and is counted in `coverage.fields_range_failed`.

R2.16. Arithmetic on counters. Immediately after the range check of R2.15 passes, every counter is converted to BigInt, and from then on no `Number` arithmetic touches a token quantity. This covers single counters and every intermediate quantity: `i + r + w`, `r + w`, `in - c - cw`, `c + cw`, `K`, `ctx`, `D`, `L`, `W + U` `K_hi` (R7.1) and all sums across responses. Threshold comparisons use exact rational constants (section 0.3): for example `S >= C2` is `10 * R >= 9 * K_prev`, `S < C1` is `2 * R < K_prev`, and `tokens_unpriced > C24 * total_tokens` is `10 * tokens_unpriced > total_tokens`. Required tests: fixtures in which every counter, and then each of `i + r + w`, `r + w`, `in - c - cw` and `K_prev`, equals or exceeds `Number.MAX_SAFE_INTEGER` (the counters themselves at `MAX_SAFE_INTEGER` and at `MAX_SAFE_INTEGER + 1`, the latter failing R2.15), pairs placed exactly on, one token below and one token above each rational boundary of R7.5, and an exact equality check against `scripts/recompute` (R13.1).

R2.17. Overlap guard for Codex model binding. The log ties a `token_usage_record` to a context only through the turn id of the record and through record order, and the true start of a request is unknown (R6.5). Requests of one thread can overlap: a request can start under context A, a settings change or a newer `turn_context(B)` can be logged, and the usage record of the request can still be logged after it. The latest `turn_context` before a usage record is therefore not shown to be the context of that request, and R2.10 verifies a model only when the guards below hold. They need no start time and no constant.

* (a) `own_turn`: all certain-provenance `turn_context` records of the stream whose `turn_id` equals the record's `turn_id` carry the same normalized model (R3.3), and the settings-marker condition of R2.10 is measured from the earliest of them. A `turn_context` of another turn, logged between the own `turn_context` and the record, does not change the result, because the response is bound to its own turn by id equality, not by being the latest context.
* (b) `carried_verified`: all certain-provenance `turn_context` records of the whole stream carry the same normalized model, and the stream holds no `thread_settings_applied` marker at all. Both are set properties, independent of order and of splitting at line boundaries. A stream that ever used two models, or ever changed settings, carries no model over by position, because the position of the latest context says nothing about overlapping requests.

* (c) Guard context set. The guards of (a) and (b) are evaluated over `G(S)`: every `turn_context` record of the files assigned to the stream `S` (R4.11), including the records of the copied prefix of a fork, because the prefix is part of the context that the child inherited (a child whose inherited context carries a model different from the models of its own turns carries no model by position). A context that lies in a file not assigned to `S` cannot silently leave `G(S)` and let a model be verified: an unassigned non-empty file taints every Codex chain, and a stream-conflict or copy-exposed file taints the family of every chain it names (R0.9); a context of a turn `T` anywhere in the scan also enters `TM(T)` of (d). The remaining limit, a context of `S` inside a file that names only chains of another family, is Q33.
* (d) Turn model conflict (scan-wide). For a turn id `T`, `TM(T)` is the set of normalized models (R3.3) of every `turn_context` record with `turn_id = T` in every file of the scan, whatever its version (R15.7), its identity resolution, its assignment and its provenance. If `TM(T)` has two or more members, `T` is `turn_model_conflicted` and taints the family of every chain named by a file that holds a `turn_context` or a `token_usage_record` with turn id `T` (R0.9). `TM(T)` is a property of the record set, and a usage record of turn `T` names its own thread in whatever file it lies, so no shuffle, duplication or split can remove the conflict or move it away from the thread that used the turn. Reason: the guards (a) and (b) see only the contexts assigned to the stream, and a conflicting context of the same turn that lies in another stream's file, in an unassigned file or in a stream-conflict file would otherwise drop out of the guard when a file is split.

Required fixtures (each also shuffled and split at every line boundary, R4.10): (1) `turn_context(A, T)`, `thread_settings_applied`, `turn_context(B, T)` and a usage record of turn `T` in one file: `TM(T) = {A, B}`, the family is tainted, tokens only; (2) `turn_context(A, T1)` and `turn_context(B, T2)` logged before the usage record of `T1`, no marker: the response of `T1` is `own_turn` with model A, and with a marker after the first context of `T1` it is `own_turn_unsettled`; (3) `turn_context(A, T1)`, `turn_context(B, T2)` and a usage record of a turn `T3` that has no context: `carried_unverified`; (4) the same stream with model A in every context and no marker: `carried_verified`; (5) the two-model fork: a parent file with `turn_context(A, TP)` and a usage record of the parent, and a fork file with the copied parent `session_meta`, the copied `turn_context(A, TP)` in the prefix, the child's own `session_meta` (with `forked_from_id` and `subagent_history_start_ordinal`), an own `turn_context(B, T1)`, a usage record of `T1` (`own_turn` B), and usage records of `T2` and `T3` without an own-turn context (`G(S)` holds A and B, so `carried_unverified`), plus the variant in which the child's own context is also A (`carried_verified` A for `T2`). The fixture stores the exact result of every split position; the split whose half holds the copied parent `session_meta` and no usage record of the parent makes that half copy-exposed (R4.13), which taints the family of parent and child, so neither gains a verified model, dollar or event; (6) two files: `F1` holds `session_meta(X)`, `turn_context(A, T)` and the usage record of turn `T` of `X`; `F2` holds `session_meta(Y)`, a usage record with `thread_id = X` (turn `T2`), a `thread_settings_applied` marker and `turn_context(B, T)`. `F2` is a stream conflict and `TM(T) = {A, B}`, so the families of `X` and `Y` are tainted in the unsplit scan and at every split position of `F1` and `F2`, including the splits that give each half of `F2` one identity: tokens kept, no dollar, event or boundary; (7) the split counterexample: `F1` holds `session_meta(X)`, `turn_context(A, T)`, the usage record `P` of `X` in turn `T`, `turn_context(B, TC)` and the usage record `C` of `X` in turn `TC`; `F2` holds `session_meta(Y)`, `turn_context(B, T)`, a marker and a usage record `Q` with `thread_id = X` in turn `T2`; times give `Q < P < C`. `TM(T) = {A, B}` and `P` names `X`, so `X` is tainted at every position, among them the split after the marker that gives the halves of `F2` the identities `{Y}` and `{X}`: no verified model for `P`, `C` or `Q`, no dollar, event or boundary (in particular no `model_switch` from A to B), tokens identical; (8) the dissolving fixture without a conflicting context: `F1` holds `session_meta(X)`, `turn_context(A, T)` and the usage record `P` of `X` in turn `T`; `F2` holds `session_meta(Y)`, a marker and a usage record `Q` with `thread_id = X`. Unsplit, `F2` is a stream conflict and the families of `X` and `Y` are tainted. The split between the marker and `Q` leaves each half with one identity (a dissolving split, R4.10, Q33). The fixture stores the exact result of every position, including the split that verifies `P` as `own_turn`, and the test asserts the record-set guarantees of R4.10 for it.

R2.13. A missing `response_id` (Codex) or `requestId` (Claude, excluding `<synthetic>` error records) makes the record `unkeyed`. Unkeyed usage is counted in `coverage.records_unkeyed`, never in totals. An unkeyed record whose chain is known (Claude `sessionId`, Codex `thread_id`) taints that chain (R0.9 `request_anomaly`). A Codex `token_usage_record` without a string `thread_id` belongs to no stream: it is unkeyed for accounting and taints every Codex chain (R0.9 `unattributed_record`).

R2.14. `<synthetic>` records and any record with `isApiErrorMessage = true` are not requests. They are counted in `coverage.api_error_records`.

## 3. Pricing

R3.1. One mode only: repricing at the price table snapshot, named "list-price equivalent at table `<version>`". `pricing/table.json` stores `model`, `provider`, per-MTok prices as decimal strings, `modifiers`, `source_url`, `verified_at`. Every object under `modifiers` carries a boolean `verified` (a schema test fails on a modifier object without one, `openai_long_context` included), and a modifier that is not `verified: true` produces no dollars. The table version is printed in every report.

Pricing table reference. The table is the file `src/pricing/table.json` (written `pricing/table.json` in the rules of this document), with schema version, table version, `verified_at`, the source id to URL map, and one entry per model. Its fields, sources and verification status are described in `docs/pricing.md`, which an auditor uses to check each entry against its source. Every entry and every modifier or long-context object carries `verified`. An object with `verified: false` is treated as absent and produces no dollars (R3.3, R3.4, R3.6), and its tokens count as unpriced (R3.9). Rule ids in this section are unchanged.

R3.2. Prices are stored as absolute dollars per million tokens. Multipliers are not used at runtime. Two tests run over the table. (1) Ratio test: for every price row that has an effective multiplier object, namely the standard row, every `fast` row, the Haiku 5.5 high tier row and every verified long-context row, each cache price equals the input price of the same row times the effective multiplier of that row, with the input price of the row itself (a fast row is tested against the fast input price, not the standard one). The effective multiplier object of a row is the object stored in the row (a long-context row stores its own) or, when the row stores none, the `multipliers` object of its entry: a Claude `fast` row and the Haiku 5.5 high tier row inherit the multipliers of their entry, because the cache ratios of an entry apply to its fast and tier rows (A1). The table stores the inherited object explicitly beside the row (`fast.multipliers`, `tiers.high_multipliers`), and a test asserts that it equals the entry's object. A row whose effective multipliers are null or absent (the OpenAI models up to GPT-5.5, the `gpt-5.3-codex` fast row, the long-context rows of `gpt-5.5` and `gpt-5.4`) is not ratio tested, and its cache prices are the printed figures. (2) Documented-multiplier test: the stored multipliers equal the documented list. Claude cache read is 0.1x input by default, with these exceptions: 0.05x for Opus 5.5 and Sonnet 5.5, and 0.025x for Fable 5.1 and Mythos 5.1. Claude 5m write is 1.25x and 1h write 2x input for every model. OpenAI cache write is 1.25x input for GPT-5.6 and later, cached input is 0.1x input for GPT-5.6 and later except 0.05x for GPT-6.1 Sol. A model outside these lists has no documented multiplier, stores none, and is not tested by (2). A model listed here whose stored multiplier differs from this list fails the test. The geo multiplier `C32` is applied at runtime (R3.8) and never stored in a row.

R3.3. Model id normalization. A trailing `-YYYYMMDD` is stripped. Matching is exact string equality afterwards. Aliases (`opus`, `sonnet`, `fable`, `haiku` in `meta.json`) are never used for pricing. A model with no table row is `unknown_model`: its tokens are reported, its dollars are not produced, and `coverage.tokens_unpriced` includes it.

R3.4. Modifiers. A response is priced only if every modifier is resolved and verified (R3.12). The general rule: a modifier value that is unrecognized, that conflicts between copies (R4.2), or whose pricing effect is not defined in this table gives `unpriced_modifier`, and no dollars are produced for that response. A modifier is never guessed, and never defaulted except where a row below says so.

| Modifier | Rule |
|---|---|
| Claude `usage.speed` | Enum from R1.2, read from the final copy (R4.2) only. A response without a final copy has no verified speed: `unpriced_modifier` with reason `modifier_unverified` (R3.12), never a standard price and never a range. On a final copy: `standard`: standard price. `fast`: use the table fast row if the model has a verified one, else `unpriced_modifier`. If `inference_geo` is also `us`, the geo multiplier is applied to every price of the fast row only when the table modifier `fast_with_geo_us` has `verified: true` and the fast row of the model has `geo_us_applies: true` (and the model's `geo_us` is verified); otherwise `unpriced_modifier`. What the official pages say about that combination is a table fact (G0-pricing), never a rule of this document. `other`: `unpriced_modifier`. |
| Claude `usage.inference_geo` | Enum from R1.2, read from the final copy (R3.12, R4.2). `not_available` on the final copy: no multiplier. Absent on the final copy: `unpriced_modifier` with reason `modifier_unverified` (R3.12). `us`: multiply every price by `C32` (11/10) where the table says it applies to the model (a verified `geo_us` object with `applies: true`), else `unpriced_modifier`. `other`: `unpriced_modifier`. |
| Claude `usage.service_tier` | Enum from R1.2, read from the final copy (R3.12, R4.2). `standard` on the final copy: no effect on price. Absent on the final copy: `unpriced_modifier` with reason `modifier_unverified` (R3.12). `priority`, `batch` or `other`: `unpriced_modifier` unless the table row of the model has an explicit `service_tier` entry for that value with `verified_at`, in which case that entry is applied as a price row. The enum values are a closed set in the schema, not integers. |
| Claude batch | `service_tier = batch` on the final copy is the only batch signal, and `standard` on the final copy shows that the response was not batch. No batch status is assumed: a final copy without `service_tier` is unpriced (row above). The assumption `no_batch_assumed` of earlier revisions no longer exists. |
| Claude Haiku 5.5 tiers | The tier is chosen by `total_input` of the response: at most `C26` uses the low tier, above uses the high tier. |
| Codex long context | A model is request-scoped iff its long-context object has `scope = request` and `scope_verified: true` (R3.10, R3.11). A response of a model that is not request-scoped is `unpriced_modifier` with reason `long_context_scope` at any `in` (R3.10). For a request-scoped model: `in <= C25` uses the standard row; `in > C25` uses the long-context object iff that object also has `verified: true` (its prices are verified) with an effective `verified_at` (R3.11), else `unpriced_modifier`. |
| Codex service tier (Standard, Fast, Ultrafast) | No field retained by R1.2 shows the tier, and recon found none (Q9). A Codex response therefore has no verified tier: it is `unpriced_modifier` with reason `modifier_unverified`, whatever its model, its `in` and its scope (R3.10). No Standard tier is assumed and no range is produced. A Standard price is not an observational bound: the official pages list higher prices for the faster tiers of the same model (O1 and the Codex speed options page, 2026-10-09), and the table itself shows a fast row at twice the Standard price for `gpt-5.3-codex`. The assumption `codex_standard_tier_assumed` no longer exists. The tokens of the response are reported and counted as unpriced (R3.9), and an event whose `P` or `C` is such a response is tokens-only (R8.4 A1). The gate is evaluated before R3.10, so the reason of a Codex response is `modifier_unverified` and not `long_context_scope`. The row selection of R3.6 and R3.10 is kept, and is exercised in tests through the test-only function parameter `codex_tier_for_test = standard` (a parameter of the pricing function, never an environment variable, CLI flag or log field, like the salt of R4.10). A log field that shows the tier, a fixture showing it and a spec revision reopen this row. |
| Regional endpoint surcharge | Not observable. Printed as assumption `no_regional_surcharge_assumed`. |

R3.5. Claude cost of one response:

```
cost = i*p_in + r*p_read + w5*p_w5 + w1*p_w1 + o*p_out
```

A response with `w_unknown_ttl > 0` (R2.1) is `unpriced_modifier` with reason `bucket_unknown`: the write price depends on a TTL class the log does not show, and a total holds one number, so no range is produced. A response whose output is unusable (R2.3: `conflict_output`, `conflict_iterations`) is a conflict, so its chain is tainted (R4.2, R0.9) and it is not priced; no cost with an omitted output term exists. A response without a final copy is not priced at all (R3.12).

R3.6. Codex cost of one response (the audit formula):

```
normal = in - c - cw
cost   = normal*p_in + c*p_cached + cw*p_write + out*p_out
```

If `cw > 0` and the model's `p_write` is `n/a`, the response is `unpriced_modifier`. If `cw == 0`, `p_write` is not needed. Reasoning is not priced separately (R2.8). This formula runs only for a response whose service tier is verified (R3.4). With the fields retained in revision 9 none is, so in a default run the formula produces no dollars; it runs in the tests under `codex_tier_for_test = standard`.

R3.7. Models seen in recon and their status (a Codex model is priced only when its attribution is verified, R2.10): Claude `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1`, `claude-haiku-4-5` and `claude-haiku-5-5` are priced from the table. Codex `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6-astra`, `gpt-5.6-luna`, `gpt-5.5` are priced. `codex-auto-review` and `gpt-5.3-codex-spark` have no table row and are `unknown_model`. The table in `pricing/table.json` is authoritative, this list is a test expectation for the table at G0-pricing. Priced here means that the table has a verified row for the model. A response is priced only when R3.4, R3.10 and R3.12 allow it: with table `pt-2026-10-09.2` a Claude response is priced only with a final copy (R3.12), and every Codex response is unpriced (`modifier_unverified`, the service tier is not observable, R3.4), so the Codex entries of this list are expectations about table rows and test-parameter runs (`codex_tier_for_test`), not about default dollars. Under that parameter every `gpt-5.5` response is unpriced as well (`session` scope, R3.10).

R3.8. Arithmetic. Prices are parsed from decimal strings into integers in units of 1e-6 USD per MTok. Cost is `tokens * price_units` as BigInt in units of 1e-12 USD, multiplied by the numerator of `C32` and divided by its denominator once when `inference_geo` is `us`, then rounded half up to 1e-9 USD only at display. Sums are sums of BigInt. No `Number` is used for money. Two runs over the same input produce byte-identical money.

R3.9. Unpriced share. Every report prints `tokens_unpriced / total_tokens` per provider. If it exceeds `C24` for a provider, the headline dollar figure for that provider is prefixed `partial` (R16.1).

R3.10. Long-context scope (Codex). Official model pages describe the long-context price of some models as applying to the request whose input exceeds `C25`, and of others as applying to a session. A log does not say what a pricing session is (Q30), and no retained field lets a reader prove that every thread and file of a session was scanned: a child thread names its parent, a parent names no child, `response_item` is dropped (R1.2), and the cumulative `thread_total` of one thread says nothing about another thread of the session (Q31). A request that is visible at 100000 input tokens can therefore belong to a session in which an unseen thread, or a request whose model is unverified (R2.10), crossed `C25`. The rule does not try to prove completeness. It abstains.

A long-context object carries three separate facts: its prices (`verified`, R3.1), its `scope` with the values `request`, `session` or `unknown` (an object without `scope` has `unknown`), and `scope_verified` (boolean) with `scope_source_id`, the id of the source page that states the scope. A `scope` without `scope_verified: true`, an effective `verified_at` and a `scope_source_id` (R3.11) is `unknown`. Verifying the prices never verifies the scope.

A model row is request-scoped iff it has a long-context object with `scope = request` and `scope_verified: true`. Pricing is decided per response, from the model row and the response's own `in` only:

* Request-scoped model: a response with `in <= C25` is priced at the standard row. A response with `in > C25` follows R3.4 (usable long-context object, else `unpriced_modifier`).
* Every other model (scope `session` or `unknown`, a long-context object without verified scope, or no long-context object at all, because the same session wording may apply): every response is `unpriced_modifier` with reason `long_context_scope`, whatever its own `in` is and whatever any other response, thread, file or archive of the scan shows.

Tier gate. R3.10 selects the price row that would apply to a response whose service tier is verified. Whether the response gets any dollar is decided first by the tier gate of R3.4: with the fields retained in revision 9 no Codex tier is verified, so every Codex response is `unpriced_modifier` with reason `modifier_unverified` in a default run, before the scope is looked at, and the reason count `long_context_scope` stays 0. The fixtures below, and the Codex fixtures of R8.1 and R8.9, run under the test-only parameter `codex_tier_for_test = standard`, which marks the tier as verified Standard for the run and exists to exercise the row selection and the allocations. Each of these fixtures also has a default run that asserts `usd = null`, reason `modifier_unverified` and the unchanged token figures.

There is no session group, no history check and no dependence on any other response. So no response, however its model is attributed, can change the price of another one, a continuation file or a sub-thread file that was not scanned cannot change the priced set, and a split or shuffle cannot change it (R4.10). The tokens of an unpriced response are reported and counted as unpriced (R3.9). Events whose `P` or `C` is such a response keep their token bound and get `delta_status = tokens_only` (R8.4, A1). The count is the reason count `long_context_scope` of `coverage.requests_unpriced_modifier`. A model whose page publishes no long-context price is treated like any other model without a verified request scope.

Required fixtures (each also shuffled and split at every line boundary, R4.10, where the priced set of a split is a subset of the unsplit one): (1) responses at `in` 100000, 300000 and 100000 on a `session` scope model: all three unpriced `long_context_scope`; the same on a model with verified `request` scope and verified long-context prices: only the middle one uses the long-context price, and with unverified long-context prices the middle one is `unpriced_modifier` and the other two are priced; (2) a main thread whose cumulative `thread_total` chain is complete and a sub-thread file of the same `session_id` that is absent from the scan, with a 100000-token request in the main thread: unpriced on a `session` scope model (the missing file cannot be seen), priced on a `request` scope model, and the same result when the sub-thread file is present with a 300000-token request; (3) a session with a 300000-token response whose model is unverified (two conflicting model contexts, R2.17) followed by a verified `gpt-5.5` response at 100000 input and 100 output tokens: unpriced on a `session` scope model, so the standard-price equivalent of that pair is never produced, and priced at the standard row on a `request` scope model while the model-unknown response yields no dollars; (4) an unreadable archive, and a coverage-only version file that carries the same `session_id` and a 300000-token request: no change for a `request` scope model, and all `session` or `unknown` scope responses stay unpriced. In table `pt-2026-10-09.2` the scope is verified from the model pages as `request` for `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` and `gpt-5.6-luna` (each page states that the long-context rate applies to the full request), and as `session` for `gpt-5.5` and `gpt-5.4`. With that table, and under `codex_tier_for_test = standard`, the seven request-scoped models are priced as above (the real `gpt-5.5` row is the `session` scope variant of fixtures 1 to 4, and `gpt-6-sol` is the `request` scope variant), while `gpt-5.5`, `gpt-5.4` and every Codex model without a long-context object are unpriced with reason `long_context_scope`. In a default run every Codex figure is a token figure only, with reason `modifier_unverified` (the tier gate above). A change of scope or of a long-context price is a new table version (R15.1, R3.11). Additional fixture (5): `gpt-5.5` and `gpt-6-sol` responses at 100000 and 300000 input tokens: both `gpt-5.5` responses are unpriced, `gpt-6-sol` is priced at the standard row (2/0.2/2.5/10) at 100000 and at the long-context row (4/0.4/5/15) at 300000.

R3.11. Verification dates in nested objects. `verified_at` is a property of the table (top level), of an entry, or of a nested object (`modifiers.*`, `fast`, `tiers`, `long_context`, `geo_us`, `service_tier` rows). A nested object without its own `verified_at` inherits the `verified_at` of its entry, and an entry without one inherits the table's. The effective date is what R3.4 means by "with `verified_at`". An object with `verified: true` that has no effective date is invalid: the schema test fails, and at runtime the object is treated as `verified: false`. `scope_verified: true` (R3.10) follows the same rule and also needs a `scope_source_id` that names a source of the table; without either it is treated as `false`. Required test: every `verified: true` object of the table has an effective `verified_at`, and every `scope_verified: true` has an effective `verified_at` and a source id. A second schema test asserts that every object under `modifiers` has a boolean `verified` (R3.1).

R3.12. Modifier verification (Claude). The price row of a response depends on three modifiers: `speed` (a fast row exists for some models), `inference_geo` (a multiplier for the models where geo applies) and `service_tier` (batch). The log carries them on the final copy (R4.2), and recon saw `speed` only there. No fact shows which modifiers a partial copy carries, so the absence of a field on a partial copy says nothing about the request, and a standard price is not an observational bound: a response that ran fast and has no final copy costs twice the standard row (example: `claude-opus-5-5`, `K_prev = 20000`, `R = 0`, `w1 = 20000`, `U = 0`: the standard row gives 0.156 USD, the fast row 0.312 USD, fast with geo us 0.3432 USD). Rule: a Claude response is priced only if it has a final copy that carries all three modifiers (`speed` marks the final copy, and `inference_geo` and `service_tier` must be present on it), and all three are read from that copy alone (R4.2). A response without such a final copy is `unpriced_modifier` with reason `modifier_unverified`: its tokens are reported and counted as unpriced (R3.9) and it yields no dollars. No range is produced, because a range would have to cover every price row and multiplier the table can apply (standard, fast, geo, fast with geo, batch), and the rule abstains instead. The rule names the modifiers and not a model list, so it holds for any model that the table lists, and a model without a fast row is not an exception: the modifiers `inference_geo` and `service_tier` apply to it. No assumption `speed_assumed` exists.

An event whose `P` or `C` is a `modifier_unverified` response has `delta_status = tokens_only` with reason `modifier_unverified` (R8.4 A1) and keeps its token bound `L` (R8.1). `P` is included because the dollar figure is built on a pair, and a figure that rests on an unverified neighbour is not defined. The response still takes part in detection (R7.2).

Required fixtures (each also shuffled and split at every line boundary, R4.10; copies are keyed globally, so a split cannot move a final copy away from its response): (1) the example above with `C` lacking a final copy: `usd = null`, `delta_status = tokens_only`, reason `modifier_unverified`, `tokens_upper = 20000`, and the response counted in `requests_unpriced_modifier` under `modifier_unverified`; (2) the same `C` with a final copy: speed `standard` gives `usd_hi = 0.156`, speed `fast` gives `0.312`, speed `fast` with `inference_geo us` gives `0.3432` (table `pt-2026-10-09.2`, `fast_with_geo_us` verified); (3) a final copy with speed `standard` and a partial copy that carries `inference_geo us`: `conflict_modifier`, unpriced; (4) `P` without a final copy and `C` with one: tokens-only; (5) a response with no final copy on a model without a fast row (`claude-sonnet-5-5`): unpriced `modifier_unverified` as well.

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
| `speed`, `inference_geo`, `service_tier` (modifiers) | the final copy, for all three. A response with no final copy has no verified modifier (R3.12) | Every non-final copy that carries a modifier MUST carry the same value as the final copy. A copy that carries a value the final copy does not carry, or a different value, is a disagreement; a copy without the field is no conflict. A disagreement gives `conflict_modifier`: the response keeps its tokens but is `unpriced_modifier` (R3.4), and no dollars and no dollar delta are produced for it. |
| `model` | any copy | MUST be equal, else `conflict_model`, excluded. |
| `diagnostics` | union of non-null `cache_miss_reason` over copies | two different non-null `type` values: `conflict_diagnostics`, treated as no diagnostics evidence (R10.4). |
| `t_first`, `t_last` | min and max `timestamp` over copies | none |

Every conflict code of this table except `conflict_diagnostics` taints the chain of the request (R0.9 `request_anomaly`): the response keeps the token treatment stated in its row, and the chain yields tokens only.

R4.3. Selection MUST NOT depend on file order, line order, file name or modification time. Where a deterministic tie-break is needed, order copies by `(has_speed desc, output_tokens desc, timestamp asc, uuid asc)`.

R4.4. Codex, CLI 0.157.1 to 0.160.1. One `token_usage_record` per response. A `response_id` that occurs more than once is accepted as one response only if every occurrence is the same record: the retained projections (R4.12) of the occurrences are equal, which includes `usage`, `thread_id`, `session_id`, `turn_id`, `ordinal` and `timestamp`, and, as a defensive check, the R2.10 attribution of each occurrence is equal (same verified or unverified status and, when verified, the same normalized model id). Then it is counted once, and which occurrence is kept cannot change any output, because every compared field is equal. No lexicographic or other choice between non-identical occurrences exists. If the `usage` differs the response is `conflict_usage`. If `usage` is equal but anything else compared above differs (a different thread, session, turn, ordinal, timestamp or model attribution) the response is `conflict_attribution`. Either conflict removes the response from totals and dollars, taints every stream that holds an occurrence (R0.9 `request_anomaly`), and is counted in `coverage.requests_conflict` with the reason. Required fixture: two records with the same `response_id` and identical `usage` in two threads, with different verified models in their thread contexts, and a second pair differing only in `turn_id`: both produce no dollars, no event and no boundary, `requests_conflict` is incremented, and the outcome is the same under shuffling. Recon found no duplicate `response_id`, so any duplicate is also an anomaly counter.

### 4.3 Retries and distinct billed responses

R4.5. Two different keys are two billed responses even if their usage is identical. cachewhy MUST NOT merge them. A Claude API error record (rate limit, `<synthetic>`) is not a billed response (R2.14). No heuristic matching of "retry-looking" requests is allowed.

### 4.4 Replayed history and ownership

R4.6. Claude copies. A request key seen in more than one logical stream (R4.11; recon: 444 requests, from one pair of main files; the second file also repeats uuids inside itself) is a replay in every stream but one. A key seen several times inside one logical stream is a duplicate within that stream and is collapsed by R4.1 and R4.2, not a replay. The owner is the logical stream with the earliest `stream_start`, where `stream_start` is the minimum `timestamp` among the records of all files of that stream. A replayed record keeps its original uuid and timestamp, so timestamps cannot separate original from copy; `stream_start` can. Ties on `stream_start` make ownership `ambiguous`: for accounting only, the lexicographically smaller `sessionId` owns, so the tokens are counted once; every such request is counted in `coverage.replay_ownership_ambiguous`, and every chain that holds a copy of it is tainted (R0.9 `ownership_ambiguous`).

R4.7. Replayed records count zero tokens, zero dollars, zero events and zero boundaries in the non-owning stream. They are not discarded from the stream's history: they remain as history for baseline and for the chain TTL set (R9.2) and as the marker of the replay region (R4.8). Duplicated non-assistant records (uuid seen twice) are collapsed on uuid. Duplicated `compact_boundary` records collapse on uuid and belong to the owning stream.

R4.8. Replay and the first own request. A replayed request is never a previous request `P` of an event (R6.2, R7.2 E1). The first own request after a replay region in a copying stream is a boundary of type `fork_inherit` (R11.6, R11.8). It is never a suspected rebuild and never an event, and no rebuild delta is computed for it, whatever its counters show. It is nevertheless a billed response of the owning stream: its tokens and its list-price-equivalent cost (R3.5, R3.6) enter the totals and the per-kind subtotals exactly like any other response (R5.8). Only the event and the delta computation are suppressed, never the accounting of the response itself. The next own request has the first own request as `P`. There is no `via_replay` event class. Required fixture: a fork whose first own response has positive counters, asserting that its tokens and dollars are in the totals, that it is a `fork_inherit` boundary, and that it has no delta.

R4.9. Codex forks. A Codex thread is a fork iff its own `session_meta` (R4.11) has a non-null `forked_from_id`. Fork detection never depends on a second `session_meta` being present in the same file, and never on the physical position of any record. The copied prefix of a fork is the set of records of the logical stream with `ordinal < subagent_history_start_ordinal` of the own `session_meta`. The prefix cut is applied only when the stream is `ordinal_verified` (R4.12) and the own `session_meta` carries `subagent_history_start_ordinal` as an integer in the range of R2.15 (a missing, non-integer or out-of-range value is `fork_prefix_unresolved`); otherwise the prefix is `fork_prefix_unresolved` and the stream is tainted (R0.9). Prefix records count zero tokens (recon: `token_usage_record` is never copied, so accounting never depends on the cut: a `token_usage_record` is accounted by its own `thread_id` and `response_id`, R2.9). The first own request of a fork is the request of the stream with the smallest event time (no ordinal is needed, because no `token_usage_record` lies in the prefix); a tie gives `order_tie`. It is a `fork_inherit` boundary (R4.8). `compacted` records in the prefix are replays and are ignored for event attribution. A `compacted` record elsewhere is owned by the logical stream where it first appears by `stream_start` (earliest `session_meta.timestamp`, a minimum, so independent of record order), and a copy has `latest_token_usage_record = null` or a prefix ordinal.

R4.10. Metamorphic tests. The operations are: (1) shuffling lines within a file; (2) shuffling file order; (3) duplicating any line; (4) re-serializing JSON with a different key order; (5) splitting a file in two at a line boundary, each half keeping at least one record that names a chain (R0.9) and the modification time of the split file. Every operation keeps file modification times and the injected run start (R0.9, live families). The semantic output is the whole report (totals, events, boundaries, causes, delta fields, headline, coverage) after these normalizations only: (a) `generated_at` is ignored; (b) opaque ids `req_<hex>`, `chain_<N>`, `sess_<N>` are compared after replacing each hex part by its rank of first appearance in the deterministic order of R14.4, because the salt is random per run (a test run MAY inject a fixed salt through a test-only function parameter, never an environment variable or CLI flag); (c) the physical counters of R17.6 are compared against the exact change stated there.

Operations 1 to 4 MUST NOT change the semantic output.

Operation 5 (split). Token totals and per-response accounting are identical, because accounting is keyed by record identity (R2.9, R4.1, R15.7) and a non-dissolving split keeps the set of live families (R0.9). The one exception is a dissolving split of a live file, after which a family named only by the half without the unparseable line is no longer live. Beyond that, R0.9 decides the result. A split is dissolving iff the split file is a stream conflict (`I(F)` of two or more ids) and every half has a smaller identity set, or the split file names chains of two or more families and no half names chains of all of them. A dissolving split removes the only evidence that one file mixed identities, so it is a different input, not a repackaging of the same log, and the unsplit scan stays the reference. For every split that is not dissolving:

* Taint monotonicity: the tainted chain set of the split scan contains that of the unsplit scan (R0.9, split and order behavior).
* Split monotonicity: the set of responses with a verified model (R2.10), the set of priced responses, the dollars of every chain, the events and the boundaries of the split scan are each a subset of the unsplit result, with equal values on the common part. Every difference is a withdrawal from a chain that the split tainted, traceable to a reason count of `chains_tainted`.
* Invariance: a split that taints no new chain gives identical output, except the physical counters of R17.6 (the two counters of R2.9 among them).
* Logical counters change only as R17.7 states.

For a dissolving split the test asserts exactly these record-set guarantees: tokens, per-response accounting and every counter keyed by record identity are identical (outside families whose liveness the split changed), and every chain tainted by a reason that is a property of the record set (`turn_model_conflicted` through a usage record of the turn, `request_anomaly`, `ownership_ambiguous`, `version_unverified`, `unattributed_record` through a record without a key, `file_unreadable`) stays tainted; the stored values of fixture (8) of R2.17 are matched exactly.

Required fixtures, each with the expected result of every split position stored and compared exactly: a Codex fork (own `session_meta`, copied parent `session_meta`, copied prefix records, own records with positive-cost responses) together with a file of the parent thread, including the split whose half holds only the copied parent `session_meta` and copied `turn_context` records (copy-exposed, R4.13: the family of parent and child is tainted, so neither gains a verified model, dollar or event); a Codex thread over two files; the fixtures (5) to (8) of R2.17; the fixtures of R0.9; and the counter fixture of R2.9: one Codex file with, in order, 1 `session_meta(X)`, 2 `token_count`, 3 `turn_context`, 4 `token_usage_record(X)`, 5 `token_count`. Each half names a chain for the splits after record 1, 2 or 3. Stored expectations: unsplit, `files_without_response_id = 0`, `token_count_events_without_response_id = 0` and `X` untainted; split after record 1: 0 and 0, `X` untainted and the output identical; split after record 2 and after record 3: 1 and 1 (the first half holds one `token_count` event and no `token_usage_record`), `X` tainted `unlogged_usage`, its events, verified models and dollars withdrawn, tokens identical.

R4.11. Logical stream. A chain's records are read as one logical stream, independent of how they are split across physical files, of file order and of line order. Identity never comes from "the first record found".

* Claude: identity is read per record from `(sessionId, agentId or main)`.
* Codex: identity is resolved per file from an identity set. In a file `F`, a `session_meta` record `m` is non-own iff another `session_meta` in `F` has `forked_from_id == m.id` (the copied parent record of a fork); every other `session_meta` is own. `own_ids(F)` is the set of ids of own `session_meta` records, `tur_ids(F)` the set of `thread_id` values of `token_usage_record` records, and `I(F) = own_ids(F) union tur_ids(F)`. Both sets are order independent.
  * `|I(F)| = 1`: `F` is assigned to that stream.
  * `|I(F)| = 0`: `F` is counted in `coverage.files_unassigned_stream` and contributes no accounting. A non-empty unassigned file taints every Codex chain (R0.9 `unattributed_record`), because its records can belong to any thread.
  * `|I(F)| >= 2`: `F` is counted in `coverage.files_stream_conflict`. Its `token_usage_record` records are still accounted by their own `thread_id` and `response_id` (accounting never depends on file membership). Its other records (`turn_context`, `event_msg`, `response_item`, `compacted`) are assigned to no stream, and the file taints the family of every id of `I(F)` (R0.9 `stream_unresolved`).
  * Two own `session_meta` records with the same `id` that differ in `session_id`, `forked_from_id` or `subagent_history_start_ordinal` also taint the family of that id (R0.9 `stream_unresolved`). Copy exposure (R4.13) and turn model conflicts (R2.17 (d)) are further taint reasons of R0.9.

All files and records with the same resolved identity form one stream. Records of a stream are ordered by `(event_time, key)` for requests (R6.1) and by `uuid` as a tie-break for Claude records; where `ordinal` is used, R4.12 applies. A file with no stream identity field is never merged into another stream by guessing. Ownership (`stream_start`, R4.6), model attribution (R2.10), previous-request search (R6.2) and linkage lookups (R5.6) use the logical stream, never the physical file. A boundary of a physical file is therefore never a context boundary, and splitting or shuffling a file does not change ownership or model attribution, except where the identity set above cannot be resolved, in which case the chains it names are tainted (R0.9) rather than guessed.

R4.12. Ordinal verification. Record equality. For a record `r`, its retained projection `proj(r)` is the tuple of every field that R1.2 retains for it: the envelope `type`, `timestamp` and `ordinal`, plus all fields listed for its record type (ids, model, effort, `comp_hash`, usage integers, payload type and role enums, `subagent_history_start_ordinal`, and so on). Two records are equal iff their projections are equal field by field. Equality is never decided on a subset such as envelope type, timestamp and payload type. Records that are equal on all retained fields and differ only in dropped content are treated as one record, which is harmless because no decision reads dropped content. Ordinal-decision records are the records that any ordinal-based decision reads: `session_meta`, `turn_context`, `token_usage_record`, `compacted`, and `event_msg` with payload type `thread_settings_applied`. (`task_started` and `response_item` are read by no decision since revision 5, R6.5.)

For a Codex stream, `ordinal_verified` is a computed property of the logical stream, not an assumption. It is true iff all hold: (a) every ordinal-decision record of the stream carries an `ordinal` that is an integer with `0 <= value <= Number.MAX_SAFE_INTEGER` and a `timestamp` that parses as an ISO instant, so a missing, non-integer, out-of-range or unparseable value on any such record, including one that the decision at hand would not itself read, makes the stream fail, and any other record that carries an ordinal must satisfy the same range; (b) records that share an ordinal are equal in the sense above (a duplicated line is not a collision); two records with the same ordinal and any differing retained field are a collision and fail the stream (for example two `turn_context` records with the same ordinal, timestamp and payload type and different models); (c) after collapsing equal records, sorting the ordinal-bearing records of the stream by ordinal gives envelope timestamps that never decrease. This is evaluated over the whole stream across all of its files, so it is independent of file order and splitting. A stream that fails is `ordinal_unverified` and tainted (R0.9), so every decision of this spec that uses `ordinal` to order records, to cut a prefix or to bind a marker runs only on `ordinal_verified` streams. Required fixtures: a stream in which one ordinal-decision record has no ordinal, and a stream in which two `turn_context` records of different models share ordinal, envelope type, timestamp and payload type; both are `ordinal_unverified` and tainted, and a byte-identical duplicated line in the same stream is not a collision. A stream whose files all pass the check is `ordinal_verified` even if it spans several files; a fixture with a thread over two files passing the check and one failing it are required (Q21).

R4.13. Copy provenance. Whether a `session_meta` or `turn_context` is a copied record of another thread is decided over the whole scan, never inside one file. Let `FS` be the set of ids that occur as `forked_from_id` of any `session_meta` anywhere in the scan (every file of every version counts, R15.7, and the set is order independent). A file `F` is copy-exposed iff `own_ids(F)` contains an id `x` in `FS` and `F` contains no `token_usage_record` with `thread_id = x`. Such a file may hold a copied parent prefix (a fork file that was split, where the child's own `session_meta` is in the other half), because a copied prefix never contains a `token_usage_record` (recon), so the file cannot show that it is the parent's own file. A copy-exposed file is counted in `coverage.files_copy_exposed` and taints the family of every chain it names (R0.9 `copy_exposed`). That family holds the parent `x` and, through the `forked_from_id` links, every fork of it and every fork of a fork, so a copied context in `F` verifies a model for none of them. The genuine parent file of a fork is not copy-exposed as long as it holds one `token_usage_record` of the parent, so forking a thread does not taint the parent in the normal case. Items (b) and (c) of revision 10 (copied contexts are no candidates; fork exposure `prefix_exposed` over the fork ancestors `FA(S)`) are removed, because the family taint subsumes both. A split can create a copy-exposed file but never remove one (R4.10). Identity and provenance are separate conditions: a file can resolve to exactly one stream identity (R4.11) and still be copy-exposed. Required fixtures: the split of a fork file at each line boundary (R4.10), including the half with only the copied parent `session_meta` and `turn_context`, which taints the family of parent and child; the two-model fork fixture (5) of R2.17 at every line boundary; and a copy-exposed file whose copied `turn_context` carries a model that differs from the parent's genuine model, which changes the parent's priced set only by withdrawal.

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
2. Every record of the chain has `agentId = <id>` and a `sessionId` equal to the parent directory uuid.
3. Parent chain selection: if `spawnDepth` is 1 or absent, the parent chain is the main chain of the session. If `spawnDepth` is 2, the parent chain is the chain of agent `parentAgentId` of the same session, and `parentAgentId` MUST be present. The parent is a logical stream (R4.11), never a physical file, so splitting a parent file changes no link.
4. The parent chain contains an assistant content block with `type = tool_use`, `id = toolUseId` and `name = Agent`.
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

R5.9. Event time of a request: Claude `t_first`, Codex the envelope `timestamp` of its `token_usage_record`. The report window `[since, until)` is evaluated in UTC on event time only. File modification time MUST NOT include or exclude any file or request, except through the liveness test of R0.9, which removes a session being written and says so in coverage. Every command reads every file under the scan roots of both providers; a window, session, project or chain filter selects what is printed, never what is read, because a file left unread can hold a request between `P` and `C` of a printed pair. The `--fast` mtime prefilter of earlier revisions is removed and `C29` is retired.

R5.10. Baseline. All files are read in full. Requests before `since` are loaded and used as previous requests and for the chain TTL set (R9.2), but they contribute zero tokens, dollars and events to the window totals. An event is in the window iff its current request `C` is in the window; its previous request `P` MAY be before the window.

## 6. Ordering and timing

R6.1. Within a chain, requests are ordered by `(event_time asc, key asc)`. Two requests with equal event time are `tie`; any event or boundary whose `P` or `C` is part of a tie abstains with `order_tie` (R7.2 E0).

R6.2. Previous request. `P(C)` is the immediately preceding request of the logical stream in the order of R6.1, taken over all requests of the stream including replayed ones (R4.7). If it is replayed, the pair is the boundary `fork_inherit` (R7.2 E1). A request that another rule removes from accounting (conflicted, unkeyed, incomplete, invariant-failed, range-failed, `bucket_mismatch`, unverified version) taints its chain (R0.9), so a stream that reaches this rule holds no removed request, and no request between `P` and `C` is missing from it. API error records (R2.14) are not requests. The code `gap_has_excluded` of earlier revisions no longer exists.

R6.3. Claude timing variables of a request `R`:

```
t_first(R)  = min timestamp over copies
t_last(R)   = max timestamp over copies
t_asm(R)    = timestamp of the record named by parentUuid of the earliest copy, if it resolves in the global uuid index
```

A `parentUuid` resolves only if every record with that uuid in the global index is equal on its retained fields (R4.12 equality). A uuid that names records with different timestamps or parents does not resolve, and `t_asm` is unknown.

R6.4. Start bounds (the true request start is not logged, so a bound exists only where a record that must precede the request exists):

```
start_lo(R) = t_asm(R)    if t_asm exists and t_asm <= t_first(R)     basis: parent_record
            = unknown     otherwise                                   basis: none
start_hi(R) = t_first(R)
```

No offset, percentile or default lag is applied. The bound `start_lo` is the timestamp of the record that the request is built on, which exists before the request is sent. That is a causal premise, not a log fact, so it is printed as assumption `parent_record_precedes_request` and is checked experimentally by R6.8. When `start_lo(R)` is `unknown`, every gap statement that needs it is `unknown` (R6.6). Constants `C4` and `C5` are retired.

R6.5. Codex timing. `start_hi(R) = ts(token_usage_record of R)`. `start_lo(R)` is always `unknown` with basis `none`, for every Codex request, whatever the stream state. Reason: the order of records (the `ordinal`) says that an input record, such as a user message or a tool result, was logged between two usage records, but not that this input is part of the request `R`. With overlapping or parallel requests of a thread, an input recorded after `R` started can sit before the usage record of `R` and belong to a later request. No retained field links an input to the request that contains it (Q27), and a link would need content or ids that R1.1 does not allow. So no Codex time lower bound is derived, the previous usage record is not used either, and every Codex statement that needs `start_lo` is `unknown` (R6.6). Consequences: Codex `gap_min` is `null`, Codex `ttl_expiry_compatible` is never emitted (R9.6), and no Codex input record is read by any decision. Required fixture: a Codex thread with two overlapping requests, in which a user input and a tool result are logged after the start of request `C` but before its usage record and belong to a later request, plus a sequential thread; both must give `start_lo = unknown`, `gap_min = null`, no `ttl_expiry_compatible` candidate, and the same result under shuffling and under every split position of R4.10. A future revision may derive a Codex bound only if a structural field ties an input to its request (Q27) and the overlap fixture passes.

R6.6. Gap bounds between `P` and `C`:

```
gap_min = start_lo(C) - start_hi(P)     unknown if start_lo(C) is unknown
gap_max = start_hi(C) - start_lo(P)     unknown if start_lo(P) is unknown
```

Gaps are intervals, never points, and either end may be `unknown` (serialized as `null`). Negative `gap_min` is clamped to 0. An unknown end is never replaced by a default. The only time-based decision, `expiry_compatible` (R9.4), reads `gap_min` alone: with `gap_min` unknown there is no TTL statement (`ttl_gap_unknown`). `gap_max` is reported for display and is read by no decision, because this spec makes no expiry exclusion statement (R9.4, Q26).

R6.7. Documentation of timestamps. The report states that `t_first` is the time the first content block finished streaming, not request start, that `start_lo` (Claude only, Codex is always unknown, R6.5) is a causal bound resting on assumption `parent_record_precedes_request`, and that all time-based statements are interval-based.

R6.8. Start bound validation. In the controlled runs (section 12) the harness records its own wall-clock time of sending each request. Requests are matched to log records by the run manifest. For every verified run, `start_lo(R) <= harness_send_time(R)` MUST hold wherever `start_lo(R)` is known. Only Claude `start_lo` values can be known (R6.4, R6.5), so the check is in effect for Claude; for Codex it is vacuous and is reported as such. The number of runs with a violation is reported per provider. If it exceeds `C34` for a provider, the bound is declared unvalidated: `start_lo` is `unknown` for that provider in all output, no `ttl_expiry_compatible` candidate is emitted for it, and the TTL classes of that provider are described as uncalibrated.

## 7. Suspected rebuild decision rule

### 7.1 Variables

R7.1. All quantities in this section and in section 8 are BigInt (R2.16). For request `X`:

```
Claude:  ctx(X) = i + r + w            K(X) = r + w     K_hi(X) = r + w
Codex:   ctx(X) = in                   K(X) = c + cw    K_hi(X) = in
```

For Codex the counters are not a complete report of the cache: content that was cached implicitly is not reported, so `K(X)` is only a lower bound of the cached prefix after `X`, and `in(X)` (everything `X` processed as input) is an upper bound of it, because a cache cannot hold more than was processed. For Claude, caching is explicit and the counters report it, so `K_hi = K`. The two roles are separate and fixed. `K` (the lower bound for Codex) is used only for eligibility and the numeric test (E5, E7, E8, R7.5): a lower bound can only reduce the number of events, which is the conservative direction. `K_hi` is used only for the upper bounds of section 8 (`L`, `L_pm`, `usd_hi`) and never for a lower or conditional-lower figure, which rest on the evidenced coverage `K_prev` (R8.2, R8.10). An upper bound built on a lower bound would not bound a full reprocess of the real cached prefix (example: Codex `P` reports `c = 20000` of `in = 30000`, `C` reprocesses all 30000; a bound built on 20000 is below the truth). `K_hi_prev = K_hi(P)`. For the current request: `R = r` (Claude) or `R = c` (Codex), `W = w` or `cw`, `U = i` (Claude) or `in - c - cw` (Codex). With `P` the previous request: `K_prev = K(P)`.

### 7.2 Eligibility

R7.2. A request `C`, and a pair `(P, C)` where `P` exists, is eligible only if all checks pass. The first failing check gives the abstain or boundary code in the third column. Checks run in this order. E0 runs before every boundary is chosen: no boundary of R11.8 (first observation, fork, cold start, model switch, context reset) is produced for a request that fails E0.

| Check | Condition | If failed |
|---|---|---|
| E0 | the gate, applied before any boundary is chosen: the chain of `C` is not tainted (R0.9), and neither `C` nor, when it exists, `P` is part of an order tie (R6.1) | abstain `chain_tainted` or `order_tie`, no boundary, no event; counted in `coverage.requests_gate_abstained` with the code. Required test: one tainted chain per reason of R0.9, and a request in a tie, each produce no `first_observation`, `fork_inherit`, `subagent_cold_start`, `model_switch` or `context_reset` boundary and no event, even where the same input without the defect would produce one of them |
| E1 | `P` exists in the same logical stream (R6.2); if `P` is a replayed request the pair is the boundary `fork_inherit` (R4.8) | the boundary of the table in R11.8 (`fork_inherit`, `subagent_cold_start` or `first_observation`) |
| E2 | the models of `P` and `C` are verified (R2.10: Claude always, Codex `own_turn` or `carried_verified`), neither is `model_unknown`, and `model(P) == model(C)` after R3.3 normalization | if both verified and different: boundary `model_switch`; else abstain `model_unknown` (a model whose continuity cannot be verified never produces a pair verdict, a boundary or a dollar figure) |
| E5 | `K_prev > 0`, meaning `P` read or wrote cache | abstain `prev_no_cache` |
| E6 | `model` has a minimum cacheable length `M` in the table | abstain `unknown_min_length` |
| E7 | `K_prev >= max(M, C3)` | abstain `short_prefix` |
| E8 | `ctx(C) >= K_prev` | boundary `context_reset` (the context shrank below the previous cached prefix; compaction, clear or pruning, section 11) |
| E9 | `C` has valid usage fields `R, W, U` | abstain `usage_incomplete` |

Checks E3 (a repeated E0) and E4 (order, now part of E0) are removed in revision 11. E9 cannot fail, because an incomplete response taints its chain (R2.12, R0.9); it stays as a defensive assertion whose failure is a hard error. The other ids are unchanged.

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
| `chain_tainted`, `order_tie`, `prev_no_cache`, `model_unknown`, `unknown_min_length` | as in R7.2 |

R7.7. By construction the event never uses the new suffix as lost prefix: no bound of section 8 exceeds `K_hi_prev` (R7.1; equal to `K_prev` for Claude), and none exceeds `W + U`, so growth beyond the previous prefix is never counted as rebuilt.

R7.8. Output of the detector for each pair is one of `no_event`, `event`, `abstain(code)`, `boundary(type)`. Counts of each go to `coverage`. The headline denominators are in section 16.

## 8. Rebuilt token bound and dollar delta

### 8.1 Token bound

R8.1. Target. The single target of every token, dollar and headline figure of sections 8 and 16 is: the tokens of the previous cached prefix of `P` that `C` processed again instead of reading. Its upper bound is built on `K_hi_prev = K_hi(P)` (R7.1), never on `K_prev`, so the target is the real cached prefix and not only the part of it that the counters report. For a `suspect` event compute two bounds (BigInt):

```
D_hi = max(K_hi_prev - R, 0)
L    = min(K_hi_prev, W + U)    unconditional upper bound
L_pm = min(D_hi, W + U)         upper bound conditional on assumption read_region_is_prefix_of_previous
```

`L` makes no assumption about what the `R` read tokens matched. At most the whole previous cached prefix can have been processed again, so `L` never exceeds `K_hi_prev`, and the tokens processed again are inside the uncached tokens `W + U` of `C`, so `L` never exceeds `W + U`. This is needed because `D_hi` is a bound only if the `R` tokens read are the first `R` positions of the prefix of `P`. Example: `K_hi_prev = 20000`, `C` reads `R = 8000` tokens from an unrelated cache entry, and the 20000 old tokens are processed again. Then `D_hi = 12000` is below the true figure of 20000, while `L = min(20000, W + U) = 20000` holds. `L_pm` is the tighter figure under the assumption that the read region is a prefix of the previous prefix (printed as assumption `read_region_is_prefix_of_previous`). `L_pm <= L` always. For Claude `K_hi = K`, so `L` and `L_pm` are computed from `K_prev` as in revisions 1 to 3. For Codex `K_hi = in(P)` can exceed `K_prev = c + cw`: with `P` at `in = 30000`, `c = 20000` and `C` at `in = 30000`, `c = 0`, `L = 30000`, not 20000. Because the lower bound `K_prev` does not decide `L`, a full reprocess of an implicitly cached prefix stays inside `L`. Required fixture: this Codex pair, asserting `tokens_upper = 30000`, that `L_if_unchanged = 20000` and `usd_point = null` (R8.2, R8.10), and that the aggregate `L_all` includes 30000 (R8.9). The dollar assertions run under `codex_tier_for_test = standard` (R3.4): `usd_hi` is the allocation of exactly these 30000 tokens (R8.6). In the default run `usd_hi = null`, `delta_status = tokens_only`, reason `modifier_unverified`, the pair counts in `EV_t`, and the token figures above are identical. Neither is a measurement: the log does not prove that the content of the prefix was unchanged. `L` is the only token bound used in the observational range.

R8.2. Observational lower bound. The log cannot show that a prefix was unchanged: the absence of a marker is not evidence of an unchanged prefix. Therefore the observational lower bound is always `L_lo = 0`, for every event. A separate, explicitly conditional metric `L_if_unchanged` is defined from the evidenced cache coverage only (R8.10): `D_lo = max(K_prev - R, 0)` and `L_if_unchanged = min(D_lo, W + U)` if no structural marker is observed between `P` and `C`, else `null`. `K_prev` is what the counters of `P` prove was cached (Claude `r + w`, Codex `c + cw`); for Codex the larger `K_hi_prev = in(P)` is an upper limit that may include content that was never cached, so it is never used here (example: `P` with `in = 30000` and `c = 20000`, `C` with `in = 30000` and `c = 0`: `L_if_unchanged = 20000`, not 30000, because only 20000 tokens are evidenced as cached). The metric also rests on the assumption that the read region is a prefix of the previous prefix (`read_region_is_prefix_of_previous`), which an unchanged prefix implies. Structural markers are: a diagnostics structural type (R10.3), `version` changed (Claude), `comp_hash` changed (Codex), a `compaction_or_clear` candidate of any level (R11.7: a confirmed or unbound Claude marker, a marker that predates `P`, or a Codex `compacted` record between `P` and `C`), `effort` changed on any model (R11.10), `speed` changed, and for Claude 2.1.293 agents a `toolsHash` or `model` difference where R10.6 applies. Whenever `L_if_unchanged` is not `null` the report prints assumption `no_marker_means_unchanged_prefix` next to it. `L_if_unchanged <= L_pm <= L` always. `L_if_unchanged` is never presented as a lower bound, never used in the observational range, and always labelled "if the prefix was unchanged".

R8.3. Tokens-only output. Every suspect event reports `L` (unconditional upper bound), `L_pm` (upper bound conditional on prefix match), `L_lo = 0` (observational lower bound) and `L_if_unchanged` (conditional, or `null`). This is always produced.

### 8.2 Dollar delta

R8.4. A dollar delta is produced only if all of the following hold, otherwise `usd = null` and `delta_status = tokens_only` with reason codes:

| Assumption | Reason code if false |
|---|---|
| A1: `P` and `C` are each priced: the model has a verified price row, every modifier is resolved and verified (R3.4, R3.10, R3.12; for Codex this includes the service tier, which is never verified in revision 9, so every Codex event is tokens-only) | `unpriced_model`, `unpriced_modifier` or `modifier_unverified` |
| A2: for Claude, `cache_creation` buckets present on `C` and `bucket_mismatch` false | `bucket_unknown` |
| A3: removed in revision 11 (a conflicted request taints its chain, R0.9, so no event of a conflicted request exists) | none |
| A4: the event is `suspect` and passed every eligibility check | not applicable (no event) |
| A5: `K_prev` and `K_hi_prev` rest on `P` counters only, never on diagnostics estimates | `diag_estimate_used` (a hard error if ever triggered) |
| A6: tier of `C` is the tier used (Haiku 5.5, Codex long context), no tier change between `P` and `C` | `tier_straddle` |

R8.5. Positional bucket allocation, valid only under assumption `read_region_is_prefix_of_previous`. The rebuilt tokens then sit directly after the read region, in position order. Claude: allocate to `w1` first, then `w5`, then `U`. Codex: allocate to `cw` first, then `U`. It is applied to `L_pm` and never to `L`, and it yields `usd_point` only when the coverage is known (R8.10). For each bucket `b` with allocation `L_b`:

```
delta_b = L_b * (p_b - p_read)
delta   = sum over b of delta_b
```

with `p_b` the input price for `U`, the 5m write price for `w5`, the 1h write price for `w1`, and for Codex the write price for `cw` and the input price for `U`. All `p_b > p_read` in the table, so each term is positive.

R8.6. Range. Compute these values with allocation caps `(w1, w5, U)` (Claude) or `(cw, U)` (Codex):

* `usd_hi`: the allocation of the unconditional `L` that puts the most tokens into the highest `p_b - p_read` bucket first, up to its cap, regardless of position. It assumes nothing about the read region. This is the observational upper bound. A test asserts `usd_if_unchanged_lo <= usd_point <= usd_hi` wherever all three exist, and `usd_if_unchanged_lo <= usd_hi` wherever the first two exist.
* The observational lower bound is `0`, because `L_lo = 0` (R8.2). It is not serialized as a field.
* `usd_if_unchanged_lo`: only when `L_if_unchanged` is not `null`: the allocation of `L_if_unchanged` (R8.2, built on `K_prev`, never on `K_hi_prev`) that puts the most tokens into the lowest `p_b - p_read` bucket first, up to its cap. Otherwise `null`.
* `usd_point`: only when `L_if_unchanged` is not `null` and the coverage is known (R8.10): the positional allocation of R8.5 using `L_pm`. Otherwise `null`. When the coverage is not known the point figure is not defined, because `L_pm` rests on `K_hi_prev`, which is an upper limit.

The observational range is `[0, usd_hi]`. The conditional range, shown only with its assumption, is `[usd_if_unchanged_lo, usd_hi]`. `usd_point` is printed in `--json` and `evidence` but not in the headline. The words "saving", "avoidable" and "cost you" are forbidden in output (R16.4).

R8.7. Forbidden dollar sources. Dollars are never computed from `cache_missed_input_tokens` or from any diagnostics token estimate. No rebuild delta is ever computed for `boundary` items (`model_switch`, `context_reset`, `subagent_cold_start`, `fork_inherit`, `first_observation`). This forbids the delta only: the list-price-equivalent cost of the boundary response itself is accounted normally under section 3 and R4.8, and is not a delta. A model switch is never priced as a saving at the new model's read price.

R8.8. Aggregation. Four event sets are defined for a window, nested: `EV_all` is every `suspect` event (count `E`); `EV_d` is the events of `EV_all` with `delta_status = ok` (count `E_d`); `EV_t` is `EV_all` minus `EV_d`, the tokens-only events (count `E_t`); `EV_c` is the events of `EV_d` whose `usd_if_unchanged_lo` is not `null` (count `E_cond`). So `EV_c` is a subset of `EV_d`, which is a subset of `EV_all`, and `EV_d` and `EV_t` partition `EV_all`. Every aggregate is a BigInt sum over exactly one named set, and a figure is never summed over a different set than the event count printed next to it:

| Aggregate | Sum of | Over |
|---|---|---|
| `L_all` | `tokens_upper` | `EV_all` |
| `L_d` | `tokens_upper` | `EV_d` |
| `L_t` | `tokens_upper` | `EV_t` |
| `hi_d` | `usd_hi` | `EV_d` |
| `hi_c` | `usd_hi` | `EV_c` |
| `clo_c` | `usd_if_unchanged_lo` | `EV_c` |

`usd_point` is not aggregated. The observational upper bound of the headline is `hi_d`, and its conditional range is `[clo_c, hi_c]`, both over `EV_c`, so the upper end of the conditional range is never the dollar bound of events that have no conditional lower figure. The headline reports `E`, `E_d`, `E_t` and `E_cond` (section 16).

R8.9. Target binding. Token, dollar and headline figures use one target (R8.1) and are tied by tests. For every event: the bucket allocation behind `usd_hi` sums to exactly `L` (the field `tokens_upper`); the allocation behind `usd_point` (when not `null`) sums to exactly `L_pm` (`tokens_upper_if_prefix_match`) and the one behind `usd_if_unchanged_lo` to `L_if_unchanged`; `L_if_unchanged <= L_pm <= L <= K_hi_prev`, `L_if_unchanged <= K_prev` and `L <= W + U`. For the aggregates of R8.8: `L_all = L_d + L_t`, `clo_c <= hi_c <= hi_d`, and each aggregate equals the sum of its field over its set, so no headline number rests on a different target or a different event set than the field it summarizes. Required fixtures: the Codex pair of R8.1 (implicit caching, `L = 30000`, `L_if_unchanged = 20000`, `usd_point = null`; the dollar equalities are checked under `codex_tier_for_test = standard`, and the default run checks that the token equalities hold with all dollar fields null) and a Claude pair (`K_hi = K`), each checked for all of these equalities, and a window with one event in each of `EV_c`, `EV_d` minus `EV_c`, and `EV_t`, checking every row of the aggregate table and that `hi_c` differs from `hi_d`.

R8.10. Known coverage. The coverage of `P` is known iff `K_hi_prev == K_prev` (BigInt). It is always true for Claude (`K_hi = K`). For Codex it is true only when `c + cw == in` for `P`, that is when the counters account for the whole input. When the coverage is not known (the normal Codex case), `usd_point` is `null` and `L_if_unchanged` is built on `K_prev` alone (R8.2). The report prints assumption `codex_cached_prefix_lower_bound_only` next to any Codex conditional figure. The conditional dollar floor therefore never exceeds what the evidenced cached tokens would cost, and an unknown coverage never turns the upper limit `K_hi` into a lower bound.

## 9. TTL

### 9.1 Claude

R9.1. TTL class comes from write buckets only: `w5 > 0` means 5m, `w1 > 0` means 1h. Recon: main chains write 1h only, subagent and workflow chains write 5m only, no request mixes. The implementation MUST NOT assume this and MUST handle mixed buckets.

R9.2. Chain TTL set. The log does not say which cache entry a read used, where an inner breakpoint was last touched, or whether the tokens read are a prefix of the previous prefix (R8.1 assumes none of this either). So no per-position class is carried from one request to the next. For each chain keep one set `TTLS` over all requests of the logical stream up to and including `P`, in stream order, with baseline requests (R5.10) and replayed requests (R4.7, which carry the counters of the owner's copy) included: `w5 > 0` of a request adds `5m`; `w1 > 0` adds `1h`; `w_unknown_ttl > 0` sets the flag `ttl_unknown`. The flag `ttl_unknown` is also set by a request whose read cannot come from the chain's own cache, that is `R_X > K(prev(X))` where `prev(X)` is the previous request of the stream (`K = 0` when there is none, so a first request with `R > 0` sets it), because the entry read may have another TTL. A request with unreliable counters taints its chain (R0.9), so no TTL statement rests on one. The pair class is `unknown` if `ttl_unknown` is set or `TTLS` is empty; else `5m` if `TTLS = {5m}`, `1h` if `TTLS = {1h}`, `mixed` if `TTLS = {5m, 1h}`.

R9.3. Touch assumption. Every entry of the chain is treated as last touched at or before `P` (a later touch by another chain is not visible, R9.5). Contact intervals are not tracked per entry; the gap is taken from `P` only, so a miss is never attributed to an inner entry whose own last contact is older than `P` and unknown. The report prints assumption `ttl_touch_is_previous_request`.

R9.4. Expiry test for a suspect event or a `grey` pair. The largest TTL that any entry of the chain may have is `T_hi`:

| Class | `T_hi` |
|---|---|
| `5m` | `C6` |
| `1h`, `mixed`, `unknown` | `C7` |

The `mixed` and `unknown` rows rest on the assumption that Claude offers only the 5m and 1h options, printed as assumption `claude_ttl_options_5m_1h`. Then:

* `expiry_compatible` iff `gap_min` is known and `gap_min > T_hi`: even the entry with the longest possible TTL, last touched no later than `P`, had expired when `C` started.
* Otherwise `expiry_ambiguous`. If `gap_min` is unknown the pair has no TTL statement (`ttl_gap_unknown`).

There is no `expiry_excluded` statement and the output enum has no such value. An exclusion would have to show that the entry `C` could have matched was touched recently, but the entry `C` would have matched depends on content that is not logged, and an inner breakpoint entry can have been last touched long before `P` while `P` touched only a longer entry, so a short gap from `P` proves nothing about it (Q26). Examples: a chain with an early `1h` write and later `5m` writes has class `mixed`, `T_hi = C7`, and a gap of 400 s is `expiry_ambiguous`; a chain whose first request already read `R > 0` is class `unknown` and a gap of 400 s is `expiry_ambiguous`; a chain with only `5m` writes and a gap of 330 s is `expiry_compatible`, and a gap of exactly 300 s is `expiry_ambiguous`. Only `expiry_compatible` creates a `ttl_expiry_compatible` candidate. The C4 and C5 offsets of revision 1 do not exist, and a bound the provider validation of R6.8 rejects is unknown (`gap_min` unknown). Required fixtures: the three chains above on both sides of `T_hi`; a chain whose pure-read `P` follows an old inner `1h` write (class `mixed`, never compatible below 3600 s); a pair whose read comes from a different prefix (first request with `R > 0`, class `unknown`); and an assertion that no output ever carries an exclusion value.

R9.5. A time-based cause is at most `ttl_expiry_compatible` (a hypothesis, R11.3). It MUST NOT be `confirmed`, because request start is inferred and refresh by an intermediate hit on a different chain is not visible.

### 9.2 OpenAI

R9.6. TTL by model family for Codex.

| Model family | `T_hi` (compatibility only) |
|---|---|
| `gpt-6*`, `gpt-5.6*` | `C8` (30 minutes; the docs say eligible at least 30 minutes after the latest write or reuse, so `gap_min > C8` is compatible, not proof, because no maximum is documented, Q10) |
| `gpt-5.5`, `gpt-5.4`, `gpt-5.2`, `gpt-5.1*`, `gpt-5`, `gpt-5-codex`, `gpt-4.1` | `C9` (retention is `in_memory` up to 1 hour or `24h` and the setting is not logged, so the larger value is used) |
| any other model | undefined, no TTL statement |

The compatibility test of R9.4 applies with these values, and like R9.4 there is no exclusion statement. Codex `gap_min` is always unknown (R6.5), so in revision 5 the test cannot succeed and no Codex `ttl_expiry_compatible` candidate is emitted (`ttl_gap_unknown`). The table stays so that a later revision with a structural Codex start bound (Q27) can use it unchanged. The chain TTL set of R9.2 is not used for Codex (write buckets carry no TTL class, R2.11).

R9.7. Codex reads and writes both refresh retention. All entries of the chain are treated as last touched at or before `P`, same as R9.3.

R9.8. The TTL class is never collapsed: `mixed` is never reported as `5m` or `1h`, and the output field `ttl_class` takes the values `5m`, `1h`, `mixed`, `unknown`, `openai_30m`, `openai_unknown`.

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
| `confirmed` | A direct local marker that by documented mechanism determines the invalidation: only a Claude `compact_boundary` marker that is bound under R11.7 (the lineage walk from `C` reaches `P` through the summary and the boundary, with strict time order and the same chain). A Codex `compacted` record is never `confirmed`. An API diagnostics type is never `confirmed` (R10.4); it is `observed` as a report and at most `hypothesis` as a cause. |
| `unknown` | No candidate with any signal. |

R11.2. Caps. Pairs of tainted chains (R0.9), ambiguous replay ownership included, abstain before any level is assigned, so no cap for them is needed. Any class that has not met the G3 bounds (R12.7) is capped to `hypothesis` (low) in default output, and the docs list it as uncalibrated.

R11.3. Confidence of a hypothesis, deterministic: `high` if exactly one candidate has a signal and the signal is a hard field (API diagnostics type with the counters condition of R10.4). A version difference alone is not a hard field (R11.5); `medium` if exactly one candidate has a signal and it is soft (expiry compatibility, partial-hit pattern); `low` if two or more candidates have signals, or the class is uncalibrated.

R11.4. Multiple candidates are always kept. Output has `candidates` (all, ordered by the precedence list below) and `primary`. `primary` is the candidate with the highest level, then highest confidence, then earliest in the precedence list. If the top two candidates tie on level and confidence, `primary = null` and the event is shown as `multiple`.

Precedence: `compaction_or_clear`, diagnostics-reported causes (`model_switch`, `tools_or_system_changed`, `context_edit_or_prune` with a diagnostics signal), `model_switch`, `tools_or_system_changed`, `request_settings_changed`, `ttl_expiry_compatible`, `fork_inherit`, `context_edit_or_prune`, `unknown`.

### 11.2 Signals per cause

R11.5. Each row gives the exact signal and the highest level it can reach. A cause row applies to a `suspect` event, or to a boundary when the row says so.

| Cause | Exact signal | Max level |
|---|---|---|
| `model_switch` (boundary, not a rebuild event) | `model(C) != model(P)` in the same chain, both verified (R2.10, R7.2 E2). Per-model caches are documented. | `observed`; a `diag.type = model_changed` on the same pair adds `hypothesis` high as a cause note, still a boundary |
| `tools_or_system_changed` | (a) `diag.type` in `{tools_changed, system_changed}` with the counters condition of R10.4; (b) Claude `version(C) != version(P)`; (c) Codex `comp_hash(C) != comp_hash(P)`, both non-null | (a) `hypothesis` high (API report, comparison basis unverified, R10.4); (b) `hypothesis` low, never higher on the version difference alone: the Claude Code caching documentation (source C1) describes a resumed session as keeping its earlier system prompt by default, so a version difference does not show that the system prompt or tools changed, and the real cause after an upgrade can be expiry or anything else. The difference is also recorded as the observed fact `version_changed`. A higher level needs a structural change on the same request pair, namely signal (a), in which case the candidate takes the level of (a); (c) `hypothesis` low (the meaning of `comp_hash` is inferred, Q15) |
| `request_settings_changed` (added to the plan taxonomy) | Claude: `effort` differs between `P` and `C`, or `usage.speed` differs. Codex: `turn_context.effort` differs. The documented effort preservation of Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1, and the documented preservation across speed changes after the first fast activation, hold only in environments that the log does not show (R11.10), so they are never assumed. | `hypothesis` medium for an effort change on a Claude model that is not one of the four, and for a Codex effort change. `hypothesis` low for an effort change on one of the four models and for any `speed` change (capped by R11.10) |
| `ttl_expiry_compatible` | `expiry_compatible` per R9.4 or R9.6 | `hypothesis` medium, never `confirmed` (R9.5) |
| `compaction_or_clear` | Claude: a `compact_boundary` record bound to `C` under R11.7 (lineage walk, strict time order, same chain), or an unbound marker as described in the Max level column. Codex: an own `compacted` record whose ordinal lies between the ordinals of the usage records of `P` and `C` in an `ordinal_verified` stream (R11.7); it is never bound to `C` | Claude: `confirmed` only if bound (R11.7); otherwise `hypothesis` low at most: `compaction_marker_unbound` when a marker of the same stream lies strictly between the two request times and binding failed (including any `unknown` walk), `compaction_marker_predates_previous` when the walk met a summary whose boundary predates `P`. Codex: `hypothesis` low at most, never `confirmed` |
| `subagent_cold_start` (boundary) | row 2 of the table in R11.8: `C` is the first request of a `linked(verified)` chain of kind `subagent` (never `workflow_agent`, R5.4), whatever its cache read `R` is | `observed` |
| `fork_inherit` (boundary) | row 1 of the table in R11.8: `C` is the first own request after a replayed prefix (R4.8, R4.9). It is only a boundary, never an event | `observed` |
| `first_observation` (boundary) | row 3 of the table in R11.8: `C` is the first request of a `main` chain with no earlier data, or of an `unlinked` or `linked(directory)` agent chain, or of a workflow agent | `observed` |
| `context_edit_or_prune` | partial hit: `0 < R < K_prev` and `S < C1`, or `diag.type = messages_changed` with the counters condition. The Claude record field `input_transformations` (thinking dropped) is present on about three quarters of all records, so it carries no signal and MUST NOT be used. | partial-hit signal: `hypothesis` low; with `messages_changed`: `hypothesis` high (R10.4) |
| `unknown` | none of the above has a signal | `unknown` |

R11.6. Boundaries. `model_switch`, `context_reset` (E8), `first_in_chain` types (`subagent_cold_start`, `fork_inherit`, `first_observation`) are cache boundary events. They are listed in the timeline, counted in the headline under "cache boundaries", get no rebuild delta, and are not counted as suspected rebuilds. The response of a boundary is still a billed response and is accounted in totals and dollars like any other (R4.8, R8.7). The boundary type of a response is chosen only by the table in R11.8, and only for a request that passed the gate E0 of R7.2: a request of a tainted chain (R0.9) or in an order tie gets no boundary of any type.

R11.7. Compaction binding. Claude: let `b` be a `compact_boundary` record and `s` a record with `isCompactSummary = true` whose `parentUuid` is `b`. The binding is decided by a lineage walk, not by the presence of a marker or of a summary near `C`. The walk starts at the earliest copy of `C`, follows `parentUuid` edges through the global uuid index and, at a `compact_boundary` record (which has no `parentUuid`), continues through its `logicalParentUuid`. It counts each followed edge as one hop, keeps a visited set and notes the first pair `(s, b)` it meets, in that order. It stops at the first record that is a copy of `P` (a record with the request key of `P`) and returns exactly one result. `lineage_found`: within `C27` hops it met a copy of `P` and, before it, a pair `(s, b)`. `lineage_clear`: within `C27` hops it met a copy of `P` and no summary on the way (no compaction on the path from `P` to `C`). `lineage_off`: within `C27` hops it reached a chain root without meeting a copy of `P`, so `P` is not an ancestor of `C` (a branch switch, a rewind or a reuse of other context). `unknown`: the limit `C27` was reached first, a record was visited twice (a cycle), or a `parentUuid` or `logicalParentUuid` did not resolve (a uuid that names records with different retained fields does not resolve, R6.3). A limit, a cycle or an unresolved uuid is never read as absence. An old summary that lies on the ancestry of `C` proves only that `C` descends from that compaction, not that a compaction happened between `P` and `C` (after `/rewind` or a return to an older branch the old summary is found from `C` while `P` ran on another branch, and the miss may be the expiry of that other branch).

`b` is bound to `C` (and the candidate is `confirmed`) iff all of the following hold: (i) the result is `lineage_found`; (ii) the marker was created in this transition, in strict time order: `t_last(P) < t(b)`, `t(b) <= t(s)` and `t(s) < t_first(C)`, with `t_last(P)` the greatest and `t_first(C)` the least `timestamp` over the copies (R4.2); an equal timestamp does not bind; (iii) `b`, `s`, every record met on the walk, `P` and `C` belong to the same logical stream and the same chain (same `sessionId`, same `agentId` or main, same `isSidechain`, R4.11); (iv) the walk met no record of a request other than `P` and `C` (a lineage that passes through another request is a different pair, R6.2); (v) `compaction_size_inconsistent` (below) does not apply. These conditions are structural: the walk shows that the context of `C` is the summary of the lineage that ends in `P`, the strict times show that the marker was written after `P` and before `C`, and a branch switch, a rewind or a reuse of an older context gives `lineage_off` or a time order that fails (ii). Every other combination leaves `b` unbound and the candidate is never `confirmed`. It is then at most `hypothesis` with `confidence` low, in two forms: `compaction_marker_unbound`, when a `compact_boundary` of the same logical stream has `t_last(P) < t(b) < t_first(C)` but the binding failed (including any `unknown` result), and `compaction_marker_predates_previous`, when the walk met a summary whose boundary has `t(b) <= t_last(P)`, whatever the walk result (the marker predates `P`, so it cannot be the cause of the miss between `P` and `C` by itself). Presence of a `compact_boundary` in the same file is not sufficient. Required fixtures for the walk and the conditions (each shuffled and split at every line boundary, R4.10): a clean lineage `P`, boundary, summary, `C` with strictly ordered times: `lineage_found`, bound and `confirmed`; the return to an old summarized branch: `P` on branch X without a summary, an older summary `s_old` with `t(b_old) < t(P)` on branch Y, `C` continuing from Y, so the walk from `C` meets `s_old` and never meets `P` (`lineage_off`), with a variant in which the cache of branch Y has expired and one in which it has not: unbound, `compaction_marker_predates_previous` low, never `confirmed`; a new compaction after a rewind, with `t_last(P) < t(b) < t_first(C)` but `b` descending from a record before `P` (`lineage_off`): unbound, `compaction_marker_unbound` low; `t(b)` equal to `t_last(P)`, and `t(s)` equal to `t_first(C)`: unbound; a lineage in which the path from `C` to `P` meets another request: unbound; `b` or `s` in another `sessionId` or `agentId`, and a sidechain record on the path: unbound; a path of exactly `C27` hops to `P` (`lineage_found`) and of `C27 + 1` hops (`unknown`); a cycle and an unresolved `parentUuid` or `logicalParentUuid` on the path: `unknown`, unbound; the rewind case with the path from `C` to `P` longer than `C27` hops: `unknown`, unbound, low, never `confirmed`. Codex: a `compacted` record is never bound to a request and never confirms. The log orders a marker against the next usage record only by position, and a request that started before the compaction can be logged after it with an independent miss; the field `compaction_response_id` names the compaction call itself, not any request, and no retained field says which context a request used (Q28). The only Codex signal is therefore a low hypothesis: an own `compacted` record (not in a copied prefix, R4.9) whose `ordinal` lies strictly between the ordinals of the usage records of `P` and `C` (the stream is untainted, so its ordinals are verified, R0.9, R4.12) gives the candidate `compaction_or_clear` at `hypothesis` low (`compaction_marker_unbound`). Otherwise no candidate. Required fixtures: a marker followed by the usage record of a request that started before the marker (independent miss): candidate low, never `confirmed`, and the same result under shuffling and every split of R4.10; a stream with a missing ordinal: tainted, no candidate. A `compact_boundary` whose `preTokens` and `postTokens` are present but where `ctx(C)` exceeds `postTokens` by more than `K_prev` (BigInt) is flagged `compaction_size_inconsistent` and stays unbound.

R11.8. Boundary decision table. This is the only place that chooses a boundary type; R4.8, R5.7, R7.2 and R11.5 refer to it. The enum is exactly the boundary `type` enum of R14.5: `model_switch`, `context_reset`, `subagent_cold_start`, `fork_inherit`, `first_observation`. Rows are tested in order for a request `C` that passed the gate E0 of R7.2 (a request that fails E0 is never tested here and gets no boundary), and the first row that matches decides.

| Row | Condition on `C` | Result |
|---|---|---|
| 1 | `C` is the first own request after a replayed prefix: Claude, `P(C)` is a replayed request (R4.8); Codex, `C` is the first request of a fork stream (R4.9). Applies even if the chain is also a `linked(verified)` subagent | boundary `fork_inherit` |
| 2 | `C` has no `P` in its logical stream, the chain is of kind `subagent` and `linked(verified)` (R5.3, R5.6), and row 1 does not apply | boundary `subagent_cold_start`, whatever `R` is. The name marks the start of the chain's own context, not an empty cache: a first response that already carries a cache hit keeps this type and reports the hit in the boundary field `r`. It is never inferred from `R == 0` or `R < M` |
| 3 | `C` has no `P` in its logical stream and rows 1 and 2 do not apply: first request of a `main` chain with no earlier data, of an `unlinked` or `linked(directory)` agent chain, or of a workflow agent (R5.4). A new session file after `/clear` is indistinguishable from a new session and lands here (Q8) | boundary `first_observation` |
| 4 | `P` exists, E1 passed, and `model(P) != model(C)` with both verified (R7.2 E2, which runs after the gate E0) | boundary `model_switch` |
| 5 | `P` exists, passed E1 to E7, and `ctx(C) < K_prev` (R7.2 E8) | boundary `context_reset` |

There is no separate `cold_start`, `after_reset` or `first_in_chain.kind` value: a request after a bound compaction is a `context_reset` boundary in row 5 if the context shrank, otherwise an ordinary pair where `compaction_or_clear` is a candidate cause (R11.5). `first_in_chain` is only a name for the family of rows 1 to 3. If none of the rows matches, the pair goes on to the numeric condition of R7.5.

R11.9. Counts by level in the headline sum to the number of suspected rebuild events, with no event counted twice.

R11.10. Environment scope of cache-preservation claims. The official Claude Code caching page (source C1) states the preservation of the cache across an effort change on some models, and across a speed change after the first fast activation, together with environment exceptions (Bedrock, a gateway, the caching beta disabled, HIPAA-type configurations). The log carries no field for the route, the beta state or the compliance mode, so cachewhy cannot verify the environment of a request. Rule: preservation is never assumed. A change of `effort` or `speed` stays a candidate signal for `request_settings_changed` at the levels of R11.5 (low where preservation is documented), and it is a marker for R8.2. The claims of `docs/accuracy.md` about N4 and P5 are worded as holding in the tested environment recorded in the run manifest (R12.2), never as general facts. Required fixtures: an effort change on a listed model with a miss gives the candidate at `hypothesis` low, and a speed change with a miss gives it at `hypothesis` low.

## 12. Controlled experiments and accuracy gates

### 12.1 Experiment design

R12.1. Ground truth comes only from controlled single-intervention runs. LLM labelling is not ground truth. Natural logs are never used as labelled data (R12.9), and this includes natural requests that carry API diagnostics (R12.10). A label is only a ground truth for a run if the effect check of R12.3 passed.

R12.2. Fixed per-run settings, recorded in the run manifest: product version (exact), model id, TTL class (set explicitly with `CLAUDE_CODE_PROMPT_CACHE_TTL` for the main bucket, and the explicit subagent TTL variable for subagent runs), `FORCE_PROMPT_CACHING_5M` unset or set, effort, fast mode off, MCP and plugin set, permission mode, working directory content, prompt text (synthetic filler of at least `C30` times the model's minimum cacheable length plus a fixed run nonce so concurrent runs cannot share cache entries), and the environment conditions of R11.10 as enums: route (`first_party_direct`, `bedrock`, `gateway`, `other`), prompt-caching beta state (`default`, `disabled`), compliance mode (`none`, `restricted`), and the fast mode state at each step. N4 and P5 are valid only when the manifest says `first_party_direct`, `default` and `none`; a run in another environment is dropped by manifest and reported, and the result of N4 is reported for the tested environment only.

R12.3. Run protocol. Step 1 cold write. Step 2 warm hit: this is the warm-hit precondition and it is measured with the harness's independent counters, in BigInt (R2.16): `R_2 >= C22 * Kb_1`, that is `10 * R_2 >= 9 * Kb_1`, together with the cache coverage conditions below. Cache coverage conditions. The ratio test alone is satisfied by a run with no cache at all (for example `K_1 = R_2 = W_2 = R_3 = 0` passes the warm-hit test, the `miss` test and the `hit` test), so the warm-hit precondition also requires, before any intervention: (a) `R_2 > 0`, a real warm read; (b) a baseline `Kb_1 >= max(M, C3)`, where `Kb_1 = K_1` for Claude and, for Codex, `Kb_1 = in_1`, the processed input of the step 1 response, because Codex reports no implicit write (R7.1): `K_1` is 0 on a cold Codex step, and an unreported implicit write is never used as the denominator evidence of a warm hit; (c) `10 * R_2 >= 9 * Kb_1` instead of the ratio on `K_1` alone; (d) `K_2 >= max(M, C3)` with `K_2 = R_2 + W_2`. `M` is the table minimum of the model; a model without `M` makes the run invalid. With (a) to (d), `K_2 > 0` holds in both criteria below and a zero-cache run is discarded with reason `no_cache_coverage`. Required fixtures: the all-zero run, a Claude run with `R_2 > 0` but `Kb_1 < max(M, C3)`, and a Codex run with `cw = 0` and a positive implicit read (`c_2 > 0`, `10 * c_2 >= 9 * in_1`): the first two are discarded, the third is kept.

A run that fails the precondition is discarded before any intervention and recorded in `discarded_runs` with its reason (`warm_ratio`, `no_cache_coverage`). Discard rate is published. Step 3 intervention: exactly one change, applied between step 2 and step 3. Step 4 optional recovery check. The manifest records the intervention timestamp and the expected observation, which is stated before the run.

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
| P5 | Claude | change effort on a model that invalidates on effort change | `request_settings_changed` | valid only under the manifest conditions of R12.2 |
| N4 | Claude | change effort on Opus 5.5, Sonnet 5.5, Haiku 5.5 or Fable 5.1 | no event | documented as cache-preserving in a direct first-party environment only; valid only under the manifest conditions of R12.2 and R11.10 |
| P6 | Claude | `/compact` | `compaction_or_clear` | only if drivable in headless mode for the pinned version; otherwise the class is excluded from claims |
| N5 | Claude | spawn a subagent from the main chain and continue | main chain: no event; subagent chain: boundary `subagent_cold_start` | parent cache is documented to stay intact |
| P7 | Codex | change `reasoning.effort` via exec resume | `request_settings_changed` | |
| P8 | Codex | switch model | boundary `model_switch` | |
| P9 | Codex | wait 1860 s on a `gpt-6*` or `gpt-5.6*` model | `ttl_expiry_compatible` | not claimable in revision 5: Codex `start_lo` is unknown (R6.5), so cachewhy cannot emit this class for Codex. The scenario is kept for a later revision and is not run for any claim |
| N6 | Codex | wait 1500 s same model | no event | shorter than 30 minutes |
| N7 | Codex | no change, immediate continue | no event | baseline |

Effect criteria (R12.3): P1 to P9 (P9 only if a later revision makes it claimable) use `miss` (P3 and P8 are boundary scenarios whose intervention also must show `miss`). N1 to N4, N6 and N7 use `hit`. N5 uses `hit` for the main chain and `miss` for the first request of the subagent chain. The wait times and all other parameters in this table are scenario parameters frozen under section 0.4. In a positive or boundary scenario, "expected" is the label that is scored; it is scored only on runs with `effect_verified`.

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
| `modifier_unverified` | R3.12 Claude requests without a final copy, and every Codex response (service tier not observable, R3.4): cachewhy reports their tokens and no dollars, while ccusage prices them. They are outside the common priced set of the cost comparison |
| `chain_tainted` | responses of tainted chains (R0.9): cachewhy reports their tokens and no dollars, so they are outside the common priced set |
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
| `table_version` | string matching `^pt-[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]+)?$`, the `table_version` field of `pricing/table.json` verbatim (for example `pt-2026-10-09.2`, which uses the optional suffix); a test asserts that the shipped table version matches the pattern and that the report copies it unchanged |
| `window` | `{since: ISO, until: ISO}` |
| `headline_status` | enum `ok`, `withheld` |
| `withheld_reason` | enum or null (R17.3) |
| `assumptions` | array of enum codes |
| `coverage` | object named in section 17: counts of files, lines, records, requests, pairs, links and streams as non-negative integers, and every token amount as a decimal string (R17.1) |
| `totals` | array of per-provider objects: provider enum, request counts by kind, token sums by bucket as decimal strings (BigInt, R2.16), `usd` integer picodollars as decimal string or null, `tokens_unpriced` as a decimal string |
| `events` | array of event objects |
| `boundaries` | array of boundary objects |

Event object: `id` (`e<N>`), `provider`, `kind`, `chain`, `model`, `t` (ISO), `gap_min_s`, `gap_max_s` (integers or null), `k_prev`, `k_hi_prev`, `r`, `w`, `u`, `d` (these six as decimal strings, BigInt; `k_hi_prev` is `K_hi(P)` of R7.1, `d` is the reported shortfall of R7.5), `reuse_ratio` (number, 3 decimals, display only, no decision reads it, R2.16), `outcome` (enum), `abstain_code` (enum or null), `ttl_class` (enum), `candidates` (array of `{cause, level, confidence, signals[]}` with enum values), `primary` (cause enum or null), `diag` (`{type enum, missed_tokens_reported decimal string or null, role const}` or null), `delta` (`{tokens_upper, tokens_upper_if_prefix_match, tokens_lower, tokens_if_unchanged, usd_hi, usd_if_unchanged_lo, usd_point, status, reasons[]}`; `tokens_upper` is `L` and `tokens_upper_if_prefix_match` is `L_pm` (R8.1), token values as decimal strings because they are BigInt; `tokens_lower` is always 0 (R8.2); `tokens_if_unchanged`, `usd_if_unchanged_lo` and `usd_point` are conditional and null when R8.2 gives null; money as decimal strings or null), `linkage` (enum), `model_source` (enum from R2.10, which includes `own_turn_unsettled` and `chain_tainted`, or `claude_explicit`), `gap_basis` (enum `parent_record`, `none`; Codex is always `none`, R6.5). Boundary objects carry the same identifying fields, the cache read `r` of `C` as a decimal string, and a `type` enum (`model_switch`, `context_reset`, `subagent_cold_start`, `fork_inherit`, `first_observation`), which is the complete set chosen by the table in R11.8.

R14.6. Errors and debug. Error and warning messages are built from enum codes, integers (counts, line numbers) and opaque file labels (`file_<N>`). They MUST NOT contain raw lines, raw JSON error messages (R1.3), file paths, directory names, raw ids or exception text from I/O or parsing. The `doctor` command prints coverage and drift counters only. A debug flag, if present, follows the same rule. Terminal output passes through a sanitizer that removes C0 and C1 control characters, ESC sequences and bidirectional control characters from any string that is not an enum or tool-generated id.

R14.7. Canary tests. The fixture generator plants secrets of the form `CANARY_<random hex 16>` in: message text, tool input and output, `cwd`, branch name, slug, title, agent description, `meta.json` description and worktree path, file and directory names, model field values, `version` values, unknown extra keys in `usage`, unknown record types, truncated JSON lines whose truncated part contains a canary, and values of the fields that R1.2 drops. The suite runs every command (`default`, `session`, `evidence`, `doctor`, `pricing`, `--demo`, `--json`, errors forced by corrupted input) and asserts that stdout, stderr, the written JSON files and the evidence files contain no canary, nor its lowercase, uppercase, base64, URL-encoded or any substring of 8 or more characters. The same scan runs on the `npm pack` tarball and on the repository tree in CI.

R14.8. Package audit. `npm pack --dry-run --json` output is compared with an allowlist of files (`dist/`, `README.md`, `LICENSE`, `package.json`, the demo data directory). Any other path fails. `dependencies` MUST be empty. The repository contains only synthetic fixtures or anonymized experiment fixtures, and CI fails if a fixture contains any key outside the schema in R1.2 or a string longer than 64 characters that is not an id or enum.

R14.9. Writes. cachewhy writes only to a path the user passed with `--out`, and never writes caches, telemetry or temp files containing log-derived data.

## 15. Release gates

### 15.1 Gates

R15.1. Gate PASS means: an audit by `gpt-6.1-sol` at high effort (backup `gpt-6-sol` high) with the audited content embedded in the prompt (sandbox locks block file reads), a verdict of PASS, zero open P0 and P1 findings, and a log entry in `docs/audit-log.md` with date, audited commit sha, sha256 of the embedded content and the verdict. The audited revision is committed, or its exact bytes are saved, before the audit starts, so that sha and hash are computed by script from those bytes and never reconstructed; an entry for a round whose text was not saved states `not recoverable` and can never support a PASS. Accounting and privacy findings cannot be waived. Each gate requires the previous gate PASS.

G0 has two parts and passes only when both pass. An audit that did not receive the content of a part cannot pass it, and the log entry states which parts were embedded.

* G0-spec: this specification.
* G0-pricing: the full versioned content of `pricing/table.json` (prices as decimal strings, `modifiers`, `service_tier` entries, per-model minimum cacheable lengths `M`, long-context and tier entries, `source_url`, `verified_at`), the source citations for every row, and the pricing rules R3.1 to R3.11 and R7.2. The audit checks each price, modifier rule and minimum length against its source, and checks that the R3.2 ratio test and the R3.7 expectation list hold for the table. It also checks, for every long-context object, its prices and, separately, its `scope`, `scope_verified` and `scope_source_id` (R3.10); the fast and geo combination (`fast_with_geo_us`) and the geo applicability of every fast row; that every `modifiers.*` object carries a boolean `verified` (R3.1); that every model of the R3.7 list, of the R7.2 minimum-length list and of the recon (Mythos 5 included) has either a priced row or an explicit no-price entry, rechecked against the current pricing page at each audit; that the `verified` flag matches what the cited current page states; and that explanatory prose in `docs/pricing.md` (for example a statement that an official page publishes no exact price, or that a combination is not documented) matches the flags; a mismatch between prose and flags, or a stale statement, is a G0-pricing finding. A refresh of prices, flags or scopes is a new table version (`pt-...`), never an in-place edit of an audited version. The behavior of cachewhy depends only on the flags, never on the prose. `pricing/table.json` is added at D1; until it exists, G0-pricing is `not run` and G0 cannot PASS.

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

R15.7. Version matrix behavior. Version status is a property of the record set. Claude: a request key is of a supported version iff every copy of it in the scan carries a `version` that has full support in section 0.2. Codex: let `V(S)` be the set of `cli_version` values of every `session_meta` record with `id = S` anywhere in the scan, own or copied, a missing or unparseable value counting as `unlisted`; the stream `S` is of a supported version iff `V(S)` is non-empty and every member has full support, and a `token_usage_record` has the status of the stream of its own `thread_id`. File order, line order, duplication and splitting change neither status. For a request of an unverified version the dedup, copy-selection and ownership semantics of R4 are not verified, so no accounting is derived from it: it adds nothing to totals, dollars, events, boundaries, links, the chain TTL set (R9.2) or the headline denominators. It is counted in `requests_unverified_version` (distinct keys, counted without selecting copies) and its lines in `lines_unverified_version` (Claude: records whose `version` lacks full support; Codex: `token_usage_record` lines whose own `thread_id` names a stream of an unverified version, a record-level count that no split changes), and the report prints assumption `unverified_version` and the version strings in the bounded form of R1.2 with counts. Its chain is tainted (R0.9 `version_unverified`), and with it the chain's family, so no request of a supported version yields an event, boundary, verified model or dollar next to a request that was not analyzed. Structural reads: every file is parsed with the same readers and the same allowlist (R1.2), whatever its version, to read identities, versions, `forked_from_id`, parent thread ids, turn ids and `turn_context` models. These reads feed only the family relation, `FS` (R4.13), `TM(T)` (R2.17 (d)) and the taint of R0.9, all of which can only withdraw output; they are never printed, and no accounting, link, stream or verification exists because of them. A record of any version whose chain key cannot be read is `unattributed_record` (R0.9) and taints the whole provider. Required fixtures: fixtures (1) and (2) of R0.9, and a coverage-only file whose `session_meta` forks the id of a supported file that has an own `session_meta` and no `token_usage_record` (that supported file is copy-exposed, and the coverage-only file adds nothing to any total). Adding a version to the full-support table needs a synthetic fixture for it and a spec revision.

## 16. Headline format

R16.1. Template. Fields in angle brackets are computed; the denominator is always printed. The first line is printed only when, for a provider, `10 * families_tainted > 3 * families_total` or `10 * tokens_in_tainted_chains > 3 * total_tokens` (`C36`, BigInt), and it then precedes every other line; the shares are printed per provider in coverage in every report.

```
Warning: <f_t>% of <provider> session families and <k_t>% of <provider> tokens are tainted (R0.9); events, boundaries and dollars below cover only the rest.
<since> to <until> (UTC). <N> responses: <n_main> main, <n_sub> subagent, <n_wf> workflow, <n_cx> Codex.
Cache read: <p>% of <T> input tokens (Claude: input + cache read + cache write; Codex: input).
List-price equivalent: $<A> at table <table_version> over <N_priced> of <N> responses; <U>% of tokens unpriced; output excluded for <V> responses with unknown output.
Cache boundaries: <b1> model switches, <b2> context resets, <b3> cold starts, <b4> first observations, <b5> fork inheritances.
Suspected prefix rebuilds: <E> from <E_elig> eligible pairs (<E_abs> abstained, <E_grey> grey); <n_ct> of <n_ch> chains tainted (R0.9), their <N_ct> responses tokens only; <n_live> live session families skipped.
By evidence: <E_c> confirmed, <E_h> hypothesis (<hh> high, <hm> medium, <hl> low), <E_u> unknown.
Counterfactual delta, assumption-bound: up to $<hi_d> (observational bound, lower bound $0) over <E_d> events (<L_d> tokens, sum of the unconditional upper bound L of R8.1); <E_t> events tokens-only (<L_t> tokens, same bound).
If the prefix was unchanged (assumption no_marker_means_unchanged_prefix): $<clo_c> to $<hi_c> over <E_cond> of those <E_d> events (the same <E_cond> events in both figures).
```

R16.2. The list-price-equivalent figure and the counterfactual delta are on separate lines and are never added together or summed in one number. Claude and Codex percentages are also printed per provider. With revision 9 the Codex part of every dollar figure is zero and the Codex tokens are in `tokens_unpriced` (R3.4, service tier), so `<U>%` and the `partial` prefix of R3.9 (decided per provider) reflect them.

R16.3. The counts satisfy `E = E_c + E_h + E_u`, `E_h = hh + hm + hl`, `E_d + E_t = E`, `E_cond <= E_d` (the conditional-line event count never exceeds the events with a dollar delta), and, for the aggregates of R8.8, `L_all = L_d + L_t` and `clo_c <= hi_c <= hi_d`. A test asserts them. The names `hi_d`, `hi_c`, `clo_c`, `L_d` and `L_t` are the sums of R8.8 over `EV_d`, `EV_c` and `EV_t`. "Observed" appears in the event listing, not as a fourth headline category, because every event is observed by definition (counters).

R16.4. Forbidden words in headline and docs text produced by the tool: "avoidable", "saving", "saved", "wasted", "cost you", "overspend". The word "equivalent" accompanies every dollar figure.

R16.5. If `headline_status = withheld`, the headline is replaced by `Headline withheld: <reason code>`, and coverage is still printed.

## 17. Coverage and schema drift

R17.1. `coverage` counters. Counters of files, lines, records, requests, responses, pairs, links and streams are non-negative integers (they are bounded by the size of the input and stay far below the safe integer range). Every counter that holds a token amount is a decimal string of a BigInt, never a JSON number: `tokens_unpriced`, `tokens_in_incomplete_responses`, `tokens_in_invalid_responses`, `tokens_in_tainted_chains`, `tokens_live_skipped`, and each bucket of `unlogged_tokens_estimate` (R17.5). Any future coverage field that holds tokens follows the same rule, and the schema rejects a JSON number in these fields. Required test: a lossless round trip, with each token-amount field set to `Number.MAX_SAFE_INTEGER + 2`, to `2^64 + 1`, and to the sum of many counters at `Number.MAX_SAFE_INTEGER`, serialized, parsed by a parser that keeps strings, and compared as BigInt with the in-memory value, plus an assertion that none of these fields is serialized as a number. The counters are: `files_total`, `files_unreadable`, `files_without_response_id`, `token_count_events_without_response_id`, `lines_total`, `lines_parse_error`, `lines_truncated_tail`, `known_type_count`, `unlisted_type_count`, `records_unkeyed`, `api_error_records`, `requests_total`, `requests_priced`, `requests_unknown_model`, `requests_unpriced_modifier` (with reason counts, among them `long_context_scope`, R3.10, and `modifier_unverified`, R3.12 for Claude without a final copy that carries all three modifiers and R3.4 for every Codex response), `requests_conflict`, `responses_bucket_mismatch`, `output_unknown_requests`, `tokens_unpriced`, `tokens_in_incomplete_responses`, `replay_requests_excluded`, `replay_ownership_ambiguous`, `links_verified`, `links_directory_only`, `links_unlinked` (with reason counts), `pairs_total`, `pairs_eligible`, `pairs_abstained` (with code counts), `requests_unverified_version`, `lines_unverified_version`, `baseline_requests_loaded`, `responses_usage_range_failed`, `tokens_in_invalid_responses`, `responses_model_unverified`, `files_unassigned_stream`, `files_assigned_by_stream`, `lines_duplicate_collapsed`, `duplicate_records_collapsed`, `requests_conflict_modifier`, `pairs_gap_unknown`, `files_stream_conflict`, `chains_total`, `chains_tainted` (with reason counts, R0.9), `families_total`, `families_tainted`, `responses_in_tainted_chains`, `tokens_in_tainted_chains`, `requests_unpriced_tainted`, `families_live_skipped`, `responses_live_skipped`, `tokens_live_skipped`, `fields_range_failed`, `files_copy_exposed`, `requests_gate_abstained` (with code counts), `records_usage_bearing` and `responses_total` (logical, R17.6). The counters are classified as physical or logical in R17.6.

R17.2. Coverage is printed in the main report, not only in `doctor`.

R17.3. Critical drift closes the headline (`headline_status = withheld`) when any of these holds for a provider in the window:

| Code | Condition |
|---|---|
| `drift_unmappable` | logical usage-bearing records (R17.6, equal records counted once) that cannot be mapped to the required integer fields exceed `C10` (1 percent) of `records_usage_bearing`. Lines that fail to parse are in neither the numerator nor the denominator |
| `drift_invariant` | responses failing R2.7 or R2.15, R2.1 mismatch or key conflicts exceed `C11` (0.5 percent) of `responses_total` (logical, one per key) |
| `drift_no_key` | `records_unkeyed` (logical) exceeds `C10` of `records_usage_bearing` |
| `drift_no_final_marker` | for Claude: no copy in the window has `usage.speed` while more than `C28` requests exist, which suggests the final-copy marker moved |
| `drift_stream_integrity` | for Codex: files in `files_stream_conflict` plus `files_unassigned_stream` plus `files_copy_exposed` exceed `C10` of Codex files (`100 * (conflict + unassigned + copy_exposed) > files`), or Codex chains tainted with reason `ordinal_unverified` exceed `C10` of Codex chains, which suggests the identity or `ordinal` semantics moved |

When closed, accounting totals are still printed with the label `unverified`, no dollar headline is printed, and `doctor` prints the code.

R17.4. Non-critical gaps (missing optional fields, unknown optional types, unlinked agents) never close the headline but always show in coverage.

R17.5. Unlogged usage estimate. For Claude, `cost-state.modelUsage` cumulative values per model are compared with the sum of logged requests per model. The difference is printed in coverage as `unlogged_tokens_estimate` per bucket, each as a signed decimal string (R17.1), with the label "includes helper and classifier calls and logging gaps". It is never added to totals or dollars.

R17.6. Physical and logical counters. A physical counter counts what is in the input files as written: lines, files and lines by class. A logical counter counts after equal records are collapsed (R4.12 equality, keys R4.1) and is therefore invariant under line duplication, line shuffling and file order. Classification:

* Physical: `files_total`, `files_assigned_by_stream`, `files_unassigned_stream`, `files_stream_conflict`, `files_copy_exposed`, `files_unreadable`, `files_without_response_id`, `token_count_events_without_response_id`, `lines_total`, `lines_parse_error`, `lines_truncated_tail`, `known_type_count`, `unlisted_type_count`, `lines_duplicate_collapsed`, `duplicate_records_collapsed`, `lines_unverified_version`.
* Logical: every other counter, among them `records_unkeyed`, `records_usage_bearing`, `responses_total`, `requests_*`, `responses_*`, `pairs_*`, `links_*`, `streams_*`, `replay_*`, `api_error_records` and `fields_range_failed`.

Definitions that make the effects exact. `lines_duplicate_collapsed` is the number of parsed lines whose record equals a record that appeared earlier in the deterministic scan order (so one extra copy of a line adds exactly 1). `duplicate_records_collapsed` is the number of distinct records that have at least one such extra line (so an extra copy adds 1 only if that record had no extra line before). A line that does not parse has no projection, is never collapsed, and counts in `lines_parse_error` each time it appears.

Expected effects, asserted by the metamorphic tests of R4.10, for an operation that adds `k` extra copies of one line (each copy inserted with its own line terminator, away from the end of a file, so a duplicated truncated tail is a parse error and not a tail):

| Line class | Physical counters that change | Logical counters |
|---|---|---|
| parsed record of a known type | `lines_total` +k, `known_type_count` +k, `lines_duplicate_collapsed` +k, `duplicate_records_collapsed` +1 if the record had no extra line before; for a `token_count` event in a file that has no `token_usage_record`, also `token_count_events_without_response_id` +k | none |
| parsed record of an unlisted type | the same with `unlisted_type_count` | none |
| parsed record of an unverified version | the same, plus `lines_unverified_version` +k | none |
| line that fails to parse | `lines_total` +k, `lines_parse_error` +k | none |

Splitting a file at a line boundary changes only `files_total`, `files_assigned_by_stream` (and the unassigned, conflict or copy-exposed file counters as R4.10 and R4.13 state) and the two counters of R2.9 among the physical counters, and never another line counter; a truncated tail stays the tail of its half. The counters of R2.9 change by an exact rule: for a file that holds at least one `token_usage_record`, each half that holds at least one `token_count` event and no `token_usage_record` adds 1 to `files_without_response_id` and its number of `token_count` events to `token_count_events_without_response_id`; a file that holds no `token_usage_record` and was already counted as one file is counted once per half that holds `token_count` events (0, 1 or 2 files), and its event total is unchanged. No token total depends on this, and the taint such a half creates (R0.9 `unlogged_usage`) only withdraws output, as R17.7 states. Among the logical counters it may change only those of R17.7. A drift ratio (R17.3) uses only logical numerators and denominators, except `drift_stream_integrity`, which is defined on physical Codex file counts and is the one drift code allowed to change under file splitting (R4.10). Required tests: the table above for each class and several `k`, on one fixture file and on a fixture split in two.

R17.7. Split contract for logical counters. Logical counters change under a split only through R0.9. A split that taints no new chain changes no logical counter. A split that is not dissolving (R4.10) and taints new chains changes the logical counters only as follows, and every other logical counter MUST equal the unsplit value:

* may only increase: `chains_tainted` and each of its reason counts, `families_tainted`, `responses_in_tainted_chains`, `tokens_in_tainted_chains`, `requests_unpriced_tainted`, `tokens_unpriced`, `responses_model_unverified`, `requests_gate_abstained` and its `chain_tainted` code count, and `pairs_abstained` and its `chain_tainted` code count.
* may only decrease: `requests_priced`, `requests_unknown_model`, the reason counts of `requests_unpriced_modifier`, `pairs_eligible`, and the code counts of `pairs_abstained` and of `requests_gate_abstained` other than `chain_tainted`.
* pair accounting: the total of `pairs_abstained` always equals the sum of its code counts. It increases by the number of pairs that were `no_event`, `event` or a boundary in the unsplit result and are `chain_tainted` in the split result. A pair that abstained with another code and is now `chain_tainted` leaves the total unchanged: its old code count decreases by one and the `chain_tainted` count increases by one.
* conservation: `requests_priced` plus the requests that became unpriced equals the unsplit `requests_priced`; the total of tokens (priced plus unpriced) per provider is equal; `chains_total`, `families_total`, the three live counters, `pairs_total`, `requests_total`, `responses_total`, `requests_conflict`, `requests_unverified_version` and the `links_*` counters are equal.

A dissolving split keeps only the record-set guarantees of R4.10. Required test: the fixtures of R4.10, R4.13, R0.9 and R2.17 (5) to (8) store, for every split position, the full expected value of every coverage counter (physical and logical, with code and reason counts), and the test compares them exactly; a second assertion checks the direction, pair accounting and conservation rules above against the unsplit result.

## 18. Open questions

Each item has a conservative rule in the spec. Resolution requires evidence listed here.

1. Q1. Partial-only Claude requests (about 68 percent of subagent and workflow requests) have no final copy, so output tokens are unknown. Rule: output unknown and the lower bound reported (R2.3), and a request without a final copy produces no dollars at all, not only no output dollars (R3.12, `modifier_unverified`). A response with a final copy whose output is unusable (`conflict_output`, `conflict_iterations`) is a conflict that taints its chain, so it is not priced either (R3.5, R4.2, R0.9). Resolve by finding where final usage is logged, or from workflow totals or `cost-state` deltas.
2. Q2. Codex `cache_write_input_tokens` is 0 in the whole corpus. Whether `input_tokens` includes writes is assumed from the official formula, not shown from data. Rule: apply `normal = in - c - cw` (R2.6), invariant `c + cw <= in`, tested on synthetic fixtures only. Resolve with a real log containing `cw > 0`.
3. Q3. Claude `thinking_tokens` may or may not be inside `output_tokens`. Rule: not added (R2.4). Resolve through ccusage reconciliation and a controlled run.
4. Q4. `prefix.json` is not shown to be per request. Rule: agent-level corroboration only (R10.6).
5. Q5. The trigger for the one forked or resumed Claude file pair is unknown (resume, fork or relocate). Rule: ownership by earliest logical stream start, ties ambiguous (R4.6, R4.11).
6. Q6. Classifier call tokens are not in transcripts, and whether `cost-state` includes them is unknown. Rule: coverage estimate only (R17.5).
7. Q7. Diagnostics are sparse (72 requests, absent on 277 of 336 recon-detected drops), `pending` was never observed, and diagnostics may be absent in some versions. Rule: absence is normal, no inference from absence (R10.1).
8. Q8. No `/clear` event was observed, so its marker is unverified. Rule: a new session file after `/clear` is a `first_observation`.
9. Q9. The Codex service tier (Standard, Fast, Ultrafast) is not identified in logs. Rule: no tier is verified, so a Codex response is tokens-only with reason `modifier_unverified`, no dollars and no dollar delta, and no Standard tier is assumed (R3.4). Resolve with a log field that shows the tier of a response, a fixture showing it, and a spec revision. A Standard-normalized scenario (every Codex response priced at the Standard row and labelled as such, never as a bound) is a possible later feature, but it needs its own fields and a revision, and is not part of this spec.
10. Q10. The TTL of the GPT-6 family is taken from the GPT-5.6 and later documentation. Rule: `C8`, claim `expiry_compatible` only (R9.6).
11. Q11. Codex model attribution relies on the latest preceding `turn_context`. 783 turns have none of their own, and `thread_settings_applied` may change a model without a `turn_context`. Rule: `model_source` recorded (R2.10). Only `own_turn` and `carried_verified` are priced and eligible; `own_turn_unsettled`, `carried_unverified`, `inherited_prefix` and `none` are `model_unknown`, no dollars, and pairs abstain. A `thread_settings_applied` marker between a `turn_context` and a record of the same turn voids the model as well. Resolve by finding where a model change without a `turn_context` is logged, which would make more carried models verifiable.
12. Q12. `C1` to `C3` are heuristics from recon (50 percent, 20k previous context). Rule: dev-set tuning only before freeze; sensitivity at 8192 and 32768 for `C3` is reported in `docs/accuracy.md`.
13. Q13. `usage.speed` is missing on partial-only requests, so fast mode cannot be detected for them. Rule: such a response has no verified speed and is tokens-only with reason `modifier_unverified` (R3.12); no standard price is assumed and no range is produced. Resolve by a log field that gives the speed, geo and tier of a request on every copy, a fixture showing it, and a spec revision.
14. Q14. `inference_geo` was only ever `not_available`. The Claude `service_tier` values seen in recon are not enumerated here, and the set `standard`, `priority`, `batch` is a schema closed set with `other`. Rule: any value without a priced table entry is unpriced; batch is recognized only through `service_tier` of the final copy (R3.4), `inference_geo` and `service_tier` are read from the final copy alone (R3.12, R4.2), and a final copy without either field is unpriced (`modifier_unverified`). Whether partial copies carry them is not known (Q13).
15. Q15. The meaning of Codex `comp_hash` is inferred from how it co-varies with the model. Rule: `hypothesis` low only (R11.5).
16. Q16. Request start is not logged in either product. Rule: interval gaps only (R6.4 to R6.6).
17. Q17. Node zstd support minor version, and whether npm lets a trusted publisher be configured before the first publish. Rule: verified at G1 and G4. If not possible, the reservation publish is the single manual publish (R15.2).
18. Q18. ccusage pinned version and its exact dedup rule. Resolve at D6 by running the pinned version on the frozen snapshot.
19. Q19. Whether `/compact`, adding an MCP server, and effort changes can be driven headlessly with `claude -p` for the pinned version. Rule: classes that cannot be driven are excluded from claims (R12.5).
20. Q20. Whether `thinking_dropped` input transformations or other fields could discriminate edit or prune events. Rule: not used (R11.5).
21. Q21. Whether Codex `ordinal` is monotone within a thread across continuation files. Rule: it is not assumed. Each stream is checked at run time (R4.12): ordinals must be unique and sorting by them must not decrease the timestamps. A stream that fails is tainted (R0.9) and yields tokens only. Resolve with fixtures of a thread spanning two files that pass and fail the check.
22. Q22. Whether any log field identifies the request that API diagnostics compared against. Rule: none assumed, diagnostics never `confirmed` (R10.4, R10.5).
23. Q23. Whether the timestamp of the record a Claude request is built on always precedes the request send time. Rule: used as a causal bound only under assumption `parent_record_precedes_request` and validated per provider by R6.8; otherwise gap bounds are unknown.
24. Q24. Whether a copied parent `session_meta` of a Codex fork can be told from the own one by any field. Rule: only through the in-file `forked_from_id` reference (R4.11); a file that cannot be resolved to one stream identity taints the families of the chains it names (R0.9). Resolve by finding a field that marks a copied record.
25. Q25. Whether the range of Claude TTL options is only 5m and 1h. Rule: assumed and printed as `claude_ttl_options_5m_1h` (R9.4); a longer option would void compatibility claims (`T_hi`), and a shorter one is harmless because the spec makes no exclusion statement.
26. Q26. Whether any log field identifies the cache entry that a request read, or the last contact time of an inner breakpoint entry. Rule: none assumed, so the chain TTL set (R9.2) replaces per-position classes and no expiry exclusion is ever stated (R9.4). Resolve with a field that names the entry read, a fixture showing it, and a spec revision.
27. Q27. Whether any Codex log field ties an input record (user message, tool result) to the request that contains it, so that a Codex start lower bound could be derived without assuming that the request is sequential. Rule: none assumed, Codex `start_lo` is always `unknown` and no Codex `ttl_expiry_compatible` is emitted (R6.5, R9.6). Resolve with such a field, a fixture showing it, the overlap fixture of R6.5 passing, and a spec revision.
28. Q28. Whether any Codex log field ties a `compacted` record to the request that ran with the compacted context (a request id or a window id on the usage record). Rule: none assumed, no Codex compaction is bound or `confirmed`, the signal is a low hypothesis (R11.7). Resolve with such a field, a fixture showing it with an overlapping request, and a spec revision.
29. Q29. Whether any Codex log field names the context (a `turn_context` or settings revision) under which a response was generated. Rule: none assumed, the overlap guard of R2.17 applies. Resolve with such a field, the overlap fixtures of R2.17 passing, and a spec revision.
30. Q30. What the pricing session of the long-context wording is (a thread, a `session_id`, or an account level notion). Rule: it is not guessed. A Codex model is priced only with a verified `request` scope from its model page (R3.10); a `session` or `unknown` scope is never priced. Resolve from the official model pages or a billing statement, record the scope and its source in the table, and revise. Table `pt-2026-10-09.2` records what the model pages state (`request` for seven models, `session` for `gpt-5.5` and `gpt-5.4`); what a billing session is stays unknown, so a `session` scope model remains unpriced.
31. Q31. Whether any log field lets a reader prove that every thread and file of a pricing session was scanned (a parent that lists its children, or a session-level cumulative counter). Rule: none assumed, so no completeness check exists and a `session` or `unknown` scope is never priced (R3.10). Resolve with such a field, fixtures with a missing sub-thread file and a model of unknown attribution (R3.10 fixtures 2 and 3), and a spec revision.
32. Q32. Whether any Claude log field names the request whose context a compaction summarized (an id on the usage record or on the summary). Rule: none assumed, so the binding is a lineage walk with strict time order and a same-chain check (R11.7), and an old summary on the ancestry of `C` is never a confirmation. Resolve with such a field, the return-to-an-old-branch fixture of R11.7 passing, and a spec revision.
33. Q33. Whether a `turn_context` or `thread_settings_applied` record can be attributed to its stream by any field other than the file it lies in (a thread id or a settings revision on the record). Rule: none assumed. Attribution is by file identity (R4.11), a turn id check over the whole scan (R2.17 (d)) and the family taint of R0.9. Two limits are stated, not hidden. (1) A dissolving split (R4.10) of a stream-conflict file loses the evidence of the conflict, so a marker without a turn id can end up assigned to another stream, and the stream that lost it can verify a model that the unsplit scan withheld (fixture (8) of R2.17). (2) A context or marker of a thread that lies in a file naming only chains of another family is not seen by that thread. Both need a record of one thread inside a file of an unrelated thread. Resolve with such a field, fixture (8) giving the same result at every split, and a spec revision.
34. Q34. Whether a line that cannot be read (a parse error, a truncated tail) can belong to a chain outside the family of the chains its file names. Rule: for a file that names no chain, nothing is assumed and the whole provider is tainted (R0.9); for a file that names chains, the line is assumed to belong to their families (a log file is written by one session family), and a file that names chains of several families taints all of them. Resolve with a real log that shows otherwise, a fixture, and a spec revision.

## 19. Resolution history

The resolution of every audit finding, from the plan audits to spec audit round 10 and later, is recorded per round in `docs/audit-log.md`, with the rules that resolve it. The rule maps that revision 10 kept here (its sections 19 to 28) are removed in revision 11 so that one record exists; the audit log holds the same content.
