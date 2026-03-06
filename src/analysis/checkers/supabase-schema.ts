import path from "node:path";
import { registerChecker, type CheckerInput, type CheckerResult } from "../registry.js";
import { analyzeSupabaseSchema, parseSupabaseSchema, type SupabaseSchemaAnalysis } from "../supabase-schema-checker.js";
import * as log from "../../utils/logger.js";

registerChecker({
  id: "supabaseSchema",
  displayName: "Supabase Schema",
  catchKey: "supabaseSchema",

  run(input: CheckerInput, projectDir): CheckerResult {
    if (input.mode === "source") {
      return {
        checkerId: "supabaseSchema",
        checked: 0,
        hallucinated: 0,
        hallucinations: [],
        catchItems: [],
        applicable: false,
        notApplicableReason: "source mode not implemented for this checker",
        rawAnalysis: null,
      };
    }

    const analysis = analyzeSupabaseSchema(input.text, projectDir);
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
      notApplicableReason: analysis.tablesIndexed > 0 ? undefined : "No Supabase generated types file found",
      rawAnalysis: analysis,
    };
  },

  formatForTool(result, projectDir): string {
    const analysis = result.rawAnalysis as SupabaseSchemaAnalysis;
    const lines: string[] = [];

    const { checkedRefs, validRefs, hallucinations, tablesIndexed, functionsIndexed, enumsIndexed, typesFilePath, byCategory } = analysis;

    lines.push(`## Supabase Schema Analysis`);
    lines.push(``);

    if (tablesIndexed === 0 && !typesFilePath) {
      lines.push(`No Supabase generated types file found in project.`);
      return lines.join("\n");
    }

    lines.push(`**Source:** \`${typesFilePath}\``);
    lines.push(`**${tablesIndexed}** tables, **${functionsIndexed}** functions, **${enumsIndexed}** enums indexed`);
    lines.push(`**${checkedRefs}** refs checked — **${validRefs}** valid, **${hallucinations.length}** hallucinated`);

    if (hallucinations.length > 0) {
      lines.push(``);
      lines.push(`### Hallucinations`);

      const fullPath = path.join(projectDir, typesFilePath!);
      const schema = parseSupabaseSchema(fullPath);

      for (const h of hallucinations) {
        const category = h.hallucinationCategory === "hallucinated-table" ? "table not found"
          : h.hallucinationCategory === "hallucinated-column" ? "column not found"
          : "function not found";
        const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
        lines.push(`- \`${h.raw}\` — ${category}${suggestion}`);

        if (h.hallucinationCategory === "hallucinated-table") {
          const tableNames = [...schema.tables.keys()].join("`, `");
          lines.push(`  - Available tables: \`${tableNames}\``);
        }

        if (h.hallucinationCategory === "hallucinated-column" && h.tableName) {
          const table = schema.tables.get(h.tableName);
          if (table) {
            const cols = [...table.columns.entries()]
              .map(([name, type]) => `\`${name}\` (${type})`)
              .join(", ");
            lines.push(`  - Columns on ${table.name}: ${cols}`);
          }
        }

        if (h.hallucinationCategory === "hallucinated-function") {
          const funcNames = [...schema.functions.keys()].join("`, `");
          if (funcNames) lines.push(`  - Available functions: \`${funcNames}\``);
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
    if (byCategory.functions.total > 0) {
      parts.push(`${byCategory.functions.total - byCategory.functions.hallucinated}/${byCategory.functions.total} functions`);
    }
    if (parts.length > 0) {
      lines.push(``);
      lines.push(`**Breakdown:** ${parts.join(", ")}`);
    }

    // Always include schema ground truth
    if (typesFilePath) {
      const fullPath = path.join(projectDir, typesFilePath);
      const schema = parseSupabaseSchema(fullPath);

      lines.push(``);
      lines.push(`### Supabase Schema Ground Truth`);
      for (const [tableName, table] of schema.tables) {
        const cols = [...table.columns.entries()]
          .map(([name, type]) => `${name} (${type})`)
          .join(", ");
        lines.push(`- **${tableName}**: ${cols}`);
      }
      if (schema.functions.size > 0) {
        lines.push(``);
        lines.push(`**Functions:** ${[...schema.functions.keys()].map(f => `\`${f}\``).join(", ")}`);
      }
      if (schema.enums.size > 0) {
        lines.push(`**Enums:** ${[...schema.enums.entries()].map(([name, vals]) => `\`${name}\` (${vals.join(", ")})`).join(", ")}`);
      }
    }

    return lines.join("\n");
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
