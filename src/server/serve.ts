import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { RunResult } from "../engine/execute.ts";
import type {
  ResumeDirective,
  WaitResumeMode,
  WaitResumeProvider,
} from "../nodes/types.ts";
import type { Item } from "../schema/item.ts";
import type { WorkflowNode } from "../schema/workflow.ts";
import { BodyParseError, buildFormItems, buildWebhookItems } from "./body.ts";
import { runServerExecution } from "./execution.ts";
import {
  buildErrorResponse,
  buildFormResponse,
  buildWebhookResponse,
  renderFormPage,
} from "./responses.ts";
import { buildRequestEnvelope, matchRoute, type RouteMatch } from "./routes.ts";
import type { ResponseGate, ServerRoute, ServeServerOptions } from "./types.ts";

const WEBHOOK_WAIT_PREFIX = "/webhook-waiting/";
const FORM_WAIT_PREFIX = "/form-waiting/";

export interface ServeHandle {
  host: string;
  port: number;
  routes: ServerRoute[];
  stop: () => Promise<void>;
}

export type ExecutionStatus = "running" | "waiting" | "done";

export interface ExecutionInfo {
  id: string;
  route: ServerRoute;
  status: ExecutionStatus;
  startNode: string;
  startedAt: number;
  finishedAt?: number;
  waitingOn?: string;
  result?: RunResult;
}

interface PendingWait {
  mode: WaitResumeMode;
  nodeName: string;
  resolve: (directive: ResumeDirective) => void;
  reject: (error: Error) => void;
}

interface Execution {
  info: ExecutionInfo;
  gate: ResponseGate;
  pendingWait?: PendingWait;
}

function routePath(route: ServerRoute): string {
  return `${route.prefix}/${route.urlPath}`;
}

/**
 * Upper bound on retained execution records. Each record keeps the full
 * `RunResult`, so an unbounded map would grow without limit on a long-lived
 * server. Completed executions are evicted oldest-first once the cap is hit;
 * recent results remain reachable via `/executions/<id>`.
 */
const MAX_RETAINED_EXECUTIONS = 1000;

function writeRaw(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string | null,
): void {
  // A run may complete after the server has closed the connection (e.g. a
  // shutdown racing an in-flight execution); writing again would throw.
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, headers);
  if (body === null) {
    res.end();
  } else {
    res.end(body);
  }
}

function writeJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
): void {
  writeRaw(
    res,
    status,
    { "content-type": "application/json; charset=utf-8" },
    JSON.stringify(payload),
  );
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function createGate(res: ServerResponse, id: string): ResponseGate {
  let sent = false;
  return {
    get sent() {
      return sent;
    },
    send(status, headers, body) {
      if (sent) return;
      sent = true;
      writeRaw(res, status, { ...headers, "x-s8n-execution-id": id }, body);
    },
  };
}

function resumePathFor(id: string, mode: WaitResumeMode): string {
  return mode === "onWebhookCall"
    ? `${WEBHOOK_WAIT_PREFIX}${id}`
    : `${FORM_WAIT_PREFIX}${id}`;
}

async function stopServer(
  server: Server,
  executions: Map<string, Execution>,
): Promise<void> {
  for (const execution of executions.values()) {
    const wait = execution.pendingWait;
    if (wait === undefined) continue;
    execution.pendingWait = undefined;
    wait.reject(new Error("s8n mock server is shutting down"));
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
  });
}

/**
 * Starts the in-process HTTP mock server. Binds to `options.host`/`options.port`
 * (port 0 picks an ephemeral port), serves the workflow's webhook and form
 * triggers, and resolves with the bound address and route table. Executions
 * run in the background; requests that reach a Wait-on-webhook/form node
 * receive a 202 with a resume path, and the final run result is available
 * from `GET /executions/<id>`.
 */
