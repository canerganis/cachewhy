# Changelog

## 0.1.0 (2026-10-11)

First public release.

* `cachewhy rebuilds`: finds suspected prompt cache rebuilds in Claude Code and Codex logs, per thread, subagents and workflow agents included. Each event has a cause (logged cache miss reason, model switch, idle past the cache TTL, compaction or `/clear`, settings or version change, unknown), an evidence level (confirmed, hypothesis with confidence, unknown) and an API list-price cost. Text and `--json` output.
* `cachewhy` (summary): token and list-price-equivalent accounting per provider and model, with coverage counters and the `cachewhy/1` JSON schema.
* `cachewhy doctor`: log sources, parse coverage and schema drift checks.
* Request-id deduplication, replay and fork handling, subagent linking, strict taint rules for chains that cannot be verified.
* Pinned pricing table for Anthropic and OpenAI models.
* Zero runtime dependencies, optional network guard (`CACHEWHY_NETGUARD=1`).
