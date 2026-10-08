# Audit log

Gate audits run with `gpt-6.1-sol` at high reasoning effort, read-only, with the audited content embedded in the prompt because the sandbox blocks file reads. Backup auditor: `gpt-6-sol` high. A gate passes only with verdict PASS and zero open P0 and P1 findings. Accounting and privacy findings cannot be waived (see `docs/methodology.md`, section 15).

## Rounds so far

| Round | Date | Target | Result | Notes |
|---|---|---|---|---|
| 0 | 2026-10-08 | Plan v1, preliminary | Not a full audit | The sandbox lock blocked file reads. The auditor used public web sources only. |
| 1 | 2026-10-08 | Plan v1, full text embedded in the prompt | FAIL | 27 findings and 8 minimal changes required for PASS. |
| 2 | 2026-10-08 | Plan v2, gate G0 | FAIL | 1 P0, 11 P1, 1 P2. Requested items: 1 addressed, 7 partial. |
| 3 | 2026-10-08 | Specification `spec-1` (`docs/methodology.md`) and pricing rules, gate G0 | FAIL | Reported below as "G0 spec audit round 1": 0 P0, 13 P1, 2 P2. Pricing table not embedded. All 15 resolved in `spec-1` revision 2, re-audit pending. |
| 4 | 2026-10-08 | `spec-1` revision 2, gate G0-spec (G0-pricing not run, no table yet) | FAIL | Reported below as "G0 spec audit round 2": 0 P0, 8 P1, 1 P2. All 9 resolved in `spec-1` revision 3, re-audit pending. |
| 5 | pending | `spec-1` revision 3, gate G0-spec (G0-pricing once `pricing/table.json` exists) | pending | Written 2026-10-08 against the 9 findings of round 4. |

## Round 1: the 8 required changes

1. Drop the "every miss cause" and "avoidable bill" claims. Separate observation, hypothesis and confirmed.
2. Fix the false-positive formula. Evidence-backed cost with explicit counterfactual assumptions.
3. Codex response and cumulative accounting, cache-write pricing, output, missing field semantics.
4. Deterministic dedup, conversation graph, verified subagent linkage, window baseline.
5. Provider and model TTL. No high confidence from proxy times.
6. Use diagnostics as evidence. Independent ground truth, confidence intervals, coverage.
7. Enforceable privacy claims, export allowlist, no-network runtime test, package audit.
8. Narrow conditional beta, differentiation on history, subagents and evidence, license, CI provenance, supported runtimes.

## Round 2: result by item

| # | Required change | Addressed in plan v2 |
|---|---|---|
| 1 | Remove over-promises, separate evidence levels | yes |
| 2 | False positives, evidence-backed counterfactual cost | partial |
| 3 | Codex accounting, write pricing, output, missing fields | partial |
| 4 | Dedup, graph, verified linkage, baseline | partial |
| 5 | Provider and model TTL, no high confidence from proxy times | partial |
| 6 | Diagnostics as evidence, independent ground truth, intervals, coverage | partial |
| 7 | Privacy: allowlist, no-network test, package audit | partial |
| 8 | Conditional narrow beta, license, CI provenance, supported runtimes | partial |

## Round 2: findings and where `spec-1` resolves them

| Severity | Area | Finding | Resolved in |
|---|---|---|---|
| P0 | Codex accounting | `input - cached` still contains cache-write tokens, so adding a separate write charge double prices them. Required `normal = input - cached - write`. | R2.6, R3.6, R2.7 |
| P1 | Accounting | Codex output semantics, missing `response_id`, missing price modifiers are undefined. | R2.8, R2.9, R2.12, R2.13, R3.4, R17.1 |
| P1 | Event detection | No decision rule for a suspected rebuild. New suffix writes, partial hits and uncacheable short prefixes can look like rebuilds. | R7.2 to R7.8 |
| P1 | Excess cost | The rebuilt length is not measurable. Counting all writes as lost prefix mixes normal growth into the delta. | R7.7, R8.1 to R8.8 |
| P1 | Diagnostics | A diagnostics record is not a confirmed cause. A structural change can coexist with a hit. `previous_message_not_found` is not a comparison. Token estimates are not billing counters. | R10.2 to R10.7, R11.5 |
| P1 | TTL | A write bucket does not explain every read. Mixed TTL is possible. Elapsed time since the last write is not enough. | R9.1 to R9.8, R6.4 to R6.6 |
| P1 | Dedup and graph | No copy selection priority table. `toolUseId` does not define Codex linkage. Ownership of replayed fork history is unclear. | R4.2 to R4.9, R5.3 to R5.7 |
| P1 | Experiments | Applying an action does not create a real miss or a single-cause label. Six minutes does not expire a one-hour cache. Effort changes keep the cache on some models. | R12.1 to R12.5 |
| P1 | Accuracy | The same fixtures served development and precision measurement. No G3 acceptance threshold. | R12.6 to R12.10, section 0.3 |
| P1 | Reconciliation | Matching ccusage does not exclude shared parser errors. `/usage` is main conversation scope. Totals can hide offsetting errors. | R13.1 to R13.8 |
| P1 | Privacy | Allowlist fields and error paths undefined. Anonymization does not stop content leaking through parser errors or free-form metadata. | R14.1 to R14.9, R1.1 to R1.4 |
| P1 | Release | PASS condition tied only to the HN date. Gates before `next`, public and publish steps unclear. No CLI version matrix. No verified provenance requirement. | R15.1 to R15.7 |
| P2 | Headline | Denominator of the cache read share is unstated. "Suspected" mixes confirmed and unknown. Meaning of the dollar figure is unclear. | R16.1 to R16.5 |

