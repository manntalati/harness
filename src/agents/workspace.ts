import { exec } from "node:child_process";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// File tools for agents working in an area that is tied to a folder on disk.
// Every path is resolved against the workspace root and rejected if it
// escapes it (including through symlinks).

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "__pycache__", ".venv", "venv", "target", ".cache", "coverage"]);
const MAX_READ_BYTES = 200_000;
const MAX_LIST_ENTRIES = 400;
const MAX_SEARCH_HITS = 80;
const MAX_COMMAND_OUTPUT = 20_000;

export class WorkspaceError extends Error {}

export class Workspace {
  constructor(readonly root: string) {}

  private async resolveInside(path: string, mustExist: boolean): Promise<string> {
    const rootReal = await realpath(this.root).catch(() => {
      throw new WorkspaceError(`Workspace folder does not exist: ${this.root}`);
    });
    const target = resolve(rootReal, path || ".");
    const rel = relative(rootReal, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new WorkspaceError(`Path escapes the workspace: ${path}`);
    }
    // Resolve symlinks on the deepest existing ancestor.
    let probe = target;
    while (true) {
      try {
        const real = await realpath(probe);
        const realRel = relative(rootReal, real);
        if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
          throw new WorkspaceError(`Path escapes the workspace through a symlink: ${path}`);
        }
        break;
      } catch (err) {
        if (err instanceof WorkspaceError) throw err;
        if (mustExist) throw new WorkspaceError(`No such file or directory: ${path}`);
        const parent = dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    return target;
  }

  private rel(abs: string): string {
    return relative(this.root, abs) || ".";
  }

  async list(path = ".", depth = 2): Promise<string> {
    const start = await this.resolveInside(path, true);
    const lines: string[] = [];
    const walk = async (dir: string, level: number) => {
      if (lines.length >= MAX_LIST_ENTRIES) return;
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (lines.length >= MAX_LIST_ENTRIES) {
          lines.push("… (truncated)");
          return;
        }
        if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        lines.push(`${"  ".repeat(level)}${entry.name}${entry.isDirectory() ? "/" : ""}`);
        if (entry.isDirectory() && level + 1 < depth) await walk(full, level + 1);
      }
    };
    await walk(start, 0);
    return `${this.rel(start)}/\n${lines.join("\n") || "(empty)"}`;
  }

  async read(path: string, startLine?: number, endLine?: number): Promise<string> {
    const file = await this.resolveInside(path, true);
    const info = await stat(file);
    if (info.isDirectory()) throw new WorkspaceError(`${path} is a directory; use list_files`);
    if (info.size > MAX_READ_BYTES * 5) throw new WorkspaceError(`${path} is too large (${info.size} bytes)`);
    const text = await readFile(file, "utf8");
    const lines = text.split("\n");
    const from = Math.max(1, startLine ?? 1);
    const to = Math.min(lines.length, endLine ?? lines.length);
    let out = "";
    for (let i = from; i <= to; i++) {
      const line = `${String(i).padStart(5)}  ${lines[i - 1]}\n`;
      if (out.length + line.length > MAX_READ_BYTES) {
        out += `… (truncated at line ${i - 1} of ${lines.length}; pass start_line to read more)\n`;
        break;
      }
      out += line;
    }
    return out || "(empty file)";
  }

  async write(path: string, content: string): Promise<string> {
    const file = await this.resolveInside(path, false);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
    return `Wrote ${content.length} characters to ${this.rel(file)}`;
  }

  async edit(path: string, oldString: string, newString: string): Promise<string> {
    const file = await this.resolveInside(path, true);
    const text = await readFile(file, "utf8");
    const count = text.split(oldString).length - 1;
    if (count === 0) throw new WorkspaceError(`old_string not found in ${path}`);
    if (count > 1) throw new WorkspaceError(`old_string appears ${count} times in ${path}; include more context so it is unique`);
    await writeFile(file, text.replace(oldString, () => newString), "utf8");
    return `Edited ${this.rel(file)}`;
  }

  async search(pattern: string, path = "."): Promise<string> {
    const start = await this.resolveInside(path, true);
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch {
      throw new WorkspaceError(`Invalid regular expression: ${pattern}`);
    }
    const hits: string[] = [];
    const walk = async (dir: string) => {
      if (hits.length >= MAX_SEARCH_HITS) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (hits.length >= MAX_SEARCH_HITS) return;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) await walk(full);
          continue;
        }
        const info = await stat(full).catch(() => null);
        if (!info || info.size > MAX_READ_BYTES) continue;
        const text = await readFile(full, "utf8").catch(() => "");
        if (text.includes("\u0000")) continue;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
          if (regex.test(lines[i])) hits.push(`${this.rel(full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
    };
    const info = await stat(start);
    if (info.isDirectory()) await walk(start);
    else {
      const lines = (await readFile(start, "utf8")).split("\n");
      lines.forEach((l, i) => regex.test(l) && hits.length < MAX_SEARCH_HITS && hits.push(`${this.rel(start)}:${i + 1}: ${l.trim().slice(0, 200)}`));
    }
    return hits.length ? hits.join("\n") + (hits.length >= MAX_SEARCH_HITS ? "\n… (more matches not shown)" : "") : "No matches.";
  }

  run(command: string, signal: AbortSignal, timeoutMs = 120_000): Promise<string> {
    return new Promise((resolvePromise) => {
      exec(
        command,
        { cwd: this.root, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, signal, env: { ...process.env, CI: "1" } },
        (error, stdout, stderr) => {
          const exit = error ? (error.killed ? "killed (timeout or cancelled)" : `exit code ${error.code ?? "?"}`) : "exit code 0";
          let out = `$ ${command}\n[${exit}]\n`;
          if (stdout) out += `--- stdout ---\n${stdout}`;
          if (stderr) out += `\n--- stderr ---\n${stderr}`;
          if (out.length > MAX_COMMAND_OUTPUT) {
            out = out.slice(0, MAX_COMMAND_OUTPUT / 2) + "\n… (output truncated) …\n" + out.slice(-MAX_COMMAND_OUTPUT / 2);
          }
          resolvePromise(out);
        },
      );
    });
  }
}
