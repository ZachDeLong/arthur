import { registerChecker, type CheckerResult } from "../registry.js";
import { analyzeSqlSchema, buildSqlSchema, type SqlSchemaAnalysis } from "../sql-schema-checker.js";

registerChecker({
  id: "sqlSchema",
  displayName: "SQL/Drizzle Schema",
  catchKey: "sqlSchema",

  run(planText, projectDir): CheckerResult {
    const analysis = analyzeSqlSchema(planText, projectDir);
    return {
      checkerId: "sqlSchema",
      checked: analysis.checkedRefs,
      hallucinated: analysis.hallucinations.length,
      hallucinations: analysis.hallucinations.map(h => ({
        raw: h.raw,
        category: h.hallucinationCategory ?? "unknown",
        suggestion: h.suggestion,
      })),
      catchItems: analysis.hallucinations.map(h => h.raw),
      applicable: analysis.tablesIndexed > 0,
      rawAnalysis: analysis,
    };
  },

  formatForCheckAll(result, projectDir): string[] {
    if (!result.applicable) return [];
    const analysis = result.rawAnalysis as SqlSchemaAnalysis;
    const sqlSchema = buildSqlSchema(projectDir);
    const sqlIssues = analysis.hallucinations.length;
    const lines: string[] = [];

    lines.push(`## SQL/Drizzle Schema`);
    lines.push(`**${analysis.tablesIndexed}** tables, **${analysis.checkedRefs}** refs — **${sqlIssues}** hallucinated`);
    if (sqlIssues > 0) {
      for (const h of analysis.hallucinations) {
        const category = h.hallucinationCategory === "hallucinated-table" ? "table not found" : "column not found";
        const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
        lines.push(`- \`${h.raw}\` — ${category}${suggestion}`);
      }
    } else {
      lines.push(`All SQL refs valid.`);
    }

    lines.push(``);
    lines.push(`**Tables:** ${[...sqlSchema.tables.keys()].map(t => `\`${t}\``).join(", ")}`);
    lines.push(``);
    return lines;
  },

  formatForFindings(result): string | undefined {
    if (!result.applicable) return undefined;
    const analysis = result.rawAnalysis as SqlSchemaAnalysis;
    if (analysis.hallucinations.length === 0) return undefined;

    const lines = [
      `### SQL Schema Issues`,
      ``,
      `Static analysis found ${analysis.hallucinations.length} SQL/Drizzle schema hallucination(s):`,
      ``,
    ];
    for (const h of analysis.hallucinations) {
      const category = h.hallucinationCategory === "hallucinated-table" ? "table not found" : "column not found";
      const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
      lines.push(`- \`${h.raw}\` — ${category}${suggestion}`);
    }
    return lines.join("\n");
  },
});
