import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { loadConfig } from "../../src/config/manager.js";
import {
  formatBenchmarkModel,
  resolveBenchmarkLlm,
  runBenchmarkLlm,
  type BenchmarkLlmOptions,
} from "../harness/llm-provider.js";
import { repoRoot } from "./corpus.js";
import type {
  PairedCase,
  PairedCategory,
  PairedOutcome,
  PairedPrediction,
  PredictionRun,
} from "./types.js";

const OUTCOMES = new Set<PairedOutcome>(["error", "clean", "ignored"]);

function stableOrder(cases: PairedCase[], repetition: number): PairedCase[] {
  return [...cases].sort((a, b) => {
    const aKey = crypto.createHash("sha256").update(`${repetition}:${a.id}`).digest("hex");
    const bKey = crypto.createHash("sha256").update(`${repetition}:${b.id}`).digest("hex");
    return aKey.localeCompare(bKey);
  });
}

function buildFacts(category: PairedCategory): string {
  if (category === "import") {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    return [
      "Project: repository root",
      "Installed direct runtime packages:",
      ...Object.keys(pkg.dependencies ?? {}).sort().map((name) => `- ${name}`),
    ].join("\n");
  }

  if (category === "env") {
    const projects = ["bench/fixtures/fixture-b", "bench/fixtures/fixture-c", "bench/fixtures/fixture-d"];
    const sections: string[] = [];
    for (const project of projects) {
      const absolute = path.join(repoRoot, project);
      const envFile = fs.readdirSync(absolute).find((name) => name.startsWith(".env"));
      if (!envFile) continue;
      sections.push(`Project: ${project}`);
      sections.push(fs.readFileSync(path.join(absolute, envFile), "utf-8").trim());
    }
    return sections.join("\n\n");
  }

  return [
    "Project: bench/fixtures/fixture-c",
    "Existing Next.js App Router endpoints:",
    "- GET /api/content",
    "- POST /api/content",
    "- GET /api/participants",
    "- POST /api/participants",
  ].join("\n");
}

function buildPrompt(category: PairedCategory, cases: PairedCase[]): string {
  return [
    "Classify each JavaScript/TypeScript snippet using only reference integrity.",
    "",
    "Outcomes:",
    '- "error": a live static package import, env variable, or API route contradicts the supplied project facts.',
    '- "clean": the snippet contains a live static reference that exists in the supplied project facts.',
    '- "ignored": the apparent reference occurs only in a comment or documentation string and is not executed.',
    "",
    "Do not judge style, default exports, TypeScript types, architecture, or whether an env value is secret.",
    "Return JSON only, with exactly one item per supplied id:",
    '{"predictions":[{"id":"case-id","outcome":"error|clean|ignored","reason":"brief factual reason"}]}',
    "",
    "PROJECT FACTS",
    buildFacts(category),
    "",
    "BLINDED CASES",
    JSON.stringify(cases.map(({ id, projectDir, source }) => ({ id, projectDir, source }))),
  ].join("\n");
}

function parsePredictions(output: string, cases: PairedCase[]): PairedPrediction[] {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Claude response did not contain a JSON object.");
  const parsed = JSON.parse(output.slice(start, end + 1)) as {
    predictions?: Array<{ id?: unknown; outcome?: unknown; reason?: unknown }>;
  };
  if (!Array.isArray(parsed.predictions)) throw new Error("Claude response omitted predictions[].");

  const expectedIds = new Set(cases.map((testCase) => testCase.id));
  const seen = new Set<string>();
  const predictions: PairedPrediction[] = [];
  for (const item of parsed.predictions) {
    if (typeof item.id !== "string" || !expectedIds.has(item.id)) {
      throw new Error(`Claude returned an unknown case id: ${String(item.id)}`);
    }
    if (seen.has(item.id)) throw new Error(`Claude returned duplicate id: ${item.id}`);
    if (typeof item.outcome !== "string" || !OUTCOMES.has(item.outcome as PairedOutcome)) {
      throw new Error(`Claude returned an invalid outcome for ${item.id}`);
    }
    seen.add(item.id);
    predictions.push({
      id: item.id,
      outcome: item.outcome as PairedOutcome,
      reason: typeof item.reason === "string" ? item.reason : "",
    });
  }

  const missing = [...expectedIds].filter((id) => !seen.has(id));
  if (missing.length > 0) throw new Error(`Claude omitted ${missing.length} ids: ${missing.join(", ")}`);
  return predictions.sort((a, b) => a.id.localeCompare(b.id));
}

async function predictCategory(
  llm: BenchmarkLlmOptions,
  category: PairedCategory,
  cases: PairedCase[],
): Promise<{ predictions: PairedPrediction[]; inputTokens: number; outputTokens: number }> {
  const result = await runBenchmarkLlm({
    ...llm,
    systemPrompt: "You are a precise, conservative reference-integrity classifier. Follow the supplied definitions exactly and return only valid JSON.",
    userMessage: buildPrompt(category, cases),
    maxOutputTokens: 16_000,
    anthropicThinking: "adaptive",
    anthropicEffort: "medium",
  });
  return {
    predictions: parsePredictions(result.output, cases),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

export async function predictWithClaude(
  cases: PairedCase[],
  corpusSha256: string,
  repetition: number,
  llm?: BenchmarkLlmOptions,
): Promise<PredictionRun> {
  const config = loadConfig(repoRoot);
  const resolvedLlm = llm ?? resolveBenchmarkLlm({
    anthropicApiKey: config.apiKey,
    anthropicModel: config.model,
  });
  const started = performance.now();
  const predictions: PairedPrediction[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (const category of ["import", "env", "route"] as const) {
    const categoryCases = stableOrder(
      cases.filter((testCase) => testCase.category === category),
      repetition,
    );
    const result = await predictCategory(resolvedLlm, category, categoryCases);
    predictions.push(...result.predictions);
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;
  }

  return {
    system: formatBenchmarkModel(resolvedLlm),
    corpusSha256,
    repetition,
    predictions: predictions.sort((a, b) => a.id.localeCompare(b.id)),
    inputTokens,
    outputTokens,
    durationMs: performance.now() - started,
  };
}
