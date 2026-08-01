import { describe, expect, test } from "bun:test";
import {
  evaluateCondition,
  evaluateConditions,
  extractConditionList,
} from "./conditions.ts";

describe("evaluateCondition", () => {
  test("evaluates a plain boolean condition by truthiness", () => {
    expect(evaluateCondition(true)).toBe(true);
    expect(evaluateCondition(0)).toBe(false);
    expect(evaluateCondition("non-empty")).toBe(true);
  });

  test("evaluates structured conditions with common operators", () => {
    expect(
      evaluateCondition({
        leftValue: 5,
        rightValue: 5,
        operator: { operation: "equal" },
      }),
    ).toBe(true);
    expect(
      evaluateCondition({
        leftValue: 5,
        rightValue: 6,
        operator: { operation: "equal" },
      }),
    ).toBe(false);
    expect(
      evaluateCondition({
        leftValue: 10,
        rightValue: 5,
        operator: { operation: "gt" },
      }),
    ).toBe(true);
    expect(
      evaluateCondition({
        leftValue: "hello world",
        rightValue: "world",
        operator: { operation: "contains" },
      }),
    ).toBe(true);
    expect(
      evaluateCondition({
        leftValue: undefined,
        operator: { operation: "notExists" },
      }),
    ).toBe(true);
  });

  test("supports the real n8n Filter operation vocabulary (equals/empty/regex/true/false)", () => {
    expect(
      evaluateCondition({ leftValue: "", operator: { operation: "empty" } }),
    ).toBe(true);
    expect(
      evaluateCondition({
        leftValue: "x",
        operator: { operation: "notEmpty" },
      }),
    ).toBe(true);
    expect(
      evaluateCondition({ leftValue: true, operator: { operation: "true" } }),
    ).toBe(true);
    expect(
      evaluateCondition({ leftValue: false, operator: { operation: "false" } }),
    ).toBe(true);
    expect(
      evaluateCondition({
        leftValue: "abc123",
        rightValue: "^abc",
        operator: { operation: "regex" },
      }),
    ).toBe(true);
  });

  test("regex/notRegex parse the /pattern/flags delimited form, not just a bare pattern", () => {
    expect(
      evaluateCondition({
        leftValue: "TEST123",
        rightValue: "/^test/i",
        operator: { operation: "regex" },
      }),
    ).toBe(true);
    expect(
      evaluateCondition({
        leftValue: "TEST123",
        rightValue: "^test",
        operator: { operation: "regex" },
      }),
    ).toBe(false);
    expect(
      evaluateCondition({
        leftValue: "abc123",
        rightValue: "abc123",
        operator: { operation: "regex" },
      }),
    ).toBe(true);
  });

  test("supports notStartsWith/notEndsWith and before/after dateTime operators", () => {
    expect(
      evaluateCondition({
        leftValue: "hello",
        rightValue: "he",
        operator: { operation: "notStartsWith" },
      }),
    ).toBe(false);
    expect(
      evaluateCondition({
        leftValue: "hello",
        rightValue: "world",
        operator: { operation: "notEndsWith" },
      }),
    ).toBe(true);
    expect(
      evaluateCondition({
        leftValue: "2026-01-01",
        rightValue: "2025-01-01",
        operator: { operation: "after" },
      }),
    ).toBe(true);
    expect(
      evaluateCondition({
        leftValue: "2024-01-01",
        rightValue: "2025-01-01",
        operator: { operation: "before" },
      }),
    ).toBe(true);
  });

  test("equals/notEquals with operator.type coerce before a strict compare, matching real n8n's type-driven filter", () => {
    // Real n8n: "5" and 5 both coerce to the number 5, then compare with ===.
    expect(
      evaluateCondition({
        leftValue: "5",
        rightValue: 5,
        operator: { operation: "equals", type: "number" },
      }),
    ).toBe(true);
    // Without a type, s8n's shorthand keeps the old loose `==` fallback.
    expect(
      evaluateCondition({
        leftValue: "5",
        rightValue: 5,
        operator: { operation: "equals" },
      }),
    ).toBe(true);
    // JS's loose `==` would treat "" and 0 as equal; real n8n's type-driven
    // string compare must not, since coercing 0 to string yields "0" !== "".
    expect(
      evaluateCondition({
        leftValue: "",
        rightValue: 0,
        operator: { operation: "equals", type: "string" },
      }),
    ).toBe(false);
    expect(
      evaluateCondition({
        leftValue: "5",
        rightValue: 6,
        operator: { operation: "notEquals", type: "number" },
      }),
    ).toBe(true);
  });

  test("throws on an unknown operation", () => {
    expect(() =>
      evaluateCondition({
        leftValue: 1,
        rightValue: 1,
        operator: { operation: "bogus" },
      }),
    ).toThrow();
  });
});

describe("evaluateConditions", () => {
  test("defaults to AND across all conditions", () => {
    expect(evaluateConditions([true, true])).toBe(true);
    expect(evaluateConditions([true, false])).toBe(false);
  });

  test("supports OR combinator", () => {
    expect(evaluateConditions([false, true], "or")).toBe(true);
    expect(evaluateConditions([false, false], "or")).toBe(false);
  });

  test("an empty condition list passes", () => {
    expect(evaluateConditions([])).toBe(true);
  });
});

describe("extractConditionList", () => {
  test("reads a single `condition` field", () => {
    expect(extractConditionList({ condition: true })).toEqual({
      conditions: [true],
      combinator: "and",
    });
  });

  test("reads a top-level conditions array", () => {
    expect(
      extractConditionList({ conditions: [true, false], combinator: "or" }),
    ).toEqual({
      conditions: [true, false],
      combinator: "or",
    });
  });

  test("reads a nested structured conditions object", () => {
    const result = extractConditionList({
      conditions: { conditions: [true], combinator: "or" },
    });
    expect(result).toEqual({ conditions: [true], combinator: "or" });
  });
});
