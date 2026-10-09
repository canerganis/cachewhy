# Accounting semantics checklist (normative)

Status: binding for G1, together with `docs/methodology.md` (spec `spec-1`, revision 11.1). Each item below is derived from the spec rule it cites. Where the spec names a quantity but leaves its normal form open, this checklist fixes the normal form conservatively, and `src/` and `scripts/recompute` MUST both implement exactly that form, each written independently from this text (R13.1: no shared code). A change to an item is a result-affecting change under R0.4 item 2.

Purpose: the G1 audit rounds 1 to 4 found the same kind of defect again and again: both implementations read the spec, each picked a slightly different normal form (a model suffix, a timestamp precision, a Number where a BigInt was required), and the totals drifted apart. This list removes the choice. The differential fuzz test (`test/differential-fuzz.test.ts`) checks the two implementations against each other on random malformed input.

Conventions. "Valid" means the item's grammar accepts the value. "State" is the reduced form of an invalid value kept for equality: `missing` (absent or JSON null), `bad` (present, wrong type or grammar), `range` (a JSON number that fails the counter range). Raw invalid values are never kept (R1.1, R14.6).

## S1. Strings and ids (R1.2, R14.4)

S1.1. An id (`requestId`, `message.id`, `uuid`, `parentUuid`, `logicalParentUuid`, `sessionId`, `agentId`, `response_id`, `thread_id`, `session_id`, `turn_id`, `root_turn_id`, `forked_from_id`, `parent_thread_id`, `tool_use_id`, `toolUseId`, `parentAgentId`, `runId`) is valid iff it is a JSON string of length 1 or more. Anything else is `missing` when absent or null and `bad` otherwise. Ids are compared as exact strings and live only in memory.

S1.2. An enum field maps a listed string to itself, absent or null to `missing` (null in code), and any other value (another string, a number, an object) to `other`. This holds for every enum, `event_msg` `payload.type` and diagnostics `type` included: an absent type is `missing`, an unlisted one is `other`, and the two differ.

S1.3. JSON null and absence are the same state `missing` for every field of every record (ids, enums, instants, counters, objects). No field maps null to `bad`.

S1.3a. A boolean field is `true` or `false`; absent or null is `missing`; any other value is `bad`. An array container (`iterations`, `message.content`) that is present and not an array is `bad`; `iterations[0]` that is not an object is `bad`.

S1.3b. Every id field keeps its state in every comparison, not only in projections: in the R4.11 comparison of two own `session_meta` records (`session_id`, `forked_from_id`, `subagent_history_start_ordinal`) a `bad` value and a `missing` value differ. A `session_meta` whose `id` is `missing` or `bad` is still a `session_meta` of its file for R4.11: it is own unless another record forks it, its `forked_from_id` still makes the forked record non-own, it adds no id to `own_ids`, and it is an `unattributed_record` (R0.9). A `version` that is absent is `missing`, one that does not match the version grammar is `unlisted`, and the two differ.

S1.3c. A parsed line that is not a JSON object (`5`, `[1]`, `null`, a string) is a record of type `missing` with no other field; all such records are equal to each other. A workflow `journal.jsonl` record projects to its `type` (enum state) and `agentId` (id state) only. A `cost-state` record projects to the common fields of S5.1 plus its top-level `modelUsage` token members as (model key, member, value or state) sorted. The R1.2 attribute fields `advisorModel`, `serverClassifierRequest` and content block `type`, `id` and `name` are projected on all four graph record types (`assistant`, `user`, `system`, `attachment`), wherever they occur.

S1.4. Optional integers that are not usage counters (`subagent_history_start_ordinal`, `thread_spawn.depth`, `window_number`, `ordinal`, `preTokens`, `postTokens`, `cache_missed_input_tokens`, `spawnDepth`) are read with the counter grammar of S4.1 and keep its states (`missing`, `bad`, `range`, value) in projections and in comparisons such as the `subagent_history_start_ordinal` check of R4.11. A rule that needs a valid integer treats every other state as invalid.

## S2. Model ids (R3.3, R14.3, R4.2, R2.17)

S2.1. Normal form of a raw model value `v`: if `v` is not a string, or is the empty string, or is longer than 80 characters, it has no model. Otherwise strip one trailing `-` followed by exactly 8 digits (`/-[0-9]{8}$/`), once. If the result matches `^[a-z0-9][a-z0-9._-]{0,63}$` it is the normalized id, else the value is `unlisted`.

