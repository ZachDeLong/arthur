import { registerChecker, type CheckerResult } from "../registry.js";
import { analyzePackageApi, type PackageApiAnalysis } from "../package-api-checker.js";

registerChecker({
  id: "packageApi",
  displayName: "Package API",
  catchKey: "packageApi",
  experimental: true,

  run(planText, projectDir): CheckerResult {
    const analysis = analyzePackageApi(planText, projectDir);
    return {
      checkerId: "packageApi",
      checked: analysis.checkedBindings + analysis.checkedMembers,
      hallucinated: analysis.hallucinations.length,
      hallucinations: analysis.hallucinations.map(h => ({
        raw: h.raw,
        category: h.category,
        suggestion: h.suggestion,
      })),
      catchItems: analysis.hallucinations.map(h => h.raw),
      applicable: analysis.applicable,
      rawAnalysis: analysis,
    };
  },

  formatForCheckAll(result): string[] {
    if (!result.applicable) return [];
    const analysis = result.rawAnalysis as PackageApiAnalysis;
    const issues = analysis.hallucinations.length;
    const lines: string[] = [];

    lines.push(`## Package API`);
    lines.push(`**${analysis.checkedBindings}** named imports, **${analysis.checkedMembers}** member accesses checked — **${issues}** hallucinated`);

    if (issues > 0) {
      for (const h of analysis.hallucinations) {
        const category = h.category === "hallucinated-named-import" ? "not exported" : "member not found";
        const suggestion = h.suggestion ? ` (did you mean \`${h.suggestion}\`?)` : "";
        lines.push(`- \`${h.raw}\` — ${category}${suggestion}`);
        if (h.availableExports) {
          lines.push(`  - Available exports: ${h.availableExports}`);
        }
      }
    } else {
      lines.push(`All package API refs valid.`);
    }
    lines.push(``);
    return lines;
  },

  formatForFindings(result): string | undefined {
    if (!result.applicable) return undefined;
    const analysis = result.rawAnalysis as PackageApiAnalysis;
    if (analysis.hallucinations.length === 0) return undefined;

    const lines = [
      `### Package API Issues`,
      ``,
      `Static analysis found ${analysis.hallucinations.length} package API hallucination(s):`,
      ``,
    ];
    for (const h of analysis.hallucinations) {
      const category = h.category === "hallucinated-named-import" ? "not exported" : "member not found";
      const suggestion = h.suggestion ? ` (did you mean \`${h.suggestion}\`?)` : "";
      lines.push(`- \`${h.raw}\` — ${category}${suggestion}`);
    }
    return lines.join("\n");
  },
});
