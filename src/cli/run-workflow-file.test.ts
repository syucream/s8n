import { describe, expect, test } from "bun:test";
import path from "node:path";
import { runWorkflowFile } from "./run-workflow-file.ts";

const FIXTURES_DIR = path.join(import.meta.dir, "..", "..", "fixtures");

describe("runWorkflowFile", () => {
  test("runs a workflow with already-parsed inline input", async () => {
    const executed = await runWorkflowFile({
      workflowFile: path.join(FIXTURES_DIR, "basic.workflow.json"),
      input: { message: "from a scenario" },
      hasExplicitInput: true,
    });

    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.workflow.name).toBe("basic-fixture");
    expect(executed.result.status).toBe("success");
    expect(executed.result.nodeOutputs["Set Message"]?.[0]?.json).toEqual({
      message: "Hello, world!",
    });
  });

  test("validates inline mocks before running the workflow", async () => {
    const executed = await runWorkflowFile({
      workflowFile: path.join(FIXTURES_DIR, "basic.workflow.json"),
      mocks: [],
      hasExplicitInput: false,
    });

    expect(executed).toEqual({
      ok: false,
      error: "--mocks JSON must be a flat { mockKey: value } object",
    });
  });

  test("creates a fresh local emulator from an inline seed", async () => {
    const executed = await runWorkflowFile({
      workflowFile: path.join(FIXTURES_DIR, "notion-emulator.workflow.json"),
      emulatorSeed: { stores: { "notion.databasePages": [] } },
      emulate: ["notion"],
      hasExplicitInput: false,
    });

    expect(executed.ok).toBe(true);
    if (!executed.ok) return;
    expect(executed.result.status).toBe("success");
    expect(executed.result.effects.every((effect) => effect.verified)).toBe(
      true,
    );
  });

  test("rejects an invalid fault target before executing the workflow", async () => {
    const workflowFile = path.join(
      FIXTURES_DIR,
      ".tmp-invalid-fault.workflow.json",
    );
    await Bun.write(
      workflowFile,
      JSON.stringify({
        name: "Invalid fault",
        nodes: [
          {
            name: "Code",
            type: "n8n-nodes-base.code",
            parameters: { jsCode: "throw new Error('should not execute');" },
          },
        ],
        connections: {},
      }),
    );
    try {
      const executed = await runWorkflowFile({
        workflowFile,
        faults: [{ node: "Code", kind: "timeout" }],
        hasExplicitInput: false,
      });

      expect(executed).toEqual({
        ok: false,
        error:
          "Fault target must be an HTTP Request or generic external node: Code",
      });
    } finally {
      await Bun.file(workflowFile).delete?.();
    }
  });
});
