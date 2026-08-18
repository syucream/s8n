import { defineSuite } from "s8n";

// A test file can import the DSL from the s8n package, or rely on the globals
// injected by `s8n test` (write the file without any import). The imported
// form is recommended: it type-checks standalone and works under any runner.
//
// Run with:
//   bun run src/cli/index.ts test examples/hello-world.test.ts

export default defineSuite(
  {
    workflow: "./hello-world.workflow.json",
  },
  (test) => {
    test("greets the world by default", async (run, expect) => {
      const r = await run({});
      expect(r).status("success");
      expect(r).outputOf("Set").count(1);
      expect(r)
        .outputOf("Set")
        .item(0)
        .pointer("/json/message")
        .equals("Hello, world!");
    });

    test("greets a named visitor", async (run, expect) => {
      const r = await run({ input: { name: "Ada" } });
      expect(r).status("success");
      expect(r)
        .outputOf("Set")
        .item(0)
        .pointer("/json/message")
        .equals("Hello, Ada!");
    });
  },
);
