import { AgentManager } from "../agents/manager.js";

export function handleListAgents(manager: AgentManager) {
  const agents = manager.listAgents();

  return {
    content: [
      {
        type: "text" as const,
        text: agents.length > 0
          ? JSON.stringify(agents, null, 2)
          : "No agents have been created yet.",
      },
    ],
  };
}
