import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { analyzeEnvSourceFiles } from "../../src/analysis/env-checker.js";
import { analyzeApiRouteSourceFiles } from "../../src/analysis/api-route-checker.js";
import { analyzeImports } from "../../src/analysis/import-checker.js";
import type { DiffFile } from "../../src/diff/resolver.js";

type ExpectedOutcome = "clean" | "error" | "warning" | "ignored";
type CheckerId = "env" | "routes" | "imports";

interface GoldCase {
  id: string;
  checker: CheckerId;
  source: string;
  expected: ExpectedOutcome;
  reason: string;
  fixture?: string;
  sourcePath?: string;
}

interface CaseResult extends GoldCase {
  actual: ExpectedOutcome;
  durationMs: number;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const corpus = JSON.parse(
  fs.readFileSync(path.join(here, "corpus.json"), "utf-8"),
) as GoldCase[];

function classify(testCase: GoldCase): ExpectedOutcome {
  const fixture = testCase.fixture ?? (testCase.checker === "imports" ? "fixture-a" : "fixture-c");
  const projectDir = path.join(repoRoot, "bench/fixtures", fixture);
  const file: DiffFile = {
    path: testCase.sourcePath ?? `src/validation/${testCase.id}.ts`,
    content: `${testCase.source}\n`,
    changedLines: [1],
    status: "added",
  };

  if (testCase.checker === "env") {
    const result = analyzeEnvSourceFiles(
      [file],
      projectDir,
    );
    if (result.hallucinations.length > 0) return "error";
    return result.checkedRefs > 0 ? "clean" : "ignored";
  }

  if (testCase.checker === "routes") {
    const result = analyzeApiRouteSourceFiles(
      [file],
      projectDir,
    );
    if (result.hallucinations.length > 0) return "error";
    return result.checkedRefs > 0 ? "clean" : "ignored";
  }

  const result = analyzeImports(
    [file],
    projectDir,
    { mode: "source" },
  );
  if (result.hallucinations.length > 0) return "error";
  if (result.unverifiedImports.length > 0) return "warning";
  return result.checkedImports > 0 ? "clean" : "ignored";
}

const results: CaseResult[] = corpus.map((testCase) => {
  const start = performance.now();
  const actual = classify(testCase);
  return { ...testCase, actual, durationMs: performance.now() - start };
});

const expectedErrors = results.filter((result) => result.expected === "error");
const predictedErrors = results.filter((result) => result.actual === "error");
const truePositives = predictedErrors.filter((result) => result.expected === "error").length;
const falsePositives = predictedErrors.length - truePositives;
const falseNegatives = expectedErrors.filter((result) => result.actual !== "error").length;
const exactMatches = results.filter((result) => result.actual === result.expected).length;
const precision = predictedErrors.length > 0 ? truePositives / predictedErrors.length : 1;
const recall = expectedErrors.length > 0 ? truePositives / expectedErrors.length : 1;
const accuracy = exactMatches / results.length;
const sortedDurations = results.map((result) => result.durationMs).sort((a, b) => a - b);
const p95Index = Math.max(0, Math.ceil(sortedDurations.length * 0.95) - 1);
const p95Ms = sortedDurations[p95Index] ?? 0;
const mismatches = results.filter((result) => result.actual !== result.expected);

const report = {
  corpus: {
    cases: results.length,
    provenance: "Manually specified fixture labels stored independently from checker execution.",
    limitation: "Regression evidence only. Real-world precision still requires external repositories and users.",
  },
  metrics: {
    precision,
    recall,
    exactOutcomeAccuracy: accuracy,
    truePositives,
    falsePositives,
    falseNegatives,
    p95CaseMs: p95Ms,
  },
  thresholds: {
    minimumPrecision: 0.98,
    minimumRecall: 0.95,
    maximumP95CaseMs: 3000,
  },
  mismatches: mismatches.map((result) => ({
    id: result.id,
    expected: result.expected,
    actual: result.actual,
    reason: result.reason,
  })),
};

console.log(JSON.stringify(report, null, 2));

if (precision < 0.98 || recall < 0.95 || p95Ms > 3000 || mismatches.length > 0) {
  process.exitCode = 1;
}
