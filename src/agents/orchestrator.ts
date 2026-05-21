import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { AgentManager } from "./manager.js";
import {
  AgentEvent,
  OrchestrationConfig,
  OrchestrationState,
  ReviewFeedback,
  ReviewVerdict,
  SubTask,
} from "./types.js";

const DEFAULT_MODEL = "claude-sonnet-4-6-20250514";
const MAX_SUB_TASKS = 10;
const DEFAULT_MAX_REVIEW_ITERATIONS = 2;
const PLAN_MAX_TOKENS = 4096;
const REVIEW_MAX_TOKENS = 4096;
const SYNTHESIS_MAX_TOKENS = 8192;

const PM_SYSTEM_PROMPT = `You are a Project Manager AI. You decompose high-level goals into concrete sub-tasks that can be executed by specialized worker agents in parallel.

When given a goal, respond with a JSON array of sub-tasks. Each sub-task must have:
- "name": a short identifier (e.g. "research-competitors")
- "role": the system prompt for the worker agent (describe its specialty and how it should approach the task)
- "task": the specific instructions for the worker agent

Keep sub-tasks focused and independent so they can run concurrently.
Respond ONLY with the JSON array, no other text.`;

const PM_CODE_SYSTEM_PROMPT = `You are a Tech Lead AI managing a team of software engineers. You decompose a high-level project description into 3-4 concrete feature tasks that can be built in parallel by independent engineers.

When given a project goal, respond with a JSON array of feature tasks. Each task must have:
- "name": a short feature identifier using kebab-case (e.g. "auth-module", "user-api", "settings-page")
- "role": the system prompt for the engineer agent — describe them as a senior software engineer specializing in the relevant area. Tell them to produce clean, production-ready code with appropriate error handling.
- "task": detailed implementation instructions for the feature — be specific about what to build, the expected inputs/outputs, and any technical constraints.

Keep features independent and well-scoped so engineers can work in parallel without conflicts.
Respond ONLY with the JSON array, no other text.`;

const CODE_REVIEW_SYSTEM_PROMPT = `You are a Tech Lead AI performing code review on work submitted by your engineering team. For each sub-task, you will see the engineer's output and must decide whether it is ready to merge.

Review each submission for:
- Correctness: Does it accomplish the stated task?
- Quality: Is the code clean, well-structured, and maintainable?
- Completeness: Are edge cases handled? Is error handling present?
- Consistency: Does it follow good practices and work well with the other features?

Respond with a JSON array. For each sub-task include:
- "name": the sub-task name (must match exactly)
- "verdict": one of "approved", "revise", or "rejected"
- "feedback": specific actionable feedback. For "approved", briefly state what's good. For "revise", explain exactly what needs to change. For "rejected", explain why it cannot be salvaged.

Respond ONLY with the JSON array, no other text.`;

const SYNTHESIS_SYSTEM_PROMPT = `You are a Project Manager AI synthesizing results from multiple worker agents.
You will receive the original goal and the results from each worker agent.
Produce a single, cohesive final deliverable that combines all the worker outputs.
Be thorough but structured. Use headings and sections to organize the combined output.`;

interface PlannedTask {
  name: string;
  role: string;
  task: string;
}

interface ParsedReview {
  name: string;
  verdict: ReviewVerdict;
  feedback: string;
}

export class Orchestrator {
  private orchestrations = new Map<string, OrchestrationState>();
  private client: Anthropic;
  private manager: AgentManager;

  constructor(manager: AgentManager) {
    this.manager = manager;
    this.client = new Anthropic();
  }

  async startOrchestration(config: OrchestrationConfig): Promise<string> {
    const id = randomUUID();
    const abortController = new AbortController();

    const state: OrchestrationState = {
      id,
      config,
      status: "planning",
      subTasks: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      createdAt: new Date(),
      abortController,
    };

    this.orchestrations.set(id, state);

    this.runOrchestration(state).catch((err: unknown) => {
      if (abortController.signal.aborted) {
        state.status = "cancelled";
      } else {
        state.status = "failed";
        state.error = err instanceof Error ? err.message : String(err);
      }
      state.completedAt = new Date();
    });

    return id;
  }

