import { isDeepStrictEqual } from "node:util";
import type { NodeTraceEntry, RunResult } from "../engine/execute.ts";
import { analyzeGraph } from "../engine/graph.ts";
import type { Item } from "../schema/item.ts";
import type { Workflow } from "../schema/workflow.ts";
import type { TestRunOutcome } from "./types.ts";

/**
 * Raised by matchers when an assertion does not hold. The runner catches it
 * and records the message as a case failure. Messages deliberately report
 * types and counts rather than raw item values, consistent with the existing
 * scenario-assertion redaction convention.
 */
export class TestAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestAssertionError";
  }
}

/** Statuses that mean a node actually executed (as opposed to being skipped). */
const EXECUTED_STATUSES = new Set<string>([
  "success",
  "error",
  "pinned",
  "waiting",
  "waiting_mock",
]);

export interface RanMatcher {
  /** Every run of this node completed before every run of the other node. */
  before(other: string): void;
  /** Every run of this node completed after every run of the other node. */
  after(other: string): void;
  /** At least one run of this node completed before one run of the other node. */
  beforeAny(other: string): void;
  /** At least one run of this node completed after one run of the other node. */
  afterAny(other: string): void;
}

export interface PointerMatcher {
  exists(): void;
  equals(value: unknown): void;
  matches(regex: RegExp | string): void;
  notMatches(regex: RegExp | string): void;
}

export interface ItemMatcher {
  pointer(path: string): PointerMatcher;
}

export interface OutputMatcher {
  count(expected: number): void;
  item(index: number): ItemMatcher;
}

export interface ReachingMatcher {
  /** Items that reached the target node flowed through the gate node. */
  passedThrough(node: string): void;
}

export interface PathMatcher {
  /** Every static path from a start node to the target passes through the gate. */
  passThrough(node: string): void;
}

export interface Expect {
  status(expected: RunResult["status"]): void;
  ran(node: string): RanMatcher;
  never(node: string): void;
  outputOf(node: string): OutputMatcher;
  itemReaching(node: string): ReachingMatcher;
  allPathsTo(node: string): PathMatcher;
}

function requireResult(outcome: TestRunOutcome): RunResult {
  if (!outcome.ok) {
    throw new TestAssertionError(`Workflow failed to run: ${outcome.error}`);
  }
  return outcome.result;
}

function requireWorkflow(outcome: TestRunOutcome): Workflow {
  if (!outcome.ok) {
    throw new TestAssertionError(`Workflow failed to run: ${outcome.error}`);
  }
  return outcome.workflow;
}

function executedEntries(result: RunResult, node: string): NodeTraceEntry[] {
  return result.trace.filter(
    (entry) => entry.nodeName === node && EXECUTED_STATUSES.has(entry.status),
  );
}

function entryIndices(entries: NodeTraceEntry[]): number[] {
  return entries
    .map((entry) => entry.executionIndex)
    .filter((index): index is number => index !== undefined);
}

function requireExecuted(result: RunResult, node: string): NodeTraceEntry[] {
  const entries = executedEntries(result, node);
  if (entries.length === 0) {
    throw new TestAssertionError(`Node "${node}" did not execute`);
  }
  return entries;
}

