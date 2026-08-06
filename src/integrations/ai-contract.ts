import type { WorkflowNode } from "../schema/workflow.ts";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  let source = value.trim();
  const fenced = source.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced?.[1] !== undefined) source = fenced[1].trim();
  try {
    return JSON.parse(source);
  } catch (cause) {
    throw new Error(
      `Structured model output is not valid JSON: ${String((cause as Error)?.message ?? cause)}`,
    );
  }
}

function schemaTypeMatches(value: unknown, expected: string): boolean {
  if (expected === "null") return value === null;
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return asObject(value) !== undefined;
  if (expected === "integer") return Number.isInteger(value);
  return typeof value === expected;
}

function validateSchema(
  value: unknown,
  schema: JsonObject,
  path = "output",
): void {
  for (const keyword of ["oneOf", "anyOf"] as const) {
    const variants = schema[keyword];
    if (!Array.isArray(variants)) continue;
    const matches = variants.filter((variant) => {
      try {
        validateSchema(value, asObject(variant) ?? {}, path);
        return true;
      } catch {
        return false;
      }
    }).length;
    if (
      (keyword === "oneOf" && matches !== 1) ||
      (keyword === "anyOf" && matches < 1)
    )
      throw new Error(`${path} does not match ${keyword}`);
  }
  const expected = schema.type;
  if (typeof expected === "string" && !schemaTypeMatches(value, expected)) {
    throw new Error(`${path} must be ${expected}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    throw new Error(`${path} must be one of ${JSON.stringify(schema.enum)}`);
  if ("const" in schema && !Object.is(value, schema.const))
    throw new Error(`${path} must equal ${JSON.stringify(schema.const)}`);
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      throw new Error(`${path} must be at least ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum)
      throw new Error(`${path} must be at most ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      throw new Error(`${path} is shorter than minLength ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      throw new Error(`${path} is longer than maxLength ${schema.maxLength}`);
    if (
      typeof schema.pattern === "string" &&
      !new RegExp(schema.pattern).test(value)
    )
      throw new Error(`${path} does not match pattern ${schema.pattern}`);
  }

  const objectValue = asObject(value);
  if (objectValue) {
    const required = Array.isArray(schema.required)
      ? schema.required.map(String)
      : [];
    for (const key of required) {
      if (!(key in objectValue)) throw new Error(`${path}.${key} is required`);
    }
    const properties = asObject(schema.properties) ?? {};
    if (schema.additionalProperties === false) {
      const unexpected = Object.keys(objectValue).find(
        (key) => !(key in properties),
      );
      if (unexpected) throw new Error(`${path}.${unexpected} is not allowed`);
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in objectValue && asObject(childSchema))
        validateSchema(
          objectValue[key],
          childSchema as JsonObject,
          `${path}.${key}`,
        );
    }
  }
  if (Array.isArray(value) && asObject(schema.items)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      throw new Error(`${path} has fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      throw new Error(`${path} has more than ${schema.maxItems} items`);
    value.forEach((entry, index) => {
      validateSchema(entry, schema.items as JsonObject, `${path}[${index}]`);
    });
  }
}

function validateExample(
  value: unknown,
  example: unknown,
  requireAll: boolean,
  path = "output",
): void {
  if (Array.isArray(example)) {
    if (!Array.isArray(value)) throw new Error(`${path} must be array`);
    if (example[0] !== undefined)
      value.forEach((entry, index) => {
        validateExample(entry, example[0], requireAll, `${path}[${index}]`);
      });
    return;
  }
  const exampleObject = asObject(example);
  if (exampleObject) {
    const valueObject = asObject(value);
    if (!valueObject) throw new Error(`${path} must be object`);
    for (const [key, childExample] of Object.entries(exampleObject)) {
      if (!(key in valueObject)) {
        if (requireAll) throw new Error(`${path}.${key} is required`);
        continue;
      }
      validateExample(
        valueObject[key],
        childExample,
        requireAll,
        `${path}.${key}`,
      );
    }
    return;
  }
  if (example === null) return;
  if (typeof value !== typeof example)
    throw new Error(`${path} must be ${typeof example}`);
}

function parserDefinition(parser: WorkflowNode): {
  schema: unknown;
  fromExample: boolean;
} {
  const parameters = parser.parameters;
  const schemaType = String(parameters.schemaType ?? "fromJson");
  const source =
    parser.typeVersion <= 1.1
      ? parameters.jsonSchema
      : schemaType === "manual"
        ? parameters.inputSchema
        : parameters.jsonSchemaExample;
  if (typeof source !== "string" || source.trim() === "")
    throw new Error(`Structured Output Parser "${parser.name}" has no schema`);
  try {
    return {
      schema: JSON.parse(source),
      fromExample: schemaType !== "manual" && parser.typeVersion > 1.1,
    };
  } catch (cause) {
    throw new Error(
      `Structured Output Parser "${parser.name}" has invalid JSON: ${String((cause as Error)?.message ?? cause)}`,
    );
  }
}

function unwrapStructuredOutput(value: unknown): unknown {
  const object = asObject(value);
  if (!object) return value;
  if ("__structured__output" in object) {
    const wrapper = asObject(object.__structured__output);
    return (
      wrapper?.__structured__output__object ??
      wrapper?.__structured__output__array ??
      object.__structured__output
    );
  }
  return object.output ?? value;
}

export function parseStructuredAiOutput(
  parser: WorkflowNode,
  rawResponse: unknown,
): unknown {
  const parsed = unwrapStructuredOutput(parseJsonText(rawResponse));
  const definition = parserDefinition(parser);
  try {
    if (definition.fromExample)
      validateExample(parsed, definition.schema, parser.typeVersion >= 1.3);
    else validateSchema(parsed, definition.schema as JsonObject);
  } catch (cause) {
    throw new Error(
      `Structured Output Parser "${parser.name}" rejected the model response: ${String((cause as Error)?.message ?? cause)}`,
    );
  }
  return parsed;
}

export function formatAiRootOutput(
  root: WorkflowNode,
  rawResponse: unknown,
  parser?: WorkflowNode,
): unknown {
  if (parser) return { output: parseStructuredAiOutput(parser, rawResponse) };
  if (root.type.endsWith(".chainLlm")) {
    if (typeof rawResponse === "string") return { text: rawResponse.trim() };
    if (Array.isArray(rawResponse)) return { data: rawResponse };
    const object = asObject(rawResponse);
    if (object && root.typeVersion >= 1.6) return object;
    if (object) return { text: JSON.stringify(object) };
  }
  const object = asObject(rawResponse);
  if (object && "output" in object) return object;
  return { output: rawResponse };
}
