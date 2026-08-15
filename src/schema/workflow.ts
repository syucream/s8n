import { z } from "zod";

/**
 * Workflow JSON schema for s8n.
 *
 * This is an original, independent schema inspired by the general shape of
 * node-based automation tools (nodes + connections + parameters). It is not
 * copied from any third-party codebase and intentionally covers only the
 * subset of concepts s8n needs to simulate execution locally.
 */

export const nodePositionSchema = z.tuple([z.number(), z.number()]);

export const credentialRefSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
});

export const credentialValueSchema = z.union([credentialRefSchema, z.string()]);

export const workflowNodeSchema = z.object({
  // Older, still-published n8n community templates can predate node IDs.
  id: z.string().default(""),
  name: z.string(),
  type: z.string(),
  typeVersion: z.number().default(1),
  position: nodePositionSchema.default([0, 0]),
  parameters: z.record(z.string(), z.unknown()).default({}),
  credentials: z.record(z.string(), credentialValueSchema).optional(),
  disabled: z.boolean().default(false),
  notes: z.string().optional(),
  continueOnFail: z.boolean().default(false),
  /**
   * Real n8n (INode.onError): the modern replacement for continueOnFail.
   * `'stopWorkflow'` (or unset) fails the run; `'continueRegularOutput'` and
   * `'continueErrorOutput'` both continue past the error - verified against
   * `continuesOnError()` in `packages/core/src/execution-engine/workflow-execute.ts`,
   * which treats the two identically for a whole-node throw (the difference
   * between them only matters for nodes that catch *per-item* errors
   * internally and route them to a distinct error output, which s8n's
   * whole-node-or-nothing mock model doesn't produce).
   */
  onError: z
    .enum(["continueRegularOutput", "continueErrorOutput", "stopWorkflow"])
    .optional(),
  retryOnFail: z.boolean().default(false),
  maxTries: z.number().int().min(1).default(1),
  /** Real n8n (INode.alwaysOutputData): run this node even if all its inputs delivered zero items. */
  alwaysOutputData: z.boolean().default(false),
  /** Real n8n (INode.executeOnce): run only once, with the first item received. */
  executeOnce: z.boolean().default(false),
});

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

export const connectionSchema = z.object({
  node: z.string(),
  type: z.string().default("main"),
  index: z.number().int().min(0).default(0),
});

export type Connection = z.infer<typeof connectionSchema>;

/**
 * connections[sourceNodeName][connectionType][outputIndex] = list of
 * destinations fed by that output slot. `connectionType` is usually
 * `"main"` (the only type s8n actually simulates item flow through), but
 * real n8n also uses side-channel types like `"ai_languageModel"`,
 * `"ai_tool"`, `"ai_memory"`, `"ai_outputParser"` to wire LangChain
 * sub-nodes to their parent Agent/Chain. Those aren't part of the item
 * pipeline s8n executes, but they still count as "this node has an
 * incoming connection" for start-node detection - without recognizing
 * them, a Chat Model node (wired only via `ai_languageModel`) would be
 * misdetected as an unconnected trigger needing `--start-node`.
 */
export const nodeConnectionsSchema = z.record(
  z.string(),
  z.array(z.array(connectionSchema)),
);

export const connectionsSchema = z.record(z.string(), nodeConnectionsSchema);

export type Connections = z.infer<typeof connectionsSchema>;

export const workflowSettingsSchema = z
  .object({
    timezone: z.string().optional(),
  })
  .default({});

export const workflowSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  nodes: z.array(workflowNodeSchema).min(1),
  connections: connectionsSchema.default({}),
  settings: workflowSettingsSchema,
  pinData: z
    .record(z.string(), z.array(z.record(z.string(), z.unknown())))
    .optional(),
});

export type Workflow = z.infer<typeof workflowSchema>;

export interface WorkflowValidationIssue {
  path: string;
  message: string;
}

export interface WorkflowValidationResult {
  valid: boolean;
  workflow?: Workflow;
  issues: WorkflowValidationIssue[];
}

/**
 * Parses and validates raw JSON against the schema, then performs a handful
 * of structural checks that zod alone can't express (node name uniqueness,
 * dangling connection references).
 */
export function validateWorkflow(raw: unknown): WorkflowValidationResult {
  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  const workflow = parsed.data;
  const issues: WorkflowValidationIssue[] = [];
  const nodeNames = new Set<string>();

  for (const node of workflow.nodes) {
    if (nodeNames.has(node.name)) {
      issues.push({
        path: `nodes[name=${node.name}]`,
        message: `Duplicate node name: "${node.name}"`,
      });
    }
    nodeNames.add(node.name);
  }

  for (const [sourceName, nodeConnections] of Object.entries(
    workflow.connections,
  )) {
    if (!nodeNames.has(sourceName)) {
      issues.push({
        path: `connections.${sourceName}`,
        message: `Connection source node "${sourceName}" does not exist in nodes`,
      });
    }
    for (const [connectionType, outputSlots] of Object.entries(
      nodeConnections,
    )) {
      for (const outputSlot of outputSlots) {
        for (const destination of outputSlot) {
          if (!nodeNames.has(destination.node)) {
            issues.push({
              path: `connections.${sourceName}.${connectionType}`,
              message: `Connection destination node "${destination.node}" does not exist in nodes`,
            });
          }
        }
      }
    }
  }

  return {
    valid: issues.length === 0,
    workflow: issues.length === 0 ? workflow : undefined,
    issues,
  };
}
