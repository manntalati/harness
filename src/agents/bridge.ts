import { randomBytes } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ToolContext, bridgeTools, executeTool } from "./tools.js";

// Agents running inside Claude Code reach their team tools (messages,
// delegation, inbox reports, notes) through a small MCP endpoint on the
// playground server. Each activation gets its own unguessable URL that only
// works while that activation is running.

const sessions = new Map<string, ToolContext>();

export function openBridge(ctx: ToolContext): string {
  const token = randomBytes(24).toString("hex");
  sessions.set(token, ctx);
  return token;
}

export function closeBridge(token: string): void {
  sessions.delete(token);
}

export async function handleBridgeRequest(req: IncomingMessage, res: ServerResponse, token: string, body: unknown): Promise<void> {
  const ctx = sessions.get(token);
  if (!ctx) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "This agent session has ended" }));
    return;
  }
  const server = new McpServer({ name: "harness", version: "1" });
  for (const def of bridgeTools(ctx)) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.shape }, async (args: Record<string, unknown>) => {
      const result = await executeTool(def.name, args, ctx);
      return { content: [{ type: "text" as const, text: result.content }], isError: result.isError };
    });
  }
  // Stateless: every request carries everything it needs.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
