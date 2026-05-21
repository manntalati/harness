import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentManager } from "../agents/manager.js";
import { Orchestrator } from "../agents/orchestrator.js";
import { AgentEvent } from "../agents/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
};

export interface DashboardConfig {
  port: number;
  manager: AgentManager;
  orchestrator: Orchestrator;
}

function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

export function startDashboard(config: DashboardConfig): void {
  const { port, manager, orchestrator } = config;
  const sseClients = new Set<ServerResponse>();

  // Subscribe to agent events and broadcast to all SSE clients
  manager.on("agent-event", (event: AgentEvent) => {
    const data = JSON.stringify({
      ...event,
      timestamp: event.timestamp.toISOString(),
    });
    for (const client of sseClients) {
      client.write(`data: ${data}\n\n`);
    }
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;

    // CORS headers for local dev
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── SSE endpoint ────────────────────────────────────────────────
    if (path === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(":ok\n\n");

      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // ── POST endpoints ──────────────────────────────────────────────
    if (req.method === "POST") {
      try {
        // POST /api/agents — create a new agent
        if (path === "/api/agents") {
          const body = (await parseJsonBody(req)) as Record<string, unknown>;
          const name = body.name as string | undefined;
          const role = body.role as string | undefined;
          const task = body.task as string | undefined;
          if (!name || !role || !task) {
            sendError(res, 400, "name, role, and task are required");
            return;
          }
          const id = manager.createAgent({
            name,
            role,
            task,
            model: (body.model as string) ?? undefined,
            maxTokens: typeof body.maxTokens === "number" ? body.maxTokens : undefined,
          });
          sendJson(res, { id, name, status: "running" }, 201);
          return;
        }

        // POST /api/orchestrations — start an orchestration
        if (path === "/api/orchestrations") {
          const body = (await parseJsonBody(req)) as Record<string, unknown>;
          const goal = body.goal as string | undefined;
          if (!goal) {
            sendError(res, 400, "goal is required");
            return;
          }
          const id = await orchestrator.startOrchestration({
            goal,
            model: (body.model as string) ?? undefined,
            maxSubTasks: typeof body.maxSubTasks === "number" ? body.maxSubTasks : undefined,
            enableReview: typeof body.enableReview === "boolean" ? body.enableReview : undefined,
            maxReviewIterations: typeof body.maxReviewIterations === "number" ? body.maxReviewIterations : undefined,
          });
          sendJson(res, { id, goal, status: "planning" }, 201);
          return;
        }

        // POST /api/agents/:id/cancel
        const agentCancelMatch = path.match(/^\/api\/agents\/([^/]+)\/cancel$/);
        if (agentCancelMatch) {
          const success = manager.cancelAgent(agentCancelMatch[1]);
          if (success) {
            sendJson(res, { message: "Agent cancelled" });
          } else {
            sendError(res, 400, "Agent not found or not running");
          }
          return;
        }

        // POST /api/orchestrations/:id/cancel
        const orchCancelMatch = path.match(/^\/api\/orchestrations\/([^/]+)\/cancel$/);
        if (orchCancelMatch) {
          const success = orchestrator.cancelOrchestration(orchCancelMatch[1]);
          if (success) {
            sendJson(res, { message: "Orchestration cancelled" });
          } else {
            sendError(res, 400, "Orchestration not found or already finished");
          }
          return;
        }

        sendError(res, 404, "Not found");
        return;
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : "Bad request");
        return;
      }
    }

    // ── GET REST API ────────────────────────────────────────────────
    if (path === "/api/agents") {
      sendJson(res, manager.listAgents());
      return;
    }

    if (path === "/api/orchestrations") {
      sendJson(res, orchestrator.listOrchestrations());
      return;
    }

    if (path.startsWith("/api/orchestrations/")) {
      const id = path.slice("/api/orchestrations/".length);
      const result = orchestrator.getOrchestration(id);
      if (result) {
        sendJson(res, result);
      } else {
        sendError(res, 404, "Orchestration not found");
      }
      return;
    }

    if (path.startsWith("/api/agents/")) {
      const id = path.slice("/api/agents/".length);
      const result = manager.getAgentResult(id);
      if (result) {
        sendJson(res, result);
      } else {
        sendError(res, 404, "Agent not found");
      }
      return;
    }

    // ── Static files ────────────────────────────────────────────────
    const filePath = path === "/" ? "/index.html" : path;
    try {
      const fullPath = join(__dirname, "public", filePath);
      const content = await readFile(fullPath);
      const ext = filePath.slice(filePath.lastIndexOf("."));
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
      });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(port, () => {
    process.stderr.write(`Dashboard running at http://localhost:${port}\n`);
  });
}
