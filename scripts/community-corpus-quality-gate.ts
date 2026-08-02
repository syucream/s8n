#!/usr/bin/env bun
import { type RunResult, runWorkflow } from "../src/engine/execute.ts";
import { toN8nExecutionLog } from "../src/format/n8n-execution.ts";
import { extractReferencedJsonFields } from "../src/mock/field-hints.ts";
import { findNodeTypeMockHint } from "../src/mock/node-type-hints.ts";
import { normalizeMockToItems } from "../src/mock/normalize.ts";
import { createMockLookup, lookupItemMock } from "../src/mock/provider.ts";
import {
  createDefaultRegistry,
  type NodeRegistry,
} from "../src/nodes/registry.ts";
import type { NodeExecutor } from "../src/nodes/types.ts";
import { toItems } from "../src/schema/item.ts";
import { validateWorkflow, type Workflow } from "../src/schema/workflow.ts";

const API_ROOT = "https://api.n8n.io/api/templates";
const CORPUS_DATE = "2026-08-02";
const SAFELY_MOCKED_BUILTINS = new Set(["n8n-nodes-base.code"]);
const EXECUTION_LOG_ONLY = process.argv.includes("--execution-log-only");
const DETAIL_IDS = new Set(
  (process.argv.find((argument) => argument.startsWith("--details=")) ?? "")
    .replace("--details=", "")
    .split(",")
    .map(Number)
    .filter(Number.isFinite),
);
const DETAIL_ITEM_LIMIT = Math.max(
  0,
  Number(
    (
      process.argv.find((argument) =>
        argument.startsWith("--truncate-data="),
      ) ?? "--truncate-data=1"
    ).replace("--truncate-data=", ""),
  ),
);

// Snapshot of the 100 highest-trending public templates on CORPUS_DATE.
// We retain only IDs, never third-party workflow JSON. This keeps the gate
// reproducible while fetching the current published definition at run time.
const TEMPLATE_IDS = [
  5962, 13526, 13536, 10000, 14020, 13544, 5035, 11204, 5148, 16921, 16789,
  10212, 10566, 5110, 17522, 5677, 16192, 11205, 4827, 5626, 5010, 17313, 13270,
  4968, 5523, 16209, 9786, 14805, 11632, 10126, 17046, 13271, 14267, 10119,
  16963, 17039, 9521, 14019, 5948, 13863, 17288, 9576, 13269, 4966, 17032,
  10174, 10358, 17554, 17552, 9437, 17075, 17010, 16801, 16798, 4722, 5979,
  10665, 5691, 16234, 10531, 5608, 4110, 9633, 17074, 5541, 14254, 5755, 10196,
  5676, 16937, 16693, 5228, 9876, 5690, 13675, 10136, 9803, 9802, 9800, 9799,
  9797, 9793, 5683, 14321, 10129, 11254, 16978, 16977, 14808, 14272, 11253,
  4600, 14802, 11631, 16201, 12663, 10793, 14268, 10125, 5906,
] as const;

interface TemplateResponse {
  workflow?: {
    id?: number;
    name?: string;
    workflow?: unknown;
  };
}

interface LoadedTemplate {
  id: number;
  name: string;
  workflow: Workflow;
}

interface CorpusFailure {
  id: number;
  name?: string;
  stage: "fetch" | "validate" | "execute";
  detail: string;
}

interface SimulationAttempt {
  result: RunResult;
  startNode?: string;
}

function canonicalAsciiName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function repairPublishedConnectionNames(raw: Record<string, unknown>): unknown {
  if (
    !Array.isArray(raw.nodes) ||
    raw.connections === null ||
    typeof raw.connections !== "object"
  ) {
    return raw;
  }
  const nodeNames = raw.nodes
    .map((node) =>
      node !== null && typeof node === "object" && "name" in node
        ? String(node.name)
        : "",
    )
    .filter(Boolean);
  const byCanonical = new Map<string, string[]>();
  for (const name of nodeNames) {
    const canonical = canonicalAsciiName(name);
    if (!canonical) continue;
    byCanonical.set(canonical, [...(byCanonical.get(canonical) ?? []), name]);
  }
  const resolve = (name: string) => {
    if (nodeNames.includes(name)) return name;
    const matches = byCanonical.get(canonicalAsciiName(name)) ?? [];
    return matches.length === 1 ? matches[0] : name;
  };
  return {
    ...raw,
    connections: Object.fromEntries(
      Object.entries(raw.connections as Record<string, unknown>).map(
        ([source, value]) => [resolve(source), value],
      ),
    ),
  };
}

