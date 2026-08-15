# Scenario rehearsal

Scenario manifests are optional sidecars for repeatable workflow tests. The
workflow JSON or YAML remains the canonical source: `s8n run workflow.json`
never searches for or requires a manifest.

Use a manifest when one input cannot exercise all important branches, when a
mock contract should be retained, or when an agent needs deterministic
assertions instead of judging a run itself.

## Quick start

```bash
s8n scenario validate examples/rehearsal.scenarios.yaml
s8n rehearse examples/rehearsal.workflow.json examples/rehearsal.scenarios.yaml
```

The second command runs every case with fresh emulator state, applies explicit
assertions plus an implicit `status: success` assertion, and returns per-case
and union executed-node coverage in one JSON envelope. Use `--case <names...>`
to select cases or `--fail-fast` to stop after the first failure.

## Manifest format

```yaml
version: 1
defaults:
  now: "2026-01-01T00:00:00.000Z"
  workflowMap: ./workflow-map.yaml
cases:
  - name: normal
    input:
      amount: 150
    mocks:
      Fetch Record:
        active: true
    faults:
      - node: Fetch Record
        kind: http-error
        statusCode: 503
    assertions:
      status: success
      minimumCoverage: 0.8
      minimumBranchCoverage: 0.75
      requiredNodes: [Store Result]
      forbiddenNodes: [No Results]
      requiredEdges:
        - sourceNode: Check Result
          sourceOutput: 0
          destinationNode: Store Result
          destinationInput: 0
      pendingMockCount: 0
      verifiedEffects: true
      subExecutionCount: 1
      nodeOutputItemCounts:
        Store Result: 1
      nodeOutputCardinality:
        - node: Store Result
          min: 1
          max: 2
      nodeOutputs:
        - node: Store Result
          item: 0
          pointer: /json/saved
          exists: true
          equals: true
      nodeRequests:
        - node: Send Result
          pointer: /body/status
          exists: true
          equals: ready
      nodeOutputLineage:
        - node: Store Result
          item: 0
          lineageContains: [input:0]
```

The workflow path is deliberately not part of the manifest. Paths inside the
manifest resolve relative to that manifest. Supported case/default run fields
are:

- `input` or `inputFile`
- `mocks` or `mocksFile`
- `workflowMap`
- `now`
- `startNode`
- `emulate`
- `emulatorSeedFile`
- `resolveCodeIncludes`
- `codeMode` (`in-process`, `vm`, `os`, or `auto`; `auto` prefers an available
  macOS/Linux OS sandbox and falls back to `vm`)
- `codeTimeoutMs` (positive integer for bounded `vm`, `os`, or `auto` Code
  execution)
- `resume` (waiting-node instructions keyed by node name; see below)

A case-level inline value replaces the corresponding default file reference,
and vice versa. Unknown fields, duplicate case names, invalid input shapes, and
inline/file conflicts are rejected. `nodeOutputs.pointer` is an RFC 6901 JSON
Pointer evaluated against an output item, so `/json/value` reads its JSON
field. Assertions never evaluate JavaScript or workflow expressions.
`nodeRequests` uses the same JSON Pointer rules against sanitized resolved HTTP
request evidence. An optional `request` index selects among per-item requests;
it defaults to `0`. Assertions cannot inspect redacted credential values.
Resolved request values are used only while evaluating these assertions and are
not copied into rehearsal trace summaries. Failure output reports value types,
not the compared values.

Cases can also declare `faults` to test an external-I/O failure path. Each
fault targets one HTTP Request or generic external node by name; only one
fault may target a node in a case. Supported `kind` values are `timeout`,
`http-error` (with an optional `statusCode`, defaulting to 500), and
`malformed-json`. Faults are local deterministic node errors: they do not make
network requests or wait for elapsed time, and take precedence over supplied
mocks and enabled emulators for the targeted node.

`minimumBranchCoverage` measures the fraction of main-pipeline edges that
carried at least one item in the case. `requiredEdges` and `forbiddenEdges`
identify edges by source/destination node and slot. An edge may have a
`deliveryCount` even when it carried zero items; that detail is retained in the
run result so empty branches remain distinguishable from branches that were
never evaluated.

`nodeOutputItemCounts` remains a compact exact-count map. Use
`nodeOutputCardinality` when a final flattened main output needs an `exact`,
`min`, or `max` item-count contract. `nodeOutputLineage` checks the origin IDs
retained for one final output item: `lineage` requires an exact ordered match,
while `lineageContains` requires only the listed origins. An omitted `item`
means item `0`. Lineage is local execution evidence, not a claim about source
records outside this simulator.

