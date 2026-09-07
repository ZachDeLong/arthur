/**
 * Re-run current deterministic checkers and review matching against a saved
 * Big Benchmark run. This never calls an LLM and preserves the original run.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { getAllFiles } from "../../src/context/tree.js";
import { extractGroundTruth } from "./ground-truth.js";
import { parseErrorDetections } from "./unified-detection-parser.js";
import {
  computePerCategory,
  generateSummary,
  getFixtureDir,
  loadPrompts,
  runStaticCheckers,
} from "./big-benchmark-runner.js";
import { generateBigReport } from "./big-benchmark-report.js";
import type { BigBenchmarkRun } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, "..", "results");

function findLatestBigDir(): string | undefined {
  if (!fs.existsSync(RESULTS_DIR)) return undefined;
  return fs
    .readdirSync(RESULTS_DIR)
    .filter((entry) => {
      const fullPath = path.join(RESULTS_DIR, entry);
      return entry.startsWith("big-") && fs.statSync(fullPath).isDirectory();
    })
    .sort()
    .at(-1);
}
/** Rescore a saved run with the current checker and matching logic. */
export function rescoreBigBenchmark(source?: string): string {
  const requested = source ?? findLatestBigDir();
  if (!requested) {
    throw new Error("No Big Benchmark results found. Run npm run bench:big first.");
  }

  const sourceDir = path.isAbsolute(requested)
    ? requested
    : path.join(RESULTS_DIR, requested);
  const outputDir = path.join(sourceDir, "rescored-current");
  fs.mkdirSync(outputDir, { recursive: true });

  const prompts = new Map(loadPrompts().map((prompt) => [prompt.id, prompt]));
  const runFiles = fs
    .readdirSync(sourceDir)
    .filter((file) => /^prompt-.*\.json$/.test(file))
    .sort();

  if (runFiles.length === 0) {
    throw new Error(`No prompt-*.json files found in ${sourceDir}`);
  }

  const runs: BigBenchmarkRun[] = [];
  for (const file of runFiles) {
    const original = JSON.parse(
      fs.readFileSync(path.join(sourceDir, file), "utf-8"),
    ) as BigBenchmarkRun;
    const prompt = prompts.get(original.promptId);
    if (!prompt) throw new Error(`Unknown prompt id: ${original.promptId}`);

    const fixtureDir = getFixtureDir(original.fixture);
    const checkerResults = runStaticCheckers(
      original.generatedPlan,
      fixtureDir,
      prompt,
    );
    const groundTruth = extractGroundTruth(checkerResults);
    const detections = parseErrorDetections(
      groundTruth,
      original.selfReviewOutput,
      getAllFiles(fixtureDir),
    );
    const detected = detections.filter((item) => item.detected).length;

    const rescored: BigBenchmarkRun = {
      ...original,
      groundTruth,
      detections,
      perCategory: computePerCategory(detections),
      overallDetectionRate: groundTruth.length > 0
        ? detected / groundTruth.length
        : 1,
    };
    runs.push(rescored);
    fs.writeFileSync(
      path.join(outputDir, file),
      `${JSON.stringify(rescored, null, 2)}\n`,
      "utf-8",
    );
  }

  const summary = generateSummary(runs, runs[0]?.model ?? "unknown");
  fs.writeFileSync(
    path.join(outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(outputDir, "REPORT.md"),
    generateBigReport(runs, summary),
    "utf-8",
  );

  return outputDir;
}

/** CLI wrapper. */
export function runBigRescore(args: string[]): void {
  try {
    const outputDir = rescoreBigBenchmark(args[0]);
    const summary = JSON.parse(
      fs.readFileSync(path.join(outputDir, "summary.json"), "utf-8"),
    ) as { totalErrors: number; totalDetected: number; overallDetectionRate: number };
    console.log(chalk.green(`Rescored results written to: ${outputDir}`));
    console.log(
      `Review mentioned ${summary.totalDetected}/${summary.totalErrors} checker findings ` +
        `(${(summary.overallDetectionRate * 100).toFixed(1)}%).`,
    );
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
