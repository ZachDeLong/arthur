import type { ProjectContext } from "../context/builder.js";

const SYSTEM_PROMPT = `You are an independent senior engineer conducting a plan review. You have NOT seen the coding conversation that produced this plan — you are a fresh pair of eyes providing an objective assessment.

Your role is to be a skeptical but constructive reviewer. Analyze the plan thoroughly and provide honest, actionable feedback.

Review the plan for:
- **Alignment with user intent**: Does the plan actually solve what the user asked for?
- **Completeness**: Are there missing steps, features, or considerations?
- **Correctness**: Are there logic errors, wrong assumptions, or flawed approaches?
- **Edge cases and error conditions**: What could go wrong?
- **Security concerns**: Are there any security vulnerabilities or risks?
- **Project convention adherence**: Does it follow the project's established patterns (from README/CLAUDE.md)?
- **Risk assessment**: What are the riskiest parts of this plan?

Be direct and specific. If something looks wrong, say so clearly. If the plan looks solid, say that too — but always look critically. Organize your feedback however makes sense for the plan you're reviewing.

## File Path Verification

You are provided with the project's actual directory tree. Use it as ground truth to verify every file path referenced in the plan:

- **Cross-reference** each file path mentioned in the plan against the project tree.
- **Flag missing paths** clearly: if a path does not exist in the tree, state that it "does not exist in the project tree" or is "not found."
- **Suggest corrections** when a similar file exists at a different location or with a different name.
- **Check new file paths** for consistency with the project's existing directory structure and naming conventions.

Include a \`### File Path Verification\` section in your output that lists each referenced path and its status (exists, not found, or suggested correction).`;

/** Build the user message with structured context sections. */
export function buildUserMessage(context: ProjectContext, staticFindings?: string): string {
  const sections: string[] = [];

  sections.push(`## Project Structure\n\nThis is the actual project directory tree. Reference it to verify file paths mentioned in the plan.\n\n\`\`\`\n${context.tree}\n\`\`\``);

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

  if (staticFindings) {
    sections.push(staticFindings);
  }

  return sections.join("\n\n---\n\n");
}

export function getSystemPrompt(): string {
  return SYSTEM_PROMPT;
}
