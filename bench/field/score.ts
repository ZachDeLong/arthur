import fs from "node:fs";
import path from "node:path";
import { recordAuditEvent, verifyAuditChain } from "./audit.js";
import { validateStudyDefinition } from "./definition.js";
import { validateCaptureArtifacts } from "./freeze.js";
import {
  readJson,
  readJsonLines,
  sha256,
  stableJson,
  writeJsonExclusive,
  writeTextExclusive,
} from "./storage.js";
import { resolveGroundTruth } from "./review.js";
import { assertStudyStatus, captureDir, loadManifest, saveManifest } from "./study-store.js";
import type {
  ArthurCapture,
  BaselineSubmission,
  CasePrediction,
  ComparatorPrediction,
  ComparatorRun,
  CollectionLock,
  ReferenceCase,
  RetentionDecision,
  ReviewLabel,
  ReviewPacket,
  StandardToolEvidence,
  StudyLock,
} from "./types.js";

interface Counts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  total: number;
}

interface Interval {
  low: number;
  high: number;
  iterations: number;
}

interface SystemScore {
  counts: Counts;
  precision: number | null;
  recall: number | null;
  specificity: number | null;
  accuracy: number | null;
  f1: number | null;
  clustered95: {
    precision: Interval | null;
    recall: Interval | null;
  };
  perDomain: Record<string, Counts>;
  falsePositiveCaseIds: string[];
  falseNegativeCaseIds: string[];
}

interface FieldReport {
  studyId: string;
  completedAt: string;
  lockSha256: string;
  cohort: {
    changes: number;
    repositories: number;
    cases: number;
    exclusions: number;
  };
  review: {
    reviewers: string[];
    rawAgreement: number | null;
    cohensKappa: number | null;
    adjudicatedCases: number;
    labelCounts: Record<string, number>;
  };
  arthur: SystemScore & {
    p50LatencyMs: number | null;
    p50LatencyClustered95: Interval | null;
    p95LatencyMs: number | null;
    p95LatencyClustered95: Interval | null;
    diffFalseBlockRate: number | null;
    diffFalseBlockRateClustered95: Interval | null;
    falseBlockedChanges: string[];
  };
  comparator: SystemScore & {
    system: string;
    provider: string;
    model: string;
    requestedModel: string;
    inputTokens: number;
    outputTokens: number;
    pricing: ComparatorRun["pricing"];
    estimatedCostUsd: number;
    durationMs: number;
  };
  paired: {
    arthurOnlyCorrect: number;
    comparatorOnlyCorrect: number;
    exactMcNemarP: number;
    accuracyDifference: number | null;
    accuracyDifferenceClustered95: Interval | null;
  };
  incremental: {
    actionableDefects: number;
    defectsCaughtByArthur: number;
    defectsCaughtByStandardTools: number;
    defectsCaughtByArthurOnly: number;
    arthurOnlyDefectIds: string[];
    arthurOnlyDefectsClustered95: Interval | null;
  };
  retention: {
    eligibleDecisions: number;
    keptEnabled: number;
    developerIdsKeepingEnabled: string[];
  };
  decision: {
    continueDevelopment: boolean;
    criteria: Record<string, { passed: boolean; actual: number; required: string }>;
  };
  interpretation: string;
}

function metric(successes: number, total: number): number | null {
  return total === 0 ? null : successes / total;
}

