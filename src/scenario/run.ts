import { loadJsonFile } from "../cli/load-json-file.ts";
import { runWorkflowFile } from "../cli/run-workflow-file.ts";
import type { RunResult } from "../engine/execute.ts";
import type { Workflow } from "../schema/workflow.ts";
import {
  evaluateScenarioAssertions,
  type ScenarioAssertionResult,
} from "./assertions.ts";
import type { ResolvedScenarioCase, ResolvedScenarioManifest } from "./load.ts";
import type { ScenarioAssertions } from "./schema.ts";

export interface RehearsalTraceEntry {
  node: string;
  type: string;
  status: string;
  inputItemCounts: number[];
  outputItemCounts?: number[];
  inputItemLineage?: string[][];
  outputItemLineage?: string[][];
}

export interface RehearsalCaseResult {
  name: string;
  passed: boolean;
  runStatus?: RunResult["status"];
  implicitAssertions: string[];
  assertions?: ScenarioAssertionResult;
  configurationErrors: string[];
  pendingMocks: Array<{
    node: string;
    type: string;
    mockKey: string;
    expectedShape: unknown;
    provenance: RunResult["pendingMocks"][number]["provenance"];
    cardinalityHint: RunResult["pendingMocks"][number]["cardinalityHint"];
  }>;
  errors: string[];
  trace: RehearsalTraceEntry[];
  effectCount: number;
  verifiedEffectCount: number;
  subExecutionCount: number;
}

export interface RehearsalResult {
  summary: {
    total: number;
    passed: number;
    failed: number;
    unionCoverage: {
      executableNodes: string[];
      executedNodes: string[];
      ratio: number;
      uncoveredNodes: string[];
    };
  };
  cases: RehearsalCaseResult[];
}

export interface RunRehearsalOptions {
  workflowFile: string;
  manifest: ResolvedScenarioManifest;
  selectedCases?: readonly string[];
  failFast?: boolean;
}

function assertionNodeNames(assertions: ScenarioAssertions): string[] {
  return [
    ...(assertions.requiredNodes ?? []),
    ...(assertions.forbiddenNodes ?? []),
    ...Object.keys(assertions.nodeOutputItemCounts ?? {}),
    ...(assertions.nodeOutputs ?? []).map((entry) => entry.node),
    ...(assertions.nodeRequests ?? []).map((entry) => entry.node),
    ...(assertions.nodeOutputCardinality ?? []).map((entry) => entry.node),
    ...(assertions.nodeOutputLineage ?? []).map((entry) => entry.node),
    ...(assertions.requiredEdges ?? []).flatMap((edge) => [
      edge.sourceNode,
      edge.destinationNode,
    ]),
    ...(assertions.forbiddenEdges ?? []).flatMap((edge) => [
      edge.sourceNode,
      edge.destinationNode,
    ]),
  ];
}

function validateAssertionNodes(
  workflow: Workflow,
  assertions: ScenarioAssertions,
): string[] {
  const workflowNodes = new Set(workflow.nodes.map((node) => node.name));
  return [...new Set(assertionNodeNames(assertions))]
    .filter((node) => !workflowNodes.has(node))
    .map((node) => `Assertion references an unknown workflow node: ${node}`);
}

async function loadOptionalJson(path: string | undefined): Promise<unknown> {
  return path === undefined ? undefined : await loadJsonFile(path);
}

