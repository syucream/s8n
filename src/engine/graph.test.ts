import { describe, expect, test } from "bun:test";
import { validateWorkflow } from "../schema/workflow.ts";
import { analyzeGraph } from "./graph.ts";

function wf(raw: unknown) {
  const result = validateWorkflow(raw);
  if (!result.valid || !result.workflow)
    throw new Error(JSON.stringify(result.issues));
  return result.workflow;
}

describe("analyzeGraph", () => {
  test("identifies nodes with no incoming connections as start nodes", () => {
    const workflow = wf({
      name: "t",
      nodes: [
        { id: "1", name: "A", type: "x", parameters: {} },
        { id: "2", name: "B", type: "x", parameters: {} },
      ],
      connections: { A: { main: [[{ node: "B", type: "main", index: 0 }]] } },
    });
    const graph = analyzeGraph(workflow);
    expect(graph.startNodes).toEqual(["A"]);
  });

  test("computes required input slots from the highest destination index", () => {
    const workflow = wf({
      name: "t",
      nodes: [
        { id: "1", name: "A", type: "x", parameters: {} },
        { id: "2", name: "B", type: "x", parameters: {} },
        { id: "3", name: "Merge", type: "x", parameters: {} },
      ],
      connections: {
        A: { main: [[{ node: "Merge", type: "main", index: 0 }]] },
        B: { main: [[{ node: "Merge", type: "main", index: 1 }]] },
      },
    });
    const graph = analyzeGraph(workflow);
    expect(graph.requiredSlots.get("Merge")).toBe(2);
  });
});
