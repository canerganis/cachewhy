# Pricing table

Table file: `src/pricing/table.json`. Table version `pt-2026-10-08`, verified on 2026-10-08, mode "current list price repricing". This is the table that `docs/methodology.md` section 3 (R3.1 to R3.9) and R7.2 refer to as `pricing/table.json`. This page explains it so an auditor can check it. The JSON is authoritative. The tables below are generated from it.

All prices are USD per 1M tokens, stored as decimal strings.

## Verification policy

* An entry or field is `verified: true` only if an official page listed under Sources states it. Everything else is `verified: false`.
* A `verified: false` entry, and a `verified: false` modifier or long-context object, MUST NOT produce dollars. The response's tokens are still reported and counted in `coverage.tokens_unpriced` (R3.3, R3.4, R3.9). A verified false object is treated exactly like a missing one.
* Absolute prices are what the runtime reads (R3.2). Multipliers are stored so the R3.2 ratio test can run. Where a cache price in the table is derived by multiplication rather than printed on a page, the object says so (`cache_prices_derived`).
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

The old OpenAI platform pricing URL redirects to O1.

## Anthropic entries

Ratios stored in the table: 5m write 1.25x input, 1h write 2x input, cache read 0.1x input by default. Exceptions: 0.025x on Fable 5.1 and Mythos 5.1, 0.05x on Opus 5.5 and Sonnet 5.5. Cache multipliers stack with fast mode, batch and the geo multiplier (A1).

Min tokens is the minimum cacheable length (A2). Geo us is the 1.1x `inference_geo` multiplier (`C32`). A1 states it for 4.6 and later models. For older models the table has `applies: null, verified: false`, shown as "unverified", so `inference_geo` us gives no dollars for them.

| Model id | Input | 5m write | 1h write | Cache read | Output | Min tokens | Fast (in/out) | Geo us |
|---|---|---|---|---|---|---|---|---|
| `claude-fable-5-1` | 10 | 12.5 | 20 | 0.25 | 50 | 512 | none | yes |
| `claude-mythos-5-1` | 10 | 12.5 | 20 | 0.25 | 50 | 512 | none | yes |
| `claude-fable-5` | 10 | 12.5 | 20 | 1 | 50 | 512 | none | yes |
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
* Fast rows exist for Opus 5.5 (8 input, 40 output), Opus 5 and Opus 4.8 (10 input, 50 output). Their cache prices are derived by applying the entry's cache multipliers to the fast input price.
* Batch is 50 percent off input and output (A1) and is stored under `modifiers.batch` with `priced_at_runtime: false`. No per-model absolute batch rows exist, so a batch response is `unpriced_modifier` under R3.4.
* Combining a fast row with the geo multiplier is not stated on A1 (`modifiers.fast_with_geo_us`, verified false). A response with `speed` fast and `inference_geo` us gets no dollars.
* Mythos 5.1 is listed as limited availability, Opus 4.1, Opus 4 and Haiku 3.5 as retired. They are priced because A1 prices them.

## OpenAI entries

GPT-5.6 and later charge 1.25x input for cache writes and 0.1x for cached input (0.05x on `gpt-6.1-sol`), and have a 1024 token minimum (O2). GPT-5.5 and earlier have no stated write charge on O2 and a model-dependent cached rate, so the table stores the cached price printed on O1 and no multipliers. Per R3.6, a response on those models with cache write tokens above 0 gets no dollars, because no write price exists.

Long context means input above 272000 tokens (`C25`). Only `gpt-6-sol` and `gpt-5.5` have exact long-context prices on O1. For the other GPT-6, GPT-5.6 and GPT-5.4 entries O1 says about 2x on input and 1.5x on output. Those entries keep the multipliers and an `approximate_prices_usd_per_mtok` object for reference only, with `verified: false`, so they give no dollars above 272000 input tokens. Entries without any long-context object also give no dollars above 272000 (R3.4).

