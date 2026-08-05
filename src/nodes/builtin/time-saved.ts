import type { NodeExecutor } from "../types.ts";

/**
 * n8n's Time Saved node records execution metadata but does not transform the
 * main data stream. The local simulator preserves the observable workflow
 * behavior by passing items through unchanged.
 */
export const timeSavedExecutor: NodeExecutor = {
  type: "n8n-nodes-base.timeSaved",
  execute: ({ inputItems }) => ({ status: "success", output: [inputItems] }),
};
