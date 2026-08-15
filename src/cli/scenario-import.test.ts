import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_ENTRY = join(import.meta.dir, "index.ts");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("scenario import", () => {
  test("emits one synthetic-shape manifest envelope without retaining values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "s8n-scenario-import-"));
    directories.push(directory);
    const workflowPath = join(directory, "workflow.json");
    const executionPath = join(directory, "execution.json");
    await Bun.write(
      workflowPath,
      JSON.stringify({
        name: "Import workflow",
        nodes: [
          { name: "Trigger", type: "n8n-nodes-base.manualTrigger" },
          { name: "Request", type: "n8n-nodes-base.httpRequest" },
        ],
        connections: {
          Trigger: {
            main: [[{ node: "Request", type: "main", index: 0 }]],
          },
        },
      }),
    );
    await Bun.write(
      executionPath,
      JSON.stringify({
        status: "success",
        data: {
          startData: { destinationNode: "Trigger" },
          resultData: {
            runData: {
              Trigger: [
                {
                  data: {
                    main: [[{ json: { email: "private@example.com" } }]],
                  },
                },
              ],
              Request: [
                {
                  data: {
                    main: [[{ json: { token: "do-not-copy" } }]],
                  },
                },
              ],
            },
          },
        },
      }),
    );

    const process = Bun.spawn(
      [
        "bun",
        "run",
        CLI_ENTRY,
        "scenario",
        "import",
        workflowPath,
        executionPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const envelope = JSON.parse(stdout);
    expect(envelope.command).toBe("scenario-import");
    expect(envelope.data.generatedFrom.dataMode).toBe("synthetic-shape");
    expect(stdout).not.toContain("private@example.com");
    expect(stdout).not.toContain("do-not-copy");
  });

  test("normalizes LLM outputs into a single llmOutputs section for review", async () => {
    const directory = await mkdtemp(join(tmpdir(), "s8n-scenario-import-"));
    directories.push(directory);
    const workflowPath = join(directory, "workflow.json");
    const executionPath = join(directory, "execution.json");
    await Bun.write(
      workflowPath,
      JSON.stringify({
        name: "Import LLM workflow",
        nodes: [
          { name: "Trigger", type: "n8n-nodes-base.manualTrigger" },
          { name: "Agent", type: "@n8n/n8n-nodes-langchain.agent" },
          {
            name: "OpenAI Model",
            type: "@n8n/n8n-nodes-langchain.lmChatOpenAi",
          },
        ],
        connections: {
          Trigger: {
            main: [[{ node: "Agent", type: "main", index: 0 }]],
          },
        },
      }),
    );
    await Bun.write(
      executionPath,
      JSON.stringify({
        status: "success",
        data: {
          startData: { destinationNode: "Trigger" },
          resultData: {
            runData: {
              Trigger: [{ data: { main: [[{ json: {} }]] } }],
              Agent: [
                {
                  data: {
                    main: [
                      [
                        {
                          json: {
                            output: {
                              proposals: [
                                { proposalId: "p1" },
                                { proposalId: "p2" },
                              ],
                            },
                          },
                        },
                      ],
                    ],
                  },
                },
              ],
              "OpenAI Model": [
                {
                  data: {
                    main: [
                      [
                        {
                          json: {
                            generations: [
                              { message: { content: "raw model text" } },
                            ],
                          },
                        },
                      ],
                    ],
                  },
                },
              ],
            },
          },
        },
      }),
    );

    const process = Bun.spawn(
      [
        "bun",
        "run",
        CLI_ENTRY,
        "scenario",
        "import",
        workflowPath,
        executionPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout);
    const llmOutputs = envelope.data.llmOutputs;
    expect(llmOutputs).toContainEqual({
      node: "Agent",
      kind: "agent-output",
      output: { proposals: [{ proposalId: "p1" }, { proposalId: "p2" }] },
      text: '{"proposals":[{"proposalId":"p1"},{"proposalId":"p2"}]}',
    });
    expect(llmOutputs).toContainEqual({
      node: "OpenAI Model",
      kind: "language-model",
      text: "raw model text",
    });
  });
});
