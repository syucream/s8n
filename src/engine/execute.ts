import { buildExpressionScope } from "../expression/context.ts";
import { resolveParameterValue } from "../expression/evaluator.ts";
import type { FaultLookup } from "../faults.ts";
import type {
  IntegrationEffect,
  IntegrationRunner,
} from "../integrations/types.ts";
import { extractReferencedJsonFields } from "../mock/field-hints.ts";
import { executeGenericFallback } from "../nodes/builtin/generic-fallback.ts";
import type { NodeRegistry } from "../nodes/registry.ts";
import type {
  ExecuteArgs,
  MockLookup,
  NodeExecuteResult,
  NodeExecutor,
  PendingMockRequest,
  ResolvedRequest,
  ResumeDirective,
  RuntimeContext,
} from "../nodes/types.ts";
import type { Item } from "../schema/item.ts";
import { toItems } from "../schema/item.ts";
import type { Workflow, WorkflowNode } from "../schema/workflow.ts";
import { analyzeGraph } from "./graph.ts";

export interface RunOptions {
  initialInput?: Item[];
  hasExplicitInput: boolean;
  mocks: MockLookup;
  /** Optional deterministic failures applied by HTTP and generic mock nodes. */
  faults?: FaultLookup;
  registry: NodeRegistry;
  now?: Date;
  /**
   * Name of the start node to fire this run. Real n8n only ever activates
   * the one trigger that was actually invoked - workflows very commonly
   * have several alternate entry points (e.g. Manual Trigger *and* Execute
   * Workflow Trigger feeding the same logic so the workflow works both
   * standalone and as a sub-workflow), and only one fires per execution.
   * Required when the workflow has more than one start node; when there's
   * exactly one, it's used automatically.
   */
  startNode?: string;
  /** Explicit local service emulation. External network I/O remains disabled. */
  integrationRunner?: IntegrationRunner;
  /** Explicit reference-to-workflow mapping used for local sub-workflow execution. */
  workflowMap?: ReadonlyMap<string, Workflow>;
  /** Maximum number of nested mapped workflow calls. Defaults to 10. */
  subWorkflowDepthLimit?: number;
  /** Internal reference chain used to detect cycles across recursive runs. */
  subWorkflowReferenceStack?: string[];
  /** Optional Code-node execution boundary. */
  codeExecutionMode?: "in-process" | "vm" | "os" | "auto";
  /** Timeout used by vm Code execution. Defaults to 1000ms. */
  codeTimeoutMs?: number;
  /** Explicitly capture sanitized HTTP request evidence. Disabled by default. */
  captureResolvedRequests?: boolean;
  /** Scenario-provided resume instructions keyed by waiting node name. */
  resumeDirectives?: ReadonlyMap<string, ResumeDirective>;
}

export type NodeTraceStatus =
  | "success"
  | "error"
  | "waiting_mock"
  | "waiting"
  | "skipped_disabled"
  | "skipped_annotation"
  | "skipped_non_main_only"
  | "skipped_alternate_trigger"
  | "skipped_no_data"
  | "pinned"
  | "unreached";

/**
 * Node types with no real inputs/outputs in n8n (canvas-only annotations).
 * These never appear in `connections` in a valid n8n export, so s8n excludes
 * them from the execution graph entirely rather than treating them as a
 * start node that needs mock data.
 */
const NON_EXECUTABLE_NODE_TYPES = new Set(["n8n-nodes-base.stickyNote"]);
const EXECUTE_WORKFLOW_NODE_TYPE = "n8n-nodes-base.executeWorkflow";
const EXECUTE_WORKFLOW_TRIGGER_NODE_TYPE =
  "n8n-nodes-base.executeWorkflowTrigger";
const DEFAULT_SUB_WORKFLOW_DEPTH_LIMIT = 10;

export interface NodeTraceEntry {
  nodeName: string;
  nodeType: string;
  status: NodeTraceStatus;
  inputItemCounts: number[];
  outputItemCounts?: number[];
  error?: string;
  pendingMock?: PendingMockRequest;
  /** Expression-resolved external requests observed locally. Nothing is sent over the network. */
  resolvedRequests?: ResolvedRequest[];
  /** Non-fatal contract mismatches or ambiguous inputs observed for this node run. */
  warnings?: string[];
  /**
   * Machine-readable fidelity caveats for this node run: places where the
   * modeled behavior is known to be narrower than real n8n (e.g. mocked
   * data, single-page pagination mocks). Informational only.
   */
  fidelityNotes?: string[];
  /**
   * Set when this node ran as part of a Split In Batches loop body: which
   * batch iteration (0-based) this entry belongs to. A loop-body node
   * appears once per iteration in `trace`, each with its own `runIndex` -
   * the only place `trace` can contain more than one entry per node name.
   */
  runIndex?: number;
  /** n8n-compatible epoch timestamp for the start of this node run. */
  startTime?: number;
  /** Wall-clock duration of this node run in milliseconds. */
  executionTime?: number;
  /** Monotonic execution order across all node runs in this workflow. */
  executionIndex?: number;
  /** n8n-like status for consumers rendering execution logs. */
  executionStatus?: "success" | "error" | "waiting" | "skipped";
  /** Upstream node runs that supplied this node's main inputs. */
  source?: Array<{
    previousNode: string;
    previousNodeOutput: number;
    previousNodeRun: number;
  }>;
  /** Exact per-output-slot items produced by this run. */
  data?: { main: Item[][] };
  /** Origin IDs for the input items observed by this node, in slot order. */
  inputItemLineage?: string[][];
  /** Origin IDs for the output items produced by this node, in slot order. */
  outputItemLineage?: string[][];
}

/**
 * Observed delivery statistics for one main-pipeline connection.
 *
 * `deliveryCount` records every attempted delivery, including empty output
 * slots. An edge is covered when at least one item crossed it, which makes
 * branch coverage useful for proving that a path carried data while still
 * retaining empty-branch observations in the detailed counters.
 */
export interface EdgeCoverageEntry {
  sourceNode: string;
  sourceOutput: number;
  destinationNode: string;
  destinationInput: number;
  deliveryCount: number;
  itemCount: number;
  covered: boolean;
}

/**
 * Result of driving a Split In Batches loop to completion (or a halt).
 * Deliberately NOT a `NodeExecuteResult` - only `"done"` carries data the
 * caller should propagate downstream; the halted cases must stop the SIB's
 * own branch without propagating anything, matching real n8n halting the
 * *entire* execution when a loop pauses or fails partway through. See
 * `runLoopDriver`'s doc comment.
 */
