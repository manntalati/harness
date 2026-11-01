import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessConfig, MODEL_CHOICES } from "../config.js";
import { HarnessContext, callMethod } from "../api/methods.js";
import { AGENT_TEMPLATES, ZONE_THEMES } from "../world/blueprints.js";
import { WorldEvent } from "../world/types.js";
import { handleBridgeRequest } from "../agents/bridge.js";
import { engineProblem } from "../agents/engine.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const STREAM_FLUSH_MS = 120;
const MAX_BODY = 1_000_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export const APP_ID = "agent-harness";

function isLoopback(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
}

function hostname(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1);
  return hostHeader.split(":")[0];
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString() || "{}";
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

/**
 * The playground: static UI, a JSON-RPC-ish API shared with the MCP tools,
 * and a server-sent event stream of everything happening in the world.
 */
export function startHttpServer(config: HarnessConfig, ctx: HarnessContext, version: string): Promise<Server> {
  const { world, scheduler } = ctx;
  const clients = new Set<ServerResponse>();
  const streamBuffer = new Map<string, { text: string; thought: string; reset: boolean }>();

  const broadcast = (event: unknown) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(payload);
  };

  // Token-by-token output is coalesced so the browser gets a few updates a second, not hundreds.
  world.on((event: WorldEvent) => {
    if (event.type === "agent:stream") {
      const buf = streamBuffer.get(event.id) ?? { text: "", thought: "", reset: false };
      if (event.reset) {
        buf.text = "";
        buf.thought = "";
        buf.reset = true;
      }
      buf.text += event.text ?? "";
      buf.thought += event.thought ?? "";
      streamBuffer.set(event.id, buf);
      return;
    }
    broadcast(event);
  });

  const flusher = setInterval(() => {
    for (const [id, buf] of streamBuffer) {
      broadcast({ type: "agent:stream", id, text: buf.text || undefined, thought: buf.thought || undefined, reset: buf.reset || undefined });
    }
    streamBuffer.clear();
  }, STREAM_FLUSH_MS);
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": ping\n\n");
  }, 20_000);

  const loopbackOnly = isLoopback(config.host);

  const server = createServer(async (req, res) => {
    // Reject DNS-rebinding style requests: this server can make agents write files and run commands.
    if (loopbackOnly && !isLoopback(hostname(req.headers.host))) {
      json(res, 403, { error: "Forbidden host" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    // Team tools for agents running inside Claude Code (see agents/bridge.ts).
    const bridge = path.match(/^\/mcp\/agent\/([a-f0-9]{48})$/);
    if (bridge) {
      try {
        const body = req.method === "POST" ? await readBody(req) : undefined;
        await handleBridgeRequest(req, res, bridge[1], body);
      } catch (err) {
        if (!res.headersSent) json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (req.method === "POST") {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) {
        json(res, 403, { error: "Cross-origin requests are not allowed" });
        return;
      }
      if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
        json(res, 415, { error: "Content-Type must be application/json" });
        return;
      }
      const match = path.match(/^\/api\/rpc\/([a-z_]+)$/);
      if (!match) {
        json(res, 404, { error: "Not found" });
        return;
      }
      try {
        const args = await readBody(req);
        const result = await callMethod(ctx, match[1], args);
        json(res, 200, { result });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { error: "Method not allowed" });
      return;
    }

    if (path === "/api/health") {
      json(res, 200, { app: APP_ID, version, home: config.home });
      return;
    }

    if (path === "/api/state") {
      json(res, 200, {
        ...world.snapshot(scheduler.runningCount),
        templates: AGENT_TEMPLATES,
        themes: ZONE_THEMES,
        models: MODEL_CHOICES,
        health: {
          hasCredentials: config.hasCredentials,
          claudeCode: scheduler.env.claudeVersion,
          engine: scheduler.engine(),
          engineProblem: engineProblem(world.data.settings.engine, scheduler.env),
          home: config.home,
          version,
        },
      });
      return;
    }

    if (path === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 2000\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    // Static files
    const rel = normalize(decodeURIComponent(path === "/" ? "/index.html" : path)).replace(/^([/\\])+/, "");
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + sep)) {
      json(res, 404, { error: "Not found" });
      return;
    }
    try {
      const content = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch {
      json(res, 404, { error: "Not found" });
    }
  });

  server.on("close", () => {
    clearInterval(flusher);
    clearInterval(heartbeat);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
