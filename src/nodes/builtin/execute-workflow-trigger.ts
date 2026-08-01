import type { NodeExecutor } from "../types.ts";

/**
 * Execute Workflow Trigger: the entry point used when this workflow is
 * invoked as a sub-workflow by another workflow's Execute Workflow node.
 * Real n8n (`inputs: []`, `return [inputData]` in
 * `ExecuteWorkflowTrigger.node.ts`) just outputs whatever data the caller
 * passed in - identical to Manual Trigger when this workflow is simulated
 * standalone, so it emits the seeded `--input` (or the default empty item).
 */
export const executeWorkflowTriggerExecutor: NodeExecutor = {
  type: "n8n-nodes-base.executeWorkflowTrigger",
  execute: ({ inputItems }) => ({ status: "success", output: [inputItems] }),
};
