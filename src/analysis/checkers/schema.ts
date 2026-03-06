import fs from "node:fs";
import path from "node:path";
import { registerChecker, type CheckerInput, type CheckerResult } from "../registry.js";
import { parseSchema, analyzeSchema, type SchemaAnalysis } from "../schema-checker.js";
import { printSchemaAnalysis } from "../formatter.js";

registerChecker({
  id: "schema",
  displayName: "Prisma Schema",
  catchKey: "schema",

  run(input: CheckerInput, projectDir, options): CheckerResult {
    if (input.mode === "source") {
      return {
        checkerId: "schema",
        checked: 0,
        hallucinated: 0,
        hallucinations: [],
        catchItems: [],
        applicable: false,
        notApplicableReason: "source mode not implemented for this checker",
        rawAnalysis: null,
      };
    }
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
        notApplicableReason: "No readable prisma/schema.prisma found",
        rawAnalysis: undefined,
      };
    }

    try {
      const schema = parseSchema(path.resolve(schemaPath));
      const analysis = analyzeSchema(input.text, schema);
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
        notApplicableReason: "Failed to parse Prisma schema",
        rawAnalysis: undefined,
      };
    }
  },

  formatForTool(result): string {
    const { analysis, schema } = result.rawAnalysis as {
      analysis: SchemaAnalysis;
      schema: ReturnType<typeof parseSchema>;
    };
    const lines: string[] = [];

    const { totalRefs, hallucinations, byCategory } = analysis;

    lines.push(`## Schema Analysis`);
    lines.push(``);
    lines.push(`**${totalRefs}** schema refs — **${totalRefs - hallucinations.length}** valid, **${hallucinations.length}** hallucinated`);

    if (hallucinations.length > 0) {
      lines.push(``);
      lines.push(`### Hallucinations`);
      for (const h of hallucinations) {
        const suggestion = h.suggestion ? ` (did you mean \`${h.suggestion}\`?)` : "";
        lines.push(`- \`${h.raw}\` — ${h.hallucinationCategory}${suggestion}`);

        // For hallucinated models, list all available models
        if (h.hallucinationCategory === "hallucinated-model") {
          const available = [...schema.accessorToModel.entries()]
            .map(([accessor, model]) => `\`${accessor}\` (${model})`)
            .join(", ");
          lines.push(`  - Available models: ${available}`);
        }

        // For hallucinated fields, list all fields on the target model
        if (h.hallucinationCategory === "hallucinated-field" && h.modelAccessor) {
          const modelName = schema.accessorToModel.get(h.modelAccessor);
          const model = modelName ? schema.models.get(modelName) : undefined;
          if (model) {
            const fields = [...model.fields.values()]
              .map(f => `\`${f.name}\` (${f.type}${f.isRelation ? ", relation" : ""})`)
              .join(", ");
            lines.push(`  - Fields on ${modelName}: ${fields}`);
          }
        }

        // For wrong relations, list available relation fields
        if (h.hallucinationCategory === "wrong-relation" && h.modelAccessor) {
          const modelName = schema.accessorToModel.get(h.modelAccessor);
          const model = modelName ? schema.models.get(modelName) : undefined;
          if (model) {
            const relations = [...model.fields.values()]
              .filter(f => f.isRelation)
              .map(f => `\`${f.name}\` → ${f.relationModel}`)
              .join(", ");
            lines.push(`  - Available relations on ${modelName}: ${relations || "none"}`);
          }
        }
      }
    }

    // Category breakdown
    const parts: string[] = [];
    if (byCategory.models.total > 0) {
      parts.push(`${byCategory.models.total - byCategory.models.hallucinated}/${byCategory.models.total} models`);
    }
    if (byCategory.fields.total > 0) {
      parts.push(`${byCategory.fields.total - byCategory.fields.hallucinated}/${byCategory.fields.total} fields`);
    }
    if (byCategory.methods.total > 0) {
      parts.push(`${byCategory.methods.total - byCategory.methods.invalid}/${byCategory.methods.total} methods`);
    }
    if (byCategory.relations.total > 0) {
      parts.push(`${byCategory.relations.total - byCategory.relations.wrong}/${byCategory.relations.total} relations`);
    }
    if (parts.length > 0) {
      lines.push(``);
      lines.push(`**Breakdown:** ${parts.join(", ")}`);
    }

    // Always include schema summary as ground truth
    lines.push(``);
    lines.push(`### Schema Ground Truth`);
    for (const [modelName, model] of schema.models) {
      const fieldNames = [...model.fields.values()]
        .map(f => f.name + (f.isRelation ? ` → ${f.relationModel}` : ""))
        .join(", ");
      lines.push(`- **${modelName}** (accessor: \`${model.accessor}\`): ${fieldNames}`);
    }
    if (schema.enums.size > 0) {
      lines.push(`- **Enums:** ${[...schema.enums].join(", ")}`);
    }

    return lines.join("\n");
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

  formatForCli(result) {
    const { analysis } = result.rawAnalysis as { analysis: SchemaAnalysis };
    printSchemaAnalysis(analysis);
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
