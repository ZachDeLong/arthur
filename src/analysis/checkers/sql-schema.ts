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

  formatForTool(result, projectDir): string {
    const analysis = result.rawAnalysis as SqlSchemaAnalysis;
    const sqlSchema = buildSqlSchema(projectDir);
    const lines: string[] = [];

    const { checkedRefs, validRefs, hallucinations, tablesIndexed, byCategory } = analysis;

    lines.push(`## SQL Schema Analysis`);
    lines.push(``);

    if (tablesIndexed === 0) {
      lines.push(`No Drizzle or SQL CREATE TABLE schemas found in project.`);
      return lines.join("\n");
    }

    lines.push(`**${tablesIndexed}** tables indexed, **${checkedRefs}** refs checked — **${validRefs}** valid, **${hallucinations.length}** hallucinated`);

    if (hallucinations.length > 0) {
      lines.push(``);
      lines.push(`### Hallucinations`);
      for (const h of hallucinations) {
        const category = h.hallucinationCategory === "hallucinated-table" ? "table not found" : "column not found";
        const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
        lines.push(`- \`${h.raw}\` — ${category}${suggestion}`);

        // For hallucinated tables, list all available tables
        if (h.hallucinationCategory === "hallucinated-table") {
          const tableNames = [...sqlSchema.tables.keys()].join("`, `");
          lines.push(`  - Available tables: \`${tableNames}\``);
        }

        // For hallucinated columns, list all columns on the target table
        if (h.hallucinationCategory === "hallucinated-column" && h.tableName) {
          const table = sqlSchema.tables.get(h.tableName)
            ?? sqlSchema.tables.get(sqlSchema.variableToTable.get(h.tableName) ?? "");
          if (table) {
            const cols = [...table.columns.entries()]
              .map(([name, type]) => `\`${name}\` (${type})`)
              .join(", ");
            lines.push(`  - Columns on ${table.name}: ${cols}`);
          }
        }
      }
    }

    // Category breakdown
    const parts: string[] = [];
    if (byCategory.tables.total > 0) {
      parts.push(`${byCategory.tables.total - byCategory.tables.hallucinated}/${byCategory.tables.total} tables`);
    }
    if (byCategory.columns.total > 0) {
      parts.push(`${byCategory.columns.total - byCategory.columns.hallucinated}/${byCategory.columns.total} columns`);
    }
    if (parts.length > 0) {
      lines.push(``);
      lines.push(`**Breakdown:** ${parts.join(", ")}`);
    }

    // Always include schema ground truth
    lines.push(``);
    lines.push(`### SQL Schema Ground Truth`);
    for (const [tableName, table] of sqlSchema.tables) {
      const varNote = table.variableName ? ` (var: \`${table.variableName}\`)` : "";
      const cols = [...table.columns.entries()]
        .map(([name, type]) => `${name} (${type})`)
        .join(", ");
      lines.push(`- **${tableName}**${varNote} [${table.source}]: ${cols}`);
    }

    return lines.join("\n");
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
