import { describe, expect, test } from "bun:test";
import { buildExpressionScope } from "../../expression/context.ts";
import { toItems } from "../../schema/item.ts";
import { validateWorkflow } from "../../schema/workflow.ts";
import type { RuntimeContext } from "../types.ts";
import { codeExecutor } from "./code.ts";

function runtimeFor(): RuntimeContext {
  return {
    workflowName: "t",
    nodeOutputs: new Map(),
    mocks: { get: () => undefined },
    suggestedFields: [],
    hasExplicitInput: true,
    workflowStaticData: new Map(),
  };
}

function node(parameters: Record<string, unknown>) {
  const result = validateWorkflow({
    name: "t",
    nodes: [{ id: "1", name: "Code", type: "n8n-nodes-base.code", parameters }],
    connections: {},
  });
  if (!result.valid || !result.workflow) throw new Error("fixture invalid");
  const [firstNode] = result.workflow.nodes;
  if (!firstNode) throw new Error("fixture invalid: no nodes");
  return firstNode;
}

describe("codeExecutor", () => {
  test("runOnceForAllItems maps over `items` and returns a new array", async () => {
    const inputItems = toItems([{ n: 1 }, { n: 2 }]);
    const result = await codeExecutor.execute({
      node: node({
        jsCode: "return items.map(i => ({ json: { doubled: i.json.n * 2 } }));",
      }),
      inputItems,
      inputSlots: [inputItems],
      runtime: runtimeFor(),
      isStartNode: false,
      buildScope: (item, itemIndex, items) =>
        buildExpressionScope({
          currentItem: item,
          itemIndex,
          inputItems: items,
          currentNodeName: "Code",
          workflowName: "t",
          nodeOutputs: new Map(),
        }),
    });
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.output[0]?.map((i) => i.json.doubled)).toEqual([2, 4]);
    }
  });

  test("runOnceForEachItem exposes `item`/`$json` per item", async () => {
    const inputItems = toItems([{ n: 5 }]);
    const result = await codeExecutor.execute({
      node: node({
        mode: "runOnceForEachItem",
        jsCode: "return { json: { squared: $json.n * $json.n } };",
      }),
      inputItems,
      inputSlots: [inputItems],
      runtime: runtimeFor(),
      isStartNode: false,
      buildScope: (item, itemIndex, items) =>
        buildExpressionScope({
          currentItem: item,
          itemIndex,
          inputItems: items,
          currentNodeName: "Code",
          workflowName: "t",
          nodeOutputs: new Map(),
        }),
    });
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.output[0]?.[0]?.json.squared).toBe(25);
    }
  });

  test("a thrown error is reported as a failure result, not an exception", async () => {
    const inputItems = toItems([{}]);
    const result = await codeExecutor.execute({
      node: node({ jsCode: "throw new Error('boom');" }),
      inputItems,
      inputSlots: [inputItems],
      runtime: runtimeFor(),
      isStartNode: false,
      buildScope: (item, itemIndex, items) =>
        buildExpressionScope({
          currentItem: item,
          itemIndex,
          inputItems: items,
          currentNodeName: "Code",
          workflowName: "t",
          nodeOutputs: new Map(),
        }),
    });
    expect(result.status).toBe("error");
  });

  test("$getWorkflowStaticData returns a shared, mutable object within one run", async () => {
    const runtime = runtimeFor();
    const inputItems = toItems([{}]);
    const args = {
      node: node({
        jsCode:
          "const d = $getWorkflowStaticData('global'); d.count = (d.count || 0) + 1; return [{ json: { count: d.count } }];",
      }),
      inputItems,
      inputSlots: [inputItems],
      runtime,
      isStartNode: false,
      buildScope: (
        item: { json: Record<string, unknown> },
        itemIndex: number,
        items: unknown[],
      ) =>
        buildExpressionScope({
          currentItem: item,
          itemIndex,
          inputItems: items as never,
          currentNodeName: "Code",
          workflowName: "t",
          nodeOutputs: new Map(),
        }),
    };

    const first = await codeExecutor.execute(args);
    const second = await codeExecutor.execute(args);

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    if (first.status === "success" && second.status === "success") {
      expect(first.output[0]?.[0]?.json.count).toBe(1);
      expect(second.output[0]?.[0]?.json.count).toBe(2);
    }
  });
});