const COMMON_DATA: Record<string, unknown> = {
  id: "sample-1",
  name: "Sample User",
  firstName: "Sample",
  lastName: "User",
  email: "sample@example.com",
  subject: "Representative workflow sample",
  text: "Representative workflow sample",
  message: "Representative workflow sample",
  content: "Representative workflow sample",
  output: "Representative simulated output",
  status: "success",
  success: true,
  url: "https://example.invalid/sample",
  timestamp: "2026-08-02T00:00:00.000Z",
  createdAt: "2026-08-02T00:00:00.000Z",
  amount: 42,
  count: 1,
  value: "sample",
  data: {
    id: "sample-1",
    text: "Representative workflow sample",
    output: "Representative simulated output",
    url: "https://example.invalid/sample",
    items: [{ id: "sample-1", value: "sample" }],
  },
  body: {
    id: "sample-1",
    name: "Sample User",
    email: "sample@example.com",
    text: "Representative workflow sample",
    message: "Representative workflow sample",
    prompt: "Summarize this representative sample",
    records: [{ id: "sample-1", value: "sample" }],
  },
  query: {},
  headers: { "content-type": "application/json" },
};

function buildSyntheticData(workflow: Workflow): Record<string, unknown> {
  const data = structuredClone(COMMON_DATA);
  for (const field of extractReferencedJsonFields(workflow)) {
    if (!Object.hasOwn(data, field)) data[field] = `sample-${field}`;
  }
  return data;
}

function buildMocks(
  workflow: Workflow,
  syntheticData: Record<string, unknown>,
): Record<string, unknown> {
  const mocks: Record<string, unknown> = {};
  for (const node of workflow.nodes) {
    const hint = findNodeTypeMockHint(node.type);
    mocks[node.name] = {
      ...structuredClone(syntheticData),
      ...(hint ? structuredClone(hint.example) : {}),
    };
  }
  return mocks;
}

/**
 * Public templates are untrusted input. s8n intentionally supports full
 * JavaScript expressions for caller-owned workflows, but the corpus gate
 * must never evaluate code downloaded from the internet. Expression values
 * are replaced with deterministic data before execution; Code nodes use the
 * safe mock executor below. The report labels those visits as mocked.
 */
function neutralizeExpressions(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("=")) return "sample";
  if (Array.isArray(value)) return value.map(neutralizeExpressions);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        neutralizeExpressions(entry),
      ]),
    );
  }
  return value;
}

function safeCorpusWorkflow(workflow: Workflow): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      const parameters = neutralizeExpressions(node.parameters) as Record<
        string,
        unknown
      >;
      if (
        node.type === "n8n-nodes-base.set" &&
        parameters.mode === "raw" &&
        typeof node.parameters.jsonOutput === "string" &&
        node.parameters.jsonOutput.startsWith("=")
      ) {
        // Raw Set expressions are JavaScript object literals, not strict
        // JSON. Never evaluate downloaded code in the corpus process.
        parameters.jsonOutput = "{}";
      }
      return { ...node, parameters };
    }),
  };
}

const safeCodeMockExecutor: NodeExecutor = {
  type: "n8n-nodes-base.code",
  execute: ({ node, inputItems, runtime }) => {
    const mock = lookupItemMock(runtime.mocks, node.name, 0);
    if (mock === undefined) {
      return {
        status: "error",
        message: `Safe corpus execution requires a mock for Code node "${node.name}"`,
      };
    }
    return {
      status: "success",
      output: [
        normalizeMockToItems(mock, inputItems[0]?.pairedItem?.item ?? 0),
      ],
    };
  },
};

function createCorpusRegistry(): NodeRegistry {
  const registry = createDefaultRegistry();
  registry.register(safeCodeMockExecutor);
  return registry;
}

function scoreRun(result: RunResult): number {
  const successfulVisits = result.trace.filter((entry) =>
    ["success", "pinned", "skipped_disabled", "skipped_annotation"].includes(
      entry.status,
    ),
  ).length;
  const statusBonus = result.status === "success" ? 1_000_000 : 0;
  return statusBonus + successfulVisits;
}

