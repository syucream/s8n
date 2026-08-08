import type { Command } from "commander";
import { printEnvelope } from "../../format/output.ts";
import { importExecutionDraft } from "../../scenario/import-execution.ts";
import { loadScenarioManifestFile } from "../../scenario/load.ts";
import { scenarioManifestSchema } from "../../scenario/schema.ts";
import { loadJsonFile } from "../load-json-file.ts";
import { loadWorkflowFile } from "../load-workflow.ts";

interface ImportOptions {
  maxItems?: string;
  resolveCodeIncludes?: boolean;
}

export function registerScenarioCommand(program: Command): Command {
  const scenario = program
    .command("scenario")
    .description("Create and validate optional workflow rehearsal scenarios");

  scenario
    .command("import <workflowFile> <executionFile>")
    .alias("draft")
    .description(
      "Create a synthetic-shape scenario draft from an n8n execution log",
    )
    .option(
      "--max-items <count>",
      "Maximum execution items retained per node in the generated draft",
      "10",
    )
    .option(
      "--resolve-code-includes",
      "Resolve strict workflow-local Code assets while loading the workflow",
    )
    .action(
      async (
        workflowFile: string,
        executionFile: string,
        options: ImportOptions,
      ) => {
        const maxItems = Number(options.maxItems);
        if (!Number.isInteger(maxItems) || maxItems < 1) {
          printEnvelope({
            ok: false,
            command: "scenario-import",
            error: `--max-items must be a positive integer: "${options.maxItems}"`,
          });
          process.exitCode = 1;
          return;
        }

        const loaded = await loadWorkflowFile(workflowFile, {
          resolveCodeIncludes: options.resolveCodeIncludes === true,
        });
        if (!loaded.ok || !loaded.workflow) {
          printEnvelope({
            ok: false,
            command: "scenario-import",
            issues: loaded.issues,
            error: loaded.error,
          });
          process.exitCode = 1;
          return;
        }

        try {
          const execution = await loadJsonFile(executionFile);
          if (execution === undefined)
            throw new Error("Execution log path is required");
          const draft = scenarioManifestSchema.parse(
            importExecutionDraft(loaded.workflow, execution, {
              maxItemsPerNode: maxItems,
            }),
          );
          printEnvelope({
            ok: true,
            command: "scenario-import",
            data: draft,
          });
        } catch (cause) {
          printEnvelope({
            ok: false,
            command: "scenario-import",
            error: `Failed to import execution log: ${String((cause as Error)?.message ?? cause)}`,
          });
          process.exitCode = 1;
        }
      },
    );

  scenario
    .command("validate <scenarioFile>")
    .description("Validate an optional JSON or YAML scenario manifest")
    .action(async (scenarioFile: string) => {
      const loaded = await loadScenarioManifestFile(scenarioFile);
      if (!loaded.ok || !loaded.manifest) {
        printEnvelope({
          ok: false,
          command: "scenario-validate",
          error: loaded.error,
        });
        process.exitCode = 1;
        return;
      }
      printEnvelope({
        ok: true,
        command: "scenario-validate",
        data: {
          valid: true,
          version: loaded.manifest.version,
          caseCount: loaded.manifest.cases.length,
          cases: loaded.manifest.cases.map((entry) => entry.name),
          generatedFrom: loaded.manifest.generatedFrom,
        },
      });
    });

  return scenario;
}