S2.2. Claude `message.model` and `advisorModel`: no model gives null, the exact string `<synthetic>` gives the reserved value `<synthetic>` (R2.14; never a request, no table row), otherwise the normalized id or `unlisted`. `unlisted` is a model value: two copies with `unlisted` agree, a copy with `unlisted` and a copy with `claude-opus-5-5` are `conflict_model`, and `unlisted` has no table row (`unknown_model`). A null model on a copy takes part in no model comparison.

S2.3. Codex `turn_context.model`: no model and `unlisted` both give null (no candidate model). A null context model blocks `carried_verified` and `own_turn` as R2.17 says for a context without a usable model. For `TM(T)` (R2.17 (d)) a null model IS a member: an unreadable model may be any model, so a turn with contexts `A` and null is `turn_model_conflicted` (conservative; abstaining costs coverage only). Two null contexts of one turn and nothing else give a one-member set.

S2.4. Normalization is applied exactly once, at read time. Every later step, the price table lookup included, uses the normalized value as is and never strips a suffix again, so `claude-opus-5-5-20251001-20251001` normalizes to `claude-opus-5-5-20251001`, which has no table row (`unknown_model`). Every use of a model compares normalized values: `conflict_model` (R4.2), the record equality projection (R4.12, S5), `TM(T)` and the single model of `G(S)` (R2.17), the attribution equality of R4.4, and the price table lookup (R3.3). The table side is normalized the same way (a table `model` id with a date suffix is looked up by its stripped form). The raw string is never compared.

## S3. Instants (R1.2 `timestamp`, R4.12 (a), R5.9, R6.1, R4.2 `t_first`)

S3.1. Grammar (both providers, every instant field). An instant is a JSON string of at most 40 characters matching `YYYY-MM-DDThh:mm:ss[.f]Z` or `YYYY-MM-DDThh:mm:ss[.f]+hh:mm` / `-hh:mm`, where `f` is 1 to 9 digits, and the calendar is checked without `Date.parse`: year 0001 to 9999, month 01 to 12, day 01 to the days of that month in the proleptic Gregorian calendar (leap years: divisible by 4, except by 100 unless by 400), hour 00 to 23, minute 00 to 59, second 00 to 59 (no leap second, no `24:00`), offset hours 00 to 23 and minutes 00 to 59. Lowercase `t`, `z`, a space separator, a missing zone and more than 9 fraction digits are invalid. `Date.parse` is not used to decide validity, because it accepts `2026-02-30` and `T24:00`.

S3.2. Value. A valid instant is the exact BigInt count of nanoseconds since 1970-01-01T00:00:00Z (UTC, the offset applied, fraction right-padded with zeros to 9 digits). Two instants are equal iff their nanosecond values are equal, so `...00.12Z` and `...00.120Z` are equal and `...00.1234567Z` and `...00.1234568Z` are not. No step truncates to milliseconds before a comparison.

S3.3. Uses at full precision: record equality (S5), ordinal check (c) of R4.12 (timestamps never decrease), Claude `t_first` and `t_last` (min and max over all copies of the key, R4.2), Codex event time, ordering of R6.1 and its ties, `stream_start` and ownership ties (R4.6), and window membership (S7). Display and the ledger may carry milliseconds (`floor(ns / 10^6)`) only for printing and for a rule whose inputs are milliseconds anyway (file modification times of R0.9).

S3.4. An invalid or missing instant is state `bad` or `missing` in projections. It never becomes 0 or the epoch.

S3.5. Ordinal check (c) of R4.12 compares the instants of the ordinal-bearing records of the stream in ordinal order and skips a record without a valid instant (only ordinal-decision records must have one, R4.12 (a); a non-decision record without a valid instant fails nothing). The records of a stream for R4.12 are the records of the files assigned to it (R4.11). A `token_usage_record` in a stream-conflict file is accounted by its `thread_id` but is not a record of the stream for R4.12. A stream of an unverified version (R15.7) gets `version_unverified` only: no ordinal check, no fork prefix check, no model attribution.

## S4. Counters (R2.12, R2.15, R2.16)

S4.1. Reading. A counter field is `missing` if absent or JSON null, `bad` if present and not a JSON number (a string `"5"`, a boolean, an object), `range` if a JSON number that is not an integer, is negative, is not finite or is above `Number.MAX_SAFE_INTEGER`, and valid otherwise. `-0` is valid and equals 0. JSON numbers that parse above `2^53` (for example `9007199254740993`) are `range`.

