import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { METHODS } from "./methods.js";

export type MethodCaller = (name: string, args: unknown) => Promise<unknown>;

/**
 * Exposes every MCP-enabled harness method as a tool. `call` either runs the
 * method in-process or forwards it to a playground that's already running.
 */
export function createMcpServer(call: MethodCaller, version: string): McpServer {
  const server = new McpServer({ name: "agent-harness", version });

  for (const [name, def] of Object.entries(METHODS)) {
    if (!def.mcp) continue;
    server.registerTool(
      name,
      { description: def.description, inputSchema: def.shape as z.ZodRawShape },
      async (args: Record<string, unknown>) => {
        try {
          const result = await call(name, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    );
  }
  return server;
}

/** Forwards method calls to a running playground's REST API. */
export function remoteCaller(baseUrl: string): MethodCaller {
  return async (name, args) => {
    const res = await fetch(`${baseUrl}/api/rpc/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args ?? {}),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body.result;
  };
}
