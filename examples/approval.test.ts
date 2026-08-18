import { defineSuite } from "s8n";

// Sample workflow test suite for examples/approval.workflow.json.
//
// The workflow routes a request through a human-approval gate (a Wait node)
// before posting to Slack, so the interesting invariants are cross-node:
// "nothing reaches Slack unless an approval decision happened first".
//
// Run with:
//   bun run src/cli/index.ts test examples/approval.test.ts

export default defineSuite(
  {
    workflow: "./approval.workflow.json",
    now: "2026-01-01T00:00:00.000Z",
  },
  (test) => {
    test("approved request is posted to slack after human approval", async (run, expect) => {
      const r = await run({
        input: { requestId: "req-7", amount: 120 },
        mocks: { "Post to Slack": { ok: true } },
        resume: { "Wait for approval": { approved: true } },
      });

      expect(r).status("success");
      expect(r).ran("Wait for approval").before("Post to Slack");
      expect(r)
        .itemReaching("Post to Slack")
        .passedThrough("Wait for approval");
      expect(r).allPathsTo("Post to Slack").passThrough("Wait for approval");
      expect(r).outputOf("Post to Slack").count(1);

      // The full engine result is exposed, so any assertion is expressible.
      if (r.ok) {
        const request = r.result.trace.find(
          (entry) => entry.nodeName === "Post to Slack",
        )?.resolvedRequests?.[0];
        const url = request?.url;
        if (typeof url !== "string" || !url.includes("hooks.slack.com")) {
          throw new Error(`Unexpected slack webhook target: ${typeof url}`);
        }
      }
    });

    test("rejected request never reaches slack and is logged", async (run, expect) => {
      const r = await run({
        input: { requestId: "req-8", amount: 30 },
        mocks: { "Post to Slack": { ok: true } },
        resume: { "Wait for approval": { approved: false } },
      });

      expect(r).status("success");
      expect(r).never("Post to Slack");
      expect(r).outputOf("Log Rejection").count(1);
      expect(r)
        .outputOf("Log Rejection")
        .item(0)
        .pointer("/json/status")
        .equals("rejected");
    });

    test("a missing approval decision pauses the workflow", async (run, expect) => {
      const r = await run({
        input: { requestId: "req-9", amount: 50 },
        mocks: {},
      });

      expect(r).status("waiting");
      expect(r).never("Post to Slack");
    });

    test("an approval timeout falls through to the rejection path", async (run, expect) => {
      const r = await run({
        input: { requestId: "req-10", amount: 50 },
        mocks: { "Post to Slack": { ok: true } },
        resume: { "Wait for approval": "timeout" },
      });

      expect(r).status("success");
      expect(r).never("Post to Slack");
      expect(r).ran("Check Approved").before("Log Rejection");
    });
  },
);
