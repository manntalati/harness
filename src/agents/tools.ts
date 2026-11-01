import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { World } from "../world/world.js";
import { Activity, Agent, Task, Zone, ZoneTheme } from "../world/types.js";
import { AGENT_TEMPLATES, ZONE_THEMES } from "../world/blueprints.js";
import { Workspace } from "./workspace.js";

/** Everything a tool needs to act on behalf of the agent during one activation. */
export interface ToolContext {
  world: World;
  agent: Agent;
  zone: Zone;
  task?: Task;
  /** The task was already started in an earlier activation (e.g. waiting on delegated work). */
  resumed: boolean;
  /** Conversation depth of whatever woke the agent; outgoing chatter is hops + 1. */
  hops: number;
  signal: AbortSignal;
  outcome: {
    completion?: { summary: string; result: string };
    reportedToUser: boolean;
  };
}

interface AgentTool<S extends z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  activity: Activity;
  available: (ctx: ToolContext) => boolean;
  /** One-line description for the activity log and the speech bubble. */
  describe: (input: z.infer<S>, ctx: ToolContext) => string;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<string>;
}

function tool<S extends z.ZodObject>(def: AgentTool<S>): AgentTool<S> {
  return def;
}

export class ToolInputError extends Error {}

type Recipient = { kind: "user" } | { kind: "agent"; agent: Agent } | { kind: "zone"; zone: Zone } | { kind: "all" };

function resolveRecipient(world: World, ref: string): Recipient | undefined {
  const key = ref.trim().toLowerCase().replace(/^@/, "");
  if (["user", "you", "human", "boss", "the user"].includes(key)) return { kind: "user" };
  if (["everyone", "all", "team", "the team"].includes(key)) return { kind: "all" };
  const areaRef = key.startsWith("area:") ? key.slice(5) : undefined;
  if (!areaRef) {
    const agent = world.findAgent(ref);
    if (agent) return { kind: "agent", agent };
  }
  const zone = world.findZone(areaRef ?? ref);
  if (zone) return { kind: "zone", zone };
  return undefined;
}

function teamList(world: World): string {
  return world.data.agents.map((a) => `${a.name} (${a.title}, ${world.zone(a.zoneId)?.name})`).join(", ");
}

function workspaceFor(ctx: ToolContext): Workspace {
  if (!ctx.zone.workspace) throw new ToolInputError("This area has no workspace folder.");
  return new Workspace(ctx.zone.workspace);
}

const hasWorkspace = (ctx: ToolContext) => Boolean(ctx.zone.workspace);
const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ── Collaboration tools ─────────────────────────────────────────────

const sendMessage = tool({
  name: "send_message",
  description:
    "Send a message to a teammate (by name), to everyone in an area (by area name), to 'everyone', or to 'user' (the human you work for). Use it to ask questions, share findings that matter to someone's work, or hand off context. Messages to the user land in their inbox; use report_to_user instead for finished results.",
  schema: z.object({
    to: z.string().describe("Teammate name, area name, 'everyone', or 'user'"),
    message: z.string().describe("The message. Be specific and self-contained."),
  }),
  activity: "messaging",
  available: () => true,
  describe: (i, ctx) => `→ ${ctx.world.displayName(resolveTarget(ctx.world, i.to))}: ${short(i.message, 80)}`,
  async run(input, ctx) {
    const recipient = resolveRecipient(ctx.world, input.to);
    if (!recipient) throw new ToolInputError(`Unknown recipient "${input.to}". Team: ${teamList(ctx.world)}`);
    if (recipient.kind === "user") {
      ctx.world.addInbox({ kind: "message", agentId: ctx.agent.id, title: short(input.message.split("\n")[0], 90), body: input.message, taskId: ctx.task?.id });
      return "Delivered to the user's inbox.";
    }
    if (recipient.kind === "agent" && recipient.agent.id === ctx.agent.id) throw new ToolInputError("You can't message yourself.");
    const to = recipient.kind === "agent" ? recipient.agent.id : recipient.kind === "zone" ? `zone:${recipient.zone.id}` : "all";
    const hops = ctx.hops + 1;
    const msg = ctx.world.sendMessage({ from: ctx.agent.id, to, content: input.message, hops, taskId: ctx.task?.id });
    const names = msg.pendingFor.map((id) => ctx.world.agent(id)?.name).filter(Boolean).join(", ");
    const quiet = hops > ctx.world.data.settings.maxHops;
    return `Delivered to ${names || "nobody"}.${quiet ? " (This conversation is getting long, so they'll read it the next time they are active rather than right away.)" : ""}`;
  },
});

