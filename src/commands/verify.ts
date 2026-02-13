import path from "node:path";
import { loadConfig } from "../config/manager.js";
import { loadPlan } from "../plan/loader.js";
import { buildContext } from "../context/builder.js";
import { buildUserMessage, getSystemPrompt } from "../verifier/prompt.js";
import { streamVerification } from "../verifier/client.js";
import { createRenderer } from "../verifier/renderer.js";
import { loadLastFeedback, saveSession } from "../session/store.js";
import { analyzePaths } from "../analysis/path-checker.js";
import { parseSchema, analyzeSchema } from "../analysis/schema-checker.js";
import { analyzeImports } from "../analysis/import-checker.js";
import { analyzeEnv } from "../analysis/env-checker.js";
import { analyzeTypes } from "../analysis/type-checker.js";
import { analyzeApiRoutes } from "../analysis/api-route-checker.js";
import { analyzeSqlSchema } from "../analysis/sql-schema-checker.js";
import {
  printPathAnalysis,
  printSchemaAnalysis,
  printImportAnalysis,
  printEnvAnalysis,
  printTypeAnalysis,
  printApiRouteAnalysis,
  printSqlSchemaAnalysis,
  formatStaticFindings,
} from "../analysis/formatter.js";
import * as log from "../utils/logger.js";

export interface VerifyOptions {
  plan?: string;
  stdin?: boolean;
  prompt?: string;
  project?: string;
  model?: string;
  verbose?: boolean;
  static?: boolean; // --no-static sets this to false
  schema?: string;
}

export async function runVerify(options: VerifyOptions): Promise<void> {
  const projectDir = path.resolve(options.project ?? process.cwd());

  // 1. Load config
  const config = loadConfig(projectDir);
  const model = options.model ?? config.model;

  // Resolve API key
  const apiKey = config.apiKey;
  if (!apiKey) {
    log.error(
      "No API key found. Set ANTHROPIC_API_KEY env var or run `codeverifier init`.",
    );
    process.exit(1);
  }

  // 2. Load plan
  log.info("Loading plan...");
  const { planText, source } = await loadPlan({
    plan: options.plan,
    stdin: options.stdin,
  });
  log.success(`Plan loaded from ${source} (${planText.length} chars)`);

  // 3. Load prior session feedback
  const sessionFeedback = loadLastFeedback(projectDir);
  if (sessionFeedback) {
    log.info("Including prior verification feedback for context");
  }

  // 4. Build project context
  log.info("Building project context...");
  const context = buildContext({
    projectDir,
    planText,
    prompt: options.prompt,
    sessionFeedback,
    tokenBudget: config.tokenBudget,
  });

  if (options.verbose) {
    log.heading("Token Budget");
    for (const [key, tokens] of context.tokenStats) {
      log.dim(`  ${key}: ~${tokens} tokens`);
    }
    const total = [...context.tokenStats.values()].reduce((a, b) => a + b, 0);
    log.dim(`  TOTAL: ~${total} / ${config.tokenBudget} tokens`);
  }

  // 4.5. Static analysis (between context build and LLM call)
  let staticFindings: string | undefined;

  if (options.static !== false) {
    const pathAnalysis = analyzePaths(planText, projectDir);

    let schemaAnalysis;
    if (options.schema) {
      const schemaPath = path.resolve(projectDir, options.schema);
      try {
        const schema = parseSchema(schemaPath);
        schemaAnalysis = analyzeSchema(planText, schema);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Could not parse schema at ${options.schema}: ${msg}`);
      }
    }

    // Import analysis
    const importAnalysis = analyzeImports(planText, projectDir);

    // Env analysis
    const envAnalysis = analyzeEnv(planText, projectDir);

    // Type analysis
    const typeAnalysis = analyzeTypes(planText, projectDir);

    // API route analysis
    const apiRouteAnalysis = analyzeApiRoutes(planText, projectDir);

    // SQL/Drizzle schema analysis
    const sqlSchemaAnalysis = analyzeSqlSchema(planText, projectDir);

    // Print to console immediately
    const hasPathIssues = pathAnalysis.hallucinatedPaths.length > 0;
    const hasSchemaIssues = schemaAnalysis && schemaAnalysis.hallucinations.length > 0;
    const hasImportIssues = importAnalysis.hallucinations.length > 0;
    const hasEnvIssues = envAnalysis.hallucinations.length > 0;
    const hasTypeIssues = typeAnalysis.hallucinations.length > 0;
    const hasApiRouteIssues = apiRouteAnalysis.hallucinations.length > 0;
    const hasSqlSchemaIssues = sqlSchemaAnalysis.hallucinations.length > 0;

    if (hasPathIssues || hasSchemaIssues || hasImportIssues || hasEnvIssues || hasTypeIssues || hasApiRouteIssues || hasSqlSchemaIssues) {
      if (hasPathIssues) printPathAnalysis(pathAnalysis);
      if (hasSchemaIssues) printSchemaAnalysis(schemaAnalysis!);
      if (hasImportIssues) printImportAnalysis(importAnalysis);
      if (hasEnvIssues) printEnvAnalysis(envAnalysis);
      if (hasTypeIssues) printTypeAnalysis(typeAnalysis);
      if (hasApiRouteIssues) printApiRouteAnalysis(apiRouteAnalysis);
      if (hasSqlSchemaIssues) printSqlSchemaAnalysis(sqlSchemaAnalysis);

      // Format for LLM context injection
      staticFindings = formatStaticFindings(
        hasPathIssues ? pathAnalysis : undefined,
        hasSchemaIssues ? schemaAnalysis : undefined,
        hasImportIssues ? importAnalysis : undefined,
        hasEnvIssues ? envAnalysis : undefined,
        hasTypeIssues ? typeAnalysis : undefined,
        hasApiRouteIssues ? apiRouteAnalysis : undefined,
        hasSqlSchemaIssues ? sqlSchemaAnalysis : undefined,
      );
    } else {
      log.success("Static analysis: no issues found");
    }
  }

  // 5. Build prompt
  const systemPrompt = getSystemPrompt();
  const userMessage = buildUserMessage(context, staticFindings);

  // 6. Stream response
  log.info(`Sending to ${model}...`);
  const renderer = createRenderer();

  try {
    const result = await streamVerification({
      apiKey,
      model,
      systemPrompt,
      userMessage,
      onText: renderer.onText,
    });

    // Ensure newline after streamed output
    console.log("\n");

    // 7. Save session
    const fullFeedback = renderer.getFullText();
    saveSession(projectDir, planText, fullFeedback);
    log.success("Feedback saved to .codeverifier/sessions/");

    // 8. Verbose stats
    if (options.verbose) {
      log.heading("API Usage");
      log.dim(`  Input tokens:  ${result.inputTokens}`);
      log.dim(`  Output tokens: ${result.outputTokens}`);
    }
  } catch (err: unknown) {
    console.log("\n");
    if (err instanceof Error) {
      if (err.message.includes("401") || err.message.includes("authentication")) {
        log.error("Authentication failed. Check your API key.");
      } else if (err.message.includes("429")) {
        log.error("Rate limited. Please wait and try again.");
      } else if (
        err.message.includes("ENOTFOUND") ||
        err.message.includes("ECONNREFUSED")
      ) {
        log.error("Network error. Check your internet connection.");
      } else {
        log.error(`API error: ${err.message}`);
      }
    } else {
      log.error("An unexpected error occurred.");
    }
    process.exit(1);
  }
}
