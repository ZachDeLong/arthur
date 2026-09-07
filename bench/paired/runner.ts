import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { predictWithArthur } from "./arthur-predictor.js";
import { predictWithClaude } from "./claude-predictor.js";
import { freezeCorpus, loadLockedCases, loadLockedCorpus } from "./corpus.js";
import { writeScoredArtifacts } from "./score.js";
import type { PredictionRun } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsRoot = path.resolve(here, "..", "results");

function createRunDir(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = path.join(resultsRoot, `paired-${timestamp}`);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

function writeRun(runDir: string, run: PredictionRun): string {
  const safeSystem = run.system.replace(/[^a-z0-9.-]+/gi, "-").toLowerCase();
  const target = path.join(runDir, `${safeSystem}-run-${run.repetition}.json`);
  fs.writeFileSync(target, `${JSON.stringify(run, null, 2)}\n`, "utf-8");
  return target;
}

function readRuns(runDir: string): PredictionRun[] {
  return fs.readdirSync(runDir)
    .filter((file) => file.endsWith(".json") && !["scores.json", "summary.json"].includes(file))
    .map((file) => JSON.parse(fs.readFileSync(path.join(runDir, file), "utf-8")) as PredictionRun)
    .filter((value) => Array.isArray(value.predictions))
    .sort((a, b) => a.system.localeCompare(b.system) || a.repetition - b.repetition);
}

function resolveRunDir(value?: string): string {
  if (value) return path.isAbsolute(value) ? value : path.join(resultsRoot, value);
  const latest = fs.readdirSync(resultsRoot)
    .filter((entry) => entry.startsWith("paired-") && fs.statSync(path.join(resultsRoot, entry)).isDirectory())
    .sort()
    .at(-1);
  if (!latest) throw new Error("No paired benchmark result directory found.");
  return path.join(resultsRoot, latest);
}

async function runArthur(runDir: string): Promise<PredictionRun> {
  const { cases, manifest } = loadLockedCases();
  const run = predictWithArthur(cases, manifest.casesSha256);
  writeRun(runDir, run);
  console.log(chalk.green(`Arthur predicted ${cases.length} locked cases in ${run.durationMs.toFixed(1)} ms.`));
  return run;
}

async function runClaude(runDir: string, repetitions: number): Promise<PredictionRun[]> {
  const { cases, manifest } = loadLockedCases();
  const runs: PredictionRun[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    console.log(chalk.blue(`Claude repetition ${repetition}/${repetitions}...`));
    const run = await predictWithClaude(cases, manifest.casesSha256, repetition);
    writeRun(runDir, run);
    runs.push(run);
    console.log(chalk.green(`Claude repetition ${repetition} completed.`));
  }
  return runs;
}

function score(runDir: string): string {
  const { cases, labels, manifest } = loadLockedCorpus();
  const runs = readRuns(runDir);
  if (runs.length === 0) throw new Error(`No prediction runs found in ${runDir}`);
  for (const run of runs) {
    if (run.corpusSha256 !== manifest.casesSha256) {
      throw new Error(`${run.system} run ${run.repetition} used a different corpus hash.`);
    }
  }
  const { reportPath } = writeScoredArtifacts({
    outputDir: runDir,
    cases,
    labels,
    corpusSha256: manifest.casesSha256,
    runs,
  });
  console.log(chalk.green(`Report written to: ${reportPath}`));
  return reportPath;
}

async function main(): Promise<void> {
  const [command = "score", ...args] = process.argv.slice(2);

  if (command === "freeze") {
    const manifest = freezeCorpus(args.includes("--force"));
    console.log(chalk.green(`Locked ${manifest.caseCount} cases.`));
    console.log(`cases sha256: ${manifest.casesSha256}`);
    console.log(`labels sha256: ${manifest.labelsSha256}`);
    return;
  }

  if (command === "arthur") {
    const runDir = args[0] ? resolveRunDir(args[0]) : createRunDir();
    fs.mkdirSync(runDir, { recursive: true });
    await runArthur(runDir);
    score(runDir);
    return;
  }

  if (command === "claude") {
    const runDir = args[0] ? resolveRunDir(args[0]) : createRunDir();
    const repetitions = Number.parseInt(args[1] ?? "3", 10);
    if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
      throw new Error("Claude repetitions must be an integer from 1 to 10.");
    }
    fs.mkdirSync(runDir, { recursive: true });
    await runClaude(runDir, repetitions);
    score(runDir);
    return;
  }

  if (command === "all") {
    const repetitions = Number.parseInt(args[0] ?? "3", 10);
    if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
      throw new Error("Claude repetitions must be an integer from 1 to 10.");
    }
    const runDir = createRunDir();
    await runArthur(runDir);
    await runClaude(runDir, repetitions);
    score(runDir);
    return;
  }

  if (command === "score") {
    score(resolveRunDir(args[0]));
    return;
  }

  throw new Error("Usage: paired [freeze [--force]|arthur [run-dir]|claude [run-dir] [repetitions]|all [repetitions]|score [run-dir]]");
}

main().catch((error) => {
  console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
