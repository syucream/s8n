import type { NodeExecutor } from "../types.ts";

/**
 * Respond to Webhook: in real n8n this builds the HTTP response sent back
 * through the originating Webhook node as a side effect, but the data it
 * returns for downstream nodes is simply the unchanged input
 * (`packages/nodes-base/nodes/RespondToWebhook/RespondToWebhook.node.ts`,
 * final `return [items]`). Since s8n never serves real HTTP responses,
 * only the pass-through half is meaningful here.
 */
export const respondToWebhookExecutor: NodeExecutor = {
  type: "n8n-nodes-base.respondToWebhook",
  execute: ({ inputItems }) => ({ status: "success", output: [inputItems] }),
};
