import { registerChecker, type CheckerResult } from "../registry.js";
import { analyzeEnv, parseEnvFiles, type EnvAnalysis } from "../env-checker.js";

registerChecker({
  id: "env",
  displayName: "Env Variables",
  catchKey: "env",

  run(planText, projectDir): CheckerResult {
    const analysis = analyzeEnv(planText, projectDir);
    const applicable = analysis.envFilesFound.length > 0 && analysis.checkedRefs > 0;
    return {
      checkerId: "env",
      checked: analysis.checkedRefs,
      hallucinated: analysis.hallucinations.length,
      hallucinations: analysis.hallucinations.map(h => ({
        raw: h.varName,
        category: "not-in-env-files",
        suggestion: h.suggestion,
      })),
      catchItems: analysis.hallucinations.map(h => h.varName),
      applicable,
      rawAnalysis: analysis,
    };
  },

  formatForCheckAll(result, projectDir): string[] {
    if (!result.applicable) return [];
    const analysis = result.rawAnalysis as EnvAnalysis;
    const envIssues = analysis.hallucinations.length;
    const lines: string[] = [];

    lines.push(`## Env Variables`);
    lines.push(`**${analysis.checkedRefs}** checked — **${envIssues}** hallucinated`);
    if (envIssues > 0) {
      for (const h of analysis.hallucinations) {
        const suggestion = h.suggestion ? ` → \`${h.suggestion}\`` : "";
        lines.push(`- \`${h.varName}\`${suggestion}`);
      }
      const { vars } = parseEnvFiles(projectDir);
      lines.push(`- Defined vars: ${[...vars].map(v => `\`${v}\``).join(", ")}`);
    } else {
      lines.push(`All env vars valid.`);
    }
    lines.push(``);
    return lines;
  },

  formatForFindings(result): string | undefined {
    if (!result.applicable) return undefined;
    const analysis = result.rawAnalysis as EnvAnalysis;
    if (analysis.hallucinations.length === 0) return undefined;

    const lines = [
      `### Environment Variable Issues`,
      ``,
      `Static analysis found ${analysis.hallucinations.length} env variable(s) not defined in project env files (${analysis.envFilesFound.join(", ")}):`,
      ``,
    ];
    for (const h of analysis.hallucinations) {
      const suggestion = h.suggestion ? ` (did you mean \`${h.suggestion}\`?)` : "";
      lines.push(`- \`${h.varName}\` — not in env files${suggestion}`);
    }
    return lines.join("\n");
  },
});
