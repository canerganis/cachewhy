# Contributing

cachewhy is a local, offline CLI with zero runtime dependencies. Keep it that way: no network calls, no runtime packages.

## Setup and checks

Node 22 or 24.

```
npm ci
npm run typecheck
npm run build
npm test
npm run lint:privacy
```

Tests use `node:test` and live in `test/`.

CI runs the same steps on Linux, macOS and Windows, and runs the suite again on Linux with the network removed (`unshare -rn`). To check locally on Linux: `unshare -rn npm test`.

## Privacy rule

Never commit real data. That means no real local paths, usernames, session ids, prompts or transcript content, in code, tests, fixtures, issues or PRs. `npm run lint:privacy` catches common leaks, but it is a backstop, not a review.

## Adding a synthetic fixture

1. Write the log by hand or with a generator in `test/`. Do not copy a real session and edit it.
2. Use invented ids, fake paths such as `/home/user/project`, and placeholder text.
3. Make the smallest log that shows the case: a few turns, with the token usage and cache fields that matter.
4. Name it for the behavior, for example `claude-ttl-expiry.jsonl`, and keep it next to the tests that use it.
5. Add a test that asserts the expected result and would fail if the behavior regressed.
6. Run `npm run lint:privacy`.

## Adding a new agent source

1. Open a "New agent source" issue first with a synthetic sample of the record shape.
2. Add a reader that turns the agent's log files into the common record type. It must only read local files and tolerate truncated or unknown lines.
3. Register the agent's default log location and file patterns.
4. Add synthetic fixtures covering normal turns, missing usage fields and a malformed line.
5. Add tests for discovery and parsing. Compressed formats must be decoded without adding a runtime dependency.
6. Document the source and its limits in the README and `docs/methodology.md`.

Accounting, dedup, classification and pricing rules are defined in `docs/methodology.md`. Change the spec first when a rule changes.

## Pricing updates

Prices must come from the provider's official pricing page. Cite the URL in the PR.

## Releases

Maintainers tag `vX.Y.Z` matching `package.json`. The release workflow builds, tests and publishes to npm with provenance through trusted publishing. It does not run on pull requests.
