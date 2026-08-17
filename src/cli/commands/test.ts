import type { Command } from "commander";
import { printEnvelope } from "../../format/output.ts";
import { type LoadedTestFile, loadTestFile } from "../../test/load.ts";
import { runTestSuite } from "../../test/runner.ts";
import type { TestCaseResult } from "../../test/types.ts";

interface TestOptions {
  test?: string[];
  failFast?: boolean;
}

/**
 * `s8n test <testFile...>` runs TypeScript workflow tests. Each test file
 * declares a suite with `defineSuite`; the command loads the file (injecting
 * the DSL globals first, so files without imports work), executes every case
 * serially, and emits one JSON envelope with the pass/fail summary. Test
 * console output is captured by the runner and never reaches stdout, keeping
 * the single-envelope contract intact. Loading arbitrary TypeScript requires
 * the Bun runtime, so this command is source-mode only.
 */
export function registerTestCommand(program: Command): void {
  program
    .command("test <testFile...>")
    .description("Run TypeScript workflow tests against a workflow file")
    .option("--test <names...>", "Run only the named test cases")
    .option("--fail-fast", "Stop after the first failed test")
    .action(async (testFiles: string[], options: TestOptions) => {
      const cases: TestCaseResult[] = [];
      for (const file of testFiles) {
        let loaded: LoadedTestFile;
        try {
          loaded = await loadTestFile(file);
        } catch (cause) {
          printEnvelope({
            ok: false,
            command: "test",
            error: String((cause as Error)?.message ?? cause),
          });
          process.exitCode = 1;
          return;
        }

        const availableCases = new Set(
          loaded.suite.cases.map((testCase) => testCase.name),
        );
        const missingCases = (options.test ?? []).filter(
          (name) => !availableCases.has(name),
        );
        if (missingCases.length > 0) {
          printEnvelope({
            ok: false,
            command: "test",
            error: `Unknown test case(s) in ${file}: ${missingCases.join(", ")}`,
          });
          process.exitCode = 1;
          return;
        }

        const result = await runTestSuite({
          suite: loaded.suite,
          selectedCases: options.test,
          failFast: options.failFast,
          file: loaded.file,
        });
        cases.push(...result.cases);
        if (
          options.failFast &&
          result.cases.some((testCase) => !testCase.passed)
        ) {
          break;
        }
      }

      const passed = cases.filter((testCase) => testCase.passed).length;
      const ok = passed === cases.length;
      printEnvelope({
        ok,
        command: "test",
        data: {
          summary: {
            total: cases.length,
            passed,
            failed: cases.length - passed,
          },
          cases,
        },
      });
      if (!ok) process.exitCode = 1;
    });
}
