import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { Message } from "../world/types.js";
import { briefing, systemPrompt } from "./prompts.js";
import { ToolContext, toolActivity } from "./tools.js";
import { closeBridge, openBridge } from "./bridge.js";
import { EngineEnv } from "./engine.js";
import { EngineResult, StopRequested, UsageLimitReached } from "./errors.js";
import { Activity } from "../world/types.js";

// Engine that runs each activation through the local Claude Code CLI in
// headless mode (`claude -p`). Claude Code brings its own file, search,
// shell and web tools and runs on whatever account it is logged in with,
// so a Claude Pro/Max plan works without an API key. Team tools come in
// over the MCP bridge.

const ACTIVATION_TIMEOUT_MS = 30 * 60_000;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "area";
}

function short(s: unknown, n = 70): string {
  const str = String(s ?? "").replace(/\s+/g, " ").trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function activityFor(name: string): Activity {
  if (name.startsWith("mcp__harness__")) return toolActivity(name.slice("mcp__harness__".length));
  switch (name) {
    case "Read":
    case "Glob":
    case "Grep":
    case "LS":
    case "WebFetch":
      return "reading";
    case "WebSearch":
      return "searching";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "editing";
    case "Bash":
      return "running";
    case "Task":
      return "delegating";
    default:
      return "thinking";
  }
}

function describe(name: string, input: Record<string, unknown>, cwd: string): string {
  const path = (p: unknown) => (typeof p === "string" ? relative(cwd, p) || p : "a file");
  switch (name) {
    case "Read":
      return `read ${path(input.file_path)}`;
    case "Edit":
    case "MultiEdit":
      return `edited ${path(input.file_path)}`;
    case "Write":
      return `wrote ${path(input.file_path)}`;
    case "Glob":
      return `looked for ${short(input.pattern, 50)}`;
    case "Grep":
      return `searched for /${short(input.pattern, 50)}/`;
    case "Bash":
      return `ran \`${short(input.command)}\``;
    case "WebSearch":
      return `searched the web: ${short(input.query)}`;
    case "WebFetch":
      return `fetched ${short(input.url)}`;
    case "Task":
      return `started a sub-agent: ${short(input.description)}`;
    case "TodoWrite":
      return "updated its to-do list";
    case "ToolSearch":
      return "loaded its team tools";
    default:
      return name;
  }
}

function friendly(raw: string): string {
  const text = raw.trim();
  if (/not logged in|please run \/login|\/login|invalid api key|authentication/i.test(text)) {
    return "Claude Code isn't logged in. Run `claude` in a terminal, log in with your Claude account, then retry.";
  }
  if (/unknown option|unrecognized option/i.test(text)) {
    return `Your Claude Code version doesn't support a flag the harness needs; run \`claude update\`. (${short(text, 160)})`;
  }
  return text || "Claude Code exited without a result.";
}

const USAGE_LIMIT = /(usage|session|weekly|5-hour|five-hour|plan) limit|limit reached|hit your( \w+)? limit|out of (extra )?usage/i;

interface StreamLine {
  type: string;
  subtype?: string;
  event?: {
    type: string;
    delta?: { type: string; text?: string; thinking?: string };
    content_block?: { type: string; name?: string };
  };
  message?: { id?: string; content?: { type: string; text?: string; name?: string; input?: Record<string, unknown> }[] };
  mcp_servers?: { name: string; status: string }[];
  result?: string;
  is_error?: boolean;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  errors?: string[];
}

export async function runClaudeCode(ctx: ToolContext, messages: Message[], env: EngineEnv): Promise<EngineResult> {
  const { world, agent, zone, task, signal } = ctx;
  const settings = world.data.settings;
  if (!env.bridgeBase) {
    throw new Error("The playground's web server isn't running, so agents in Claude Code can't reach their team tools. Make sure the port is free and restart the harness.");
  }
  const cwd = zone.workspace ?? join(env.home, "scratch", `${slug(zone.name)}-${zone.id.slice(-4)}`);
  await mkdir(cwd, { recursive: true });

  const token = openBridge(ctx);
  try {
    const mcpConfig = JSON.stringify({ mcpServers: { harness: { type: "http", url: `${env.bridgeBase}/${token}` } } });
    // Only load the built-in tools this agent may use: a smaller toolset means less context on every run.
    const builtins = ["Read", "Glob", "Grep", "Edit", "Write", "NotebookEdit"];
    if (agent.webAccess) builtins.push("WebSearch", "WebFetch");
    if (zone.workspace && zone.allowCommands) builtins.push("Bash");

    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--no-session-persistence",
      "--append-system-prompt", systemPrompt(agent, "claude-code"),
      "--mcp-config", mcpConfig,
      "--strict-mcp-config",
      // Anything not pre-approved below is denied rather than prompting: nobody is at the keyboard.
      "--permission-mode", "dontAsk",
      "--tools", builtins.join(","),
      "--allowedTools", ["mcp__harness", ...builtins].join(","),
      ...(agent.model ? ["--model", agent.model] : []),
      ...(agent.effort ? ["--effort", agent.effort] : []),
    ];

    // Use the CLI's own login (e.g. a Claude Pro/Max plan) rather than an API key from our environment.
    const childEnv = { ...process.env };
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;
    // The harness may itself run under Claude Code (as an MCP server); each agent is its own session.
    delete childEnv.CLAUDECODE;

    const child = spawn(env.claudeBin, args, { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let spawnError: Error | null = null;
    const exited = new Promise<number | null>((resolve) => {
      child.on("error", (err) => {
        spawnError = err;
        resolve(null);
      });
      child.on("close", (code) => resolve(code));
    });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(briefing({ world, agent, zone, task, messages, engine: "claude-code", cwd, resumed: ctx.resumed }));

    const kill = () => child.kill("SIGTERM");
    signal.addEventListener("abort", kill);
    const timer = setTimeout(kill, ACTIVATION_TIMEOUT_MS);

    let finalText = "";
    let wroteText = false;
    let result: StreamLine | null = null;
    let stepLimitHit = false;
    const toolTurns = new Set<string>();

    try {
      for await (const line of createInterface({ input: child.stdout })) {
        let evt: StreamLine;
        try {
          evt = JSON.parse(line) as StreamLine;
        } catch {
          continue;
        }
        if (evt.type === "system" && evt.subtype === "init") {
          const bridge = evt.mcp_servers?.find((s) => s.name === "harness");
          if (bridge && bridge.status !== "connected") {
            world.addAction(agent.id, "error", `Team tools didn't connect (${bridge.status}); this agent can't message or report this time.`);
          }
        } else if (evt.type === "stream_event" && evt.event) {
          const e = evt.event;
          if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
            if (agent.activity !== "writing") world.setAgentState(agent.id, { activity: "writing" });
            world.streamAgent(agent.id, { text: e.delta.text });
            wroteText = true;
          } else if (e.type === "content_block_delta" && e.delta?.type === "thinking_delta" && e.delta.thinking) {
            if (agent.activity !== "thinking") world.setAgentState(agent.id, { activity: "thinking" });
            world.streamAgent(agent.id, { thought: e.delta.thinking });
          } else if (e.type === "content_block_start" && e.content_block?.type === "tool_use" && e.content_block.name) {
            world.setAgentState(agent.id, { activity: activityFor(e.content_block.name) });
          } else if (e.type === "message_stop" && wroteText) {
            world.streamAgent(agent.id, { text: "\n\n" });
            wroteText = false;
          }
        } else if (evt.type === "assistant" && evt.message?.content) {
          for (const block of evt.message.content) {
            if (block.type === "text" && block.text?.trim()) {
              finalText = block.text.trim();
              world.addAction(agent.id, "text", finalText.slice(0, 400));
            } else if (block.type === "tool_use" && block.name) {
              toolTurns.add(evt.message.id ?? `${toolTurns.size}`);
              // Team tools are logged by the bridge when they run.
              if (!block.name.startsWith("mcp__harness__")) {
                const summary = describe(block.name, block.input ?? {}, cwd);
                world.addAction(agent.id, "tool", summary);
                world.setAgentState(agent.id, { activity: activityFor(block.name), activityDetail: summary.slice(0, 120) });
              }
            }
          }
          if (toolTurns.size > settings.maxStepsPerActivation && !stepLimitHit) {
            stepLimitHit = true;
            kill();
          }
        } else if (evt.type === "result") {
          result = evt;
        }
      }
      await exited;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
    }

    if (signal.aborted) throw signal.reason ?? new StopRequested(true);
    if (stepLimitHit) return { finalText, stepLimitHit: true };
    if (spawnError) {
      throw new Error(`Couldn't start Claude Code (${env.claudeBin}): ${(spawnError as Error).message}. Install it or set CLAUDE_BIN.`);
    }

    if (result?.usage) {
      // Runs on the user's Claude plan: track tokens, not dollars.
      world.addUsage(agent.id, "claude-code", {
        input_tokens: result.usage.input_tokens ?? 0,
        output_tokens: result.usage.output_tokens ?? 0,
        cache_read_input_tokens: result.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: result.usage.cache_creation_input_tokens ?? 0,
      });
      world.emitAgent(agent);
    }

    if (result && !result.is_error && result.subtype === "success") {
      return { finalText: (result.result ?? finalText).trim(), stepLimitHit: false };
    }
    if (result?.subtype === "error_max_turns") return { finalText, stepLimitHit: true };

    const problem = [result?.result, ...(result?.errors ?? []), stderr].filter(Boolean).join("\n");
    if (USAGE_LIMIT.test(problem)) {
      throw new UsageLimitReached(`Your Claude plan's usage limit was reached (${short(problem, 140)}).`);
    }
    throw new Error(friendly(problem || `Claude Code exited with code ${await exited}`));
  } finally {
    closeBridge(token);
  }
}
