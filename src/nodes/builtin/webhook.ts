import { normalizeMockToItems } from "../../mock/normalize.ts";
import {
  buildMockContractEvidence,
  defaultMockCardinalityHint,
} from "../../mock/request-contract.ts";
import { buildMockShapeHint } from "../../mock/shape-hint.ts";
import type { NodeExecutor } from "../types.ts";

/**
 * Webhook: the incoming request body is data the caller controls, so unlike
 * Manual/Schedule triggers s8n won't silently default it to `{}`. Priority:
 * 1. explicit `--input` (the run is simulating one specific incoming call)
 * 2. a mock registered under this node's name
 * 3. otherwise, pause and ask the calling AI for a plausible payload
 */
export const webhookExecutor: NodeExecutor = {
  type: "n8n-nodes-base.webhook",
  execute: ({ node, inputItems, runtime }) => {
    if (runtime.hasExplicitInput) {
      return { status: "success", output: [inputItems] };
    }

    const mockValue = runtime.mocks.get(node.name);
    if (mockValue !== undefined) {
      return {
        status: "success",
        output: [normalizeMockToItems(mockValue, 0)],
      };
    }

    const suggestedFields =
      runtime.suggestedFieldsByNode?.get(node.name) ?? runtime.suggestedFields;
    return {
      status: "waiting_mock",
      request: {
        nodeName: node.name,
        nodeType: node.type,
        mockKey: node.name,
        reason: `No incoming request body was provided for webhook "${node.name}"`,
        expectedShape: buildMockShapeHint(
          "The JSON request body received by this webhook. Use field names referenced by the workflow as a guide.",
          suggestedFields,
        ),
        provenance: buildMockContractEvidence({
          suggestedFields,
          genericContext:
            "No concrete incoming payload was supplied, so the webhook body shape is inferred generically.",
        }),
        cardinalityHint: { ...defaultMockCardinalityHint },
      },
    };
  },
};
