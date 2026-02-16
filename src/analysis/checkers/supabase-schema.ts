import path from "node:path";
import { registerChecker, type CheckerResult } from "../registry.js";
import { analyzeSupabaseSchema, parseSupabaseSchema, type SupabaseSchemaAnalysis } from "../supabase-schema-checker.js";

registerChecker({
  id: "supabaseSchema",
  displayName: "Supabase Schema",
  catchKey: "supabaseSchema",

  run(planText, projectDir): CheckerResult {
    const analysis = analyzeSupabaseSchema(planText, projectDir);
    return {
      checkerId: "supabaseSchema",
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
    const analysis = result.rawAnalysis as SupabaseSchemaAnalysis;
    const lines: string[] = [];

    const supabaseFullPath = path.join(projectDir, analysis.typesFilePath!);
    const supabaseSchema = parseSupabaseSchema(supabaseFullPath);
    const supabaseIssues = analysis.hallucinations.length;

    lines.push(`## Supabase Schema`);
    lines.push(`**Source:** \`${analysis.typesFilePath}\``);
    lines.push(`**${analysis.tablesIndexed}** tables, **${analysis.functionsIndexed}** functions, **${analysis.enumsIndexed}** enums indexed`);
    lines.push(`**${analysis.checkedRefs}** refs checked — **${supabaseIssues}** hallucinated`);
    if (supabaseIssues > 0) {
      for (const h of analysis.hallucinations) {
        const category = h.hallucinationCategory === "hallucinated-table" ? "table not found"
          : h.hallucinationCategory === "hallucinated-column" ? "column not found"
          : "function not found";
        const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
        lines.push(`- \`${h.raw}\` — ${category}${suggestion}`);

        if (h.hallucinationCategory === "hallucinated-column" && h.tableName) {
          const table = supabaseSchema.tables.get(h.tableName);
          if (table) {
            const cols = [...table.columns.keys()].join("`, `");
            lines.push(`  - Columns on ${h.tableName}: \`${cols}\``);
          }
        }
      }
    } else {
      lines.push(`All Supabase refs valid.`);
    }

    lines.push(``);
    lines.push(`**Tables:** ${[...supabaseSchema.tables.keys()].map(t => `\`${t}\``).join(", ")}`);
    lines.push(``);
    return lines;
  },

  formatForFindings(result): string | undefined {
    if (!result.applicable) return undefined;
    const analysis = result.rawAnalysis as SupabaseSchemaAnalysis;
    if (analysis.hallucinations.length === 0) return undefined;

    const lines = [
      `### Supabase Schema Issues`,
      ``,
      `Static analysis found ${analysis.hallucinations.length} Supabase schema hallucination(s):`,
      ``,
    ];
    for (const h of analysis.hallucinations) {
      const category = h.hallucinationCategory === "hallucinated-table" ? "table not found"
        : h.hallucinationCategory === "hallucinated-column" ? "column not found"
        : "function not found";
      const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
      lines.push(`- \`${h.raw}\` — ${category}${suggestion}`);
    }
    return lines.join("\n");
  },
});
