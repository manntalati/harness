import Anthropic from "@anthropic-ai/sdk";
import { AgentConfig, AgentProgress, TokenUsage } from "./types.js";

const DEFAULT_MODEL = "claude-sonnet-4-6-20250514";
const DEFAULT_MAX_TOKENS = 4096;

export interface RunResult {
  text: string;
  tokenUsage: TokenUsage;
}

export type ProgressCallback = (progress: AgentProgress) => void;

export async function runAgentStreaming(
  client: Anthropic,
  config: AgentConfig,
  signal: AbortSignal,
  onProgress?: ProgressCallback,
): Promise<RunResult> {
  const stream = client.messages.stream(
    {
      model: config.model ?? DEFAULT_MODEL,
      max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: config.role,
      messages: [{ role: "user", content: config.task }],
    },
    { signal },
  );

  let fullText = "";

  stream.on("text", (chunk) => {
    fullText += chunk;
    onProgress?.({
      textLength: fullText.length,
      latestChunk: chunk,
    });
  });

  const finalMessage = await stream.finalMessage();

  return {
    text: fullText,
    tokenUsage: {
      inputTokens: finalMessage.usage.input_tokens,
      outputTokens: finalMessage.usage.output_tokens,
    },
  };
}
