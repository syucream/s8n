import { createContext, Script } from "node:vm";
import type { ExpressionScope } from "../../expression/context.ts";
import { SAFE_RUNTIME_GLOBALS } from "../../expression/safe-globals.ts";
import type { Item } from "../../schema/item.ts";
import {
  type OsCodeRequest,
  OsSandboxUnavailableError,
  runOsCode,
} from "../code-sandbox.ts";
import type { NodeExecutor, RuntimeContext } from "../types.ts";

/**
 * Code: runs caller-supplied JavaScript as the sole "compute" node type.
 * Like the expression evaluator, this uses `new Function` for a local,
 * single-user CLI evaluating its own trusted workflow definition. Common host
 * I/O globals are explicitly shadowed, which prevents accidental network or
 * filesystem access. This guardrail is not a security sandbox for hostile
 * JavaScript; use OS-level isolation for untrusted workflows.
 */

function runCode(
  code: string,
  scope: Record<string, unknown>,
  mode: "in-process" | "vm" = "in-process",
  timeoutMs = 1000,
): unknown {
  const guardedScope = { ...scope, ...SAFE_RUNTIME_GLOBALS };
  if (mode === "vm") {
    const context = createContext({ ...guardedScope });
    const script = new Script(`(function () { "use strict";\n${code}\n})()`);
    return script.runInContext(context, { timeout: timeoutMs });
  }
  const names = Object.keys(guardedScope);
  const values = Object.values(guardedScope);
  const fn = new Function(...names, `"use strict";\n${code}\n`);
  return fn(...values);
}

function osRequest(
  code: string,
  nodeName: string,
  scope: ExpressionScope,
  inputItems: Item[],
  itemIndex: number,
  runtime: RuntimeContext,
  mode: "runOnceForAllItems" | "runOnceForEachItem",
  item?: Item,
): OsCodeRequest {
  const legacyNodeOutputs = Object.fromEntries(runtime.nodeOutputs.entries());
  const nodeOutputs = Object.fromEntries(
    [...runtime.nodeOutputs.keys()].map((name) => {
      try {
        return [name, scope.$(name).all()];
      } catch {
        return [name, runtime.nodeOutputs.get(name) ?? []];
      }
    }),
  );
  const now = scope.$now.toISO();
  return {
    code,
    mode,
    item,
    items: inputItems,
    itemIndex,
    nodeName,
    scope: {
      json: scope.$json,
      binary: scope.$binary,
      workflow: scope.$workflow,
      now: now ?? undefined,
      timezone: scope.$now.zoneName ?? undefined,
    },
    nodeOutputs,
    legacyNodeOutputs,
    staticData: Object.fromEntries(runtime.workflowStaticData.entries()),
    dateNow: runtime.now?.toISOString(),
  };
}

function applyStaticData(
  runtime: RuntimeContext,
  values: Record<string, Record<string, unknown>>,
): void {
  for (const [key, value] of Object.entries(values)) {
    runtime.workflowStaticData.set(key, value);
  }
}

async function runWithBoundary(
  code: string,
  fallbackScope: Record<string, unknown>,
  request: OsCodeRequest,
  runtime: RuntimeContext,
): Promise<unknown> {
  const mode = runtime.codeExecutionMode;
  if (mode !== "os" && mode !== "auto") {
    return runCode(code, fallbackScope, mode, runtime.codeTimeoutMs);
  }
  try {
    const response = await runOsCode(
      request,
      runtime.codeTimeoutMs ?? 1000,
      mode === "os",
    );
    applyStaticData(runtime, response.staticData);
    return response.result;
  } catch (cause) {
    if (mode === "auto" && cause instanceof OsSandboxUnavailableError) {
      return runCode(code, fallbackScope, "vm", runtime.codeTimeoutMs);
    }
    throw cause;
  }
}

