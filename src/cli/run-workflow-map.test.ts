import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_ENTRY = join(import.meta.dir, "index.ts");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("run --workflow-map", () => {
  test("executes only the explicitly mapped child workflow", async () => {
    const directory = await mkdtemp(join(tmpdir(), "s8n-cli-workflow-map-"));
    directories.push(directory);
    const parentPath = join(directory, "parent.json");
    const childPath = join(directory, "child.yaml");
    const mapPath = join(directory, "workflows.json");

    await Bun.write(
      parentPath,
      JSON.stringify({
        name: "CLI parent",
        nodes: [
          { name: "Start", type: "n8n-nodes-base.manualTrigger" },
          {
            name: "Call Child",
            type: "n8n-nodes-base.executeWorkflow",
            parameters: {
              workflowId: { value: "child-ref", mode: "list" },
              options: {},
            },
          },
        ],
        connections: {
          Start: {
            main: [[{ node: "Call Child", type: "main", index: 0 }]],
          },
        },
      }),
    );
    await Bun.write(
      childPath,
      [
        "name: CLI child",
        "nodes:",
        "  - name: Called",
        "    type: n8n-nodes-base.executeWorkflowTrigger",
        "  - name: Produce Result",
        "    type: n8n-nodes-base.set",
        "    parameters:",
        "      fields:",
        "        - name: childRan",
        "          value: true",
        "connections:",
        "  Called:",
        "    main:",
        "      - - node: Produce Result",
        "          type: main",
        "          index: 0",
      ].join("\n"),
    );
    await Bun.write(
      mapPath,
      JSON.stringify({
        workflows: [{ reference: "child-ref", path: "child.yaml" }],
      }),
    );

    const process = Bun.spawn(
      ["bun", "run", CLI_ENTRY, "run", parentPath, "--workflow-map", mapPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.status).toBe("success");
    expect(envelope.data.nodeOutputs["Call Child"][0].json).toEqual({
      childRan: true,
    });
    expect(envelope.data.subExecutions).toEqual([
      {
        callNodeName: "Call Child",
        reference: "child-ref",
        workflowName: "CLI child",
        status: "success",
        traceStatusCounts: { success: 2 },
        pendingMockCount: 0,
        errors: [],
        nested: [],
        entryItems: [{ json: {}, pairedItem: { item: 0 } }],
      },
    ]);
  });
});
