import { resolveParameterValue } from "../../expression/evaluator.ts";
import type { Item } from "../../schema/item.ts";
import type { NodeExecutor } from "../types.ts";

interface Assignment {
  name: string;
  value: unknown;
}

function extractAssignments(
  resolvedParams: Record<string, unknown>,
): Assignment[] {
  // n8n-compatible shape: parameters.assignments.assignments[]
  const nested = resolvedParams.assignments as
    | { assignments?: unknown[] }
    | undefined;
  if (nested && Array.isArray(nested.assignments)) {
    return nested.assignments
      .filter(
        (a): a is Record<string, unknown> =>
          typeof a === "object" && a !== null,
      )
      .map((a) => ({ name: String(a.name ?? ""), value: a.value }))
      .filter((a) => a.name.length > 0);
  }
  // s8n shorthand: parameters.fields[] = [{name, value}]
  if (Array.isArray(resolvedParams.fields)) {
    return (resolvedParams.fields as unknown[])
      .filter(
        (a): a is Record<string, unknown> =>
          typeof a === "object" && a !== null,
      )
      .map((a) => ({ name: String(a.name ?? ""), value: a.value }))
      .filter((a) => a.name.length > 0);
  }
  return [];
}

/**
 * Set / Edit Fields: assigns computed values onto each item's json. Supports
 * both the n8n-style `assignments.assignments[]` shape and s8n's shorthand
 * `fields[]`, since either might show up in AI-authored workflow JSON.
 *
 * Matches real n8n Set v2/v3 semantics: `parameters.includeOtherFields` is a
 * top-level boolean that defaults to `false` - i.e. by default the output
 * contains *only* the assigned fields, and existing fields are kept only
 * when `includeOtherFields` is explicitly `true`.
 */
export const setExecutor: NodeExecutor = {
  type: "n8n-nodes-base.set",
  execute: ({ node, inputItems, buildScope }) => {
    const outputItems: Item[] = inputItems.map((item, index) => {
      const scope = buildScope(item, index, inputItems);
      const resolvedParams = resolveParameterValue(
        node.parameters,
        scope,
      ) as Record<string, unknown>;
      const assignments = extractAssignments(resolvedParams);
      const keepOnlySet = resolvedParams.includeOtherFields !== true;

      const baseJson = keepOnlySet ? {} : { ...item.json };
      for (const assignment of assignments) {
        baseJson[assignment.name] = assignment.value;
      }

      return {
        json: baseJson,
        binary: item.binary,
        pairedItem: { item: index },
      };
    });

    return { status: "success", output: [outputItems] };
  },
};