In addition to `exists` and `equals`, `nodeOutputs` supports string checks for
human-facing output: `matches` and `notMatches` are regular expressions applied
to the pointed-to value (which must be a string), and `occurrences` bounds how
many times a `substring` appears (`atLeast` and/or `atMost`). These catch the
regressions people read but machines ignore - stray `undefined`, literal
`{{ }}` braces, or a value appearing twice in one message:

```yaml
nodeOutputs:
  - node: Compose Message
    pointer: /json/message
    matches: '^\*Approval request\*'
    notMatches: 'undefined|\{\{|\$\{'
    occurrences:
      substring: Facility
      atMost: 1
```

A case can also pin a golden file with `snapshot: ./golden.json`. The snapshot
stores the case's final per-node output JSON (item `json` only). Run
`s8n rehearse --update-snapshots` to write the baseline; later rehearsals fail
with a bounded path diff when the observed output drifts. This is how "intended
change" is separated from "accident" in assembled strings. Keep snapshots
deterministic by pinning `now`.

### Waiting nodes and resume

A Wait node (`resume: onWebhookCall` / `onFormSubmission`) - the backbone of
approval flows - halts its branch when it has no resume data. Cases resolve it
with `resume`, keyed by node name: an object is the payload delivered to the
resumed node (mirroring a webhook resume), and the literal `"timeout"` models
expiry (which resumes with no payload, so downstream guards fall through to
their default):

```yaml
cases:
  - name: approved
    resume:
      Wait for approval: { approved: true }
    assertions:
      status: success
  - name: timed-out
    resume:
      Wait for approval: timeout
  - name: unresolved
    assertions:
      status: waiting
```

Without a directive the run reports a `waiting` status and the branch stops,
so an incomplete approval flow is visible instead of silently hanging.

### Sub-workflow entry payloads

`subExecutionInputs` asserts what a called child workflow actually received at
its entry trigger - the boundary where payload bugs are most common:

```yaml
subExecutionInputs:
  - callNode: Call Child
    pointer: /json/requestId
    exists: true
    equals: req-7
```

`callNode` names the calling `executeWorkflow` node, `index` selects among
repeated calls (default `0`), and `item` / `pointer` / value checks behave like
`nodeOutputs`. The same string checks (`matches`, `notMatches`,
`occurrences`) apply.

Executed coverage counts nodes that returned `success`, `pinned`, or `error`.
Waiting mocks, unresolved `waiting` nodes, and skipped nodes remain uncovered
with their trace status as the reason. Sticky Notes and nodes connected only
through non-main AI ports are not part of the denominator.

## Draft from an execution log

An n8n-shaped execution log can seed a draft instead of starting from an empty
manifest:

```bash
s8n scenario draft workflow.json execution.json
```

`scenario import` is an equivalent command. The envelope's `data` field is a
valid version 1 manifest. The importer:

- verifies that executed node names exist in the supplied workflow;
- infers `startNode` and fixes `now` from `startedAt` when available;
- uses the start-node output as draft input;
- creates mocks only for HTTP Request and generic external nodes;
- replaces every scalar with a deterministic synthetic value;
- omits binary data, credentials, raw errors, and execution identifiers;
- marks the result `reviewRequired` and lists lossy conversion warnings.

When the execution log contains LLM nodes, the draft also carries an
`llmOutputs` section that normalizes the model's raw output into one place -
`generations`/`text` on language-model and chain nodes, and the parser-shaped
`output` on agents - so "what did the agent actually return" is reviewable
instead of scattered across runData shapes. These verbatim strings are flagged
in the warnings for redaction before sharing.

The generated draft is not claimed to replay the original path. Replaced
values can change conditions, repeated executions are collapsed, and called
workflows still need an explicit map. Review it, run `scenario validate`, then
use `rehearse` failures and uncovered-node reasons to add cases.

## Agent loop

Agents should propose scenarios; s8n should determine whether they pass.

1. Run the workflow once without a manifest to discover mocks or start nodes.
2. Import a reviewed execution log or create a minimal sidecar.
3. Run `rehearse` and inspect assertion failures, pending mock keys, trace
   statuses, and uncovered nodes.
4. Add one synthetic case that reaches a new important path.
5. Keep the case only if it increases union coverage or verifies a critical
   outcome.
6. Add a negative or mutation case proving that the assertion can fail.

Keep private manifests and detailed results in the private workflow repository.
Only original synthetic workflows and scenarios belong in the public s8n
repository.

## Fidelity boundary

Scenario success proves only the supplied local computation, mock shapes, and
enabled emulator behavior. It does not prove authentication, permissions,
rate limits, pagination, webhook delivery, arbitrary SQL, model quality, or
production side effects. Code and expression execution still require a trusted
workflow or OS-level isolation.
