# src/model

Shared domain types for every cachewhy module. One file: `types.ts`. Binding spec: `docs/methodology.md` (spec-1, revision 9). Rule ids in comments (`R4.8`) point to it.

`types.ts` holds types, enum value lists, the pre-registered constants C1 to C34 (`CONSTANTS`), and a few pure helpers (`rat`, `chainKeyString`, `countsInTotals`, `contextTokens`, `writeTokens`, `cachedPrefix`, `cachedPrefixUpper`, `pricedAmount`, `emptyCoverage`, `mergeCoverage`). It does no I/O and no parsing. Only the owner of this file changes it; ask for new fields or enum values instead of widening types locally.

## Conventions

* Tokens are `bigint` from the moment the range check of R2.15 passes (R2.16). Money is `bigint` picodollars (1e-12 USD, R3.8). Epoch milliseconds are `number` and are never token quantities.
* Serialization is the writer's job: every `bigint` becomes a decimal string, raw ids become `req_<hex>`, `chain_<N>`, `sess_<N>` (R14.4, R14.5, R17.1). Nothing in `types.ts` is JSON ready.
* Raw ids (`key`, `uuid`, session, agent and thread ids) live only inside the process. No type here carries a path, a name or free text (R1.1). `DiscoveredFile` (from `src/discover.ts`) is the only input type that holds paths, and no result type copies from it. Files are referred to by `FileIndex` and labelled `file_<N>` on output (R14.6).
* Absent is `null`, never a default value (R2.12, R3.4). A modifier or count that is unknown is not 0.

## Data model in one paragraph

A parser turns files into `Response` objects, one per `(provider, key, chain)`. A response is `ClaudeResponse` or `CodexResponse` (discriminated by `provider`). Its `usage` (`UsageBuckets`) is non-null exactly when `exclusion` is null; an excluded response (conflict, incomplete, range failed, invariant failed) keeps its identity and time so it can still sit between `P` and `C` (R6.2), but it has no counters. Keyless or unverified-version records are `ExcludedRecord`s instead. A key replayed into a non-owning stream appears there as a response with `ownership.role = "replayed"`: it carries the owner's counters (history for the TTL set and for `P`) but `countsInTotals` is false (R4.7). Totals, dollars, events and boundaries use `countsInTotals` only. `Stream` is the logical stream of R4.11 (integrity, ordinal verification, fork facts). `Link` is the linkage of an agent chain. `buildGraph` adds `GraphNode`s (parallel array to `Graph.responses`): chain order, `prev`, ties, excluded-between, TTL set, gap bounds, window membership. `detectEvents` later produces `RebuildEvent` and `Boundary` objects; `priceResponse` produces a `PricedResponse` per response.

## Exported API (grouped)

Primitives: `Provider`, `PROVIDERS`, `TableProvider`, `Tokens`, `Pico`, `EpochMs`, `DecimalString`, `Rational`, `rat`, `TimeWindow`.

Constants: `CONSTANTS` (C1 to C34 by spec name), `CLAUDE_FULL_VERSIONS`, `CODEX_FULL_VERSIONS`, `SPEC_ID`, `SCHEMA_ID`, `SupportLevel`.

Enums (each a `const` array plus a type): `RequestKind`, `Speed`, `Geo`, `ServiceTier`, `Effort`, `StopReason`, `Entrypoint`, `ModelSource`, `ExclusionReason`, `ExcludedRecordReason`, `ResponseFlag`, `ConflictKind`, `LinkState`, `UnlinkedReason`, `StreamIntegrityReason`, `GateAbstainCode`, `AbstainCode`, `NumericOutcome`, `PairOutcome`, `BoundaryType`, `Cause`, `EvidenceLevel`, `Confidence`, `Signal`, `TtlClass`, `ExpiryStatus`, `GapBasis`, `DeltaStatus`, `DeltaReason`, `DiagType`, `PairTag`, `Assumption`, `DriftCode`, `HeadlineStatus`, `UnpricedModifierReason`, `UnpricedReason`, `PriceRowKind`, `ReportCommand`.

Pricing table: `PricingTable` and `TableModelEntry` (JSON shape of `src/pricing/table.json`), `PriceRow`, `LongContextPrice`, `ModelPrice`, `PriceBook` (prepared, integer units of 1e-6 USD per MTok).

Responses: `ChainKey`, `chainKeyString`, `UsageBuckets`, `Modifiers`, `ModelAttribution`, `TimeInfo`, `Ownership`, `Provenance`, `FileIndex`, `Diagnostics`, `ResponseBase`, `ClaudeResponse`, `CodexResponse`, `Response`, `ExcludedRecord`, `DedupConflict`, `countsInTotals`, `contextTokens`, `writeTokens`, `cachedPrefix`, `cachedPrefixUpper`.

Files, streams, markers: `FileInfo`, `ForkInfo`, `Stream`, `Link`, `ClaudeUuidNode`, `ClaudeCompactBoundary`, `CodexCompaction`, `AgentPrefixHint`, `CostStateUsage`, `CodexThreadTotal`.

