// ── Core world model ────────────────────────────────────────────────
//
// The harness is a persistent "world": areas (zones) that hold agents,
// a task board, agent-to-agent messages, and an inbox of things the
// agents bring back to the user. Everything here is JSON-serialisable and
// persisted to world.json.

export type ZoneTheme = "hq" | "lab" | "workshop" | "markets" | "studio" | "library" | "garden";

export interface Zone {
  id: string;
  name: string;
  /** What this area is for. Shown to every agent working in it. */
  description: string;
  theme: ZoneTheme;
  /** Absolute path to a repo / project folder. Agents here get file tools scoped to it. */
  workspace?: string;
  /** Lets agents in this area run shell commands inside the workspace. Off by default. */
  allowCommands: boolean;
  createdAt: string;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Appearance {
  skin: string;
  hair: string;
  hairStyle: number;
  shirt: string;
  pants: string;
  accent: string;
}

export type AgentStatus = "idle" | "working" | "paused" | "error";

/** What the agent is doing right now — drives the speech-bubble icon on the map. */
export type Activity =
  | "idle"
  | "thinking"
  | "writing"
  | "searching"
  | "reading"
  | "editing"
  | "running"
  | "messaging"
  | "delegating"
  | "reporting"
  | "noting"
  | "hiring"
  | "done"
  | "error";

export interface AgentFocus {
  kind: "task" | "conversation";
  taskId?: string;
  /** For conversations: the agent whose message woke this one (the sprite walks over to them). */
  withAgentId?: string;
}

export interface AgentAction {
  ts: string;
  kind: "tool" | "think" | "text" | "info" | "error";
  text: string;
}

export interface Agent {
  id: string;
  name: string;
  /** Short job title, e.g. "Researcher". */
  title: string;
  /** Persona / system prompt describing how this agent works. */
  role: string;
  template?: string;
  zoneId: string;
  /** External handoff only: never runs through a local model. Address is local world data. */
  email?: string;
  model?: string;
  effort?: Effort;
  /** Grants Anthropic's server-side web search + web fetch tools. */
  webAccess: boolean;
  /** Lead agents can hire new agents and open new areas. */
  canHire: boolean;
  appearance: Appearance;
  status: AgentStatus;
  activity: Activity;
  activityDetail?: string;
  focus?: AgentFocus;
  /** Durable facts the agent chose to remember between activations. */
  memory: string[];
  /** Rolling log of what the agent did (tool calls, thoughts) for the inspector. */
  actions: AgentAction[];
  /** Latest streamed text of the current/last activation. */
  liveText: string;
  liveThought: string;
  lastError?: string;
  stats: { tasksDone: number; activations: number; inputTokens: number; outputTokens: number; costUsd: number };
  createdAt: string;
}

export type TaskStatus = "queued" | "in_progress" | "done" | "failed" | "cancelled";

export interface Task {
  id: string;
  title: string;
  description: string;
  zoneId: string;
  assigneeId?: string;
  /** "user" or the id of the agent that delegated it. */
  createdBy: string;
  status: TaskStatus;
  result?: string;
  summary?: string;
  error?: string;
  /** Delegation depth: user tasks are 0, a task delegated from those is 1, ... */
  depth: number;
  parentTaskId?: string;
  /** Re-queue the task this many minutes after it finishes. */
  repeatEveryMinutes?: number;
  nextRunAt?: string;
  iteration: number;
  /** Feedback from the user when asking for another iteration. */
  feedback?: string;
  previousResult?: string;
  reportedToUser?: boolean;
  /** Times the agent picked this task back up after a run hit the step limit. */
  continuations?: number;
  /** What earlier runs got done before hitting the step limit; shown to the agent when it continues. */
  progress?: string;
  /** Claude Code session to resume when the task continues (Claude Code engine). */
  sessionId?: string;
  /** Email was prepared, not necessarily sent or accepted. Survives restart. */
  emailHandoff?: {
    to: string; subject: string; body: string; preparedAt: string;
    /** Set when a mail transport is configured and the email went out automatically. */
    sendingAt?: string; sentAt?: string; messageId?: string; sendError?: string;
    replyMessageId?: string; timeoutNotified?: boolean;
    /** Failed send attempts so far, and when the next automatic retry is due. */
    attempts?: number; retryAt?: string;
    /** The login was rejected with this mail account version; retried once the account changes. */
    authFailedVersion?: number;
  };
  /** Set when this task carries a message to an external agent: the reply goes back as a message. */
  replyAsMessage?: { hops: number };
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export type MessageKind = "chat" | "task_result" | "system";

export interface Message {
  id: string;
  /** Agent id or "user". */
  from: string;
  /** Agent id, "user", "zone:<id>" or "all". */
  to: string;
  content: string;
  kind: MessageKind;
  /** Conversation depth; agents stop waking up for chatter past settings.maxHops. */
  hops: number;
  taskId?: string;
  /** Agent ids that still have to process this message. */
  pendingFor: string[];
  createdAt: string;
}

export type InboxKind = "report" | "message" | "task_result" | "question";
export type Priority = "low" | "normal" | "high";

export interface InboxItem {
  id: string;
  kind: InboxKind;
  agentId: string;
  zoneId?: string;
  taskId?: string;
  title: string;
  body: string;
  actionItems: { text: string; done: boolean }[];
  priority: Priority;
  read: boolean;
  archived: boolean;
  createdAt: string;
}

export interface Note {
  id: string;
  zoneId: string;
  author: string;
  content: string;
  createdAt: string;
}

export type LogKind =
  | "system"
  | "task"
  | "message"
  | "report"
  | "agent"
  | "zone"
  | "error";

export interface LogEntry {
  id: string;
  ts: string;
  kind: LogKind;
  text: string;
  agentId?: string;
  zoneId?: string;
  /** For message animations on the map. */
  targetAgentId?: string;
  toUser?: boolean;
}

export interface WorldSettings {
  /** "api" (API key), "claude-code" (local Claude Code CLI on your Claude plan), or "auto". */
  engine: "auto" | "api" | "claude-code";
  /** Model for agents that don't specify one (API engine; Claude Code uses its own default). */
  defaultModel: string;
  /** How many agents may call the API at the same time. */
  maxConcurrent: number;
  /** Max model calls in one run; an unfinished task then continues in a fresh run. */
  maxStepsPerActivation: number;
  /** How many fresh runs a task gets after hitting the step limit before it's handed back to the user. */
  maxContinuations: number;
  /** Agent-to-agent chatter deeper than this is delivered but doesn't wake the recipient. */
  maxHops: number;
  /** How deep a chain of delegated tasks may go. */
  maxDelegationDepth: number;
  /** Circuit breaker: max activations per agent per hour. */
  maxActivationsPerHour: number;
  maxAgents: number;
  maxZones: number;
  /** Brake on outgoing email to external agents. */
  maxEmailsPerDay: number;
}

export interface WorldData {
  version: 1;
  name: string;
  paused: boolean;
  settings: WorldSettings;
  zones: Zone[];
  agents: Agent[];
  tasks: Task[];
  messages: Message[];
  inbox: InboxItem[];
  notes: Note[];
  log: LogEntry[];
  /** When emails went out in the last 24 hours (for the daily limit). */
  emailsSent?: string[];
  createdAt: string;
}

// ── Events pushed to the UI over SSE ─────────────────────────────────

export type WorldEvent =
  | { type: "world"; paused: boolean; settings: WorldSettings; name: string }
  | { type: "zone"; zone: Zone }
  | { type: "zone:removed"; id: string }
  | { type: "agent"; agent: PublicAgent }
  | { type: "agent:removed"; id: string }
  | { type: "agent:stream"; id: string; text?: string; thought?: string; reset?: boolean }
  | { type: "task"; task: Task }
  | { type: "message"; message: Message }
  | { type: "inbox"; item: InboxItem }
  | { type: "note"; note: Note }
  | { type: "note:removed"; id: string }
  | { type: "log"; entry: LogEntry }
  | { type: "stats"; stats: WorldStats };

/** Agent as sent to clients (live text trimmed). */
export type PublicAgent = Omit<Agent, "liveText" | "liveThought"> & { liveText: string; liveThought: string };

export interface WorldStats {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  running: number;
  queuedTasks: number;
  unreadInbox: number;
}
