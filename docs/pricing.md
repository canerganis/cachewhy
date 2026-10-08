# Pricing table

Table file: `src/pricing/table.json`. Table version `pt-2026-10-09.1`, prices verified on 2026-10-09, mode "current list price repricing". This is the table that `docs/methodology.md` section 3 (R3.1 to R3.9) and R7.2 refer to as `pricing/table.json`. This page explains it so an auditor can check it. The JSON is authoritative. The tables below are generated from it.

All prices are USD per 1M tokens, stored as decimal strings.

## Verification policy

* An entry or field is `verified: true` only if an official page listed under Sources states it. Everything else is `verified: false`.
* A `verified: false` entry, and a `verified: false` modifier or long-context object, MUST NOT produce dollars. The response's tokens are still reported and counted in `coverage.tokens_unpriced` (R3.3, R3.4, R3.9). A verified false object is treated exactly like a missing one.
* Absolute prices are what the runtime reads (R3.2). Multipliers are stored so the R3.2 ratio test can run. The ratio test runs on the effective multiplier object of each price row: the row's own object, or the multipliers of its entry when the row has none. A Claude `fast` row stores `fast.multipliers` and the Haiku 5.5 high tier row stores `tiers.high_multipliers`, each equal to the entry's `multipliers` (a test asserts the equality). Where a cache price in the table is derived by multiplication rather than printed on a page, the object says so (`cache_prices_derived`).
* `aliases` is empty everywhere. Aliases are never used for pricing (R3.3). The `id` of an entry is a table key. Only `model_ids` are matched, after stripping a trailing `-YYYYMMDD`.
* A `null` minimum cacheable length means unknown, and R7.2 abstains for it.

## Sources

| Id | URL | Used for |
|---|---|---|
| A1 | https://platform.claude.com/docs/en/about-claude/pricing | Anthropic prices, multipliers, fast, batch, geo, Haiku 5.5 tiers |
| A2 | https://platform.claude.com/docs/en/build-with-claude/prompt-caching | Cache TTL, minimum cacheable lengths, invalidation table |
| C1 | https://code.claude.com/docs/en/prompt-caching | Each model has its own cache (model switch) |
| C2 | https://code.claude.com/docs/en/costs | Cost reporting behavior |
| O1 | https://developers.openai.com/api/docs/pricing | OpenAI standard tier prices, long context, regional surcharge |
| O2 | https://developers.openai.com/api/docs/guides/prompt-caching | OpenAI cache write and read rules, minimums |
| CX1 | https://learn.chatgpt.com/docs/agent-configuration/speed | Codex Standard, Fast and Ultrafast speed options (service tier) |
| OM-gpt-6-astra | https://developers.openai.com/api/docs/models/gpt-6-astra | Long-context scope of `gpt-6-astra` |
| OM-gpt-6.1-sol | https://developers.openai.com/api/docs/models/gpt-6.1-sol | Long-context scope of `gpt-6.1-sol` |
| OM-gpt-6-sol | https://developers.openai.com/api/docs/models/gpt-6-sol | Long-context scope of `gpt-6-sol` |
| OM-gpt-6-luna | https://developers.openai.com/api/docs/models/gpt-6-luna | Long-context scope of `gpt-6-luna` |
| OM-gpt-5.6-sol | https://developers.openai.com/api/docs/models/gpt-5.6-sol | Long-context scope of `gpt-5.6-sol` |
| OM-gpt-5.6-terra | https://developers.openai.com/api/docs/models/gpt-5.6-terra | Long-context scope of `gpt-5.6-terra` |
| OM-gpt-5.6-luna | https://developers.openai.com/api/docs/models/gpt-5.6-luna | Long-context scope of `gpt-5.6-luna` |
| OM-gpt-5.5 | https://developers.openai.com/api/docs/models/gpt-5.5 | Long-context scope of `gpt-5.5` |
| OM-gpt-5.4 | https://developers.openai.com/api/docs/models/gpt-5.4 | Long-context scope of `gpt-5.4` |

The old OpenAI platform pricing URL redirects to O1.

## Anthropic entries

Ratios stored in the table: 5m write 1.25x input, 1h write 2x input, cache read 0.1x input by default. Exceptions: 0.025x on Fable 5.1 and Mythos 5.1, 0.05x on Opus 5.5 and Sonnet 5.5. Cache multipliers stack with fast mode, batch and the geo multiplier (A1). The geo multiplier also stacks with fast mode: A1 states that data residency multipliers apply on top of fast mode pricing.

