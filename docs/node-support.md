# Node support tiers

s8n uses four explicit support tiers. The tiers describe what s8n proves about
a node; they do not claim full n8n compatibility.

| Tier | What s8n does | How to use it | What a successful run proves |
| --- | --- | --- | --- |
| Local simulation | Executes dedicated local logic for the node | No option is required | The modeled parameters, item transformation, and branch behavior produced the observed output |
| Stateful emulation | Executes selected service operations against an in-process store | Pass `--emulate <family>` and optionally `--emulator-seed` | The modeled request changed or read local state; mutations include read-back evidence |
| Injected data | Replaces a trigger payload or node output with caller-owned JSON | Use `--input`, `--mocks`, or workflow `pinData` | The rest of the graph works for that supplied output shape; the replaced node's real behavior was not tested |
| Generic fallback | Treats an unmodeled executable node as external I/O | Supply the requested mock and rerun | Parameters and expressions resolved, and downstream logic works; the node's own behavior remains unmodeled |

The execution order is significant:

1. A disabled node passes through its input.
2. Workflow `pinData` replaces that node's execution.
3. A dedicated executor runs when one exists.
4. An unmodeled node uses an enabled emulator when its family and operation are
   supported.
5. Otherwise, the node requests a mock instead of failing solely because its
   type is unknown.

## Tier 1: local simulation

These node types have dedicated executors:

| Area | Node types |
| --- | --- |
| Entry points | Manual Trigger, Schedule Trigger, Execute Workflow Trigger |
| Transformations | Set, Code, Aggregate, Limit, Sort, Split Out, Date & Time, Remove Duplicates, Summarize, Time Saved |
| Control flow | If, Filter, Switch, Merge, Loop Over Items (`splitInBatches`), NoOp, Wait, Stop and Error |
| Local composition | Execute Workflow with an explicit `--workflow-map` |
| Response flow | Respond to Webhook |
| Mock-aware primitives | Webhook, HTTP Request |

Webhook and HTTP Request have dedicated executors for richer input and mock-key
behavior, but they never perform network I/O. Their external response is still
injected.

Run `s8n schema` for the machine-readable current list and parameter summaries.
The source of truth for registration is `src/nodes/registry.ts`.

## Tier 2: stateful emulation

Stateful emulation is opt-in and stays inside the s8n process:

```bash
s8n run workflow.json --emulate ai,slack,gws,gcp,notion,jira,github
s8n run workflow.json --emulate all --emulator-seed seed.json
```

| Family | Recognized node families | Modeled state |
| --- | --- | --- |
| `ai` | LangChain Agent/Chain roots with connected chat models and parsers | resolved prompt/model request, caller-supplied model response, n8n-style root output, structured-output parsing and schema validation |
| `slack` | Slack | messages, thread replies, updates, users |
| `gws` | Google Sheets, Drive, Gmail, Calendar, Docs | rows, files, messages, events, documents |
| `gcp` | BigQuery, Google Cloud Storage, Vertex/Gemini | rows and queries, buckets and objects, deterministic model invocation records |
| `notion` | Notion | pages, databases, and blocks |
| `jira` | Jira | issues and comments |
| `github` | GitHub | issues, comments, and selected resource records |

Coverage is operation-specific. Merely recognizing a service family does not
mean every resource, operation, or API edge case is emulated. Unsupported
operations continue to Tier 3/4 mock handling. The detailed operation and
fidelity boundaries are in [service-emulation.md](service-emulation.md).

AI emulation deliberately mocks the model boundary rather than inventing a
plausible completion. Put the raw model response under the Agent/Chain node
name in `--mocks`, then run with `--emulate ai`. s8n resolves the prompt and
system message, records privacy-safe size metadata plus tool/memory counts, and
applies a connected Structured Output Parser. Invalid JSON, missing required
fields, and type mismatches fail the node. Prompt, system-message, model, and
fixture contents are not copied into the effect log.

The Vercel Labs `emulate` package is an independent quality-gate oracle for
selected Slack, GitHub, and Google Workspace behavior. It is not a runtime
server or a dependency of the compiled CLI. s8n's normal emulator remains its
own in-process implementation.

## Tier 3: caller-owned data injection

There are three mechanisms, each with a different scope.

### Start-node input

`--input` supplies items to the active trigger. It is also used directly by an
unmodeled trigger when that trigger is the selected start node.

```bash
s8n run workflow.json --input input.json
```

