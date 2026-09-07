import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export type BenchmarkLlmProvider = "anthropic" | "openai";

export interface BenchmarkLlmOptions {
  provider: BenchmarkLlmProvider;
  apiKey: string;
  model: string;
}

export interface BenchmarkLlmResult {
  responseId: string;
  output: string;
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported model identifier, retained to distinguish rolling aliases from snapshots. */
  model: string;
}

interface ResolveBenchmarkLlmOptions {
  anthropicApiKey?: string;
  anthropicModel: string;
  env?: Record<string, string | undefined>;
}

interface RunBenchmarkLlmOptions extends BenchmarkLlmOptions {
  systemPrompt: string;
  userMessage: string;
  maxOutputTokens: number;
  anthropicThinking?: "adaptive" | "disabled";
  anthropicEffort?: "low" | "medium" | "high" | "max";
}

export const DEFAULT_OPENAI_BENCHMARK_MODEL = "gpt-5";

/** Resolve the benchmark provider without ever persisting an API key. */
export function resolveBenchmarkLlm(
  options: ResolveBenchmarkLlmOptions,
): BenchmarkLlmOptions {
  const env = options.env ?? process.env;
  const requestedProvider = env.ARTHUR_BENCH_PROVIDER?.trim().toLowerCase();

  if (
    requestedProvider &&
    requestedProvider !== "anthropic" &&
    requestedProvider !== "openai"
  ) {
    throw new Error(
      "ARTHUR_BENCH_PROVIDER must be either 'anthropic' or 'openai'.",
    );
  }

  const anthropicApiKey =
    options.anthropicApiKey?.trim() || env.ANTHROPIC_API_KEY?.trim();
  const openaiApiKey = env.OPENAI_API_KEY?.trim();
  const provider =
    (requestedProvider as BenchmarkLlmProvider | undefined) ??
    (openaiApiKey && !anthropicApiKey ? "openai" : "anthropic");

  if (provider === "openai") {
    if (!openaiApiKey) {
      throw new Error(
        "OpenAI benchmark provider selected, but OPENAI_API_KEY is not set.",
      );
    }

    return {
      provider,
      apiKey: openaiApiKey,
      model:
        env.ARTHUR_BENCH_MODEL?.trim() ||
        env.OPENAI_MODEL?.trim() ||
        DEFAULT_OPENAI_BENCHMARK_MODEL,
    };
  }

  if (!anthropicApiKey) {
    throw new Error(
      "No benchmark API key found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.",
    );
  }

  if (!anthropicApiKey.startsWith("sk-ant-")) {
    throw new Error(
      "ANTHROPIC_API_KEY does not look like a Claude API key; expected a value beginning with 'sk-ant-'.",
    );
  }

  return {
    provider,
    apiKey: anthropicApiKey,
    model: env.ARTHUR_BENCH_MODEL?.trim() || options.anthropicModel,
  };
}

export function formatBenchmarkModel(options: BenchmarkLlmOptions): string {
  return `${options.provider}/${options.model}`;
}

/** Run one non-streaming benchmark prompt through the selected provider. */
export async function runBenchmarkLlm(
  options: RunBenchmarkLlmOptions,
): Promise<BenchmarkLlmResult> {
  if (options.provider === "openai") {
    const client = new OpenAI({ apiKey: options.apiKey });
    const response = await client.responses.create({
      model: options.model,
      instructions: options.systemPrompt,
      input: options.userMessage,
      max_output_tokens: options.maxOutputTokens,
      store: false,
    });

    const output = response.output_text.trim();
    if (!output) {
      throw new Error("OpenAI returned no text for the benchmark prompt.");
    }

    return {
      responseId: response.id,
      output,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      model: response.model,
    };
  }

  const client = new Anthropic({ apiKey: options.apiKey });
  const thinking =
    options.anthropicThinking === "adaptive"
      ? ({ type: "adaptive" } as const)
      : options.anthropicThinking === "disabled"
        ? ({ type: "disabled" } as const)
        : undefined;
  const response = await client.messages.create({
    model: options.model,
    max_tokens: options.maxOutputTokens,
    system: options.systemPrompt,
    messages: [{ role: "user", content: options.userMessage }],
    thinking,
    output_config: options.anthropicEffort
      ? { effort: options.anthropicEffort }
      : undefined,
  });

  const output = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `Anthropic reached the ${options.maxOutputTokens}-token output limit; refusing to score a truncated benchmark response.`,
    );
  }

  if (!output) {
    throw new Error(
      `Anthropic returned no text for the benchmark prompt (stop reason: ${response.stop_reason ?? "unknown"}).`,
    );
  }

  return {
    responseId: response.id,
    output,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model: response.model,
  };
}
