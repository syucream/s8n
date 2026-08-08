import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadScenarioManifestFile } from "../src/scenario/load.ts";
import { runRehearsal } from "../src/scenario/run.ts";

const repository = join(import.meta.dir, "..");

describe("published rehearsal assets", () => {
  test("the example manifest executes both branches with full union coverage", async () => {
    const manifestPath = join(
      repository,
      "examples",
      "rehearsal.scenarios.yaml",
    );
    const loaded = await loadScenarioManifestFile(manifestPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.manifest) throw new Error(loaded.error);

    const result = await runRehearsal({
      workflowFile: join(repository, "examples", "rehearsal.workflow.json"),
      manifest: loaded.manifest,
    });
    expect(result.summary).toMatchObject({
      total: 2,
      passed: 2,
      failed: 0,
      unionCoverage: { ratio: 1, uncoveredNodes: [] },
    });
  });

  test("the bundled agent skill has no template placeholders", async () => {
    const skill = await Bun.file(
      join(repository, "skills", "s8n-rehearse-workflows", "SKILL.md"),
    ).text();
    expect(skill).toContain("name: s8n-rehearse-workflows");
    expect(skill).toContain("s8n rehearse workflow.json");
    expect(skill).not.toContain("TODO");
  });
});
