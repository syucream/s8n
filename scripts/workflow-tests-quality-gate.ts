import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Envelope {
  ok: boolean;
  command: string;
  error?: string;
  data?: {
    summary?: { total?: number; passed?: number; failed?: number };
    cases?: Array<{ name?: string; passed?: boolean }>;
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function runAllowFailure(
  binary: string,
  args: string[],
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  envelope: Envelope;
}> {
  const process = Bun.spawn([binary, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return {
    exitCode,
    stdout,
    stderr,
    envelope: JSON.parse(stdout) as Envelope,
  };
}

const BUN = "bun";
const CLI_ENTRY = join(import.meta.dir, "..", "src", "cli", "index.ts");
const EXAMPLES_DIR = join(import.meta.dir, "..", "examples");

const exampleTestFiles = [
  "approval.test.ts",
  "hello-world.test.ts",
  "rehearsal.test.ts",
];

async function main(): Promise<void> {
  const testFiles = exampleTestFiles.map((file) => join(EXAMPLES_DIR, file));
  const run = await runAllowFailure(BUN, [
    "run",
    CLI_ENTRY,
    "test",
    ...testFiles,
  ]);
  const summary = run.envelope.data?.summary;
  assert(
    run.exitCode === 0 && run.envelope.ok === true,
    `Example workflow tests failed: ${run.stderr || run.stdout}`,
  );
  assert(
    summary?.total === 9 && summary.passed === 9 && summary.failed === 0,
    `Expected 9/9 passing example tests, got ${JSON.stringify(summary)}`,
  );

  // A mutated expectation must be rejected: the assertions are strong enough
  // to catch a regression, not just run green.
  const directory = await mkdtemp(join(tmpdir(), "s8n-workflow-tests-gate-"));
  try {
    const mutated = join(directory, "mutated.test.ts");
    await Bun.write(
      mutated,
      `// No import: relies on the DSL globals injected by the test command.\n` +
        `export default defineSuite(\n` +
        `  { workflow: "${join(EXAMPLES_DIR, "approval.workflow.json")}" },\n` +
        `  (test) => {\n` +
        `    test("approved path must never reach slack", async (run, expect) => {\n` +
        `      const r = await run({\n` +
        `        input: { requestId: "r", amount: 10 },\n` +
        `        mocks: { "Post to Slack": { ok: true } },\n` +
        `        resume: { "Wait for approval": { approved: true } },\n` +
        `      });\n` +
        `      expect(r).status("success");\n` +
        `      expect(r).never("Post to Slack");\n` +
        `    });\n` +
        `  },\n` +
        `);\n`,
    );
    const mutatedRun = await runAllowFailure(BUN, [
      "run",
      CLI_ENTRY,
      "test",
      mutated,
    ]);
    assert(
      mutatedRun.exitCode === 1 &&
        mutatedRun.envelope.ok === false &&
        mutatedRun.envelope.data?.summary?.failed === 1,
      "A mutated expectation was not rejected by the workflow test runner",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  console.log(
    JSON.stringify(
      {
        status: "passed",
        assertions: {
          exampleSuitesLoaded: true,
          exampleTestsPassed: true,
          totalCases: summary?.total,
          crossNodeInvariantsVerified: true,
          failureDetectionVerified: true,
        },
      },
      null,
      2,
    ),
  );
}

await main();
