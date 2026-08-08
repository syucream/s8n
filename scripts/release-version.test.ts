import { describe, expect, test } from "bun:test";
import { planReleaseVersion } from "./release-version.ts";

describe("planReleaseVersion", () => {
  test("creates a tag for patch, minor, and major increases", () => {
    expect(planReleaseVersion("0.5.0", "0.5.1")).toEqual({
      changed: true,
      tag: "v0.5.1",
    });
    expect(planReleaseVersion("0.5.1", "0.6.0")).toEqual({
      changed: true,
      tag: "v0.6.0",
    });
    expect(planReleaseVersion("0.6.0", "1.0.0")).toEqual({
      changed: true,
      tag: "v1.0.0",
    });
  });

  test("does not tag package changes that keep the same version", () => {
    expect(planReleaseVersion("0.6.0", "0.6.0")).toEqual({ changed: false });
  });

  test("rejects decreasing and non-stable versions", () => {
    expect(() => planReleaseVersion("0.6.0", "0.5.9")).toThrow(
      "Package version must increase",
    );
    expect(() => planReleaseVersion("0.6.0", "0.7.0-beta.1")).toThrow(
      "Invalid stable semantic version",
    );
    expect(() => planReleaseVersion("0.6.0", "01.0.0")).toThrow(
      "Invalid stable semantic version",
    );
  });
});
