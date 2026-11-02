import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MODEL_PRICES } from "../config.js";
import {
  Agent,
  AgentAction,
  Effort,
  InboxItem,
  InboxKind,
  LogEntry,
  LogKind,
  Message,
  MessageKind,
  Note,
  Priority,
  PublicAgent,
  Task,
  WorldData,
  WorldEvent,
  WorldSettings,
  WorldStats,
  Zone,
  ZoneTheme,
} from "./types.js";
import {
  AGENT_TEMPLATES,
  STARTER_AGENTS,
  STARTER_ZONES,
  appearanceFor,
  getTemplate,
} from "./blueprints.js";

const LIMITS = {
  messages: 600,
  log: 400,
  notesPerZone: 60,
  finishedTasks: 300,
  inbox: 400,
  actionsPerAgent: 80,
  memoryPerAgent: 40,
  liveText: 6000,
};

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(5).toString("hex")}`;
}

function now(): string {
  return new Date().toISOString();
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

export function defaultSettings(defaultModel: string): WorldSettings {
  const engine = process.env.HARNESS_ENGINE;
  return {
    engine: engine === "api" || engine === "claude-code" ? engine : "auto",
    defaultModel,
    maxConcurrent: 3,
    maxStepsPerActivation: 50,
    maxContinuations: 5,
    maxHops: 3,
    maxDelegationDepth: 3,
    maxActivationsPerHour: 40,
    maxAgents: 30,
    maxZones: 16,
  };
}

export interface CreateZoneInput {
  name: string;
  description?: string;
  theme?: ZoneTheme;
  workspace?: string;
  allowCommands?: boolean;
}

export interface CreateAgentInput {
  name: string;
  zoneId: string;
  template?: string;
  title?: string;
  role?: string;
  email?: string;
  model?: string;
  effort?: Effort;
  webAccess?: boolean;
  canHire?: boolean;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  zoneId: string;
  assigneeId?: string;
  createdBy: string;
  depth?: number;
  parentTaskId?: string;
  repeatEveryMinutes?: number;
  feedback?: string;
  previousResult?: string;
  iteration?: number;
}

export interface SendMessageInput {
  from: string;
  to: string;
  content: string;
  kind?: MessageKind;
  hops?: number;
  taskId?: string;
}

export interface InboxInput {
  kind: InboxKind;
  agentId: string;
  title: string;
  body: string;
  actionItems?: string[];
  priority?: Priority;
  taskId?: string;
}

type Listener = (event: WorldEvent) => void;

/**
 * The world: every zone, agent, task, message and inbox item, with an event
 * stream for the UI and debounced JSON persistence.
 */
export class World {
  data: WorldData;
  private emitter = new EventEmitter();
  private saveTimer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();

  private constructor(private file: string, data: WorldData) {
    this.data = data;
    this.emitter.setMaxListeners(100);
  }

  static async load(home: string, defaultModel: string): Promise<World> {
    await mkdir(home, { recursive: true });
    const file = join(home, "world.json");
    let data: WorldData | null = null;
    if (existsSync(file)) {
      try {
        data = JSON.parse(await readFile(file, "utf8")) as WorldData;
      } catch (err) {
        const backup = `${file}.corrupt-${Date.now()}`;
        await rename(file, backup);
        process.stderr.write(`[harness] world.json was unreadable (${String(err)}); moved to ${backup}\n`);
      }
    }
    const isNew = !data;
    const world = new World(file, data ?? World.emptyData(defaultModel));
    if (isNew) world.seedStarter();
    world.recoverAfterRestart();
    world.scheduleSave();
    return world;
  }

  private static emptyData(defaultModel: string): WorldData {
    return {
      version: 1,
      name: "My Harness",
      paused: false,
      settings: defaultSettings(defaultModel),
      zones: [],
      agents: [],
      tasks: [],
      messages: [],
      inbox: [],
      notes: [],
      log: [],
      createdAt: now(),
    };
  }

  private seedStarter(): void {
    const zoneIds = new Map<string, string>();
    for (const z of STARTER_ZONES) {
      const zone = this.createZone({ name: z.name, description: z.description, theme: z.theme });
      zoneIds.set(z.key, zone.id);
    }
    for (const a of STARTER_AGENTS) {
      this.createAgent({ name: a.name, template: a.template, zoneId: zoneIds.get(a.zone)! });
    }
    this.log("system", "Welcome! Your starter team is ready. Give Mira at Headquarters a goal to get going.");
  }

  /** Anything that was mid-flight when the process stopped goes back on the queue. */
  private recoverAfterRestart(): void {
    // Worlds from before step-limit continuations kept the old 24-step default; give them the new one.
    const saved = this.data.settings as Partial<WorldSettings>;
    if (saved.maxContinuations === undefined && saved.maxStepsPerActivation === 24) saved.maxStepsPerActivation = 50;
    // Fill in settings added after this world.json was written.
    this.data.settings = { ...defaultSettings(this.data.settings.defaultModel), ...this.data.settings };
    for (const agent of this.data.agents) {
      if (agent.status === "working" || agent.status === "error") {
        agent.status = "idle";
      }
      if (agent.status !== "paused") agent.activity = "idle";
      agent.focus = undefined;
      agent.activityDetail = undefined;
    }
    for (const task of this.data.tasks) {
      if (task.status === "in_progress" && !task.emailHandoff) {
        task.status = "queued";
        task.startedAt = undefined;
      }
    }
  }

  // ── Events & persistence ───────────────────────────────────────────

  on(listener: Listener): void {
    this.emitter.on("event", listener);
  }

  off(listener: Listener): void {
    this.emitter.off("event", listener);
  }

  /** Fired whenever something happened that might give an agent work to do. */
  onWork(listener: () => void): void {
    this.emitter.on("work", listener);
  }

  private emit(event: WorldEvent): void {
    this.emitter.emit("event", event);
  }

  private work(): void {
    this.emitter.emit("work");
  }

  scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 400);
  }

  async flush(): Promise<void> {
    this.trim();
    const json = JSON.stringify(this.data, null, 1);
    this.saving = this.saving.then(async () => {
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, json, "utf8");
      await rename(tmp, this.file);
    }).catch((err) => {
      process.stderr.write(`[harness] failed to save world: ${String(err)}\n`);
    });
    return this.saving;
  }

  private trim(): void {
    const d = this.data;
    if (d.messages.length > LIMITS.messages) {
      // Keep anything an agent still has to read.
      const excess = d.messages.length - LIMITS.messages;
      let dropped = 0;
      d.messages = d.messages.filter((m) => {
        if (dropped < excess && m.pendingFor.length === 0) {
          dropped++;
          return false;
        }
        return true;
      });
    }
    if (d.log.length > LIMITS.log) d.log = d.log.slice(-LIMITS.log);
    const finished = d.tasks.filter((t) => ["done", "failed", "cancelled"].includes(t.status) && !t.repeatEveryMinutes);
    if (finished.length > LIMITS.finishedTasks) {
      const drop = new Set(finished.slice(0, finished.length - LIMITS.finishedTasks).map((t) => t.id));
      d.tasks = d.tasks.filter((t) => !drop.has(t.id));
    }
    const archived = d.inbox.filter((i) => i.archived);
    if (d.inbox.length > LIMITS.inbox && archived.length) {
      const drop = new Set(archived.slice(0, d.inbox.length - LIMITS.inbox).map((i) => i.id));
      d.inbox = d.inbox.filter((i) => !drop.has(i.id));
    }
    for (const zone of d.zones) {
      const notes = d.notes.filter((n) => n.zoneId === zone.id);
      if (notes.length > LIMITS.notesPerZone) {
        const drop = new Set(notes.slice(0, notes.length - LIMITS.notesPerZone).map((n) => n.id));
        d.notes = d.notes.filter((n) => !drop.has(n.id));
      }
    }
  }

  // ── Queries ────────────────────────────────────────────────────────

  zone(id: string | undefined): Zone | undefined {
    return id ? this.data.zones.find((z) => z.id === id) : undefined;
  }

  agent(id: string | undefined): Agent | undefined {
    return id ? this.data.agents.find((a) => a.id === id) : undefined;
  }

  task(id: string | undefined): Task | undefined {
    return id ? this.data.tasks.find((t) => t.id === id) : undefined;
  }

  /** Accepts an id or a (case-insensitive) name. */
  findAgent(ref: string | undefined): Agent | undefined {
    if (!ref) return undefined;
    const key = ref.trim().toLowerCase().replace(/^@/, "");
    return (
      this.data.agents.find((a) => a.id === ref) ??
      this.data.agents.find((a) => a.name.toLowerCase() === key) ??
      this.data.agents.find((a) => a.name.toLowerCase().startsWith(key))
    );
  }

  findZone(ref: string | undefined): Zone | undefined {
    if (!ref) return undefined;
    const key = ref.trim().toLowerCase();
    return (
      this.data.zones.find((z) => z.id === ref) ??
      this.data.zones.find((z) => z.name.toLowerCase() === key) ??
      this.data.zones.find((z) => z.name.toLowerCase().includes(key))
    );
  }

  agentsInZone(zoneId: string): Agent[] {
    return this.data.agents.filter((a) => a.zoneId === zoneId);
  }

  /** The agent that receives work handed to an area without a specific assignee. */
  zoneLead(zoneId: string): Agent | undefined {
    const agents = this.agentsInZone(zoneId).filter((a) => a.status !== "paused");
    return agents.find((a) => a.canHire) ?? agents[0];
  }

  pendingMessagesFor(agentId: string): Message[] {
    return this.data.messages.filter((m) => m.pendingFor.includes(agentId));
  }

  queuedTasksFor(agentId: string): Task[] {
    return this.data.tasks.filter((t) => t.assigneeId === agentId && t.status === "queued");
  }

  displayName(ref: string): string {
    if (ref === "user") return "You";
    if (ref === "all") return "everyone";
    if (ref.startsWith("zone:")) return this.zone(ref.slice(5))?.name ?? "an area";
    return this.agent(ref)?.name ?? "a former teammate";
  }

  publicAgent(agent: Agent): PublicAgent {
    return {
      ...agent,
      liveText: clip(agent.liveText, 2000),
      liveThought: clip(agent.liveThought, 600),
    };
  }

  stats(running: number): WorldStats {
    const totals = this.data.agents.reduce(
      (acc, a) => {
        acc.inputTokens += a.stats.inputTokens;
        acc.outputTokens += a.stats.outputTokens;
        acc.costUsd += a.stats.costUsd;
        return acc;
      },
      { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    );
    return {
      ...totals,
      running,
      queuedTasks: this.data.tasks.filter((t) => t.status === "queued").length,
      unreadInbox: this.data.inbox.filter((i) => !i.read && !i.archived).length,
    };
  }

  snapshot(running: number) {
    const d = this.data;
    const tasks = d.tasks.filter((t) => !["done", "failed", "cancelled"].includes(t.status) || t.repeatEveryMinutes);
    const finished = d.tasks.filter((t) => !tasks.includes(t)).slice(-150);
    return {
      name: d.name,
      paused: d.paused,
      settings: d.settings,
      zones: d.zones,
      agents: d.agents.map((a) => this.publicAgent(a)),
      tasks: [...tasks, ...finished],
      messages: d.messages.slice(-200),
      inbox: d.inbox.filter((i) => !i.archived).concat(d.inbox.filter((i) => i.archived).slice(-50)),
      notes: d.notes.slice(-200),
      log: d.log.slice(-150),
      stats: this.stats(running),
    };
  }

  // ── World ──────────────────────────────────────────────────────────

  setPaused(paused: boolean): void {
    this.data.paused = paused;
    this.log("system", paused ? "World paused — no agent will start new work." : "World resumed.");
    this.emitWorld();
    if (!paused) this.work();
  }

  updateSettings(patch: Partial<WorldSettings> & { name?: string }): void {
    const { name, ...settings } = patch;
    if (name) this.data.name = name;
    this.data.settings = { ...this.data.settings, ...settings };
    this.emitWorld();
    this.work();
  }

  private emitWorld(): void {
    this.emit({ type: "world", paused: this.data.paused, settings: this.data.settings, name: this.data.name });
    this.scheduleSave();
  }

  emitStats(running: number): void {
    this.emit({ type: "stats", stats: this.stats(running) });
  }

  // ── Zones ──────────────────────────────────────────────────────────

  createZone(input: CreateZoneInput): Zone {
    if (this.data.zones.length >= this.data.settings.maxZones) {
      throw new Error(`Area limit reached (${this.data.settings.maxZones}). Remove an area or raise maxZones in settings.`);
    }
    const name = input.name.trim();
    if (!name) throw new Error("Area name is required");
    if (this.data.zones.some((z) => z.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`An area named "${name}" already exists`);
    }
    const zone: Zone = {
      id: newId("zone"),
      name,
      description: input.description?.trim() ?? "",
      theme: input.theme ?? "garden",
      workspace: input.workspace?.trim() || undefined,
      allowCommands: input.allowCommands ?? false,
      createdAt: now(),
    };
    this.data.zones.push(zone);
    this.emit({ type: "zone", zone });
    this.log("zone", `New area opened: ${zone.name}`, { zoneId: zone.id });
    this.scheduleSave();
    return zone;
  }

  updateZone(id: string, patch: Partial<Omit<Zone, "id" | "createdAt">>): Zone {
    const zone = this.zone(id);
    if (!zone) throw new Error(`Area not found: ${id}`);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error("Area name is required");
      if (this.data.zones.some((z) => z.id !== id && z.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`An area named "${name}" already exists`);
      }
      zone.name = name;
    }
    if (patch.description !== undefined) zone.description = patch.description;
    if (patch.theme !== undefined) zone.theme = patch.theme;
    if (patch.workspace !== undefined) zone.workspace = patch.workspace.trim() || undefined;
    if (patch.allowCommands !== undefined) zone.allowCommands = patch.allowCommands;
    this.emit({ type: "zone", zone });
    this.scheduleSave();
    return zone;
  }

  /** Deletes an area; its agents and open tasks move to another area. */
  deleteZone(id: string): void {
    const zone = this.zone(id);
    if (!zone) throw new Error(`Area not found: ${id}`);
    const fallback = this.data.zones.find((z) => z.id !== id);
    if (!fallback) throw new Error("You can't delete the last area");
    for (const agent of this.agentsInZone(id)) {
      agent.zoneId = fallback.id;
      this.emitAgent(agent);
    }
    for (const task of this.data.tasks) {
      if (task.zoneId === id) {
        task.zoneId = fallback.id;
        this.emit({ type: "task", task });
      }
    }
    this.data.notes = this.data.notes.filter((n) => n.zoneId !== id);
    this.data.zones = this.data.zones.filter((z) => z.id !== id);
    this.emit({ type: "zone:removed", id });
    this.log("zone", `Area closed: ${zone.name}. Its team moved to ${fallback.name}.`);
    this.scheduleSave();
  }

  // ── Agents ─────────────────────────────────────────────────────────

  createAgent(input: CreateAgentInput): Agent {
    if (this.data.agents.length >= this.data.settings.maxAgents) {
      throw new Error(`Agent limit reached (${this.data.settings.maxAgents}).`);
    }
    if ("email" in input && input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.email).trim())) throw new Error("Invalid external email address");
    const zone = this.zone(input.zoneId);
    if (!zone) throw new Error(`Area not found: ${input.zoneId}`);
    const name = input.name.trim();
    if (!name) throw new Error("Agent name is required");
    if (/^(user|you|all|everyone|zone)$/i.test(name)) throw new Error(`"${name}" is a reserved name`);
    if (this.data.agents.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`An agent named "${name}" already exists`);
    }
    const template = getTemplate(input.template) ?? AGENT_TEMPLATES.find((t) => t.id === "custom")!;
    const role = (input.role ?? (input.email ? "External assistant reached through owner-reviewed email handoffs." : template.role)).trim();
    if (!role) throw new Error("Describe the agent's role (what it does and how it works)");
    const agent: Agent = {
      id: newId("agt"),
      name,
      title: input.title?.trim() || template.title,
      role,
      template: template.id,
      zoneId: zone.id,
      email: input.email?.trim() || undefined,
      model: input.model || undefined,
      effort: input.effort ?? template.effort,
      webAccess: input.email ? false : input.webAccess ?? template.webAccess,
      canHire: input.email ? false : input.canHire ?? template.canHire,
      appearance: appearanceFor(name),
      status: "idle",
      activity: "idle",
      memory: [],
      actions: [],
      liveText: "",
      liveThought: "",
      stats: { tasksDone: 0, activations: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      createdAt: now(),
    };
    this.data.agents.push(agent);
    this.emitAgent(agent);
    this.log("agent", `${agent.name} (${agent.title}) joined ${zone.name}`, { agentId: agent.id, zoneId: zone.id });
    this.scheduleSave();
    return agent;
  }

  updateAgent(
    id: string,
    patch: Partial<Pick<Agent, "name" | "title" | "role" | "zoneId" | "email" | "model" | "effort" | "webAccess" | "canHire">>,
  ): Agent {
    const agent = this.agent(id);
    if (!agent) throw new Error(`Agent not found: ${id}`);
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error("Agent name is required");
      if (this.data.agents.some((a) => a.id !== id && a.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`An agent named "${name}" already exists`);
      }
      agent.name = name;
    }
    if (patch.zoneId !== undefined && patch.zoneId !== agent.zoneId) {
      const zone = this.zone(patch.zoneId);
      if (!zone) throw new Error(`Area not found: ${patch.zoneId}`);
      agent.zoneId = zone.id;
      this.log("agent", `${agent.name} moved to ${zone.name}`, { agentId: agent.id, zoneId: zone.id });
    }
    if (patch.title !== undefined) agent.title = patch.title;
    if (patch.role !== undefined && patch.role.trim()) agent.role = patch.role;
    if (patch.email !== undefined) agent.email = patch.email.trim() || undefined;
    if (patch.model !== undefined) agent.model = patch.model || undefined;
    if (patch.effort !== undefined) agent.effort = patch.effort;
    if (patch.webAccess !== undefined) agent.webAccess = patch.webAccess;
    if (patch.canHire !== undefined) agent.canHire = patch.canHire;
    this.emitAgent(agent);
    this.scheduleSave();
    return agent;
  }

  removeAgent(id: string): void {
    const agent = this.agent(id);
    if (!agent) throw new Error(`Agent not found: ${id}`);
    this.data.agents = this.data.agents.filter((a) => a.id !== id);
    for (const task of this.data.tasks) {
      if (task.assigneeId === id && (task.status === "queued" || task.status === "in_progress")) {
        task.assigneeId = undefined;
        task.status = "queued";
        this.emit({ type: "task", task });
      }
    }
    for (const m of this.data.messages) m.pendingFor = m.pendingFor.filter((p) => p !== id);
    this.emit({ type: "agent:removed", id });
    this.log("agent", `${agent.name} left the team`);
    this.scheduleSave();
    this.work();
  }

  setAgentPaused(id: string, paused: boolean): Agent {
    const agent = this.agent(id);
    if (!agent) throw new Error(`Agent not found: ${id}`);
    agent.status = paused ? "paused" : "idle";
    agent.activity = "idle";
    agent.lastError = paused ? agent.lastError : undefined;
    this.emitAgent(agent);
    this.scheduleSave();
    if (!paused) this.work();
    return agent;
  }

  /** Runtime state changes (status, activity, focus). */
  setAgentState(id: string, patch: Partial<Pick<Agent, "status" | "activity" | "activityDetail" | "focus" | "lastError">>): void {
    const agent = this.agent(id);
    if (!agent) return;
    Object.assign(agent, patch);
    this.emitAgent(agent);
    this.scheduleSave();
  }

  emitAgent(agent: Agent): void {
    this.emit({ type: "agent", agent: this.publicAgent(agent) });
  }

  addAction(agentId: string, kind: AgentAction["kind"], text: string): void {
    const agent = this.agent(agentId);
    if (!agent) return;
    agent.actions.push({ ts: now(), kind, text: text.slice(0, 600) });
    if (agent.actions.length > LIMITS.actionsPerAgent) agent.actions = agent.actions.slice(-LIMITS.actionsPerAgent);
    this.scheduleSave();
  }

  /** Live text/thought streaming. Not every delta is persisted, only the rolling tail. */
  streamAgent(id: string, delta: { text?: string; thought?: string; reset?: boolean }): void {
    const agent = this.agent(id);
    if (!agent) return;
    if (delta.reset) {
      agent.liveText = "";
      agent.liveThought = "";
    }
    if (delta.text) agent.liveText = clip(agent.liveText + delta.text, LIMITS.liveText);
    if (delta.thought) agent.liveThought = clip(agent.liveThought + delta.thought, LIMITS.liveText);
    this.emit({ type: "agent:stream", id, ...delta });
  }

  remember(agentId: string, fact: string): void {
    const agent = this.agent(agentId);
    if (!agent) return;
    agent.memory.push(fact.slice(0, 500));
    if (agent.memory.length > LIMITS.memoryPerAgent) agent.memory = agent.memory.slice(-LIMITS.memoryPerAgent);
    this.emitAgent(agent);
    this.scheduleSave();
  }

  forget(agentId: string, index: number): void {
    const agent = this.agent(agentId);
    if (!agent) return;
    agent.memory.splice(index, 1);
    this.emitAgent(agent);
    this.scheduleSave();
  }

  addUsage(agentId: string, model: string, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): void {
    const agent = this.agent(agentId);
    if (!agent) return;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    agent.stats.inputTokens += usage.input_tokens + cacheRead + cacheWrite;
    agent.stats.outputTokens += usage.output_tokens;
    const price = MODEL_PRICES[model];
    if (price) {
      agent.stats.costUsd +=
        (usage.input_tokens * price.input + cacheRead * price.input * 0.1 + cacheWrite * price.input * 1.25 + usage.output_tokens * price.output) /
        1_000_000;
    }
    this.scheduleSave();
  }

  // ── Tasks ──────────────────────────────────────────────────────────

  createTask(input: CreateTaskInput): Task {
    const zone = this.zone(input.zoneId);
    if (!zone) throw new Error(`Area not found: ${input.zoneId}`);
    if (input.assigneeId && !this.agent(input.assigneeId)) throw new Error(`Agent not found: ${input.assigneeId}`);
    const task: Task = {
      id: newId("task"),
      title: input.title.trim().slice(0, 200) || "Untitled task",
      description: input.description?.trim() ?? "",
      zoneId: zone.id,
      assigneeId: input.assigneeId,
      createdBy: input.createdBy,
      status: "queued",
      depth: input.depth ?? 0,
      parentTaskId: input.parentTaskId,
      repeatEveryMinutes: input.repeatEveryMinutes && input.repeatEveryMinutes > 0 ? input.repeatEveryMinutes : undefined,
      iteration: input.iteration ?? 1,
      feedback: input.feedback,
      previousResult: input.previousResult,
      createdAt: now(),
    };
    this.data.tasks.push(task);
    this.emit({ type: "task", task });
    const who = task.assigneeId ? this.displayName(task.assigneeId) : zone.name;
    this.log("task", `${this.displayName(task.createdBy)} → ${who}: ${task.title}`, {
      agentId: input.createdBy === "user" ? undefined : input.createdBy,
      targetAgentId: task.assigneeId,
      zoneId: zone.id,
    });
    this.scheduleSave();
    this.work();
    return task;
  }

  updateTask(id: string, patch: Partial<Task>): Task {
    const task = this.task(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    Object.assign(task, patch);
    this.emit({ type: "task", task });
    this.scheduleSave();
    this.work();
    return task;
  }

  // ── Messages ───────────────────────────────────────────────────────

  /** Resolves the recipient list for a message address. */
  recipients(from: string, to: string): string[] {
    if (to === "user") return [];
    if (to === "all") return this.data.agents.filter((a) => a.id !== from).map((a) => a.id);
    if (to.startsWith("zone:")) {
      return this.agentsInZone(to.slice(5)).filter((a) => a.id !== from).map((a) => a.id);
    }
    return this.agent(to) && to !== from ? [to] : [];
  }

  sendMessage(input: SendMessageInput): Message {
    const pendingFor = this.recipients(input.from, input.to);
    if (input.to !== "user" && pendingFor.length === 0) {
      throw new Error(`Nobody to deliver to: ${input.to}`);
    }
    const message: Message = {
      id: newId("msg"),
      from: input.from,
      to: input.to,
      content: input.content,
      kind: input.kind ?? "chat",
      hops: input.hops ?? 0,
      taskId: input.taskId,
      pendingFor,
      createdAt: now(),
    };
    this.data.messages.push(message);
    this.emit({ type: "message", message });
    const target = input.to.startsWith("zone:") || input.to === "all" ? undefined : input.to;
    this.log("message", `${this.displayName(input.from)} → ${this.displayName(input.to)}: ${input.content.slice(0, 140)}`, {
      agentId: input.from === "user" ? undefined : input.from,
      targetAgentId: target === "user" ? undefined : target,
      toUser: input.to === "user",
    });
    this.scheduleSave();
    this.work();
    return message;
  }

  markProcessed(agentId: string, messageIds: string[]): void {
    const ids = new Set(messageIds);
    for (const m of this.data.messages) {
      if (ids.has(m.id)) m.pendingFor = m.pendingFor.filter((p) => p !== agentId);
    }
    this.scheduleSave();
  }

  // ── Inbox ──────────────────────────────────────────────────────────

  addInbox(input: InboxInput): InboxItem {
    const agent = this.agent(input.agentId);
    const item: InboxItem = {
      id: newId("inb"),
      kind: input.kind,
      agentId: input.agentId,
      zoneId: agent?.zoneId,
      taskId: input.taskId,
      title: input.title.slice(0, 200),
      body: input.body,
      actionItems: (input.actionItems ?? []).filter(Boolean).map((text) => ({ text, done: false })),
      priority: input.priority ?? "normal",
      read: false,
      archived: false,
      createdAt: now(),
    };
    this.data.inbox.push(item);
    this.emit({ type: "inbox", item });
    this.log("report", `${agent?.name ?? "An agent"} → You: ${item.title}`, { agentId: input.agentId, toUser: true });
    this.scheduleSave();
    return item;
  }

  updateInbox(id: string, patch: Partial<Pick<InboxItem, "read" | "archived">> & { toggleAction?: number }): InboxItem {
    const item = this.data.inbox.find((i) => i.id === id);
    if (!item) throw new Error(`Inbox item not found: ${id}`);
    if (patch.read !== undefined) item.read = patch.read;
    if (patch.archived !== undefined) item.archived = patch.archived;
    if (patch.toggleAction !== undefined && item.actionItems[patch.toggleAction]) {
      item.actionItems[patch.toggleAction].done = !item.actionItems[patch.toggleAction].done;
    }
    this.emit({ type: "inbox", item });
    this.scheduleSave();
    return item;
  }

  // ── Notes ──────────────────────────────────────────────────────────

  addNote(zoneId: string, author: string, content: string): Note {
    if (!this.zone(zoneId)) throw new Error(`Area not found: ${zoneId}`);
    const note: Note = { id: newId("note"), zoneId, author, content: content.slice(0, 2000), createdAt: now() };
    this.data.notes.push(note);
    this.emit({ type: "note", note });
    this.scheduleSave();
    return note;
  }

  removeNote(id: string): void {
    this.data.notes = this.data.notes.filter((n) => n.id !== id);
    this.emit({ type: "note:removed", id });
    this.scheduleSave();
  }

  notesFor(zoneId: string, limit = 10): Note[] {
    return this.data.notes.filter((n) => n.zoneId === zoneId).slice(-limit);
  }

  // ── Activity log ───────────────────────────────────────────────────

  log(kind: LogKind, text: string, extra: Partial<Omit<LogEntry, "id" | "ts" | "kind" | "text">> = {}): void {
    const entry: LogEntry = { id: newId("log"), ts: now(), kind, text: text.slice(0, 300), ...extra };
    this.data.log.push(entry);
    this.emit({ type: "log", entry });
    this.scheduleSave();
  }
}
