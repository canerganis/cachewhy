# Demo data

`cachewhy --demo` runs every command against built-in synthetic sessions instead of your local logs. It never reads `~/.claude` or `~/.codex`, so it is safe for screenshots and bug reports.

The demo data contains no real paths, usernames, session ids or transcript content. Everything in it is generated for illustration only.

Status: the demo fixtures are not wired up yet. Until the analysis commands land, `--demo` is accepted and the commands report "not implemented yet" (exit code 3).
