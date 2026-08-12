import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedScenarioManifest } from "./load.ts";
import { runRehearsal } from "./run.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function branchingWorkflow(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "s8n-rehearsal-run-"));
  directories.push(directory);
  const workflowPath = join(directory, "workflow.json");
  await Bun.write(
    workflowPath,
    JSON.stringify({
      name: "Branching rehearsal",
      nodes: [
        { name: "Start", type: "n8n-nodes-base.manualTrigger" },
        {
          name: "Choose",
          type: "n8n-nodes-base.if",
          parameters: { condition: "={{ $json.enabled }}" },
        },
        {
          name: "Enabled",
          type: "n8n-nodes-base.set",
          parameters: { fields: [{ name: "result", value: "enabled" }] },
        },
        {
          name: "Disabled",
          type: "n8n-nodes-base.set",
          parameters: { fields: [{ name: "result", value: "disabled" }] },
        },
      ],
      connections: {
        Start: { main: [[{ node: "Choose", type: "main", index: 0 }]] },
        Choose: {
          main: [
            [{ node: "Enabled", type: "main", index: 0 }],
            [{ node: "Disabled", type: "main", index: 0 }],
          ],
        },
      },
    }),
  );
  return workflowPath;
}

async function externalWorkflow(type: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "s8n-rehearsal-fault-"));
  directories.push(directory);
  const workflowPath = join(directory, "workflow.json");
  await Bun.write(
    workflowPath,
    JSON.stringify({
      name: "Fault rehearsal",
      nodes: [
        { name: "Start", type: "n8n-nodes-base.manualTrigger" },
        { name: "Boundary", type },
      ],
      connections: {
        Start: {
          main: [[{ node: "Boundary", type: "main", index: 0 }]],
        },
      },
    }),
  );
  return workflowPath;
}

describe("runRehearsal", () => {
  test("runs independent cases and reports union executed coverage", async () => {
    const manifest: ResolvedScenarioManifest = {
      version: 1,
      cases: [
        {
          name: "enabled",
          run: { input: { enabled: true } },
          assertions: {
            requiredNodes: ["Enabled"],
            forbiddenNodes: ["Disabled"],
          },
        },
        {
          name: "disabled",
          run: { input: { enabled: false } },
          assertions: {
            requiredNodes: ["Disabled"],
            forbiddenNodes: ["Enabled"],
          },
        },
      ],
    };

    const result = await runRehearsal({
      workflowFile: await branchingWorkflow(),
      manifest,
    });

    expect(result.summary).toMatchObject({
      total: 2,
      passed: 2,
      failed: 0,
      unionCoverage: { ratio: 1 },
    });
    expect(result.cases[0]?.implicitAssertions).toEqual(["status=success"]);
  });

  test("fails a case by default when the workflow does not succeed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "s8n-rehearsal-run-"));
    directories.push(directory);
    const workflowPath = join(directory, "workflow.json");
    await Bun.write(
      workflowPath,
      JSON.stringify({
        name: "Needs mock",
        nodes: [
          { name: "Start", type: "n8n-nodes-base.manualTrigger" },
          { name: "Request", type: "n8n-nodes-base.httpRequest" },
        ],
        connections: {
          Start: {
            main: [[{ node: "Request", type: "main", index: 0 }]],
          },
        },
      }),
    );
    const result = await runRehearsal({
      workflowFile: workflowPath,
      manifest: { version: 1, cases: [{ name: "default", run: {} }] },
    });

    expect(result.cases[0]).toMatchObject({
      passed: false,
      runStatus: "needs_mock",
      implicitAssertions: ["status=success"],
      assertions: {
        failures: [{ assertion: "status" }],
      },
    });
  });

  test("treats unknown assertion nodes and edge endpoints as configuration errors", async () => {
    const result = await runRehearsal({
      workflowFile: await branchingWorkflow(),
      manifest: {
        version: 1,
        cases: [
          {
            name: "invalid",
            run: { input: { enabled: true } },
            assertions: {
              forbiddenNodes: ["Typo"],
              requiredEdges: [
                {
                  sourceNode: "Start",
                  sourceOutput: 0,
                  destinationNode: "Missing",
                  destinationInput: 0,
                },
              ],
            },
          },
        ],
      },
    });
    expect(result.cases[0]?.configurationErrors).toEqual([
      "Assertion references an unknown workflow node: Typo",
      "Assertion references an unknown workflow node: Missing",
    ]);
    expect(result.cases[0]?.passed).toBe(false);
  });

  test("rejects faults on local compute nodes as configuration errors", async () => {
    const result = await runRehearsal({
      workflowFile: await branchingWorkflow(),
      manifest: {
        version: 1,
        cases: [
          {
            name: "invalid target",
            faults: [{ node: "Choose", kind: "timeout" }],
            run: { input: { enabled: true } },
          },
        ],
      },
    });

    expect(result.cases[0]?.configurationErrors).toEqual([
      "Fault target must be an HTTP Request or generic external node: Choose",
    ]);
    expect(result.cases[0]?.passed).toBe(false);
  });

  test("injects HTTP failures before a supplied mock without real I/O", async () => {
    const result = await runRehearsal({
      workflowFile: await externalWorkflow("n8n-nodes-base.httpRequest"),
      manifest: {
        version: 1,
        cases: [
          {
            name: "service unavailable",
            faults: [{ node: "Boundary", kind: "http-error", statusCode: 503 }],
            run: { mocks: { Boundary: { response: "would not be used" } } },
            assertions: { status: "error" },
          },
        ],
      },
    });

    expect(result.cases[0]).toMatchObject({
      passed: true,
      runStatus: "error",
      errors: [expect.stringContaining("Injected HTTP error 503")],
      trace: [
        expect.objectContaining({ node: "Start", status: "success" }),
        expect.objectContaining({ node: "Boundary", status: "error" }),
      ],
    });
  });

  test("represents a timeout without waiting for wall-clock time", async () => {
    const result = await runRehearsal({
      workflowFile: await externalWorkflow("n8n-nodes-base.httpRequest"),
      manifest: {
        version: 1,
        cases: [
          {
            name: "timed out",
            faults: [{ node: "Boundary", kind: "timeout" }],
            run: {},
            assertions: { status: "error" },
          },
        ],
      },
    });

    expect(result.cases[0]).toMatchObject({
      passed: true,
      runStatus: "error",
      errors: [expect.stringContaining("Injected timeout fault")],
      pendingMocks: [],
    });
  });

  test("injects malformed JSON at a generic mock boundary", async () => {
    const result = await runRehearsal({
      workflowFile: await externalWorkflow("n8n-nodes-base.slack"),
      manifest: {
        version: 1,
        cases: [
          {
            name: "bad generic response",
            faults: [{ node: "Boundary", kind: "malformed-json" }],
            run: { mocks: { Boundary: { ok: true } } },
            assertions: { status: "error" },
          },
        ],
      },
    });

    expect(result.cases[0]).toMatchObject({
      passed: true,
      runStatus: "error",
      errors: [expect.stringContaining("Injected malformed JSON")],
    });
  });
});
