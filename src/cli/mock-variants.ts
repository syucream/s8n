/**
 * Mock variants for determinism exploration (`s8n run --repeat N`).
 *
 * A mock file can declare `$variants: { "<nodeName>": [v1, v2, ...] }`.
 * Each repeat iteration substitutes the variant at
 * `iteration % variants.length` for that node, so an author can model "this
 * LLM output could be any of these shapes" and ask whether the workflow
 * stays well-behaved across all of them. Normal single-valued mocks are
 * untouched.
 */

/** Reads the `$variants` map, returning per-node variant arrays. */
export function extractVariantSets(
  mocks: Record<string, unknown>,
): Record<string, unknown[]> {
  const raw = mocks.$variants;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).flatMap(([node, list]) =>
      Array.isArray(list) && list.length > 0 ? [[node, list]] : [],
    ),
  );
}

/** Builds the iteration-specific mock map, substituting one variant per node. */
export function applyVariantIteration(
  mocks: Record<string, unknown>,
  iteration: number,
): Record<string, unknown> {
  const variants = extractVariantSets(mocks);
  if (Object.keys(variants).length === 0) return mocks;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mocks)) {
    if (key === "$variants") continue;
    result[key] = value;
  }
  for (const [node, list] of Object.entries(variants)) {
    result[node] = list[iteration % list.length];
  }
  return result;
}
