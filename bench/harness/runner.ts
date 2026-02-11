import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { loadConfig } from "../../src/config/manager.js";
import type {
  PromptDefinition,
  BenchmarkRun,
  Tier1Result,
  BenchmarkSummary,
} from "./types.js";
import { generatePlan } from "./plan-generator.js";
import { analyzePaths } from "./path-checker.js";
import { runVerification } from "./verifier-runner.js";
import { parseDetections } from "./detection-parser.js";
import { getAllFiles } from "../../src/context/tree.js";
import { generateRubric } from "./rubric-generator.js";
import { generateSummary } from "./report.js";
import { scoreTier2, mergeTier2IntoSummary } from "./score-tier2.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.resolve(__dirname, "..");
const FIXTURES_DIR = path.join(BENCH_ROOT, "fixtures");
const PROMPTS_PATH = path.join(BENCH_ROOT, "prompts", "prompts.json");
const RESULTS_DIR = path.join(BENCH_ROOT, "results");

function loadPrompts(): PromptDefinition[] {
  const raw = fs.readFileSync(PROMPTS_PATH, "utf-8");
  return JSON.parse(raw) as PromptDefinition[];
}

function getFixtureDir(fixture: string): string {
  return path.join(FIXTURES_DIR, fixture);
}

function createRunDir(): string {
  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = path.join(RESULTS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

/** Run Tier 1 benchmark: plan generation + path checking + verification + detection. */
async function runTier1(
  prompt: PromptDefinition,
  apiKey: string,
  model: string,
): Promise<BenchmarkRun> {
  const fixtureDir = getFixtureDir(prompt.fixture);

  // Step 1: Generate plan (README-only context)
  console.log(
    chalk.blue(`  [${prompt.id}] Generating plan...`),
  );
  const planResult = await generatePlan(prompt, fixtureDir, apiKey, model);
  console.log(
    chalk.dim(
      `  [${prompt.id}] Plan: ${planResult.inputTokens} in / ${planResult.outputTokens} out`,
    ),
  );

  // Step 2: Check paths
  console.log(chalk.blue(`  [${prompt.id}] Analyzing paths...`));
  const pathAnalysis = analyzePaths(
    planResult.plan,
    fixtureDir,
    prompt.allowedNewPaths,
  );
  console.log(
    chalk.dim(
      `  [${prompt.id}] Paths: ${pathAnalysis.extractedPaths.length} extracted, ${pathAnalysis.hallucinatedPaths.length} hallucinated`,
    ),
  );

  // Step 3: Run verifier (full tree context)
  console.log(chalk.blue(`  [${prompt.id}] Running verifier...`));
  const verifyResult = await runVerification(
    planResult.plan,
    fixtureDir,
    apiKey,
    model,
    prompt.task,
  );
  console.log(
    chalk.dim(
      `  [${prompt.id}] Verify: ${verifyResult.inputTokens} in / ${verifyResult.outputTokens} out`,
    ),
  );

  // Step 4: Parse detections
  const actualFiles = getAllFiles(fixtureDir);
  const detections = parseDetections(
    pathAnalysis.hallucinatedPaths,
    verifyResult.output,
    actualFiles,
  );
  const detectedCount = detections.filter((d) => d.detected).length;
  const detectionRate =
    pathAnalysis.hallucinatedPaths.length > 0
      ? detectedCount / pathAnalysis.hallucinatedPaths.length
      : 1; // No hallucinations = perfect detection

  const tier1: Tier1Result = {
    promptId: prompt.id,
    fixture: prompt.fixture,
    pathAnalysis,
    detections,
    detectionRate,
  };

  return {
    promptId: prompt.id,
    fixture: prompt.fixture,
    task: prompt.task,
    generatedPlan: planResult.plan,
    verifierOutput: verifyResult.output,
    tier1,
    apiUsage: {
      planInputTokens: planResult.inputTokens,
      planOutputTokens: planResult.outputTokens,
      verifyInputTokens: verifyResult.inputTokens,
      verifyOutputTokens: verifyResult.outputTokens,
    },
    timestamp: new Date().toISOString(),
  };
}

/** Main benchmark runner — Tier 1 only (automated). */
export async function runBenchmark(
  promptIds?: string[],
): Promise<void> {
  const config = loadConfig(path.resolve("."));
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      chalk.red("No API key found. Set ANTHROPIC_API_KEY or run codeverifier init."),
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
      `\nCodeVerifier Benchmark — Tier 1\n` +
        `Running ${prompts.length} prompts with model: ${model}\n`,
    ),
  );

  const runDir = createRunDir();
  console.log(chalk.dim(`Results: ${runDir}\n`));

  const runs: BenchmarkRun[] = [];

  for (const prompt of prompts) {
    console.log(
      chalk.bold(`\nPrompt ${prompt.id}: ${prompt.task.slice(0, 60)}...`),
    );

    const run = await runTier1(prompt, apiKey, model);
    runs.push(run);

    // Save per-run results
    const runFile = path.join(runDir, `prompt-${prompt.id}.json`);
    fs.writeFileSync(runFile, JSON.stringify(run, null, 2) + "\n", "utf-8");

    // Generate rubric template
    const rubricFile = path.join(runDir, `prompt-${prompt.id}-rubric.md`);
    const rubric = generateRubric(run);
    fs.writeFileSync(rubricFile, rubric, "utf-8");

    // Print summary for this run
    console.log(
      chalk.green(
        `  Hallucination rate: ${(run.tier1.pathAnalysis.hallucinationRate * 100).toFixed(1)}%`,
      ),
    );
    console.log(
      chalk.green(
        `  Detection rate: ${(run.tier1.detectionRate * 100).toFixed(1)}%`,
      ),
    );
    if (run.tier1.pathAnalysis.hallucinatedPaths.length > 0) {
      console.log(chalk.yellow("  Hallucinated paths:"));
      for (const p of run.tier1.pathAnalysis.hallucinatedPaths) {
        const det = run.tier1.detections.find((d) => d.path === p);
        const status = det?.detected
          ? chalk.green(`detected (${det.method})`)
          : chalk.red("missed");
        console.log(`    ${p} — ${status}`);
      }
    }
  }

  // Generate summary
  const summary = generateSummary(runs);
  const summaryFile = path.join(runDir, "summary.json");
  fs.writeFileSync(
    summaryFile,
    JSON.stringify(summary, null, 2) + "\n",
    "utf-8",
  );

  // Print final summary
  console.log(chalk.bold.cyan("\n— Summary —"));
  console.log(
    `  Avg hallucination rate: ${(summary.tier1.avgHallucinationRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  Avg detection rate: ${(summary.tier1.avgDetectionRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  API usage: ${summary.apiUsage.totalInputTokens} in / ${summary.apiUsage.totalOutputTokens} out (${summary.apiUsage.totalCalls} calls)`,
  );
  console.log(chalk.dim(`\nResults saved to: ${runDir}`));
  console.log(
    chalk.dim(
      `Fill in rubric files and run: npm run bench:score -- ${runDir}`,
    ),
  );
}