type LoopDriverOutcome =
  | { kind: "done"; output: Item[][] }
  | { kind: "halted_mock" }
  | { kind: "halted_error" }
  | { kind: "halted_new_error"; message: string };

export interface StartNodeCandidate {
  name: string;
  type: string;
}

export interface SubExecutionSummary {
  callNodeName: string;
  reference: string;
  workflowName: string;
  status: RunResult["status"];
  traceStatusCounts: Partial<Record<NodeTraceStatus, number>>;
  pendingMockCount: number;
  errors: string[];
  nested: SubExecutionSummary[];
  /**
   * The resolved items delivered to the child workflow's Execute Workflow
   * Trigger, bounded to the first 100 so the envelope stays readable.
   * `entryItemCount` is the full count when the input was truncated.
   */
  entryItems?: Item[];
  entryItemCount?: number;
}

export interface RunResult {
  status: "success" | "error" | "waiting" | "needs_mock" | "needs_start_node";
  workflowName: string;
  trace: NodeTraceEntry[];
  nodeOutputs: Record<string, Item[]>;
  pendingMocks: PendingMockRequest[];
  errors: string[];
  warnings?: string[];
  /** Aggregated per-node fidelity caveats (see NodeTraceEntry.fidelityNotes). */
  fidelityNotes?: string[];
  /** Stateful local integration effects that were confirmed by reading emulator state. */
  effects: IntegrationEffect[];
  /** AI-readable evidence for explicitly mapped child workflow executions. */
  subExecutions: SubExecutionSummary[];
  /** Main-pipeline connection deliveries observed during this run. */
  edgeCoverage: EdgeCoverageEntry[];
  /** Fraction of main-pipeline edges that received at least one delivery. */
  branchCoverage: number;
  /** Populated only when status is "needs_start_node": pass one of these names via `startNode`. */
  startNodeCandidates?: StartNodeCandidate[];
}

async function runNodeWithRetry(
  executor: NodeExecutor,
  args: Parameters<NodeExecutor["execute"]>[0],
  node: WorkflowNode,
): Promise<NodeExecuteResult> {
  const maxTries = node.retryOnFail ? Math.max(1, node.maxTries) : 1;
  let lastResult: NodeExecuteResult = {
    status: "error",
    message: "Not executed",
  };

  for (let attempt = 0; attempt < maxTries; attempt++) {
    try {
      lastResult = await executor.execute(args);
    } catch (cause) {
      lastResult = {
        status: "error",
        message: String((cause as Error)?.message ?? cause),
      };
    }
    if (lastResult.status !== "error") return lastResult;
  }
  return lastResult;
}

function extractWorkflowReference(workflowId: unknown): string | undefined {
  if (typeof workflowId === "string" && workflowId.length > 0) {
    return workflowId;
  }
  if (
    workflowId !== null &&
    typeof workflowId === "object" &&
    "value" in workflowId &&
    typeof workflowId.value === "string" &&
    workflowId.value.length > 0
  ) {
    return workflowId.value;
  }
  return undefined;
}

function terminalOutput(workflow: Workflow, result: RunResult): Item[][] {
  const nodesWithMainDestinations = new Set<string>();
  for (const [sourceName, connections] of Object.entries(
    workflow.connections,
  )) {
    if ((connections.main ?? []).some((slot) => (slot?.length ?? 0) > 0)) {
      nodesWithMainDestinations.add(sourceName);
    }
  }

  const output = workflow.nodes.flatMap((node) =>
    nodesWithMainDestinations.has(node.name)
      ? []
      : (result.nodeOutputs[node.name] ?? []),
  );
  return [output];
}

function traceStatusCounts(
  trace: NodeTraceEntry[],
): Partial<Record<NodeTraceStatus, number>> {
  const counts: Partial<Record<NodeTraceStatus, number>> = {};
  for (const entry of trace) {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  }
  return counts;
}