function readJsonPointer(
  value: unknown,
  pointer: string,
): { exists: boolean; value: unknown } {
  let current: unknown = value;
  for (const encodedSegment of pointer.slice(1).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, segment)
    ) {
      return { exists: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { exists: true, value: current };
}

function toRegExp(regex: RegExp | string): RegExp {
  return regex instanceof RegExp ? regex : new RegExp(regex);
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return "null";
  return typeof value;
}

function pointerMatcher(
  value: unknown,
  pointer: string,
  label: string,
): PointerMatcher {
  const observed = readJsonPointer(value, pointer);
  const location = `${label} at ${pointer}`;
  return {
    exists(): void {
      if (!observed.exists) {
        throw new TestAssertionError(
          `Expected value to exist at ${location}, but it was absent`,
        );
      }
    },
    equals(expected: unknown): void {
      if (!observed.exists || !isDeepStrictEqual(observed.value, expected)) {
        throw new TestAssertionError(
          `Expected value at ${location} to equal ${describeValue(expected)}, got ${describeValue(observed.value)}`,
        );
      }
    },
    matches(regex: RegExp | string): void {
      const observedValue = observed.value;
      if (typeof observedValue !== "string") {
        throw new TestAssertionError(
          `Expected a string value at ${location} for matches, got ${describeValue(observedValue)}`,
        );
      }
      if (!toRegExp(regex).test(observedValue)) {
        throw new TestAssertionError(
          `Expected string at ${location} to match ${String(regex)}`,
        );
      }
    },
    notMatches(regex: RegExp | string): void {
      const observedValue = observed.value;
      if (typeof observedValue !== "string") {
        throw new TestAssertionError(
          `Expected a string value at ${location} for notMatches, got ${describeValue(observedValue)}`,
        );
      }
      if (toRegExp(regex).test(observedValue)) {
        throw new TestAssertionError(
          `Expected string at ${location} not to match ${String(regex)}`,
        );
      }
    },
  };
}

/**
 * Builds the matcher DSL for one run outcome. Each matcher is a thin,
 * message-safe wrapper over the full engine result; tests can always read
 * `outcome.result` directly for anything the matchers do not cover.
 */
export function createExpect(outcome: TestRunOutcome): Expect {
  return {
    status(expected: RunResult["status"]): void {
      const result = requireResult(outcome);
      if (result.status !== expected) {
        throw new TestAssertionError(
          `Expected workflow status ${expected}, got ${result.status}`,
        );
      }
    },
    ran(node: string): RanMatcher {
      const result = requireResult(outcome);
      // `ran` itself asserts the node executed; the returned matcher adds
      // optional ordering constraints.
      const indices = entryIndices(requireExecuted(result, node));
      return {
        before(other: string): void {
          const otherIndices = entryIndices(requireExecuted(result, other));
          const maxSelf = Math.max(...indices);
          const minOther = Math.min(...otherIndices);
          if (maxSelf >= minOther) {
            throw new TestAssertionError(
              `Expected every run of "${node}" to finish before any run of "${other}" (node ran ${indices.length} time(s), other ran ${otherIndices.length} time(s))`,
            );
          }
        },
        after(other: string): void {
          const otherIndices = entryIndices(requireExecuted(result, other));
          const minSelf = Math.min(...indices);
          const maxOther = Math.max(...otherIndices);
          if (minSelf <= maxOther) {
            throw new TestAssertionError(
              `Expected every run of "${node}" to finish after every run of "${other}" (node ran ${indices.length} time(s), other ran ${otherIndices.length} time(s))`,
            );
          }
        },
        beforeAny(other: string): void {
          const otherIndices = entryIndices(requireExecuted(result, other));
          const minSelf = Math.min(...indices);
          const maxOther = Math.max(...otherIndices);
          if (minSelf >= maxOther) {
            throw new TestAssertionError(
              `Expected some run of "${node}" to finish before some run of "${other}"`,
            );
          }
        },
        afterAny(other: string): void {
          const otherIndices = entryIndices(requireExecuted(result, other));
          const maxSelf = Math.max(...indices);
          const minOther = Math.min(...otherIndices);
          if (maxSelf <= minOther) {
            throw new TestAssertionError(
              `Expected some run of "${node}" to finish after some run of "${other}"`,
            );
          }
        },
      };
    },
    never(node: string): void {
      const result = requireResult(outcome);
      const entries = executedEntries(result, node);
      if (entries.length > 0) {
        throw new TestAssertionError(
          `Expected node "${node}" not to execute, but it ran ${entries.length} time(s)`,
        );
      }
    },
    outputOf(node: string): OutputMatcher {
      const result = requireResult(outcome);
      const items: Item[] = result.nodeOutputs[node] ?? [];
      const label = `Node "${node}"`;
      return {
        count(expected: number): void {
          if (items.length !== expected) {
            throw new TestAssertionError(
              `Expected ${label} to output ${expected} item(s), got ${items.length}`,
            );
          }
        },
        item(index: number): ItemMatcher {
          const item = items[index];
          if (item === undefined) {
            throw new TestAssertionError(
              `Expected ${label} to have an output item at index ${index}, but it has ${items.length}`,
            );
          }
          return {
            pointer(path: string): PointerMatcher {
              return pointerMatcher(item, path, `${label} item ${index}`);
            },
          };
        },
      };
    },
    itemReaching(node: string): ReachingMatcher {
      const result = requireResult(outcome);
      return {
        passedThrough(gate: string): void {
          if (!hasItemFlowedThrough(result, node, gate)) {
            throw new TestAssertionError(
              `Expected items reaching "${node}" to have flowed through "${gate}"`,
            );
          }
        },
      };
    },
    allPathsTo(node: string): PathMatcher {
      const workflow = requireWorkflow(outcome);
      return {
        passThrough(gate: string): void {
          if (!allPathsPassThrough(workflow, node, gate)) {
            throw new TestAssertionError(
              `Expected every static path to "${node}" to pass through "${gate}"`,
            );
          }
        },
      };
    },
  };
}

function buildMainAdjacency(workflow: Workflow): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const [source, nodeConnections] of Object.entries(
    workflow.connections,
  )) {
    const destinations: string[] = [];
    for (const outputSlot of nodeConnections.main ?? []) {
      for (const destination of outputSlot ?? []) {
        destinations.push(destination.node);
      }
    }
    adjacency.set(source, destinations);
  }
  return adjacency;
}