async function runCase(
  workflowFile: string,
  scenario: ResolvedScenarioCase,
): Promise<RehearsalCaseResult> {
  const implicitAssertions: string[] = [];
  const assertions: ScenarioAssertions = {
    status: "success",
    ...(scenario.assertions ?? {}),
  };
  if (scenario.assertions?.status === undefined)
    implicitAssertions.push("status=success");

  try {
    const [fileInput, fileMocks, emulatorSeed] = await Promise.all([
      loadOptionalJson(scenario.run.inputFile),
      loadOptionalJson(scenario.run.mocksFile),
      loadOptionalJson(scenario.run.emulatorSeedFile),
    ]);
    const input = scenario.run.input ?? fileInput;
    const mocks = scenario.run.mocks ?? fileMocks;
    const executed = await runWorkflowFile({
      workflowFile,
      input,
      mocks,
      faults: scenario.faults,
      emulatorSeed,
      hasExplicitInput:
        Object.hasOwn(scenario.run, "input") ||
        scenario.run.inputFile !== undefined,
      workflowMapFile: scenario.run.workflowMap,
      resolveCodeIncludes: scenario.run.resolveCodeIncludes,
      now: scenario.run.now,
      startNode: scenario.run.startNode,
      emulate: scenario.run.emulate,
      codeExecutionMode: scenario.run.codeMode,
      codeTimeoutMs: scenario.run.codeTimeoutMs,
      captureResolvedRequests: (assertions.nodeRequests?.length ?? 0) > 0,
    });
    if (!executed.ok) {
      return {
        name: scenario.name,
        passed: false,
        implicitAssertions,
        configurationErrors: [executed.error],
        pendingMocks: [],
        errors: [],
        trace: [],
        effectCount: 0,
        verifiedEffectCount: 0,
        subExecutionCount: 0,
      };
    }

    const configurationErrors = validateAssertionNodes(
      executed.workflow,
      assertions,
    );
    const evaluated = evaluateScenarioAssertions(
      executed.workflow,
      executed.result,
      assertions,
    );
    return {
      name: scenario.name,
      passed: configurationErrors.length === 0 && evaluated.ok,
      runStatus: executed.result.status,
      implicitAssertions,
      assertions: evaluated,
      configurationErrors,
      pendingMocks: executed.result.pendingMocks.map((request) => ({
        node: request.nodeName,
        type: request.nodeType,
        mockKey: request.mockKey,
        expectedShape: request.expectedShape,
        provenance: request.provenance,
        cardinalityHint: request.cardinalityHint,
      })),
      errors: executed.result.errors,
      trace: executed.result.trace.map((entry) => ({
        node: entry.nodeName,
        type: entry.nodeType,
        status: entry.status,
        inputItemCounts: entry.inputItemCounts,
        ...(entry.outputItemCounts === undefined
          ? {}
          : { outputItemCounts: entry.outputItemCounts }),
        ...(entry.inputItemLineage === undefined
          ? {}
          : { inputItemLineage: entry.inputItemLineage }),
        ...(entry.outputItemLineage === undefined
          ? {}
          : { outputItemLineage: entry.outputItemLineage }),
      })),
      effectCount: executed.result.effects.length,
      verifiedEffectCount: executed.result.effects.filter(
        (effect) => effect.verified,
      ).length,
      subExecutionCount: executed.result.subExecutions.length,
    };
  } catch (cause) {
    return {
      name: scenario.name,
      passed: false,
      implicitAssertions,
      configurationErrors: [
        `Failed to load scenario data: ${String((cause as Error)?.message ?? cause)}`,
      ],
      pendingMocks: [],
      errors: [],
      trace: [],
      effectCount: 0,
      verifiedEffectCount: 0,
      subExecutionCount: 0,
    };
  }
}

export async function runRehearsal(
  options: RunRehearsalOptions,
): Promise<RehearsalResult> {
  const selected =
    options.selectedCases === undefined
      ? options.manifest.cases
      : options.manifest.cases.filter((scenario) =>
          options.selectedCases?.includes(scenario.name),
        );
  const cases: RehearsalCaseResult[] = [];
  for (const scenario of selected) {
    const result = await runCase(options.workflowFile, scenario);
    cases.push(result);
    if (options.failFast && !result.passed) break;
  }

  const executableNodes = [
    ...new Set(
      cases.flatMap(
        (entry) => entry.assertions?.coverage.executableNodes ?? [],
      ),
    ),
  ];
  const executedNodes = [
    ...new Set(
      cases.flatMap((entry) => entry.assertions?.coverage.executedNodes ?? []),
    ),
  ].filter((node) => executableNodes.includes(node));
  const passed = cases.filter((entry) => entry.passed).length;
  return {
    summary: {
      total: cases.length,
      passed,
      failed: cases.length - passed,
      unionCoverage: {
        executableNodes,
        executedNodes,
        ratio:
          executableNodes.length === 0
            ? 0
            : executedNodes.length / executableNodes.length,
        uncoveredNodes: executableNodes.filter(
          (node) => !executedNodes.includes(node),
        ),
      },
    },
    cases,
  };
}
