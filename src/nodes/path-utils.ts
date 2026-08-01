/** Reads a dot-notation path (`"a.b.c"`) out of a nested object, mirroring n8n's default (non-disabled) dot notation behavior. */
export function getByPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === undefined || acc === null || typeof acc !== "object")
      return undefined;
    if (!Object.hasOwn(acc, key)) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, source);
}

/** Removes a dot-notation path from a shallow-cloned copy of the object; leaves the original untouched. */
export function omitByPath(
  source: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const segments = path.split(".");
  if (segments.length === 1) {
    const { [path]: _omitted, ...rest } = source;
    return rest;
  }
  const [head, ...tail] = segments;
  if (
    !head ||
    !Object.hasOwn(source, head) ||
    typeof source[head] !== "object" ||
    source[head] === null
  ) {
    return { ...source };
  }
  return {
    ...source,
    [head]: omitByPath(source[head] as Record<string, unknown>, tail.join(".")),
  };
}
