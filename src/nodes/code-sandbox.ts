import { resolve } from "node:path";
import { DateTime } from "luxon";
import type { Item } from "../schema/item.ts";

export type OsSandboxKind = "sandbox-exec" | "bwrap";

export interface OsCodeRequest {
  code: string;
  mode: "runOnceForAllItems" | "runOnceForEachItem";
  item?: Item;
  items: Item[];
  itemIndex: number;
  nodeName: string;
  scope: {
    json: Record<string, unknown>;
    binary?: Record<string, unknown>;
    workflow: { name: string; id?: string };
    now?: string;
    timezone?: string;
  };
  /** Branch-aware outputs used by the $('Node') accessor. */
  nodeOutputs: Record<string, Item[]>;
  /** Flattened outputs used by the legacy $node.NodeName accessor. */
  legacyNodeOutputs: Record<string, Item[]>;
  staticData: Record<string, Record<string, unknown>>;
  dateNow?: string;
}

export interface OsCodeResponse {
  result: unknown;
  staticData: Record<string, Record<string, unknown>>;
}

export class OsSandboxUnavailableError extends Error {
  override readonly name = "OsSandboxUnavailableError";
}

function sandboxCommand(
  kind: OsSandboxKind,
  workerCommand: string[],
): string[] {
  if (kind === "sandbox-exec") {
    const profile = [
      "(version 1)",
      "(allow default)",
      "(deny network*)",
      "(deny file-write*)",
      "(deny process-fork)",
    ].join(" ");
    return ["sandbox-exec", "-p", profile, ...workerCommand];
  }
  return [
    "bwrap",
    "--die-with-parent",
    "--unshare-all",
    "--new-session",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    ...workerCommand,
  ];
}

function makeAccessor(values: Item[], index: number) {
  return {
    all: () => values,
    first: () => values[0],
    last: () => values[values.length - 1],
    item: values[index] ?? values[0] ?? { json: {} },
  };
}

async function executeWorkerRequest(
  request: OsCodeRequest,
): Promise<OsCodeResponse> {
  const staticData = request.staticData ?? {};
  const parseNow = () => {
    if (!request.scope.now) return DateTime.now();
    const parsed = DateTime.fromISO(request.scope.now, { setZone: true });
    return request.scope.timezone
      ? parsed.setZone(request.scope.timezone)
      : parsed;
  };
  const writeDiagnostic = (...values: unknown[]) =>
    process.stderr.write(`${values.map(String).join(" ")}\n`);
  const codeConsole = Object.freeze({
    log: writeDiagnostic,
    info: writeDiagnostic,
    warn: writeDiagnostic,
    error: writeDiagnostic,
    debug: writeDiagnostic,
  });
  const fixedTime = request.dateNow
    ? new Date(request.dateNow).getTime()
    : undefined;
  class ScopedDate extends Date {
    constructor(...args: unknown[]) {
      if (args.length === 0 && fixedTime !== undefined) super(fixedTime);
      else super(...(args as []));
    }
    static override now(): number {
      return fixedTime ?? Date.now();
    }
  }
  const scope = {
    $json: request.scope.json,
    $binary: request.scope.binary,
    $itemIndex: request.itemIndex,
    $input: makeAccessor(request.items, request.itemIndex),
    $: (name: string) => {
      const values = request.nodeOutputs[name];
      if (!values) {
        throw new Error(
          `No output found for referenced node "${name}" (it has not run or its name does not match)`,
        );
      }
      return makeAccessor(values, request.itemIndex);
    },
    $node: Object.assign(
      { name: request.nodeName },
      Object.fromEntries(
        Object.entries(request.legacyNodeOutputs).map(([name, values]) => [
          name,
          values[0] ?? { json: {} },
        ]),
      ),
    ),
    $workflow: request.scope.workflow,
    $now: parseNow(),
    $today: parseNow().startOf("day"),
    item: request.item,
    items: request.items,
    $getWorkflowStaticData: (type: string) => {
      const key = type === "node" ? `node:${request.nodeName}` : "global";
      staticData[key] ??= {};
      return staticData[key];
    },
    console: codeConsole,
    Date: fixedTime === undefined ? Date : ScopedDate,
  };
  const isolatedGlobal = Object.freeze(Object.create(null));
  const guarded = {
    ...scope,
    fetch: undefined,
    process: undefined,
    Bun: undefined,
    Deno: undefined,
    require: undefined,
    WebSocket: undefined,
    EventSource: undefined,
    XMLHttpRequest: undefined,
    global: isolatedGlobal,
    globalThis: isolatedGlobal,
    self: isolatedGlobal,
    window: isolatedGlobal,
    Function: undefined,
  };
  const fn = new Function(
    ...Object.keys(guarded),
    `"use strict";\n${request.code}\n`,
  );
  const result = await fn(...Object.values(guarded));
  return { result, staticData };
}

