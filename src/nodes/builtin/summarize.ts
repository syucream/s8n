import { resolveParameterValue } from "../../expression/evaluator.ts";
import type { Item } from "../../schema/item.ts";
import { getByPath } from "../path-utils.ts";
import type { NodeExecutor } from "../types.ts";

interface SummaryField {
  aggregation: string;
  field: string;
  includeEmpty: boolean;
  separateBy?: string;
  customSeparator?: string;
}

function extractFields(p: Record<string, unknown>): SummaryField[] {
  const collection = p.fieldsToSummarize as { values?: unknown[] } | undefined;
  if (!collection || !Array.isArray(collection.values)) return [];
  return collection.values
    .filter(
      (v): v is Record<string, unknown> => typeof v === "object" && v !== null,
    )
    .map((v) => ({
      aggregation: String(v.aggregation ?? "count"),
      field: String(v.field ?? ""),
      includeEmpty: v.includeEmpty === true,
      separateBy: typeof v.separateBy === "string" ? v.separateBy : undefined,
      customSeparator:
        typeof v.customSeparator === "string" ? v.customSeparator : undefined,
    }));
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/**
 * Real n8n always prefixes the output key with the aggregation's display
 * name (verified against `AggregationDisplayNames` + the `${prefix}${field}`
 * key construction in `utils.ts`'s `aggregateData`) - it's not just for
 * collision avoidance when the same field is aggregated twice, every
 * aggregation gets prefixed unconditionally.
 */
const AGGREGATION_OUTPUT_PREFIX: Record<string, string> = {
  append: "appended_",
  average: "average_",
  concatenate: "concatenated_",
  count: "count_",
  countUnique: "unique_count_",
  max: "max_",
  min: "min_",
  sum: "sum_",
};

function normalizeFieldName(fieldName: string): string {
  return fieldName.replace(/[[\]"]/g, "").replace(/[ .]/g, "_");
}

function outputKeyFor(field: SummaryField): string {
  const prefix = AGGREGATION_OUTPUT_PREFIX[field.aggregation] ?? "";
  return normalizeFieldName(`${prefix}${field.field}`);
}

/**
 * Real n8n's `separateBy` option values are the literal separator
 * characters themselves (`","`, `", "`, `"\n"`, `""`, `" "`), not symbolic
 * names - only `"other"` is a sentinel, resolved via `customSeparator`
 * (verified against `Summarize.node.ts`'s `separateBy` option list).
 */
function separator(field: SummaryField): string {
  if (field.separateBy === "other") return field.customSeparator ?? "";
  return field.separateBy ?? ",";
}

function aggregate(field: SummaryField, rawValues: unknown[]): unknown {
  const values = field.includeEmpty
    ? rawValues
    : rawValues.filter((v) => !isEmptyValue(v));
  const numeric = values.map(Number).filter((n) => !Number.isNaN(n));
  switch (field.aggregation) {
    case "count":
      return values.length;
    case "countUnique":
      return new Set(values.map((v) => JSON.stringify(v))).size;
    case "sum":
      return numeric.reduce((a, b) => a + b, 0);
    case "average":
      return numeric.length > 0
        ? numeric.reduce((a, b) => a + b, 0) / numeric.length
        : 0;
    case "min":
      return numeric.length > 0 ? Math.min(...numeric) : undefined;
    case "max":
      return numeric.length > 0 ? Math.max(...numeric) : undefined;
    case "concatenate":
      return values
        .map((v) => (v === undefined ? "undefined" : String(v)))
        .join(separator(field));
    case "append":
      return values;
    default:
      return undefined;
  }
}

/**
 * Summarize: SQL-`GROUP BY`-style aggregation. Field names verified against
 * `packages/nodes-base/nodes/Transform/Summarize/Summarize.node.ts` and
 * `utils.ts`: `parameters.fieldsToSummarize.values[]` (`{aggregation, field,
 * includeEmpty?, separateBy?, customSeparator?}`), `parameters.fieldsToSplitBy`
 * (comma-separated group-by field names, used *as-is* with no bracket/quote
 * stripping - matching real n8n exactly, including its quirks: a value like
 * `[\"foo\"]` is a literal, non-matching split key in both implementations).
 * `includeEmpty` (default false) keeps empty/undefined values in
 * append/concatenate instead of filtering them out first. Output keys are
 * always `${aggregationDisplayPrefix}${field}` (e.g. a `concatenate`
 * aggregation on field `name` writes to `concatenated_name`, never bare
 * `name`) - this surprised the s8n author on first read, but it's
 * unconditional in real n8n, not just a same-field collision fallback.
 */
export const summarizeExecutor: NodeExecutor = {
  type: "n8n-nodes-base.summarize",
  execute: ({ node, inputItems, buildScope }) => {
    const scope = buildScope(inputItems[0] ?? { json: {} }, 0, inputItems);
    const p = resolveParameterValue(node.parameters, scope) as Record<
      string,
      unknown
    >;
    const fields = extractFields(p);
    const splitByFields = String(p.fieldsToSplitBy ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (fields.length === 0) {
      return {
        status: "error",
        message: `Summarize node "${node.name}" has no field to aggregate`,
      };
    }

    const groups = new Map<
      string,
      { keyJson: Record<string, unknown>; items: Item[] }
    >();
    for (const item of inputItems) {
      const keyJson: Record<string, unknown> = {};
      for (const f of splitByFields) keyJson[f] = getByPath(item.json, f);
      const key = JSON.stringify(keyJson);
      const group = groups.get(key) ?? { keyJson, items: [] };
      group.items.push(item);
      groups.set(key, group);
    }
    if (groups.size === 0) groups.set("", { keyJson: {}, items: [] });

    const outputItems: Item[] = [...groups.values()].map((group, index) => {
      const json: Record<string, unknown> = { ...group.keyJson };
      for (const field of fields) {
        const values = group.items.map((item) =>
          getByPath(item.json, field.field),
        );
        json[outputKeyFor(field)] = aggregate(field, values);
      }
      return { json, pairedItem: { item: index } };
    });

    return { status: "success", output: [outputItems] };
  },
};
