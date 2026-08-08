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

## What s8n models

| Workflow behavior | How s8n handles it |
| --- | --- |
| Common compute and control flow | Runs locally with built-in semantics |
| HTTP Request and app integrations | Requests caller-provided mock output by default |
| Supported service operations | Can use opt-in stateful emulation |
| Existing n8n pinned data | Uses `pinData` directly |
| Explicitly mapped called workflows | Executes them recursively and reports child evidence |
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
s8n run <workflowFile> [options]  Simulate a workflow
s8n rehearse <workflow> <manifest> Run optional repeatable scenarios
s8n scenario validate <manifest>   Validate a scenario sidecar
s8n scenario draft <workflow> <execution> Create a synthetic draft
s8n validate <workflowFile>       Validate schema and connections
s8n schema [nodeType]             Inspect node parameters and mock requirements
s8n init [--out file]             Create a minimal sample workflow
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
- `--truncate-data <count>` bounds retained execution-log items.

Run `./dist/s8n --help` or `./dist/s8n run --help` for the complete CLI help.
Every command writes exactly one machine-readable JSON envelope to stdout.

Scenario manifests are optional: the workflow file remains canonical and the
existing `run` command never discovers a sidecar implicitly. See
[Scenario rehearsal](docs/scenario-rehearsal.md) for multi-case assertions,
union coverage, safe execution-log drafts, and the external-agent loop.

## Safety and limitations

- Workflow credentials are descriptive only and are never used.
- External I/O is always mocked or emulated in-process.
- Expression evaluation and Code nodes use `new Function`. Common host I/O
  globals are shadowed, but this is not a hostile-code sandbox. Only run
  trusted workflows unless the whole process is OS-isolated.
- Emulation does not reproduce authentication, authorization, rate limits,
  pagination, webhooks, arbitrary BigQuery SQL, real model semantics, or AI
  output quality.
- Execute Workflow supports only the synchronous, once-per-run subset when an
  explicit map is supplied; other modes fail explicitly.
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
