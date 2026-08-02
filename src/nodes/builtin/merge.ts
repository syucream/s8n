import { resolveParameterValue } from "../../expression/evaluator.ts";
import type { Item } from "../../schema/item.ts";
import { getByPath } from "../path-utils.ts";
import type { NodeExecutor } from "../types.ts";

interface FieldPair {
  field1: string;
  field2: string;
}

function extractFieldPairs(
  resolvedParams: Record<string, unknown>,
): FieldPair[] {
  const mergeByFields = resolvedParams.mergeByFields as
    | { values?: unknown[] }
    | undefined;
  if (!mergeByFields || !Array.isArray(mergeByFields.values)) return [];
  return mergeByFields.values
    .filter(
      (v): v is Record<string, unknown> => typeof v === "object" && v !== null,
    )
    .map((v) => ({
      field1: String(v.field1 ?? ""),
      field2: String(v.field2 ?? ""),
    }))
    .filter((p) => p.field1.length > 0 && p.field2.length > 0);
}

function combineByPosition(inputSlots: Item[][]): Item[] {
  const maxLength = Math.max(0, ...inputSlots.map((slot) => slot.length));
  const combined: Item[] = [];
  for (let i = 0; i < maxLength; i++) {
    let json: Record<string, unknown> = {};
    for (const slot of inputSlots) {
      const entry = slot[i];
      if (entry) json = { ...json, ...entry.json };
    }
    combined.push({ json, pairedItem: { item: i } });
  }
  return combined;
}

function combineAll(inputSlots: Item[][]): Item[] {
  let combinations: Item[] = [{ json: {} }];
  for (const slot of inputSlots) {
    if (slot.length === 0) return [];
    combinations = combinations.flatMap((combined, index) =>
      slot.map((item) => ({
        json: { ...combined.json, ...item.json },
        pairedItem: { item: index },
      })),
    );
  }
  return combinations;
}

/** Inner-join style match on the configured field pairs (real n8n also supports outer-join modes; not implemented here). */
function combineByFields(
  inputSlots: Item[][],
  fieldPairs: FieldPair[],
): Item[] {
  const [left, right] = inputSlots;
  if (!left || !right || fieldPairs.length === 0)
    return combineByPosition(inputSlots);

  const combined: Item[] = [];
  left.forEach((leftItem, index) => {
    const match = right.find((rightItem) =>
      fieldPairs.every(
        (pair) =>
          getByPath(leftItem.json, pair.field1) ===
          getByPath(rightItem.json, pair.field2),
      ),
    );
    if (match) {
      combined.push({
        json: { ...leftItem.json, ...match.json },
        pairedItem: { item: index },
      });
    }
  });
  return combined;
}

/**
 * Merge: combines items from multiple input slots. `parameters.mode`:
 * - `append` (default): concatenates all input slots' items in order.
 * - `combine`: joins slots per `parameters.combineBy`:
 *   - `combineByFields` (real n8n default): inner-join on
 *     `parameters.mergeByFields.values[]` ({field1, field2} pairs), 2 inputs only.
 *   - `combineByPosition`: zips items positionally, shallow-merging json.
 *   - unset `combineBy` also falls back to positional zipping.
 * - `chooseBranch`: waits for all configured inputs, then passes through the
 *   selected input (`parameters.output`, default `input1`).
 * Unimplemented `combineBy` values (`combineBySql`) return an explicit error
 * rather than silently falling back to append.
 */
export const mergeExecutor: NodeExecutor = {
  type: "n8n-nodes-base.merge",
  execute: ({ node, inputSlots, buildScope }) => {
    const firstSlotItems = inputSlots[0] ?? [];
    const scope = buildScope(
      firstSlotItems[0] ?? { json: {} },
      0,
      firstSlotItems,
    );
    const resolvedParams = resolveParameterValue(
      node.parameters,
      scope,
    ) as Record<string, unknown>;
    const mode = String(resolvedParams.mode ?? "append");

    if (mode === "combine") {
      const combineBy = String(resolvedParams.combineBy ?? "combineByFields");
      if (combineBy === "combineByFields") {
        const fieldPairs = extractFieldPairs(resolvedParams);
        return {
          status: "success",
          output: [combineByFields(inputSlots, fieldPairs)],
        };
      }
      if (combineBy === "combineByPosition") {
        return { status: "success", output: [combineByPosition(inputSlots)] };
      }
      if (combineBy === "combineAll") {
        return { status: "success", output: [combineAll(inputSlots)] };
      }
      return {
        status: "error",
        message: `Merge node "${node.name}" uses unsupported combineBy="${combineBy}" (for example, combineBySql)`,
      };
    }

    if (mode === "chooseBranch") {
      const selected = String(resolvedParams.output ?? "input1");
      const match = selected.match(/^(?:input)?(\d+)$/i);
      const oneBasedIndex = match ? Number(match[1]) : 1;
      const slotIndex = Math.max(0, oneBasedIndex - 1);
      return { status: "success", output: [inputSlots[slotIndex] ?? []] };
    }

    if (mode !== "append") {
      return {
        status: "error",
        message: `Merge node "${node.name}" uses unsupported mode="${mode}"`,
      };
    }

    const appended = inputSlots.flat();
    return { status: "success", output: [appended] };
  },
};
