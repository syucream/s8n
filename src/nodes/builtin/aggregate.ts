import { resolveParameterValue } from "../../expression/evaluator.ts";
import { getByPath } from "../path-utils.ts";
import type { NodeExecutor } from "../types.ts";

interface FieldToAggregate {
  fieldToAggregate: string;
  renameField: boolean;
  outputFieldName: string;
}

function extractFields(
  resolvedParams: Record<string, unknown>,
): FieldToAggregate[] {
  const collection = resolvedParams.fieldsToAggregate as
    | { fieldToAggregate?: unknown[] }
    | undefined;
  if (!collection || !Array.isArray(collection.fieldToAggregate)) return [];
  return collection.fieldToAggregate
    .filter(
      (f): f is Record<string, unknown> => typeof f === "object" && f !== null,
    )
    .map((f) => ({
      fieldToAggregate: String(f.fieldToAggregate ?? ""),
      renameField: f.renameField === true,
      outputFieldName: String(f.outputFieldName ?? ""),
    }))
    .filter((f) => f.fieldToAggregate.length > 0);
}

function filterFields(
  json: Record<string, unknown>,
  include: string,
  list: string[],
): Record<string, unknown> {
  if (include === "specifiedFields") {
    const result: Record<string, unknown> = {};
    for (const key of list) if (key in json) result[key] = json[key];
    return result;
  }
  if (include === "allFieldsExcept") {
    const result = { ...json };
    for (const key of list) delete result[key];
    return result;
  }
  return json;
}

/**
 * Aggregate: collapses many items into one. Field names verified against
 * `packages/nodes-base/nodes/Transform/Aggregate/Aggregate.node.ts`:
 * `parameters.aggregate` (`"aggregateIndividualFields"` default |
 * `"aggregateAllItemData"`), `parameters.fieldsToAggregate.fieldToAggregate[]`
 * (`{fieldToAggregate, renameField, outputFieldName}`),
 * `parameters.destinationFieldName` (default `"data"`), `parameters.include`
 * (`"allFields"` default | `"specifiedFields"` | `"allFieldsExcept"`),
 * `parameters.fieldsToInclude` / `fieldsToExclude` (comma-separated).
 * `options.keepMissing` (default false): when false, a missing/null field
 * value is skipped entirely (not pushed as `null`) and `null` entries
 * inside an array value are filtered out - matches real n8n exactly.
 * `options.mergeLists`/`includeBinaries` are not implemented.
 */
export const aggregateExecutor: NodeExecutor = {
  type: "n8n-nodes-base.aggregate",
  execute: ({ node, inputItems, buildScope }) => {
    const scope = buildScope(inputItems[0] ?? { json: {} }, 0, inputItems);
    const resolvedParams = resolveParameterValue(
      node.parameters,
      scope,
    ) as Record<string, unknown>;
    const mode = String(
      resolvedParams.aggregate ?? "aggregateIndividualFields",
    );

    if (mode === "aggregateAllItemData") {
      const destinationFieldName = String(
        resolvedParams.destinationFieldName ?? "data",
      );
      const include = String(resolvedParams.include ?? "allFields");
      const fieldsList = String(
        resolvedParams.include === "specifiedFields"
          ? resolvedParams.fieldsToInclude
          : (resolvedParams.fieldsToExclude ?? ""),
      )
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const collected = inputItems.map((item) =>
        filterFields(item.json, include, fieldsList),
      );
      return {
        status: "success",
        output: [
          [
            {
              json: { [destinationFieldName]: collected },
              pairedItem: { item: 0 },
            },
          ],
        ],
      };
    }

    const fields = extractFields(resolvedParams);
    if (fields.length === 0) {
      return {
        status: "error",
        message: `Aggregate node "${node.name}" has no field to aggregate`,
      };
    }

    const options = resolvedParams.options as
      | Record<string, unknown>
      | undefined;
    const keepMissing = options?.keepMissing === true;

    const outputJson: Record<string, unknown> = {};
    for (const field of fields) {
      const outputName =
        field.renameField && field.outputFieldName
          ? field.outputFieldName
          : field.fieldToAggregate;
      const collected: unknown[] = [];
      for (const item of inputItems) {
        let value = getByPath(item.json, field.fieldToAggregate);
        if (!keepMissing) {
          if (Array.isArray(value)) {
            value = value.filter((entry) => entry !== null);
          } else if (value === null || value === undefined) {
            continue;
          }
        }
        collected.push(value);
      }
      outputJson[outputName] = collected;
    }

    return {
      status: "success",
      output: [[{ json: outputJson, pairedItem: { item: 0 } }]],
    };
  },
};
