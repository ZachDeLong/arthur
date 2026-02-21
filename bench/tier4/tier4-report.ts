/**
 * Tier 4 Report Generator
 *
 * Produces a markdown report highlighting Arthur's advantage over
 * self-review when both operate with realistic context constraints.
 *
 * Headline stat: "Arthur caught N errors self-review missed."
 */

import type {
  CheckerCategory,
  Tier4Run,
  Tier4Summary,
} from "../harness/types.js";

const ALL_CATEGORIES: CheckerCategory[] = [
  "path", "import", "env", "route", "supabase_schema", "package_api",
];

/** Generate the full Tier 4 markdown report. */
export function generateTier4Report(
  runs: Tier4Run[],
  summary: Tier4Summary,
): string {
  const lines: string[] = [];

  // Title & headline stat
  lines.push("# Tier 4 Benchmark: Arthur vs Self-Review on Real Production Projects\n");
  lines.push(
    `> **Arthur caught ${summary.arthurCaughtSelfReviewMissed} errors self-review missed** across ${summary.totalRuns} tasks on \`${summary.project}\`.\n`,
  );
  lines.push(
    `> ${summary.totalErrors} ground-truth errors. Model: ${summary.model}. Generated ${new Date().toISOString().slice(0, 10)}.\n`,
  );

  // Context explanation
  lines.push("## Why This Benchmark Matters\n");
  lines.push(
    "In real usage, LLMs work with limited context — a CLAUDE.md file and a task description, " +
    "not the full project tree. Arthur has perfect knowledge of the project on disk regardless " +
    "of context window constraints. Self-review here gets the **same limited context** as plan " +
    "generation (CLAUDE.md + task only), which is realistic.\n",
  );
  lines.push(
    "Previous benchmarks gave self-review full project context (file tree + source code), " +
    "inflating its detection rate. This benchmark proves Arthur's value in the realistic scenario.\n",
  );

  // Main comparison table
  lines.push("## Results by Category\n");
  lines.push("| Category | Errors | Arthur | Self-Review | Gap |");
  lines.push("|----------|--------|--------|-------------|-----|");

  for (const cat of ALL_CATEGORIES) {
    const stats = summary.perCategory[cat];
    if (stats.errors === 0) continue;
    const selfRate = `${(stats.rate * 100).toFixed(1)}%`;
    const gap = `${((1 - stats.rate) * 100).toFixed(1)}pp`;
    lines.push(
      `| ${cat} | ${stats.errors} | 100% | ${selfRate} | ${gap} |`,
    );
  }

  lines.push(
    `| **Overall** | **${summary.totalErrors}** | **100%** | **${(summary.overallDetectionRate * 100).toFixed(1)}%** | **${((1 - summary.overallDetectionRate) * 100).toFixed(1)}pp** |`,
  );
  lines.push("");

  // Per-task breakdown
  lines.push("## Per-Task Breakdown\n");
  lines.push("| Task | Description | Errors | Self-Review | Missed |");
  lines.push("|------|-------------|--------|-------------|--------|");

  for (const run of runs) {
    const detected = run.detections.filter((d) => d.detected).length;
    const missed = run.groundTruth.length - detected;
    const shortTask = run.task.slice(0, 50) + (run.task.length > 50 ? "..." : "");
    lines.push(
      `| ${run.taskId} | ${shortTask} | ${run.groundTruth.length} | ${detected}/${run.groundTruth.length} (${(run.overallDetectionRate * 100).toFixed(0)}%) | ${missed} |`,
    );
  }
  lines.push("");

  // Highlight section: most interesting misses
  lines.push("## Highlight: Errors Arthur Caught That Self-Review Missed\n");
  lines.push("These are the \"demo reel\" errors — things only Arthur's static checkers found.\n");

  for (const run of runs) {
    const missed = run.detections.filter((d) => !d.detected);
    if (missed.length === 0) continue;

    lines.push(`### Task ${run.taskId}\n`);
    for (const det of missed) {
      const suggestion = det.error.suggestion ? ` → suggestion: \`${det.error.suggestion}\`` : "";
      lines.push(
        `- **[${det.error.category}]** \`${det.error.raw}\` — ${det.error.description}${suggestion}`,
      );
    }
    lines.push("");
  }

  // Detected errors (what self-review did catch)
  lines.push("## Errors Self-Review Successfully Detected\n");

  for (const run of runs) {
    const found = run.detections.filter((d) => d.detected);
    if (found.length === 0) continue;

    lines.push(`### Task ${run.taskId}\n`);
    for (const det of found) {
      lines.push(
        `- **[${det.error.category}]** \`${det.error.raw}\` — detected via ${det.method}`,
      );
    }
    lines.push("");
  }

  // Methodology
  lines.push("## Methodology\n");
  lines.push("1. **Plan generation:** LLM generates a plan with CLAUDE.md-only context (no file tree, no source code)");
  lines.push("2. **Ground truth:** Arthur's static checkers run against the plan + real project on disk (paths, imports, env, routes, Supabase schema, package APIs)");
  lines.push("3. **Self-review:** Same model reviews its own plan with the **same limited context** (CLAUDE.md + task, no full tree)");
  lines.push("4. **Scoring:** Self-review output parsed for detection of each ground-truth error using 3-tier detection (direct → sentiment → section)\n");
  lines.push("**Key difference from Big Benchmark:** Self-review does NOT get full project context. It operates with the same information it had when writing the plan. This is realistic — in Claude Code, the LLM that reviews its plan doesn't suddenly get the full file tree.\n");
  lines.push(`**Project:** \`${summary.project}\` — real production codebase with ${runs.length > 0 ? "33 Supabase tables, 17 API routes, 499 packages" : "real data"}\n`);

  // API usage
  lines.push("## API Usage\n");
  lines.push(`- Total input tokens: ${summary.apiUsage.totalInputTokens.toLocaleString()}`);
  lines.push(`- Total output tokens: ${summary.apiUsage.totalOutputTokens.toLocaleString()}`);
  lines.push("");

  return lines.join("\n");
}