function f1(precision: number | null, recall: number | null): number | null {
  if (precision === null || recall === null) return null;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

function countCases(
  cases: ReferenceCase[],
  labels: Map<string, Exclude<ReviewLabel, "uncertain">>,
  predictedInvalid: Map<string, boolean>,
): Counts {
  const counts: Counts = { tp: 0, fp: 0, fn: 0, tn: 0, total: cases.length };
  for (const item of cases) {
    const positive = labels.get(item.caseId) === "actionable_invalid";
    const predicted = predictedInvalid.get(item.caseId) ?? false;
    if (positive && predicted) counts.tp++;
    else if (!positive && predicted) counts.fp++;
    else if (positive) counts.fn++;
    else counts.tn++;
  }
  return counts;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/** Hierarchical bootstrap: repositories, then diffs, with references kept clustered. */
function clusterInterval(
  cases: ReferenceCase[],
  labels: Map<string, Exclude<ReviewLabel, "uncertain">>,
  predictions: Map<string, boolean>,
  metricName: "precision" | "recall",
  seedText: string,
  iterations = 10_000,
): Interval | null {
  const byRepository = new Map<string, Map<string, ReferenceCase[]>>();
  for (const item of cases) {
    const changes = byRepository.get(item.repositoryId) ?? new Map<string, ReferenceCase[]>();
    const changeCases = changes.get(item.changeId) ?? [];
    changeCases.push(item);
    changes.set(item.changeId, changeCases);
    byRepository.set(item.repositoryId, changes);
  }
  const repositories = [...byRepository.keys()].sort();
  if (repositories.length === 0) return null;
  const seed = Number.parseInt(sha256(seedText).slice(0, 8), 16);
  const random = mulberry32(seed);
  const values: number[] = [];

  for (let iteration = 0; iteration < iterations; iteration++) {
    const sampled: ReferenceCase[] = [];
    for (let repositoryIndex = 0; repositoryIndex < repositories.length; repositoryIndex++) {
      const repositoryId = repositories[Math.floor(random() * repositories.length)];
      const changes = [...byRepository.get(repositoryId)!.values()];
      for (let changeIndex = 0; changeIndex < changes.length; changeIndex++) {
        sampled.push(...changes[Math.floor(random() * changes.length)]);
      }
    }
    const counts = countCases(sampled, labels, predictions);
    const value = metricName === "precision"
      ? metric(counts.tp, counts.tp + counts.fp)
      : metric(counts.tp, counts.tp + counts.fn);
    if (value !== null) values.push(value);
  }
  if (values.length === 0) return null;
  return {
    low: quantile(values, 0.025),
    high: quantile(values, 0.975),
    iterations: values.length,
  };
}

function clusteredChangeInterval(
  changes: Array<{ repositoryId: string; changeId: string }>,
  statistic: (sampledChangeIds: string[]) => number | null,
  seedText: string,
  iterations = 10_000,
): Interval | null {
  const byRepository = new Map<string, string[]>();
  for (const change of changes) {
    const items = byRepository.get(change.repositoryId) ?? [];
    items.push(change.changeId);
    byRepository.set(change.repositoryId, items);
  }
  const repositories = [...byRepository.keys()].sort();
  if (repositories.length === 0) return null;
  const random = mulberry32(Number.parseInt(sha256(seedText).slice(0, 8), 16));
  const values: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const sampled: string[] = [];
    for (let repositoryIndex = 0; repositoryIndex < repositories.length; repositoryIndex++) {
      const repositoryId = repositories[Math.floor(random() * repositories.length)];
      const changeIds = byRepository.get(repositoryId)!;
      for (let changeIndex = 0; changeIndex < changeIds.length; changeIndex++) {
        sampled.push(changeIds[Math.floor(random() * changeIds.length)]);
      }
    }
    const value = statistic(sampled);
    if (value !== null && Number.isFinite(value)) values.push(value);
  }
  if (values.length === 0) return null;
  return {
    low: quantile(values, 0.025),
    high: quantile(values, 0.975),
    iterations: values.length,
  };
}

function scoreSystem(
  cases: ReferenceCase[],
  labels: Map<string, Exclude<ReviewLabel, "uncertain">>,
  predictions: Map<string, boolean>,
  seed: string,
): SystemScore {
  const counts = countCases(cases, labels, predictions);
  const precision = metric(counts.tp, counts.tp + counts.fp);
  const recall = metric(counts.tp, counts.tp + counts.fn);
  const specificity = metric(counts.tn, counts.tn + counts.fp);
  const perDomain: Record<string, Counts> = {};
  for (const domain of ["imports", "env", "routes"] as const) {
    perDomain[domain] = countCases(
      cases.filter((item) => item.domain === domain),
      labels,
      predictions,
    );
  }
  const falsePositiveCaseIds = cases
    .filter((item) => predictions.get(item.caseId) && labels.get(item.caseId) !== "actionable_invalid")
    .map((item) => item.caseId);
  const falseNegativeCaseIds = cases
    .filter((item) => !predictions.get(item.caseId) && labels.get(item.caseId) === "actionable_invalid")
    .map((item) => item.caseId);
  return {
    counts,
    precision,
    recall,
    specificity,
    accuracy: metric(counts.tp + counts.tn, counts.total),
    f1: f1(precision, recall),
    clustered95: {
      precision: clusterInterval(cases, labels, predictions, "precision", `${seed}:precision`),
      recall: clusterInterval(cases, labels, predictions, "recall", `${seed}:recall`),
    },
    perDomain,
    falsePositiveCaseIds,
    falseNegativeCaseIds,
  };
}

function combination(n: number, k: number): number {
  const smaller = Math.min(k, n - k);
  let result = 1;
  for (let index = 1; index <= smaller; index++) {
    result = (result * (n - smaller + index)) / index;
  }
  return result;
}

function pairedTest(
  cases: ReferenceCase[],
  labels: Map<string, Exclude<ReviewLabel, "uncertain">>,
  arthur: Map<string, boolean>,
  comparator: Map<string, boolean>,
): { arthurOnlyCorrect: number; comparatorOnlyCorrect: number; exactMcNemarP: number } {
  let arthurOnlyCorrect = 0;
  let comparatorOnlyCorrect = 0;
  for (const item of cases) {
    const truth = labels.get(item.caseId) === "actionable_invalid";
    const arthurCorrect = (arthur.get(item.caseId) ?? false) === truth;
    const comparatorCorrect = (comparator.get(item.caseId) ?? false) === truth;
    if (arthurCorrect && !comparatorCorrect) arthurOnlyCorrect++;
    if (!arthurCorrect && comparatorCorrect) comparatorOnlyCorrect++;
  }
  const discordant = arthurOnlyCorrect + comparatorOnlyCorrect;
  if (discordant === 0) return { arthurOnlyCorrect, comparatorOnlyCorrect, exactMcNemarP: 1 };
  const tail = Math.min(arthurOnlyCorrect, comparatorOnlyCorrect);
  let cumulative = 0;
  for (let value = 0; value <= tail; value++) {
    cumulative += combination(discordant, value) * (0.5 ** discordant);
  }
  return {
    arthurOnlyCorrect,
    comparatorOnlyCorrect,
    exactMcNemarP: Math.min(1, 2 * cumulative),
  };
}

function reviewerAgreement(reviews: ReturnType<typeof resolveGroundTruth>["reviews"]): {
  rawAgreement: number | null;
  cohensKappa: number | null;
} {
  if (reviews.length !== 2 || reviews[0].labels.length === 0) {
    return { rawAgreement: null, cohensKappa: null };
  }
  const right = new Map(reviews[1].labels.map((item) => [item.caseId, item.label]));
  const labels: ReviewLabel[] = ["valid", "actionable_invalid", "ignored", "uncertain"];
  let agreements = 0;
  for (const item of reviews[0].labels) if (right.get(item.caseId) === item.label) agreements++;
  const total = reviews[0].labels.length;
  const observed = agreements / total;
  let expected = 0;
  for (const label of labels) {
    const leftRate = reviews[0].labels.filter((item) => item.label === label).length / total;
    const rightRate = reviews[1].labels.filter((item) => item.label === label).length / total;
    expected += leftRate * rightRate;
  }
  const kappa = expected === 1 ? 1 : (observed - expected) / (1 - expected);
  return { rawAgreement: observed, cohensKappa: kappa };
}

function percentile(values: number[], fraction: number): number | null {
  return values.length === 0 ? null : quantile(values, fraction);
}

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function formatMetric(value: number | null, interval: Interval | null): string {
  if (value === null) return "n/a";
  if (!interval) return formatPercent(value);
  return `${formatPercent(value)} (${formatPercent(interval.low)}–${formatPercent(interval.high)})`;
}

function renderReport(report: FieldReport): string {
  const lines: string[] = [];
  lines.push("# Arthur Preregistered Field Benchmark");
  lines.push("");
  lines.push(`Study: \`${report.studyId}\` · lock: \`${report.lockSha256}\``);
  lines.push("");
  lines.push(`Decision: **${report.decision.continueDevelopment ? "CONTINUE" : "FREEZE CHECKER EXPANSION"}**`);
  lines.push("");
  lines.push("## Cohort and review");
  lines.push("");
  lines.push(`- ${report.cohort.changes} consecutive included changes across ${report.cohort.repositories} repositories`);
  lines.push(`- ${report.cohort.cases} exhaustively inventoried supported references; ${report.cohort.exclusions} recorded exclusions`);
  lines.push(`- Reviewer agreement: ${formatPercent(report.review.rawAgreement)}; Cohen's kappa: ${report.review.cohensKappa?.toFixed(3) ?? "n/a"}`);
  lines.push(`- ${report.review.adjudicatedCases} cases required a third reviewer`);
  lines.push("");
  lines.push("## Accuracy");
  lines.push("");
  lines.push(`Comparator model: requested \`${report.comparator.requestedModel}\`; provider reported \`${report.comparator.model}\`.`);
  lines.push(`Comparator usage: ${report.comparator.inputTokens} input + ${report.comparator.outputTokens} output tokens; estimated $${report.comparator.estimatedCostUsd.toFixed(6)} USD using ${report.comparator.pricing.source}. Arthur API cost: $0.`);
  lines.push("");
  lines.push("| System | Precision (clustered 95% CI) | Recall (clustered 95% CI) | Specificity | TP | FP | FN | TN |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  lines.push(`| Arthur | ${formatMetric(report.arthur.precision, report.arthur.clustered95.precision)} | ${formatMetric(report.arthur.recall, report.arthur.clustered95.recall)} | ${formatPercent(report.arthur.specificity)} | ${report.arthur.counts.tp} | ${report.arthur.counts.fp} | ${report.arthur.counts.fn} | ${report.arthur.counts.tn} |`);
  lines.push(`| ${report.comparator.system} | ${formatMetric(report.comparator.precision, report.comparator.clustered95.precision)} | ${formatMetric(report.comparator.recall, report.comparator.clustered95.recall)} | ${formatPercent(report.comparator.specificity)} | ${report.comparator.counts.tp} | ${report.comparator.counts.fp} | ${report.comparator.counts.fn} | ${report.comparator.counts.tn} |`);
  lines.push("");
  lines.push(`Arthur latency: ${report.arthur.p50LatencyMs?.toFixed(1) ?? "n/a"} ms p50, ${report.arthur.p95LatencyMs?.toFixed(1) ?? "n/a"} ms p95.`);
  lines.push(`Latency clustered 95% intervals: p50 ${report.arthur.p50LatencyClustered95 ? `${report.arthur.p50LatencyClustered95.low.toFixed(1)}–${report.arthur.p50LatencyClustered95.high.toFixed(1)} ms` : "n/a"}; p95 ${report.arthur.p95LatencyClustered95 ? `${report.arthur.p95LatencyClustered95.low.toFixed(1)}–${report.arthur.p95LatencyClustered95.high.toFixed(1)} ms` : "n/a"}.`);
  lines.push(`Diff-level false-block rate: ${formatMetric(report.arthur.diffFalseBlockRate, report.arthur.diffFalseBlockRateClustered95)}.`);
  lines.push(`Paired accuracy difference (Arthur − comparator): ${formatMetric(report.paired.accuracyDifference, report.paired.accuracyDifferenceClustered95)}; descriptive exact McNemar p: ${report.paired.exactMcNemarP.toFixed(4)}.`);
  lines.push("");
  lines.push("### Per-domain counts");
  lines.push("");
  lines.push("| System | Domain | Precision | Recall | TP | FP | FN | TN |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|");
  for (const [system, score] of [
    ["Arthur", report.arthur],
    [report.comparator.system, report.comparator],
  ] as const) {
    for (const domain of ["imports", "env", "routes"] as const) {
      const counts = score.perDomain[domain];
      lines.push(`| ${system} | ${domain} | ${formatPercent(metric(counts.tp, counts.tp + counts.fp))} | ${formatPercent(metric(counts.tp, counts.tp + counts.fn))} | ${counts.tp} | ${counts.fp} | ${counts.fn} | ${counts.tn} |`);
    }
  }
  lines.push("");
  lines.push("## Incremental value and retention");
  lines.push("");
  lines.push(`- ${report.incremental.defectsCaughtByArthurOnly} actionable defect(s) caught by Arthur and missed by existing compiler/test/lint commands${report.incremental.arthurOnlyDefectsClustered95 ? ` (clustered 95% interval ${report.incremental.arthurOnlyDefectsClustered95.low.toFixed(1)}–${report.incremental.arthurOnlyDefectsClustered95.high.toFixed(1)})` : ""}`);
  lines.push(`- ${report.retention.keptEnabled} external developer(s) chose to keep the gate enabled before seeing aggregate results`);
  lines.push("");
  lines.push("## Fixed decision criteria");
  lines.push("");
  for (const [name, criterion] of Object.entries(report.decision.criteria)) {
    lines.push(`- ${criterion.passed ? "PASS" : "FAIL"} — ${name}: ${criterion.actual} (required ${criterion.required})`);
  }
  lines.push("");
  lines.push("## Interpretation");
  lines.push("");
  lines.push(report.interpretation);
  lines.push("");
  return lines.join("\n");
}

export function scoreFieldStudy(studyDir: string): FieldReport {
  const manifest = loadManifest(studyDir);
  assertStudyStatus(manifest, ["adjudicating"]);
  validateStudyDefinition(studyDir, manifest);
  const auditEvents = verifyAuditChain(studyDir);
  const auditedPaths = new Set(auditEvents.map((event) => event.artifactPath));
  const requireAudited = (absolutePath: string, label: string) => {
    const relative = path.relative(path.resolve(studyDir), absolutePath).replace(/\\/g, "/");
    if (!auditedPaths.has(relative)) throw new Error(`${label} was not submitted through the audited workflow.`);
  };
  if (!manifest.lockSha256) throw new Error("Study is missing its frozen lock hash.");
  const frozenDir = path.join(path.resolve(studyDir), "frozen");
  requireAudited(path.join(frozenDir, "lock.json"), "Frozen lock");
  const lock = readJson<StudyLock>(path.join(frozenDir, "lock.json"));
  if (sha256(stableJson(lock)) !== manifest.lockSha256) {
    throw new Error("Frozen study lock changed after collection.");
  }
  if (lock.studyPlanSha256 !== manifest.activation.studyPlanSha256) {
    throw new Error("Frozen lock points to a different study plan.");
  }
  const collectionLockPath = path.join(
    path.resolve(studyDir),
    "comparator",
    "collection-lock.json",
  );
  requireAudited(collectionLockPath, "Collection lock");
  const collectionLock = readJson<CollectionLock>(collectionLockPath);
  if (sha256(stableJson(collectionLock)) !== lock.collectionLockSha256) {
    throw new Error("Collection lock changed after freezing.");
  }
  if (sha256(stableJson(manifest.captures)) !== lock.captureIndexSha256) {
    throw new Error("Capture index changed after freezing.");
  }
  for (const capture of manifest.captures) {
    validateCaptureArtifacts(captureDir(studyDir, capture.changeId), capture.captureSha256);
  }
  const packetPath = path.join(frozenDir, "review-packets.jsonl");
  const packetText = fs.readFileSync(packetPath, "utf-8");
  if (sha256(packetText) !== lock.reviewPacketsSha256) {
    throw new Error("Blinded review packets changed after freezing.");
  }
  const packets = readJsonLines<ReviewPacket>(packetPath);
  const standardToolEvidence = readJson<StandardToolEvidence>(
    path.join(frozenDir, "standard-tool-evidence.json"),
  );
  if (sha256(stableJson(standardToolEvidence)) !== lock.standardToolEvidenceSha256) {
    throw new Error("Standard-tool evidence changed after freezing.");
  }
  const cases = readJson<ReferenceCase[]>(path.join(frozenDir, "cases.json"));
  if (packets.length !== cases.length) throw new Error("Review packet count differs from case inventory.");
  if (sha256(stableJson(cases)) !== lock.caseInventorySha256) {
    throw new Error("Case inventory changed after freezing.");
  }
  const arthurItems = readJson<CasePrediction[]>(path.join(frozenDir, "arthur-predictions.json"));
  const comparatorItems = readJson<ComparatorPrediction[]>(
    path.join(frozenDir, "comparator-predictions.json"),
  );
  if (sha256(stableJson(arthurItems)) !== lock.arthurPredictionsSha256) {
    throw new Error("Arthur predictions changed after freezing.");
  }
  if (sha256(stableJson(comparatorItems)) !== lock.comparatorPredictionsSha256) {
    throw new Error("Comparator predictions changed after freezing.");
  }
  const comparatorRun = readJson<ComparatorRun>(
    path.join(path.resolve(studyDir), "comparator", "predictions.json"),
  );
  requireAudited(
    path.join(path.resolve(studyDir), "comparator", "predictions.json"),
    "Comparator predictions",
  );
  if (sha256(stableJson(comparatorRun)) !== lock.comparatorRunSha256) {
    throw new Error("Comparator run metadata changed after freezing.");
  }
  const comparatorRunsRoot = path.join(path.resolve(studyDir), "comparator", "runs");
  for (const batch of comparatorRun.batches) {
    const target = path.resolve(studyDir, batch.artifactPath);
    if (!target.startsWith(`${comparatorRunsRoot}${path.sep}`) || !fs.existsSync(target)) {
      throw new Error(`Comparator batch is missing or outside its run directory: ${batch.artifactPath}`);
    }
    if (fs.realpathSync(target).startsWith(`${fs.realpathSync(comparatorRunsRoot)}${path.sep}`) === false) {
      throw new Error(`Comparator batch resolves outside its run directory: ${batch.artifactPath}`);
    }
    if (sha256(fs.readFileSync(target)) !== batch.artifactSha256) {
      throw new Error(`Comparator batch changed after freezing: ${batch.artifactPath}`);
    }
  }

  const truth = resolveGroundTruth(studyDir);
  for (const review of truth.reviews) {
    requireAudited(
      path.join(path.resolve(studyDir), "review", "submissions", `${review.reviewerId}.json`),
      `Review ${review.reviewerId}`,
    );
  }
  if (truth.disputedCaseIds.length > 0) {
    requireAudited(
      path.join(path.resolve(studyDir), "review", "adjudication.json"),
      "Adjudication",
    );
  }
  if (truth.labels.size !== cases.length) throw new Error("Resolved labels do not cover every case.");
  const arthurMap = new Map(arthurItems.map((item) => [item.caseId, item.outcome === "error"]));
  const comparatorMap = new Map(comparatorItems.map((item) => [item.caseId, item.predictedInvalid]));
  const arthurScore = scoreSystem(cases, truth.labels, arthurMap, `${manifest.lockSha256}:arthur`);
  const comparatorScore = scoreSystem(cases, truth.labels, comparatorMap, `${manifest.lockSha256}:comparator`);

  const baselinePath = path.join(path.resolve(studyDir), "review", "baseline.json");
  if (!fs.existsSync(baselinePath)) throw new Error("Standard-tool attribution has not been submitted.");
  requireAudited(baselinePath, "Standard-tool attribution");
  const baseline = readJson<BaselineSubmission>(baselinePath);
  const attributionByCase = new Map(baseline.attributions.map((item) => [item.caseId, item]));
  const positiveIds = [...truth.labels]
    .filter(([, label]) => label === "actionable_invalid")
    .map(([caseId]) => caseId);
  if (positiveIds.some((caseId) => !attributionByCase.has(caseId))) {
    throw new Error("Baseline attribution does not cover every actionable invalid case.");
  }
  const defectIds = new Set(baseline.attributions.map((item) => item.defectId));
  const defectsCaughtByArthur = new Set<string>();
  const defectsCaughtByStandardTools = new Set<string>();
  for (const item of baseline.attributions) {
    if (arthurMap.get(item.caseId)) defectsCaughtByArthur.add(item.defectId);
    if (item.caughtByStandardTools) defectsCaughtByStandardTools.add(item.defectId);
  }
  const arthurOnlyDefectIds = [...defectsCaughtByArthur]
    .filter((defectId) => !defectsCaughtByStandardTools.has(defectId))
    .sort();

  const latencies = manifest.captures.map((capture) => {
    const arthur = readJson<ArthurCapture>(
      path.join(captureDir(studyDir, capture.changeId), "arthur.json"),
    );
    return arthur.durationMs;
  });
  const falseBlockedChanges = manifest.captures.flatMap((capture) => {
    const changeCases = cases.filter((item) => item.changeId === capture.changeId);
    const predictedCases = changeCases.filter((item) => arthurMap.get(item.caseId));
    if (predictedCases.length === 0) return [];
    const hasTruePositive = predictedCases.some(
      (item) => truth.labels.get(item.caseId) === "actionable_invalid",
    );
    return hasTruePositive ? [] : [capture.changeId];
  });
  const changeClusters = manifest.captures.map((capture) => ({
    repositoryId: capture.repositoryId,
    changeId: capture.changeId,
  }));
  const latencyByChange = new Map(
    manifest.captures.map((capture, index) => [capture.changeId, latencies[index]]),
  );
  const falseBlockedSet = new Set(falseBlockedChanges);
  const p50LatencyClustered95 = clusteredChangeInterval(
    changeClusters,
    (sampled) => percentile(sampled.map((changeId) => latencyByChange.get(changeId)!), 0.5),
    `${manifest.lockSha256}:latency-p50`,
  );
  const p95LatencyClustered95 = clusteredChangeInterval(
    changeClusters,
    (sampled) => percentile(sampled.map((changeId) => latencyByChange.get(changeId)!), 0.95),
    `${manifest.lockSha256}:latency-p95`,
  );
  const diffFalseBlockRateClustered95 = clusteredChangeInterval(
    changeClusters,
    (sampled) => metric(sampled.filter((changeId) => falseBlockedSet.has(changeId)).length, sampled.length),
    `${manifest.lockSha256}:false-block-rate`,
  );
  const caseChange = new Map(cases.map((item) => [item.caseId, item.changeId]));
  const arthurOnlyDefectsByChange = new Map<string, number>();
  for (const defectId of arthurOnlyDefectIds) {
    const attribution = baseline.attributions.find((item) => item.defectId === defectId)!;
    const changeId = caseChange.get(attribution.caseId)!;
    arthurOnlyDefectsByChange.set(changeId, (arthurOnlyDefectsByChange.get(changeId) ?? 0) + 1);
  }
  const arthurOnlyDefectsClustered95 = clusteredChangeInterval(
    changeClusters,
    (sampled) => sampled.reduce(
      (sum, changeId) => sum + (arthurOnlyDefectsByChange.get(changeId) ?? 0),
      0,
    ),
    `${manifest.lockSha256}:incremental-defects`,
  );
  const casesByChange = new Map<string, ReferenceCase[]>();
  for (const item of cases) {
    const items = casesByChange.get(item.changeId) ?? [];
    items.push(item);
    casesByChange.set(item.changeId, items);
  }
  const accuracyDifference = arthurScore.accuracy === null || comparatorScore.accuracy === null
    ? null
    : arthurScore.accuracy - comparatorScore.accuracy;
  const accuracyDifferenceClustered95 = clusteredChangeInterval(
    changeClusters,
    (sampled) => {
      let total = 0;
      let arthurCorrect = 0;
      let comparatorCorrect = 0;
      for (const changeId of sampled) {
        for (const item of casesByChange.get(changeId) ?? []) {
          const expected = truth.labels.get(item.caseId) === "actionable_invalid";
          if ((arthurMap.get(item.caseId) ?? false) === expected) arthurCorrect++;
          if ((comparatorMap.get(item.caseId) ?? false) === expected) comparatorCorrect++;
          total++;
        }
      }
      return total === 0 ? null : (arthurCorrect - comparatorCorrect) / total;
    },
    `${manifest.lockSha256}:paired-accuracy-difference`,
  );

  const retentionDir = path.join(path.resolve(studyDir), "retention");
  const retention = fs.existsSync(retentionDir)
    ? fs.readdirSync(retentionDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson<RetentionDecision>(path.join(retentionDir, name)))
    : [];
  const eligibleRetention = retention.filter(
    (item) => item.externalToArthurImplementation && item.recordedBeforeAggregateResults,
  );
  for (const item of retention) {
    requireAudited(
      path.join(retentionDir, `${item.developerId}.json`),
      `Retention decision ${item.developerId}`,
    );
  }
  const keeping = eligibleRetention.filter((item) => item.keepEnabled);
  const repositories = new Set(manifest.captures.map((entry) => entry.repositoryId));
  const p95Latency = percentile(latencies, 0.95);
  const precisionValue = arthurScore.precision ?? 0;
  const criteria = {
    includedChanges: {
      passed: manifest.captures.length >= manifest.cohort.minimumIncludedChanges,
      actual: manifest.captures.length,
      required: `>= ${manifest.cohort.minimumIncludedChanges}`,
    },
    repositories: {
      passed: repositories.size >= manifest.cohort.minimumRepositories,
      actual: repositories.size,
      required: `>= ${manifest.cohort.minimumRepositories}`,
    },
    incrementalActionableDefects: {
      passed: arthurOnlyDefectIds.length >= manifest.decisionRules.minimumIncrementalActionableDefects,
      actual: arthurOnlyDefectIds.length,
      required: `>= ${manifest.decisionRules.minimumIncrementalActionableDefects}`,
    },
    blockingPrecision: {
      passed: precisionValue >= manifest.decisionRules.minimumBlockingPrecision,
      actual: precisionValue,
      required: `>= ${manifest.decisionRules.minimumBlockingPrecision}`,
    },
    p95LatencyMs: {
      passed: p95Latency !== null && p95Latency < manifest.decisionRules.maximumP95LatencyMs,
      actual: p95Latency ?? Number.POSITIVE_INFINITY,
      required: `< ${manifest.decisionRules.maximumP95LatencyMs}`,
    },
    externalDevelopersKeepingEnabled: {
      passed: keeping.length >= manifest.decisionRules.minimumExternalDevelopersKeepingEnabled,
      actual: keeping.length,
      required: `>= ${manifest.decisionRules.minimumExternalDevelopersKeepingEnabled}`,
    },
  };
  const continueDevelopment = Object.values(criteria).every((criterion) => criterion.passed);
  const agreement = reviewerAgreement(truth.reviews);
  const labelCounts = Object.fromEntries(
    ["valid", "actionable_invalid", "ignored"].map((label) => [
      label,
      [...truth.labels.values()].filter((value) => value === label).length,
    ]),
  );
  const completedAt = new Date().toISOString();
  const report: FieldReport = {
    studyId: manifest.studyId,
    completedAt,
    lockSha256: manifest.lockSha256,
    cohort: {
      changes: manifest.captures.length,
      repositories: repositories.size,
      cases: cases.length,
      exclusions: manifest.exclusions.length,
    },
    review: {
      reviewers: truth.reviews.map((item) => item.reviewerId),
      ...agreement,
      adjudicatedCases: truth.disputedCaseIds.length,
      labelCounts,
    },
    arthur: {
      ...arthurScore,
      p50LatencyMs: percentile(latencies, 0.5),
      p50LatencyClustered95,
      p95LatencyMs: p95Latency,
      p95LatencyClustered95,
      diffFalseBlockRate: metric(falseBlockedChanges.length, manifest.captures.length),
      diffFalseBlockRateClustered95,
      falseBlockedChanges,
    },
    comparator: {
      ...comparatorScore,
      system: comparatorRun.system,
      provider: comparatorRun.provider,
      model: comparatorRun.model,
      requestedModel: comparatorRun.requestedModel,
      inputTokens: comparatorRun.inputTokens,
      outputTokens: comparatorRun.outputTokens,
      pricing: comparatorRun.pricing,
      estimatedCostUsd: comparatorRun.estimatedCostUsd,
      durationMs: comparatorRun.durationMs,
    },
    paired: {
      ...pairedTest(cases, truth.labels, arthurMap, comparatorMap),
      accuracyDifference,
      accuracyDifferenceClustered95,
    },
    incremental: {
      actionableDefects: defectIds.size,
      defectsCaughtByArthur: defectsCaughtByArthur.size,
      defectsCaughtByStandardTools: defectsCaughtByStandardTools.size,
      defectsCaughtByArthurOnly: arthurOnlyDefectIds.length,
      arthurOnlyDefectIds,
      arthurOnlyDefectsClustered95,
    },
    retention: {
      eligibleDecisions: eligibleRetention.length,
      keptEnabled: keeping.length,
      developerIdsKeepingEnabled: keeping.map((item) => item.developerId).sort(),
    },
    decision: { continueDevelopment, criteria },
    interpretation: continueDevelopment
      ? "All preregistered continuation criteria passed. This supports continued validation-led development within the evaluated JavaScript/TypeScript reference domains; it does not justify claims outside them."
      : "One or more preregistered continuation criteria failed. Freeze checker expansion and publish the negative or inconclusive result without changing the threshold or cohort.",
  };

  writeJsonExclusive(path.join(path.resolve(studyDir), "REPORT.json"), report);
  writeTextExclusive(path.join(path.resolve(studyDir), "REPORT.md"), renderReport(report));
  recordAuditEvent(studyDir, "field_report_created", path.join(path.resolve(studyDir), "REPORT.json"));
  manifest.status = "complete";
  manifest.completedAt = completedAt;
  saveManifest(studyDir, manifest);
  return report;
}
