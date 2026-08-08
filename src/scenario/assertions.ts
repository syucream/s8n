import { isDeepStrictEqual } from "node:util";
import type { RunResult } from "../engine/execute.ts";
import type { Workflow } from "../schema/workflow.ts";
import type {
  ScenarioAssertions,
  ScenarioNodeOutputAssertion,
} from "./schema.ts";

const NON_EXECUTABLE_NODE_TYPES = new Set(["n8n-nodes-base.stickyNote"]);
const EXECUTED_STATUSES = new Set(["success", "pinned", "error"]);

export interface UncoveredNode {
  node: string;
  reason: string;
}

export interface ScenarioCoverage {
  executableNodes: string[];
  executedNodes: string[];
  ratio: number;
  uncoveredNodes: UncoveredNode[];
}

export interface ScenarioAssertionFailure {
  assertion:
    | "status"
    | "minimumCoverage"
    | "requiredNodes"
    | "forbiddenNodes"
    | "pendingMockCount"
    | "verifiedEffects"
    | "subExecutionCount"
    | "nodeOutputItemCounts"
    | "nodeOutputs";
  message: string;
  expected: unknown;
  actual: unknown;
  node?: string;
  item?: number;
  pointer?: string;
}

export interface ScenarioAssertionResult {
  ok: boolean;
  coverage: ScenarioCoverage;
  failures: ScenarioAssertionFailure[];
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function calculateCoverage(
  workflow: Workflow,
  result: RunResult,
): ScenarioCoverage {
  const mainPipelineNodes = new Set<string>();
  const nonMainPipelineNodes = new Set<string>();
  for (const [source, connectionTypes] of Object.entries(
    workflow.connections,
  )) {
    for (const [connectionType, outputSlots] of Object.entries(
      connectionTypes,
    )) {
      const target =
        connectionType === "main" ? mainPipelineNodes : nonMainPipelineNodes;
      target.add(source);
      for (const outputSlot of outputSlots) {
        for (const connection of outputSlot) target.add(connection.node);
      }
    }
  }
  const executableNodes = workflow.nodes
    .filter(
      (node) =>
        !NON_EXECUTABLE_NODE_TYPES.has(node.type) &&
        !(
          nonMainPipelineNodes.has(node.name) &&
          !mainPipelineNodes.has(node.name)
        ),
    )
    .map((node) => node.name);
  const traceByNode = new Map<string, (typeof result.trace)[number]>();
  for (const trace of result.trace) {
    traceByNode.set(trace.nodeName, trace);
  }
  const executedNodes = executableNodes.filter((name) =>
    result.trace.some(
      (trace) => trace.nodeName === name && EXECUTED_STATUSES.has(trace.status),
    ),
  );
  const uncoveredNodes = executableNodes
    .filter((name) => !executedNodes.includes(name))
    .map((node) => {
      const trace = traceByNode.get(node);
      return { node, reason: trace?.status ?? "not_visited" };
    });
  return {
    executableNodes,
    executedNodes,
    ratio:
      executableNodes.length === 0
        ? 1
        : executedNodes.length / executableNodes.length,
    uncoveredNodes,
  };
}

function readJsonPointer(
  value: unknown,
  pointer: string | undefined,
): {
  exists: boolean;
  value: unknown;
} {
  if (pointer === undefined || pointer === "") return { exists: true, value };
  let current: unknown = value;
  for (const encodedSegment of pointer.slice(1).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      current === null ||
      typeof current !== "object" ||
      !hasOwn(current, segment)
    ) {
      return { exists: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { exists: true, value: current };
}

function evaluateNodeOutput(
  assertion: ScenarioNodeOutputAssertion,
  result: RunResult,
  failures: ScenarioAssertionFailure[],
): void {
  const itemIndex = assertion.item ?? 0;
  const item = result.nodeOutputs[assertion.node]?.[itemIndex];
  const observed = readJsonPointer(item, assertion.pointer);
  const location = {
    node: assertion.node,
    item: itemIndex,
    ...(assertion.pointer === undefined ? {} : { pointer: assertion.pointer }),
  };

  if (assertion.exists !== undefined && observed.exists !== assertion.exists) {
    failures.push({
      assertion: "nodeOutputs",
      message: `Node output existence did not match for ${assertion.node}`,
      expected: assertion.exists,
      actual: observed.exists,
      ...location,
    });
  }
  if (
    hasOwn(assertion, "equals") &&
    !isDeepStrictEqual(observed.value, assertion.equals)
  ) {
    failures.push({
      assertion: "nodeOutputs",
      message: `Node output value did not match for ${assertion.node}`,
      expected: assertion.equals,
      actual: observed.value,
      ...location,
    });
  }
}

/** Evaluates deterministic assertions without evaluating workflow expressions or Code. */
export function evaluateScenarioAssertions(
  workflow: Workflow,
  result: RunResult,
  assertions: ScenarioAssertions = {},
): ScenarioAssertionResult {
  const failures: ScenarioAssertionFailure[] = [];
  const coverage = calculateCoverage(workflow, result);

  if (assertions.status !== undefined && result.status !== assertions.status) {
    failures.push({
      assertion: "status",
      message: "Run status did not match",
      expected: assertions.status,
      actual: result.status,
    });
  }
  if (
    assertions.minimumCoverage !== undefined &&
    coverage.ratio < assertions.minimumCoverage
  ) {
    failures.push({
      assertion: "minimumCoverage",
      message: "Executable node coverage was below the required minimum",
      expected: assertions.minimumCoverage,
      actual: coverage.ratio,
    });
  }
  for (const node of assertions.requiredNodes ?? []) {
    if (!coverage.executedNodes.includes(node)) {
      failures.push({
        assertion: "requiredNodes",
        message: `Required node was not executed: ${node}`,
        expected: true,
        actual: false,
        node,
      });
    }
  }
  for (const node of assertions.forbiddenNodes ?? []) {
    if (coverage.executedNodes.includes(node)) {
      failures.push({
        assertion: "forbiddenNodes",
        message: `Forbidden node was executed: ${node}`,
        expected: false,
        actual: true,
        node,
      });
    }
  }
  if (
    assertions.pendingMockCount !== undefined &&
    result.pendingMocks.length !== assertions.pendingMockCount
  ) {
    failures.push({
      assertion: "pendingMockCount",
      message: "Pending mock count did not match",
      expected: assertions.pendingMockCount,
      actual: result.pendingMocks.length,
    });
  }
  if (assertions.verifiedEffects !== undefined) {
    const verified =
      result.effects.length > 0 &&
      result.effects.every((effect) => effect.verified);
    if (verified !== assertions.verifiedEffects) {
      failures.push({
        assertion: "verifiedEffects",
        message: "Effect verification state did not match",
        expected: assertions.verifiedEffects,
        actual: verified,
      });
    }
  }
  if (
    assertions.subExecutionCount !== undefined &&
    result.subExecutions.length !== assertions.subExecutionCount
  ) {
    failures.push({
      assertion: "subExecutionCount",
      message: "Sub-workflow execution count did not match",
      expected: assertions.subExecutionCount,
      actual: result.subExecutions.length,
    });
  }
  for (const [node, expected] of Object.entries(
    assertions.nodeOutputItemCounts ?? {},
  )) {
    const actual = result.nodeOutputs[node]?.length;
    if (actual !== expected) {
      failures.push({
        assertion: "nodeOutputItemCounts",
        message: `Final main output item count did not match for ${node}`,
        expected,
        actual,
        node,
      });
    }
  }
  for (const assertion of assertions.nodeOutputs ?? []) {
    evaluateNodeOutput(assertion, result, failures);
  }

  return { ok: failures.length === 0, coverage, failures };
}
