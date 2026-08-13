import type { ResolvedRequest } from "../types.ts";

type KeyValueParameter = { name?: unknown; value?: unknown };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonObject(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function keyValueRecord(value: unknown): Record<string, unknown> {
  const collection = asRecord(value);
  const parameters = collection?.parameters ?? collection?.parameter;
  if (!Array.isArray(parameters)) return {};
  return Object.fromEntries(
    parameters
      .filter(
        (entry): entry is KeyValueParameter => asRecord(entry) !== undefined,
      )
      .map((entry): [string, unknown] => [
        String(entry.name ?? ""),
        entry.value,
      ])
      .filter(([name]) => name.length > 0),
  );
}

function appendQuery(url: string, query: Record<string, unknown>): string {
  if (Object.keys(query).length === 0) return url;
  try {
    const parsed = new URL(url);
    for (const [name, value] of Object.entries(query)) {
      parsed.searchParams.set(name, String(value ?? ""));
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

const SENSITIVE_NAME =
  /(?:auth|authorization|cookie|token|secret|password|passwd|api[-_]?key|access[-_]?key|private[-_]?key|credential|signature)/i;
const SAFE_HEADER_VALUE = /^(?:accept|content-type|user-agent)$/i;

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([name, entry]) => [
      name,
      SENSITIVE_NAME.test(name) ? "[REDACTED]" : sanitizeValue(entry),
    ]),
  );
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "[REDACTED]";
      url.password = "[REDACTED]";
    }
    for (const name of [...url.searchParams.keys()]) {
      if (SENSITIVE_NAME.test(name)) url.searchParams.set(name, "[REDACTED]");
    }
    return url.toString();
  } catch {
    return value;
  }
}

function sanitizeFormEncoded(value: string): string {
  const parameters = new URLSearchParams(value);
  for (const name of [...parameters.keys()]) {
    if (SENSITIVE_NAME.test(name)) parameters.set(name, "[REDACTED]");
  }
  return parameters.toString();
}

