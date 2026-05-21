import { z } from "zod";
import { Orchestrator } from "../agents/orchestrator.js";

export const StartOrchestrationSchema = z.object({
  goal: z
    .string()
    .describe("The high-level goal for the PM agent to decompose and execute"),
  model: z
    .string()
    .optional()
    .describe("Model for the PM agent (default: claude-sonnet-4-6-20250514)"),
  max_sub_tasks: z
    .number()
    .optional()
    .describe("Maximum number of worker agents to spawn (default: 10)"),
  enable_review: z
    .boolean()
    .optional()
    .describe("Enable code review mode — PM reviews each worker's output and requests revisions before synthesis (default: false)"),
  max_review_iterations: z
    .number()
    .optional()
    .describe("Maximum number of review-and-revise cycles (default: 2). Only used when enable_review is true."),
});

export async function handleStartOrchestration(
  orchestrator: Orchestrator,
  args: z.infer<typeof StartOrchestrationSchema>,
) {
  const id = await orchestrator.startOrchestration({
    goal: args.goal,
    model: args.model,
    maxSubTasks: args.max_sub_tasks,
    enableReview: args.enable_review,
    maxReviewIterations: args.max_review_iterations,
  });

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            id,
            goal: args.goal,
            status: "planning",
            message:
              "Orchestration started. The PM agent is decomposing the goal into sub-tasks. Use get_orchestration_status to monitor progress.",
          },
          null,
          2,
        ),
      },
    ],
  };
}

export const GetOrchestrationSchema = z.object({
  orchestration_id: z
    .string()
    .describe("The ID of the orchestration to check"),
});

export function handleGetOrchestrationStatus(
  orchestrator: Orchestrator,
  args: z.infer<typeof GetOrchestrationSchema>,
) {
  const result = orchestrator.getOrchestration(args.orchestration_id);

  if (!result) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Orchestration not found: ${args.orchestration_id}`,
        },
      ],
      isError: true,
    };
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

export function handleListOrchestrations(orchestrator: Orchestrator) {
  const list = orchestrator.listOrchestrations();

  return {
    content: [
      {
        type: "text" as const,
        text:
          list.length > 0
            ? JSON.stringify(list, null, 2)
            : "No orchestrations have been started yet.",
      },
    ],
  };
}

export const CancelOrchestrationSchema = z.object({
  orchestration_id: z
    .string()
    .describe("The ID of the orchestration to cancel"),
});

export function handleCancelOrchestration(
  orchestrator: Orchestrator,
  args: z.infer<typeof CancelOrchestrationSchema>,
) {
  const success = orchestrator.cancelOrchestration(args.orchestration_id);

  if (!success) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Could not cancel orchestration ${args.orchestration_id}. It may not exist or is already finished.`,
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `Orchestration ${args.orchestration_id} is being cancelled. All running worker agents will be stopped.`,
      },
    ],
  };
}