S4.2. Conversion. Immediately after S4.1 accepts a value, it is converted to BigInt, and every later operation on it is BigInt: equality between copies, max over copies, sums, differences, the invariants of R2.7 (`c + cw <= in`, `rs <= out`, `total == in + out`), the bucket check of R2.1 (`wt == w5 + w1`), the Haiku split of R3.4 (`total_input > C26`) and the long-context split (`in > C25`). No Number comparison or arithmetic touches a token quantity, including `Math.max`, `>` on Numbers and `===` on Numbers.

S4.3. Effect on a response. Claude: a usage-bearing copy is `range` if any counter of the R1.2 counter row is `range` (including every integer member of `iterations[0]` and `output_tokens_details.thinking_tokens`); `incomplete` if any of `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens` is `missing` or `bad`, or `cache_creation` is present and not an object, or it is an object and `ephemeral_5m_input_tokens` or `ephemeral_1h_input_tokens` is `missing` or `bad`. Codex: a `token_usage_record` is `range` if any of the six `usage` integers is `range`, and `incomplete` if any is `missing` or `bad` or `usage` is not an object. Range wins over incomplete (R2.15 removes the response entirely). A Claude copy without a usage object is not usage-bearing; a Codex record without a usage object is incomplete.

## S5. Record equality projection (R4.12, R4.4, R17.6)

S5.1. Two records are one record iff their projections are equal field by field. The projection holds every R1.2 leaf field of the record type in its normal form: ids raw (S1.1) or their state (an absent `agentId` is `missing`, never the string `main`), booleans or `missing`, enums (S1.2), models (S2), instants as nanosecond values or their state (S3), counters and optional integers as BigInt values or their state (S4, S1.4), integer members of `iterations[0]`, `thread_token_usage` and `turn_token_usage` as (member name, value or `range`) pairs sorted by member name (the object itself: `missing` when absent or null, `bad` when not an object), content block types and ids for Claude, and the record type (an unlisted type is `other`). Only the fields R1.2 retains for the record's own type are projected (`message.role` belongs to `user` records only, so it is not part of an `assistant` projection). A container that is not itself retained (`output_tokens_details`, `diagnostics`) contributes only its leaf fields, so an absent container and a container without the leaf are the same. Derived flags (for example an API error flag) are not projection fields; they follow from the projected fields. A record of an unlisted type projects to the type `other` and exactly these common fields, each in its normal form: `uuid`, `parentUuid`, `logicalParentUuid`, `sessionId`, `agentId`, `timestamp`, `version`.

S5.2. The same projection decides: Claude `records_unkeyed` and `api_error_records` (logical counters), `lines_duplicate_collapsed`, `duplicate_records_collapsed`, Codex record interning, ordinal collisions (R4.12 (b)) and the occurrence equality of R4.4 (`conflict_usage` when `usage` differs, else `conflict_attribution` when anything else differs, including a timestamp that differs only below a millisecond).

## S6. Incomplete, invalid and excluded responses (R2.7, R2.12, R2.15, R4.1, R4.2, R4.4)

S6.0. Copies of a Claude key are grouped globally by `requestId`, whatever their chain: a copy without a valid `sessionId` (an `unattributed_record`, R0.9) is still a copy of the key, and every check of S6.1 (version, range, incomplete, timestamp, key conflict, input, model, output, iterations, modifiers) and `t_first`/`t_last` read it. It holds no chain, so it is never an owner candidate and names no chain. A key whose every copy is chainless has no owner and is not accounted (its records taint the provider through `unattributed_record`).

S6.1. Order of exclusion for a Claude key: unverified version (R15.7, counted only), then `usage_range_failed` (any usage-bearing copy is `range`), then `usage_incomplete` (no usage-bearing copy, any usage-bearing copy is `incomplete`, or any copy, usage-bearing or not, has a `missing` or `bad` `timestamp`, revision 11.1), then `key_conflict`, then `conflict_input` and `conflict_model` (both recorded, the first is the exclusion). For a kept response, `conflict_output`, `conflict_iterations` and `conflict_modifier` are each decided independently and every one that holds is recorded (disagreeing final outputs and a disagreeing `iterations[0]` record both), and `conflict_diagnostics` is decided as R4.2 says and counted in `requests_conflict_by_kind` without exclusion or taint. Only the first exclusion code is counted in the exclusion counters (`responses_usage_range_failed`, the `key_conflict` kind, and `tokens_in_incomplete_responses` for an incomplete response).

