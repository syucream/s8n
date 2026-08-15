import { describe, expect, test } from "bun:test";
import type { IntegrationRunner } from "../integrations/types.ts";
import { createMockLookup, emptyMockLookup } from "../mock/provider.ts";
import { createDefaultRegistry } from "../nodes/registry.ts";
import { toItems } from "../schema/item.ts";
import type { Workflow } from "../schema/workflow.ts";
import { validateWorkflow } from "../schema/workflow.ts";
import { runWorkflow } from "./execute.ts";

function workflow(raw: unknown): Workflow {
  const result = validateWorkflow(raw);
  if (!result.valid || !result.workflow) {
    throw new Error(JSON.stringify(result.issues));
  }
  return result.workflow;
}

function trigger(name = "Called") {
  return {
    name,
    type: "n8n-nodes-base.executeWorkflowTrigger",
    parameters: {},
  };
}

function call(name: string, reference: string) {
  return {
    name,
    type: "n8n-nodes-base.executeWorkflow",
    parameters: {
      workflowId: { value: reference, mode: "list" },
      options: {},
    },
  };
}

function parentCalling(reference: string): Workflow {
  return workflow({
    name: "Parent",
    nodes: [
      {
        name: "Start",
        type: "n8n-nodes-base.manualTrigger",
        parameters: {},
      },
      call("Call Child", reference),
    ],
    connections: {
      Start: {
        main: [[{ node: "Call Child", type: "main", index: 0 }]],
      },
    },
  });
}

const registry = createDefaultRegistry();

