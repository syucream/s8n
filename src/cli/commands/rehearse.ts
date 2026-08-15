import type { Command } from "commander";
import { printEnvelope } from "../../format/output.ts";
import { loadScenarioManifestFile } from "../../scenario/load.ts";
import { runRehearsal } from "../../scenario/run.ts";

interface RehearseOptions {
  case?: string[];
  failFast?: boolean;
  updateSnapshots?: boolean;
}

export function registerRehearseCommand(program: Command): void {
  program
    .command("rehearse <workflowFile> <scenarioFile>")
    .description(
      "Run optional deterministic scenarios against a canonical workflow file",
    )
    .option("--case <names...>", "Run only the named scenario cases")
    .option("--fail-fast", "Stop after the first failed scenario case")
    .option(
      "--update-snapshots",
      "Rewrite golden snapshot files instead of comparing against them",
    )
    .action(
      async (
        workflowFile: string,
        scenarioFile: string,
        options: RehearseOptions,
      ) => {
        const loaded = await loadScenarioManifestFile(scenarioFile);
        if (!loaded.ok || !loaded.manifest) {
          printEnvelope({
            ok: false,
            command: "rehearse",
            error: loaded.error,
          });
          process.exitCode = 1;
          return;
        }

        const availableCases = new Set(
          loaded.manifest.cases.map((scenario) => scenario.name),
        );
        const missingCases = (options.case ?? []).filter(
          (name) => !availableCases.has(name),
        );
        if (missingCases.length > 0) {
          printEnvelope({
            ok: false,
            command: "rehearse",
            error: `Unknown scenario case(s): ${missingCases.join(", ")}`,
          });
          process.exitCode = 1;
          return;
        }

        const result = await runRehearsal({
          workflowFile,
          manifest: loaded.manifest,
          selectedCases: options.case,
          failFast: options.failFast,
          updateSnapshots: options.updateSnapshots,
        });
        const ok = result.summary.failed === 0;
        printEnvelope({ ok, command: "rehearse", data: result });
        if (!ok) process.exitCode = 1;
      },
    );
}
