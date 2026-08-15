import { isDeepStrictEqual } from "node:util";
import type { ExecutionRun } from "./import-execution.ts";

/**
 * Offline precision/recall evaluation over real execution data
 * (`s8n eval`). s8n never calls an LLM itself; instead an author re-runs
 * their workflow in real n8n, exports the execution JSON, and this module
 * scores the agent's actual output (read from runData) against a fixed
 * fixture of expected results. That turns LLM workflows into
 * "did it get better or worse" comparisons instead of binary pass/fail.
 */

export interface EvalExpectationCase {
  /** Node whose last run output holds the extracted result list. */
  node: string;
  /** JSON Pointer to the result array inside that item's json. */
  pointer: string;
  /** The expected elements (the fixture's "ground truth" set). */
  expected: unknown[];
  /** When set, elements are matched by this field's value instead of deep equality. */
  key?: string;
}

export interface EvalCaseResult {
  node: string;
  expectedCount: number;
  actualCount: number;
  matched: number;
  /** matched / actualCount; 0 when the node produced no extractable list. */
  precision: number;
  /** matched / expectedCount. */
  recall: number;
  error?: string;
}

export interface EvalResult {
  cases: EvalCaseResult[];
  aggregate: {
    caseCount: number;
    precision: number;
    recall: number;
  };
}

function readPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  let current: unknown = value;
  for (const encodedSegment of pointer.slice(1).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current as Record<string, unknown>, segment)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function lastRunItems(
  runs: ExecutionRun[] | undefined,
): Record<string, unknown>[] | undefined {
  const items = runs?.at(-1)?.data?.main?.[0];
  if (!Array.isArray(items)) return undefined;
  return items.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const json = (item as Record<string, unknown>).json;
    return json !== null && typeof json === "object" && !Array.isArray(json)
      ? [json as Record<string, unknown>]
      : [];
  });
}

function keyOf(element: unknown, key?: string): unknown {
  if (key === undefined) return element;
  return element !== null &&
    typeof element === "object" &&
    Object.hasOwn(element as Record<string, unknown>, key)
    ? (element as Record<string, unknown>)[key]
    : undefined;
}

function evaluateCase(
  entry: EvalExpectationCase,
  runs: ExecutionRun[] | undefined,
): EvalCaseResult {
  const expectedCount = entry.expected.length;
  const items = lastRunItems(runs);
  const rawActual =
    items === undefined ? undefined : readPointer(items[0], entry.pointer);
  if (!Array.isArray(rawActual)) {
    return {
      node: entry.node,
      expectedCount,
      actualCount: 0,
      matched: 0,
      precision: 0,
      recall: 0,
      error: `Node "${entry.node}" produced no array at pointer ${entry.pointer}`,
    };
  }
  const actual = rawActual as unknown[];
  // Multiset matching: every expected element must be consumed by a
  // distinct actual element for it to count as a match.
  const expectedPool = entry.expected.map((element) => ({
    element,
    key: keyOf(element, entry.key),
  }));
  let matched = 0;
  for (const actualElement of actual) {
    const actualKey = keyOf(actualElement, entry.key);
    const index = expectedPool.findIndex((candidate) =>
      entry.key !== undefined
        ? isDeepStrictEqual(candidate.key, actualKey)
        : isDeepStrictEqual(candidate.element, actualElement),
    );
    if (index !== -1) {
      matched++;
      expectedPool.splice(index, 1);
    }
  }
  return {
    node: entry.node,
    expectedCount,
    actualCount: actual.length,
    matched,
    precision: actual.length === 0 ? 0 : matched / actual.length,
    recall: expectedCount === 0 ? 0 : matched / expectedCount,
  };
}

export function evaluateExecutionAgainstExpectations(
  runData: Record<string, ExecutionRun[]>,
  cases: EvalExpectationCase[],
): EvalResult {
  const caseResults = cases.map((entry) =>
    evaluateCase(entry, runData[entry.node]),
  );
  const meaningful = caseResults.filter((entry) => entry.error === undefined);
  const average = (values: number[]) =>
    values.length === 0
      ? 0
      : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    cases: caseResults,
    aggregate: {
      caseCount: caseResults.length,
      precision: average(meaningful.map((entry) => entry.precision)),
      recall: average(meaningful.map((entry) => entry.recall)),
    },
  };
}
