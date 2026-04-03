import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { AgentConfig, AgentState, AgentTemplate } from "./types.js";
import { runAgent } from "./runner.js";
import { DEFAULT_TEMPLATES } from "../templates/defaults.js";

export class AgentManager {
  private agents = new Map<string, AgentState>();
  private templates = new Map<string, AgentTemplate>();
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic();

    for (const template of DEFAULT_TEMPLATES) {
      this.templates.set(template.name, template);
    }
  }

  createAgent(config: AgentConfig): string {
    const id = randomUUID();
    const abortController = new AbortController();

    const state: AgentState = {
      id,
      config,
      status: "pending",
      createdAt: new Date(),
      abortController,
    };

    this.agents.set(id, state);

    state.status = "running";
    runAgent(this.client, config, abortController.signal)
      .then((result) => {
        state.status = "completed";
        state.result = result.text;
        state.tokenUsage = {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        };
        state.completedAt = new Date();
      })
      .catch((err: unknown) => {
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

  listAgents() {
    return Array.from(this.agents.values()).map((a) => ({
      id: a.id,
      name: a.config.name,
      role: a.config.role,
      status: a.status,
      createdAt: a.createdAt.toISOString(),
      completedAt: a.completedAt?.toISOString() ?? null,
    }));
  }

  getAgentResult(id: string) {
    const agent = this.agents.get(id);
    if (!agent) return null;

    return {
      id: agent.id,
      name: agent.config.name,
      status: agent.status,
      result: agent.result ?? null,
      error: agent.error ?? null,
      tokenUsage: agent.tokenUsage ?? null,
      createdAt: agent.createdAt.toISOString(),
      completedAt: agent.completedAt?.toISOString() ?? null,
    };
  }

  cancelAgent(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent || agent.status !== "running") return false;

    agent.abortController.abort();
    return true;
  }

  createTemplate(template: AgentTemplate): void {
    this.templates.set(template.name, template);
  }

  listTemplates() {
    return Array.from(this.templates.values()).map((t) => ({
      name: t.name,
      role: t.role,
      model: t.model ?? null,
      maxTokens: t.maxTokens ?? null,
    }));
  }
}
