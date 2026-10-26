import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Database } from "bun:sqlite";
import { getDatabase, resolveDbPath, LegacyDatabaseError } from "../db/connection.ts";
import { startAutoArchive } from "../domain/archive.ts";
import { registerMcpTools } from "./tools.ts";

export function createMcpServer(db: Database = getDatabase()): McpServer {
  const server = new McpServer(
    {
      name: "requireflow",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  registerMcpTools(server, db);
  return server;
}

export async function startMcpServer(db: Database = getDatabase()): Promise<void> {
  const server = createMcpServer(db);
  startAutoArchive(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so stdout remains clean for JSON-RPC 2.0 messages
  console.error("RequireFlow MCP Server running on stdio");
  console.error(`Active database: ${resolveDbPath()}`);
}

if (import.meta.main) {
  startMcpServer().catch((err) => {
    if (err instanceof LegacyDatabaseError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    console.error("Fatal error in MCP server:", err);
    process.exit(1);
  });
}
