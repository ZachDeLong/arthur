import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerToolHandlers } from "../src/mcp/tool-handlers.js";

function registeredTools(options: Parameters<typeof registerToolHandlers>[1] = {}): string[] {
  const server = new McpServer({ name: "arthur-test", version: "0" });
  registerToolHandlers(server, options);
  const internal = server as unknown as { _registeredTools: Record<string, unknown> };
  return Object.keys(internal._registeredTools);
}

describe("MCP tool profile", () => {
  it("exposes only the two primary tools by default", () => {
    expect(registeredTools()).toEqual(["check_all", "check_diff"]);
  });

  it("keeps legacy, LLM, and session surfaces explicitly opt-in", () => {
    expect(registeredTools({ legacyTools: true })).toContain("check_paths");
    expect(registeredTools({ llmTool: true })).toContain("verify_plan");
    expect(registeredTools({ sessionTools: true })).toEqual(
      expect.arrayContaining(["update_session_context", "get_session_context"]),
    );
  });
});
