import { describe, expect, test } from "bun:test";
import { createMockLookup, lookupItemMock } from "./provider.ts";

describe("createMockLookup", () => {
  test("returns undefined for a key that isn't present, even one shadowing an Object.prototype member", () => {
    const mocks = createMockLookup({ Foo: { ok: true } });
    expect(mocks.get("constructor")).toBeUndefined();
    expect(mocks.get("toString")).toBeUndefined();
    expect(mocks.get("hasOwnProperty")).toBeUndefined();
  });

  test("still returns an explicitly-set value for one of those names", () => {
    const mocks = createMockLookup({ constructor: { ok: true } });
    expect(mocks.get("constructor")).toEqual({ ok: true });
  });
});

describe("lookupItemMock", () => {
  test("prefers the per-item key over the shared node-name key", () => {
    const mocks = createMockLookup({ Foo: "shared", "Foo#0": "per-item" });
    expect(lookupItemMock(mocks, "Foo", 0)).toBe("per-item");
    expect(lookupItemMock(mocks, "Foo", 1)).toBe("shared");
  });
});
