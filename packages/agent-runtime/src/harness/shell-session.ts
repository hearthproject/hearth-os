import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { detectShell, type ShellSpec } from "./environment.ts";
import {
  buildChildEnv,
  ensureSandboxTemp,
  runnerFailed,
  SandboxUnavailableError,
  type RunnerFailureRule,
  type SandboxEnforcement,
  type SandboxPolicy,
  type SandboxProvider,
  type NetworkEnforcement
} from "./sandbox.ts";
import { redactSecrets } from "./tool-output.ts";

export type ShellSandboxFailure = "denied" | "runner_failure";

export interface ShellSandboxRun {
  backend: string;
  enforcement: SandboxEnforcement;
  networkEnforcement: NetworkEnforcement;
  mode: string;
  denialSignatures: readonly string[];
  runnerFailureRules: readonly RunnerFailureRule[];
}

export interface ShellSandboxOptions {
  provider: SandboxProvider;
  policy: SandboxPolicy;
}

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
  sandbox: ShellSandboxRun | null;
}

export interface ShellStartResult {
  sessionId: string;
  pid: number | null;
  outputPath: string;
  sandbox: ShellSandboxRun | null;
}

export interface ShellRunResult {
  sessionId: string;
  output: string;
  exitCode: number | null;
  running: boolean;
  durationMs: number;
  outputPath: string;
  sandbox: ShellSandboxRun | null;
  sandboxFailure: ShellSandboxFailure | null;
}

const sessions = new Map<string, ShellSession>();
const MAX_BUFFER = 512 * 1024;

export async function startShellSession(options: {
  command: string;
  cwd: string;
  outDir: string;
  env?: Record<string, string>;
  shell?: ShellSpec;
  stdin?: string;
  sandbox?: ShellSandboxOptions;
  unsafeNoSandbox?: boolean;
  signal?: AbortSignal;
}): Promise<ShellStartResult> {
  const shell = options.shell ?? detectShell();
  const id = `sh_${randomUUID().slice(0, 8)}`;
  const logs = join(options.outDir, ".hearth", "shell");
  mkdirSync(logs, { recursive: true });
  const outputPath = join(logs, `${id}.log`);
  const argv = [shell.executable, ...shell.args, options.command];

  let spawnArgv: readonly string[] = argv;
  let spawnCwd = options.cwd;
  let spawnEnv: Record<string, string>;
  let sandbox: ShellSandboxRun | null = null;

  if (options.sandbox) {
    ensureSandboxTemp(options.sandbox.policy);
    const policy = options.env
      ? {
          ...options.sandbox.policy,
          env: buildChildEnv({
            base: options.sandbox.policy.env,
            extra: options.env,
            tempRoot: options.sandbox.policy.tempRoot,
            workspaceRoot: options.sandbox.policy.workspaceRoot
          })
        }
      : options.sandbox.policy;
    const confined = await options.sandbox.provider.confine({
      argv,
      cwd: options.cwd,
      policy,
      ...(options.signal ? { signal: options.signal } : {})
    });
    spawnArgv = confined.argv;
    spawnCwd = confined.cwd;
    spawnEnv = { ...confined.env };
    sandbox = {
      backend: confined.backend,
      enforcement: confined.enforcement,
      networkEnforcement: confined.networkEnforcement,
      mode: policy.mode,
      denialSignatures: confined.denialSignatures,
      runnerFailureRules: confined.runnerFailureRules
    };
  } else if (options.unsafeNoSandbox) {
    const tempRoot = join(options.outDir, ".hearth", "shell-tmp");
    mkdirSync(tempRoot, { recursive: true });
    spawnEnv = buildChildEnv({
      base: process.env,
      extra: options.env,
      tempRoot,
      workspaceRoot: options.cwd
    });
  } else {
    throw new SandboxUnavailableError("native shell 需要沙箱；不能在没有 SandboxProvider 的情况下 spawn");
  }

  const child = spawn(spawnArgv[0]!, spawnArgv.slice(1), {
    cwd: spawnCwd,
    env: spawnEnv,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"]
  });
  const session: ShellSession = {
    id,
    command: options.command,
    cwd: spawnCwd,
    shell,
    startedAt: Date.now(),
    child,
    output: "",
    outputPath,
    exitCode: null,
    running: true,
    sandbox
  };
  sessions.set(id, session);
  try {
    writeFileSync(outputPath, `$ ${redactSecrets(options.command)}\n`, "utf8");
  } catch {
    // The in-memory buffer still works when the log cannot be created.
  }

  const onChunk = (chunk: Buffer): void => {
    const text = redactSecrets(stripAnsi(chunk.toString("utf8")));
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
    const text = `\n[shell error] ${redactSecrets(error.message)}\n`;
    session.output += text;
    try {
      appendFileSync(outputPath, text, "utf8");
    } catch {
      // Keep the in-memory buffer even if the log cannot be updated.
    }
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
  return { sessionId: id, pid: child.pid ?? null, outputPath, sandbox };
}

export async function runShellSession(options: {
  command: string;
  cwd: string;
  outDir: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  shell?: ShellSpec;
  stdin?: string;
  sandbox?: ShellSandboxOptions;
  unsafeNoSandbox?: boolean;
  signal?: AbortSignal;
}): Promise<ShellRunResult> {
  const started = await startShellSession(options);
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
    outputPath: session.outputPath,
    sandbox: session.sandbox,
    sandboxFailure: classifySandboxFailure(session)
  };
}

function classifySandboxFailure(session: ShellSession): ShellSandboxFailure | null {
  if (!session.sandbox || session.exitCode === null) return null;
  if (runnerFailed(session.output, session.exitCode, session.sandbox.runnerFailureRules)) return "runner_failure";
  if (session.sandbox.denialSignatures.some((signature) => session.output.includes(signature))) return "denied";
  return null;
}

export function shellOutput(sessionId: string, offset = 0): { output: string; running: boolean; exitCode: number | null; outputPath: string | null } | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const safeOffset = Math.max(0, Math.min(offset, session.output.length));
  return { output: session.output.slice(safeOffset), running: session.running, exitCode: session.exitCode, outputPath: session.outputPath };
}

export function shellSessionInfo(sessionId: string): { running: boolean; exitCode: number | null; command: string; outputPath: string; sandbox: ShellSandboxRun | null } | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return { running: session.running, exitCode: session.exitCode, command: session.command, outputPath: session.outputPath, sandbox: session.sandbox };
}

export async function waitShellSession(sessionId: string, options: { timeoutMs?: number; match?: string } = {}): Promise<{
  sessionId: string;
  output: string;
  running: boolean;
  exitCode: number | null;
  matched: boolean;
  timedOut: boolean;
  outputPath: string;
  sandbox: ShellSandboxRun | null;
  sandboxFailure: ShellSandboxFailure | null;
} | null> {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const timeoutMs = Math.min(10 * 60_000, Math.max(100, options.timeoutMs ?? 60_000));
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
    outputPath: session.outputPath,
    sandbox: session.sandbox,
    sandboxFailure: classifySandboxFailure(session)
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
        spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(session.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5_000 });
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
