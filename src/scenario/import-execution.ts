import { createDefaultRegistry } from "../nodes/registry.ts";
import type { Workflow } from "../schema/workflow.ts";

export interface ExecutionRun {
  data?: { main?: unknown[][] };
  executionIndex?: number;
  executionStatus?: string;
}

export interface ExecutionView {
  status?: string;
  startedAt?: string;
  startNode?: string;
  runData: Record<string, ExecutionRun[]>;
}

export interface ImportExecutionOptions {
  maxItemsPerNode?: number;
}

export interface ImportedScenarioDraft {
  version: 1;
  generatedFrom: {
    kind: "n8n-execution-log";
    dataMode: "synthetic-shape";
    reviewRequired: true;
    warnings: string[];
  };
  /**
   * Normalized view of what each LLM node actually returned, extracted from
   * runData. Real n8n scatters the model's raw output across places
   * (`ai_languageModel` `generations`, chain `text`, structured parsers'
   * `output`); this collapses them so "the agent returned this string" is
   * visible in one place for review.
   */
  llmOutputs?: Array<{
    node: string;
    kind: "agent-output" | "language-model" | "chain-text";
    text?: string;
    output?: unknown;
  }>;
  cases: Array<{
    name: string;
    input: Record<string, unknown>[];
    mocks: Record<string, unknown>;
    startNode?: string;
    now?: string;
    assertions: {
      status?: "success";
      requiredNodes: string[];
    };
  }>;
}

const SENSITIVE_KEY =
  /(?:authorization|credential|password|passwd|secret|token|api[_-]?key|cookie)/iu;

function syntheticString(key: string): string {
  if (/email/iu.test(key)) return "person@example.invalid";
  if (/(?:url|uri|link)/iu.test(key)) return "https://example.invalid/resource";
  if (/(?:date|time|timestamp|created|updated)/iu.test(key))
    return "2026-01-01T00:00:00.000Z";
  if (/(?:^|[_-])id$/iu.test(key) || /^id$/iu.test(key)) return "synthetic-id";
  if (/name/iu.test(key)) return "Synthetic Name";
  return "synthetic";
}

/**
 * Preserves JSON shape while replacing every scalar from an execution log.
 * This intentionally cannot reproduce value-dependent branches without a
 * caller reviewing the draft, but it avoids turning production data into a
 * fixture by accident.
 */
export function synthesizeExecutionValue(
  value: unknown,
  key = "value",
): unknown {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (Array.isArray(value))
    return value.map((entry) => synthesizeExecutionValue(entry, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        synthesizeExecutionValue(entryValue, entryKey),
      ]),
    );
  }
  if (typeof value === "string") return syntheticString(key);
  if (typeof value === "number") return 1;
  if (typeof value === "boolean") return false;
  return value === null ? null : "synthetic";
}

export function unwrapExecution(raw: unknown): ExecutionView {
  let current = raw;
  for (let depth = 0; depth < 4; depth++) {
    if (current === null || typeof current !== "object") break;
    const record = current as Record<string, unknown>;
    const resultData =
      record.resultData !== null && typeof record.resultData === "object"
        ? (record.resultData as Record<string, unknown>)
        : undefined;
    if (
      resultData?.runData !== null &&
      typeof resultData?.runData === "object" &&
      !Array.isArray(resultData.runData)
    ) {
      const startData =
        record.startData !== null && typeof record.startData === "object"
          ? (record.startData as Record<string, unknown>)
          : undefined;
      return {
        status: typeof record.status === "string" ? record.status : undefined,
        startedAt:
          typeof record.startedAt === "string" ? record.startedAt : undefined,
        startNode:
          typeof startData?.destinationNode === "string"
            ? startData.destinationNode
            : undefined,
        runData: resultData.runData as Record<string, ExecutionRun[]>,
      };
    }
    if (
      record.data !== null &&
      typeof record.data === "object" &&
      !Array.isArray(record.data)
    ) {
      const nested = record.data as Record<string, unknown>;
      if (nested.resultData !== null && typeof nested.resultData === "object") {
        current = {
          ...nested,
          status: record.status ?? nested.status,
          startedAt: record.startedAt ?? nested.startedAt,
        };
      } else {
        current = nested;
      }
      continue;
    }
    break;
  }
  throw new Error(
    "Execution log must contain data.resultData.runData or resultData.runData",
  );
}

type LlmOutputEntry = NonNullable<ImportedScenarioDraft["llmOutputs"]>[number];

function extractLlmOutputs(
  runData: Record<string, ExecutionRun[]>,
): LlmOutputEntry[] {
  const outputs: LlmOutputEntry[] = [];
  for (const [node, runs] of Object.entries(runData)) {
    const last = runs?.at(-1);
    const item = last?.data?.main?.[0]?.[0];
    const json =
      item !== null && typeof item === "object"
        ? (item as { json?: unknown }).json
        : undefined;
    if (json === null || typeof json !== "object" || Array.isArray(json))
      continue;
    const record = json as Record<string, unknown>;
    if (Array.isArray(record.generations)) {
      const generation = record.generations[0] as Record<string, unknown>;
      const message =
        generation?.message !== null && typeof generation?.message === "object"
          ? (generation.message as Record<string, unknown>)
          : undefined;
      const text =
        typeof message?.content === "string"
          ? message.content
          : typeof generation?.text === "string"
            ? generation.text
            : typeof generation?.output === "string"
              ? generation.output
              : undefined;
      outputs.push({
        node,
        kind: "language-model",
        ...(text === undefined ? {} : { text }),
      });
    } else if (typeof record.text === "string") {
      outputs.push({ node, kind: "chain-text", text: record.text });
    } else if (Object.hasOwn(record, "output")) {
      outputs.push({
        node,
        kind: "agent-output",
        output: record.output,
        ...(typeof record.output === "string"
          ? { text: record.output }
          : { text: JSON.stringify(record.output) }),
      });
    }
  }
  return outputs;
}

