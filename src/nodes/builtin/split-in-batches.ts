import type { NodeExecutor } from "../types.ts";

/**
 * Split In Batches (Loop Over Items): real n8n iterates, re-executing the
 * loop body once per batch and firing `done` (output 0) only after the
 * final batch, `loop` (output 1) once per batch - verified against
 * `packages/nodes-base/nodes/SplitInBatches/v3/SplitInBatchesV3.node.ts`
 * (`outputNames: ['done', 'loop']`, `parameters.batchSize`). The node itself
 * has no iteration logic - the *engine* re-invokes it via the `loop`
 * output's back-edge until the batch queue empties.
 *
 * s8n's engine (`src/engine/execute.ts`, see `graph.loops`/`runLoopDriver`)
 * detects a genuine back-edge from this node's `loop` output to itself and,
 * when found, re-executes the loop body once per batch for real (resetting
 * and re-running just the body node set each iteration), fixing the
 * historical "Code node relying on real per-batch invocation only sees the
 * first item" divergence. This executor is only reached as a fallback for a
 * malformed/unusual SIB with no detected back-edge (e.g. its `loop` output
 * isn't wired anywhere) - in that case there is no real loop to drive, so it
 * collapses to a single pass: all items go to `loop`, `done` gets nothing.
 */
export const splitInBatchesExecutor: NodeExecutor = {
  type: "n8n-nodes-base.splitInBatches",
  execute: ({ inputItems }) => ({
    status: "success",
    output: [[], inputItems],
  }),
};
