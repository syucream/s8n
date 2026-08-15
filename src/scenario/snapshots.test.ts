import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Item } from "../schema/item.ts";
import {
  diffSnapshots,
  evaluateSnapshot,
  serializeSnapshot,
} from "./snapshots.ts";

const outputs: Record<string, Item[]> = {
  Compose: [{ json: { message: "Hello", count: 1 } }],
};

describe("serializeSnapshot", () => {
  test("serializes item json only with sorted keys", () => {
    const text = serializeSnapshot({
      Compose: [{ json: { b: 2, a: 1 }, pairedItem: { item: 0 } }] as Item[],
    });
    expect(text).toBe(
      '{\n  "Compose": [\n    {\n      "a": 1,\n      "b": 2\n    }\n  ]\n}\n',
    );
    expect(text).not.toContain("pairedItem");
  });
});

describe("diffSnapshots", () => {
  test("reports leaf differences with paths", () => {
    const diff = diffSnapshots(
      { a: { b: 1 }, c: [1, 2] },
      { a: { b: 2 }, c: [1], d: "new" },
    );
    expect(diff).toEqual([
      "/a/b: expected 1 but got 2",
      "/c: expected 2 item(s) but got 1",
      '/d: unexpected key with value "new"',
    ]);
  });

  test("returns no entries for equal trees", () => {
    expect(diffSnapshots({ a: [1] }, { a: [1] })).toEqual([]);
  });
});

describe("evaluateSnapshot", () => {
  test("update writes a baseline and later comparisons match it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "s8n-snapshot-"));
    try {
      const path = join(dir, "golden.json");
      const updated = await evaluateSnapshot({
        snapshotPath: path,
        nodeOutputs: outputs,
        update: true,
      });
      expect(updated).toEqual({ ok: true, updated: true, diff: [] });
      expect(await readFile(path, "utf8")).toBe(serializeSnapshot(outputs));

      const compared = await evaluateSnapshot({
        snapshotPath: path,
        nodeOutputs: outputs,
        update: false,
      });
      expect(compared).toEqual({ ok: true, updated: false, diff: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("missing baseline fails outside update mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "s8n-snapshot-"));
    try {
      const missing = await evaluateSnapshot({
        snapshotPath: join(dir, "absent.json"),
        nodeOutputs: outputs,
        update: false,
      });
      expect(missing.ok).toBe(false);
      expect(missing.error).toContain("--update-snapshots");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("drifted output fails with a bounded diff", async () => {
    const dir = await mkdtemp(join(tmpdir(), "s8n-snapshot-"));
    try {
      const path = join(dir, "golden.json");
      await writeFile(path, serializeSnapshot(outputs), "utf8");
      const drifted = await evaluateSnapshot({
        snapshotPath: path,
        nodeOutputs: {
          Compose: [{ json: { message: "Changed", count: 1 } }],
        },
        update: false,
      });
      expect(drifted.ok).toBe(false);
      expect(drifted.diff[0]).toContain("/Compose/0/message");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