Min tokens is the minimum cacheable length (A2). Geo us is the 1.1x `inference_geo` multiplier (`C32`). A1 states it for 4.6 and later models, on all token categories including cache writes and reads. For older models the table has `applies: null, verified: false`, shown as "unverified", so `inference_geo` us gives no dollars for them.

| Model id | Input | 5m write | 1h write | Cache read | Output | Min tokens | Fast (in/out) | Geo us |
|---|---|---|---|---|---|---|---|---|
| `claude-fable-5-1` | 10 | 12.5 | 20 | 0.25 | 50 | 512 | none | yes |
| `claude-mythos-5-1` | 10 | 12.5 | 20 | 0.25 | 50 | 512 | none | yes |
| `claude-fable-5` | 10 | 12.5 | 20 | 1 | 50 | 512 | none | yes |
| `claude-mythos-5` | 10 | 12.5 | 20 | 1 | 50 | 512 | none | yes |
| `claude-opus-5-5` | 4 | 5 | 8 | 0.2 | 20 | 512 | 8/40 | yes |
| `claude-opus-5` | 5 | 6.25 | 10 | 0.5 | 25 | 512 | 10/50 | yes |
| `claude-opus-4-8` | 5 | 6.25 | 10 | 0.5 | 25 | 1024 | 10/50 | yes |
| `claude-opus-4-7` | 5 | 6.25 | 10 | 0.5 | 25 | 2048 | none | yes |
| `claude-opus-4-6` | 5 | 6.25 | 10 | 0.5 | 25 | 4096 | none | yes |
| `claude-opus-4-5` | 5 | 6.25 | 10 | 0.5 | 25 | 4096 | none | unverified |
| `claude-opus-4-1` | 15 | 18.75 | 30 | 1.5 | 75 | 1024 | none | unverified |
| `claude-opus-4` | 15 | 18.75 | 30 | 1.5 | 75 | 1024 | none | unverified |
| `claude-sonnet-5-5` | 2 | 2.5 | 4 | 0.1 | 10 | 512 | none | yes |
| `claude-sonnet-5` | 2 | 2.5 | 4 | 0.2 | 10 | 1024 | none | yes |
| `claude-sonnet-4-6` | 3 | 3.75 | 6 | 0.3 | 15 | 1024 | none | yes |
| `claude-sonnet-4-5` | 3 | 3.75 | 6 | 0.3 | 15 | 1024 | none | unverified |
| `claude-sonnet-4` | 3 | 3.75 | 6 | 0.3 | 15 | 1024 | none | unverified |
| `claude-haiku-4-5` | 1 | 1.25 | 2 | 0.1 | 5 | 4096 | none | unverified |
| `claude-haiku-3-5` | 0.8 | 1 | 1.6 | 0.08 | 4 | 2048 | none | unverified |
| `claude-haiku-5-5` | 0.1 | 0.125 | 0.2 | 0.01 | 0.5 | 512 | none | yes |
| `claude-haiku-5-5` above 100000 total input | 0.5 | 0.625 | 1 | 0.05 | 2.5 | 512 | none | yes |

Haiku 5.5 uses the low row when `total_input` is at most 100000 and the high row above it (`C26`).

Notes on specific values:

* Sonnet 5.5 cache read is 0.1 (0.05x of 2). A secondary local copy of Anthropic pricing said 0.2. The live page A1 says 0.1, and the table uses 0.1.
* 4.6 and later models other than Haiku 5.5 bill the full 1M context at standard rates (A1). Their `long_context` object says `surcharge: none`. Older models have `long_context: null` because the pages used state no long-context price for them. Methodology R3.4 defines no Claude long-context rule, so this is recorded here and not interpreted.
* Fast rows exist for Opus 5.5 (8 input, 40 output), Opus 5 and Opus 4.8 (10 input, 50 output). Their cache prices are derived by applying the cache multipliers of the entry to the fast input price. Each fast row carries `geo_us_applies: true`, because A1 states the geo multiplier on top of fast mode pricing. Fast mode is not available on Opus 4.7, and on Opus 4.6 A1 says requests run at standard speed and are billed at standard rates, so those models have no fast row.
* Batch is 50 percent off input and output (A1) and is stored under `modifiers.batch` with `priced_at_runtime: false`. No per-model absolute batch rows exist, so a batch response is `unpriced_modifier` under R3.4.
* A response with `speed` fast and `inference_geo` us is priced at the fast row times 1.1 (`modifiers.fast_with_geo_us`, verified true, A1). Example for Opus 5.5 with 20000 tokens moved from a 1h write to a read: standard row 0.156 USD, fast row 0.312 USD, fast with geo us 0.3432 USD.
* `claude-mythos-5` is priced at 10 input, 12.5 and 20 for cache writes, 1 for cache reads and 50 output (A1), with a minimum cacheable length of 512 (A2) and the same limited availability note as Mythos 5.1.
* Mythos 5 and Mythos 5.1 are listed as limited availability, Opus 4.1, Opus 4 and Haiku 3.5 as retired. They are priced because A1 prices them.

