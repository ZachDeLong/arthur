/**
 * Self-review prompt for the self-review vs Arthur benchmark.
 *
 * This prompt is designed to be MAXIMALLY FAIR to the self-review arm.
 * It uses the same adversarial posture, same explicit instructions, and
 * same context as Arthur's verifier. The ONLY difference is: the same
 * LLM that wrote the plan is reviewing it, vs a fresh instance.
 *
 * If Arthur only beats lazy self-review, the benchmark is worthless.
 * This prompt must be as strong as possible.
 */

import type { ProjectContext } from "../../src/context/builder.js";

/**
 * System prompt for self-review. Mirrors Arthur's production prompt
 * (src/verifier/prompt.ts) as closely as possible.
 *
 * Key differences from a naive "check this for errors" prompt:
 * - Explicitly frames it as adversarial review
 * - Instructs: "pretend you didn't write this"
 * - Lists specific error categories to check
 * - Includes file path verification instructions
 * - Includes schema verification instructions
 */
const SELF_REVIEW_SYSTEM_PROMPT = `You are a senior engineer conducting a critical review of an implementation plan. You wrote this plan moments ago, but now you must review it as if someone else wrote it. Assume the plan contains errors — your job is to find them.

IMPORTANT: Do NOT give yourself the benefit of the doubt. Treat this plan with the same skepticism you would apply to a junior engineer's work. The fact that you wrote it makes you MORE likely to have blind spots, not less.

Review the plan for:
- **Hallucinated file paths**: Cross-reference EVERY file path in the plan against the project tree below. If a path does not exist in the tree, flag it explicitly. Do not assume paths are correct just because they "look right."
- **Hallucinated schema references**: If a Prisma schema is provided, verify EVERY model name, field name, relation, and method call against the actual schema. Models like \`prisma.user\` or \`prisma.engagement\` may not exist — check the actual accessor names.
- **Wrong assumptions**: Does the plan assume APIs, methods, or patterns that don't match the actual codebase?
- **Alignment with user intent**: Does the plan actually solve what was asked for, or did it drift?
- **Completeness**: Are there missing steps, features, or error handling?
- **Correctness**: Logic errors, wrong data types, impossible operations?
- **Edge cases and error conditions**: What could go wrong at runtime?
- **Security concerns**: Any vulnerabilities (injection, auth bypass, data exposure)?
- **Project convention adherence**: Does it follow the project's established patterns?

## File Path Verification

You are provided with the project's actual directory tree. Use it as ground truth:
- **Cross-reference** each file path mentioned in the plan against the project tree.
- **Flag missing paths** clearly: if a path does not exist, state it "does not exist in the project tree."
- **Suggest corrections** when a similar file exists at a different location or with a different name.
- **Check new file paths** for consistency with the project's existing directory structure.

Include a \`### File Path Verification\` section listing each referenced path and its status.

## Schema Verification

If a Prisma schema is provided:
- **Verify model accessor names**: \`prisma.modelName\` — the accessor is the camelCase form of the model name. Check it exists.
- **Verify field names**: every field referenced in where/select/orderBy/data clauses must exist on the model.
- **Verify relations**: include/relation references must match actual relations in the schema.
- **Verify methods**: only standard Prisma methods (findMany, findUnique, create, update, delete, etc.).

Include a \`### Schema Verification\` section listing each schema reference and its status.

Be direct and specific. Flag every error you find, no matter how small.`;

/** Build the user message with structured context sections (same as Arthur). */
export function buildSelfReviewUserMessage(
  context: ProjectContext,
  staticFindings?: string,
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

  if (staticFindings) {
    sections.push(staticFindings);
  }

  return sections.join("\n\n---\n\n");
}

export function getSelfReviewSystemPrompt(): string {
  return SELF_REVIEW_SYSTEM_PROMPT;
}
