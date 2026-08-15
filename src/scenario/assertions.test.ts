import { describe, expect, test } from "bun:test";
import type { RunResult } from "../engine/execute.ts";
import { workflowSchema } from "../schema/workflow.ts";
import { evaluateScenarioAssertions } from "./assertions.ts";

const workflow = workflowSchema.parse({
  name: "Synthetic assertions",
  nodes: [
    { name: "Start", type: "n8n-nodes-base.manualTrigger" },
    { name: "Transform", type: "n8n-nodes-base.set" },
    { name: "Unreached", type: "n8n-nodes-base.set" },
    { name: "Note", type: "n8n-nodes-base.stickyNote" },
    { name: "AI Model", type: "@n8n/n8n-nodes-langchain.lmChatOpenAi" },
  ],
  connections: {
    Start: {
      main: [[{ node: "Transform", type: "main", index: 0 }]],
    },
    Transform: {
      main: [[{ node: "Unreached", type: "main", index: 0 }]],
    },
    "AI Model": {
      ai_languageModel: [
        [{ node: "Transform", type: "ai_languageModel", index: 0 }],
      ],
    },
  },
  settings: {},
});

function result(): RunResult {
  return {
    status: "success",
    workflowName: workflow.name,
    trace: [
      {
        nodeName: "Start",
        nodeType: "n8n-nodes-base.manualTrigger",
        status: "success",
        inputItemCounts: [],
      },
      {
        nodeName: "Transform",
        nodeType: "n8n-nodes-base.set",
        status: "success",
        inputItemCounts: [1],
        outputItemLineage: [["input:0"]],
        resolvedRequests: [
          {
            method: "PATCH",
            url: "https://example.com/resources/resource-1",
            body: { state: "ready" },
          },
        ],
      },
      {
        nodeName: "Unreached",
        nodeType: "n8n-nodes-base.set",
        status: "skipped_no_data",
        inputItemCounts: [0],
      },
      {
        nodeName: "Note",
        nodeType: "n8n-nodes-base.stickyNote",
        status: "unreached",
        inputItemCounts: [],
      },
      {
        nodeName: "AI Model",
        nodeType: "@n8n/n8n-nodes-langchain.lmChatOpenAi",
        status: "unreached",
        inputItemCounts: [],
      },
    ],
    nodeOutputs: {
      Transform: [
        {
          json: {
            result: { count: 2 },
            absent: undefined,
            "a/b~c": "escaped",
          },
        },
      ],
    },
    pendingMocks: [],
    errors: [],
    effects: [
      {
        nodeName: "Transform",
        nodeType: "n8n-nodes-base.set",
        service: "local",
        operation: "write",
        request: {},
        response: {},
        observation: {},
        verified: true,
      },
    ],
    subExecutions: [
      {
        callNodeName: "Call child",
        reference: "child",
        workflowName: "Child",
        status: "success",
        traceStatusCounts: { success: 1 },
        pendingMockCount: 0,
        errors: [],
        nested: [],
      },
    ],
    edgeCoverage: [
      {
        sourceNode: "Start",
        sourceOutput: 0,
        destinationNode: "Transform",
        destinationInput: 0,
        deliveryCount: 1,
        itemCount: 1,
        covered: true,
      },
      {
        sourceNode: "Transform",
        sourceOutput: 0,
        destinationNode: "Unreached",
        destinationInput: 0,
        deliveryCount: 0,
        itemCount: 0,
        covered: false,
      },
    ],
    branchCoverage: 0.5,
  };
}

