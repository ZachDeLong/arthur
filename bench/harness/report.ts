import type { BenchmarkRun, BenchmarkSummary } from "./types.js";

/** Aggregate individual benchmark runs into a summary. */
export function generateSummary(runs: BenchmarkRun[]): BenchmarkSummary {
  const tier1PerRun = runs.map((run) => ({
    promptId: run.promptId,
    hallucinationRate: run.tier1.pathAnalysis.hallucinationRate,
    detectionRate: run.tier1.detectionRate,
  }));

  const avgHallucinationRate =
    tier1PerRun.length > 0
      ? Number(
          (
            tier1PerRun.reduce((sum, r) => sum + r.hallucinationRate, 0) /
            tier1PerRun.length
          ).toFixed(4),
        )
      : 0;

  const avgDetectionRate =
    tier1PerRun.length > 0
      ? Number(
          (
            tier1PerRun.reduce((sum, r) => sum + r.detectionRate, 0) /
            tier1PerRun.length
          ).toFixed(4),
        )
      : 0;

  const totalInputTokens = runs.reduce(
    (sum, r) => sum + r.apiUsage.planInputTokens + r.apiUsage.verifyInputTokens,
    0,
  );
  const totalOutputTokens = runs.reduce(
    (sum, r) =>
      sum + r.apiUsage.planOutputTokens + r.apiUsage.verifyOutputTokens,
    0,
  );

  // Tier 2 merged separately via score-tier2.ts
  const tier2PerRun = runs
    .filter((r) => r.tier2)
    .map((r) => ({
      promptId: r.promptId,
      scores: r.tier2!.scores,
    }));

  const summary: BenchmarkSummary = {
    tier1: {
      avgHallucinationRate,
      avgDetectionRate,
      perRun: tier1PerRun,
    },
    apiUsage: {
      totalInputTokens,
      totalOutputTokens,
      totalCalls: runs.length * 2, // plan + verify per run
    },
  };

  if (tier2PerRun.length > 0) {
    const avgScores = {
      missingLogic: 0,
      wrongAssumptions: 0,
      securityIssues: 0,
      completenessGaps: 0,
      conventionViolations: 0,
      overallQuality: 0,
    };

    for (const run of tier2PerRun) {
      for (const key of Object.keys(avgScores) as (keyof typeof avgScores)[]) {
        avgScores[key] += run.scores[key];
      }
    }
    for (const key of Object.keys(avgScores) as (keyof typeof avgScores)[]) {
      avgScores[key] = Number(
        (avgScores[key] / tier2PerRun.length).toFixed(2),
      );
    }

    summary.tier2 = { avgScores, perRun: tier2PerRun };
  }

  return summary;
}
