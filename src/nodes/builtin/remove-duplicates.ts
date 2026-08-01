import { resolveParameterValue } from "../../expression/evaluator.ts";
import type { Item } from "../../schema/item.ts";
import { getByPath } from "../path-utils.ts";
import type { NodeExecutor } from "../types.ts";

function keyFor(
  item: Item,
  compare: string,
  fieldList: string[],
  disableDotNotation: boolean,
): string {
  if (compare === "allFields") return JSON.stringify(item.json);
  const read = (field: string) =>
    disableDotNotation ? item.json[field] : getByPath(item.json, field);
  if (compare === "allFieldsExcept") {
    const rest = { ...item.json };
    for (const f of fieldList) delete rest[f];
    return JSON.stringify(rest);
  }
  // "selectedFields"
  return JSON.stringify(fieldList.map(read));
}

/**
 * Remove Duplicates (v2): field names verified against
 * `packages/nodes-base/nodes/Transform/RemoveDuplicates/v2/RemoveDuplicatesV2.description.ts`.
 * Only `operation: "removeDuplicateInputItems"` (default) is faithfully
 * implemented - deduping within the current batch by `compare`
 * (`"allFields"` default | `"allFieldsExcept"` | `"selectedFields"`) +
 * `fieldsToExclude`/`fieldsToCompare` (comma-separated).
 * `"removeItemsSeenInPreviousExecutions"` needs data persisted *across* CLI
 * invocations, which s8n doesn't have (each `run` is a fresh process) - it's
 * treated as a no-op passthrough (equivalent to "nothing seen before",
 * i.e. a first-ever execution), and `"clearDeduplicationHistory"` is also a
 * passthrough since there's no history to clear.
 */
export const removeDuplicatesExecutor: NodeExecutor = {
  type: "n8n-nodes-base.removeDuplicates",
  execute: ({ node, inputItems, buildScope }) => {
    const scope = buildScope(inputItems[0] ?? { json: {} }, 0, inputItems);
    const p = resolveParameterValue(node.parameters, scope) as Record<
      string,
      unknown
    >;
    const operation = String(p.operation ?? "removeDuplicateInputItems");

    if (operation !== "removeDuplicateInputItems") {
      return { status: "success", output: [inputItems] };
    }

    const compare = String(p.compare ?? "allFields");
    const options = p.options as Record<string, unknown> | undefined;
    const disableDotNotation = options?.disableDotNotation === true;
    const fieldList = String(
      compare === "allFieldsExcept"
        ? p.fieldsToExclude
        : (p.fieldsToCompare ?? ""),
    )
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const seen = new Set<string>();
    const kept: Item[] = [];
    for (const item of inputItems) {
      const key = keyFor(item, compare, fieldList, disableDotNotation);
      if (!seen.has(key)) {
        seen.add(key);
        kept.push(item);
      }
    }

    return { status: "success", output: [kept] };
  },
};