async function executeBestStart(
  workflow: Workflow,
): Promise<SimulationAttempt> {
  const safeWorkflow = safeCorpusWorkflow(workflow);
  const syntheticData = buildSyntheticData(safeWorkflow);
  const options = {
    initialInput: toItems([syntheticData]),
    hasExplicitInput: true,
    mocks: createMockLookup(buildMocks(safeWorkflow, syntheticData)),
    registry: createCorpusRegistry(),
    now: new Date("2026-08-02T00:00:00.000Z"),
  };
  const initial = await runWorkflow(safeWorkflow, options);
  if (initial.status !== "needs_start_node") {
    const startNode = initial.trace.find(
      (entry) => entry.status === "success" || entry.status === "pinned",
    )?.nodeName;
    return { result: initial, startNode };
  }

  const attempts = await Promise.all(
    (initial.startNodeCandidates ?? []).map((candidate) =>
      runWorkflow(safeWorkflow, { ...options, startNode: candidate.name }).then(
        (result) => ({ result, startNode: candidate.name }),
      ),
    ),
  );
  return (
    attempts.sort(
      (left, right) => scoreRun(right.result) - scoreRun(left.result),
    )[0] ?? { result: initial }
  );
}

function compactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string")
    return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  if (value === null || typeof value !== "object") return value;
  if (depth >= 2)
    return Array.isArray(value) ? `[${value.length} items]` : "{...}";
  if (Array.isArray(value))
    return value.slice(0, 3).map((entry) => compactValue(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 12)
      .map(([key, entry]) => [key, compactValue(entry, depth + 1)]),
  );
}

function buildSimulationDetail(
  template: LoadedTemplate,
  attempt: SimulationAttempt,
) {
  const { result } = attempt;
  const registry = createDefaultRegistry();
  const reached = result.trace.filter((entry) =>
    ["success", "pinned", "skipped_no_data"].includes(entry.status),
  );
  const outputNodes = [...reached]
    .reverse()
    .filter((entry) => result.nodeOutputs[entry.nodeName] !== undefined)
    .slice(0, 3)
    .reverse();
  return {
    id: template.id,
    title: template.name,
    source: `https://n8n.io/workflows/${template.id}`,
    workflowName: template.workflow.name,
    nodeCount: template.workflow.nodes.length,
    startNode: attempt.startNode,
    status: result.status,
    reachedNodeVisits: reached.length,
    builtinVisits: reached.filter(
      (entry) =>
        registry.has(entry.nodeType) &&
        !SAFELY_MOCKED_BUILTINS.has(entry.nodeType),
    ).length,
    mockedVisits: reached.filter(
      (entry) =>
        !registry.has(entry.nodeType) ||
        SAFELY_MOCKED_BUILTINS.has(entry.nodeType),
    ).length,
    trace: reached.map((entry) => ({
      node: entry.nodeName,
      type: entry.nodeType,
      status: entry.status,
      inputItems: entry.inputItemCounts,
      outputItems: entry.outputItemCounts,
      mode:
        registry.has(entry.nodeType) &&
        !SAFELY_MOCKED_BUILTINS.has(entry.nodeType)
          ? "builtin"
          : "safe-mock",
    })),
    outputPreviews: outputNodes.map((entry) => ({
      node: entry.nodeName,
      items: result.nodeOutputs[entry.nodeName]?.length ?? 0,
      firstItem: compactValue(result.nodeOutputs[entry.nodeName]?.[0]?.json),
    })),
    errors: result.errors,
    execution: toN8nExecutionLog(result, {
      workflowId: String(template.id),
      startNode: attempt.startNode,
      truncateData: DETAIL_ITEM_LIMIT,
      metadataForTrace: (entry) => ({
        s8nSimulationMode:
          registry.has(entry.nodeType) &&
          !SAFELY_MOCKED_BUILTINS.has(entry.nodeType)
            ? "builtin"
            : "safe-mock",
      }),
    }),
  };
}

