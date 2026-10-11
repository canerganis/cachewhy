# cachewhy

Find out why your coding agent's prompt cache broke, and what it cost.

cachewhy reads the Claude Code and Codex session logs already on your machine, walks every conversation thread (subagents included), and flags requests that had to process the prompt prefix again instead of reading it from cache. Each event gets a likely cause and an evidence level. Everything runs offline; no message content is read into the report.

```bash
npx cachewhy rebuilds --since 7d
```

```
cachewhy rebuilds (2026-10-04 to 2026-10-11)
Checked 45,362 requests. 497 suspected prefix rebuilds, 129M tokens processed again, ~$645.45 API list-price equivalent.
Evidence: 70 confirmed, 390 hypotheses, 37 unknown.

By cause
Cause                           Events  Tokens rebuilt  List-price equiv.
------------------------------  ------  --------------  -----------------
idle past cache TTL                412            118M            $570.93
earlier messages edited             11            3.9M             $44.71
unknown                             37            5.1M             $22.13
tools or system prompt changed       8            895k              $5.25
compaction or /clear                22            713k              $1.30
model switch                         4            252k              $0.86
request settings changed             3           90.6k              $0.27

Most expensive 3 of 497
Time (UTC)        Agent            Session   Model             Rebuilt    Cost  Evidence           Why
----------------  ---------------  --------  ----------------  -------  ------  -----------------  --------------------------------------------
2026-10-05 04:23  claude/subagent  3f1c9a2e  claude-fable-5-1     894k  $10.95  confirmed          idle past cache TTL: Claude reported: ...
2026-10-04 23:05  claude/subagent  3f1c9a2e  claude-fable-5-1     848k  $10.39  hypothesis (high)  idle past cache TTL: idle 25m, cache TTL 5m
2026-10-04 22:00  claude/subagent  3f1c9a2e  claude-fable-5-1     733k   $8.98  hypothesis (high)  idle past cache TTL: idle 11m, cache TTL 5m
```

That is a real week of the author's own logs. Most of the waste was subagents sitting idle longer than the 5 minute cache TTL, which Claude Code's own `/usage` does not show because it only covers the main conversation.

## Why

With a coding agent, almost every request resends the whole conversation. When the prefix matches the previous request, the provider reads it from cache at about a tenth of the input price. When something changes the prefix, or the cache expires, the whole prefix is processed and written again at full price or more. One miss on a long session can cost more than a hundred cache hits.

Existing usage tools count tokens and dollars. cachewhy explains the misses.

## What it does

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
