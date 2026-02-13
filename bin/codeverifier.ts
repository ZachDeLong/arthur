#!/usr/bin/env node

import { Command } from "commander";
import { runInit } from "../src/commands/init.js";
import { runVerify, type VerifyOptions } from "../src/commands/verify.js";

const program = new Command();

program
  .name("codeverifier")
  .description("Independent verification layer for Claude Code plans")
  .version("0.1.0");

program
  .command("init")
  .description("Set up API key and default configuration")
  .action(async () => {
    await runInit();
  });

program
  .command("verify")
  .description("Verify a plan with an independent Claude review")
  .option("--plan <file>", "Path to plan file")
  .option("--stdin", "Read plan from stdin")
  .option("--prompt <value>", "Original user request (literal string)")
  .option("--project <dir>", "Project directory (default: cwd)")
  .option("--model <model>", "Claude model to use")
  .option("--verbose", "Show token usage and context details")
  .option("--no-static", "Skip static analysis (pure LLM mode)")
  .option("--schema <file>", "Path to Prisma schema file for static validation")
  .action(async (opts: VerifyOptions) => {
    await runVerify(opts);
  });

program.parse();
