/**
 * Release-quality gate for the feedback-driven feature work:
 *
 * - pagination modeling (multi-page mocks, `$response` completion, fidelity
 *   notes for single-page mocks)
 * - string assertions (`matches` / `notMatches` / `occurrences`) and
 *   golden-file snapshots
 * - parent-child scenarios (sub-workflow entry-payload assertions, resume
 *   directives, `waiting` status)
 * - `executeOnce` modeling and mock-served fidelity notes
 * - BigQuery read type coercion through the emulator
 * - `--repeat N` variance over mock `$variants`
 * - `s8n eval` offline precision/recall
 *
 * Every fixture here is original, minimal, and synthetic.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Envelope {
  ok: boolean;
  command: string;
  error?: string;
  data?: Record<string, unknown> & {
    status?: string;
    nodeOutputs?: Record<string, Array<{ json?: Record<string, unknown> }>>;
    fidelityNotes?: string[];
    pendingMocks?: unknown[];
    errors?: string[];
    subExecutions?: Array<Record<string, unknown>>;
    trace?: Array<Record<string, unknown>>;
    repeat?: {
      count?: number;
      deterministic?: boolean;
      distinctCount?: number;
      cardinality?: Record<string, number[]>;
    };
    summary?: { total?: number; passed?: number };
    cases?: Array<{
      passed?: boolean;
      runStatus?: string;
      snapshot?: { updated?: boolean; diff?: string[]; error?: string };
      node?: string;
      precision?: number;
      recall?: number;
    }>;
    aggregate?: { caseCount?: number; precision?: number; recall?: number };
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
    `CLI failed: ${result.stderr || result.stdout}`,
  );
  return result.envelope;
}

const directory = await mkdtemp(join(tmpdir(), "s8n-features-gate-"));
try {
  const binary = join(import.meta.dir, "..", "dist", "s8n");

  // ---- Pagination -----------------------------------------------------
  const pagedPath = join(directory, "paged.yaml");
  await Bun.write(
    pagedPath,
    `name: Synthetic paged listing
nodes:
  - name: Trigger
    type: n8n-nodes-base.manualTrigger
  - name: Fetch Pages
    type: n8n-nodes-base.httpRequest
    parameters:
      method: GET
      url: https://example.invalid/items
      options:
        pagination:
          pagination:
            paginationMode: updateAParameterInEachRequest
            parameters:
              parameters:
                - type: qs
                  name: cursor
                  value: "={{ $response.body.next }}"
            paginationCompleteWhen: other
            completeExpression: "={{ $response.body.done === true }}"
  - name: Collect
    type: n8n-nodes-base.set
    parameters:
      includeOtherFields: true
      fields:
        - name: itemCount
          value: "={{ $json.items.length }}"
connections:
  Trigger:
    main:
      - - node: Fetch Pages
          type: main
          index: 0
  Fetch Pages:
    main:
      - - node: Collect
          type: main
          index: 0
settings: {}
`,
  );
  const pagesMockPath = join(directory, "pages-mock.json");
  await writeJson(pagesMockPath, {
    "Fetch Pages": {
      pages: [
        { items: [1, 2], next: "c2", done: false },
        { items: [3], done: true },
      ],
    },
  });
  const paged = await run(binary, [
    "run",
    pagedPath,
    "--mocks",
    pagesMockPath,
    "--trace-requests",
  ]);
  const fetchPagesTrace = (paged.data?.trace ?? []).find(
    (entry) => entry.nodeName === "Fetch Pages",
  );
  assert(
    paged.data?.status === "success" &&
      (paged.data.nodeOutputs?.["Fetch Pages"]?.length ?? 0) === 2 &&
      (paged.data.nodeOutputs?.["Collect"]?.[0]?.json?.itemCount ?? -1) === 2,
    "Paginated listing did not concatenate page items",
  );
  assert(
    JSON.stringify(fetchPagesTrace?.resolvedRequests ?? []).includes(
      "cursor=c2",
    ),
    "Page request did not carry the previous page's cursor",
  );
  assert(
    !JSON.stringify(paged.data.fidelityNotes ?? []).includes("pagination-"),
    "Complete pages mock emitted an unexpected pagination fidelity note",
  );

  const singlePageMockPath = join(directory, "single-page-mock.json");
  await writeJson(singlePageMockPath, {
    "Fetch Pages": { items: [1, 2, 3], done: true },
  });
  const singlePage = await run(binary, [
    "run",
    pagedPath,
    "--mocks",
    singlePageMockPath,
  ]);
  assert(
    (singlePage.data?.nodeOutputs?.["Fetch Pages"]?.length ?? 0) === 1 &&
      JSON.stringify(singlePage.data?.fidelityNotes ?? []).includes(
        "pagination-single-page-mock",
      ),
    "Single-page mock for a paginated node was not annotated with a fidelity note",
  );

  // ---- String assertions + snapshots ----------------------------------
  const composePath = join(directory, "compose.yaml");
  await Bun.write(
    composePath,
    `name: Synthetic message composer
nodes:
  - name: Trigger
    type: n8n-nodes-base.manualTrigger
  - name: Compose
    type: n8n-nodes-base.set
    parameters:
      fields:
        - name: approvalMessage
          value: "=*Approval request*\\nFacility: {{ $json.facility }}"
connections:
  Trigger:
    main:
      - - node: Compose
          type: main
          index: 0
settings: {}
`,
  );
  const composeScenarioPath = join(directory, "compose-scenarios.yaml");
  await Bun.write(
    composeScenarioPath,
    `version: 1
cases:
  - name: message-shape
    input:
      facility: Example Clinic
    assertions:
      status: success
      nodeOutputs:
        - node: Compose
          pointer: /json/approvalMessage
          matches: '^\\*Approval request\\*'
          notMatches: 'undefined|\\{\\{|\\$\\{'
          occurrences:
            substring: Facility
            atMost: 1
    snapshot: ./compose-golden.json
`,
  );
  const composeRehearse = await run(binary, [
    "rehearse",
    composePath,
    composeScenarioPath,
    "--update-snapshots",
  ]);
  assert(
    composeRehearse.data?.summary?.passed === 1 &&
      composeRehearse.data.cases?.[0]?.snapshot?.updated === true,
    "Snapshot baseline was not written",
  );
  const composeRehearseAgain = await run(binary, [
    "rehearse",
    composePath,
    composeScenarioPath,
  ]);
  assert(
    composeRehearseAgain.data?.summary?.passed === 1,
    "Snapshot comparison failed against the fresh baseline",
  );

  // Drift the golden file so the string assertion still passes but the
  // snapshot must fail.
  const driftedComposeScenarioPath = join(directory, "compose-drift.yaml");
  await Bun.write(
    driftedComposeScenarioPath,
    `version: 1
cases:
  - name: message-shape
    input:
      facility: Example Clinic
    assertions:
      status: success
      nodeOutputs:
        - node: Compose
          pointer: /json/approvalMessage
          matches: '^\\*Approval request\\*'
    snapshot: ./drifted-golden.json
`,
  );
  const driftedGoldenPath = join(directory, "drifted-golden.json");
  await writeJson(driftedGoldenPath, {
    Compose: [{ approvalMessage: "*Approval request*", tampered: true }],
  });
  const drifted = await runAllowFailure(binary, [
    "rehearse",
    composePath,
    driftedComposeScenarioPath,
  ]);
  assert(
    drifted.exitCode === 1 &&
      drifted.envelope.ok === false &&
      (drifted.envelope.data?.cases?.[0]?.snapshot?.diff?.length ?? 0) > 0,
    "Snapshot drift was not rejected",
  );

  // ---- Parent-child approval flow (resume + waiting) ------------------
  const approvalParentPath = join(directory, "approval-parent.yaml");
  const approvalChildPath = join(directory, "approval-child.yaml");
  const approvalMapPath = join(directory, "approval-map.yaml");
  const approvalScenarioPath = join(directory, "approval-scenarios.yaml");
  await Bun.write(
    approvalParentPath,
    `name: Synthetic approval parent
nodes:
  - name: Trigger
    type: n8n-nodes-base.manualTrigger
  - name: Call Child
    type: n8n-nodes-base.executeWorkflow
    parameters:
      workflowId:
        mode: list
        value: approval-child
      workflowInputs:
        mappingMode: defineBelow
        attemptToConvertTypes: false
        convertFieldsToString: true
        value:
          requestId: "={{ $json.requestId }}"
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
    approvalChildPath,
    `name: Synthetic approval child
nodes:
  - name: Child Trigger
    type: n8n-nodes-base.executeWorkflowTrigger
  - name: Wait for approval
    type: n8n-nodes-base.wait
    parameters:
      resume: onWebhookCall
  - name: Apply
    type: n8n-nodes-base.set
    parameters:
      assignments:
        assignments:
          - name: approved
            value: "={{ $json.approved === true }}"
          - name: requestId
            value: "={{ $json.requestId }}"
connections:
  Child Trigger:
    main:
      - - node: Wait for approval
          type: main
          index: 0
  Wait for approval:
    main:
      - - node: Apply
          type: main
          index: 0
settings: {}
`,
  );
  await Bun.write(
    approvalMapPath,
    `workflows:\n  - reference: approval-child\n    path: ./approval-child.yaml\n`,
  );
  await Bun.write(
    approvalScenarioPath,
    `version: 1
defaults:
  input:
    requestId: req-7
  workflowMap: ./approval-map.yaml
cases:
  - name: approved
    resume:
      Wait for approval:
        approved: true
    assertions:
      status: success
      subExecutionCount: 1
      subExecutionInputs:
        - callNode: Call Child
          pointer: /json/requestId
          exists: true
          equals: req-7
          matches: "^req-"
      nodeOutputs:
        - node: Call Child
          pointer: /json/approved
          equals: true
  - name: timeout
    resume:
      Wait for approval: timeout
    assertions:
      status: success
      nodeOutputs:
        - node: Call Child
          pointer: /json/approved
          equals: false
  - name: unresolved-wait
    assertions:
      status: waiting
      subExecutionCount: 1
`,
  );
  const approval = await run(binary, [
    "rehearse",
    approvalParentPath,
    approvalScenarioPath,
  ]);
  assert(
    approval.data?.summary?.passed === 3 && approval.data.summary.total === 3,
    "Approval resume/waiting scenarios did not pass",
  );

  // ---- executeOnce + mocked fidelity note -----------------------------
  const collapsePath = join(directory, "collapse.yaml");
  await Bun.write(
    collapsePath,
    `name: Synthetic collapse
nodes:
  - name: Trigger
    type: n8n-nodes-base.manualTrigger
  - name: Collapse
    type: n8n-nodes-base.set
    executeOnce: true
    parameters:
      assignments:
        assignments:
          - name: seenIndex
            value: "={{ $itemIndex }}"
  - name: Fetch
    type: n8n-nodes-base.httpRequest
    parameters:
      method: GET
      url: https://example.invalid/data
connections:
  Trigger:
    main:
      - - node: Collapse
          type: main
          index: 0
  Collapse:
    main:
      - - node: Fetch
          type: main
          index: 0
settings: {}
`,
  );
  const collapseInputPath = join(directory, "collapse-input.json");
  await writeJson(collapseInputPath, [{ a: 1 }, { a: 2 }, { a: 3 }]);
  const collapseMocksPath = join(directory, "collapse-mocks.json");
  await writeJson(collapseMocksPath, { Fetch: { data: "ok" } });
  const collapse = await run(binary, [
    "run",
    collapsePath,
    "--input",
    collapseInputPath,
    "--mocks",
    collapseMocksPath,
  ]);
  assert(
    (collapse.data?.nodeOutputs?.Collapse?.length ?? 0) === 1 &&
      collapse.data?.nodeOutputs?.Collapse?.[0]?.json?.seenIndex === 0,
    "executeOnce did not collapse N input items into one run",
  );
  assert(
    JSON.stringify(collapse.data.fidelityNotes ?? []).includes("mocked-output"),
    "Mock-served node did not carry a mocked-output fidelity note",
  );

  // ---- BigQuery read type coercion (emulator) -------------------------
  const bigqueryPath = join(directory, "bigquery.yaml");
  await Bun.write(
    bigqueryPath,
    `name: Synthetic bigquery types
nodes:
  - name: Trigger
    type: n8n-nodes-base.manualTrigger
  - name: Insert Hit
    type: n8n-nodes-base.googleBigQuery
    parameters:
      operation: insert
      tableId: hits
      rows:
        - is_hit: true
          score: 1.5
  - name: Query Hits
    type: n8n-nodes-base.googleBigQuery
    parameters:
      operation: executeQuery
      query: "SELECT * FROM hits"
connections:
  Trigger:
    main:
      - - node: Insert Hit
          type: main
          index: 0
  Insert Hit:
    main:
      - - node: Query Hits
          type: main
          index: 0
settings: {}
`,
  );
  const bigquery = await run(binary, ["run", bigqueryPath, "--emulate", "gcp"]);
  assert(
    bigquery.data?.nodeOutputs?.["Query Hits"]?.[0]?.json?.is_hit === "true" &&
      bigquery.data.nodeOutputs["Query Hits"][0].json?.score === "1.5",
    "BigQuery emulator did not stringify boolean/numeric read values",
  );

  // ---- --repeat variance over mock variants ---------------------------
  const agentPath = join(directory, "agent.yaml");
  await Bun.write(
    agentPath,
    `name: Synthetic agent output
nodes:
  - name: Trigger
    type: n8n-nodes-base.manualTrigger
  - name: Agent
    type: "@n8n/n8n-nodes-langchain.agent"
connections:
  Trigger:
    main:
      - - node: Agent
          type: main
          index: 0
settings: {}
`,
  );
  const agentMocksPath = join(directory, "agent-mocks.json");
  await writeJson(agentMocksPath, {
    $variants: {
      Agent: [
        { output: { proposals: [{ proposalId: "p1" }] } },
        { output: { proposals: [{ proposalId: "p1" }, { proposalId: "p2" }] } },
      ],
    },
  });
  const repeated = await run(binary, [
    "run",
    agentPath,
    "--mocks",
    agentMocksPath,
    "--repeat",
    "4",
  ]);
  const repeat = repeated.data?.repeat;
  assert(
    repeat !== undefined &&
      repeat.deterministic === false &&
      repeat.distinctCount === 2 &&
      repeat.count === 4,
    "--repeat did not report the expected output variance",
  );

  // ---- s8n eval (offline precision/recall) ----------------------------
  const executionPath = join(directory, "eval-execution.json");
  await writeJson(executionPath, {
    status: "success",
    data: {
      startData: { destinationNode: "Agent" },
      resultData: {
        runData: {
          Agent: [
            {
              data: {
                main: [
                  [
                    {
                      json: {
                        output: {
                          proposals: [
                            { proposalId: "p1" },
                            { proposalId: "p2" },
                            { proposalId: "p9" },
                          ],
                        },
                      },
                    },
                  ],
                ],
              },
            },
          ],
        },
      },
    },
  });
  const expectationsPath = join(directory, "eval-expectations.json");
  await writeJson(expectationsPath, {
    cases: [
      {
        node: "Agent",
        pointer: "/output/proposals",
        key: "proposalId",
        expected: [
          { proposalId: "p1" },
          { proposalId: "p2" },
          { proposalId: "p3" },
        ],
      },
    ],
  });
  const evaluated = await run(binary, [
    "eval",
    executionPath,
    expectationsPath,
  ]);
  assert(
    evaluated.data?.aggregate?.recall === 2 / 3 &&
      evaluated.data.aggregate.precision === 2 / 3,
    "s8n eval precision/recall scoring did not match the fixture",
  );

  console.log(
    JSON.stringify(
      {
        status: "passed",
        assertions: {
          paginationMultiPageExecuted: true,
          paginationCursorPropagated: true,
          paginationSinglePageFidelityNote: true,
          stringAssertionsAndSnapshotVerified: true,
          snapshotDriftRejected: true,
          approvalResumeAndWaitingVerified: true,
          subExecutionInputAssertionVerified: true,
          executeOnceCollapseVerified: true,
          mockedFidelityNoteVerified: true,
          bigQueryReadTypeCoercionVerified: true,
          repeatVarianceReported: true,
          offlineEvalPrecisionRecallVerified: true,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
