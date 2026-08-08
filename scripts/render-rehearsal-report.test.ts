import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderRehearsalReport } from "./render-rehearsal-report.ts";

const validInput = {
  generatedAt: "2026-08-07T00:00:00.000Z",
  safety: {
    synthetic: true,
    allowlistedEvidenceOnly: true,
    credentialsUsed: false,
    hostIoGlobalsGuarded: true,
    osNetworkIsolation: false,
  },
  reports: [
    {
      benchmark: "WF-01",
      requiredBenchmark: true,
      topology: { nodes: 2, edges: 1, distinctNodeTypes: 2 },
      startNodeType: "n8n-nodes-base.manualTrigger",
      nodeTypes: ["n8n-nodes-base.manualTrigger", "n8n-nodes-base.noOp"],
      baseline: {
        status: "success",
        counts: { inputItems: 1, outputItems: 1 },
        coverage: 1,
        effectCount: 0,
        errorCategories: [],
        executionEvidence: [
          {
            node: "Node-01",
            type: "n8n-nodes-base.manualTrigger",
            status: "success",
            inputItemCounts: [1],
            outputItemCounts: [1],
          },
        ],
      },
      assisted: {
        status: "success",
        counts: { inputItems: 1, outputItems: 1 },
        coverage: 1,
        effectCount: 1,
        errorCategories: [],
        executionEvidence: [
          {
            node: "Node-01",
            type: "n8n-nodes-base.manualTrigger",
            status: "success",
            inputItemCounts: [1],
            outputItemCounts: [1],
          },
        ],
      },
    },
  ],
};

test("renders a self-contained report from valid sanitized input", () => {
  const html = renderRehearsalReport(validInput);
  expect(html).toContain("Enterprise workflow rehearsal");
  expect(html).toContain("WF-01 execution evidence");
  expect(html).toContain("&quot;node&quot;: &quot;Node-01&quot;");
});

test("escapes all rendered strings", () => {
  const input = structuredClone(validInput);
  input.generatedAt = '<img src=x onerror="alert(1)">';
  const report = input.reports[0];
  if (!report) throw new Error("Missing report fixture.");
  const html = renderRehearsalReport(input);
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});

test("rejects private-looking fields", () => {
  const input = structuredClone(validInput) as Record<string, unknown>;
  input.workflowName = "private-workflow";
  expect(() => renderRehearsalReport(input)).toThrow(
    "Invalid sanitized rehearsal report input.",
  );
});

test("rejects benchmark aliases", () => {
  const input = structuredClone(validInput);
  const report = input.reports[0];
  if (!report) throw new Error("Missing report fixture.");
  report.benchmark = "WF-1";
  expect(() => renderRehearsalReport(input)).toThrow(
    "Invalid sanitized rehearsal report input.",
  );
});

test("writes HTML when invoked as a CLI", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "s8n-render-report-"));
  const inputPath = path.join(directory, "input.json");
  const outputDirectory = path.join(
    process.cwd(),
    ".artifacts",
    "rehearsal",
    `test-${process.pid}-${Date.now()}`,
  );
  const outputPath = path.join(outputDirectory, "report.html");
  try {
    await Bun.write(inputPath, JSON.stringify(validInput));
    const child = Bun.spawn(
      [
        "bun",
        "run",
        path.join(import.meta.dir, "render-rehearsal-report.ts"),
        inputPath,
        outputPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
    expect(await readFile(outputPath, "utf8")).toContain("WF-01");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("rejects tracked or arbitrary report output paths", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "s8n-render-report-"));
  const inputPath = path.join(directory, "input.json");
  const outputPath = path.join(directory, "report.html");
  try {
    await Bun.write(inputPath, JSON.stringify(validInput));
    const child = Bun.spawn(
      [
        "bun",
        "run",
        path.join(import.meta.dir, "render-rehearsal-report.ts"),
        inputPath,
        outputPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(1);
    expect(await Bun.file(outputPath).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
