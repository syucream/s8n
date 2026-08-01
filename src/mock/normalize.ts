import type { Item } from "../schema/item.ts";

/** Turns a raw mock value (object, array of objects, or primitive) into items. */
export function normalizeMockToItems(
  mockValue: unknown,
  pairedItemIndex: number,
): Item[] {
  const entries = Array.isArray(mockValue) ? mockValue : [mockValue];
  return entries.map((entry) => ({
    json:
      entry !== null && typeof entry === "object"
        ? (entry as Record<string, unknown>)
        : { value: entry },
    pairedItem: { item: pairedItemIndex },
  }));
}