## Additions in `spec-1` beyond the Round 2 findings

1. Cause class `request_settings_changed` was added to the plan taxonomy (effort, speed), because both product docs list these as invalidating changes and one negative control depends on it.
2. Boundary events (`model_switch`, `context_reset`, cold starts) are separated from suspected rebuilds and never priced.
3. Cause class signals fixed to exact field comparisons, and a `ttl_expiry_compatible` ceiling at hypothesis.
4. Unlogged helper and classifier usage is estimated for coverage only and never enters totals.

## Round 3 checklist for the auditor

1. Each Round 2 P0 and P1 above maps to a rule that is testable without judgment.
2. No rule produces dollars from a diagnostics estimate or from a boundary event.
3. Every numeric constant is in section 0.3 and the freeze procedure is in section 0.4.
4. Open questions (section 18) each carry a conservative default.
5. Pricing rules match the sources recorded in `pricing/table.json` when it is added at D1.

## G0 spec audit round 1 (target: `spec-1`, revision 1)

Auditor: `gpt-6.1-sol` (available, no fallback used). Prompt size 82543 bytes. Verdict: FAIL. Counts: 0 P0, 13 P1, 2 P2. Each finding was re-checked against the recon facts stated in the spec before changing it. No finding was rejected. One was accepted with a narrower fix (row 8, see its note). All resolutions are in `docs/methodology.md` revision 2, and the rule map is its section 20.

