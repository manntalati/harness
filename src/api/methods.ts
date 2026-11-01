import { z } from "zod";
import { isAbsolute, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { World } from "../world/world.js";
import { Scheduler } from "../world/scheduler.js";
import { AGENT_TEMPLATES, ZONE_THEMES } from "../world/blueprints.js";
import { Task, ZoneTheme } from "../world/types.js";
import { MODEL_CHOICES } from "../config.js";
import { engineProblem } from "../agents/engine.js";

// One table of operations shared by the web UI (POST /api/rpc/<name>),
// the MCP server (one tool per method marked `mcp`), and the MCP proxy
// that forwards to an already-running playground.

export interface HarnessContext {
  world: World;
  scheduler: Scheduler;
}

interface Method<S extends z.ZodRawShape> {
  description: string;
  shape: S;
  /** Expose as an MCP tool. UI-only housekeeping methods are left out. */
  mcp: boolean;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: HarnessContext) => unknown;
}

function method<S extends z.ZodRawShape>(def: Method<S>): Method<S> {
  return def;
}

const themeEnum = z.enum(ZONE_THEMES.map((t) => t.id) as [ZoneTheme, ...ZoneTheme[]]);
const effortEnum = z.enum(["low", "medium", "high", "xhigh", "max"]);

function checkWorkspace(path: string | undefined): string | undefined {
  if (!path?.trim()) return undefined;
  const p = path.trim().replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
  if (!isAbsolute(p)) throw new Error(`Workspace must be an absolute path: ${path}`);
  if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error(`Workspace folder doesn't exist: ${p}`);
  return resolve(p);
}

function zoneRef(ctx: HarnessContext, ref: string) {
  const zone = ctx.world.findZone(ref);
  if (!zone) throw new Error(`Area not found: ${ref}. Areas: ${ctx.world.data.zones.map((z) => z.name).join(", ")}`);
  return zone;
}

function agentRef(ctx: HarnessContext, ref: string) {
  const agent = ctx.world.findAgent(ref);
  if (!agent) throw new Error(`Agent not found: ${ref}. Agents: ${ctx.world.data.agents.map((a) => a.name).join(", ")}`);
  return agent;
}

function taskView(ctx: HarnessContext, t: Task, full = false) {
  const w = ctx.world;
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    area: w.zone(t.zoneId)?.name,
    assignee: t.assigneeId ? w.displayName(t.assigneeId) : null,
    createdBy: w.displayName(t.createdBy),
    iteration: t.iteration,
    repeatEveryMinutes: t.repeatEveryMinutes ?? null,
    summary: t.summary ?? null,
    error: t.error ?? null,
    ...(full ? { description: t.description, result: t.result ?? null, feedback: t.feedback ?? null } : {}),
    createdAt: t.createdAt,
    completedAt: t.completedAt ?? null,
  };
}

