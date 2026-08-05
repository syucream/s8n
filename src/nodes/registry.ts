import { aggregateExecutor } from "./builtin/aggregate.ts";
import { codeExecutor } from "./builtin/code.ts";
import { dateTimeExecutor } from "./builtin/date-time.ts";
import { executeWorkflowTriggerExecutor } from "./builtin/execute-workflow-trigger.ts";
import { filterExecutor } from "./builtin/filter.ts";
import { httpRequestExecutor } from "./builtin/http-request.ts";
import { ifExecutor } from "./builtin/if.ts";
import { limitExecutor } from "./builtin/limit.ts";
import { manualTriggerExecutor } from "./builtin/manual-trigger.ts";
import { mergeExecutor } from "./builtin/merge.ts";
import { noOpExecutor } from "./builtin/no-op.ts";
import { removeDuplicatesExecutor } from "./builtin/remove-duplicates.ts";
import { respondToWebhookExecutor } from "./builtin/respond-to-webhook.ts";
import { scheduleTriggerExecutor } from "./builtin/schedule-trigger.ts";
import { setExecutor } from "./builtin/set.ts";
import { sortExecutor } from "./builtin/sort.ts";
import { splitInBatchesExecutor } from "./builtin/split-in-batches.ts";
import { splitOutExecutor } from "./builtin/split-out.ts";
import { stopAndErrorExecutor } from "./builtin/stop-and-error.ts";
import { summarizeExecutor } from "./builtin/summarize.ts";
import { switchExecutor } from "./builtin/switch.ts";
import { timeSavedExecutor } from "./builtin/time-saved.ts";
import { waitExecutor } from "./builtin/wait.ts";
import { webhookExecutor } from "./builtin/webhook.ts";
import type { NodeExecutor } from "./types.ts";

const BUILTIN_EXECUTORS: NodeExecutor[] = [
  manualTriggerExecutor,
  scheduleTriggerExecutor,
  executeWorkflowTriggerExecutor,
  webhookExecutor,
  httpRequestExecutor,
  setExecutor,
  ifExecutor,
  filterExecutor,
  switchExecutor,
  mergeExecutor,
  codeExecutor,
  timeSavedExecutor,
  noOpExecutor,
  waitExecutor,
  aggregateExecutor,
  limitExecutor,
  sortExecutor,
  splitOutExecutor,
  splitInBatchesExecutor,
  respondToWebhookExecutor,
  dateTimeExecutor,
  removeDuplicatesExecutor,
  summarizeExecutor,
  stopAndErrorExecutor,
];

export class NodeRegistry {
  private readonly executors = new Map<string, NodeExecutor>();

  constructor(executors: NodeExecutor[] = BUILTIN_EXECUTORS) {
    for (const executor of executors) {
      this.register(executor);
    }
  }

  register(executor: NodeExecutor): void {
    this.executors.set(executor.type, executor);
  }

  get(type: string): NodeExecutor | undefined {
    return this.executors.get(type);
  }

  has(type: string): boolean {
    return this.executors.has(type);
  }

  types(): string[] {
    return [...this.executors.keys()];
  }
}

export function createDefaultRegistry(): NodeRegistry {
  return new NodeRegistry();
}
