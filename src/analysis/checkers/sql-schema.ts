import { registerChecker, type CheckerInput, type CheckerResult } from "../registry.js";
import { analyzeSqlSchema, buildSqlSchema, type SqlSchemaAnalysis } from "../sql-schema-checker.js";
import { printSqlSchemaAnalysis } from "../formatter.js";

registerChecker({
  id: "sqlSchema",
  displayName: "SQL/Drizzle Schema",
  catchKey: "sqlSchema",

  run(input: CheckerInput, projectDir): CheckerResult {
    if (input.mode === "source") {
      return {
        checkerId: "sqlSchema",
        checked: 0,
        hallucinated: 0,
        hallucinations: [],
        catchItems: [],
        applicable: false,
        notApplicableReason: "source mode not implemented for this checker",
        rawAnalysis: null,
      };
    }

    const analysis = analyzeSqlSchema(input.text, projectDir);
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
      notApplicableReason: analysis.tablesIndexed > 0 ? undefined : "No Drizzle or SQL schema files found",
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

  formatForCli(result) {
    printSqlSchemaAnalysis(result.rawAnalysis as SqlSchemaAnalysis);
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
