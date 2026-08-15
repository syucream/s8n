import type { ExpressionScope } from "../../expression/context.ts";
import { resolveParameterValue } from "../../expression/evaluator.ts";
import { formatFaultMessage } from "../../faults.ts";
import { normalizeMockToItems } from "../../mock/normalize.ts";
import { lookupItemMock } from "../../mock/provider.ts";
import {
  buildMockContractEvidence,
  defaultMockCardinalityHint,
  MOCK_FIDELITY_NOTE,
} from "../../mock/request-contract.ts";
import { buildMockShapeHint } from "../../mock/shape-hint.ts";
import type { Item } from "../../schema/item.ts";
import type { NodeExecutor, ResolvedRequest } from "../types.ts";
import {
  normalizeHttpMock,
  requestTarget,
  resolveHttpRequest,
  usesFullResponse,
} from "./http-request-contract.ts";
import {
  applyPaginationUpdates,
  buildPageResponse,
  extractPages,
  extractPaginationConfig,
  isPageComplete,
  type PaginationConfig,
  stripPaginationParameters,
} from "./http-request-pagination.ts";

/**
 * HTTP Request, mocked: s8n never performs real network IO. It resolves the
 * (expression-evaluated) method/url per item purely for tracing/reporting,
 * then looks up a caller-supplied mock response keyed by node name (with an
 * optional `#<itemIndex>` suffix for per-item responses). If no mock is
 * registered, execution pauses and reports a `PendingMockRequest` so the
 * calling AI can generate one.
 *
 * When the node configures `options.pagination`, the mock drives a simulated
 * page loop: `{ pages: [...] }` supplies one response per page, while any
 * other mock shape is treated as a single complete page (annotated with a
 * fidelity note). Page-dependent expressions (`completeExpression`, request
 * updates) are evaluated against `$response`, mirroring upstream n8n.
 */
export const httpRequestExecutor: NodeExecutor = {
  type: "n8n-nodes-base.httpRequest",
  execute: ({
    node,
    inputItems,
    runtime,
    buildScope,
    loopIterationIndex,
    isStartNode,
  }) => {
    const items =
      inputItems.length > 0 || !isStartNode ? inputItems : [{ json: {} }];
    const outputItems: Item[] = [];
    const resolvedRequests: ResolvedRequest[] = [];
    const warnings = new Set<string>();
    const fidelityNotes = new Set<string>();
    const rawParameters = (node.parameters ?? {}) as Record<string, unknown>;
    const pagination = extractPaginationConfig(rawParameters);
    const eagerParameters = stripPaginationParameters(rawParameters);

    for (let i = 0; i < items.length; i++) {
      const item = items[i] as Item;
      const scope = buildScope(item, i, items);
      const resolvedParams = resolveParameterValue(
        eagerParameters,
        scope,
      ) as Record<string, unknown>;
      const baseRequest = resolveHttpRequest(resolvedParams, node.typeVersion);
      const { method, url } = baseRequest;
      if (runtime.captureResolvedRequests && !pagination) {
        resolvedRequests.push(baseRequest);
      }

      const fault = runtime.faults?.get(node.name);
      if (fault !== undefined) {
        return { status: "error", message: formatFaultMessage(fault) };
      }

      // Inside a Split In Batches loop body, prefer the loop's own
      // iteration counter over the local within-batch index for the mock
      // key - with the common `batchSize: 1`, `i` is always 0 every
      // iteration, which would otherwise collide every batch onto the same
      // `#0` mock (see `ExecuteArgs.loopIterationIndex`).
      const mockValue = lookupItemMock(
        runtime.mocks,
        node.name,
        loopIterationIndex ?? i,
      );

      if (mockValue === undefined) {
        const suggestedFields =
          runtime.suggestedFieldsByNode?.get(node.name) ??
          runtime.suggestedFields;
        const fullResponse = usesFullResponse(resolvedParams, node.typeVersion);
        return {
          status: "waiting_mock",
          request: {
            nodeName: node.name,
            nodeType: node.type,
            mockKey: node.name,
            reason: `No mock response was provided for HTTP request "${method} ${requestTarget(url)}"`,
            expectedShape: buildMockShapeHint(
              fullResponse
                ? "The configured HTTP Request node output, with body, headers, statusCode, and statusMessage. Provide one object or an array of objects to emit multiple items."
                : "The JSON response body for this HTTP request. Provide one object or an array of objects to emit multiple items." +
                    (pagination
                      ? " This node paginates: wrap per-page responses as { pages: [page1, page2, ...] } to model a multi-page listing."
                      : ""),
              suggestedFields,
            ),
            provenance: buildMockContractEvidence({
              suggestedFields,
              userContext: `The request method and target origin were resolved from user configuration as ${method} ${requestTarget(url)}.`,
              genericContext:
                "No remote response schema is fetched because s8n never performs network I/O.",
            }),
            cardinalityHint: { ...defaultMockCardinalityHint },
          },
        };
      }

      const fullResponse = usesFullResponse(resolvedParams, node.typeVersion);
      fidelityNotes.add(MOCK_FIDELITY_NOTE);
      if (pagination) {
        const outcome = runPaginatedMock({
          pagination,
          mockValue,
          fullResponse,
          baseRequest,
          itemIndex: i,
          scope,
          captureResolvedRequests: runtime.captureResolvedRequests === true,
        });
        for (const warning of outcome.warnings) warnings.add(warning);
        for (const note of outcome.fidelityNotes) fidelityNotes.add(note);
        resolvedRequests.push(...outcome.resolvedRequests);
        outputItems.push(...outcome.items);
        continue;
      }

      const normalized = normalizeHttpMock(mockValue, fullResponse);
      for (const warning of normalized.warnings) warnings.add(warning);
      outputItems.push(...normalizeMockToItems(normalized.value, i));
    }

    return {
      status: "success",
      output: [outputItems],
      ...(resolvedRequests.length > 0 ? { resolvedRequests } : {}),
      ...(warnings.size > 0 ? { warnings: [...warnings] } : {}),
      ...(fidelityNotes.size > 0 ? { fidelityNotes: [...fidelityNotes] } : {}),
    };
  },
};

