import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { PromptDefinition } from "./types.js";

const PLAN_SYSTEM_PROMPT = `You are a senior software engineer creating an implementation plan. You have access ONLY to the project README below — you do NOT have access to the actual file tree or source code.

IMPORTANT: When your plan references an existing file to modify, use "Modify" or "Update". When proposing a new file, use "Create" or "Add". Be explicit about which files already exist vs. which ones you are proposing to create.

Create a detailed, actionable implementation plan with:
1. Concrete file paths for every file you reference
2. Clear indication of whether each file is being modified or created
3. Key code changes or additions needed
4. Integration points with existing code
5. Testing considerations

Be specific with file paths — use the full relative path from the project root.`;

export interface PlanGenerationResult {
  plan: string;
  inputTokens: number;
  outputTokens: number;
}

/** Generate an implementation plan using Claude with README-only context. */
export async function generatePlan(
  prompt: PromptDefinition,
  fixtureDir: string,
  apiKey: string,
  model: string,
): Promise<PlanGenerationResult> {
  const readmePath = path.join(fixtureDir, "README.md");
  const readme = fs.readFileSync(readmePath, "utf-8");

  const client = new Anthropic({ apiKey });

  const userMessage = `## Project README

${readme}

---

## Task

${prompt.task}`;

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: `${PLAN_SYSTEM_PROMPT}\n\n${prompt.systemContext}`,
    messages: [{ role: "user", content: userMessage }],
  });

  const plan = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return {
    plan,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
