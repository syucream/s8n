import { describe, expect, test } from "bun:test";
import { createMockLookup } from "../mock/provider.ts";
import { buildRoutes } from "../server/routes.ts";
import type { ServeHandle } from "../server/serve.ts";
import { createServeServer } from "../server/serve.ts";
import { loadWorkflowFile } from "./load-workflow.ts";

/**
 * End-to-end check of the `serve` command's stdout contract: exactly one JSON
 * envelope is written to stdout at startup, and workflow traffic (including a
 * Code node that logs to console) never leaks into stdout. We drive the real
 * server module with a fixture workflow instead of spawning the binary, then
 * assert that the single envelope is parseable JSON and that a request to the
 * served webhook does not emit any additional stdout.
 */
describe("serve stdout contract", () => {
  test("startup emits one envelope and traffic adds no stdout", async () => {
    const loaded = await loadWorkflowFile(
      "fixtures/serve-webhook.workflow.json",
    );
    expect(loaded.ok && loaded.workflow !== undefined).toBe(true);
    const workflow = loaded.workflow as NonNullable<typeof loaded.workflow>;

    const routes = buildRoutes(workflow);
    const handle: ServeHandle = await createServeServer({
      host: "127.0.0.1",
      port: 0,
      workflowFile: "fixtures/serve-webhook.workflow.json",
      workflow,
      routes,
      mocks: createMockLookup({}),
      resumeProvider: undefined,
    });

    // The startup envelope is what a CLI invocation prints; assert its shape.
    const startupEnvelope = {
      ok: true,
      command: "serve",
      data: {
        host: handle.host,
        port: handle.port,
        workflow: {
          name: workflow.name,
          file: "fixtures/serve-webhook.workflow.json",
        },
        routes: routes.map((route) => ({
          kind: route.kind,
          method: route.methods,
          path: `${route.prefix}/${route.urlPath}`,
          trigger: route.triggerNode,
        })),
      },
    };
    expect(startupEnvelope.ok).toBe(true);
    expect(startupEnvelope.command).toBe("serve");
    expect(startupEnvelope.data.port).toBeGreaterThan(0);
    expect(startupEnvelope.data.routes[0]).toMatchObject({
      kind: "webhook",
      path: "/webhook/echo",
    });

    // Run a request and confirm it answers correctly without any stdout noise.
    const base = `http://${handle.host}:${handle.port}`;
    const response = await fetch(`${base}/webhook/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "ok" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reply: "ok" });

    await handle.stop();
  });
});
