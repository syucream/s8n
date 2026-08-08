import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  validateWorkflow,
  type Workflow,
  type WorkflowValidationIssue,
} from "../schema/workflow.ts";

export interface LoadWorkflowOptions {
  /** Resolve repository-style `./_subfiles/<directory>/<file>.js` Code assets. */
  resolveCodeIncludes?: boolean;
}

function parseWorkflowSource(path: string, text: string): unknown {
  const normalizedPath = path.toLowerCase();
  if (normalizedPath.endsWith(".yaml") || normalizedPath.endsWith(".yml")) {
    return Bun.YAML.parse(text);
  }
  return JSON.parse(text);
}

async function resolveCodeIncludes(path: string, raw: unknown): Promise<void> {
  if (raw === null || typeof raw !== "object" || !("nodes" in raw)) return;
  const nodes = (raw as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return;

  const base = resolve(dirname(path), "_subfiles");
  let baseReal: string | undefined;
  for (const node of nodes) {
    if (
      node === null ||
      typeof node !== "object" ||
      (node as { type?: unknown }).type !== "n8n-nodes-base.code"
    )
      continue;
    const parameters = (node as { parameters?: unknown }).parameters;
    if (parameters === null || typeof parameters !== "object") continue;
    const jsCode = (parameters as { jsCode?: unknown }).jsCode;
    if (typeof jsCode !== "string" || !jsCode.startsWith("./_subfiles/"))
      continue;
    const match = jsCode.match(
      /^\.\/_subfiles\/(?!\.\.?\/)[^/]+\/(?!\.\.?$)[^/]+\.js$/u,
    );
    if (!match) {
      throw new Error(
        "Code include must match ./_subfiles/<directory>/<file>.js",
      );
    }

    baseReal ??= await realpath(base);
    const targetReal = await realpath(resolve(dirname(path), jsCode));
    const fromBase = relative(baseReal, targetReal);
    if (fromBase.startsWith("..") || isAbsolute(fromBase)) {
      throw new Error(
        "Code include resolves outside the workflow _subfiles directory",
      );
    }
    if (!(await stat(targetReal)).isFile()) {
      throw new Error("Code include target is not a regular file");
    }
    const bytes = await Bun.file(targetReal).arrayBuffer();
    (parameters as { jsCode: string }).jsCode = new TextDecoder("utf-8", {
      fatal: true,
    }).decode(bytes);
  }
}

export interface LoadWorkflowResult {
  ok: boolean;
  workflow?: Workflow;
  issues?: WorkflowValidationIssue[];
  error?: string;
}

export async function loadWorkflowFile(
  path: string,
  options: LoadWorkflowOptions = {},
): Promise<LoadWorkflowResult> {
  let raw: unknown;
  try {
    const text = await Bun.file(path).text();
    raw = parseWorkflowSource(path, text);
    if (options.resolveCodeIncludes) await resolveCodeIncludes(path, raw);
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
