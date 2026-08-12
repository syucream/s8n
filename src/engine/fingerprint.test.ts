import { describe, expect, test } from "bun:test";
import type { RunResult } from "./execute.ts";
import { stableRunFingerprint } from "./fingerprint.ts";

function result(overrides: Partial<RunResult> = {}): RunResult {
  return {
    status: "success",
    workflowName: "demo",
    trace: [
      {
        nodeName: "Set",
        nodeType: "n8n-nodes-base.set",
        status: "success",
        inputItemCounts: [1],
        outputItemCounts: [1],
        startTime: 100,
        executionTime: 2,
        executionIndex: 0,
        data: { main: [[{ json: { value: 1 } }]] },
      },
    ],
    nodeOutputs: { Set: [{ json: { value: 1 } }] },
    pendingMocks: [],
    errors: [],
    effects: [],
    subExecutions: [],
    edgeCoverage: [],
    branchCoverage: 1,
    ...overrides,
  };
}

describe("stableRunFingerprint", () => {
  test("ignores wall-clock execution metadata", () => {
    const first = result();
    const firstTrace = first.trace[0];
    if (firstTrace === undefined) throw new Error("fixture trace is empty");
    const second = result({
      trace: [
        {
          ...firstTrace,
          startTime: 999,
          executionTime: 40,
          executionIndex: 8,
        },
      ],
    });

    expect(stableRunFingerprint(first)).toBe(stableRunFingerprint(second));
  });

  test("changes when observed workflow evidence changes", () => {
    expect(stableRunFingerprint(result())).not.toBe(
      stableRunFingerprint(
        result({ nodeOutputs: { Set: [{ json: { value: 2 } }] } }),
      ),
    );
  });

  test("returns a digest instead of embedding execution data", () => {
    const fingerprint = stableRunFingerprint(
      result({ nodeOutputs: { Set: [{ json: { secret: "private-value" } }] } }),
    );

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain("private-value");
  });
});
