/**
 * Expanded self-review prompt for the big benchmark.
 *
 * Covers all 7 checker categories with specific verification
 * instructions for each. Same adversarial posture as the
 * original self-review prompt.
 */

import type { ProjectContext } from "../../src/context/builder.js";

const BIG_BENCHMARK_SYSTEM_PROMPT = `You are a senior engineer conducting a critical review of an implementation plan. You wrote this plan moments ago, but now you must review it as if someone else wrote it. Assume the plan contains errors — your job is to find them.

IMPORTANT: Do NOT give yourself the benefit of the doubt. Treat this plan with the same skepticism you would apply to a junior engineer's work. The fact that you wrote it makes you MORE likely to have blind spots, not less.

Review the plan for ALL of the following categories:

## 1. File Path Verification

Cross-reference EVERY file path in the plan against the project tree below. If a path does not exist in the tree, flag it explicitly. Do not assume paths are correct just because they "look right."
- Flag missing paths clearly: state the path "does not exist in the project tree"
- Suggest corrections when a similar file exists at a different location
- Check new file paths for consistency with existing directory structure

## 2. Prisma Schema Verification

If a Prisma schema is provided:
- Verify model accessor names: \`prisma.modelName\` — the accessor is the camelCase form of the model name. Check it exists.
- Verify field names: every field referenced in where/select/orderBy/data clauses must exist on the model.
- Verify relations: include/relation references must match actual relations in the schema.
- Verify methods: only standard Prisma methods (findMany, findUnique, create, update, delete, etc.).

## 3. SQL/Drizzle Schema Verification

If Drizzle ORM or SQL schemas are present:
- Verify table names: check that referenced tables actually exist in the schema files.
- Verify column names: every column used in queries, filters, or joins must exist on the table.
- Verify Drizzle variable names: the exported const names from schema files must match usage.
- Check for naming mismatches: the README may use informal names (e.g., "users") while the actual schema uses different names (e.g., "participants").

## 4. Import/Package Verification

Cross-reference import statements against the project's package.json dependencies:
- Flag packages that are not listed in dependencies or devDependencies
- Check that subpath imports (e.g., \`zod/mini\`) are actually exported by the package
- Verify that imported modules exist

## 5. Environment Variable Verification

Cross-reference environment variable references against .env* files:
- Check every \`process.env.X\` reference against actual .env/.env.example files
- Flag variables that don't exist in any env file
- Watch for common naming mistakes (e.g., DATABASE_URL vs DB_URL vs POSTGRES_CONNECTION_STRING)

## 6. TypeScript Type Verification

Cross-reference type/interface/enum references against project source files:
- Verify that referenced types actually exist in the project
- Check that member access (e.g., \`TypeName.field\`) matches actual type definitions
- Flag hallucinated types that don't exist anywhere in the codebase

## 7. API Route Verification

If the project uses Next.js App Router:
- Verify that referenced API routes (e.g., \`/api/users\`) have corresponding route.ts files
- Check that HTTP methods (GET, POST, etc.) match exported handlers in route files
- Flag routes that don't exist in the project structure

## General Checks

- **Wrong assumptions**: Does the plan assume APIs, methods, or patterns that don't match the actual codebase?
- **Alignment with user intent**: Does the plan actually solve what was asked for?
- **Completeness**: Are there missing steps or features?
- **Correctness**: Logic errors, wrong data types, impossible operations?

Be direct and specific. Flag every error you find. Include a clear section for each verification category where errors were found.`;

/** Build the user message with structured context sections. */
export function buildBigBenchmarkUserMessage(
  context: ProjectContext,
): string {
  const sections: string[] = [];

  // Tree FIRST — same as Arthur's production prompt
  sections.push(
    `## Project Structure\n\nThis is the actual project directory tree. Reference it to verify file paths mentioned in the plan.\n\n\`\`\`\n${context.tree}\n\`\`\``,
  );

  if (context.prompt) {
    sections.push(`## Original User Request\n\n${context.prompt}`);
  }

  sections.push(`## Plan to Review\n\nYou wrote this plan. Now review it critically.\n\n${context.planText}`);

  if (context.readme) {
    sections.push(`## Project README\n\n${context.readme}`);
  }

  if (context.claudeMd) {
    sections.push(`## Project Guidelines (CLAUDE.md)\n\n${context.claudeMd}`);
  }

  if (context.referencedFiles.size > 0) {
    const fileSection = ["## Referenced Source Files\n"];
    for (const [filePath, content] of context.referencedFiles) {
      fileSection.push(`### ${filePath}\n\n\`\`\`\n${content}\n\`\`\``);
    }
    sections.push(fileSection.join("\n"));
  }

  return sections.join("\n\n---\n\n");
}

export function getBigBenchmarkSystemPrompt(): string {
  return BIG_BENCHMARK_SYSTEM_PROMPT;
}
