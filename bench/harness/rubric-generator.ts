import type { BenchmarkRun } from "./types.js";

/** Generate a markdown rubric template for Tier 2 human evaluation. */
export function generateRubric(run: BenchmarkRun): string {
  const hallucinatedList =
    run.tier1.pathAnalysis.hallucinatedPaths.length > 0
      ? run.tier1.pathAnalysis.hallucinatedPaths
          .map((p) => `  - \`${p}\``)
          .join("\n")
      : "  (none)";

  const detectedList =
    run.tier1.detections.filter((d) => d.detected).length > 0
      ? run.tier1.detections
          .filter((d) => d.detected)
          .map((d) => `  - \`${d.path}\` (${d.method})`)
          .join("\n")
      : "  (none)";

  return `# Tier 2 Evaluation: Prompt ${run.promptId}

## Metadata
- **Fixture:** ${run.fixture}
- **Task:** ${run.task}
- **Hallucination Rate:** ${(run.tier1.pathAnalysis.hallucinationRate * 100).toFixed(1)}%
- **Detection Rate:** ${(run.tier1.detectionRate * 100).toFixed(1)}%

## Tier 1 Summary

**Hallucinated paths:**
${hallucinatedList}

**Detected by verifier:**
${detectedList}

---

## Generated Plan (excerpt)

\`\`\`
${run.generatedPlan.slice(0, 3000)}${run.generatedPlan.length > 3000 ? "\n[...truncated]" : ""}
\`\`\`

---

## Verifier Output

\`\`\`
${run.verifierOutput}
\`\`\`

---

## Scoring (1-5, fill in each)

### 1. Missing Logic
Did the verifier catch missing steps, flows, or logic gaps?
- 1 = Missed everything
- 5 = Caught all significant gaps

**Score:** ___
**Notes:**

### 2. Wrong Assumptions
Did the verifier identify incorrect architecture or dependency assumptions?
- 1 = Missed all wrong assumptions
- 5 = Identified all incorrect assumptions

**Score:** ___
**Notes:**

### 3. Security Issues
Did the verifier flag security vulnerabilities or unsafe patterns?
- 1 = Missed critical security issues
- 5 = Thoroughly identified security concerns

**Score:** ___
**Notes:**

### 4. Completeness Gaps
Did the verifier note missing tests, error handling, or documentation?
- 1 = No completeness issues raised
- 5 = Comprehensively identified gaps

**Score:** ___
**Notes:**

### 5. Convention Violations
Did the verifier catch deviations from project patterns and conventions?
- 1 = Missed all convention issues
- 5 = Identified all convention violations

**Score:** ___
**Notes:**

### 6. Overall Quality
How actionable and useful was the verifier's feedback overall?
- 1 = Not useful at all
- 5 = Highly actionable, would improve the plan significantly

**Score:** ___
**Notes:**
`;
}
