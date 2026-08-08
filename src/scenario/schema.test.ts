import { describe, expect, test } from "bun:test";
import {
  scenarioManifestSchema,
  scenarioNodeOutputAssertionSchema,
} from "./schema.ts";

describe("scenario manifest schema", () => {
  test("accepts versioned cases without embedding a workflow", () => {
    const parsed = scenarioManifestSchema.parse({
      version: 1,
      generatedFrom: {
        kind: "n8n-execution-log",
        dataMode: "synthetic-shape",
        reviewRequired: true,
        warnings: ["Review the generated draft."],
      },
      defaults: { now: "2026-08-01T00:00:00.000Z", emulate: ["slack"] },
      cases: [
        {
          name: "normal",
          input: { message: "synthetic" },
          assertions: { minimumCoverage: 0.8 },
        },
      ],
    });

    expect(parsed.cases[0]?.name).toBe("normal");
    expect("workflow" in parsed).toBe(false);
  });

  test("rejects duplicate names and embedded workflows", () => {
    const duplicate = scenarioManifestSchema.safeParse({
      version: 1,
      cases: [{ name: "same" }, { name: "same" }],
    });
    const embeddedWorkflow = scenarioManifestSchema.safeParse({
      version: 1,
      workflow: { name: "not allowed" },
      cases: [{ name: "normal" }],
    });
    expect(duplicate.success).toBe(false);
    expect(embeddedWorkflow.success).toBe(false);
  });

  test("rejects non-item input, non-record mocks, and invalid pointers", () => {
    const invalidInput = scenarioManifestSchema.safeParse({
      version: 1,
      cases: [{ name: "normal", input: "not an item" }],
    });
    const invalidMocks = scenarioManifestSchema.safeParse({
      version: 1,
      cases: [{ name: "normal", mocks: [] }],
    });
    const invalidPointer = scenarioNodeOutputAssertionSchema.safeParse({
      node: "Result",
      pointer: "json.value",
    });

    expect(invalidInput.success).toBe(false);
    expect(invalidMocks.success).toBe(false);
    expect(invalidPointer.success).toBe(false);
  });

  test("preserves explicit equals undefined for the evaluator", () => {
    const parsed = scenarioNodeOutputAssertionSchema.parse({
      node: "Result",
      equals: undefined,
    });

    expect(Object.hasOwn(parsed, "equals")).toBe(true);
  });
});