async function loadTemplate(id: number): Promise<LoadedTemplate> {
  const response = await fetch(`${API_ROOT}/workflows/${id}`, {
    headers: { "user-agent": "s8n-community-corpus-quality-gate/0.3" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as TemplateResponse;
  const published = payload.workflow;
  const raw = published?.workflow;
  const candidate =
    raw !== null && typeof raw === "object"
      ? repairPublishedConnectionNames({
          name: published?.name ?? `Template ${id}`,
          ...raw,
        })
      : raw;
  const validated = validateWorkflow(candidate);
  if (!validated.valid || !validated.workflow) {
    throw new Error(JSON.stringify(validated.issues));
  }
  return {
    id,
    name: payload.workflow?.name ?? validated.workflow.name,
    workflow: validated.workflow,
  };
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = Array<PromiseSettledResult<R>>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        try {
          results[index] = {
            status: "fulfilled",
            value: await mapper(values[index] as T),
          };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    }),
  );
  return results;
}

async function main(): Promise<void> {
  const registry = createDefaultRegistry();
  const failures: CorpusFailure[] = [];
  const loaded: LoadedTemplate[] = [];
  const fetched = await mapConcurrent(TEMPLATE_IDS, 8, loadTemplate);
  fetched.forEach((result, index) => {
    const id = TEMPLATE_IDS[index] as number;
    if (result.status === "fulfilled") loaded.push(result.value);
    else failures.push({ id, stage: "fetch", detail: String(result.reason) });
  });

  const nodeTypeWorkflows = new Map<string, Set<number>>();
  const runStatuses = new Map<string, number>();
  const failuresByNodeType = new Map<string, number>();
  let successfulWorkflows = 0;
  let totalNodes = 0;
  let executedVisits = 0;
  let builtinVisits = 0;
  let mockedVisits = 0;
  const details: ReturnType<typeof buildSimulationDetail>[] = [];

  for (const template of loaded) {
    totalNodes += template.workflow.nodes.length;
    for (const node of template.workflow.nodes) {
      const ids = nodeTypeWorkflows.get(node.type) ?? new Set<number>();
      ids.add(template.id);
      nodeTypeWorkflows.set(node.type, ids);
    }
    try {
      const attempt = await executeBestStart(template.workflow);
      const { result } = attempt;
      if (DETAIL_IDS.has(template.id)) {
        details.push(buildSimulationDetail(template, attempt));
      }
      runStatuses.set(result.status, (runStatuses.get(result.status) ?? 0) + 1);
      if (result.status === "success") successfulWorkflows++;
      else {
        failures.push({
          id: template.id,
          name: template.name,
          stage: "execute",
          detail: result.errors.join("; ") || result.status,
        });
        for (const entry of result.trace.filter(
          (item) => item.status === "error",
        )) {
          failuresByNodeType.set(
            entry.nodeType,
            (failuresByNodeType.get(entry.nodeType) ?? 0) + 1,
          );
        }
      }
      for (const entry of result.trace) {
        if (entry.status !== "success" && entry.status !== "pinned") continue;
        executedVisits++;
        if (
          registry.has(entry.nodeType) &&
          !SAFELY_MOCKED_BUILTINS.has(entry.nodeType)
        )
          builtinVisits++;
        else mockedVisits++;
      }
    } catch (cause) {
      failures.push({
        id: template.id,
        name: template.name,
        stage: "execute",
        detail: String((cause as Error)?.message ?? cause),
      });
    }
  }

  const topNodeTypes = [...nodeTypeWorkflows.entries()]
    .map(([type, ids]) => ({
      type,
      workflowCount: ids.size,
      mode:
        registry.has(type) && !SAFELY_MOCKED_BUILTINS.has(type)
          ? "builtin"
          : type === "n8n-nodes-base.code"
            ? "mocked-untrusted-code"
            : "mocked-external-io",
      tailoredMock: findNodeTypeMockHint(type) !== undefined,
    }))
    .sort(
      (left, right) =>
        right.workflowCount - left.workflowCount ||
        left.type.localeCompare(right.type),
    );

  const report = {
    ok: loaded.length === TEMPLATE_IDS.length && successfulWorkflows >= 95,
    gate: "community-corpus",
    corpus: {
      source: "https://n8n.io/workflows/",
      selection: `top 100 by trendingScore on ${CORPUS_DATE}`,
      requested: TEMPLATE_IDS.length,
      fetchedAndValidated: loaded.length,
    },
    simulation: {
      successfulWorkflows,
      successRate:
        loaded.length === 0 ? 0 : successfulWorkflows / loaded.length,
      statuses: Object.fromEntries([...runStatuses].sort()),
      totalNodes,
      executedVisits,
      builtinVisits,
      mockedExternalVisits: mockedVisits,
    },
    representativeNodeTypes: topNodeTypes.slice(0, 30),
    failuresByNodeType: Object.fromEntries(
      [...failuresByNodeType].sort((left, right) => right[1] - left[1]),
    ),
    failures,
    ...(DETAIL_IDS.size > 0
      ? { details: details.sort((left, right) => left.id - right.id) }
      : {}),
  };
  const output = EXECUTION_LOG_ONLY
    ? {
        executions: details
          .sort((left, right) => left.id - right.id)
          .map(({ id, title, source, execution }) => ({
            id,
            title,
            source,
            execution,
          })),
      }
    : report;
  console.log(JSON.stringify(output, null, 2));
  if (!report.ok) process.exitCode = 1;
}

await main();
