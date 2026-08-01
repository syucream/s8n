import { describe, expect, test } from "bun:test";
import { validateWorkflow } from "../schema/workflow.ts";
import { extractReferencedJsonFields } from "./field-hints.ts";

describe("extractReferencedJsonFields", () => {
  test("finds dot-access and bracket-access $json references across all nodes", () => {
    const result = validateWorkflow({
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
          name: "B",
          type: "n8n-nodes-base.set",
          parameters: {
            fields: [
              { name: "x", value: "={{$json.userId}} {{$json['order-id']}}" },
            ],
          },
        },
      ],
      connections: {},
    });
    if (!result.valid || !result.workflow) throw new Error("fixture invalid");

    const fields = extractReferencedJsonFields(result.workflow);
    expect(fields).toContain("userId");
    expect(fields).toContain("order-id");
  });

  test("returns an empty list when there are no references", () => {
    const result = validateWorkflow({
      name: "t",
      nodes: [
        {
          id: "1",
          name: "A",
          type: "n8n-nodes-base.manualTrigger",
          parameters: {},
        },
      ],
      connections: {},
    });
    if (!result.valid || !result.workflow) throw new Error("fixture invalid");
    expect(extractReferencedJsonFields(result.workflow)).toEqual([]);
  });
});
