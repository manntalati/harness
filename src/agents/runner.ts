import Anthropic from "@anthropic-ai/sdk";
import { AgentConfig } from "./types.js";

const DEFAULT_MODEL = "claude-sonnet-4-6-20250514";
const DEFAULT_MAX_TOKENS = 4096;

interface RunResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export async function runAgent(
  client: Anthropic,
  config: AgentConfig,
  signal: AbortSignal,
): Promise<RunResult> {
  const response = await client.messages.create(
    {
      model: config.model ?? DEFAULT_MODEL,
      max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: config.role,
      messages: [{ role: "user", content: config.task }],
    },
    { signal },
  );

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
