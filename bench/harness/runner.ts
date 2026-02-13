import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { loadConfig } from "../../src/config/manager.js";
import type {
  PromptDefinition,
  BenchmarkRun,
  Tier1Result,
  Tier2Result,
  DriftSpec,
  DriftDetection,
} from "./types.js";
import { generatePlan } from "./plan-generator.js";
import { analyzePaths } from "./path-checker.js";
import { runVerification } from "./verifier-runner.js";
import { parseDetections, parseSchemaDetections } from "./detection-parser.js";
import { injectDrift } from "./drift-injector.js";
import { scoreDriftDetection } from "./drift-scorer.js";
import { getAllFiles } from "../../src/context/tree.js";
import { generateSummary } from "./report.js";
import { parseSchema, analyzeSchema } from "./schema-checker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.resolve(__dirname, "..");
const FIXTURES_DIR = path.join(BENCH_ROOT, "fixtures");
const PROMPTS_PATH = path.join(BENCH_ROOT, "prompts", "prompts.json");
const DRIFT_SPECS_PATH = path.join(BENCH_ROOT, "prompts", "drift-specs.json");
const RESULTS_DIR = path.join(BENCH_ROOT, "results");

function loadPrompts(): PromptDefinition[] {
  const raw = fs.readFileSync(PROMPTS_PATH, "utf-8");
  return JSON.parse(raw) as PromptDefinition[];
}

