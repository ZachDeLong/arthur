/**
 * Self-Review vs Arthur Benchmark Runner
 *
 * Directly compares: does a second adversarial reviewer catch errors
 * the original LLM doesn't self-catch?
 *
 * Both arms get identical context. The only variable is:
 * - Arm A (self-review): Same model reviews its own plan
 * - Arm B (arthur): Fresh instance reviews the plan
 *
 * Ground truth comes from static checkers (path + schema).
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
import { parseDetections, parseSchemaDetections } from "./detection-parser.js";
import { getAllFiles } from "../../src/context/tree.js";
import {
  getSelfReviewSystemPrompt,
  buildSelfReviewUserMessage,
} from "../prompts/self-review-prompt.js";
import {
  getSystemPrompt as getArthurSystemPrompt,
  buildUserMessage as buildArthurUserMessage,
} from "../../src/verifier/prompt.js";
import type {
  PromptDefinition,
  PathDetection,
  SchemaDetection,
} from "./types.js";
import type { SchemaRef } from "./schema-checker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.resolve(__dirname, "..");
const FIXTURES_DIR = path.join(BENCH_ROOT, "fixtures");
const PROMPTS_PATH = path.join(BENCH_ROOT, "prompts", "prompts.json");
const RESULTS_DIR = path.join(BENCH_ROOT, "results");

// --- Types ---

interface GroundTruth {
  hallucinatedPaths: string[];
  schemaHallucinations: SchemaRef[];
  totalPathRefs: number;
  totalSchemaRefs: number;
}

interface ArmResult {
  arm: "self-review" | "arthur";
  output: string;
  pathDetections: PathDetection[];
  schemaDetections: SchemaDetection[];
  pathDetectionRate: number;
  schemaDetectionRate: number;
  overallDetectionRate: number;
  inputTokens: number;
  outputTokens: number;
}

interface ComparisonRun {
  promptId: string;
  fixture: string;
  task: string;
  model: string;
  groundTruth: GroundTruth;
  selfReview: ArmResult;
  arthur: ArmResult;
  winner: "self-review" | "arthur" | "tie";
  delta: number; // arthur detection rate - self-review detection rate
  timestamp: string;
}

interface ComparisonSummary {
  totalRuns: number;
  model: string;
  selfReview: {
    avgPathDetectionRate: number;
    avgSchemaDetectionRate: number;
    avgOverallDetectionRate: number;
  };
  arthur: {
    avgPathDetectionRate: number;
    avgSchemaDetectionRate: number;
    avgOverallDetectionRate: number;
  };
  arthurWins: number;
  selfReviewWins: number;
  ties: number;
  avgDelta: number;
  perRun: Array<{
    promptId: string;
    selfReviewRate: number;
    arthurRate: number;
    winner: string;
  }>;
}

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
  const runDir = path.join(RESULTS_DIR, `self-review-${runId}`);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

/** Run a single LLM call and collect the output. */
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

/** Score an arm's output against ground truth. */
function scoreArm(
  arm: "self-review" | "arthur",
  output: string,
  groundTruth: GroundTruth,
  actualFiles: Set<string>,
): ArmResult {
  // Path detections
  const pathDetections = parseDetections(
    groundTruth.hallucinatedPaths,
    output,
    actualFiles,
  );
  const pathDetected = pathDetections.filter((d) => d.detected).length;
  const pathDetectionRate =
    groundTruth.hallucinatedPaths.length > 0
      ? pathDetected / groundTruth.hallucinatedPaths.length
      : 1;

  // Schema detections
  let schemaDetections: SchemaDetection[] = [];
  let schemaDetectionRate = 1;
  if (groundTruth.schemaHallucinations.length > 0) {
    schemaDetections = parseSchemaDetections(
      groundTruth.schemaHallucinations,
      output,
    );
    const schemaDetected = schemaDetections.filter((d) => d.detected).length;
    schemaDetectionRate =
      schemaDetected / groundTruth.schemaHallucinations.length;
  }

  // Overall: weighted average (equal weight to path and schema if both present)
  const totalErrors =
    groundTruth.hallucinatedPaths.length +
    groundTruth.schemaHallucinations.length;
  const totalDetected =
    pathDetected +
    schemaDetections.filter((d) => d.detected).length;
  const overallDetectionRate = totalErrors > 0 ? totalDetected / totalErrors : 1;

  return {
    arm,
    output,
    pathDetections,
    schemaDetections,
    pathDetectionRate,
    schemaDetectionRate,
    overallDetectionRate,
    inputTokens: 0, // filled in by caller
    outputTokens: 0,
  };
}

