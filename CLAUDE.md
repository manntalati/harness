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
  index.ts              # MCP server entry point, tool registration
  agents/
    manager.ts          # AgentManager class — lifecycle & state
    runner.ts           # AgentRunner — calls Anthropic API
    types.ts            # Shared interfaces (AgentConfig, AgentState, etc.)
  templates/
    defaults.ts         # Built-in agent templates
  tools/
    create-agent.ts     # create_agent tool handler
    list-agents.ts      # list_agents tool handler
    get-result.ts       # get_agent_result tool handler
    cancel-agent.ts     # cancel_agent tool handler
    templates.ts        # create_template + list_templates tool handlers
```

## Key Commands
- `npm run build` — Compile TypeScript
- `npm start` — Run the MCP server
- `npm run dev` — Run with ts-node for development
- `npx @modelcontextprotocol/inspector` — Test/debug the server interactively

## Implementation Status
- [ ] Phase 1: Project setup (package.json, tsconfig, structure)
- [ ] Phase 2: Core agent manager & runner
- [ ] Phase 3: MCP tool handlers
- [ ] Phase 4: Built-in templates
- [ ] Phase 5: Server wiring, validation, build scripts
- [ ] Phase 6: Integration config & documentation

## Design Decisions
- **In-memory agent store**: V1 uses a simple Map for agent state. No persistence needed yet.
- **Async execution**: Agents run in background via promises. `create_agent` returns immediately with an ID; use `get_agent_result` to poll.
- **AbortController for cancellation**: Each agent gets an AbortController so `cancel_agent` can cleanly stop API calls.
- **Zod for validation**: All tool inputs validated with zod schemas before processing.

## Environment
- Requires `ANTHROPIC_API_KEY` environment variable
- Default model: `claude-sonnet-4-6` (configurable per agent)
