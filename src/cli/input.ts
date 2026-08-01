import type { Item } from "../schema/item.ts";
import { toItems } from "../schema/item.ts";

/** Accepts either a single JSON object (one item) or an array of objects (many items). */
export function parseInputToItems(raw: unknown): Item[] {
  if (Array.isArray(raw)) {
    return toItems(
      raw.map((entry) => {
        if (typeof entry !== "object" || entry === null) {
          throw new Error(
            "Every element in the --input array must be an object",
          );
        }
        return entry as Record<string, unknown>;
      }),
    );
  }
  if (typeof raw === "object" && raw !== null) {
    return toItems([raw as Record<string, unknown>]);
  }
  throw new Error("--input JSON must be an object or an array of objects");
}