Coverage: `CoverageCounters`, `COVERAGE_COUNT_FIELDS`, `COVERAGE_TOKEN_FIELDS`, `PHYSICAL_COVERAGE_COUNTERS`, `UNLOGGED_BUCKETS`, `emptyCoverage`, `mergeCoverage`, `DriftFinding`. Every counter named in R17.1 exists, plus the numerators the drift codes need (`records_usage_unmappable`, `responses_usage_invariant_failed`, `requests_with_final_marker`), `streams_total`, `token_count_events_without_response_id`, `pairs_no_event`, `pairs_event`, `pairs_boundary`. Reason and code counts are the `*_by_reason`, `*_by_kind` and `*_by_code` records and must sum to the plain counter of the same name.

Parsing: `ParseOptions`, `ParseResult`, `ClaudeParseResult`, `CodexParseResult`, and the function types `ParseClaude`, `ParseCodex`.

Graph: `TtlSet`, `GapBounds`, `GraphNode`, `Chain`, `Graph`, `GraphOptions`, function type `BuildGraph`.

Pricing results: `PricedAmount`, `pricedAmount`, `ResolvedRates`, `PricedResponse`, function types `LoadPriceBook`, `PriceResponse`.

Events: `CauseCandidate`, `EventDelta`, `LinkageKind`, `PairRef`, `RebuildEvent`, `Boundary`, `PairVerdict`, `DetectionResult`, function type `DetectEvents`.

Report: `ProviderTotals`, `HeadlineFigures`, `ReportOptions`, `ReportInput`, function types `BuildReportInput`, `RenderReport`, and `CachewhyModules` (all signatures as one interface).

## Module contracts

Implementers should declare their export with the matching function type so a signature change fails the typecheck:

```ts
export const parseClaude: ParseClaude = async (files, opts) => { /* ... */ };
```

Suggested locations (not enforced): `src/parse/claude.ts`, `src/parse/codex.ts`, `src/graph/build.ts`, `src/pricing/load.ts` and `src/pricing/price.ts`, `src/detect/`, `src/report/`.

* `parseClaude(files, opts)` and `parseCodex(files, opts)` take the `DiscoveredFile[]` of `discover()`, ignore files of the other provider, never throw on bad input (failures become coverage counters, R1.3, R14.6) and return `{ responses, excluded, coverage, conflicts, links, streams, files, assumptions }` plus provider specific data (`uuid_index`, `compact_boundaries`, `prefix_hints`, `cost_state` for Claude; `compactions`, `thread_totals`, `forked_from_ids` for Codex). The parser applies the allowlist of R1.2 (everything else is dropped), dedup (R4), ownership (R4.6 to R4.8), model attribution (R2.10, R2.17), linkage (R5.3 to R5.6) and stream verification (R4.11 to R4.13). Responses of baseline time are included; windowing is the graph's job (R5.10).
* `buildGraph(parsed, opts)` merges parse results, sorts each chain by `(event_ms, key)` (R6.1), computes `prev`, ties, excluded-between, the TTL set (R9.2) and gap bounds (R6.4 to R6.6) per node, and marks `in_window`. It makes no eligibility, boundary or numeric decision.
* `loadPriceBook(table)` and `priceResponse(response, book)` implement section 3. Pricing decides each response on its own attribution, modifiers and `in` (R3.10). `PricedResponse.rates` exposes the rates applied so the delta code (R8.5, R8.6) never re-derives them.
* `detectEvents(graph, priced, book)` (sections 7 to 11) is a placeholder signature; `RebuildEvent` and `Boundary` list the fields only.
* `buildReportInput(...)` and `renderReport(input)` consume and render `ReportInput`. The JSON writer for schema `cachewhy/1` takes the same `ReportInput`.

## Notes for implementers

* `ModelAttribution.model` is `candidate` only when `verified`; otherwise null, which means `model_unknown` (R2.10): tokens reported, no dollars, pairs abstain.
* `Response.flags` holds non-exclusion facts (`bucket_mismatch`, `output_unknown`, `speed_assumed`, `ownership_ambiguous`, `fork_first_own`, and so on). Exclusions are in `exclusion`, never in `flags`.
* Codex fields that spec section 6.5 forces unknown are typed accordingly: `TimeInfo.start_lo_ms` is null and `gap_basis` is `none` for every Codex response; `GapBounds.min_ms` is therefore null for Codex.
* `UsageBuckets.reasoning` is informational and is never added to output (R2.4, R2.8). `reasoning_included_in_output` is true for Codex and false for Claude (Q3).
* `contextTokens` is `ctx(X)` of R7.1 for both providers (`i + r + w` and `in`). `cachedPrefix` is `K(X)`. `cachedPrefixUpper` is `K_hi(X)` (equal to `K` for Claude, `in` for Codex).
* `pricedAmount(pico, reason)` keeps `usd` equal to the decimal string of `pico`; build amounts through it.
* `UNLINKED_REASONS` merges the Claude (R5.3) and Codex (R5.6) reasons, plus three workflow directory reasons that the spec leaves unnamed (R5.4 only says "unlinked"). They are an implementation detail and can be renamed with the owner of this file.
* Enum lists that the spec leaves open (`SIGNALS`, `PAIR_TAGS`, `UNPRICED_MODIFIER_REASONS`) follow the cause and modifier rows of R3.4 and R11.5. A new value needs a change here, a schema test update and an allowlist entry (R14.3).
