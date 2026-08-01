import type { ExpressionScope } from "../expression/context.ts";
import type { Item } from "../schema/item.ts";
import type { WorkflowNode } from "../schema/workflow.ts";

/**
 * Describes IO that a node wants to perform but can't, because s8n mocks all
 * external IO and no matching mock data was supplied. The engine surfaces
 * this back to the caller (typically an AI agent) so it can generate
 * dummy data conforming to `expectedShape` and re-run with `--mocks`.
 */
export interface PendingMockRequest {
  nodeName: string;
  nodeType: string;
  /** Stable key the caller can use in a mocks file to satisfy this request. */
  mockKey: string;
  reason: string;
  expectedShape: unknown;
}

export type NodeExecuteResult =
  | { status: "success"; output: Item[][] }
  | { status: "error"; message: string }
  | { status: "waiting_mock"; request: PendingMockRequest };

export interface MockLookup {
  /** Looks up mock data registered under `mockKey`; undefined if absent. */
  get: (mockKey: string) => unknown | undefined;
}

export interface RuntimeContext {
  workflowName: string;
  workflowId?: string;
  /** Last output items per node name, for `$('NodeName')` and Merge inputs. */
  nodeOutputs: Map<string, Item[]>;
  now?: Date;
  mocks: MockLookup;
  /** Field names (e.g. from `$json.foo` references) seen anywhere in the workflow, used as a hint when requesting mock data. */
  suggestedFields: string[];
  /** True when the caller passed `--input`; data-dependent triggers (e.g. Webhook) use this to decide whether to request a mock. */
  hasExplicitInput: boolean;
  /**
   * Backing store for `$getWorkflowStaticData(type)`, keyed by `type`
   * (`"global"` or a node name for `"node"` scope). Real n8n persists this
   * across executions in the workflow's DB row; s8n only simulates one
   * execution, so each run starts with empty objects - but within that one
   * run, repeated calls (even from different Code nodes) return the same
   * shared object, matching real in-run semantics.
   */
  workflowStaticData: Map<string, Record<string, unknown>>;
}

export interface ExecuteArgs {
  node: WorkflowNode;
  /** Items on the node's first ("main", index 0) input. */
  inputItems: Item[];
  /** All input slots, for nodes (like Merge) that read more than one. */
  inputSlots: Item[][];
  runtime: RuntimeContext;
  /** True when this node has no incoming connections, i.e. it's acting as a workflow entry point. */
  isStartNode: boolean;
  /**
   * Set when this node is running as part of a Split In Batches loop body,
   * to the current batch iteration (0-based) - see `runLoopDriver` in
   * `engine/execute.ts`. Node types that key per-item mocks by index
   * (`#<index>`, e.g. HTTP Request, the generic fallback) should prefer this
   * over their own local within-batch index: with `batchSize: 1`, the local
   * index is always 0 every iteration, so without this every iteration would
   * collide on the same mock key (`<nodeName>#0`) instead of getting its own.
   * For example, three input items would otherwise all request
   * `<nodeName>#0` rather than distinct per-iteration keys.
   *
   * Caveat: this identifies the *batch*, not the item within it. For
   * `batchSize: 1` (the common case that motivated this field) that's the
   * same thing, so per-item mocking works correctly. For `batchSize > 1`,
   * every item within one batch still collides on the same suffixed key -
   * a pre-existing imprecision, not a regression (the old local-index
   * scheme was equally imprecise, just along the other axis: correct within
   * one batch, colliding across batches). Since the *primary*, commonly
   * used mocking path is one shared mock keyed by plain node name (the
   * `#<index>` suffix is an opt-in refinement, and the exact key needed is
   * always echoed back in `PendingMockRequest.mockKey` anyway), this is a
   * narrow edge case, not a blocking one.
   */
  loopIterationIndex?: number;
  /** Builds a per-item expression scope for evaluating `=` parameters. */
  buildScope: (
    item: Item,
    itemIndex: number,
    inputItems: Item[],
  ) => ExpressionScope;
}

export interface NodeExecutor {
  /** n8n-compatible or s8n-native node type identifier, e.g. "n8n-nodes-base.set". */
  type: string;
  execute: (
    args: ExecuteArgs,
  ) => NodeExecuteResult | Promise<NodeExecuteResult>;
}