function resolveTarget(world: World, ref: string): string {
  const r = resolveRecipient(world, ref);
  if (!r) return ref;
  if (r.kind === "user") return "user";
  if (r.kind === "all") return "all";
  if (r.kind === "zone") return `zone:${r.zone.id}`;
  return r.agent.id;
}

const delegateTask = tool({
  name: "delegate_task",
  description:
    "Hand a piece of work to a teammate (by name) or to an area (by area name; it goes to whoever is free there). They work on it independently, and their result is sent back to you as a message when they finish. Give them everything they need: the goal, context, constraints, and what the deliverable should look like.",
  schema: z.object({
    to: z.string().describe("Teammate name or area name"),
    title: z.string().describe("Short task title (under 80 characters)"),
    details: z.string().describe("Full instructions, context, and expected deliverable"),
  }),
  activity: "delegating",
  available: () => true,
  describe: (i, ctx) => `delegated "${short(i.title)}" → ${ctx.world.displayName(resolveTarget(ctx.world, i.to))}`,
  async run(input, ctx) {
    const depth = (ctx.task?.depth ?? 0) + 1;
    const max = ctx.world.data.settings.maxDelegationDepth;
    if (depth > max) {
      throw new ToolInputError(`This task is already ${depth - 1} hand-offs deep (limit ${max}). Do the work yourself or report back what's missing.`);
    }
    const recipient = resolveRecipient(ctx.world, input.to);
    if (!recipient || recipient.kind === "user" || recipient.kind === "all") {
      throw new ToolInputError(`Unknown teammate or area "${input.to}". Team: ${teamList(ctx.world)}`);
    }
    if (recipient.kind === "agent" && recipient.agent.id === ctx.agent.id) throw new ToolInputError("You can't delegate to yourself.");
    const task = ctx.world.createTask({
      title: input.title,
      description: input.details,
      zoneId: recipient.kind === "agent" ? recipient.agent.zoneId : recipient.zone.id,
      assigneeId: recipient.kind === "agent" ? recipient.agent.id : undefined,
      createdBy: ctx.agent.id,
      depth,
      parentTaskId: ctx.task?.id,
    });
    const who = recipient.kind === "agent" ? recipient.agent.name : `the ${recipient.zone.name} team`;
    return `Task ${task.id} queued for ${who}. Their result will arrive as a message when they finish; you don't need to wait or poll.`;
  },
});

const completeTask = tool({
  name: "complete_task",
  description:
    "Mark your current task as finished and hand over the deliverable. The result goes to whoever assigned the task. Call this once, when the work is actually done (or when you've established it can't be done, explaining why).",
  schema: z.object({
    summary: z.string().describe("One or two sentences: what you did and the headline outcome"),
    result: z.string().describe("The full deliverable in Markdown: findings, the written piece, what changed in the code, etc."),
  }),
  activity: "done",
  available: (ctx) => Boolean(ctx.task),
  describe: (i) => `completed task: ${short(i.summary, 80)}`,
  async run(input, ctx) {
    ctx.outcome.completion = { summary: input.summary, result: input.result };
    return "Task marked complete. End your turn now unless something else needs doing (e.g. a report to the user).";
  },
});

