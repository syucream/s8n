import type { Item } from "../schema/item.ts";
import type { WorkflowNode } from "../schema/workflow.ts";

export interface IntegrationEffect {
  nodeName: string;
  nodeType: string;
  service: string;
  operation: string;
  request: unknown;
  response: unknown;
  observation: unknown;
  verified: boolean;
}

export interface EmulatedIntegrationResult {
  output: unknown;
  effect: IntegrationEffect;
}

export interface IntegrationRunner {
  execute(
    node: WorkflowNode,
    resolvedParameters: Record<string, unknown>,
    inputItem?: Item,
  ): Promise<EmulatedIntegrationResult | undefined>;
  close(): Promise<void>;
}

export const EMULATED_SERVICES = [
  "ai",
  "slack",
  "gws",
  "gcp",
  "notion",
  "jira",
  "github",
] as const;

export type EmulatedService = (typeof EMULATED_SERVICES)[number];

/**
 * Initial emulator state keyed by the store names shown in effect
 * observations, for example `notion.databasePages`, `jira.issues`, or
 * `gws.gmail.messages`.
 */
export interface EmulatorSeed {
  stores: Record<string, Array<Record<string, unknown>>>;
}
