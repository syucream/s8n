import { describe, expect, test } from "bun:test";
import { buildExpressionScope } from "../../expression/context.ts";
import { createMockLookup } from "../../mock/provider.ts";
import { workflowNodeSchema } from "../../schema/workflow.ts";
import type { ExecuteArgs } from "../types.ts";
import { httpRequestExecutor } from "./http-request.ts";
import {
  extractPages,
  extractPaginationConfig,
  stripPaginationParameters,
} from "./http-request-pagination.ts";

describe("pagination config extraction", () => {
  test("reads the upstream double-nested options.pagination.pagination shape", () => {
    const config = extractPaginationConfig({
      options: {
        pagination: {
          pagination: {
            paginationMode: "updateAParameterInEachRequest",
            parameters: {
              parameters: [
                {
                  type: "qs",
                  name: "cursor",
                  value: "={{ $response.body.next }}",
                },
              ],
            },
            paginationCompleteWhen: "other",
            completeExpression: "={{ $response.body.done }}",
            limitPagesFetched: true,
            maxRequests: 10,
          },
        },
      },
    });
    expect(config).toEqual({
      paginationMode: "updateAParameterInEachRequest",
      updates: [
        { type: "qs", name: "cursor", value: "={{ $response.body.next }}" },
      ],
      paginationCompleteWhen: "other",
      completeExpression: "={{ $response.body.done }}",
      limitPagesFetched: true,
      maxRequests: 10,
    });
  });

  test("returns undefined for off/missing pagination", () => {
    expect(
      extractPaginationConfig({
        options: { pagination: { pagination: { paginationMode: "off" } } },
      }),
    ).toBeUndefined();
    expect(extractPaginationConfig({ options: {} })).toBeUndefined();
    expect(extractPaginationConfig({})).toBeUndefined();
  });

  test("stripping keeps sibling options and drops the pagination subtree", () => {
    const stripped = stripPaginationParameters({
      url: "https://example.com",
      options: {
        pagination: {
          pagination: { completeExpression: "={{ $response.x }}" },
        },
        response: { response: { fullResponse: true } },
      },
    });
    expect(stripped).toEqual({
      url: "https://example.com",
      options: { response: { response: { fullResponse: true } } },
    });
  });
});

describe("page extraction", () => {
  test("explicit pages wrapper wins", () => {
    expect(extractPages({ pages: [{ a: 1 }, { a: 2 }] })).toEqual({
      pages: [{ a: 1 }, { a: 2 }],
      explicit: true,
    });
  });

  test("plain mock is a single implicit page", () => {
    expect(extractPages({ a: 1 })).toEqual({
      pages: [{ a: 1 }],
      explicit: false,
    });
  });
});

function makeArgs(
  parameters: Record<string, unknown>,
  mocks: Record<string, unknown>,
  overrides: Partial<ExecuteArgs> = {},
): ExecuteArgs {
  const nodeOutputs = new Map();
  return {
    node: workflowNodeSchema.parse({
      name: "Fetch",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.2,
      position: [0, 0],
      parameters,
    }),
    inputItems: [{ json: {} }],
    inputSlots: [[{ json: {} }]],
    runtime: {
      workflowName: "test",
      nodeOutputs,
      mocks: createMockLookup(mocks),
      suggestedFields: [],
      hasExplicitInput: true,
      workflowStaticData: new Map(),
      integrationEffects: [],
      captureResolvedRequests: true,
    },
    isStartNode: true,
    buildScope: (item, itemIndex, inputItems) =>
      buildExpressionScope({
        currentItem: item,
        itemIndex,
        inputItems,
        currentNodeName: "Fetch",
        workflowName: "test",
        nodeOutputs,
      }),
    ...overrides,
  };
}

const paginatedParameters = {
  method: "GET",
  url: "https://example.com/rows",
  options: {
    pagination: {
      pagination: {
        paginationMode: "updateAParameterInEachRequest",
        parameters: {
          parameters: [
            {
              type: "qs",
              name: "cursor",
              value: "={{ $response.body.nextCursor }}",
            },
          ],
        },
        paginationCompleteWhen: "other",
        completeExpression: "={{ $response.body.hasMore === false }}",
      },
    },
  },
};

describe("paginated HTTP Request execution", () => {
  test("evaluates $response expressions and concatenates pages", async () => {
    const result = await httpRequestExecutor.execute(
      makeArgs(paginatedParameters, {
        Fetch: {
          pages: [
            { rows: [{ id: 1 }], hasMore: true, nextCursor: "c2" },
            { rows: [{ id: 2 }], hasMore: false },
          ],
        },
      }),
    );
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.output[0]?.map((item) => item.json)).toEqual([
      { rows: [{ id: 1 }], hasMore: true, nextCursor: "c2" },
      { rows: [{ id: 2 }], hasMore: false },
    ]);
    // Page 2's request carries the cursor from page 1's response.
    expect(result.resolvedRequests?.[1]?.url).toContain("cursor=c2");
    // Mock-served output carries the generic mocked-output fidelity note, but
    // no pagination-specific caveat (the pages mock was complete).
    expect(result.fidelityNotes?.join(" ")).toContain("mocked-output");
    expect(result.fidelityNotes?.join(" ")).not.toContain("pagination-");
  });

  test("single-page mock succeeds with a fidelity note instead of an error", async () => {
    const result = await httpRequestExecutor.execute(
      makeArgs(paginatedParameters, {
        Fetch: { rows: [{ id: 1 }], hasMore: false },
      }),
    );
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.output[0]).toHaveLength(1);
    expect(result.fidelityNotes?.join(" ")).toContain(
      "pagination-single-page-mock",
    );
  });

  test("exhausted pages without completion are flagged as truncated", async () => {
    const result = await httpRequestExecutor.execute(
      makeArgs(paginatedParameters, {
        Fetch: {
          pages: [
            { rows: [], hasMore: true, nextCursor: "c2" },
            { rows: [], hasMore: true, nextCursor: "c3" },
          ],
        },
      }),
    );
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.output[0]).toHaveLength(2);
    expect(result.fidelityNotes?.join(" ")).toContain(
      "pagination-truncated-mock",
    );
  });

  test("responseIsEmpty stops after the first empty page", async () => {
    const parameters = {
      method: "GET",
      url: "https://example.com/rows",
      options: {
        pagination: {
          pagination: {
            paginationMode: "responseContainsNextURL",
            nextURL: "={{ $response.body.next }}",
            paginationCompleteWhen: "responseIsEmpty",
          },
        },
      },
    };
    const result = await httpRequestExecutor.execute(
      makeArgs(parameters, {
        Fetch: {
          pages: [[{ id: 1 }], []],
        },
      }),
    );
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.output[0]?.map((item) => item.json)).toEqual([{ id: 1 }]);
  });

  test("missing mock still pauses with a pages-aware shape hint", async () => {
    const result = await httpRequestExecutor.execute(
      makeArgs(paginatedParameters, {}),
    );
    expect(result.status).toBe("waiting_mock");
    if (result.status !== "waiting_mock") return;
    expect(JSON.stringify(result.request.expectedShape)).toContain("pages");
  });
});