export function resolveHttpRequest(
  parameters: Record<string, unknown>,
  typeVersion = 4.4,
): ResolvedRequest {
  const legacy = typeVersion < 3 && Object.hasOwn(parameters, "requestMethod");
  const method = String(
    legacy ? (parameters.requestMethod ?? "GET") : (parameters.method ?? "GET"),
  ).toUpperCase();
  let url = String(parameters.url ?? "");

  if (legacy) {
    const usesJson = parameters.jsonParameters === true;
    const query = usesJson
      ? (asRecord(parseJsonObject(parameters.queryParametersJson)) ?? {})
      : keyValueRecord(parameters.queryParametersUi);
    url = appendQuery(url, query);
    const headers = usesJson
      ? (asRecord(parseJsonObject(parameters.headerParametersJson)) ?? {})
      : keyValueRecord(parameters.headerParametersUi);
    const options = asRecord(parameters.options) ?? {};
    const bodyContentType = String(options.bodyContentType ?? "json");
    let body: unknown;
    if (["PATCH", "POST", "PUT", "DELETE"].includes(method)) {
      if (parameters.sendBinaryData === true) {
        body = {
          binaryPropertyName: String(parameters.binaryPropertyName ?? "data"),
        };
      } else if (usesJson) {
        body =
          bodyContentType === "raw"
            ? {
                redacted: true,
                contentType: String(options.bodyContentCustomMimeType ?? ""),
              }
            : parseJsonObject(parameters.bodyParametersJson);
      } else {
        body = keyValueRecord(parameters.bodyParametersUi);
      }
    }
    return {
      method,
      url: sanitizeUrl(url),
      ...(Object.keys(headers).length > 0
        ? {
            headers: Object.fromEntries(
              Object.entries(headers).map(([name, value]) => [
                name,
                SAFE_HEADER_VALUE.test(name)
                  ? sanitizeValue(value)
                  : "[REDACTED]",
              ]),
            ),
          }
        : {}),
      ...(body !== undefined ? { body: sanitizeValue(body) } : {}),
    };
  }

  if (parameters.sendQuery === true) {
    const query =
      parameters.specifyQuery === "json"
        ? (asRecord(parseJsonObject(parameters.jsonQuery)) ?? {})
        : keyValueRecord(parameters.queryParameters);
    url = appendQuery(url, query);
  }

  let headers: Record<string, unknown> | undefined;
  if (parameters.sendHeaders === true) {
    headers =
      parameters.specifyHeaders === "json"
        ? (asRecord(parseJsonObject(parameters.jsonHeaders)) ?? {})
        : keyValueRecord(parameters.headerParameters);
  }

  let body: unknown;
  if (parameters.sendBody === true) {
    const contentType = String(parameters.contentType ?? "json");
    const specifyBody = String(parameters.specifyBody ?? "keypair");
    if (contentType === "json") {
      body =
        specifyBody === "json"
          ? parseJsonObject(parameters.jsonBody)
          : keyValueRecord(parameters.bodyParameters);
    } else if (contentType === "form-urlencoded") {
      if (specifyBody === "string") {
        body = sanitizeFormEncoded(String(parameters.body ?? ""));
      } else {
        const fields = keyValueRecord(parameters.bodyParameters);
        body = new URLSearchParams(
          Object.fromEntries(
            Object.entries(fields).map(([name, value]) => [
              name,
              SENSITIVE_NAME.test(name) ? "[REDACTED]" : String(value ?? ""),
            ]),
          ),
        ).toString();
      }
    } else if (contentType === "raw") {
      body = {
        redacted: true,
        contentType: String(parameters.rawContentType ?? ""),
      };
    } else if (contentType === "multipart-form-data") {
      body = keyValueRecord(parameters.bodyParameters);
    } else if (contentType === "binaryData") {
      body = {
        binaryPropertyName: String(parameters.inputDataFieldName ?? "data"),
      };
    }
  }

  return {
    method,
    url: sanitizeUrl(url),
    ...(headers
      ? {
          headers: Object.fromEntries(
            Object.entries(headers).map(([name, value]) => [
              name,
              SAFE_HEADER_VALUE.test(name)
                ? sanitizeValue(value)
                : "[REDACTED]",
            ]),
          ),
        }
      : {}),
    ...(body !== undefined ? { body: sanitizeValue(body) } : {}),
  };
}

export function usesFullResponse(
  parameters: Record<string, unknown>,
  typeVersion = 4.4,
): boolean {
  const options = asRecord(parameters.options);
  if (typeVersion < 3 && Object.hasOwn(parameters, "requestMethod")) {
    return options?.fullResponse === true;
  }
  const response = asRecord(options?.response);
  const nested = asRecord(response?.response);
  return nested?.fullResponse === true;
}

export function requestTarget(value: string): string {
  if (!value) return "(unresolved URL)";
  try {
    return new URL(value).origin;
  } catch {
    return "(unresolved URL)";
  }
}

function resemblesFullResponse(value: unknown): boolean {
  const record = asRecord(value);
  return (
    record !== undefined &&
    ["body", "headers", "statusCode", "statusMessage"].every((key) =>
      Object.hasOwn(record, key),
    )
  );
}

export function normalizeHttpMock(
  mockValue: unknown,
  fullResponse: boolean,
): { value: unknown; warnings: string[] } {
  const entries = Array.isArray(mockValue) ? mockValue : [mockValue];
  const warnings =
    !fullResponse && entries.some(resemblesFullResponse)
      ? [
          "HTTP mock resembles a full response, but this node returns only the response body because fullResponse is disabled.",
        ]
      : [];
  if (fullResponse && !entries.every(resemblesFullResponse)) {
    warnings.push(
      "HTTP mock does not match this node's fullResponse output shape. Include body and statusCode to model the configured node output.",
    );
  }
  return { value: mockValue, warnings };
}
