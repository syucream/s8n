/**
 * A best-effort description of what mock data a node needs, handed back to
 * the calling AI so it can generate a matching dummy JSON value. This is
 * intentionally loose (not a formal JSON Schema) - see `field-hints.ts`.
 */
export interface MockShapeHint {
  description: string;
  suggestedFields: string[];
  example: Record<string, unknown>;
}

export function buildMockShapeHint(
  description: string,
  suggestedFields: string[],
  exampleOverride?: Record<string, unknown>,
): MockShapeHint {
  if (exampleOverride) {
    return { description, suggestedFields, example: exampleOverride };
  }
  const example: Record<string, unknown> = {};
  for (const field of suggestedFields.slice(0, 8)) {
    example[field] = "<dummy value>";
  }
  if (suggestedFields.length === 0) {
    example.exampleField = "<dummy value>";
  }
  return { description, suggestedFields, example };
}
