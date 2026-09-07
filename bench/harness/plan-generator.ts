import fs from "node:fs";
import path from "node:path";
import {
  runBenchmarkLlm,
  type BenchmarkLlmProvider,
} from "./llm-provider.js";
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

export interface PlanGenerationOptions {
  provider?: BenchmarkLlmProvider;
  maxOutputTokens?: number;
  anthropicThinking?: "adaptive" | "disabled";
  anthropicEffort?: "low" | "medium" | "high" | "max";
}

/** Generate an implementation plan using the selected model with README-only context. */
export async function generatePlan(
  prompt: PromptDefinition,
  fixtureDir: string,
  apiKey: string,
  model: string,
  options: PlanGenerationOptions = {},
): Promise<PlanGenerationResult> {
  const readmePath = path.join(fixtureDir, "README.md");
  const readme = fs.readFileSync(readmePath, "utf-8");

  const userMessage = `## Project README

${readme}

---

## Task

${prompt.task}`;

  const response = await runBenchmarkLlm({
    provider: options.provider ?? "anthropic",
    apiKey,
    model,
    maxOutputTokens: options.maxOutputTokens ?? 4096,
    anthropicThinking: options.anthropicThinking,
    anthropicEffort: options.anthropicEffort,
    systemPrompt: `${PLAN_SYSTEM_PROMPT}\n\n${prompt.systemContext}`,
    userMessage,
  });

  return {
    plan: response.output,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
  };
}