Cached mult and Write mult are the documented ratios ("none" means not documented). Long context shows input, cached input, cache write and output prices.

| Model id | Input | Cached input | Cache write | Output | Cached mult | Write mult | Min tokens | Long context over 272000 input |
|---|---|---|---|---|---|---|---|---|
| `gpt-6-astra` | 10 | 1 | 12.5 | 50 | 0.1 | 1.25 | 1024 | unverified, no dollars |
| `gpt-6.1-sol` | 2 | 0.1 | 2.5 | 10 | 0.05 | 1.25 | 1024 | unverified, no dollars |
| `gpt-6-sol` | 2 | 0.2 | 2.5 | 10 | 0.1 | 1.25 | 1024 | 4/0.4/5/15 |
| `gpt-6-luna` | 0.1 | 0.01 | 0.125 | 0.5 | 0.1 | 1.25 | 1024 | unverified, no dollars |
| `gpt-5.6-sol` (promo) | 4 | 0.4 | 5 | 20 | 0.1 | 1.25 | 1024 | unverified, no dollars |
| `gpt-5.6-terra` | 2 | 0.2 | 2.5 | 12 | 0.1 | 1.25 | 1024 | unverified, no dollars |
| `gpt-5.6-luna` | 0.2 | 0.02 | 0.25 | 1.2 | 0.1 | 1.25 | 1024 | unverified, no dollars |
| `gpt-5.5` | 5 | 0.5 | none | 30 | none | none | unknown | 10/1/none/45 |
| `gpt-5.4` | 2.5 | 0.25 | none | 15 | none | none | unknown | unverified, no dollars |
| `gpt-5.4-mini` | 0.75 | 0.075 | none | 4.5 | none | none | unknown | no entry, no dollars |
| `gpt-5.3-codex` | 1.75 | 0.175 | none | 14 | none | none | unknown | no entry, no dollars |
| `gpt-5.2` | 1.75 | 0.175 | none | 14 | none | none | unknown | no entry, no dollars |
| `gpt-5.1` | 1.25 | 0.125 | none | 10 | none | none | unknown | no entry, no dollars |
| `gpt-5` | 1.25 | 0.125 | none | 10 | none | none | unknown | no entry, no dollars |
| `gpt-5-mini` | 0.25 | 0.025 | none | 2 | none | none | unknown | no entry, no dollars |

Other notes:

* `gpt-5.6-sol` is a promotion price through at least 2026-11-21 (`price_valid_through_at_least`). Repricing after that date needs a new table version.
* `gpt-5.4` and `gpt-5.5` rows are the under 272K prices.
* `gpt-5.3-codex` has a fast row (3.5 input, 0.35 cached, 28 output). The tier is not observable in Codex logs, so standard is assumed (R3.4).
* Regional and FedRAMP endpoints add 10 percent (`modifiers.openai_regional_endpoint`). Not observable, not applied.
* Prices are the standard tier. Codex model attribution rules (R2.10) still decide whether a Codex response is priced at all.

## Entries that give no dollars

These are in the table with `verified: false` and null prices. A model with no row at all is `unknown_model` (R3.3), which has the same effect on dollars.

| Model id | Reason |
|---|---|
| `claude-mythos-5` | The minimum cacheable length is on A2. No price for this model is on the pages used, so it produces no dollars. |
| `mythos-preview` | The minimum cacheable length is on A2. No price for this model is on the pages used, so it produces no dollars. |
| `gpt-5-codex` | No price for this model is on O1. It produces no dollars. |
| `gpt-5.1-codex` | No price for this model is on O1. It produces no dollars. |
| `gpt-5.1-codex-max` | No price for this model is on O1. It produces no dollars. |
| `gpt-5.1-codex-mini` | No price for this model is on O1. It produces no dollars. |
| `gpt-5.2-codex` | No price for this model is on O1. It produces no dollars. |

