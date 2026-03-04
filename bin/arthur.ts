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
  .description("Run all deterministic checkers against a plan or code diff")
  .option("--plan <file>", "Path to plan file")
  .option("--stdin", "Read plan from stdin")
  .option("--diff <ref>", "Check code changes from git diff against <ref> (e.g., HEAD, origin/main)")
  .option("--staged", "With --diff, check only staged changes")
  .option("--project <dir>", "Project directory (default: cwd)")
  .option("--format <format>", "Output format: text or json (default: text)")
  .option("--schema <file>", "Path to Prisma schema file")
  .option("--include-experimental", "Include experimental checkers (types + package API)")
  .option("--strict", "Enable strict mode (includes experimental checkers and coverage fail)")
  .option(
    "--min-checked-refs <n>",
    "Coverage gate threshold (minimum number of refs that must be checked)",
    (value: string) => parseInt(value, 10),
  )
  .option(
    "--coverage-mode <mode>",
    "Coverage gate mode: off | warn | fail",
  )
  .action(async (opts: CheckOptions) => {
    const code = await runCheck(opts);
    process.exit(code);
  });

program.parse();
