#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { World } from "./world/world.js";
import { Scheduler } from "./world/scheduler.js";
import { HarnessContext, callMethod } from "./api/methods.js";
import { createMcpServer, remoteCaller } from "./api/mcp.js";
import { APP_ID, startHttpServer } from "./server/http.js";
import { EngineEnv, detectClaudeCli, engineProblem, resolveEngine } from "./agents/engine.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }).version;

const USAGE = `agent-harness — a playground of collaborating AI agents

Usage:
  agent-harness serve   Run the playground (web UI + agents) in this terminal
  agent-harness mcp     Run as an MCP server over stdio (default). If a playground
                        is already running, tool calls are forwarded to it.

Options:
  --port <n>     Web UI port (default 3456, env HARNESS_PORT)
  --home <dir>   Where the world is saved (default ~/.agent-harness, env HARNESS_HOME)
  --host <addr>  Interface to bind (default 127.0.0.1, env HARNESS_HOST)
`;

function log(message: string): void {
  // stdout belongs to the MCP protocol, so everything human-readable goes to stderr.
  process.stderr.write(`[harness] ${message}\n`);
}

function loadDotEnv(): void {
  for (const file of [join(process.cwd(), ".env"), join(PACKAGE_ROOT, ".env")]) {
    if (existsSync(file)) {
      try {
        process.loadEnvFile(file);
      } catch (err) {
        log(`couldn't read ${file}: ${String(err)}`);
      }
      return;
    }
  }
}

/** Command-line words that aren't flags or flag values. */
function positionalArgs(): string[] {
  const args = process.argv.slice(2);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (!args[i].includes("=") && ["--port", "--home", "--host"].includes(args[i])) i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

async function findRunningPlayground(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(800) });
    const body = (await res.json()) as { app?: string };
    return body.app === APP_ID;
  } catch {
    return false;
  }
}

async function startLocal(withUi: boolean): Promise<{ ctx: HarnessContext; shutdown: () => Promise<void> }> {
  const config = loadConfig();
  const world = await World.load(config.home, config.defaultModel);
  const env: EngineEnv = {
    hasCredentials: config.hasCredentials,
    claudeBin: config.claudeBin,
    claudeVersion: await detectClaudeCli(config.claudeBin),
    home: config.home,
    bridgeBase: null,
  };
  const scheduler = new Scheduler(world, env);
  const ctx: HarnessContext = { world, scheduler };

  let server: Awaited<ReturnType<typeof startHttpServer>> | null = null;
  if (withUi) {
    try {
      server = await startHttpServer(config, ctx, VERSION);
      const local = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
      env.bridgeBase = `http://${local.includes(":") ? `[${local}]` : local}:${config.port}/mcp/agent`;
      log(`Playground running at http://${local}:${config.port}`);
    } catch (err) {
      log(`Couldn't start the web UI on port ${config.port}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(`World saved in ${config.home}`);
  const engine = resolveEngine(world.data.settings.engine, env);
  if (engine === "claude-code") log(`Agents run on Claude Code ${env.claudeVersion} (your Claude plan).`);
  else if (engine === "api") log(`Agents run on the Anthropic API (${world.data.settings.defaultModel}).`);
  else log(engineProblem(world.data.settings.engine, env) ?? "No engine available.");
  scheduler.start();

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    scheduler.stop();
    server?.close();
    await world.flush();
  };
  return { ctx, shutdown };
}

function onExit(shutdown: () => Promise<void>): void {
  const exit = () => {
    void shutdown().finally(() => process.exit(0));
  };
  process.on("SIGINT", exit);
  process.on("SIGTERM", exit);
}

async function main(): Promise<void> {
  loadDotEnv();
  const command = positionalArgs()[0] ?? "mcp";

  if (command === "help" || process.argv.includes("--help")) {
    process.stderr.write(USAGE);
    return;
  }

  if (command === "serve") {
    const { shutdown } = await startLocal(true);
    onExit(shutdown);
    return;
  }

  if (command !== "mcp") {
    process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
    process.exit(1);
  }

  const config = loadConfig();
  const baseUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
  let mcp;
  let shutdown = async () => {};

  if (await findRunningPlayground(baseUrl)) {
    log(`Connected to the playground already running at ${baseUrl}`);
    mcp = createMcpServer(remoteCaller(baseUrl), VERSION);
  } else {
    const local = await startLocal(true);
    shutdown = local.shutdown;
    mcp = createMcpServer((name, args) => callMethod(local.ctx, name, args), VERSION);
  }

  onExit(shutdown);
  // When the MCP client goes away, save and exit.
  process.stdin.on("close", () => {
    void shutdown().finally(() => process.exit(0));
  });
  await mcp.connect(new StdioServerTransport());
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
