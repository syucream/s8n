import { normalizeMockToItems } from "../../mock/normalize.ts";
import type { NodeExecutor } from "../types.ts";

/**
 * Wait: s8n never actually sleeps. Time-based waits (`resume: timeInterval`
 * / `onDate`) pass items through immediately - the delay is informational.
 * Waits for an external resume (`onWebhookCall` / `onFormSubmission`, the
 * pattern behind approval flows) consume a scenario `resume` directive: a
 * payload models the data a webhook resume would deliver, `"timeout"`
 * models expiry (which resumes with no data), and a missing directive
 * reports a `waiting` status so the run is visibly incomplete instead of
 * hanging.
 */
export const waitExecutor: NodeExecutor = {
  type: "n8n-nodes-base.wait",
  execute: ({ node, inputItems, runtime }) => {
    const resumeMode = String(node.parameters.resume ?? "");
    const waitsForExternalResume =
      resumeMode === "onWebhookCall" || resumeMode === "onFormSubmission";
    if (!waitsForExternalResume) {
      return { status: "success", output: [inputItems] };
    }
    const directive = runtime.resumeDirectives?.get(node.name);
    if (directive === undefined) {
      return {
        status: "waiting",
        message: `Node "${node.name}" is waiting for a resume directive; provide scenario resume data or "timeout" to continue the flow.`,
      };
    }
    if (directive.timeout === true) {
      // Real n8n resumes a timed-out wait with no webhook data, so
      // downstream guards that expect a decision field fall through to
      // their default (e.g. "not approved").
      return { status: "success", output: [[{ json: {} }]] };
    }
    return {
      status: "success",
      output: [normalizeMockToItems(directive.data ?? {}, 0)],
    };
  },
};
