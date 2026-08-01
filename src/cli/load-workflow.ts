import {
  validateWorkflow,
  type Workflow,
  type WorkflowValidationIssue,
} from "../schema/workflow.ts";

export interface LoadWorkflowResult {
  ok: boolean;
  workflow?: Workflow;
  issues?: WorkflowValidationIssue[];
  error?: string;
}

export async function loadWorkflowFile(
  path: string,
): Promise<LoadWorkflowResult> {
  let raw: unknown;
  try {
    const text = await Bun.file(path).text();
    raw = JSON.parse(text);
  } catch (cause) {
    return {
      ok: false,
      error: `Failed to load workflow file: ${String((cause as Error)?.message ?? cause)}`,
    };
  }

  const result = validateWorkflow(raw);
  if (!result.valid) {
    return { ok: false, issues: result.issues };
  }
  return { ok: true, workflow: result.workflow };
}