| # | Sev | Rules | Finding (short) | Re-check | Resolution |
|---|---|---|---|---|---|
| 1 | P1 | R2.7, R2.12 | No negative value or safe integer check on token fields | Correct: R2.7 only checked `c >= 0` and `cw >= 0` for Codex and nothing for Claude | New R2.15: every counter must satisfy `0 <= v <= Number.MAX_SAFE_INTEGER`. A failing response (`usage_range_failed`) is removed from accounting, events and lineage, counts toward `C11`, and sums use BigInt. R2.7 runs after R2.15. |
| 2 | P1 | R1.2, R3.4, R4.2 | `speed`, `inference_geo`, `service_tier` listed as integers, copy conflicts and `service_tier` pricing undefined | Correct: the R1.2 row grouped them with counters | Separate enum rows in R1.2. R4.2 gets a modifier row: all carrying copies must agree, else `conflict_modifier` and `unpriced_modifier`. R3.4 gets a general rule (unrecognized, conflicting or undefined modifier gives no dollars) and a `service_tier` row (`standard` no effect, others unpriced unless the table has an explicit entry). |
| 3 | P1 | R2.10, Q11 | Carried Codex model is trusted though a model change can happen without `turn_context` | Correct: Q11 already admitted the gap | R2.10 now has a `model_source` table. Only `own_turn` and `carried_verified` (no `thread_settings_applied` marker in between) are verified. Others give `model_unknown`: no dollars, pairs abstain at E2. An `event_msg` payload type enum was added to R1.2. |
| 4 | P1 | R1.2, R5.4, R6.5, R11.7 | Allowlist misses graph fields and Codex message role, workflow check needs dropped tool-result text | Correct: R6.5 needs `payload.role`, R11.7 needs `user` records, R5.4 needs text that R1.1 forbids to retain | R1.2 now lists all-record graph fields, `message.role`, `tool_use_id`, Codex `payload.role`, `thread_spawn.parent_thread_id` and `depth`. Workflow agents can never be `linked(verified)`; `linked(directory)` is the maximum (R5.4), and their first request is a `first_observation` boundary. |
| 5 | P1 | R2.10, R4.6, R4.10 | Splitting a file breaks model context and `file_start` ownership | Correct: both used the physical file | New R4.11 logical stream. Ownership (`stream_start`), model attribution and previous-request search use the stream, never the physical file. The R4.10 split test is defined on streams. |
| 6 | P1 | R4.8, R5.7, R6.2, R7.4 | Replayed previous request both removed and eligible, fork first response both boundary and rebuild | Correct: R6.2 removed replayed requests while R7.4 made them eligible | The first own request after a replay is only a `fork_inherit` boundary (R4.8, R7.2 E1). Replayed requests stay in the stream as lineage and baseline history (R4.7, R9.2) but are never `P` of an event. R7.4 and `via_replay` removed. |
| 7 | P1 | R6.4 to R6.6, R9.4 | The 15 s (p90) and 120 s constants are not start bounds | Correct: `C4` was a percentile of an observed lag, `C5` a guess | `C4` and `C5` retired. `start_lo` is the parent record timestamp (Claude), the latest input record (Codex) or `unknown`. Unknown gap ends give no TTL statement (`ttl_gap_unknown`). New R6.8 validates the bound against harness send times (`C34`); if violated, the provider's TTL claims are withdrawn. Q23 added. |
| 8 | P1 | R10.4, R10.5, R11.1 | Diagnostics do not identify the compared request, so `confirmed` is unsupported | Correct. Note: `confirmed` stays for a bound compaction marker (R11.7) because that is a local structural binding, not an API comparison, and the finding does not cover it. | A diagnostics type is `observed` as an API report and at most `hypothesis` (high) as a cause. `confirmed` removed from every diagnostics path (R10.4, R10.5, R11.1, R11.4, R11.5, R12.10). Q22 states the promotion condition. |
| 9 | P1 | R8.2, R8.3 | Marker absence is not proof of an unchanged prefix, yet `L_lo = L` | Correct | `L_lo = 0` always. New conditional metric `L_if_unchanged` with assumption `no_marker_means_unchanged_prefix`. Dollar fields `usd_hi` (observational) and `usd_if_unchanged_lo`, `usd_point` (conditional). The headline has an observational line and a conditional line. |
| 10 | P1 | R12.3 to R12.5 | The intervention label does not prove a miss or boundary effect occurred | Correct: only the warm-hit precondition was verified | Effect check in R12.3 with criteria `miss` (`R_3 <= C21 * K_2`) and `hit` (`R_3 >= C22 * K_2`) from harness counters, verdict stored before cachewhy runs. `no_effect` runs get no label, are excluded from precision and coverage and are reported separately. A scenario is invalid above `C23`. |
| 11 | P1 | R12.7, R12.10 | Precision denominator and `n` undefined, natural diagnostics calibration contradicts R12.1 | Correct | R12.7 defines the prediction unit (one run, `primary` cause), `TP`, `FP` and `n = TP + FP`. Wilson uses `n` of scored predictions. R12.10 forbids natural diagnostics as labels; calibration only on controlled runs. |
| 12 | P1 | R15.7 | "Accounting only" yet observed events, dedup semantics unverified for new versions | Correct | Unsupported versions are coverage only: counts of distinct keys and lines, nothing in totals, dollars, events, boundaries or lineage. The R0.2 support level is renamed "coverage only". |
| 13 | P1 | R15.1, checklist 5 | G0 covers the price table but the table and its sources were not in the audit input | Correct: `pricing/table.json` is only added at D1, so it could not have been embedded | G0 is split into G0-spec and G0-pricing and passes only when both pass. G0-pricing requires the full table, sources, modifier rules and minimum cache lengths in the audit input. Until the table exists G0-pricing is `not run` and G0 cannot PASS. Round 4 can at most pass G0-spec. |
| 14 | P2 | R4.10, R14.4, R17.1 | Random salt and duplicate-line counters prevent byte equality | Correct | R4.10 defines the semantic output with three normalizations only: `generated_at`, opaque id hex ranks, and listed physical-shape counters compared to their expected change. New counters in R17.1. |
| 15 | P2 | Sections 0.3, 0.4 | Not every threshold is in the table, change procedure for other sections unclear | Correct | `C21` to `C34` added (effect criteria, tier splits, hop and request thresholds, day count, filler multiple, hand-check size, unexplained tolerance, start bound violations). Scenario parameters are frozen like constants. Section 0.4 defines result-affecting rules and requires a new freeze tag and a new held-out set for any change to them, with a narrow wording-only exemption backed by an identical-output test. |

## Round 4 checklist for the auditor

