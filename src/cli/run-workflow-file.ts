import { type RunResult, runWorkflow } from "../engine/execute.ts";
import { createFaultLookup, type ScenarioFault } from "../faults.ts";
import { EmulatorIntegrationRunner } from "../integrations/emulator.ts";
import {
  EMULATED_SERVICES,
  type EmulatedService,
  type EmulatorSeed,
} from "../integrations/types.ts";
import { createMockLookup, emptyMockLookup } from "../mock/provider.ts";
import { createDefaultRegistry } from "../nodes/registry.ts";
import type { Item } from "../schema/item.ts";
import type { Workflow, WorkflowValidationIssue } from "../schema/workflow.ts";
import { parseInputToItems } from "./input.ts";
import { loadWorkflowFile } from "./load-workflow.ts";
import { loadWorkflowMapFile } from "./load-workflow-map.ts";

export interface RunWorkflowFileOptions {
  workflowFile: string;
  /** Parsed inline input data, not a file path. */
  input?: unknown;
  /** Parsed inline mocks, not a file path. */
  mocks?: unknown;
  /** Parsed scenario-only, deterministic fault injections. */
  faults?: readonly ScenarioFault[];
  /** Parsed inline emulator seed, not a file path. */
  emulatorSeed?: unknown;
  hasExplicitInput: boolean;
  workflowMapFile?: string;
  resolveCodeIncludes?: boolean;
  now?: string;
  startNode?: string;
  /** Requested emulated services. "all" expands to every supported service. */
  emulate?: readonly string[];
  codeExecutionMode?: "in-process" | "vm" | "os" | "auto";
  codeTimeoutMs?: number;
  captureResolvedRequests?: boolean;
  /** Resume instructions for waiting nodes, keyed by node name. */
  resume?: Record<string, unknown>;
}

export type RunWorkflowFileResult =
  | {
      ok: true;
      workflow: Workflow;
      result: RunResult;
    }
  | {
      ok: false;
      error: string;
      issues?: WorkflowValidationIssue[];
    };

function validateMocks(rawMocks: unknown) {
  if (rawMocks === undefined) {
    return emptyMockLookup;
  }
  if (
    typeof rawMocks !== "object" ||
    rawMocks === null ||
    Array.isArray(rawMocks)
  ) {
    throw new Error("--mocks JSON must be a flat { mockKey: value } object");
  }
  return createMockLookup(rawMocks as Record<string, unknown>);
}

export function validateEmulatorSeed(
  rawSeed: unknown,
): EmulatorSeed | undefined {
  if (rawSeed === undefined) return undefined;
  if (
    rawSeed === null ||
    typeof rawSeed !== "object" ||
    Array.isArray(rawSeed) ||
    !("stores" in rawSeed) ||
    rawSeed.stores === null ||
    typeof rawSeed.stores !== "object" ||
    Array.isArray(rawSeed.stores)
  ) {
    throw new Error(
      "--emulator-seed JSON must be { stores: { storeName: [entities] } }",
    );
  }
  for (const [storeName, entities] of Object.entries(rawSeed.stores)) {
    if (!Array.isArray(entities)) {
      throw new Error(`--emulator-seed store "${storeName}" must be an array`);
    }
  }
  return rawSeed as EmulatorSeed;
}

export function resolveEmulatedServices(
  requested: readonly string[] | undefined,
): EmulatedService[] | undefined {
  if (requested === undefined) return undefined;
  const services = requested.map((service) => service.trim()).filter(Boolean);
  const expanded = services.includes("all") ? [...EMULATED_SERVICES] : services;
  const unsupported = expanded.filter(
    (service) => !EMULATED_SERVICES.includes(service as EmulatedService),
  );
  if (unsupported.length > 0 || services.length === 0) {
    throw new Error(
      `Unsupported --emulate service(s): ${unsupported.join(", ") || requested.join(",")}. Supported services: ${EMULATED_SERVICES.join(", ")}, all`,
    );
  }
  return expanded as EmulatedService[];
}