export const METHODS = {
  // ── Overview ──────────────────────────────────────────────────────
  harness_overview: method({
    description:
      "Overview of the agent harness: every area (project/workspace), the agents in it and what they're doing, open tasks, and unread inbox count. Start here.",
    shape: {},
    mcp: true,
    handler: (_args, ctx) => {
      const w = ctx.world;
      return {
        world: w.data.name,
        paused: w.data.paused,
        engine: ctx.scheduler.engine(),
        engineProblem: engineProblem(w.data.settings.engine, ctx.scheduler.env),
        stats: w.stats(ctx.scheduler.runningCount),
        areas: w.data.zones.map((z) => ({
          id: z.id,
          name: z.name,
          purpose: z.description,
          theme: z.theme,
          workspace: z.workspace ?? null,
          allowCommands: z.allowCommands,
          agents: w.agentsInZone(z.id).map((a) => ({
            id: a.id,
            name: a.name,
            title: a.title,
            status: a.status,
            activity: a.activity,
            doing: a.activityDetail ?? null,
            queued: w.queuedTasksFor(a.id).length,
          })),
        })),
        openTasks: w.data.tasks.filter((t) => t.status === "queued" || t.status === "in_progress").map((t) => taskView(ctx, t)),
      };
    },
  }),

  list_templates: method({
    description: "List the agent templates (researcher, engineer, markets analyst, ...) and area themes you can use.",
    shape: {},
    mcp: true,
    handler: () => ({
      templates: AGENT_TEMPLATES.map(({ id, title, description, webAccess, canHire, homeTheme }) => ({ id, title, description, webAccess, canHire, homeTheme })),
      themes: ZONE_THEMES,
      models: MODEL_CHOICES,
    }),
  }),

  // ── Areas ─────────────────────────────────────────────────────────
  create_area: method({
    description:
      "Open a new area: a project, research stream, or line of work. Optionally attach a folder/repository (absolute path) so agents there can read and edit its files.",
    shape: {
      name: z.string().describe("Area name, e.g. 'Trading Bot' or 'Thesis Research'"),
      purpose: z.string().optional().describe("What this area is for; every agent working here sees it"),
      theme: themeEnum.optional().describe("Visual style of the room"),
      workspace: z.string().optional().describe("Absolute path to a project folder or git repo"),
      allow_commands: z.boolean().optional().describe("Let agents here run shell commands in the workspace (default false)"),
    },
    mcp: true,
    handler: (a, ctx) =>
      ctx.world.createZone({
        name: a.name,
        description: a.purpose,
        theme: a.theme,
        workspace: checkWorkspace(a.workspace),
        allowCommands: a.allow_commands,
      }),
  }),

  update_area: method({
    description: "Change an area's name, purpose, theme, workspace folder, or command permission.",
    shape: {
      area: z.string().describe("Area id or name"),
      name: z.string().optional(),
      purpose: z.string().optional(),
      theme: themeEnum.optional(),
      workspace: z.string().optional().describe("Absolute path, or empty string to detach"),
      allow_commands: z.boolean().optional(),
    },
    mcp: true,
    handler: (a, ctx) => {
      const zone = zoneRef(ctx, a.area);
      return ctx.world.updateZone(zone.id, {
        name: a.name,
        description: a.purpose,
        theme: a.theme,
        workspace: a.workspace === undefined ? undefined : (checkWorkspace(a.workspace) ?? ""),
        allowCommands: a.allow_commands,
      });
    },
  }),

  delete_area: method({
    description: "Close an area. Its agents and tasks move to another area.",
    shape: { area: z.string() },
    mcp: true,
    handler: (a, ctx) => {
      ctx.world.deleteZone(zoneRef(ctx, a.area).id);
      return { ok: true };
    },
  }),

  // ── Agents ────────────────────────────────────────────────────────
  create_agent: method({
    description:
      "Hire an agent into an area, from a template (see list_templates) or with a custom role. Agents sit idle until they get a task or a message.",
    shape: {
      name: z.string().describe("Short unique first name"),
      area: z.string().describe("Area id or name"),
      template: z.string().optional().describe("Template id, e.g. researcher, engineer, markets-analyst, writer, reviewer, planner, chief-of-staff, custom"),
      title: z.string().optional().describe("Job title (defaults to the template's)"),
      role: z.string().optional().describe("Persona / instructions (defaults to the template's)"),
      model: z.string().optional().describe("Model id (defaults to the world default)"),
      effort: effortEnum.optional(),
      web_access: z.boolean().optional().describe("Give web search + fetch"),
      can_hire: z.boolean().optional().describe("Let this agent hire agents and open areas (lead role)"),
    },
    mcp: true,
    handler: (a, ctx) =>
      ctx.world.createAgent({
        name: a.name,
        zoneId: zoneRef(ctx, a.area).id,
        template: a.template,
        title: a.title,
        role: a.role,
        model: a.model,
        effort: a.effort,
        webAccess: a.web_access,
        canHire: a.can_hire,
      }),
  }),

  update_agent: method({
    description: "Change an agent's name, title, role, area, model, effort, or permissions.",
    shape: {
      agent: z.string().describe("Agent id or name"),
      name: z.string().optional(),
      title: z.string().optional(),
      role: z.string().optional(),
      area: z.string().optional().describe("Move to this area"),
      model: z.string().optional().describe("Model id, or empty string for the world default"),
      effort: effortEnum.optional(),
      web_access: z.boolean().optional(),
      can_hire: z.boolean().optional(),
    },
    mcp: true,
    handler: (a, ctx) => {
      const agent = agentRef(ctx, a.agent);
      return ctx.world.updateAgent(agent.id, {
        name: a.name,
        title: a.title,
        role: a.role,
        zoneId: a.area ? zoneRef(ctx, a.area).id : undefined,
        model: a.model,
        effort: a.effort,
        webAccess: a.web_access,
        canHire: a.can_hire,
      });
    },
  }),

  remove_agent: method({
    description: "Remove an agent. Its open tasks go back to its area's queue.",
    shape: { agent: z.string() },
    mcp: true,
    handler: (a, ctx) => {
      const agent = agentRef(ctx, a.agent);
      ctx.scheduler.abort(agent.id, true);
      ctx.world.removeAgent(agent.id);
      return { ok: true };
    },
  }),

  pause_agent: method({
    description: "Pause an agent (stops what it's doing; its task goes back on its queue) or resume it.",
    shape: { agent: z.string(), paused: z.boolean() },
    mcp: true,
    handler: (a, ctx) => {
      const agent = agentRef(ctx, a.agent);
      const updated = ctx.world.setAgentPaused(agent.id, a.paused);
      if (a.paused) ctx.scheduler.abort(agent.id, true);
      return { name: updated.name, status: updated.status };
    },
  }),

  get_agent: method({
    description: "Details for one agent: role, current activity, live output, recent actions, memory, and task history.",
    shape: { agent: z.string() },
    mcp: true,
    handler: (a, ctx) => {
      const w = ctx.world;
      const agent = agentRef(ctx, a.agent);
      return {
        ...w.publicAgent(agent),
        area: w.zone(agent.zoneId)?.name,
        actions: agent.actions.slice(-25),
        tasks: w.data.tasks.filter((t) => t.assigneeId === agent.id).slice(-10).map((t) => taskView(ctx, t)),
      };
    },
  }),

  forget_memory: method({
    description: "Remove one remembered fact from an agent's memory.",
    shape: { agent: z.string(), index: z.number().int().min(0) },
    mcp: false,
    handler: (a, ctx) => {
      ctx.world.forget(agentRef(ctx, a.agent).id, a.index);
      return { ok: true };
    },
  }),

  // ── Tasks ─────────────────────────────────────────────────────────
  assign_task: method({
    description:
      "Give work to an agent (by name) or to an area (it goes to whoever there is free). With neither, it goes to the lead at Headquarters, who plans and delegates. Results come back to the inbox. Set repeat_every_minutes for recurring work (e.g. a daily market scan).",
    shape: {
      title: z.string().describe("Short title"),
      details: z.string().optional().describe("Full instructions, context, and what the deliverable should look like"),
      agent: z.string().optional().describe("Agent id or name"),
      area: z.string().optional().describe("Area id or name"),
      repeat_every_minutes: z.number().int().min(5).optional().describe("Re-run this often (minimum 5)"),
    },
    mcp: true,
    handler: (a, ctx) => {
      const w = ctx.world;
      let agent = a.agent ? agentRef(ctx, a.agent) : undefined;
      let zone = a.area ? zoneRef(ctx, a.area) : undefined;
      if (!agent && !zone) {
        agent = w.data.agents.find((x) => x.canHire && x.status !== "paused") ?? w.data.agents[0];
        if (!agent) throw new Error("There are no agents yet. Create one first.");
      }
      zone ??= w.zone(agent!.zoneId)!;
      const task = w.createTask({
        title: a.title,
        description: a.details,
        zoneId: agent ? agent.zoneId : zone.id,
        assigneeId: agent?.id,
        createdBy: "user",
        repeatEveryMinutes: a.repeat_every_minutes,
      });
      return { ...taskView(ctx, task), note: w.data.paused ? "The world is paused; this will start when you resume it." : "Queued." };
    },
  }),

  list_tasks: method({
    description: "List tasks, optionally filtered by status, area, or agent.",
    shape: {
      status: z.enum(["queued", "in_progress", "done", "failed", "cancelled", "open"]).optional().describe("'open' = queued or in progress"),
      area: z.string().optional(),
      agent: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    mcp: true,
    handler: (a, ctx) => {
      const zoneId = a.area ? zoneRef(ctx, a.area).id : undefined;
      const agentId = a.agent ? agentRef(ctx, a.agent).id : undefined;
      return ctx.world.data.tasks
        .filter((t) => !a.status || (a.status === "open" ? t.status === "queued" || t.status === "in_progress" : t.status === a.status))
        .filter((t) => !zoneId || t.zoneId === zoneId)
        .filter((t) => !agentId || t.assigneeId === agentId)
        .slice(-(a.limit ?? 30))
        .map((t) => taskView(ctx, t));
    },
  }),

  get_task: method({
    description: "Full details and result of one task.",
    shape: { task_id: z.string() },
    mcp: true,
    handler: (a, ctx) => {
      const task = ctx.world.task(a.task_id);
      if (!task) throw new Error(`Task not found: ${a.task_id}`);
      return taskView(ctx, task, true);
    },
  }),

  cancel_task: method({
    description: "Cancel a queued or running task (also stops a recurring task from repeating).",
    shape: { task_id: z.string() },
    mcp: true,
    handler: (a, ctx) => {
      const task = ctx.world.task(a.task_id);
      if (!task) throw new Error(`Task not found: ${a.task_id}`);
      const wasRunning = task.status === "in_progress";
      ctx.world.updateTask(task.id, { status: "cancelled", completedAt: new Date().toISOString(), repeatEveryMinutes: undefined, nextRunAt: undefined });
      if (wasRunning && task.assigneeId) {
        const agent = ctx.world.agent(task.assigneeId);
        if (agent?.focus?.taskId === task.id) ctx.scheduler.abort(task.assigneeId, false);
      }
      return { ok: true };
    },
  }),

  iterate_task: method({
    description:
      "Ask for another pass on a finished task, with your feedback. The same agent gets its previous result plus your notes and produces a revised version.",
    shape: {
      task_id: z.string(),
      feedback: z.string().describe("What to change, dig into further, or fix"),
      agent: z.string().optional().describe("Give the new iteration to a different agent"),
    },
    mcp: true,
    handler: (a, ctx) => {
      const w = ctx.world;
      const task = w.task(a.task_id);
      if (!task) throw new Error(`Task not found: ${a.task_id}`);
      const agent = a.agent ? agentRef(ctx, a.agent) : w.agent(task.assigneeId);
      const next = w.createTask({
        title: task.title,
        description: task.description,
        zoneId: agent?.zoneId ?? task.zoneId,
        assigneeId: agent?.id,
        createdBy: "user",
        iteration: task.iteration + 1,
        previousResult: task.result ?? task.error,
        feedback: a.feedback,
      });
      return taskView(ctx, next);
    },
  }),

  // ── Messages & notes ─────────────────────────────────────────────
  send_message: method({
    description:
      "Message an agent, everyone in an area, or the whole team. The recipients wake up and act on it; replies land in your inbox. Good for steering, answering questions, or brainstorming.",
    shape: {
      to: z.string().describe("Agent name/id, area name/id, or 'everyone'"),
      message: z.string(),
    },
    mcp: true,
    handler: (a, ctx) => {
      const w = ctx.world;
      const key = a.to.trim().toLowerCase();
      let to: string;
      if (key === "everyone" || key === "all") to = "all";
      else {
        const agent = w.findAgent(a.to);
        if (agent) to = agent.id;
        else to = `zone:${zoneRef(ctx, a.to).id}`;
      }
      const msg = w.sendMessage({ from: "user", to, content: a.message, hops: 0 });
      return { delivered: msg.pendingFor.map((id) => w.displayName(id)) };
    },
  }),

  post_note: method({
    description: "Pin a note on an area's board. Every agent working in that area sees recent notes in its briefing; use it for standing instructions or context.",
    shape: { area: z.string(), note: z.string() },
    mcp: true,
    handler: (a, ctx) => ctx.world.addNote(zoneRef(ctx, a.area).id, "user", a.note),
  }),

  remove_note: method({
    description: "Remove a note from an area board.",
    shape: { note_id: z.string() },
    mcp: false,
    handler: (a, ctx) => {
      ctx.world.removeNote(a.note_id);
      return { ok: true };
    },
  }),

  // ── Inbox ─────────────────────────────────────────────────────────
  get_inbox: method({
    description: "Read your inbox: reports, questions, and finished-task results the agents brought back to you, with action items.",
    shape: {
      unread_only: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      mark_read: z.boolean().optional().describe("Mark the returned items as read (default true)"),
    },
    mcp: true,
    handler: (a, ctx) => {
      const w = ctx.world;
      const items = w.data.inbox
        .filter((i) => !i.archived && (!a.unread_only || !i.read))
        .slice(-(a.limit ?? 20));
      if (a.mark_read !== false) for (const i of items) if (!i.read) w.updateInbox(i.id, { read: true });
      return items.map((i) => ({
        id: i.id,
        kind: i.kind,
        from: w.displayName(i.agentId),
        area: w.zone(i.zoneId)?.name ?? null,
        title: i.title,
        body: i.body,
        actionItems: i.actionItems,
        priority: i.priority,
        taskId: i.taskId ?? null,
        createdAt: i.createdAt,
      }));
    },
  }),

  update_inbox_item: method({
    description: "Mark an inbox item read/unread or archived, or toggle one of its action items.",
    shape: {
      item_id: z.string(),
      read: z.boolean().optional(),
      archived: z.boolean().optional(),
      toggle_action: z.number().int().min(0).optional(),
    },
    mcp: false,
    handler: (a, ctx) => ctx.world.updateInbox(a.item_id, { read: a.read, archived: a.archived, toggleAction: a.toggle_action }),
  }),

  mark_all_read: method({
    description: "Mark every inbox item as read.",
    shape: {},
    mcp: false,
    handler: (_a, ctx) => {
      for (const i of ctx.world.data.inbox) if (!i.read) ctx.world.updateInbox(i.id, { read: true });
      return { ok: true };
    },
  }),

  // ── World controls ────────────────────────────────────────────────
  set_paused: method({
    description:
      "Pause or resume the whole harness. Pausing stops agents from starting new work; set stop_running to also interrupt agents mid-task (their tasks go back on the queue).",
    shape: { paused: z.boolean(), stop_running: z.boolean().optional() },
    mcp: true,
    handler: (a, ctx) => {
      ctx.world.setPaused(a.paused);
      if (a.paused && a.stop_running) ctx.scheduler.abortAll();
      return { paused: ctx.world.data.paused };
    },
  }),

  update_settings: method({
    description: "Change harness settings: default model, how many agents run at once, and the safety limits on chatter, delegation depth, and activations per hour.",
    shape: {
      name: z.string().optional().describe("Name shown in the UI"),
      engine: z
        .enum(["auto", "api", "claude-code"])
        .optional()
        .describe("How agents run: 'claude-code' uses the local Claude Code CLI and your Claude plan, 'api' uses an Anthropic API key, 'auto' picks"),
      default_model: z.string().optional(),
      max_concurrent: z.number().int().min(1).max(16).optional(),
      max_steps_per_activation: z.number().int().min(2).max(100).optional(),
      max_hops: z.number().int().min(0).max(10).optional(),
      max_delegation_depth: z.number().int().min(0).max(8).optional(),
      max_activations_per_hour: z.number().int().min(1).max(500).optional(),
    },
    mcp: true,
    handler: (a, ctx) => {
      const patch = Object.fromEntries(
        Object.entries({
          name: a.name,
          engine: a.engine,
          defaultModel: a.default_model,
          maxConcurrent: a.max_concurrent,
          maxStepsPerActivation: a.max_steps_per_activation,
          maxHops: a.max_hops,
          maxDelegationDepth: a.max_delegation_depth,
          maxActivationsPerHour: a.max_activations_per_hour,
        }).filter(([, v]) => v !== undefined),
      );
      ctx.world.updateSettings(patch);
      return ctx.world.data.settings;
    },
  }),
};

export type MethodName = keyof typeof METHODS;

export function isMethod(name: string): name is MethodName {
  return Object.prototype.hasOwnProperty.call(METHODS, name);
}

/** Validates args with the method's schema and runs it. */
export async function callMethod(ctx: HarnessContext, name: string, args: unknown): Promise<unknown> {
  if (!isMethod(name)) throw new Error(`Unknown method: ${name}`);
  const def = METHODS[name] as Method<z.ZodRawShape>;
  const parsed = z.object(def.shape).safeParse(args ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  return await def.handler(parsed.data, ctx);
}
