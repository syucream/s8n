# Quality report

Date: 2026-08-01

## Release gate

The release gate is `bun run quality`. It combines repository policy checks,
Biome, TypeScript, the Bun test suite, standalone compilation, the synthetic
rehearsal, stateful service verification, five reviewed public workflows, and
the 100-template structural corpus.

## Agent rehearsal gate

Date: 2026-08-07

`bun run quality:rehearsal` executes an original synthetic YAML parent and
child workflow through the standalone binary. It verifies strict Code include
resolution, explicit mapped sub-workflow execution, mapped inputs, a scoped
child mock, DateTime and object `keys()` expression compatibility, and host I/O
global guardrails. The semantic result is repeated with a fixed clock.

The same standalone gate also runs that workflow through an optional Scenario
Manifest, checks output and union-coverage assertions, proves a mutated
assertion exits non-zero, generates a synthetic-shape manifest draft from an
n8n-shaped execution log, rejects a mismatched workflow/log pair, and verifies
that private scalar sentinels are absent from the draft.

The gate also mutates one expected behavior and one forbidden report field and
requires both verifiers to reject the mutations. This proves the gate can turn
red for a behavior regression and for a privacy regression. No private
workflow, name, path, identifier, parameter, query, URL, or payload is part of
the fixture.

Detailed rehearsal reports are local developer artifacts, not repository
documentation. Generate them only under the ignored
`.artifacts/rehearsal/` directory:

```bash
bun run scripts/render-rehearsal-report.ts sanitized-input.json \
  .artifacts/rehearsal/report.html
```

Do not commit generated reports. The release gate tests the renderer and its
privacy rejection behavior without retaining its output.

## Verified results

- `bun run check`: passed with 194 tests and 483 assertions.
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

## Multi-service emulator gate

Date: 2026-08-03

`bun run quality:services` executes stateful create-to-read workflows for GWS,
GCP, Notion, Jira, and GitHub. It also executes an input-mapped BigQuery insert,
SQL table read-back, and a downstream Vertex AI invocation. Every scenario
passed with exact response versus
read-back equality and every emitted effect was verified. The negative path
rejected a missing Notion resource instead of fabricating data. A mutation
check flipped one evidence record to `verified: false` and proved the verifier
rejects it.

The gate also started the Vercel Labs GitHub and Google emulators and performed
real local HTTP create/read cycles for a GitHub issue and a Gmail message. Both
oracle parity checks passed. The in-process s8n implementation remains the
standalone runtime path; the broader server emulator is an independent quality
oracle for services it supports.

## Real public multi-service workflows

Date: 2026-08-03

`bun run quality:real-services` fetched five reviewed, hash-pinned official n8n
templates and executed their original graphs with seeded state and deterministic
remote responses. All five workflows succeeded and all 21 assertions passed.
The coverage includes BigQuery, Notion, GitHub, Gmail, Cloud Storage, Jira, and
Vertex AI. Every emulated service mutation was read back before being marked
verified.

The exercise found and fixed concrete published-workflow gaps: legacy Set
values, default service operations, state seeding, richer GCS/Gmail/Notion/Jira
and GitHub semantics, Vertex language-model subnodes, Time Saved pass-through,
and expression compatibility. The detailed outcomes and fidelity boundary are
retained in [real-service-simulation.md](real-service-simulation.md).
