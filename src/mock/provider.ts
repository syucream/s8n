import type { MockLookup } from "../nodes/types.ts";

/**
 * Mock data is a flat `{ [mockKey]: value }` JSON object. `mockKey` is
 * normally a node name (optionally suffixed with `#<itemIndex>` for
 * per-item HTTP Request responses); see each builtin node for its
 * exact convention.
 */
export function createMockLookup(
  mocksData: Record<string, unknown>,
): MockLookup {
  return {
    // `Object.hasOwn` guard: a node legitimately named "constructor",
    // "toString", etc. would otherwise resolve to an inherited
    // Object.prototype member via plain bracket access instead of
    // undefined, silently corrupting the mock instead of requesting one.
    get: (mockKey: string) =>
      Object.hasOwn(mocksData, mockKey) ? mocksData[mockKey] : undefined,
  };
}

export const emptyMockLookup: MockLookup = { get: () => undefined };

/** Looks up a per-item mock (`<nodeName>#<itemIndex>`), falling back to a shared one keyed by node name alone. */
export function lookupItemMock(
  mocks: MockLookup,
  nodeName: string,
  itemIndex: number,
): unknown {
  return mocks.get(`${nodeName}#${itemIndex}`) ?? mocks.get(nodeName);
}