describe("evaluateScenarioAssertions", () => {
  test("evaluates coverage, effects, output counts, and JSON Pointer output checks", () => {
    const evaluated = evaluateScenarioAssertions(workflow, result(), {
      status: "success",
      minimumCoverage: 2 / 3,
      minimumBranchCoverage: 0.5,
      requiredNodes: ["Start", "Transform"],
      forbiddenNodes: ["Unreached"],
      requiredEdges: [
        {
          sourceNode: "Start",
          sourceOutput: 0,
          destinationNode: "Transform",
          destinationInput: 0,
        },
      ],
      forbiddenEdges: [
        {
          sourceNode: "Transform",
          sourceOutput: 0,
          destinationNode: "Unreached",
          destinationInput: 0,
        },
      ],
      pendingMockCount: 0,
      verifiedEffects: true,
      subExecutionCount: 1,
      nodeOutputItemCounts: { Transform: 1 },
      nodeOutputCardinality: [{ node: "Transform", exact: 1 }],
      nodeOutputs: [
        {
          node: "Transform",
          pointer: "/json/result/count",
          exists: true,
          equals: 2,
        },
        { node: "Transform", pointer: "/json/absent", equals: undefined },
        {
          node: "Transform",
          pointer: "/json/a~1b~0c",
          equals: "escaped",
        },
      ],
      nodeOutputLineage: [
        { node: "Transform", lineage: ["input:0"] },
        { node: "Transform", lineageContains: ["input:0"] },
      ],
      nodeRequests: [
        {
          node: "Transform",
          pointer: "/body/state",
          exists: true,
          equals: "ready",
        },
        {
          node: "Transform",
          pointer: "/body/forbidden",
          exists: false,
        },
      ],
    });

    expect(evaluated).toMatchObject({
      ok: true,
      coverage: {
        executableNodes: ["Start", "Transform", "Unreached"],
        executedNodes: ["Start", "Transform"],
        ratio: 2 / 3,
        uncoveredNodes: [{ node: "Unreached", reason: "skipped_no_data" }],
      },
      failures: [],
    });
  });

  test("returns structured failures instead of throwing", () => {
    const evaluated = evaluateScenarioAssertions(workflow, result(), {
      status: "error",
      minimumCoverage: 1,
      minimumBranchCoverage: 1,
      requiredNodes: ["Unreached"],
      forbiddenNodes: ["Transform"],
      requiredEdges: [
        {
          sourceNode: "Transform",
          sourceOutput: 0,
          destinationNode: "Unreached",
          destinationInput: 0,
        },
      ],
      forbiddenEdges: [
        {
          sourceNode: "Start",
          sourceOutput: 0,
          destinationNode: "Transform",
          destinationInput: 0,
        },
      ],
      pendingMockCount: 1,
      verifiedEffects: false,
      subExecutionCount: 2,
      nodeOutputItemCounts: { Transform: 2 },
      nodeOutputCardinality: [{ node: "Transform", exact: 2 }],
      nodeOutputs: [
        { node: "Transform", pointer: "/json/result/count", equals: 3 },
      ],
      nodeOutputLineage: [{ node: "Transform", lineageContains: ["input:1"] }],
      nodeRequests: [
        { node: "Transform", pointer: "/body/state", equals: "blocked" },
      ],
    });

    expect(evaluated.ok).toBe(false);
    expect(evaluated.failures.map((failure) => failure.assertion)).toEqual([
      "status",
      "minimumCoverage",
      "minimumBranchCoverage",
      "requiredNodes",
      "forbiddenNodes",
      "requiredEdges",
      "forbiddenEdges",
      "pendingMockCount",
      "verifiedEffects",
      "subExecutionCount",
      "nodeOutputItemCounts",
      "nodeOutputs",
      "nodeRequests",
      "nodeOutputCardinality",
      "nodeOutputLineage",
    ]);
  });

  test("does not treat an empty effect list as verified", () => {
    const noEffects = result();
    noEffects.effects = [];

    const evaluated = evaluateScenarioAssertions(workflow, noEffects, {
      verifiedEffects: true,
    });

    expect(evaluated).toMatchObject({ ok: false });
    expect(evaluated.failures[0]?.assertion).toBe("verifiedEffects");
  });

  test("does not echo request assertion values in failures", () => {
    const evaluated = evaluateScenarioAssertions(workflow, result(), {
      nodeRequests: [
        {
          node: "Transform",
          pointer: "/body/state",
          equals: "private-expected-sentinel",
        },
      ],
    });
    expect(evaluated.ok).toBe(false);
    expect(JSON.stringify(evaluated.failures)).not.toContain(
      "private-expected-sentinel",
    );
    expect(JSON.stringify(evaluated.failures)).not.toContain("ready");
  });

  test("reports each violated output cardinality bound and missing lineage", () => {
    const evaluated = evaluateScenarioAssertions(workflow, result(), {
      nodeOutputCardinality: [
        { node: "Transform", exact: 2 },
        { node: "Transform", min: 2 },
        { node: "Transform", max: 0 },
      ],
      nodeOutputLineage: [
        { node: "Transform", lineage: ["input:1"] },
        { node: "Missing output", lineageContains: ["input:0"] },
      ],
    });

    expect(evaluated.failures.map((failure) => failure.assertion)).toEqual([
      "nodeOutputCardinality",
      "nodeOutputCardinality",
      "nodeOutputCardinality",
      "nodeOutputLineage",
      "nodeOutputLineage",
    ]);
  });

  test("evaluates string operators against pointed-to output values", () => {
    const withMessage = result();
    withMessage.nodeOutputs.Transform = [
      { json: { message: "*Approval request*\nFacility: Example Clinic" } },
    ];

    const passing = evaluateScenarioAssertions(workflow, withMessage, {
      nodeOutputs: [
        {
          node: "Transform",
          pointer: "/json/message",
          matches: "^\\*Approval request\\*",
          notMatches: "undefined|\\{\\{|\\$\\{",
          occurrences: { substring: "Facility", atMost: 1 },
        },
      ],
    });
    expect(passing.ok).toBe(true);

    const failing = evaluateScenarioAssertions(workflow, withMessage, {
      nodeOutputs: [
        {
          node: "Transform",
          pointer: "/json/message",
          matches: "^Nope",
          notMatches: "Approval",
          occurrences: { substring: "Facility", atLeast: 2 },
        },
      ],
    });
    expect(failing.ok).toBe(false);
    expect(failing.failures).toHaveLength(3);
    expect(
      failing.failures.every((failure) => failure.assertion === "nodeOutputs"),
    ).toBe(true);
  });

  test("string operators require a string value", () => {
    const evaluated = evaluateScenarioAssertions(workflow, result(), {
      nodeOutputs: [
        { node: "Transform", pointer: "/json/result/count", matches: "2" },
      ],
    });
    expect(evaluated.ok).toBe(false);
    expect(evaluated.failures[0]?.message).toContain("requires a string");
  });

  test("asserts the payload delivered to a called child's entry trigger", () => {
    const withChildInput = result();
    const baseSub = withChildInput.subExecutions[0];
    if (baseSub === undefined) throw new Error("expected a sub-execution");
    withChildInput.subExecutions[0] = {
      ...baseSub,
      entryItems: [
        { json: { requestId: "req-1", facility: "Example Clinic" } },
      ],
      entryItemCount: 1,
    };

    const passing = evaluateScenarioAssertions(workflow, withChildInput, {
      subExecutionInputs: [
        {
          callNode: "Call child",
          pointer: "/json/requestId",
          exists: true,
          equals: "req-1",
          matches: "^req-",
        },
        {
          callNode: "Call child",
          pointer: "/json/facility",
          occurrences: { substring: "Clinic", atLeast: 1 },
        },
      ],
    });
    expect(passing.ok).toBe(true);

    const failing = evaluateScenarioAssertions(workflow, withChildInput, {
      subExecutionInputs: [
        {
          callNode: "Call child",
          pointer: "/json/requestId",
          equals: "req-9",
        },
        { callNode: "Unknown caller", pointer: "/json/x", exists: true },
      ],
    });
    expect(failing.ok).toBe(false);
    expect(failing.failures.map((failure) => failure.assertion)).toEqual([
      "subExecutionInputs",
      "subExecutionInputs",
    ]);
  });
});
