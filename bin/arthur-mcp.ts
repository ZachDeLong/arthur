#!/usr/bin/env node

/**
 * Arthur MCP Server
 *
 * Exposes Arthur's reference-integrity checks as MCP tools for direct
 * integration with AI coding hosts.
 *
 * Default tools:
 *   check_all              — runs all deterministic checkers in one call (no API key)
 *   check_diff             — validates changed lines from a git diff (no API key)
 *
 * Legacy individual tools, networked LLM review, and session tools are
 * available through explicit ARTHUR_MCP_* environment opt-ins.
 *
 * Prisma schema auto-detected at prisma/schema.prisma (or schemaPath override).
 *
 * CRITICAL: No console.log() — stdout is reserved for JSON-RPC protocol.
 * Use console.error() for debug output.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerToolHandlers } from "../src/mcp/tool-handlers.js";
import { ARTHUR_VERSION } from "../src/version.js";

const server = new McpServer({
  name: "arthur",
  version: ARTHUR_VERSION,
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
