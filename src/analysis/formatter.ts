import chalk from "chalk";
import type { PathAnalysis } from "./path-checker.js";
import type { SchemaAnalysis } from "./schema-checker.js";
import type { ImportAnalysis } from "./import-checker.js";
import type { EnvAnalysis } from "./env-checker.js";
import type { TypeAnalysis } from "./type-checker.js";
import type { ApiRouteAnalysis } from "./api-route-checker.js";
import type { SqlSchemaAnalysis } from "./sql-schema-checker.js";
import type { SupabaseSchemaAnalysis } from "./supabase-schema-checker.js";
import { getCheckers, type CheckerResult } from "./registry.js";

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

/** Print static import analysis results to the console. */
export function printImportAnalysis(analysis: ImportAnalysis): void {
  const { checkedImports, hallucinations, skippedImports } = analysis;

  console.log(
    chalk.bold.cyan("── Static Analysis: Imports ") +
    chalk.dim("─".repeat(33)),
  );

  console.log(
    chalk.dim(`   ${checkedImports} checked, ${skippedImports} skipped, `) +
    (hallucinations.length > 0
      ? chalk.red(`${hallucinations.length} hallucinated`)
      : chalk.green("0 hallucinated")),
  );

  for (const h of hallucinations) {
    const reason = h.reason === "package-not-found" ? "package not found" : "subpath not exported";
    const suggestion = h.suggestion ? chalk.dim(` (${h.suggestion})`) : "";
    console.log(chalk.red(`   ✗ ${h.raw}`) + chalk.dim(` — ${reason}`) + suggestion);
  }

  console.log();
}

/** Print static env analysis results to the console. */
export function printEnvAnalysis(analysis: EnvAnalysis): void {
  const { checkedRefs, hallucinations, skippedRefs, envFilesFound } = analysis;

  console.log(
    chalk.bold.cyan("── Static Analysis: Env Variables ") +
    chalk.dim("─".repeat(27)),
  );

  console.log(
    chalk.dim(`   ${checkedRefs} checked, ${skippedRefs} skipped (runtime), `) +
    (hallucinations.length > 0
      ? chalk.red(`${hallucinations.length} hallucinated`)
      : chalk.green("0 hallucinated")),
  );

  console.log(chalk.dim(`   Sources: ${envFilesFound.join(", ")}`));

  for (const h of hallucinations) {
    const suggestion = h.suggestion ? chalk.dim(` (did you mean ${h.suggestion}?)`) : "";
    console.log(chalk.red(`   ✗ ${h.varName}`) + chalk.dim(" — not in env files") + suggestion);
  }

  console.log();
}

/** Print static type analysis results to the console. */
export function printTypeAnalysis(analysis: TypeAnalysis): void {
  const { checkedRefs, hallucinations, skippedRefs, byCategory } = analysis;

  console.log(
    chalk.bold.cyan("── Static Analysis: TypeScript Types ") +
    chalk.dim("─".repeat(23)),
  );

  console.log(
    chalk.dim(`   ${checkedRefs} checked, ${skippedRefs} skipped (builtins), `) +
    (hallucinations.length > 0
      ? chalk.red(`${hallucinations.length} hallucinated`)
      : chalk.green("0 hallucinated")),
  );

  for (const h of hallucinations) {
    const category = h.hallucinationCategory === "hallucinated-type" ? "type not found" : "member not found";
    const suggestion = h.suggestion ? chalk.dim(` (${h.suggestion})`) : "";
    console.log(chalk.red(`   ✗ ${h.raw}`) + chalk.dim(` — ${category}`) + suggestion);
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
    console.log(chalk.dim(`   Valid: ${parts.join(", ")}`));
  }

  console.log();
}

/** Print static API route analysis results to the console. */
export function printApiRouteAnalysis(analysis: ApiRouteAnalysis): void {
  const { checkedRefs, hallucinations, routesIndexed } = analysis;

  console.log(
    chalk.bold.cyan("── Static Analysis: API Routes ") +
    chalk.dim("─".repeat(30)),
  );

  console.log(
    chalk.dim(`   ${checkedRefs} checked, ${routesIndexed} routes indexed, `) +
    (hallucinations.length > 0
      ? chalk.red(`${hallucinations.length} hallucinated`)
      : chalk.green("0 hallucinated")),
  );

  for (const h of hallucinations) {
    const category = h.hallucinationCategory === "hallucinated-route" ? "route not found" : "method not allowed";
    const method = h.method ? `${h.method} ` : "";
    const suggestion = h.suggestion ? chalk.dim(` (${h.suggestion})`) : "";
    console.log(chalk.red(`   ✗ ${method}${h.urlPath}`) + chalk.dim(` — ${category}`) + suggestion);
  }

  console.log();
}

/** Print static SQL schema analysis results to the console. */
export function printSqlSchemaAnalysis(analysis: SqlSchemaAnalysis): void {
  const { checkedRefs, hallucinations, tablesIndexed, byCategory } = analysis;

  console.log(
    chalk.bold.cyan("── Static Analysis: SQL Schema ") +
    chalk.dim("─".repeat(30)),
  );

  console.log(
    chalk.dim(`   ${checkedRefs} checked, ${tablesIndexed} tables indexed, `) +
    (hallucinations.length > 0
      ? chalk.red(`${hallucinations.length} hallucinated`)
      : chalk.green("0 hallucinated")),
  );

  for (const h of hallucinations) {
    const category = h.hallucinationCategory === "hallucinated-table" ? "table not found" : "column not found";
    const suggestion = h.suggestion ? chalk.dim(` (${h.suggestion})`) : "";
    console.log(chalk.red(`   ✗ ${h.raw}`) + chalk.dim(` — ${category}`) + suggestion);
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
    console.log(chalk.dim(`   Valid: ${parts.join(", ")}`));
  }

  console.log();
}

/**
 * Format static analysis findings as a markdown section for LLM context.
 * Registry-driven: loops over all registered checkers and calls formatForFindings().
 */
export function formatStaticFindings(
  results: Map<string, CheckerResult>,
): string | undefined {
  const sections: string[] = [];

  for (const checker of getCheckers()) {
    const result = results.get(checker.id);
    if (!result) continue;
    const section = checker.formatForFindings(result);
    if (section) sections.push(section);
  }

  if (sections.length === 0) return undefined;

  return `## Static Analysis Findings\n\nThe following issues were detected by static analysis before this review. Confirm or elaborate on these findings.\n\n${sections.join("\n\n")}`;
}
