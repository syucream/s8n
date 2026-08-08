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

  test("treats unknown assertion nodes as configuration errors", async () => {
    const result = await runRehearsal({
      workflowFile: await branchingWorkflow(),
      manifest: {
        version: 1,
        cases: [
          {
            name: "invalid",
            run: { input: { enabled: true } },
            assertions: { forbiddenNodes: ["Typo"] },
          },
        ],
      },
    });
    expect(result.cases[0]?.configurationErrors[0]).toContain("unknown");
    expect(result.cases[0]?.passed).toBe(false);
  });
});
