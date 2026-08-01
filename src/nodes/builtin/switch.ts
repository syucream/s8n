import { resolveParameterValue } from "../../expression/evaluator.ts";
import type { Item } from "../../schema/item.ts";
import { evaluateConditions, extractConditionList } from "../conditions.ts";
import type { NodeExecutor } from "../types.ts";

interface Rule {
  output: number;
  conditions: ReturnType<typeof extractConditionList>["conditions"];
  combinator: "and" | "or";
}

function extractRules(resolvedParams: Record<string, unknown>): Rule[] {
  const raw = resolvedParams.rules;
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === "object" &&
        Array.isArray((raw as Record<string, unknown>).values)
      ? ((raw as Record<string, unknown>).values as unknown[])
      : [];

  return list.map((entry, index) => {
    const rec = (entry ?? {}) as Record<string, unknown>;
    const output =
      typeof rec.output === "number" &&
      Number.isInteger(rec.output) &&
      rec.output >= 0
        ? rec.output
        : index;
    const { conditions, combinator } = extractConditionList(rec);
    return { output, conditions, combinator };
  });
}

/**
 * Switch: routes each item to the output of the first matching rule (rules
 * checked in order; output index = rule position, matching real n8n's
 * `configuredOutputs` behavior). Items matching no rule are routed per
 * `parameters.options.fallbackOutput`: `'none'`/unset drops them, `'extra'`
 * sends them to a new output appended after the last rule, and a number
 * sends them to that existing rule's output.
 */
export const switchExecutor: NodeExecutor = {
  type: "n8n-nodes-base.switch",
  execute: ({ node, inputItems, buildScope }) => {
    const outputs: Item[][] = [];
    const ensureSlot = (index: number) => {
      while (outputs.length <= index) outputs.push([]);
    };

    inputItems.forEach((item, itemIndex) => {
      const scope = buildScope(item, itemIndex, inputItems);
      const resolvedParams = resolveParameterValue(
        node.parameters,
        scope,
      ) as Record<string, unknown>;
      const rules = extractRules(resolvedParams);

      const matched = rules.find((rule) =>
        evaluateConditions(rule.conditions, rule.combinator),
      );
      if (matched) {
        ensureSlot(matched.output);
        outputs[matched.output]?.push(item);
        return;
      }

      const options = resolvedParams.options as
        | Record<string, unknown>
        | undefined;
      const fallback = options?.fallbackOutput;
      if (fallback === "extra") {
        const extraIndex = rules.length;
        ensureSlot(extraIndex);
        outputs[extraIndex]?.push(item);
      } else if (
        typeof fallback === "number" &&
        Number.isInteger(fallback) &&
        fallback >= 0
      ) {
        ensureSlot(fallback);
        outputs[fallback]?.push(item);
      }
      // 'none' (default) or unset: the item is dropped, matching real n8n.
    });

    return { status: "success", output: outputs.length > 0 ? outputs : [[]] };
  },
};