export function createServeServer(
  options: ServeServerOptions,
): Promise<ServeHandle> {
  const executions = new Map<string, Execution>();
  let executionCounter = 0;
  let boundPort = options.port;
  const nodesByName = new Map(
    options.workflow.nodes.map((node) => [node.name, node]),
  );
  const triggerNode = (route: ServerRoute): WorkflowNode => {
    const node = nodesByName.get(route.triggerNode);
    if (node === undefined) {
      throw new Error(`Unknown trigger node "${route.triggerNode}"`);
    }
    return node;
  };

  const nowForRequest = (): Date => options.now ?? new Date();

  function evictCompletedExecutions(): void {
    if (executions.size <= MAX_RETAINED_EXECUTIONS) return;
    for (const [key, candidate] of executions) {
      if (candidate.info.status === "done") {
        executions.delete(key);
        if (executions.size <= MAX_RETAINED_EXECUTIONS) return;
      }
    }
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((cause) => {
      writeJson(res, 500, {
        ok: false,
        error: `s8n mock server error: ${String((cause as Error)?.message ?? cause)}`,
      });
    });
  });

  function handleResume(
    req: IncomingMessage,
    res: ServerResponse,
    prefix: string,
    rawBody: string,
  ): void {
    const id = rawUrlId(req);
    const execution = executions.get(id);
    if (execution === undefined) {
      writeJson(res, 404, { ok: false, error: `Unknown execution "${id}"` });
      return;
    }
    const wait = execution.pendingWait;
    if (wait === undefined) {
      writeJson(res, 409, {
        ok: false,
        error: `Execution "${id}" is not currently waiting`,
      });
      return;
    }
    const expectedPrefix =
      wait.mode === "onWebhookCall" ? WEBHOOK_WAIT_PREFIX : FORM_WAIT_PREFIX;
    if (prefix !== expectedPrefix) {
      writeJson(res, 409, {
        ok: false,
        error: `Execution "${id}" is waiting for a ${wait.mode === "onWebhookCall" ? "webhook" : "form"} resume, not ${prefix}`,
      });
      return;
    }

    let directive: ResumeDirective;
    try {
      const parsed: unknown =
        rawBody.trim() === "" ? {} : (JSON.parse(rawBody) as unknown);
      const isObjectValue =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
      directive =
        isObjectValue && (parsed as { timeout?: unknown }).timeout === true
          ? { timeout: true }
          : { data: parsed ?? {} };
    } catch {
      writeJson(res, 400, {
        ok: false,
        error: 'Resume body must be valid JSON or {"timeout":true}',
      });
      return;
    }

    execution.pendingWait = undefined;
    execution.info.waitingOn = undefined;
    execution.info.status = "running";
    wait.resolve(directive);
    writeJson(res, 200, { ok: true, executionId: id, status: "resumed" });
  }

  function rawUrlId(req: IncomingMessage): string {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    return pathname.split("/").filter(Boolean)[1] ?? "";
  }

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    // Control endpoints.
    if (pathname === "/" && method === "GET") {
      writeJson(res, 200, {
        ok: true,
        name: "s8n mock server",
        workflow: { name: options.workflow.name, file: options.workflowFile },
        routes: options.routes.map((route) => ({
          kind: route.kind,
          method: route.methods,
          path: routePath(route),
          trigger: route.triggerNode,
        })),
      });
      return;
    }
    if (pathname === "/executions" && method === "GET") {
      writeJson(res, 200, {
        ok: true,
        executions: [...executions.values()].map((execution) => ({
          id: execution.info.id,
          status: execution.info.status,
          path: routePath(execution.info.route),
          startNode: execution.info.startNode,
          waitingOn: execution.info.waitingOn,
          startedAt: execution.info.startedAt,
          ...(execution.info.finishedAt === undefined
            ? {}
            : { finishedAt: execution.info.finishedAt }),
        })),
      });
      return;
    }
    if (pathname.startsWith("/executions/") && method === "GET") {
      const id = rawUrlId(req);
      const execution = executions.get(id);
      if (execution === undefined) {
        writeJson(res, 404, { ok: false, error: `Unknown execution "${id}"` });
        return;
      }
      writeJson(res, 200, {
        ok: true,
        executionId: id,
        status: execution.info.status,
        waitingOn: execution.info.waitingOn,
        startedAt: execution.info.startedAt,
        ...(execution.info.finishedAt === undefined
          ? {}
          : { finishedAt: execution.info.finishedAt }),
        ...(execution.info.result === undefined
          ? {}
          : { result: execution.info.result }),
      });
      return;
    }
    if (pathname.startsWith(WEBHOOK_WAIT_PREFIX) && method === "POST") {
      const rawBody = await readBody(req);
      handleResume(req, res, WEBHOOK_WAIT_PREFIX, rawBody);
      return;
    }
    if (pathname.startsWith(FORM_WAIT_PREFIX) && method === "POST") {
      const rawBody = await readBody(req);
      handleResume(req, res, FORM_WAIT_PREFIX, rawBody);
      return;
    }

    // Trigger routes.
    const match: RouteMatch | undefined = matchRoute(
      options.routes,
      method,
      pathname,
    );
    if (match === undefined) {
      writeJson(res, 404, {
        ok: false,
        error: `No matching webhook or form route for ${method} ${pathname}`,
      });
      return;
    }

    const route = match.route;
    const node = triggerNode(route);

    if (route.kind === "form" && method === "GET") {
      const html = renderFormPage(node, pathname);
      writeRaw(res, 200, { "content-type": "text/html; charset=utf-8" }, html);
      return;
    }

    const rawBody = await readBody(req);
    const envelope = buildRequestEnvelope(req, match, req.url);
    const contentType = req.headers["content-type"]?.toString();
    const id = `exec-${++executionCounter}`;
    const now = nowForRequest();

    let items: Item[];
    try {
      if (route.kind === "webhook") {
        const webhookUrl = `http://${options.host}:${boundPort}${pathname}`;
        items = buildWebhookItems(envelope, rawBody, contentType, webhookUrl);
      } else {
        items = buildFormItems(node, envelope, rawBody, contentType, now);
      }
    } catch (cause) {
      if (cause instanceof BodyParseError) {
        writeJson(res, cause.status, {
          ok: false,
          error: cause.message,
        });
        return;
      }
      throw cause;
    }

    const gate = createGate(res, id);
    const execution: Execution = {
      info: {
        id,
        route,
        status: "running",
        startNode: route.triggerNode,
        startedAt: Date.now(),
      },
      gate,
    };
    executions.set(id, execution);
    evictCompletedExecutions();

    const resumeProvider: WaitResumeProvider = (waitNode, mode) =>
      new Promise<ResumeDirective>((resolve, reject) => {
        if (execution.pendingWait !== undefined) {
          reject(
            new Error(
              `Execution "${id}" is already waiting at "${execution.pendingWait.nodeName}"`,
            ),
          );
          return;
        }
        execution.pendingWait = {
          mode,
          nodeName: waitNode.name,
          resolve,
          reject,
        };
        execution.info.status = "waiting";
        execution.info.waitingOn = waitNode.name;
        const resumePath = resumePathFor(id, mode);
        gate.send(
          202,
          { "content-type": "application/json; charset=utf-8" },
          JSON.stringify({
            ok: true,
            executionId: id,
            status: "waiting",
            nodeName: waitNode.name,
            resumePath,
          }),
        );
      });

    void runServerExecution({
      workflow: options.workflow,
      mocks: options.mocks,
      emulate: options.emulate,
      emulatorSeed: options.emulatorSeed,
      now,
      codeExecutionMode: options.codeExecutionMode,
      codeTimeoutMs: options.codeTimeoutMs,
      workflowMap: options.workflowMap,
      captureResolvedRequests: options.captureResolvedRequests,
      resumeProvider,
      inputItems: items,
      startNode: route.triggerNode,
    })
      .then((result: RunResult) => {
        execution.info.result = result;
        execution.info.status = "done";
        execution.info.finishedAt = Date.now();
        execution.info.waitingOn = undefined;
        if (execution.gate.sent) return;
        if (result.status !== "success") {
          const respond = buildErrorResponse(result);
          execution.gate.send(
            respond.status,
            { "content-type": "application/json; charset=utf-8" },
            respond.body,
          );
          return;
        }
        const respond =
          route.kind === "form"
            ? buildFormResponse()
            : buildWebhookResponse(options.workflow, result, node);
        execution.gate.send(
          respond.status,
          {
            ...(respond.contentType === undefined
              ? {}
              : { "content-type": respond.contentType }),
            ...(respond.headers ?? {}),
          },
          respond.body,
        );
      })
      .catch((cause) => {
        execution.info.status = "done";
        execution.info.finishedAt = Date.now();
        execution.info.waitingOn = undefined;
        if (execution.gate.sent) return;
        execution.gate.send(
          500,
          { "content-type": "application/json; charset=utf-8" },
          JSON.stringify({
            ok: false,
            error: `s8n mock server error: ${String((cause as Error)?.message ?? cause)}`,
          }),
        );
      });
  }

  return new Promise<ServeHandle>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port, options.host, () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (address !== null && typeof address === "object") {
        boundPort = address.port;
      }
      resolve({
        host: options.host,
        port: boundPort,
        routes: options.routes,
        stop: () => stopServer(server, executions),
      });
    });
  });
}
