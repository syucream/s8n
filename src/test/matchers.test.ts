import { describe, expect, test } from "bun:test";
import { loadWorkflowFile } from "../cli/load-workflow.ts";
import { runWorkflowFile } from "../cli/run-workflow-file.ts";
import type { NodeTraceEntry, RunResult } from "../engine/execute.ts";
import type { Workflow } from "../schema/workflow.ts";
import { createExpect, TestAssertionError } from "./matchers.ts";
import type { TestRunOutcome } from "./types.ts";

const EXAMPLES = "examples";

function traceEntry(
  node: string,
  index: number,
  overrides: Partial<NodeTraceEntry> = {},
): NodeTraceEntry {
  return {
    nodeName: node,
    nodeType: "n8n-nodes-base.set",
    status: "success",
    inputItemCounts: [1],
    executionIndex: index,
    ...overrides,
  };
}

function syntheticResult(trace: NodeTraceEntry[]): RunResult {
  return {
    status: "success",
    workflowName: "synthetic",
    trace,
    nodeOutputs: {},
    pendingMocks: [],
    errors: [],
    effects: [],
    subExecutions: [],
    edgeCoverage: [],
    branchCoverage: 1,
  };
}

function syntheticOutcome(trace: NodeTraceEntry[]): TestRunOutcome {
  return {
    ok: true,
    result: syntheticResult(trace),
    workflow: undefined as never,
  };
}

async function runExample(
  workflowFile: string,
  options: Partial<Omit<Parameters<typeof runWorkflowFile>[0], "workflowFile">>,
): Promise<TestRunOutcome> {
  const executed = await runWorkflowFile({
    workflowFile,
    hasExplicitInput: options.hasExplicitInput ?? options.input !== undefined,
    ...options,
  });
  if (!executed.ok) {
    return { ok: false, error: executed.error, issues: executed.issues };
  }
  return { ok: true, result: executed.result, workflow: executed.workflow };
}

describe("matchers: status and execution", () => {
  test("status matches the run result", async () => {
    const outcome = await runExample(`${EXAMPLES}/approval.workflow.json`, {
      input: { requestId: "r1", amount: 10 },
      hasExplicitInput: true,
      resume: { "Wait for approval": { approved: true } },
      mocks: { "Post to Slack": { ok: true } },
    });
    expect(outcome.ok).toBe(true);
    expect(() => createExpect(outcome).status("success")).not.toThrow();
    expect(() => createExpect(outcome).status("error")).toThrow(
      TestAssertionError,
    );
  });

  test("ran asserts execution and never asserts absence", async () => {
    const approved = await runExample(`${EXAMPLES}/approval.workflow.json`, {
      input: { requestId: "r2", amount: 10 },
      hasExplicitInput: true,
      resume: { "Wait for approval": { approved: true } },
      mocks: { "Post to Slack": { ok: true } },
    });
    expect(createExpect(approved).ran).not.toBeUndefined();
    expect(() => createExpect(approved).ran("Post to Slack")).not.toThrow();
    expect(() => createExpect(approved).never("Log Rejection")).not.toThrow();
    expect(() => createExpect(approved).ran("Log Rejection")).toThrow(
      TestAssertionError,
    );
    expect(() => createExpect(approved).never("Post to Slack")).toThrow(
      TestAssertionError,
    );

    const rejected = await runExample(`${EXAMPLES}/approval.workflow.json`, {
      input: { requestId: "r3", amount: 10 },
      hasExplicitInput: true,
      resume: { "Wait for approval": { approved: false } },
      mocks: { "Post to Slack": { ok: true } },
    });
    expect(() => createExpect(rejected).never("Post to Slack")).not.toThrow();
    expect(() => createExpect(rejected).ran("Post to Slack")).toThrow(
      TestAssertionError,
    );
  });

  test("a failed run outcome makes every matcher report the run error", () => {
    const failed: TestRunOutcome = { ok: false, error: "boom" };
    expect(() => createExpect(failed).status("success")).toThrow(
      /failed to run: boom/,
    );
    expect(() => createExpect(failed).ran("Any")).toThrow(
      /failed to run: boom/,
    );
    expect(() => createExpect(failed).never("Any")).toThrow(
      /failed to run: boom/,
    );
  });
});

