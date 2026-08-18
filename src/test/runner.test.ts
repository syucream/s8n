import { describe, expect, test } from "bun:test";
import { runTestSuite } from "./runner.ts";
import { defineSuite } from "./suite.ts";
import type { TestRunOutcome } from "./types.ts";

function approvalSuite() {
  return defineSuite(
    { workflow: "examples/approval.workflow.json" },
    (test) => {
      test("approved path", async (run, expect) => {
        const r = await run({
          input: { requestId: "r1", amount: 10 },
          mocks: { "Post to Slack": { ok: true } },
          resume: { "Wait for approval": { approved: true } },
        });
        expect(r).status("success");
        expect(r)
          .itemReaching("Post to Slack")
          .passedThrough("Wait for approval");
      });
      test("rejected path", async (run, expect) => {
        const r = await run({
          input: { requestId: "r2", amount: 10 },
          mocks: { "Post to Slack": { ok: true } },
          resume: { "Wait for approval": { approved: false } },
        });
        expect(r).never("Post to Slack");
      });
      test("failing assertion", async (run, expect) => {
        const r = await run({
          input: { requestId: "r3", amount: 10 },
          mocks: { "Post to Slack": { ok: true } },
          resume: { "Wait for approval": { approved: false } },
        });
        expect(r).status("error");
      });
    },
  );
}

describe("runTestSuite", () => {
  test("aggregates pass and fail across cases", async () => {
    const result = await runTestSuite({ suite: approvalSuite() });
    expect(result.summary.total).toBe(3);
    expect(result.summary.passed).toBe(2);
    expect(result.summary.failed).toBe(1);
    expect(result.cases.map((c) => c.passed)).toEqual([true, true, false]);
  });

  test("records failures with the matcher message", async () => {
    const result = await runTestSuite({ suite: approvalSuite() });
    const failed = result.cases.find((c) => !c.passed);
    expect(failed?.name).toBe("failing assertion");
    expect(failed?.failures).toHaveLength(1);
    expect(failed?.failures[0]).toMatch(
      /Expected workflow status error, got success/,
    );
  });

  test("records the last run status and pending mocks", async () => {
    const suite = defineSuite(
      { workflow: "examples/approval.workflow.json" },
      (test) => {
        test("needs mock", async (run) => {
          await run({
            input: { requestId: "r", amount: 10 },
            resume: { "Wait for approval": { approved: true } },
          });
        });
      },
    );
    const result = await runTestSuite({ suite });
    expect(result.cases[0]?.runStatus).toBe("needs_mock");
    expect(result.cases[0]?.pendingMocks).toContain("Post to Slack");
    // A run that pauses for a mock is still a pass unless an assertion fails;
    // an author can also assert `status("needs_mock")` to pin that behavior.
    expect(result.cases[0]?.passed).toBe(true);
  });

  test("supports selecting cases by name", async () => {
    const result = await runTestSuite({
      suite: approvalSuite(),
      selectedCases: ["approved path"],
    });
    expect(result.summary.total).toBe(1);
    expect(result.summary.passed).toBe(1);
  });

  test("failFast stops after the first failure", async () => {
    const order: string[] = [];
    const suite = defineSuite(
      { workflow: "examples/hello-world.workflow.json" },
      (test) => {
        test("first", async () => {
          order.push("first");
          throw new Error("boom");
        });
        test("second", async () => {
          order.push("second");
        });
      },
    );
    const result = await runTestSuite({ suite, failFast: true });
    expect(result.summary.total).toBe(1);
    expect(order).toEqual(["first"]);
  });

  test("captures console output instead of letting it leak", async () => {
    const suite = defineSuite(
      { workflow: "examples/hello-world.workflow.json" },
      (test) => {
        test("noisy", async () => {
          console.log("test-noise", { x: 1 });
        });
      },
    );
    const originalWrite = process.stdout.write;
    const result = await runTestSuite({ suite });
    expect(result.cases[0]?.consoleOutput).toEqual(['test-noise {"x":1}']);
    // stdout still works after the run.
    expect(process.stdout.write).toBe(originalWrite);
  });

  test("reports workflow load failures as errors", async () => {
    const suite = defineSuite({ workflow: "missing.workflow.json" }, (test) => {
      test("cannot load", async (run, expect) => {
        const r: TestRunOutcome = await run({});
        expect(r).status("success");
      });
    });
    const result = await runTestSuite({ suite });
    expect(result.cases[0]?.passed).toBe(false);
    expect(result.cases[0]?.errors.join(" ")).toMatch(/missing.workflow.json/);
    expect(result.cases[0]?.failures[0]).toMatch(/Workflow failed to run/);
  });

  test("selected cases that do not exist are silently filtered", async () => {
    const suite = defineSuite(
      { workflow: "examples/hello-world.workflow.json" },
      (test) => {
        test("ok", async () => {});
      },
    );
    const result = await runTestSuite({
      suite,
      selectedCases: ["missing"],
    });
    expect(result.summary.total).toBe(0);
    expect(result.summary.passed).toBe(0);
  });
});
