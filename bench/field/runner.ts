#!/usr/bin/env node
import path from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { captureChange } from "./capture.js";
import { runFieldComparator } from "./comparator.js";
import { freezeStudy } from "./freeze.js";
import {
  createAdjudicationTemplate,
  createBaselineTemplate,
  createReviewTemplate,
  recordRetention,
  submitAdjudication,
  submitBaseline,
  submitReview,
} from "./review.js";
import { scoreFieldStudy } from "./score.js";
import { initializeStudy, recordExclusion, summarizeStudy } from "./study.js";
import { assertSimpleId } from "./storage.js";
import type { ToolCommand, ToolKind } from "./types.js";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseTool(spec: string): ToolCommand {
  const match = spec.match(/^(compiler|test|lint|other):([A-Za-z0-9][A-Za-z0-9._-]{0,79})=(.+)$/s);
  if (!match) {
    throw new Error(
      `Invalid --tool "${spec}". Use kind:name=command, for example test:unit=npm test.`,
    );
  }
  return {
    kind: match[1] as ToolKind,
    name: match[2],
    command: match[3].trim(),
  };
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

const program = new Command();
program
  .name("arthur-field")
  .description("Preregistered real-world validation workflow for Arthur")
  .showHelpAfterError();

program.command("init")
  .description("Initialize an empty v1 study directory")
  .requiredOption("--study <directory>", "study data directory")
  .option("--id <study-id>", "public study identifier")
  .action((options: { study: string; id?: string }) => {
    const manifest = initializeStudy(options.study, options.id);
    console.log(chalk.green(`Initialized ${manifest.studyId} at ${path.resolve(options.study)}`));
    print(summarizeStudy(options.study));
  });

program.command("capture")
  .description("Capture one committed, eligible AI-authored change before labels exist")
  .requiredOption("--study <directory>", "study data directory")
  .requiredOption("--project <directory>", "clean target repository root at result HEAD")
  .requiredOption("--base <ref>", "base commit before the agent change")
  .option("--result <ref>", "result commit, which must be checked out", "HEAD")
  .requiredOption("--repository <id>", "stable public or anonymized repository ID")
  .requiredOption("--developer <id>", "stable anonymized developer ID")
  .requiredOption("--agent <name>", "AI coding agent used")
  .requiredOption("--agent-evidence <text>", "how agent authorship was established")
  .option("--public-url <url>", "public repository URL")
  .option(
    "--tool <kind:name=command>",
    "existing compiler/test/lint command; repeat as needed",
    collect,
    [],
  )
  .option("--no-tools-reason <text>", "required when the project has no standard commands")
  .option("--tool-timeout-ms <number>", "timeout per standard command", "120000")
  .action((options: {
    study: string;
    project: string;
    base: string;
    result: string;
    repository: string;
    developer: string;
    agent: string;
    agentEvidence: string;
    publicUrl?: string;
    tool: string[];
    noToolsReason?: string;
    toolTimeoutMs: string;
  }) => {
    const timeout = Number.parseInt(options.toolTimeoutMs, 10);
    if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 30 * 60_000) {
      throw new Error("--tool-timeout-ms must be between 1000 and 1800000.");
    }
    const directory = captureChange({
      studyDir: options.study,
      projectDir: options.project,
      baseRef: options.base,
      resultRef: options.result,
      repositoryId: assertSimpleId(options.repository, "Repository ID"),
      developerId: assertSimpleId(options.developer, "Developer ID"),
      agentTool: options.agent,
      agentEvidence: options.agentEvidence,
      publicRepositoryUrl: options.publicUrl,
      tools: options.tool.map(parseTool),
      noStandardToolsReason: options.noToolsReason,
      toolTimeoutMs: timeout,
    });
    console.log(chalk.green(`Captured change at ${directory}`));
    print(summarizeStudy(options.study));
  });

program.command("exclude")
  .description("Record an eligible-stream exclusion without silently dropping it")
  .requiredOption("--study <directory>")
  .requiredOption("--repository <id>")
  .requiredOption("--reason <reason>")
  .requiredOption("--note <text>")
  .option("--base <commit>")
  .option("--result <commit>")
  .action((options: {
    study: string;
    repository: string;
    reason: string;
    note: string;
    base?: string;
    result?: string;
  }) => {
    const candidateId = recordExclusion({
      studyDir: options.study,
      repositoryId: assertSimpleId(options.repository, "Repository ID"),
      reason: options.reason,
      note: options.note,
      baseCommit: options.base,
      resultCommit: options.result,
    });
    console.log(chalk.green(`Recorded exclusion ${candidateId}`));
  });

