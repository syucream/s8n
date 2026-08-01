import type { Command } from "commander";
import { printEnvelope } from "../../format/output.ts";
import {
  allNodeTypeMockHints,
  findNodeTypeMockHint,
} from "../../mock/node-type-hints.ts";
import { findNodeTypeDoc, NODE_TYPE_DOCS } from "../../nodes/docs.ts";

export function registerSchemaCommand(program: Command): void {
  program
    .command("schema [nodeType]")
    .description(
      "Describe expected node parameters and mock data for AI agents (lists all node types when omitted)",
    )
    .action((nodeType?: string) => {
      if (!nodeType) {
        printEnvelope({
          ok: true,
          command: "schema",
          data: {
            executedNodeTypes: NODE_TYPE_DOCS,
            mockedNodeTypesWithTailoredHints: allNodeTypeMockHints(),
          },
        });
        return;
      }

      const doc = findNodeTypeDoc(nodeType);
      if (doc) {
        printEnvelope({ ok: true, command: "schema", data: doc });
        return;
      }

      const hint = findNodeTypeMockHint(nodeType);
      if (hint) {
        printEnvelope({
          ok: true,
          command: "schema",
          data: {
            type: nodeType,
            summary: `Unmodeled external I/O node. s8n replaces its execution with a mock. ${hint.description}`,
            parametersShape: {},
            requiresMock: true,
            mockKeyConvention: "<nodeName> or <nodeName>#<itemIndex>",
            tailoredMockExample: hint.example,
          },
        });
        return;
      }

      printEnvelope({
        ok: true,
        command: "schema",
        data: {
          type: nodeType,
          summary:
            "s8n has no dedicated implementation for this node. It is treated as external I/O and requests a mock instead of failing.",
          parametersShape: {},
          requiresMock: true,
          mockKeyConvention: "<nodeName> or <nodeName>#<itemIndex>",
        },
      });
    });
}