/** Run comparison for a single prompt. */
async function runComparison(
  prompt: PromptDefinition,
  apiKey: string,
  model: string,
): Promise<ComparisonRun> {
  const fixtureDir = getFixtureDir(prompt.fixture);

  // Step 1: Generate plan (README-only context)
  console.log(chalk.blue(`  [${prompt.id}] Generating plan...`));
  const planResult = await generatePlan(prompt, fixtureDir, apiKey, model);
  console.log(
    chalk.dim(
      `  [${prompt.id}] Plan: ${planResult.inputTokens} in / ${planResult.outputTokens} out`,
    ),
  );

  // Step 2: Establish ground truth via static analysis
  console.log(chalk.blue(`  [${prompt.id}] Running static analysis (ground truth)...`));

  const pathAnalysis = analyzePaths(
    planResult.plan,
    fixtureDir,
    prompt.allowedNewPaths,
  );

  let schemaHallucinations: SchemaRef[] = [];
  let totalSchemaRefs = 0;
  if (prompt.schemaFile) {
    const schemaPath = path.join(fixtureDir, prompt.schemaFile);
    const schema = parseSchema(schemaPath);
    const schemaAnalysis = analyzeSchema(planResult.plan, schema);
    schemaHallucinations = schemaAnalysis.hallucinations;
    totalSchemaRefs = schemaAnalysis.totalRefs;
  }

  const groundTruth: GroundTruth = {
    hallucinatedPaths: pathAnalysis.hallucinatedPaths,
    schemaHallucinations,
    totalPathRefs: pathAnalysis.extractedPaths.length,
    totalSchemaRefs,
  };

  const totalErrors =
    groundTruth.hallucinatedPaths.length +
    groundTruth.schemaHallucinations.length;

  console.log(
    chalk.dim(
      `  [${prompt.id}] Ground truth: ${groundTruth.hallucinatedPaths.length} hallucinated paths, ${groundTruth.schemaHallucinations.length} schema hallucinations (${totalErrors} total errors)`,
    ),
  );

  if (totalErrors === 0) {
    console.log(
      chalk.yellow(`  [${prompt.id}] No errors to detect — skipping comparison`),
    );
  }

  // Step 3: Build shared context
  const context = buildContext({
    projectDir: fixtureDir,
    planText: planResult.plan,
    prompt: prompt.task,
    tokenBudget: 80_000,
  });

  const actualFiles = getAllFiles(fixtureDir);

  // Step 4a: Self-review arm
  console.log(chalk.blue(`  [${prompt.id}] Running self-review...`));
  const selfReviewResult = await runLlmReview(
    apiKey,
    model,
    getSelfReviewSystemPrompt(),
    buildSelfReviewUserMessage(context),
  );

  const selfReviewScored = scoreArm(
    "self-review",
    selfReviewResult.output,
    groundTruth,
    actualFiles,
  );
  selfReviewScored.inputTokens = selfReviewResult.inputTokens;
  selfReviewScored.outputTokens = selfReviewResult.outputTokens;

  console.log(
    chalk.dim(
      `  [${prompt.id}] Self-review: ${selfReviewResult.inputTokens} in / ${selfReviewResult.outputTokens} out`,
    ),
  );

  // Step 4b: Arthur arm (fresh instance)
  console.log(chalk.blue(`  [${prompt.id}] Running Arthur review...`));
  const arthurResult = await runLlmReview(
    apiKey,
    model,
    getArthurSystemPrompt(),
    buildArthurUserMessage(context),
  );

  const arthurScored = scoreArm(
    "arthur",
    arthurResult.output,
    groundTruth,
    actualFiles,
  );
  arthurScored.inputTokens = arthurResult.inputTokens;
  arthurScored.outputTokens = arthurResult.outputTokens;

  console.log(
    chalk.dim(
      `  [${prompt.id}] Arthur: ${arthurResult.inputTokens} in / ${arthurResult.outputTokens} out`,
    ),
  );

  // Step 5: Compare
  const delta =
    arthurScored.overallDetectionRate - selfReviewScored.overallDetectionRate;
  const winner: ComparisonRun["winner"] =
    delta > 0.01 ? "arthur" : delta < -0.01 ? "self-review" : "tie";

  return {
    promptId: prompt.id,
    fixture: prompt.fixture,
    task: prompt.task,
    model,
    groundTruth,
    selfReview: selfReviewScored,
    arthur: arthurScored,
    winner,
    delta,
    timestamp: new Date().toISOString(),
  };
}

