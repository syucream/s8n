import { defineSuite } from "s8n";

// Sample workflow test suite for examples/rehearsal.workflow.json, which
// routes an amount to a "high" or "standard" tier branch. Demonstrates
// branch assertions, conditional (plain-TS) invariants, and matcher chains.
//
// Run with:
//   bun run src/cli/index.ts test examples/rehearsal.test.ts

export default defineSuite(
  {
    workflow: "./rehearsal.workflow.json",
  },
  (test) => {
    test("high amounts route to the high tier", async (run, expect) => {
      const r = await run({ input: { amount: 150 } });
      expect(r).status("success");
      expect(r).ran("High Tier");
      expect(r).never("Standard Tier");
      expect(r)
        .outputOf("High Tier")
        .item(0)
        .pointer("/json/tier")
        .equals("high");

      // Plain TypeScript is enough for conditional invariants.
      if (r.ok) {
        const tier = r.result.nodeOutputs["High Tier"]?.[0]?.json.tier;
        if (tier !== "high") {
          throw new Error(`Unexpected tier value type: ${typeof tier}`);
        }
      }
    });

    test("standard amounts skip the high tier", async (run, expect) => {
      const r = await run({ input: { amount: 30 } });
      expect(r).status("success");
      expect(r).never("High Tier");
      expect(r).ran("Standard Tier");
      expect(r)
        .outputOf("Standard Tier")
        .item(0)
        .pointer("/json/tier")
        .equals("standard");
    });

    test("the tier decision always precedes the branch output", async (run, expect) => {
      const r = await run({ input: { amount: 150 } });
      expect(r).status("success");
      expect(r).ran("Choose Tier").before("High Tier");
      expect(r).itemReaching("High Tier").passedThrough("Choose Tier");
      expect(r).allPathsTo("High Tier").passThrough("Choose Tier");
    });
  },
);
