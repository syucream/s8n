import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const CLI_ENTRY = join(import.meta.dir, "index.ts");
const FIXTURES_DIR = join(import.meta.dir, "..", "..", "fixtures");
const EXAMPLES_DIR = join(import.meta.dir, "..", "..", "examples");

const createdFiles: string[] = [];

async function writeTempTest(content: string): Promise<string> {
  const path = join(
    FIXTURES_DIR,
    `.tmp-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}.test.ts`,
  );
  createdFiles.push(path);
  await Bun.write(path, content);
  return path;
}

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

afterEach(async () => {
  for (const file of createdFiles.splice(0)) {
    await rm(file, { force: true });
  }
});

describe("s8n test CLI", () => {
  test("runs a passing test file and prints a single success envelope", async () => {
    const { stdout, stderr, exitCode } = await runCli([
      "test",
      join(EXAMPLES_DIR, "hello-world.test.ts"),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("test");
    expect(parsed.data.summary.total).toBe(2);
    expect(parsed.data.summary.passed).toBe(2);
    expect(parsed.data.summary.failed).toBe(0);
    expect(parsed.data.cases).toHaveLength(2);
  });

  test("runs multiple test files in one invocation", async () => {
    const { stdout, exitCode } = await runCli([
      "test",
      join(EXAMPLES_DIR, "hello-world.test.ts"),
      join(EXAMPLES_DIR, "approval.test.ts"),
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.data.summary.total).toBe(6);
    expect(parsed.data.summary.passed).toBe(6);
  });

  test("fails with exit code 1 and records matcher failures", async () => {
    const testPath = await writeTempTest(`
import { defineSuite } from "s8n";
export default defineSuite({ workflow: "${join(FIXTURES_DIR, "basic.workflow.json")}" }, (test) => {
  test("wrong status", async (run, expect) => {
    const r = await run({});
    expect(r).status("error");
  });
  test("second passes", async (run, expect) => {
    const r = await run({});
    expect(r).status("success");
  });
});
`);
    const { stdout, exitCode } = await runCli(["test", testPath]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.data.summary.total).toBe(2);
    expect(parsed.data.summary.passed).toBe(1);
    expect(parsed.data.summary.failed).toBe(1);
    const failed = parsed.data.cases.find(
      (c: { name: string }) => c.name === "wrong status",
    );
    expect(failed.failures[0]).toMatch(
      /Expected workflow status error, got success/,
    );
  });

  test("keeps stdout a single JSON envelope despite test console output", async () => {
    const testPath = await writeTempTest(`
import { defineSuite } from "s8n";
export default defineSuite({ workflow: "${join(FIXTURES_DIR, "basic.workflow.json")}" }, (test) => {
  test("noisy", async () => {
    console.log("leaked-noise-42");
    console.error("leaked-error-42");
  });
});
`);
    const { stdout, exitCode } = await runCli(["test", testPath]);
    expect(exitCode).toBe(0);
    // The whole stdout must be exactly one JSON envelope.
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("test");
    expect(parsed.data.cases[0].consoleOutput).toContain("leaked-noise-42");
    expect(parsed.data.cases[0].consoleOutput).toContain("leaked-error-42");
  });

  test("supports --test name filtering", async () => {
    const { stdout, exitCode } = await runCli([
      "test",
      join(EXAMPLES_DIR, "approval.test.ts"),
      "--test",
      "approved request is posted to slack after human approval",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.data.summary.total).toBe(1);
    expect(parsed.data.cases[0].name).toBe(
      "approved request is posted to slack after human approval",
    );
  });

  test("rejects unknown test case names", async () => {
    const { stdout, exitCode } = await runCli([
      "test",
      join(EXAMPLES_DIR, "hello-world.test.ts"),
      "--test",
      "nope",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/Unknown test case\(s\)/);
  });

  test("--fail-fast stops at the first failed case", async () => {
    const testPath = await writeTempTest(`
import { defineSuite } from "s8n";
export default defineSuite({ workflow: "${join(FIXTURES_DIR, "basic.workflow.json")}" }, (test) => {
  test("first fails", async (run, expect) => {
    const r = await run({});
    expect(r).status("error");
  });
  test("second never runs", async () => {
    throw new Error("should not run");
  });
});
`);
    const { stdout, exitCode } = await runCli([
      "test",
      testPath,
      "--fail-fast",
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.data.summary.total).toBe(1);
  });

  test("reports a missing test file as an error envelope", async () => {
    const { stdout, exitCode } = await runCli([
      "test",
      join(FIXTURES_DIR, "does-not-exist.test.ts"),
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.command).toBe("test");
    expect(parsed.error).toMatch(/Failed to load test file/);
  });

  test("reports a test file without a suite export as an error", async () => {
    const testPath = await writeTempTest(`export const notASuite = 1;\n`);
    const { stdout, exitCode } = await runCli(["test", testPath]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/must export a suite/);
  });
});
