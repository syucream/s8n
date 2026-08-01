const JAPANESE_CHARACTER =
  /[\u3005\u3006\u303b\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

export interface JapaneseTextMatch {
  line: number;
  text: string;
}

export function findJapaneseText(text: string): JapaneseTextMatch[] {
  const matches: JapaneseTextMatch[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (JAPANESE_CHARACTER.test(line)) {
      matches.push({ line: index + 1, text: line.trim() });
    }
  }
  return matches;
}

async function trackedPaths(): Promise<string[]> {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  }

  return new TextDecoder().decode(result.stdout).split("\0").filter(Boolean);
}

async function main(): Promise<void> {
  const violations: string[] = [];

  for (const path of await trackedPaths()) {
    if (JAPANESE_CHARACTER.test(path)) {
      violations.push(`${path}: Japanese characters in tracked file name`);
    }

    const file = Bun.file(path);
    if (!(await file.exists())) continue;

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.includes(0)) continue;

    for (const match of findJapaneseText(new TextDecoder().decode(bytes))) {
      violations.push(`${path}:${match.line}: ${match.text}`);
    }
  }

  if (violations.length > 0) {
    console.error(
      "Repository-facing text must be written in English. Japanese text was found:",
    );
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
  }

  console.log("English-language policy check passed.");
}

if (import.meta.main) await main();
