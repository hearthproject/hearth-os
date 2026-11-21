import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { detectShell, type ShellSpec } from "./environment.ts";
import { type BackgroundTaskRecord, type BackgroundTaskRegistry, type BackgroundTaskStatus } from "./background-tasks.ts";
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
  pty: boolean;
  sandbox: ShellSandboxRun | null;
  backgroundTasks?: BackgroundTaskRegistry;
  onExit?: ((info: { sessionId: string; exitCode: number | null }) => void) | undefined;
  exitNotified?: boolean;
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
  aborted: boolean;
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
  pty?: { cols?: number; rows?: number };
  backgroundTasks?: BackgroundTaskRegistry;
  taskId?: string;
  runId?: string;
  sandbox?: ShellSandboxOptions;
  unsafeNoSandbox?: boolean;
  signal?: AbortSignal;
  onExit?: ((info: { sessionId: string; exitCode: number | null }) => void) | undefined;
  onStarted?: ((info: { sessionId: string; command: string }) => void) | undefined;
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
  const pty = options.pty
    ? {
        cols: Math.min(400, Math.max(20, Math.trunc(options.pty.cols ?? 120))),
        rows: Math.min(200, Math.max(5, Math.trunc(options.pty.rows ?? 30)))
      }
    : null;
  if (pty && !options.sandbox) {
    throw new SandboxUnavailableError("PTY shell 必须通过 Windows AppContainer helper 启动；不能直接 spawn");
  }

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
      ...(pty ? { pty } : {}),
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
    pty: pty !== null,
    sandbox,
    ...(options.backgroundTasks ? { backgroundTasks: options.backgroundTasks } : {}),
    ...(options.onExit ? { onExit: options.onExit } : {})
  };
  sessions.set(id, session);
  options.onStarted?.({ sessionId: id, command: options.command });
  try {
    writeFileSync(outputPath, `$ ${redactSecrets(options.command)}\n`, "utf8");
  } catch {
    // The in-memory buffer still works when the log cannot be created.
  }
  try {
    const now = new Date(session.startedAt).toISOString();
    options.backgroundTasks?.start({
      sessionId: id,
      taskId: options.taskId ?? null,
      runId: options.runId ?? null,
      pid: child.pid ?? null,
      startTime: now,
      command: options.command,
      outputPath,
      pty: pty !== null,
      status: "running",
      exitCode: null,
      createdAt: now,
      updatedAt: now
    });
  } catch {
    // A registry write failure must not prevent the shell from running.
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
    finishBackgroundTask(session, "exited");
    notifyExit(session);
  });
  child.on("exit", (code) => {
    session.running = false;
    session.exitCode = code;
    finishBackgroundTask(session, "exited");
    notifyExit(session);
  });
  if (options.stdin !== undefined) {
    child.stdin.write(options.stdin);
    if (!pty) child.stdin.end();
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
  pty?: { cols?: number; rows?: number };
  backgroundTasks?: BackgroundTaskRegistry;
  taskId?: string;
  runId?: string;
  sandbox?: ShellSandboxOptions;
  unsafeNoSandbox?: boolean;
  signal?: AbortSignal;
}): Promise<ShellRunResult> {
  const started = await startShellSession(options);
  const session = sessions.get(started.sessionId)!;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    killShellSession(started.sessionId);
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (session.running && Date.now() < deadline) {
      await delay(Math.min(200, Math.max(1, deadline - Date.now())));
      if (options.timeoutMs === 0) break;
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
  return {
    sessionId: session.id,
    output: session.output,
    exitCode: session.exitCode,
    running: session.running,
    durationMs: Date.now() - session.startedAt,
    outputPath: session.outputPath,
    sandbox: session.sandbox,
    sandboxFailure: classifySandboxFailure(session),
    aborted
  };
}

function notifyExit(session: ShellSession): void {
  if (session.exitNotified) return;
  session.exitNotified = true;
  session.onExit?.({ sessionId: session.id, exitCode: session.exitCode });
}

function finishBackgroundTask(session: ShellSession, status: Exclude<BackgroundTaskStatus, "running">): void {
  try {
    session.backgroundTasks?.finish(session.id, session.exitCode, status);
  } catch {
    // The shell lifecycle continues even if the durable record cannot update.
  }
}

function classifySandboxFailure(session: ShellSession): ShellSandboxFailure | null {
  if (!session.sandbox || session.exitCode === null) return null;
  if (runnerFailed(session.output, session.exitCode, session.sandbox.runnerFailureRules)) return "runner_failure";
  if (session.sandbox.denialSignatures.some((signature) => session.output.includes(signature))) return "denied";
  return null;
}

export function shellOutput(sessionId: string, offset = 0, backgroundTasks?: BackgroundTaskRegistry): { output: string; running: boolean; exitCode: number | null; outputPath: string | null; status?: BackgroundTaskStatus } | null {
  const session = sessions.get(sessionId);
  if (!session) {
    const record = backgroundTasks?.get(sessionId);
    if (!record) return null;
    const text = readBackgroundOutput(record.outputPath);
    const safeOffset = Math.max(0, Math.min(offset, text.length));
    return {
      output: text.slice(safeOffset),
      running: false,
      exitCode: record.exitCode,
      outputPath: record.outputPath,
      status: record.status
    };
  }
  const safeOffset = Math.max(0, Math.min(offset, session.output.length));
  return { output: session.output.slice(safeOffset), running: session.running, exitCode: session.exitCode, outputPath: session.outputPath };
}

export function shellSessionInfo(sessionId: string, backgroundTasks?: BackgroundTaskRegistry): { running: boolean; exitCode: number | null; command: string; outputPath: string; pty: boolean; sandbox: ShellSandboxRun | null; status?: BackgroundTaskStatus } | null {
  const session = sessions.get(sessionId);
  if (!session) {
    const record = backgroundTasks?.get(sessionId);
    if (!record) return null;
    return {
      running: false,
      exitCode: record.exitCode,
      command: record.command,
      outputPath: record.outputPath,
      pty: record.pty,
      sandbox: null,
      status: record.status
    };
  }
  return { running: session.running, exitCode: session.exitCode, command: session.command, outputPath: session.outputPath, pty: session.pty, sandbox: session.sandbox };
}

/** Write raw bytes to the session's stdin. For PTY sessions this types into the console. */
export function writeShellInput(sessionId: string, data: string): { sessionId: string; written: number; running: boolean; pty: boolean } | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (!session.running) return { sessionId, written: 0, running: false, pty: session.pty };
  try {
    session.child.stdin.write(data);
    return { sessionId, written: data.length, running: session.running, pty: session.pty };
  } catch {
    return { sessionId, written: 0, running: session.running, pty: session.pty };
  }
}

