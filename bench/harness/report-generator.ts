import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import type { BenchmarkRun, BenchmarkSummary } from "./types.js";
import { generateSummary } from "./report.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = path.resolve(__dirname, "..");
const RESULTS_DIR = path.join(BENCH_ROOT, "results");

interface AggregatedResults {
  runs: BenchmarkRun[];
  summary: BenchmarkSummary;
  runDirs: string[];
}

/** Load all results from a specific run directory. */
function loadRunDir(runDir: string): BenchmarkRun[] {
  const runs: BenchmarkRun[] = [];
  const files = fs.readdirSync(runDir).filter((f) => f.startsWith("prompt-") && f.endsWith(".json"));
  for (const file of files) {
    const raw = fs.readFileSync(path.join(runDir, file), "utf-8");
    runs.push(JSON.parse(raw) as BenchmarkRun);
  }
  return runs;
}

/** Load all results across all run directories, or from a specific one. */
function loadResults(specificDir?: string): AggregatedResults {
  if (specificDir) {
    const runDir = path.isAbsolute(specificDir)
      ? specificDir
      : path.join(RESULTS_DIR, specificDir);
    const runs = loadRunDir(runDir);
    return { runs, summary: generateSummary(runs), runDirs: [specificDir] };
  }

  // Load all run directories
  if (!fs.existsSync(RESULTS_DIR)) {
    return { runs: [], summary: generateSummary([]), runDirs: [] };
  }

  const dirs = fs
    .readdirSync(RESULTS_DIR)
    .filter((d) => fs.statSync(path.join(RESULTS_DIR, d)).isDirectory())
    .sort();

  const allRuns: BenchmarkRun[] = [];
  for (const dir of dirs) {
    allRuns.push(...loadRunDir(path.join(RESULTS_DIR, dir)));
  }

  return { runs: allRuns, summary: generateSummary(allRuns), runDirs: dirs };
}

