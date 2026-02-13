import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import type { Tier3EvaluationResult, Tier3Comparison } from "../../harness/types.js";

function usage(): never {
  console.error("Usage: compare <results-dir>");
  console.error("");
  console.error("  <results-dir>  Path to the timestamped results directory");
  console.error("                 (must contain vanilla/ and arthur-assisted/ subdirs)");
  process.exit(1);
}

function loadEvaluation(dir: string): Tier3EvaluationResult {
  const evalFile = path.join(dir, "evaluation.json");
  if (!fs.existsSync(evalFile)) {
    console.error(chalk.red(`Missing evaluation: ${evalFile}`));
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(evalFile, "utf-8")) as Tier3EvaluationResult;
}

function determineBuildDelta(
  vanilla: Tier3EvaluationResult,
  arthur: Tier3EvaluationResult,
): Tier3Comparison["buildDelta"] {
  if (vanilla.build.pass && arthur.build.pass) return "both-pass";
  if (!vanilla.build.pass && arthur.build.pass) return "arthur-only";
  if (vanilla.build.pass && !arthur.build.pass) return "vanilla-only";
  return "both-fail";
}

function generateVerdict(comparison: Omit<Tier3Comparison, "verdict">): string {
  const { vanilla, arthurAssisted, buildDelta, scoreDelta } = comparison;

  if (buildDelta === "arthur-only") {
    return "Arthur-assisted arm produced a passing build while vanilla failed — clear Arthur advantage.";
  }
  if (buildDelta === "vanilla-only") {
    return "Vanilla arm produced a passing build while Arthur-assisted failed — Arthur verification did not help here.";
  }
  if (buildDelta === "both-fail") {
    return "Neither arm produced a passing build — refactoring was too complex for both approaches.";
  }

  // Both pass — compare scores
  const absDelta = Math.abs(scoreDelta);
  const winner = scoreDelta > 0 ? "Arthur-assisted" : "Vanilla";

  if (absDelta < 3) {
    return `Both arms produced passing builds with similar scores (Δ${scoreDelta.toFixed(1)}). Effectively a tie.`;
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
      ? "Arthur verification significantly improved the refactoring outcome."
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

  const partial = {
    vanilla,
    arthurAssisted: arthur,
    buildDelta,
    scoreDelta,
    fileCountDelta: arthur.extractedFiles.total - vanilla.extractedFiles.total,
    reductionDelta: arthur.appTsx.reductionPct - vanilla.appTsx.reductionPct,
    hallucinatedImportsDelta: arthur.hallucinatedImports.count - vanilla.hallucinatedImports.count,
  };

  const comparison: Tier3Comparison = {
    ...partial,
    verdict: generateVerdict(partial),
  };

  // Save comparison
  const compFile = path.join(resultsDir, "comparison.json");
  fs.writeFileSync(compFile, JSON.stringify(comparison, null, 2));

  // Print table
  console.log(chalk.bold.cyan("\n── Tier 3 Comparison ──\n"));

  const pad = (s: string, n: number) => s.padEnd(n);
  const rpad = (s: string, n: number) => s.padStart(n);

  console.log(
    `  ${pad("Metric", 25)} ${rpad("Vanilla", 12)} ${rpad("Arthur", 12)} ${rpad("Delta", 10)}`,
  );
  console.log(`  ${"-".repeat(59)}`);

  // Build
  const vBuild = vanilla.build.pass ? chalk.green("PASS") : chalk.red("FAIL");
  const aBuild = arthur.build.pass ? chalk.green("PASS") : chalk.red("FAIL");
  console.log(
    `  ${pad("Build", 25)} ${rpad(vanilla.build.pass ? "PASS" : "FAIL", 12)} ${rpad(arthur.build.pass ? "PASS" : "FAIL", 12)} ${rpad(buildDelta, 10)}`,
  );

  // App.tsx reduction
  console.log(
    `  ${pad("App.tsx reduction", 25)} ${rpad(vanilla.appTsx.reductionPct + "%", 12)} ${rpad(arthur.appTsx.reductionPct + "%", 12)} ${rpad((comparison.reductionDelta >= 0 ? "+" : "") + comparison.reductionDelta.toFixed(1) + "%", 10)}`,
  );

  // Files extracted
  console.log(
    `  ${pad("Files extracted", 25)} ${rpad(String(vanilla.extractedFiles.total), 12)} ${rpad(String(arthur.extractedFiles.total), 12)} ${rpad((comparison.fileCountDelta >= 0 ? "+" : "") + String(comparison.fileCountDelta), 10)}`,
  );

  // Hallucinated imports
  console.log(
    `  ${pad("Hallucinated imports", 25)} ${rpad(String(vanilla.hallucinatedImports.count), 12)} ${rpad(String(arthur.hallucinatedImports.count), 12)} ${rpad((comparison.hallucinatedImportsDelta >= 0 ? "+" : "") + String(comparison.hallucinatedImportsDelta), 10)}`,
  );

  // Composite score
  console.log(`  ${"-".repeat(59)}`);
  console.log(
    `  ${pad("Composite score", 25)} ${rpad(String(vanilla.compositeScore), 12)} ${rpad(String(arthur.compositeScore), 12)} ${rpad((scoreDelta >= 0 ? "+" : "") + scoreDelta.toFixed(1), 10)}`,
  );

  console.log(chalk.bold(`\n  Verdict: ${comparison.verdict}\n`));
  console.log(chalk.green(`✓ Comparison saved: ${compFile}`));
}

main();