const reportToUser = tool({
  name: "report_to_user",
  description:
    "Send the user a report in their inbox: finished findings, a recommendation, a decision they need to make, or things they should do. Lead with the answer. List concrete next steps as action_items.",
  schema: z.object({
    title: z.string().describe("Headline of the report"),
    body: z.string().describe("Report body in Markdown"),
    action_items: z.array(z.string()).optional().describe("Concrete things the user should do or decide"),
    priority: z.enum(["low", "normal", "high"]).optional().describe("high = needs attention soon"),
  }),
  activity: "reporting",
  available: () => true,
  describe: (i) => `reported to you: ${short(i.title, 80)}`,
  async run(input, ctx) {
    ctx.world.addInbox({
      kind: "report",
      agentId: ctx.agent.id,
      title: input.title,
      body: input.body,
      actionItems: input.action_items,
      priority: input.priority,
      taskId: ctx.task?.id,
    });
    ctx.outcome.reportedToUser = true;
    return "Report delivered to the user's inbox.";
  },
});

const postNote = tool({
  name: "post_note",
  description: "Pin a note on your area's board. Everyone who works in this area sees recent notes in their briefing. Use it for decisions, conventions, and status others should know.",
  schema: z.object({ note: z.string().describe("The note (short)") }),
  activity: "noting",
  available: () => true,
  describe: (i) => `pinned note: ${short(i.note, 80)}`,
  async run(input, ctx) {
    ctx.world.addNote(ctx.zone.id, ctx.agent.id, input.note);
    return "Note pinned to the area board.";
  },
});

const remember = tool({
  name: "remember",
  description: "Save a fact to your personal long-term memory. You'll see your memory in every future briefing. Use it for user preferences, ongoing commitments, and lessons learned, not for transient details.",
  schema: z.object({ fact: z.string() }),
  activity: "noting",
  available: () => true,
  describe: (i) => `remembered: ${short(i.fact, 80)}`,
  async run(input, ctx) {
    ctx.world.remember(ctx.agent.id, input.fact);
    return "Saved to memory.";
  },
});

const teamStatus = tool({
  name: "team_status",
  description: "See what every teammate is doing right now, and the status of open tasks, including ones you delegated.",
  schema: z.object({}),
  activity: "thinking",
  available: () => true,
  describe: () => "checked on the team",
  async run(_input, ctx) {
    const w = ctx.world;
    const agents = w.data.agents.map((a) => {
      const current = a.focus?.taskId ? w.task(a.focus.taskId)?.title : undefined;
      return `- ${a.name} (${a.title}, ${w.zone(a.zoneId)?.name}): ${a.status}${current ? ` on "${current}"` : ""}; ${w.queuedTasksFor(a.id).length} queued`;
    });
    const open = w.data.tasks.filter((t) => t.status === "queued" || t.status === "in_progress");
    const mine = w.data.tasks.filter((t) => t.createdBy === ctx.agent.id).slice(-15);
    const fmt = (t: Task) => `- [${t.status}] ${t.id} "${t.title}" → ${t.assigneeId ? w.displayName(t.assigneeId) : w.zone(t.zoneId)?.name}`;
    return [
      "Team:",
      ...agents,
      "",
      `Open tasks (${open.length}):`,
      ...open.slice(-20).map(fmt),
      "",
      "Tasks you delegated (latest):",
      ...(mine.length ? mine.map(fmt) : ["(none)"]),
    ].join("\n");
  },
});

const hireAgent = tool({
  name: "hire_agent",
  description: `Add a new agent to the team when nobody has the right skills. Templates: ${AGENT_TEMPLATES.filter((t) => t.id !== "custom").map((t) => `${t.id} (${t.title})`).join(", ")}, or "custom" with your own role. Don't hire for one-off tasks a teammate can handle.`,
  schema: z.object({
    name: z.string().describe("A short first name, unique on the team"),
    template: z.string().describe("Template id, or 'custom'"),
    area: z.string().describe("Name of the area they should work in"),
    title: z.string().optional().describe("Job title (required for custom)"),
    role: z.string().optional().describe("What they do and how they work (required for custom; overrides the template's role)"),
    web_access: z.boolean().optional().describe("Give them web search and fetch"),
  }),
  activity: "hiring",
  available: (ctx) => ctx.agent.canHire,
  describe: (i) => `hired ${i.name} (${i.title ?? i.template}) for ${i.area}`,
  async run(input, ctx) {
    const zone = ctx.world.findZone(input.area);
    if (!zone) throw new ToolInputError(`Unknown area "${input.area}". Areas: ${ctx.world.data.zones.map((z) => z.name).join(", ")}`);
    const agent = ctx.world.createAgent({
      name: input.name,
      template: input.template,
      zoneId: zone.id,
      title: input.title,
      role: input.role,
      webAccess: input.web_access,
      canHire: false,
    });
    return `${agent.name} (${agent.title}) joined ${zone.name}. Delegate work to them by name.`;
  },
});