describe("mapped sub-workflow execution", () => {
  test("maps each parent item, runs the child trigger, returns terminal output, and aggregates effects", async () => {
    const parent = parentCalling("child-ref");
    const callNode = parent.nodes.find((node) => node.name === "Call Child");
    if (!callNode) throw new Error("missing call node");
    callNode.parameters.workflowInputs = {
      mappingMode: "defineBelow",
      value: {
        greeting: "=Hello {{$json.name}}",
        count: "={{$json.count}}",
      },
      attemptToConvertTypes: false,
      convertFieldsToString: true,
    };

    const child = workflow({
      name: "Child",
      nodes: [
        trigger(),
        {
          name: "Record Locally",
          type: "synthetic.localIntegration",
          parameters: {},
        },
      ],
      connections: {
        Called: {
          main: [[{ node: "Record Locally", type: "main", index: 0 }]],
        },
      },
    });
    const integrationRunner: IntegrationRunner = {
      async execute(node, _parameters, inputItem) {
        if (node.type !== "synthetic.localIntegration") return undefined;
        return {
          output: inputItem?.json,
          effect: {
            nodeName: node.name,
            nodeType: node.type,
            service: "synthetic",
            operation: "record",
            request: inputItem?.json,
            response: inputItem?.json,
            observation: inputItem?.json,
            verified: true,
          },
        };
      },
      async close() {},
    };

    const result = await runWorkflow(parent, {
      initialInput: toItems([
        { name: "Ada", count: 2 },
        { name: "Lin", count: 3 },
      ]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
      integrationRunner,
      workflowMap: new Map([["child-ref", child]]),
    });

    expect(result.status).toBe("success");
    expect(result.nodeOutputs["Call Child"]?.map((item) => item.json)).toEqual([
      { greeting: "Hello Ada", count: "2" },
      { greeting: "Hello Lin", count: "3" },
    ]);
    expect(result.effects).toHaveLength(2);
    expect(result.effects.every((effect) => effect.verified)).toBe(true);
    expect(result.subExecutions).toEqual([
      {
        callNodeName: "Call Child",
        reference: "child-ref",
        workflowName: "Child",
        status: "success",
        traceStatusCounts: { success: 2 },
        pendingMockCount: 0,
        errors: [],
        nested: [],
        entryItems: [
          {
            json: { greeting: "Hello Ada", count: "2" },
            pairedItem: { item: 0 },
          },
          {
            json: { greeting: "Hello Lin", count: "3" },
            pairedItem: { item: 1 },
          },
        ],
      },
    ]);
  });

  test("keeps the existing generic mock behavior when no workflow map is provided", async () => {
    const result = await runWorkflow(parentCalling("child-ref"), {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
    });

    expect(result.status).toBe("needs_mock");
    expect(result.pendingMocks[0]?.mockKey).toBe("Call Child");
  });

  test("accepts a string workflowId and passes parent items through when no mapping is configured", async () => {
    const parent = parentCalling("unused");
    const callNode = parent.nodes.find((node) => node.name === "Call Child");
    if (!callNode) throw new Error("missing call node");
    callNode.parameters.workflowId = "child-ref";
    const child = workflow({ name: "Passthrough child", nodes: [trigger()] });

    const result = await runWorkflow(parent, {
      initialInput: toItems([{ passthrough: true }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
      workflowMap: new Map([["child-ref", child]]),
    });

    expect(result.status).toBe("success");
    expect(result.nodeOutputs["Call Child"]?.[0]?.json).toEqual({
      passthrough: true,
    });
  });

  test("scopes a child pending mock to the call node and accepts that key on rerun", async () => {
    const child = workflow({
      name: "Child needing mock",
      nodes: [
        trigger(),
        {
          name: "Fetch Data",
          type: "n8n-nodes-base.httpRequest",
          parameters: { url: "https://example.invalid/synthetic" },
        },
      ],
      connections: {
        Called: { main: [[{ node: "Fetch Data", type: "main", index: 0 }]] },
      },
    });
    const workflowMap = new Map([["child-ref", child]]);

    const pending = await runWorkflow(parentCalling("child-ref"), {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
      workflowMap,
    });

    expect(pending.status).toBe("needs_mock");
    expect(pending.pendingMocks[0]?.mockKey).toBe("Call Child::Fetch Data");
    expect(pending.subExecutions[0]).toMatchObject({
      callNodeName: "Call Child",
      reference: "child-ref",
      workflowName: "Child needing mock",
      status: "needs_mock",
      traceStatusCounts: { success: 1, waiting_mock: 1 },
      pendingMockCount: 1,
      nested: [],
    });

    const completed = await runWorkflow(parentCalling("child-ref"), {
      hasExplicitInput: false,
      mocks: createMockLookup({
        "Call Child::Fetch Data": { received: true },
      }),
      registry,
      workflowMap,
    });
    expect(completed.status).toBe("success");
    expect(completed.nodeOutputs["Call Child"]?.[0]?.json).toEqual({
      received: true,
    });
  });

  test("returns a structured run error for an unresolved explicit reference", async () => {
    const result = await runWorkflow(parentCalling("missing-ref"), {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
      workflowMap: new Map(),
    });

    expect(result.status).toBe("error");
    expect(result.pendingMocks).toEqual([]);
    expect(result.errors[0]).toContain(
      'Workflow reference "missing-ref" is not present',
    );
  });

  test("returns explicit errors for unsupported execution modes", async () => {
    const parent = parentCalling("child-ref");
    const callNode = parent.nodes.find((node) => node.name === "Call Child");
    if (!callNode) throw new Error("missing call node");
    callNode.parameters.mode = "each";
    const child = workflow({ name: "Child", nodes: [trigger()] });

    const result = await runWorkflow(parent, {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
      workflowMap: new Map([["child-ref", child]]),
    });

    expect(result.status).toBe("error");
    expect(result.errors[0]).toContain(
      'Unsupported Execute Workflow mode "each"',
    );
  });

  test("rejects asynchronous sub-workflow execution", async () => {
    const parent = parentCalling("child-ref");
    const callNode = parent.nodes.find((node) => node.name === "Call Child");
    if (!callNode) throw new Error("missing call node");
    callNode.parameters.options = { waitForSubWorkflow: false };
    const child = workflow({ name: "Child", nodes: [trigger()] });

    const result = await runWorkflow(parent, {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
      workflowMap: new Map([["child-ref", child]]),
    });

    expect(result.status).toBe("error");
    expect(result.errors[0]).toContain(
      "mapped execution requires waitForSubWorkflow to be true",
    );
  });

  test("requires exactly one Execute Workflow Trigger in a mapped child", async () => {
    const child = workflow({
      name: "Ambiguous child",
      nodes: [trigger("Called One"), trigger("Called Two")],
    });

    const result = await runWorkflow(parentCalling("child-ref"), {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
      workflowMap: new Map([["child-ref", child]]),
    });

    expect(result.status).toBe("error");
    expect(result.errors[0]).toContain(
      "must contain exactly one Execute Workflow Trigger; found 2",
    );
  });

  test("detects a reference cycle before recursively executing it", async () => {
    const childA = workflow({
      name: "Child A",
      nodes: [trigger(), call("Call B", "b")],
      connections: {
        Called: { main: [[{ node: "Call B", type: "main", index: 0 }]] },
      },
    });
    const childB = workflow({
      name: "Child B",
      nodes: [trigger(), call("Call A", "a")],
      connections: {
        Called: { main: [[{ node: "Call A", type: "main", index: 0 }]] },
      },
    });

    const result = await runWorkflow(parentCalling("a"), {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
      workflowMap: new Map([
        ["a", childA],
        ["b", childB],
      ]),
    });

    expect(result.status).toBe("error");
    expect(result.errors.join(" ")).toContain(
      "Sub-workflow cycle detected: a -> b -> a",
    );
    expect(result.subExecutions[0]).toMatchObject({
      callNodeName: "Call Child",
      reference: "a",
      workflowName: "Child A",
      status: "error",
    });
    expect(result.subExecutions[0]?.nested[0]).toMatchObject({
      callNodeName: "Call B",
      reference: "b",
      workflowName: "Child B",
      status: "error",
    });
  });

  test("stops a non-cyclic chain at the configured depth limit", async () => {
    const leaf = workflow({ name: "Leaf", nodes: [trigger()] });
    const middle = workflow({
      name: "Middle",
      nodes: [trigger(), call("Call Leaf", "leaf")],
      connections: {
        Called: {
          main: [[{ node: "Call Leaf", type: "main", index: 0 }]],
        },
      },
    });
    const first = workflow({
      name: "First",
      nodes: [trigger(), call("Call Middle", "middle")],
      connections: {
        Called: {
          main: [[{ node: "Call Middle", type: "main", index: 0 }]],
        },
      },
    });

    const result = await runWorkflow(parentCalling("first"), {
      hasExplicitInput: false,
      mocks: emptyMockLookup,
      registry,
      workflowMap: new Map([
        ["first", first],
        ["middle", middle],
        ["leaf", leaf],
      ]),
      subWorkflowDepthLimit: 2,
    });

    expect(result.status).toBe("error");
    expect(result.errors.join(" ")).toContain(
      "Sub-workflow depth limit (2) exceeded: first -> middle -> leaf",
    );
  });

  test("a waiting child without a resume directive reports waiting and halts the parent", async () => {
    const parent = parentCalling("child-ref");
    const callNode = parent.nodes.find((node) => node.name === "Call Child");
    if (!callNode) throw new Error("missing call node");
    callNode.parameters.workflowInputs = {
      mappingMode: "defineBelow",
      value: { requestId: "={{$json.id}}" },
    };

    const child = workflow({
      name: "Approval child",
      nodes: [
        trigger(),
        {
          name: "Wait for approval",
          type: "n8n-nodes-base.wait",
          parameters: { resume: "onWebhookCall" },
        },
        {
          name: "Apply",
          type: "n8n-nodes-base.set",
          parameters: { fields: [{ name: "applied", value: "=true" }] },
        },
      ],
      connections: {
        Called: {
          main: [
            [
              {
                node: "Wait for approval",
                type: "main",
                index: 0,
              },
            ],
          ],
        },
        "Wait for approval": {
          main: [[{ node: "Apply", type: "main", index: 0 }]],
        },
      },
    });

    const result = await runWorkflow(parent, {
      initialInput: toItems([{ id: "req-1" }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
      workflowMap: new Map([["child-ref", child]]),
    });

    expect(result.status).toBe("waiting");
    expect(result.subExecutions[0]?.status).toBe("waiting");
    expect(result.subExecutions[0]?.traceStatusCounts.waiting).toBe(1);
    // The waiting branch halts: no terminal output propagates to the parent.
    expect(result.nodeOutputs["Call Child"]).toBeUndefined();
  });

  test("a scenario resume directive resolves the waiting child and continues the flow", async () => {
    const parent = parentCalling("child-ref");
    const callNode = parent.nodes.find((node) => node.name === "Call Child");
    if (!callNode) throw new Error("missing call node");
    callNode.parameters.workflowInputs = {
      mappingMode: "defineBelow",
      value: { requestId: "={{$json.id}}" },
    };

    const child = workflow({
      name: "Approval child",
      nodes: [
        trigger(),
        {
          name: "Wait for approval",
          type: "n8n-nodes-base.wait",
          parameters: { resume: "onWebhookCall" },
        },
        {
          name: "Apply",
          type: "n8n-nodes-base.set",
          parameters: {
            assignments: {
              assignments: [{ name: "approved", value: "={{$json.approved}}" }],
            },
          },
        },
      ],
      connections: {
        Called: {
          main: [
            [
              {
                node: "Wait for approval",
                type: "main",
                index: 0,
              },
            ],
          ],
        },
        "Wait for approval": {
          main: [[{ node: "Apply", type: "main", index: 0 }]],
        },
      },
    });

    const result = await runWorkflow(parent, {
      initialInput: toItems([{ id: "req-1" }]),
      hasExplicitInput: true,
      mocks: emptyMockLookup,
      registry,
      workflowMap: new Map([["child-ref", child]]),
      resumeDirectives: new Map([
        ["Wait for approval", { data: { approved: true } }],
      ]),
    });

    expect(result.status).toBe("success");
    expect(result.subExecutions[0]?.status).toBe("success");
    // Apply is the child's terminal node, so its output surfaces as the
    // parent's "Call Child" output.
    expect(result.nodeOutputs["Call Child"]?.map((item) => item.json)).toEqual([
      { approved: true },
    ]);
    expect(result.subExecutions[0]?.entryItems).toEqual([
      { json: { requestId: "req-1" }, pairedItem: { item: 0 } },
    ]);
  });
});
