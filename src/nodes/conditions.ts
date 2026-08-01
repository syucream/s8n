/**
 * Shared condition evaluation for If/Switch/Filter-style nodes.
 *
 * Two condition shapes are accepted, both resolved (expressions already
 * evaluated) by the time they reach this module:
 *
 * 1. Simplified: a boolean expression string (from `={{ ... }}`), e.g.
 *    `true` / `false` / any resolved JS value (truthy/falsy).
 * 2. Structured: `{ leftValue, rightValue, operator: { operation } }`,
 *    a pragmatic subset of the structured condition builders found in
 *    node-based automation tools, covering the common comparison ops.
 */

export interface StructuredCondition {
  leftValue?: unknown;
  rightValue?: unknown;
  operator?: {
    operation?: string;
    /**
     * Real n8n's Filter/If v2 conditions are type-driven: `operator.type`
     * (`string`/`number`/`dateTime`/`boolean`/...) affects every operator
     * (see `executeFilterCondition` in
     * `packages/workflow/src/node-parameters/filter-parameter.ts`) - e.g.
     * string operators additionally lowercase both sides when
     * `caseSensitive` is off, and a genuine type mismatch throws a
     * `FilterError` rather than silently coercing. s8n only implements the
     * narrower `equals`/`notEquals` slice: coerce both sides per `type`
     * (see `coerceToType`), then compare with strict `===`/`!==` instead of
     * JS's loose `==` - `caseSensitive` and type-mismatch errors are NOT
     * implemented. Other operators (`gt`/`lt` via `Number()`, etc.) already
     * had their own per-operation coercion before `type` existed and don't
     * read it. Optional: s8n's own shorthand condition authoring has no
     * type field and keeps the old loose-compare fallback for backward
     * compatibility.
     */
    type?: string;
  };
}

export type ResolvedCondition = boolean | StructuredCondition | unknown;

function isStructuredCondition(value: unknown): value is StructuredCondition {
  return (
    typeof value === "object" &&
    value !== null &&
    ("operator" in value || "leftValue" in value || "rightValue" in value)
  );
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" &&
      value !== null &&
      Object.keys(value).length === 0)
  );
}

/**
 * Real n8n's regex operators accept both a bare pattern ("^foo") and the
 * conventional `/pattern/flags` delimited form (e.g. `/^foo/i`). Passing the
 * delimited form straight to `new RegExp()` would compile the slashes and
 * flag letters as literal pattern text instead of stripping them - this
 * parses the delimited form when present, falling back to treating the
 * whole string as a bare pattern otherwise.
 */
function parseRegexPattern(raw: string): RegExp {
  const delimited = /^\/(.*)\/([a-z]*)$/s.exec(raw);
  if (delimited?.[1] !== undefined) {
    return new RegExp(delimited[1], delimited[2]);
  }
  return new RegExp(raw);
}

