import type { ExpressionScope } from "./context.ts";
import { SAFE_RUNTIME_GLOBALS } from "./safe-globals.ts";

/**
 * s8n's expression convention (independent design, not copied from any
 * third-party tool): a parameter value is treated as an expression only when
 * the raw string starts with "=". Everything after that prefix may contain
 * one or more `{{ ... }}` interpolation blocks evaluated as JavaScript
 * against an `ExpressionScope`.
 *
 * - If the whole expression body is exactly one `{{ ... }}` block, the
 *   evaluated value is returned as-is (preserving type: object, number...).
 * - Otherwise every `{{ ... }}` block is stringified and substituted into
 *   the surrounding literal text.
 *
 * Expressions run via `new Function` in a local, single-user CLI. Common host
 * I/O globals are shadowed to prevent accidental external access, but this is
 * not a security sandbox for hostile JavaScript. s8n must only evaluate
 * trusted workflow definitions unless the entire process is OS-isolated.
 */

const INTERPOLATION_RE = /\{\{([\s\S]*?)\}\}/g;

export class ExpressionError extends Error {
  constructor(
    public readonly expression: string,
    cause: unknown,
  ) {
    super(
      `Failed to evaluate expression: "${expression}" (${String((cause as Error)?.message ?? cause)})`,
    );
    this.name = "ExpressionError";
  }
}

export function isExpression(raw: unknown): raw is string {
  return typeof raw === "string" && raw.startsWith("=");
}

function runJs(expr: string, scope: ExpressionScope): unknown {
  const guardedScope = { ...scope, ...SAFE_RUNTIME_GLOBALS };
  const argNames = Object.keys(guardedScope);
  const argValues = Object.values(guardedScope);
  try {
    // n8n adds helpers to primitive values. Keep the common JSON helper local
    // to expression evaluation instead of mutating global prototypes.
    const compatibleExpr = expr
      .trim()
      .replace(/;$/, "")
      .replace(
        /((?:\$json|\$node(?:\[[^\]]+\])?)(?:\??\.[A-Za-z_$][\w$]*|\[[^\]]+\])+?)\.parseJson\(\)/g,
        "JSON.parse($1)",
      )
      .replace(
        /(\$json(?:\??\.[A-Za-z_$][\w$]*|\[[^\]]+\])*)\.keys\(\)/g,
        "Object.keys($1)",
      )
      .replace(/(\$now|\$today)\.format\(/g, "$1.toFormat(");
    const fn = new Function(
      ...argNames,
      `"use strict"; return (${compatibleExpr});`,
    );
    return fn(...argValues);
  } catch (cause) {
    throw new ExpressionError(expr, cause);
  }
}

function stringifyForInterpolation(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    // Values with a meaningful custom toString (Luxon DateTime, Date, ...)
    // stringify the way real n8n's template interpolation would (an ISO
    // string), not as a JSON-quoted string; plain objects/arrays still
    // fall back to JSON so the interpolated text stays inspectable.
    const hasCustomToString = value.toString !== Object.prototype.toString;
    return hasCustomToString ? String(value) : JSON.stringify(value);
  }
  return String(value);
}

/** Evaluates a raw `={{ ... }}` expression string against the given scope. */
export function evaluateExpressionString(
  raw: string,
  scope: ExpressionScope,
): unknown {
  const body = raw.slice(1); // strip leading "="
  const matches = [...body.matchAll(INTERPOLATION_RE)];

  if (matches.length === 0) {
    return body;
  }

  const isSingleFullMatch =
    matches.length === 1 && matches[0]?.[0] === body.trim();
  if (isSingleFullMatch) {
    return runJs(matches[0]?.[1] ?? "", scope);
  }

  return body.replace(INTERPOLATION_RE, (_full, exprBody: string) =>
    stringifyForInterpolation(runJs(exprBody, scope)),
  );
}

/**
 * Recursively resolves parameter values: strings prefixed with "=" are
 * evaluated as expressions, arrays/objects are walked, everything else is
 * returned unchanged.
 */
export function resolveParameterValue(
  raw: unknown,
  scope: ExpressionScope,
): unknown {
  if (isExpression(raw)) {
    return evaluateExpressionString(raw, scope);
  }
  if (Array.isArray(raw)) {
    return raw.map((entry) => resolveParameterValue(entry, scope));
  }
  if (raw !== null && typeof raw === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      result[key] = resolveParameterValue(value, scope);
    }
    return result;
  }
  return raw;
}
