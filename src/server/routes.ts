import type { Workflow, WorkflowNode } from "../schema/workflow.ts";
import type { RequestEnvelope, ServerRoute } from "./types.ts";

const WEBHOOK_TYPE = "n8n-nodes-base.webhook";
const FORM_TRIGGER_TYPE = "n8n-nodes-base.formTrigger";
const ALL_WEBHOOK_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

function stringParam(node: WorkflowNode, key: string): string {
  const value = node.parameters[key];
  return typeof value === "string" ? value : "";
}

function optionParam(node: WorkflowNode, key: string): unknown {
  const options = node.parameters.options;
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    return undefined;
  }
  return (options as Record<string, unknown>)[key];
}

function httpMethods(node: WorkflowNode): string[] {
  const raw = node.parameters.httpMethod;
  if (Array.isArray(raw)) {
    const methods = raw.map((entry) => String(entry).toUpperCase());
    return methods.length > 0 ? methods : [...ALL_WEBHOOK_METHODS];
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    return raw
      .split(",")
      .map((entry) => entry.trim().toUpperCase())
      .filter(Boolean);
  }
  // No explicit httpMethod (some exports omit it): accept any method rather
  // than guessing, which is the mock-friendly default for a test double.
  return [...ALL_WEBHOOK_METHODS];
}

function splitPath(raw: string): string[] {
  return raw.split("/").filter(Boolean);
}

function buildRoute(
  node: WorkflowNode,
  kind: ServerRoute["kind"],
  prefix: string,
  rawPath: string,
  methods: string[],
): ServerRoute {
  const urlPath = rawPath.split("/").filter(Boolean).join("/");
  const paramNames = splitPath(urlPath)
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => segment.slice(1));
  return { kind, triggerNode: node.name, prefix, urlPath, methods, paramNames };
}

function webhookRoute(node: WorkflowNode): ServerRoute {
  // n8n: `path` is the full path (isFullPath). Without a path the generated
  // webhookId is used. A `:param`-bearing path would be prefixed with the
  // webhookId in n8n; the mock keeps the path as-is and documents that.
  const path = stringParam(node, "path");
  const rawPath = path !== "" ? path : stringParam(node, "webhookId");
  return buildRoute(
    node,
    "webhook",
    "/webhook",
    rawPath !== "" ? rawPath : node.name,
    httpMethods(node),
  );
}

function formRoute(node: WorkflowNode): ServerRoute {
  // n8n: path = $parameter.path || $parameter.options.path || $webhookId
  const path = stringParam(node, "path");
  const optionPath = optionParam(node, "path");
  const rawPath =
    path !== "" ? path : typeof optionPath === "string" ? optionPath : "";
  const fallback = rawPath !== "" ? rawPath : stringParam(node, "webhookId");
  return buildRoute(
    node,
    "form",
    "/form",
    fallback !== "" ? fallback : node.name,
    // GET renders the form page, POST submits it.
    ["GET", "POST"],
  );
}

/** Builds the inbound trigger routes from a loaded workflow. */
export function buildRoutes(workflow: Workflow): ServerRoute[] {
  const predecessors = new Map<string, Set<string>>();
  for (const node of workflow.nodes) predecessors.set(node.name, new Set());
  for (const nodeConnections of Object.values(workflow.connections)) {
    for (const outputSlots of Object.values(nodeConnections)) {
      for (const slot of outputSlots) {
        for (const destination of slot ?? []) {
          predecessors.get(destination.node)?.add("connected");
        }
      }
    }
  }

  const routes: ServerRoute[] = [];
  for (const node of workflow.nodes) {
    if ((predecessors.get(node.name)?.size ?? 0) > 0) continue;
    if (node.type === WEBHOOK_TYPE) {
      routes.push(webhookRoute(node));
    } else if (node.type === FORM_TRIGGER_TYPE) {
      routes.push(formRoute(node));
    }
  }
  return routes;
}

export interface RouteMatch {
  route: ServerRoute;
  params: Record<string, string>;
}

/** Matches a request pathname+method against the route table. */
export function matchRoute(
  routes: readonly ServerRoute[],
  method: string,
  pathname: string,
): RouteMatch | undefined {
  const segments = pathname.split("/").filter(Boolean);
  for (const route of routes) {
    if (!route.methods.includes(method)) continue;
    const routeSegments = splitPath(`${route.prefix}/${route.urlPath}`);
    if (routeSegments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < routeSegments.length; index++) {
      const routeSegment = routeSegments[index] as string;
      const value = segments[index] as string;
      if (routeSegment.startsWith(":")) {
        try {
          params[routeSegment.slice(1)] = decodeURIComponent(value);
        } catch {
          params[routeSegment.slice(1)] = value;
        }
      } else if (routeSegment !== value) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return undefined;
}

/** True when a route table contains a duplicate path+method pair. */
export function findRouteConflict(
  routes: readonly ServerRoute[],
): { path: string; method: string; a: string; b: string } | undefined {
  const seen = new Map<string, { route: ServerRoute }>();
  for (const route of routes) {
    for (const method of route.methods) {
      const key = `${method} ${route.prefix}/${route.urlPath}`;
      const existing = seen.get(key);
      if (existing !== undefined) {
        return {
          path: `${route.prefix}/${route.urlPath}`,
          method,
          a: existing.route.triggerNode,
          b: route.triggerNode,
        };
      }
      seen.set(key, { route });
    }
  }
  return undefined;
}

/** Query string -> object, with repeated keys kept as arrays. */
export function parseQuery(
  searchParams: URLSearchParams,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const key of searchParams.keys()) {
    const values = searchParams.getAll(key);
    result[key] = values.length > 1 ? values : (values[0] as string);
  }
  return result;
}

/** Builds the envelope the server passes to the item builders. */
export function buildRequestEnvelope(
  req: import("node:http").IncomingMessage,
  match: RouteMatch,
  rawUrl: string | undefined,
): RequestEnvelope {
  const url = new URL(rawUrl ?? "/", "http://localhost");
  return {
    method: req.method ?? "GET",
    headers: { ...(req.headers as Record<string, string | string[]>) },
    query: parseQuery(url.searchParams),
    params: match.params,
  };
}