describe("matchers: ordering", () => {
  test("before/after compare execution order on a real run", async () => {
    const outcome = await runExample(`${EXAMPLES}/approval.workflow.json`, {
      input: { requestId: "r4", amount: 10 },
      hasExplicitInput: true,
      resume: { "Wait for approval": { approved: true } },
      mocks: { "Post to Slack": { ok: true } },
    });
    expect(() =>
      createExpect(outcome).ran("Wait for approval").before("Post to Slack"),
    ).not.toThrow();
    expect(() =>
      createExpect(outcome).ran("Post to Slack").after("Wait for approval"),
    ).not.toThrow();
    expect(() =>
      createExpect(outcome).ran("Post to Slack").before("Wait for approval"),
    ).toThrow(TestAssertionError);
    expect(() =>
      createExpect(outcome).ran("Wait for approval").after("Post to Slack"),
    ).toThrow(TestAssertionError);
  });

  test("strict all-run ordering with loop iterations", () => {
    // Node A runs twice (indices 1, 3), Node B twice (indices 0, 2).
    const outcome = syntheticOutcome([
      traceEntry("B", 0),
      traceEntry("A", 1),
      traceEntry("B", 2),
      traceEntry("A", 3),
    ]);
    // Some runs of B precede some runs of A, but not all.
    expect(() => createExpect(outcome).ran("A").before("B")).toThrow(
      TestAssertionError,
    );
    expect(() => createExpect(outcome).ran("B").before("A")).toThrow(
      TestAssertionError,
    );
    expect(() => createExpect(outcome).ran("A").after("B")).toThrow(
      TestAssertionError,
    );
    expect(() => createExpect(outcome).ran("B").beforeAny("A")).not.toThrow();
    expect(() => createExpect(outcome).ran("A").afterAny("B")).not.toThrow();
  });

  test("strict ordering holds when every run of A precedes every run of B", () => {
    const outcome = syntheticOutcome([
      traceEntry("A", 0),
      traceEntry("A", 1),
      traceEntry("B", 2),
      traceEntry("B", 3),
    ]);
    expect(() => createExpect(outcome).ran("A").before("B")).not.toThrow();
    expect(() => createExpect(outcome).ran("B").after("A")).not.toThrow();
    expect(() => createExpect(outcome).ran("A").after("B")).toThrow(
      TestAssertionError,
    );
  });

  test("ordering requires both nodes to have executed", () => {
    const outcome = syntheticOutcome([traceEntry("A", 0)]);
    expect(() => createExpect(outcome).ran("A").before("Missing")).toThrow(
      /"Missing" did not execute/,
    );
    expect(() => createExpect(outcome).ran("Missing").before("A")).toThrow(
      /"Missing" did not execute/,
    );
  });
});

describe("matchers: itemReaching", () => {
  test("detects data flow through an approval gate", async () => {
    const outcome = await runExample(`${EXAMPLES}/approval.workflow.json`, {
      input: { requestId: "r5", amount: 10 },
      hasExplicitInput: true,
      resume: { "Wait for approval": { approved: true } },
      mocks: { "Post to Slack": { ok: true } },
    });
    expect(() =>
      createExpect(outcome)
        .itemReaching("Post to Slack")
        .passedThrough("Wait for approval"),
    ).not.toThrow();
    expect(() =>
      createExpect(outcome)
        .itemReaching("Post to Slack")
        .passedThrough("Log Rejection"),
    ).toThrow(TestAssertionError);
  });

  test("walks merged sources when multiple predecessors feed a node", () => {
    const outcome = syntheticOutcome([
      traceEntry("Start", 0),
      traceEntry("Gate", 1, {
        source: [
          { previousNode: "Start", previousNodeOutput: 0, previousNodeRun: 0 },
        ],
      }),
      traceEntry("Side", 2, {
        source: [
          { previousNode: "Start", previousNodeOutput: 0, previousNodeRun: 0 },
        ],
      }),
      traceEntry("Merge", 3, {
        source: [
          { previousNode: "Gate", previousNodeOutput: 0, previousNodeRun: 0 },
          { previousNode: "Side", previousNodeOutput: 0, previousNodeRun: 0 },
        ],
      }),
    ]);
    expect(() =>
      createExpect(outcome).itemReaching("Merge").passedThrough("Gate"),
    ).not.toThrow();
  });

  test("fails when the target never executed", () => {
    const outcome = syntheticOutcome([traceEntry("A", 0)]);
    expect(() =>
      createExpect(outcome).itemReaching("Missing").passedThrough("A"),
    ).toThrow(/failed to run|Expected items reaching/);
  });
});

