import { z } from "zod";
import { AgentManager } from "../agents/manager.js";

export const CreateTemplateSchema = z.object({
  name: z.string().describe("Template name (used to reference it later)"),
  role: z.string().describe("System prompt for agents created from this template"),
  model: z.string().optional().describe("Default model for this template"),
  max_tokens: z.number().optional().describe("Default max tokens for this template"),
});

export function handleCreateTemplate(
  manager: AgentManager,
  args: z.infer<typeof CreateTemplateSchema>,
) {
  manager.createTemplate({
    name: args.name,
    role: args.role,
    model: args.model,
    maxTokens: args.max_tokens,
  });

  return {
    content: [
      { type: "text" as const, text: `Template "${args.name}" created successfully.` },
    ],
  };
}

export function handleListTemplates(manager: AgentManager) {
  const templates = manager.listTemplates();

  return {
    content: [
      { type: "text" as const, text: JSON.stringify(templates, null, 2) },
    ],
  };
}
