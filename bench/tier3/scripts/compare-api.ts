import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import type { ApiUnificationEvaluationResult, ApiUnificationComparison } from "../../harness/types.js";

function usage(): never {
  console.error("Usage: compare-api <results-dir>");
  console.error("");
  console.error("  <results-dir>  Path to the timestamped results directory");
  console.error("                 (must contain vanilla/ and arthur-assisted/ subdirs)");
  process.exit(1);
}

function loadEvaluation(dir: string): ApiUnificationEvaluationResult {
  const evalFile = path.join(dir, "evaluation.json");
  if (!fs.existsSync(evalFile)) {
    console.error(chalk.red(`Missing evaluation: ${evalFile}`));
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(evalFile, "utf-8")) as ApiUnificationEvaluationResult;
}

function determineBuildDelta(
  vanilla: ApiUnificationEvaluationResult,
  arthur: ApiUnificationEvaluationResult,
): ApiUnificationComparison["buildDelta"] {
  if (vanilla.build.pass && arthur.build.pass) return "both-pass";
  if (!vanilla.build.pass && arthur.build.pass) return "arthur-only";
  if (vanilla.build.pass && !arthur.build.pass) return "vanilla-only";
  return "both-fail";
}

function generateVerdict(comparison: Omit<ApiUnificationComparison, "verdict">): string {
  const { buildDelta, scoreDelta, typeAccuracyDelta } = comparison;

  if (buildDelta === "arthur-only") {
    return "Arthur-assisted arm produced a passing build while vanilla failed — clear Arthur advantage.";
  }
  if (buildDelta === "vanilla-only") {
    return "Vanilla arm produced a passing build while Arthur-assisted failed — Arthur verification did not help here.";
  }
  if (buildDelta === "both-fail") {
    return "Neither arm produced a passing build — task was too complex for both approaches.";
  }

  // Both pass — compare scores
  const absDelta = Math.abs(scoreDelta);
  const winner = scoreDelta > 0 ? "Arthur-assisted" : "Vanilla";

  if (absDelta < 3) {
    let note = `Both arms similar (Δ${scoreDelta.toFixed(1)}).`;
    if (Math.abs(typeAccuracyDelta) > 10) {
      note += ` Type accuracy diverged: ${typeAccuracyDelta > 0 ? "Arthur" : "Vanilla"} +${Math.abs(typeAccuracyDelta).toFixed(0)}%.`;
    }
    return note;
  }
  if (absDelta < 10) {
    return `${winner} edges ahead by ${absDelta.toFixed(1)} points. ${
      scoreDelta > 0
        ? "Arthur verification provided a modest advantage."
        : "Arthur verification did not improve the outcome."
    }`;
  }
  return `${winner} wins by ${absDelta.toFixed(1)} points. ${
    scoreDelta > 0
      ? "Arthur verification significantly improved type accuracy and API coverage."
      : "Arthur verification hurt the outcome — worth investigating why."
  }`;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1) usage();

  const resultsDir = path.resolve(args[0]);
  const vanillaDir = path.join(resultsDir, "vanilla");
  const arthurDir = path.join(resultsDir, "arthur-assisted");

  if (!fs.existsSync(vanillaDir) || !fs.existsSync(arthurDir)) {
    console.error(chalk.red("Results directory must contain vanilla/ and arthur-assisted/ subdirs"));
    process.exit(1);
  }

  const vanilla = loadEvaluation(vanillaDir);
  const arthur = loadEvaluation(arthurDir);

  const buildDelta = determineBuildDelta(vanilla, arthur);
  const scoreDelta = arthur.compositeScore - vanilla.compositeScore;
  const typeAccuracyDelta = arthur.typeAccuracy.overallScore - vanilla.typeAccuracy.overallScore;

  const partial = {
    vanilla,
    arthurAssisted: arthur,
    buildDelta,
    scoreDelta,
    typeAccuracyDelta,
    rawFetchDelta: arthur.apiCoverage.totalRawFetches - vanilla.apiCoverage.totalRawFetches,
    hallucinatedImportsDelta: arthur.hallucinatedImports.count - vanilla.hallucinatedImports.count,
  };

  const comparison: ApiUnificationComparison = {
    ...partial,
    verdict: generateVerdict(partial),
  };

  // Save comparison
  const compFile = path.join(resultsDir, "comparison.json");
  fs.writeFileSync(compFile, JSON.stringify(comparison, null, 2));

  // Print table
  console.log(chalk.bold.cyan("\n── API Unification Comparison ──\n"));

  const pad = (s: string, n: number) => s.padEnd(n);
  const rpad = (s: string, n: number) => s.padStart(n);

  console.log(
    `  ${pad("Metric", 25)} ${rpad("Vanilla", 12)} ${rpad("Arthur", 12)} ${rpad("Delta", 10)}`,
  );
  console.log(`  ${"-".repeat(59)}`);

  // Build
  console.log(
    `  ${pad("Build", 25)} ${rpad(vanilla.build.pass ? "PASS" : "FAIL", 12)} ${rpad(arthur.build.pass ? "PASS" : "FAIL", 12)} ${rpad(buildDelta, 10)}`,
  );

  // Type accuracy
  console.log(
    `  ${pad("Type accuracy", 25)} ${rpad(vanilla.typeAccuracy.overallScore + "%", 12)} ${rpad(arthur.typeAccuracy.overallScore + "%", 12)} ${rpad((typeAccuracyDelta >= 0 ? "+" : "") + typeAccuracyDelta.toFixed(1) + "%", 10)}`,
  );

  // Raw fetches
  console.log(
    `  ${pad("Raw fetch calls", 25)} ${rpad(String(vanilla.apiCoverage.totalRawFetches), 12)} ${rpad(String(arthur.apiCoverage.totalRawFetches), 12)} ${rpad((comparison.rawFetchDelta >= 0 ? "+" : "") + String(comparison.rawFetchDelta), 10)}`,
  );

  // Hallucinated imports
  console.log(
    `  ${pad("Hallucinated imports", 25)} ${rpad(String(vanilla.hallucinatedImports.count), 12)} ${rpad(String(arthur.hallucinatedImports.count), 12)} ${rpad((comparison.hallucinatedImportsDelta >= 0 ? "+" : "") + String(comparison.hallucinatedImportsDelta), 10)}`,
  );

  // Error handling
  console.log(
    `  ${pad("Error handling", 25)} ${rpad(vanilla.errorHandling.coveragePct + "%", 12)} ${rpad(arthur.errorHandling.coveragePct + "%", 12)} ${rpad((arthur.errorHandling.coveragePct - vanilla.errorHandling.coveragePct >= 0 ? "+" : "") + (arthur.errorHandling.coveragePct - vanilla.errorHandling.coveragePct) + "%", 10)}`,
  );

  // Composite score
  console.log(`  ${"-".repeat(59)}`);
  console.log(
    `  ${pad("Composite score", 25)} ${rpad(String(vanilla.compositeScore), 12)} ${rpad(String(arthur.compositeScore), 12)} ${rpad((scoreDelta >= 0 ? "+" : "") + scoreDelta.toFixed(1), 10)}`,
  );

  // Per-type breakdown
  console.log(chalk.dim("\n  Type accuracy detail:"));
  for (const [gtName, vAcc] of Object.entries(vanilla.typeAccuracy.fieldAccuracy)) {
    const aAcc = arthur.typeAccuracy.fieldAccuracy[gtName];
    const vPct = vAcc.expected.length > 0
      ? Math.round(((vAcc.expected.length - vAcc.missing.length) / vAcc.expected.length) * 100)
      : 0;
    const aPct = aAcc && aAcc.expected.length > 0
      ? Math.round(((aAcc.expected.length - aAcc.missing.length) / aAcc.expected.length) * 100)
      : 0;
    console.log(chalk.dim(`    ${pad(gtName, 25)} ${rpad(vPct + "%", 8)} ${rpad(aPct + "%", 8)}`));
  }

  console.log(chalk.bold(`\n  Verdict: ${comparison.verdict}\n`));
  console.log(chalk.green(`✓ Comparison saved: ${compFile}`));
}

main();