## Which Claude responses these rows apply to (R3.12)

The price rows above (standard, fast, geo, batch) are chosen from the modifiers `speed`, `inference_geo` and `service_tier`, which are read from the final copy of a response only. A response without a final copy has no verified price row. It gets no dollars (reason `modifier_unverified`), not a standard price and not a range, and an event whose previous or current response is such a response is tokens-only. The table needs no field for this. An unverified speed cannot be turned into a bound, because the same tokens cost twice as much in fast mode.

## OpenAI entries

GPT-5.6 and later charge 1.25x input for cache writes and 0.1x for cached input (0.05x on `gpt-6.1-sol`), and have a 1024 token minimum (O2). GPT-5.5 and earlier have no stated write charge on O2 and a model-dependent cached rate, so the table stores the cached price printed on O1 and no multipliers. Per R3.6, a response on those models with cache write tokens above 0 gets no dollars, because no write price exists.

Long context means input above 272000 tokens (`C25`). O1 prints exact long-context prices for `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` and `gpt-5.4`, and these are stored with `verified: true` and the cache multipliers of the long-context row (2x input, 1.5x output). The model page of each states whether the long-context rate applies to the full request or the full session: `request` for the first seven, `session` for `gpt-5.5` and `gpt-5.4` (sources `OM-<model id>`, `scope_verified: true`). Entries without any long-context object give no dollars (R3.10).

Cached mult and Write mult are the documented ratios ("none" means not documented). Long context shows input, cached input, cache write and output prices, then the scope stated on the model page.

| Model id | Input | Cached input | Cache write | Output | Cached mult | Write mult | Min tokens | Long context over 272000 input (scope) |
|---|---|---|---|---|---|---|---|---|
| `gpt-6-astra` | 10 | 1 | 12.5 | 50 | 0.1 | 1.25 | 1024 | 20/2/25/75 (request) |
| `gpt-6.1-sol` | 2 | 0.1 | 2.5 | 10 | 0.05 | 1.25 | 1024 | 4/0.2/5/15 (request) |
| `gpt-6-sol` | 2 | 0.2 | 2.5 | 10 | 0.1 | 1.25 | 1024 | 4/0.4/5/15 (request) |
| `gpt-6-luna` | 0.1 | 0.01 | 0.125 | 0.5 | 0.1 | 1.25 | 1024 | 0.2/0.02/0.25/0.75 (request) |
| `gpt-5.6-sol` (promo) | 4 | 0.4 | 5 | 20 | 0.1 | 1.25 | 1024 | 8/0.8/10/30 (request) |
| `gpt-5.6-terra` | 2 | 0.2 | 2.5 | 12 | 0.1 | 1.25 | 1024 | 4/0.4/5/18 (request) |
| `gpt-5.6-luna` | 0.2 | 0.02 | 0.25 | 1.2 | 0.1 | 1.25 | 1024 | 0.4/0.04/0.5/1.8 (request) |
| `gpt-5.5` | 5 | 0.5 | none | 30 | none | none | unknown | 10/1/none/45 (session, no dollars) |
| `gpt-5.4` | 2.5 | 0.25 | none | 15 | none | none | unknown | 5/0.5/none/22.5 (session, no dollars) |
| `gpt-5.4-mini` | 0.75 | 0.075 | none | 4.5 | none | none | unknown | no entry, no dollars |
| `gpt-5.3-codex` | 1.75 | 0.175 | none | 14 | none | none | unknown | no entry, no dollars |
| `gpt-5.2` | 1.75 | 0.175 | none | 14 | none | none | unknown | no entry, no dollars |
| `gpt-5.1` | 1.25 | 0.125 | none | 10 | none | none | unknown | no entry, no dollars |
| `gpt-5` | 1.25 | 0.125 | none | 10 | none | none | unknown | no entry, no dollars |
| `gpt-5-mini` | 0.25 | 0.025 | none | 2 | none | none | unknown | no entry, no dollars |