/** Internal raw-JSON entrypoint used only by the sandboxed child process. */
export async function runCodeWorkerStdio(): Promise<void> {
  try {
    const raw = await new Response(Bun.stdin).text();
    const request = JSON.parse(raw) as OsCodeRequest;
    const response = await executeWorkerRequest(request);
    process.stdout.write(JSON.stringify({ ok: true, ...response }));
  } catch (cause) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: String((cause as Error)?.message ?? cause),
      }),
    );
  }
}

function workerCommand(): string[] {
  if (
    process.execPath.endsWith("/bun") ||
    process.execPath.endsWith("\\bun.exe")
  ) {
    return [
      process.execPath,
      resolve(import.meta.dir, "../cli/index.ts"),
      "__code-worker",
    ];
  }
  return [process.execPath, "__code-worker"];
}

export function availableOsSandbox(): OsSandboxKind | undefined {
  if (process.platform === "darwin" && Bun.which("sandbox-exec")) {
    return "sandbox-exec";
  }
  if (process.platform === "linux" && Bun.which("bwrap")) return "bwrap";
  return undefined;
}

async function runWorker(
  command: string[],
  request: OsCodeRequest,
  timeoutMs: number,
  sandboxed: boolean,
): Promise<OsCodeResponse> {
  const child = Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TZ: process.env.TZ ?? "UTC",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    },
  });
  child.stdin.write(JSON.stringify(request));
  child.stdin.end();
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const exitCode = await child.exited;
  clearTimeout(timeout);
  const [output, errorOutput] = await Promise.all([stdout, stderr]);
  if (timedOut)
    throw new Error(`OS Code execution timed out after ${timeoutMs}ms`);
  if (exitCode !== 0) {
    const message =
      errorOutput.trim() || `OS Code worker exited with code ${exitCode}`;
    if (sandboxed) throw new OsSandboxUnavailableError(message);
    throw new Error(message);
  }
  let parsed: ({ ok: true } & OsCodeResponse) | { ok: false; error: string };
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    throw new Error("OS Code worker returned invalid JSON");
  }
  if (!parsed.ok) throw new Error(parsed.error);
  return { result: parsed.result, staticData: parsed.staticData };
}

/** Executes the serialization boundary without an OS policy, for unit tests only. */
export function runCodeWorkerForTesting(
  request: OsCodeRequest,
  timeoutMs = 1000,
): Promise<OsCodeResponse> {
  return runWorker(workerCommand(), request, timeoutMs, false);
}

export async function runOsCode(
  request: OsCodeRequest,
  timeoutMs: number,
  requireSandbox: boolean,
): Promise<OsCodeResponse> {
  const kind = availableOsSandbox();
  if (!kind && requireSandbox) {
    throw new OsSandboxUnavailableError(
      "OS Code sandbox is unavailable: install sandbox-exec (macOS) or bubblewrap (Linux)",
    );
  }
  if (!kind) {
    throw new OsSandboxUnavailableError("OS Code sandbox is unavailable");
  }
  return runWorker(
    sandboxCommand(kind, workerCommand()),
    request,
    timeoutMs,
    true,
  );
}
