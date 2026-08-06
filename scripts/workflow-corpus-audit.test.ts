import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("corpus audit aggregates private node types and omits source identifiers", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "s8n-corpus-audit-"));
  const privateWorkflowName = "confidential-customer-workflow";
  const privateNodeType = "PRIVATE.confidentialOperation";
  const privateNodeName = "Confidential customer lookup";
  try {
    await Bun.write(
      path.join(directory, `${privateWorkflowName}.yaml`),
      `name: private\nnodes:\n  - id: one\n    name: ${privateNodeName}\n    type: ${privateNodeType}\n    parameters: {}\nconnections: {}\n`,
    );
    await Bun.write(
      path.join(directory, "invalid-private.yaml"),
      `name: invalid\nnodes:\n  - id: one\n    name: ${privateNodeName}\n    type: n8n-nodes-base.noOp\n    parameters: {}\n  - id: two\n    name: ${privateNodeName}\n    type: n8n-nodes-base.noOp\n    parameters: {}\nconnections: {}\n`,
    );

    const process = Bun.spawn(
      [
        "bun",
        "run",
        path.join(import.meta.dir, "workflow-corpus-audit.ts"),
        directory,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).not.toContain(directory);
    expect(stdout).not.toContain(privateWorkflowName);
    expect(stdout).not.toContain(privateNodeType);
    expect(stdout).not.toContain(privateNodeName);

    const report = JSON.parse(stdout);
    expect(report.nodeTypes).toContainEqual({
      type: "<custom-node>",
      count: 1,
      supportTier: "injected-boundary",
    });
    expect(report.invalidIssueCounts).toEqual({ "duplicate-node-name": 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