const openArea = tool({
  name: "open_area",
  description: `Open a new area for a new line of work (a project, a research stream, a product). Themes: ${ZONE_THEMES.map((t) => t.id).join(", ")}. Only the user can attach a code repository to an area.`,
  schema: z.object({
    name: z.string(),
    purpose: z.string().describe("What this area is for"),
    theme: z.enum(ZONE_THEMES.map((t) => t.id) as [ZoneTheme, ...ZoneTheme[]]).optional(),
  }),
  activity: "hiring",
  available: (ctx) => ctx.agent.canHire,
  describe: (i) => `opened area ${i.name}`,
  async run(input, ctx) {
    const zone = ctx.world.createZone({ name: input.name, description: input.purpose, theme: input.theme });
    return `Area "${zone.name}" opened. Hire agents into it or move work there.`;
  },
});

// ── Workspace tools ─────────────────────────────────────────────────

const listFiles = tool({
  name: "list_files",
  description: "List files and folders in this area's workspace (common build/dependency folders are skipped).",
  schema: z.object({
    path: z.string().optional().describe("Folder relative to the workspace root (default: root)"),
    depth: z.number().int().min(1).max(5).optional().describe("How many levels deep (default 2)"),
  }),
  activity: "reading",
  available: hasWorkspace,
  describe: (i) => `listed ${i.path || "workspace"}`,
  run: async (i, ctx) => workspaceFor(ctx).list(i.path, i.depth),
});

const readFileTool = tool({
  name: "read_file",
  description: "Read a text file from the workspace, with line numbers.",
  schema: z.object({
    path: z.string(),
    start_line: z.number().int().min(1).optional(),
    end_line: z.number().int().min(1).optional(),
  }),
  activity: "reading",
  available: hasWorkspace,
  describe: (i) => `read ${i.path}`,
  run: async (i, ctx) => workspaceFor(ctx).read(i.path, i.start_line, i.end_line),
});

const searchFiles = tool({
  name: "search_files",
  description: "Search file contents in the workspace with a regular expression (case-insensitive). Returns file:line matches.",
  schema: z.object({ pattern: z.string(), path: z.string().optional().describe("Limit to this folder or file") }),
  activity: "reading",
  available: hasWorkspace,
  describe: (i) => `searched for /${short(i.pattern, 40)}/`,
  run: async (i, ctx) => workspaceFor(ctx).search(i.pattern, i.path),
});

const writeFileTool = tool({
  name: "write_file",
  description: "Create or overwrite a file in the workspace with the full contents given. Prefer edit_file for changes to existing files.",
  schema: z.object({ path: z.string(), content: z.string() }),
  activity: "editing",
  available: hasWorkspace,
  describe: (i) => `wrote ${i.path}`,
  run: async (i, ctx) => workspaceFor(ctx).write(i.path, i.content),
});

const editFile = tool({
  name: "edit_file",
  description: "Replace one exact, unique snippet of an existing workspace file with new text. Read the file first; include enough surrounding lines that old_string occurs exactly once.",
  schema: z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }),
  activity: "editing",
  available: hasWorkspace,
  describe: (i) => `edited ${i.path}`,
  run: async (i, ctx) => workspaceFor(ctx).edit(i.path, i.old_string, i.new_string),
});

const runCommand = tool({
  name: "run_command",
  description: "Run a shell command in the workspace root (tests, builds, git status, linters). 2-minute timeout; output is truncated. Don't run destructive commands or anything that needs interactive input.",
  schema: z.object({ command: z.string() }),
  activity: "running",
  available: (ctx) => hasWorkspace(ctx) && ctx.zone.allowCommands,
  describe: (i) => `ran \`${short(i.command, 70)}\``,
  run: async (i, ctx) => workspaceFor(ctx).run(i.command, ctx.signal),
});

