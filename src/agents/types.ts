export type AgentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface AgentConfig {
  name: string;
  role: string;
  task: string;
  model?: string;
  maxTokens?: number;
}

export interface AgentProgress {
  /** Characters of response text received so far */
  textLength: number;
  /** Partial text snapshot (latest chunk) */
  latestChunk: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AgentState {
  id: string;
  config: AgentConfig;
  status: AgentStatus;
  result?: string;
  error?: string;
  progress?: AgentProgress;
  tokenUsage?: TokenUsage;
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

// ── Events ──────────────────────────────────────────────────────────

export type AgentEventKind =
  | "agent:created"
  | "agent:started"
  | "agent:progress"
  | "agent:completed"
  | "agent:failed"
  | "agent:cancelled";

export interface AgentEventBase {
  kind: AgentEventKind;
  agentId: string;
  timestamp: Date;
}

export interface AgentCreatedEvent extends AgentEventBase {
  kind: "agent:created";
  config: AgentConfig;
}

export interface AgentStartedEvent extends AgentEventBase {
  kind: "agent:started";
}

export interface AgentProgressEvent extends AgentEventBase {
  kind: "agent:progress";
  progress: AgentProgress;
}

export interface AgentCompletedEvent extends AgentEventBase {
  kind: "agent:completed";
  tokenUsage: TokenUsage;
  resultPreview: string;
}

export interface AgentFailedEvent extends AgentEventBase {
  kind: "agent:failed";
  error: string;
}

export interface AgentCancelledEvent extends AgentEventBase {
  kind: "agent:cancelled";
}

export type AgentEvent =
  | AgentCreatedEvent
  | AgentStartedEvent
  | AgentProgressEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | AgentCancelledEvent;

// ── Orchestration ───────────────────────────────────────────────────

export type OrchestrationStatus =
  | "planning"
  | "executing"
  | "reviewing"
  | "synthesizing"
  | "completed"
  | "failed"
  | "cancelled";

export type ReviewVerdict = "approved" | "revise" | "rejected";

export interface ReviewFeedback {
  verdict: ReviewVerdict;
  feedback: string;
  iteration: number;
}

export interface SubTask {
  agentId: string;
  name: string;
  role: string;
  task: string;
  status: AgentStatus;
  result?: string;
  error?: string;
  reviewHistory?: ReviewFeedback[];
  iteration?: number;
}

export interface OrchestrationConfig {
  goal: string;
  model?: string;
  maxSubTasks?: number;
  enableReview?: boolean;
  maxReviewIterations?: number;
}

export interface OrchestrationState {
  id: string;
  config: OrchestrationConfig;
  status: OrchestrationStatus;
  subTasks: SubTask[];
  plan?: string;
  finalResult?: string;
  error?: string;
  tokenUsage: TokenUsage;
  createdAt: Date;
  completedAt?: Date;
  abortController: AbortController;
}
