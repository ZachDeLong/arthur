import chalk from "chalk";
import type { PathAnalysis } from "./path-checker.js";
import type { SchemaAnalysis } from "./schema-checker.js";

/** Print static path analysis results to the console. */
export function printPathAnalysis(analysis: PathAnalysis): void {
  const checked = analysis.extractedPaths.length;
  const hallucinated = analysis.hallucinatedPaths.length;
  const intentionalNew = analysis.intentionalNewPaths.length;

  console.log(
    chalk.bold.cyan("\n── Static Analysis: File Paths ") +
    chalk.dim("─".repeat(30)),
  );

  const validCount = checked - hallucinated - intentionalNew;
  console.log(
    chalk.dim(`   ${checked} checked, `) +
    (hallucinated > 0
      ? chalk.red(`${hallucinated} hallucinated`)
      : chalk.green("0 hallucinated")) +
    (intentionalNew > 0 ? chalk.dim(`, ${intentionalNew} intentional new`) : ""),
  );

  for (const p of analysis.hallucinatedPaths) {
    console.log(chalk.red(`   ✗ ${p}`) + chalk.dim(" — NOT FOUND"));
  }
  for (const p of analysis.intentionalNewPaths) {
    console.log(chalk.yellow(`   ~ ${p}`) + chalk.dim(" — new file"));
  }
  // Show a sample of valid paths (max 5) to keep output concise
  const validPaths = analysis.validPaths;
  const showValid = validPaths.slice(0, 5);
  for (const p of showValid) {
    console.log(chalk.green(`   ✓ ${p}`));
  }
  if (validPaths.length > 5) {
    console.log(chalk.dim(`   ... and ${validPaths.length - 5} more valid paths`));
  }

  console.log();
}

/** Print static schema analysis results to the console. */
export function printSchemaAnalysis(analysis: SchemaAnalysis): void {
  const { totalRefs, hallucinations } = analysis;

  console.log(
    chalk.bold.cyan("── Static Analysis: Schema ") +
    chalk.dim("─".repeat(34)),
  );

  console.log(
    chalk.dim(`   ${totalRefs} refs, `) +
    (hallucinations.length > 0
      ? chalk.red(`${hallucinations.length} hallucinated`)
      : chalk.green("0 hallucinated")),
  );

  for (const h of hallucinations) {
    const suggestion = h.suggestion ? chalk.dim(` (did you mean ${h.suggestion}?)`) : "";
    console.log(chalk.red(`   ✗ ${h.raw}`) + chalk.dim(` — ${h.hallucinationCategory}`) + suggestion);
  }

  // Show valid ref summary by category
  const { byCategory } = analysis;
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
    console.log(chalk.dim(`   Valid: ${parts.join(", ")}`));
  }

  console.log();
}

/** Format static analysis findings as a markdown section for LLM context. */
export function formatStaticFindings(
  pathAnalysis?: PathAnalysis,
  schemaAnalysis?: SchemaAnalysis,
): string | undefined {
  const sections: string[] = [];

  if (pathAnalysis && pathAnalysis.hallucinatedPaths.length > 0) {
    const lines = [
      `### File Path Issues`,
      ``,
      `Static analysis found ${pathAnalysis.hallucinatedPaths.length} file path(s) that do not exist in the project:`,
      ``,
    ];
    for (const p of pathAnalysis.hallucinatedPaths) {
      lines.push(`- \`${p}\` — **NOT FOUND** in project tree`);
    }
    sections.push(lines.join("\n"));
  }

  if (schemaAnalysis && schemaAnalysis.hallucinations.length > 0) {
    const lines = [
      `### Schema Issues`,
      ``,
      `Static analysis found ${schemaAnalysis.hallucinations.length} Prisma schema hallucination(s):`,
      ``,
    ];
    for (const h of schemaAnalysis.hallucinations) {
      const suggestion = h.suggestion ? ` (did you mean \`${h.suggestion}\`?)` : "";
      lines.push(`- \`${h.raw}\` — ${h.hallucinationCategory}${suggestion}`);
    }
    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) return undefined;

  return `## Static Analysis Findings\n\nThe following issues were detected by static analysis before this review. Confirm or elaborate on these findings.\n\n${sections.join("\n\n")}`;
}
