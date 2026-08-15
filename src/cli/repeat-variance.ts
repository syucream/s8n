import { createHash } from "node:crypto";
import type { RunResult } from "../engine/execute.ts";

/**
 * Variance report for `s8n run --repeat N`: does the workflow produce
 * identical output every time, or does it spread across multiple shapes?
 * Item-count spread per node and a hash of each run's full output answer
 * "is this workflow deterministic?" in a single glance.
 */

export interface RepeatVarianceReport {
  count: number;
  /** True when every run produced an identical final output. */
  deterministic: boolean;
  /** Number of distinct final outputs observed across runs. */
  distinctCount: number;
  /** Distinct final item counts observed per node, ascending. */
  cardinality: Record<string, number[]>;
  /** Short hash of each run's final output, in run order. */
  outputHashes: string[];
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortKeysDeep(entry)]),
    );
  }
  return value;
}

function outputHash(nodeOutputs: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(sortKeysDeep(nodeOutputs)))
    .digest("hex")
    .slice(0, 16);
}

export function computeRepeatVariance(
  results: RunResult[],
): RepeatVarianceReport {
  const cardinality = new Map<string, Set<number>>();
  const outputHashes: string[] = [];
  for (const result of results) {
    outputHashes.push(outputHash(result.nodeOutputs));
    for (const [node, items] of Object.entries(result.nodeOutputs)) {
      const counts = cardinality.get(node) ?? new Set<number>();
      counts.add(items.length);
      cardinality.set(node, counts);
    }
  }
  const distinctCount = new Set(outputHashes).size;
  return {
    count: results.length,
    deterministic: distinctCount === 1,
    distinctCount,
    cardinality: Object.fromEntries(
      [...cardinality.entries()].map(([node, counts]) => [
        node,
        [...counts].sort((a, b) => a - b),
      ]),
    ),
    outputHashes,
  };
}
