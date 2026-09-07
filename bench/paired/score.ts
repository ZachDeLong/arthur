import fs from "node:fs";
import path from "node:path";
import type {
  PairedCase,
  PairedCategory,
  PairedLabel,
  PairedPrediction,
  PredictionRun,
} from "./types.js";

interface Counts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  exact: number;
  total: number;
}
export interface ScoredRun {
  system: string;
  repetition: number;
  counts: Counts;
  metrics: ReturnType<typeof metrics>;
  perCategory: Record<PairedCategory, ReturnType<typeof metrics>>;
  mismatches: Array<{
    id: string;
    category: PairedCategory;
    expected: string;
    actual: string;
    source: string;
    reason: string;
    oracle: string;
  }>;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

function safeDivide(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function wilson(successes: number, total: number): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 1 };
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function metrics(counts: Counts) {
  const precision = safeDivide(counts.tp, counts.tp + counts.fp);
  const recall = safeDivide(counts.tp, counts.tp + counts.fn);
  const specificity = safeDivide(counts.tn, counts.tn + counts.fp);
  const accuracy = safeDivide(counts.tp + counts.tn, counts.total);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    precision,
    precision95: wilson(counts.tp, counts.tp + counts.fp),
    recall,
    recall95: wilson(counts.tp, counts.tp + counts.fn),
    specificity,
    specificity95: wilson(counts.tn, counts.tn + counts.fp),
    binaryAccuracy: accuracy,
    exactOutcomeAccuracy: safeDivide(counts.exact, counts.total),
    f1,
    counts,
  };
}

function count(
  ids: string[],
  labels: Map<string, PairedLabel>,
  predictions: Map<string, PairedPrediction>,
): Counts {
  const counts: Counts = { tp: 0, fp: 0, fn: 0, tn: 0, exact: 0, total: ids.length };
  for (const id of ids) {
    const expected = labels.get(id)!;
    const actual = predictions.get(id)!;
    const expectedError = expected.expected === "error";
    const predictedError = actual.outcome === "error";
    if (expectedError && predictedError) counts.tp++;
    else if (!expectedError && predictedError) counts.fp++;
    else if (expectedError) counts.fn++;
    else counts.tn++;
    if (expected.expected === actual.outcome) counts.exact++;
  }
  return counts;
}

export function scoreRun(
  cases: PairedCase[],
  labelsInput: PairedLabel[],
  run: PredictionRun,
): ScoredRun {
  if (run.predictions.length !== cases.length) {
    throw new Error(`${run.system} repetition ${run.repetition} returned ${run.predictions.length}/${cases.length} predictions.`);
  }
  const labels = new Map(labelsInput.map((label) => [label.id, label]));
  const predictions = new Map(run.predictions.map((prediction) => [prediction.id, prediction]));
  if (predictions.size !== run.predictions.length) throw new Error("Prediction run contains duplicate ids.");
  const ids = cases.map((testCase) => testCase.id);
  const unknown = [...predictions.keys()].filter((id) => !labels.has(id));
  const missing = ids.filter((id) => !predictions.has(id));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(`Prediction id mismatch: ${unknown.length} unknown, ${missing.length} missing.`);
  }

  const allCounts = count(ids, labels, predictions);
  const perCategory = {} as Record<PairedCategory, ReturnType<typeof metrics>>;
  for (const category of ["import", "env", "route"] as const) {
    const categoryIds = cases.filter((testCase) => testCase.category === category).map((testCase) => testCase.id);
    perCategory[category] = metrics(count(categoryIds, labels, predictions));
  }

  const mismatches = cases.flatMap((testCase) => {
    const expected = labels.get(testCase.id)!;
    const actual = predictions.get(testCase.id)!;
    if (expected.expected === actual.outcome) return [];
    return [{
      id: testCase.id,
      category: testCase.category,
      expected: expected.expected,
      actual: actual.outcome,
      source: testCase.source,
      reason: actual.reason,
      oracle: expected.oracle,
    }];
  });

  return {
    system: run.system,
    repetition: run.repetition,
    counts: allCounts,
    metrics: metrics(allCounts),
    perCategory,
    mismatches,
    durationMs: run.durationMs,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
  };
}

function combination(n: number, k: number): number {
  const smaller = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= smaller; i++) result = (result * (n - smaller + i)) / i;
  return result;
}

