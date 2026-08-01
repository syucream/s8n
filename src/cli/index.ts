#!/usr/bin/env bun
import { Command } from "commander";
import { registerInitCommand } from "./commands/init.ts";
import { registerRunCommand } from "./commands/run.ts";
import { registerSchemaCommand } from "./commands/schema.ts";
import { registerValidateCommand } from "./commands/validate.ts";

const program = new Command();

program
  .name("s8n")
  .description(
    "Simulate n8n workflows locally with all external I/O mocked. Designed for use by AI agents.",
  )
  .version("0.1.0");

registerRunCommand(program);
registerValidateCommand(program);
registerSchemaCommand(program);
registerInitCommand(program);

program.parseAsync(process.argv);
