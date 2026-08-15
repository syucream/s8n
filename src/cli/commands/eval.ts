import type { Command } from "commander";
import { printEnvelope } from "../../format/output.ts";
import {
  type EvalExpectationCase,
  evaluateExecutionAgainstExpectations,
} from "../../scenario/eval.ts";
import { unwrapExecution } from "../../scenario/import-execution.ts";
import { loadJsonFile } from "../load-json-file.ts";

/**
 * `s8n eval <execution.json> <expectations.json>`: scores a real n8n
 * execution's LLM output against a fixture of expected results, reporting
 * precision and recall. s8n never calls an LLM; the execution JSON comes
 * from running the workflow in real n8n. This makes LLM-including workflows
 * measurable ("did it get better or worse") rather than binary pass/fail.
 */
export function registerEvalCommand(program: Command): void {
  program
    .command("eval <executionFile> <expectationsFile>")
    .description(
      "Score an n8n execution log's LLM output against an expectations fixture (precision/recall)",
    )
    .action(async (executionFile: string, expectationsFile: string) => {
      try {
        const rawExecution = await loadJsonFile(executionFile);
        const rawExpectations = await loadJsonFile(expectationsFile);
        if (
          rawExpectations === null ||
          typeof rawExpectations !== "object" ||
          Array.isArray(rawExpectations)
        ) {
          throw new Error(
            "expectations JSON must be an object with a cases array",
          );
        }
        const cases = (rawExpectations as { cases?: unknown }).cases;
        if (!Array.isArray(cases)) {
          throw new Error("expectations JSON must contain a cases array");
        }
        const parsedCases = cases.map((entry, index) => {
          const record =
            entry !== null && typeof entry === "object"
              ? (entry as Record<string, unknown>)
              : {};
          if (
            typeof record.node !== "string" ||
            typeof record.pointer !== "string"
          ) {
            throw new Error(
              `Expectation case ${index} requires string node and pointer`,
            );
          }
          if (!Array.isArray(record.expected)) {
            throw new Error(
              `Expectation case ${index} requires an expected array`,
            );
          }
          const parsed: EvalExpectationCase = {
            node: record.node,
            pointer: record.pointer,
            expected: record.expected as unknown[],
          };
          if (typeof record.key === "string") parsed.key = record.key;
          return parsed;
        });

        const execution = unwrapExecution(rawExecution);
        const result = evaluateExecutionAgainstExpectations(
          execution.runData,
          parsedCases,
        );
        printEnvelope({ ok: true, command: "eval", data: result });
      } catch (cause) {
        printEnvelope({
          ok: false,
          command: "eval",
          error: String((cause as Error)?.message ?? cause),
        });
        process.exitCode = 1;
      }
    });
}
