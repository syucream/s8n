import type { NodeExecutor } from "../types.ts";

/**
 * Manual trigger: the classic "click to run" entry point. In s8n it simply
 * emits whatever items were supplied as the workflow's initial input (via
 * `--input`, defaulting to a single empty item), since there is no UI click
 * to simulate.
 */
export const manualTriggerExecutor: NodeExecutor = {
  type: "n8n-nodes-base.manualTrigger",
  execute: ({ inputItems }) => {
    return { status: "success", output: [inputItems] };
  },
};
