import { type RunResult, runWorkflow } from "../engine/execute.ts";
import { EmulatorIntegrationRunner } from "../integrations/emulator.ts";
import type { EmulatedService, EmulatorSeed } from "../integrations/types.ts";
import { createDefaultRegistry } from "../nodes/registry.ts";
import type { Item } from "../schema/item.ts";
import type { ServeRunOptions } from "./types.ts";

/**
 * Runs one request's workflow execution, keeping any emulator runner alive
 * for the whole run. Unlike `runWorkflowFile`, which creates and closes an
 * emulator per call, this variant lets a run suspended at a Wait node keep
 * its in-process service state across the resume request.
 */
export async function runServerExecution(
  options: ServeRunOptions & {
    inputItems: Item[];
    startNode: string;
  },
): Promise<RunResult> {
  const { workflow, inputItems, startNode } = options;
  let integrationRunner: EmulatorIntegrationRunner | undefined;
  try {
    const emulate = options.emulate;
    if (emulate !== undefined && emulate.length > 0) {
      integrationRunner = await EmulatorIntegrationRunner.create(
        emulate as EmulatedService[],
        options.emulatorSeed as EmulatorSeed | undefined,
      );
    }
    return await runWorkflow(workflow, {
      initialInput: inputItems,
      hasExplicitInput: true,
      mocks: options.mocks,
      registry: createDefaultRegistry(),
      now: options.now,
      startNode,
      integrationRunner,
      workflowMap: options.workflowMap,
      codeExecutionMode: options.codeExecutionMode,
      codeTimeoutMs: options.codeTimeoutMs,
      captureResolvedRequests: options.captureResolvedRequests,
      resumeProvider: options.resumeProvider,
    });
  } finally {
    await integrationRunner?.close();
  }
}
