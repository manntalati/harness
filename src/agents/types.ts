export type AgentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface AgentConfig {
  name: string;
  role: string;
  task: string;
  model?: string;
  maxTokens?: number;
}

export interface AgentState {
  id: string;
  config: AgentConfig;
  status: AgentStatus;
  result?: string;
  error?: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
  };
  createdAt: Date;
  completedAt?: Date;
  abortController: AbortController;
}

export interface AgentTemplate {
  name: string;
  role: string;
  model?: string;
  maxTokens?: number;
}
