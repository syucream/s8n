import type { Command } from "commander";
import { printEnvelope } from "../../format/output.ts";

const TEMPLATE = {
  name: "example-workflow",
  nodes: [
    {
      id: "1",
      name: "Manual Trigger",
      type: "n8n-nodes-base.manualTrigger",
      typeVersion: 1,
      position: [0, 0],
      parameters: {},
    },
    {
      id: "2",
      name: "Set",
      type: "n8n-nodes-base.set",
      typeVersion: 1,
      position: [300, 0],
      parameters: {
        fields: [
          { name: "message", value: "=Hello, {{$json.name ?? 'world'}}!" },
        ],
      },
    },
  ],
  connections: {
    "Manual Trigger": { main: [[{ node: "Set", type: "main", index: 0 }]] },
  },
};

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description(
      "Write a minimal sample workflow JSON (to stdout when --out is omitted)",
    )
    .option("--out <file>", "output file path")
    .action(async (opts: { out?: string }) => {
      const json = JSON.stringify(TEMPLATE, null, 2);
      if (opts.out) {
        await Bun.write(opts.out, `${json}\n`);
        printEnvelope({
          ok: true,
          command: "init",
          data: { written: opts.out },
        });
        return;
      }
      printEnvelope({
        ok: true,
        command: "init",
        data: { workflow: TEMPLATE },
      });
    });
}
