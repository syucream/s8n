# Workflow tests in TypeScript

`s8n test` runs workflow tests written in TypeScript. Each test simulates the
workflow with its own input, mocks, faults, and resume data, then asserts on
the full engine result - including cross-node invariants such as "nothing is
written to Slack unless a human approval happened first".

This is the recommended way to test a workflow beyond the declarative scenario
manifests used by `s8n rehearse`. The YAML manifest remains available, but the
TypeScript layer is where new testing should be written.

## Quick start

The three example suites show the three shapes a test suite covers:

```bash
bun run src/cli/index.ts test examples/hello-world.test.ts
bun run src/cli/index.ts test examples/rehearsal.test.ts
bun run src/cli/index.ts test examples/approval.test.ts
```

Each command prints one JSON envelope with a pass/fail summary and exits 1 when
any case fails.

## How it works

A test file declares a suite with `defineSuite`. Every `test` receives two
helpers:

- `run(options)` simulates the workflow and returns the full `RunResult`
  (execution order, per-node source provenance, intermediate outputs, lineage,
  edge coverage, resolved requests, emulator effects). It is a fresh simulation
  per call: each case starts from clean emulator state.
- `expect(outcome)` is the matcher DSL for common workflow assertions.

Because the outcome exposes the raw `RunResult`, any assertion is expressible -
matchers are ergonomic wrappers, not a ceiling. Plain TypeScript control flow
(`if`, loops, helper functions) works everywhere.

```ts
import { defineSuite } from "s8n";

export default defineSuite(
  { workflow: "./approval.workflow.json", now: "2026-01-01T00:00:00.000Z" },
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
      expect(r).outputOf("Post to Slack").count(1);

      // The full engine result is available for any custom check.
      if (r.ok) {
        const url = r.result.trace.find(
          (entry) => entry.nodeName === "Post to Slack",
        )?.resolvedRequests?.[0]?.url;
        if (typeof url !== "string" || !url.includes("hooks.slack.com")) {
          throw new Error(`Unexpected slack webhook target: ${typeof url}`);
        }
      }
    });
  },
);
```

## Suite configuration

| Field | Purpose |
| --- | --- |
| `workflow` | Workflow JSON/YAML path, resolved relative to the test file |
| `workflowMap` | Explicit map for called sub-workflows |
| `resolveCodeIncludes` | Resolve strict workflow-local `_subfiles` Code assets |
| `emulate` | Suite-wide emulated services; cases can override |
| `codeMode` / `codeTimeoutMs` | Code node isolation mode and timeout |
| `now` | Fixed timestamp for reproducible time-dependent expressions |

## Per-case run options

`run(options)` accepts the same run surface as a scenario case: `input`,
`mocks`, `faults`, `emulatorSeed`, `emulate`, `now`, `startNode`, and `resume`
(for waiting/approval nodes). Resolved HTTP request evidence is captured by
default so `trace[].resolvedRequests` is available to assertions.

## Matchers

| Matcher | Checks |
| --- | --- |
| `status(expected)` | Overall run status (`success`, `error`, `waiting`, `needs_mock`, ...) |
| `ran(node)` | The node executed; returns an ordering matcher |
| `ran(node).before(other)` | Every run of the node finished before every run of `other` |
| `ran(node).after(other)` | Every run of the node finished after every run of `other` |
| `ran(node).beforeAny(other)` | Some run of the node finished before some run of `other` |
| `ran(node).afterAny(other)` | Some run of the node finished after some run of `other` |
| `never(node)` | The node did not execute |
| `outputOf(node).count(n)` | The node's final output has exactly `n` items |
| `outputOf(node).item(i).pointer(p)` | Read an RFC 6901 JSON Pointer on an output item (`/json/x`, `/json/x/0`) |
| `...pointer(p).exists()` / `.equals(v)` | Value presence / deep equality |
| `...pointer(p).matches(re)` / `.notMatches(re)` | String pattern checks |
| `itemReaching(node).passedThrough(gate)` | Items reaching the node flowed through the gate (dynamic data-flow provenance) |
| `allPathsTo(node).passThrough(gate)` | Every static path from a start node to the node passes through the gate |

`before`/`after` compare engine execution order (`executionIndex`), which is
defined for every executed trace entry. When a node runs multiple times (for
example inside a Split In Batches loop), the strict forms require every run to
satisfy the order; the `*Any` forms only require one.

`itemReaching(...).passedThrough(...)` walks the execution's `source` chains
backwards from the target node. It is node-execution-level provenance: a merge
where only some items came from the gate still counts as a pass. The static
`allPathsTo(...).passThrough(...)` check runs over the workflow's main
connections and cannot explode with loops - it looks for any path that reaches
the target while avoiding the gate.

Matcher failure messages report types and counts rather than raw item values,
consistent with the scenario-assertion redaction convention.

## Conditional and cross-node invariants

The example that motivated the feature - "slack writes require prior human
approval" - has three complementary representations:

1. Ordering: `expect(r).ran("Wait for approval").before("Post to Slack")`.
2. Dynamic data flow: `expect(r).itemReaching("Post to Slack").passedThrough("Wait for approval")`.
3. Static structure: `expect(r).allPathsTo("Post to Slack").passThrough("Wait for approval")`.

Conditional rules are plain TypeScript:

```ts
test("writes to slack only happen on approved requests", async (run, expect) => {
  const r = await run({ ... });
  if (r.ok && r.result.nodeOutputs["Post to Slack"]?.length) {
    expect(r).itemReaching("Post to Slack").passedThrough("Wait for approval");
  }
});
```

## Loading and distribution

`defineSuite` can be imported from the `s8n` package (the recommended form) or
used as a global injected by the `s8n test` command (write the file without any
import). The injected globals are the distribution-independent form: they work
from the standalone binary and from a checkout with zero setup:

```bash
bun run src/cli/index.ts test path/to/suite.test.ts
./dist/s8n test path/to/suite.test.ts
```

Import-based test files need the `s8n` package resolvable, so they run from the
repository or from a Bun git dependency rather than the standalone binary. The
package is not published to npm; add it as a Bun git dependency when a project
wants the library API:

```bash
bun add github:syucream/s8n
```

## Fidelity boundary

A passing workflow test proves the supplied local computation, mock shapes, and
enabled emulator behavior. It does not prove authentication, permissions, rate
limits, real pagination, webhook delivery, arbitrary SQL, model quality, or
production side effects. The `itemReaching` provenance is node-execution-level,
not per-item: it does not distinguish "all items passed the gate" from "one of
the merged items passed the gate".