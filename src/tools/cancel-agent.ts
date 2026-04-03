import { z } from "zod";
import { AgentManager } from "../agents/manager.js";

export const CancelAgentSchema = z.object({
  agent_id: z.string().describe("The ID of the agent to cancel"),
});

export function handleCancelAgent(manager: AgentManager, args: z.infer<typeof CancelAgentSchema>) {
  const success = manager.cancelAgent(args.agent_id);

  if (!success) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Could not cancel agent ${args.agent_id}. It may not exist or is not running.`,
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      { type: "text" as const, text: `Agent ${args.agent_id} has been cancelled.` },
    ],
  };
}
