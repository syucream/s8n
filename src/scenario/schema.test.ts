import { describe, expect, test } from "bun:test";
import {
  scenarioEdgeAssertionSchema,
  scenarioFaultSchema,
  scenarioManifestSchema,
  scenarioNodeOutputAssertionSchema,
  scenarioNodeOutputCardinalityAssertionSchema,
  scenarioNodeOutputLineageAssertionSchema,
  scenarioNodeRequestAssertionSchema,
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
          assertions: {
            minimumCoverage: 0.8,
            minimumBranchCoverage: 0.5,
            requiredEdges: [
              {
                sourceNode: "Trigger",
                sourceOutput: 0,
                destinationNode: "Result",
                destinationInput: 0,
              },
            ],
          },
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

  test("requires request assertions to check existence or equality", () => {
    expect(
      scenarioNodeRequestAssertionSchema.safeParse({
        node: "Request",
        pointer: "/body/state",
      }).success,
    ).toBe(false);
    expect(
      scenarioNodeRequestAssertionSchema.safeParse({
        node: "Request",
        pointer: "/body/state",
        exists: false,
      }).success,
    ).toBe(true);
  });

  test("rejects malformed edge assertions and invalid branch coverage", () => {
    const invalidEdge = scenarioEdgeAssertionSchema.safeParse({
      sourceNode: "Trigger",
      sourceOutput: -1,
      destinationNode: "Result",
      destinationInput: 0,
    });
    const invalidCoverage = scenarioManifestSchema.safeParse({
      version: 1,
      cases: [
        {
          name: "normal",
          assertions: { minimumBranchCoverage: 1.1 },
        },
      ],
    });

    expect(invalidEdge.success).toBe(false);
    expect(invalidCoverage.success).toBe(false);
  });

  test("validates output cardinality bounds and lineage contracts", () => {
    expect(
      scenarioNodeOutputCardinalityAssertionSchema.safeParse({
        node: "Result",
        min: 1,
        max: 2,
      }).success,
    ).toBe(true);
    expect(
      scenarioNodeOutputCardinalityAssertionSchema.safeParse({
        node: "Result",
        min: 2,
        max: 1,
      }).success,
    ).toBe(false);
    expect(
      scenarioNodeOutputCardinalityAssertionSchema.safeParse({
        node: "Result",
      }).success,
    ).toBe(false);
    expect(
      scenarioNodeOutputLineageAssertionSchema.safeParse({
        node: "Result",
        lineageContains: ["input:0"],
      }).success,
    ).toBe(true);
    expect(
      scenarioNodeOutputLineageAssertionSchema.safeParse({
        node: "Result",
      }).success,
    ).toBe(false);
  });

  test("accepts deterministic external-I/O faults and rejects ambiguous targets", () => {
    expect(
      scenarioFaultSchema.safeParse({
        node: "Request",
        kind: "http-error",
        statusCode: 503,
      }).success,
    ).toBe(true);
    expect(
      scenarioFaultSchema.safeParse({
        node: "Request",
        kind: "timeout",
        statusCode: 504,
      }).success,
    ).toBe(false);
    expect(
      scenarioManifestSchema.safeParse({
        version: 1,
        cases: [
          {
            name: "ambiguous",
            faults: [
              { node: "Request", kind: "timeout" },
              { node: "Request", kind: "malformed-json" },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
