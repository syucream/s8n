import { describe, expect, test } from "bun:test";
import { defineSuite } from "./suite.ts";

describe("defineSuite", () => {
  test("registers cases through the test callback", () => {
    const suite = defineSuite({ workflow: "wf.json" }, (test) => {
      test("one", async () => {});
      test("two", async () => {});
    });
    expect(suite.config.workflow).toBe("wf.json");
    expect(suite.cases.map((c) => c.name)).toEqual(["one", "two"]);
  });

  test("rejects empty case names", () => {
    expect(() =>
      defineSuite({ workflow: "wf.json" }, (test) => {
        test("", async () => {});
      }),
    ).toThrow(/must not be empty/);
  });

  test("rejects duplicate case names", () => {
    expect(() =>
      defineSuite({ workflow: "wf.json" }, (test) => {
        test("same", async () => {});
        test("same", async () => {});
      }),
    ).toThrow(/Duplicate test case name/);
  });

  test("is pure registration: nothing executes at definition time", () => {
    let executed = false;
    defineSuite({ workflow: "wf.json" }, (test) => {
      test("lazy", async () => {
        executed = true;
      });
    });
    expect(executed).toBe(false);
  });
});
