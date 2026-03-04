import { registerChecker, type CheckerInput, type CheckerResult } from "../registry.js";
import { analyzeImports, type ImportAnalysis } from "../import-checker.js";

registerChecker({
  id: "imports",
  displayName: "Imports",
  catchKey: "imports",

  run(input: CheckerInput, projectDir): CheckerResult {
    if (input.mode === "source") {
      return {
        checkerId: "imports",
        checked: 0,
        hallucinated: 0,
        hallucinations: [],
        catchItems: [],
        applicable: false,
        notApplicableReason: "source mode not implemented for this checker",
        rawAnalysis: null,
      };
    }

    const analysis = analyzeImports(input.text, projectDir);
    return {
      checkerId: "imports",
      checked: analysis.checkedImports,
      hallucinated: analysis.hallucinations.length,
      hallucinations: analysis.hallucinations.map(h => ({
        raw: h.raw,
        category: h.reason ?? "unknown",
        suggestion: h.suggestion,
      })),
      catchItems: analysis.hallucinations.map(h => h.raw),
      applicable: analysis.checkedImports > 0,
      notApplicableReason: analysis.checkedImports > 0 ? undefined : "No package import refs found in plan",
      rawAnalysis: analysis,
    };
  },

  formatForCheckAll(result): string[] {
    if (!result.applicable) return [];
    const analysis = result.rawAnalysis as ImportAnalysis;
    const importIssues = analysis.hallucinations.length;
    const lines: string[] = [];

    lines.push(`## Imports`);
    lines.push(`**${analysis.checkedImports}** checked — **${importIssues}** hallucinated`);
    if (importIssues > 0) {
      for (const h of analysis.hallucinations) {
        const reason = h.reason === "package-not-found" ? "not installed" : "subpath not exported";
        const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
        lines.push(`- \`${h.raw}\` — ${reason}${suggestion}`);
      }
    } else {
      lines.push(`All imports valid.`);
    }
    lines.push(``);
    return lines;
  },

  formatForFindings(result): string | undefined {
    if (!result.applicable) return undefined;
    const analysis = result.rawAnalysis as ImportAnalysis;
    if (analysis.hallucinations.length === 0) return undefined;

    const lines = [
      `### Import Issues`,
      ``,
      `Static analysis found ${analysis.hallucinations.length} hallucinated import(s):`,
      ``,
    ];
    for (const h of analysis.hallucinations) {
      const reason = h.reason === "package-not-found" ? "package not found" : "subpath not exported";
      const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
      lines.push(`- \`${h.raw}\` — ${reason}${suggestion}`);
    }
    return lines.join("\n");
  },
});
