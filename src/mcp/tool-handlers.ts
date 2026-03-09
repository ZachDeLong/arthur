/**
 * MCP Tool Handler Registrations
 *
 * All server.tool() calls live here, keeping the entry point slim.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

import { clearImportCaches } from "../analysis/import-checker.js";
import { clearApiCaches } from "../analysis/package-api-checker.js";
import { formatStaticFindings } from "../analysis/formatter.js";
import { buildContext } from "../context/builder.js";
import { buildUserMessage, getSystemPrompt } from "../verifier/prompt.js";
import { streamVerification } from "../verifier/client.js";
import { loadConfig } from "../config/manager.js";
import { resolveArthurCheckPolicy } from "../config/arthur-check.js";
import { logCatch, buildCatchFindings } from "../logging/catches.js";
import { evaluateCoverageGate, runAllCheckers } from "../analysis/run-all.js";

import { buildJsonReport } from "../analysis/finding-schema.js";
import "../analysis/checkers/index.js";

import { resolveDiffFiles } from "../diff/resolver.js";
import { getChecker, type CheckerInput } from "../analysis/registry.js";

export function registerToolHandlers(server: McpServer): void {
  // --- check_paths ---

  server.tool(
    "check_paths",
    "Check file paths referenced in a plan against the actual project tree. Catches hallucinated paths that don't exist. No API key required.",
    {
      planText: z.string().describe("The plan text to check for file path references"),
      projectDir: z.string().describe("Absolute path to the project directory"),
    },
    async ({ planText, projectDir }) => {
      try {
        const checker = getChecker("paths")!;
        const result = checker.run({ mode: "plan", text: planText }, projectDir);

        logCatch({
          timestamp: new Date().toISOString(),
          tool: "check_paths",
          projectDir: path.basename(projectDir),
          findings: buildCatchFindings("paths", result.checked, result.hallucinated, result.catchItems),
          totalChecked: result.checked,
          totalHallucinated: result.hallucinated,
        });

        return { content: [{ type: "text", text: checker.formatForTool(result, projectDir) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[arthur-mcp] Error in check_paths: ${msg}`);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // --- check_schema ---

  server.tool(
    "check_schema",
    "Check Prisma schema references in a plan against a schema.prisma file. Catches hallucinated models, fields, methods, and relations. Auto-detects prisma/schema.prisma if schemaPath not provided. No API key required.",
    {
      planText: z.string().describe("The plan text to check for Prisma schema references"),
      projectDir: z.string().optional().describe("Absolute path to the project directory (for auto-detecting prisma/schema.prisma)"),
      schemaPath: z.string().optional().describe("Absolute path to the schema.prisma file (overrides auto-detection)"),
    },
    async ({ planText, projectDir, schemaPath }) => {
      try {
        const checker = getChecker("schema")!;
        const options: Record<string, string> = {};
        if (schemaPath) options.schemaPath = schemaPath;

        const result = checker.run({ mode: "plan", text: planText }, projectDir ?? "", options);

        if (!result.applicable) {
          return {
            content: [{ type: "text", text: "No schema found. Provide schemaPath or projectDir with prisma/schema.prisma." }],
            isError: true,
          };
        }

        logCatch({
          timestamp: new Date().toISOString(),
          tool: "check_schema",
          projectDir: path.basename(projectDir ?? ""),
          findings: buildCatchFindings("schema", result.checked, result.hallucinated, result.catchItems),
          totalChecked: result.checked,
          totalHallucinated: result.hallucinated,
        });

        return { content: [{ type: "text", text: checker.formatForTool(result, projectDir ?? "") }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[arthur-mcp] Error in check_schema: ${msg}`);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // --- check_imports ---

  server.tool(
    "check_imports",
    "Check package imports referenced in a plan against the project's node_modules. Catches hallucinated packages and invalid subpath imports. No API key required.",
    {
      planText: z.string().describe("The plan text to check for import/require statements"),
      projectDir: z.string().describe("Absolute path to the project directory (must have node_modules)"),
    },
    async ({ planText, projectDir }) => {
      try {
        clearImportCaches();
        const checker = getChecker("imports")!;
        const result = checker.run({ mode: "plan", text: planText }, projectDir);

        logCatch({
          timestamp: new Date().toISOString(),
          tool: "check_imports",
          projectDir: path.basename(projectDir),
          findings: buildCatchFindings("imports", result.checked, result.hallucinated, result.catchItems),
          totalChecked: result.checked,
          totalHallucinated: result.hallucinated,
        });

        return { content: [{ type: "text", text: checker.formatForTool(result, projectDir) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[arthur-mcp] Error in check_imports: ${msg}`);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // --- check_env ---

  server.tool(
    "check_env",
    "Check environment variable references in a plan against the project's .env* files. Catches hallucinated env var names. No API key required.",
    {
      planText: z.string().describe("The plan text to check for env variable references"),
      projectDir: z.string().describe("Absolute path to the project directory"),
    },
    async ({ planText, projectDir }) => {
      try {
        const checker = getChecker("env")!;
        const result = checker.run({ mode: "plan", text: planText }, projectDir);

        logCatch({
          timestamp: new Date().toISOString(),
          tool: "check_env",
          projectDir: path.basename(projectDir),
          findings: buildCatchFindings("env", result.checked, result.hallucinated, result.catchItems),
          totalChecked: result.checked,
          totalHallucinated: result.hallucinated,
        });

        return { content: [{ type: "text", text: checker.formatForTool(result, projectDir) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[arthur-mcp] Error in check_env: ${msg}`);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // --- check_routes ---

  server.tool(
    "check_routes",
    "Check API route references in a plan against the project's Next.js App Router route files. Catches hallucinated routes and invalid HTTP methods. No API key required.",
    {
      planText: z.string().describe("The plan text to check for API route references"),
      projectDir: z.string().describe("Absolute path to the project directory (must use Next.js App Router)"),
    },
    async ({ planText, projectDir }) => {
      try {
        const checker = getChecker("routes")!;
        const result = checker.run({ mode: "plan", text: planText }, projectDir);

        logCatch({
          timestamp: new Date().toISOString(),
          tool: "check_routes",
          projectDir: path.basename(projectDir),
          findings: buildCatchFindings("routes", result.checked, result.hallucinated, result.catchItems),
          totalChecked: result.checked,
          totalHallucinated: result.hallucinated,
        });

        return { content: [{ type: "text", text: checker.formatForTool(result, projectDir) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[arthur-mcp] Error in check_routes: ${msg}`);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // --- check_sql_schema ---

  server.tool(
    "check_sql_schema",
    "Check SQL/Drizzle schema references in a plan against the project's Drizzle table definitions and SQL CREATE TABLE statements. Catches hallucinated table and column names. No API key required.",
    {
      planText: z.string().describe("The plan text to check for SQL/Drizzle schema references"),
      projectDir: z.string().describe("Absolute path to the project directory"),
    },
    async ({ planText, projectDir }) => {
      try {
        const checker = getChecker("sqlSchema")!;
        const result = checker.run({ mode: "plan", text: planText }, projectDir);

        logCatch({
          timestamp: new Date().toISOString(),
          tool: "check_sql_schema",
          projectDir: path.basename(projectDir),
          findings: buildCatchFindings("sqlSchema", result.checked, result.hallucinated, result.catchItems),
          totalChecked: result.checked,
          totalHallucinated: result.hallucinated,
        });

        return { content: [{ type: "text", text: checker.formatForTool(result, projectDir) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[arthur-mcp] Error in check_sql_schema: ${msg}`);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // --- check_supabase_schema ---

  server.tool(
    "check_supabase_schema",
    "Check Supabase table, column, and function references in a plan against the project's generated database.types.ts file. Catches hallucinated tables, columns, and RPC functions. Auto-detects the types file. No API key required.",
    {
      planText: z.string().describe("The plan text to check for Supabase references (.from(), .select(), .eq(), .rpc(), etc.)"),
      projectDir: z.string().describe("Absolute path to the project directory"),
    },
    async ({ planText, projectDir }) => {
      try {
        const checker = getChecker("supabaseSchema")!;
        const result = checker.run({ mode: "plan", text: planText }, projectDir);

        logCatch({
          timestamp: new Date().toISOString(),
          tool: "check_supabase_schema",
          projectDir: path.basename(projectDir),
          findings: buildCatchFindings("supabaseSchema", result.checked, result.hallucinated, result.catchItems),
          totalChecked: result.checked,
          totalHallucinated: result.hallucinated,
        });

        return { content: [{ type: "text", text: checker.formatForTool(result, projectDir) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[arthur-mcp] Error in check_supabase_schema: ${msg}`);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // --- check_express_routes ---

  server.tool(
    "check_express_routes",
    "Check Express/Fastify route references in a plan against the project's route definitions. Catches hallucinated routes and invalid HTTP methods. Auto-detects Express or Fastify from package.json. No API key required.",
    {
      planText: z.string().describe("The plan text to check for route references"),
      projectDir: z.string().describe("Absolute path to the project directory"),
    },
    async ({ planText, projectDir }) => {
      try {
        const checker = getChecker("expressRoutes")!;
        const result = checker.run({ mode: "plan", text: planText }, projectDir);

        logCatch({
          timestamp: new Date().toISOString(),
          tool: "check_express_routes",
          projectDir: path.basename(projectDir),
          findings: buildCatchFindings("expressRoutes", result.checked, result.hallucinated, result.catchItems),
          totalChecked: result.checked,
          totalHallucinated: result.hallucinated,
        });

        return { content: [{ type: "text", text: checker.formatForTool(result, projectDir) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[arthur-mcp] Error in check_express_routes: ${msg}`);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // --- check_package_api ---

  server.tool(
    "check_package_api",
    "Check package API usage in a plan against real .d.ts type definitions in node_modules. Catches hallucinated named imports (e.g., import { parseEmail } from 'zod') and hallucinated member access (e.g., z.isEmail()). Experimental. No API key required.",
    {
      planText: z.string().describe("The plan text to check for package API references (import statements and member access)"),
      projectDir: z.string().describe("Absolute path to the project directory (must have node_modules)"),
    },
    async ({ planText, projectDir }) => {
      try {
        // Clear stale module-level caches from previous requests in this long-running process.
        clearApiCaches();

        const checker = getChecker("packageApi")!;
        const result = checker.run({ mode: "plan", text: planText }, projectDir);

        logCatch({
          timestamp: new Date().toISOString(),
          tool: "check_package_api",
          projectDir: path.basename(projectDir),
          findings: buildCatchFindings("packageApi", result.checked, result.hallucinated, result.catchItems),
          totalChecked: result.checked,
          totalHallucinated: result.hallucinated,
        });

        return { content: [{ type: "text", text: checker.formatForTool(result, projectDir) }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[arthur-mcp] Error in check_package_api: ${msg}`);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // --- check_all (registry-driven) ---

  server.tool(
    "check_all",
    "Run Arthur's full static verification pass in one call. By default this runs stable deterministic checkers (paths, schema, SQL/Drizzle, Supabase, imports, env vars, routes). Optional strict mode enables experimental checkers and enforces coverage thresholds. Returns ground truth context for every finding. No API key required.",
    {
      planText: z.string().describe("The plan text to verify against the project"),
      projectDir: z.string().describe("Absolute path to the project directory"),
      schemaPath: z.string().optional().describe("Absolute path to schema.prisma (auto-detected if omitted)"),
      format: z.enum(["text", "json"]).optional().default("text").describe("Output format: 'text' for markdown (default), 'json' for machine-readable ArthurReport"),
      includeExperimental: z.boolean().optional().describe("Include experimental checkers (TypeScript Types + Package API). Defaults to project config or false."),
      strict: z.boolean().optional().default(false).describe("Strict mode: includes experimental checkers and fails coverage gate if checked refs are below threshold."),
      minCheckedRefs: z.number().int().positive().optional().describe("Coverage gate threshold: minimum refs that must be checked."),
      coverageMode: z.enum(["off", "warn", "fail"]).optional().describe("Coverage gate mode. Defaults to project config or warn."),
    },
    async ({
      planText,
      projectDir,
      schemaPath,
      format,
      includeExperimental,
      strict,
      minCheckedRefs,
      coverageMode,
    }) => {
      try {
        const checkerOptions: Record<string, string> = {};
        if (schemaPath) checkerOptions.schemaPath = schemaPath;

        const policy = resolveArthurCheckPolicy(projectDir, {
          includeExperimental,
          strict,
          minCheckedRefs,
          coverageMode,
        });

        const summary = runAllCheckers({ mode: "plan", text: planText }, projectDir, {
          includeExperimental: policy.includeExperimental,
          checkerOptions,
        });
        const coverageGate = evaluateCoverageGate(
          summary.totalChecked,
          policy.minCheckedRefs,
          policy.coverageMode,
        );

        const catchFindings: Record<string, { checked: number; hallucinated: number; items: string[] } | null> = {};

        for (const { checker, result } of summary.checkerResults) {
          catchFindings[checker.catchKey] = result.applicable
            ? { checked: result.checked, hallucinated: result.hallucinated, items: result.catchItems }
            : null;
        }

        // Log catches
        logCatch({
          timestamp: new Date().toISOString(),
          tool: "check_all",
          projectDir: path.basename(projectDir),
          findings: catchFindings,
          totalChecked: summary.totalChecked,
          totalHallucinated: summary.totalFindings,
        });

        // JSON output
        if (format === "json") {
          const report = buildJsonReport(summary.checkerResults, projectDir);
          const payload = {
            ...report,
            meta: {
              includeExperimental: policy.includeExperimental,
              coverageGate,
              skippedCheckers: summary.skippedCheckers.map((s) => ({
                checker: s.checker.id,
                displayName: s.checker.displayName,
                reason: s.reason,
              })),
            },
          };
          return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
        }

        // Text (markdown) output — existing behavior
        const lines: string[] = [];
        lines.push(`# Arthur Verification Report`);
        lines.push(``);
        lines.push(`**Experimental checkers:** ${policy.includeExperimental ? "enabled" : "disabled"}`);
        lines.push(``);

        for (const { checker, result } of summary.checkerResults) {
          if (result.applicable) {
            lines.push(...checker.formatForCheckAll(result, projectDir));
          }
        }

        if (summary.skippedCheckers.length > 0) {
          lines.push(`## Skipped / Not Applicable`);
          for (const skipped of summary.skippedCheckers) {
            lines.push(`- **${skipped.checker.displayName}** — ${skipped.reason}`);
          }
          lines.push(``);
        }

        lines.push(`## Coverage Gate`);
        lines.push(`- Mode: \`${coverageGate.mode}\``);
        lines.push(`- Minimum checked refs: **${coverageGate.minCheckedRefs}**`);
        lines.push(`- Total checked refs: **${summary.totalChecked}**`);
        if (coverageGate.triggered) {
          const level = coverageGate.mode === "fail" ? "FAILED" : "WARNING";
          lines.push(`- Status: **${level}** — ${coverageGate.message}`);
        } else if (coverageGate.mode === "off") {
          lines.push(`- Status: disabled`);
        } else {
          lines.push(`- Status: pass`);
        }
        lines.push(``);

        // Summary
        lines.push(`---`);
        if (summary.totalFindings === 0 && coverageGate.mode === "fail" && coverageGate.triggered) {
          lines.push(`**0 issues found, but coverage gate failed.** Increase plan specificity or lower threshold.`);
        } else if (summary.totalFindings === 0 && coverageGate.triggered) {
          lines.push(`**0 issues found, but coverage is low.** Increase plan specificity for stronger validation.`);
        } else if (summary.totalFindings === 0) {
          lines.push(`**All checks passed.** No hallucinated references found.`);
        } else {
          lines.push(`**${summary.totalFindings} issue(s) found.** Fix the hallucinated references above using the ground truth provided.`);
        }

        const coverageFailed = coverageGate.mode === "fail" && coverageGate.triggered;
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          ...(coverageFailed ? { isError: true } : {}),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[arthur-mcp] Error in check_all: ${msg}`);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // --- check_diff (source code verification via git diff) ---

  server.tool(
    "check_diff",
    "Validate actual code changes from a git diff against project ground truth. Catches hallucinated imports in source files that were added or modified. Only checkers with source-mode support are run (currently: imports). No API key required.",
    {
      projectDir: z.string().describe("Absolute path to the project directory (must be a git repo)"),
      diffRef: z.string().optional().default("HEAD").describe("Git ref to diff against: HEAD (default), origin/main, HEAD~3, etc."),
      staged: z.boolean().optional().default(false).describe("Check only staged changes (for pre-commit hooks)"),
      format: z.enum(["text", "json"]).optional().default("text").describe("Output format: 'text' for markdown (default), 'json' for machine-readable ArthurReport"),
      includeExperimental: z.boolean().optional().describe("Include experimental checkers (if they support source mode)."),
      strict: z.boolean().optional().default(false).describe("Strict mode: includes experimental checkers and fails coverage gate."),
      minCheckedRefs: z.number().int().positive().optional().describe("Coverage gate threshold."),
      coverageMode: z.enum(["off", "warn", "fail"]).optional().describe("Coverage gate mode."),
    },
    async ({ projectDir, diffRef, staged, format, includeExperimental, strict, minCheckedRefs, coverageMode }) => {
      try {
        const files = resolveDiffFiles(projectDir, diffRef, { staged });

        if (files.length === 0) {
          return { content: [{ type: "text" as const, text: "No changed source files found in diff." }] };
        }

        const text = files.map(f => f.content).join("\n");
        const input: CheckerInput = { mode: "source", text, files };

        const policy = resolveArthurCheckPolicy(projectDir, {
          includeExperimental,
          strict,
          minCheckedRefs,
          coverageMode,
        });

        const summary = runAllCheckers(input, projectDir, {
          includeExperimental: policy.includeExperimental,
        });
        const coverageGate = evaluateCoverageGate(
          summary.totalChecked,
          policy.minCheckedRefs,
          policy.coverageMode,
        );

        // Log catches
        const catchFindings: Record<string, { checked: number; hallucinated: number; items: string[] } | null> = {};
        for (const { checker, result } of summary.checkerResults) {
          catchFindings[checker.catchKey] = result.applicable
            ? { checked: result.checked, hallucinated: result.hallucinated, items: result.catchItems }
            : null;
        }
        logCatch({
          timestamp: new Date().toISOString(),
          tool: "check_diff",
          projectDir: path.basename(projectDir),
          findings: catchFindings,
          totalChecked: summary.totalChecked,
          totalHallucinated: summary.totalFindings,
        });

        // JSON output
        if (format === "json") {
          const report = buildJsonReport(summary.checkerResults, projectDir);
          const payload = {
            ...report,
            meta: {
              mode: "diff",
              diffRef,
              staged,
              filesChecked: files.length,
              includeExperimental: policy.includeExperimental,
              coverageGate,
              skippedCheckers: summary.skippedCheckers.map((s) => ({
                checker: s.checker.id,
                displayName: s.checker.displayName,
                reason: s.reason,
              })),
            },
          };
          return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
        }

        // Text (markdown) output
        const lines: string[] = [];
        lines.push(`# Arthur Diff Report`);
        lines.push(``);
        lines.push(`**Mode:** diff (${staged ? "staged" : diffRef})`);
        lines.push(`**Files checked:** ${files.length}`);
        lines.push(`**Experimental checkers:** ${policy.includeExperimental ? "enabled" : "disabled"}`);
        lines.push(``);

        for (const { checker, result } of summary.checkerResults) {
          if (result.applicable) {
            lines.push(...checker.formatForCheckAll(result, projectDir));
          }
        }

        if (summary.skippedCheckers.length > 0) {
          lines.push(`## Skipped / Not Applicable`);
          for (const skipped of summary.skippedCheckers) {
            lines.push(`- **${skipped.checker.displayName}** — ${skipped.reason}`);
          }
          lines.push(``);
        }

        // Coverage gate
        lines.push(`## Coverage Gate`);
        lines.push(`- Mode: \`${coverageGate.mode}\``);
        lines.push(`- Minimum checked refs: **${coverageGate.minCheckedRefs}**`);
        lines.push(`- Total checked refs: **${summary.totalChecked}**`);
        if (coverageGate.triggered) {
          const level = coverageGate.mode === "fail" ? "FAILED" : "WARNING";
          lines.push(`- Status: **${level}** — ${coverageGate.message}`);
        } else if (coverageGate.mode === "off") {
          lines.push(`- Status: disabled`);
        } else {
          lines.push(`- Status: pass`);
        }
        lines.push(``);

        lines.push(`---`);
        if (summary.totalFindings === 0) {
          lines.push(`**All checks passed.** No issues found in changed files.`);
        } else {
          lines.push(`**${summary.totalFindings} issue(s) found.** Fix the references above.`);
        }

        const coverageFailed = coverageGate.mode === "fail" && coverageGate.triggered;
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          ...(coverageFailed ? { isError: true } : {}),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[arthur-mcp] Error in check_diff: ${msg}`);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // --- verify_plan ---

  server.tool(
    "verify_plan",
    "Full plan verification: static analysis (paths, imports, env vars, types, API routes, SQL schemas + optional Prisma schema) followed by LLM review. Requires ANTHROPIC_API_KEY environment variable.",
    {
      planText: z.string().describe("The plan text to verify"),
      projectDir: z.string().describe("Absolute path to the project directory"),
      prompt: z.string().optional().describe("Original user request (for intent alignment checking)"),
      schemaPath: z.string().optional().describe("Absolute path to schema.prisma for Prisma schema validation"),
      model: z.string().optional().describe("Claude model to use (default: from config or claude-sonnet-4-5-20250929)"),
      includeExperimental: z.boolean().optional().describe("Include experimental checkers (TypeScript Types + Package API). Defaults to project config or false."),
      strict: z.boolean().optional().default(false).describe("Strict mode: includes experimental checkers and fails coverage gate if checked refs are below threshold."),
      minCheckedRefs: z.number().int().positive().optional().describe("Coverage gate threshold: minimum refs that must be checked."),
      coverageMode: z.enum(["off", "warn", "fail"]).optional().describe("Coverage gate mode. Defaults to project config or warn."),
    },
    async ({
      planText,
      projectDir,
      prompt,
      schemaPath,
      model,
      includeExperimental,
      strict,
      minCheckedRefs,
      coverageMode,
    }) => {
      try {
        // Load config for API key and model default
        const config = loadConfig(projectDir);
        const apiKey = config.apiKey;

        if (!apiKey) {
          return {
            content: [{
              type: "text",
              text: "Error: No API key found. Set the ANTHROPIC_API_KEY environment variable to use verify_plan. The check_paths and check_schema tools work without an API key.",
            }],
            isError: true,
          };
        }

        const resolvedModel = model ?? config.model;
        const checkPolicy = resolveArthurCheckPolicy(projectDir, {
          includeExperimental,
          strict,
          minCheckedRefs,
          coverageMode,
        });

        // 1. Build context
        const context = buildContext({
          projectDir,
          planText,
          prompt,
          tokenBudget: config.tokenBudget,
        });

        // 2. Run all checkers via registry
        const options: Record<string, string> = {};
        if (schemaPath) options.schemaPath = schemaPath;

        const results = new Map<string, import("../analysis/registry.js").CheckerResult>();
        const checkSummary = runAllCheckers({ mode: "plan", text: planText }, projectDir, {
          includeExperimental: checkPolicy.includeExperimental,
          checkerOptions: options,
        });
        for (const { checker, result } of checkSummary.checkerResults) {
          results.set(checker.id, result);
        }

        // 3. Format static findings for LLM context
        const coverageGate = evaluateCoverageGate(
          checkSummary.totalChecked,
          checkPolicy.minCheckedRefs,
          checkPolicy.coverageMode,
        );

        let staticFindings = formatStaticFindings(results, {
          checkers: checkSummary.checkerResults.map(({ checker }) => checker),
        });
        if (coverageGate.triggered) {
          const coverageSection = [
            `### Coverage Gate`,
            ``,
            `${coverageGate.mode === "fail" ? "FAIL" : "WARNING"}: ${coverageGate.message}`,
            `Increase plan specificity so static checkers can validate more references.`,
          ].join("\n");
          staticFindings = staticFindings
            ? `${staticFindings}\n\n${coverageSection}`
            : coverageSection;
        }

        // 4. Build LLM prompt
        const systemPrompt = getSystemPrompt();
        const userMessage = buildUserMessage(context, staticFindings);

        // 5. Stream verification (collect full output)
        let fullText = "";
        await streamVerification({
          apiKey,
          model: resolvedModel,
          systemPrompt,
          userMessage,
          onText: (text) => { fullText += text; },
        });

        // 6. Assemble output: static findings + LLM review
        const outputParts: string[] = [];

        if (staticFindings) {
          outputParts.push(staticFindings);
          outputParts.push("---");
        }

        outputParts.push(`## LLM Verification (${resolvedModel})`);
        outputParts.push(``);
        outputParts.push(fullText);

        return { content: [{ type: "text", text: outputParts.join("\n\n") }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[arthur-mcp] Error in verify_plan: ${msg}`);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // --- update_session_context ---

  server.tool(
    "update_session_context",
    "Record a key decision, insight, or context from the current conversation to a session file. This survives context compression. Call this after meaningful exchanges — decisions made, directions killed, requirements clarified. Not every message, just turning points.",
    {
      projectDir: z.string().describe("Absolute path to the project directory (session file stored in .arthur/sessions/)"),
      entry: z.string().describe("The decision, insight, or context to record. Be concise but complete — this is what a fresh context will read to understand what happened."),
      category: z.enum(["decision", "insight", "requirement", "correction", "context"]).optional()
        .describe("Category of the entry (default: context)"),
    },
    async ({ projectDir, entry, category }) => {
      try {
        const sessionDir = path.join(projectDir, ".arthur", "sessions");
        fs.mkdirSync(sessionDir, { recursive: true });

        // One session file per day — append entries
        const today = new Date().toISOString().split("T")[0];
        const sessionFile = path.join(sessionDir, `${today}.md`);

        const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
        const cat = category ?? "context";
        const line = `- **[${timestamp}] [${cat}]** ${entry}\n`;

        // Create file with header if new
        if (!fs.existsSync(sessionFile)) {
          fs.writeFileSync(sessionFile, `# Session Context — ${today}\n\n`, "utf-8");
        }

        fs.appendFileSync(sessionFile, line, "utf-8");

        // Read back the full session for the response
        const content = fs.readFileSync(sessionFile, "utf-8");
        const entryCount = (content.match(/^- \*\*/gm) || []).length;

        return {
          content: [{
            type: "text",
            text: `Recorded. Session file: ${sessionFile} (${entryCount} entries today)`,
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[arthur-mcp] Error in update_session_context: ${msg}`);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    },
  );

  // --- get_session_context ---

  server.tool(
    "get_session_context",
    "Read the current session context file. Use this at the start of a conversation or after context compression to recover decisions and insights from earlier in the session.",
    {
      projectDir: z.string().describe("Absolute path to the project directory"),
      date: z.string().optional().describe("Date to read (YYYY-MM-DD format, default: today)"),
    },
    async ({ projectDir, date }) => {
      try {
        const targetDate = date ?? new Date().toISOString().split("T")[0];
        const sessionFile = path.join(projectDir, ".arthur", "sessions", `${targetDate}.md`);

        if (!fs.existsSync(sessionFile)) {
          return {
            content: [{
              type: "text",
              text: `No session context for ${targetDate}. Nothing has been recorded yet.`,
            }],
          };
        }

        const content = fs.readFileSync(sessionFile, "utf-8");
        return { content: [{ type: "text", text: content }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[arthur-mcp] Error in get_session_context: ${msg}`);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    },
  );
}
