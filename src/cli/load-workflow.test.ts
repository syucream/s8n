import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadWorkflowFile } from "./load-workflow.ts";

const paths: string[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { force: true })));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function fixture(extension: string, content: string): Promise<string> {
  const path = join(
    process.env.TMPDIR ?? "/tmp",
    `s8n-load-workflow-${crypto.randomUUID()}.${extension}`,
  );
  paths.push(path);
  await Bun.write(path, content);
  return path;
}

describe("loadWorkflowFile", () => {
  test("loads an n8n workflow from YAML", async () => {
    const path = await fixture(
      "yaml",
      [
        "name: YAML workflow",
        "nodes:",
        "  - name: Start",
        "    type: n8n-nodes-base.manualTrigger",
        "connections: {}",
        "settings: {}",
      ].join("\n"),
    );

    const result = await loadWorkflowFile(path);

    expect(result.ok).toBe(true);
    expect(result.workflow?.name).toBe("YAML workflow");
    expect(result.workflow?.nodes[0]?.position).toEqual([0, 0]);
  });

  test("keeps JSON loading behavior", async () => {
    const path = await fixture(
      "json",
      JSON.stringify({
        name: "JSON workflow",
        nodes: [{ name: "Start", type: "n8n-nodes-base.manualTrigger" }],
        connections: {},
        settings: {},
      }),
    );

    const result = await loadWorkflowFile(path);

    expect(result.ok).toBe(true);
    expect(result.workflow?.name).toBe("JSON workflow");
  });

  test("returns a load error for invalid YAML", async () => {
    const path = await fixture("yml", "name: [unterminated");

    const result = await loadWorkflowFile(path);

    expect(result.ok).toBe(false);
    expect(result.error).toStartWith("Failed to load workflow file:");
  });

  test("resolves strict Code includes only when explicitly enabled", async () => {
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "s8n-code-include-"),
    );
    directories.push(directory);
    const assetDirectory = join(directory, "_subfiles", "workflow");
    await mkdir(assetDirectory, { recursive: true });
    const workflowPath = join(directory, "workflow.yaml");
    await Bun.write(
      workflowPath,
      [
        "name: Included Code",
        "nodes:",
        "  - name: Code",
        "    type: n8n-nodes-base.code",
        "    parameters:",
        "      jsCode: ./_subfiles/workflow/code.js",
        "connections: {}",
        "settings: {}",
      ].join("\n"),
    );
    await Bun.write(
      join(assetDirectory, "code.js"),
      "return [{ json: { included: true } }];",
    );

    const unresolved = await loadWorkflowFile(workflowPath);
    const resolved = await loadWorkflowFile(workflowPath, {
      resolveCodeIncludes: true,
    });

    expect(unresolved.workflow?.nodes[0]?.parameters.jsCode).toBe(
      "./_subfiles/workflow/code.js",
    );
    expect(resolved.workflow?.nodes[0]?.parameters.jsCode).toContain(
      "included: true",
    );
  });

  test("rejects Code include traversal before executing JavaScript", async () => {
    const path = await fixture(
      "yaml",
      [
        "name: Invalid include",
        "nodes:",
        "  - name: Code",
        "    type: n8n-nodes-base.code",
        "    parameters:",
        "      jsCode: ./_subfiles/../outside.js",
        "connections: {}",
        "settings: {}",
      ].join("\n"),
    );

    const result = await loadWorkflowFile(path, { resolveCodeIncludes: true });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Code include must match");
  });
});
