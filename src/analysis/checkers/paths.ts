import { registerChecker, type CheckerInput, type CheckerResult } from "../registry.js";
import { analyzePaths, findClosestPaths, getDirectoryContext } from "../path-checker.js";
import { getAllFiles } from "../../context/tree.js";
import { printPathAnalysis } from "../formatter.js";
import type { PathAnalysis } from "../path-checker.js";

registerChecker({
  id: "paths",
  displayName: "File Paths",
  catchKey: "paths",

  run(input: CheckerInput, projectDir): CheckerResult {
    if (input.mode === "source") {
      return {
        checkerId: "paths",
        checked: 0,
        hallucinated: 0,
        hallucinations: [],
        catchItems: [],
        applicable: false,
        notApplicableReason: "source mode not implemented for this checker",
        rawAnalysis: null,
      };
    }

    const analysis = analyzePaths(input.text, projectDir);
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

  formatForTool(result, projectDir): string {
    const analysis = result.rawAnalysis as PathAnalysis;
    const lines: string[] = [];

    const checked = analysis.extractedPaths.length;
    const hallucinated = analysis.hallucinatedPaths.length;
    const intentionalNew = analysis.intentionalNewPaths.length;
    const valid = checked - hallucinated - intentionalNew;

    // Get actual files for ground truth context
    const actualFiles = getAllFiles(projectDir);

    lines.push(`## Path Analysis`);
    lines.push(``);
    lines.push(`**${checked}** paths checked — **${valid}** valid, **${hallucinated}** hallucinated, **${intentionalNew}** intentional new`);
    lines.push(`**${actualFiles.size}** total files indexed in project`);

    if (hallucinated > 0) {
      lines.push(``);
      lines.push(`### Hallucinated Paths`);
      for (const p of analysis.hallucinatedPaths) {
        lines.push(`- \`${p}\` — **NOT FOUND**`);

        // Closest matches
        const closest = findClosestPaths(p, actualFiles);
        if (closest.length > 0) {
          lines.push(`  - Closest matches: ${closest.map(c => `\`${c}\``).join(", ")}`);
        }

        // Directory context — show what actually exists near the expected location
        const dirFiles = getDirectoryContext(p, actualFiles);
        if (dirFiles.length > 0) {
          const parentDir = p.substring(0, p.lastIndexOf("/"));
          lines.push(`  - Files in \`${parentDir}/\`: ${dirFiles.slice(0, 8).map(f => `\`${f}\``).join(", ")}${dirFiles.length > 8 ? ` (+${dirFiles.length - 8} more)` : ""}`);
        }
      }
    }

    if (intentionalNew > 0) {
      lines.push(``);
      lines.push(`### Intentional New Files`);
      for (const p of analysis.intentionalNewPaths) {
        lines.push(`- \`${p}\` — new file (CREATE signal found)`);
      }
    }

    if (analysis.validPaths.length > 0) {
      lines.push(``);
      lines.push(`### Valid Paths`);
      const show = analysis.validPaths.slice(0, 10);
      for (const p of show) {
        lines.push(`- \`${p}\` — exists`);
      }
      if (analysis.validPaths.length > 10) {
        lines.push(`- ... and ${analysis.validPaths.length - 10} more`);
      }
    }

    return lines.join("\n");
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

  formatForCli(result) {
    printPathAnalysis(result.rawAnalysis as PathAnalysis);
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
