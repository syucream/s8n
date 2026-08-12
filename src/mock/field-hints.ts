import type { Workflow } from "../schema/workflow.ts";

const JSON_FIELD_RE = /\$json(?:\.([a-zA-Z_][\w]*)|\[["']([^"']+)["']\])/g;

/**
 * Scans every node's parameters for `$json.foo` / `$json["foo"]` references
 * and returns the unique field names found. Used purely as a best-effort
 * hint when s8n asks the calling AI to generate dummy input data - it is not
 * a formal schema, just a nudge toward plausible field names.
 */
export function extractReferencedJsonFields(
  workflow: Workflow,
  downstreamOf?: string,
): string[] {
  let nodes = workflow.nodes;
  if (downstreamOf !== undefined) {
    const reachable = new Set<string>();
    const queue = (workflow.connections[downstreamOf]?.main ?? [])
      .flat()
      .map((connection) => connection.node);
    while (queue.length > 0) {
      const name = queue.shift() as string;
      if (reachable.has(name)) continue;
      reachable.add(name);
      for (const connection of (
        workflow.connections[name]?.main ?? []
      ).flat()) {
        queue.push(connection.node);
      }
    }
    nodes = workflow.nodes.filter((node) => reachable.has(node.name));
  }
  const fields = new Set<string>();
  const text = JSON.stringify(nodes.map((node) => node.parameters));
  for (const match of text.matchAll(JSON_FIELD_RE)) {
    const name = match[1] ?? match[2];
    if (name) fields.add(name);
  }
  return [...fields].sort();
}
