import fs from "node:fs";
import path from "node:path";
import { registerChecker, type CheckerInput, type CheckerResult } from "../registry.js";
import { analyzeImports, type ImportAnalysis } from "../import-checker.js";
import { printImportAnalysis } from "../formatter.js";

registerChecker({
  id: "imports",
  displayName: "Imports",
  catchKey: "imports",
  supportsSourceMode: true,

  run(input: CheckerInput, projectDir): CheckerResult {
    const analysis = input.mode === "source" && input.files
      ? analyzeImports(input.files, projectDir, { mode: "source" })
      : analyzeImports(input.text, projectDir);

    return {
      checkerId: "imports",
      checked: analysis.checkedImports,
      hallucinated: analysis.hallucinations.length,
      hallucinations: analysis.hallucinations.map(h => ({
        raw: h.file ? `${h.raw} (in ${h.file})` : h.raw,
        category: h.reason ?? "unknown",
        suggestion: h.suggestion,
      })),
      catchItems: analysis.hallucinations.map(h => h.raw),
      applicable: analysis.checkedImports > 0,
      notApplicableReason: analysis.checkedImports > 0 ? undefined : "No package import refs found",
      rawAnalysis: analysis,
    };
  },

  formatForTool(result, projectDir): string {
    const analysis = result.rawAnalysis as ImportAnalysis;
    const lines: string[] = [];

    const { checkedImports, validImports, hallucinations, skippedImports } = analysis;

    lines.push(`## Import Analysis`);
    lines.push(``);
    lines.push(`**${checkedImports}** imports checked — **${validImports}** valid, **${hallucinations.length}** hallucinated, **${skippedImports}** skipped (relative/builtin)`);

    if (hallucinations.length > 0) {
      lines.push(``);
      lines.push(`### Hallucinated Imports`);
      for (const h of hallucinations) {
        const reason = h.reason === "package-not-found" ? "package not found" : "subpath not exported";
        const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
        lines.push(`- \`${h.raw}\` — ${reason}${suggestion}`);
      }

      // List installed packages as ground truth for package-not-found errors
      const hasPackageErrors = hallucinations.some(h => h.reason === "package-not-found");
      if (hasPackageErrors) {
        const pkgJsonPath = path.join(projectDir, "package.json");
        if (fs.existsSync(pkgJsonPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
            const deps = Object.keys(pkg.dependencies ?? {});
            const devDeps = Object.keys(pkg.devDependencies ?? {});
            lines.push(``);
            lines.push(`### Installed Packages`);
            if (deps.length > 0) lines.push(`- **dependencies:** ${deps.map(d => `\`${d}\``).join(", ")}`);
            if (devDeps.length > 0) lines.push(`- **devDependencies:** ${devDeps.map(d => `\`${d}\``).join(", ")}`);
          } catch { /* ignore parse errors */ }
        }
      }
    }

    return lines.join("\n");
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
        const fileContext = h.file ? ` (in ${h.file})` : "";
        lines.push(`- \`${h.raw}\`${fileContext} — ${reason}${suggestion}`);
      }
    } else {
      lines.push(`All imports valid.`);
    }
    lines.push(``);
    return lines;
  },

  formatForCli(result) {
    printImportAnalysis(result.rawAnalysis as ImportAnalysis);
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
      const fileContext = h.file ? ` (in ${h.file})` : "";
      lines.push(`- \`${h.raw}\`${fileContext} — ${reason}${suggestion}`);
    }
    return lines.join("\n");
  },
});
