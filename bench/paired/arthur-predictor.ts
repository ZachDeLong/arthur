import { performance } from "node:perf_hooks";
import path from "node:path";
import { analyzeEnvSourceFiles } from "../../src/analysis/env-checker.js";
import { analyzeImports } from "../../src/analysis/import-checker.js";
import { analyzeApiRouteSourceFiles } from "../../src/analysis/api-route-checker.js";
import type { DiffFile } from "../../src/diff/resolver.js";
import { repoRoot } from "./corpus.js";
import type {
  PairedCase,
  PairedOutcome,
  PairedPrediction,
  PredictionRun,
} from "./types.js";

function predictCase(testCase: PairedCase): PairedPrediction {
  const file: DiffFile = {
    path: testCase.filePath,
    content: `${testCase.source}\n`,
    changedLines: [1],
    status: "added",
  };
  const projectDir = path.resolve(repoRoot, testCase.projectDir);
  let outcome: PairedOutcome;
  let reason: string;

  if (testCase.category === "import") {
    const result = analyzeImports([file], projectDir, { mode: "source" });
    outcome = result.hallucinations.length > 0
      ? "error"
      : result.checkedImports > 0 || result.unverifiedImports.length > 0
        ? "clean"
        : "ignored";
    reason = result.hallucinations[0]?.reason
      ?? result.unverifiedImports[0]?.reason
      ?? (outcome === "ignored" ? "no live import reference" : "package reference resolved");
  } else if (testCase.category === "env") {
    const result = analyzeEnvSourceFiles([file], projectDir);
    outcome = result.hallucinations.length > 0
      ? "error"
      : result.checkedRefs > 0
        ? "clean"
        : "ignored";
    reason = result.hallucinations[0]?.reason
      ?? (outcome === "ignored" ? "no live env reference" : "env reference declared");
  } else {
    const result = analyzeApiRouteSourceFiles([file], projectDir);
    outcome = result.hallucinations.length > 0
      ? "error"
      : result.checkedRefs > 0
        ? "clean"
        : "ignored";
    reason = result.hallucinations[0]?.hallucinationCategory
      ?? (outcome === "ignored" ? "no live route reference" : "route reference resolved");
  }

  return { id: testCase.id, outcome, reason };
}
export function predictWithArthur(cases: PairedCase[], corpusSha256: string): PredictionRun {
  const started = performance.now();
  const predictions = cases.map(predictCase);
  return {
    system: "arthur",
    corpusSha256,
    repetition: 1,
    predictions,
    durationMs: performance.now() - started,
  };
}
