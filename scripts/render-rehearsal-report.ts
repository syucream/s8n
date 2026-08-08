import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

type ExecutionEvidence = {
  node: string;
  type: string;
  status: string;
  inputItemCounts: number[];
  outputItemCounts: number[];
};

type RunSummary = {
  status: "success" | "error" | "needs_mock" | "needs_start_node";
  counts: Record<string, number>;
  coverage: number;
  effectCount: number;
  errorCategories: string[];
  executionEvidence: ExecutionEvidence[];
};

type Report = {
  benchmark: string;
  requiredBenchmark: boolean;
  topology: Record<string, number>;
  startNodeType: string;
  baseline: RunSummary;
  assisted: RunSummary;
  nodeTypes: string[];
};

type RehearsalInput = {
  generatedAt: string;
  safety: {
    synthetic: boolean;
    allowlistedEvidenceOnly: boolean;
    credentialsUsed: boolean;
    hostIoGlobalsGuarded: boolean;
    osNetworkIsolation: boolean;
  };
  reports: Report[];
};

function fail(): never {
  throw new Error("Invalid sanitized rehearsal report input.");
}

function localReportOutputPath(outputPath: string): string {
  const root = resolve(process.cwd(), ".artifacts/rehearsal");
  const output = resolve(outputPath);
  if (!output.startsWith(`${root}${sep}`)) {
    throw new Error("Report output must be under .artifacts/rehearsal/.");
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    fail();
}

function publicNodeType(value: unknown): string {
  if (value === "<custom-node>") return value;
  if (
    typeof value !== "string" ||
    !/^(n8n-nodes-base|@n8n\/n8n-nodes-langchain)\.[A-Za-z][A-Za-z0-9]*$/.test(
      value,
    )
  )
    fail();
  return value;
}

function numberMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) fail();
  for (const [key, count] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(key) || !Number.isFinite(count))
      fail();
  }
  return value as Record<string, number>;
}

function itemCounts(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        typeof entry !== "number" || !Number.isInteger(entry) || entry < 0,
    )
  )
    fail();
  return value;
}

function executionEvidence(value: unknown): ExecutionEvidence[] {
  if (!Array.isArray(value)) fail();
  return value.map((entry) => {
    if (!isRecord(entry)) fail();
    requireExactKeys(entry, [
      "node",
      "type",
      "status",
      "inputItemCounts",
      "outputItemCounts",
    ]);
    if (
      typeof entry.node !== "string" ||
      !/^Node-\d{2,3}$/u.test(entry.node) ||
      typeof entry.status !== "string" ||
      !/^(success|error|waiting_mock|pinned|skipped_[a-z_]+)$/u.test(
        entry.status,
      )
    )
      fail();
    return {
      node: entry.node,
      type: publicNodeType(entry.type),
      status: entry.status,
      inputItemCounts: itemCounts(entry.inputItemCounts),
      outputItemCounts: itemCounts(entry.outputItemCounts),
    };
  });
}

function runSummary(value: unknown): RunSummary {
  if (!isRecord(value)) fail();
  requireExactKeys(value, [
    "status",
    "counts",
    "coverage",
    "effectCount",
    "errorCategories",
    "executionEvidence",
  ]);
  if (
    (value.status !== "success" &&
      value.status !== "error" &&
      value.status !== "needs_mock" &&
      value.status !== "needs_start_node") ||
    typeof value.coverage !== "number" ||
    !Number.isFinite(value.coverage) ||
    value.coverage < 0 ||
    value.coverage > 1 ||
    typeof value.effectCount !== "number" ||
    !Number.isFinite(value.effectCount) ||
    !Array.isArray(value.errorCategories) ||
    value.errorCategories.some(
      (category) =>
        typeof category !== "string" || !/^[a-z0-9-]+$/u.test(category),
    )
  )
    fail();
  return {
    status: value.status,
    counts: numberMap(value.counts),
    coverage: value.coverage,
    effectCount: value.effectCount,
    errorCategories: value.errorCategories,
    executionEvidence: executionEvidence(value.executionEvidence),
  };
}

