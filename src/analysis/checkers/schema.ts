import fs from "node:fs";
import path from "node:path";
import { registerChecker, type CheckerResult } from "../registry.js";
import { parseSchema, analyzeSchema, type SchemaAnalysis } from "../schema-checker.js";

registerChecker({
  id: "schema",
  displayName: "Prisma Schema",
  catchKey: "schema",

  run(planText, projectDir, options): CheckerResult {
    const schemaPath = options?.schemaPath
      ?? (fs.existsSync(path.join(projectDir, "prisma/schema.prisma"))
        ? path.join(projectDir, "prisma/schema.prisma")
        : undefined);

    if (!schemaPath) {
      return {
        checkerId: "schema",
        checked: 0,
        hallucinated: 0,
        hallucinations: [],
        catchItems: [],
        applicable: false,
        rawAnalysis: undefined,
      };
    }

    try {
      const schema = parseSchema(path.resolve(schemaPath));
      const analysis = analyzeSchema(planText, schema);
      return {
        checkerId: "schema",
        checked: analysis.totalRefs,
        hallucinated: analysis.hallucinations.length,
        hallucinations: analysis.hallucinations.map(h => ({
          raw: h.raw,
          category: h.hallucinationCategory ?? h.category,
          suggestion: h.suggestion,
        })),
        catchItems: analysis.hallucinations.map(h => h.raw),
        applicable: true,
        rawAnalysis: { analysis, schema, schemaPath },
      };
    } catch {
      return {
        checkerId: "schema",
        checked: 0,
        hallucinated: 0,
        hallucinations: [],
        catchItems: [],
        applicable: false,
        rawAnalysis: undefined,
      };
    }
  },

  formatForCheckAll(result): string[] {
    if (!result.applicable) return [];
    const { analysis, schema } = result.rawAnalysis as {
      analysis: SchemaAnalysis;
      schema: ReturnType<typeof parseSchema>;
    };
    const lines: string[] = [];
    const schemaIssues = analysis.hallucinations.length;

    lines.push(`## Prisma Schema`);
    lines.push(`**${analysis.totalRefs}** refs — **${schemaIssues}** hallucinated`);
    if (schemaIssues > 0) {
      for (const h of analysis.hallucinations) {
        const suggestion = h.suggestion ? ` → \`${h.suggestion}\`` : "";
        lines.push(`- \`${h.raw}\` — ${h.hallucinationCategory}${suggestion}`);

        if (h.hallucinationCategory === "hallucinated-model") {
          const available = [...schema.accessorToModel.entries()]
            .map(([accessor, model]) => `\`${accessor}\` (${model})`)
            .join(", ");
          lines.push(`  - Available models: ${available}`);
        }
        if (h.hallucinationCategory === "hallucinated-field" && h.modelAccessor) {
          const modelName = schema.accessorToModel.get(h.modelAccessor);
          const model = modelName ? schema.models.get(modelName) : undefined;
          if (model) {
            const fields = [...model.fields.keys()].join("`, `");
            lines.push(`  - Fields on ${modelName}: \`${fields}\``);
          }
        }
      }
    } else {
      lines.push(`All schema refs valid.`);
    }

    lines.push(``);
    lines.push(`**Schema:** ${[...schema.models.keys()].map(m => `\`${m}\``).join(", ")}${schema.enums.size > 0 ? ` | Enums: ${[...schema.enums].join(", ")}` : ""}`);
    lines.push(``);
    return lines;
  },

  formatForFindings(result): string | undefined {
    if (!result.applicable) return undefined;
    const { analysis } = result.rawAnalysis as { analysis: SchemaAnalysis };
    if (analysis.hallucinations.length === 0) return undefined;

    const lines = [
      `### Schema Issues`,
      ``,
      `Static analysis found ${analysis.hallucinations.length} Prisma schema hallucination(s):`,
      ``,
    ];
    for (const h of analysis.hallucinations) {
      const suggestion = h.suggestion ? ` (did you mean \`${h.suggestion}\`?)` : "";
      lines.push(`- \`${h.raw}\` — ${h.hallucinationCategory}${suggestion}`);
    }
    return lines.join("\n");
  },
});
