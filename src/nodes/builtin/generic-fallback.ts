import { resolveParameterValue } from "../../expression/evaluator.ts";
import { formatAiRootOutput } from "../../integrations/ai-contract.ts";
import { findNodeTypeMockHint } from "../../mock/node-type-hints.ts";
import { normalizeMockToItems } from "../../mock/normalize.ts";
import { lookupItemMock } from "../../mock/provider.ts";
import { buildMockShapeHint } from "../../mock/shape-hint.ts";
import type { Item } from "../../schema/item.ts";
import type { ExecuteArgs, NodeExecuteResult } from "../types.ts";

/**
 * s8n implements real local-compute/control-flow logic for a curated set of
 * node types (see `src/nodes/registry.ts` for the current list: Set, If,
 * Filter, Switch, Merge, Code, Aggregate, Limit, Sort, Split Out, Split In
 * Batches, DateTime, RemoveDuplicates, Summarize, StopAndError, NoOp, Wait,
 * Respond to Webhook, and the trigger types) plus two IO *primitives* - HTTP
 * Request and Webhook - which get dedicated executors not because they're
 * exempt from the "mock IO" rule, but because they're the generic building
 * blocks every other IO node conceptually reduces to (an arbitrary URL call;
 * the most common trigger), so they earn slightly richer mock-request
 * plumbing (per-item `#<index>` keys, `--input`-first trigger priority).
 * Everything else - the hundreds of app-specific integration nodes (Slack,
 * Gmail, Notion, BigQuery, every LangChain node, ...) - falls all the way
 * through to this generic fallback, which s8n has no chance of (and no
 * intention of) faithfully re-implementing one by one.
 *
 * Rather than hard-failing on every node type it doesn't recognize, s8n
 * treats any unmodeled node as external IO and mocks it exactly like HTTP
 * Request: look up a mock by node name (optionally per-item), or pause and
 * ask the calling AI for plausible output data given the node's type and
 * configured parameters.
 *
 * Even though the node's own logic isn't simulated, its `parameters` are
 * still expression-resolved here (per item) before building the mock
 * request. This matters for two reasons: (1) a broken `={{ ... }}`
 * expression in an unmodeled node's parameters is still a real bug in the
 * workflow and should surface as an error rather than being silently
 * skipped, and (2) showing the *resolved* parameters (not the raw
 * `={{ }}` source) gives the calling AI real values to build a plausible
 * mock from.
 *
 * Many real workflows use unmodeled node types as their *trigger*
 * (`n8n-nodes-base.slackTrigger`, `formTrigger`, `errorTrigger`,
 * `evaluationTrigger`, `executeWorkflowTrigger`, ...) - s8n has no chance of
 * knowing that event's shape ahead of time either, but if the caller
 * already supplied `--input`, that *is* the simulated trigger payload and
 * should be used directly rather than demanding a mock for a node that
 * has no real predecessor to mock a response for.
 */
export async function executeGenericFallback(
  args: ExecuteArgs,
): Promise<NodeExecuteResult> {
  const {
    node,
    inputItems,
    runtime,
    buildScope,
    isStartNode,
    loopIterationIndex,
  } = args;
  if (isStartNode && runtime.hasExplicitInput) {
    return { status: "success", output: [inputItems] };
  }

  const items = inputItems.length > 0 ? inputItems : [{ json: {} }];
  const outputItems: Item[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Item;
    const scope = buildScope(item, i, items);

    let resolvedParams: unknown;
    try {
      resolvedParams = resolveParameterValue(node.parameters, scope);
    } catch (cause) {
      return {
        status: "error",
        message: `Failed to evaluate an expression in parameters for node "${node.name}": ${String((cause as Error)?.message ?? cause)}`,
      };
    }

    if (runtime.integrationRunner) {
      try {
        const emulated = await runtime.integrationRunner.execute(
          node,
          resolvedParams as Record<string, unknown>,
          item,
        );
        if (emulated) {
          runtime.integrationEffects.push(emulated.effect);
          outputItems.push(...normalizeMockToItems(emulated.output, i));
          continue;
        }

        let handledBySubnode = false;
        const aiSubnodes = runtime.integrationSubnodes?.get(node.name);
        for (const subnode of aiSubnodes?.ai_languageModel ?? []) {
          const subnodeParameters = resolveParameterValue(
            subnode.parameters,
            scope,
          ) as Record<string, unknown>;
          const parent = resolvedParams as Record<string, unknown>;
          const parentOptions =
            parent.options !== null && typeof parent.options === "object"
              ? (parent.options as Record<string, unknown>)
              : {};
          const prompt =
            parent.text ??
            parent.prompt ??
            item.json.chatInput ??
            item.json.text ??
            item.json.message;
          const simulatedResponse =
            lookupItemMock(runtime.mocks, node.name, loopIterationIndex ?? i) ??
            lookupItemMock(
              runtime.mocks,
              subnode.name,
              loopIterationIndex ?? i,
            );
          const subnodeResult = await runtime.integrationRunner.execute(
            subnode,
            {
              ...subnodeParameters,
              ...(prompt === undefined ? {} : { prompt }),
              ...(parentOptions.systemMessage === undefined
                ? {}
                : { systemMessage: parentOptions.systemMessage }),
              tools: (aiSubnodes?.ai_tool ?? []).map((tool) => ({
                name: tool.name,
                type: tool.type,
              })),
              memory: (aiSubnodes?.ai_memory ?? []).map((memory) => ({
                name: memory.name,
                type: memory.type,
              })),
              ...(simulatedResponse === undefined ? {} : { simulatedResponse }),
            },
            item,
          );
          if (subnodeResult) {
            runtime.integrationEffects.push(subnodeResult.effect);
            const parser =
              parent.hasOutputParser === true
                ? aiSubnodes?.ai_outputParser?.[0]
                : undefined;
            const formatted =
              subnodeResult.effect.service === "ai"
                ? formatAiRootOutput(node, subnodeResult.output, parser)
                : subnodeResult.output;
            outputItems.push(...normalizeMockToItems(formatted, i));
            handledBySubnode = true;
            break;
          }
        }
        if (handledBySubnode) continue;
      } catch (cause) {
        return {
          status: "error",
          message: `Local integration emulation failed for node "${node.name}": ${String((cause as Error)?.message ?? cause)}`,
        };
      }
    }

    // Inside a Split In Batches loop body, prefer the loop's own iteration
    // counter over the local within-batch index - see
    // `ExecuteArgs.loopIterationIndex` (same rationale as http-request.ts).
    const mockValue = lookupItemMock(
      runtime.mocks,
      node.name,
      loopIterationIndex ?? i,
    );

    if (mockValue === undefined) {
      const tailored = findNodeTypeMockHint(node.type);
      const description = tailored
        ? `${tailored.description} Resolved node parameters: ${JSON.stringify(resolvedParams)}`
        : `The JSON data this node (type: "${node.type}") would produce. Resolved node parameters: ${JSON.stringify(
            resolvedParams,
          )}. Infer a plausible real response from these parameters. Provide one object or an array of objects to emit multiple items.`;

      return {
        status: "waiting_mock",
        request: {
          nodeName: node.name,
          nodeType: node.type,
          mockKey: node.name,
          reason: `Node type "${node.type}" has no built-in executor in s8n, so it is treated as external I/O and requires a mock`,
          expectedShape: buildMockShapeHint(
            description,
            runtime.suggestedFields,
            tailored?.example,
          ),
        },
      };
    }

    outputItems.push(...normalizeMockToItems(mockValue, i));
  }

  return { status: "success", output: [outputItems] };
}