function rehearsalInput(value: unknown): RehearsalInput {
  if (!isRecord(value)) fail();
  requireExactKeys(value, ["generatedAt", "safety", "reports"]);
  if (typeof value.generatedAt !== "string" || !Array.isArray(value.reports))
    fail();
  if (!isRecord(value.safety)) fail();
  requireExactKeys(value.safety, [
    "synthetic",
    "allowlistedEvidenceOnly",
    "credentialsUsed",
    "hostIoGlobalsGuarded",
    "osNetworkIsolation",
  ]);
  if (
    typeof value.safety.synthetic !== "boolean" ||
    typeof value.safety.allowlistedEvidenceOnly !== "boolean" ||
    typeof value.safety.credentialsUsed !== "boolean" ||
    typeof value.safety.hostIoGlobalsGuarded !== "boolean" ||
    typeof value.safety.osNetworkIsolation !== "boolean"
  )
    fail();
  return {
    generatedAt: value.generatedAt,
    safety: value.safety as RehearsalInput["safety"],
    reports: value.reports.map((entry) => {
      if (!isRecord(entry)) fail();
      requireExactKeys(entry, [
        "benchmark",
        "requiredBenchmark",
        "topology",
        "startNodeType",
        "baseline",
        "assisted",
        "nodeTypes",
      ]);
      if (
        typeof entry.benchmark !== "string" ||
        !/^WF-\d{2}$/.test(entry.benchmark) ||
        typeof entry.requiredBenchmark !== "boolean" ||
        !Array.isArray(entry.nodeTypes)
      )
        fail();
      return {
        benchmark: entry.benchmark,
        requiredBenchmark: entry.requiredBenchmark,
        topology: (() => {
          if (!isRecord(entry.topology)) fail();
          requireExactKeys(entry.topology, [
            "nodes",
            "edges",
            "distinctNodeTypes",
          ]);
          return numberMap(entry.topology);
        })(),
        startNodeType: publicNodeType(entry.startNodeType),
        baseline: runSummary(entry.baseline),
        assisted: runSummary(entry.assisted),
        nodeTypes: entry.nodeTypes.map(publicNodeType),
      };
    }),
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] as string,
  );
}

function cells(values: Record<string, number>): string {
  return Object.entries(values)
    .map(([key, value]) => `${escapeHtml(key)}: ${value}`)
    .join("<br>");
}

function runCells(run: RunSummary): string {
  return `<td>${escapeHtml(run.status)}</td><td>${cells(run.counts)}</td><td>${run.coverage}</td><td>${run.effectCount}</td><td>${run.errorCategories.map(escapeHtml).join(", ")}</td>`;
}

