/**
 * Tier 4 Benchmark Runner: Arthur vs Self-Review on Real Production Projects
 *
 * Key difference from big benchmark: self-review gets the SAME limited
 * context the plan was generated with (CLAUDE.md + task), NOT the full
 * project tree. This is realistic — in Claude Code, the LLM that reviews
 * its own plan doesn't suddenly get more context than when it wrote it.
 *
 * Arthur's static checkers run against the real project on disk and
 * have perfect knowledge regardless of context window constraints.
 *
 * Commands:
 *   npm run bench:tier4 -- generate    Generate plans (LLM calls, saves to plans/)
 *   npm run bench:tier4 -- score       Score cached plans (Arthur vs self-review)
 *   npm run bench:tier4 -- report      Generate report from latest results
 *   npm run bench:tier4                Full run (generate + score + report)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../../src/config/manager.js";
import { analyzePaths } from "../../src/analysis/path-checker.js";
import { analyzeImports } from "../../src/analysis/import-checker.js";
import { analyzeEnv } from "../../src/analysis/env-checker.js";
import { analyzeApiRoutes } from "../../src/analysis/api-route-checker.js";
import { analyzeSupabaseSchema } from "../../src/analysis/supabase-schema-checker.js";
import { analyzePackageApi } from "../../src/analysis/package-api-checker.js";
import { getAllFiles } from "../../src/context/tree.js";
import { extractGroundTruth, type AllCheckerResults } from "../harness/ground-truth.js";
import { parseErrorDetections } from "../harness/unified-detection-parser.js";
import { buildPlanGenerationMessage, buildSelfReviewMessage } from "./tier4-prompt.js";
import { generateTier4Report } from "./tier4-report.js";
import type {
  CheckerCategory,
  Tier4Task,
  Tier4Run,
  Tier4Summary,
} from "../harness/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TIER4_ROOT = path.resolve(__dirname);
const BENCH_ROOT = path.resolve(__dirname, "..");
const TASKS_PATH = path.join(TIER4_ROOT, "tasks.json");
const PLANS_DIR = path.join(TIER4_ROOT, "plans");
const RESULTS_DIR = path.join(BENCH_ROOT, "results");

const ALL_CATEGORIES: CheckerCategory[] = [
  "path", "import", "env", "route", "supabase_schema", "package_api",
];

// --- Helpers ---

function loadTasks(): Tier4Task[] {
  const raw = fs.readFileSync(TASKS_PATH, "utf-8");
  return JSON.parse(raw) as Tier4Task[];
}

function createRunDir(): string {
  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = path.join(RESULTS_DIR, `tier4-${runId}`);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

function getPlanDir(project: string): string {
  const dir = path.join(PLANS_DIR, project);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readClaudeMd(projectDir: string): string {
  const claudeMdPath = path.join(projectDir, "CLAUDE.md");
  if (!fs.existsSync(claudeMdPath)) {
    throw new Error(`CLAUDE.md not found at: ${claudeMdPath}`);
  }
  return fs.readFileSync(claudeMdPath, "utf-8");
}

/** Find the most recent cached plan for a task. */
function findLatestPlan(project: string, taskId: string): string | undefined {
  const planDir = path.join(PLANS_DIR, project);
  if (!fs.existsSync(planDir)) return undefined;

  const plans = fs
    .readdirSync(planDir)
    .filter((f) => f.startsWith(`${taskId}-`) && f.endsWith(".md"))
    .sort()
    .reverse();

  return plans[0] ? path.join(planDir, plans[0]) : undefined;
}

