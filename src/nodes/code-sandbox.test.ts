import { describe, expect, test } from "bun:test";
import { type OsCodeRequest, runCodeWorkerForTesting } from "./code-sandbox.ts";

function request(code: string): OsCodeRequest {
  return {
    code,
    mode: "runOnceForAllItems",
    items: [{ json: { input: true } }],
    itemIndex: 0,
    nodeName: "Code",
    scope: {
      json: { input: true },
      workflow: { name: "sandbox-test" },
      now: "2026-08-12T00:00:00.000+00:00",
      timezone: "Asia/Tokyo",
    },
    nodeOutputs: { Branch: [{ json: { selected: true } }] },
    legacyNodeOutputs: { Branch: [{ json: { selected: false } }] },
    staticData: {},
    dateNow: "2026-08-12T00:00:00.000Z",
  };
}

describe("OS Code worker protocol", () => {
  test("keeps console output off the JSON response and preserves branch-aware access", async () => {
    const response = await runCodeWorkerForTesting(
      request(
        'console.log("diagnostic"); return [{ json: { selected: $("Branch").first().json.selected, zone: $now.zoneName } }];',
      ),
    );

    expect(response.result).toEqual([
      { json: { selected: true, zone: "Asia/Tokyo" } },
    ]);
  });

  test("reports an unknown node reference as a Code error", async () => {
    expect(
      runCodeWorkerForTesting(request('return $("Missing").all();')),
    ).rejects.toThrow("No output found for referenced node");
  });

  test("does not inherit arbitrary parent environment variables", async () => {
    process.env.S8N_SANDBOX_TEST_SECRET = "must-not-cross-boundary";
    try {
      const response = await runCodeWorkerForTesting(
        request(
          'const hostProcess = ({}).constructor.constructor("return process")(); return [{ json: { leaked: hostProcess.env.S8N_SANDBOX_TEST_SECRET } }];',
        ),
      );
      expect(response.result).toEqual([{ json: {} }]);
    } finally {
      delete process.env.S8N_SANDBOX_TEST_SECRET;
    }
  });
});
