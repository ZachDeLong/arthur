#!/usr/bin/env node

import { Command } from "commander";
import { runCheck, type CheckOptions } from "../src/commands/check.js";
import { installPreCommitHook, uninstallPreCommitHook } from "../src/commands/hooks.js";
import { ARTHUR_VERSION } from "../src/version.js";

const program = new Command();

program
  .name("arthur")
  .description("Reference-integrity gate for AI-written code")
  .version(ARTHUR_VERSION);

program
  .command("check")
  .description("Run all deterministic checkers against a plan or code diff")
  .option("--plan <file>", "Path to plan file")
  .option("--stdin", "Read plan from stdin")
  .option("--diff <ref>", "Check code changes from git diff against <ref> (e.g., HEAD, origin/main)")
  .option("--staged", "With --diff, check only staged changes")
  .option("--no-untracked", "With --diff, exclude untracked source files")
  .option("--project <dir>", "Project directory (default: cwd)")
  .option("--format <format>", "Output format: text, json, or sarif (default: text)")
  .option("--schema <file>", "Path to Prisma schema file")
  .option("--include-experimental", "Include experimental checkers (package API)")
  .option("--strict", "Fail on low coverage; experimental checkers remain opt-in")
  .option(
    "--min-checked-refs <n>",
    "Coverage gate threshold (minimum number of refs that must be checked)",
    (value: string) => parseInt(value, 10),
  )
  .option(
    "--coverage-mode <mode>",
    "Coverage gate mode: off | warn | fail",
  )
  .option("--quiet", "Print nothing when the check has no findings")
  .action(async (opts: CheckOptions) => {
    const code = await runCheck(opts);
    process.exit(code);
  });

const hooks = program
  .command("hooks")
  .description("Install or remove Arthur Git hooks");

hooks
  .command("install")
  .description("Install an idempotent pre-commit hook for staged changes")
  .option("--project <dir>", "Git project directory (default: cwd)")
  .action((opts: { project?: string }) => {
    const result = installPreCommitHook(opts);
    const writer = result.code === 0 ? console.log : console.error;
    writer(result.message);
    process.exit(result.code);
  });

hooks
  .command("uninstall")
  .description("Remove the Arthur-managed pre-commit hook")
  .option("--project <dir>", "Git project directory (default: cwd)")
  .action((opts: { project?: string }) => {
    const result = uninstallPreCommitHook(opts);
    const writer = result.code === 0 ? console.log : console.error;
    writer(result.message);
    process.exit(result.code);
  });

program.parse();
