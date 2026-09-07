/**
 * Big Benchmark Runner: Static Checker Findings vs Self-Review
 *
 * This is an agreement study: Arthur generates candidate findings, then an
 * LLM independently reviews the same plan with full project context. Arthur's
 * findings are not independently adjudicated ground truth.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { loadConfig } from "../../src/config/manager.js";
import { buildContext } from "../../src/context/builder.js";
import { generatePlan } from "./plan-generator.js";
import {
  formatBenchmarkModel,
  resolveBenchmarkLlm,
  runBenchmarkLlm,
  type BenchmarkLlmOptions,
} from "./llm-provider.js";
import { analyzePaths } from "./path-checker.js";
import { parseSchema, analyzeSchema } from "./schema-checker.js";
import { analyzeSqlSchema } from "../../src/analysis/sql-schema-checker.js";
import { analyzeImports } from "../../src/analysis/import-checker.js";
import { analyzeEnv } from "../../src/analysis/env-checker.js";
import { analyzeApiRoutes } from "../../src/analysis/api-route-checker.js";
import { getAllFiles } from "../../src/context/tree.js";
import { extractGroundTruth, type AllCheckerResults } from "./ground-truth.js";
import { parseErrorDetections } from "./unified-detection-parser.js";
import { generateBigReport } from "./big-benchmark-report.js";
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

export const ALL_CATEGORIES: CheckerCategory[] = [
  "path", "schema", "sql_schema", "import", "env", "route",
];

// --- Helpers ---

export function loadPrompts(): PromptDefinition[] {
  const raw = fs.readFileSync(PROMPTS_PATH, "utf-8");
  return JSON.parse(raw) as PromptDefinition[];
}

export function getFixtureDir(fixture: string): string {
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
  llm: BenchmarkLlmOptions,
  systemPrompt: string,
  userMessage: string,
): Promise<{ output: string; inputTokens: number; outputTokens: number }> {
  return runBenchmarkLlm({
    ...llm,
    systemPrompt,
    userMessage,
    maxOutputTokens: 16_000,
    anthropicThinking: "adaptive",
    anthropicEffort: "medium",
  });
}

/** Run all applicable static checkers for a prompt. */
export function runStaticCheckers(
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

  // API routes — requires Next.js App Router structure
  results.routes = analyzeApiRoutes(planText, fixtureDir);

  return results;
}

/** Compute per-category stats from detections. */
export function computePerCategory(
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
  llm: BenchmarkLlmOptions,
): Promise<BigBenchmarkRun | null> {
  const fixtureDir = getFixtureDir(prompt.fixture);

  // Step 1: Generate plan (README-only context)
  console.log(chalk.blue(`  [${prompt.id}] Generating plan...`));
  const planResult = await generatePlan(
    prompt,
    fixtureDir,
    llm.apiKey,
    llm.model,
    {
      provider: llm.provider,
      maxOutputTokens: 16_000,
      anthropicThinking: "adaptive",
      anthropicEffort: "medium",
    },
  );
  console.log(
    chalk.dim(
      `  [${prompt.id}] Plan: ${planResult.inputTokens} in / ${planResult.outputTokens} out`,
    ),
  );

  // Step 2: Run all static checkers → candidate findings
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
      `  [${prompt.id}] Checker findings: ${groundTruth.length} (${countStr || "none"})`,
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
    llm,
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
    model: formatBenchmarkModel(llm),
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
export function generateSummary(
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
  let llm: BenchmarkLlmOptions;
  try {
    llm = resolveBenchmarkLlm({
      anthropicApiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY,
      anthropicModel: config.model,
    });
  } catch (error) {
    console.error(
      chalk.red(
        error instanceof Error ? error.message : "Unable to configure benchmark provider.",
      ),
    );
    process.exit(1);
    return;
  }

  const model = formatBenchmarkModel(llm);
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
      `\nBig Benchmark: Static Checker Findings vs Self-Review\n` +
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

    const run = await runPrompt(prompt, llm);

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
  const report = generateBigReport(runs, summary);
  const reportFile = path.join(runDir, "REPORT.md");
  fs.writeFileSync(reportFile, report, "utf-8");

  // Print final summary
  console.log(chalk.bold.cyan("\n══════════════════════════════════════════"));
  console.log(chalk.bold.cyan("  Big Benchmark — Final Results"));
  console.log(chalk.bold.cyan("══════════════════════════════════════════\n"));

  console.log(`  Model: ${model}`);
  console.log(`  Prompts with errors: ${runs.length}`);
  console.log(`  Checker findings: ${summary.totalErrors}\n`);

  // Category table
  console.log("  Category          Findings  Review mentioned  Unmatched");
  console.log("  ────────────────  ────────  ────────────────  ─────────");

  for (const cat of ALL_CATEGORIES) {
    const stats = summary.perCategory[cat];
    if (stats.errors === 0) continue;
    const pad = (s: string, n: number) => s.padEnd(n);
    const selfRate = `${(stats.rate * 100).toFixed(0)}%`;
    const unmatched = String(stats.errors - stats.detected);
    console.log(
      `  ${pad(cat, 18)}${String(stats.errors).padStart(6)}    ${selfRate.padStart(14)}  ${unmatched.padStart(9)}`,
    );
  }

  console.log("  ────────────────  ────────  ────────────────  ─────────");
  console.log(
    `  ${"OVERALL".padEnd(18)}${String(summary.totalErrors).padStart(6)}    ${`${(summary.overallDetectionRate * 100).toFixed(0)}%`.padStart(14)}  ${String(summary.totalErrors - summary.totalDetected).padStart(9)}`,
  );

  console.log(chalk.dim(`\n  Results: ${runDir}`));
  console.log(chalk.dim(`  Report: ${reportFile}`));
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