S6.2. Order for a Codex `response_id`: unverified version of the stream, then occurrence conflicts (`conflict_usage`, `conflict_attribution`, R4.4), then `usage_range_failed`, then `usage_incomplete` (a counter `missing` or `bad`, or the envelope `timestamp` `missing` or `bad`, revision 11.1), then `usage_invariant_failed`.

S6.3. `tokens_in_incomplete_responses` (one decimal string per provider, R17.1) of one incomplete response (R2.12, "present integer fields that pass R2.15"), with each field taken as the maximum of its valid values over the usage-bearing copies (Claude) or its value on the record (Codex), all in BigInt:
  * Claude: `i + r + W + o`, where each absent term is 0 and `W` is `cache_creation_input_tokens` when valid, else `w5 + w1` over the valid ones among them. Each term counts once, so a token is never counted twice.
  * Codex: `I + O`, where `I` is `in` when valid, else the sum of the valid ones among `c` and `cw`, and `O` is `out` when valid, else `rs` when valid. `in` includes `c` and `cw`, and `out` includes `rs` (R2.6, R2.8), so a valid inner counter is reported only when its outer counter is not.

S6.4. `tokens_in_invalid_responses` (R2.7) of an invariant-failed Codex response is `in + out`. A range-failed response adds nothing anywhere (R2.15).

S6.5. Each excluded response with a known chain taints that chain (R0.9 `request_anomaly`; Claude chain scoped, Codex family scoped, revision 11.1). Its ledger entry carries its event time when one exists (Claude: the minimum valid instant over its copies; Codex: its valid envelope instant), else no time, and an entry without a time is in every window.

## S7. Window (R5.9, R5.10)

S7.1. `since` and `until` are milliseconds since the epoch (CLI dates are midnight UTC, durations are measured from the run start). A response is in the window iff its event time `t` (S3.2, nanoseconds) satisfies `since * 10^6 <= t < until * 10^6`, compared as BigInt.

S7.2. Event time: Claude `t_first`, the minimum instant over all copies of the key in the scan whatever chain holds them (R4.2, R6.3); Codex the envelope instant of the `token_usage_record` (for equal occurrences, the common instant).

S7.0. A window needs `since <= until` (an empty window when equal); `since > until` is a usage error in both implementations. Every comparison between the two implementations is made with an explicit `[since, until)`; the default window of the CLI (`until` = run start, `since` = first event) is a CLI convenience, not part of accounting.

S7.5. `replay_requests_excluded` counts, per accounted (not excluded) response in the window, its replayed representations (one per non-owner chain that holds a copy).

S7.3. The window selects what totals, priced counts, `tokens_unpriced`, `tokens_unpriced_by_reason`, the response level taint counters and the ledger counters count. Taint, families, live families, ownership, version status and every record-set relation are computed scan-wide, never windowed.

## S8. Pricing modifiers and verification (R3.1, R3.4, R3.8, R3.11, R3.12)

S8.1. Effective verification of a table object: `verified === true` (a boolean, not a string) and an effective `verified_at` (own, else the entry's, else the table's) that is a string starting with `YYYY-MM-DD`. Anything else is not verified.