1. Each finding in the table above maps to a rule that is testable without judgment.
2. G0-spec: no rule yields dollars from diagnostics, from a boundary, from an unverified model, or from an unresolved or conflicting modifier.
3. No rule yields `confirmed` from an API diagnostics type.
4. Every numeric decision threshold is in section 0.3 or in the R12.5 scenario table, and section 0.4 covers every result-affecting rule.
5. G0-pricing is run only with the full `pricing/table.json` and its sources in the prompt; until then the verdict covers G0-spec only.

## G0 spec audit round 2 (target: `spec-1`, revision 2)

Auditor: `gpt-6.1-sol` (available, no fallback used). Prompt size 114278 bytes (instruction, `docs/methodology.md`, `docs/audit-log.md`). Scope: G0-spec only. The pricing table was not supplied, so G0-pricing was not run. Verdict: FAIL. Counts: 0 P0, 8 P1, 1 P2. The auditor also stated that not all earlier findings were closed. Each finding was re-checked against the recon facts and the text of revision 2 before changing it. No finding was rejected. Three were accepted with a narrower or different fix than the one proposed (rows 2, 5 and 7, see notes). All resolutions are in `docs/methodology.md` revision 3, and the rule map is its section 21.

| # | Sev | Rules | Finding (short) | Re-check | Resolution |
|---|---|---|---|---|---|
| 1 | P1 | R2.15, R2.1, R7.1 | Counters are range checked one by one, but sums such as `i+r+w` and `r+w` can exceed the safe integer range. BigInt was required only for sums across responses | Correct: three counters each at the maximum safe value overflow `Number` in `i+r+w` | New R2.16: all token arithmetic is BigInt right after the range check, including every intermediate quantity. Ratio constants are exact rationals (section 0.3) and tests are cross-multiplications (`S >= C2` is `10*R >= 9*K_prev`, `S < C1` is `2*R < K_prev`, the same for C21, C22, C24). R7.5, R12.3 and R7.1 rewritten. JSON output carries token values as decimal strings. Required boundary fixtures: counters at the maximum, sums above it, pairs exactly on and next to each rational boundary |
| 2 | P1 | R4.9, R4.11, R5.3 | Codex stream id taken from the "first found" record, fork detected by a second `session_meta` in the same file. Line shuffling or file splitting changes id, prefix and links | Correct: "first found" depends on physical order, and fork detection depended on file co-location, both against R4.10. Note: the proposed fix says to abstain on unresolved ids; that is adopted, plus a resolvable rule so that ordinary splits do not abstain | R4.11 rewritten: per file identity set `I(F)` from own `session_meta` ids (a copied parent record is the one referenced by another `forked_from_id` in the same file) and `thread_id` of `token_usage_record`. One id assigns the file, none leaves it unassigned, two or more is `files_stream_conflict`: accounting stays keyed by record identity, the streams become `integrity_unverified` and abstain `stream_unresolved`. R4.9: a fork is a thread whose own `session_meta` has `forked_from_id`, the first own request is the earliest request by event time. R5.6 links through resolved stream identity. R4.10 gets fork and multi-file fixtures with shuffles and every split position, expected results stored. New coverage counters, drift code `drift_stream_integrity`, Q24 |
| 3 | P1 | R4.8, R3.5, R3.6, R5.8 | The first own response of a fork is "never priced", although it is a separate billed response. The ban on a boundary delta was mixed with response cost | Correct: R4.8 said "never priced" while R5.8 requires every request in the grand total | R4.8, R5.8, R8.7, R11.6: tokens and list-price-equivalent cost of every boundary response enter totals normally. Only the event and the rebuild delta are suppressed. Required fixture: a fork with a positive cost first own response |
| 4 | P1 | R9.4 | Unknown TTL treated as the larger value is conservative for the compatibility claim but unsafe for `expiry_excluded`. A real 300 s TTL with a 600 s gap would be wrongly excluded | Correct | R9.4 keeps a range `[T_lo, T_hi]`: compatibility uses `T_hi`, exclusion uses `T_lo`. `mixed` and `unknown` Claude segments are `[C6, C7]`. R9.6 gets the same two columns. Where `T_lo` is undefined (OpenAI rows without a documented minimum) no exclusion is ever produced. Compatibility and exclusion now depend only on their own gap end (`gap_min`, `gap_max`). Q25 records the assumed option set |
| 5 | P1 | R8.1 to R8.6 | `D = K_prev - R` is not an unconditional observational upper bound when the read region is not a prefix of the previous prefix. Example: `K_prev = 20000`, `R = 8000` from another entry, the old 20000 reprocessed, `D = 12000` | Correct: `D` assumes the read tokens are the first `R` positions of the previous prefix. Note: the proposed bound `min(K_prev, W+U)` is adopted as the unconditional bound; `D` is kept as a conditional, tighter figure instead of being dropped | R8.1: `L = min(K_prev, W+U)` unconditional, `L_pm = min(D, W+U)` conditional on assumption `read_region_is_prefix_of_previous`. `usd_hi` uses `L` with the free bucket allocation. `usd_point`, `usd_if_unchanged_lo` and `L_if_unchanged` use `L_pm` and the positional allocation. Test `usd_if_unchanged_lo <= usd_point <= usd_hi`. Schema and headline updated |
| 6 | P1 | R12.7 | A wrong event with `primary = null` counts as "no prediction", so it escapes the negative-control error rate | Correct | Negative controls are scored by violation, independent of `primary`: any event or any boundary on the intervention pair (N5: also on the subagent chain except the expected types). Abstention is not a violation. A violation with `primary = null` is a violation and an `FP` of no class. G3 item 4 uses violations. Required fixtures: equal-candidate event, unexpected boundary |
| 7 | P1 | R2.10, R6.5, R11.7, Q21 | Unverified `ordinal` only stops model attribution, but start bounds and `confirmed` compaction binding still use it | Correct: R6.5 and R11.7 use `ordinal` ranges. Note: instead of declaring the ordering unverified by default, the fix makes it a per-stream computed check (R4.12), so verified streams keep their results | R4.12: `ordinal_verified` iff ordinals are integers, unique, and sorting by them never decreases timestamps, evaluated over the whole logical stream. If false: carried models unverified, fork prefix unresolved, `start_lo` unknown, Codex compaction `compaction_marker_unbound` (hypothesis low), equal times are `order_tie`. The first own request of a fork needs no ordinal. Q21 rewritten, fixtures for pass and fail |
| 8 | P1 | section 0.4, 0.2, R15.7, R17.3 | Freeze scope omits the version matrix, unsupported-version behavior and headline drift rules, so they could change after evaluation without a new held-out set | Correct: the list named sections 1 to 11 and selected rules of 12 and 13 only | Section 0.4 item 2 now defines a result-affecting rule by effect (accounting, eligibility, abstention, classification, scoring, headline status, report or README claims) and lists sections 0.1 to 0.3, 1 to 11, all of 12 and 13, R14.5, R15.3, R15.7, 16, 17 and the pricing table. Adding or demoting a version needs a new tag and a new held-out set (for an added version, runs on that version). Process-only rules (R15.2, R15.4, R15.6) are exempt but logged |
| 9 | P2 | R5.7, R11.5, R11.8, R14.5 | The first response of a linked subagent is an unconditional cold start in some rules and only for `R < M` in R11.8. `after_reset` is not in the boundary schema | Correct | New single ordered decision table in R11.8 whose result is exactly the five boundary types of R14.5: `fork_inherit`, `subagent_cold_start`, `first_observation`, `model_switch`, `context_reset`. A linked subagent first response is always `subagent_cold_start`, whatever `R` is, and the hit is reported in the new boundary field `r`. `cold_start`, `after_reset` and `first_in_chain.kind` are removed. R5.7, R7.2 E1 and R11.5 refer to the table |

