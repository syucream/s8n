import path from "node:path";
import { installTestGlobals } from "./globals.ts";
import type { TestSuite } from "./types.ts";

export interface LoadedTestFile {
  file: string;
  suite: TestSuite;
}

function isTestSuite(value: unknown): value is TestSuite {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TestSuite>;
  return (
    typeof candidate.config === "object" &&
    candidate.config !== null &&
    typeof candidate.config.workflow === "string" &&
    Array.isArray(candidate.cases)
  );
}

function resolveRelative(directory: string, target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(directory, target);
}

/**
 * Loads a TypeScript test file. Installs the injected DSL globals first so a
 * file written without imports works, then discovers the suite from either
 * the default export or a named `suite` export. Relative workflow/workflowMap
 * paths in the suite config are resolved against the test file's directory.
 */
export async function loadTestFile(file: string): Promise<LoadedTestFile> {
  installTestGlobals();
  const resolved = path.resolve(file);
  let module: Record<string, unknown>;
  try {
    module = (await import(resolved)) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      `Failed to load test file ${resolved}: ${String((cause as Error)?.message ?? cause)}`,
    );
  }
  const suite = module.default ?? module.suite;
  if (!isTestSuite(suite)) {
    throw new Error(
      `Test file ${resolved} must export a suite via "export default defineSuite(...)" or "export const suite = defineSuite(...)"`,
    );
  }
  const directory = path.dirname(resolved);
  const config = { ...suite.config };
  config.workflow = resolveRelative(directory, config.workflow);
  if (config.workflowMap !== undefined) {
    config.workflowMap = resolveRelative(directory, config.workflowMap);
  }
  return { file: resolved, suite: { ...suite, config } };
}
