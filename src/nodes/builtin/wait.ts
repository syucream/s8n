import { normalizeMockToItems } from "../../mock/normalize.ts";
import type { NodeExecutor, ResumeDirective } from "../types.ts";

function applyResumeDirective(
  directive: ResumeDirective,
): ReturnType<NodeExecutor["execute"]> {
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
}

/**
 * Wait: s8n never actually sleeps. Time-based waits (`resume: timeInterval`
 * / `onDate`) pass items through immediately - the delay is informational.
 * Waits for an external resume (`onWebhookCall` / `onFormSubmission`, the
 * pattern behind approval flows) resolve in order from:
 * 1. a scenario `resume` directive (a payload models the data a webhook
 *    resume would deliver, `"timeout"` models expiry);
 * 2. an async `runtime.resumeProvider` (used by the HTTP mock server to
 *    suspend a run until a resume endpoint is called);
 * 3. otherwise a `waiting` status is reported so the run is visibly
 *    incomplete instead of hanging.
 */
export const waitExecutor: NodeExecutor = {
  type: "n8n-nodes-base.wait",
  execute: async ({ node, inputItems, runtime }) => {
    const resumeMode = String(node.parameters.resume ?? "");
    const waitsForExternalResume =
      resumeMode === "onWebhookCall" || resumeMode === "onFormSubmission";
    if (!waitsForExternalResume) {
      return { status: "success", output: [inputItems] };
    }
    const directive = runtime.resumeDirectives?.get(node.name);
    if (directive !== undefined) {
      return applyResumeDirective(directive);
    }
    if (runtime.resumeProvider) {
      const provided = await runtime.resumeProvider(
        node,
        resumeMode as "onWebhookCall" | "onFormSubmission",
      );
      return applyResumeDirective(provided);
    }
    return {
      status: "waiting",
      message: `Node "${node.name}" is waiting for a resume directive; provide scenario resume data or "timeout" to continue the flow.`,
    };
  },
};
