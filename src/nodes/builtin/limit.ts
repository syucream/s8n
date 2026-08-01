import { resolveParameterValue } from "../../expression/evaluator.ts";
import type { Item } from "../../schema/item.ts";
import type { NodeExecutor } from "../types.ts";

/**
 * Limit: keeps only the first or last `maxItems` items. Field names verified
 * against `packages/nodes-base/nodes/Transform/Limit/Limit.node.ts`:
 * `parameters.maxItems` (number, default 1), `parameters.keep`
 * (`"firstItems"` default | `"lastItems"`).
 */
export const limitExecutor: NodeExecutor = {
  type: "n8n-nodes-base.limit",
  execute: ({ node, inputItems, buildScope }) => {
    const scope = buildScope(inputItems[0] ?? { json: {} }, 0, inputItems);
    const resolvedParams = resolveParameterValue(
      node.parameters,
      scope,
    ) as Record<string, unknown>;
    const maxItems = Number(resolvedParams.maxItems ?? 1);
    const keep = String(resolvedParams.keep ?? "firstItems");

    let output: Item[] = inputItems;
    if (maxItems < inputItems.length) {
      output =
        keep === "lastItems"
          ? inputItems.slice(inputItems.length - maxItems)
          : inputItems.slice(0, maxItems);
    }

    return { status: "success", output: [output] };
  },
};
