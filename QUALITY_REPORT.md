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
