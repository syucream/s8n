import { describe, expect, test } from "bun:test";
import type { RunResult } from "../engine/execute.ts";
import { applyVariantIteration, extractVariantSets } from "./mock-variants.ts";
import { computeRepeatVariance } from "./repeat-variance.ts";

describe("mock variants", () => {
  test("extracts per-node variant arrays", () => {
    expect(
      extractVariantSets({
        $variants: {
          Agent: [{ text: "a" }, { text: "b" }],
          Empty: [],
          NotArray: "x",
        },
        Agent: "unused",
      }),
    ).toEqual({ Agent: [{ text: "a" }, { text: "b" }] });
  });

  test("cycles variants per iteration and leaves plain mocks untouched", () => {
    const base = {
      $variants: { Agent: [{ text: "a" }, { text: "b" }] },
      Fetch: { rows: [] },
    };
    expect(applyVariantIteration(base, 0)).toEqual({
      Agent: { text: "a" },
      Fetch: { rows: [] },
    });
    expect(applyVariantIteration(base, 1)).toEqual({
      Agent: { text: "b" },
      Fetch: { rows: [] },
    });
    expect(applyVariantIteration(base, 2)).toEqual({
      Agent: { text: "a" },
      Fetch: { rows: [] },
    });
  });

  test("returns the mock unchanged when no variants are declared", () => {
    const base = { Agent: { text: "a" } };
    expect(applyVariantIteration(base, 3)).toBe(base);
  });
});

describe("computeRepeatVariance", () => {
  function run(nodeOutputs: Record<string, unknown[]>): RunResult {
    return {
      status: "success",
      workflowName: "test",
      trace: [],
      nodeOutputs: nodeOutputs as RunResult["nodeOutputs"],
      pendingMocks: [],
      errors: [],
      effects: [],
      subExecutions: [],
      edgeCoverage: [],
      branchCoverage: 1,
    };
  }

  test("identical runs report a deterministic single shape", () => {
    const variance = computeRepeatVariance([
      run({ Agent: [{ json: { text: "a" } }] }),
      run({ Agent: [{ json: { text: "a" } }] }),
    ]);
    expect(variance.deterministic).toBe(true);
    expect(variance.distinctCount).toBe(1);
    expect(variance.cardinality).toEqual({ Agent: [1] });
  });

  test("divergent runs report item-count spread and multiple shapes", () => {
    const variance = computeRepeatVariance([
      run({ Agent: [{ json: { text: "a" } }, { json: { text: "b" } }] }),
      run({ Agent: [{ json: { text: "a" } }] }),
    ]);
    expect(variance.deterministic).toBe(false);
    expect(variance.distinctCount).toBe(2);
    expect(variance.cardinality).toEqual({ Agent: [1, 2] });
    expect(variance.outputHashes).toHaveLength(2);
  });
});
