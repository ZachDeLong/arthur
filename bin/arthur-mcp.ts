#!/usr/bin/env node

/**
 * Arthur MCP Server
 *
 * Exposes Arthur's static analysis and plan verification as MCP tools
 * for direct integration with Claude Code.
 *
 * Tools:
 *   check_paths            — deterministic path validation (no API key)
 *   check_schema           — deterministic Prisma schema validation (no API key)
 *   check_imports          — deterministic package import validation (no API key)
 *   check_env              — deterministic env variable validation (no API key)
 *   check_types            — deterministic TypeScript type validation (no API key)
 *   check_routes           — deterministic Next.js API route validation (no API key)
 *   check_sql_schema       — deterministic Drizzle/SQL schema validation (no API key)
 *   verify_plan            — full pipeline: static analysis + LLM review (requires ANTHROPIC_API_KEY)
 *   update_session_context — record decisions/insights to survive context compression
 *   get_session_context    — read back session context after compression
 *
 * CRITICAL: No console.log() — stdout is reserved for JSON-RPC protocol.
 * Use console.error() for debug output.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

import { analyzePaths } from "../src/analysis/path-checker.js";
import {
  parseSchema,
  analyzeSchema,
} from "../src/analysis/schema-checker.js";
import { analyzeImports } from "../src/analysis/import-checker.js";
import { analyzeEnv } from "../src/analysis/env-checker.js";
import { analyzeTypes } from "../src/analysis/type-checker.js";
import { analyzeApiRoutes } from "../src/analysis/api-route-checker.js";
import { analyzeSqlSchema } from "../src/analysis/sql-schema-checker.js";
import { formatStaticFindings } from "../src/analysis/formatter.js";
import { buildContext } from "../src/context/builder.js";
import { buildUserMessage, getSystemPrompt } from "../src/verifier/prompt.js";
import { streamVerification } from "../src/verifier/client.js";
import { loadConfig } from "../src/config/manager.js";

const server = new McpServer({
  name: "arthur",
  version: "0.1.0",
});

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
      const analysis = analyzePaths(planText, projectDir);
      const lines: string[] = [];

      const checked = analysis.extractedPaths.length;
      const hallucinated = analysis.hallucinatedPaths.length;
      const intentionalNew = analysis.intentionalNewPaths.length;
      const valid = checked - hallucinated - intentionalNew;

      lines.push(`## Path Analysis`);
      lines.push(``);
      lines.push(`**${checked}** paths checked — **${valid}** valid, **${hallucinated}** hallucinated, **${intentionalNew}** intentional new`);

      if (hallucinated > 0) {
        lines.push(``);
        lines.push(`### Hallucinated Paths`);
        for (const p of analysis.hallucinatedPaths) {
          lines.push(`- \`${p}\` — **NOT FOUND**`);
        }
      }

      if (intentionalNew > 0) {
        lines.push(``);
        lines.push(`### Intentional New Files`);
        for (const p of analysis.intentionalNewPaths) {
          lines.push(`- \`${p}\` — new file (CREATE signal found)`);
        }
      }

      if (analysis.validPaths.length > 0) {
        lines.push(``);
        lines.push(`### Valid Paths`);
        const show = analysis.validPaths.slice(0, 10);
        for (const p of show) {
          lines.push(`- \`${p}\` — exists`);
        }
        if (analysis.validPaths.length > 10) {
          lines.push(`- ... and ${analysis.validPaths.length - 10} more`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- check_schema ---

server.tool(
  "check_schema",
  "Check Prisma schema references in a plan against a schema.prisma file. Catches hallucinated models, fields, methods, and relations. No API key required.",
  {
    planText: z.string().describe("The plan text to check for Prisma schema references"),
    schemaPath: z.string().describe("Absolute path to the schema.prisma file"),
  },
  async ({ planText, schemaPath }) => {
    try {
      const schema = parseSchema(schemaPath);
      const analysis = analyzeSchema(planText, schema);
      const lines: string[] = [];

      const { totalRefs, hallucinations, byCategory } = analysis;

      lines.push(`## Schema Analysis`);
      lines.push(``);
      lines.push(`**${totalRefs}** schema refs — **${totalRefs - hallucinations.length}** valid, **${hallucinations.length}** hallucinated`);

      if (hallucinations.length > 0) {
        lines.push(``);
        lines.push(`### Hallucinations`);
        for (const h of hallucinations) {
          const suggestion = h.suggestion ? ` (did you mean \`${h.suggestion}\`?)` : "";
          lines.push(`- \`${h.raw}\` — ${h.hallucinationCategory}${suggestion}`);
        }
      }

      // Category breakdown
      const parts: string[] = [];
      if (byCategory.models.total > 0) {
        parts.push(`${byCategory.models.total - byCategory.models.hallucinated}/${byCategory.models.total} models`);
      }
      if (byCategory.fields.total > 0) {
        parts.push(`${byCategory.fields.total - byCategory.fields.hallucinated}/${byCategory.fields.total} fields`);
      }
      if (byCategory.methods.total > 0) {
        parts.push(`${byCategory.methods.total - byCategory.methods.invalid}/${byCategory.methods.total} methods`);
      }
      if (byCategory.relations.total > 0) {
        parts.push(`${byCategory.relations.total - byCategory.relations.wrong}/${byCategory.relations.total} relations`);
      }
      if (parts.length > 0) {
        lines.push(``);
        lines.push(`**Breakdown:** ${parts.join(", ")}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
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
      const analysis = analyzeImports(planText, projectDir);
      const lines: string[] = [];

      const { checkedImports, validImports, hallucinations, skippedImports } = analysis;

      lines.push(`## Import Analysis`);
      lines.push(``);
      lines.push(`**${checkedImports}** imports checked — **${validImports}** valid, **${hallucinations.length}** hallucinated, **${skippedImports}** skipped (relative/builtin)`);

      if (hallucinations.length > 0) {
        lines.push(``);
        lines.push(`### Hallucinated Imports`);
        for (const h of hallucinations) {
          const reason = h.reason === "package-not-found" ? "package not found" : "subpath not exported";
          const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
          lines.push(`- \`${h.raw}\` — ${reason}${suggestion}`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
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
      const analysis = analyzeEnv(planText, projectDir);
      const lines: string[] = [];

      const { checkedRefs, validRefs, hallucinations, skippedRefs, envFilesFound } = analysis;

      lines.push(`## Env Variable Analysis`);
      lines.push(``);

      if (envFilesFound.length === 0) {
        lines.push(`No .env* files found in project — nothing to check against.`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      lines.push(`**${checkedRefs}** env vars checked — **${validRefs}** valid, **${hallucinations.length}** hallucinated, **${skippedRefs}** skipped (runtime)`);
      lines.push(`Sources: ${envFilesFound.join(", ")}`);

      if (hallucinations.length > 0) {
        lines.push(``);
        lines.push(`### Hallucinated Env Variables`);
        for (const h of hallucinations) {
          const suggestion = h.suggestion ? ` (did you mean \`${h.suggestion}\`?)` : "";
          lines.push(`- \`${h.varName}\` — not in env files${suggestion}`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- check_types ---

server.tool(
  "check_types",
  "Check TypeScript type references in a plan against the project's .ts/.tsx files. Catches hallucinated type names and member access. No API key required.",
  {
    planText: z.string().describe("The plan text to check for TypeScript type references"),
    projectDir: z.string().describe("Absolute path to the project directory"),
  },
  async ({ planText, projectDir }) => {
    try {
      const analysis = analyzeTypes(planText, projectDir);
      const lines: string[] = [];

      const { checkedRefs, validRefs, hallucinations, skippedRefs, byCategory } = analysis;

      lines.push(`## TypeScript Type Analysis`);
      lines.push(``);

      if (checkedRefs === 0 && skippedRefs === 0) {
        lines.push(`No type references found in plan text.`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      lines.push(`**${checkedRefs}** types checked — **${validRefs}** valid, **${hallucinations.length}** hallucinated, **${skippedRefs}** skipped (builtins)`);

      if (hallucinations.length > 0) {
        lines.push(``);
        lines.push(`### Hallucinated Types`);
        for (const h of hallucinations) {
          const category = h.hallucinationCategory === "hallucinated-type" ? "type not found" : "member not found";
          const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
          lines.push(`- \`${h.raw}\` — ${category}${suggestion}`);
        }
      }

      // Category breakdown
      const parts: string[] = [];
      if (byCategory.types.total > 0) {
        parts.push(`${byCategory.types.total - byCategory.types.hallucinated}/${byCategory.types.total} types`);
      }
      if (byCategory.members.total > 0) {
        parts.push(`${byCategory.members.total - byCategory.members.hallucinated}/${byCategory.members.total} members`);
      }
      if (parts.length > 0) {
        lines.push(``);
        lines.push(`**Breakdown:** ${parts.join(", ")}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
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
      const analysis = analyzeApiRoutes(planText, projectDir);
      const lines: string[] = [];

      const { checkedRefs, validRefs, hallucinations, routesIndexed } = analysis;

      lines.push(`## API Route Analysis`);
      lines.push(``);

      if (routesIndexed === 0) {
        lines.push(`No Next.js App Router route files found in project.`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      lines.push(`**${routesIndexed}** routes indexed, **${checkedRefs}** refs checked — **${validRefs}** valid, **${hallucinations.length}** hallucinated`);

      if (hallucinations.length > 0) {
        lines.push(``);
        lines.push(`### Hallucinated Routes`);
        for (const h of hallucinations) {
          const category = h.hallucinationCategory === "hallucinated-route" ? "route not found" : "method not allowed";
          const method = h.method ? `${h.method} ` : "";
          const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
          lines.push(`- \`${method}${h.urlPath}\` — ${category}${suggestion}`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
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
      const analysis = analyzeSqlSchema(planText, projectDir);
      const lines: string[] = [];

      const { checkedRefs, validRefs, hallucinations, tablesIndexed, byCategory } = analysis;

      lines.push(`## SQL Schema Analysis`);
      lines.push(``);

      if (tablesIndexed === 0) {
        lines.push(`No Drizzle or SQL CREATE TABLE schemas found in project.`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      lines.push(`**${tablesIndexed}** tables indexed, **${checkedRefs}** refs checked — **${validRefs}** valid, **${hallucinations.length}** hallucinated`);

      if (hallucinations.length > 0) {
        lines.push(``);
        lines.push(`### Hallucinations`);
        for (const h of hallucinations) {
          const category = h.hallucinationCategory === "hallucinated-table" ? "table not found" : "column not found";
          const suggestion = h.suggestion ? ` (${h.suggestion})` : "";
          lines.push(`- \`${h.raw}\` — ${category}${suggestion}`);
        }
      }

      // Category breakdown
      const parts: string[] = [];
      if (byCategory.tables.total > 0) {
        parts.push(`${byCategory.tables.total - byCategory.tables.hallucinated}/${byCategory.tables.total} tables`);
      }
      if (byCategory.columns.total > 0) {
        parts.push(`${byCategory.columns.total - byCategory.columns.hallucinated}/${byCategory.columns.total} columns`);
      }
      if (parts.length > 0) {
        lines.push(``);
        lines.push(`**Breakdown:** ${parts.join(", ")}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
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
  },
  async ({ planText, projectDir, prompt, schemaPath, model }) => {
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

      // 1. Build context
      const context = buildContext({
        projectDir,
        planText,
        prompt,
        tokenBudget: config.tokenBudget,
      });

      // 2. Static analysis
      const pathAnalysis = analyzePaths(planText, projectDir);

      let schemaAnalysis;
      if (schemaPath) {
        try {
          const schema = parseSchema(path.resolve(schemaPath));
          schemaAnalysis = analyzeSchema(planText, schema);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[arthur-mcp] Schema parse error: ${msg}`);
        }
      }

      // 2b. Import analysis
      const importAnalysis = analyzeImports(planText, projectDir);

      // 2c. Env analysis
      const envAnalysis = analyzeEnv(planText, projectDir);

      // 2d. Type analysis
      const typeAnalysis = analyzeTypes(planText, projectDir);

      // 2e. API route analysis
      const apiRouteAnalysis = analyzeApiRoutes(planText, projectDir);

      // 2f. SQL/Drizzle schema analysis
      const sqlSchemaAnalysis = analyzeSqlSchema(planText, projectDir);

      // Format static findings for LLM context
      const hasPathIssues = pathAnalysis.hallucinatedPaths.length > 0;
      const hasSchemaIssues = schemaAnalysis && schemaAnalysis.hallucinations.length > 0;
      const hasImportIssues = importAnalysis.hallucinations.length > 0;
      const hasEnvIssues = envAnalysis.hallucinations.length > 0;
      const hasTypeIssues = typeAnalysis.hallucinations.length > 0;
      const hasApiRouteIssues = apiRouteAnalysis.hallucinations.length > 0;
      const hasSqlSchemaIssues = sqlSchemaAnalysis.hallucinations.length > 0;

      const staticFindings = formatStaticFindings(
        hasPathIssues ? pathAnalysis : undefined,
        hasSchemaIssues ? schemaAnalysis : undefined,
        hasImportIssues ? importAnalysis : undefined,
        hasEnvIssues ? envAnalysis : undefined,
        hasTypeIssues ? typeAnalysis : undefined,
        hasApiRouteIssues ? apiRouteAnalysis : undefined,
        hasSqlSchemaIssues ? sqlSchemaAnalysis : undefined,
      );

      // 3. Build LLM prompt
      const systemPrompt = getSystemPrompt();
      const userMessage = buildUserMessage(context, staticFindings);

      // 4. Stream verification (collect full output)
      let fullText = "";
      await streamVerification({
        apiKey,
        model: resolvedModel,
        systemPrompt,
        userMessage,
        onText: (text) => { fullText += text; },
      });

      // 5. Assemble output: static findings + LLM review
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
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  },
);

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[arthur-mcp] Server started on stdio");
}

main().catch((err) => {
  console.error("[arthur-mcp] Fatal error:", err);
  process.exit(1);
});
