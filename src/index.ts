#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AgentManager } from "./agents/manager.js";
import { CreateAgentSchema, handleCreateAgent } from "./tools/create-agent.js";
import { handleListAgents } from "./tools/list-agents.js";
import { GetResultSchema, handleGetResult } from "./tools/get-result.js";
import { CancelAgentSchema, handleCancelAgent } from "./tools/cancel-agent.js";
import {
  CreateTemplateSchema,
  handleCreateTemplate,
  handleListTemplates,
} from "./tools/templates.js";
import { Orchestrator } from "./agents/orchestrator.js";
import {
  CancelOrchestrationSchema,
  GetOrchestrationSchema,
  StartOrchestrationSchema,
  handleCancelOrchestration,
  handleGetOrchestrationStatus,
  handleListOrchestrations,
  handleStartOrchestration,
} from "./tools/orchestrate.js";
import { startDashboard } from "./dashboard/server.js";

const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT ?? "3456", 10);

const manager = new AgentManager();
const orchestrator = new Orchestrator(manager);

const server = new McpServer({
  name: "agent-orchestrator",
  version: "0.1.0",
});

server.tool(
  "create_agent",
  "Spawn a new AI agent with a specific role and task. The agent runs asynchronously — use get_agent_result to check on it.",
  CreateAgentSchema.shape,
  async (args) => handleCreateAgent(manager, args),
);

server.tool(
  "list_agents",
  "List all agents and their current statuses (pending, running, completed, failed, cancelled).",
  {},
  async () => handleListAgents(manager),
);

server.tool(
  "get_agent_result",
  "Get the result of an agent by its ID. Returns the full response text, token usage, and status.",
  GetResultSchema.shape,
  async (args) => handleGetResult(manager, args),
);

server.tool(
  "cancel_agent",
  "Cancel a running agent by its ID.",
  CancelAgentSchema.shape,
  async (args) => handleCancelAgent(manager, args),
);

server.tool(
  "create_template",
  "Save a reusable agent template with a name, role, and optional model/token settings.",
  CreateTemplateSchema.shape,
  async (args) => handleCreateTemplate(manager, args),
);

server.tool(
  "list_templates",
  "List all available agent templates (built-in and custom).",
  {},
  async () => handleListTemplates(manager),
);

// ── Orchestration tools ───────────────────────────────────────────

server.tool(
  "start_orchestration",
  "Start a PM-managed orchestration. Give it a high-level goal and the PM agent will decompose it into sub-tasks, spawn worker agents, monitor them, and synthesize the final result.",
  StartOrchestrationSchema.shape,
  async (args) => handleStartOrchestration(orchestrator, args),
);

server.tool(
  "get_orchestration_status",
  "Check the status of an orchestration — see the plan, sub-task progress, and final result.",
  GetOrchestrationSchema.shape,
  async (args) => handleGetOrchestrationStatus(orchestrator, args),
);

server.tool(
  "list_orchestrations",
  "List all orchestrations and their current status.",
  {},
  async () => handleListOrchestrations(orchestrator),
);

server.tool(
  "cancel_orchestration",
  "Cancel a running orchestration and all its worker agents.",
  CancelOrchestrationSchema.shape,
  async (args) => handleCancelOrchestration(orchestrator, args),
);

async function main() {
  // Start the dashboard HTTP server (uses stderr for logs, won't interfere with stdio)
  startDashboard({ port: DASHBOARD_PORT, manager, orchestrator });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
