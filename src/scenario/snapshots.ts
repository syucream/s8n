import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Item } from "../schema/item.ts";

/**
 * Golden-file snapshots for scenario rehearsals. A snapshot pins a case's
 * final per-node output JSON (`nodeOutputs`, item `json` only - pairedItem
 * metadata is intentionally excluded so files stay focused on the content a
 * human would read) and fails later rehearsals when the observed output
 * drifts from it. Human-facing strings (messages, assembled payloads) are
 * where silent regressions hurt most, and "intended change" vs "accident"
 * is indistinguishable without a checked-in baseline.
 */

export interface SnapshotEvaluation {
  ok: boolean;
  /** True when this evaluation (re)wrote the golden file. */
  updated: boolean;
  /** Bounded, human-readable differences; empty when matched/updated. */
  diff: string[];
  /** Present when the snapshot could not be read or written at all. */
  error?: string;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortKeysDeep(entry)]),
    );
  }
  return value;
}

/** Stable, diff-friendly serialization of a run's final node outputs. */
export function serializeSnapshot(nodeOutputs: Record<string, Item[]>): string {
  const simplified = Object.fromEntries(
    Object.entries(nodeOutputs).map(([node, items]) => [
      node,
      items.map((item) => item.json),
    ]),
  );
  return `${JSON.stringify(sortKeysDeep(simplified), null, 2)}\n`;
}

function summarize(value: unknown): string {
  const text =
    typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

const MAX_DIFF_ENTRIES = 20;

/** Compares two parsed snapshot trees; returns bounded difference entries. */
export function diffSnapshots(
  expected: unknown,
  actual: unknown,
  path = "",
  diff: string[] = [],
): string[] {
  if (diff.length >= MAX_DIFF_ENTRIES) return diff;
  if (Object.is(expected, actual)) return diff;
  const bothObjects =
    expected !== null &&
    actual !== null &&
    typeof expected === "object" &&
    typeof actual === "object";
  if (!bothObjects) {
    diff.push(
      `${path || "/"}: expected ${summarize(expected)} but got ${summarize(actual)}`,
    );
    return diff;
  }
  const expectedIsArray = Array.isArray(expected);
  if (expectedIsArray !== Array.isArray(actual)) {
    diff.push(
      `${path || "/"}: expected ${summarize(expected)} but got ${summarize(actual)}`,
    );
    return diff;
  }
  if (expectedIsArray) {
    const expectedArray = expected as unknown[];
    const actualArray = actual as unknown[];
    if (expectedArray.length !== actualArray.length) {
      diff.push(
        `${path || "/"}: expected ${expectedArray.length} item(s) but got ${actualArray.length}`,
      );
    }
    const shared = Math.min(expectedArray.length, actualArray.length);
    for (let index = 0; index < shared; index++) {
      diffSnapshots(
        expectedArray[index],
        actualArray[index],
        `${path}/${index}`,
        diff,
      );
    }
    return diff;
  }
  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;
  const keys = [
    ...new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)]),
  ].sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    if (!Object.hasOwn(expectedRecord, key)) {
      diff.push(
        `${path}/${key}: unexpected key with value ${summarize(actualRecord[key])}`,
      );
      continue;
    }
    if (!Object.hasOwn(actualRecord, key)) {
      diff.push(
        `${path}/${key}: missing key, expected ${summarize(expectedRecord[key])}`,
      );
      continue;
    }
    diffSnapshots(
      expectedRecord[key],
      actualRecord[key],
      `${path}/${key}`,
      diff,
    );
  }
  return diff;
}

/**
 * Compares observed outputs against the golden file, or (with `update`)
 * writes them as the new baseline. A missing file is a failure outside
 * update mode so snapshots cannot silently pass on first review.
 */
export async function evaluateSnapshot(args: {
  snapshotPath: string;
  nodeOutputs: Record<string, Item[]>;
  update: boolean;
}): Promise<SnapshotEvaluation> {
  const serialized = serializeSnapshot(args.nodeOutputs);
  if (args.update) {
    try {
      await mkdir(dirname(args.snapshotPath), { recursive: true });
      await writeFile(args.snapshotPath, serialized, "utf8");
      return { ok: true, updated: true, diff: [] };
    } catch (cause) {
      return {
        ok: false,
        updated: false,
        diff: [],
        error: `Failed to write snapshot: ${String((cause as Error)?.message ?? cause)}`,
      };
    }
  }

  let golden: string;
  try {
    golden = await readFile(args.snapshotPath, "utf8");
  } catch {
    return {
      ok: false,
      updated: false,
      diff: [],
      error:
        "Snapshot file not found; run `s8n rehearse --update-snapshots` to create the baseline.",
    };
  }
  if (golden === serialized) return { ok: true, updated: false, diff: [] };

  let parsedGolden: unknown;
  let parsedActual: unknown;
  try {
    parsedGolden = JSON.parse(golden);
    parsedActual = JSON.parse(serialized);
  } catch {
    return {
      ok: false,
      updated: false,
      diff: ["Snapshot file is not parseable JSON; regenerate the baseline."],
    };
  }
  const diff = diffSnapshots(parsedGolden, parsedActual);
  return { ok: false, updated: false, diff };
}
