import { DateTime } from "luxon";
import type { Item } from "../schema/item.ts";
import type { Connections } from "../schema/workflow.ts";

/** Accessor exposed for both the current node's input and `$('NodeName')` references. */
export interface NodeOutputAccessor {
  all: () => Item[];
  first: () => Item | undefined;
  last: () => Item | undefined;
  item: Item;
}

export function createAccessor(
  items: Item[],
  currentIndex: number,
): NodeOutputAccessor {
  const fallback: Item = { json: {} };
  return {
    all: () => items,
    first: () => items[0],
    last: () => items[items.length - 1],
    item: items[currentIndex] ?? items[0] ?? fallback,
  };
}

export interface ExpressionScope {
  $json: Record<string, unknown>;
  $binary: Record<string, unknown> | undefined;
  $itemIndex: number;
  $input: NodeOutputAccessor;
  /** Reference another node's last executed output by name, e.g. $('HTTP Request'). */
  $: (nodeName: string) => NodeOutputAccessor;
  $node: { name: string };
  $workflow: { name: string; id?: string };
  /** Real n8n exposes these as Luxon `DateTime` (`$now: DateTime.now()`), not plain strings - see `workflow-data-proxy.ts`. */
  $now: DateTime;
  $today: DateTime;
}

export interface BuildScopeOptions {
  currentItem: Item;
  itemIndex: number;
  inputItems: Item[];
  currentNodeName: string;
  workflowName: string;
  workflowId?: string;
  /** Last output items per node name, used to resolve `$('NodeName')`. */
  nodeOutputs: Map<string, Item[]>;
  /**
   * Per-output-slot results (before the flattening that `nodeOutputs` above
   * applies), used together with `connections` to resolve `$('NodeName')` to
   * only the branch that actually reaches the currently executing node - an
   * If/Switch's untaken branch shouldn't leak into `$('NodeName').all()` on
   * the taken branch. Optional: callers that omit it (e.g. isolated unit
   * tests) get the old flatten-everything behavior via `nodeOutputs`.
   */
  nodeSlotOutputs?: Map<string, Item[][]>;
  connections?: Connections;
  /** Injectable clock for deterministic tests; defaults to the real current time. */
  now?: Date;
  /**
   * Real n8n resolves `$now`/`$today` in `workflow.settings.timezone` (falling
   * back to the instance-wide default when unset) by setting Luxon's global
   * `Settings.defaultZone` per execution - see `WorkflowDataProxy`'s
   * constructor in `workflow-data-proxy.ts`. s8n has no instance-wide
   * default (no server), so this only applies when the workflow itself sets
   * a timezone; otherwise `$now`/`$today` use the local system zone as
   * before. Deliberately does NOT mutate Luxon's global `Settings.defaultZone`
   * (unlike real n8n) to avoid a process-wide side effect from a single
   * workflow run - only `$now`/`$today` themselves are zoned.
   */
  timezone?: string;
}

/** BFS over `main` connections: can output slot `slotIndex` of `sourceName` reach `targetName`? */
function slotReachesNode(
  connections: Connections,
  sourceName: string,
  slotIndex: number,
  targetName: string,
): boolean {
  const queue: string[] = (
    connections[sourceName]?.main?.[slotIndex] ?? []
  ).map((destination) => destination.node);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === targetName) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const slot of connections[current]?.main ?? []) {
      for (const destination of slot ?? []) queue.push(destination.node);
    }
  }
  return false;
}

export function buildExpressionScope(
  options: BuildScopeOptions,
): ExpressionScope {
  const zone = options.timezone;
  const now = options.now
    ? DateTime.fromJSDate(options.now, zone ? { zone } : undefined)
    : zone
      ? DateTime.now().setZone(zone)
      : DateTime.now();
  return {
    $json: options.currentItem.json,
    $binary: options.currentItem.binary,
    $itemIndex: options.itemIndex,
    $input: createAccessor(options.inputItems, options.itemIndex),
    $: (nodeName: string) => {
      const items = options.nodeOutputs.get(nodeName);
      if (!items) {
        throw new Error(
          `No output found for referenced node "${nodeName}" (it has not run or its name does not match)`,
        );
      }
      const slots = options.nodeSlotOutputs?.get(nodeName);
      if (slots && slots.length > 1 && options.connections) {
        const reachableSlotIndexes = slots
          .map((_, idx) => idx)
          .filter((idx) =>
            slotReachesNode(
              options.connections as Connections,
              nodeName,
              idx,
              options.currentNodeName,
            ),
          );
        if (reachableSlotIndexes.length > 0) {
          const filtered = reachableSlotIndexes.flatMap(
            (idx) => slots[idx] ?? [],
          );
          return createAccessor(filtered, options.itemIndex);
        }
      }
      return createAccessor(items, options.itemIndex);
    },
    $node: { name: options.currentNodeName },
    $workflow: { name: options.workflowName, id: options.workflowId },
    $now: now,
    $today: now.set({ hour: 0, minute: 0, second: 0, millisecond: 0 }),
  };
}
