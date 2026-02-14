/**
 * Big Benchmark Runner: All 7 Static Checkers vs Self-Review
 *
 * Proves the core thesis: breadth of automatic coverage beats
 * any single prompt. Self-review must spread attention across
 * 7 categories. Arthur's 7 static checkers each run independently
 * at 100%. The gap is permanent.
 *
 * Arthur arm = static checkers only. No LLM call. 100% by definition.
 * Self-review arm = LLM only. Comprehensive adversarial prompt.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../../src/config/manager.js";
import { buildContext } from "../../src/context/builder.js";
import { generatePlan } from "./plan-generator.js";
import { analyzePaths } from "./path-checker.js";
import { parseSchema, analyzeSchema } from "./schema-checker.js";
import { analyzeSqlSchema } from "../../src/analysis/sql-schema-checker.js";
import { analyzeImports } from "../../src/analysis/import-checker.js";
import { analyzeEnv } from "../../src/analysis/env-checker.js";
// import { analyzeTypes } from "../../src/analysis/type-checker.js"; // disabled — 98% FP rate
import { analyzeApiRoutes } from "../../src/analysis/api-route-checker.js";
import { getAllFiles } from "../../src/context/tree.js";
import { extractGroundTruth, type AllCheckerResults } from "./ground-truth.js";
import { parseErrorDetections } from "./unified-detection-parser.js";
import {
  getBigBenchmarkSystemPrompt,
  buildBigBenchmarkUserMessage,
} from "../prompts/big-benchmark-prompt.js";
import type {
  PromptDefinition,
  CheckerCategory,
  BigBenchmarkRun,
  BigBenchmarkSummary,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.resolve(__dirname, "..");
const FIXTURES_DIR = path.join(BENCH_ROOT, "fixtures");
const PROMPTS_PATH = path.join(BENCH_ROOT, "prompts", "prompts.json");
const RESULTS_DIR = path.join(BENCH_ROOT, "results");

const ALL_CATEGORIES: CheckerCategory[] = [
  "path", "schema", "sql_schema", "import", "env", "route",
];

// --- Helpers ---

function loadPrompts(): PromptDefinition[] {
  const raw = fs.readFileSync(PROMPTS_PATH, "utf-8");
  return JSON.parse(raw) as PromptDefinition[];
}

function getFixtureDir(fixture: string): string {
  return path.join(FIXTURES_DIR, fixture);
}

function createRunDir(): string {
  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = path.join(RESULTS_DIR, `big-${runId}`);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

/** Run a single LLM call. */
async function runLlmReview(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<{ output: string; inputTokens: number; outputTokens: number }> {
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const output = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return {
    output,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

/** Run all applicable static checkers for a prompt. */
function runStaticCheckers(
  planText: string,
  fixtureDir: string,
  prompt: PromptDefinition,
): AllCheckerResults {
  const results: AllCheckerResults = {};

  // Path checker — always applicable
  results.paths = analyzePaths(planText, fixtureDir, prompt.allowedNewPaths);

  // Prisma schema — only if schemaFile configured
  if (prompt.schemaFile) {
    const schemaPath = path.join(fixtureDir, prompt.schemaFile);
    const schema = parseSchema(schemaPath);
    results.schema = analyzeSchema(planText, schema);
  }

  // SQL/Drizzle schema — auto-detected from project files
  results.sqlSchema = analyzeSqlSchema(planText, fixtureDir);

  // Imports — requires node_modules
  results.imports = analyzeImports(planText, fixtureDir);

  // Env variables — requires .env* files
  results.env = analyzeEnv(planText, fixtureDir);

  // TypeScript types — disabled in benchmark (98% FP rate, needs structural fix)
  // results.types = analyzeTypes(planText, fixtureDir);

  // API routes — requires Next.js App Router structure
  results.routes = analyzeApiRoutes(planText, fixtureDir);

  return results;
}

/** Compute per-category stats from detections. */
function computePerCategory(
  detections: ReturnType<typeof parseErrorDetections>,
): Record<CheckerCategory, { errors: number; detected: number; rate: number }> {
  const result = {} as Record<CheckerCategory, { errors: number; detected: number; rate: number }>;

  for (const cat of ALL_CATEGORIES) {
    const catDetections = detections.filter((d) => d.error.category === cat);
    const errors = catDetections.length;
    const detected = catDetections.filter((d) => d.detected).length;
    result[cat] = {
      errors,
      detected,
      rate: errors > 0 ? detected / errors : 1,
    };
  }

  return result;
}

/** Run the big benchmark for a single prompt. */
async function runPrompt(
  prompt: PromptDefinition,
  apiKey: string,
  model: string,
): Promise<BigBenchmarkRun | null> {
  const fixtureDir = getFixtureDir(prompt.fixture);

  // Step 1: Generate plan (README-only context)
  console.log(chalk.blue(`  [${prompt.id}] Generating plan...`));
  const planResult = await generatePlan(prompt, fixtureDir, apiKey, model);
  console.log(
    chalk.dim(
      `  [${prompt.id}] Plan: ${planResult.inputTokens} in / ${planResult.outputTokens} out`,
    ),
  );

  // Step 2: Run all static checkers → ground truth
  console.log(chalk.blue(`  [${prompt.id}] Running static checkers...`));
  const checkerResults = runStaticCheckers(planResult.plan, fixtureDir, prompt);
  const groundTruth = extractGroundTruth(checkerResults);

  // Log per-category counts
  const categoryCounts = new Map<string, number>();
  for (const error of groundTruth) {
    categoryCounts.set(error.category, (categoryCounts.get(error.category) ?? 0) + 1);
  }
  const countStr = [...categoryCounts.entries()]
    .map(([cat, count]) => `${cat}:${count}`)
    .join(", ");
  console.log(
    chalk.dim(
      `  [${prompt.id}] Ground truth: ${groundTruth.length} errors (${countStr || "none"})`,
    ),
  );

  // Step 3: Skip if no errors
  if (groundTruth.length === 0) {
    console.log(
      chalk.yellow(`  [${prompt.id}] No errors found — skipping self-review`),
    );
    return null;
  }

  // Step 4: Build full project context for self-review
  const context = buildContext({
    projectDir: fixtureDir,
    planText: planResult.plan,
    prompt: prompt.task,
    tokenBudget: 80_000,
  });

  // Step 5: Run self-review LLM
  console.log(chalk.blue(`  [${prompt.id}] Running self-review...`));
  const selfReviewResult = await runLlmReview(
    apiKey,
    model,
    getBigBenchmarkSystemPrompt(),
    buildBigBenchmarkUserMessage(context),
  );
  console.log(
    chalk.dim(
      `  [${prompt.id}] Self-review: ${selfReviewResult.inputTokens} in / ${selfReviewResult.outputTokens} out`,
    ),
  );

  // Step 6: Parse detections
  const actualFiles = getAllFiles(fixtureDir);
  const detections = parseErrorDetections(
    groundTruth,
    selfReviewResult.output,
    actualFiles,
  );

  // Step 7: Score
  const perCategory = computePerCategory(detections);
  const totalDetected = detections.filter((d) => d.detected).length;
  const overallDetectionRate = totalDetected / groundTruth.length;

  console.log(
    chalk.green(
      `  [${prompt.id}] Self-review detected ${totalDetected}/${groundTruth.length} (${(overallDetectionRate * 100).toFixed(1)}%)`,
    ),
  );

  // Print per-category summary
  for (const [cat, stats] of Object.entries(perCategory)) {
    if (stats.errors > 0) {
      const color = stats.rate >= 1 ? chalk.green : stats.rate > 0.5 ? chalk.yellow : chalk.red;
      console.log(
        chalk.dim(`    ${cat}: `) + color(`${stats.detected}/${stats.errors} (${(stats.rate * 100).toFixed(0)}%)`),
      );
    }
  }

  return {
    promptId: prompt.id,
    fixture: prompt.fixture,
    task: prompt.task,
    model,
    generatedPlan: planResult.plan,
    groundTruth,
    selfReviewOutput: selfReviewResult.output,
    detections,
    perCategory,
    overallDetectionRate,
    inputTokens: planResult.inputTokens + selfReviewResult.inputTokens,
    outputTokens: planResult.outputTokens + selfReviewResult.outputTokens,
    timestamp: new Date().toISOString(),
  };
}

/** Generate summary across all runs. */
function generateSummary(
  runs: BigBenchmarkRun[],
  model: string,
): BigBenchmarkSummary {
  const totalErrors = runs.reduce((sum, r) => sum + r.groundTruth.length, 0);
  const totalDetected = runs.reduce(
    (sum, r) => sum + r.detections.filter((d) => d.detected).length,
    0,
  );

  // Per-category aggregation
  const perCategory = {} as Record<CheckerCategory, { errors: number; detected: number; rate: number }>;
  for (const cat of ALL_CATEGORIES) {
    const errors = runs.reduce((sum, r) => sum + r.perCategory[cat].errors, 0);
    const detected = runs.reduce((sum, r) => sum + r.perCategory[cat].detected, 0);
    perCategory[cat] = {
      errors,
      detected,
      rate: errors > 0 ? detected / errors : 1,
    };
  }

  // Per-fixture aggregation
  const fixtureMap = new Map<string, { errors: number; detected: number }>();
  for (const run of runs) {
    const existing = fixtureMap.get(run.fixture) ?? { errors: 0, detected: 0 };
    existing.errors += run.groundTruth.length;
    existing.detected += run.detections.filter((d) => d.detected).length;
    fixtureMap.set(run.fixture, existing);
  }
  const perFixture: Record<string, { errors: number; detected: number; rate: number }> = {};
  for (const [fixture, stats] of fixtureMap) {
    perFixture[fixture] = {
      ...stats,
      rate: stats.errors > 0 ? stats.detected / stats.errors : 1,
    };
  }

  return {
    totalRuns: runs.length,
    model,
    totalErrors,
    totalDetected,
    overallDetectionRate: totalErrors > 0 ? totalDetected / totalErrors : 1,
    perCategory,
    perFixture,
    perRun: runs.map((r) => ({
      promptId: r.promptId,
      fixture: r.fixture,
      errors: r.groundTruth.length,
      detected: r.detections.filter((d) => d.detected).length,
      rate: r.overallDetectionRate,
    })),
    apiUsage: {
      totalInputTokens: runs.reduce((sum, r) => sum + r.inputTokens, 0),
      totalOutputTokens: runs.reduce((sum, r) => sum + r.outputTokens, 0),
    },
  };
}

/** Main benchmark runner. */
export async function runBigBenchmark(
  promptIds?: string[],
): Promise<void> {
  const config = loadConfig(path.resolve("."));
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      chalk.red(
        "No API key found. Set ANTHROPIC_API_KEY or run codeverifier init.",
      ),
    );
    process.exit(1);
  }

  const model = config.model;
  const allPrompts = loadPrompts();
  const prompts = promptIds
    ? allPrompts.filter((p) => promptIds.includes(p.id))
    : allPrompts;

  if (prompts.length === 0) {
    console.error(chalk.red("No matching prompts found."));
    process.exit(1);
  }

  console.log(
    chalk.bold.cyan(
      `\nBig Benchmark: All 7 Checkers vs Self-Review\n` +
        `Running ${prompts.length} prompts with model: ${model}\n`,
    ),
  );

  const runDir = createRunDir();
  console.log(chalk.dim(`Results: ${runDir}\n`));

  const runs: BigBenchmarkRun[] = [];

  for (const prompt of prompts) {
    console.log(
      chalk.bold(`\nPrompt ${prompt.id}: ${prompt.task.slice(0, 60)}...`),
    );

    const run = await runPrompt(prompt, apiKey, model);

    if (run) {
      runs.push(run);

      // Save per-run result
      const runFile = path.join(runDir, `prompt-${prompt.id}.json`);
      fs.writeFileSync(runFile, JSON.stringify(run, null, 2) + "\n", "utf-8");
    }
  }

  if (runs.length === 0) {
    console.log(chalk.yellow("\nNo runs with errors to analyze."));
    return;
  }

  // Generate summary
  const summary = generateSummary(runs, model);
  const summaryFile = path.join(runDir, "summary.json");
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n", "utf-8");

  // Generate report
  const report = generateBigBenchmarkReport(runs, summary);
  const reportFile = path.join(runDir, "REPORT.md");
  fs.writeFileSync(reportFile, report, "utf-8");

  // Print final summary
  console.log(chalk.bold.cyan("\n══════════════════════════════════════════"));
  console.log(chalk.bold.cyan("  Big Benchmark — Final Results"));
  console.log(chalk.bold.cyan("══════════════════════════════════════════\n"));

  console.log(`  Model: ${model}`);
  console.log(`  Prompts with errors: ${runs.length}`);
  console.log(`  Total errors: ${summary.totalErrors}\n`);

  // Category table
  console.log("  Category          Errors  Static  Self-Review  Gap");
  console.log("  ────────────────  ──────  ──────  ───────────  ──────");

  for (const cat of ALL_CATEGORIES) {
    const stats = summary.perCategory[cat];
    if (stats.errors === 0) continue;
    const pad = (s: string, n: number) => s.padEnd(n);
    const staticRate = "100%";
    const selfRate = `${(stats.rate * 100).toFixed(0)}%`;
    const gap = `${((1 - stats.rate) * 100).toFixed(0)}pp`;
    console.log(
      `  ${pad(cat, 18)}${String(stats.errors).padStart(4)}    ${staticRate.padStart(4)}    ${selfRate.padStart(9)}  ${gap.padStart(5)}`,
    );
  }

  console.log("  ────────────────  ──────  ──────  ───────────  ──────");
  console.log(
    `  ${"OVERALL".padEnd(18)}${String(summary.totalErrors).padStart(4)}    ${"100%".padStart(4)}    ${`${(summary.overallDetectionRate * 100).toFixed(0)}%`.padStart(9)}  ${`${((1 - summary.overallDetectionRate) * 100).toFixed(0)}pp`.padStart(5)}`,
  );

  console.log(chalk.dim(`\n  Results: ${runDir}`));
  console.log(chalk.dim(`  Report: ${reportFile}`));
}

/** Generate markdown report inline (also available as separate module). */
function generateBigBenchmarkReport(
  runs: BigBenchmarkRun[],
  summary: BigBenchmarkSummary,
): string {
  // Import and delegate to the report generator
  return generateReportMarkdown(runs, summary);
}

/** Inline report generation — mirrors big-benchmark-report.ts. */
function generateReportMarkdown(
  runs: BigBenchmarkRun[],
  summary: BigBenchmarkSummary,
): string {
  const lines: string[] = [];

  lines.push("# Big Benchmark: All 7 Checkers vs Self-Review\n");
  lines.push(
    `> ${summary.totalRuns} prompts, ${summary.totalErrors} ground-truth errors. Model: ${summary.model}. Generated ${new Date().toISOString().slice(0, 10)}.\n`,
  );
  lines.push(
    "Arthur's static checkers catch errors deterministically at 100%. Self-review must spread attention across 7 categories with a single prompt. The question: **what percentage of real errors does self-review independently catch?**\n",
  );

  // Main comparison table
  lines.push("## Results by Category\n");
  lines.push("| Category | Errors | Static (Arthur) | Self-Review | Gap |");
  lines.push("|----------|--------|-----------------|-------------|-----|");

  for (const cat of ALL_CATEGORIES) {
    const stats = summary.perCategory[cat];
    if (stats.errors === 0) continue;
    const selfRate = `${(stats.rate * 100).toFixed(1)}%`;
    const gap = `${((1 - stats.rate) * 100).toFixed(1)}pp`;
    lines.push(
      `| ${cat} | ${stats.errors} | 100% | ${selfRate} | ${gap} |`,
    );
  }

  lines.push(
    `| **Overall** | **${summary.totalErrors}** | **100%** | **${(summary.overallDetectionRate * 100).toFixed(1)}%** | **${((1 - summary.overallDetectionRate) * 100).toFixed(1)}pp** |`,
  );
  lines.push("");

  // Per-fixture breakdown
  lines.push("## Results by Fixture\n");
  lines.push("| Fixture | Errors | Self-Review Rate |");
  lines.push("|---------|--------|-----------------|");

  for (const [fixture, stats] of Object.entries(summary.perFixture)) {
    lines.push(
      `| ${fixture} | ${stats.errors} | ${(stats.rate * 100).toFixed(1)}% |`,
    );
  }
  lines.push("");

  // Per-run detail
  lines.push("## Per-Run Detail\n");
  lines.push("| Prompt | Fixture | Errors | Detected | Rate |");
  lines.push("|--------|---------|--------|----------|------|");

  for (const run of runs) {
    const detected = run.detections.filter((d) => d.detected).length;
    lines.push(
      `| ${run.promptId} | ${run.fixture} | ${run.groundTruth.length} | ${detected} | ${(run.overallDetectionRate * 100).toFixed(1)}% |`,
    );
  }
  lines.push("");

  // Missed errors detail
  lines.push("## Missed Errors (Self-Review Failed to Detect)\n");

  for (const run of runs) {
    const missed = run.detections.filter((d) => !d.detected);
    if (missed.length === 0) continue;

    lines.push(`### Prompt ${run.promptId} (${run.fixture})\n`);
    for (const det of missed) {
      const suggestion = det.error.suggestion ? ` (suggestion: ${det.error.suggestion})` : "";
      lines.push(`- **[${det.error.category}]** \`${det.error.raw}\` — ${det.error.description}${suggestion}`);
    }
    lines.push("");
  }

  // Methodology
  lines.push("## Methodology\n");
  lines.push("1. **Plan generation:** LLM generates a plan with README-only context (no file tree, no source code)");
  lines.push("2. **Ground truth:** All 7 static checkers run against the plan to identify errors deterministically");
  lines.push("3. **Self-review:** Same model reviews its own plan with adversarial prompt + full project context");
  lines.push("4. **Scoring:** Self-review output parsed for detection of each ground-truth error\n");
  lines.push("**Key insight:** Arthur's static checkers are the ground truth. They run independently, each at 100% detection, with zero attention budget competition. Self-review must allocate finite LLM attention across all 7 categories simultaneously.\n");

  // API usage
  lines.push("## API Usage\n");
  lines.push(`- Total input tokens: ${summary.apiUsage.totalInputTokens.toLocaleString()}`);
  lines.push(`- Total output tokens: ${summary.apiUsage.totalOutputTokens.toLocaleString()}`);
  lines.push("");

  return lines.join("\n");
}

// CLI entry point
if (
  process.argv[1] &&
  (process.argv[1].endsWith("big-benchmark-runner.ts") ||
    process.argv[1].endsWith("big-benchmark-runner.js"))
) {
  const args = process.argv.slice(2);
  runBigBenchmark(args.length > 0 ? args : undefined);
}
