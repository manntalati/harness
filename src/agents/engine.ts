import { execFile } from "node:child_process";

/**
 * How agents think:
 * - "api": direct Anthropic API calls with an API key (pay per token).
 * - "claude-code": each activation runs the local Claude Code CLI headlessly,
 *   using whatever account it is logged in with, e.g. a Pro or Max plan.
 */
export type EngineName = "api" | "claude-code";
export type EngineSetting = "auto" | EngineName;

export interface EngineEnv {
  hasCredentials: boolean;
  claudeBin: string;
  claudeVersion: string | null;
  home: string;
  /** Base URL (…/mcp/agent) agents running in Claude Code use to reach their team tools. */
  bridgeBase: string | null;
}

export function detectClaudeCli(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      const version = stdout.trim().split(/\s+/)[0];
      resolve(version || null);
    });
  });
}

export function resolveEngine(setting: EngineSetting, env: EngineEnv): EngineName | null {
  if (setting === "api") return "api";
  if (setting === "claude-code") return env.claudeVersion ? "claude-code" : null;
  if (env.hasCredentials) return "api";
  if (env.claudeVersion) return "claude-code";
  return null;
}

export function engineProblem(setting: EngineSetting, env: EngineEnv): string | null {
  if (resolveEngine(setting, env)) return null;
  if (setting === "claude-code") {
    return "Claude Code isn't installed (or isn't on PATH), so agents can't run on your Claude plan. Install it from https://claude.com/claude-code and log in, or set CLAUDE_BIN.";
  }
  return "Agents have no way to think yet: install and log in to Claude Code to use your Claude plan, or set ANTHROPIC_API_KEY to use the API.";
}
