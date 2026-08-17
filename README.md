# s8n

[![Lint](https://github.com/syucream/s8n/actions/workflows/lint.yml/badge.svg)](https://github.com/syucream/s8n/actions/workflows/lint.yml)
[![Build](https://github.com/syucream/s8n/actions/workflows/build.yml/badge.svg)](https://github.com/syucream/s8n/actions/workflows/build.yml)
[![Test](https://github.com/syucream/s8n/actions/workflows/test.yml/badge.svg)](https://github.com/syucream/s8n/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Run and inspect n8n workflow JSON or YAML locally, without starting n8n or contacting
external services.

s8n is useful when you want to understand a workflow, test its branching and
data transformations, or give an AI coding agent a safe execution loop. It
implements common compute and control-flow nodes locally. External nodes pause
for synthetic responses by default, while selected services can use opt-in,
stateful in-memory emulators.

> [!IMPORTANT]
> s8n is a simulator, not n8n. It never uses workflow credentials or performs
> real external I/O. A successful simulation does not prove authentication,
> permissions, rate limits, webhooks, or production behavior.

## Quick start

You need [Bun 1.3.4](https://bun.sh/) and Git.

```bash
git clone https://github.com/syucream/s8n.git
cd s8n
bun install --frozen-lockfile
bun run build
./dist/s8n run examples/hello-world.workflow.json
```

The command prints one JSON object. Look for `data.status` and the output of
each node under `data.nodeOutputs`:

```json
{
  "ok": true,
  "command": "run",
  "data": {
    "status": "success",
    "nodeOutputs": {
      "Set": [{ "json": { "message": "Hello, world!" } }]
    }
  }
}
```

The same result includes execution trace evidence: main-edge delivery counts,
branch coverage, and per-item lineage for local cardinality debugging. These
are simulator observations; they do not identify real external records.

During development, you can skip the build and run the TypeScript entry point:

```bash
bun run src/cli/index.ts run examples/hello-world.workflow.json
```

## Try a stateful integration

This example posts a release notification into an in-memory Slack workspace,
then reads the message back to verify the simulated side effect:

```bash
./dist/s8n run examples/slack-release-notification.workflow.json \
  --input examples/slack-release-notification.input.json \
  --emulate slack
```

No Slack account, token, network request, or local server is involved. The
result includes the resolved request, emulator response, independent
`observation`, and `verified: true` under `data.effects`.

## Run your own workflow

Export a workflow as JSON or YAML from n8n, then run:

```bash
./dist/s8n validate path/to/workflow.json
./dist/s8n run path/to/workflow.json
```

Repositories that split trusted Code nodes into YAML `!include` assets can
enable the strict `_subfiles` resolver explicitly:

```bash
./dist/s8n run path/to/workflow.yaml --resolve-code-includes
```

To execute called workflows locally, provide an explicit JSON or YAML map.
s8n never scans a directory or guesses a workflow reference:

```yaml
workflows:
  - reference: child-workflow
    path: ./child.workflow.yaml
```

```bash
./dist/s8n run parent.workflow.yaml --workflow-map workflow-map.yaml
```

If an external node needs data, the run returns `needs_mock` and tells you the
required key and expected shape. Put a synthetic response in `mocks.json`:

```json
{
  "Fetch customer": {
    "id": "customer-123",
    "plan": "trial"
  }
}
```

Then rerun:

```bash
./dist/s8n run path/to/workflow.json --mocks mocks.json
```

Repeat until the workflow succeeds. This request-and-rerun contract is designed
to be easy for both people and external AI agents to follow.

For HTTP Request nodes with pagination configured, the mock drives the page
loop: `{ "pages": [page1, page2, ...] }` supplies one response per page and
`completeExpression` / per-request cursor updates are evaluated against
`$response`. Any other mock shape is treated as a single complete page with a
`pagination-single-page-mock` fidelity note.

To model "this node could return any of these shapes" (e.g. an LLM's varying
output), declare `$variants` and combine it with `--repeat`:

```json
{
  "$variants": {
    "Agent": [
      { "output": { "proposals": [{ "proposalId": "p1" }] } },
      { "output": { "proposals": [{ "proposalId": "p1" }, { "proposalId": "p2" }] } }
    ]
  }
}
```

```bash
./dist/s8n run workflow.json --mocks variants.json --repeat 4
```

The result reports whether the workflow is deterministic across those variants
and how its output item counts spread.

For HTTP Request nodes, supplied mocks model the configured node output. When
`options.response.response.fullResponse` is enabled, use an object containing
`body`, `headers`, `statusCode`, and `statusMessage`; s8n reports a warning when
the mock shape contradicts that setting. Successful HTTP trace entries include
the expression-resolved method, URL, headers, and body only when
`--trace-requests` is explicitly enabled, so write requests can be checked
without performing network I/O. Scenario `nodeRequests` assertions enable the
same evidence internally without copying it into rehearsal trace summaries.
Credential-like values and unsafe header or raw-body content are redacted.

## What s8n models

| Workflow behavior | How s8n handles it |
| --- | --- |
| Common compute and control flow | Runs locally with built-in semantics |
| HTTP Request pagination | Simulates page loops from `{ pages: [...] }` mocks, evaluating `$response` expressions; single-page mocks are annotated with a fidelity note |
| HTTP Request and app integrations | Requests caller-provided mock output by default |
| Supported service operations | Can use opt-in stateful emulation |
| Existing n8n pinned data | Uses `pinData` directly |
| Explicitly mapped called workflows | Executes them recursively and reports child evidence (including child entry payloads) |
| Waiting / approval nodes | Scenario `resume` directives resolve Wait nodes; without one the run reports `waiting` |
| Unknown executable node types | Uses the generic mock fallback |

Built-in behavior includes triggers, Set, If, Filter, Switch, Merge, Code,
Wait, Aggregate, Limit, Sort, Split Out, Loop Over Items, Date & Time, Remove
Duplicates, Summarize, Stop and Error, and Respond to Webhook. Expressions
cover common n8n values such as `$json`, `$input`, `$('NodeName')`, `$now`,
`$today`, `$node`, `$workflow`, and `$itemIndex`.

Stateful emulation is available for selected AI, Slack, Google Workspace,
Google Cloud, Notion, Jira, and GitHub operations. See:

- [Node support tiers](docs/node-support.md) for the exact built-in node list,
  injection mechanisms, and fallback behavior.
- [Service emulation](docs/service-emulation.md) for supported operations,
  seed formats, evidence contracts, and fidelity limits.

## Command overview

```text
s8n run <workflowFile> [options]             Simulate a workflow
s8n test <testFile...>                       Run TypeScript workflow tests
s8n rehearse <workflow> <manifest>           Run optional repeatable scenarios
s8n scenario validate <manifest>             Validate a scenario sidecar
s8n scenario draft <workflow> <execution>    Create a synthetic draft
s8n eval <execution> <expectations>          Score an LLM output fixture (precision/recall)
s8n validate <workflowFile>                  Validate schema and connections
s8n schema [nodeType]                        Inspect node parameters and mock requirements
s8n init [--out file]                        Create a minimal sample workflow
```

Useful `run` options:

- `--input <file>` supplies initial trigger items.
- `--mocks <file>` supplies synthetic external-node responses.
- `--workflow-map <file>` explicitly maps called workflow references.
- `--resolve-code-includes` resolves strict, workflow-local `_subfiles` Code assets.
- `--emulate <services|all>` enables selected in-memory service emulators.
- `--emulator-seed <file>` supplies initial emulator state.
- `--now <ISO timestamp>` makes time-dependent expressions reproducible.
- `--start-node <name>` chooses one of multiple possible entry points.
- `--execution-log` adds an n8n-shaped `resultData.runData` record.
- `--trace-requests` explicitly includes sanitized resolved HTTP request evidence.
- `--truncate-data <count>` bounds retained execution-log items.
- `--code-mode vm` runs Code nodes in a fresh Node VM context with a bounded
  timeout; `--code-mode os` uses `sandbox-exec` on macOS or `bwrap` on Linux
  when installed; `--code-mode auto` prefers that OS sandbox and falls back to
  `vm`. `--code-timeout-ms` changes the limit.
- `--determinism-check` runs the same input twice and reports whether the
  stable execution evidence matches (wall-clock timing is excluded).
- `--repeat <count>` runs the same scenario N times - cycling mock `$variants`
  if present - and reports output variance (per-node item-count spread plus a
  hash of each run's output) so you can ask "is this workflow deterministic?"
  in numbers.

Run `./dist/s8n --help` or `./dist/s8n run --help` for the complete CLI help.
Every command writes exactly one machine-readable JSON envelope to stdout.

Scenario manifests are optional: the workflow file remains canonical and the
existing `run` command never discovers a sidecar implicitly. See
[Scenario rehearsal](docs/scenario-rehearsal.md) for multi-case assertions,
union coverage, safe execution-log drafts, and the external-agent loop.

## Write workflow tests

Workflows can be tested from TypeScript with `s8n test`. Each test simulates
the workflow with its own input, mocks, faults, and resume data, then asserts
on the full engine result - including cross-node invariants such as "nothing
is written to Slack unless a human approval happened first":

```bash
bun run src/cli/index.ts test examples/approval.test.ts
```

```ts
import { defineSuite } from "s8n";

export default defineSuite(
  { workflow: "./approval.workflow.json" },
  (test) => {
    test("an approved request is posted to slack", async (run, expect) => {
      const r = await run({
        input: { requestId: "req-7", amount: 120 },
        mocks: { "Post to Slack": { ok: true } },
        resume: { "Wait for approval": { approved: true } },
      });
      expect(r).status("success");
      expect(r).ran("Wait for approval").before("Post to Slack");
      expect(r).itemReaching("Post to Slack").passedThrough("Wait for approval");
      expect(r).allPathsTo("Post to Slack").passThrough("Wait for approval");
    });
  },
);
```

`run` returns the full engine `RunResult`, so any assertion is expressible -
the matchers are ergonomic wrappers, not a ceiling. Tests can import
`defineSuite` from the `s8n` package or rely on globals injected by the
command. The injected-globals form also works from the standalone binary;
import-based test files need the `s8n` package resolvable (a checkout or a Bun
git dependency). See [Workflow tests](docs/workflow-tests.md) for the full
API, matcher semantics, and fidelity boundaries.

## Safety and limitations

- Workflow credentials are descriptive only and are never used.
- External I/O is always mocked or emulated in-process.
- Expression evaluation and in-process Code nodes use `new Function`. Common
  host I/O globals are shadowed, but this is not a hostile-code sandbox. The
  optional `vm` Code mode adds a fresh context and execution timeout. The
  `os`/`auto` modes run Code in a child process and, when available, apply the
  platform sandbox. The sandbox command and policy are environment-dependent;
  they block network access and host writes, and sanitize inherited environment
  variables, but may retain read-only access needed by the runtime. Treat this
  as a stronger guardrail, not a universal confidentiality boundary.
- Emulation does not reproduce authentication, authorization, rate limits,
  real pagination, webhooks, arbitrary BigQuery SQL, real model semantics, or
  AI output quality. Mock-driven HTTP pagination is a simulation: completion
  and cursor updates only reflect the pages the mock supplies.
- Execute Workflow supports only the synchronous, once-per-run subset when an
  explicit map is supplied; other modes fail explicitly. Unresolved waiting
  nodes report a `waiting` status and halt their branch.
- Code-node static data lasts for one execution only.
- Nested Loop Over Items flows and complete cross-iteration `pairedItem`
  tracking are not supported.

The project validates public workflow samples only after pinning or neutralizing
untrusted executable content. See [Contributing](CONTRIBUTING.md) before adding
downloaded workflow fixtures to a quality gate.

## For contributors

```bash
bun run check    # public-content policy, language policy, formatting, types, tests
bun run build    # standalone executable
bun run quality  # complete release gate
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) for development and release guidance.
AI coding agents should start with [AGENTS.md](AGENTS.md). Stable quality
documentation is under [docs/reports](docs/reports/). Generated rehearsal
reports are local developer artifacts under `.artifacts/` and are not tracked.

## License

[MIT](LICENSE)
