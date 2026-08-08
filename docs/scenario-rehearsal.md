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
    assertions:
      status: success
      minimumCoverage: 0.8
      requiredNodes: [Store Result]
      forbiddenNodes: [No Results]
      pendingMockCount: 0
      verifiedEffects: true
      subExecutionCount: 1
      nodeOutputItemCounts:
        Store Result: 1
      nodeOutputs:
        - node: Store Result
          item: 0
          pointer: /json/saved
          exists: true
          equals: true
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

A case-level inline value replaces the corresponding default file reference,
and vice versa. Unknown fields, duplicate case names, invalid input shapes, and
inline/file conflicts are rejected. `nodeOutputs.pointer` is an RFC 6901 JSON
Pointer evaluated against an output item, so `/json/value` reads its JSON
field. Assertions never evaluate JavaScript or workflow expressions.

Executed coverage counts nodes that returned `success`, `pinned`, or `error`.
Waiting mocks and skipped nodes remain uncovered with their trace status as the
reason. Sticky Notes and nodes connected only through non-main AI ports are not
part of the denominator.

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
