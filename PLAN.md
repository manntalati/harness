# MCP Agent Orchestrator — Implementation Plan

## Overview

An MCP server that lets you spin up, manage, and collect results from multiple AI agents. Each agent gets its own role (system prompt), task, and optional model configuration. Built with TypeScript, stdio transport, using the Anthropic SDK under the hood.

## Why This Is Useful

- **Parallel work**: Kick off multiple agents at once — research, writing, analysis — and collect results when ready.
- **Specialized roles**: Each agent gets a tailored system prompt (e.g., "You are a senior security auditor") so it performs better at its specific task.
- **Persistent management**: List, monitor, and cancel agents from any Claude interface that connects to this MCP server.

---

## Architecture

```
Claude Code / Desktop
        │
        │ (MCP stdio)
        ▼
┌──────────────────────┐
│  MCP Server          │
│  (agent-orchestrator) │
│                      │
│  Tools:              │
│  - create_agent      │
│  - list_agents       │
│  - get_agent_result  │
│  - cancel_agent      │
│  - create_template   │
│  - list_templates    │
├──────────────────────┤
│  Agent Manager       │
│  (in-memory store)   │
├──────────────────────┤
│  Anthropic SDK       │
│  (Claude API calls)  │
└──────────────────────┘
```

---

## Implementation Steps

### Phase 1: Project Setup
- [ ] Initialize Node.js/TypeScript project (`package.json`, `tsconfig.json`)
- [ ] Install dependencies: `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`, `zod`, `typescript`
- [ ] Set up project structure:
  ```
  src/
    index.ts          # MCP server entry point
    agents/
      manager.ts      # Agent lifecycle management
      runner.ts       # Runs an agent via Anthropic API
      types.ts        # Shared types/interfaces
    templates/
      defaults.ts     # Built-in agent templates (researcher, writer, coder, etc.)
    tools/
      create-agent.ts
      list-agents.ts
      get-result.ts
      cancel-agent.ts
      templates.ts
  ```
- [ ] Create `.env.example` with `ANTHROPIC_API_KEY` placeholder

### Phase 2: Core Agent Manager
- [ ] Define agent types/interfaces (`AgentConfig`, `AgentStatus`, `AgentResult`)
- [ ] Build `AgentManager` class:
  - In-memory store of agents (Map<id, AgentState>)
  - Methods: `create()`, `list()`, `get()`, `cancel()`
  - Status tracking: `pending` → `running` → `completed` / `failed` / `cancelled`
- [ ] Build `AgentRunner`:
  - Takes an `AgentConfig`, calls Anthropic API with streaming
  - Captures full response, stores in AgentState
  - Handles errors gracefully (rate limits, token limits, etc.)

### Phase 3: MCP Tools
- [ ] **`create_agent`** — Spawn a new agent
  - Inputs: `name`, `role` (system prompt), `task` (user message), `model?` (default: claude-sonnet-4-6), `max_tokens?`
  - Returns: agent ID + confirmation
  - Agent runs asynchronously in background
- [ ] **`list_agents`** — Show all agents and their statuses
  - Returns: array of `{ id, name, role, status, created_at, completed_at? }`
- [ ] **`get_agent_result`** — Fetch a completed agent's output
  - Input: `agent_id`
  - Returns: full response text, token usage, status
- [ ] **`cancel_agent`** — Abort a running agent
  - Input: `agent_id`
  - Cancels the API call via AbortController
- [ ] **`create_template`** — Save a reusable agent profile
  - Inputs: `name`, `role`, `model?`, `max_tokens?`
  - Stored in memory (optionally persisted to disk)
- [ ] **`list_templates`** — Show available templates
  - Includes built-in defaults (researcher, writer, code reviewer, etc.)

### Phase 4: Built-in Agent Templates
- [ ] **Researcher** — "You are a thorough research analyst. Gather information, cite sources, and provide a structured summary."
- [ ] **Writer** — "You are a skilled writer. Produce clear, engaging, well-structured content."
- [ ] **Code Reviewer** — "You are a senior engineer. Review code for bugs, security issues, performance, and style."
- [ ] **Summarizer** — "You are an expert at distilling information. Provide concise, accurate summaries."
- [ ] **Planner** — "You are a project planner. Break down goals into actionable steps with priorities and dependencies."

### Phase 5: Server Wiring & Config
- [ ] Wire all tools into MCP server in `index.ts`
- [ ] Add proper error handling and input validation (zod schemas)
- [ ] Add `bin` entry in `package.json` for easy execution
- [ ] Add build script (`tsc`) and `start` script
- [ ] Test locally with `npx @modelcontextprotocol/inspector`

### Phase 6: Integration & Docs
- [ ] Add MCP server config snippet for Claude Desktop (`claude_desktop_config.json`)
- [ ] Add MCP server config snippet for Claude Code (`.mcp.json`)
- [ ] Write README with setup instructions, usage examples, and architecture overview
- [ ] Add example workflows:
  - "Research a topic and then write a blog post about it"
  - "Review 3 PRs in parallel"
  - "Plan a project and break it into tasks"

---

## Future Enhancements (Out of Scope for V1)
- Agent-to-agent communication (chaining outputs)
- Persistent agent history (SQLite)
- Tool-use agents (give agents their own MCP tools)
- Cost tracking per agent
- Webhook notifications on completion
- Agent "teams" — predefined groups that work together on a workflow
