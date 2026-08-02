import { describe, expect, test } from "bun:test";
import path from "node:path";

const CLI_ENTRY = path.join(import.meta.dir, "index.ts");
const FIXTURES_DIR = path.join(import.meta.dir, "..", "..", "fixtures");

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("s8n CLI", () => {
  test("run executes a fixture workflow end-to-end and prints a single JSON envelope", async () => {
    const { stdout, exitCode } = await runCli([
      "run",
      path.join(FIXTURES_DIR, "basic.workflow.json"),
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("run");
    expect(parsed.data.status).toBe("success");
  });

  test("run reports needs_mock and a non-zero-but-graceful envelope for an unmocked HTTP node", async () => {
    const { stdout, exitCode } = await runCli([
      "run",
      path.join(FIXTURES_DIR, "http.workflow.json"),
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.data.status).toBe("needs_mock");
    expect(parsed.data.pendingMocks.length).toBeGreaterThan(0);
  });

  test("run --execution-log emits n8n-like resultData.runData with node items", async () => {
    const { stdout, exitCode } = await runCli([
      "run",
      path.join(FIXTURES_DIR, "basic.workflow.json"),
      "--execution-log",
      "--truncate-data",
      "1",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.data.status).toBe("success");
    expect(parsed.data.data.resultData.runData.Trigger[0]).toMatchObject({
      executionIndex: 0,
      executionStatus: "success",
      source: [],
    });
    expect(
      parsed.data.data.resultData.runData["Set Message"][0].data.main[0][0]
        .json,
    ).toEqual({ message: "Hello, world!" });
  });

  test("validate reports schema issues for a malformed workflow file", async () => {
    const tmpFile = path.join(
      FIXTURES_DIR,
      "..",
      "fixtures",
      ".tmp-invalid.workflow.json",
    );
    await Bun.write(tmpFile, JSON.stringify({ nodes: [] }));
    try {
      const { stdout, exitCode } = await runCli(["validate", tmpFile]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.issues.length).toBeGreaterThan(0);
    } finally {
      await Bun.file(tmpFile).delete?.();
    }
  });

  test("schema with no argument lists all builtin node types", async () => {
    const { stdout, exitCode } = await runCli(["schema"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(
      parsed.data.executedNodeTypes.some(
        (d: { type: string }) => d.type === "n8n-nodes-base.if",
      ),
    ).toBe(true);
    expect(
      parsed.data.mockedNodeTypesWithTailoredHints.some(
        (d: { type: string }) => d.type === "n8n-nodes-base.slack",
      ),
    ).toBe(true);
  });

  test("schema for an unmodeled node type still succeeds and returns a tailored mock hint", async () => {
    const { stdout, exitCode } = await runCli([
      "schema",
      "n8n-nodes-base.slack",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.requiresMock).toBe(true);
    expect(parsed.data.tailoredMockExample).toBeDefined();
  });
});
