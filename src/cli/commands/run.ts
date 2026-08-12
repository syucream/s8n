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
  codeMode?: "in-process" | "vm" | "os" | "auto";
  codeTimeoutMs?: string;
  determinismCheck?: boolean;
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
    .option(
      "--code-mode <mode>",
      "Code node boundary: in-process (default), vm, os, or auto",
    )
    .option(
      "--code-timeout-ms <milliseconds>",
      "Timeout for vm Code nodes (default: 1000)",
    )
    .option(
      "--determinism-check",
      "Run twice and compare stable execution evidence",
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
        const codeTimeoutMs =
          opts.codeTimeoutMs === undefined
            ? undefined
            : Number(opts.codeTimeoutMs);
        if (
          codeTimeoutMs !== undefined &&
          (!Number.isInteger(codeTimeoutMs) || codeTimeoutMs <= 0)
        ) {
          printEnvelope({
            ok: false,
            command: "run",
            error: `--code-timeout-ms must be a positive integer: "${opts.codeTimeoutMs}"`,
          });
          process.exitCode = 1;
          return;
        }
        if (
          opts.codeMode !== undefined &&
          !["in-process", "vm", "os", "auto"].includes(opts.codeMode)
        ) {
          printEnvelope({
            ok: false,
            command: "run",
            error: `--code-mode must be "in-process", "vm", "os", or "auto": "${opts.codeMode}"`,
          });
          process.exitCode = 1;
          return;
        }
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
          codeExecutionMode: opts.codeMode,
          codeTimeoutMs,
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

        let determinism:
          | { equal: boolean; fingerprint?: string; error?: string }
          | undefined;
        if (opts.determinismCheck) {
          const repeated = await runWorkflowFile({
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
            codeExecutionMode: opts.codeMode,
            codeTimeoutMs,
          });
          if (!repeated.ok) {
            determinism = { equal: false, error: repeated.error };
          } else {
            const { stableRunFingerprint } = await import(
              "../../engine/fingerprint.ts"
            );
            const firstFingerprint = stableRunFingerprint(executed.result);
            const secondFingerprint = stableRunFingerprint(repeated.result);
            determinism = {
              equal: firstFingerprint === secondFingerprint,
              fingerprint: firstFingerprint,
            };
          }
        }

        const outputData = opts.executionLog
          ? toN8nExecutionLog(executed.result, {
              workflowId: executed.workflow.id,
              startNode: opts.startNode,
              truncateData,
            })
          : executed.result;
        printEnvelope({
          ok:
            (executed.result.status === "success" ||
              executed.result.status === "needs_mock") &&
            determinism?.equal !== false,
          command: "run",
          data:
            determinism === undefined
              ? outputData
              : { result: outputData, determinism },
        });
        if (
          executed.result.status === "error" ||
          executed.result.status === "needs_start_node" ||
          determinism?.equal === false
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
