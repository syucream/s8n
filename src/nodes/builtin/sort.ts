import { resolveParameterValue } from "../../expression/evaluator.ts";
import type { Item } from "../../schema/item.ts";
import { getByPath } from "../path-utils.ts";
import type { NodeExecutor } from "../types.ts";

interface SortField {
  fieldName: string;
  order: "ascending" | "descending";
}

function extractSortFields(
  resolvedParams: Record<string, unknown>,
): SortField[] {
  const ui = resolvedParams.sortFieldsUi as
    | { sortField?: unknown[] }
    | undefined;
  if (!ui || !Array.isArray(ui.sortField)) return [];
  return ui.sortField
    .filter(
      (f): f is Record<string, unknown> => typeof f === "object" && f !== null,
    )
    .map(
      (f): SortField => ({
        fieldName: String(f.fieldName ?? ""),
        order: f.order === "descending" ? "descending" : "ascending",
      }),
    )
    .filter((f) => f.fieldName.length > 0);
}

function normalizeForCompare(value: unknown): unknown {
  return typeof value === "string" ? value.toLowerCase() : value;
}

function shuffle<T>(array: T[]): T[] {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    // biome-ignore lint/style/noNonNullAssertion: i/j are always in-bounds swap indices
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/**
 * Sort: reorders items. Field names verified against
 * `packages/nodes-base/nodes/Transform/Sort/Sort.node.ts`: `parameters.type`
 * (`"simple"` default | `"random"` | `"code"`), `parameters.sortFieldsUi.sortField[]`
 * (`{fieldName, order}`), `parameters.options.disableDotNotation`.
 * `type: "code"` (custom JS comparator) is not implemented - it errors
 * explicitly rather than silently leaving the order unchanged.
 */
export const sortExecutor: NodeExecutor = {
  type: "n8n-nodes-base.sort",
  execute: ({ node, inputItems, buildScope }) => {
    const scope = buildScope(inputItems[0] ?? { json: {} }, 0, inputItems);
    const resolvedParams = resolveParameterValue(
      node.parameters,
      scope,
    ) as Record<string, unknown>;
    const type = String(resolvedParams.type ?? "simple");

    if (type === "random") {
      return { status: "success", output: [shuffle(inputItems)] };
    }

    if (type === "code") {
      return {
        status: "error",
        message: `Sort node "${node.name}" uses unsupported type="code" (custom comparator)`,
      };
    }

    const options = resolvedParams.options as
      | Record<string, unknown>
      | undefined;
    const disableDotNotation = options?.disableDotNotation === true;
    const sortFields = extractSortFields(resolvedParams);
    if (sortFields.length === 0) {
      return {
        status: "error",
        message: `Sort node "${node.name}" has no field to sort by`,
      };
    }

    const readField = (item: Item, fieldName: string) =>
      disableDotNotation
        ? item.json[fieldName]
        : getByPath(item.json, fieldName);

    const sorted = [...inputItems].sort((a, b) => {
      for (const field of sortFields) {
        const va = normalizeForCompare(readField(a, field.fieldName));
        const vb = normalizeForCompare(readField(b, field.fieldName));
        if (va === vb) continue;
        const dir = field.order === "ascending" ? 1 : -1;
        // biome-ignore lint/suspicious/noExplicitAny: comparing heterogeneous JSON values, matching real n8n's loose comparison
        return (va as any) < (vb as any) ? -1 * dir : 1 * dir;
      }
      return 0;
    });

    return { status: "success", output: [sorted] };
  },
};
