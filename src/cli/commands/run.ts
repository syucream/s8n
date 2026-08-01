import type { Command } from "commander";
import { runWorkflow } from "../../engine/execute.ts";
import { printEnvelope } from "../../format/output.ts";
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
}

export function registerRunCommand(program: Command): void {
  program
    .command("run <workflowFile>")
    .description("Simulate a workflow locally with all external I/O mocked")
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

      const result = await runWorkflow(loaded.workflow, {
        initialInput,
        hasExplicitInput: opts.input !== undefined,
        mocks,
        registry: createDefaultRegistry(),
        now,
        startNode: opts.startNode,
      });

      printEnvelope({
        ok: result.status === "success" || result.status === "needs_mock",
        command: "run",
        data: result,
      });
      if (result.status === "error" || result.status === "needs_start_node")
        process.exitCode = 1;
    });
}
