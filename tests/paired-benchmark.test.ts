import { describe, expect, it } from "vitest";
import { predictWithArthur } from "../bench/paired/arthur-predictor.js";
import {
  generateCorpus,
  loadLockedCases,
  loadLockedCorpus,
} from "../bench/paired/corpus.js";
import { pairedExactTest, scoreRun } from "../bench/paired/score.js";
import type { PredictionRun } from "../bench/paired/types.js";

describe("paired benchmark corpus", () => {
  it("is locked, exhaustive, balanced by construction, and label-blind", () => {
    const { cases, labels, manifest } = loadLockedCorpus();
    const predictionInputs = loadLockedCases();
    const outcomes = labels.reduce<Record<string, number>>((counts, label) => {
      counts[label.expected] = (counts[label.expected] ?? 0) + 1;
      return counts;
    }, {});

    expect(cases).toHaveLength(80);
    expect(manifest.categoryCounts).toEqual({ import: 28, env: 36, route: 16 });
    expect(outcomes).toEqual({ ignored: 40, error: 20, clean: 20 });
    expect(predictionInputs.cases).toEqual(cases);
    expect(cases.every((testCase) => !("expected" in testCase))).toBe(true);
  });

  it("re-generates to the frozen hashes without using checker output", () => {
    const generated = generateCorpus();
    const locked = loadLockedCorpus();
    expect(generated.manifest.casesSha256).toBe(locked.manifest.casesSha256);
    expect(generated.manifest.labelsSha256).toBe(locked.manifest.labelsSha256);
  });

  it("preserves the first honest Arthur baseline, including its PORT mismatch", () => {
    const { cases, labels, manifest } = loadLockedCorpus();
    const run = predictWithArthur(cases, manifest.casesSha256);
    const score = scoreRun(cases, labels, run);

    expect(score.metrics.precision).toBe(1);
    expect(score.metrics.recall).toBe(1);
    expect(score.metrics.specificity).toBe(1);
    expect(score.metrics.exactOutcomeAccuracy).toBe(79 / 80);
    expect(score.mismatches).toEqual([
      expect.objectContaining({ source: "export const value = process.env.PORT;" }),
    ]);
  });
});
describe("paired exact test", () => {
  it("counts paired correctness rather than comparing unpaired rates", () => {
    const { cases, labels, manifest } = loadLockedCorpus();
    const perfectPredictions = labels.map((label) => ({
      id: label.id,
      outcome: label.expected,
      reason: "oracle",
    }));
    const perfect: PredictionRun = {
      system: "perfect",
      repetition: 1,
      corpusSha256: manifest.casesSha256,
      predictions: perfectPredictions,
      durationMs: 0,
    };
    const arthur = predictWithArthur(cases, manifest.casesSha256);
    const result = pairedExactTest(cases, labels, arthur, perfect);

    expect(result).toEqual({
      leftOnlyCorrect: 0,
      rightOnlyCorrect: 1,
      pValue: 1,
    });
  });
});