  private async runOrchestration(state: OrchestrationState): Promise<void> {
    const { config, abortController } = state;
    const model = config.model ?? DEFAULT_MODEL;
    const maxTasks = config.maxSubTasks ?? MAX_SUB_TASKS;
    const useReview = config.enableReview ?? false;

    // ── Step 1: Planning ──────────────────────────────────────────────
    state.status = "planning";

    const systemPrompt = useReview ? PM_CODE_SYSTEM_PROMPT : PM_SYSTEM_PROMPT;

    const planResponse = await this.client.messages.create(
      {
        model,
        max_tokens: PLAN_MAX_TOKENS,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `Goal: ${config.goal}\n\nDecompose this into at most ${maxTasks} independent sub-tasks. Return a JSON array.`,
          },
        ],
      },
      { signal: abortController.signal },
    );

    this.addTokenUsage(state, planResponse.usage);

    const planText = planResponse.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    const planned = this.parsePlan(planText, maxTasks);
    state.plan = planText;

    // ── Step 2: Executing ─────────────────────────────────────────────
    state.status = "executing";

    for (const task of planned) {
      const agentId = this.manager.createAgent({
        name: task.name,
        role: task.role,
        task: task.task,
      });

      const subTask: SubTask = {
        agentId,
        name: task.name,
        role: task.role,
        task: task.task,
        status: "running",
        iteration: 1,
        reviewHistory: [],
      };

      state.subTasks.push(subTask);
    }

    await this.waitForAgents(state);

    if (abortController.signal.aborted) {
      state.status = "cancelled";
      state.completedAt = new Date();
      return;
    }

    // ── Step 2.5: Review loop (if enabled) ────────────────────────────
    if (useReview) {
      await this.reviewAndRevise(state);

      if (abortController.signal.aborted) {
        state.status = "cancelled";
        state.completedAt = new Date();
        return;
      }
    }

    // ── Step 3: Synthesizing ──────────────────────────────────────────
    state.status = "synthesizing";

    const resultsBlock = state.subTasks
      .map((st) => {
        const header = `## ${st.name}`;
        if (st.status === "completed" && st.result) {
          return `${header}\n${st.result}`;
        }
        if (st.status === "failed") {
          return `${header}\n[FAILED: ${st.error ?? "unknown error"}]`;
        }
        return `${header}\n[${st.status}]`;
      })
      .join("\n\n");

    const synthesisResponse = await this.client.messages.create(
      {
        model,
        max_tokens: SYNTHESIS_MAX_TOKENS,
        system: SYNTHESIS_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Original goal: ${config.goal}\n\n---\n\nWorker agent results:\n\n${resultsBlock}\n\n---\n\nSynthesize these results into a single cohesive deliverable.`,
          },
        ],
      },
      { signal: abortController.signal },
    );

    this.addTokenUsage(state, synthesisResponse.usage);

    state.finalResult = synthesisResponse.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    state.status = "completed";
    state.completedAt = new Date();
  }

  // ── Review and revise loop ──────────────────────────────────────────

  private async reviewAndRevise(state: OrchestrationState): Promise<void> {
    const { config, abortController } = state;
    const model = config.model ?? DEFAULT_MODEL;
    const maxIterations = config.maxReviewIterations ?? DEFAULT_MAX_REVIEW_ITERATIONS;

    for (let round = 0; round < maxIterations; round++) {
      if (abortController.signal.aborted) return;

      state.status = "reviewing";

      // Build review prompt with each completed sub-task's output
      const reviewInput = state.subTasks
        .map((st) => {
          const output = st.status === "completed" && st.result
            ? st.result
            : `[${st.status}${st.error ? ': ' + st.error : ''}]`;
          return `### ${st.name}\n**Task:** ${st.task}\n**Output:**\n${output}`;
        })
        .join("\n\n---\n\n");

      const reviewResponse = await this.client.messages.create(
        {
          model,
          max_tokens: REVIEW_MAX_TOKENS,
          system: CODE_REVIEW_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: `Original goal: ${config.goal}\n\n---\n\nReview the following submissions:\n\n${reviewInput}`,
            },
          ],
        },
        { signal: abortController.signal },
      );

      this.addTokenUsage(state, reviewResponse.usage);

      const reviewText = reviewResponse.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      const reviews = this.parseReviews(reviewText);

      // Apply verdicts
      let hasRevisions = false;

      for (const review of reviews) {
        const subTask = state.subTasks.find((st) => st.name === review.name);
        if (!subTask) continue;

        const feedback: ReviewFeedback = {
          verdict: review.verdict,
          feedback: review.feedback,
          iteration: (subTask.iteration ?? 1),
        };
        subTask.reviewHistory = subTask.reviewHistory ?? [];
        subTask.reviewHistory.push(feedback);

        if (review.verdict === "revise") {
          hasRevisions = true;

          // Re-spawn the agent with feedback
          const revisedTask = `Original task:\n${subTask.task}\n\nPrevious output was reviewed and needs revision.\n\nReview feedback (you must address this):\n${review.feedback}`;

          const newIteration = (subTask.iteration ?? 1) + 1;
          const newAgentId = this.manager.createAgent({
            name: `${subTask.name}-v${newIteration}`,
            role: subTask.role,
            task: revisedTask,
          });

          subTask.agentId = newAgentId;
          subTask.status = "running";
          subTask.result = undefined;
          subTask.error = undefined;
          subTask.iteration = newIteration;
        }
        // "approved" and "rejected" — leave as-is
      }

      if (!hasRevisions) {
        // All approved or rejected — done reviewing
        return;
      }

      // Wait for re-spawned agents
      state.status = "executing";
      await this.waitForAgents(state);

      if (abortController.signal.aborted) return;
    }

    // Max iterations reached — force-approve remaining
  }

  private parseReviews(text: string): ParsedReview[] {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    try {
      const parsed: unknown = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      const reviews: ParsedReview[] = [];
      for (const item of parsed) {
        if (
          typeof item === "object" &&
          item !== null &&
          typeof (item as ParsedReview).name === "string" &&
          typeof (item as ParsedReview).verdict === "string" &&
          typeof (item as ParsedReview).feedback === "string" &&
          ["approved", "revise", "rejected"].includes((item as ParsedReview).verdict)
        ) {
          reviews.push({
            name: (item as ParsedReview).name,
            verdict: (item as ParsedReview).verdict,
            feedback: (item as ParsedReview).feedback,
          });
        }
      }
      return reviews;
    } catch {
      return [];
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private parsePlan(text: string, maxTasks: number): PlannedTask[] {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error("PM agent did not return a valid JSON task array");
    }

    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) {
      throw new Error("PM agent response is not an array");
    }

    const tasks: PlannedTask[] = [];
    for (const item of parsed.slice(0, maxTasks)) {
      if (
        typeof item === "object" &&
        item !== null &&
        typeof (item as PlannedTask).name === "string" &&
        typeof (item as PlannedTask).role === "string" &&
        typeof (item as PlannedTask).task === "string"
      ) {
        tasks.push({
          name: (item as PlannedTask).name,
          role: (item as PlannedTask).role,
          task: (item as PlannedTask).task,
        });
      }
    }

    if (tasks.length === 0) {
      throw new Error("PM agent returned zero valid sub-tasks");
    }

    return tasks;
  }

  private waitForAgents(state: OrchestrationState): Promise<void> {
    return new Promise<void>((resolve) => {
      // Only wait on agents that are still running
      const pendingIds = new Set(
        state.subTasks
          .filter((st) => st.status === "running" || st.status === "pending")
          .map((st) => st.agentId),
      );

      if (this.updateSubTaskStatuses(state, pendingIds)) {
        resolve();
        return;
      }

      const listener = (event: AgentEvent) => {
        if (!pendingIds.has(event.agentId)) return;

        if (
          event.kind === "agent:completed" ||
          event.kind === "agent:failed" ||
          event.kind === "agent:cancelled"
        ) {
          const subTask = state.subTasks.find(
            (st) => st.agentId === event.agentId,
          );
          if (subTask) {
            const agentState = this.manager.getAgent(event.agentId);
            if (agentState) {
              subTask.status = agentState.status;
              subTask.result = agentState.result;
              subTask.error = agentState.error;
              if (agentState.tokenUsage) {
                this.addTokenUsage(state, {
                  input_tokens: agentState.tokenUsage.inputTokens,
                  output_tokens: agentState.tokenUsage.outputTokens,
                });
              }
            }
          }

          pendingIds.delete(event.agentId);

          if (pendingIds.size === 0) {
            this.manager.off("agent-event", listener);
            resolve();
          }
        }
      };

      state.abortController.signal.addEventListener("abort", () => {
        this.manager.off("agent-event", listener);
        for (const st of state.subTasks) {
          if (st.status === "running") {
            this.manager.cancelAgent(st.agentId);
          }
        }
        resolve();
      });

      this.manager.on("agent-event", listener);
    });
  }

  private updateSubTaskStatuses(
    state: OrchestrationState,
    pendingIds: Set<string>,
  ): boolean {
    for (const subTask of state.subTasks) {
      const agentState = this.manager.getAgent(subTask.agentId);
      if (!agentState) continue;

      subTask.status = agentState.status;
      subTask.result = agentState.result;
      subTask.error = agentState.error;

      const terminal = ["completed", "failed", "cancelled"];
      if (terminal.includes(agentState.status)) {
        pendingIds.delete(subTask.agentId);
      }
    }
    return pendingIds.size === 0;
  }

  private addTokenUsage(
    state: OrchestrationState,
    usage: { input_tokens: number; output_tokens: number },
  ): void {
    state.tokenUsage.inputTokens += usage.input_tokens;
    state.tokenUsage.outputTokens += usage.output_tokens;
  }

  // ── Public queries ────────────────────────────────────────────────

  getOrchestration(id: string) {
    const orch = this.orchestrations.get(id);
    if (!orch) return null;

    return {
      id: orch.id,
      goal: orch.config.goal,
      status: orch.status,
      plan: orch.plan ?? null,
      enableReview: orch.config.enableReview ?? false,
      subTasks: orch.subTasks.map((st) => ({
        agentId: st.agentId,
        name: st.name,
        status: st.status,
        hasResult: st.result !== undefined,
        error: st.error ?? null,
        iteration: st.iteration ?? 1,
        reviewHistory: st.reviewHistory ?? [],
      })),
      finalResult: orch.finalResult ?? null,
      error: orch.error ?? null,
      tokenUsage: orch.tokenUsage,
      createdAt: orch.createdAt.toISOString(),
      completedAt: orch.completedAt?.toISOString() ?? null,
    };
  }

  listOrchestrations() {
    return Array.from(this.orchestrations.values()).map((orch) => ({
      id: orch.id,
      goal: orch.config.goal,
      status: orch.status,
      enableReview: orch.config.enableReview ?? false,
      subTaskCount: orch.subTasks.length,
      completedSubTasks: orch.subTasks.filter(
        (st) => st.status === "completed",
      ).length,
      tokenUsage: orch.tokenUsage,
      createdAt: orch.createdAt.toISOString(),
      completedAt: orch.completedAt?.toISOString() ?? null,
    }));
  }

  cancelOrchestration(id: string): boolean {
    const orch = this.orchestrations.get(id);
    if (!orch) return false;

    const terminal = ["completed", "failed", "cancelled"];
    if (terminal.includes(orch.status)) return false;

    orch.abortController.abort();
    return true;
  }
}
