import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_ENTRY = join(import.meta.dir, "index.ts");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function runCli(args: string[]) {
  const process = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function fixture(): Promise<{
  workflow: string;
  passing: string;
  failing: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "s8n-rehearse-cli-"));
  directories.push(directory);
  const workflow = join(directory, "workflow.json");
  const passing = join(directory, "passing.yaml");
  const failing = join(directory, "failing.json");
  await Bun.write(
    workflow,
    JSON.stringify({
      name: "CLI rehearsal",
      nodes: [
        { name: "Start", type: "n8n-nodes-base.manualTrigger" },
        {
          name: "Set result",
          type: "n8n-nodes-base.set",
          parameters: { fields: [{ name: "result", value: "synthetic" }] },
        },
      ],
      connections: {
        Start: {
          main: [[{ node: "Set result", type: "main", index: 0 }]],
        },
      },
    }),
  );
  await Bun.write(
    passing,
    [
      "version: 1",
      "cases:",
      "  - name: normal",
      "    input:",
      "      source: synthetic",
      "    assertions:",
      "      minimumCoverage: 1",
      "      nodeOutputs:",
      "        - node: Set result",
      "          pointer: /json/result",
      "          equals: synthetic",
    ].join("\n"),
  );
  await Bun.write(
    failing,
    JSON.stringify({
      version: 1,
      cases: [
        {
          name: "mutated",
          assertions: { requiredNodes: ["Missing node"] },
        },
      ],
    }),
  );
  return { workflow, passing, failing };
}

describe("rehearse CLI", () => {
  test("runs an optional manifest and prints one passing envelope", async () => {
    const files = await fixture();
    const run = await runCli(["rehearse", files.workflow, files.passing]);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      ok: true,
      command: "rehearse",
      data: { summary: { total: 1, passed: 1, unionCoverage: { ratio: 1 } } },
    });
  });

  test("fails on an assertion mutation and validates manifests separately", async () => {
    const files = await fixture();
    const failed = await runCli(["rehearse", files.workflow, files.failing]);
    expect(failed.exitCode).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({
      ok: false,
      data: {
        cases: [{ passed: false, configurationErrors: [expect.any(String)] }],
      },
    });

    const validated = await runCli(["scenario", "validate", files.passing]);
    expect(validated.exitCode).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({
      ok: true,
      command: "scenario-validate",
      data: { valid: true, caseCount: 1, cases: ["normal"] },
    });
  });
});
