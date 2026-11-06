# CLAUDE.md — Harness

## Project overview
A persistent playground of collaborating AI agents, rendered as a pixel-art town in the browser and exposed as an MCP server. Areas (rooms) are projects or lines of work, optionally attached to a folder/repo. Agents live in areas, pick up tasks, message and delegate to each other, and report back to the user's inbox.

## Tech stack
- TypeScript on Node.js (ESM, `"module": "Node16"`), no frontend build step
- `@anthropic-ai/sdk` (API engine), `@modelcontextprotocol/sdk` (MCP server + agent bridge), `zod` v4
- Optional: the local `claude` CLI (Claude Code engine, runs on the user's Claude plan)

## Commands
- `npm run build`: compile to `dist/` and copy `src/server/public`
- `npm start`: run the playground (`node dist/index.js serve`) at http://localhost:3456
- `npm run dev`: same via `tsx`
- `npm run typecheck`
- `node dist/index.js mcp`: MCP over stdio (forwards to a running playground if one is up)

## Layout
- `src/world/`: the model (`types.ts`), store + persistence + events (`world.ts`), scheduler, templates/themes/starter team (`blueprints.ts`)
- `src/agents/`: activation lifecycle (`runtime.ts`), engines (API loop in `runtime.ts`, `claude-code.ts`), MCP bridge for Claude Code agents (`bridge.ts`), tools, workspace sandbox, prompts
- `src/api/methods.ts`: the single table of operations. The web UI calls them at `POST /api/rpc/<name>`; methods with `mcp: true` are also MCP tools. Add new operations here, not in two places.
- `src/server/http.ts`: static UI, `/api/state` snapshot, `/events` SSE stream, `/mcp/agent/<token>` bridge
- `src/server/public/js/`: `pixel.js` (procedural art), `town.js` (layout, routing, sprites, bubbles), `app.js` (state sync, panels, modals), `markdown.js`

## Design decisions
- **Persistent world**: everything is in `~/.agent-harness/world.json` (debounced atomic writes, trimmed history). In-flight tasks are re-queued on restart.
- **Activations, not chat sessions**: an agent wakes for queued tasks or new messages and gets a fresh briefing each time (area, team, notes, memory, recent work, trigger). Durable state is `remember` (personal) and `post_note` (area). The system prompt is stable per agent so it caches.
- **Collaboration**: `delegate_task` creates a child task; when it finishes, the result is sent to the delegator as a `task_result` message, which resumes the parent task. A task with open children stays `in_progress` while the agent is free for other work.
- **Brakes**: concurrency cap, chatter depth (`hops`), delegation depth, activations/hour, steps per run. Result messages and user messages always wake.
- **Step limit is a checkpoint, not an ending**: a run that hits `maxStepsPerActivation` without `complete_task` saves `task.progress` (journal of what it did) and re-queues the task (`continuations`, max `maxContinuations`); the scheduler prefers already-started tasks. Claude Code continues via `--resume <task.sessionId>`; the API engine continues the in-memory conversation (falls back to the progress notes after a restart). Out of runs → task fails with its progress and goes to the inbox for an Iterate.
- **Two engines**: `api` (streamed manual tool loop: adaptive thinking with summarized display, server-side fallbacks, eager input streaming with zod validation, web search/fetch server tools) and `claude-code` (`claude -p --output-format stream-json`, `--tools` limited to what the area allows, `--permission-mode dontAsk`, team tools over a per-activation MCP URL, sessions persisted only for task runs). Hitting a Claude plan usage limit re-queues the task and pauses the world.
- **External email agents** (`agent.email`, e.g. Instinct): never run a model. `agents/email.ts` emails their tasks (and direct messages, as tasks with `replyAsMessage`), retries failed sends with backoff, re-sends login failures when the account changes (`mailVersion`), checks the Sent folder before any re-send, enforces `maxEmailsPerDay`, and polls IMAP every 30 s for authenticated tagged replies. The account comes from `HARNESS_MAIL_*` env vars or `<home>/mail.json` (Settings → Email, `agents/mailer.ts`).
- **Safety**: file tools resolve real paths and refuse anything outside the area folder; shell commands are opt-in per area; the server binds to loopback, checks the Host header, requires JSON content-type, and rejects cross-origin POSTs.
- **UI**: everything the map shows is derived from the state snapshot plus SSE events. Token streams are coalesced server-side (~8 updates/s). Panel regions re-render only when their HTML changes, and inputs keep their values across refreshes.

## Environment
- `HARNESS_ENGINE` (`auto` | `api` | `claude-code`), `ANTHROPIC_API_KEY` (API engine only), `HARNESS_MODEL` (default `claude-opus-5-5`), `CLAUDE_BIN`, `HARNESS_PORT` (default 3456), `HARNESS_HOME`, `HARNESS_HOST`
- Logs go to stderr; stdout is reserved for MCP.