/** Resize a PTY session; plain-pipe sessions ignore this. */
export function resizeShellSession(sessionId: string, cols: number, rows: number): { sessionId: string; cols: number; rows: number; pty: boolean } | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const safeCols = Math.min(400, Math.max(20, Math.trunc(cols)));
  const safeRows = Math.min(200, Math.max(5, Math.trunc(rows)));
  if (session.pty && session.running) {
    try {
      session.child.stdin.write(`\u001bHEARTH_RESIZE:${safeCols},${safeRows}\n`);
    } catch {
      // The session is already gone; callers can observe running=false.
    }
  }
  return { sessionId, cols: safeCols, rows: safeRows, pty: session.pty };
}

export async function waitShellSession(sessionId: string, options: { timeoutMs?: number; match?: string } = {}, backgroundTasks?: BackgroundTaskRegistry): Promise<{
  sessionId: string;
  output: string;
  running: boolean;
  exitCode: number | null;
  matched: boolean;
  timedOut: boolean;
  outputPath: string;
  sandbox: ShellSandboxRun | null;
  sandboxFailure: ShellSandboxFailure | null;
  status?: BackgroundTaskStatus;
} | null> {
  const session = sessions.get(sessionId);
  if (!session) {
    const record = backgroundTasks?.get(sessionId);
    if (!record) return null;
    const output = readBackgroundOutput(record.outputPath);
    const matcher = options.match ? compileMatcher(options.match) : null;
    return {
      sessionId,
      output: output.slice(-8_000),
      running: false,
      exitCode: record.exitCode,
      matched: matcher ? matcher.test(output) : false,
      timedOut: false,
      outputPath: record.outputPath,
      sandbox: null,
      sandboxFailure: null,
      status: record.status
    };
  }
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

export function killShellSession(sessionId: string, backgroundTasks?: BackgroundTaskRegistry): boolean {
  const session = sessions.get(sessionId);
  if (!session) {
    const record = backgroundTasks?.get(sessionId);
    return Boolean(record && record.status !== "running");
  }
  if (!session.running) return true;
  session.running = false;
  session.exitCode = null;
  try {
    if (process.platform === "win32") {
      if (session.child.pid) {
        killWindowsProcessTree(session.child.pid);
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
  finishBackgroundTask(session, "killed");
  notifyExit(session);
  return true;
}

/**
 * taskkill /T can fail with "operation not supported" for a child that was
 * created in the same instant as the parent kill. Enumerate the live tree
 * first, then kill children bottom-up so a just-spawned grandchild cannot
 * survive as an orphan.
 */
export function killWindowsProcessTree(pid: number): void {
  const script = [
    "$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId;",
    "$children = @{};",
    "foreach ($row in $all) {",
    "  $parent = [int]$row.ParentProcessId;",
    "  if (-not $children.ContainsKey($parent)) { $children[$parent] = @() }",
    "  $children[$parent] += [int]$row.ProcessId;",
    "}",
    "function Kill-Tree([int]$p) {",
    "  if ($children.ContainsKey($p)) { foreach ($child in $children[$p]) { Kill-Tree $child } }",
    "  Stop-Process -Id $p -Force -ErrorAction SilentlyContinue;",
    "}",
    `Kill-Tree ${pid};`
  ].join("\n");
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    stdio: "ignore",
    timeout: 5_000
  });
  try {
    spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 5_000
    });
  } catch {
    // Best effort; the child.kill below is the last resort.
  }
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

function readBackgroundOutput(path: string): string {
  try {
    const text = redactSecrets(stripAnsi(readFileSync(path, "utf8")));
    return text.length > MAX_BUFFER ? text.slice(-MAX_BUFFER) : text;
  } catch {
    return "";
  }
}

process.once("exit", cleanupShellSessions);
