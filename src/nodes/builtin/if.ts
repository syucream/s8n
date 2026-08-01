import { resolveParameterValue } from "../../expression/evaluator.ts";
import type { Item } from "../../schema/item.ts";
import { evaluateConditions, extractConditionList } from "../conditions.ts";
import type { NodeExecutor } from "../types.ts";

/**
 * If: routes each item to output 0 (true) or output 1 (false) based on a
 * boolean expression or a structured condition list (see conditions.ts).
 */
export const ifExecutor: NodeExecutor = {
  type: "n8n-nodes-base.if",
  execute: ({ node, inputItems, buildScope }) => {
    const trueItems: Item[] = [];
    const falseItems: Item[] = [];

    inputItems.forEach((item, index) => {
      const scope = buildScope(item, index, inputItems);
      const resolvedParams = resolveParameterValue(
        node.parameters,
        scope,
      ) as Record<string, unknown>;
      const { conditions, combinator } = extractConditionList(resolvedParams);
      const passes = evaluateConditions(conditions, combinator);
      (passes ? trueItems : falseItems).push(item);
    });

    return { status: "success", output: [trueItems, falseItems] };
  },
};
