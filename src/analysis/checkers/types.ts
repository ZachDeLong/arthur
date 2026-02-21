import { registerChecker, type CheckerResult } from "../registry.js";
import { analyzeTypes, type TypeAnalysis } from "../type-checker.js";

registerChecker({
  id: "types",
  displayName: "TypeScript Types",
  catchKey: "types",
  experimental: true,

  run(planText, projectDir): CheckerResult {
    const analysis = analyzeTypes(planText, projectDir);
    return {
      checkerId: "types",
      checked: analysis.checkedRefs,
      hallucinated: analysis.hallucinations.length,
      hallucinations: analysis.hallucinations.map(h => ({
        raw: h.raw,
        category: h.hallucinationCategory ?? "unknown",
        suggestion: h.suggestion,
      })),
      catchItems: analysis.hallucinations.map(h => h.raw),
      applicable: analysis.checkedRefs > 0,
      rawAnalysis: analysis,
    };
  },

  formatForCheckAll(result): string[] {
    if (!result.applicable) return [];
    const analysis = result.rawAnalysis as TypeAnalysis;
    const typeIssues = analysis.hallucinations.length;
    const lines: string[] = [];

    lines.push(`## TypeScript Types`);
    lines.push(`**${analysis.checkedRefs}** checked — **${typeIssues}** hallucinated`);
    if (typeIssues > 0) {
      for (const h of analysis.hallucinations) {
        const category = h.hallucinationCategory === "hallucinated-type" ? "not found" : "member not found";
        const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
        lines.push(`- \`${h.raw}\` — ${category}${suggestion}`);
      }
    } else {
      lines.push(`All type refs valid.`);
    }
    lines.push(``);
    return lines;
  },

  formatForFindings(result): string | undefined {
    if (!result.applicable) return undefined;
    const analysis = result.rawAnalysis as TypeAnalysis;
    if (analysis.hallucinations.length === 0) return undefined;

    const lines = [
      `### TypeScript Type Issues`,
      ``,
      `Static analysis found ${analysis.hallucinations.length} TypeScript type hallucination(s):`,
      ``,
    ];
    for (const h of analysis.hallucinations) {
      const category = h.hallucinationCategory === "hallucinated-type" ? "type not found" : "member not found";
      const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
      lines.push(`- \`${h.raw}\` — ${category}${suggestion}`);
    }
    return lines.join("\n");
  },
});
