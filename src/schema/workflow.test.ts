import { describe, expect, test } from "bun:test";
import { validateWorkflow } from "./workflow.ts";

function baseWorkflow() {
  return {
    name: "test",
    nodes: [
      {
        id: "1",
        name: "Trigger",
        type: "n8n-nodes-base.manualTrigger",
        parameters: {},
      },
      { id: "2", name: "Set", type: "n8n-nodes-base.set", parameters: {} },
    ],
    connections: {
      Trigger: { main: [[{ node: "Set", type: "main", index: 0 }]] },
    },
  };
}

describe("validateWorkflow", () => {
  test("accepts a well-formed workflow and fills in defaults", () => {
    const result = validateWorkflow(baseWorkflow());
    expect(result.valid).toBe(true);
    expect(result.workflow?.nodes[0]?.typeVersion).toBe(1);
    expect(result.workflow?.nodes[0]?.position).toEqual([0, 0]);
  });

  test("accepts published legacy community nodes without IDs and with string credential names", () => {
    const result = validateWorkflow({
      name: "Legacy community workflow",
      nodes: [
        {
          name: "Slack",
          type: "n8n-nodes-base.slack",
          parameters: { channel: "general", text: "hello" },
          credentials: { slackApi: "Community credential" },
        },
      ],
      connections: {},
    });

    expect(result.valid).toBe(true);
    expect(result.workflow?.nodes[0]?.id).toBe("");
    expect(result.workflow?.nodes[0]?.credentials?.slackApi).toBe(
      "Community credential",
    );
  });

  test("rejects missing required fields", () => {
    const result = validateWorkflow({ nodes: [] });
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  test("rejects duplicate node names", () => {
    const wf = baseWorkflow();
    const [, second] = wf.nodes;
    if (!second) throw new Error("fixture invalid: missing second node");
    wf.nodes[1] = { ...second, name: "Trigger" };
    const result = validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.message.includes("Duplicate"))).toBe(
      true,
    );
  });

  test("rejects connections referencing an unknown node", () => {
    const wf = baseWorkflow();
    wf.connections.Trigger = {
      main: [[{ node: "DoesNotExist", type: "main", index: 0 }]],
    };
    const result = validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.message.includes("DoesNotExist"))).toBe(
      true,
    );
  });
});
