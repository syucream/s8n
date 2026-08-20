import { describe, expect, test } from "bun:test";
import type { RunResult } from "../engine/execute.ts";
import { createMockLookup } from "../mock/provider.ts";
import type { Workflow } from "../schema/workflow.ts";
import { BodyParseError, buildFormItems, buildWebhookItems } from "./body.ts";
import {
  buildFormResponse,
  buildWebhookResponse,
  renderFormPage,
} from "./responses.ts";
import { buildRoutes, matchRoute } from "./routes.ts";
import { createServeServer, type ServeHandle } from "./serve.ts";
import type { RequestEnvelope } from "./types.ts";

function node(
  name: string,
  type: string,
  parameters: Record<string, unknown>,
): Workflow["nodes"][number] {
  return {
    id: name,
    name,
    type,
    typeVersion: 2,
    position: [0, 0],
    parameters,
    disabled: false,
    continueOnFail: false,
    retryOnFail: false,
    maxTries: 1,
    alwaysOutputData: false,
    executeOnce: false,
  };
}

function webhookWorkflow(
  parameters: Record<string, unknown>,
  tail: Array<Workflow["nodes"][number]> = [],
): Workflow {
  const trigger = node("Webhook", "n8n-nodes-base.webhook", {
    httpMethod: "POST",
    ...parameters,
  });
  const setReply = node("Set reply", "n8n-nodes-base.set", {
    assignments: {
      assignments: [
        { name: "reply", value: "={{ $json.body.message }}", type: "string" },
      ],
    },
  });
  const nodes = [trigger, setReply, ...tail];
  return {
    name: "webhook-echo",
    nodes,
    connections: {
      Webhook: { main: [[{ node: "Set reply", type: "main", index: 0 }]] },
    },
    settings: {},
  };
}

const envelope: RequestEnvelope = {
  method: "POST",
  headers: { "content-type": "application/json" },
  query: {},
  params: {},
};

function makeServer(workflow: Workflow): Promise<ServeHandle> {
  return createServeServer({
    host: "127.0.0.1",
    port: 0,
    workflowFile: "test-workflow.json",
    workflow,
    routes: buildRoutes(workflow),
    mocks: createMockLookup({}),
    resumeProvider: undefined,
  });
}

async function waitForExecution(
  baseUrl: string,
  id: string,
  attempts = 100,
): Promise<{ status: string; result?: unknown }> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetch(`${baseUrl}/executions/${id}`);
    const body = (await response.json()) as {
      status: string;
      result?: unknown;
    };
    if (body.status === "done") return body;
    await Bun.sleep(10);
  }
  throw new Error(`Execution ${id} did not finish in time`);
}

describe("buildRoutes", () => {
  test("webhook path and method from parameters", () => {
    const routes = buildRoutes(
      webhookWorkflow({ path: "echo", responseMode: "lastNode" }),
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      kind: "webhook",
      prefix: "/webhook",
      urlPath: "echo",
      triggerNode: "Webhook",
    });
    expect(routes[0]?.methods).toEqual(["POST"]);
  });

  test("webhook falls back to webhookId when path is empty", () => {
    const routes = buildRoutes(webhookWorkflow({ webhookId: "abc-123" }));
    expect(routes[0]?.urlPath).toBe("abc-123");
  });

  test("webhook supports multiple methods and dynamic segments", () => {
    const workflow = webhookWorkflow({
      multipleMethods: true,
      httpMethod: ["GET", "POST"],
      path: "orders/:orderId",
    });
    const routes = buildRoutes(workflow);
    expect(routes[0]?.methods).toEqual(["GET", "POST"]);
    expect(routes[0]?.paramNames).toEqual(["orderId"]);

    const match = matchRoute(routes, "POST", "/webhook/orders/42");
    expect(match?.route.triggerNode).toBe("Webhook");
    expect(match?.params).toEqual({ orderId: "42" });

    const mismatch = matchRoute(routes, "DELETE", "/webhook/orders/42");
    expect(mismatch).toBeUndefined();
  });

  test("form trigger exposes GET (page) and POST (submit)", () => {
    const workflow: Workflow = {
      name: "form",
      nodes: [
        node("On form submission", "n8n-nodes-base.formTrigger", {
          formTitle: "Contact us",
          path: "contact",
        }),
        node("Save", "n8n-nodes-base.noOp", {}),
      ],
      connections: {
        "On form submission": {
          main: [[{ node: "Save", type: "main", index: 0 }]],
        },
      },
      settings: {},
    };
    const routes = buildRoutes(workflow);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      kind: "form",
      prefix: "/form",
      urlPath: "contact",
    });
    expect(routes[0]?.methods).toEqual(["GET", "POST"]);
  });
});