Other notes:

* `gpt-5.6-sol` is a promotion price through at least 2026-11-21 (`price_valid_through_at_least`). Repricing after that date needs a new table version.
* `gpt-5.4` and `gpt-5.5` rows are the under 272K prices.
* `gpt-5.3-codex` has a fast row (3.5 input, 0.35 cached, 28 output), twice the standard row. O1 and CX1 list Fast and Ultrafast options above Standard for other models too. The tier is not observable in Codex logs, so no Codex response is priced (see the service tier section below) and the fast row is a printed fact that is not applied.
* Regional and FedRAMP endpoints add 10 percent (`modifiers.openai_regional_endpoint`). Not observable, not applied.
* The OpenAI prices above are the Standard tier rows of O1. They are price facts for the row selection of R3.6 and R3.10, not a statement that a logged response ran on the Standard tier (next section).

## Codex service tier (R3.4)

Codex has Standard, Fast and Ultrafast options, and the faster options cost more for the same model (O1, CX1; checked 2026-10-09: for `gpt-6.1-sol` Fast is twice the Standard price and Ultrafast six times). No field that the logs retain shows the tier of a response (Q9). A Standard price is therefore not an observational bound. Example: `gpt-6.1-sol`, `K_prev = 20000`, `R = 0`, `cw = 20000`, `U = 0` gives 0.048 USD at the Standard row and 0.096 USD at the Fast row. With table `pt-2026-10-09.1` a Codex response is `unpriced_modifier` with reason `modifier_unverified`: tokens are reported and counted as unpriced, and no dollars and no dollar delta are produced, whatever the model, the input size or the long-context scope. The table records this in `modifiers.openai_service_tier` (`observable_in_logs: false`, `priced_at_runtime: false`). The Standard rows stay in the table so the row selection can be tested (test-only parameter `codex_tier_for_test = standard`) and so a later revision with a tier field in the logs can use them. A Standard-normalized scenario is not part of this table version.

## Entries that give no dollars

These are in the table with `verified: false` and null prices. A model with no row at all is `unknown_model` (R3.3), which has the same effect on dollars.

| Model id | Reason |
|---|---|
| `mythos-preview` | The minimum cacheable length is on A2. No price for this model is on the pages used, so it produces no dollars. |
| `gpt-5-codex` | No price for this model is on O1. It produces no dollars. |
| `gpt-5.1-codex` | No price for this model is on O1. It produces no dollars. |
| `gpt-5.1-codex-max` | No price for this model is on O1. It produces no dollars. |
| `gpt-5.1-codex-mini` | No price for this model is on O1. It produces no dollars. |
| `gpt-5.2-codex` | No price for this model is on O1. It produces no dollars. |

The prices of the Codex model variants above are not on O1. Which model Codex CLI uses by default is also not stated on the pages used. No GPT-6 Codex variant is listed. `codex-auto-review` and `gpt-5.3-codex-spark` have no row (R3.7).

## Long-context scope and what R3.10 does to a response

Two facts are kept apart for every long-context object (R3.10, R3.11). `verified` says the prices were checked against the cited page. `scope_verified` with `scope_source_id` says the model page states whether the long-context price follows the request or the session. Verifying prices never verifies scope. In table `pt-2026-10-09.1` every long-context object has both: the model pages of `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` and `gpt-5.6-luna` say the rate applies to the full request (`scope: request`), and the pages of `gpt-5.5` and `gpt-5.4` say it applies to the full session (`scope: session`).

