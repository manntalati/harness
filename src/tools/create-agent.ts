import { z } from "zod";
import { AgentManager } from "../agents/manager.js";

export const CreateAgentSchema = z.object({
  name: z.string().describe("A short name for this agent"),
  role: z.string().describe("System prompt defining the agent's role and behavior"),
  task: z.string().describe("The task/question for the agent to work on"),
  model: z.string().optional().describe("Model to use (default: claude-sonnet-4-6-20250514)"),
  max_tokens: z.number().optional().describe("Max tokens for the response (default: 4096)"),
});

export function handleCreateAgent(manager: AgentManager, args: z.infer<typeof CreateAgentSchema>) {
  const id = manager.createAgent({
    name: args.name,
    role: args.role,
    task: args.task,
    model: args.model,
    maxTokens: args.max_tokens,
  });

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ id, name: args.name, status: "running" }, null, 2),
      },
    ],
  };
}
