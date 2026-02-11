import fs from "node:fs";
import path from "node:path";
import type { Tier2Result, Tier2Scores, BenchmarkSummary } from "./types.js";

/** Parse a filled-in rubric markdown file and extract scores. */
export function parseRubric(rubricContent: string): Tier2Result | null {
  // Extract prompt ID from header
  const idMatch = rubricContent.match(
    /# Tier 2 Evaluation: Prompt (\d+)/,
  );
  if (!idMatch) return null;
  const promptId = idMatch[1];

  // Only parse the scoring section (after "## Scoring") to avoid
  // matching ### headings inside verifier output code blocks
  const scoringSectionStart = rubricContent.indexOf("## Scoring");
  const scoringSection =
    scoringSectionStart !== -1
      ? rubricContent.slice(scoringSectionStart)
      : rubricContent;

  const scorePattern = /### \d+\. (\w[\w\s]*)\n[\s\S]*?\*\*Score:\*\*\s*(\d)/g;
  const scores: Record<string, number> = {};
  const notes: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = scorePattern.exec(scoringSection)) !== null) {
    const label = match[1].trim();
    const score = parseInt(match[2], 10);

    // Map section titles to score keys
    const keyMap: Record<string, keyof Tier2Scores> = {
      "Missing Logic": "missingLogic",
      "Wrong Assumptions": "wrongAssumptions",
      "Security Issues": "securityIssues",
      "Completeness Gaps": "completenessGaps",
      "Convention Violations": "conventionViolations",
      "Overall Quality": "overallQuality",
    };

    const key = keyMap[label];
    if (key && score >= 1 && score <= 5) {
      scores[key] = score;
    }
  }

  // Extract notes after each **Notes:** marker
  const notesPattern = /\*\*Notes:\*\*\s*([\s\S]*?)(?=\n###|\n---|\n$|$)/g;
  while ((match = notesPattern.exec(scoringSection)) !== null) {
    const note = match[1].trim();
    if (note && note !== "___") {
      notes.push(note);
    }
  }

  // Validate we got all 6 scores
  const requiredKeys: (keyof Tier2Scores)[] = [
    "missingLogic",
    "wrongAssumptions",
    "securityIssues",
    "completenessGaps",
    "conventionViolations",
    "overallQuality",
  ];

  for (const key of requiredKeys) {
    if (!(key in scores)) return null;
  }

  return {
    promptId,
    scores: scores as unknown as Tier2Scores,
    notes: notes.join("\n\n"),
  };
}

/** Parse all rubric files in a run directory and merge into summary. */
export function scoreTier2(runDir: string): Tier2Result[] {
  const results: Tier2Result[] = [];

  const files = fs.readdirSync(runDir).filter((f) => f.endsWith("-rubric.md"));
  for (const file of files) {
    const content = fs.readFileSync(path.join(runDir, file), "utf-8");
    const result = parseRubric(content);
    if (result) {
      results.push(result);
    }
  }

  return results;
}

/** Merge Tier 2 results into an existing summary. */
export function mergeTier2IntoSummary(
  summary: BenchmarkSummary,
  tier2Results: Tier2Result[],
): BenchmarkSummary {
  if (tier2Results.length === 0) return summary;

  const avgScores: Tier2Scores = {
    missingLogic: 0,
    wrongAssumptions: 0,
    securityIssues: 0,
    completenessGaps: 0,
    conventionViolations: 0,
    overallQuality: 0,
  };

  for (const result of tier2Results) {
    for (const key of Object.keys(avgScores) as (keyof Tier2Scores)[]) {
      avgScores[key] += result.scores[key];
    }
  }

  for (const key of Object.keys(avgScores) as (keyof Tier2Scores)[]) {
    avgScores[key] = Number((avgScores[key] / tier2Results.length).toFixed(2));
  }

  return {
    ...summary,
    tier2: {
      avgScores,
      perRun: tier2Results.map((r) => ({
        promptId: r.promptId,
        scores: r.scores,
      })),
    },
  };
}
