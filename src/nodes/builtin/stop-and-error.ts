import { resolveParameterValue } from "../../expression/evaluator.ts";
import type { NodeExecutor } from "../types.ts";

/**
 * Stop and Error: unconditionally throws. Field names verified against
 * `packages/nodes-base/nodes/StopAndError/StopAndError.node.ts`:
 * `parameters.errorType` (`"errorMessage"` default | `"errorObject"`),
 * `parameters.errorMessage` (string) or `parameters.errorObject` (JSON string).
 */
export const stopAndErrorExecutor: NodeExecutor = {
  type: "n8n-nodes-base.stopAndError",
  execute: ({ node, inputItems, buildScope }) => {
    const scope = buildScope(inputItems[0] ?? { json: {} }, 0, inputItems);
    const p = resolveParameterValue(node.parameters, scope) as Record<
      string,
      unknown
    >;
    const errorType = String(p.errorType ?? "errorMessage");
    const message =
      errorType === "errorObject"
        ? String(p.errorObject ?? "")
        : String(p.errorMessage ?? "An error occurred!");
    return {
      status: "error",
      message: `Stop and Error node "${node.name}": ${message}`,
    };
  },
};