/**
 * Dynamic data-flow provenance: walks the execution's `source` chains
 * backwards from the target node to decide whether data passed through the
 * gate node. This is node-execution-level provenance, not per-item lineage;
 * a merged input where only some items came from the gate still counts as a
 * pass. Bounded by the number of trace entries.
 */
function hasItemFlowedThrough(
  result: RunResult,
  target: string,
  gate: string,
): boolean {
  const byName = new Map<string, NodeTraceEntry[]>();
  for (const entry of result.trace) {
    const list = byName.get(entry.nodeName) ?? [];
    list.push(entry);
    byName.set(entry.nodeName, list);
  }

  const start = (byName.get(target) ?? []).filter((entry) =>
    EXECUTED_STATUSES.has(entry.status),
  );
  if (target === gate && start.length > 0) return true;

  const visited = new Set<string>();
  const queue: NodeTraceEntry[] = [...start];
  let budget = result.trace.length + 1;
  while (queue.length > 0 && budget-- > 0) {
    const entry = queue.shift() as NodeTraceEntry;
    const key = `${entry.nodeName}#${entry.runIndex ?? 0}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (entry.nodeName === gate) return true;
    for (const source of entry.source ?? []) {
      const candidates = (byName.get(source.previousNode) ?? []).filter(
        (candidate) => EXECUTED_STATUSES.has(candidate.status),
      );
      const matches =
        source.previousNodeRun === undefined
          ? candidates
          : candidates.filter(
              (candidate) => candidate.runIndex === source.previousNodeRun,
            );
      const selected = matches.length > 0 ? matches : candidates;
      for (const candidate of selected) {
        const candidateKey = `${candidate.nodeName}#${candidate.runIndex ?? 0}`;
        if (!visited.has(candidateKey)) queue.push(candidate);
      }
    }
  }
  return false;
}

/**
 * Static reachability: every path from a start node to the target must pass
 * through the gate. Implemented as "no path can reach the target while
 * avoiding the gate", which is a single BFS over the main-connection graph and
 * cannot explode with loops. When the target node is the gate itself, the
 * check trivially holds.
 */
function allPathsPassThrough(
  workflow: Workflow,
  target: string,
  gate: string,
): boolean {
  if (target === gate) return true;
  const adjacency = buildMainAdjacency(workflow);
  const startNodes = analyzeGraph(workflow).startNodes;
  const visited = new Set<string>();
  const queue = [...startNodes];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === gate) continue;
    if (current === target) return false;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(adjacency.get(current) ?? []));
  }
  return true;
}
