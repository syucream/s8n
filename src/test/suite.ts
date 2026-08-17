import type {
  SuiteConfig,
  TestCaseDefinition,
  TestFn,
  TestSuite,
} from "./types.ts";

/**
 * Declares a workflow test suite. `register` receives a `test` function used
 * to add cases; each case receives the `run` helper (which simulates the
 * workflow with per-case input/mocks/faults/resume) and an `expect` factory
 * for the rich matcher DSL.
 *
 * A suite is pure registration: no workflow is loaded and nothing executes
 * until `runTestSuite` runs the cases.
 */
export function defineSuite(
  config: SuiteConfig,
  register: (test: (name: string, fn: TestFn) => void) => void,
): TestSuite {
  const cases: TestCaseDefinition[] = [];
  register((name, fn) => {
    if (name.trim() === "") {
      throw new Error("Test case names must not be empty");
    }
    if (cases.some((existing) => existing.name === name)) {
      throw new Error(`Duplicate test case name: "${name}"`);
    }
    cases.push({ name, fn });
  });
  return { config, cases };
}
