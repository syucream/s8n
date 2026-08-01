import type { Workflow } from "../schema/workflow.ts";

export interface LoopInfo {
  /**
   * Every node reachable from the Split In Batches (SIB) node's `loop`
   * output (main slot 1) via "main" connections - the whole loop body, not
   * just the nodes that happen to cycle back to the SIB. A branch off the
   * body that never reconverges (e.g. a logging node) still gets re-run
   * every batch in real n8n, since the *engine* replays the whole body on
   * each cycle; only the SIB's own re-trigger depends on the back-edge.
   */
  bodyNodes: Set<string>;
  /**
   * For each body node, which of its input slot indexes are fed (at least
   * once) by another body node or by the SIB's own `loop` output - i.e.
   * slots that participate in the repeating cycle and must be cleared and
   * re-awaited every iteration. A slot NOT in this set is fed exclusively by
   * a source outside the loop (a one-time upstream node that only ever
   * fires once) - its delivered data must be preserved across iterations,
   * or it would be wiped after iteration 1 and never refill, silently
   * starving that node for every batch after the first.
   */
  internalSlots: Map<string, Set<number>>;
}

export interface GraphInfo {
  /** Node names with no incoming connections of ANY type - the workflow's entry points. */
  startNodes: string[];
  /** How many input slots a node needs, derived from the highest destination index targeting it (main connections only). */
  requiredSlots: Map<string, number>;
  /**
   * Nodes wired only via non-"main" connections (e.g. a LangChain Chat
   * Model feeding its parent Agent through "ai_languageModel"). These have
   * no role in the item pipeline s8n executes - they're not start nodes to
   * seed, and running them standalone would be meaningless.
   */
  nonMainOnlyNodes: Set<string>;
  /**
   * Split In Batches nodes whose `loop` output genuinely cycles back to
   * themselves via "main" connections, keyed by the SIB node's name. Only
   * these get true per-batch re-execution in the engine; a SIB with no
   * detected back-edge (unusual/malformed wiring) falls back to the old
   * single-pass collapse.
   */
  loops: Map<string, LoopInfo>;
}

function mainDestinations(
  workflow: Workflow,
  nodeName: string,
): Array<{ node: string; index: number }> {
  const result: Array<{ node: string; index: number }> = [];
  for (const slot of workflow.connections[nodeName]?.main ?? []) {
    for (const destination of slot ?? [])
      result.push({ node: destination.node, index: destination.index });
  }
  return result;
}

function analyzeLoops(workflow: Workflow): Map<string, LoopInfo> {
  const loops = new Map<string, LoopInfo>();

  for (const node of workflow.nodes) {
    if (node.type !== "n8n-nodes-base.splitInBatches") continue;

    const loopOutputDestinations = (
      workflow.connections[node.name]?.main?.[1] ?? []
    ).map((d) => d.node);
    if (loopOutputDestinations.length === 0) continue;

    const forwardReachable = new Set<string>();
    const queue = [...loopOutputDestinations];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (forwardReachable.has(current)) continue;
      forwardReachable.add(current);
      // Don't expand past the SIB itself: its `done` output leads to nodes
      // after the loop, not more of the loop body, and its `loop` output is
      // already what seeded this whole traversal.
      if (current === node.name) continue;
      queue.push(...mainDestinations(workflow, current).map((d) => d.node));
    }

    // No back-edge to the SIB itself: not a real cycle, leave it to the
    // single-pass fallback in split-in-batches.ts.
    if (!forwardReachable.has(node.name)) continue;

    // The whole forward-reachable set is the body - including branches that
    // never cycle back to the SIB (they still get replayed every batch by
    // the engine, they just don't gate the SIB's own re-trigger).
    const bodyNodes = new Set(forwardReachable);
    bodyNodes.delete(node.name);

    const internalSources = new Set([node.name, ...bodyNodes]);
    const internalSlots = new Map<string, Set<number>>();
    for (const source of internalSources) {
      for (const destination of mainDestinations(workflow, source)) {
        if (!bodyNodes.has(destination.node)) continue;
        const slots = internalSlots.get(destination.node) ?? new Set<number>();
        slots.add(destination.index);
        internalSlots.set(destination.node, slots);
      }
    }

    if (bodyNodes.size > 0) loops.set(node.name, { bodyNodes, internalSlots });
  }

  return loops;
}

export function analyzeGraph(workflow: Workflow): GraphInfo {
  const allNodeNames = new Set(workflow.nodes.map((n) => n.name));
  const predecessorsAnyType = new Map<string, Set<string>>();
  const requiredSlots = new Map<string, number>();
  const nodesWithAnyConnection = new Set<string>();
  const nodesWithMainConnection = new Set<string>();

  for (const name of allNodeNames) {
    predecessorsAnyType.set(name, new Set());
    requiredSlots.set(name, 1);
  }

  for (const [sourceName, nodeConnections] of Object.entries(
    workflow.connections,
  )) {
    for (const [connectionType, outputSlots] of Object.entries(
      nodeConnections,
    )) {
      const isMain = connectionType === "main";
      for (const outputSlot of outputSlots) {
        for (const destination of outputSlot) {
          predecessorsAnyType.get(destination.node)?.add(sourceName);
          nodesWithAnyConnection.add(sourceName);
          nodesWithAnyConnection.add(destination.node);
          if (isMain) {
            nodesWithMainConnection.add(sourceName);
            nodesWithMainConnection.add(destination.node);
            const currentMax = requiredSlots.get(destination.node) ?? 1;
            requiredSlots.set(
              destination.node,
              Math.max(currentMax, destination.index + 1),
            );
          }
        }
      }
    }
  }

  const startNodes = workflow.nodes
    .filter((n) => (predecessorsAnyType.get(n.name)?.size ?? 0) === 0)
    .map((n) => n.name);

  const nonMainOnlyNodes = new Set<string>();
  for (const name of nodesWithAnyConnection) {
    if (!nodesWithMainConnection.has(name)) nonMainOnlyNodes.add(name);
  }

  const loops = analyzeLoops(workflow);

  return { startNodes, requiredSlots, nonMainOnlyNodes, loops };
}
