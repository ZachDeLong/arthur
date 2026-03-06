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
 *   check_routes           — deterministic Next.js API route validation (no API key)
 *   check_sql_schema       — deterministic Drizzle/SQL schema validation (no API key)
 *   check_supabase_schema  — deterministic Supabase schema validation (no API key)
 *   check_express_routes   — deterministic Express/Fastify route validation (no API key)
 *   check_package_api      — deterministic package API validation (no API key)
 *   check_all              — runs all deterministic checkers in one call (no API key)
 *   check_diff             — validates actual code changes from a git diff (no API key)
 *   verify_plan            — full pipeline: static analysis + LLM review (requires ANTHROPIC_API_KEY)
 *   update_session_context — record decisions/insights to survive context compression
 *   get_session_context    — read back session context after compression
 *
 * Prisma schema auto-detected at prisma/schema.prisma (or schemaPath override).
 *
 * CRITICAL: No console.log() — stdout is reserved for JSON-RPC protocol.
 * Use console.error() for debug output.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerToolHandlers } from "../src/mcp/tool-handlers.js";

const server = new McpServer({
  name: "arthur",
  version: "0.1.0",
});

registerToolHandlers(server);

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
