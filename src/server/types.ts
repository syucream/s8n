import type { MockLookup, WaitResumeProvider } from "../nodes/types.ts";
import type { Workflow } from "../schema/workflow.ts";

/** The n8n webhook/form response-mode values the mock server honors. */
export type ServeResponseMode =
  | "onReceived"
  | "lastNode"
  | "responseNode"
  | "streaming";

/** A single inbound trigger route derived from a workflow start node. */
export interface ServerRoute {
  kind: "webhook" | "form";
  /** The start-node name this route belongs to (used as the engine startNode). */
  triggerNode: string;
  /** Route prefix segment(s), e.g. "/webhook" or "/form". */
  prefix: string;
  /** Path segments after the prefix; a segment starting with ":" is dynamic. */
  urlPath: string;
  /** HTTP methods that match this route. */
  methods: string[];
  /** Dynamic ":name" segments in order of appearance in `urlPath`. */
  paramNames: string[];
}

/** Options shared by the HTTP mock server and its per-execution runner. */
export interface ServeRunOptions {
  workflow: Workflow;
  mocks: MockLookup;
  /** Requested stateful emulation services (already resolved). */
  emulate?: readonly string[];
  emulatorSeed?: unknown;
  /** Fixed clock; when unset each request uses the current time. */
  now?: Date;
  codeExecutionMode?: "in-process" | "vm" | "os" | "auto";
  codeTimeoutMs?: number;
  workflowMap?: ReadonlyMap<string, Workflow>;
  captureResolvedRequests?: boolean;
  /**
   * Suspends runs that reach a Wait-on-webhook/form node until resumed. The
   * HTTP server always supplies its own per-execution provider; standalone
   * callers may omit it (Wait then reports a `waiting` status like the CLI).
   */
  resumeProvider?: WaitResumeProvider;
}

export interface ServeServerOptions extends ServeRunOptions {
  host: string;
  port: number;
  workflowFile: string;
  routes: ServerRoute[];
}

/** A single-use HTTP response gate; only the first call wins. */
export interface ResponseGate {
  sent: boolean;
  send(
    status: number,
    headers: Record<string, string>,
    body: string | null,
  ): void;
}

/** Shape of the incoming request the server hands to the item builders. */
export interface RequestEnvelope {
  method: string;
  headers: Record<string, string | string[]>;
  query: Record<string, string | string[]>;
  params: Record<string, string>;
}
