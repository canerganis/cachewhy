# cachewhy

Find out why your coding agent's prompt cache broke, and what it cost.

cachewhy reads the Claude Code and Codex session logs already on your machine, walks every conversation thread (subagents included), and flags requests that had to process the prompt prefix again instead of reading it from cache. Each event gets a likely cause and an evidence level. Everything runs offline; no message content is read into the report.

```bash
npx cachewhy rebuilds --since 7d
```

![cachewhy rebuilds run on a real week of logs](assets/demo.svg)

That is a real week of the author's own logs. Most of the waste was subagents sitting idle longer than the 5 minute cache TTL, which Claude Code's own `/usage` does not show because it only covers the main conversation.

## Why

With a coding agent, almost every request resends the whole conversation. When the prefix matches the previous request, the provider reads it from cache at about a tenth of the input price. When something changes the prefix, or the cache expires, the whole prefix is processed and written again at full price or more. One miss on a long session can cost more than a hundred cache hits.

Existing usage tools count tokens and dollars. cachewhy explains the misses.

## What it does

![How cachewhy finds a rebuild](assets/how-it-works.svg)


* Reads `~/.claude/projects` and `~/.codex` (sessions and archived sessions). Override with `--claude-dir` and `--codex-dir`.
* Deduplicates responses by request id, so replayed and copied log lines count once.
* Builds one ordered chain per conversation thread: Claude main threads, subagents and workflow agents, Codex threads and forks.
* Flags a rebuild when a request reads back less than half of the prefix the previous request in the same thread had cached.
* Assigns one cause per event, with an evidence level:

| Evidence | Meaning |
| --- | --- |
| confirmed | Claude Code logged a cache miss reason for that request |
| hypothesis | A signal in the logs fits: model switch, idle gap past the cache TTL, a context that shrank (compaction), an effort change, a version change. Comes with a confidence |
| unknown | Nothing in the logs explains it |

* Prices the extra cost from a pinned table of public API list prices. This is an estimate of what the rebuild would cost at API rates, not your bill or subscription usage.

## Commands

```bash
npx cachewhy rebuilds              # suspected cache rebuilds, causes, cost
npx cachewhy rebuilds --top 50     # list more events
npx cachewhy rebuilds --json       # machine readable
npx cachewhy                       # token and cost accounting per provider and model
npx cachewhy doctor                # log sources and parse coverage
```

Common options: `--since 7d`, `--until 2026-10-01`, `--agent claude|codex|all`, `--project <dir>`, `--no-color`. Set `CACHEWHY_NETGUARD=1` to block all network access during a run.

Requires Node 22 or newer.

## Limits

* Causes other than `confirmed` are inferred from timing and counters, not from the requests themselves. Treat them as leads.
* Codex logs carry no cache miss reason, so Codex events are never `confirmed`.
* The summary command is strict: chains it cannot verify end to end keep their tokens but get no dollars. `rebuilds` prices any event whose model has a table row.

## Development

```bash
npm ci
npm test
npm run build
node dist/cli.js rebuilds --since 7d
```

The accounting rules are in [docs/methodology.md](docs/methodology.md) and [docs/accounting-semantics.md](docs/accounting-semantics.md). Test fixtures are synthetic; never commit real logs.

## License

MIT
