import { describe, expect, test } from "bun:test";
import { workflowNodeSchema } from "../schema/workflow.ts";
import { formatAiRootOutput } from "./ai-contract.ts";

const agent = workflowNodeSchema.parse({
  id: "agent",
  name: "Agent",
  type: "@n8n/n8n-nodes-langchain.agent",
  typeVersion: 3,
  parameters: {},
});

describe("AI output contracts", () => {
  test("parses fenced JSON and validates a structured-output example", () => {
    const parser = workflowNodeSchema.parse({
      id: "parser",
      name: "Parser",
      type: "@n8n/n8n-nodes-langchain.outputParserStructured",
      typeVersion: 1.3,
      parameters: {
        schemaType: "fromJson",
        jsonSchemaExample: '{"summary":"","score":0}',
      },
    });
    expect(
      formatAiRootOutput(
        agent,
        '```json\n{"output":{"summary":"ready","score":1}}\n```',
        parser,
      ),
    ).toEqual({ output: { summary: "ready", score: 1 } });
  });

  test("rejects a response that violates the parser contract", () => {
    const parser = workflowNodeSchema.parse({
      id: "parser",
      name: "Parser",
      type: "@n8n/n8n-nodes-langchain.outputParserStructured",
      typeVersion: 1.3,
      parameters: {
        schemaType: "manual",
        inputSchema:
          '{"type":"object","required":["score"],"properties":{"score":{"type":"number"}}}',
      },
    });
    expect(() =>
      formatAiRootOutput(agent, '{"output":{"score":"high"}}', parser),
    ).toThrow("output.score must be number");
  });
});