describe("body parsing", () => {
  test("webhook JSON body is wrapped in headers/params/query/body", () => {
    const items = buildWebhookItems(
      envelope,
      '{"message":"hi"}',
      "application/json",
      "http://localhost:5678/webhook/echo",
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.json).toMatchObject({
      headers: { "content-type": "application/json" },
      params: {},
      query: {},
      body: { message: "hi" },
      webhookUrl: "http://localhost:5678/webhook/echo",
      executionMode: "production",
    });
  });

  test("GET-style empty body yields an empty body object", () => {
    const items = buildWebhookItems(
      { ...envelope, method: "GET", query: { q: "1" } },
      "",
      undefined,
      "http://localhost:5678/webhook/echo",
    );
    expect(items[0]?.json).toMatchObject({ query: { q: "1" }, body: {} });
  });

  test("JSON array body is a single item with the array under body", () => {
    const items = buildWebhookItems(
      envelope,
      '[{"a":1},{"a":2}]',
      "application/json",
      "http://localhost:5678/webhook/echo",
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.json.body).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("scalar body is kept under body", () => {
    const items = buildWebhookItems(
      envelope,
      "42",
      "application/json",
      "http://localhost:5678/webhook/echo",
    );
    expect(items[0]?.json.body).toBe(42);
  });

  test("multipart is rejected with 415", () => {
    expect(() =>
      buildWebhookItems(
        envelope,
        "x=1",
        "multipart/form-data; boundary=abc",
        "http://localhost:5678/webhook/echo",
      ),
    ).toThrow(BodyParseError);
  });

  test("invalid JSON with application/json is rejected with 400", () => {
    try {
      buildWebhookItems(envelope, "not-json", "application/json", "");
      expect.unreachable();
    } catch (cause) {
      expect(cause).toBeInstanceOf(BodyParseError);
      expect((cause as BodyParseError).status).toBe(400);
    }
  });

  test("form submission maps field-N keys to declared field names", () => {
    const workflow: Workflow = {
      name: "form",
      nodes: [
        node("On form submission", "n8n-nodes-base.formTrigger", {
          formFields: {
            values: [
              { fieldLabel: "Name", fieldType: "text" },
              { fieldLabel: "Age", fieldType: "number" },
            ],
          },
        }),
      ],
      connections: {},
      settings: {},
    };
    const items = buildFormItems(
      workflow.nodes[0] as NonNullable<(typeof workflow.nodes)[0]>,
      { ...envelope, method: "POST" },
      "field-0=Alice&field-1=30",
      "application/x-www-form-urlencoded",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.json).toMatchObject({
      Name: "Alice",
      Age: 30,
      formMode: "production",
    });
    expect(items[0]?.json.submittedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("response building", () => {
  const trigger = node("Webhook", "n8n-nodes-base.webhook", {
    httpMethod: "POST",
    responseMode: "lastNode",
  });
  const workflow = webhookWorkflow({ path: "echo" });
  const result: RunResult = {
    status: "success",
    workflowName: "webhook-echo",
    trace: [],
    nodeOutputs: {
      "Set reply": [{ json: { reply: "hi" }, pairedItem: { item: 0 } }],
    },
    pendingMocks: [],
    errors: [],
    effects: [],
    subExecutions: [],
    edgeCoverage: [],
    branchCoverage: 1,
  };

  test("lastNode firstEntryJson returns the terminal item json", () => {
    const respond = buildWebhookResponse(workflow, result, trigger);
    expect(respond.status).toBe(200);
    expect(respond.contentType).toBe("application/json");
    expect(JSON.parse(respond.body ?? "")).toEqual({ reply: "hi" });
  });

  test("lastNode allEntries returns an array", () => {
    const allTrigger = node("Webhook", "n8n-nodes-base.webhook", {
      httpMethod: "POST",
      responseMode: "lastNode",
      responseData: "allEntries",
    });
    const respond = buildWebhookResponse(workflow, result, allTrigger);
    expect(JSON.parse(respond.body ?? "")).toEqual([{ reply: "hi" }]);
  });

  test("onReceived default returns an empty body", () => {
    const onReceived = node("Webhook", "n8n-nodes-base.webhook", {
      httpMethod: "POST",
    });
    const respond = buildWebhookResponse(workflow, result, onReceived);
    expect(respond.status).toBe(200);
    expect(respond.body).toBeNull();
  });

  test("responseNode uses the Respond to Webhook output", () => {
    const respondNode = node("Respond", "n8n-nodes-base.respondToWebhook", {
      respondWith: "firstIncomingItem",
    });
    const responseWorkflow: Workflow = {
      ...workflow,
      nodes: [
        trigger,
        respondNode,
        node("Set reply", "n8n-nodes-base.set", {
          assignments: { assignments: [{ name: "reply", value: "hi" }] },
        }),
      ],
    };
    const responseResult: RunResult = {
      ...result,
      nodeOutputs: {
        Respond: [{ json: { ok: true }, pairedItem: { item: 0 } }],
        "Set reply": [{ json: { reply: "hi" } }],
      },
    };
    const respond = buildWebhookResponse(
      responseWorkflow,
      responseResult,
      node("Webhook", "n8n-nodes-base.webhook", {
        httpMethod: "POST",
        responseMode: "responseNode",
      }),
    );
    expect(respond.status).toBe(200);
    expect(JSON.parse(respond.body ?? "")).toEqual({ ok: true });
  });

  test("form response is an empty 200", () => {
    expect(buildFormResponse()).toEqual({ status: 200, body: null });
  });

  test("renderFormPage includes the form title and fields", () => {
    const formNode = node("On form submission", "n8n-nodes-base.formTrigger", {
      formTitle: "Contact us",
      formDescription: "Tell us about yourself",
      formFields: {
        values: [{ fieldLabel: "Name", fieldType: "text" }],
      },
      options: { buttonLabel: "Send" },
    });
    const html = renderFormPage(formNode, "/form/contact");
    expect(html).toContain("Contact us");
    expect(html).toContain("Tell us about yourself");
    expect(html).toContain('action="/form/contact"');
    expect(html).toContain(">Send</button>");
    expect(html).toContain('name="field-0"');
  });
});

describe("serve server (HTTP)", () => {
  test("webhook POST returns the terminal output (lastNode)", async () => {
    const handle = await makeServer(
      webhookWorkflow({ path: "echo", responseMode: "lastNode" }),
    );
    try {
      const base = `http://${handle.host}:${handle.port}`;
      const response = await fetch(`${base}/webhook/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-s8n-execution-id")).toBeTruthy();
      expect(await response.json()).toEqual({ reply: "hello" });
    } finally {
      await handle.stop();
    }
  });

  test("onReceived webhook returns an empty 200", async () => {
    const handle = await makeServer(
      webhookWorkflow({ path: "ping", responseMode: "onReceived" }),
    );
    try {
      const response = await fetch(
        `http://${handle.host}:${handle.port}/webhook/ping`,
        {
          method: "POST",
          body: JSON.stringify({ ping: true }),
          headers: { "content-type": "application/json" },
        },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
    } finally {
      await handle.stop();
    }
  });

  test("unknown routes return 404 and multipart returns 415", async () => {
    const handle = await makeServer(webhookWorkflow({ path: "echo" }));
    try {
      const base = `http://${handle.host}:${handle.port}`;
      const missing = await fetch(`${base}/webhook/nope`, { method: "POST" });
      expect(missing.status).toBe(404);

      const multipart = await fetch(`${base}/webhook/echo`, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=x" },
        body: "--x\r\n\r\n--x--",
      });
      expect(multipart.status).toBe(415);

      const badJson = await fetch(`${base}/webhook/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });
      expect(badJson.status).toBe(400);
    } finally {
      await handle.stop();
    }
  });

  test("route listing and execution inspection endpoints work", async () => {
    const handle = await makeServer(
      webhookWorkflow({ path: "echo", responseMode: "lastNode" }),
    );
    try {
      const base = `http://${handle.host}:${handle.port}`;
      const root = await fetch(`${base}/`);
      const rootBody = (await root.json()) as {
        routes: Array<{
          kind: string;
          method: string[];
          path: string;
          trigger: string;
        }>;
      };
      expect(rootBody.routes).toEqual([
        {
          kind: "webhook",
          method: ["POST"],
          path: "/webhook/echo",
          trigger: "Webhook",
        },
      ]);

      const exec = await fetch(`${base}/webhook/echo`, {
        method: "POST",
        body: JSON.stringify({ message: "x" }),
        headers: { "content-type": "application/json" },
      });
      const execId = exec.headers.get("x-s8n-execution-id") as string;
      const listing = (await (await fetch(`${base}/executions`)).json()) as {
        executions: Array<{ id: string; status: string }>;
      };
      expect(listing.executions.map((entry) => entry.id)).toContain(execId);

      const detail = await waitForExecution(base, execId);
      expect(detail.status).toBe("done");
      const detailResult = detail.result as {
        nodeOutputs: Record<string, unknown[]>;
      };
      expect(detailResult.nodeOutputs["Set reply"]?.[0]).toMatchObject({
        json: { reply: "x" },
      });
    } finally {
      await handle.stop();
    }
  });

  test("form page renders and submission runs the workflow", async () => {
    const workflow: Workflow = {
      name: "contact",
      nodes: [
        node("On form submission", "n8n-nodes-base.formTrigger", {
          formTitle: "Contact us",
          path: "contact",
          formFields: {
            values: [{ fieldLabel: "Message", fieldType: "text" }],
          },
        }),
        node("Capture", "n8n-nodes-base.noOp", {}),
      ],
      connections: {
        "On form submission": {
          main: [[{ node: "Capture", type: "main", index: 0 }]],
        },
      },
      settings: {},
    };
    const handle = await makeServer(workflow);
    try {
      const base = `http://${handle.host}:${handle.port}`;
      const page = await fetch(`${base}/form/contact`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain("Contact us");

      const submit = await fetch(`${base}/form/contact`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "field-0=hello world",
      });
      expect(submit.status).toBe(200);
      const execId = submit.headers.get("x-s8n-execution-id") as string;
      const detail = await waitForExecution(base, execId);
      expect(detail.status).toBe("done");
      const result = detail.result as {
        nodeOutputs: Record<string, Array<{ json: Record<string, unknown> }>>;
      };
      const captureOutput = result.nodeOutputs.Capture?.[0]?.json;
      expect(captureOutput).toMatchObject({
        Message: "hello world",
        formMode: "production",
      });
      expect(typeof captureOutput?.submittedAt).toBe("string");
    } finally {
      await handle.stop();
    }
  });

  test("wait-on-webhook resume suspends, resumes, and completes", async () => {
    const workflow: Workflow = {
      name: "approval",
      nodes: [
        node("Webhook", "n8n-nodes-base.webhook", {
          httpMethod: "POST",
          path: "approve",
          responseMode: "lastNode",
        }),
        node("Wait for approval", "n8n-nodes-base.wait", {
          resume: "onWebhookCall",
        }),
        node("Set result", "n8n-nodes-base.set", {
          assignments: {
            assignments: [
              {
                name: "approved",
                value: "={{ $json.approved }}",
                type: "boolean",
              },
            ],
          },
        }),
      ],
      connections: {
        Webhook: {
          main: [[{ node: "Wait for approval", type: "main", index: 0 }]],
        },
        "Wait for approval": {
          main: [[{ node: "Set result", type: "main", index: 0 }]],
        },
      },
      settings: {},
    };
    const handle = await makeServer(workflow);
    try {
      const base = `http://${handle.host}:${handle.port}`;
      const start = await fetch(`${base}/webhook/approve`, {
        method: "POST",
        body: JSON.stringify({ requestId: "r-1" }),
        headers: { "content-type": "application/json" },
      });
      expect(start.status).toBe(202);
      const startBody = (await start.json()) as {
        executionId: string;
        resumePath: string;
        status: string;
      };
      expect(startBody.status).toBe("waiting");
      expect(startBody.resumePath).toBe(
        `/webhook-waiting/${startBody.executionId}`,
      );

      const detail = await fetch(`${base}/executions/${startBody.executionId}`);
      const pending = (await detail.json()) as {
        status: string;
        waitingOn: string;
      };
      expect(pending.status).toBe("waiting");
      expect(pending.waitingOn).toBe("Wait for approval");

      // The resume endpoint only accepts POST.
      const wrongMethod = await fetch(`${base}${startBody.resumePath}`, {
        method: "GET",
      });
      expect(wrongMethod.status).toBe(404);

      const resume = await fetch(`${base}${startBody.resumePath}`, {
        method: "POST",
        body: JSON.stringify({ approved: true }),
        headers: { "content-type": "application/json" },
      });
      expect(resume.status).toBe(200);

      const finished = await waitForExecution(base, startBody.executionId);
      const result = finished.result as {
        nodeOutputs: Record<string, Array<{ json: Record<string, unknown> }>>;
      };
      expect(result.nodeOutputs["Set result"]?.[0]?.json).toEqual({
        approved: true,
      });
    } finally {
      await handle.stop();
    }
  });

  test("concurrent webhook requests stay isolated", async () => {
    const handle = await makeServer(
      webhookWorkflow({ path: "echo", responseMode: "lastNode" }),
    );
    try {
      const base = `http://${handle.host}:${handle.port}`;
      const responses = await Promise.all(
        ["alpha", "beta", "gamma"].map((message) =>
          fetch(`${base}/webhook/echo`, {
            method: "POST",
            body: JSON.stringify({ message }),
            headers: { "content-type": "application/json" },
          }).then(async (response) => response.json()),
        ),
      );
      expect(responses).toEqual([
        { reply: "alpha" },
        { reply: "beta" },
        { reply: "gamma" },
      ]);
    } finally {
      await handle.stop();
    }
  });

  test("emulator state persists across a Wait resume", async () => {
    // Writes to the Slack emulator before the Wait, then the workflow resumes
    // and completes. The run's final result still carries the pre-Wait write
    // effect with its independent verified read-back - proving the per-
    // execution emulator runner is kept alive across the suspension (not
    // torn down and rebuilt, which would drop the earlier write).
    const workflow: Workflow = {
      name: "approval-with-slack",
      nodes: [
        node("Webhook", "n8n-nodes-base.webhook", {
          httpMethod: "POST",
          path: "approve",
          responseMode: "lastNode",
        }),
        node("Post to Slack", "n8n-nodes-base.slack", {
          resource: "message",
          operation: "post",
          channel: "#general",
          text: "={{ $json.body.requestId }}",
        }),
        node("Wait for approval", "n8n-nodes-base.wait", {
          resume: "onWebhookCall",
        }),
        node("Set result", "n8n-nodes-base.set", {
          assignments: {
            assignments: [{ name: "approved", value: "={{ $json.approved }}" }],
          },
        }),
      ],
      connections: {
        Webhook: {
          main: [[{ node: "Post to Slack", type: "main", index: 0 }]],
        },
        "Post to Slack": {
          main: [[{ node: "Wait for approval", type: "main", index: 0 }]],
        },
        "Wait for approval": {
          main: [[{ node: "Set result", type: "main", index: 0 }]],
        },
      },
      settings: {},
    };
    const handle = await createServeServer({
      host: "127.0.0.1",
      port: 0,
      workflowFile: "test-workflow.json",
      workflow,
      routes: buildRoutes(workflow),
      mocks: createMockLookup({}),
      emulate: ["slack"],
      resumeProvider: undefined,
    });
    try {
      const base = `http://${handle.host}:${handle.port}`;
      const start = await fetch(`${base}/webhook/approve`, {
        method: "POST",
        body: JSON.stringify({ requestId: "r-99" }),
        headers: { "content-type": "application/json" },
      });
      expect(start.status).toBe(202);
      const startBody = (await start.json()) as {
        executionId: string;
        resumePath: string;
      };
      const resume = await fetch(`${base}${startBody.resumePath}`, {
        method: "POST",
        body: JSON.stringify({ approved: true }),
        headers: { "content-type": "application/json" },
      });
      expect(resume.status).toBe(200);

      const finished = await waitForExecution(base, startBody.executionId);
      const result = finished.result as {
        effects: Array<{
          service: string;
          operation: string;
          verified: boolean;
        }>;
      };
      // The pre-Wait Slack write survived to the final result with its
      // verified read-back, so the emulator state was not lost on resume.
      expect(
        result.effects.find(
          (effect) => effect.operation === "chat.postMessage",
        ),
      ).toMatchObject({
        service: "slack",
        operation: "chat.postMessage",
        verified: true,
      });
    } finally {
      await handle.stop();
    }
  });
});
