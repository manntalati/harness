# Harness: plan

## Where it is

The original agent orchestrator (spawn one-shot agents, a PM loop, a table dashboard) has become a persistent playground:

- [x] Persistent world: areas, agents, tasks, messages, inbox, notes, memory (`world.json`)
- [x] Agents that wake on tasks and messages, delegate to each other, and resume when results return
- [x] Inbox with action items, replies, and "send back with feedback" iterations
- [x] Recurring tasks
- [x] Areas attached to folders/repos, with sandboxed file tools and opt-in shell commands
- [x] Two engines: Anthropic API, or Claude Code on the user's Claude plan (no API key)
- [x] Pixel-art town UI: rooms per area, walking sprites, activity bubbles, flying envelopes, live output
- [x] MCP server for Claude Code / Claude Desktop, sharing one live world with the web UI
- [x] Brakes: concurrency, chatter depth, delegation depth, hourly activations, steps per activation

## Ideas for next

- **Meetings**: gather several agents in one room for a structured discussion with a written outcome.
- **Schedules in plain language**: "every weekday at 8am" rather than minutes.
- **Spending budgets**: per area or per day caps (tokens or dollars), not just rate limits.
- **Git-aware workshop areas**: agents work on a branch or worktree and open a PR instead of editing the main checkout.
- **Connectors**: give an area MCP servers of its own (calendar, issue tracker, brokerage read-only, …).
- **Approvals**: let an area require your OK before an agent runs a command or writes outside a drafts folder.
- **Agent day/night**: idle agents head home after hours; a morning digest summarises overnight work.
- **Search** across all results, notes, and reports.
