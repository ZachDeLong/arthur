/**
 * Snapshot of the naive (unprompted) verifier prompt used as the benchmark
 * baseline. This is the original prompt before path-verification instructions
 * were added to the production prompt in src/verifier/prompt.ts.
 *
 * DO NOT MODIFY — this preserves the baseline so benchmark results stay
 * comparable across runs.
 */

import type { ProjectContext } from "../src/context/builder.js";

const NAIVE_SYSTEM_PROMPT = `You are an independent senior engineer conducting a plan review. You have NOT seen the coding conversation that produced this plan — you are a fresh pair of eyes providing an objective assessment.

Your role is to be a skeptical but constructive reviewer. Analyze the plan thoroughly and provide honest, actionable feedback.

Review the plan for:
- **Alignment with user intent**: Does the plan actually solve what the user asked for?
- **Completeness**: Are there missing steps, features, or considerations?
- **Correctness**: Are there logic errors, wrong assumptions, or flawed approaches?
- **Edge cases and error conditions**: What could go wrong?
- **Security concerns**: Are there any security vulnerabilities or risks?
- **Project convention adherence**: Does it follow the project's established patterns (from README/CLAUDE.md)?
- **Risk assessment**: What are the riskiest parts of this plan?

Be direct and specific. If something looks wrong, say so clearly. If the plan looks solid, say that too — but always look critically. Organize your feedback however makes sense for the plan you're reviewing.`;

/** Build the user message with the original section order (tree last). */
export function buildUserMessage(context: ProjectContext): string {
  const sections: string[] = [];

  if (context.prompt) {
    sections.push(`## Original User Request\n\n${context.prompt}`);
  }

  sections.push(`## Plan to Review\n\n${context.planText}`);

  if (context.readme) {
    sections.push(`## Project README\n\n${context.readme}`);
  }

  if (context.claudeMd) {
    sections.push(`## Project Guidelines (CLAUDE.md)\n\n${context.claudeMd}`);
  }

  if (context.sessionFeedback) {
    sections.push(
      `## Prior Verification Feedback\n\nThis plan was previously reviewed. Here is the prior feedback for reference:\n\n${context.sessionFeedback}`,
    );
  }

  if (context.referencedFiles.size > 0) {
    const fileSection = ["## Referenced Source Files\n"];
    for (const [filePath, content] of context.referencedFiles) {
      fileSection.push(`### ${filePath}\n\n\`\`\`\n${content}\n\`\`\``);
    }
    sections.push(fileSection.join("\n"));
  }

  sections.push(`## Project Structure\n\n\`\`\`\n${context.tree}\n\`\`\``);

  return sections.join("\n\n---\n\n");
}

export function getSystemPrompt(): string {
  return NAIVE_SYSTEM_PROMPT;
}
