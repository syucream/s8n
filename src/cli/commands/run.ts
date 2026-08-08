import type { Command } from "commander";
import { toN8nExecutionLog } from "../../format/n8n-execution.ts";
import { printEnvelope } from "../../format/output.ts";
import { EMULATED_SERVICES } from "../../integrations/types.ts";
import { loadJsonFile } from "../load-json-file.ts";
import { runWorkflowFile } from "../run-workflow-file.ts";

interface RunOpts {
  input?: string;
  mocks?: string;
  workflowMap?: string;
  resolveCodeIncludes?: boolean;
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
      "--workflow-map <file>",
      "JSON or YAML map of explicit sub-workflow references and file paths",
    )
    .option(
      "--resolve-code-includes",
      "Resolve strict ./_subfiles/<directory>/<file>.js Code references relative to each workflow",
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
      let input: unknown;
      try {
        input = await loadJsonFile(opts.input);
      } catch (cause) {
        printEnvelope({
          ok: false,
          command: "run",
          error: `Failed to read --input: ${String((cause as Error)?.message ?? cause)}`,
        });
        process.exitCode = 1;
        return;
      }

      let mocks: unknown;
      try {
        mocks = await loadJsonFile(opts.mocks);
      } catch (cause) {
        printEnvelope({
          ok: false,
          command: "run",
          error: String((cause as Error)?.message ?? cause),
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

      try {
        const emulatorSeed = await loadJsonFile(opts.emulatorSeed);
        const executed = await runWorkflowFile({
          workflowFile,
          input,
          mocks,
          emulatorSeed,
          hasExplicitInput: opts.input !== undefined,
          workflowMapFile: opts.workflowMap,
          resolveCodeIncludes: opts.resolveCodeIncludes === true,
          now: opts.now,
          startNode: opts.startNode,
          emulate: opts.emulate?.split(","),
        });
        if (!executed.ok) {
          printEnvelope({
            ok: false,
            command: "run",
            error: executed.error,
            issues: executed.issues,
          });
          process.exitCode = 1;
          return;
        }

        printEnvelope({
          ok:
            executed.result.status === "success" ||
            executed.result.status === "needs_mock",
          command: "run",
          data: opts.executionLog
            ? toN8nExecutionLog(executed.result, {
                workflowId: executed.workflow.id,
                startNode: opts.startNode,
                truncateData,
              })
            : executed.result,
        });
        if (
          executed.result.status === "error" ||
          executed.result.status === "needs_start_node"
        )
          process.exitCode = 1;
      } catch (cause) {
        printEnvelope({
          ok: false,
          command: "run",
          error: String((cause as Error)?.message ?? cause),
        });
        process.exitCode = 1;
      }
    });
}
