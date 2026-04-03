import { z } from "zod";
import { AgentManager } from "../agents/manager.js";

export const GetResultSchema = z.object({
  agent_id: z.string().describe("The ID of the agent to get results for"),
});

export function handleGetResult(manager: AgentManager, args: z.infer<typeof GetResultSchema>) {
  const result = manager.getAgentResult(args.agent_id);

  if (!result) {
    return {
      content: [{ type: "text" as const, text: `Agent not found: ${args.agent_id}` }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}