/** Exact two-sided McNemar/binomial test over paired correctness. */
export function pairedExactTest(
  cases: PairedCase[],
  labels: PairedLabel[],
  left: PredictionRun,
  right: PredictionRun,
): { leftOnlyCorrect: number; rightOnlyCorrect: number; pValue: number } {
  const labelMap = new Map(labels.map((label) => [label.id, label.expected]));
  const leftMap = new Map(left.predictions.map((prediction) => [prediction.id, prediction.outcome]));
  const rightMap = new Map(right.predictions.map((prediction) => [prediction.id, prediction.outcome]));
  let leftOnlyCorrect = 0;
  let rightOnlyCorrect = 0;
  for (const testCase of cases) {
    const expected = labelMap.get(testCase.id);
    const leftCorrect = leftMap.get(testCase.id) === expected;
    const rightCorrect = rightMap.get(testCase.id) === expected;
    if (leftCorrect && !rightCorrect) leftOnlyCorrect++;
    if (!leftCorrect && rightCorrect) rightOnlyCorrect++;
  }
  const discordant = leftOnlyCorrect + rightOnlyCorrect;
  if (discordant === 0) return { leftOnlyCorrect, rightOnlyCorrect, pValue: 1 };
  const tail = Math.min(leftOnlyCorrect, rightOnlyCorrect);
  let cumulative = 0;
  for (let k = 0; k <= tail; k++) cumulative += combination(discordant, k) * (0.5 ** discordant);
  return { leftOnlyCorrect, rightOnlyCorrect, pValue: Math.min(1, 2 * cumulative) };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function interval(metric: number, ci: { low: number; high: number }): string {
  return `${percent(metric)} (${percent(ci.low)}–${percent(ci.high)})`;
}

export function renderReport(input: {
  cases: PairedCase[];
  labels: PairedLabel[];
  corpusSha256: string;
  scores: ScoredRun[];
  runs: PredictionRun[];
}): string {
  const lines: string[] = [];
  lines.push("# Paired Reference-Integrity Benchmark\n");
  lines.push(`> Locked corpus: \`${input.corpusSha256}\` · ${input.cases.length} cases · labels fixed before prediction.\n`);
  lines.push("This benchmark scores Arthur and Claude against the same mechanically derived labels. Arthur does not define the candidate set, and Claude never receives the label file.\n");
  lines.push("## Results\n");
  lines.push("| System | Run | Precision (95% CI) | Recall (95% CI) | Specificity (95% CI) | Exact 3-way accuracy | Time |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const score of input.scores) {
    lines.push(`| ${score.system} | ${score.repetition} | ${interval(score.metrics.precision, score.metrics.precision95)} | ${interval(score.metrics.recall, score.metrics.recall95)} | ${interval(score.metrics.specificity, score.metrics.specificity95)} | ${percent(score.metrics.exactOutcomeAccuracy)} | ${(score.durationMs / 1000).toFixed(2)}s |`);
  }
  lines.push("");

  const arthurRun = input.runs.find((run) => run.system === "arthur");
  const claudeRuns = input.runs.filter((run) => run.system !== "arthur");
  if (arthurRun && claudeRuns.length > 0) {
    lines.push("## Paired Tests\n");
    lines.push("| Claude run | Arthur-only correct | Claude-only correct | Exact McNemar p |");
    lines.push("|---:|---:|---:|---:|");
    for (const run of claudeRuns) {
      const paired = pairedExactTest(input.cases, input.labels, arthurRun, run);
      lines.push(`| ${run.repetition} | ${paired.leftOnlyCorrect} | ${paired.rightOnlyCorrect} | ${paired.pValue.toFixed(4)} |`);
    }
    lines.push("");
  }

  lines.push("## Per-Category Exact Accuracy\n");
  lines.push("| System | Run | Imports | Env | Routes |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const score of input.scores) {
    lines.push(`| ${score.system} | ${score.repetition} | ${percent(score.perCategory.import.exactOutcomeAccuracy)} | ${percent(score.perCategory.env.exactOutcomeAccuracy)} | ${percent(score.perCategory.route.exactOutcomeAccuracy)} |`);
  }
  lines.push("");

  lines.push("## Mismatches\n");
  for (const score of input.scores) {
    lines.push(`### ${score.system}, run ${score.repetition}\n`);
    if (score.mismatches.length === 0) {
      lines.push("No mismatches.\n");
      continue;
    }
    for (const mismatch of score.mismatches) {
      lines.push(`- \`${mismatch.id}\` [${mismatch.category}] expected **${mismatch.expected}**, got **${mismatch.actual}** — \`${mismatch.source}\``);
      lines.push(`  - Prediction: ${mismatch.reason}`);
      lines.push(`  - Oracle: ${mismatch.oracle}`);
    }
    lines.push("");
  }

  lines.push("## Scope and Limits\n");
  lines.push("- Cases are deterministic single-reference mutations, not a sample of all real AI coding failures.");
  lines.push("- Selection is exhaustive within the declared package/env/route artifacts, which reduces cherry-picking but does not provide external validity.");
  lines.push("- Confidence intervals describe this locked corpus only.");
  lines.push("- Public product claims still require blinded human adjudication of real agent-authored diffs across multiple external repositories.\n");

  const inputTokens = input.runs.reduce((sum, run) => sum + (run.inputTokens ?? 0), 0);
  const outputTokens = input.runs.reduce((sum, run) => sum + (run.outputTokens ?? 0), 0);
  if (inputTokens > 0 || outputTokens > 0) {
    lines.push("## API Usage\n");
    lines.push(`- Input tokens: ${inputTokens.toLocaleString()}`);
    lines.push(`- Output tokens: ${outputTokens.toLocaleString()}\n`);
  }
  return lines.join("\n");
}

export function writeScoredArtifacts(input: {
  outputDir: string;
  cases: PairedCase[];
  labels: PairedLabel[];
  corpusSha256: string;
  runs: PredictionRun[];
}): { scores: ScoredRun[]; reportPath: string } {
  const scores = input.runs.map((run) => scoreRun(input.cases, input.labels, run));
  fs.mkdirSync(input.outputDir, { recursive: true });
  fs.writeFileSync(path.join(input.outputDir, "scores.json"), `${JSON.stringify(scores, null, 2)}\n`, "utf-8");
  const reportPath = path.join(input.outputDir, "REPORT.md");
  fs.writeFileSync(reportPath, renderReport({ ...input, scores }), "utf-8");
  return { scores, reportPath };
}