const ALL_TOOLS = [
  sendMessage,
  delegateTask,
  completeTask,
  reportToUser,
  postNote,
  remember,
  teamStatus,
  hireAgent,
  openArea,
  listFiles,
  readFileTool,
  searchFiles,
  writeFileTool,
  editFile,
  runCommand,
] as AgentTool<z.ZodObject>[];

// ── Building the request's tool list ────────────────────────────────

function jsonSchemaFor(schema: z.ZodObject): Anthropic.Tool.InputSchema {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json as Anthropic.Tool.InputSchema;
}

/** Server-side web tools: the dynamic-filtering versions where the model supports them. */
function webTools(model: string): Anthropic.Beta.BetaToolUnion[] {
  const modern = /claude-(opus-(5|4-[678])|sonnet-(5|4-6)|fable|mythos)/.test(model);
  if (modern) {
    return [
      { type: "web_search_20260209", name: "web_search", max_uses: 8 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8 },
    ];
  }
  return [
    { type: "web_search_20250305", name: "web_search", max_uses: 8 },
    { type: "web_fetch_20250910", name: "web_fetch", max_uses: 8 },
  ];
}

export function toolsFor(ctx: ToolContext, model: string): Anthropic.Beta.BetaToolUnion[] {
  const custom: Anthropic.Beta.BetaToolUnion[] = ALL_TOOLS.filter((t) => t.available(ctx)).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: jsonSchemaFor(t.schema),
    // Streamed request: let large inputs (file contents, reports) stream as generated.
    // We validate every input against the zod schema before running it.
    eager_input_streaming: true,
  }));
  return ctx.agent.webAccess ? [...custom, ...webTools(model)] : custom;
}

export function toolActivity(name: string): Activity {
  if (name === "web_search") return "searching";
  if (name === "web_fetch") return "reading";
  return ALL_TOOLS.find((t) => t.name === name)?.activity ?? "thinking";
}

export interface ToolRunResult {
  content: string;
  isError: boolean;
  summary: string;
}

const WORKSPACE_TOOLS = new Set(["list_files", "read_file", "search_files", "write_file", "edit_file", "run_command"]);

/**
 * Team tools for agents running inside Claude Code: everything except the
 * file/shell tools, which Claude Code provides natively.
 */
export function bridgeTools(ctx: ToolContext): { name: string; description: string; shape: z.ZodRawShape }[] {
  return ALL_TOOLS.filter((t) => !WORKSPACE_TOOLS.has(t.name) && t.available(ctx)).map((t) => ({
    name: t.name,
    description: t.description,
    shape: t.schema.shape,
  }));
}

/** Runs a tool and records it on the agent (activity bubble + action log). */
export async function executeTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolRunResult> {
  ctx.world.setAgentState(ctx.agent.id, { activity: toolActivity(name) });
  const result = await runTool(name, input, ctx);
  ctx.world.addAction(ctx.agent.id, result.isError ? "error" : "tool", result.summary);
  ctx.world.setAgentState(ctx.agent.id, { activityDetail: result.summary.slice(0, 120) });
  return result;
}

/** Validates the (eagerly streamed, so unvalidated) input and runs the tool. */
export async function runTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolRunResult> {
  const def = ALL_TOOLS.find((t) => t.name === name);
  if (!def || !def.available(ctx)) {
    return { content: `Tool ${name} is not available to you.`, isError: true, summary: `tried unavailable tool ${name}` };
  }
  const parsed = def.schema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      content: JSON.stringify({ INVALID_JSON: JSON.stringify(rawInput), problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }),
      isError: true,
      summary: `${name} with invalid input`,
    };
  }
  const summary = def.describe(parsed.data, ctx);
  try {
    const content = await def.run(parsed.data, ctx);
    return { content, isError: false, summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${message}`, isError: true, summary: `${summary} (failed: ${short(message, 80)})` };
  }
}
