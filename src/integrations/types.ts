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
  ): Promise<EmulatedIntegrationResult | undefined>;
  close(): Promise<void>;
}