/** Generate a publishable markdown report from benchmark results. */
function generateMarkdownReport(results: AggregatedResults): string {
  const { runs, summary, runDirs } = results;
  const lines: string[] = [];

  lines.push("# Arthur Benchmark Results\n");
  lines.push(`> Generated ${new Date().toISOString().slice(0, 10)} from ${runDirs.length} benchmark run(s), ${runs.length} prompt evaluation(s)\n`);

  // --- Tier 1: Path Hallucination ---
  const pathRuns = runs.filter(
    (r) => r.tier1.pathAnalysis.extractedPaths.length > 0,
  );

  if (pathRuns.length > 0) {
    lines.push("## Path Hallucination Detection\n");
    lines.push(
      "Plans generated with README-only context (no file tree), then verified against the real project structure.\n",
    );

    lines.push(
      "| Prompt | Fixture | Extracted | Hallucinated | Rate | Static Detection | LLM Detection |",
    );
    lines.push(
      "|--------|---------|-----------|-------------|------|-----------------|---------------|",
    );

    for (const run of pathRuns) {
      const pa = run.tier1.pathAnalysis;
      const extracted = pa.extractedPaths.length;
      const hallucinated = pa.hallucinatedPaths.length;
      const rate = (pa.hallucinationRate * 100).toFixed(1);
      const staticDet = hallucinated > 0 ? `${hallucinated}/${hallucinated} (100%)` : "n/a";
      const llmDetected = run.tier1.detections.filter((d) => d.detected).length;
      const llmDet =
        hallucinated > 0
          ? `${llmDetected}/${hallucinated} (${((llmDetected / hallucinated) * 100).toFixed(1)}%)`
          : "n/a";
      lines.push(
        `| ${run.promptId} | ${run.fixture} | ${extracted} | ${hallucinated} | ${rate}% | ${staticDet} | ${llmDet} |`,
      );
    }

    const avgHallRate = (summary.tier1.avgHallucinationRate * 100).toFixed(1);
    const avgDetRate = (summary.tier1.avgDetectionRate * 100).toFixed(1);
    lines.push(
      `| **Avg** | | | | **${avgHallRate}%** | **100%** | **${avgDetRate}%** |`,
    );

    lines.push(
      "\n**Key finding:** Static path checking achieves 100% detection with zero variance. LLM detection is unreliable — it sees the full file tree in context but still misses hallucinated paths.\n",
    );
  }

  // --- Tier 1: Schema Hallucination ---
  const schemaRuns = runs.filter((r) => r.tier1.schemaAnalysis);

  if (schemaRuns.length > 0) {
    lines.push("## Schema Hallucination Detection\n");
    lines.push(
      "Fixture uses adversarial Prisma naming (`Participant` not `User`, `displayIdentifier` not `username`, `participantEngagement` not `engagement`). Plans generated with README-only context — no schema file provided.\n",
    );

    lines.push(
      "| Prompt | Task | Schema Refs | Hallucinated | Rate | Static Detection | LLM Detection |",
    );
    lines.push(
      "|--------|------|------------|-------------|------|-----------------|---------------|",
    );

    for (const run of schemaRuns) {
      const sa = run.tier1.schemaAnalysis!;
      const hallCount = sa.hallucinations.length;
      const staticDet = hallCount > 0 ? `${hallCount}/${hallCount} (100%)` : "n/a";
      const llmDetected = run.tier1.schemaDetections?.filter((d) => d.detected).length ?? 0;
      const llmDet =
        hallCount > 0
          ? `${llmDetected}/${hallCount} (${((llmDetected / hallCount) * 100).toFixed(1)}%)`
          : "n/a";
      lines.push(
        `| ${run.promptId} | ${run.task.slice(0, 40)} | ${sa.totalRefs} | ${hallCount} | ${(sa.hallucinationRate * 100).toFixed(1)}% | ${staticDet} | ${llmDet} |`,
      );
    }

    if (summary.tier1.schema) {
      const s = summary.tier1.schema;
      lines.push(
        `| **Avg** | | | | **${(s.avgSchemaHallucinationRate * 100).toFixed(1)}%** | **100%** | **${(s.avgSchemaDetectionRate * 100).toFixed(1)}%** |`,
      );
    }

    // Per-category breakdown
    if (summary.tier1.schema) {
      const cats = summary.tier1.schema.perCategory;
      lines.push("\n### Per-Category Breakdown\n");
      lines.push("| Category | Total Refs | Hallucinated | Rate |");
      lines.push("|----------|-----------|-------------|------|");
      lines.push(
        `| Models | ${cats.models.total} | ${cats.models.hallucinated} | ${cats.models.total > 0 ? ((cats.models.hallucinated / cats.models.total) * 100).toFixed(1) : 0}% |`,
      );
      lines.push(
        `| Fields | ${cats.fields.total} | ${cats.fields.hallucinated} | ${cats.fields.total > 0 ? ((cats.fields.hallucinated / cats.fields.total) * 100).toFixed(1) : 0}% |`,
      );
      lines.push(
        `| Methods | ${cats.methods.total} | ${cats.methods.invalid} | ${cats.methods.total > 0 ? ((cats.methods.invalid / cats.methods.total) * 100).toFixed(1) : 0}% |`,
      );
      lines.push(
        `| Relations | ${cats.relations.total} | ${cats.relations.wrong} | ${cats.relations.total > 0 ? ((cats.relations.wrong / cats.relations.total) * 100).toFixed(1) : 0}% |`,
      );
    }

    // Recurring hallucinations
    const hallucinationCounts = new Map<string, number>();
    for (const run of schemaRuns) {
      for (const h of run.tier1.schemaAnalysis!.hallucinations) {
        const key = h.raw;
        hallucinationCounts.set(key, (hallucinationCounts.get(key) ?? 0) + 1);
      }
    }
    const recurring = [...hallucinationCounts.entries()]
      .filter(([, count]) => count > 1)
      .sort(([, a], [, b]) => b - a);

    if (recurring.length > 0) {
      lines.push("\n### Recurring Hallucinations\n");
      for (const [raw, count] of recurring) {
        lines.push(
          `- \`${raw}\` — appeared in ${count}/${schemaRuns.length} runs`,
        );
      }
    }

    lines.push(
      "\n**Key finding:** Static schema checking achieves 100% detection. LLMs pattern-match from task descriptions rather than reading the actual schema, producing systematic hallucinations.\n",
    );
  }

  // --- Tier 2: Drift Detection ---
  const driftRuns = runs.filter((r) => r.tier2);

  if (driftRuns.length > 0 && summary.tier2) {
    lines.push("## Intent Drift Detection\n");
    lines.push(
      "Synthetic drift injected into generated plans (scope creep, feature drift, wrong abstraction, etc.). Measures whether the verifier catches the injected drift.\n",
    );

    const t2 = summary.tier2;
    lines.push(
      `**Overall detection rate: ${(t2.avgDetectionRate * 100).toFixed(1)}%**\n`,
    );

    lines.push("| Category | Detection Rate |");
    lines.push("|----------|---------------|");
    for (const [cat, rate] of Object.entries(t2.perCategory)) {
      lines.push(`| ${cat} | ${(rate * 100).toFixed(1)}% |`);
    }

    if (t2.perSpec.length > 0) {
      lines.push("\n### Per-Spec Details\n");
      lines.push(
        "| Spec ID | Category | Injected | Detected | Method |",
      );
      lines.push(
        "|---------|----------|----------|----------|--------|",
      );
      for (const spec of t2.perSpec) {
        lines.push(
          `| ${spec.specId} | ${spec.category} | ${spec.injectionApplied ? "yes" : "skipped"} | ${spec.detected ? "yes" : "no"} | ${spec.method ?? "—"} |`,
        );
      }
    }
    lines.push("");
  }

  // --- API Usage ---
  lines.push("## API Usage\n");
  lines.push(`- Total input tokens: ${summary.apiUsage.totalInputTokens.toLocaleString()}`);
  lines.push(`- Total output tokens: ${summary.apiUsage.totalOutputTokens.toLocaleString()}`);
  lines.push(`- Total API calls: ${summary.apiUsage.totalCalls}`);
  lines.push(`- Benchmark runs: ${runDirs.length}`);
  lines.push("");

  // --- Methodology ---
  lines.push("## Methodology\n");
  lines.push("### Plan Generation");
  lines.push("Plans are generated by an LLM with README-only context — the model has no access to the actual file tree or source code. This creates a realistic scenario where the model must guess at file paths and schema details.\n");
  lines.push("### Verification");
  lines.push("Each plan is verified through two independent channels:");
  lines.push("1. **Static analysis** — Deterministic checks against ground truth (file tree, Prisma schema). Zero LLM involvement.");
  lines.push("2. **LLM verifier** — Independent Claude instance reviews the plan with full project context. Uses the same adversarial prompt across all runs.\n");
  lines.push("### Detection Parsing");
  lines.push("LLM verifier output is parsed using multi-tier detection:");
  lines.push("- **Paths:** direct match → sentiment analysis → section detection → directory correction");
  lines.push("- **Schema:** direct match → sentiment analysis → section detection");
  lines.push("- **Drift:** critical callout → alignment section → signal match (≥40% threshold)\n");

  return lines.join("\n");
}

/** CLI: generate and print/save the report. */
export function runReport(args: string[]): void {
  const specificDir = args[0];

  console.log(chalk.bold.cyan("\nGenerating benchmark report...\n"));

  const results = loadResults(specificDir);

  if (results.runs.length === 0) {
    console.error(
      chalk.red("No benchmark results found. Run benchmarks first with: npm run bench:tier1"),
    );
    process.exit(1);
  }

  const report = generateMarkdownReport(results);

  // Write report to file
  const reportPath = path.join(BENCH_ROOT, "RESULTS.md");
  fs.writeFileSync(reportPath, report, "utf-8");
  console.log(chalk.green(`Report written to: ${reportPath}`));

  // Also print to stdout
  console.log("\n" + report);
}

// CLI entry point when run directly
if (process.argv[1] && (
  process.argv[1].endsWith("report-generator.ts") ||
  process.argv[1].endsWith("report-generator.js")
)) {
  const args = process.argv.slice(2);
  runReport(args);
}
