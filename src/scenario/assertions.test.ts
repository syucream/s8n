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
  };
}

describe("evaluateScenarioAssertions", () => {
  test("evaluates coverage, effects, output counts, and JSON Pointer output checks", () => {
    const evaluated = evaluateScenarioAssertions(workflow, result(), {
      status: "success",
      minimumCoverage: 2 / 3,
      requiredNodes: ["Start", "Transform"],
      forbiddenNodes: ["Unreached"],
      pendingMockCount: 0,
      verifiedEffects: true,
      subExecutionCount: 1,
      nodeOutputItemCounts: { Transform: 1 },
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
      requiredNodes: ["Unreached"],
      forbiddenNodes: ["Transform"],
      pendingMockCount: 1,
      verifiedEffects: false,
      subExecutionCount: 2,
      nodeOutputItemCounts: { Transform: 2 },
      nodeOutputs: [
        { node: "Transform", pointer: "/json/result/count", equals: 3 },
      ],
    });

    expect(evaluated.ok).toBe(false);
    expect(evaluated.failures.map((failure) => failure.assertion)).toEqual([
      "status",
      "minimumCoverage",
      "requiredNodes",
      "forbiddenNodes",
      "pendingMockCount",
      "verifiedEffects",
      "subExecutionCount",
      "nodeOutputItemCounts",
      "nodeOutputs",
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
});