export async function runWorkflow(
  workflow: Workflow,
  options: RunOptions,
): Promise<RunResult> {
  const graph = analyzeGraph(workflow);
  const nodesByName = new Map(workflow.nodes.map((n) => [n.name, n]));
  const suggestedFields = extractReferencedJsonFields(workflow);
  const suggestedFieldsByNode = new Map(
    workflow.nodes.map((node) => [
      node.name,
      extractReferencedJsonFields(workflow, node.name),
    ]),
  );

  const pendingData = new Map<string, Item[][]>();
  const filledSlots = new Map<string, Set<number>>();
  const pendingSources = new Map<
    string,
    Map<number, NonNullable<NodeTraceEntry["source"]>>
  >();
  const nodeOutputs = new Map<string, Item[]>();
  const nodeSlotOutputs = new Map<string, Item[][]>();
  /** Internal provenance is kept out of Item JSON and exposed only in trace. */
  const itemLineage = new WeakMap<object, string[]>();
  const trace: NodeTraceEntry[] = [];
  let executionIndex = 0;
  const pendingMocks: PendingMockRequest[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const fidelityNotes: string[] = [];
  let runWaiting = false;
  const subExecutions: SubExecutionSummary[] = [];
  const edgeCoverage = new Map<string, EdgeCoverageEntry>();
  for (const [sourceNode, connectionTypes] of Object.entries(
    workflow.connections,
  )) {
    for (const [sourceOutput, destinations] of (
      connectionTypes.main ?? []
    ).entries()) {
      for (const destination of destinations) {
        const entry: EdgeCoverageEntry = {
          sourceNode,
          sourceOutput,
          destinationNode: destination.node,
          destinationInput: destination.index,
          deliveryCount: 0,
          itemCount: 0,
          covered: false,
        };
        edgeCoverage.set(
          `${sourceNode}\u0000${sourceOutput}\u0000${destination.node}\u0000${destination.index}`,
          entry,
        );
      }
    }
  }
  for (const node of workflow.nodes) {
    const slots = graph.requiredSlots.get(node.name) ?? 1;
    pendingData.set(
      node.name,
      Array.from({ length: slots }, () => []),
    );
    filledSlots.set(node.name, new Set());
    pendingSources.set(node.name, new Map());
  }

  const isNonExecutable = (name: string) =>
    NON_EXECUTABLE_NODE_TYPES.has(nodesByName.get(name)?.type ?? "") ||
    graph.nonMainOnlyNodes.has(name);

  const executableStartNodes = graph.startNodes.filter(
    (name) => !isNonExecutable(name),
  );

  let activeStartNode: string;
  if (executableStartNodes.length === 1) {
    activeStartNode = executableStartNodes[0] as string;
  } else if (
    executableStartNodes.length > 1 &&
    options.startNode &&
    executableStartNodes.includes(options.startNode)
  ) {
    activeStartNode = options.startNode;
  } else {
    // Either no runnable entry point exists at all (e.g. every node is a
    // sticky note or an AI sub-node wired only via a non-"main" connection),
    // or there are several candidates and the caller didn't disambiguate.
    // Either way, nothing can meaningfully execute - report it explicitly
    // instead of silently returning a "success" where zero nodes ran.
    return {
      status: "needs_start_node",
      workflowName: workflow.name,
      trace: [],
      nodeOutputs: {},
      pendingMocks: [],
      errors:
        executableStartNodes.length === 0
          ? [
              "No runnable start node (a node without incoming connections) was found",
            ]
          : options.startNode
            ? [
                `The specified startNode "${options.startNode}" is not a start node (it has incoming connections)`,
              ]
            : [],
      effects: [],
      subExecutions: [],
      edgeCoverage: [...edgeCoverage.values()],
      branchCoverage: edgeCoverage.size === 0 ? 1 : 0,
      startNodeCandidates: executableStartNodes.map((name) => ({
        name,
        type: nodesByName.get(name)?.type ?? "",
      })),
    };
  }

  const seedInput = options.initialInput ?? toItems([{}]);
  seedInput.forEach((item, index) => {
    itemLineage.set(item, [`input:${index}`]);
  });
  const queue: string[] = [];
  if (activeStartNode) {
    pendingData.get(activeStartNode)?.splice(0, 1, seedInput);
    queue.push(activeStartNode);
  }

  const runtime: RuntimeContext = {
    workflowName: workflow.name,
    workflowId: workflow.id,
    nodeOutputs,
    now: options.now,
    mocks: options.mocks,
    faults: options.faults,
    suggestedFields,
    suggestedFieldsByNode,
    hasExplicitInput: options.hasExplicitInput,
    workflowStaticData: new Map(),
    integrationRunner: options.integrationRunner,
    integrationSubnodes: new Map(),
    integrationEffects: [],
    codeExecutionMode: options.codeExecutionMode,
    codeTimeoutMs: options.codeTimeoutMs,
    captureResolvedRequests: options.captureResolvedRequests,
    resumeDirectives: options.resumeDirectives,
  };
  const aiConnectionTypes = [
    "ai_languageModel",
    "ai_outputParser",
    "ai_tool",
    "ai_memory",
  ] as const;
  for (const [sourceName, connectionTypes] of Object.entries(
    workflow.connections,
  )) {
    const sourceNode = nodesByName.get(sourceName);
    if (!sourceNode) continue;
    for (const connectionType of aiConnectionTypes) {
      for (const slot of connectionTypes[connectionType] ?? []) {
        for (const destination of slot) {
          const connected =
            runtime.integrationSubnodes?.get(destination.node) ?? {};
          const nodes = connected[connectionType] ?? [];
          nodes.push(sourceNode);
          connected[connectionType] = nodes;
          runtime.integrationSubnodes?.set(destination.node, connected);
        }
      }
    }
  }

  const executed = new Set<string>();

  for (const node of workflow.nodes) {
    const isStickyNote = NON_EXECUTABLE_NODE_TYPES.has(node.type);
    const isNonMainOnly = graph.nonMainOnlyNodes.has(node.name);
    if (isStickyNote || isNonMainOnly) {
      executed.add(node.name);
      trace.push({
        nodeName: node.name,
        nodeType: node.type,
        status: isStickyNote ? "skipped_annotation" : "skipped_non_main_only",
        inputItemCounts: [],
      });
    } else if (
      executableStartNodes.includes(node.name) &&
      node.name !== activeStartNode
    ) {
      executed.add(node.name);
      trace.push({
        nodeName: node.name,
        nodeType: node.type,
        status: "skipped_alternate_trigger",
        inputItemCounts: [],
      });
    }
  }

  const MAX_LOOP_ITERATIONS = 10_000;

  function sourcesForNode(
    nodeName: string,
  ): NonNullable<NodeTraceEntry["source"]> {
    return [...(pendingSources.get(nodeName)?.values() ?? [])].flat();
  }

  function cloneMainData(output: Item[][]): Item[][] {
    return structuredClone(output);
  }

  function inputLineage(inputSlots: Item[][]): string[][] {
    return inputSlots.flat().map((item) => itemLineage.get(item) ?? []);
  }

  function jsonContains(
    candidate: Record<string, unknown>,
    output: Record<string, unknown>,
  ): boolean {
    return Object.entries(candidate).every(
      ([key, value]) => JSON.stringify(output[key]) === JSON.stringify(value),
    );
  }

  /**
   * Assigns provenance to executor-created items without adding internal
   * fields to the n8n-compatible Item JSON. Existing item references retain
   * their lineage; pairedItem is used for normal one-to-one transforms, while
   * a cardinality reduction with no unambiguous source is conservatively
   * attributed to every input item.
   */
  function outputLineage(
    nodeName: string,
    inputSlots: Item[][],
    output: Item[][],
    runIndex?: number,
  ): string[][] {
    const inputs = inputSlots.flat();
    const outputs = output.flat();
    const inputCount = inputs.length;
    const outputCount = outputs.length;
    return outputs.map((item, outputIndex) => {
      const known = itemLineage.get(item);
      if (known) return known;

      const pairedIndex = item.pairedItem?.item;
      const matchingInputs = inputs.filter((candidate) =>
        jsonContains(candidate.json, item.json),
      );
      let origins = [
        ...new Set(
          matchingInputs.flatMap(
            (candidate) => itemLineage.get(candidate) ?? [],
          ),
        ),
      ];
      if (origins.length === 0 && pairedIndex !== undefined) {
        const source = inputSlots[0]?.[pairedIndex] ?? inputs[pairedIndex];
        origins = source ? (itemLineage.get(source) ?? []) : [];
      }
      if (
        matchingInputs.length === 0 &&
        outputCount < inputCount &&
        inputCount > 1
      ) {
        origins = [
          ...new Set(
            inputs.flatMap((candidate) => itemLineage.get(candidate) ?? []),
          ),
        ];
      }
      if (origins.length === 0) {
        origins = [`generated:${nodeName}:${runIndex ?? 0}:${outputIndex}`];
      }
      itemLineage.set(item, origins);
      return origins;
    });
  }

  async function executeMappedSubWorkflow(
    node: WorkflowNode,
    inputItems: Item[],
    buildScope: ExecuteArgs["buildScope"],
  ): Promise<NodeExecuteResult> {
    const scopeItems = inputItems.length > 0 ? inputItems : toItems([{}]);
    let parameters: Record<string, unknown>;
    try {
      parameters = resolveParameterValue(
        node.parameters,
        buildScope(scopeItems[0] as Item, 0, scopeItems),
      ) as Record<string, unknown>;
    } catch (cause) {
      return {
        status: "error",
        message: `Failed to evaluate sub-workflow parameters: ${String((cause as Error)?.message ?? cause)}`,
      };
    }

    const source = parameters.source ?? "database";
    if (source !== "database") {
      return {
        status: "error",
        message: `Unsupported Execute Workflow source "${String(source)}"; mapped execution supports only the default "database" source`,
      };
    }

    const mode = parameters.mode ?? "once";
    if (mode !== "once") {
      return {
        status: "error",
        message: `Unsupported Execute Workflow mode "${String(mode)}"; mapped execution supports only the default "once" mode`,
      };
    }

    const executionOptions =
      parameters.options !== null && typeof parameters.options === "object"
        ? (parameters.options as Record<string, unknown>)
        : {};
    const waitsForCompletion =
      executionOptions.waitForSubWorkflow ??
      parameters.waitForSubWorkflowCompletion ??
      true;
    if (waitsForCompletion !== true) {
      return {
        status: "error",
        message:
          "Unsupported Execute Workflow asynchronous mode; mapped execution requires waitForSubWorkflow to be true",
      };
    }

    let childInput = inputItems;
    const rawWorkflowInputs = node.parameters.workflowInputs;
    if (rawWorkflowInputs !== undefined) {
      if (
        rawWorkflowInputs === null ||
        typeof rawWorkflowInputs !== "object" ||
        Array.isArray(rawWorkflowInputs)
      ) {
        return {
          status: "error",
          message:
            "Unsupported Execute Workflow workflowInputs value; expected an input-mapping object",
        };
      }
      const workflowInputs = rawWorkflowInputs as Record<string, unknown>;
      const mappingMode = workflowInputs.mappingMode ?? "defineBelow";
      if (mappingMode !== "defineBelow") {
        return {
          status: "error",
          message: `Unsupported Execute Workflow input mapping mode "${String(mappingMode)}"; mapped execution supports only "defineBelow"`,
        };
      }
      if (workflowInputs.attemptToConvertTypes === true) {
        return {
          status: "error",
          message:
            "Unsupported Execute Workflow input conversion; attemptToConvertTypes must be false",
        };
      }

      const rawValues = workflowInputs.value;
      if (rawValues !== undefined) {
        if (
          rawValues === null ||
          typeof rawValues !== "object" ||
          Array.isArray(rawValues)
        ) {
          return {
            status: "error",
            message:
              "Unsupported Execute Workflow workflowInputs.value; expected an object",
          };
        }

        const stringifyFields = workflowInputs.convertFieldsToString === true;
        const sourceItems = inputItems.length > 0 ? inputItems : toItems([{}]);
        const mappedValues: Record<string, unknown>[] = [];
        for (const [itemIndex, item] of sourceItems.entries()) {
          let mapped: unknown;
          try {
            mapped = resolveParameterValue(
              rawValues,
              buildScope(item, itemIndex, sourceItems),
            );
          } catch (cause) {
            return {
              status: "error",
              message: `Failed to evaluate workflowInputs.value for input item ${itemIndex}: ${String((cause as Error)?.message ?? cause)}`,
            };
          }
          if (mapped === null || typeof mapped !== "object") {
            return {
              status: "error",
              message: `workflowInputs.value resolved to a non-object for input item ${itemIndex}`,
            };
          }
          const mappedRecord = mapped as Record<string, unknown>;
          mappedValues.push(
            stringifyFields
              ? Object.fromEntries(
                  Object.entries(mappedRecord).map(([key, value]) => [
                    key,
                    value === null || typeof value === "object"
                      ? value
                      : String(value),
                  ]),
                )
              : mappedRecord,
          );
        }
        childInput = toItems(mappedValues);
      }
    }

    const reference = extractWorkflowReference(parameters.workflowId);
    if (!reference) {
      return {
        status: "error",
        message:
          "Execute Workflow requires workflowId to be a non-empty string or a resource locator with a string value",
      };
    }

    const childWorkflow = options.workflowMap?.get(reference);
    if (!childWorkflow) {
      return {
        status: "error",
        message: `Workflow reference "${reference}" is not present in the explicit workflow map`,
      };
    }

    const referenceStack = options.subWorkflowReferenceStack ?? [];
    if (referenceStack.includes(reference)) {
      return {
        status: "error",
        message: `Sub-workflow cycle detected: ${[...referenceStack, reference].join(" -> ")}`,
      };
    }

    const depthLimit =
      options.subWorkflowDepthLimit ?? DEFAULT_SUB_WORKFLOW_DEPTH_LIMIT;
    if (referenceStack.length >= depthLimit) {
      return {
        status: "error",
        message: `Sub-workflow depth limit (${depthLimit}) exceeded: ${[...referenceStack, reference].join(" -> ")}`,
      };
    }

    const triggerNodes = childWorkflow.nodes.filter(
      (candidate) => candidate.type === EXECUTE_WORKFLOW_TRIGGER_NODE_TYPE,
    );
    if (triggerNodes.length !== 1) {
      return {
        status: "error",
        message: `Mapped workflow "${reference}" must contain exactly one Execute Workflow Trigger; found ${triggerNodes.length}`,
      };
    }

    const mockPrefix = `${node.name}::`;
    const childResult = await runWorkflow(childWorkflow, {
      initialInput: childInput,
      hasExplicitInput: true,
      mocks: {
        get: (mockKey) => options.mocks.get(`${mockPrefix}${mockKey}`),
      },
      registry: options.registry,
      now: options.now,
      startNode: triggerNodes[0]?.name,
      integrationRunner: options.integrationRunner,
      workflowMap: options.workflowMap,
      subWorkflowDepthLimit: depthLimit,
      subWorkflowReferenceStack: [...referenceStack, reference],
      resumeDirectives: options.resumeDirectives,
    });

    subExecutions.push({
      callNodeName: node.name,
      reference,
      workflowName: childWorkflow.name,
      status: childResult.status,
      traceStatusCounts: traceStatusCounts(childResult.trace),
      pendingMockCount: childResult.pendingMocks.length,
      errors: [...childResult.errors],
      nested: childResult.subExecutions,
      entryItems: childInput.slice(0, 100),
      ...(childInput.length > 100 ? { entryItemCount: childInput.length } : {}),
    });

    runtime.integrationEffects.push(...childResult.effects);

    if (childResult.status === "needs_mock") {
      const requests = childResult.pendingMocks.map((request) => ({
        ...request,
        mockKey: `${mockPrefix}${request.mockKey}`,
        reason: `Sub-workflow "${reference}" called by "${node.name}": ${request.reason}`,
      }));
      const first = requests[0];
      if (!first) {
        return {
          status: "error",
          message: `Sub-workflow "${reference}" reported needs_mock without a pending mock request`,
        };
      }
      return {
        status: "waiting_mock",
        request: first,
        ...(requests.length > 1
          ? { additionalRequests: requests.slice(1) }
          : {}),
      };
    }

    if (childResult.status === "waiting") {
      return {
        status: "waiting",
        message: `Sub-workflow "${reference}" is waiting and no resume directive resolved it`,
      };
    }

    if (childResult.status !== "success") {
      return {
        status: "error",
        message: `Sub-workflow "${reference}" failed: ${childResult.errors.join("; ") || childResult.status}`,
      };
    }

    return {
      status: "success",
      output: terminalOutput(childWorkflow, childResult),
    };
  }

  /**
   * Runs the full dequeue-time handling for one node: disabled/pinned/
   * empty-input short-circuits, then either a normal executor call or (for a
   * detected Split In Batches loop) `runLoopDriver`, then applies the result
   * (trace + nodeOutputs/nodeSlotOutputs + propagate). Shared by the main
   * queue loop and `drainBodyQueue` so loop-body nodes get identical
   * disabled/pinned/retry/continueOnFail/error semantics to any other node.
   */
  async function processNode(nodeName: string, runIndex?: number) {
    const node = nodesByName.get(nodeName);
    if (!node) return;

    const startTime = Date.now();
    const performanceStart = performance.now();
    const pushRunTrace = (
      entry: Omit<
        NodeTraceEntry,
        | "startTime"
        | "executionTime"
        | "executionIndex"
        | "executionStatus"
        | "source"
        | "data"
      >,
      output?: Item[][],
    ) => {
      const executionStatus: NonNullable<NodeTraceEntry["executionStatus"]> =
        entry.status === "success" || entry.status === "pinned"
          ? "success"
          : entry.status === "error"
            ? "error"
            : entry.status === "waiting_mock"
              ? "waiting"
              : "skipped";
      const outputItemLineage = output
        ? outputLineage(nodeName, inputSlots, output, runIndex)
        : undefined;
      trace.push({
        ...entry,
        startTime,
        executionTime: Math.max(
          0,
          Math.round(performance.now() - performanceStart),
        ),
        executionIndex: executionIndex++,
        executionStatus,
        source: sourcesForNode(nodeName),
        inputItemLineage: inputLineage(inputSlots),
        ...(outputItemLineage === undefined ? {} : { outputItemLineage }),
        ...(output ? { data: { main: cloneMainData(output) } } : {}),
      });
    };

    const inputSlots = pendingData.get(nodeName) ?? [[]];
    const inputItems = inputSlots[0] ?? [];

    if (node.disabled) {
      nodeOutputs.set(nodeName, inputItems);
      nodeSlotOutputs.set(nodeName, [inputItems]);
      pushRunTrace(
        {
          nodeName,
          nodeType: node.type,
          status: "skipped_disabled",
          inputItemCounts: inputSlots.map((s) => s.length),
          outputItemCounts: [inputItems.length],
          ...(runIndex !== undefined ? { runIndex } : {}),
        },
        [inputItems],
      );
      propagate(nodeName, [inputItems]);
      return;
    }

    const pinned = workflow.pinData?.[nodeName];
    if (pinned) {
      const pinnedItems = toItems(pinned);
      nodeOutputs.set(nodeName, pinnedItems);
      nodeSlotOutputs.set(nodeName, [pinnedItems]);
      pushRunTrace(
        {
          nodeName,
          nodeType: node.type,
          status: "pinned",
          inputItemCounts: inputSlots.map((s) => s.length),
          outputItemCounts: [pinnedItems.length],
          ...(runIndex !== undefined ? { runIndex } : {}),
        },
        [pinnedItems],
      );
      propagate(nodeName, [pinnedItems]);
      return;
    }

    // Real n8n skips a node entirely when every one of its inputs delivered
    // zero items (verified: `incomingConnectionIsEmpty` /
    // `getConnectionInputData` in workflow-execute.ts, under the modern
    // `executionOrder: "v1"` default) - unless `alwaysOutputData` is set.
    // Without this, an If/Switch branch that legitimately has no items
    // would still fire its downstream nodes (asking for mocks that would
    // never actually be needed in real n8n). This does NOT apply to the
    // active start/trigger node itself: real n8n's empty-check only covers
    // nodes fed via `getConnectionInputData` (i.e. nodes with incoming
    // connections) - a trigger has none, so it always "runs" even with a
    // zero-item `--input`, exactly like a webhook call with an empty body.
    const totalInputItems = inputSlots.reduce(
      (sum, slot) => sum + slot.length,
      0,
    );
    if (
      totalInputItems === 0 &&
      !node.alwaysOutputData &&
      nodeName !== activeStartNode
    ) {
      pushRunTrace({
        nodeName,
        nodeType: node.type,
        status: "skipped_no_data",
        inputItemCounts: inputSlots.map((s) => s.length),
        ...(runIndex !== undefined ? { runIndex } : {}),
      });
      return;
    }

    const buildScope = (item: Item, itemIndex: number, items: Item[]) =>
      buildExpressionScope({
        currentItem: item,
        itemIndex,
        inputItems: items,
        currentNodeName: nodeName,
        workflowName: workflow.name,
        workflowId: workflow.id,
        nodeOutputs,
        nodeSlotOutputs,
        connections: workflow.connections,
        now: options.now,
        timezone: workflow.settings.timezone,
      });

    // Real n8n runs an `executeOnce` node a single time with only the first
    // item it received ("the node executes only once, with data from the
    // first item"). Trace inputItemCounts keep the true delivered counts so
    // fan-in stays visible in the evidence.
    const executeInputSlots = node.executeOnce
      ? inputSlots.map((slot) => slot.slice(0, 1))
      : inputSlots;
    const executeInputItems = executeInputSlots[0] ?? [];

    let result: NodeExecuteResult;
    if (graph.loops.has(nodeName)) {
      const loopOutcome = await runLoopDriver(nodeName, node, inputItems);
      if (loopOutcome.kind !== "done") {
        // The loop paused (waiting_mock) or failed partway through (a body
        // node's own uncaught error, or the iteration-cap safety cutoff).
        // Real n8n halts the *entire* execution at that point - nothing
        // downstream of a paused/failed loop ever runs. Record a trace
        // entry for the SIB itself and stop here WITHOUT propagating;
        // do NOT re-push to `errors`/`pendingMocks` for the
        // "waiting_mock"/"error" cases, since the real failure/mock
        // request was already recorded against the specific body node that
        // caused it - only the iteration-cap cutoff is a genuinely new
        // failure attributable to the SIB itself.
        if (loopOutcome.kind === "halted_new_error") {
          errors.push(`[${nodeName}] ${loopOutcome.message}`);
        }
        pushRunTrace({
          nodeName,
          nodeType: node.type,
          status: loopOutcome.kind === "halted_mock" ? "waiting_mock" : "error",
          inputItemCounts: inputSlots.map((s) => s.length),
          ...(loopOutcome.kind === "halted_new_error"
            ? { error: loopOutcome.message }
            : {}),
          ...(runIndex !== undefined ? { runIndex } : {}),
        });
        return;
      }
      result = { status: "success", output: loopOutcome.output };
    } else if (
      node.type === EXECUTE_WORKFLOW_NODE_TYPE &&
      options.workflowMap
    ) {
      result = await executeMappedSubWorkflow(
        node,
        executeInputItems,
        buildScope,
      );
    } else {
      // Any node type s8n doesn't explicitly implement is treated as
      // unmodeled external IO and mocked the same way as HTTP Request,
      // rather than failing the whole run - see generic-fallback.ts.
      const executor: NodeExecutor = options.registry.get(node.type) ?? {
        type: node.type,
        execute: executeGenericFallback,
      };

      result = await runNodeWithRetry(
        executor,
        {
          node,
          inputItems: executeInputItems,
          inputSlots: executeInputSlots,
          runtime,
          buildScope,
          isStartNode: nodeName === activeStartNode,
          ...(runIndex !== undefined ? { loopIterationIndex: runIndex } : {}),
        },
        node,
      );
    }

    if (result.status === "success") {
      const output =
        node.alwaysOutputData &&
        result.output.every((slot) => slot.length === 0)
          ? [[{ json: {} }]]
          : result.output;
      const nodeWarnings = result.warnings ?? [];
      warnings.push(
        ...nodeWarnings.map((warning) => `[${nodeName}] ${warning}`),
      );
      const nodeFidelityNotes = result.fidelityNotes ?? [];
      fidelityNotes.push(
        ...nodeFidelityNotes.map((note) => `[${nodeName}] ${note}`),
      );
      nodeOutputs.set(nodeName, output.flat());
      nodeSlotOutputs.set(nodeName, output);
      pushRunTrace(
        {
          nodeName,
          nodeType: node.type,
          status: "success",
          inputItemCounts: inputSlots.map((s) => s.length),
          outputItemCounts: output.map((slot) => slot.length),
          ...(result.resolvedRequests
            ? { resolvedRequests: result.resolvedRequests }
            : {}),
          ...(nodeWarnings.length > 0 ? { warnings: nodeWarnings } : {}),
          ...(nodeFidelityNotes.length > 0
            ? { fidelityNotes: nodeFidelityNotes }
            : {}),
          ...(runIndex !== undefined ? { runIndex } : {}),
        },
        output,
      );
      propagate(nodeName, output);
    } else if (result.status === "waiting_mock") {
      pendingMocks.push(result.request, ...(result.additionalRequests ?? []));
      pushRunTrace({
        nodeName,
        nodeType: node.type,
        status: "waiting_mock",
        inputItemCounts: inputSlots.map((s) => s.length),
        pendingMock: result.request,
        ...(runIndex !== undefined ? { runIndex } : {}),
      });
      // Execution along this branch pauses here; downstream nodes are simply never reached.
    } else if (result.status === "waiting") {
      // A waiting node (Wait / wait-for-approval) with no scenario resume
      // directive halts its branch. Real n8n would pause until resumed; s8n
      // reports the incomplete run instead of hanging or fabricating data.
      runWaiting = true;
      pushRunTrace({
        nodeName,
        nodeType: node.type,
        status: "waiting",
        inputItemCounts: inputSlots.map((s) => s.length),
        error: result.message,
        ...(runIndex !== undefined ? { runIndex } : {}),
      });
    } else if (
      node.continueOnFail ||
      node.onError === "continueRegularOutput" ||
      node.onError === "continueErrorOutput"
    ) {
      // Real n8n passes the node's own (slot-0) input items through
      // unchanged on a whole-node throw when continuing past the error -
      // verified against `continuesOnError()` /
      // `nodeSuccessData = [executionData.data.main[0]]` in
      // `workflow-execute.ts`. It does NOT emit an empty output.
      nodeOutputs.set(nodeName, inputItems);
      nodeSlotOutputs.set(nodeName, [inputItems]);
      pushRunTrace(
        {
          nodeName,
          nodeType: node.type,
          status: "error",
          inputItemCounts: inputSlots.map((s) => s.length),
          outputItemCounts: [inputItems.length],
          error: result.message,
          ...(runIndex !== undefined ? { runIndex } : {}),
        },
        [inputItems],
      );
      propagate(nodeName, [inputItems]);
    } else {
      errors.push(`[${nodeName}] ${result.message}`);
      pushRunTrace({
        nodeName,
        nodeType: node.type,
        status: "error",
        inputItemCounts: inputSlots.map((s) => s.length),
        error: result.message,
        ...(runIndex !== undefined ? { runIndex } : {}),
      });
    }
  }

  /**
   * Drives one Split In Batches node's loop to completion: real n8n
   * re-executes the loop body once per batch (verified against
   * `SplitInBatchesV3.node.ts` - the node itself has no iteration logic, the
   * *engine* re-invokes it via the `loop` output's back-edge until the batch
   * queue is empty). s8n reproduces this by resetting and re-running just
   * the loop-body node set (`graph.loops`) once per batch, reusing the same
   * `processNode`/`propagate` machinery as the main queue so disabled/
   * pinned/continueOnFail/waiting_mock all behave identically inside a loop.
   *
   * Only a body node's *in-loop* slots (`loopInfo.internalSlots` - fed by
   * another body node or by the SIB's own `loop` output) are cleared each
   * iteration. A slot fed exclusively by a source outside the loop (a
   * one-time upstream node that only ever fires once) keeps whatever it
   * already received, instead of being wiped and starved from iteration 2
   * onward - a real divergence an earlier version of this driver had.
   *
   * The SIB node itself is only ever marked `executed` once (by the caller),
   * so a body node's connection back to the SIB is a harmless no-op propagate
   * (the `!executed.has()` guard blocks re-queuing it) rather than a real
   * re-execution - this node's own "iteration" is entirely internal to this
   * function, invisible to the outer queue.
   *
   * `done` receives the full original item list (not whatever the body
   * produced) because real SplitInBatches ignores the back-edge's data and
   * hands out `context.processedItems`, which is just the concatenation of
   * the batches it originally sent out - not the transformed data from the
   * consuming loop body.
   *
   * A batch that raises an uncaught (non-continued) error, or asks for a
   * mock, stops further iterations immediately - matching real n8n, where an
   * uncaught error halts the whole execution rather than continuing to the
   * next batch, and matching the main queue's own "a waiting_mock branch is
   * simply never resumed" behavior. Critically, the caller (`processNode`)
   * must NOT propagate anything downstream of the SIB in that case either -
   * real n8n halts the *entire* execution, so nothing past a paused/failed
   * loop ever runs. `LoopDriverOutcome` makes that distinction explicit
   * (`"done"` is the only case with real output data to propagate).
   *
   * Known limitations (documented, not fixed): nested loops and
   * `pairedItem` tracking through iterations. Mock-key collisions can occur
   * whenever the same node executes in multiple loop iterations; they are
   * avoided via `loopIterationIndex` in `ExecuteArgs` (see
   * `http-request.ts`/`generic-fallback.ts`).
   */
  async function runLoopDriver(
    sibName: string,
    node: WorkflowNode,
    initialItems: Item[],
  ): Promise<LoopDriverOutcome> {
    const loopInfo = graph.loops.get(sibName);
    if (!loopInfo) return { kind: "done", output: [initialItems, []] };

    const batchScope = buildExpressionScope({
      currentItem: initialItems[0] ?? { json: {} },
      itemIndex: 0,
      inputItems: initialItems,
      currentNodeName: sibName,
      workflowName: runtime.workflowName,
      workflowId: runtime.workflowId,
      nodeOutputs,
      nodeSlotOutputs,
      connections: workflow.connections,
      now: options.now,
      timezone: workflow.settings.timezone,
    });
    const resolvedParams = resolveParameterValue(
      node.parameters,
      batchScope,
    ) as Record<string, unknown>;
    const rawBatchSize = Number(resolvedParams.batchSize);
    const batchSize =
      Number.isFinite(rawBatchSize) && rawBatchSize > 0
        ? Math.floor(rawBatchSize)
        : 1;

    const remaining = [...initialItems];
    let iteration = 0;
    let haltedByError = false;
    let haltedByMock = false;
    // Body nodes get `executed.delete`d unconditionally at the top of every
    // iteration, but a conditional branch not taken in the *final*
    // iteration would otherwise leave that node absent from `executed` at
    // the end of the whole run, wrongly flagged "unreached" by the final
    // sweep despite having real success/error trace entries from an
    // earlier iteration. Track everything that ran at least once and
    // restore it below.
    const everExecutedBodyNodes = new Set<string>();
    while (remaining.length > 0 && iteration < MAX_LOOP_ITERATIONS) {
      const batch = remaining.splice(0, batchSize);

      for (const bodyName of loopInfo.bodyNodes) {
        executed.delete(bodyName);
        const slots = graph.requiredSlots.get(bodyName) ?? 1;
        const internal = loopInfo.internalSlots.get(bodyName) ?? new Set();
        const previousSlots = pendingData.get(bodyName) ?? [];
        const previousFilled = filledSlots.get(bodyName) ?? new Set();
        const previousSources = pendingSources.get(bodyName) ?? new Map();
        const nextSlots: Item[][] = [];
        const nextFilled = new Set<number>();
        const nextSources = new Map<
          number,
          NonNullable<NodeTraceEntry["source"]>
        >();
        for (let slotIndex = 0; slotIndex < slots; slotIndex++) {
          if (internal.has(slotIndex)) {
            nextSlots.push([]);
          } else {
            // Not part of the cycle: preserve whatever a one-time external
            // source already delivered instead of wiping it.
            nextSlots.push(previousSlots[slotIndex] ?? []);
            if (previousFilled.has(slotIndex)) nextFilled.add(slotIndex);
            const sources = previousSources.get(slotIndex);
            if (sources) nextSources.set(slotIndex, sources);
          }
        }
        pendingData.set(bodyName, nextSlots);
        filledSlots.set(bodyName, nextFilled);
        pendingSources.set(bodyName, nextSources);
      }
      // The SIB's own input slot only ever receives harmless no-op
      // deliveries from body nodes' back-edges (never consumed, since the
      // SIB is already `executed` and never re-queued) - reset it each
      // iteration too, rather than letting it grow unbounded over
      // potentially thousands of iterations.
      pendingData.set(sibName, [[]]);
      filledSlots.set(sibName, new Set());
      pendingSources.set(sibName, new Map());

      // So that `$('SIB').item`/`.all()` resolve to *this* batch while the
      // body runs (real n8n's per-item linking sees the current loop batch,
      // not the eventual `done` payload) - overwritten below once the loop
      // finishes and the SIB's own real result (done=all items) is applied.
      nodeOutputs.set(sibName, batch);
      nodeSlotOutputs.set(sibName, [[], batch]);

      const errorsBefore = errors.length;
      const pendingMocksBefore = pendingMocks.length;

      // Only seed the `loop` output (slot 1) - NOT `propagate(sibName, [[],
      // batch])`, which would also touch slot 0 (`done`)'s destinations
      // with an empty array and prematurely queue post-loop nodes before
      // the loop has actually finished. See `deliverToSlot`'s doc comment.
      deliverToSlot(sibName, 1, batch);
      await drainBodyQueue(loopInfo.bodyNodes, iteration);
      iteration++;

      for (const bodyName of loopInfo.bodyNodes) {
        if (executed.has(bodyName)) everExecutedBodyNodes.add(bodyName);
      }

      if (errors.length > errorsBefore) {
        haltedByError = true;
        break;
      }
      if (pendingMocks.length > pendingMocksBefore) {
        haltedByMock = true;
        break;
      }
    }

    // Restore `executed` for every body node that ran in at least one
    // iteration, even if the final iteration's branching didn't reach it -
    // see the comment on `everExecutedBodyNodes` above.
    for (const bodyName of everExecutedBodyNodes) executed.add(bodyName);

    if (haltedByError) {
      // The actual error was already recorded against the specific body
      // node that threw (its own `processNode` call pushed to `errors` and
      // `trace`) - this is a pure "stop propagating" signal, not a new
      // failure to report again.
      return { kind: "halted_error" };
    }
    if (haltedByMock) {
      // Likewise already recorded against the specific body node that
      // requested it - just stop.
      return { kind: "halted_mock" };
    }
    if (remaining.length > 0) {
      // Unlike the two cases above, nothing else has recorded this failure
      // yet - the iteration-cap cutoff is attributable to the SIB/driver
      // itself, not any specific body node.
      return {
        kind: "halted_new_error",
        message: `Split In Batches "${sibName}" stopped after reaching the ${MAX_LOOP_ITERATIONS}-iteration limit; ${remaining.length} item(s) remain unprocessed`,
      };
    }

    return { kind: "done", output: [initialItems, []] };
  }

  /**
   * Processes only `bodyNodes` entries out of the shared `queue`, in
   * whatever order `propagate` enqueued them, until none remain queued.
   * Anything else `propagate` happens to queue (a stray edge leaving the
   * loop body) is left in `queue` for the outer loop to pick up once the
   * whole loop finishes, rather than being drained here.
   */
  async function drainBodyQueue(bodyNodes: Set<string>, runIndex: number) {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < queue.length; i++) {
        const name = queue[i] as string;
        if (bodyNodes.has(name) && !executed.has(name)) {
          queue.splice(i, 1);
          executed.add(name);
          await processNode(name, runIndex);
          progressed = true;
          break;
        }
      }
    }
  }

  while (queue.length > 0) {
    const nodeName = queue.shift() as string;
    if (executed.has(nodeName)) continue;
    executed.add(nodeName);
    await processNode(nodeName);
  }

  /**
   * Delivers `items` to every destination of one specific output slot,
   * queuing a destination once all its required slots have received at
   * least one delivery (see `propagate`'s doc comment for the "OR across
   * sources" rationale). Factored out of `propagate` so `runLoopDriver` can
   * seed just the `loop` output (slot 1) each iteration WITHOUT also
   * touching the `done` output (slot 0)'s destinations - calling `propagate`
   * with `[[], batch]` would iterate *both* slots, and even an empty `[]`
   * array for slot 0 still marks its destinations' slot as "filled" and
   * queues them (this function's own filled/queue bookkeeping doesn't
   * distinguish "delivered zero items" from "never delivered to") - which
   * would prematurely queue post-loop nodes with zero real data before the
   * loop has actually finished, real n8n's `done` firing before every
   * batch is processed.
   */
  function deliverToSlot(
    sourceName: string,
    outputIndex: number,
    items: Item[],
  ) {
    const mainConnections = workflow.connections[sourceName]?.main ?? [];
    const destinations = mainConnections[outputIndex] ?? [];
    for (const destination of destinations) {
      const coverage = edgeCoverage.get(
        `${sourceName}\u0000${outputIndex}\u0000${destination.node}\u0000${destination.index}`,
      );
      if (coverage) {
        coverage.deliveryCount += 1;
        coverage.itemCount += items.length;
        coverage.covered = coverage.itemCount > 0;
      }
      const destSlots = pendingData.get(destination.node);
      if (!destSlots) continue;
      destSlots[destination.index] = [
        ...(destSlots[destination.index] ?? []),
        ...items,
      ];
      filledSlots.get(destination.node)?.add(destination.index);
      const sourceRuns = trace.filter(
        (entry) =>
          entry.nodeName === sourceName && entry.executionIndex !== undefined,
      ).length;
      const destinationSources = pendingSources.get(destination.node);
      const slotSources = destinationSources?.get(destination.index) ?? [];
      const source = {
        previousNode: sourceName,
        previousNodeOutput: outputIndex,
        previousNodeRun: Math.max(0, sourceRuns - 1),
      };
      if (
        !slotSources.some(
          (existing) =>
            existing.previousNode === source.previousNode &&
            existing.previousNodeOutput === source.previousNodeOutput &&
            existing.previousNodeRun === source.previousNodeRun,
        )
      ) {
        destinationSources?.set(destination.index, [...slotSources, source]);
      }

      const needed = graph.requiredSlots.get(destination.node) ?? 1;
      const filled = filledSlots.get(destination.node)?.size ?? 0;
      if (
        filled >= needed &&
        !executed.has(destination.node) &&
        !queue.includes(destination.node)
      ) {
        queue.push(destination.node);
      }
    }
  }

  /**
   * Delivers a source node's output to each connected destination slot and
   * queues the destination once *every* required slot index has received at
   * least one delivery. Multiple sources feeding the *same* slot (a common
   * branch-reconvergence pattern with no explicit Merge node) only need one
   * of them to fire - this mirrors real n8n, where waiting for literally
   * every connected source would deadlock whenever an alternate path is
   * legitimately never taken (e.g. an If's untaken branch, or a workflow's
   * other, unused trigger).
   */
  function propagate(sourceName: string, output: Item[][]) {
    output.forEach((items, outputIndex) => {
      deliverToSlot(sourceName, outputIndex, items);
    });
  }

  for (const node of workflow.nodes) {
    if (!executed.has(node.name)) {
      trace.push({
        nodeName: node.name,
        nodeType: node.type,
        status: "unreached",
        inputItemCounts: [],
      });
    }
  }

  const status: RunResult["status"] =
    errors.length > 0
      ? "error"
      : runWaiting
        ? "waiting"
        : pendingMocks.length > 0
          ? "needs_mock"
          : "success";

  return {
    status,
    workflowName: workflow.name,
    trace,
    nodeOutputs: Object.fromEntries(nodeOutputs),
    pendingMocks,
    errors,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(fidelityNotes.length > 0 ? { fidelityNotes } : {}),
    effects: runtime.integrationEffects,
    subExecutions,
    edgeCoverage: [...edgeCoverage.values()],
    branchCoverage:
      edgeCoverage.size === 0
        ? 1
        : [...edgeCoverage.values()].filter((edge) => edge.covered).length /
          edgeCoverage.size,
  };
}
