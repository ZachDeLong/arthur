import { buildContext } from "../../src/context/builder.js";
import { buildUserMessage, getSystemPrompt } from "../naive-prompt.js";
import { streamVerification } from "../../src/verifier/client.js";

export interface VerificationResult {
  output: string;
  inputTokens: number;
  outputTokens: number;
}

/** Run the codeverifier pipeline against a fixture project. */
export async function runVerification(
  planText: string,
  fixtureDir: string,
  apiKey: string,
  model: string,
  taskDescription?: string,
): Promise<VerificationResult> {
  // Build context with the full fixture tree (verifier sees everything)
  const context = buildContext({
    projectDir: fixtureDir,
    planText,
    prompt: taskDescription,
    tokenBudget: 80_000,
  });

  const systemPrompt = getSystemPrompt();
  const userMessage = buildUserMessage(context);

  // Collect the streamed output
  const chunks: string[] = [];
  const result = await streamVerification({
    apiKey,
    model,
    systemPrompt,
    userMessage,
    onText: (text) => {
      chunks.push(text);
    },
  });

  return {
    output: chunks.join(""),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}