describe("matchers: allPathsTo", () => {
  async function approvalWorkflow(): Promise<Workflow> {
    const loaded = await loadWorkflowFile(
      `${EXAMPLES}/approval.workflow.json`,
      {},
    );
    if (!loaded.ok || !loaded.workflow) {
      throw new Error("fixture workflow failed to load");
    }
    return loaded.workflow;
  }

  test("every static path to the external write passes the gate", async () => {
    const workflow = await approvalWorkflow();
    const outcome: TestRunOutcome = {
      ok: true,
      result: syntheticResult([]),
      workflow,
    };
    expect(() =>
      createExpect(outcome)
        .allPathsTo("Post to Slack")
        .passThrough("Wait for approval"),
    ).not.toThrow();
    // A gate that is not on the path to the target must be rejected.
    expect(() =>
      createExpect(outcome)
        .allPathsTo("Post to Slack")
        .passThrough("Log Rejection"),
    ).toThrow(TestAssertionError);
  });

  test("a gate on a different branch fails for the target", async () => {
    const workflow = await approvalWorkflow();
    const outcome: TestRunOutcome = {
      ok: true,
      result: syntheticResult([]),
      workflow,
    };
    // "Log Rejection" and "Post to Slack" sit on different branches; neither
    // is on the other's only path.
    expect(() =>
      createExpect(outcome)
        .allPathsTo("Log Rejection")
        .passThrough("Post to Slack"),
    ).toThrow(TestAssertionError);
    expect(() =>
      createExpect(outcome)
        .allPathsTo("Post to Slack")
        .passThrough("Log Rejection"),
    ).toThrow(TestAssertionError);
  });
});

describe("matchers: outputOf", () => {
  test("counts and reads item pointers", async () => {
    const outcome = await runExample(`${EXAMPLES}/approval.workflow.json`, {
      input: { requestId: "r6", amount: 10 },
      hasExplicitInput: true,
      resume: { "Wait for approval": { approved: true } },
      mocks: { "Post to Slack": { ok: true } },
    });
    expect(() =>
      createExpect(outcome).outputOf("Post to Slack").count(1),
    ).not.toThrow();
    expect(() =>
      createExpect(outcome).outputOf("Post to Slack").count(2),
    ).toThrow(TestAssertionError);
    expect(() =>
      createExpect(outcome)
        .outputOf("Post to Slack")
        .item(0)
        .pointer("/json/ok")
        .equals(true),
    ).not.toThrow();
    expect(() =>
      createExpect(outcome)
        .outputOf("Post to Slack")
        .item(0)
        .pointer("/json/ok")
        .equals(false),
    ).toThrow(TestAssertionError);
    expect(() =>
      createExpect(outcome)
        .outputOf("Post to Slack")
        .item(0)
        .pointer("/json/missing")
        .exists(),
    ).toThrow(TestAssertionError);
    expect(() =>
      createExpect(outcome)
        .outputOf("Post to Slack")
        .item(5)
        .pointer("/json/x")
        .exists(),
    ).toThrow(/have an output item at index 5/);
  });

  test("string matchers apply to string values only", async () => {
    const outcome = await runExample(`${EXAMPLES}/rehearsal.workflow.json`, {
      input: { amount: 150 },
      hasExplicitInput: true,
    });
    expect(() =>
      createExpect(outcome)
        .outputOf("High Tier")
        .item(0)
        .pointer("/json/tier")
        .matches(/^high$/),
    ).not.toThrow();
    expect(() =>
      createExpect(outcome)
        .outputOf("High Tier")
        .item(0)
        .pointer("/json/tier")
        .notMatches(/^standard$/),
    ).not.toThrow();
    expect(() =>
      createExpect(outcome)
        .outputOf("High Tier")
        .item(0)
        .pointer("/json/tier")
        .matches(/^standard$/),
    ).toThrow(TestAssertionError);
  });
});