export function renderRehearsalReport(input: unknown): string {
  const report = rehearsalInput(input);
  const rows = report.reports
    .map(
      (entry) =>
        `<tr><td>${entry.benchmark}</td><td>${entry.requiredBenchmark}</td><td>${cells(entry.topology)}</td><td>${escapeHtml(entry.startNodeType)}</td><td>${entry.nodeTypes.map(escapeHtml).join("<br>")}</td>${runCells(entry.baseline)}${runCells(entry.assisted)}</tr>`,
    )
    .join("");
  const evidence = report.reports
    .map(
      (entry) =>
        `<section><h2>${entry.benchmark} execution evidence</h2><h3>Baseline</h3><pre>${escapeHtml(JSON.stringify(entry.baseline.executionEvidence, null, 2))}</pre><h3>Assisted</h3><pre>${escapeHtml(JSON.stringify(entry.assisted.executionEvidence, null, 2))}</pre></section>`,
    )
    .join("\n");
  const baselineSuccesses = report.reports.filter(
    (entry) => entry.baseline.status === "success",
  ).length;
  const assistedSuccesses = report.reports.filter(
    (entry) => entry.assisted.status === "success",
  ).length;
  const fullCoverage = report.reports.filter(
    (entry) => entry.assisted.coverage === 1,
  ).length;
  const totalNodes = report.reports.reduce(
    (sum, entry) => sum + (entry.topology.nodes ?? 0),
    0,
  );
  const totalEdges = report.reports.reduce(
    (sum, entry) => sum + (entry.topology.edges ?? 0),
    0,
  );
  const required = report.reports.find((entry) => entry.requiredBenchmark);
  const meanCoverage = (key: "baseline" | "assisted") =>
    report.reports.length === 0
      ? 0
      : (report.reports.reduce((sum, entry) => sum + entry[key].coverage, 0) /
          report.reports.length) *
        100;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Enterprise workflow rehearsal</title><style>body{font-family:system-ui,sans-serif;margin:2rem;color:#172033;background:#f8fafc}main{max-width:1200px;margin:auto}.cards{display:flex;flex-wrap:wrap;gap:1rem}.card,section{background:white;border:1px solid #cbd5e1;border-radius:.5rem;padding:1rem}.card{min-width:10rem}table{border-collapse:collapse;width:100%;margin:1.5rem 0;font-size:.9rem;background:white}th,td{border:1px solid #cbd5e1;padding:.5rem;text-align:left;vertical-align:top}th{background:#e2e8f0}pre{background:#0f172a;color:#e2e8f0;padding:1rem;overflow:auto}.boundary{border-left:4px solid #f59e0b;margin:1rem 0}</style></head><body><main><h1>Enterprise workflow rehearsal</h1><p>This report contains allowlisted evidence from real s8n executions of private workflow graphs. All inputs and external responses were synthetic. Workflow names, node names, paths, identifiers, parameters, queries, URLs, raw errors, and payloads are excluded by the renderer schema.</p><div class="cards"><div class="card"><strong>Benchmarks</strong><br>${report.reports.length}</div><div class="card"><strong>Graph size</strong><br>${totalNodes} nodes / ${totalEdges} edges</div><div class="card"><strong>Baseline success</strong><br>${baselineSuccesses}/${report.reports.length}</div><div class="card"><strong>Assisted success</strong><br>${assistedSuccesses}/${report.reports.length}</div><div class="card"><strong>Full graph coverage</strong><br>${fullCoverage}/${report.reports.length}</div><div class="card"><strong>Assisted mean coverage</strong><br>${meanCoverage("assisted").toFixed(1)}%</div></div><p>Generated at: ${escapeHtml(report.generatedAt)}</p><section><h2>Assessment</h2><p>The assisted runs completed ${assistedSuccesses} of ${report.reports.length} workflows, but only ${fullCoverage} reached every executable node in the selected scenario. ${required ? `The required benchmark completed with ${(required.assisted.coverage * 100).toFixed(1)}% top-level node coverage and ${required.assisted.counts.subExecutionCount ?? 0} observed mapped sub-workflow executions.` : "No required benchmark was marked."} This is useful for structural dry-runs, expression and Code compatibility checks, mock-contract discovery, and downstream shape validation. It is not yet sufficient to approve production behavior without scenario-specific branch fixtures, critical checkpoints, and OS-level isolation for untrusted Code.</p><h3>Implemented from the observed gaps</h3><ul><li>Direct JSON and YAML workflow loading.</li><li>Explicit, recursive sub-workflow maps with scoped mocks, cycle detection, and child evidence.</li><li>Opt-in, traversal-safe Code asset includes.</li><li>Luxon DateTime and object keys expression compatibility.</li><li>Optional multi-case Scenario Manifests with deterministic assertions and union coverage.</li><li>Synthetic-shape scenario drafts from n8n-shaped execution logs.</li><li>Host I/O global guardrails and a strict allowlist renderer for evidence.</li><li>A standalone rehearsal quality gate with behavior and privacy mutation checks.</li></ul></section><section class="boundary"><h2>Safety and fidelity boundary</h2><ul><li>Synthetic inputs: ${report.safety.synthetic}</li><li>Credentials used: ${report.safety.credentialsUsed}</li><li>Host I/O globals guarded: ${report.safety.hostIoGlobalsGuarded}</li><li>OS network isolation: ${report.safety.osNetworkIsolation}</li></ul><p>Mocks prove downstream graph behavior for the supplied shapes, not remote API behavior. In-process emulation does not prove authentication, permissions, rate limits, pagination, webhooks, arbitrary SQL semantics, model quality, or production side effects. The host-global guard reduces accidental I/O from trusted Code nodes; it is not a hostile-code security sandbox.</p></section><h2>Measured results</h2><table><thead><tr><th>Benchmark</th><th>Required</th><th>Topology</th><th>Start node</th><th>Node types</th><th>Baseline status</th><th>Baseline counts</th><th>Baseline coverage</th><th>Baseline effects</th><th>Baseline errors</th><th>Assisted status</th><th>Assisted counts</th><th>Assisted coverage</th><th>Assisted effects</th><th>Assisted errors</th></tr></thead><tbody>${rows}</tbody></table><h2>Actual simulation result data</h2><p>Each row below is emitted from an executed node visit. Only generated aliases, public node types, statuses, and item counts are retained.</p>${evidence}</main></body></html>`;
}

async function main(): Promise<void> {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    console.error(
      "Usage: render-rehearsal-report.ts <sanitized-json-input> .artifacts/rehearsal/<report>.html",
    );
    process.exitCode = 1;
    return;
  }
  try {
    const input = JSON.parse(await Bun.file(inputPath).text());
    const localOutputPath = localReportOutputPath(outputPath);
    await mkdir(dirname(localOutputPath), { recursive: true });
    await Bun.write(localOutputPath, renderRehearsalReport(input));
  } catch {
    console.error("Unable to render sanitized rehearsal report.");
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