program.command("comparator")
  .description("Run/resume the fixed LLM comparator after collection and before labels")
  .requiredOption("--study <directory>")
  .requiredOption("--input-usd-per-million <number>", "published input-token rate")
  .requiredOption("--output-usd-per-million <number>", "published output-token rate")
  .requiredOption("--pricing-source <text>", "URL or dated source for those rates")
  .action(async (options: {
    study: string;
    inputUsdPerMillion: string;
    outputUsdPerMillion: string;
    pricingSource: string;
  }) => {
    const inputUsdPerMillion = Number(options.inputUsdPerMillion);
    const outputUsdPerMillion = Number(options.outputUsdPerMillion);
    if (
      !Number.isFinite(inputUsdPerMillion) || inputUsdPerMillion < 0 ||
      !Number.isFinite(outputUsdPerMillion) || outputUsdPerMillion < 0
    ) {
      throw new Error("Comparator token prices must be non-negative numbers.");
    }
    const result = await runFieldComparator(options.study, undefined, {
      inputUsdPerMillion,
      outputUsdPerMillion,
      source: options.pricingSource,
    });
    console.log(chalk.green(`Frozen ${result.predictions.length} ${result.system} predictions.`));
    print({
      system: result.system,
      requestedModel: result.requestedModel,
      resolvedModel: result.model,
      promptSha256: result.promptSha256,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedCostUsd: result.estimatedCostUsd,
      pricing: result.pricing,
      durationMs: result.durationMs,
    });
  });

program.command("freeze")
  .description("Lock captures and predictions, then create detector-blind review packets")
  .requiredOption("--study <directory>")
  .action((options: { study: string }) => {
    const lock = freezeStudy(options.study);
    console.log(chalk.green(`Study frozen at ${lock.frozenAt}`));
    print(lock);
  });

program.command("review-template")
  .description("Create a blank primary-review submission")
  .requiredOption("--study <directory>")
  .requiredOption("--reviewer <id>")
  .requiredOption("--out <file>")
  .action((options: { study: string; reviewer: string; out: string }) => {
    createReviewTemplate(options.study, options.reviewer, options.out);
    console.log(chalk.green(`Review template written to ${path.resolve(options.out)}`));
  });

program.command("submit-review")
  .description("Validate and lock one blinded primary review")
  .requiredOption("--study <directory>")
  .requiredOption("--file <file>")
  .action((options: { study: string; file: string }) => {
    console.log(chalk.green(`Review locked at ${submitReview(options.study, options.file)}`));
  });

program.command("adjudication-template")
  .description("Create a third-reviewer template for disagreements and uncertain labels")
  .requiredOption("--study <directory>")
  .requiredOption("--adjudicator <id>")
  .requiredOption("--out <file>")
  .action((options: { study: string; adjudicator: string; out: string }) => {
    const count = createAdjudicationTemplate(
      options.study,
      options.adjudicator,
      options.out,
    );
    console.log(chalk.green(`Adjudication template contains ${count} case(s).`));
  });

program.command("submit-adjudication")
  .description("Validate and lock third-reviewer decisions")
  .requiredOption("--study <directory>")
  .requiredOption("--file <file>")
  .action((options: { study: string; file: string }) => {
    console.log(chalk.green(`Adjudication locked at ${submitAdjudication(options.study, options.file)}`));
  });

program.command("baseline-template")
  .description("Create post-label attribution for existing compiler/test/lint commands")
  .requiredOption("--study <directory>")
  .requiredOption("--assessor <id>")
  .requiredOption("--out <file>")
  .action((options: { study: string; assessor: string; out: string }) => {
    const count = createBaselineTemplate(options.study, options.assessor, options.out);
    console.log(chalk.green(`Baseline template contains ${count} actionable occurrence(s).`));
  });

program.command("submit-baseline")
  .description("Validate and lock standard-tool attribution")
  .requiredOption("--study <directory>")
  .requiredOption("--file <file>")
  .action((options: { study: string; file: string }) => {
    console.log(chalk.green(`Baseline attribution locked at ${submitBaseline(options.study, options.file)}`));
  });

program.command("retention")
  .description("Record an external developer's keep/remove decision before aggregate results")
  .requiredOption("--study <directory>")
  .requiredOption("--developer <id>")
  .requiredOption("--keep <yes|no>")
  .option("--note <text>")
  .action((options: { study: string; developer: string; keep: string; note?: string }) => {
    const normalized = options.keep.toLowerCase();
    if (!['yes', 'no'].includes(normalized)) throw new Error("--keep must be yes or no.");
    const target = recordRetention(options.study, {
      developerId: options.developer,
      externalToArthurImplementation: true,
      keepEnabled: normalized === "yes",
      recordedBeforeAggregateResults: true,
      note: options.note,
    });
    console.log(chalk.green(`Retention decision locked at ${target}`));
  });

program.command("score")
  .description("Score adjudicated labels once and apply the preregistered decision rule")
  .requiredOption("--study <directory>")
  .action((options: { study: string }) => {
    const report = scoreFieldStudy(options.study);
    print(report.decision);
    console.log(chalk.green(`Reports written under ${path.resolve(options.study)}`));
  });

program.command("status")
  .description("Show collection, review, and decision progress")
  .requiredOption("--study <directory>")
  .action((options: { study: string }) => print(summarizeStudy(options.study)));

program.parseAsync().catch((error) => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
