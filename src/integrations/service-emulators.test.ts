import { describe, expect, test } from "bun:test";
import { type WorkflowNode, workflowNodeSchema } from "../schema/workflow.ts";
import { EmulatorIntegrationRunner } from "./emulator.ts";
import type { EmulatedService } from "./types.ts";

function node(type: string, name = type): WorkflowNode {
  return workflowNodeSchema.parse({ id: name, name, type, parameters: {} });
}

async function execute(
  runner: EmulatorIntegrationRunner,
  type: string,
  parameters: Record<string, unknown>,
) {
  const response = await runner.execute(node(type), parameters);
  expect(response?.effect.verified).toBe(true);
  expect(response?.effect.observation).toBeDefined();
  return response;
}

describe("stateful service emulators", () => {
  test.each([
    {
      service: "gws" as const,
      type: "n8n-nodes-base.googleDrive",
      create: {
        operation: "upload",
        fileName: "evidence.txt",
        content: "passed",
      },
      get: (id: string) => ({ operation: "get", fileId: id }),
    },
    {
      service: "gcp" as const,
      type: "n8n-nodes-base.googleCloudStorage",
      create: {
        operation: "upload",
        bucketName: "evidence",
        objectName: "report.json",
        content: "{}",
      },
      get: (id: string) => ({ operation: "get", objectName: id }),
    },
    {
      service: "notion" as const,
      type: "n8n-nodes-base.notion",
      create: { resource: "page", operation: "create", title: "Evidence" },
      get: (id: string) => ({ resource: "page", operation: "get", pageId: id }),
    },
    {
      service: "jira" as const,
      type: "n8n-nodes-base.jira",
      create: {
        resource: "issue",
        operation: "create",
        projectKey: "S8N",
        summary: "Evidence",
      },
      get: (id: string) => ({
        resource: "issue",
        operation: "get",
        issueKey: id,
      }),
    },
    {
      service: "github" as const,
      type: "n8n-nodes-base.github",
      create: {
        resource: "issue",
        operation: "create",
        owner: "s8n",
        repository: "quality",
        title: "Evidence",
      },
      get: (id: string) => ({
        resource: "issue",
        operation: "get",
        owner: "s8n",
        repository: "quality",
        issueNumber: id,
      }),
    },
  ])("persists and reads back $service resources", async ({
    service,
    type,
    create,
    get,
  }) => {
    const runner = await EmulatorIntegrationRunner.create([service]);
    const created = await execute(runner, type, create);
    const output = created?.output as Record<string, unknown>;
    const id = String(output.id ?? output.key ?? output.number);
    const fetched = await execute(runner, type, get(id));
    expect(fetched?.output).toMatchObject(output);
  });

  test("BigQuery inserts rows and query reads the persisted table", async () => {
    const runner = await EmulatorIntegrationRunner.create(["gcp"]);
    await execute(runner, "n8n-nodes-base.googleBigQuery", {
      operation: "insert",
      tableId: "quality_events",
      rows: [{ gate: "integration", passed: true }],
    });
    const queried = await execute(runner, "n8n-nodes-base.googleBigQuery", {
      operation: "executeQuery",
      tableId: "quality_events",
      query: "SELECT * FROM quality_events",
    });
    expect(queried?.output).toEqual([
      expect.objectContaining({ gate: "integration", passed: true }),
    ]);
  });

  test("Sheets and BigQuery use incoming item fields for automatic mapping", async () => {
    const runner = await EmulatorIntegrationRunner.create(["gws", "gcp"]);
    const input = { json: { gate: "automatic", passed: true } };
    const sheet = await runner.execute(
      node("n8n-nodes-base.googleSheets"),
      { operation: "append", documentId: "quality", sheetName: "runs" },
      input,
    );
    const bigQuery = await runner.execute(
      node("n8n-nodes-base.googleBigQuery"),
      { operation: "insert", tableId: "runs" },
      input,
    );
    expect(sheet?.output).toMatchObject(input.json);
    expect(bigQuery?.output).toEqual([expect.objectContaining(input.json)]);
  });

  test("Vertex AI records a deterministic invocation", async () => {
    const runner = await EmulatorIntegrationRunner.create(["gcp"]);
    const generated = await execute(
      runner,
      "@n8n/n8n-nodes-langchain.googleVertexChat",
      {
        prompt: "Summarize quality evidence",
        model: "gemini-2.5-flash",
      },
    );
    expect(generated?.output).toMatchObject({
      modelMetadata: { present: true, kind: "string", sizeBucket: "short" },
      promptMetadata: { present: true, kind: "string", sizeBucket: "short" },
      finishReason: "STOP",
    });
    expect(JSON.stringify(generated?.effect)).not.toContain(
      "Summarize quality evidence",
    );
    expect(JSON.stringify(generated?.effect)).not.toContain("gemini-2.5-flash");
  });

  test("GWS emulates Sheets, Gmail, Calendar, and Docs", async () => {
    const runner = await EmulatorIntegrationRunner.create(["gws"]);
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        "n8n-nodes-base.googleSheets",
        {
          operation: "append",
          documentId: "quality",
          sheetName: "runs",
          data: { passed: true },
        },
      ],
      [
        "n8n-nodes-base.gmail",
        {
          operation: "send",
          sendTo: "agent@s8n.local",
          subject: "Passed",
          message: "Evidence ready",
        },
      ],
      [
        "n8n-nodes-base.googleCalendar",
        {
          operation: "create",
          summary: "Quality review",
          start: "2026-08-03T00:00:00Z",
          end: "2026-08-03T01:00:00Z",
        },
      ],
      [
        "n8n-nodes-base.googleDocs",
        { operation: "create", title: "Quality evidence", text: "passed" },
      ],
    ];
    for (const [type, parameters] of cases) {
      expect((await execute(runner, type, parameters))?.output).toBeDefined();
    }
  });

  test.each([
    "gws",
    "gcp",
    "notion",
    "jira",
    "github",
  ] as EmulatedService[])("%s returns undefined for unrelated nodes so explicit mocks remain available", async (service) => {
    const runner = await EmulatorIntegrationRunner.create([service]);
    expect(
      await runner.execute(node("example.unsupported"), {}),
    ).toBeUndefined();
  });

  test("read of a missing resource fails instead of fabricating success", async () => {
    const runner = await EmulatorIntegrationRunner.create(["notion"]);
    expect(
      runner.execute(node("n8n-nodes-base.notion"), {
        resource: "page",
        operation: "get",
        pageId: "missing",
      }),
    ).rejects.toThrow("notion.pages missing was not found");
  });

  test("seeded state makes read-first workflows meaningful", async () => {
    const runner = await EmulatorIntegrationRunner.create(["notion"], {
      stores: {
        "notion.databasePages": [
          { id: "page-1", name: "Offline mode", property_status: "To develop" },
        ],
      },
    });
    const listed = await runner.execute(node("n8n-nodes-base.notion"), {
      resource: "databasePage",
      operation: "getAll",
    });
    expect(listed?.output).toEqual([
      expect.objectContaining({ id: "page-1", name: "Offline mode" }),
    ]);
  });

  test("published-workflow defaults create GitHub issues, send Gmail, and insert BigQuery rows", async () => {
    const runner = await EmulatorIntegrationRunner.create([
      "github",
      "gws",
      "gcp",
    ]);
    const github = await runner.execute(node("n8n-nodes-base.github"), {
      owner: { value: "s8n" },
      repository: { value: "product" },
      title: "Offline mode",
    });
    const gmail = await runner.execute(node("n8n-nodes-base.gmail"), {
      sendTo: "team@example.com",
      subject: "Issue created",
      message: "Offline mode",
    });
    const bigQuery = await runner.execute(
      node("n8n-nodes-base.googleBigQuery"),
      { tableId: "events" },
      { json: { event: "issue_created" } },
    );
    expect(github?.effect.operation).toBe("issues.create");
    expect(gmail?.effect.operation).toBe("gmail.users.messages.send");
    expect(bigQuery?.effect.operation).toBe("bigquery.tabledata.insertAll");
    expect(bigQuery?.effect.request).toMatchObject({
      rows: [expect.objectContaining({ event: "issue_created" })],
    });
  });

  test("GCS models the published bucket and object lifecycle", async () => {
    const runner = await EmulatorIntegrationRunner.create(["gcp"]);
    const bucket = await runner.execute(
      node("n8n-nodes-base.googleCloudStorage"),
      { operation: "create", bucketName: "quality-bucket" },
    );
    const object = await runner.execute(
      node("n8n-nodes-base.googleCloudStorage"),
      {
        resource: "object",
        operation: "create",
        bucketName: "quality-bucket",
        objectName: "evidence.json",
      },
    );
    const removed = await runner.execute(
      node("n8n-nodes-base.googleCloudStorage"),
      {
        resource: "object",
        operation: "delete",
        bucketName: "quality-bucket",
        objectName: "evidence.json",
      },
    );
    expect(bucket?.output).toMatchObject({ name: "quality-bucket" });
    expect(object?.output).toMatchObject({ name: "evidence.json" });
    expect(removed?.output).toMatchObject({ deleted: true });
  });
});