function toDateValue(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/**
 * Coerces a value to the declared comparison type, matching real n8n's
 * `parseSingleFilterValue` (`packages/workflow/src/node-parameters/filter-parameter.ts`)
 * closely enough for `equals`/`notEquals`: values are converted to a common
 * type first, then compared with strict `===`/`!==` - never JS's loose `==`,
 * which has its own well-known quirks (`"" == 0`, `[] == false`, ...).
 */
function coerceToType(value: unknown, type: string): unknown {
  switch (type) {
    case "string":
      return String(value ?? "");
    case "number":
      return Number(value);
    case "boolean":
      return Boolean(value);
    case "dateTime":
      return toDateValue(value);
    default:
      return value;
  }
}

/**
 * Mirrors the operation vocabulary of n8n's real Filter condition component
 * (`operator.operation` in `FilterConditionValue`), plus a few aliases kept
 * for backward compatibility with s8n's own shorthand condition authoring.
 */
function evaluateOperation(
  operation: string,
  left: unknown,
  right: unknown,
  type?: string,
): boolean {
  switch (operation) {
    case "equal":
    case "equals":
      if (type) return coerceToType(left, type) === coerceToType(right, type);
      // biome-ignore lint/suspicious/noDoubleEquals: intentional loose compare for cross-type literals (e.g. "1" == 1)
      return left == right;
    case "notEqual":
    case "notEquals":
      if (type) return coerceToType(left, type) !== coerceToType(right, type);
      // biome-ignore lint/suspicious/noDoubleEquals: see above
      return left != right;
    case "contains":
      return String(left).includes(String(right));
    case "notContains":
      return !String(left).includes(String(right));
    case "startsWith":
      return String(left).startsWith(String(right));
    case "notStartsWith":
      return !String(left).startsWith(String(right));
    case "endsWith":
      return String(left).endsWith(String(right));
    case "notEndsWith":
      return !String(left).endsWith(String(right));
    case "regex":
      return parseRegexPattern(String(right)).test(String(left));
    case "notRegex":
      return !parseRegexPattern(String(right)).test(String(left));
    case "gt":
    case "larger":
      return Number(left) > Number(right);
    case "gte":
    case "largerEqual":
      return Number(left) >= Number(right);
    case "lt":
    case "smaller":
      return Number(left) < Number(right);
    case "lte":
    case "smallerEqual":
      return Number(left) <= Number(right);
    case "after":
      return toDateValue(left) > toDateValue(right);
    case "afterOrEquals":
      return toDateValue(left) >= toDateValue(right);
    case "before":
      return toDateValue(left) < toDateValue(right);
    case "beforeOrEquals":
      return toDateValue(left) <= toDateValue(right);
    case "lengthEquals":
      return Array.isArray(left) && left.length === Number(right);
    case "lengthNotEquals":
      return Array.isArray(left) && left.length !== Number(right);
    case "exists":
      return left !== undefined && left !== null;
    case "notExists":
      return left === undefined || left === null;
    case "true":
    case "isTrue":
      return Boolean(left) === true;
    case "false":
    case "isFalse":
      return Boolean(left) === false;
    case "empty":
    case "isEmpty":
      return isEmptyValue(left);
    case "notEmpty":
    case "isNotEmpty":
      return !isEmptyValue(left);
    default:
      throw new Error(`Unsupported comparison operator: "${operation}"`);
  }
}

export function evaluateCondition(condition: ResolvedCondition): boolean {
  if (isStructuredCondition(condition)) {
    const operation = condition.operator?.operation ?? "equal";
    return evaluateOperation(
      operation,
      condition.leftValue,
      condition.rightValue,
      condition.operator?.type,
    );
  }
  return Boolean(condition);
}

export function evaluateConditions(
  conditions: ResolvedCondition[],
  combinator: "and" | "or" = "and",
): boolean {
  if (conditions.length === 0) return true;
  return combinator === "or"
    ? conditions.some((c) => evaluateCondition(c))
    : conditions.every((c) => evaluateCondition(c));
}

/**
 * Extracts a condition list + combinator from a node's already
 * expression-resolved parameters. Accepts the s8n shorthand
 * (`conditions: [...]` or a single `condition`) as well as a structured
 * `{ conditions: [...], combinator }` shape.
 */
export function extractConditionList(resolvedParams: Record<string, unknown>): {
  conditions: ResolvedCondition[];
  combinator: "and" | "or";
} {
  const raw = resolvedParams.conditions;
  let combinator: "and" | "or" =
    resolvedParams.combinator === "or" ? "or" : "and";

  if (Array.isArray(raw)) {
    return { conditions: raw, combinator };
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (obj.combinator === "or") combinator = "or";
    if (Array.isArray(obj.conditions)) {
      return { conditions: obj.conditions, combinator };
    }
  }
  if ("condition" in resolvedParams) {
    return { conditions: [resolvedParams.condition], combinator };
  }
  return { conditions: [], combinator };
}
