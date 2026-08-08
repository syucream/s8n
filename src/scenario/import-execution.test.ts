import { describe, expect, test } from "bun:test";
import { validateWorkflow } from "../schema/workflow.ts";
import {
  importExecutionDraft,
  synthesizeExecutionValue,
} from "./import-execution.ts";

function workflow() {
  const parsed = validateWorkflow({
    name: "Draft source",
    nodes: [
      { name: "Trigger", type: "n8n-nodes-base.manualTrigger" },
      { name: "Fetch", type: "n8n-nodes-base.httpRequest" },
    ],
    connections: {
      Trigger: { main: [[{ node: "Fetch", type: "main", index: 0 }]] },
    },
  });
  if (!parsed.workflow) throw new Error(JSON.stringify(parsed.issues));
  return parsed.workflow;
}

describe("importExecutionDraft", () => {
  test("creates a synthetic scenario draft from an n8n-shaped execution", () => {
    const draft = importExecutionDraft(workflow(), {
      status: "success",
      startedAt: "2026-08-07T01:02:03.000Z",
      data: {
        startData: { destinationNode: "Trigger" },
        resultData: {
          runData: {
            Trigger: [
              {
                data: {
                  main: [[{ json: { email: "real@example.com", count: 42 } }]],
                },
              },
            ],
            Fetch: [
              {
                data: {
                  main: [
                    [
                      {
                        json: {
                          token: "secret-value",
                          url: "https://private.invalid/path",
                        },
                      },
                    ],
                  ],
                },
              },
            ],
          },
        },
      },
    });

    expect(draft.generatedFrom.dataMode).toBe("synthetic-shape");
    expect(draft.generatedFrom.reviewRequired).toBe(true);
    expect(draft.generatedFrom.warnings).toContain(
      "Value-dependent branches may diverge and require manual review.",
    );
    expect(draft.cases[0]?.startNode).toBe("Trigger");
    expect(draft.cases[0]?.now).toBe("2026-08-07T01:02:03.000Z");
    expect(draft.cases[0]?.input).toEqual([
      { email: "person@example.invalid", count: 1 },
    ]);
    expect(draft.cases[0]?.mocks.Fetch).toEqual([
      {
        token: "[redacted]",
        url: "https://example.invalid/resource",
      },
    ]);
    expect(JSON.stringify(draft)).not.toContain("real@example.com");
    expect(JSON.stringify(draft)).not.toContain("secret-value");
    expect(draft.cases[0]?.assertions.requiredNodes).toEqual([
      "Trigger",
      "Fetch",
    ]);
  });

  test("accepts an API wrapper and rejects logs without runData", () => {
    const wrapped = importExecutionDraft(workflow(), {
      data: {
        status: "success",
        data: {
          startData: { destinationNode: "Trigger" },
          resultData: {
            runData: { Trigger: [{ data: { main: [[{ json: {} }]] } }] },
          },
        },
      },
    });
    expect(wrapped.cases[0]?.input).toEqual([{}]);
    expect(() => importExecutionDraft(workflow(), {})).toThrow("runData");
    expect(() =>
      importExecutionDraft(workflow(), {
        resultData: { runData: { "Different node": [{}] } },
      }),
    ).toThrow("does not match");
  });

  test("replaces every scalar and validates the item limit", () => {
    expect(
      synthesizeExecutionValue({ active: true, score: 9, name: "Private" }),
    ).toEqual({ active: false, score: 1, name: "Synthetic Name" });
    expect(() =>
      importExecutionDraft(
        workflow(),
        {
          resultData: { runData: {} },
        },
        { maxItemsPerNode: 0 },
      ),
    ).toThrow("positive integer");
  });
});
