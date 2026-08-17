import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { installTestGlobals } from "./globals.ts";
import { loadTestFile } from "./load.ts";
import { defineSuite } from "./suite.ts";

// Temp test files are written inside the repository so the "s8n" self-import
// resolves; they are removed after each test.
const TEMP_PREFIX = ".tmp-test-";
const FIXTURES_DIR = join(import.meta.dir, "..", "..", "fixtures");

const createdFiles: string[] = [];

async function writeTempFiles(): Promise<{
  testPath: string;
  workflowPath: string;
}> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const testPath = join(FIXTURES_DIR, `${TEMP_PREFIX}${unique}.test.ts`);
  const workflowPath = join(
    FIXTURES_DIR,
    `${TEMP_PREFIX}${unique}.workflow.json`,
  );
  createdFiles.push(testPath, workflowPath);
  await Bun.write(
    workflowPath,
    JSON.stringify({
      name: "temp-wf",
      nodes: [
        { name: "Start", type: "n8n-nodes-base.manualTrigger", parameters: {} },
      ],
      connections: {},
    }),
  );
  return { testPath, workflowPath };
}

afterEach(async () => {
  for (const file of createdFiles.splice(0)) {
    await rm(file, { force: true });
  }
});

describe("loadTestFile", () => {
  test("discovers a default-exported suite and resolves relative paths", async () => {
    const { testPath, workflowPath } = await writeTempFiles();
    await Bun.write(
      testPath,
      `import { defineSuite } from "s8n";\n` +
        `export default defineSuite({ workflow: "${workflowPath}" }, (test) => {\n` +
        `  test("case one", async () => {});\n` +
        `});\n`,
    );

    const loaded = await loadTestFile(testPath);
    expect(loaded.file).toBe(testPath);
    expect(loaded.suite.config.workflow).toBe(workflowPath);
    expect(loaded.suite.cases.map((c) => c.name)).toEqual(["case one"]);
  });

  test("discovers a named suite export", async () => {
    const { testPath, workflowPath } = await writeTempFiles();
    await Bun.write(
      testPath,
      `import { defineSuite } from "s8n";\n` +
        `export const suite = defineSuite({ workflow: "${workflowPath}" }, (test) => {\n` +
        `  test("named case", async () => {});\n` +
        `});\n`,
    );
    const loaded = await loadTestFile(testPath);
    expect(loaded.suite.cases.map((c) => c.name)).toEqual(["named case"]);
  });

  test("rejects a file without a suite export", async () => {
    const { testPath } = await writeTempFiles();
    await Bun.write(testPath, `export const notASuite = 42;\n`);
    expect(loadTestFile(testPath)).rejects.toThrow(/must export a suite/);
  });

  test("rejects a missing test file", async () => {
    const { testPath } = await writeTempFiles();
    await rm(testPath, { force: true });
    await rm(testPath.replace(/\.test\.ts$/, ".workflow.json"), {
      force: true,
    });
    expect(loadTestFile(testPath)).rejects.toThrow(/Failed to load test file/);
  });

  test("installs the DSL globals before loading so import-free files work", async () => {
    const { testPath, workflowPath } = await writeTempFiles();
    await Bun.write(
      testPath,
      `export default defineSuite({ workflow: "${workflowPath}" }, (test) => {\n` +
        `  test("no import", async () => {});\n` +
        `});\n`,
    );
    const loaded = await loadTestFile(testPath);
    expect(loaded.suite.cases.map((c) => c.name)).toEqual(["no import"]);
  });
});

describe("installTestGlobals", () => {
  test("exposes defineSuite on globalThis", () => {
    installTestGlobals();
    const global = globalThis as typeof globalThis & { defineSuite: unknown };
    expect(global.defineSuite).toBe(defineSuite);
  });
});
