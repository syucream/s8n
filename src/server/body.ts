import { type Item, toItems } from "../schema/item.ts";
import type { WorkflowNode } from "../schema/workflow.ts";
import type { RequestEnvelope } from "./types.ts";

/** Typed error carrying the HTTP status the server should respond with. */
export class BodyParseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function contentTypeOf(header: string | undefined): string {
  if (header === undefined) return "";
  return header.split(";")[0]?.trim().toLowerCase() ?? "";
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/**
 * Parses a raw request body into the value n8n would place under `body` in
 * the webhook output item. Multipart is not parsed (415); urlencoded bodies
 * are decoded into an object; otherwise the body must be JSON.
 */
function parseBodyValue(raw: string, contentType: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return {};

  const type = contentTypeOf(contentType);
  if (type === "multipart/form-data") {
    throw new BodyParseError(
      415,
      "multipart/form-data is not supported by the s8n mock server; send JSON or application/x-www-form-urlencoded instead",
    );
  }
  if (type === "application/x-www-form-urlencoded") {
    const params = new URLSearchParams(trimmed);
    const result: Record<string, string | string[]> = {};
    for (const key of params.keys()) {
      const values = params.getAll(key);
      result[key] = values.length > 1 ? values : (values[0] as string);
    }
    return result;
  }

  try {
    return parseJson(trimmed);
  } catch {
    if (type === "application/json" || type.endsWith("+json") || type === "") {
      throw new BodyParseError(400, "Request body is not valid JSON");
    }
    throw new BodyParseError(
      415,
      `Unsupported content type "${type || "unknown"}" for the s8n mock server`,
    );
  }
}

/**
 * Builds the n8n-shaped webhook trigger item: `{ headers, params, query,
 * body, webhookUrl, executionMode }` (verified against the upstream Webhook
 * node). A webhook always emits exactly one item whose `body` is the parsed
 * request body - object, array, or scalar - never a fan-out.
 */
export function buildWebhookItems(
  envelope: RequestEnvelope,
  rawBody: string,
  contentType: string | undefined,
  webhookUrl: string,
): Item[] {
  const value = parseBodyValue(rawBody, contentType ?? "");
  return toItems([
    {
      headers: envelope.headers,
      params: envelope.params,
      query: envelope.query,
      webhookUrl,
      executionMode: "production",
      body: value ?? {},
    },
  ]);
}

interface FormFieldDeclaration {
  name: string;
  fieldType: string;
}

/** Extracts the form field declarations from a Form Trigger node. */
export function formFieldDeclarations(
  node: WorkflowNode,
): FormFieldDeclaration[] {
  const values = node.parameters.formFields;
  if (
    values === null ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    !("values" in values) ||
    !Array.isArray((values as { values: unknown }).values)
  ) {
    return [];
  }
  const rawFields = (values as { values: unknown[] }).values;
  return rawFields.flatMap((raw) => {
    if (raw === null || typeof raw !== "object") return [];
    const field = raw as Record<string, unknown>;
    const fieldType =
      typeof field.fieldType === "string" ? field.fieldType : "text";
    const name =
      typeof field.fieldName === "string" && field.fieldName !== ""
        ? field.fieldName
        : typeof field.fieldLabel === "string"
          ? field.fieldLabel
          : "";
    if (name === "") return [];
    return [{ name, fieldType }];
  });
}

function convertFormValue(
  fieldType: string,
  rawValue: unknown,
  declaredDefault: unknown,
): unknown {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return rawValue === undefined || rawValue === ""
      ? (declaredDefault ?? null)
      : null;
  }
  if (fieldType === "number") {
    const converted = Number(rawValue);
    return Number.isNaN(converted) ? rawValue : converted;
  }
  if (
    fieldType === "text" ||
    fieldType === "email" ||
    fieldType === "password"
  ) {
    return String(rawValue).trim();
  }
  if (
    (fieldType === "checkbox" ||
      fieldType === "radio" ||
      fieldType === "multiselect") &&
    typeof rawValue === "string"
  ) {
    try {
      const parsed: unknown = JSON.parse(rawValue);
      if (fieldType === "radio" && Array.isArray(parsed))
        return parsed[0] ?? null;
      return parsed;
    } catch {
      return rawValue;
    }
  }
  return rawValue;
}

function declaredDefault(
  raw: Record<string, unknown>,
  fieldType: string,
): unknown {
  if (typeof raw.defaultValue === "string" && raw.defaultValue !== "") {
    return raw.defaultValue;
  }
  if (fieldType === "hiddenField" && typeof raw.fieldValue === "string") {
    return raw.fieldValue;
  }
  return null;
}

/**
 * Builds the Form Trigger submission item, mirroring the upstream shape:
 * one `{ fieldName: value, submittedAt, formMode }` item (plus
 * `formQueryParameters`/`headers` when configured). The mock accepts
 * urlencoded or JSON submissions keyed by `field-<index>` (like the n8n form
 * page) or directly by field name; multipart is not parsed.
 */
export function buildFormItems(
  node: WorkflowNode,
  envelope: RequestEnvelope,
  rawBody: string,
  contentType: string | undefined,
  now: Date,
): Item[] {
  const value = parseBodyValue(rawBody, contentType ?? "");
  const body =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const fields = formFieldDeclarations(node);
  const options =
    node.parameters.options !== null &&
    typeof node.parameters.options === "object"
      ? (node.parameters.options as Record<string, unknown>)
      : {};

  const json: Record<string, unknown> = {};
  fields.forEach((field, index) => {
    const rawField = ((node.parameters.formFields as { values?: unknown[] })
      ?.values ?? [])[index] as Record<string, unknown> | undefined;
    const key = `field-${index}`;
    const rawValue =
      body[key] ??
      body[field.name] ??
      declaredDefault(rawField ?? {}, field.fieldType);
    json[field.name] = convertFormValue(
      field.fieldType,
      rawValue,
      declaredDefault(rawField ?? {}, field.fieldType),
    );
  });

  json.submittedAt = now.toISOString();
  json.formMode = "production";
  if (Object.keys(envelope.query).length > 0) {
    json.formQueryParameters = envelope.query;
  }
  if (options.showHeaders === true) {
    json.headers = envelope.headers;
  }
  return toItems([json]);
}
