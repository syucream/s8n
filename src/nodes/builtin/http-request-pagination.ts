import type { ExpressionScope } from "../../expression/context.ts";
import {
  evaluateExpressionString,
  isExpression,
} from "../../expression/evaluator.ts";
import type { ResolvedRequest } from "../types.ts";

/**
 * HTTP Request pagination modeling (parameter structure verified against
 * upstream n8n `HttpRequestV3`: `options.pagination.pagination.{...}`).
 *
 * s8n never performs network I/O, so a paginated node is driven entirely by
 * the caller-supplied mock: a mock shaped as `{ pages: [...] }` supplies one
 * response per page; any other mock shape is treated as a single, complete
 * page (with a fidelity note). `completeExpression` and per-request parameter
 * updates are evaluated lazily against `$response` so workflows that page
 * over large collections stay simulatable instead of failing with
 * `$response is not defined`.
 */

export interface PaginationParameterUpdate {
  type: "body" | "headers" | "qs";
  name: string;
  value: unknown;
}

export interface PaginationConfig {
  paginationMode: "updateAParameterInEachRequest" | "responseContainsNextURL";
  nextURL?: string;
  updates: PaginationParameterUpdate[];
  paginationCompleteWhen:
    | "responseIsEmpty"
    | "receiveSpecificStatusCodes"
    | "other";
  statusCodesWhenComplete?: string;
  completeExpression?: string;
  limitPagesFetched: boolean;
  maxRequests?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Reads `options.pagination.pagination` from raw (unresolved) node
 * parameters. Returns undefined when pagination is absent or `off`.
 */
export function extractPaginationConfig(
  parameters: Record<string, unknown>,
): PaginationConfig | undefined {
  const options = asRecord(parameters.options);
  const outer = asRecord(options?.pagination);
  const inner = asRecord(outer?.pagination);
  if (!inner) return undefined;
  const mode = inner.paginationMode;
  if (
    mode !== "updateAParameterInEachRequest" &&
    mode !== "responseContainsNextURL"
  ) {
    return undefined;
  }
  const rawUpdates = asRecord(inner.parameters)?.parameters;
  const updates: PaginationParameterUpdate[] = Array.isArray(rawUpdates)
    ? rawUpdates.flatMap((entry) => {
        const record = asRecord(entry);
        const type = record?.type;
        if (
          (type !== "body" && type !== "headers" && type !== "qs") ||
          typeof record?.name !== "string" ||
          record.name.length === 0
        ) {
          return [];
        }
        return [{ type, name: record.name, value: record.value }];
      })
    : [];
  const completeWhen = inner.paginationCompleteWhen;
  const maxRequests =
    typeof inner.maxRequests === "number" && inner.maxRequests > 0
      ? Math.floor(inner.maxRequests)
      : undefined;
  return {
    paginationMode: mode,
    ...(typeof inner.nextURL === "string" ? { nextURL: inner.nextURL } : {}),
    updates,
    paginationCompleteWhen:
      completeWhen === "responseIsEmpty" ||
      completeWhen === "receiveSpecificStatusCodes"
        ? completeWhen
        : "other",
    ...(typeof inner.statusCodesWhenComplete === "string"
      ? { statusCodesWhenComplete: inner.statusCodesWhenComplete }
      : {}),
    ...(typeof inner.completeExpression === "string"
      ? { completeExpression: inner.completeExpression }
      : {}),
    limitPagesFetched: inner.limitPagesFetched === true,
    ...(maxRequests !== undefined ? { maxRequests } : {}),
  };
}

/**
 * Returns a copy of the parameters with `options.pagination` removed so the
 * eager expression resolution pass never evaluates `$response` expressions,
 * which only exist while a paginated run is in flight.
 */
export function stripPaginationParameters(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const options = asRecord(parameters.options);
  if (!options || !Object.hasOwn(options, "pagination")) return parameters;
  const { pagination: _removed, ...restOptions } = options;
  return { ...parameters, options: restOptions };
}

/**
 * Splits a mock into its page sequence. An explicit `{ pages: [...] }`
 * wrapper wins; anything else is a single implicit page. Callers should
 * surface a fidelity note when `explicit` is false so a single-page mock
 * cannot silently masquerade as a fully paginated listing.
 */
export function extractPages(mockValue: unknown): {
  pages: unknown[];
  explicit: boolean;
} {
  const record = asRecord(mockValue);
  if (record && Array.isArray(record.pages)) {
    return { pages: record.pages, explicit: true };
  }
  return { pages: [mockValue], explicit: false };
}

/** Builds the `$response` object pagination expressions evaluate against. */
export function buildPageResponse(
  pageMock: unknown,
  fullResponse: boolean,
): Record<string, unknown> {
  const record = asRecord(pageMock);
  if (fullResponse && record && Object.hasOwn(record, "body")) {
    return {
      body: record.body,
      headers: asRecord(record.headers) ?? {},
      statusCode:
        typeof record.statusCode === "number" ? record.statusCode : 200,
      statusMessage:
        typeof record.statusMessage === "string" ? record.statusMessage : "OK",
    };
  }
  return { body: pageMock, statusCode: 200, statusMessage: "OK" };
}

/** Applies one page of upstream-modeled request updates to a resolved request. */
export function applyPaginationUpdates(
  request: ResolvedRequest,
  updates: PaginationParameterUpdate[],
  scope: ExpressionScope,
): { request: ResolvedRequest; warnings: string[] } {
  const warnings: string[] = [];
  let url = request.url;
  const headers: Record<string, unknown> = { ...request.headers };
  let body = request.body;
  for (const update of updates) {
    const value = isExpression(update.value)
      ? evaluateExpressionString(update.value, scope)
      : update.value;
    if (update.type === "qs") {
      try {
        const parsed = new URL(url);
        parsed.searchParams.set(update.name, String(value ?? ""));
        url = parsed.toString();
      } catch {
        warnings.push(
          `Could not apply pagination query parameter "${update.name}" to an unparseable URL.`,
        );
      }
    } else if (update.type === "headers") {
      headers[update.name] = value;
    } else {
      const bodyRecord = asRecord(body);
      if (bodyRecord) {
        body = { ...bodyRecord, [update.name]: value };
      } else {
        warnings.push(
          `Could not apply pagination body parameter "${update.name}" because the resolved body is not an object.`,
        );
      }
    }
  }
  return {
    request: {
      method: request.method,
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(body !== undefined ? { body } : {}),
    },
    warnings,
  };
}

export function isPageComplete(
  config: PaginationConfig,
  response: Record<string, unknown>,
  pageItemCount: number,
  scope: ExpressionScope,
): { complete: boolean; warnings: string[] } {
  if (config.paginationCompleteWhen === "responseIsEmpty") {
    return { complete: pageItemCount === 0, warnings: [] };
  }
  if (config.paginationCompleteWhen === "receiveSpecificStatusCodes") {
    const codes = (config.statusCodesWhenComplete ?? "")
      .split(",")
      .map((code) => Number.parseInt(code.trim(), 10))
      .filter((code) => Number.isFinite(code));
    return {
      complete: codes.includes(Number(response.statusCode)),
      warnings: [],
    };
  }
  const expression = config.completeExpression;
  if (!expression) {
    return {
      complete: true,
      warnings: [
        'paginationCompleteWhen is "other" but no completeExpression is configured; treating the first page as complete.',
      ],
    };
  }
  if (!isExpression(expression)) {
    return {
      complete: true,
      warnings: [
        "completeExpression is not an expression; treating the first page as complete.",
      ],
    };
  }
  return {
    complete: Boolean(evaluateExpressionString(expression, scope)),
    warnings: [],
  };
}
