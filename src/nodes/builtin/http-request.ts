import { resolveParameterValue } from "../../expression/evaluator.ts";
import { formatFaultMessage } from "../../faults.ts";
import { normalizeMockToItems } from "../../mock/normalize.ts";
import { lookupItemMock } from "../../mock/provider.ts";
import {
  buildMockContractEvidence,
  defaultMockCardinalityHint,
} from "../../mock/request-contract.ts";
import { buildMockShapeHint } from "../../mock/shape-hint.ts";
import type { Item } from "../../schema/item.ts";
import type { NodeExecutor } from "../types.ts";

/**
 * HTTP Request, mocked: s8n never performs real network IO. It resolves the
 * (expression-evaluated) method/url per item purely for tracing/reporting,
 * then looks up a caller-supplied mock response keyed by node name (with an
 * optional `#<itemIndex>` suffix for per-item responses). If no mock is
 * registered, execution pauses and reports a `PendingMockRequest` so the
 * calling AI can generate one.
 */
export const httpRequestExecutor: NodeExecutor = {
  type: "n8n-nodes-base.httpRequest",
  execute: ({ node, inputItems, runtime, buildScope, loopIterationIndex }) => {
    const items = inputItems.length > 0 ? inputItems : [{ json: {} }];
    const outputItems: Item[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i] as Item;
      const scope = buildScope(item, i, items);
      const resolvedParams = resolveParameterValue(
        node.parameters,
        scope,
      ) as Record<string, unknown>;
      const method = String(resolvedParams.method ?? "GET").toUpperCase();
      const url = String(resolvedParams.url ?? "");

      const fault = runtime.faults?.get(node.name);
      if (fault !== undefined) {
        return { status: "error", message: formatFaultMessage(fault) };
      }

      // Inside a Split In Batches loop body, prefer the loop's own
      // iteration counter over the local within-batch index for the mock
      // key - with the common `batchSize: 1`, `i` is always 0 every
      // iteration, which would otherwise collide every batch onto the same
      // `#0` mock (see `ExecuteArgs.loopIterationIndex`).
      const mockValue = lookupItemMock(
        runtime.mocks,
        node.name,
        loopIterationIndex ?? i,
      );

      if (mockValue === undefined) {
        const suggestedFields =
          runtime.suggestedFieldsByNode?.get(node.name) ??
          runtime.suggestedFields;
        return {
          status: "waiting_mock",
          request: {
            nodeName: node.name,
            nodeType: node.type,
            mockKey: node.name,
            reason: `No mock response was provided for HTTP request "${method} ${url || "(unresolved URL)"}"`,
            expectedShape: buildMockShapeHint(
              "The JSON response body for this HTTP request. Provide one object or an array of objects to emit multiple items.",
              suggestedFields,
            ),
            provenance: buildMockContractEvidence({
              suggestedFields,
              userContext: `The request method and URL were resolved from user configuration as ${method} ${url || "(unresolved URL)"}.`,
              genericContext:
                "No remote response schema is fetched because s8n never performs network I/O.",
            }),
            cardinalityHint: { ...defaultMockCardinalityHint },
          },
        };
      }

      outputItems.push(...normalizeMockToItems(mockValue, i));
    }

    return { status: "success", output: [outputItems] };
  },
};
