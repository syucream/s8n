import { createHash } from "node:crypto";
import type { RunResult } from "./execute.ts";

/**
 * Returns a stable, privacy-preserving representation of observable
 * execution behavior. Wall-clock timing and execution indexes are excluded;
 * node outputs, statuses, mocks, errors, effects, lineage and edge evidence
 * remain part of the comparison.
 */
export function stableRunFingerprint(result: RunResult): string {
  const stable = {
    status: result.status,
    workflowName: result.workflowName,
    trace: result.trace.map((entry) => ({
      nodeName: entry.nodeName,
      nodeType: entry.nodeType,
      status: entry.status,
      inputItemCounts: entry.inputItemCounts,
      outputItemCounts: entry.outputItemCounts,
      inputItemLineage: entry.inputItemLineage,
      outputItemLineage: entry.outputItemLineage,
      source: entry.source,
      data: entry.data,
      pendingMock: entry.pendingMock,
      error: entry.error,
    })),
    nodeOutputs: result.nodeOutputs,
    pendingMocks: result.pendingMocks,
    errors: result.errors,
    effects: result.effects,
    subExecutions: result.subExecutions,
    edgeCoverage: result.edgeCoverage,
    branchCoverage: result.branchCoverage,
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
