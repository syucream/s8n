import { resolveParameterValue } from "../../expression/evaluator.ts";
import type { Item } from "../../schema/item.ts";
import { getByPath, omitByPath } from "../path-utils.ts";
import type { NodeExecutor } from "../types.ts";

/**
 * Split Out: expands an array field within each item into multiple items.
 * Field names verified against
 * `packages/nodes-base/nodes/Transform/SplitOut/SplitOut.node.ts`:
 * `parameters.fieldToSplitOut` (string, comma-separated in real n8n),
 * `parameters.include` (`"noOtherFields"` default | `"allOtherFields"` | `"selectedOtherFields"`),
 * `parameters.options.destinationFieldName`.
 *
 * Simplified: only the first field in a comma-separated `fieldToSplitOut`
 * is split (multi-field simultaneous split is not implemented), and
 * `"selectedOtherFields"` falls back to `"allOtherFields"` behavior.
 */
export const splitOutExecutor: NodeExecutor = {
  type: "n8n-nodes-base.splitOut",
  execute: ({ node, inputItems, buildScope }) => {
    const outputItems: Item[] = [];

    inputItems.forEach((item, index) => {
      const scope = buildScope(item, index, inputItems);
      const resolvedParams = resolveParameterValue(
        node.parameters,
        scope,
      ) as Record<string, unknown>;
      const fieldToSplitOut = String(resolvedParams.fieldToSplitOut ?? "")
        .split(",")[0]
        ?.trim()
        .replace(/^\$json\./, "");
      const include = String(resolvedParams.include ?? "noOtherFields");
      const options = resolvedParams.options as
        | Record<string, unknown>
        | undefined;
      const destinationFieldName =
        String(options?.destinationFieldName ?? "") || undefined;

      if (!fieldToSplitOut) return;

      let entities = getByPath(item.json, fieldToSplitOut);
      if (entities === undefined) entities = [];
      else if (!Array.isArray(entities)) entities = [entities];

      const baseJson =
        include === "allOtherFields"
          ? omitByPath(item.json, fieldToSplitOut)
          : {};

      for (const entity of entities as unknown[]) {
        if (destinationFieldName) {
          outputItems.push({
            json: { ...baseJson, [destinationFieldName]: entity },
            pairedItem: { item: index },
          });
        } else if (
          typeof entity === "object" &&
          entity !== null &&
          include === "noOtherFields"
        ) {
          outputItems.push({
            json: { ...(entity as Record<string, unknown>) },
            pairedItem: { item: index },
          });
        } else {
          outputItems.push({
            json: { ...baseJson, [fieldToSplitOut]: entity },
            pairedItem: { item: index },
          });
        }
      }
    });

    return { status: "success", output: [outputItems] };
  },
};