/** Score Tier 2 from filled-in rubric files. */
export async function scoreBenchmark(runDir: string): Promise<void> {
  const summaryFile = path.join(runDir, "summary.json");
  if (!fs.existsSync(summaryFile)) {
    console.error(chalk.red(`No summary.json found in ${runDir}`));
    process.exit(1);
  }

  const summary = JSON.parse(
    fs.readFileSync(summaryFile, "utf-8"),
  ) as BenchmarkSummary;

  const tier2Results = scoreTier2(runDir);
  if (tier2Results.length === 0) {
    console.error(
      chalk.red(
        "No scored rubrics found. Fill in the *-rubric.md files with scores first.",
      ),
    );
    process.exit(1);
  }

  const updatedSummary = mergeTier2IntoSummary(summary, tier2Results);
  fs.writeFileSync(
    summaryFile,
    JSON.stringify(updatedSummary, null, 2) + "\n",
    "utf-8",
  );

  console.log(chalk.bold.cyan("\n— Tier 2 Scores —"));
  if (updatedSummary.tier2) {
    for (const [key, value] of Object.entries(updatedSummary.tier2.avgScores)) {
      console.log(`  ${key}: ${value}/5`);
    }
  }
  console.log(chalk.dim(`\nUpdated: ${summaryFile}`));
}

// CLI entry point
const args = process.argv.slice(2);

if (args[0] === "score") {
  const runDir = args[1];
  if (!runDir) {
    console.error("Usage: bench:score <run-directory>");
    process.exit(1);
  }
  scoreBenchmark(path.resolve(runDir));
} else if (args[0] === "tier1" || args.length === 0) {
  // Optional prompt IDs: bench:tier1 01 03
  const promptIds = args.slice(1);
  runBenchmark(promptIds.length > 0 ? promptIds : undefined);
} else {
  console.error("Usage: bench [tier1] [prompt-ids...] | bench score <run-dir>");
  process.exit(1);
}
