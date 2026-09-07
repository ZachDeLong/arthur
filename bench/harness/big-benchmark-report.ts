/**
 * Big Benchmark Report Generator
 *
 * Loads results from big benchmark runs and generates
 * a publishable markdown report.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import type {
  CheckerCategory,
  BigBenchmarkRun,
  BigBenchmarkSummary,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.resolve(__dirname, "..");
const RESULTS_DIR = path.join(BENCH_ROOT, "results");

const ALL_CATEGORIES: CheckerCategory[] = [
  "path", "schema", "sql_schema", "import", "env", "route",
];

/** Load runs from a big benchmark results directory. */
function loadBigRuns(runDir: string): BigBenchmarkRun[] {
  const runs: BigBenchmarkRun[] = [];
  const files = fs
    .readdirSync(runDir)
    .filter((f) => f.startsWith("prompt-") && f.endsWith(".json"));

  for (const file of files) {
    const raw = fs.readFileSync(path.join(runDir, file), "utf-8");
    runs.push(JSON.parse(raw) as BigBenchmarkRun);
  }

  return runs;
}

/** Find the most recent big-* results directory. */
function findLatestBigDir(): string | undefined {
  if (!fs.existsSync(RESULTS_DIR)) return undefined;

  const dirs = fs
    .readdirSync(RESULTS_DIR)
    .filter(
      (d) =>
        d.startsWith("big-") &&
        fs.statSync(path.join(RESULTS_DIR, d)).isDirectory(),
    )
    .sort()
    .reverse();

  return dirs[0];
}