interface PaginatedMockOutcome {
  items: Item[];
  resolvedRequests: ResolvedRequest[];
  warnings: string[];
  fidelityNotes: string[];
}

/**
 * Drives the simulated page loop for one input item. Pages come from the
 * mock alone; the loop therefore always terminates. Completion semantics
 * follow the upstream node (`responseIsEmpty`, status codes, or a
 * `completeExpression` over `$response`).
 */
function runPaginatedMock(args: {
  pagination: PaginationConfig;
  mockValue: unknown;
  fullResponse: boolean;
  baseRequest: ResolvedRequest;
  itemIndex: number;
  scope: ExpressionScope;
  captureResolvedRequests: boolean;
}): PaginatedMockOutcome {
  const { pagination, mockValue, fullResponse, baseRequest, itemIndex } = args;
  const warnings: string[] = [];
  const fidelityNotes: string[] = [];
  const resolvedRequests: ResolvedRequest[] = [];
  const items: Item[] = [];

  const { pages, explicit } = extractPages(mockValue);
  if (!explicit) {
    fidelityNotes.push(
      "pagination-single-page-mock: the node paginates but the mock has no `pages` array; simulated as one complete page. Real-service listings may return additional pages.",
    );
  }

  let completed = false;
  let prevResponse: Record<string, unknown> | undefined;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const pageMock = pages[pageIndex];
    const response = buildPageResponse(pageMock, fullResponse);

    let pageRequest = baseRequest;
    if (pageIndex > 0) {
      // Per-page request updates read the *previous* page's `$response`,
      // matching upstream n8n's pagination loop.
      const updateScope: ExpressionScope = {
        ...args.scope,
        $response: prevResponse,
      };
      if (pagination.paginationMode === "responseContainsNextURL") {
        const next = pagination.nextURL
          ? resolveParameterValue(pagination.nextURL, updateScope)
          : undefined;
        if (typeof next === "string" && next.length > 0) {
          pageRequest = { ...baseRequest, url: next };
        } else {
          warnings.push(
            "pagination nextURL did not resolve to a non-empty URL; reusing the previous request target.",
          );
        }
      } else {
        const applied = applyPaginationUpdates(
          baseRequest,
          pagination.updates,
          updateScope,
        );
        pageRequest = applied.request;
        warnings.push(...applied.warnings);
      }
    }
    if (args.captureResolvedRequests) resolvedRequests.push(pageRequest);

    const normalized = normalizeHttpMock(pageMock, fullResponse);
    warnings.push(...normalized.warnings);
    const pageItems = normalizeMockToItems(normalized.value, itemIndex);
    items.push(...pageItems);

    const completion = isPageComplete(pagination, response, pageItems.length, {
      ...args.scope,
      $response: response,
    });
    warnings.push(...completion.warnings);
    if (completion.complete) {
      completed = true;
      break;
    }
    if (
      pagination.limitPagesFetched &&
      pagination.maxRequests !== undefined &&
      pageIndex + 1 >= pagination.maxRequests
    ) {
      fidelityNotes.push(
        `pagination-max-requests: stopped after ${pageIndex + 1} page(s) per the node's maxRequests limit.`,
      );
      completed = true;
      break;
    }
    prevResponse = response;
  }

  if (!completed) {
    fidelityNotes.push(
      "pagination-truncated-mock: mock pages were exhausted before the completion condition was satisfied; real-service output may contain further items.",
    );
  }

  return { items, resolvedRequests, warnings, fidelityNotes };
}