S8.2. Geo `us` on a Claude final copy applies the multiplier `C32` only if all hold: the table-level object `modifiers.geo_us` is verified (S8.1, its own date or the table's), the model entry's `geo_us` object is verified (S8.1, inheriting from the entry and the table) and has `applies === true`. For a fast row, additionally `modifiers.fast_with_geo_us` is verified and the model's fast row has `geo_us_applies === true`. Any failure is `unpriced_modifier` (`geo_other` for the standard or tier row, `fast_geo_unverified` for the fast row).

S8.3. Fast: the model's fast row is used only if it is verified (S8.1); else `speed_fast_no_row`. Service tier rows `priority` and `batch` only if the entry has a verified row for that value; a tier row combined with fast or geo `us` is `service_tier_unpriced`. Haiku 5.5: `total_input > C26` (BigInt) selects the high tier, which must be verified.

S8.4. Modifiers come from the final copy alone. A final copy is a copy whose `usage.speed` is present (any value, `other` included). Several final copies must agree on all three modifiers, and a non-final copy that carries `inference_geo` or `service_tier` must carry the final copy's value, else `conflict_modifier`. A response without a final copy, or whose final copy lacks `inference_geo` or `service_tier`, is `modifier_unverified`.

S8.5. Codex: the tier gate makes every default-run response `modifier_unverified`. Under the test-only `codex_tier_for_test = standard`: a model is request scoped iff its `long_context` has `scope === "request"`, `scope_verified === true`, an effective date and a `scope_source_id` naming a table source; `in > C25` (BigInt) needs a verified long-context price row; `cw > 0` needs a write price.

S8.5a. Table prices are JSON strings of the grammar `^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$`; any other value (a number, an array, a string of another form) in any price row of any entry (verified or not, standard, fast, tiers, long context, service tier rows) makes the whole table malformed in both implementations, checked when the table is loaded, before any response is priced. Two entries with the same normalized model id make the table malformed. An entry is used only for its own provider (`anthropic` for Claude, `openai` for Codex). A `scope_source_id` names a source iff it is an own key of the table's `sources` object.

S8.6. The unpriced reason of a response is the first refusing gate in the order of R3.9 (revision 11.1), and its tokens go to that reason only.

S8.7. Money is BigInt picodollars: `tokens * price_units` per term, summed, then multiplied by 11 and divided by 10 once when geo `us` applies, with the division rounding half up. (If the spec rounding of R3.8 for the geo division is read differently by an implementation, that is a defect of this item and must be raised, not chosen locally.)

## S9. Taint (R0.9, revision 11.1)

S9.1. Families: links (i) shared root session (Claude `sessionId`, Codex `session_id` of a `session_meta` with the chain's id or of a `token_usage_record` of the chain), (ii) `forked_from_id` and `thread_spawn.parent_thread_id`, (iii) shared request keys. Computed over every parsed record of the scan, any version.

S9.2. Scope: Claude `request_anomaly` taints the chains holding a copy and their link (iii) component (chains connected through shared request keys, transitively), never over link (i). Every other reason taints the families of the chains it names, or the whole provider when it names none.

S9.3. A family is tainted iff one of its chains is tainted. `families_ordinal_unverified` counts the Codex families that hold a chain tainted with reason `ordinal_unverified`.

S9.4. A chain's link decides a boundary only when the chain and its parent chain are both untainted. A uuid of an untainted chain that resolves to a record of a tainted chain gives no `t_asm`, no `start_lo` and no lineage (R0.9 effect 4).

## S10. Chains, kinds and stream descriptors (R5.1, R5.2, R4.9, R4.11)

S10.0. Claude discovery follows S12.6a exactly: a path is discovered only at the listed depth and names (`<project>/<session>.jsonl` with a non-empty session stem, `<project>/<session>/subagents/...`), never by searching for a `subagents` segment anywhere.

S10.1. Claude chain: `(sessionId, agentId)` with `main` when `agentId` is `missing` or `bad`, or is the string `main` (all three are the main chain). Kind: `main` for the main chain, whatever file holds it; otherwise `workflow_agent` if a file holding any parsed record that names the chain (a string `sessionId` and that `agentId`, any record type and any version) lies under `subagents/workflows/wf_*/`, else `subagent`.

S10.2. Codex kind: `subagent` if the describing `session_meta` has `source.subagent.thread_spawn` or `thread_source` is `subagent` or `agent_created_thread`; `helper` for `automation`; `classifier` for `guardian_review`; `main` otherwise (`user`, `missing`, `other`, or no describing `session_meta`). Every request has exactly one kind of the R5.2 enum, so per-kind subtotals sum to the total (R5.8).

S10.3. Fields of a Codex stream that come from its `session_meta` and that R4.11 does not compare are decided over the SET of its own `session_meta` records (or, when it has none, of its copied ones), never by picking one record: the kind by the precedence `subagent` (any record with `thread_spawn` or `thread_source` `subagent` or `agent_created_thread`), then `helper` (`automation`), then `classifier` (`guardian_review`), then `main`; the subagent link parent `pt` and `source.subagent.other` only when every record of the set carries the same value, else the link is `unlinked` with reason `no_parent_id`. No order of records, files or lines can change these fields.

S10.4. A Codex thread is a fork iff an own `session_meta` of that id anywhere in the scan, in any file and whatever the file's assignment, has a non-null `forked_from_id` (R4.9: never dependent on the physical position). The prefix check (`fork_prefix_unresolved`) fires when ANY own record of the id with a non-null `forked_from_id` has a `subagent_history_start_ordinal` that is not a valid integer (S1.4), or when the stream is not `ordinal_verified`; it uses the `subagent_history_start_ordinal` of those own records, and applies to supported-version streams only.

S10.5. Replay ownership (R4.6) is decided for every Claude request key held by two or more logical streams, excluded keys included, so a tie gives `ownership_ambiguous` (counter and taint) also when the key is excluded for another reason.

## S12. Coverage counter definitions

S12.1. Windowed logical counters. Every counter of the ledger set (`records_usage_bearing`, `records_usage_unmappable`, `records_unkeyed`, `responses_total`, `requests_with_final_marker`, `responses_usage_range_failed`, `responses_usage_invariant_failed`, `responses_bucket_mismatch`, `requests_conflict`, `requests_conflict_modifier`, `replay_requests_excluded`, `replay_ownership_ambiguous`, `api_error_records`, `fields_range_failed`) counts the entries whose event time is in the window (S7.1) or unknown, and whose chain is not in a live family. An entry without a chain is never live.

S12.2. `requests_total` (per provider) is the number of accounted responses (owner representation, supported version, not excluded, not in a live family) whose event time is in the window; it equals the response count of the provider totals.

S12.0. `records_usage_bearing` counts logical records (S5 equality) that carry a usage object, of every chain, chainless and keyless records included, except API error records (R2.14: `isApiErrorMessage` true or model `<synthetic>`), which are not requests; every Codex `token_usage_record` counts. `records_usage_unmappable` counts those of them whose usage counters are `incomplete` or `range` (S4.3; a missing or bad timestamp does not make a record unmappable); `requests_with_final_marker` counts accounted Claude responses with a final copy; `fields_range_failed` counts R2.15 non-counter integers (`preTokens` and `postTokens` of a `system` record with subtype `compact_boundary` only, `cache_missed_input_tokens`, the token members `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens` and `thinkingTokens` of each model key of the top-level `modelUsage` object of a `cost-state` record (other members such as `costUSD` and `webSearchRequests` are not tokens and are not checked; no other path is read), Codex `thread_token_usage.total_tokens` of a record with a valid `thread_id`) that fail the range, once per logical record and field (for `modelUsage`, a field is a raw model key and member pair). All are ledger counters (S12.1).

S12.3. `records_unkeyed` counts usage-bearing records without a valid key (Claude `requestId`, Codex `response_id`) that are not API error records (R2.13, R2.14), whatever their chain key; a record that also lacks a chain key is counted here and is `unattributed_record` as well.

S12.4. `output_unknown_requests` counts accounted responses in the window whose output is unknown for any reason: no final copy (R2.3), `conflict_output` or `conflict_iterations`. (The headline count of R16.1 is a different, narrower number.)

S12.5. `baseline_requests_loaded` counts accounted responses whose event time is before `since` and that are not in a live family.

S12.6a. Discovery layout (both implementations): Claude logs are `<project>/<session>.jsonl` (main) and `<project>/<session>/subagents/agent-<id>.jsonl` and `<project>/<session>/subagents/workflows/wf_<run>/agent-<id>.jsonl`; sidecars are `agent-<id>.meta.json` and `agent-<id>.prefix.json` next to an agent log in either directory, `<project>/<session>/workflows/wf_<run>.json` and `<project>/<session>/subagents/workflows/wf_<run>/journal.jsonl`. Any other path is not discovered. A JSON sidecar larger than 8 MiB is unreadable (`files_unreadable`). `cost-state` records are a known record type (R1.2) wherever they occur.

S12.6. Files and lines. `files_total` counts every discovered file of the provider, sidecars included (Claude `agent-*.meta.json` and `agent-*.prefix.json` under `subagents/` and under `subagents/workflows/wf_*/`, `workflows/wf_*.json`, `journal.jsonl`). The fields of a workflow agent sidecar link nothing (R5.4). A JSON sidecar counts 1 in `lines_total`, and 1 in `lines_parse_error` when it does not parse (its taint names no chain, so it is provider-wide unless the file is live, R0.9). JSONL files (logs and journals) count each line in `lines_total` and follow R1.3 for `lines_parse_error` and `lines_truncated_tail`. A blank or whitespace-only terminated line is a line that fails `JSON.parse` (a parse error); only an unterminated last line that is empty after removing a BOM and a CR is not a line. An unreadable file counts in `files_unreadable` and adds no line.

S12.7. Model rows of the totals: a verified model is keyed by its normalized id, or `unlisted` when the table has no row; an unverified Claude response keeps its candidate id; a Claude response with no model at all is keyed `unlisted` (R14.3); an unverified Codex response has no model key (null).

## S11. Not compared

`reasoning` (Claude `thinking_tokens`, informational, R2.4) is not part of the compared output.