function validateFaultTargets(
  workflow: Workflow,
  faults: readonly ScenarioFault[] | undefined,
): string | undefined {
  if (faults === undefined) return undefined;
  const nodes = new Map(workflow.nodes.map((node) => [node.name, node]));
  const registry = createDefaultRegistry();
  for (const fault of faults) {
    const node = nodes.get(fault.node);
    if (node === undefined) {
      return `Fault references an unknown workflow node: ${fault.node}`;
    }
    if (node.type !== "n8n-nodes-base.httpRequest" && registry.has(node.type)) {
      return `Fault target must be an HTTP Request or generic external node: ${fault.node}`;
    }
  }
  return undefined;
}

/**
 * Runs one workflow from its canonical workflow file and caller-supplied,
 * already-parsed rehearsal values. It is deliberately CLI-output agnostic so
 * both `run` and multi-case scenario harnesses use the same validation and
 * execution path.
 */
export async function runWorkflowFile(
  options: RunWorkflowFileOptions,
): Promise<RunWorkflowFileResult> {
  const workflowOptions = {
    resolveCodeIncludes: options.resolveCodeIncludes === true,
  };
  const loaded = await loadWorkflowFile(options.workflowFile, workflowOptions);
  if (!loaded.ok || !loaded.workflow) {
    return {
      ok: false,
      error: loaded.error ?? "Workflow validation failed",
      ...(loaded.issues === undefined ? {} : { issues: loaded.issues }),
    };
  }

  const faultTargetError = validateFaultTargets(
    loaded.workflow,
    options.faults,
  );
  if (faultTargetError !== undefined) {
    return { ok: false, error: faultTargetError };
  }

  try {
    const workflowMap = options.workflowMapFile
      ? await loadWorkflowMapFile(options.workflowMapFile, workflowOptions)
      : undefined;
    if (
      workflowMap !== undefined &&
      (!workflowMap.ok || !workflowMap.workflows)
    ) {
      return {
        ok: false,
        error: workflowMap.error ?? "Failed to load workflow map",
      };
    }

    let initialInput: Item[] | undefined;
    try {
      initialInput =
        options.input === undefined
          ? undefined
          : parseInputToItems(options.input);
    } catch (cause) {
      return {
        ok: false,
        error: `Failed to read --input: ${String((cause as Error)?.message ?? cause)}`,
      };
    }
    const mocks = validateMocks(options.mocks);
    const now = options.now === undefined ? undefined : new Date(options.now);
    if (options.now !== undefined && Number.isNaN(now?.getTime())) {
      return {
        ok: false,
        error: `--now contains an invalid timestamp: "${options.now}"`,
      };
    }

    const emulatorSeed = validateEmulatorSeed(options.emulatorSeed);
    const services = resolveEmulatedServices(options.emulate);
    if (emulatorSeed !== undefined && services === undefined) {
      return { ok: false, error: "--emulator-seed requires --emulate" };
    }

    let integrationRunner: EmulatorIntegrationRunner | undefined;
    try {
      if (services !== undefined) {
        integrationRunner = await EmulatorIntegrationRunner.create(
          services,
          emulatorSeed,
        );
      }
      const result = await runWorkflow(loaded.workflow, {
        initialInput,
        hasExplicitInput: options.hasExplicitInput,
        mocks,
        faults: createFaultLookup(options.faults),
        registry: createDefaultRegistry(),
        now,
        startNode: options.startNode,
        integrationRunner,
        workflowMap: workflowMap?.workflows,
        codeExecutionMode: options.codeExecutionMode,
        codeTimeoutMs: options.codeTimeoutMs,
        captureResolvedRequests: options.captureResolvedRequests,
        resumeDirectives: options.resume
          ? new Map(
              Object.entries(options.resume).map(([nodeName, value]) => [
                nodeName,
                value === "timeout"
                  ? { timeout: true }
                  : {
                      data:
                        value !== null && typeof value === "object"
                          ? value
                          : {},
                    },
              ]),
            )
          : undefined,
      });
      return { ok: true, workflow: loaded.workflow, result };
    } finally {
      await integrationRunner?.close();
    }
  } catch (cause) {
    return {
      ok: false,
      error: String((cause as Error)?.message ?? cause),
    };
  }
}
