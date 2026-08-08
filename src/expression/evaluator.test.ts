import { describe, expect, test } from "bun:test";
import { buildExpressionScope } from "./context.ts";
import {
  evaluateExpressionString,
  isExpression,
  resolveParameterValue,
} from "./evaluator.ts";

function scopeFor(json: Record<string, unknown>) {
  return buildExpressionScope({
    currentItem: { json },
    itemIndex: 0,
    inputItems: [{ json }],
    currentNodeName: "Node",
    workflowName: "wf",
    nodeOutputs: new Map(),
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
}

describe("isExpression", () => {
  test("only strings prefixed with = are expressions", () => {
    expect(isExpression("=foo")).toBe(true);
    expect(isExpression("foo")).toBe(false);
    expect(isExpression(42)).toBe(false);
  });
});

describe("evaluateExpressionString", () => {
  test("a single full {{ }} block preserves the evaluated type", () => {
    const result = evaluateExpressionString(
      "={{$json.amount}}",
      scopeFor({ amount: 42 }),
    );
    expect(result).toBe(42);
  });

  test("mixed literal text stringifies interpolated values", () => {
    const result = evaluateExpressionString(
      "=Hello, {{$json.name}}!",
      scopeFor({ name: "Alice" }),
    );
    expect(result).toBe("Hello, Alice!");
  });

  test("a plain literal (no {{ }}) after the = prefix returns as-is", () => {
    const result = evaluateExpressionString("=plain text", scopeFor({}));
    expect(result).toBe("plain text");
  });

  test("throws a descriptive error for invalid expressions", () => {
    expect(() =>
      evaluateExpressionString("={{ ) invalid ( }}", scopeFor({})),
    ).toThrow();
  });

  test("does not expose host I/O globals to expressions", () => {
    expect(
      evaluateExpressionString(
        "={{ [typeof fetch, typeof process, typeof Bun, typeof require, typeof globalThis.fetch] }}",
        scopeFor({}),
      ),
    ).toEqual([
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
    ]);
  });

  test("supports n8n's parseJson string helper used by published workflows", () => {
    const scope = scopeFor({
      result: { message: '{"title":"Fix checkout"}' },
    });
    expect(
      evaluateExpressionString(
        "={{ $json.result.message.parseJson().title }}",
        scope,
      ),
    ).toBe("Fix checkout");
  });

  test("supports n8n's object keys helper used by workflow expressions", () => {
    expect(
      evaluateExpressionString(
        "={{ $json.profile.keys().sort() }}",
        scopeFor({ profile: { role: "engineer", level: 2 } }),
      ),
    ).toEqual(["level", "role"]);
  });

  test("$now is a Luxon DateTime supporting real n8n date arithmetic", () => {
    const result = evaluateExpressionString(
      "={{$now.minus({days: 7}).toFormat('yyyy-MM-dd')}}",
      scopeFor({}),
    );
    expect(result).toBe("2025-12-25");
  });

  test("exposes Luxon DateTime for explicit parsing used by n8n workflows", () => {
    expect(
      evaluateExpressionString(
        "={{ DateTime.fromISO($json.startDate).toISODate() }}",
        scopeFor({ startDate: "2026-08-01T00:00:00.000Z" }),
      ),
    ).toBe("2026-08-01");
  });

  test("supports n8n's DateTime format alias used by published workflows", () => {
    expect(
      evaluateExpressionString("={{$now.format('yyyyMMdd')}}", scopeFor({})),
    ).toBe("20260101");
  });

  test("$today is start-of-day and DateTimes interpolate as ISO text, not JSON", () => {
    const result = evaluateExpressionString(
      "=Today: {{$today.toISODate()}}",
      scopeFor({}),
    );
    expect(result).toBe("Today: 2026-01-01");
  });
});

describe("resolveParameterValue", () => {
  test("leaves non-expression values untouched", () => {
    expect(resolveParameterValue("plain", scopeFor({}))).toBe("plain");
    expect(resolveParameterValue(42, scopeFor({}))).toBe(42);
  });

  test("recursively resolves arrays and objects", () => {
    const result = resolveParameterValue(
      { fields: [{ name: "x", value: "={{$json.a + $json.b}}" }] },
      scopeFor({ a: 1, b: 2 }),
    );
    expect(result).toEqual({ fields: [{ name: "x", value: 3 }] });
  });
});
