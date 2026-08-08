import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScenarioManifestFile } from "./load.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("loadScenarioManifestFile", () => {
  test("loads YAML and resolves every supported path against the manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "s8n-scenario-"));
    directories.push(directory);
    const path = join(directory, "scenario.yaml");
    await Bun.write(
      path,
      [
        "version: 1",
        "defaults:",
        "  inputFile: fixtures/input.json",
        "  workflowMap: maps/children.yaml",
        "  emulatorSeedFile: seeds/state.json",
        "  resolveCodeIncludes: true",
        "cases:",
        "  - name: normal",
        "    mocksFile: mocks/normal.json",
        "    startNode: Start",
        "    emulate: [slack]",
        "",
      ].join("\n"),
    );

    const loaded = await loadScenarioManifestFile(path);

    expect(loaded.ok).toBe(true);
    expect(loaded.manifest?.cases).toEqual([
      {
        name: "normal",
        run: {
          inputFile: join(directory, "fixtures/input.json"),
          mocksFile: join(directory, "mocks/normal.json"),
          workflowMap: join(directory, "maps/children.yaml"),
          emulatorSeedFile: join(directory, "seeds/state.json"),
          resolveCodeIncludes: true,
          startNode: "Start",
          emulate: ["slack"],
        },
      },
    ]);
  });

  test("reports malformed JSON and invalid inline/file combinations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "s8n-scenario-"));
    directories.push(directory);
    const malformedPath = join(directory, "bad.json");
    const conflictPath = join(directory, "conflict.json");
    await Bun.write(malformedPath, "{");
    await Bun.write(
      conflictPath,
      JSON.stringify({
        version: 1,
        cases: [{ name: "normal", mocks: {}, mocksFile: "mocks.json" }],
      }),
    );

    await expect(
      loadScenarioManifestFile(malformedPath),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Failed to load scenario manifest"),
    });
    await expect(loadScenarioManifestFile(conflictPath)).resolves.toMatchObject(
      {
        ok: false,
        error: expect.stringContaining(
          "mocks and mocksFile cannot both be set",
        ),
      },
    );
  });

  test("lets case inline data replace default files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "s8n-scenario-"));
    directories.push(directory);
    const path = join(directory, "override.json");
    await Bun.write(
      path,
      JSON.stringify({
        version: 1,
        defaults: { inputFile: "input.json", mocksFile: "mocks.json" },
        cases: [{ name: "normal", input: { message: "synthetic" }, mocks: {} }],
      }),
    );

    const loaded = await loadScenarioManifestFile(path);

    expect(loaded.manifest?.cases[0]?.run).toEqual({
      input: { message: "synthetic" },
      mocks: {},
    });
  });
});
