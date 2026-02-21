#!/usr/bin/env node

import { Command } from "commander";
import { runCheck, type CheckOptions } from "../src/commands/check.js";

const program = new Command();

program
  .name("arthur")
  .description("Ground truth verification for AI-generated code plans")
  .version("0.4.0");

program
  .command("check")
  .description("Run all deterministic checkers against a plan")
  .option("--plan <file>", "Path to plan file")
  .option("--stdin", "Read plan from stdin")
  .option("--project <dir>", "Project directory (default: cwd)")
  .option("--format <format>", "Output format: text or json (default: text)")
  .option("--schema <file>", "Path to Prisma schema file")
  .action(async (opts: CheckOptions) => {
    const code = await runCheck(opts);
    process.exit(code);
  });

program.parse();
