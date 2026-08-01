import type { NodeExecutor } from "../types.ts";

/**
 * Schedule Trigger: real n8n fires this on a cron/interval. s8n has no
 * scheduler - it simply emits the seeded input items once, as if this were
 * the single scheduled firing being simulated.
 */
export const scheduleTriggerExecutor: NodeExecutor = {
  type: "n8n-nodes-base.scheduleTrigger",
  execute: ({ inputItems }) => ({ status: "success", output: [inputItems] }),
};