/** Generate summary across all comparison runs. */
function generateComparisonSummary(
  runs: ComparisonRun[],
  model: string,
): ComparisonSummary {
  const avg = (arr: number[]) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  return {
    totalRuns: runs.length,
    model,
    selfReview: {
      avgPathDetectionRate: avg(runs.map((r) => r.selfReview.pathDetectionRate)),
      avgSchemaDetectionRate: avg(runs.map((r) => r.selfReview.schemaDetectionRate)),
      avgOverallDetectionRate: avg(runs.map((r) => r.selfReview.overallDetectionRate)),
    },
    arthur: {
      avgPathDetectionRate: avg(runs.map((r) => r.arthur.pathDetectionRate)),
      avgSchemaDetectionRate: avg(runs.map((r) => r.arthur.schemaDetectionRate)),
      avgOverallDetectionRate: avg(runs.map((r) => r.arthur.overallDetectionRate)),
    },
    arthurWins: runs.filter((r) => r.winner === "arthur").length,
    selfReviewWins: runs.filter((r) => r.winner === "self-review").length,
    ties: runs.filter((r) => r.winner === "tie").length,
    avgDelta: avg(runs.map((r) => r.delta)),
    perRun: runs.map((r) => ({
      promptId: r.promptId,
      selfReviewRate: r.selfReview.overallDetectionRate,
      arthurRate: r.arthur.overallDetectionRate,
      winner: r.winner,
    })),
  };
}

