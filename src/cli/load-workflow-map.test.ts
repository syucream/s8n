import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflowMapFile } from "./load-workflow-map.ts";

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

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "s8n-workflow-map-"));
  directories.push(directory);
  return directory;
}

describe("loadWorkflowMapFile", () => {
  test("loads JSON and YAML workflows from paths relative to a YAML map", async () => {
    const directory = await fixtureDirectory();
    await Bun.write(
      join(directory, "first.json"),
      JSON.stringify({
        name: "First child",
        nodes: [
          {
            name: "Called",
            type: "n8n-nodes-base.executeWorkflowTrigger",
          },
        ],
      }),
    );
    await Bun.write(
      join(directory, "second.yaml"),
      [
        "name: Second child",
        "nodes:",
        "  - name: Called",
        "    type: n8n-nodes-base.executeWorkflowTrigger",
      ].join("\n"),
    );
    const mapPath = join(directory, "workflows.yaml");
    await Bun.write(
      mapPath,
      [
        "workflows:",
        "  - reference: first-ref",
        "    path: first.json",
        "  - reference: second-ref",
        "    path: second.yaml",
      ].join("\n"),
    );

    const result = await loadWorkflowMapFile(mapPath);

    expect(result.ok).toBe(true);
    expect(result.workflows?.get("first-ref")?.name).toBe("First child");
    expect(result.workflows?.get("second-ref")?.name).toBe("Second child");
  });

  test("rejects duplicate references", async () => {
    const directory = await fixtureDirectory();
    await Bun.write(
      join(directory, "child.json"),
      JSON.stringify({
        name: "Child",
        nodes: [
          {
            name: "Called",
            type: "n8n-nodes-base.executeWorkflowTrigger",
          },
        ],
      }),
    );
    const mapPath = join(directory, "workflows.json");
    await Bun.write(
      mapPath,
      JSON.stringify({
        workflows: [
          { reference: "same", path: "child.json" },
          { reference: "same", path: "child.json" },
        ],
      }),
    );

    const result = await loadWorkflowMapFile(mapPath);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('duplicate reference "same"');
  });

  test("reports the reference and relative path when a workflow cannot be loaded", async () => {
    const directory = await fixtureDirectory();
    const mapPath = join(directory, "workflows.json");
    await Bun.write(
      mapPath,
      JSON.stringify({
        workflows: [{ reference: "missing", path: "missing.json" }],
      }),
    );

    const result = await loadWorkflowMapFile(mapPath);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('reference "missing"');
    expect(result.error).toContain('from "missing.json"');
  });
});