/** Run a single LLM call. */
async function runLlm(
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

// --- Core Functions ---

/** Generate a plan for a task using CLAUDE.md-only context. */
async function generatePlan(
  task: Tier4Task,
  claudeMd: string,
  apiKey: string,
  model: string,
): Promise<{ plan: string; inputTokens: number; outputTokens: number }> {
  const { system, user } = buildPlanGenerationMessage(
    claudeMd,
    task.task,
    task.systemContext,
  );

  const result = await runLlm(apiKey, model, system, user);

  // Cache the plan
  const planDir = getPlanDir(task.project);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const modelShort = model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const planFile = path.join(planDir, `${task.id}-${modelShort}-${timestamp}.md`);
  fs.writeFileSync(planFile, result.output, "utf-8");

  console.log(chalk.dim(`    Plan cached: ${path.relative(TIER4_ROOT, planFile)}`));

  return {
    plan: result.output,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

/** Run all applicable static checkers against the plan + real project. */
function runArthurCheckers(
  planText: string,
  projectDir: string,
  allowedNewPaths: string[],
): AllCheckerResults {
  const results: AllCheckerResults = {};

  // Path checker — always applicable
  results.paths = analyzePaths(planText, projectDir, allowedNewPaths);

  // Import checker — requires node_modules
  results.imports = analyzeImports(planText, projectDir);

  // Env checker — requires .env* files
  results.env = analyzeEnv(planText, projectDir);

  // API routes — Next.js App Router
  results.routes = analyzeApiRoutes(planText, projectDir);

  // Supabase schema — the star checker for this benchmark
  results.supabaseSchema = analyzeSupabaseSchema(planText, projectDir);

  // Package API — experimental, this is its proving ground
  results.packageApi = analyzePackageApi(planText, projectDir);

  // SQL schema skipped — counselor-sophie uses Supabase (covered by supabase_schema),
  // not Drizzle/raw SQL. The sql_schema checker produces false positives on English
  // phrases that look like SQL ("from Resend", "update own", "from CSV").

  return results;
}

/** Run self-review with the SAME limited context as plan generation. */
async function runSelfReview(
  plan: string,
  claudeMd: string,
  task: Tier4Task,
  apiKey: string,
  model: string,
): Promise<{ output: string; inputTokens: number; outputTokens: number }> {
  const { system, user } = buildSelfReviewMessage(claudeMd, task.task, plan);
  return runLlm(apiKey, model, system, user);
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

/** Run a single task: generate plan, run checkers, run self-review, score. */
async function runTask(
  task: Tier4Task,
  claudeMd: string,
  apiKey: string,
  model: string,
  cachedPlanPath?: string,
): Promise<Tier4Run | null> {
  let plan: string;
  let planInputTokens = 0;
  let planOutputTokens = 0;

  // Step 1: Get plan (generate or load from cache)
  if (cachedPlanPath) {
    console.log(chalk.dim(`    Loading cached plan: ${path.basename(cachedPlanPath)}`));
    plan = fs.readFileSync(cachedPlanPath, "utf-8");
  } else {
    console.log(chalk.blue(`    Generating plan...`));
    const planResult = await generatePlan(task, claudeMd, apiKey, model);
    plan = planResult.plan;
    planInputTokens = planResult.inputTokens;
    planOutputTokens = planResult.outputTokens;
    console.log(
      chalk.dim(`    Plan: ${planInputTokens} in / ${planOutputTokens} out`),
    );
  }

  // Step 2: Run Arthur's static checkers
  console.log(chalk.blue(`    Running Arthur checkers...`));
  const checkerResults = runArthurCheckers(plan, task.projectDir, task.allowedNewPaths);
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
    chalk.dim(`    Ground truth: ${groundTruth.length} errors (${countStr || "none"})`),
  );

  // Step 3: Skip if no errors
  if (groundTruth.length === 0) {
    console.log(chalk.yellow(`    No errors found — skipping self-review`));
    return null;
  }

  // Step 4: Run self-review with SAME limited context (CLAUDE.md + task only)
  console.log(chalk.blue(`    Running self-review (limited context)...`));
  const selfReviewResult = await runSelfReview(plan, claudeMd, task, apiKey, model);
  console.log(
    chalk.dim(
      `    Self-review: ${selfReviewResult.inputTokens} in / ${selfReviewResult.outputTokens} out`,
    ),
  );

  // Step 5: Score self-review detections
  const actualFiles = getAllFiles(task.projectDir);
  const detections = parseErrorDetections(
    groundTruth,
    selfReviewResult.output,
    actualFiles,
  );

  const perCategory = computePerCategory(detections);
  const totalDetected = detections.filter((d) => d.detected).length;
  const overallDetectionRate = totalDetected / groundTruth.length;

  console.log(
    chalk.green(
      `    Self-review detected ${totalDetected}/${groundTruth.length} (${(overallDetectionRate * 100).toFixed(1)}%)`,
    ),
  );

  // Print per-category summary
  for (const [cat, stats] of Object.entries(perCategory)) {
    if (stats.errors > 0) {
      const color = stats.rate >= 1 ? chalk.green : stats.rate > 0.5 ? chalk.yellow : chalk.red;
      console.log(
        chalk.dim(`      ${cat}: `) + color(`${stats.detected}/${stats.errors} (${(stats.rate * 100).toFixed(0)}%)`),
      );
    }
  }

  return {
    taskId: task.id,
    project: task.project,
    task: task.task,
    model,
    generatedPlan: plan,
    groundTruth,
    selfReviewOutput: selfReviewResult.output,
    detections,
    perCategory,
    overallDetectionRate,
    inputTokens: planInputTokens + selfReviewResult.inputTokens,
    outputTokens: planOutputTokens + selfReviewResult.outputTokens,
    timestamp: new Date().toISOString(),
  };
}

/** Generate summary across all runs. */
function generateSummary(
  runs: Tier4Run[],
  model: string,
  project: string,
): Tier4Summary {
  const totalErrors = runs.reduce((sum, r) => sum + r.groundTruth.length, 0);
  const totalDetected = runs.reduce(
    (sum, r) => sum + r.detections.filter((d) => d.detected).length,
    0,
  );

  const perCategory = {} as Record<CheckerCategory, { errors: number; detected: number; rate: number }>;
  for (const cat of ALL_CATEGORIES) {
    const errors = runs.reduce((sum, r) => sum + (r.perCategory[cat]?.errors ?? 0), 0);
    const detected = runs.reduce((sum, r) => sum + (r.perCategory[cat]?.detected ?? 0), 0);
    perCategory[cat] = {
      errors,
      detected,
      rate: errors > 0 ? detected / errors : 1,
    };
  }

  return {
    totalRuns: runs.length,
    model,
    project,
    totalErrors,
    totalDetected,
    overallDetectionRate: totalErrors > 0 ? totalDetected / totalErrors : 1,
    arthurCaughtSelfReviewMissed: totalErrors - totalDetected,
    perCategory,
    perTask: runs.map((r) => ({
      taskId: r.taskId,
      task: r.task.slice(0, 80),
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

// --- Top-Level Modes ---

/** Generate plans for all tasks. */
async function runGenerate(
  tasks: Tier4Task[],
  apiKey: string,
  model: string,
): Promise<void> {
  console.log(
    chalk.bold.cyan(`\nTier 4: Generating plans for ${tasks.length} tasks\n`),
  );

  for (const task of tasks) {
    console.log(chalk.bold(`  Task ${task.id}: ${task.task.slice(0, 60)}...`));
    const claudeMd = readClaudeMd(task.projectDir);
    await generatePlan(task, claudeMd, apiKey, model);
  }

  console.log(chalk.green(`\nAll plans generated and cached to ${PLANS_DIR}`));
}

/** Score cached plans: run Arthur + self-review on each. */
async function runScore(
  tasks: Tier4Task[],
  apiKey: string,
  model: string,
): Promise<void> {
  console.log(
    chalk.bold.cyan(
      `\nTier 4: Scoring ${tasks.length} tasks — Arthur vs Self-Review\n`,
    ),
  );

  const runDir = createRunDir();
  console.log(chalk.dim(`Results: ${runDir}\n`));

  const runs: Tier4Run[] = [];

  for (const task of tasks) {
    console.log(chalk.bold(`  Task ${task.id}: ${task.task.slice(0, 60)}...`));

    const claudeMd = readClaudeMd(task.projectDir);
    const cachedPlan = findLatestPlan(task.project, task.id);

    const run = await runTask(task, claudeMd, apiKey, model, cachedPlan);

    if (run) {
      runs.push(run);
      const runFile = path.join(runDir, `task-${task.id}.json`);
      fs.writeFileSync(runFile, JSON.stringify(run, null, 2) + "\n", "utf-8");
    }
  }

  if (runs.length === 0) {
    console.log(chalk.yellow("\nNo runs with errors to analyze."));
    return;
  }

  // Generate summary
  const summary = generateSummary(runs, model, tasks[0].project);
  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
    "utf-8",
  );

  // Generate report
  const report = generateTier4Report(runs, summary);
  fs.writeFileSync(path.join(runDir, "REPORT.md"), report, "utf-8");

  printFinalSummary(summary, runDir);
}

/** Full run: generate plans, score, produce report. */
async function runFull(
  tasks: Tier4Task[],
  apiKey: string,
  model: string,
): Promise<void> {
  console.log(
    chalk.bold.cyan(
      `\nTier 4: Full Run — ${tasks.length} tasks\n` +
        `Model: ${model}\n`,
    ),
  );

  const runDir = createRunDir();
  console.log(chalk.dim(`Results: ${runDir}\n`));

  const runs: Tier4Run[] = [];

  for (const task of tasks) {
    console.log(chalk.bold(`\n  Task ${task.id}: ${task.task.slice(0, 60)}...`));

    const claudeMd = readClaudeMd(task.projectDir);
    const run = await runTask(task, claudeMd, apiKey, model);

    if (run) {
      runs.push(run);
      const runFile = path.join(runDir, `task-${task.id}.json`);
      fs.writeFileSync(runFile, JSON.stringify(run, null, 2) + "\n", "utf-8");
    }
  }

  if (runs.length === 0) {
    console.log(chalk.yellow("\nNo runs with errors to analyze."));
    return;
  }

  const summary = generateSummary(runs, model, tasks[0].project);
  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
    "utf-8",
  );

  const report = generateTier4Report(runs, summary);
  fs.writeFileSync(path.join(runDir, "REPORT.md"), report, "utf-8");

  printFinalSummary(summary, runDir);
}

/** Print the final comparison table to console. */
function printFinalSummary(summary: Tier4Summary, runDir: string): void {
  console.log(chalk.bold.cyan("\n══════════════════════════════════════════════════"));
  console.log(chalk.bold.cyan("  Tier 4 — Arthur vs Self-Review (Limited Context)"));
  console.log(chalk.bold.cyan("══════════════════════════════════════════════════\n"));

  console.log(`  Project: ${summary.project}`);
  console.log(`  Model: ${summary.model}`);
  console.log(`  Tasks with errors: ${summary.totalRuns}`);
  console.log(`  Total errors: ${summary.totalErrors}`);
  console.log(
    chalk.bold.yellow(
      `\n  Arthur caught ${summary.arthurCaughtSelfReviewMissed} errors self-review missed\n`,
    ),
  );

  // Category table
  console.log("  Category            Errors  Arthur  Self-Review  Gap");
  console.log("  ──────────────────  ──────  ──────  ───────────  ──────");

  for (const cat of ALL_CATEGORIES) {
    const stats = summary.perCategory[cat];
    if (stats.errors === 0) continue;
    const pad = (s: string, n: number) => s.padEnd(n);
    const arthurRate = "100%";
    const selfRate = `${(stats.rate * 100).toFixed(0)}%`;
    const gap = `${((1 - stats.rate) * 100).toFixed(0)}pp`;
    console.log(
      `  ${pad(cat, 20)}${String(stats.errors).padStart(4)}    ${arthurRate.padStart(4)}    ${selfRate.padStart(9)}  ${gap.padStart(5)}`,
    );
  }

  console.log("  ──────────────────  ──────  ──────  ───────────  ──────");
  console.log(
    `  ${"OVERALL".padEnd(20)}${String(summary.totalErrors).padStart(4)}    ${"100%".padStart(4)}    ${`${(summary.overallDetectionRate * 100).toFixed(0)}%`.padStart(9)}  ${`${((1 - summary.overallDetectionRate) * 100).toFixed(0)}pp`.padStart(5)}`,
  );

  console.log(chalk.dim(`\n  Results: ${runDir}`));
  console.log(chalk.dim(`  Report: ${path.join(runDir, "REPORT.md")}`));
}

// --- Main Entry Point ---

export async function runTier4(mode?: string, taskIds?: string[]): Promise<void> {
  const config = loadConfig(path.resolve("."));
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      chalk.red("No API key found. Set ANTHROPIC_API_KEY or run codeverifier init."),
    );
    process.exit(1);
  }

  const model = config.model;
  const allTasks = loadTasks();
  const tasks = taskIds
    ? allTasks.filter((t) => taskIds.includes(t.id))
    : allTasks;

  if (tasks.length === 0) {
    console.error(chalk.red("No matching tasks found."));
    process.exit(1);
  }

  switch (mode) {
    case "generate":
      await runGenerate(tasks, apiKey, model);
      break;
    case "score":
      await runScore(tasks, apiKey, model);
      break;
    case "report":
      runTier4ReportFromResults();
      break;
    default:
      await runFull(tasks, apiKey, model);
      break;
  }
}

/** Regenerate report from existing results (no LLM calls). */
function runTier4ReportFromResults(): void {
  if (!fs.existsSync(RESULTS_DIR)) {
    console.error(chalk.red("No results directory found. Run: npm run bench:tier4"));
    process.exit(1);
  }

  const dirs = fs
    .readdirSync(RESULTS_DIR)
    .filter(
      (d) =>
        d.startsWith("tier4-") &&
        fs.statSync(path.join(RESULTS_DIR, d)).isDirectory(),
    )
    .sort()
    .reverse();

  if (dirs.length === 0) {
    console.error(chalk.red("No tier4 results found. Run: npm run bench:tier4"));
    process.exit(1);
  }

  const runDir = path.join(RESULTS_DIR, dirs[0]);
  console.log(chalk.bold.cyan(`\nRegenerating report from: ${runDir}\n`));

  // Load all task-*.json files
  const runs: Tier4Run[] = [];
  const files = fs
    .readdirSync(runDir)
    .filter((f) => f.startsWith("task-") && f.endsWith(".json"));

  for (const file of files) {
    const raw = fs.readFileSync(path.join(runDir, file), "utf-8");
    runs.push(JSON.parse(raw) as Tier4Run);
  }

  if (runs.length === 0) {
    console.error(chalk.red("No task-*.json files found."));
    process.exit(1);
  }

  const summary = generateSummary(
    runs,
    runs[0].model,
    runs[0].project,
  );

  const report = generateTier4Report(runs, summary);
  const reportPath = path.join(runDir, "REPORT.md");
  fs.writeFileSync(reportPath, report, "utf-8");

  console.log(chalk.green(`Report written to: ${reportPath}`));
  console.log("\n" + report);
}

// CLI entry point
if (
  process.argv[1] &&
  (process.argv[1].endsWith("tier4-runner.ts") ||
    process.argv[1].endsWith("tier4-runner.js"))
) {
  const args = process.argv.slice(2);
  const mode = args[0];
  const taskIds = args.slice(1);
  runTier4(mode, taskIds.length > 0 ? taskIds : undefined);
}
