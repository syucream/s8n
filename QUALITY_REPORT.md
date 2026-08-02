# v0.2.0 Quality Report

Date: 2026-08-01

## Release gate

The release gate is `bun run quality`. It combines repository policy checks,
Biome, TypeScript, the Bun test suite, standalone compilation, stateful Slack
verification, and execution of a currently published community workflow.

## Verified results

- `bun run check`: passed with 102 tests and 229 assertions.
- `bun run build`: produced a standalone executable and `./dist/s8n --help`
  started without repository runtime files.
- The compiled executable ran the Slack release example with `--emulate slack`.
  Its posted text was read back from conversation history and reported with
  `verified: true`.
- `bun run quality:emulator`: verified a parent message, a thread reply through
  `conversations.replies`, a message update, and a user lookup through an
  independent user-state read. Every effect was verified.
- The same message contract was checked against the Vercel Labs `emulate` Slack
  service started programmatically in the quality process. Oracle parity passed.
- `bun run quality:community` fetched two official n8n templates. Template 371,
  "Notify a team channel about new software releases via Slack and GitHub,"
  proved legacy schema, expression, and Slack behavior. Template 14034,
  "Transform and validate webhook records with configurable type conversion,"
  proved Webhook, raw JSON Set, Code, and Respond behavior by checking exact
  string, number, boolean, and date transformations.

The gates emit structured JSON containing the exact requests, responses,
observations, and boolean assertions. Screenshots are not applicable because
s8n v0.2.0 is a CLI-only product with no rendered UI; the retained JSON evidence
is the user-observable artifact.

## 100-template community corpus follow-up

Date: 2026-08-02

`bun run quality:corpus` snapshots the IDs of the 100 highest-trending public
templates, fetches their current definitions from the official n8n API, and
requires all 100 definitions to validate plus at least 95 simulations to
complete. Downloaded JavaScript and expressions are never evaluated: Code
nodes are mocked, expression parameters are neutralized, and external services
receive representative response mocks. This makes the corpus safe to run while
keeping builtin graph, trigger, control-flow, transformation, and merge logic
observable.

The verified run fetched and validated 100/100 workflows containing 2,505
nodes. All 100 simulations completed. Across 951 reached node visits, 438 used
builtin simulation logic and 513 used safe external-I/O or untrusted-Code
mocks. The corpus directly drove support for current API payloads, legacy
connection-name encoding, Merge `chooseBranch`, and Merge `combineAll`.

This is a structural and deterministic simulation gate, not a claim that s8n
faithfully reproduces remote APIs, LLM behavior, or downloaded Code-node logic.
It replaces the downloaded-Code `quality:community` check in the current
`bun run quality` release gate; that legacy command remains trusted-input only.