/** Regenerate summary from runs (in case summary.json is missing/stale). */
function regenerateSummary(runs: BigBenchmarkRun[]): BigBenchmarkSummary {
  const totalErrors = runs.reduce((sum, r) => sum + r.groundTruth.length, 0);
  const totalDetected = runs.reduce(
    (sum, r) => sum + r.detections.filter((d) => d.detected).length,
    0,
  );

  const perCategory = {} as Record<CheckerCategory, { errors: number; detected: number; rate: number }>;
  for (const cat of ALL_CATEGORIES) {
    const errors = runs.reduce((sum, r) => sum + r.perCategory[cat].errors, 0);
    const detected = runs.reduce((sum, r) => sum + r.perCategory[cat].detected, 0);
    perCategory[cat] = { errors, detected, rate: errors > 0 ? detected / errors : 1 };
  }

  const fixtureMap = new Map<string, { errors: number; detected: number }>();
  for (const run of runs) {
    const existing = fixtureMap.get(run.fixture) ?? { errors: 0, detected: 0 };
    existing.errors += run.groundTruth.length;
    existing.detected += run.detections.filter((d) => d.detected).length;
    fixtureMap.set(run.fixture, existing);
  }
  const perFixture: Record<string, { errors: number; detected: number; rate: number }> = {};
  for (const [fixture, stats] of fixtureMap) {
    perFixture[fixture] = { ...stats, rate: stats.errors > 0 ? stats.detected / stats.errors : 1 };
  }

  return {
    totalRuns: runs.length,
    model: runs[0]?.model ?? "unknown",
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

/** Generate an agreement-study report from benchmark results. */
export function generateBigReport(runs: BigBenchmarkRun[], summary: BigBenchmarkSummary): string {
  const lines: string[] = [];

  lines.push("# Big Benchmark: Checker Findings vs Self-Review\n");
  lines.push(
    `> ${summary.totalRuns} prompts, ${summary.totalErrors} automated checker findings. Model: ${summary.model}. Generated ${new Date().toISOString().slice(0, 10)}.\n`,
  );
  lines.push(
    "This is an **agreement study**, not an accuracy benchmark. It measures how often self-review independently mentions findings produced by Arthur. Arthur's findings are candidate issues, not independently established ground truth.\n",
  );

  // Main comparison table
  lines.push("## Results by Category\n");
  lines.push("| Category | Checker Findings | Review Mentioned | Unmatched Findings |");
  lines.push("|----------|------------------|------------------|--------------------|");

  for (const cat of ALL_CATEGORIES) {
    const stats = summary.perCategory[cat];
    if (stats.errors === 0) continue;
    const selfRate = `${(stats.rate * 100).toFixed(1)}%`;
    lines.push(
      `| ${cat} | ${stats.errors} | ${stats.detected} (${selfRate}) | ${stats.errors - stats.detected} |`,
    );
  }

  lines.push(
    `| **Overall** | **${summary.totalErrors}** | **${summary.totalDetected} (${(summary.overallDetectionRate * 100).toFixed(1)}%)** | **${summary.totalErrors - summary.totalDetected}** |`,
  );
  lines.push("");

  // Per-fixture breakdown
  lines.push("## Results by Fixture\n");
  lines.push("| Fixture | Checker Findings | Review Mention Rate |");
  lines.push("|---------|--------|-----------------|");
  for (const [fixture, stats] of Object.entries(summary.perFixture)) {
    lines.push(`| ${fixture} | ${stats.errors} | ${(stats.rate * 100).toFixed(1)}% |`);
  }
  lines.push("");

  // Per-run detail
  lines.push("## Per-Run Detail\n");
  lines.push("| Prompt | Fixture | Checker Findings | Review Mentioned | Rate |");
  lines.push("|--------|---------|--------|----------|------|");
  for (const run of runs) {
    const detected = run.detections.filter((d) => d.detected).length;
    lines.push(
      `| ${run.promptId} | ${run.fixture} | ${run.groundTruth.length} | ${detected} | ${(run.overallDetectionRate * 100).toFixed(1)}% |`,
    );
  }
  lines.push("");

  // Unmatched finding detail
  lines.push("## Unmatched Findings Requiring Adjudication\n");
  lines.push("An unmatched item is not automatically an Arthur-only catch. It may be a checker false positive or a parser miss.\n");
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

  // Review-mentioned finding detail
  lines.push("## Findings Mentioned by Self-Review\n");
  for (const run of runs) {
    const found = run.detections.filter((d) => d.detected);
    if (found.length === 0) continue;

    lines.push(`### Prompt ${run.promptId} (${run.fixture})\n`);
    for (const det of found) {
      lines.push(`- **[${det.error.category}]** \`${det.error.raw}\` — matched via ${det.method}`);
    }
    lines.push("");
  }

  // Methodology
  lines.push("## Methodology\n");
  lines.push("1. **Plan generation:** LLM generates a plan with README-only context (no file tree, no source code)");
  lines.push("2. **Candidate findings:** Applicable static checkers run against the plan and local project state");
  lines.push("3. **Self-review:** Same model reviews its own plan with comprehensive adversarial prompt + full project context");
  lines.push("4. **Automated matching:** Review output is parsed for mentions of each checker finding (direct → sentiment → section)");
  lines.push("5. **Required audit:** Independently adjudicate checker precision and every unmatched item before making product claims\n");

  lines.push("## Interpretation Limits\n");
  lines.push("- Arthur defines the candidate set, so its apparent 100% coverage is tautological and is not reported as an accuracy score.");
  lines.push("- The benchmark does not measure issues found by self-review that Arthur cannot detect.");
  lines.push("- Automated text matching can produce both misses and false matches.");
  lines.push("- One non-deterministic run does not provide confidence intervals or a stable model comparison.\n");

  // API usage
  lines.push("## API Usage\n");
  lines.push(`- Total input tokens: ${summary.apiUsage.totalInputTokens.toLocaleString()}`);
  lines.push(`- Total output tokens: ${summary.apiUsage.totalOutputTokens.toLocaleString()}`);
  lines.push("");

  return lines.join("\n");
}

/** CLI: regenerate report from existing results. */
export function runBigReport(args: string[]): void {
  const specificDir = args[0] ?? findLatestBigDir();

  if (!specificDir) {
    console.error(
      chalk.red("No big benchmark results found. Run: npm run bench:big"),
    );
    process.exit(1);
  }

  const runDir = path.isAbsolute(specificDir)
    ? specificDir
    : path.join(RESULTS_DIR, specificDir);

  console.log(chalk.bold.cyan(`\nGenerating big benchmark report from: ${runDir}\n`));

  const runs = loadBigRuns(runDir);
  if (runs.length === 0) {
    console.error(chalk.red("No prompt-*.json files found in results directory."));
    process.exit(1);
  }

  const summary = regenerateSummary(runs);
  const report = generateBigReport(runs, summary);

  // Write report
  const reportPath = path.join(runDir, "REPORT.md");
  fs.writeFileSync(reportPath, report, "utf-8");
  console.log(chalk.green(`Report written to: ${reportPath}`));
  console.log("\n" + report);
}

// CLI entry point
if (
  process.argv[1] &&
  (process.argv[1].endsWith("big-benchmark-report.ts") ||
    process.argv[1].endsWith("big-benchmark-report.js"))
) {
  const args = process.argv.slice(2);
  runBigReport(args);
}
