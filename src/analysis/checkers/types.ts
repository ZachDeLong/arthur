import { registerChecker, type CheckerInput, type CheckerResult } from "../registry.js";
import { analyzeTypes, buildTypeIndex, type TypeAnalysis } from "../type-checker.js";
import { printTypeAnalysis } from "../formatter.js";

registerChecker({
  id: "types",
  displayName: "TypeScript Types",
  catchKey: "types",
  experimental: true,

  run(input: CheckerInput, projectDir): CheckerResult {
    if (input.mode === "source") {
      return {
        checkerId: "types",
        checked: 0,
        hallucinated: 0,
        hallucinations: [],
        catchItems: [],
        applicable: false,
        notApplicableReason: "source mode not implemented for this checker",
        rawAnalysis: null,
      };
    }

    const analysis = analyzeTypes(input.text, projectDir);
    return {
      checkerId: "types",
      checked: analysis.checkedRefs,
      hallucinated: analysis.hallucinations.length,
      hallucinations: analysis.hallucinations.map(h => ({
        raw: h.raw,
        category: h.hallucinationCategory ?? "unknown",
        suggestion: h.suggestion,
      })),
      catchItems: analysis.hallucinations.map(h => h.raw),
      applicable: analysis.checkedRefs > 0,
      notApplicableReason: analysis.checkedRefs > 0 ? undefined : "No TypeScript type/member refs found in plan",
      rawAnalysis: analysis,
    };
  },

  formatForTool(result, projectDir): string {
    const analysis = result.rawAnalysis as TypeAnalysis;
    const lines: string[] = [];

    const { checkedRefs, validRefs, hallucinations, skippedRefs, byCategory } = analysis;

    lines.push(`## TypeScript Type Analysis`);
    lines.push(``);

    if (checkedRefs === 0 && skippedRefs === 0) {
      lines.push(`No type references found in plan text.`);
      return lines.join("\n");
    }

    lines.push(`**${checkedRefs}** types checked — **${validRefs}** valid, **${hallucinations.length}** hallucinated, **${skippedRefs}** skipped (builtins)`);

    if (hallucinations.length > 0) {
      lines.push(``);
      lines.push(`### Hallucinated Types`);
      const typeIndex = buildTypeIndex(projectDir);
      for (const h of hallucinations) {
        const category = h.hallucinationCategory === "hallucinated-type" ? "type not found" : "member not found";
        const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
        lines.push(`- \`${h.raw}\` — ${category}${suggestion}`);

        // For hallucinated members, show available members on the type
        if (h.hallucinationCategory === "hallucinated-member" && h.typeName) {
          const decl = typeIndex.get(h.typeName);
          if (decl && decl.members.size > 0) {
            const members = [...decl.members.keys()].join("`, `");
            lines.push(`  - Members on ${h.typeName}: \`${members}\``);
          }
        }
      }

      // List project types as ground truth for type-not-found errors
      const hasTypeErrors = hallucinations.some(h => h.hallucinationCategory === "hallucinated-type");
      if (hasTypeErrors) {
        const index = buildTypeIndex(projectDir);
        if (index.size > 0) {
          lines.push(``);
          lines.push(`### Available Project Types`);
          const typesByFile = new Map<string, string[]>();
          for (const [name, decl] of index) {
            const existing = typesByFile.get(decl.sourceFile) ?? [];
            existing.push(`${name} (${decl.kind})`);
            typesByFile.set(decl.sourceFile, existing);
          }
          for (const [file, types] of typesByFile) {
            lines.push(`- \`${file}\`: ${types.join(", ")}`);
          }
        }
      }
    }

    // Category breakdown
    const parts: string[] = [];
    if (byCategory.types.total > 0) {
      parts.push(`${byCategory.types.total - byCategory.types.hallucinated}/${byCategory.types.total} types`);
    }
    if (byCategory.members.total > 0) {
      parts.push(`${byCategory.members.total - byCategory.members.hallucinated}/${byCategory.members.total} members`);
    }
    if (parts.length > 0) {
      lines.push(``);
      lines.push(`**Breakdown:** ${parts.join(", ")}`);
    }

    return lines.join("\n");
  },

  formatForCheckAll(result): string[] {
    if (!result.applicable) return [];
    const analysis = result.rawAnalysis as TypeAnalysis;
    const typeIssues = analysis.hallucinations.length;
    const lines: string[] = [];

    lines.push(`## TypeScript Types`);
    lines.push(`**${analysis.checkedRefs}** checked — **${typeIssues}** hallucinated`);
    if (typeIssues > 0) {
      for (const h of analysis.hallucinations) {
        const category = h.hallucinationCategory === "hallucinated-type" ? "not found" : "member not found";
        const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
        lines.push(`- \`${h.raw}\` — ${category}${suggestion}`);
      }
    } else {
      lines.push(`All type refs valid.`);
    }
    lines.push(``);
    return lines;
  },

  formatForCli(result) {
    printTypeAnalysis(result.rawAnalysis as TypeAnalysis);
  },

  formatForFindings(result): string | undefined {
    if (!result.applicable) return undefined;
    const analysis = result.rawAnalysis as TypeAnalysis;
    if (analysis.hallucinations.length === 0) return undefined;

    const lines = [
      `### TypeScript Type Issues`,
      ``,
      `Static analysis found ${analysis.hallucinations.length} TypeScript type hallucination(s):`,
      ``,
    ];
    for (const h of analysis.hallucinations) {
      const category = h.hallucinationCategory === "hallucinated-type" ? "type not found" : "member not found";
      const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
      lines.push(`- \`${h.raw}\` — ${category}${suggestion}`);
    }
    return lines.join("\n");
  },
});
