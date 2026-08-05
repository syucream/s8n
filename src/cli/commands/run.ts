import type { Command } from "commander";
import { runWorkflow } from "../../engine/execute.ts";
import { toN8nExecutionLog } from "../../format/n8n-execution.ts";
import { printEnvelope } from "../../format/output.ts";
import { EmulatorIntegrationRunner } from "../../integrations/emulator.ts";
import {
  EMULATED_SERVICES,
  type EmulatedService,
  type EmulatorSeed,
} from "../../integrations/types.ts";
import { createMockLookup, emptyMockLookup } from "../../mock/provider.ts";
import { createDefaultRegistry } from "../../nodes/registry.ts";
import type { Item } from "../../schema/item.ts";
import { parseInputToItems } from "../input.ts";
import { loadJsonFile } from "../load-json-file.ts";
import { loadWorkflowFile } from "../load-workflow.ts";

interface RunOpts {
  input?: string;
  mocks?: string;
  now?: string;
  startNode?: string;
  emulate?: string;
  emulatorSeed?: string;
  executionLog?: boolean;
  truncateData?: string;
}

export function registerRunCommand(program: Command): void {
  program
    .command("run <workflowFile>")
    .description(
      "Simulate a workflow with mocked I/O or explicitly enabled local emulators",
    )
    .option(
      "--input <file>",
      "JSON file containing initial input data (defaults to one empty item)",
    )
    .option(
      "--mocks <file>",
      "JSON file defining external I/O mocks as a flat { mockKey: value } object",
    )
    .option(
      "--now <iso>",
      "ISO timestamp used to fix $now and $today for reproducible expression evaluation",
    )
    .option(
      "--start-node <name>",
      "Start node to use when multiple nodes have no incoming connections",
    )
    .option(
      "--emulate <services>",
      `Run integrations against stateful local emulators (${EMULATED_SERVICES.join(", ")}, or all)`,
    )
    .option(
      "--emulator-seed <file>",
      "JSON file containing initial state as { stores: { storeName: [entities] } }",
    )
    .option(
      "--execution-log",
      "Output n8n-like execution metadata and resultData.runData",
    )
    .option(
      "--truncate-data <count>",
      "Limit items retained per node output in --execution-log",
    )
    .action(async (workflowFile: string, opts: RunOpts) => {
      const loaded = await loadWorkflowFile(workflowFile);
      if (!loaded.ok || !loaded.workflow) {
        printEnvelope({
          ok: false,
          command: "run",
          issues: loaded.issues,
          error: loaded.error,
        });
        process.exitCode = 1;
        return;
      }

      let initialInput: Item[] | undefined;
      try {
        const rawInput = await loadJsonFile(opts.input);
        initialInput =
          rawInput === undefined ? undefined : parseInputToItems(rawInput);
      } catch (cause) {
        printEnvelope({
          ok: false,
          command: "run",
          error: `Failed to read --input: ${String((cause as Error)?.message ?? cause)}`,
        });
        process.exitCode = 1;
        return;
      }

      let mocks = emptyMockLookup;
      try {
        const rawMocks = await loadJsonFile(opts.mocks);
        if (rawMocks !== undefined) {
          if (
            typeof rawMocks !== "object" ||
            rawMocks === null ||
            Array.isArray(rawMocks)
          ) {
            throw new Error(
              "--mocks JSON must be a flat { mockKey: value } object",
            );
          }
          mocks = createMockLookup(rawMocks as Record<string, unknown>);
        }
      } catch (cause) {
        printEnvelope({
          ok: false,
          command: "run",
          error: String((cause as Error)?.message ?? cause),
        });
        process.exitCode = 1;
        return;
      }

      const now = opts.now ? new Date(opts.now) : undefined;
      if (opts.now !== undefined && Number.isNaN(now?.getTime())) {
        printEnvelope({
          ok: false,
          command: "run",
          error: `--now contains an invalid timestamp: "${opts.now}"`,
        });
        process.exitCode = 1;
        return;
      }
      const truncateData =
        opts.truncateData === undefined ? undefined : Number(opts.truncateData);
      if (
        truncateData !== undefined &&
        (!Number.isInteger(truncateData) || truncateData < 0)
      ) {
        printEnvelope({
          ok: false,
          command: "run",
          error: `--truncate-data must be a non-negative integer: "${opts.truncateData}"`,
        });
        process.exitCode = 1;
        return;
      }

      let integrationRunner: EmulatorIntegrationRunner | undefined;
      try {
        let emulatorSeed: EmulatorSeed | undefined;
        if (opts.emulatorSeed) {
          const rawSeed = await loadJsonFile(opts.emulatorSeed);
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
            if (!Array.isArray(entities))
              throw new Error(
                `--emulator-seed store "${storeName}" must be an array`,
              );
          }
          emulatorSeed = rawSeed as EmulatorSeed;
        }
        if (opts.emulate) {
          const services = opts.emulate
            .split(",")
            .map((service) => service.trim())
            .filter(Boolean);
          const expanded = services.includes("all")
            ? [...EMULATED_SERVICES]
            : services;
          const unsupported = expanded.filter(
            (service) =>
              !EMULATED_SERVICES.includes(service as EmulatedService),
          );
          if (unsupported.length > 0 || services.length === 0) {
            throw new Error(
              `Unsupported --emulate service(s): ${unsupported.join(", ") || opts.emulate}. Supported services: ${EMULATED_SERVICES.join(", ")}, all`,
            );
          }
          integrationRunner = await EmulatorIntegrationRunner.create(
            expanded as EmulatedService[],
            emulatorSeed,
          );
        } else if (emulatorSeed) {
          throw new Error("--emulator-seed requires --emulate");
        }

        const result = await runWorkflow(loaded.workflow, {
          initialInput,
          hasExplicitInput: opts.input !== undefined,
          mocks,
          registry: createDefaultRegistry(),
          now,
          startNode: opts.startNode,
          integrationRunner,
        });

        await integrationRunner?.close();
        integrationRunner = undefined;

        printEnvelope({
          ok: result.status === "success" || result.status === "needs_mock",
          command: "run",
          data: opts.executionLog
            ? toN8nExecutionLog(result, {
                workflowId: loaded.workflow.id,
                startNode: opts.startNode,
                truncateData,
              })
            : result,
        });
        if (result.status === "error" || result.status === "needs_start_node")
          process.exitCode = 1;
      } catch (cause) {
        await integrationRunner?.close().catch(() => undefined);
        printEnvelope({
          ok: false,
          command: "run",
          error: String((cause as Error)?.message ?? cause),
        });
        process.exitCode = 1;
      }
    });
}
