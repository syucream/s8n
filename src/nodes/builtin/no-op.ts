import type { NodeExecutor } from "../types.ts";

/** NoOp: passes items through unchanged (useful as a branch merge point / label). */
export const noOpExecutor: NodeExecutor = {
  type: "n8n-nodes-base.noOp",
  execute: ({ inputItems }) => ({ status: "success", output: [inputItems] }),
};