The prices of the Codex model variants above are not on O1. Which model Codex CLI uses by default is also not stated on the pages used. No GPT-6 Codex variant is listed. `codex-auto-review` and `gpt-5.3-codex-spark` have no row (R3.7).

## Long-context scope and what R3.10 does to a response

Two facts are kept apart for every long-context object (R3.10, R3.11). `verified` says the prices were checked against the cited page. `scope_verified` with `scope_source_id` says the page states whether the long-context price follows the request or the session. Verifying prices never verifies scope. In table `pt-2026-10-08` no object has `scope_verified: true`, so no model has a verified `request` scope.

Since spec revision 7, R3.10 decides per response and groups nothing. A Codex model with a verified `request` scope is priced at the standard row up to 272000 input tokens and at a verified long-context row above. Every other model is unpriced (reason `long_context_scope`) at any input size: a session scope or unknown scope cannot be priced because the log cannot show that every thread and file of a session was scanned (Q30, Q31). With table `pt-2026-10-08` this means every Codex response is unpriced and Codex figures are token bounds only, until a later table version records a verified `request` scope with its source for a model. Unpriced responses count in `tokens_unpriced`, and an event whose previous or current response is unpriced gets a token bound and no dollar delta.

## Statements known to be stale (round 5)

The audit of revision 5 found that the following statements on this page no longer match the current official pages. The flags in `src/pricing/table.json` still decide behavior, and every one of these cases gives no dollars, which is the safe direction. They are corrected together with the table in a new table version (`pt-...`) that is audited under G0-pricing (R15.1). Nothing is edited in `pt-2026-10-08` in place.

* "Combining a fast row with the geo multiplier is not stated on A1" and `fast_with_geo_us` verified false. A1 now states that the geo multiplier applies on top of the fast price.
* `claude-mythos-5` listed under "Entries that give no dollars" with no price. A1 now lists a price for it.
* "Only `gpt-6-sol` and `gpt-5.5` have exact long-context prices on O1", and the approximate prices for the other GPT-6 and GPT-5.6 entries. O1 now publishes exact long-context prices for `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna` and `gpt-5.6-sol`, so the approximate notes and the `unverified, no dollars` cells for those models are out of date.
* The per-model long-context scope is not recorded for any model. Each needs `scope`, `scope_verified` and `scope_source_id` from the model page.

Until the refresh, an auditor treats a mismatch between this prose and the flags as a G0-pricing finding, not as a rule change.

## Open items carried from the pricing rules

* The exact cached input multiplier for GPT-5.5 and earlier. O2 says only "model-dependent", while the O1 prices imply about 0.1x. Not stored as a multiplier.
* The Anthropic invalidation table on A2 does not list a model switch. The per-model cache is documented on C1, and the table relies on C1 for that.
* Bedrock TTL availability and minimums vary by model. This table covers the Claude API, Claude Platform on AWS, Google Cloud and Foundry values stated on A2.
* Community claims (an old default TTL change, an `ENABLE_PROMPT_CACHING_1H` bug) are not authoritative and are not used.

## How an auditor checks this

1. Read `src/pricing/table.json` and compare each `prices_usd_per_mtok`, `fast`, `tiers`, `min_cacheable_tokens` and `long_context` value with the cited page (`source_ids`, resolved through `sources`).
2. Run the R3.2 ratio test: for every entry with multipliers, input price times multiplier equals the stored cache price. The generator of this table asserted that against the page-listed numbers.
3. Check the R3.7 expectation list: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1`, `claude-haiku-4-5`, `claude-haiku-5-5`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6-astra`, `gpt-5.6-luna` and `gpt-5.5` all have `verified: true`. `codex-auto-review` and `gpt-5.3-codex-spark` have no row.
4. Check the R7.2 minimum list in methodology against `min_cacheable_tokens`.
5. Confirm every `verified: false` object is excluded from dollar output.
