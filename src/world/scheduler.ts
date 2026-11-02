import Anthropic from "@anthropic-ai/sdk";
import { World } from "./world.js";
import { Agent, Message, Task } from "./types.js";
import { Activation, StopRequested, runActivation } from "../agents/runtime.js";
import { EngineEnv, EngineName, engineProblem, resolveEngine } from "../agents/engine.js";

import { prepareEmailTask } from "../agents/email.js";

const TICK_MS = 5000;

/**
 * Decides which agent works next. Agents wake up for queued tasks and new
 * messages; a concurrency cap, a chatter-depth limit and an hourly
 * activation cap keep a busy team from running away with the bill.
 */
export class Scheduler {
  private running = new Map<string, AbortController>();
  private history = new Map<string, number[]>();
  private restingLogged = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private pending = false;
  private client: Anthropic | null = null;
  private engineWarned = false;

  constructor(private world: World, readonly env: EngineEnv) {
    world.onWork(() => this.poke());
  }

  /** The engine agents will run on right now, or null if none is usable. */
  engine(): EngineName | null {
    return resolveEngine(this.world.data.settings.engine, this.env);
  }

  start(): void {
    this.timer = setInterval(() => {
      this.requeueRecurring();
      this.poke();
    }, TICK_MS);
    this.poke();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.running.values()) controller.abort(new StopRequested(true));
  }

  get runningCount(): number {
    return this.running.size;
  }

  isRunning(agentId: string): boolean {
    return this.running.has(agentId);
  }

  /** Stops an agent mid-activation. requeue=false cancels its task instead of putting it back. */
  abort(agentId: string, requeue = true): boolean {
    const controller = this.running.get(agentId);
    if (!controller) return false;
    controller.abort(new StopRequested(requeue));
    return true;
  }

  abortAll(): void {
    for (const id of [...this.running.keys()]) this.abort(id, true);
  }

  /** Coalesces bursts of world changes into one scheduling pass. */
  poke(): void {
    if (this.pending) return;
    this.pending = true;
    setImmediate(() => {
      this.pending = false;
      this.schedule();
    });
  }

  private getClient(): Anthropic {
    this.client ??= new Anthropic();
    return this.client;
  }

  private schedule(): void {
    const w = this.world;
    this.assignUnclaimedTasks();
    this.world.emitStats(this.running.size);
    if (w.data.paused) return;
    // External tasks work even when no Claude engine is installed. Never auto-send email.
    for (const agent of w.data.agents.filter((a) => a.email && a.status !== "paused")) {
      for (const task of w.queuedTasksFor(agent.id)) prepareEmailTask(w, task);
      const messages = w.pendingMessagesFor(agent.id);
      for (const message of messages) w.addInbox({ kind: "message", agentId: agent.id,
        title: `Message for ${agent.name}: review needed`, body: message.content });
      w.markProcessed(agent.id, messages.map((m) => m.id));
    }
    const engine = this.engine();
    if (!engine) {
      // Leave work queued instead of failing it; the UI explains how to fix this.
      const hasWork = w.data.agents.some((a) => !a.email && a.status !== "paused" && this.nextActivation(a));
      if (hasWork && !this.engineWarned) {
        this.engineWarned = true;
        w.log("error", engineProblem(w.data.settings.engine, this.env) ?? "No engine available.");
      }
      return;
    }
    this.engineWarned = false;

    for (const agent of w.data.agents) {
      if (this.running.size >= w.data.settings.maxConcurrent) break;
      if (agent.email || agent.status === "paused" || this.running.has(agent.id)) continue;
      const activation = this.nextActivation(agent);
      if (!activation) continue;
      if (!this.withinHourlyLimit(agent)) continue;
      this.launch(activation, engine);
    }
  }

  private launch(activation: Activation, engine: EngineName): void {
    const controller = new AbortController();
    this.running.set(activation.agentId, controller);
    const stamps = this.history.get(activation.agentId) ?? [];
    stamps.push(Date.now());
    this.history.set(activation.agentId, stamps);
    this.world.emitStats(this.running.size);

    runActivation(this.world, activation, controller.signal, { engine, env: this.env, client: () => this.getClient() })
      .catch((err) => {
        process.stderr.write(`[harness] activation crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
        this.world.setAgentState(activation.agentId, { status: "error", activity: "error", lastError: String(err) });
      })
      .finally(() => {
        this.running.delete(activation.agentId);
        this.world.emitStats(this.running.size);
        this.poke();
      });
  }

  private wakes(message: Message): boolean {
    return message.from === "user" || message.kind === "task_result" || message.hops <= this.world.data.settings.maxHops;
  }

  /** Picks what an agent should do next, or nothing. */
  private nextActivation(agent: Agent): Activation | undefined {
    const w = this.world;
    const pending = w.pendingMessagesFor(agent.id);
    const urgent = pending.filter((m) => this.wakes(m));

    if (urgent.length) {
      // A delegated result resumes the task that was waiting for it.
      let resume: Task | undefined;
      for (const m of urgent) {
        if (m.kind !== "task_result") continue;
        const child = w.task(m.taskId);
        const parent = w.task(child?.parentTaskId);
        if (parent && parent.assigneeId === agent.id && parent.status === "in_progress") {
          resume = parent;
          break;
        }
      }
      return { agentId: agent.id, messages: pending, task: resume };
    }

    // Finish what was started (e.g. a task continuing after the step limit) before newer work.
    const queued = w.queuedTasksFor(agent.id);
    const next = queued.find((t) => t.startedAt) ?? queued[0];
    if (next) return { agentId: agent.id, messages: pending, task: next };
    return undefined;
  }

  /** Tasks handed to an area go to whoever there is least busy. */
  private assignUnclaimedTasks(): void {
    const w = this.world;
    for (const task of w.data.tasks) {
      if (task.status !== "queued" || task.assigneeId) continue;
      const candidates = w.agentsInZone(task.zoneId).filter((a) => !a.email && a.status !== "paused" && a.id !== task.createdBy);
      if (!candidates.length) continue;
      const load = (a: Agent) => w.queuedTasksFor(a.id).length + (this.running.has(a.id) ? 1 : 0);
      candidates.sort((a, b) => load(a) - load(b) || Number(a.canHire) - Number(b.canHire));
      w.updateTask(task.id, { assigneeId: candidates[0].id });
    }
  }

  private withinHourlyLimit(agent: Agent): boolean {
    const hourAgo = Date.now() - 3_600_000;
    const stamps = (this.history.get(agent.id) ?? []).filter((t) => t > hourAgo);
    this.history.set(agent.id, stamps);
    if (stamps.length < this.world.data.settings.maxActivationsPerHour) {
      this.restingLogged.delete(agent.id);
      return true;
    }
    if (!this.restingLogged.has(agent.id)) {
      this.restingLogged.add(agent.id);
      this.world.log("system", `${agent.name} hit the hourly activation limit and is resting. Raise it in settings if this is expected.`, { agentId: agent.id });
      this.world.setAgentState(agent.id, { activityDetail: "resting (hourly limit)" });
    }
    return false;
  }

  private requeueRecurring(): void {
    const w = this.world;
    if (w.data.paused) return;
    const nowMs = Date.now();
    for (const task of w.data.tasks) {
      if (!task.repeatEveryMinutes || !task.nextRunAt) continue;
      if (task.status !== "done" && task.status !== "failed") continue;
      if (new Date(task.nextRunAt).getTime() > nowMs) continue;
      w.updateTask(task.id, {
        status: "queued",
        iteration: task.iteration + 1,
        previousResult: task.result ?? task.previousResult,
        result: undefined,
        error: undefined,
        startedAt: undefined,
        completedAt: undefined,
        nextRunAt: undefined,
        feedback: undefined,
        emailHandoff: undefined,
      });
      w.log("task", `Recurring task re-queued: ${task.title}`, { zoneId: task.zoneId });
    }
  }
}