function loadDriftSpecs(): DriftSpec[] {
  const raw = fs.readFileSync(DRIFT_SPECS_PATH, "utf-8");
  return JSON.parse(raw) as DriftSpec[];
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

  // Step 2b: Schema analysis (when schemaFile is configured)
  let schemaAnalysisResult: ReturnType<typeof analyzeSchema> | undefined;
  if (prompt.schemaFile) {
    console.log(chalk.blue(`  [${prompt.id}] Analyzing schema references...`));
    const schemaPath = path.join(fixtureDir, prompt.schemaFile);
    const schema = parseSchema(schemaPath);
    schemaAnalysisResult = analyzeSchema(planResult.plan, schema);
    console.log(
      chalk.dim(
        `  [${prompt.id}] Schema: ${schemaAnalysisResult.totalRefs} refs, ${schemaAnalysisResult.hallucinations.length} hallucinated`,
      ),
    );
  }

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

  // Step 4b: Parse schema detections
  let schemaDetections: ReturnType<typeof parseSchemaDetections> | undefined;
  let schemaDetectionRate: number | undefined;
  if (schemaAnalysisResult && schemaAnalysisResult.hallucinations.length > 0) {
    schemaDetections = parseSchemaDetections(
      schemaAnalysisResult.hallucinations,
      verifyResult.output,
    );
    const schemaDetectedCount = schemaDetections.filter((d) => d.detected).length;
    schemaDetectionRate = schemaDetectedCount / schemaAnalysisResult.hallucinations.length;
  } else if (schemaAnalysisResult) {
    schemaDetections = [];
    schemaDetectionRate = 1; // No hallucinations = perfect
  }

  const tier1: Tier1Result = {
    promptId: prompt.id,
    fixture: prompt.fixture,
    pathAnalysis,
    detections,
    detectionRate,
    schemaAnalysis: schemaAnalysisResult,
    schemaDetections,
    schemaDetectionRate,
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

    // Print summary for this run
    console.log(
      chalk.green(
        `  Paths: hallucination rate ${(run.tier1.pathAnalysis.hallucinationRate * 100).toFixed(1)}%, detection rate ${(run.tier1.detectionRate * 100).toFixed(1)}%`,
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
    if (run.tier1.schemaAnalysis) {
      const sa = run.tier1.schemaAnalysis;
      console.log(
        chalk.green(
          `  Schema: ${sa.totalRefs} refs, ${sa.hallucinations.length} hallucinated (${(sa.hallucinationRate * 100).toFixed(1)}%)`,
        ),
      );
      if (run.tier1.schemaDetectionRate !== undefined) {
        console.log(
          chalk.green(
            `  Schema detection rate: ${(run.tier1.schemaDetectionRate * 100).toFixed(1)}%`,
          ),
        );
      }
      if (sa.hallucinations.length > 0 && run.tier1.schemaDetections) {
        console.log(chalk.yellow("  Schema hallucinations:"));
        for (const h of sa.hallucinations) {
          const det = run.tier1.schemaDetections.find((d) => d.raw === h.raw);
          const status = det?.detected
            ? chalk.green(`detected (${det.method})`)
            : chalk.red("missed");
          const suggestion = h.suggestion ? ` (suggestion: ${h.suggestion})` : "";
          console.log(
            `    ${h.raw} — ${h.hallucinationCategory}${suggestion} — ${status}`,
          );
        }
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
  printSchemaSummary(summary);
  console.log(
    `  API usage: ${summary.apiUsage.totalInputTokens} in / ${summary.apiUsage.totalOutputTokens} out (${summary.apiUsage.totalCalls} calls)`,
  );
  console.log(chalk.dim(`\nResults saved to: ${runDir}`));
}

/** Run Tier 2 for a single prompt: inject drift specs → verify each → score detection. */
async function runTier2ForPrompt(
  prompt: PromptDefinition,
  plan: string,
  specs: DriftSpec[],
  apiKey: string,
  model: string,
): Promise<{ tier2: Tier2Result; verifierOutputs: Record<string, string>; extraTokens: { input: number; output: number } }> {
  const fixtureDir = getFixtureDir(prompt.fixture);
  const detections: DriftDetection[] = [];
  const verifierOutputs: Record<string, string> = {};
  let extraInputTokens = 0;
  let extraOutputTokens = 0;

  for (const spec of specs) {
    console.log(
      chalk.blue(`  [${prompt.id}] Drift spec ${spec.id} (${spec.category})...`),
    );

    // Inject drift
    const { modifiedPlan, applied } = injectDrift(plan, spec);

    if (!applied) {
      console.log(
        chalk.yellow(`  [${prompt.id}] ${spec.id}: injection pattern did not match — skipped`),
      );
      detections.push({
        specId: spec.id,
        category: spec.category,
        injectionApplied: false,
        detected: false,
        method: null,
        matchedSignals: [],
      });
      continue;
    }

    // Run verifier on the drifted plan
    const verifyResult = await runVerification(
      modifiedPlan,
      fixtureDir,
      apiKey,
      model,
      prompt.task,
    );
    extraInputTokens += verifyResult.inputTokens;
    extraOutputTokens += verifyResult.outputTokens;
    verifierOutputs[spec.id] = verifyResult.output;

    console.log(
      chalk.dim(
        `  [${prompt.id}] ${spec.id}: verify ${verifyResult.inputTokens} in / ${verifyResult.outputTokens} out`,
      ),
    );

    // Score detection
    const detection = scoreDriftDetection(verifyResult.output, spec);
    detections.push(detection);

    const status = detection.detected
      ? chalk.green(`detected (${detection.method}, signals: ${detection.matchedSignals.join(", ")})`)
      : chalk.red("missed");
    console.log(`  [${prompt.id}] ${spec.id}: ${status}`);
  }

  const appliedDetections = detections.filter((d) => d.injectionApplied);
  const detectedCount = appliedDetections.filter((d) => d.detected).length;
  const detectionRate =
    appliedDetections.length > 0
      ? detectedCount / appliedDetections.length
      : 1;

  return {
    tier2: {
      promptId: prompt.id,
      fixture: prompt.fixture,
      detections,
      detectionRate,
    },
    verifierOutputs,
    extraTokens: { input: extraInputTokens, output: extraOutputTokens },
  };
}

/** Benchmark runner — Tier 2 only (drift detection). */
export async function runBenchmarkTier2(
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
  const allSpecs = loadDriftSpecs();

  if (prompts.length === 0) {
    console.error(chalk.red("No matching prompts found."));
    process.exit(1);
  }

  console.log(
    chalk.bold.cyan(
      `\nCodeVerifier Benchmark — Tier 2 (Drift Detection)\n` +
        `Running ${prompts.length} prompts with model: ${model}\n`,
    ),
  );

  const runDir = createRunDir();
  console.log(chalk.dim(`Results: ${runDir}\n`));

  const runs: BenchmarkRun[] = [];

  for (const prompt of prompts) {
    const specs = allSpecs.filter((s) => s.promptId === prompt.id);
    if (specs.length === 0) {
      console.log(chalk.yellow(`\nPrompt ${prompt.id}: no drift specs — skipped`));
      continue;
    }

    console.log(
      chalk.bold(`\nPrompt ${prompt.id}: ${prompt.task.slice(0, 60)}...`),
    );
    console.log(chalk.dim(`  ${specs.length} drift specs to test`));

    // Generate plan (same as tier1 step 1)
    const fixtureDir = getFixtureDir(prompt.fixture);
    console.log(chalk.blue(`  [${prompt.id}] Generating plan...`));
    const planResult = await generatePlan(prompt, fixtureDir, apiKey, model);
    console.log(
      chalk.dim(
        `  [${prompt.id}] Plan: ${planResult.inputTokens} in / ${planResult.outputTokens} out`,
      ),
    );

    // Run tier 2
    const { tier2, verifierOutputs, extraTokens } = await runTier2ForPrompt(
      prompt,
      planResult.plan,
      specs,
      apiKey,
      model,
    );

    const run: BenchmarkRun = {
      promptId: prompt.id,
      fixture: prompt.fixture,
      task: prompt.task,
      generatedPlan: planResult.plan,
      verifierOutput: "",
      tier1: {
        promptId: prompt.id,
        fixture: prompt.fixture,
        pathAnalysis: { extractedPaths: [], validPaths: [], intentionalNewPaths: [], hallucinatedPaths: [], hallucinationRate: 0 },
        detections: [],
        detectionRate: 0,
      },
      tier2,
      driftVerifierOutputs: verifierOutputs,
      apiUsage: {
        planInputTokens: planResult.inputTokens,
        planOutputTokens: planResult.outputTokens,
        verifyInputTokens: extraTokens.input,
        verifyOutputTokens: extraTokens.output,
      },
      timestamp: new Date().toISOString(),
    };

    runs.push(run);

    const runFile = path.join(runDir, `prompt-${prompt.id}.json`);
    fs.writeFileSync(runFile, JSON.stringify(run, null, 2) + "\n", "utf-8");

    console.log(
      chalk.green(
        `  Drift detection rate: ${(tier2.detectionRate * 100).toFixed(1)}%`,
      ),
    );
  }

  const summary = generateSummary(runs);
  const summaryFile = path.join(runDir, "summary.json");
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n", "utf-8");

  printTier2Summary(summary);
  console.log(chalk.dim(`\nResults saved to: ${runDir}`));
}

/** Benchmark runner — both tiers, reusing the generated plan. */
export async function runBenchmarkAll(
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
  const allSpecs = loadDriftSpecs();

  if (prompts.length === 0) {
    console.error(chalk.red("No matching prompts found."));
    process.exit(1);
  }

  console.log(
    chalk.bold.cyan(
      `\nCodeVerifier Benchmark — All Tiers\n` +
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

    // Run Tier 1 (generates plan + verifies)
    const run = await runTier1(prompt, apiKey, model);

    // Run Tier 2 on the same plan
    const specs = allSpecs.filter((s) => s.promptId === prompt.id);
    if (specs.length > 0) {
      console.log(chalk.dim(`  ${specs.length} drift specs to test`));
      const { tier2, verifierOutputs, extraTokens } = await runTier2ForPrompt(
        prompt,
        run.generatedPlan,
        specs,
        apiKey,
        model,
      );
      run.tier2 = tier2;
      run.driftVerifierOutputs = verifierOutputs;
      run.apiUsage.verifyInputTokens += extraTokens.input;
      run.apiUsage.verifyOutputTokens += extraTokens.output;
    }

    runs.push(run);

    const runFile = path.join(runDir, `prompt-${prompt.id}.json`);
    fs.writeFileSync(runFile, JSON.stringify(run, null, 2) + "\n", "utf-8");

    // Print tier1 summary
    console.log(
      chalk.green(
        `  Hallucination rate: ${(run.tier1.pathAnalysis.hallucinationRate * 100).toFixed(1)}%`,
      ),
    );
    console.log(
      chalk.green(
        `  T1 detection rate: ${(run.tier1.detectionRate * 100).toFixed(1)}%`,
      ),
    );
    if (run.tier2) {
      console.log(
        chalk.green(
          `  T2 drift detection rate: ${(run.tier2.detectionRate * 100).toFixed(1)}%`,
        ),
      );
    }
  }

  const summary = generateSummary(runs);
  const summaryFile = path.join(runDir, "summary.json");
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n", "utf-8");

  // Print combined summary
  console.log(chalk.bold.cyan("\n— Tier 1 Summary —"));
  console.log(
    `  Avg hallucination rate: ${(summary.tier1.avgHallucinationRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  Avg detection rate: ${(summary.tier1.avgDetectionRate * 100).toFixed(1)}%`,
  );
  printSchemaSummary(summary);
  printTier2Summary(summary);
  console.log(
    `\n  API usage: ${summary.apiUsage.totalInputTokens} in / ${summary.apiUsage.totalOutputTokens} out (${summary.apiUsage.totalCalls} calls)`,
  );
  console.log(chalk.dim(`\nResults saved to: ${runDir}`));
}

function printSchemaSummary(summary: ReturnType<typeof generateSummary>): void {
  if (!summary.tier1.schema) return;

  const s = summary.tier1.schema;
  console.log(chalk.bold.cyan("\n— Schema Hallucination Summary —"));
  console.log(
    `  Avg schema hallucination rate: ${(s.avgSchemaHallucinationRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  Avg schema detection rate: ${(s.avgSchemaDetectionRate * 100).toFixed(1)}%`,
  );
  console.log(chalk.dim("  Per category:"));
  console.log(
    `    Models: ${s.perCategory.models.hallucinated}/${s.perCategory.models.total} hallucinated`,
  );
  console.log(
    `    Fields: ${s.perCategory.fields.hallucinated}/${s.perCategory.fields.total} hallucinated`,
  );
  console.log(
    `    Methods: ${s.perCategory.methods.invalid}/${s.perCategory.methods.total} invalid`,
  );
  console.log(
    `    Relations: ${s.perCategory.relations.wrong}/${s.perCategory.relations.total} wrong`,
  );
}

function printTier2Summary(summary: ReturnType<typeof generateSummary>): void {
  if (!summary.tier2) return;

  console.log(chalk.bold.cyan("\n— Tier 2 Summary (Drift Detection) —"));
  console.log(
    `  Avg detection rate: ${(summary.tier2.avgDetectionRate * 100).toFixed(1)}%`,
  );

  console.log(chalk.dim("  Per category:"));
  for (const [cat, rate] of Object.entries(summary.tier2.perCategory)) {
    console.log(`    ${cat}: ${(rate * 100).toFixed(1)}%`);
  }

  console.log(chalk.dim("  Per injection method:"));
  for (const [method, rate] of Object.entries(summary.tier2.perMethod)) {
    console.log(`    ${method}: ${(rate * 100).toFixed(1)}%`);
  }
}

// CLI entry point
const args = process.argv.slice(2);
const subcommand = args[0];

if (subcommand === "tier1" || args.length === 0) {
  const promptIds = args.slice(subcommand === "tier1" ? 1 : 0);
  runBenchmark(promptIds.length > 0 ? promptIds : undefined);
} else if (subcommand === "tier2") {
  const promptIds = args.slice(1);
  runBenchmarkTier2(promptIds.length > 0 ? promptIds : undefined);
} else if (subcommand === "all") {
  const promptIds = args.slice(1);
  runBenchmarkAll(promptIds.length > 0 ? promptIds : undefined);
} else {
  console.error("Usage: bench [tier1|tier2|all] [prompt-ids...]");
  process.exit(1);
}