/** Generate markdown report for comparison results. */
function generateComparisonReport(
  runs: ComparisonRun[],
  summary: ComparisonSummary,
): string {
  const lines: string[] = [];

  lines.push("# Self-Review vs Arthur: Benchmark Results\n");
  lines.push(
    `> ${summary.totalRuns} comparisons using ${summary.model}. Generated ${new Date().toISOString().slice(0, 10)}.\n`,
  );
  lines.push(
    "Both arms receive identical context (full project tree, README, source files). The self-review prompt is maximally adversarial — same instructions as Arthur. The **only** variable is whether the same LLM reviews its own output vs a fresh instance.\n",
  );

  // Summary table
  lines.push("## Summary\n");
  lines.push("| Metric | Self-Review | Arthur | Delta |");
  lines.push("|--------|------------|--------|-------|");
  lines.push(
    `| Path detection | ${(summary.selfReview.avgPathDetectionRate * 100).toFixed(1)}% | ${(summary.arthur.avgPathDetectionRate * 100).toFixed(1)}% | ${((summary.arthur.avgPathDetectionRate - summary.selfReview.avgPathDetectionRate) * 100).toFixed(1)}pp |`,
  );
  lines.push(
    `| Schema detection | ${(summary.selfReview.avgSchemaDetectionRate * 100).toFixed(1)}% | ${(summary.arthur.avgSchemaDetectionRate * 100).toFixed(1)}% | ${((summary.arthur.avgSchemaDetectionRate - summary.selfReview.avgSchemaDetectionRate) * 100).toFixed(1)}pp |`,
  );
  lines.push(
    `| **Overall** | **${(summary.selfReview.avgOverallDetectionRate * 100).toFixed(1)}%** | **${(summary.arthur.avgOverallDetectionRate * 100).toFixed(1)}%** | **${(summary.avgDelta * 100).toFixed(1)}pp** |`,
  );
  lines.push("");

  lines.push(
    `**Wins:** Arthur ${summary.arthurWins}, Self-Review ${summary.selfReviewWins}, Tie ${summary.ties}\n`,
  );

  // Per-run details
  lines.push("## Per-Run Results\n");
  lines.push(
    "| Prompt | Fixture | Errors | Self-Review | Arthur | Winner |",
  );
  lines.push(
    "|--------|---------|--------|------------|--------|--------|",
  );

  for (const run of runs) {
    const totalErrors =
      run.groundTruth.hallucinatedPaths.length +
      run.groundTruth.schemaHallucinations.length;
    const srRate = (run.selfReview.overallDetectionRate * 100).toFixed(1);
    const arRate = (run.arthur.overallDetectionRate * 100).toFixed(1);
    const winnerLabel =
      run.winner === "arthur"
        ? "**Arthur**"
        : run.winner === "self-review"
          ? "Self-Review"
          : "Tie";
    lines.push(
      `| ${run.promptId} | ${run.fixture} | ${totalErrors} | ${srRate}% | ${arRate}% | ${winnerLabel} |`,
    );
  }
  lines.push("");

  // Detailed breakdown per run
  for (const run of runs) {
    lines.push(`### Prompt ${run.promptId}: ${run.task.slice(0, 60)}\n`);

    if (run.groundTruth.hallucinatedPaths.length > 0) {
      lines.push("**Hallucinated paths:**");
      for (const p of run.groundTruth.hallucinatedPaths) {
        const srDet = run.selfReview.pathDetections.find((d) => d.path === p);
        const arDet = run.arthur.pathDetections.find((d) => d.path === p);
        const sr = srDet?.detected ? `detected (${srDet.method})` : "missed";
        const ar = arDet?.detected ? `detected (${arDet.method})` : "missed";
        lines.push(`- \`${p}\` — Self-review: ${sr}, Arthur: ${ar}`);
      }
      lines.push("");
    }

    if (run.groundTruth.schemaHallucinations.length > 0) {
      lines.push("**Schema hallucinations:**");
      for (const h of run.groundTruth.schemaHallucinations) {
        const srDet = run.selfReview.schemaDetections.find(
          (d) => d.raw === h.raw,
        );
        const arDet = run.arthur.schemaDetections.find(
          (d) => d.raw === h.raw,
        );
        const sr = srDet?.detected ? `detected (${srDet.method})` : "missed";
        const ar = arDet?.detected ? `detected (${arDet.method})` : "missed";
        const suggestion = h.suggestion ? ` (should be: ${h.suggestion})` : "";
        lines.push(
          `- \`${h.raw}\`${suggestion} — Self-review: ${sr}, Arthur: ${ar}`,
        );
      }
      lines.push("");
    }
  }

  // Methodology
  lines.push("## Methodology\n");
  lines.push("1. **Plan generation:** LLM generates a plan with README-only context (no file tree, no source code)");
  lines.push("2. **Ground truth:** Static checkers (path existence, schema validation) identify all errors deterministically");
  lines.push("3. **Self-review:** Same model reviews its own plan with adversarial prompt + full project context");
  lines.push("4. **Arthur review:** Fresh model instance reviews the plan with adversarial prompt + full project context");
  lines.push("5. **Scoring:** Both reviews parsed for detection of ground-truth errors using multi-tier detection parsing\n");
  lines.push("The self-review prompt is deliberately strong — it explicitly instructs the model to check for hallucinated paths, schema errors, and convention violations. This ensures the comparison is fair: **the only variable is same-instance vs fresh-instance review.**\n");

  return lines.join("\n");
}

