import { describe, expect, test } from "bun:test";
import { getByPath, omitByPath } from "./path-utils.ts";

describe("getByPath", () => {
  test("reads a nested dot-notation path", () => {
    expect(getByPath({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
  });

  test("returns undefined for a missing path", () => {
    expect(getByPath({ a: 1 }, "a.b.c")).toBeUndefined();
  });

  test("returns undefined for a path segment that only exists on Object.prototype", () => {
    expect(getByPath({ name: "Alice" }, "constructor")).toBeUndefined();
    expect(getByPath({ name: "Alice" }, "toString")).toBeUndefined();
    expect(getByPath({ name: "Alice" }, "hasOwnProperty")).toBeUndefined();
  });

  test("still returns an explicitly-set value for one of those names", () => {
    expect(getByPath({ constructor: "custom" }, "constructor")).toBe("custom");
  });
});

describe("omitByPath", () => {
  test("removes a top-level key", () => {
    expect(omitByPath({ a: 1, b: 2 }, "a")).toEqual({ b: 2 });
  });

  test("removes a nested key without mutating the original", () => {
    const source = { a: { b: 1, c: 2 } };
    const result = omitByPath(source, "a.b");
    expect(result).toEqual({ a: { c: 2 } });
    expect(source).toEqual({ a: { b: 1, c: 2 } });
  });

  test("leaves the object untouched when a prototype-only segment is targeted", () => {
    expect(omitByPath({ name: "Alice" }, "constructor.foo")).toEqual({
      name: "Alice",
    });
  });
});
