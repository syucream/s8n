import { describe, expect, test } from "bun:test";
import { runWorkflow } from "../engine/execute.ts";
import { createDefaultRegistry } from "../nodes/registry.ts";
import { validateWorkflow } from "../schema/workflow.ts";
import { emptyMockLookup } from "./provider.ts";
import {
  buildMockContractEvidence,
  defaultMockCardinalityHint,
} from "./request-contract.ts";

function workflow(raw: unknown) {
  const result = validateWorkflow(raw);
  if (!result.valid || !result.workflow) throw new Error("Invalid fixture");
  return result.workflow;
}

describe("mock request contract", () => {
  test("keeps the evidence source and confidence for every available hint", () => {
    expect(
      buildMockContractEvidence({
        suggestedFields: ["accountId", "status"],
        nodeHint: "A service response with account metadata.",
        userContext: "The operation is read.",
        genericContext: "The remaining response shape is unknown.",
      }),
    ).toEqual([
      {
        source: "downstream-expression",
        confidence: "high",
        detail: "Downstream $json expressions reference: accountId, status.",
      },
      {
        source: "node-hint",
        confidence: "medium",
        detail: "A service response with account metadata.",
      },
      {
        source: "user",
        confidence: "high",
        detail: "The operation is read.",
      },
      {
        source: "generic",
        confidence: "low",
        detail: "The remaining response shape is unknown.",
      },
    ]);
    expect(defaultMockCardinalityHint).toEqual({
      minItems: 1,
      preferredItems: 1,
      allowsMultiple: true,
    });
  });

  test("HTTP pending mocks expose expression evidence and a cardinality hint", async () => {
    const result = await runWorkflow(
      workflow({
        name: "mock-contract",
        nodes: [
          {
            id: "1",
            name: "Fetch account",
            type: "n8n-nodes-base.httpRequest",
            parameters: { method: "GET", url: "https://example.test/account" },
          },
          {
            id: "2",
            name: "Use account",
            type: "n8n-nodes-base.set",
            parameters: {
              fields: [{ name: "account", value: "={{$json.accountId}}" }],
            },
          },
        ],
        connections: {
          "Fetch account": {
            main: [[{ node: "Use account", type: "main", index: 0 }]],
          },
        },
      }),
      {
        hasExplicitInput: false,
        mocks: emptyMockLookup,
        registry: createDefaultRegistry(),
      },
    );

    expect(result.status).toBe("needs_mock");
    expect(result.pendingMocks[0]).toMatchObject({
      nodeName: "Fetch account",
      cardinalityHint: defaultMockCardinalityHint,
    });
    expect(result.pendingMocks[0]?.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "downstream-expression",
          confidence: "high",
        }),
        expect.objectContaining({ source: "user", confidence: "high" }),
        expect.objectContaining({ source: "generic", confidence: "low" }),
      ]),
    );
  });

  test("generic fallback includes a tailored node-hint when one is known", async () => {
    const result = await runWorkflow(
      workflow({
        name: "tailored-contract",
        nodes: [
          {
            id: "1",
            name: "Post message",
            type: "n8n-nodes-base.slack",
            parameters: { channel: "C123", text: "hello" },
          },
        ],
        connections: {},
      }),
      {
        hasExplicitInput: false,
        mocks: emptyMockLookup,
        registry: createDefaultRegistry(),
      },
    );

    expect(result.status).toBe("needs_mock");
    expect(result.pendingMocks[0]?.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "node-hint",
          confidence: "medium",
        }),
        expect.objectContaining({ source: "user", confidence: "high" }),
      ]),
    );
  });
});