The file may contain one JSON object or an array of objects.

### External output mocks

`--mocks` supplies output for HTTP Request and any unmodeled executable node:

```json
{
  "Fetch customer": { "id": "customer-1", "plan": "pro" },
  "Fetch orders#0": [{ "id": "order-1", "total": 1200 }]
}
```

The normal key is the node name. `"<nodeName>#<itemIndex>"` can provide
per-item output, with the plain node name as fallback. If data is missing, s8n
returns `needs_mock` with the exact `mockKey` and an `expectedShape` hint.

HTTP Request mocks represent the node's configured output. A node with
`options.response.response.fullResponse: true` expects `body`, `headers`,
`statusCode`, and `statusMessage`; contradictory supplied shapes produce a
non-fatal warning. With explicit `--trace-requests`, each successfully executed
HTTP Request also records a sanitized `resolvedRequests` array in its trace entry. This local evidence
contains the resolved method, URL, headers, and body, but it is not a claim of
wire-level fidelity and no request is sent. Common credential-like keys and URL
userinfo are redacted. Request evidence is omitted by default.

### Workflow pin data

n8n exports may contain `pinData`. s8n honors it for any node type and bypasses
that node's executor, emulator, and mock lookup:

```json
{
  "name": "Pinned example",
  "nodes": [],
  "connections": {},
  "pinData": {
    "Fetch customer": [
      { "id": "customer-1", "plan": "pro" }
    ]
  }
}
```

The example omits the real `nodes` only for brevity; a valid workflow still
needs the named node. Pin data is useful when an export already contains a
reviewed fixture. Prefer `--mocks` when test data should remain separate from
the workflow definition.

## Tier 4: generic fallback and uncared behavior

There is no hard-coded denylist of executable node types. An unknown type is
expression-resolved and then treated as mockable external I/O. For several
common app and AI nodes, `s8n schema <nodeType>` returns a tailored output-shape
hint. For every other type it returns a generic hint.

This fallback is deliberately not behavioral support. In particular, it does
not validate the remote API, credentials, side effects, retries, pagination,
binary data, or exact output schema. A workflow can therefore finish with
mocks even when one of those real-world contracts would fail.

Special cases and known gaps:

- Sticky Note is a canvas annotation and is ignored as non-executable.
- Execute Workflow remains a generic mock boundary unless `--workflow-map`
  explicitly maps its reference. Mapped calls support synchronous
  `source=database`, `mode=once` execution, mapped inputs, scoped child mocks,
  child effects, nested evidence, cycle detection, and a depth limit. Other
  modes fail explicitly. Child entry payloads are retained for
  `subExecutionInputs` assertions.
- HTTP Request pagination (`options.pagination.pagination`) is simulated from
  the mock: `{ pages: [...] }` supplies one response per page, page-dependent
  expressions (`completeExpression`, per-request updates) are evaluated against
  `$response`, and each page's request is traced. Any other mock shape is
  treated as a single complete page with a `pagination-single-page-mock`
  fidelity note. Completion modes `responseIsEmpty`,
  `receiveSpecificStatusCodes`, and `other` (`completeExpression`) are
  supported; `limitPagesFetched`/`maxRequests` bound the page loop.
- `executeOnce` is modeled: the node runs once with only the first item it
  received, while trace `inputItemCounts` still report the full fan-in.
- Wait nodes with `resume: onWebhookCall` / `onFormSubmission` consume a
  scenario `resume` directive (payload or `"timeout"`); without one they report
  a `waiting` status and halt their branch. Time-based waits pass through.
- Nodes whose output came from a caller-supplied mock carry a `mocked-output`
  fidelity note so "this may differ from the real service" is machine-readable.
- JSON and YAML workflow files are accepted. `--resolve-code-includes`
  opt-in resolves only `./_subfiles/<directory>/<file>.js` Code assets, checks
  their real path remains under `_subfiles`, and rejects missing or invalid
  targets before execution.
- Code and expression evaluation shadow common host I/O globals to prevent
  accidental access. This is not a hostile-code security sandbox; only run
  trusted workflows unless the whole process is OS-isolated.
- Nested Loop Over Items and complete `pairedItem` tracking are not modeled.
- Emulator operations outside the documented matrix fall back to mocks.

When assessing support, report both the node type and the tier actually used.
For example, "Slack message/post passed with the `slack` emulator" is stronger
and more precise than "Slack is supported."
