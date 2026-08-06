import { createDefaultRegistry } from "../src/nodes/registry.ts";
import { validateWorkflow } from "../src/schema/workflow.ts";

type SupportTier =
  | "local-simulation"
  | "stateful-emulation"
  | "ai-contract-emulation"
  | "injected-boundary"
  | "annotation";

function privacySafeNodeType(type: string): string {
  if (
    type.startsWith("n8n-nodes-base.") ||
    type.startsWith("@n8n/n8n-nodes-langchain.")
  )
    return type;
  return "<custom-node>";
}

function supportTier(type: string): SupportTier {
  if (type === "<custom-node>") return "injected-boundary";
  if (type === "n8n-nodes-base.stickyNote") return "annotation";
  if (
    type === "n8n-nodes-base.httpRequest" ||
    type === "n8n-nodes-base.webhook"
  )
    return "injected-boundary";
  if (createDefaultRegistry().has(type)) return "local-simulation";
  const normalized = type.toLowerCase();
  if (
    normalized.startsWith("@n8n/n8n-nodes-langchain.agent") ||
    normalized.startsWith("@n8n/n8n-nodes-langchain.chainllm") ||
    normalized.startsWith("@n8n/n8n-nodes-langchain.lm") ||
    normalized.includes("outputparserstructured")
  )
    return "ai-contract-emulation";
  if (
    normalized.includes("slack") ||
    normalized.includes("googlesheets") ||
    normalized.includes("googledrive") ||
    normalized.includes("gmail") ||
    normalized.includes("googlecalendar") ||
    normalized.includes("googledocs") ||
    normalized.includes("googlebigquery") ||
    normalized.includes("googlecloudstorage") ||
    normalized.includes("vertex") ||
    normalized.includes("googlegemini") ||
    normalized.includes("notion") ||
    normalized.includes("jira") ||
    normalized.includes("github")
  )
    return "stateful-emulation";
  return "injected-boundary";
}

const directory = process.argv[2];
if (!directory) {
  console.error("Usage: workflow-corpus-audit.ts <workflow-directory>");
  process.exit(1);
}

const files = new Set<string>();
for (const pattern of ["**/*.yaml", "**/*.yml", "**/*.json"]) {
  for await (const file of new Bun.Glob(pattern).scan({
    cwd: directory,
    absolute: true,
    onlyFiles: true,
  }))
    files.add(file);
}

function issueCategory(message: string): string {
  if (message.includes("Duplicate node name")) return "duplicate-node-name";
  if (message.includes("does not exist in nodes")) return "dangling-connection";
  if (message.includes("expected array to have")) return "empty-node-list";
  return "schema-validation";
}

const counts = new Map<string, number>();
const invalidIssueCounts = new Map<string, number>();
let invalidWorkflowCount = 0;
let nodeCount = 0;
for (const file of files) {
  try {
    const source = await Bun.file(file).text();
    const raw = file.endsWith(".json")
      ? JSON.parse(source)
      : Bun.YAML.parse(source);
    const validated = validateWorkflow(raw);
    if (!validated.workflow) {
      invalidWorkflowCount += 1;
      const categories = new Set(
        validated.issues.map((issue) => issueCategory(issue.message)),
      );
      for (const category of categories)
        invalidIssueCounts.set(
          category,
          (invalidIssueCounts.get(category) ?? 0) + 1,
        );
      continue;
    }
    for (const node of validated.workflow.nodes) {
      nodeCount += 1;
      const type = privacySafeNodeType(node.type);
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  } catch {
    invalidWorkflowCount += 1;
    invalidIssueCounts.set(
      "parse-error",
      (invalidIssueCounts.get("parse-error") ?? 0) + 1,
    );
  }
}

const nodeTypes = [...counts]
  .map(([type, count]) => ({ type, count, supportTier: supportTier(type) }))
  .sort(
    (left, right) =>
      right.count - left.count || left.type.localeCompare(right.type),
  );
const tierCounts = Object.fromEntries(
  nodeTypes.reduce((totals, entry) => {
    totals.set(
      entry.supportTier,
      (totals.get(entry.supportTier) ?? 0) + entry.count,
    );
    return totals;
  }, new Map<SupportTier, number>()),
);

console.log(
  JSON.stringify(
    {
      workflowFiles: files.size,
      validWorkflows: files.size - invalidWorkflowCount,
      invalidWorkflowCount,
      invalidIssueCounts: Object.fromEntries(
        [...invalidIssueCounts].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      nodeCount,
      tierCounts,
      nodeTypes,
    },
    null,
    2,
  ),
);
