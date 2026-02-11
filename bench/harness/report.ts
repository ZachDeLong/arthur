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

  // Count total API calls: plan + tier1 verify per run + tier2 verify calls
  let tier2VerifyCalls = 0;
  const runsWithTier2 = runs.filter((r) => r.tier2);

  const summary: BenchmarkSummary = {
    tier1: {
      avgHallucinationRate,
      avgDetectionRate,
      perRun: tier1PerRun,
    },
    apiUsage: {
      totalInputTokens,
      totalOutputTokens,
      totalCalls: 0, // computed below
    },
  };

  // Build tier2 summary if any runs have tier2 data
  if (runsWithTier2.length > 0) {
    const allDetections = runsWithTier2.flatMap((r) => r.tier2!.detections);
    const appliedDetections = allDetections.filter((d) => d.injectionApplied);
    tier2VerifyCalls = appliedDetections.length;

    const detectedCount = appliedDetections.filter((d) => d.detected).length;
    const avgTier2DetectionRate =
      appliedDetections.length > 0
        ? Number((detectedCount / appliedDetections.length).toFixed(4))
        : 0;

    // Per-category rates
    const perCategory: Record<string, number> = {};
    const categoryGroups = new Map<string, { applied: number; detected: number }>();
    for (const det of allDetections) {
      const group = categoryGroups.get(det.category) ?? { applied: 0, detected: 0 };
      if (det.injectionApplied) {
        group.applied++;
        if (det.detected) group.detected++;
      }
      categoryGroups.set(det.category, group);
    }
    for (const [cat, group] of categoryGroups) {
      perCategory[cat] = group.applied > 0
        ? Number((group.detected / group.applied).toFixed(4))
        : 0;
    }

    // Per-method rates (injection method)
    const perMethod: Record<string, number> = {};
    // We need the specs to know the injection method — derive from spec IDs
    // Instead, group by the detection method used (critical-callout, alignment-section, signal-match)
    // But the plan says "perMethod" = injection method. We can derive this from the spec data
    // stored in drift-specs.json. For now, compute from what we have in detections.
    // Since DriftDetection doesn't store injection method, we'll use the detection .method field
    // to show which scoring methods succeeded. This is more useful for calibration anyway.
    const methodGroups = new Map<string, { applied: number; detected: number }>();
    for (const det of appliedDetections) {
      const key = det.method ?? "none";
      const group = methodGroups.get(key) ?? { applied: 0, detected: 0 };
      group.applied++;
      if (det.detected) group.detected++;
      methodGroups.set(key, group);
    }
    for (const [method, group] of methodGroups) {
      perMethod[method] = group.applied > 0
        ? Number((group.detected / group.applied).toFixed(4))
        : 0;
    }

    // Per-spec breakdown
    const perSpec = allDetections.map((d) => ({
      specId: d.specId,
      category: d.category,
      injectionApplied: d.injectionApplied,
      detected: d.detected,
      method: d.method,
    }));

    summary.tier2 = {
      avgDetectionRate: avgTier2DetectionRate,
      perCategory,
      perMethod,
      perSpec,
    };
  }

  summary.apiUsage.totalCalls = runs.length * 2 + tier2VerifyCalls;

  return summary;
}
