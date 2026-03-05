import { registerChecker, type CheckerInput, type CheckerResult } from "../registry.js";
import { analyzePackageApi, type PackageApiAnalysis } from "../package-api-checker.js";
import * as log from "../../utils/logger.js";

registerChecker({
  id: "packageApi",
  displayName: "Package API",
  catchKey: "packageApi",
  experimental: true,

  run(input: CheckerInput, projectDir): CheckerResult {
    if (input.mode === "source") {
      return {
        checkerId: "packageApi",
        checked: 0,
        hallucinated: 0,
        hallucinations: [],
        catchItems: [],
        applicable: false,
        notApplicableReason: "source mode not implemented for this checker",
        rawAnalysis: null,
      };
    }

    const analysis = analyzePackageApi(input.text, projectDir);
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
      notApplicableReason: analysis.applicable ? undefined : "No package API refs could be validated",
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

  formatForCli(result) {
    log.heading(`Static Analysis: ${this.displayName}`);
    log.dim(`  ${result.checked} checked, ${result.hallucinated} hallucinated`);
    for (const finding of result.hallucinations) {
      const suggestion = finding.suggestion ? ` (${finding.suggestion})` : "";
      log.dim(`  - ${finding.raw} [${finding.category}]${suggestion}`);
    }
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
