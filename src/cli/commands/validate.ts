import type { Command } from "commander";
import { printEnvelope } from "../../format/output.ts";
import { loadWorkflowFile } from "../load-workflow.ts";

export function registerValidateCommand(program: Command): void {
  program
    .command("validate <workflowFile>")
    .description(
      "Validate workflow JSON schema and connection integrity without executing it",
    )
    .action(async (workflowFile: string) => {
      const loaded = await loadWorkflowFile(workflowFile);
      if (!loaded.ok || !loaded.workflow) {
        printEnvelope({
          ok: false,
          command: "validate",
          issues: loaded.issues,
          error: loaded.error,
        });
        process.exitCode = 1;
        return;
      }
      printEnvelope({
        ok: true,
        command: "validate",
        data: {
          valid: true,
          nodeCount: loaded.workflow.nodes.length,
          nodeTypes: [...new Set(loaded.workflow.nodes.map((n) => n.type))],
        },
      });
    });
}
