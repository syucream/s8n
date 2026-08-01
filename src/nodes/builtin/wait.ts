import type { NodeExecutor } from "../types.ts";

/**
 * Wait: s8n never actually sleeps. It passes items through unchanged; the
 * configured duration is purely informational and shows up in the run
 * trace, not in the data.
 */
export const waitExecutor: NodeExecutor = {
  type: "n8n-nodes-base.wait",
  execute: ({ inputItems }) => ({ status: "success", output: [inputItems] }),
};