/**
 * Real n8n Code node scripts commonly call `new Date()` directly (not just
 * `$now`) to get the current time. Without shadowing the global `Date`
 * inside the executed code, `--now` would fail to make such scripts
 * reproducible. Only args-less `new Date()`/`Date.now()` are pinned;
 * explicit `new Date(x)` still behaves normally.
 */
function createScopedDate(fixedNow: Date | undefined): DateConstructor {
  if (!fixedNow) return Date;
  const fixedTime = fixedNow.getTime();
  class ScopedDate extends Date {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(fixedTime);
      } else {
        super(...(args as []));
      }
    }
    static override now(): number {
      return fixedTime;
    }
  }
  return ScopedDate as unknown as DateConstructor;
}

function toItem(value: unknown, pairedItemIndex: number): Item {
  if (
    value !== null &&
    typeof value === "object" &&
    "json" in (value as Record<string, unknown>)
  ) {
    const v = value as {
      json: Record<string, unknown>;
      binary?: Item["binary"];
    };
    return {
      json: v.json,
      binary: v.binary,
      pairedItem: { item: pairedItemIndex },
    };
  }
  return {
    json: (value ?? {}) as Record<string, unknown>,
    pairedItem: { item: pairedItemIndex },
  };
}

export const codeExecutor: NodeExecutor = {
  type: "n8n-nodes-base.code",
  execute: async ({ node, inputItems, runtime, buildScope }) => {
    const language = String(node.parameters.language ?? "javaScript");
    if (language !== "javaScript") {
      return {
        status: "error",
        message: `Code node "${node.name}" uses unsupported language="${language}"; only jsCode/JavaScript can run`,
      };
    }

    const code = String(node.parameters.jsCode ?? "");
    const mode = String(node.parameters.mode ?? "runOnceForAllItems");
    const ScopedDate = createScopedDate(runtime.now);
    const getWorkflowStaticData = (type: string) => {
      const key = type === "node" ? `node:${node.name}` : "global";
      let data = runtime.workflowStaticData.get(key);
      if (!data) {
        data = {};
        runtime.workflowStaticData.set(key, data);
      }
      return data;
    };

    try {
      if (mode === "runOnceForEachItem") {
        const outputItems: Item[] = [];
        for (const [index, item] of inputItems.entries()) {
          // `$json`/`$input`/`$('Node')`/`$now`/`$workflow` all come from the
          // same expression scope used to resolve `={{ }}` parameters
          // elsewhere, so Code node scripts see exactly the same API surface.
          const scope = buildScope(item, index, inputItems);
          const fallbackScope = {
            ...scope,
            item,
            $itemIndex: index,
            $getWorkflowStaticData: getWorkflowStaticData,
            Date: ScopedDate,
          };
          const result = await runWithBoundary(
            code,
            fallbackScope,
            osRequest(
              code,
              node.name,
              scope,
              inputItems,
              index,
              runtime,
              "runOnceForEachItem",
              item,
            ),
            runtime,
          );
          outputItems.push(toItem(result, index));
        }
        return { status: "success", output: [outputItems] };
      }

      const scope = buildScope(inputItems[0] ?? { json: {} }, 0, inputItems);
      const fallbackScope = {
        ...scope,
        items: inputItems,
        $getWorkflowStaticData: getWorkflowStaticData,
        Date: ScopedDate,
      };
      const result = await runWithBoundary(
        code,
        fallbackScope,
        osRequest(
          code,
          node.name,
          scope,
          inputItems,
          0,
          runtime,
          "runOnceForAllItems",
        ),
        runtime,
      );
      const resultArray = Array.isArray(result) ? result : [result];
      const outputItems = resultArray.map((entry, index) =>
        toItem(entry, index),
      );
      return { status: "success", output: [outputItems] };
    } catch (cause) {
      return {
        status: "error",
        message: `Code node "${node.name}" failed: ${String((cause as Error)?.message ?? cause)}`,
      };
    }
  },
};
