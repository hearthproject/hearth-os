import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { detectShell, type ShellSpec } from "./environment.ts";

export interface ShellSession {
  id: string;
  command: string;
  cwd: string;
  shell: ShellSpec;
  startedAt: number;
  child: ChildProcessWithoutNullStreams;
  output: string;
  outputPath: string;
  exitCode: number | null;
  running: boolean;
}

export interface ShellStartResult {
  sessionId: string;
  pid: number | null;
  outputPath: string;
}

export interface ShellRunResult {
  sessionId: string;
  output: string;
  exitCode: number | null;
  running: boolean;
  durationMs: number;
  outputPath: string;
}

const sessions = new Map<string, ShellSession>();
const MAX_BUFFER = 512 * 1024;

export function startShellSession(options: {
  command: string;
  cwd: string;
  outDir: string;
  env?: Record<string, string>;
  shell?: ShellSpec;
  stdin?: string;
}): ShellStartResult {
  const shell = options.shell ?? detectShell();
  const id = `sh_${randomUUID().slice(0, 8)}`;
  const logs = join(options.outDir, ".hearth", "shell");
  mkdirSync(logs, { recursive: true });
  const outputPath = join(logs, `${id}.log`);
  const child = spawn(shell.executable, [...shell.args, options.command], {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"]
  });
  const session: ShellSession = {
    id,
    command: options.command,
    cwd: options.cwd,
    shell,
    startedAt: Date.now(),
    child,
    output: "",
    outputPath,
    exitCode: null,
    running: true
  };
  sessions.set(id, session);
  try {
    writeFileSync(outputPath, `$ ${options.command}\n`, "utf8");
  } catch {
    // The in-memory buffer still works when the log cannot be created.
  }

  const onChunk = (chunk: Buffer): void => {
    const text = stripAnsi(chunk.toString("utf8"));
    session.output = `${session.output}${text}`;
    if (session.output.length > MAX_BUFFER) session.output = session.output.slice(-MAX_BUFFER);
    try {
      appendFileSync(outputPath, text, "utf8");
    } catch {
      // Keep the in-memory buffer even if the log cannot be written.
    }
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  child.on("error", (error) => {
    const text = `\n[shell error] ${error.message}\n`;
    session.output += text;
    appendFileSync(outputPath, text, "utf8");
    session.running = false;
    session.exitCode = 1;
  });
  child.on("exit", (code) => {
    session.running = false;
    session.exitCode = code;
  });
  if (options.stdin !== undefined) {
    child.stdin.write(options.stdin);
    child.stdin.end();
  }
  return { sessionId: id, pid: child.pid ?? null, outputPath };
}

export async function runShellSession(options: {
  command: string;
  cwd: string;
  outDir: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  shell?: ShellSpec;
  stdin?: string;
}): Promise<ShellRunResult> {
  const started = startShellSession(options);
  const session = sessions.get(started.sessionId)!;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  while (session.running && Date.now() < deadline) {
    await delay(Math.min(200, Math.max(1, deadline - Date.now())));
    if (options.timeoutMs === 0) break;
  }
  return {
    sessionId: session.id,
    output: session.output,
    exitCode: session.exitCode,
    running: session.running,
    durationMs: Date.now() - session.startedAt,
    outputPath: session.outputPath
  };
}

export function shellOutput(sessionId: string, offset = 0): { output: string; running: boolean; exitCode: number | null; outputPath: string | null } | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const safeOffset = Math.max(0, Math.min(offset, session.output.length));
  return { output: session.output.slice(safeOffset), running: session.running, exitCode: session.exitCode, outputPath: session.outputPath };
}

export function shellSessionInfo(sessionId: string): { running: boolean; exitCode: number | null; command: string; outputPath: string } | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return { running: session.running, exitCode: session.exitCode, command: session.command, outputPath: session.outputPath };
}

export async function waitShellSession(sessionId: string, options: { timeoutMs?: number; match?: string } = {}): Promise<{
  sessionId: string;
  output: string;
  running: boolean;
  exitCode: number | null;
  matched: boolean;
  timedOut: boolean;
  outputPath: string;
} | null> {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const timeoutMs = Math.min(10 * 60_000, Math.max(100, options.timeoutMs ?? 30_000));
  const matcher = options.match ? compileMatcher(options.match) : null;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!session.running) break;
    if (matcher && matcher.test(session.output)) break;
    await delay(100);
  }
  return {
    sessionId,
    output: session.output.slice(-8_000),
    running: session.running,
    exitCode: session.exitCode,
    matched: matcher ? matcher.test(session.output) : false,
    timedOut: session.running && !(matcher?.test(session.output) ?? false),
    outputPath: session.outputPath
  };
}

function compileMatcher(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

export function killShellSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (!session.running) return true;
  session.running = false;
  session.exitCode = null;
  try {
    if (process.platform === "win32") {
      if (session.child.pid) {
        spawnSync("taskkill", ["/pid", String(session.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5_000 });
      }
      session.child.kill("SIGKILL");
    } else if (session.child.pid) {
      process.kill(-session.child.pid, "SIGTERM");
    } else {
      session.child.kill("SIGTERM");
    }
  } catch {
    try {
      session.child.kill("SIGKILL");
    } catch {
      // Process may already be gone.
    }
  }
  return true;
}

export function cleanupShellSessions(): void {
  for (const session of sessions.values()) {
    if (session.running) killShellSession(session.id);
  }
  sessions.clear();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

process.once("exit", cleanupShellSessions);
