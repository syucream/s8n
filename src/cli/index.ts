#!/usr/bin/env bun
import { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import { registerInitCommand } from "./commands/init.ts";
import { registerRehearseCommand } from "./commands/rehearse.ts";
import { registerRunCommand } from "./commands/run.ts";
import { registerScenarioCommand } from "./commands/scenario.ts";
import { registerSchemaCommand } from "./commands/schema.ts";
import { registerValidateCommand } from "./commands/validate.ts";

const program = new Command();

program
  .name("s8n")
  .description(
    "Simulate n8n workflows locally with mocked I/O and optional stateful emulators. Designed for use by AI agents.",
  )
  .version(packageJson.version);

registerRunCommand(program);
registerRehearseCommand(program);
registerScenarioCommand(program);
registerValidateCommand(program);
registerSchemaCommand(program);
registerInitCommand(program);

program.parseAsync(process.argv);
