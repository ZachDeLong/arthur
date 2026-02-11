import Anthropic from "@anthropic-ai/sdk";

export interface StreamOptions {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
  onText: (text: string) => void;
}

export interface StreamResult {
  inputTokens: number;
  outputTokens: number;
}

/** Stream a verification request to the Anthropic API. */
export async function streamVerification(
  options: StreamOptions,
): Promise<StreamResult> {
  const client = new Anthropic({ apiKey: options.apiKey });

  const stream = client.messages.stream({
    model: options.model,
    max_tokens: 8192,
    system: options.systemPrompt,
    messages: [{ role: "user", content: options.userMessage }],
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      options.onText(event.delta.text);
    }
  }

  const finalMessage = await stream.finalMessage();

  return {
    inputTokens: finalMessage.usage.input_tokens,
    outputTokens: finalMessage.usage.output_tokens,
  };
}
