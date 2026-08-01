# s8n

s8n is a local CLI simulator for n8n workflow JSON. It runs without an n8n
server and never performs real external I/O.

- External integrations are mocked instead of making HTTP requests or waiting
  for webhooks.
- The CLI contains no AI features. It is designed for an external AI agent to
  run a workflow, inspect missing mock requests, generate synthetic data, and
  rerun the workflow.
- Bun can compile it into a single executable with `bun build --compile`.
- Supported node fields, defaults, and branch behavior are implemented against
  upstream n8n source rather than inferred parameter shapes.

## Install and build

```bash
bun install
bun run build
./dist/s8n --help
```

During development, run the TypeScript entry point directly:

```bash
bun run src/cli/index.ts --help
```

## Commands

Every command writes exactly one JSON object to stdout:
`{ ok, command, data?, issues?, error? }`. An AI agent can determine the result
by parsing that envelope.

### `s8n run <workflowFile>`

Simulate a workflow:

```bash
s8n run workflow.json [--input input.json] [--mocks mocks.json] [--now 2026-01-01T00:00:00Z] [--start-node "Node Name"]
```

- `--input`: Initial items passed to the trigger node. Accepts one JSON object
  or an array of objects. Defaults to one empty item.
- `--mocks`: External I/O mock data as a flat
  `{ "<mockKey>": <value> }` JSON object.
- `--now`: Fixes the Luxon `$now` and `$today` values for reproducible
  expression evaluation.
- `--start-node`: Selects the entry point when multiple nodes have no incoming
  connections. Like n8n, s8n activates only one trigger per execution.

`data.status` is one of:

| Status | Meaning |
| --- | --- |
| `success` | The workflow completed. |
| `needs_mock` | Execution paused at an I/O node without mock data. `data.pendingMocks` contains `mockKey`, `reason`, and `expectedShape`. |
| `needs_start_node` | Multiple start nodes exist and `--start-node` is required. Candidates are in `data.startNodeCandidates`. |
| `error` | A node without a continuing error mode failed. |

A typical agent loop is:

1. Run `s8n run workflow.json`.
2. If the status is `needs_start_node`, choose a candidate and rerun with
   `--start-node`.
3. If the status is `needs_mock`, use `expectedShape` to generate synthetic
   data and save it under the requested key in `mocks.json`.
4. Rerun with `--mocks mocks.json`, repeating when more mocks are requested.
5. On `success`, inspect each node's final output in `data.nodeOutputs`.

### `s8n validate <workflowFile>`

Validate workflow schema and connection integrity without executing it.

### `s8n schema [nodeType]`

Describe a node type's expected `parameters` shape and mock requirements. With
no argument, list every built-in type. Agents should consult this command
before creating or repairing workflow JSON.

### `s8n init [--out file]`

Write a minimal sample workflow JSON.

## Workflow JSON support

s8n accepts the `nodes`, `connections`, and `parameters` structure used by n8n
workflow exports. It also preserves n8n node type identifiers such as
`n8n-nodes-base.httpRequest`, but it is not a complete n8n implementation.

- Locally modeled nodes include Manual Trigger, Schedule Trigger, Execute
  Workflow Trigger, Webhook, Set, If, Filter, Switch, Merge, Code, NoOp, Wait,
  Aggregate, Limit, Sort, Split Out, Loop Over Items, Date & Time, Remove
  Duplicates, Summarize, Stop and Error, and Respond to Webhook.
- HTTP Request returns mock responses and performs no network communication.
- Every unmodeled node type, including integration nodes such as Slack, Gmail,
  Notion, BigQuery, and LangChain nodes, falls back to external-I/O mocking
  instead of failing.
- Expressions support `$json`, `$input`, `$('NodeName')`, `$now`, `$today`,
  `$node`, `$workflow`, and `$itemIndex`. `$now` and `$today` are Luxon
  `DateTime` objects, so methods such as `.minus()` and `.toFormat()` work.
- Code nodes support `$getWorkflowStaticData(type)` within one execution. State
  is not persisted across executions.

## Mock data

- A `mockKey` is normally the node name. I/O nodes processing multiple items
  can use `"<nodeName>#<itemIndex>"`; missing item-specific keys fall back to
  the plain node name.
- Webhooks and unmodeled triggers used as start nodes prefer `--input` and do
  not request a mock when input is provided.

## Development

```bash
bun run check          # English policy + lint + typecheck + tests
bun run check:english  # reject Japanese in tracked repository text
bun run lint           # biome check .
bun run lint:fix       # biome check --write .
bun run typecheck      # tsc --noEmit
bun run test           # bun test
bun run build          # compile dist/s8n
```

Files under `fixtures/` are original test workflows. Files under `examples/`
are original documentation examples. They contain no copied private workflow
data or source from another repository.

All repository-facing prose, including documentation, comments, CLI output,
schemas, fixtures, and test names, must be written in English. `bun run check`
enforces this rule for tracked text files.

## Deliberate simplifications

- A node runs after every required input slot has received a delivery. Multiple
  sources connected to the same slot are alternatives, not cumulative
  requirements.
- Nodes receiving zero total items are skipped unless `alwaysOutputData` is
  enabled, matching n8n's `executionOrder: "v1"` behavior.
- Only one trigger runs per execution. Use `--start-node` when several entry
  points exist.
- Loop Over Items executes its body once per batch and follows a detected
  back-edge. Nested loops and complete `pairedItem` tracking across iterations
  remain unsupported.
- Execute Workflow does not resolve or run a real sub-workflow; it uses the
  generic mock fallback.
- Expression evaluation and Code nodes use `new Function` and are not
  sandboxed. Run only trusted workflow JSON in this local single-user CLI.
