#!/usr/bin/env node
/**
 * Posta MCP server — stdio transport.
 *
 * Exposes Posta's REST API as MCP tools so any MCP client (Claude Desktop, Claude
 * web via remote MCP, Cursor, Windsurf, VS Code, Zed, …) can schedule and publish
 * social posts. Authenticates with a single `POSTA_API_TOKEN`.
 *
 * Run: POSTA_API_TOKEN=posta_xxx node dist/index.js
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PostaClient } from "./client.js";
import { registerTools } from "./tools.js";

async function main(): Promise<void> {
  const token = process.env.POSTA_API_TOKEN;
  if (!token) {
    // Fail loudly on stderr (stdout is reserved for the MCP protocol stream).
    console.error(
      "[posta-mcp] POSTA_API_TOKEN is not set. Generate a token in the Posta dashboard " +
        "and add it to your MCP server config (env.POSTA_API_TOKEN).",
    );
    process.exit(1);
  }

  const client = new PostaClient({
    token,
    baseUrl: process.env.POSTA_BASE_URL,
  });

  const server = new McpServer({
    name: "posta-mcp",
    version: "0.1.0",
  });

  registerTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Connected. Log to stderr only — never stdout.
  console.error("[posta-mcp] ready (stdio).");
}

main().catch((err) => {
  console.error("[posta-mcp] fatal:", err);
  process.exit(1);
});
