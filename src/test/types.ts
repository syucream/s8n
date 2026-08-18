import type { RunResult } from "../engine/execute.ts";
import type { ScenarioFault } from "../faults.ts";
import type { Workflow, WorkflowValidationIssue } from "../schema/workflow.ts";
import type { Expect } from "./matchers.ts";

/** Suite-level configuration shared by every test case. */
export interface SuiteConfig {
  /** Workflow file path. Resolved relative to the test file when loaded by the CLI. */
  workflow: string;
  /** Explicit workflow map for called sub-workflows. */
  workflowMap?: string;
  /** Resolve strict workflow-local `_subfiles` Code assets. */
  resolveCodeIncludes?: boolean;
  /** Suite-wide emulated services; each case can override with its own `emulate`. */
  emulate?: string[];
  /** Code execution mode: in-process, vm, os, or auto. */
  codeMode?: "in-process" | "vm" | "os" | "auto";
  /** Bounded Code execution timeout in milliseconds. */
  codeTimeoutMs?: number;
  /** Fixed timestamp for reproducible time-dependent expressions. */
  now?: string;
}

/** Per-case run options merged over the suite defaults. */
export interface TestRunOptions {
  input?: unknown;
  mocks?: unknown;
  faults?: ScenarioFault[];
  emulatorSeed?: unknown;
  emulate?: string[];
  now?: string;
  startNode?: string;
  /** Resume instructions for waiting nodes, keyed by node name. */
  resume?: Record<string, unknown>;
}

/**
 * Result of one workflow simulation inside a test. The successful side exposes
 * the full engine `RunResult` (trace with execution order, per-node source
 * provenance, intermediate outputs, lineage, edge coverage) so tests can write
 * arbitrary TypeScript assertions on top of the built-in matchers.
 */
export type TestRunOutcome =
  | { ok: true; result: RunResult; workflow: Workflow }
  | { ok: false; error: string; issues?: WorkflowValidationIssue[] };

/** Runs the workflow with the given case options and returns the full outcome. */
export type TestRunFn = (options?: TestRunOptions) => Promise<TestRunOutcome>;

export type TestFn = (
  run: TestRunFn,
  expect: (outcome: TestRunOutcome) => Expect,
) => Promise<void> | void;

export interface TestCaseDefinition {
  name: string;
  fn: TestFn;
}

export interface TestSuite {
  config: SuiteConfig;
  cases: TestCaseDefinition[];
}

export interface TestCaseResult {
  /** Test file the case came from, when the suite was loaded from a file. */
  file?: string;
  name: string;
  passed: boolean;
  runStatus?: RunResult["status"];
  /** Matcher / thrown failure messages for this case. */
  failures: string[];
  /** Run-level errors (workflow errors or configuration failures). */
  errors: string[];
  /** Mock keys still needed when the run stopped at `needs_mock`. */
  pendingMocks: string[];
  /** Captured console output produced while the test executed. */
  consoleOutput: string[];
}

export interface TestResult {
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
  cases: TestCaseResult[];
}
