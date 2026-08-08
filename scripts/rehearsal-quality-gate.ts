import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRehearsalReport } from "./render-rehearsal-report.ts";

interface Envelope {
  ok: boolean;
  command: string;
  data?: Record<string, unknown> & {
    status?: string;
    nodeOutputs?: Record<string, Array<{ json: Record<string, unknown> }>>;
    subExecutions?: Array<{
      status: string;
      traceStatusCounts: Record<string, number>;
    }>;
  };
}

interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  envelope: Envelope;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function runAllowFailure(
  binary: string,
  args: string[],
): Promise<CliRun> {
  const process = Bun.spawn([binary, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return {
    exitCode,
    stdout,
    stderr,
    envelope: JSON.parse(stdout) as Envelope,
  };
}

async function run(binary: string, args: string[]): Promise<Envelope> {
  const result = await runAllowFailure(binary, args);
  assert(
    result.exitCode === 0,
    `Rehearsal CLI failed: ${result.stderr || result.stdout}`,
  );
  return result.envelope;
}

function verifyResult(envelope: Envelope, expectedKeyCount: number): boolean {
  const output = envelope.data?.nodeOutputs?.["Call Child"]?.[0]?.json;
  const child = envelope.data?.subExecutions?.[0];
  return (
    envelope.ok === true &&
    envelope.data?.status === "success" &&
    output?.keyCount === expectedKeyCount &&
    output?.date === "2026-08-01" &&
    output?.remote === "synthetic" &&
    Array.isArray(output?.hostGlobals) &&
    output.hostGlobals.every((value) => value === "undefined") &&
    child?.status === "success" &&
    child.traceStatusCounts.success === 4
  );
}

const directory = await mkdtemp(join(tmpdir(), "s8n-rehearsal-gate-"));
try {
  const assetDirectory = join(directory, "_subfiles", "child");
  await mkdir(assetDirectory, { recursive: true });
  const rootPath = join(directory, "root.yaml");
  const childPath = join(directory, "child.yaml");
  const mapPath = join(directory, "map.yaml");
  const inputPath = join(directory, "input.json");
  const mocksPath = join(directory, "mocks.json");
  const scenarioPath = join(directory, "scenarios.yaml");
  const mutatedScenarioPath = join(directory, "mutated-scenarios.yaml");
  const executionPath = join(directory, "execution.json");
  const mismatchedExecutionPath = join(directory, "mismatched-execution.json");

  await Bun.write(
    rootPath,
    `name: Synthetic parent
nodes:
  - name: Trigger
    type: n8n-nodes-base.manualTrigger
  - name: Call Child
    type: n8n-nodes-base.executeWorkflow
    typeVersion: 1.3
    parameters:
      workflowId:
        mode: list
        value: synthetic-child
      workflowInputs:
        mappingMode: defineBelow
        attemptToConvertTypes: false
        convertFieldsToString: false
        value:
          message: "={{ $json.message }}"
          profile: "={{ $json.profile }}"
          startDate: "={{ $json.startDate }}"
      options: {}
connections:
  Trigger:
    main:
      - - node: Call Child
          type: main
          index: 0
settings: {}
`,
  );
  await Bun.write(
    childPath,
    `name: Synthetic child
nodes:
  - name: Child Trigger
    type: n8n-nodes-base.executeWorkflowTrigger
    typeVersion: 1.1
  - name: Transform
    type: n8n-nodes-base.set
    parameters:
      includeOtherFields: true
      fields:
        - name: keyCount
          value: "={{ $json.profile.keys().length }}"
        - name: date
          value: "={{ DateTime.fromISO($json.startDate).toISODate() }}"
  - name: Fetch Data
    type: n8n-nodes-base.httpRequest
    parameters:
      url: https://example.invalid/synthetic
  - name: Code
    type: n8n-nodes-base.code
    parameters:
      jsCode: ./_subfiles/child/code.js
connections:
  Child Trigger:
    main:
      - - node: Transform
          type: main
          index: 0
  Transform:
    main:
      - - node: Fetch Data
          type: main
          index: 0
  Fetch Data:
    main:
      - - node: Code
          type: main
          index: 0
settings: {}
`,
  );
  await Bun.write(
    join(assetDirectory, "code.js"),
    `return items.map((item) => ({ json: { ...item.json, hostGlobals: [typeof fetch, typeof process, typeof Bun, typeof require, typeof globalThis.fetch] } }));\n`,
  );
  await Bun.write(
    mapPath,
    `workflows:\n  - reference: synthetic-child\n    path: ./child.yaml\n`,
  );
  await writeJson(inputPath, {
    message: "Synthetic input",
    profile: { role: "engineer", level: 2 },
    startDate: "2026-08-01T00:00:00.000Z",
  });
  await writeJson(mocksPath, {
    "Call Child::Fetch Data": {
      keyCount: 2,
      date: "2026-08-01",
      remote: "synthetic",
    },
  });
  const scenarioSource = `version: 1
defaults:
  inputFile: ./input.json
  mocksFile: ./mocks.json
  workflowMap: ./map.yaml
  resolveCodeIncludes: true
  now: "2026-08-01T00:00:00.000Z"
cases:
  - name: mapped-child
    assertions:
      minimumCoverage: 1
      requiredNodes: [Call Child]
      pendingMockCount: 0
      subExecutionCount: 1
      nodeOutputs:
        - node: Call Child
          pointer: /json/keyCount
          equals: EXPECTED_KEY_COUNT
        - node: Call Child
          pointer: /json/hostGlobals/0
          equals: undefined
`;
  await Bun.write(
    scenarioPath,
    scenarioSource.replace("EXPECTED_KEY_COUNT", "2"),
  );
  await Bun.write(
    mutatedScenarioPath,
    scenarioSource.replace("EXPECTED_KEY_COUNT", "99"),
  );
  await writeJson(executionPath, {
    status: "success",
    startedAt: "2026-08-01T00:00:00.000Z",
    data: {
      startData: { destinationNode: "Trigger" },
      resultData: {
        runData: {
          Trigger: [
            {
              executionIndex: 0,
              data: {
                main: [
                  [
                    {
                      json: {
                        email: "private-sentinel@example.com",
                        token: "private-token-sentinel",
                      },
                    },
                  ],
                ],
              },
            },
          ],
          "Call Child": [
            {
              executionIndex: 1,
              data: { main: [[{ json: { result: "private-result" } }]] },
            },
          ],
        },
      },
    },
  });
  await writeJson(mismatchedExecutionPath, {
    data: { resultData: { runData: { "Unknown Node": [{}] } } },
  });

  const binary = join(import.meta.dir, "..", "dist", "s8n");
  const args = [
    "run",
    rootPath,
    "--workflow-map",
    mapPath,
    "--resolve-code-includes",
    "--input",
    inputPath,
    "--mocks",
    mocksPath,
    "--now",
    "2026-08-01T00:00:00.000Z",
  ];
  const first = await run(binary, args);
  const second = await run(binary, args);
  assert(verifyResult(first, 2), "Synthetic mapped workflow evidence failed");
  assert(verifyResult(second, 2), "Repeated rehearsal evidence failed");
  assert(
    !verifyResult(first, 99),
    "The rehearsal verifier did not reject a mutated expectation",
  );

  const manifestRun = await run(binary, ["rehearse", rootPath, scenarioPath]);
  const manifestSummary = manifestRun.data?.summary as
    | { total?: number; passed?: number; unionCoverage?: { ratio?: number } }
    | undefined;
  assert(
    manifestRun.ok === true &&
      manifestSummary?.total === 1 &&
      manifestSummary.passed === 1 &&
      manifestSummary.unionCoverage?.ratio === 1,
    "Scenario manifest did not verify the mapped workflow",
  );
  const mutatedManifest = await runAllowFailure(binary, [
    "rehearse",
    rootPath,
    mutatedScenarioPath,
  ]);
  assert(
    mutatedManifest.exitCode === 1 && mutatedManifest.envelope.ok === false,
    "Scenario assertion mutation did not fail",
  );

  const importedDraft = await run(binary, [
    "scenario",
    "draft",
    rootPath,
    executionPath,
  ]);
  const importedText = JSON.stringify(importedDraft);
  assert(
    importedDraft.ok === true &&
      importedDraft.data?.generatedFrom !== undefined &&
      !importedText.includes("private-sentinel@example.com") &&
      !importedText.includes("private-token-sentinel") &&
      !importedText.includes("private-result"),
    "Execution-log draft retained a private scalar",
  );
  const mismatchedDraft = await runAllowFailure(binary, [
    "scenario",
    "draft",
    rootPath,
    mismatchedExecutionPath,
  ]);
  assert(
    mismatchedDraft.exitCode === 1 && mismatchedDraft.envelope.ok === false,
    "Execution-log workflow mismatch was not rejected",
  );

  let privacyMutationRejected = false;
  try {
    renderRehearsalReport({
      generatedAt: "2026-08-01T00:00:00.000Z",
      safety: {
        synthetic: true,
        allowlistedEvidenceOnly: true,
        credentialsUsed: false,
        hostIoGlobalsGuarded: true,
        osNetworkIsolation: false,
      },
      reports: [],
      workflowName: "must-not-render",
    });
  } catch {
    privacyMutationRejected = true;
  }
  assert(privacyMutationRejected, "Privacy schema accepted a forbidden field");

  console.log(
    JSON.stringify(
      {
        status: "passed",
        assertions: {
          yamlRootAndChildLoaded: true,
          codeIncludeResolved: true,
          mappedSubWorkflowExecuted: true,
          scopedMockConsumed: true,
          dateTimeAndKeysHelpersMatched: true,
          hostIoGlobalsGuarded: true,
          deterministicSemanticResult: true,
          behaviorMutationRejected: true,
          privacyMutationRejected: true,
          optionalScenarioManifestVerified: true,
          scenarioAssertionMutationRejected: true,
          executionDraftSanitized: true,
          executionWorkflowMismatchRejected: true,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
