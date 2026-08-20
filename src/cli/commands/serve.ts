import type { Command } from "commander";
import { printEnvelope } from "../../format/output.ts";
import { createMockLookup, emptyMockLookup } from "../../mock/provider.ts";
import type { Workflow } from "../../schema/workflow.ts";
import { buildRoutes, findRouteConflict } from "../../server/routes.ts";
import { createServeServer } from "../../server/serve.ts";
import { loadJsonFile } from "../load-json-file.ts";
import { loadWorkflowFile } from "../load-workflow.ts";
import { loadWorkflowMapFile } from "../load-workflow-map.ts";
import {
  resolveEmulatedServices,
  validateEmulatorSeed,
} from "../run-workflow-file.ts";

interface ServeOptions {
  port?: string;
  host?: string;
  mocks?: string;
  workflowMap?: string;
  resolveCodeIncludes?: boolean;
  now?: string;
  emulate?: string;
  emulatorSeed?: string;
  codeMode?: "in-process" | "vm" | "os" | "auto";
  codeTimeoutMs?: string;
  traceRequests?: boolean;
}

function validateMocks(rawMocks: unknown) {
  if (rawMocks === undefined) {
    return emptyMockLookup;
  }
  if (
    typeof rawMocks !== "object" ||
    rawMocks === null ||
    Array.isArray(rawMocks)
  ) {
    throw new Error("--mocks JSON must be a flat { mockKey: value } object");
  }
  return createMockLookup(rawMocks as Record<string, unknown>);
}

/**
 * `s8n serve <workflowFile>` starts a loopback HTTP mock server that exposes
 * the workflow's webhook and form triggers. Every workflow run keeps all
 * outbound I/O mocked or emulated; the server only receives inbound requests.
 * The command emits exactly one JSON envelope on stdout at startup (with the
 * bound address and route table) and never writes to stdout again - runtime
 * diagnostics go to stderr. Run traffic flows over HTTP; send SIGINT/SIGTERM
 * to stop.
 */
