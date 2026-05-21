# CLAUDE.md — Agent Orchestrator MCP Server

## Project Overview
An MCP (Model Context Protocol) server that orchestrates multiple AI agents. Users can spin up specialized agents (researcher, writer, code reviewer, etc.) to handle tasks concurrently, monitor their status, and collect results.

## Tech Stack
- **Language**: TypeScript
- **Runtime**: Node.js
- **Transport**: stdio (for Claude Code / Claude Desktop)
- **Dependencies**:
  - `@modelcontextprotocol/sdk` — MCP server framework
  - `@anthropic-ai/sdk` — Claude API client
  - `zod` — input validation
  - `typescript` — type safety

## Project Structure
```
src/
  index.ts                  # MCP server entry point, tool registration, dashboard startup
  agents/
    manager.ts              # AgentManager — lifecycle, state, EventEmitter for live events
    runner.ts               # AgentRunner — streaming Anthropic API calls with progress
    orchestrator.ts         # Orchestrator (PM agent) — plan, execute, synthesize loop
    types.ts                # Shared interfaces, event types, orchestration types
  templates/
    defaults.ts             # Built-in agent templates
  tools/
    create-agent.ts         # create_agent tool handler
    list-agents.ts          # list_agents tool handler
    get-result.ts           # get_agent_result tool handler
    cancel-agent.ts         # cancel_agent tool handler
    templates.ts            # create_template + list_templates tool handlers
    orchestrate.ts          # start/get/list/cancel orchestration tool handlers
  dashboard/
    server.ts               # HTTP server with SSE event stream + REST API
    public/
      index.html            # Dashboard frontend (single-page, no build step)
```

## Key Commands
- `npm run build` — Compile TypeScript
- `npm start` — Run the MCP server
- `npm run dev` — Run with ts-node for development
- `npx @modelcontextprotocol/inspector` — Test/debug the server interactively

## Implementation Status
- [x] Phase 1: Project setup (package.json, tsconfig, structure)
- [x] Phase 2: Streaming runner, EventEmitter on AgentManager, typed agent events
- [x] Phase 3: Orchestrator (PM agent) — plan/execute/synthesize loop + orchestration MCP tools
- [x] Phase 4: Live web dashboard — HTTP server, SSE stream, REST API, single-page UI
- [x] Phase 5: Server wiring, build scripts, README, integration config
- [x] Phase 6: Integration config & documentation

## Design Decisions
- **In-memory agent store**: V1 uses a simple Map for agent state. No persistence needed yet.
- **Async execution**: Agents run in background via promises. `create_agent` returns immediately with an ID; use `get_agent_result` to poll.
- **Streaming responses**: Runner uses `messages.stream()` for real-time progress tracking.
- **EventEmitter for live updates**: AgentManager emits typed events (created, started, progress, completed, failed, cancelled) that the dashboard and orchestrator subscribe to.
- **PM agent loop**: Orchestrator calls Claude to plan sub-tasks, spawns them as worker agents, waits via event subscription, then synthesizes results with a second Claude call.
- **AbortController for cancellation**: Each agent and orchestration gets an AbortController. Cancelling an orchestration cascades to all its worker agents.
- **Zod for validation**: All tool inputs validated with zod schemas before processing.
- **Dashboard on separate port**: HTTP server runs alongside stdio MCP transport, logs to stderr to avoid interference.

## Environment
- Requires `ANTHROPIC_API_KEY` environment variable
- Default model: `claude-sonnet-4-6` (configurable per agent)
- `DASHBOARD_PORT` — web dashboard port (default: 3456)
