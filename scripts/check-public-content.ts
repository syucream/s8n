import { basename } from "node:path";

interface PublicContentRule {
  name: string;
  pattern: RegExp;
}

const CONTENT_RULES: PublicContentRule[] = [
  {
    name: "private key material",
    pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/u,
  },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u },
  {
    name: "Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u,
  },
  {
    name: "GitHub access token",
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
  },
  {
    name: "OpenAI API key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  },
  {
    name: "Slack access token",
    pattern: /\bxox[baprs]-\d{8,}-[A-Za-z0-9-]{10,}\b/u,
  },
  {
    name: "absolute user home path",
    pattern: /(?:^|[\s"'=(])(?:\/Users|\/home)\/[A-Za-z0-9._-]+(?:\/|\b)/u,
  },
];

const RISKY_FILE_NAMES = [
  /^\.env(?:\..+)?$/u,
  /^id_rsa(?:\..+)?$/u,
  /\.(?:key|p12|pfx|pem)$/u,
];

export interface PublicContentMatch {
  line: number;
  rule: string;
  text: string;
}

export function findPublicContentRisks(text: string): PublicContentMatch[] {
  const matches: PublicContentMatch[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    for (const rule of CONTENT_RULES) {
      if (rule.pattern.test(line)) {
        matches.push({ line: index + 1, rule: rule.name, text: line.trim() });
      }
    }
  }
  return matches;
}

export function isRiskyRepositoryPath(path: string): boolean {
  const name = basename(path);
  if (name === ".env.example") return false;
  return RISKY_FILE_NAMES.some((pattern) => pattern.test(name));
}

function repositoryPaths(): string[] {
  const result = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  }
  return new TextDecoder().decode(result.stdout).split("\0").filter(Boolean);
}

async function main(): Promise<void> {
  const violations: string[] = [];

  for (const path of repositoryPaths()) {
    if (isRiskyRepositoryPath(path)) {
      violations.push(`${path}: sensitive file name`);
    }

    const file = Bun.file(path);
    if (!(await file.exists())) continue;

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.includes(0)) continue;

    for (const match of findPublicContentRisks(
      new TextDecoder().decode(bytes),
    )) {
      violations.push(`${path}:${match.line}: ${match.rule}: ${match.text}`);
    }
  }

  if (violations.length > 0) {
    console.error("Potentially sensitive public repository content was found:");
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
  }

  console.log("Public repository content check passed.");
}

if (import.meta.main) await main();