function lastMainItems(
  runs: ExecutionRun[] | undefined,
  limit: number,
): Record<string, unknown>[] {
  const last = runs?.at(-1);
  const items = last?.data?.main?.[0] ?? [];
  return items.slice(0, limit).map((item) => {
    if (item === null || typeof item !== "object")
      return { value: "synthetic" };
    const json = (item as Record<string, unknown>).json;
    const source =
      json !== null && typeof json === "object" && !Array.isArray(json)
        ? json
        : {};
    return synthesizeExecutionValue(source) as Record<string, unknown>;
  });
}

export function importExecutionDraft(
  workflow: Workflow,
  rawExecution: unknown,
  options: ImportExecutionOptions = {},
): ImportedScenarioDraft {
  const execution = unwrapExecution(rawExecution);
  const limit = options.maxItemsPerNode ?? 10;
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("maxItemsPerNode must be a positive integer");

  const workflowNames = new Set(workflow.nodes.map((node) => node.name));
  const unknownNodes = Object.entries(execution.runData)
    .filter(
      ([name, runs]) =>
        !workflowNames.has(name) && Array.isArray(runs) && runs.length > 0,
    )
    .map(([name]) => name);
  if (unknownNodes.length > 0) {
    throw new Error(
      `Execution log does not match the workflow; unknown node(s): ${unknownNodes.join(", ")}`,
    );
  }
  const reachedNodes = Object.entries(execution.runData)
    .filter(
      ([name, runs]) =>
        workflowNames.has(name) && Array.isArray(runs) && runs.length > 0,
    )
    .map(([name]) => name);
  const inferredStart =
    execution.startNode ??
    Object.entries(execution.runData)
      .filter(([name]) => workflowNames.has(name))
      .flatMap(([name, runs]) =>
        runs.map((run) => ({ name, index: run.executionIndex })),
      )
      .filter(
        (entry): entry is { name: string; index: number } =>
          typeof entry.index === "number",
      )
      .sort((left, right) => left.index - right.index)[0]?.name ??
    workflow.nodes.find((node) => reachedNodes.includes(node.name))?.name;
  const input = lastMainItems(execution.runData[inferredStart ?? ""], limit);
  const registry = createDefaultRegistry();
  const mockableNodes = new Set(
    workflow.nodes
      .filter(
        (node) =>
          node.type !== "n8n-nodes-base.executeWorkflow" &&
          (node.type === "n8n-nodes-base.httpRequest" ||
            !registry.has(node.type)),
      )
      .map((node) => node.name),
  );
  const mocks = Object.fromEntries(
    reachedNodes
      .filter((name) => name !== inferredStart && mockableNodes.has(name))
      .map((name) => [name, lastMainItems(execution.runData[name], limit)]),
  );
  const repeatedRunCollapsed = Object.values(execution.runData).some(
    (runs) => runs.length > 1,
  );
  const itemsTruncated = Object.values(execution.runData).some((runs) =>
    runs.some((run) => (run.data?.main?.[0]?.length ?? 0) > limit),
  );
  const mappedWorkflowReviewNeeded = workflow.nodes.some(
    (node) =>
      node.type === "n8n-nodes-base.executeWorkflow" &&
      reachedNodes.includes(node.name),
  );
  const llmOutputs = extractLlmOutputs(execution.runData);
  const warnings = [
    "Scalar values were replaced with deterministic synthetic values.",
    "Value-dependent branches may diverge and require manual review.",
    "Binary data, credentials, raw errors, and execution identifiers were omitted.",
    ...(llmOutputs.length > 0
      ? [
          "LLM outputs are preserved verbatim under llmOutputs for review; redact before sharing.",
        ]
      : []),
    ...(repeatedRunCollapsed
      ? ["Repeated node runs were collapsed to the final run."]
      : []),
    ...(itemsTruncated
      ? [`Node outputs were truncated to ${limit} items in the draft.`]
      : []),
    ...(mappedWorkflowReviewNeeded
      ? ["Execute Workflow nodes require an explicit workflow map."]
      : []),
  ];

  return {
    version: 1,
    generatedFrom: {
      kind: "n8n-execution-log",
      dataMode: "synthetic-shape",
      reviewRequired: true,
      warnings,
    },
    ...(llmOutputs.length > 0 ? { llmOutputs } : {}),
    cases: [
      {
        name: "imported-execution-draft",
        input: input.length > 0 ? input : [{}],
        mocks,
        ...(inferredStart ? { startNode: inferredStart } : {}),
        ...(execution.startedAt ? { now: execution.startedAt } : {}),
        assertions: {
          ...(execution.status === "success" ? { status: "success" } : {}),
          requiredNodes: reachedNodes,
        },
      },
    ],
  };
}
