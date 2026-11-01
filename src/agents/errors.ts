/** What an engine hands back when the agent ends its turn. */
export interface EngineResult {
  finalText: string;
  stepLimitHit: boolean;
}

/** Thrown when the user stops an agent; carries what should happen to its task. */
export class StopRequested extends Error {
  constructor(readonly requeue: boolean) {
    super("stopped");
  }
}

/** The Claude plan ran out of usage: put the work back and pause until the user resumes. */
export class UsageLimitReached extends Error {}
