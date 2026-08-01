import { describe, expect, test } from "bun:test";
import { buildExpressionScope } from "./context.ts";

const baseOptions = {
  currentItem: { json: {} },
  itemIndex: 0,
  inputItems: [{ json: {} }],
  currentNodeName: "Node",
  workflowName: "wf",
  nodeOutputs: new Map(),
};

describe("buildExpressionScope timezone handling", () => {
  test("$now uses the local system zone when the workflow sets no timezone", () => {
    const scope = buildExpressionScope({
      ...baseOptions,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(scope.$now.zoneName).not.toBe("Asia/Tokyo");
  });

  test("$now/$today resolve in workflow.settings.timezone, matching real n8n's WorkflowDataProxy", () => {
    const scope = buildExpressionScope({
      ...baseOptions,
      now: new Date("2026-01-01T00:00:00.000Z"), // 09:00 JST
      timezone: "Asia/Tokyo",
    });
    expect(scope.$now.zoneName).toBe("Asia/Tokyo");
    expect(scope.$now.hour).toBe(9);
    expect(scope.$today.zoneName).toBe("Asia/Tokyo");
    expect(scope.$today.hour).toBe(0);
  });

  test("$now honors the configured timezone even without an injected clock", () => {
    const scope = buildExpressionScope({
      ...baseOptions,
      timezone: "Asia/Tokyo",
    });
    expect(scope.$now.zoneName).toBe("Asia/Tokyo");
  });
});
