import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENAI_BENCHMARK_MODEL,
  formatBenchmarkModel,
  resolveBenchmarkLlm,
} from "../bench/harness/llm-provider.js";

describe("benchmark LLM provider resolution", () => {
  it("uses OpenAI when it is the only configured provider", () => {
    const result = resolveBenchmarkLlm({
      anthropicModel: "claude-test",
      env: { OPENAI_API_KEY: "openai-secret" },
    });

    expect(result).toEqual({
      provider: "openai",
      apiKey: "openai-secret",
      model: DEFAULT_OPENAI_BENCHMARK_MODEL,
    });
    expect(formatBenchmarkModel(result)).toBe(
      `openai/${DEFAULT_OPENAI_BENCHMARK_MODEL}`,
    );
  });

  it("supports an explicit OpenAI model override", () => {
    const result = resolveBenchmarkLlm({
      anthropicModel: "claude-test",
      env: {
        OPENAI_API_KEY: "openai-secret",
        ARTHUR_BENCH_PROVIDER: "openai",
        ARTHUR_BENCH_MODEL: "gpt-test",
      },
    });

    expect(result.model).toBe("gpt-test");
  });

  it("preserves Anthropic as the default when both keys are present", () => {
    const result = resolveBenchmarkLlm({
      anthropicApiKey: "sk-ant-test-secret",
      anthropicModel: "claude-test",
      env: { OPENAI_API_KEY: "openai-secret" },
    });

    expect(result).toEqual({
      provider: "anthropic",
      apiKey: "sk-ant-test-secret",
      model: "claude-test",
    });
  });

  it("rejects a non-Claude value before making an Anthropic request", () => {
    expect(() =>
      resolveBenchmarkLlm({
        anthropicApiKey: "not-a-claude-key",
        anthropicModel: "claude-test",
        env: {},
      }),
    ).toThrow("expected a value beginning with 'sk-ant-'");
  });

  it("fails clearly when no provider key is configured", () => {
    expect(() =>
      resolveBenchmarkLlm({
        anthropicModel: "claude-test",
        env: {},
      }),
    ).toThrow("Set OPENAI_API_KEY or ANTHROPIC_API_KEY");
  });

  it("fails when an unsupported provider is requested", () => {
    expect(() =>
      resolveBenchmarkLlm({
        anthropicModel: "claude-test",
        env: { ARTHUR_BENCH_PROVIDER: "unknown" },
      }),
    ).toThrow("ARTHUR_BENCH_PROVIDER");
  });
});