Clarification on an earlier entry: the item "Boundary events ... never priced" under "Additions in `spec-1` beyond the Round 2 findings" meant that no rebuild delta is computed for them. Their own response cost is accounted normally (finding 3 above).

## Round 5 checklist for the auditor

1. Every token quantity, sum and threshold comparison is BigInt or an exact rational cross-multiplication (R2.16), including intermediate sums.
2. Codex stream identity, fork detection and links give the same result under line shuffling and file splitting, or the affected streams abstain (R4.9, R4.11, R4.12, R5.6).
3. No boundary response is removed from accounting, and no boundary response gets a rebuild delta (R4.8, R8.7).
4. No exclusion statement can come from a TTL smaller than the possible one, and no compatibility statement from one larger (R9.4, R9.6).
5. `usd_hi` rests on `L = min(K_prev, W+U)` only, and every figure using `D` carries the prefix-match assumption (R8.1 to R8.6).
6. A wrong event on a negative control is a violation whatever `primary` is (R12.7).
7. Every use of `ordinal` is conditional on `ordinal_verified` (R4.12, R6.5, R11.7, R2.10, R4.9).
8. Section 0.4 covers every rule that can change accounting, eligibility, classification, scoring or report claims.
9. R11.8 is the only boundary decision table and its values equal the R14.5 enum.
10. G0-pricing is run only with the full `pricing/table.json` and its sources in the prompt.
