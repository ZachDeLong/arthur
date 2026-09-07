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
      ? analyzeImports(input.files, projectDir, { mode: "source", cache: input.cache })
      : analyzeImports(input.text, projectDir, { cache: input.cache });

    const findings: CheckerResult["hallucinations"] = [
      ...analysis.hallucinations.map(h => ({
        raw: h.raw,
        category: h.reason ?? "unknown",
        suggestion: h.suggestion,
        location: h.location,
      })),
      ...analysis.unverifiedImports.map(h => ({
        raw: h.raw,
        category: h.reason ?? "declared-not-installed",
        suggestion: h.reason === "planned-dependency"
          ? "install the planned dependency before treating this import as verified"
          : "install dependencies before treating this import as verified",
        severity: "warning" as const,
        location: h.location,
      })),
    ];

    return {
      checkerId: "imports",
      checked: analysis.checkedImports,
      hallucinated: findings.length,
      hallucinations: findings,
      catchItems: [...analysis.hallucinations, ...analysis.unverifiedImports].map(h => h.raw),
      applicable: analysis.checkedImports > 0 || analysis.unverifiedImports.length > 0,
      notApplicableReason: analysis.checkedImports > 0 || analysis.unverifiedImports.length > 0
        ? undefined
        : input.mode === "source"
          ? "No changed package import refs found"
          : "No package import refs found in plan",
      rawAnalysis: analysis,
    };
  },

  formatForTool(result, projectDir): string {
    const analysis = result.rawAnalysis as ImportAnalysis;
    const lines: string[] = [];

    const { checkedImports, validImports, hallucinations, skippedImports, unverifiedImports } = analysis;

    lines.push(`## Import Analysis`);
    lines.push(``);
    lines.push(`**${checkedImports}** imports checked — **${validImports}** valid, **${hallucinations.length}** invalid, **${unverifiedImports.length}** unverified, **${skippedImports}** skipped (relative/builtin)`);

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

    if (unverifiedImports.length > 0) {
      lines.push(``);
      lines.push(`### Unverified Imports`);
      for (const h of unverifiedImports) {
        const fileContext = h.file ? ` in \`${h.file}\`` : "";
        const reason = h.reason === "planned-dependency"
          ? "planned but not installed"
          : "declared in package.json but not installed";
        lines.push(`- \`${h.raw}\`${fileContext} — ${reason}`);
      }
    }

    return lines.join("\n");
  },

  formatForCheckAll(result): string[] {
    if (!result.applicable) return [];
    const analysis = result.rawAnalysis as ImportAnalysis;
    const importIssues = analysis.hallucinations.length;
    const importWarnings = analysis.unverifiedImports.length;
    const lines: string[] = [];

    lines.push(`## Imports`);
    lines.push(`**${analysis.checkedImports}** checked — **${importIssues}** invalid, **${importWarnings}** unverified`);
    if (importIssues > 0) {
      for (const h of analysis.hallucinations) {
        const reason = h.reason === "package-not-found" ? "not installed" : "subpath not exported";
        const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
        const fileContext = h.file ? ` (in ${h.file})` : "";
        lines.push(`- \`${h.raw}\`${fileContext} — ${reason}${suggestion}`);
      }
    } else if (importWarnings === 0) {
      lines.push(`All imports valid.`);
    }
    for (const h of analysis.unverifiedImports) {
      const fileContext = h.file ? ` (in ${h.file})` : "";
      const reason = h.reason === "planned-dependency"
        ? "planned but not installed"
        : "declared but not installed";
      lines.push(`- \`${h.raw}\`${fileContext} — ${reason} (warning)`);
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
    if (analysis.hallucinations.length === 0 && analysis.unverifiedImports.length === 0) return undefined;

    const lines = [
      `### Import Issues`,
      ``,
      `Static analysis found ${analysis.hallucinations.length} invalid and ${analysis.unverifiedImports.length} unverified import(s):`,
      ``,
    ];
    for (const h of analysis.hallucinations) {
      const reason = h.reason === "package-not-found" ? "package not found" : "subpath not exported";
      const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
      const fileContext = h.file ? ` (in ${h.file})` : "";
      lines.push(`- \`${h.raw}\`${fileContext} — ${reason}${suggestion}`);
    }
    for (const h of analysis.unverifiedImports) {
      const fileContext = h.file ? ` (in ${h.file})` : "";
      const reason = h.reason === "planned-dependency"
        ? "planned but not installed"
        : "declared but not installed";
      lines.push(`- \`${h.raw}\`${fileContext} — ${reason} (warning)`);
    }
    return lines.join("\n");
  },
});
