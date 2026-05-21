# Agent Orchestrator MCP Server

An MCP (Model Context Protocol) server that lets you spin up multiple AI agents, run them concurrently, and monitor everything from a live web dashboard. A built-in **Project Manager agent** can decompose high-level goals into sub-tasks, spawn worker agents, and synthesize results automatically.

## Features

- **Spawn agents on demand** — create agents with custom roles and tasks that run in the background
- **Project Manager orchestration** — give a high-level goal and the PM decomposes it into parallel sub-tasks
- **Live dashboard** — web UI at `http://localhost:3456` with real-time status updates via Server-Sent Events
- **Streaming responses** — agent responses stream in with progress tracking
- **Cancel anytime** — abort individual agents or entire orchestrations mid-flight
- **Reusable templates** — built-in templates (researcher, writer, code-reviewer, etc.) and custom ones

## Prerequisites

- **Node.js** >= 18
- **npm**
- An **Anthropic API key** ([get one here](https://console.anthropic.com/))

## Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd mcp
npm install
```

### 2. Set your API key

Create a `.env` file in the project root (already in `.gitignore`):

```
ANTHROPIC_API_KEY=sk-ant-...
```

Or export it directly:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Build

```bash
npm run build
```

### 4. Run

```bash
npm start
```

The MCP server communicates over **stdio** and the dashboard starts automatically on port **3456**.

For development with auto-reload:

```bash
npm run dev
```

## Connecting to Claude

### Claude Code

Add the server to your Claude Code MCP settings (`~/.claude/settings.json` or project-level `.claude/settings.json`):

```json
{
  "mcpServers": {
    "agent-orchestrator": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/dist/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "agent-orchestrator": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/dist/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

### Testing with the MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

This opens an interactive UI to test each tool directly.

## Dashboard

Once the server is running, open **http://localhost:3456** in your browser.

The dashboard shows:
- **Stats bar** — total agents, running, completed, failed counts
- **Orchestrations** — PM-managed workflows with sub-task progress cards
- **Agent table** — all agents sorted by status with progress indicators
- **Event log** — real-time feed of all agent lifecycle events
- **Result viewer** — click any completed agent or orchestration to read its output

The dashboard port is configurable via the `DASHBOARD_PORT` environment variable (default: `3456`).

## Available MCP Tools

### Agent Management

| Tool | Description |
|------|-------------|
| `create_agent` | Spawn a new agent with a name, role (system prompt), and task. Returns an ID immediately. |
| `list_agents` | List all agents with their current status. |
| `get_agent_result` | Get the full result of a completed agent by ID. |
| `cancel_agent` | Cancel a running agent. |

### Orchestration (Project Manager)

| Tool | Description |
|------|-------------|
| `start_orchestration` | Give a high-level goal. The PM agent plans sub-tasks, spawns workers, and synthesizes results. |
| `get_orchestration_status` | Check orchestration progress — plan, sub-task statuses, final result. |
| `list_orchestrations` | List all orchestrations. |
| `cancel_orchestration` | Cancel an orchestration and all its worker agents. |

### Templates

| Tool | Description |
|------|-------------|
| `create_template` | Save a reusable agent template. |
| `list_templates` | List built-in and custom templates. |

## Example Usage

Once connected to Claude, you can say things like:

> "Start an orchestration to research the top 5 JavaScript frameworks, compare their pros/cons, and write a recommendation report."

The PM agent will:
1. Break this into sub-tasks (e.g., "research React", "research Vue", "compare frameworks", "write report")
2. Spawn worker agents for each
3. Wait for all to complete
4. Synthesize a final cohesive report

Monitor it all in real-time at `http://localhost:3456`.

Or for individual agents:

> "Create an agent named 'code-review' with the role of a senior engineer to review this function for bugs..."

## Architecture

```
                    MCP Client (Claude Code / Desktop)
                           |  stdio
                           v
                    +--------------+
                    |  MCP Server  |  src/index.ts
                    +--------------+
                      |          |
            +---------+          +-----------+
            v                                v
    +---------------+              +------------------+
    | AgentManager  |<------------>|   Orchestrator   |
    | (EventEmitter)|  spawns      | (PM Agent Loop)  |
    +---------------+  agents      +------------------+
            |                         |
            v                         v
    +---------------+         Plan -> Spawn -> Wait -> Synthesize
    | AgentRunner   |
    | (streaming)   |
    +---------------+
            |
            v
    Anthropic Claude API

    +-------------------+
    | Dashboard (HTTP)  |  port 3456
    | SSE event stream  |<--- subscribes to AgentManager events
    | REST API          |
    | Static HTML/JS    |
    +-------------------+
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (required) | Your Anthropic API key |
| `DASHBOARD_PORT` | `3456` | Port for the web dashboard |

## Project Structure

```
src/
  index.ts                  # Entry point — MCP server + dashboard startup
  agents/
    types.ts                # AgentState, events, orchestration types
    manager.ts              # AgentManager — lifecycle, state, event emitter
    runner.ts               # Streaming Anthropic API calls
    orchestrator.ts         # PM agent — plan, execute, synthesize loop
  tools/
    create-agent.ts         # create_agent tool handler
    list-agents.ts          # list_agents tool handler
    get-result.ts           # get_agent_result tool handler
    cancel-agent.ts         # cancel_agent tool handler
    templates.ts            # template tool handlers
    orchestrate.ts          # orchestration tool handlers
  templates/
    defaults.ts             # Built-in agent templates
  dashboard/
    server.ts               # HTTP server with SSE + REST API
    public/
      index.html            # Dashboard frontend (single-page, no build step)
```

## License

MIT
