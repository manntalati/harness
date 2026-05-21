import Anthropic from "@anthropic-ai/sdk";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  AgentConfig,
  AgentEvent,
  AgentProgress,
  AgentState,
  AgentTemplate,
} from "./types.js";
import { RunResult, runAgentStreaming } from "./runner.js";
import { DEFAULT_TEMPLATES } from "../templates/defaults.js";

export type AgentEventListener = (event: AgentEvent) => void;

export class AgentManager {
  private agents = new Map<string, AgentState>();
  private templates = new Map<string, AgentTemplate>();
  private client: Anthropic;
  private emitter = new EventEmitter();

  constructor() {
    this.client = new Anthropic();

    for (const template of DEFAULT_TEMPLATES) {
      this.templates.set(template.name, template);
    }
  }

  on(event: "agent-event", listener: AgentEventListener): void {
    this.emitter.on(event, listener);
  }

  off(event: "agent-event", listener: AgentEventListener): void {
    this.emitter.off(event, listener);
  }

  private emitEvent(event: AgentEvent): void {
    this.emitter.emit("agent-event", event);
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

    this.emitEvent({
      kind: "agent:created",
      agentId: id,
      timestamp: new Date(),
      config,
    });

    state.status = "running";
    this.emitEvent({
      kind: "agent:started",
      agentId: id,
      timestamp: new Date(),
    });

    const onProgress = (progress: AgentProgress) => {
      state.progress = progress;
      this.emitEvent({
        kind: "agent:progress",
        agentId: id,
        timestamp: new Date(),
        progress,
      });
    };

    runAgentStreaming(this.client, config, abortController.signal, onProgress)
      .then((result: RunResult) => {
        state.status = "completed";
        state.result = result.text;
        state.tokenUsage = result.tokenUsage;
        state.completedAt = new Date();

        this.emitEvent({
          kind: "agent:completed",
          agentId: id,
          timestamp: new Date(),
          tokenUsage: result.tokenUsage,
          resultPreview: result.text.slice(0, 200),
        });
      })
      .catch((err: unknown) => {
        state.completedAt = new Date();

        if (abortController.signal.aborted) {
          state.status = "cancelled";
          this.emitEvent({
            kind: "agent:cancelled",
            agentId: id,
            timestamp: new Date(),
          });
        } else {
          const errorMsg = err instanceof Error ? err.message : String(err);
          state.status = "failed";
          state.error = errorMsg;
          this.emitEvent({
            kind: "agent:failed",
            agentId: id,
            timestamp: new Date(),
            error: errorMsg,
          });
        }
      });

    return id;
  }

  getAgent(id: string): AgentState | undefined {
    return this.agents.get(id);
  }

  listAgents() {
    return Array.from(this.agents.values()).map((a) => ({
      id: a.id,
      name: a.config.name,
      role: a.config.role,
      status: a.status,
      progress: a.progress ?? null,
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
