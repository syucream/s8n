import { runWorkflowFile } from "../cli/run-workflow-file.ts";
import { createExpect } from "./matchers.ts";
import type {
  SuiteConfig,
  TestCaseDefinition,
  TestCaseResult,
  TestResult,
  TestRunFn,
  TestRunOptions,
  TestRunOutcome,
  TestSuite,
} from "./types.ts";

export interface RunTestSuiteOptions {
  suite: TestSuite;
  selectedCases?: readonly string[];
  failFast?: boolean;
  /** Test file this suite came from; included on each case result. */
  file?: string;
}

/**
 * Runs every case of a suite serially, each with fresh emulator state (the
 * underlying `runWorkflowFile` creates and closes an emulator runner per
 * call). Console output produced during a case is captured so it can never
 * corrupt the CLI's single-JSON-envelope stdout contract.
 */
export async function runTestSuite(
  options: RunTestSuiteOptions,
): Promise<TestResult> {
  const cases =
    options.selectedCases === undefined
      ? options.suite.cases
      : options.suite.cases.filter((testCase) =>
          options.selectedCases?.includes(testCase.name),
        );

  const results: TestCaseResult[] = [];
  for (const testCase of cases) {
    const result = await runTestCase(
      options.suite.config,
      testCase,
      options.file,
    );
    results.push(result);
    if (options.failFast && !result.passed) break;
  }

  const passed = results.filter((result) => result.passed).length;
  return {
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
    },
    cases: results,
  };
}

async function runTestCase(
  config: SuiteConfig,
  testCase: TestCaseDefinition,
  file: string | undefined,
): Promise<TestCaseResult> {
  const restoreConsole = captureConsole();
  let lastOutcome: TestRunOutcome | undefined;
  const run: TestRunFn = async (runOptions) => {
    const outcome = await executeRun(config, runOptions);
    lastOutcome = outcome;
    return outcome;
  };

  const failures: string[] = [];
  try {
    await testCase.fn(run, createExpect);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    failures.push(message);
  }
  const consoleOutput = restoreConsole();

  const errors: string[] = [];
  if (lastOutcome !== undefined) {
    if (!lastOutcome.ok) {
      errors.push(lastOutcome.error);
    } else {
      errors.push(...lastOutcome.result.errors);
    }
  }

  return {
    file,
    name: testCase.name,
    passed: failures.length === 0,
    runStatus: lastOutcome?.ok ? lastOutcome.result.status : undefined,
    failures,
    errors,
    pendingMocks: lastOutcome?.ok
      ? lastOutcome.result.pendingMocks.map((mock) => mock.mockKey)
      : [],
    consoleOutput,
  };
}

async function executeRun(
  config: SuiteConfig,
  runOptions?: TestRunOptions,
): Promise<TestRunOutcome> {
  const emulate = runOptions?.emulate ?? config.emulate;
  const executed = await runWorkflowFile({
    workflowFile: config.workflow,
    input: runOptions?.input,
    mocks: runOptions?.mocks,
    faults: runOptions?.faults,
    emulatorSeed: runOptions?.emulatorSeed,
    hasExplicitInput: runOptions?.input !== undefined,
    workflowMapFile: config.workflowMap,
    resolveCodeIncludes: config.resolveCodeIncludes,
    now: runOptions?.now ?? config.now,
    startNode: runOptions?.startNode,
    emulate: emulate !== undefined && emulate.length > 0 ? emulate : undefined,
    codeExecutionMode: config.codeMode,
    codeTimeoutMs: config.codeTimeoutMs,
    captureResolvedRequests: true,
    resume: runOptions?.resume,
  });
  if (!executed.ok) {
    return { ok: false, error: executed.error, issues: executed.issues };
  }
  return { ok: true, result: executed.result, workflow: executed.workflow };
}

function captureConsole(): () => string[] {
  const logs: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((method) => [method, console[method]] as const);
  const writer = (...args: unknown[]): void => {
    logs.push(args.map((arg) => formatConsoleArg(arg)).join(" "));
  };
  for (const [method] of originals) {
    (console as unknown as Record<string, unknown>)[method] = writer;
  }
  return () => {
    for (const [method, original] of originals) {
      (console as unknown as Record<string, unknown>)[method] = original;
    }
    return logs;
  };
}

function formatConsoleArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}
