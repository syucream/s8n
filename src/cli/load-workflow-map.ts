import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { Workflow } from "../schema/workflow.ts";
import { type LoadWorkflowOptions, loadWorkflowFile } from "./load-workflow.ts";

const workflowMapSchema = z.object({
  workflows: z
    .array(
      z.object({
        reference: z.string().min(1),
        path: z.string().min(1),
      }),
    )
    .min(1),
});

export interface LoadWorkflowMapResult {
  ok: boolean;
  workflows?: ReadonlyMap<string, Workflow>;
  error?: string;
}

function parseWorkflowMapSource(path: string, text: string): unknown {
  const normalizedPath = path.toLowerCase();
  if (normalizedPath.endsWith(".yaml") || normalizedPath.endsWith(".yml")) {
    return Bun.YAML.parse(text);
  }
  return JSON.parse(text);
}

/**
 * Loads only the workflows explicitly listed in a caller-provided map. Paths
 * are resolved relative to the map file; no directory discovery is performed.
 */
export async function loadWorkflowMapFile(
  path: string,
  workflowOptions: LoadWorkflowOptions = {},
): Promise<LoadWorkflowMapResult> {
  let raw: unknown;
  try {
    raw = parseWorkflowMapSource(path, await Bun.file(path).text());
  } catch (cause) {
    return {
      ok: false,
      error: `Failed to load workflow map: ${String((cause as Error)?.message ?? cause)}`,
    };
  }

  const parsed = workflowMapSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "map"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: `Invalid workflow map: ${details}` };
  }

  const workflows = new Map<string, Workflow>();
  for (const [index, entry] of parsed.data.workflows.entries()) {
    if (workflows.has(entry.reference)) {
      return {
        ok: false,
        error: `Invalid workflow map: duplicate reference "${entry.reference}" at workflows.${index}`,
      };
    }

    const workflowPath = isAbsolute(entry.path)
      ? entry.path
      : resolve(dirname(path), entry.path);
    const loaded = await loadWorkflowFile(workflowPath, workflowOptions);
    if (!loaded.ok || !loaded.workflow) {
      const details = loaded.error
        ? loaded.error
        : `Workflow validation failed: ${JSON.stringify(loaded.issues ?? [])}`;
      return {
        ok: false,
        error: `Failed to load workflow map reference "${entry.reference}" from "${entry.path}": ${details}`,
      };
    }
    workflows.set(entry.reference, loaded.workflow);
  }

  return { ok: true, workflows };
}
