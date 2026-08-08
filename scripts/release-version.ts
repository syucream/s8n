type StableVersion = {
  major: number;
  minor: number;
  patch: number;
  raw: string;
};

export type ReleaseVersionPlan =
  | { changed: false }
  | { changed: true; tag: string };

function stableVersion(value: string): StableVersion {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (!match) {
    throw new Error(`Invalid stable semantic version: ${value}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: value,
  };
}

function compareVersions(left: StableVersion, right: StableVersion): number {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch
  );
}

export function planReleaseVersion(
  previousValue: string,
  currentValue: string,
): ReleaseVersionPlan {
  const previous = stableVersion(previousValue);
  const current = stableVersion(currentValue);
  const comparison = compareVersions(current, previous);
  if (comparison === 0) return { changed: false };
  if (comparison < 0) {
    throw new Error(
      `Package version must increase: ${previous.raw} -> ${current.raw}`,
    );
  }
  return { changed: true, tag: `v${current.raw}` };
}

if (import.meta.main) {
  const [previous, current] = process.argv.slice(2);
  if (!previous || !current) {
    console.error(
      "Usage: release-version.ts <previous-version> <current-version>",
    );
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(planReleaseVersion(previous, current)));
  } catch (cause) {
    console.error(String((cause as Error)?.message ?? cause));
    process.exit(1);
  }
}