/** Main benchmark runner. */
export async function runSelfReviewBenchmark(
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
      `\nSelf-Review vs Arthur Benchmark\n` +
        `Running ${prompts.length} prompts with model: ${model}\n`,
    ),
  );

  const runDir = createRunDir();
  console.log(chalk.dim(`Results: ${runDir}\n`));

  const runs: ComparisonRun[] = [];

  for (const prompt of prompts) {
    console.log(
      chalk.bold(`\nPrompt ${prompt.id}: ${prompt.task.slice(0, 60)}...`),
    );

    const run = await runComparison(prompt, apiKey, model);
    runs.push(run);

    // Save per-run result
    const runFile = path.join(runDir, `comparison-${prompt.id}.json`);
    fs.writeFileSync(runFile, JSON.stringify(run, null, 2) + "\n", "utf-8");

    // Print comparison
    const totalErrors =
      run.groundTruth.hallucinatedPaths.length +
      run.groundTruth.schemaHallucinations.length;
    console.log(chalk.dim(`  Ground truth: ${totalErrors} errors`));
    console.log(
      `  Self-review: ${chalk.yellow(`${(run.selfReview.overallDetectionRate * 100).toFixed(1)}%`)} detection`,
    );
    console.log(
      `  Arthur:      ${chalk.green(`${(run.arthur.overallDetectionRate * 100).toFixed(1)}%`)} detection`,
    );
    const winColor =
      run.winner === "arthur"
        ? chalk.green
        : run.winner === "self-review"
          ? chalk.yellow
          : chalk.dim;
    console.log(`  Winner: ${winColor(run.winner)}`);
  }

  // Generate summary
  const summary = generateComparisonSummary(runs, model);
  const summaryFile = path.join(runDir, "summary.json");
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n", "utf-8");

  // Generate report
  const report = generateComparisonReport(runs, summary);
  const reportFile = path.join(runDir, "COMPARISON.md");
  fs.writeFileSync(reportFile, report, "utf-8");

  // Print final summary
  console.log(chalk.bold.cyan("\n══════════════════════════════════════"));
  console.log(chalk.bold.cyan("  Self-Review vs Arthur — Final Results"));
  console.log(chalk.bold.cyan("══════════════════════════════════════\n"));

  console.log(`  Model: ${model}`);
  console.log(`  Prompts: ${runs.length}\n`);

  console.log("  Detection Rates:");
  console.log(
    `    Self-review: ${(summary.selfReview.avgOverallDetectionRate * 100).toFixed(1)}%`,
  );
  console.log(
    `    Arthur:      ${(summary.arthur.avgOverallDetectionRate * 100).toFixed(1)}%`,
  );
  console.log(
    `    Delta:       ${(summary.avgDelta * 100).toFixed(1)}pp\n`,
  );

  console.log(
    `  Wins: Arthur ${summary.arthurWins} / Self-Review ${summary.selfReviewWins} / Tie ${summary.ties}`,
  );

  console.log(chalk.dim(`\n  Results: ${runDir}`));
  console.log(chalk.dim(`  Report: ${reportFile}`));
}

// CLI entry point
if (
  process.argv[1] &&
  (process.argv[1].endsWith("self-review-runner.ts") ||
    process.argv[1].endsWith("self-review-runner.js"))
) {
  const args = process.argv.slice(2);
  runSelfReviewBenchmark(args.length > 0 ? args : undefined);
}
