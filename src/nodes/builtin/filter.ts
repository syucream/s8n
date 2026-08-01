import { resolveParameterValue } from "../../expression/evaluator.ts";
import type { Item } from "../../schema/item.ts";
import { evaluateConditions, extractConditionList } from "../conditions.ts";
import type { NodeExecutor } from "../types.ts";

/** Filter: keeps only the items whose condition(s) evaluate to true (single output). */
export const filterExecutor: NodeExecutor = {
  type: "n8n-nodes-base.filter",
  execute: ({ node, inputItems, buildScope }) => {
    const kept: Item[] = [];

    inputItems.forEach((item, index) => {
      const scope = buildScope(item, index, inputItems);
      const resolvedParams = resolveParameterValue(
        node.parameters,
        scope,
      ) as Record<string, unknown>;
      const { conditions, combinator } = extractConditionList(resolvedParams);
      if (evaluateConditions(conditions, combinator)) kept.push(item);
    });

    return { status: "success", output: [kept] };
  },
};
