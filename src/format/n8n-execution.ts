import type { NodeTraceEntry, RunResult } from "../engine/execute.ts";

export interface N8nExecutionLogOptions {
  workflowId?: string;
  startNode?: string;
  truncateData?: number;
  metadataForTrace?: (
    trace: NodeTraceEntry,
  ) => Record<string, unknown> | undefined;
}

function inferMode(type: string | undefined): string {
  if (type?.includes("webhook")) return "webhook";
  if (type?.includes("chatTrigger")) return "chat";
  if (type?.includes("manualTrigger")) return "manual";
  return "trigger";
}

function executionStatus(status: RunResult["status"]): string {
  if (status === "needs_mock") return "waiting";
  if (status === "needs_start_node") return "error";
  return status;
}

export function toN8nExecutionLog(
  result: RunResult,
  options: N8nExecutionLogOptions = {},
): Record<string, unknown> {
  const executedRuns = result.trace.filter(
    (entry) => entry.executionIndex !== undefined,
  );
  const fallbackTime = Date.now();
  const startTime =
    executedRuns.length > 0
      ? Math.min(
          ...executedRuns.map((entry) => entry.startTime ?? fallbackTime),
        )
      : fallbackTime;
  const stoppedAt =
    executedRuns.length > 0
      ? Math.max(
          ...executedRuns.map(
            (entry) =>
              (entry.startTime ?? startTime) + (entry.executionTime ?? 0),
          ),
        )
      : startTime;
  const inferredStart =
    options.startNode ??
    executedRuns.find((entry) => (entry.source?.length ?? 0) === 0)?.nodeName;
  const startType = result.trace.find(
    (entry) => entry.nodeName === inferredStart,
  )?.nodeType;
  const itemLimit =
    options.truncateData === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, options.truncateData);
  const runData: Record<string, unknown[]> = {};

  for (const entry of executedRuns) {
    const runs = runData[entry.nodeName] ?? [];
    runs.push({
      startTime: entry.startTime,
      executionTime: entry.executionTime,
      executionIndex: entry.executionIndex,
      executionStatus: entry.executionStatus,
      source: entry.source ?? [],
      ...(entry.data
        ? {
            data: {
              main: entry.data.main.map((slot) => slot.slice(0, itemLimit)),
            },
          }
        : {}),
      ...(entry.error ? { error: { message: entry.error } } : {}),
      metadata: {
        s8nTraceStatus: entry.status,
        originalOutputItemCounts: entry.outputItemCounts ?? [],
        dataTruncated: entry.data?.main.some((slot) => slot.length > itemLimit),
        ...(entry.pendingMock ? { pendingMock: entry.pendingMock } : {}),
        ...(entry.resolvedRequests
          ? { resolvedRequests: entry.resolvedRequests }
          : {}),
        ...(entry.warnings ? { warnings: entry.warnings } : {}),
        ...(options.metadataForTrace?.(entry) ?? {}),
      },
    });
    runData[entry.nodeName] = runs;
  }

  const lastNodeExecuted = [...executedRuns].sort(
    (left, right) => (right.executionIndex ?? 0) - (left.executionIndex ?? 0),
  )[0]?.nodeName;

  return {
    id: `s8n-${options.workflowId ?? "workflow"}-${startTime}`,
    workflowId: options.workflowId ?? null,
    mode: inferMode(startType),
    status: executionStatus(result.status),
    startedAt: new Date(startTime).toISOString(),
    stoppedAt: new Date(stoppedAt).toISOString(),
    data: {
      startData: { destinationNode: inferredStart ?? null },
      resultData: {
        runData,
        lastNodeExecuted: lastNodeExecuted ?? null,
        error: result.errors[0] ? { message: result.errors[0] } : null,
      },
    },
  };
}
