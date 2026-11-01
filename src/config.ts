import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Runtime configuration, resolved once from env vars and CLI flags. */
export interface HarnessConfig {
  /** Directory holding world.json (zones, agents, tasks, inbox...). */
  home: string;
  /** Port for the playground web UI + REST API. */
  port: number;
  /** Interface the playground binds to. Loopback by default: agents can write files and run commands. */
  host: string;
  /** Model used by agents that don't set their own. */
  defaultModel: string;
  hasCredentials: boolean;
  /** Claude Code executable, for running agents on a Claude subscription. */
  claudeBin: string;
}

function flag(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const prefixed = process.argv.find((a) => a.startsWith(`--${name}=`));
  return prefixed?.slice(name.length + 3);
}

export function loadConfig(): HarnessConfig {
  const home = resolve(flag("home") ?? process.env.HARNESS_HOME ?? join(homedir(), ".agent-harness"));
  const port = parseInt(flag("port") ?? process.env.HARNESS_PORT ?? process.env.DASHBOARD_PORT ?? "3456", 10);
  return {
    home,
    port,
    host: flag("host") ?? process.env.HARNESS_HOST ?? "127.0.0.1",
    defaultModel: process.env.HARNESS_MODEL ?? "claude-opus-5-5",
    claudeBin: process.env.CLAUDE_BIN ?? "claude",
    hasCredentials: Boolean(
      process.env.ANTHROPIC_API_KEY ||
        process.env.ANTHROPIC_AUTH_TOKEN ||
        process.env.ANTHROPIC_PROFILE ||
        process.env.ANTHROPIC_FEDERATION_RULE_ID,
    ),
  };
}

/** Per-million-token prices used for the UI's cost estimate. Unknown models show tokens only. */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export const MODEL_CHOICES = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-1",
];
