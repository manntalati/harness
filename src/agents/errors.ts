import type Anthropic from "@anthropic-ai/sdk";

/** What an engine hands back when the agent ends its turn. */
export interface EngineResult {
  finalText: string;
  stepLimitHit: boolean;
  /** Claude Code engine: the session this run used, so a continuation can resume it. */
  sessionId?: string;
  /** API engine: the conversation so far, so a continuation can pick it up. */
  conversation?: Anthropic.Beta.BetaMessageParam[];
}

/** Thrown when the user stops an agent; carries what should happen to its task. */
export class StopRequested extends Error {
  constructor(readonly requeue: boolean) {
    super("stopped");
  }
}

/** The Claude plan ran out of usage: put the work back and pause until the user resumes. */
export class UsageLimitReached extends Error {}
