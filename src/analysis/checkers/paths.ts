import { registerChecker, type CheckerResult } from "../registry.js";
import { analyzePaths, findClosestPaths, getDirectoryContext } from "../path-checker.js";
import { getAllFiles } from "../../context/tree.js";
import type { PathAnalysis } from "../path-checker.js";

registerChecker({
  id: "paths",
  displayName: "File Paths",
  catchKey: "paths",

  run(planText, projectDir): CheckerResult {
    const analysis = analyzePaths(planText, projectDir);
    return {
      checkerId: "paths",
      checked: analysis.extractedPaths.length,
      hallucinated: analysis.hallucinatedPaths.length,
      hallucinations: analysis.hallucinatedPaths.map(p => ({
        raw: p,
        category: "hallucinated-path",
      })),
      catchItems: analysis.hallucinatedPaths,
      applicable: true,
      rawAnalysis: analysis,
    };
  },

  formatForCheckAll(result, projectDir): string[] {
    const analysis = result.rawAnalysis as PathAnalysis;
    const actualFiles = getAllFiles(projectDir);
    const pathIssues = analysis.hallucinatedPaths.length;
    const lines: string[] = [];

    lines.push(`## File Paths`);
    lines.push(`**${analysis.extractedPaths.length}** paths checked — **${pathIssues}** hallucinated | ${actualFiles.size} files indexed`);
    if (pathIssues > 0) {
      for (const p of analysis.hallucinatedPaths) {
        lines.push(`- \`${p}\` — **NOT FOUND**`);
        const closest = findClosestPaths(p, actualFiles);
        if (closest.length > 0) {
          lines.push(`  - Closest: ${closest.map(c => `\`${c}\``).join(", ")}`);
        }
      }
    } else {
      lines.push(`All paths valid.`);
    }
    lines.push(``);
    return lines;
  },

  formatForFindings(result): string | undefined {
    const analysis = result.rawAnalysis as PathAnalysis;
    if (analysis.hallucinatedPaths.length === 0) return undefined;

    const lines = [
      `### File Path Issues`,
      ``,
      `Static analysis found ${analysis.hallucinatedPaths.length} file path(s) that do not exist in the project:`,
      ``,
    ];
    for (const p of analysis.hallucinatedPaths) {
      lines.push(`- \`${p}\` — **NOT FOUND** in project tree`);
    }
    return lines.join("\n");
  },
});
