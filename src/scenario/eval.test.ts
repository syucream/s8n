import { describe, expect, test } from "bun:test";
import { evaluateExecutionAgainstExpectations } from "./eval.ts";

describe("evaluateExecutionAgainstExpectations", () => {
  test("scores precision and recall over the agent's parsed output", () => {
    const runData = {
      Agent: [
        {
          data: {
            main: [
              [
                {
                  json: {
                    output: {
                      proposals: [
                        { proposalId: "p1", title: "Fix" },
                        { proposalId: "p2", title: "Extra" },
                        { proposalId: "p9", title: "Noise" },
                      ],
                    },
                  },
                },
              ],
            ],
          },
        },
      ],
    };
    const result = evaluateExecutionAgainstExpectations(runData, [
      {
        node: "Agent",
        pointer: "/output/proposals",
        key: "proposalId",
        expected: [
          { proposalId: "p1" },
          { proposalId: "p2" },
          { proposalId: "p3" },
        ],
      },
    ]);
    expect(result.cases[0]).toMatchObject({
      expectedCount: 3,
      actualCount: 3,
      matched: 2,
      precision: 2 / 3,
      recall: 2 / 3,
    });
    expect(result.aggregate).toMatchObject({
      caseCount: 1,
      precision: 2 / 3,
      recall: 2 / 3,
    });
  });

  test("missing or non-array output reports an error entry without throwing", () => {
    const result = evaluateExecutionAgainstExpectations({ Agent: [] }, [
      { node: "Agent", pointer: "/output/proposals", expected: [] },
    ]);
    expect(result.cases[0]?.error).toContain("no array");
    expect(result.cases[0]?.recall).toBe(0);
  });
});
