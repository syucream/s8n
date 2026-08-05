import { describe, expect, test } from "bun:test";
import { EmulatorIntegrationRunner } from "../integrations/emulator.ts";
import type { IntegrationRunner } from "../integrations/types.ts";
import { createMockLookup, emptyMockLookup } from "../mock/provider.ts";
import { createDefaultRegistry } from "../nodes/registry.ts";
import { toItems } from "../schema/item.ts";
import type { Workflow } from "../schema/workflow.ts";
import { validateWorkflow } from "../schema/workflow.ts";
import { runWorkflow } from "./execute.ts";

function wf(raw: unknown): Workflow {
  const result = validateWorkflow(raw);
  if (!result.valid || !result.workflow)
    throw new Error(JSON.stringify(result.issues));
  return result.workflow;
}

const registry = createDefaultRegistry();

describe("runWorkflow", () => {
  test("runs a simple trigger -> set chain", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Set",
          type: "n8n-nodes-base.set",
          parameters: {
            fields: [{ name: "greeting", value: "=Hi {{$json.name}}" }],
          },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Set", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ name: "Alice" }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");
    // Real n8n Set defaults `includeOtherFields` to false: only assigned fields survive.
    expect(result.nodeOutputs.Set?.[0]?.json).toEqual({ greeting: "Hi Alice" });
    const triggerRun = result.trace.find(
      (entry) => entry.nodeName === "Trigger" && entry.status === "success",
    );
    const setRun = result.trace.find(
      (entry) => entry.nodeName === "Set" && entry.status === "success",
    );
    expect(triggerRun).toMatchObject({
      executionIndex: 0,
      executionStatus: "success",
      source: [],
      data: {
        main: [[{ json: { name: "Alice" }, pairedItem: { item: 0 } }]],
      },
    });
    expect(triggerRun?.startTime).toBeNumber();
    expect(triggerRun?.executionTime).toBeNumber();
    expect(setRun).toMatchObject({
      executionIndex: 1,
      executionStatus: "success",
      source: [
        {
          previousNode: "Trigger",
          previousNodeOutput: 0,
          previousNodeRun: 0,
        },
      ],
      data: {
        main: [[{ json: { greeting: "Hi Alice" }, pairedItem: { item: 0 } }]],
      },
    });
  });

  test("Set keeps existing fields when includeOtherFields is true", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Set",
          type: "n8n-nodes-base.set",
          parameters: {
            includeOtherFields: true,
            fields: [{ name: "greeting", value: "=Hi {{$json.name}}" }],
          },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Set", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ name: "Alice" }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.nodeOutputs.Set?.[0]?.json).toEqual({
      name: "Alice",
      greeting: "Hi Alice",
    });
  });

  test("Set supports the legacy typed values shape in published workflows", async () => {
    const workflow = wf({
      name: "legacy-set",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Set",
          type: "n8n-nodes-base.set",
          parameters: {
            keepOnlySet: true,
            values: {
              string: [{ name: "name", value: "={{$json.name}}" }],
              number: [{ name: "latitude", value: "={{$json.latitude}}" }],
            },
          },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Set", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([
        { name: "iss", latitude: 35.6812, ignored: true },
      ]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.nodeOutputs.Set?.[0]?.json).toEqual({
      name: "iss",
      latitude: 35.6812,
    });
  });

  test("Time Saved records no external I/O and preserves main items", async () => {
    const workflow = wf({
      name: "time-saved",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Time Saved",
          type: "n8n-nodes-base.timeSaved",
          parameters: { mode: "perItem", minutesSaved: 0.5 },
        },
      ],
      connections: {
        Trigger: {
          main: [[{ node: "Time Saved", type: "main", index: 0 }]],
        },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ id: "mail-1" }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");
    expect(result.nodeOutputs["Time Saved"]?.[0]?.json).toEqual({
      id: "mail-1",
    });
    expect(result.effects).toEqual([]);
  });

  test("Set evaluates includeOtherFields as a per-item expression, not just a literal boolean", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Set",
          type: "n8n-nodes-base.set",
          parameters: {
            includeOtherFields: "={{$json.keepAll}}",
            fields: [{ name: "greeting", value: "hi" }],
          },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Set", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([
        { keepAll: true, extra: "x" },
        { keepAll: false, extra: "y" },
      ]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.nodeOutputs.Set?.[0]?.json).toEqual({
      keepAll: true,
      extra: "x",
      greeting: "hi",
    });
    expect(result.nodeOutputs.Set?.[1]?.json).toEqual({ greeting: "hi" });
  });

  test("Set raw mode parses the n8n jsonOutput object used by community templates", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Configure",
          type: "n8n-nodes-base.set",
          parameters: {
            mode: "raw",
            jsonOutput: '{"mapping":{"source":"price"},"enabled":true}',
          },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Configure", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ ignored: true }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");
    expect(result.nodeOutputs.Configure?.[0]?.json).toEqual({
      mapping: { source: "price" },
      enabled: true,
    });
  });

  test("Set raw mode reports invalid JSON as a node error", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Configure",
          type: "n8n-nodes-base.set",
          parameters: { mode: "raw", jsonOutput: "{invalid" },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Configure", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("error");
    expect(result.errors[0]).toContain("failed to parse raw JSON output");
  });

  test("routes items through If into the correct branch only", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Check",
          type: "n8n-nodes-base.if",
          parameters: { condition: "={{$json.amount > 100}}" },
        },
        { id: "3", name: "High", type: "n8n-nodes-base.noOp", parameters: {} },
        { id: "4", name: "Low", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: {
        Trigger: { main: [[{ node: "Check", type: "main", index: 0 }]] },
        Check: {
          main: [
            [{ node: "High", type: "main", index: 0 }],
            [{ node: "Low", type: "main", index: 0 }],
          ],
        },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ amount: 500 }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.nodeOutputs.High).toHaveLength(1);
    // Real n8n skips a node entirely when all its inputs deliver zero items.
    expect(result.nodeOutputs.Low).toBeUndefined();
    expect(result.trace.find((t) => t.nodeName === "Low")?.status).toBe(
      "skipped_no_data",
    );
  });

  test("$('NodeName').all() on one If branch doesn't see items routed to the other branch", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Check",
          type: "n8n-nodes-base.if",
          parameters: { condition: "={{$json.amount > 100}}" },
        },
        {
          id: "3",
          name: "High",
          type: "n8n-nodes-base.set",
          parameters: {
            fields: [
              { name: "seenByCheck", value: "={{$('Check').all().length}}" },
            ],
          },
        },
        { id: "4", name: "Low", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: {
        Trigger: { main: [[{ node: "Check", type: "main", index: 0 }]] },
        Check: {
          main: [
            [{ node: "High", type: "main", index: 0 }],
            [{ node: "Low", type: "main", index: 0 }],
          ],
        },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ amount: 500 }, { amount: 1 }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    // Only the one item that took the true branch should be visible from
    // High's `$('Check')` reference - not both items across both branches.
    expect(result.nodeOutputs.High?.[0]?.json.seenByCheck).toBe(1);
  });

  test("requests a mock for an HTTP Request node and resumes once one is supplied", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Call API",
          type: "n8n-nodes-base.httpRequest",
          parameters: { method: "GET", url: "https://example.com" },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Call API", type: "main", index: 0 }]] },
      },
    });

    const withoutMock = await runWorkflow(workflow, {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
    });
    expect(withoutMock.status).toBe("needs_mock");
    expect(withoutMock.pendingMocks[0]?.mockKey).toBe("Call API");

    const withMock = await runWorkflow(workflow, {
      hasExplicitInput: false,
      mocks: createMockLookup({ "Call API": { ok: true } }),
      registry,
    });
    expect(withMock.status).toBe("success");
    expect(withMock.nodeOutputs["Call API"]?.[0]?.json).toEqual({ ok: true });
  });

  test("merges two branches back together (append mode)", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "A",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "SetA",
          type: "n8n-nodes-base.set",
          parameters: { fields: [{ name: "from", value: "a" }] },
        },
        {
          id: "3",
          name: "SetB",
          type: "n8n-nodes-base.set",
          parameters: { fields: [{ name: "from", value: "b" }] },
        },
        {
          id: "4",
          name: "Combine",
          type: "n8n-nodes-base.merge",
          parameters: { mode: "append" },
        },
      ],
      connections: {
        A: {
          main: [
            [
              { node: "SetA", type: "main", index: 0 },
              { node: "SetB", type: "main", index: 0 },
            ],
          ],
        },
        SetA: { main: [[{ node: "Combine", type: "main", index: 0 }]] },
        SetB: { main: [[{ node: "Combine", type: "main", index: 1 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");
    expect(result.nodeOutputs.Combine?.map((i) => i.json.from)).toEqual([
      "a",
      "b",
    ]);
  });

  test("Merge chooseBranch passes through the selected input", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Left",
          type: "n8n-nodes-base.set",
          parameters: { fields: [{ name: "branch", value: "left" }] },
        },
        {
          id: "3",
          name: "Right",
          type: "n8n-nodes-base.set",
          parameters: { fields: [{ name: "branch", value: "right" }] },
        },
        {
          id: "4",
          name: "Choose",
          type: "n8n-nodes-base.merge",
          parameters: { mode: "chooseBranch", output: "input2" },
        },
      ],
      connections: {
        Trigger: {
          main: [
            [
              { node: "Left", type: "main", index: 0 },
              { node: "Right", type: "main", index: 0 },
            ],
          ],
        },
        Left: { main: [[{ node: "Choose", type: "main", index: 0 }]] },
        Right: { main: [[{ node: "Choose", type: "main", index: 1 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");
    expect(result.nodeOutputs.Choose?.map((item) => item.json.branch)).toEqual([
      "right",
    ]);
  });

  test("Merge combineAll produces every input combination", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Choose",
          type: "n8n-nodes-base.merge",
          parameters: { mode: "combine", combineBy: "combineAll" },
        },
      ],
      connections: {
        Trigger: {
          main: [
            [
              { node: "Choose", type: "main", index: 0 },
              { node: "Choose", type: "main", index: 1 },
            ],
          ],
        },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ value: "a" }, { value: "b" }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");
    expect(result.nodeOutputs.Choose).toHaveLength(4);
  });

  test("Merge's own expression scope sees the real first item on slot 0, not a hardcoded empty object", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Combine",
          type: "n8n-nodes-base.merge",
          parameters: { mode: "={{$json.mode}}" },
        },
      ],
      connections: {
        Trigger: {
          main: [
            [
              { node: "Combine", type: "main", index: 0 },
              { node: "Combine", type: "main", index: 1 },
            ],
          ],
        },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ mode: "append" }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    // If Combine's own scope saw {} instead of the real seeded item, `mode`
    // would resolve to undefined -> String(undefined) -> "combine" fallback,
    // not "append".
    expect(result.status).toBe("success");
    expect(result.nodeOutputs.Combine).toHaveLength(2);
  });

  test("continueOnFail swallows an error and keeps the run non-fatal", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Bad Code",
          type: "n8n-nodes-base.code",
          continueOnFail: true,
          parameters: { jsCode: "throw new Error('boom')" },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Bad Code", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");
    expect(
      result.trace.find((t) => t.nodeName === "Bad Code")?.error,
    ).toContain("boom");
    // Real n8n passes the node's own input through unchanged on a
    // continue-on-fail whole-node throw, it does not emit an empty output.
    expect(result.nodeOutputs["Bad Code"]).toEqual(result.nodeOutputs.Trigger);
  });

  test("Split In Batches truly re-executes the loop body once per batch", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Loop",
          type: "n8n-nodes-base.splitInBatches",
          parameters: { batchSize: 1 },
        },
        {
          id: "3",
          name: "ProcessItem",
          type: "n8n-nodes-base.code",
          parameters: {
            jsCode:
              "return [{ json: { value: $('Loop').item.json.value * 10 } }];",
          },
        },
        {
          id: "4",
          name: "AfterLoop",
          type: "n8n-nodes-base.noOp",
          parameters: {},
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Loop", type: "main", index: 0 }]] },
        Loop: {
          main: [
            [{ node: "AfterLoop", type: "main", index: 0 }],
            [{ node: "ProcessItem", type: "main", index: 0 }],
          ],
        },
        ProcessItem: { main: [[{ node: "Loop", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ value: 1 }, { value: 2 }, { value: 3 }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");
    // `done` gets the original 3 items unchanged, not whatever the body produced.
    expect(result.nodeOutputs.AfterLoop?.map((i) => i.json.value)).toEqual([
      1, 2, 3,
    ]);

    const processItemTrace = result.trace.filter(
      (t) => t.nodeName === "ProcessItem",
    );
    // One real invocation per batch (batchSize: 1 -> 3 iterations), each
    // seeing only its own item - not all 3 items at once (the old
    // single-pass collapse's documented divergence).
    expect(processItemTrace).toHaveLength(3);
    expect(processItemTrace.map((t) => t.runIndex)).toEqual([0, 1, 2]);
    expect(processItemTrace.map((t) => t.outputItemCounts)).toEqual([
      [1],
      [1],
      [1],
    ]);
  });

  test("Split In Batches groups items per batchSize > 1", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Loop",
          type: "n8n-nodes-base.splitInBatches",
          parameters: { batchSize: 2 },
        },
        {
          id: "3",
          name: "ProcessBatch",
          type: "n8n-nodes-base.noOp",
          parameters: {},
        },
        {
          id: "4",
          name: "AfterLoop",
          type: "n8n-nodes-base.noOp",
          parameters: {},
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Loop", type: "main", index: 0 }]] },
        Loop: {
          main: [
            [{ node: "AfterLoop", type: "main", index: 0 }],
            [{ node: "ProcessBatch", type: "main", index: 0 }],
          ],
        },
        ProcessBatch: { main: [[{ node: "Loop", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ v: 1 }, { v: 2 }, { v: 3 }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");
    const processBatchTrace = result.trace.filter(
      (t) => t.nodeName === "ProcessBatch",
    );
    // 3 items / batchSize 2 -> 2 iterations: [2 items, 1 item].
    expect(processBatchTrace.map((t) => t.inputItemCounts)).toEqual([[2], [1]]);
  });

  test("Split In Batches with no back-edge falls back to the single-pass collapse", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Loop",
          type: "n8n-nodes-base.splitInBatches",
          parameters: { batchSize: 1 },
        },
        {
          id: "3",
          name: "DeadEnd",
          type: "n8n-nodes-base.noOp",
          parameters: {},
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Loop", type: "main", index: 0 }]] },
        // `loop` output goes to a node that never wires back to Loop.
        Loop: { main: [[], [{ node: "DeadEnd", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ v: 1 }, { v: 2 }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");
    expect(result.nodeOutputs.DeadEnd).toHaveLength(2);
    expect(result.trace.filter((t) => t.nodeName === "DeadEnd")).toHaveLength(
      1,
    );
  });

  test("a loop-body node fed by a one-time external source keeps that data across iterations", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Config",
          type: "n8n-nodes-base.set",
          parameters: { fields: [{ name: "tag", value: "X" }] },
        },
        {
          id: "3",
          name: "Loop",
          type: "n8n-nodes-base.splitInBatches",
          parameters: { batchSize: 1 },
        },
        {
          id: "4",
          name: "Merge",
          type: "n8n-nodes-base.merge",
          parameters: { mode: "combine", combineBy: "combineByPosition" },
        },
        {
          id: "5",
          name: "AfterLoop",
          type: "n8n-nodes-base.noOp",
          parameters: {},
        },
      ],
      connections: {
        Trigger: {
          main: [
            [
              { node: "Config", type: "main", index: 0 },
              { node: "Loop", type: "main", index: 0 },
            ],
          ],
        },
        Config: { main: [[{ node: "Merge", type: "main", index: 1 }]] },
        Loop: {
          main: [
            [{ node: "AfterLoop", type: "main", index: 0 }],
            [{ node: "Merge", type: "main", index: 0 }],
          ],
        },
        Merge: { main: [[{ node: "Loop", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ value: 1 }, { value: 2 }, { value: 3 }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");
    // Merge needs both slot 0 (this batch, from Loop) and slot 1 (Config's
    // one-time output, delivered before the loop ever starts). If slot 1
    // got wiped by the per-iteration reset, Merge would never see `filled
    // >= needed` again after iteration 0 and would silently stop running.
    const mergeTrace = result.trace.filter((t) => t.nodeName === "Merge");
    expect(mergeTrace).toHaveLength(3);
    // Config runs once on all 3 initial items, so slot 1 always holds 3
    // items; combineByPosition zips it against slot 0's 1-item batch each
    // time. What matters here is that Merge keeps running at all (length 3
    // above) rather than starving after iteration 0.
    expect(mergeTrace.map((t) => t.outputItemCounts)).toEqual([[3], [3], [3]]);
  });

  test("a loop-body branch that never cycles back to the SIB still re-executes every batch", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Loop",
          type: "n8n-nodes-base.splitInBatches",
          parameters: { batchSize: 1 },
        },
        {
          id: "3",
          name: "ProcessItem",
          type: "n8n-nodes-base.noOp",
          parameters: {},
        },
        { id: "4", name: "Log", type: "n8n-nodes-base.noOp", parameters: {} },
        {
          id: "5",
          name: "AfterLoop",
          type: "n8n-nodes-base.noOp",
          parameters: {},
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Loop", type: "main", index: 0 }]] },
        Loop: {
          main: [
            [{ node: "AfterLoop", type: "main", index: 0 }],
            [{ node: "ProcessItem", type: "main", index: 0 }],
          ],
        },
        // ProcessItem fans out to a dead-end logger AND the back-edge - Log
        // never reaches Loop, so it's not on the cycle, but real n8n still
        // replays it every batch since it's part of the loop body.
        ProcessItem: {
          main: [
            [
              { node: "Log", type: "main", index: 0 },
              { node: "Loop", type: "main", index: 0 },
            ],
          ],
        },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ v: 1 }, { v: 2 }, { v: 3 }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");
    const logTrace = result.trace.filter((t) => t.nodeName === "Log");
    expect(logTrace).toHaveLength(3);
    expect(logTrace.map((t) => t.inputItemCounts)).toEqual([[1], [1], [1]]);
  });

  test("a missing mock inside a loop body halts further iterations instead of repeating the request", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Loop",
          type: "n8n-nodes-base.splitInBatches",
          parameters: { batchSize: 1 },
        },
        {
          id: "3",
          name: "Call API",
          type: "n8n-nodes-base.httpRequest",
          parameters: { method: "GET", url: "https://example.com" },
        },
        {
          id: "4",
          name: "AfterLoop",
          type: "n8n-nodes-base.noOp",
          parameters: {},
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Loop", type: "main", index: 0 }]] },
        Loop: {
          main: [
            [{ node: "AfterLoop", type: "main", index: 0 }],
            [{ node: "Call API", type: "main", index: 0 }],
          ],
        },
        "Call API": {
          main: [[{ node: "Loop", type: "main", index: 0 }]],
        },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ v: 1 }, { v: 2 }, { v: 3 }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("needs_mock");
    expect(
      result.trace.filter(
        (t) => t.nodeName === "Call API" && t.status === "waiting_mock",
      ),
    ).toHaveLength(1);
    // The loop never actually finished - only 1 of 3 items were ever
    // processed - so `done` must NOT fire and AfterLoop must never run,
    // matching real n8n halting the whole execution rather than treating a
    // paused loop as complete.
    expect(result.nodeOutputs.AfterLoop).toBeUndefined();
    expect(result.trace.find((t) => t.nodeName === "AfterLoop")?.status).toBe(
      "unreached",
    );
  });

  test("an uncaught error inside a loop body halts further iterations", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Loop",
          type: "n8n-nodes-base.splitInBatches",
          parameters: { batchSize: 1 },
        },
        {
          id: "3",
          name: "BadCode",
          type: "n8n-nodes-base.code",
          parameters: { jsCode: "throw new Error('boom')" },
        },
        {
          id: "4",
          name: "AfterLoop",
          type: "n8n-nodes-base.noOp",
          parameters: {},
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Loop", type: "main", index: 0 }]] },
        Loop: {
          main: [
            [{ node: "AfterLoop", type: "main", index: 0 }],
            [{ node: "BadCode", type: "main", index: 0 }],
          ],
        },
        BadCode: { main: [[{ node: "Loop", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ v: 1 }, { v: 2 }, { v: 3 }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("error");
    expect(
      result.trace.filter(
        (t) => t.nodeName === "BadCode" && t.status === "error",
      ),
    ).toHaveLength(1);
    // Same as the waiting_mock case: the loop failed partway through, so
    // `done` must not fire and AfterLoop must never execute.
    expect(result.nodeOutputs.AfterLoop).toBeUndefined();
    expect(result.trace.find((t) => t.nodeName === "AfterLoop")?.status).toBe(
      "unreached",
    );
  });

  test("a node inside a loop body keys its per-item mock by loop iteration, not by its always-0 within-batch index", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Loop",
          type: "n8n-nodes-base.splitInBatches",
          parameters: { batchSize: 1 },
        },
        {
          id: "3",
          name: "Call API",
          type: "n8n-nodes-base.httpRequest",
          parameters: { method: "GET", url: "https://example.com" },
        },
        {
          id: "4",
          name: "AfterLoop",
          type: "n8n-nodes-base.noOp",
          parameters: {},
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Loop", type: "main", index: 0 }]] },
        Loop: {
          main: [
            [{ node: "AfterLoop", type: "main", index: 0 }],
            [{ node: "Call API", type: "main", index: 0 }],
          ],
        },
        "Call API": { main: [[{ node: "Loop", type: "main", index: 0 }]] },
      },
    });

    // Only iteration 0's mock is supplied. Each batch has exactly 1 item,
    // so the executor's own local index is always 0 - if the lookup used
    // that local index instead of the loop iteration, every iteration would
    // collide on "Call API#0" and this would wrongly report "success" for
    // all 3. It should instead succeed once, then pause on iteration 1's
    // distinct key ("Call API#1"), which was deliberately left unmocked.
    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ v: 1 }, { v: 2 }, { v: 3 }]),
      hasExplicitInput: true,
      mocks: createMockLookup({ "Call API#0": { page: "first" } }),
      registry,
    });

    expect(result.status).toBe("needs_mock");
    const callApiTrace = result.trace.filter((t) => t.nodeName === "Call API");
    expect(callApiTrace).toHaveLength(2);
    expect(callApiTrace[0]?.status).toBe("success");
    expect(callApiTrace[0]?.runIndex).toBe(0);
    expect(callApiTrace[1]?.status).toBe("waiting_mock");
    expect(callApiTrace[1]?.runIndex).toBe(1);
    expect(callApiTrace[1]?.pendingMock?.mockKey).toBe("Call API");
  });

  test("a loop-body node two hops past a skipped branch isn't falsely reported as unreached", async () => {
    // Check -> NodeA -> NodeB (two hops). When Check's branch to NodeA
    // isn't taken, NodeA gets a normal "skipped_no_data" (0 items, exactly
    // like an If's untaken branch anywhere else in s8n) and, per its own
    // early-return, never propagates - so NodeB is never even queued that
    // iteration, unlike NodeA which still gets a real (skipped) trace entry
    // every iteration because it's directly wired to Check's output.
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Loop",
          type: "n8n-nodes-base.splitInBatches",
          parameters: { batchSize: 1 },
        },
        {
          id: "3",
          name: "Check",
          type: "n8n-nodes-base.if",
          parameters: { condition: "={{$json.value == 1}}" },
        },
        { id: "4", name: "NodeA", type: "n8n-nodes-base.noOp", parameters: {} },
        { id: "5", name: "NodeB", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: {
        Trigger: { main: [[{ node: "Loop", type: "main", index: 0 }]] },
        Loop: { main: [[], [{ node: "Check", type: "main", index: 0 }]] },
        Check: {
          main: [
            [{ node: "NodeA", type: "main", index: 0 }],
            [{ node: "Loop", type: "main", index: 0 }],
          ],
        },
        NodeA: { main: [[{ node: "NodeB", type: "main", index: 0 }]] },
        NodeB: { main: [[{ node: "Loop", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      // Iteration 0 (value: 1) takes Check's true branch through NodeA and
      // NodeB; iteration 1 (value: 2) takes the false branch straight back
      // to Loop, never touching NodeA or NodeB again.
      initialInput: toItems([{ value: 1 }, { value: 2 }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");

    // NodeA is directly wired to Check's output, so it's touched (with 0
    // items) every iteration Check doesn't route to it - same mechanism as
    // any If's untaken branch, correctly reported as "skipped_no_data" both
    // times, not "unreached".
    const nodeATrace = result.trace.filter((t) => t.nodeName === "NodeA");
    expect(nodeATrace.map((t) => t.status)).toEqual([
      "success",
      "skipped_no_data",
    ]);

    // NodeB is one hop further downstream of NodeA, which never propagates
    // on its own "skipped_no_data" path - so NodeB is never re-touched in
    // iteration 1 at all. It must keep its single genuine "success" entry
    // from iteration 0, without a trailing "unreached" entry from the final
    // sweep just because `executed` got reset out from under it.
    const nodeBTrace = result.trace.filter((t) => t.nodeName === "NodeB");
    expect(nodeBTrace).toHaveLength(1);
    expect(nodeBTrace[0]?.status).toBe("success");
    expect(nodeBTrace[0]?.runIndex).toBe(0);
  });

  test("Split In Batches resolves batchSize as an expression, not just a literal number", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Loop",
          type: "n8n-nodes-base.splitInBatches",
          parameters: { batchSize: "={{$json.chunkSize}}" },
        },
        {
          id: "3",
          name: "ProcessBatch",
          type: "n8n-nodes-base.noOp",
          parameters: {},
        },
        {
          id: "4",
          name: "AfterLoop",
          type: "n8n-nodes-base.noOp",
          parameters: {},
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Loop", type: "main", index: 0 }]] },
        Loop: {
          main: [
            [{ node: "AfterLoop", type: "main", index: 0 }],
            [{ node: "ProcessBatch", type: "main", index: 0 }],
          ],
        },
        ProcessBatch: { main: [[{ node: "Loop", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([
        { chunkSize: 2, v: 1 },
        { v: 2 },
        { v: 3 },
        { v: 4 },
      ]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");
    const processBatchTrace = result.trace.filter(
      (t) => t.nodeName === "ProcessBatch",
    );
    // 4 items / batchSize resolved from `$json.chunkSize` (2) -> 2 iterations of 2.
    expect(processBatchTrace.map((t) => t.inputItemCounts)).toEqual([[2], [2]]);
  });

  test("workflow.settings.timezone applies to $now and DateTime's getCurrentDate, matching real n8n's WorkflowDataProxy", async () => {
    const workflow = wf({
      name: "t",
      settings: { timezone: "Asia/Tokyo" },
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Set",
          type: "n8n-nodes-base.set",
          parameters: {
            fields: [{ name: "zone", value: "={{$now.zoneName}}" }],
          },
        },
        {
          id: "3",
          name: "Now",
          type: "n8n-nodes-base.dateTime",
          parameters: { operation: "getCurrentDate" },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Set", type: "main", index: 0 }]] },
        Set: { main: [[{ node: "Now", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{}]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(result.status).toBe("success");
    expect(result.nodeOutputs.Set?.[0]?.json.zone).toBe("Asia/Tokyo");
    expect(result.nodeOutputs.Now?.[0]?.json.currentDate).toContain("+09:00");
  });

  test("onError: continueErrorOutput behaves the same as continueOnFail for a whole-node throw", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Bad Code",
          type: "n8n-nodes-base.code",
          onError: "continueErrorOutput",
          parameters: { jsCode: "throw new Error('boom')" },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Bad Code", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");
    expect(result.nodeOutputs["Bad Code"]).toEqual(result.nodeOutputs.Trigger);
  });

  test("an unmodeled node type falls back to a generic mock request instead of failing", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Post to Slack",
          type: "n8n-nodes-base.slack",
          parameters: { channel: "sandbox" },
        },
      ],
      connections: {},
    });

    const withoutMock = await runWorkflow(workflow, {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
    });
    expect(withoutMock.status).toBe("needs_mock");
    expect(withoutMock.pendingMocks[0]?.mockKey).toBe("Post to Slack");
    expect(withoutMock.errors).toEqual([]);

    const withMock = await runWorkflow(workflow, {
      hasExplicitInput: false,
      mocks: createMockLookup({ "Post to Slack": { ok: true, ts: "123.456" } }),
      registry,
    });
    expect(withMock.status).toBe("success");
    expect(withMock.nodeOutputs["Post to Slack"]?.[0]?.json).toEqual({
      ok: true,
      ts: "123.456",
    });
  });

  test("an explicitly enabled integration runner executes legacy Slack parameters and records a verified effect", async () => {
    const workflow = wf({
      name: "Community-style release notification",
      nodes: [
        {
          name: "Github Trigger",
          type: "n8n-nodes-base.githubTrigger",
          parameters: {},
        },
        {
          name: "Slack",
          type: "n8n-nodes-base.slack",
          parameters: {
            channel: "release-alerts",
            text: '=Release {{$node["Github Trigger"].json["tag"]}}',
          },
        },
      ],
      connections: {
        "Github Trigger": {
          main: [[{ node: "Slack", type: "main", index: 0 }]],
        },
      },
    });
    const integrationRunner: IntegrationRunner = {
      async execute(node, parameters) {
        if (node.type !== "n8n-nodes-base.slack") return undefined;
        const response = {
          ok: true,
          channel: parameters.channel,
          text: parameters.text,
        };
        return {
          output: response,
          effect: {
            nodeName: node.name,
            nodeType: node.type,
            service: "slack",
            operation: "chat.postMessage",
            request: parameters,
            response,
            observation: { message: response },
            verified: true,
          },
        };
      },
      async close() {},
    };

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ tag: "v0.2.0" }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
      integrationRunner,
    });

    expect(result.status).toBe("success");
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]?.verified).toBe(true);
    expect(result.effects[0]?.request).toMatchObject({
      channel: "release-alerts",
      text: "Release v0.2.0",
    });
  });

  test("a Vertex AI language-model subnode drives its connected chain", async () => {
    const workflow = wf({
      name: "Published-style Vertex chain",
      nodes: [
        {
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          name: "Summarize",
          type: "@n8n/n8n-nodes-langchain.chainLlm",
          parameters: {
            text: "=Summarize {{$json.subject}}",
            promptType: "define",
          },
        },
        {
          name: "Google Vertex Chat Model",
          type: "@n8n/n8n-nodes-langchain.lmChatGoogleVertex",
          parameters: { projectId: { value: "local-project" } },
        },
      ],
      connections: {
        Trigger: {
          main: [[{ node: "Summarize", type: "main", index: 0 }]],
        },
        "Google Vertex Chat Model": {
          ai_languageModel: [
            [{ node: "Summarize", type: "ai_languageModel", index: 0 }],
          ],
        },
      },
    });
    const integrationRunner = await EmulatorIntegrationRunner.create(["gcp"]);
    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ subject: "release evidence" }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
      integrationRunner,
    });
    expect(result.status).toBe("success");
    expect(result.nodeOutputs.Summarize?.[0]?.json).toMatchObject({
      prompt: "Summarize release evidence",
      finishReason: "STOP",
    });
    expect(result.effects[0]).toMatchObject({
      nodeName: "Google Vertex Chat Model",
      operation: "vertex.models.generateContent",
      verified: true,
    });
  });

  test("pinData bypasses the real executor", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Call API",
          type: "n8n-nodes-base.httpRequest",
          parameters: { method: "GET", url: "https://example.com" },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Call API", type: "main", index: 0 }]] },
      },
      pinData: { "Call API": [{ pinned: true }] },
    });

    const result = await runWorkflow(workflow, {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");
    expect(result.trace.find((t) => t.nodeName === "Call API")?.status).toBe(
      "pinned",
    );
    expect(result.nodeOutputs["Call API"]?.[0]?.json).toEqual({ pinned: true });
  });

  test("stickyNote is excluded from execution entirely, even with no connections", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Note",
          type: "n8n-nodes-base.stickyNote",
          parameters: { content: "hi" },
        },
      ],
      connections: {},
    });

    const result = await runWorkflow(workflow, {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");
    expect(result.trace.find((t) => t.nodeName === "Note")?.status).toBe(
      "skipped_annotation",
    );
    expect(result.pendingMocks).toEqual([]);
  });

  test("an unmodeled trigger-type node uses --input directly instead of requesting a mock", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "On Slack Event",
          type: "n8n-nodes-base.slackTrigger",
          parameters: {},
        },
      ],
      connections: {},
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ text: "hello" }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");
    expect(result.nodeOutputs["On Slack Event"]?.[0]?.json).toEqual({
      text: "hello",
    });
  });

  test("Aggregate collects a field across items into a single array item", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Agg",
          type: "n8n-nodes-base.aggregate",
          parameters: {
            fieldsToAggregate: {
              fieldToAggregate: [{ fieldToAggregate: "id" }],
            },
          },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Agg", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ id: 1 }, { id: 2 }, { id: 3 }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.nodeOutputs.Agg).toHaveLength(1);
    expect(result.nodeOutputs.Agg?.[0]?.json).toEqual({ id: [1, 2, 3] });
  });

  test("Limit keeps only the last N items when keep=lastItems", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Lim",
          type: "n8n-nodes-base.limit",
          parameters: { maxItems: 2, keep: "lastItems" },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Lim", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ n: 1 }, { n: 2 }, { n: 3 }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.nodeOutputs.Lim?.map((i) => i.json.n)).toEqual([2, 3]);
  });

  test("Sort orders items by a field, descending", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Srt",
          type: "n8n-nodes-base.sort",
          parameters: {
            sortFieldsUi: {
              sortField: [{ fieldName: "n", order: "descending" }],
            },
          },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Srt", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ n: 1 }, { n: 3 }, { n: 2 }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.nodeOutputs.Srt?.map((i) => i.json.n)).toEqual([3, 2, 1]);
  });

  test("Split Out expands an array field into multiple items", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Split",
          type: "n8n-nodes-base.splitOut",
          parameters: { fieldToSplitOut: "tags" },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Split", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ tags: ["a", "b", "c"] }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.nodeOutputs.Split?.map((i) => i.json.tags)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("Split In Batches sends all items to the loop output in a single simulated pass", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Loop",
          type: "n8n-nodes-base.splitInBatches",
          parameters: {},
        },
        { id: "3", name: "Done", type: "n8n-nodes-base.noOp", parameters: {} },
        { id: "4", name: "Body", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: {
        Trigger: { main: [[{ node: "Loop", type: "main", index: 0 }]] },
        Loop: {
          main: [
            [{ node: "Done", type: "main", index: 0 }],
            [{ node: "Body", type: "main", index: 0 }],
          ],
        },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ n: 1 }, { n: 2 }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.nodeOutputs.Body).toHaveLength(2);
    // Real n8n skips a node entirely when all its inputs deliver zero items.
    expect(result.nodeOutputs.Done).toBeUndefined();
    expect(result.trace.find((t) => t.nodeName === "Done")?.status).toBe(
      "skipped_no_data",
    );
  });

  test("Respond to Webhook passes items through unchanged", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Respond",
          type: "n8n-nodes-base.respondToWebhook",
          parameters: { respondWith: "json" },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Respond", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ ok: true }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.nodeOutputs.Respond?.[0]?.json).toEqual({ ok: true });
  });

  test("multiple start nodes require an explicit --start-node (needs_start_node)", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Manual",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "SubWorkflow",
          type: "n8n-nodes-base.executeWorkflowTrigger",
          parameters: {},
        },
      ],
      connections: {},
    });

    const result = await runWorkflow(workflow, {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("needs_start_node");
    expect(result.startNodeCandidates?.map((c) => c.name).sort()).toEqual([
      "Manual",
      "SubWorkflow",
    ]);
  });

  test("an explicit startNode activates only that trigger; the other is skipped, not executed", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Manual",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "SubWorkflow",
          type: "n8n-nodes-base.executeWorkflowTrigger",
          parameters: {},
        },
        {
          id: "3",
          name: "Set",
          type: "n8n-nodes-base.set",
          parameters: { fields: [{ name: "x", value: 1 }] },
        },
      ],
      connections: {
        Manual: { main: [[{ node: "Set", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
      startNode: "Manual",
    });

    expect(result.status).toBe("success");
    expect(result.trace.find((t) => t.nodeName === "SubWorkflow")?.status).toBe(
      "skipped_alternate_trigger",
    );
    expect(result.nodeOutputs.Set).toHaveLength(1);
  });

  test("a node fed by two sources into the same slot fires on the first delivery (OR, not AND)", async () => {
    // Models a common no-Merge reconvergence: two branches both feed slot 0 of
    // the same downstream node. Real n8n does not wait for every source.
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Check",
          type: "n8n-nodes-base.if",
          parameters: { condition: "={{$json.ok}}" },
        },
        { id: "3", name: "PathA", type: "n8n-nodes-base.noOp", parameters: {} },
        { id: "4", name: "PathB", type: "n8n-nodes-base.noOp", parameters: {} },
        { id: "5", name: "Join", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: {
        Trigger: { main: [[{ node: "Check", type: "main", index: 0 }]] },
        Check: {
          main: [
            [{ node: "PathA", type: "main", index: 0 }],
            [{ node: "PathB", type: "main", index: 0 }],
          ],
        },
        PathA: { main: [[{ node: "Join", type: "main", index: 0 }]] },
        PathB: { main: [[{ node: "Join", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ ok: true }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");
    expect(result.nodeOutputs.Join).toHaveLength(1);
  });

  test("Date & Time formats and adds to dates via Luxon", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Format",
          type: "n8n-nodes-base.dateTime",
          parameters: {
            operation: "formatDate",
            date: "2026-01-28T00:00:00.000Z",
            format: "yyyy-MM-dd",
          },
        },
        {
          id: "3",
          name: "Add",
          type: "n8n-nodes-base.dateTime",
          parameters: {
            operation: "addToDate",
            magnitude: "2026-01-28T00:00:00.000Z",
            timeUnit: "days",
            duration: 7,
            outputFieldName: "later",
          },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Format", type: "main", index: 0 }]] },
        Format: { main: [[{ node: "Add", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
    });
    expect(result.trace.find((t) => t.nodeName === "Format")?.status).toBe(
      "success",
    );
    expect(result.nodeOutputs.Format?.[0]?.json.formattedDate).toBe(
      "2026-01-28",
    );
    expect(result.nodeOutputs.Add?.[0]?.json.later).toBe(
      "2026-02-04T00:00:00.000+00:00",
    );
  });

  test("Date & Time's getCurrentDate respects --now instead of the real wall clock", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Now",
          type: "n8n-nodes-base.dateTime",
          parameters: { operation: "getCurrentDate" },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Now", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
      now: new Date("2020-06-15T00:00:00.000Z"),
    });

    expect(result.nodeOutputs.Now?.[0]?.json.currentDate).toBe(
      "2020-06-15T00:00:00.000+00:00",
    );
  });

  test("Remove Duplicates dedupes within the current batch by all fields", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Dedupe",
          type: "n8n-nodes-base.removeDuplicates",
          parameters: {},
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Dedupe", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ id: 1 }, { id: 2 }, { id: 1 }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.nodeOutputs.Dedupe).toHaveLength(2);
  });

  test("Summarize groups by a field and aggregates within each group", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Sum",
          type: "n8n-nodes-base.summarize",
          parameters: {
            fieldsToSummarize: {
              values: [{ aggregation: "sum", field: "amount" }],
            },
            fieldsToSplitBy: "category",
          },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Sum", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([
        { category: "a", amount: 10 },
        { category: "a", amount: 5 },
        { category: "b", amount: 2 },
      ]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    const rows = result.nodeOutputs.Sum?.map((i) => i.json).sort((a, b) =>
      String(a.category).localeCompare(String(b.category)),
    );
    // Real n8n prefixes the output key with the aggregation's display name: "sum_amount", not "amount".
    expect(rows).toEqual([
      { category: "a", sum_amount: 15 },
      { category: "b", sum_amount: 2 },
    ]);
  });

  test("Summarize concatenate uses the literal separateBy character (real n8n option values, not symbolic names)", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Sum",
          type: "n8n-nodes-base.summarize",
          parameters: {
            fieldsToSummarize: {
              values: [
                { aggregation: "concatenate", field: "name", separateBy: ", " },
              ],
            },
          },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Sum", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: toItems([{ name: "a" }, { name: "b" }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.nodeOutputs.Sum?.[0]?.json.concatenated_name).toBe("a, b");
  });

  test("Stop and Error always fails with the configured message", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Stop",
          type: "n8n-nodes-base.stopAndError",
          parameters: { errorType: "errorMessage", errorMessage: "boom" },
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Stop", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
    });
    expect(result.status).toBe("error");
    expect(result.errors[0]).toContain("boom");
  });

  test("a LangChain-style node wired only via a non-main connection type isn't treated as a start node", async () => {
    // "Chat Model" nodes feed their parent Agent through an "ai_languageModel"
    // connection, not "main" - they have zero incoming edges of any type but
    // must not be mistaken for an unconnected trigger.
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        {
          id: "2",
          name: "Agent",
          type: "@n8n/n8n-nodes-langchain.agent",
          parameters: {},
        },
        {
          id: "3",
          name: "Chat Model",
          type: "@n8n/n8n-nodes-langchain.lmChatOpenAi",
          parameters: {},
        },
      ],
      connections: {
        Trigger: { main: [[{ node: "Agent", type: "main", index: 0 }]] },
        "Chat Model": {
          ai_languageModel: [
            [{ node: "Agent", type: "ai_languageModel", index: 0 }],
          ],
        },
      },
    });

    const result = await runWorkflow(workflow, {
      hasExplicitInput: false,
      mocks: createMockLookup({ Agent: { output: "ok" } }),
      registry,
    });

    expect(result.status).toBe("success");
    expect(result.trace.find((t) => t.nodeName === "Chat Model")?.status).toBe(
      "skipped_non_main_only",
    );
  });

  test("an explicit zero-item --input still fires the trigger itself (only downstream nodes get skipped_no_data)", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Trigger",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
        { id: "2", name: "Next", type: "n8n-nodes-base.noOp", parameters: {} },
      ],
      connections: {
        Trigger: { main: [[{ node: "Next", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(workflow, {
      initialInput: [],
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("success");
    expect(result.trace.find((t) => t.nodeName === "Trigger")?.status).toBe(
      "success",
    );
    expect(result.trace.find((t) => t.nodeName === "Next")?.status).toBe(
      "skipped_no_data",
    );
  });

  test("a workflow with no runnable entry point reports needs_start_node instead of a false success", async () => {
    const workflow = wf({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "Note",
          type: "n8n-nodes-base.stickyNote",
          parameters: {},
        },
      ],
      connections: {},
    });

    const result = await runWorkflow(workflow, {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("needs_start_node");
    expect(result.startNodeCandidates).toEqual([]);
  });
});
