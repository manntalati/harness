import Anthropic from "@anthropic-ai/sdk";
import { World } from "../world/world.js";
import { Agent, Message, Task } from "../world/types.js";
import { briefing, continuationPrompt, systemPrompt } from "./prompts.js";
import { ToolContext, executeTool, toolActivity, toolsFor } from "./tools.js";
import { EngineEnv, EngineName } from "./engine.js";
import { runClaudeCode } from "./claude-code.js";
import { EngineResult, StopRequested, UsageLimitReached } from "./errors.js";

export { StopRequested } from "./errors.js";

const MAX_TOKENS = 32000;

/**
 * API engine: conversations of runs that hit the step limit, keyed by task id, so the next run
 * carries on with full context. Lost on restart, in which case the progress notes take over.
 */
const pausedConversations = new Map<string, { model: string; conversation: Anthropic.Beta.BetaMessageParam[] }>();
const MAX_PAUSED_CONVERSATIONS = 20;

export interface Activation {
  agentId: string;
  task?: Task;
  messages: Message[];
}

/** Older models take neither adaptive thinking nor effort. */
function supportsAdaptive(model: string): boolean {
  return !/claude-(3|haiku-4-5|sonnet-4-5|opus-4-5|opus-4-1|opus-4-0|sonnet-4-0)/.test(model);
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

function friendlyError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "No valid Anthropic credentials. Set ANTHROPIC_API_KEY (or run `ant auth login`) and restart the harness, or switch the engine to Claude Code in Settings.";
  }
  if (err instanceof Anthropic.PermissionDeniedError) return `Permission denied by the API: ${err.message}`;
  if (err instanceof Anthropic.NotFoundError) return `Model or endpoint not found: ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API. The task can be retried in a bit.";
  if (err instanceof Anthropic.BadRequestError) return `The API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API (network error).";
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ""}: ${err.message}`;
  const message = err instanceof Error ? err.message : String(err);
  // The SDK raises a plain error before any request when it finds no credentials at all.
  if (/could not resolve authentication method/i.test(message)) {
    return "No Anthropic credentials found. Set ANTHROPIC_API_KEY (or run `ant auth login`), or switch the engine to Claude Code in Settings to use your Claude plan.";
  }
  return message;
}

export interface RunOptions {
  engine: EngineName;
  env: EngineEnv;
  client: () => Anthropic;
}

/**
 * Runs one activation of an agent: a briefing, then the engine's tool-use
 * loop until the agent ends its turn. Keeps the world (status, live text,
 * task, inbox) updated as it goes.
 */
export async function runActivation(world: World, activation: Activation, signal: AbortSignal, opts: RunOptions): Promise<void> {
  const agent = world.agent(activation.agentId);
  if (!agent) return;
  const zone = world.zone(agent.zoneId) ?? world.data.zones[0];
  const { task, messages } = activation;

  world.markProcessed(agent.id, messages.map((m) => m.id));
  const resumed = Boolean(task?.startedAt);
  if (task) {
    world.updateTask(task.id, { status: "in_progress", startedAt: task.startedAt ?? new Date().toISOString(), assigneeId: agent.id });
  }

  // Whoever woke this agent with a chat message is who it "walks over to" on the map.
  const chatPartner = messages.find((m) => m.from !== "user" && m.kind === "chat")?.from;
  agent.stats.activations++;
  world.streamAgent(agent.id, { reset: true });
  world.setAgentState(agent.id, {
    status: "working",
    activity: "thinking",
    activityDetail: task ? task.title : `reading ${messages.length} message${messages.length === 1 ? "" : "s"}`,
    focus: task ? { kind: "task", taskId: task.id } : { kind: "conversation", withAgentId: chatPartner },
    lastError: undefined,
  });
  world.addAction(agent.id, "info", task ? `Started: ${task.title}` : `Woke up for ${messages.length} message(s) from ${[...new Set(messages.map((m) => world.displayName(m.from)))].join(", ")}`);

  const ctx: ToolContext = {
    world,
    agent,
    zone,
    task,
    resumed,
    journal: [],
    hops: messages.length ? Math.max(...messages.map((m) => m.hops)) : 0,
    signal,
    outcome: { reportedToUser: false },
  };

  try {
    const result =
      opts.engine === "claude-code"
        ? await runClaudeCode(ctx, messages, opts.env)
        : await runApiLoop(ctx, messages, opts.client());
    finishTask(world, agent, ctx, result);
    world.setAgentState(agent.id, { status: "idle", activity: "done", activityDetail: undefined, focus: undefined });
  } catch (err) {
    const stop = err instanceof StopRequested ? err : signal.aborted ? (signal.reason instanceof StopRequested ? signal.reason : new StopRequested(true)) : null;
    if (stop || err instanceof UsageLimitReached) {
      const requeue = stop ? stop.requeue : true;
      const current = task ? world.task(task.id) : undefined;
      if (current && current.status === "in_progress") {
        world.updateTask(current.id, requeue ? { status: "queued", startedAt: undefined } : { status: "cancelled", completedAt: new Date().toISOString() });
      }
      if (err instanceof UsageLimitReached) {
        // Don't burn through the queue failing every task: put the work back and wait for the user.
        world.addAction(agent.id, "error", err.message);
        if (!world.data.paused) {
          world.setPaused(true);
          world.log("error", `${err.message} The world is paused; resume it when your limit resets.`, { agentId: agent.id });
        }
      } else {
        world.addAction(agent.id, "info", "Stopped.");
      }
      const latest = world.agent(agent.id);
      if (latest) world.setAgentState(agent.id, { status: latest.status === "paused" ? "paused" : "idle", activity: "idle", activityDetail: undefined, focus: undefined });
      return;
    }
    const message = friendlyError(err);
    world.addAction(agent.id, "error", message);
    world.log("error", `${agent.name}: ${message}`, { agentId: agent.id });
    if (task) failTask(world, agent, task, message);
    world.setAgentState(agent.id, { status: "error", activity: "error", activityDetail: message.slice(0, 120), focus: undefined, lastError: message });
  }
}

// ── Engine: Anthropic API ───────────────────────────────────────────

async function runApiLoop(ctx: ToolContext, messages: Message[], client: Anthropic): Promise<EngineResult> {
  const { world, agent, zone, task, signal } = ctx;
  const settings = world.data.settings;
  const model = agent.model || settings.defaultModel;
  const paused = task ? pausedConversations.get(task.id) : undefined;
  if (task) pausedConversations.delete(task.id);
  // Same model and still the same piece of work: carry on in the conversation that ran out of steps.
  const conversation: Anthropic.Beta.BetaMessageParam[] =
    paused && task && paused.model === model && task.progress
      ? [...paused.conversation, { role: "user", content: continuationPrompt(world, task, messages, settings.maxStepsPerActivation) }]
      : [{ role: "user", content: briefing({ world, agent, zone, task, messages, engine: "api", resumed: ctx.resumed }) }];
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: systemPrompt(agent), cache_control: { type: "ephemeral" } },
  ];
  const tools = toolsFor(ctx, model);
  const adaptive = supportsAdaptive(model);

  let finalText = "";
  let jsonRetries = 0;

  for (let step = 0; step < settings.maxStepsPerActivation; step++) {
    if (signal.aborted) throw signal.reason ?? new StopRequested(true);

    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: MAX_TOKENS,
        system,
        tools,
        messages: conversation,
        // Caches the growing conversation between steps of this activation.
        cache_control: { type: "ephemeral" },
        ...(adaptive
          ? {
              thinking: { type: "adaptive", display: "summarized" } as const,
              ...(agent.effort ? { output_config: { effort: agent.effort } } : {}),
            }
          : {}),
        // If the model declines for policy reasons, let the API retry on its recommended fallback.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal },
    );

    stream.on("text", (delta) => {
      if (agent.activity !== "writing") world.setAgentState(agent.id, { activity: "writing" });
      world.streamAgent(agent.id, { text: delta });
    });
    stream.on("thinking", (delta) => {
      if (agent.activity !== "thinking") world.setAgentState(agent.id, { activity: "thinking" });
      world.streamAgent(agent.id, { thought: delta });
    });
    stream.on("streamEvent", (event) => {
      if (event.type !== "content_block_start") return;
      const block = event.content_block;
      if (block.type === "tool_use" || block.type === "server_tool_use") {
        world.setAgentState(agent.id, { activity: toolActivity(block.name), activityDetail: block.name.replace(/_/g, " ") });
      }
    });

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // With eager input streaming the SDK rejects when a tool input isn't parseable JSON at all.
      // Only that case is retried; API errors and aborts propagate.
      if (signal.aborted || err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
      world.addAction(agent.id, "error", "A tool call came back garbled; retrying that step.");
      continue;
    }

    world.addUsage(agent.id, model, message.usage);
    world.emitAgent(agent);

    const text = textOf(message.content);
    if (text) {
      finalText = text;
      world.addAction(agent.id, "text", text.slice(0, 400));
      world.streamAgent(agent.id, { text: "\n\n" });
    }

    if (message.stop_reason === "refusal") {
      throw new Error("The model declined to continue this request (refusal).");
    }
    if (message.stop_reason === "pause_turn") {
      conversation.push({ role: "assistant", content: message.content });
      continue;
    }

    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) return { finalText, stepLimitHit: false };

    conversation.push({ role: "assistant", content: message.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];

    if (message.stop_reason === "max_tokens") {
      // A tool input cut off at max_tokens can still parse as a plausible partial object. Don't run it.
      for (const use of toolUses) {
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content: "Your output hit the length limit before this tool call finished, so it was not run. Retry with smaller pieces (for example, split a large file into several edits).",
        });
      }
    } else {
      // Sequential on purpose: a write followed by a read must see the write.
      for (const use of toolUses) {
        if (signal.aborted) throw signal.reason ?? new StopRequested(true);
        const result = await executeTool(use.name, use.input, ctx);
        results.push({ type: "tool_result", tool_use_id: use.id, content: result.content, is_error: result.isError || undefined });
      }
    }
    conversation.push({ role: "user", content: results });
  }
  if (task) {
    pausedConversations.set(task.id, { model, conversation });
    if (pausedConversations.size > MAX_PAUSED_CONVERSATIONS) {
      pausedConversations.delete(pausedConversations.keys().next().value!);
    }
  }
  return { finalText, stepLimitHit: true };
}

// ── Finishing up ────────────────────────────────────────────────────

function openChildren(world: World, taskId: string): Task[] {
  return world.data.tasks.filter((t) => t.parentTaskId === taskId && (t.status === "queued" || t.status === "in_progress"));
}

function finishTask(world: World, agent: Agent, ctx: ToolContext, result: EngineResult): void {
  const task = ctx.task ? world.task(ctx.task.id) : undefined;
  if (result.stepLimitHit && !ctx.outcome.completion) {
    world.addAction(agent.id, "info", `Used all ${world.data.settings.maxStepsPerActivation} steps for this run.`);
  }
  if (!task || task.status !== "in_progress") {
    if (task) pausedConversations.delete(task.id);
    return;
  }

  let completion = ctx.outcome.completion;
  if (!completion) {
    if (result.stepLimitHit) {
      // Not finished, just out of steps for this run: save where it got to and keep going.
      const checkpoint = {
        progress: appendProgress(task.progress, (task.continuations ?? 0) + 1, ctx.journal, result.finalText),
        sessionId: result.sessionId ?? task.sessionId,
      };
      const waiting = openChildren(world, task.id);
      if (waiting.length) {
        // Delegated results will resume it (with this checkpoint) when they arrive.
        world.updateTask(task.id, checkpoint);
        world.setAgentState(agent.id, { activityDetail: `waiting on ${waiting.map((t) => (t.assigneeId ? world.displayName(t.assigneeId) : "a teammate")).join(", ")}` });
        return;
      }
      continueLater(world, agent, task, checkpoint);
      return;
    }
    const waiting = openChildren(world, task.id);
    if (waiting.length) {
      world.addAction(agent.id, "info", `Waiting on ${waiting.length} delegated task(s) before finishing "${task.title}".`);
      world.setAgentState(agent.id, { activityDetail: `waiting on ${waiting.map((t) => (t.assigneeId ? world.displayName(t.assigneeId) : "a teammate")).join(", ")}` });
      return;
    }
    // The agent ended its turn without calling complete_task: treat its last words as the result.
    const text = result.finalText || "Finished without a written result.";
    completion = { summary: text.split("\n").find((l) => l.trim())?.slice(0, 200) ?? text.slice(0, 200), result: text };
  }

  pausedConversations.delete(task.id);
  const completedAt = new Date().toISOString();
  world.updateTask(task.id, {
    status: "done",
    result: completion.result,
    summary: completion.summary,
    completedAt,
    reportedToUser: ctx.outcome.reportedToUser,
    nextRunAt: task.repeatEveryMinutes ? new Date(Date.now() + task.repeatEveryMinutes * 60_000).toISOString() : undefined,
    // A recurring task starts its next run fresh.
    ...(task.repeatEveryMinutes ? { progress: undefined, sessionId: undefined, continuations: undefined } : {}),
  });
  agent.stats.tasksDone++;
  world.log("task", `${agent.name} finished: ${task.title}`, { agentId: agent.id, zoneId: task.zoneId });
  deliverResult(world, agent, task, `Finished "${task.title}".\n\nSummary: ${completion.summary}\n\n${completion.result}`, completion, ctx.outcome.reportedToUser);
}

/** One block of the task's running progress log, written when a run hits the step limit. */
function appendProgress(existing: string | undefined, run: number, journal: string[], lastText: string): string {
  const steps = journal.slice(-40).map((line) => `- ${line}`);
  const omitted = journal.length > 40 ? `- … ${journal.length - 40} earlier steps\n` : "";
  const block = `Run ${run}:\n${omitted}${steps.join("\n") || "- (no tool calls)"}${lastText ? `\nWhere it left off: ${lastText.slice(0, 1500)}` : ""}`;
  const all = existing ? `${existing}\n\n${block}` : block;
  return all.length > 12000 ? `…${all.slice(-12000)}` : all;
}

/** Re-queues an unfinished task for a fresh run, or hands it back to the user once the runs are used up. */
function continueLater(world: World, agent: Agent, task: Task, checkpoint: { progress: string; sessionId?: string }): void {
  const { maxContinuations, maxStepsPerActivation } = world.data.settings;
  const runs = (task.continuations ?? 0) + 1;
  if (runs > maxContinuations) {
    pausedConversations.delete(task.id);
    world.updateTask(task.id, checkpoint);
    const total = runs;
    failTask(
      world,
      agent,
      task,
      `Not finished after ${total} run${total === 1 ? "" : "s"} of up to ${maxStepsPerActivation} steps each. Use "Iterate" to send it back and keep going (the progress so far is saved), or raise the step limits in Settings.`,
      checkpoint.progress,
    );
    world.addAction(agent.id, "error", `Gave "${task.title}" back to you after ${total} run${total === 1 ? "" : "s"} without finishing.`);
    return;
  }
  // Queued again with startedAt kept, so it's picked up before newer work and briefed as a continuation.
  world.updateTask(task.id, { ...checkpoint, status: "queued", continuations: runs });
  world.addAction(agent.id, "info", `Not done yet; continuing "${task.title}" in a fresh run (${runs} of ${maxContinuations}).`);
  world.log("task", `${agent.name} is continuing "${task.title}" in a fresh run (${runs}/${maxContinuations})`, { agentId: agent.id, zoneId: task.zoneId });
}

function failTask(world: World, agent: Agent, task: Task, error: string, progress?: string): void {
  const current = world.task(task.id);
  if (!current || current.status !== "in_progress") return;
  pausedConversations.delete(task.id);
  world.updateTask(task.id, {
    status: "failed",
    error,
    completedAt: new Date().toISOString(),
    nextRunAt: current.repeatEveryMinutes ? new Date(Date.now() + current.repeatEveryMinutes * 60_000).toISOString() : undefined,
  });
  const detail = progress ? `\n\n### Progress so far\n${progress}` : "";
  deliverResult(world, agent, current, `Couldn't finish "${task.title}": ${error}${detail}`, undefined, false, error + detail);
}

/** Sends a finished task's outcome back to whoever asked for it. */
export function deliverResult(
  world: World,
  agent: Agent,
  task: Task,
  content: string,
  completion: { summary: string; result: string } | undefined,
  alreadyReported: boolean,
  error?: string,
): void {
  if (task.createdBy === "user") {
    if (alreadyReported) return;
    world.addInbox({
      kind: "task_result",
      agentId: agent.id,
      taskId: task.id,
      title: error ? `Couldn't finish: ${task.title}` : `Done: ${task.title}`,
      body: error ? `**Error:** ${error}` : completion ? `${completion.summary}\n\n---\n\n${completion.result}` : content,
      priority: error ? "high" : "normal",
    });
    return;
  }
  if (world.agent(task.createdBy)) {
    // Results always wake the delegator, regardless of chatter depth.
    world.sendMessage({ from: agent.id, to: task.createdBy, content, kind: "task_result", hops: 0, taskId: task.id });
  }
}