export function registerServeCommand(program: Command): void {
  program
    .command("serve <workflowFile>")
    .description(
      "Start a local mock server exposing webhook and form triggers over HTTP",
    )
    .option(
      "--port <port>",
      "Port to listen on (default 5678; 0 picks a free port)",
    )
    .option("--host <host>", "Host interface to bind (default 127.0.0.1)")
    .option(
      "--mocks <file>",
      "JSON file defining external I/O mocks as a flat { mockKey: value } object",
    )
    .option(
      "--workflow-map <file>",
      "JSON or YAML map of explicit sub-workflow references and file paths",
    )
    .option(
      "--resolve-code-includes",
      "Resolve strict ./_subfiles/<directory>/<file>.js Code references",
    )
    .option(
      "--now <iso>",
      "ISO timestamp fixing $now and $today for every request",
    )
    .option(
      "--emulate <services>",
      "Run integrations against stateful local emulators (comma-separated or all)",
    )
    .option(
      "--emulator-seed <file>",
      "JSON file containing initial state as { stores: { storeName: [entities] } }",
    )
    .option(
      "--code-mode <mode>",
      "Code node boundary: in-process (default), vm, os, or auto",
    )
    .option(
      "--code-timeout-ms <milliseconds>",
      "Timeout for vm Code nodes (default: 1000)",
    )
    .option(
      "--trace-requests",
      "Include sanitized resolved HTTP request evidence in execution results",
    )
    .action(async (workflowFile: string, opts: ServeOptions) => {
      let port = 5678;
      if (opts.port !== undefined) {
        port = Number(opts.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          printEnvelope({
            ok: false,
            command: "serve",
            error: `--port must be an integer between 0 and 65535: "${opts.port}"`,
          });
          process.exitCode = 1;
          return;
        }
      }
      const host = opts.host ?? "127.0.0.1";
      const codeMode = opts.codeMode;
      if (
        codeMode !== undefined &&
        !["in-process", "vm", "os", "auto"].includes(codeMode)
      ) {
        printEnvelope({
          ok: false,
          command: "serve",
          error: `--code-mode must be "in-process", "vm", "os", or "auto": "${codeMode}"`,
        });
        process.exitCode = 1;
        return;
      }
      const codeTimeoutMs =
        opts.codeTimeoutMs === undefined
          ? undefined
          : Number(opts.codeTimeoutMs);
      if (
        codeTimeoutMs !== undefined &&
        (!Number.isInteger(codeTimeoutMs) || codeTimeoutMs <= 0)
      ) {
        printEnvelope({
          ok: false,
          command: "serve",
          error: `--code-timeout-ms must be a positive integer: "${opts.codeTimeoutMs}"`,
        });
        process.exitCode = 1;
        return;
      }

      const workflowOptions = {
        resolveCodeIncludes: opts.resolveCodeIncludes === true,
      };
      const loaded = await loadWorkflowFile(workflowFile, workflowOptions);
      if (!loaded.ok || !loaded.workflow) {
        printEnvelope({
          ok: false,
          command: "serve",
          error: loaded.error ?? "Workflow validation failed",
          ...(loaded.issues === undefined ? {} : { issues: loaded.issues }),
        });
        process.exitCode = 1;
        return;
      }

      try {
        const [mocksRaw, emulatorSeedRaw] = await Promise.all([
          loadJsonFile(opts.mocks),
          loadJsonFile(opts.emulatorSeed),
        ]);
        const mocks = validateMocks(mocksRaw);
        const emulatorSeed = validateEmulatorSeed(emulatorSeedRaw);
        const services = resolveEmulatedServices(opts.emulate?.split(","));
        if (emulatorSeed !== undefined && services === undefined) {
          printEnvelope({
            ok: false,
            command: "serve",
            error: "--emulator-seed requires --emulate",
          });
          process.exitCode = 1;
          return;
        }

        let workflowMap: ReadonlyMap<string, Workflow> | undefined;
        if (opts.workflowMap !== undefined) {
          const loadedMap = await loadWorkflowMapFile(
            opts.workflowMap,
            workflowOptions,
          );
          if (!loadedMap.ok || !loadedMap.workflows) {
            printEnvelope({
              ok: false,
              command: "serve",
              error: loadedMap.error ?? "Failed to load workflow map",
            });
            process.exitCode = 1;
            return;
          }
          workflowMap = loadedMap.workflows;
        }

        const now = opts.now === undefined ? undefined : new Date(opts.now);
        if (opts.now !== undefined && Number.isNaN(now?.getTime())) {
          printEnvelope({
            ok: false,
            command: "serve",
            error: `--now contains an invalid timestamp: "${opts.now}"`,
          });
          process.exitCode = 1;
          return;
        }

        const routes = buildRoutes(loaded.workflow);
        const conflict = findRouteConflict(routes);
        if (conflict !== undefined) {
          printEnvelope({
            ok: false,
            command: "serve",
            error: `Duplicate route ${conflict.method} ${conflict.path}: triggers "${conflict.a}" and "${conflict.b}" map to the same path`,
          });
          process.exitCode = 1;
          return;
        }
        if (routes.length === 0) {
          printEnvelope({
            ok: false,
            command: "serve",
            error:
              "The workflow has no webhook or form trigger start nodes to expose",
          });
          process.exitCode = 1;
          return;
        }

        const handle = await createServeServer({
          host,
          port,
          workflowFile,
          workflow: loaded.workflow,
          routes,
          mocks,
          emulate: services,
          emulatorSeed,
          now,
          codeExecutionMode: codeMode,
          codeTimeoutMs,
          workflowMap,
          captureResolvedRequests: opts.traceRequests === true,
        });

        printEnvelope({
          ok: true,
          command: "serve",
          data: {
            host: handle.host,
            port: handle.port,
            workflow: { name: loaded.workflow.name, file: workflowFile },
            routes: routes.map((route) => ({
              kind: route.kind,
              method: route.methods,
              path: `${route.prefix}/${route.urlPath}`,
              trigger: route.triggerNode,
            })),
          },
        });

        let stopping = false;
        const shutdown = (): void => {
          if (stopping) return;
          stopping = true;
          void handle.stop().finally(() => process.exit(0));
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      } catch (cause) {
        printEnvelope({
          ok: false,
          command: "serve",
          error: String((cause as Error)?.message ?? cause),
        });
        process.exitCode = 1;
      }
    });
}
