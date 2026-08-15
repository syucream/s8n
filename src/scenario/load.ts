import { dirname, isAbsolute, resolve } from "node:path";
import {
  type ScenarioAssertions,
  type ScenarioFault,
  type ScenarioGeneratedFrom,
  type ScenarioManifest,
  type ScenarioRunOverlay,
  scenarioManifestSchema,
} from "./schema.ts";

export interface ResolvedScenarioCase {
  name: string;
  run: ScenarioRunOverlay;
  faults?: ScenarioFault[];
  assertions?: ScenarioAssertions;
  /** Golden-file path resolved relative to the manifest, when configured. */
  snapshot?: string;
}

export interface ResolvedScenarioManifest {
  version: 1;
  generatedFrom?: ScenarioGeneratedFrom;
  cases: ResolvedScenarioCase[];
}

export interface LoadScenarioManifestResult {
  ok: boolean;
  manifest?: ResolvedScenarioManifest;
  error?: string;
}

function parseScenarioSource(path: string, text: string): unknown {
  const normalizedPath = path.toLowerCase();
  if (normalizedPath.endsWith(".yaml") || normalizedPath.endsWith(".yml")) {
    return Bun.YAML.parse(text);
  }
  return JSON.parse(text);
}

function resolvePath(
  baseDirectory: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return isAbsolute(value) ? value : resolve(baseDirectory, value);
}

function resolveRunPaths(
  baseDirectory: string,
  run: ScenarioRunOverlay,
): ScenarioRunOverlay {
  return {
    ...run,
    ...(run.inputFile === undefined
      ? {}
      : { inputFile: resolvePath(baseDirectory, run.inputFile) }),
    ...(run.mocksFile === undefined
      ? {}
      : { mocksFile: resolvePath(baseDirectory, run.mocksFile) }),
    ...(run.workflowMap === undefined
      ? {}
      : { workflowMap: resolvePath(baseDirectory, run.workflowMap) }),
    ...(run.emulatorSeedFile === undefined
      ? {}
      : { emulatorSeedFile: resolvePath(baseDirectory, run.emulatorSeedFile) }),
  };
}

function mergeRunOverlay(
  defaults: ScenarioRunOverlay,
  override: ScenarioRunOverlay,
): ScenarioRunOverlay {
  const merged = { ...defaults, ...override };
  if (Object.hasOwn(override, "input")) delete merged.inputFile;
  if (Object.hasOwn(override, "inputFile")) delete merged.input;
  if (Object.hasOwn(override, "mocks")) delete merged.mocksFile;
  if (Object.hasOwn(override, "mocksFile")) delete merged.mocks;
  return merged;
}

/**
 * Resolves scenario run overlays without loading a workflow. The workflow JSON
 * remains the source of truth and is intentionally absent from this format.
 */
export function resolveScenarioManifest(
  manifest: ScenarioManifest,
  manifestPath: string,
): ResolvedScenarioManifest {
  const baseDirectory = dirname(manifestPath);
  return {
    version: manifest.version,
    ...(manifest.generatedFrom === undefined
      ? {}
      : { generatedFrom: manifest.generatedFrom }),
    cases: manifest.cases.map((entry) => {
      const { name, faults, assertions, snapshot, ...caseRun } = entry;
      return {
        name,
        run: resolveRunPaths(
          baseDirectory,
          mergeRunOverlay(manifest.defaults, caseRun),
        ),
        ...(faults === undefined ? {} : { faults }),
        ...(assertions === undefined ? {} : { assertions }),
        ...(snapshot === undefined
          ? {}
          : { snapshot: resolvePath(baseDirectory, snapshot) as string }),
      };
    }),
  };
}

export async function loadScenarioManifestFile(
  path: string,
): Promise<LoadScenarioManifestResult> {
  let raw: unknown;
  try {
    raw = parseScenarioSource(path, await Bun.file(path).text());
  } catch (cause) {
    return {
      ok: false,
      error: `Failed to load scenario manifest: ${String((cause as Error)?.message ?? cause)}`,
    };
  }

  const parsed = scenarioManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: `Invalid scenario manifest: ${details}` };
  }
  return { ok: true, manifest: resolveScenarioManifest(parsed.data, path) };
}
