# cachewhy

cachewhy is a local, offline command line tool that reads your Claude Code and Codex session logs and builds a forensic timeline of prompt cache reads, writes and suspected prefix rebuilds, with an evidence level on every finding and no message content ever stored or exported. It is not released yet. The binding technical rules live in [docs/methodology.md](docs/methodology.md).

Status: `cachewhy doctor` lists the log sources and the parse coverage (with the drift findings of R17.3). `cachewhy` (the summary) prints token accounting and list-price-equivalent dollars per provider and model, with explicit denominators, coverage counters and the `cachewhy/1` JSON form (`--json`). Suspected rebuild events, boundaries and causes (sections 7 to 11) are not computed yet. `session`, `evidence`, `pricing` and `--demo` are pending and exit with code 3.