R3.10 decides per response and groups nothing. A Codex model with a verified `request` scope is priced at the standard row up to 272000 input tokens and at its verified long-context row above. Every other model is unpriced (reason `long_context_scope`) at any input size: a session scope or unknown scope cannot be priced because the log cannot show that every thread and file of a session was scanned (Q30, Q31). The service tier gate of R3.4 is evaluated first (previous section): with table `pt-2026-10-09.1` every Codex response is token-only in a default run, reason `modifier_unverified`. The row selection above is the one that applies when the tier is verified, and is exercised in tests with `codex_tier_for_test = standard`: then the seven request-scoped models can get dollars when their model attribution is verified (R2.10), and every response of `gpt-5.5`, `gpt-5.4` and of each Codex model without a long-context object is token-only with reason `long_context_scope`. Unpriced responses count in `tokens_unpriced`, and an event whose previous or current response is unpriced gets a token bound and no dollar delta.

## Changes in table `pt-2026-10-09.1`

The audit of spec revision 8 (round 8) found no price mismatch: fast with geo, Mythos 5, the reviewed minimum lengths and the request and session scopes agree with the official pages. No price value, minimum length or scope is changed in this version, and `verified_at` stays 2026-10-09. The version `pt-2026-10-09` is not edited. Changes:

* `modifiers.openai_service_tier` is added (`observable_in_logs: false`, `priced_at_runtime: false`) with source `CX1`. A Codex response gets no dollars because its tier is not observable (R3.4).
* The `gpt-5.3-codex` fast row note no longer says that the Standard tier is assumed.
* `fast.multipliers` (Opus 5.5, Opus 5, Opus 4.8) and `tiers.high_multipliers` (Haiku 5.5) are stored, equal to the multipliers of their entry, so the ratio test runs on an explicit object for every row (R3.2).
* `table_version` is `pt-2026-10-09.1`, which matches the pattern of R14.5 (`^pt-[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]+)?$`).

## Changes in table `pt-2026-10-09`

The audit of spec revision 7 listed the statements below as stale. They are corrected in this table version, and the old version `pt-2026-10-08` is not edited.

* `modifiers.fast_with_geo_us` is verified true and each fast row has `geo_us_applies: true`.
* `claude-mythos-5` has a verified price row.
* Exact long-context prices are stored, with the cache multipliers of the row, for `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5` and `gpt-5.4`. The approximate-price objects and the notes saying that O1 prints no exact price are removed.
* Per-model `scope`, `scope_verified` and `scope_source_id` are recorded from the model pages (sources `OM-<model id>`).
* The standard rows, the minimum cacheable lengths and the no-price entries were checked against A1, A2 and O1 again on 2026-10-09 and did not change.

## Open items carried from the pricing rules

* The exact cached input multiplier for GPT-5.5 and earlier. O2 says only "model-dependent", while the O1 prices imply about 0.1x. Not stored as a multiplier.
* The Anthropic invalidation table on A2 does not list a model switch. The per-model cache is documented on C1, and the table relies on C1 for that.
* Bedrock TTL availability and minimums vary by model. This table covers the Claude API, Claude Platform on AWS, Google Cloud and Foundry values stated on A2.
* Community claims (an old default TTL change, an `ENABLE_PROMPT_CACHING_1H` bug) are not authoritative and are not used.

## How an auditor checks this

1. Read `src/pricing/table.json` and compare each `prices_usd_per_mtok`, `fast`, `tiers`, `min_cacheable_tokens` and `long_context` value with the cited page (`source_ids`, resolved through `sources`).
2. Run the R3.2 ratio test: for every price row with an effective multiplier object (its own, or the one of its entry; fast rows and the Haiku 5.5 high row store `multipliers` / `high_multipliers` explicitly), input price of the row times the multiplier equals the stored cache price. The generator of this table asserted that against the page-listed numbers.
3. Check the R3.7 expectation list: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1`, `claude-haiku-4-5`, `claude-haiku-5-5`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6-astra`, `gpt-5.6-luna` and `gpt-5.5` all have `verified: true`, and `claude-mythos-5` has a price row. `codex-auto-review` and `gpt-5.3-codex-spark` have no row.
4. Check the R7.2 minimum list in methodology against `min_cacheable_tokens`.
5. Confirm every `verified: false` object is excluded from dollar output.
6. For every long-context object check the prices against O1, then separately `scope`, `scope_verified` and `scope_source_id` against the model page named by the source id, and the ratio test of the long-context row (cache prices against the long-context input price times the stored multiplier).
7. Check that `fast_with_geo_us` is verified and that each fast row has `geo_us_applies`.
8. Check that `modifiers.openai_service_tier` has `observable_in_logs: false` and that no Codex row or note says the Standard tier is assumed.
