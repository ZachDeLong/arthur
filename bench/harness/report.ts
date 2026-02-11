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

  return {
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
}
