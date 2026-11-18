import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";

export type DesktopMode = "dev" | "prod";

export interface ServerLaunchInput {
  mode: DesktopMode;
  root: string;
  dataDir: string;
  webDist: string;
  port?: number;
  execPath?: string;
  resourcesPath?: string;
}

export interface ServerLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  baseUrl: string;
}

export type LogSink = (stream: "stdout" | "stderr", text: string) => void;

export type PortStatus = "free" | "hearth" | "occupied";

export const MAX_RESTARTS = 5;
export const RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export function resolveDesktopRoot(fromDir: string): string {
  return resolve(fromDir, "..", "..", "..");
}

export function buildServerLaunch(input: ServerLaunchInput): ServerLaunch {
  const port = input.port ?? 4317;
  const execPath = input.execPath ?? process.execPath;
  const serverEntry = join(input.root, "apps", "server", "src", "index.ts");
  const tsxCli = join(input.root, "node_modules", "tsx", "dist", "cli.mjs");

  if (input.mode === "dev" && !existsSync(tsxCli)) {
    throw new Error(`找不到 tsx：${tsxCli}。请先在仓库根运行 npm install。`);
  }

  const args = input.mode === "dev"
    ? [tsxCli, serverEntry]
    : [join(input.resourcesPath ?? "", "server", "server.mjs")];

  if (input.mode === "prod" && !input.resourcesPath) {
    throw new Error("生产模式缺少 resourcesPath，无法定位 server.mjs。");
  }

  return {
    command: execPath,
    args,
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      HEARTH_ROOT: input.root,
      HEARTH_DATA_DIR: input.dataDir,
      HEARTH_WEB_DIST: input.webDist,
      HEARTH_PORT: String(port),
      HEARTH_DESKTOP: "1"
    },
    baseUrl: `http://127.0.0.1:${port}`
  };
}

export function spawnServer(launch: ServerLaunch, onLog?: LogSink): ChildProcess {
  const child = spawn(launch.command, launch.args, {
    env: { ...process.env, ...launch.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  const write = onLog ?? ((stream: "stdout" | "stderr", text: string) => {
    const target = stream === "stdout" ? process.stdout : process.stderr;
    target.write(`[hearth-server] ${text}`);
  });

  child.stdout?.on("data", (chunk: Buffer) => write("stdout", chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => write("stderr", chunk.toString()));
  child.once("error", (error: Error) => write("stderr", `spawn failed: ${error.message}\n`));

  return child;
}

export function restartDelay(attempt: number): number | null {
  return RESTART_DELAYS_MS[attempt] ?? null;
}

export function probePort(port: number, host = "127.0.0.1", timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(open);
    };

    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function portStatus(baseUrl: string, port: number, host = "127.0.0.1"): Promise<PortStatus> {
  if (!(await probePort(port, host))) return "free";

  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(2_000)
    });
    if (!response.ok) return "occupied";
    const body = (await response.json()) as { name?: unknown };
    return body.name === "Hearth" ? "hearth" : "occupied";
  } catch {
    return "occupied";
  }
}

export async function waitForHealth(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: string = "尚未收到响应";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(1_500)
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }

  throw new Error(`Hearth 服务端在 ${timeoutMs}ms 内没有就绪：${lastError}`);
}

export async function stopServer(child: ChildProcess | null, timeoutMs = 5_000): Promise<void> {
  if (!child || child.exitCode !== null) return;

  const exited = new Promise<void>((resolvePromise) => {
    child.once("exit", () => resolvePromise());
  });

  const pid = child.pid;
  if (pid && process.platform === "win32") {
    await new Promise<void>((resolvePromise) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.once("exit", () => resolvePromise());
      killer.once("error", () => resolvePromise());
    });
  } else {
    child.kill();
  }

  await Promise.race([
    exited,
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, timeoutMs))
  ]);

  if (child.exitCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export interface ServerSupervisorOptions {
  launch: ServerLaunch;
  onLog?: LogSink;
  onFatal?: (message: string) => void;
  onRestart?: (attempt: number, delayMs: number) => void;
}

export class ServerSupervisor {
  private child: ChildProcess | null = null;
  private stopping = false;
  private restartAttempt = 0;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: ServerSupervisorOptions) {}

  get process(): ChildProcess | null {
    return this.child;
  }

  async start(): Promise<void> {
    const status = await portStatus(this.options.launch.baseUrl, this.port());
    if (status === "hearth") {
      throw new Error("另一个 Hearth 正在运行，请先关闭它，或从托盘退出旧实例。");
    }
    if (status === "occupied") {
      throw new Error("端口 4317 被占用，请关闭占用该端口的程序后重试。");
    }

    this.spawn();
    await waitForHealth(this.options.launch.baseUrl);
    this.restartAttempt = 0;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    await stopServer(this.child);
    this.child = null;
  }

  private port(): number {
    const url = new URL(this.options.launch.baseUrl);
    return Number(url.port);
  }

  private spawn(): void {
    const child = spawnServer(this.options.launch, this.options.onLog);
    this.child = child;
    child.once("exit", (code, signal) => this.handleExit(child, code, signal));
  }

  private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = null;
    if (this.stopping) return;

    this.options.onLog?.("stderr", `server exited code=${code ?? "null"} signal=${signal ?? "null"}\n`);
    this.scheduleRestart();
  }

  private async restart(): Promise<void> {
    if (this.stopping) return;

    try {
      this.spawn();
      await waitForHealth(this.options.launch.baseUrl);
      this.restartAttempt = 0;
    } catch (error) {
      this.options.onLog?.("stderr", `restart failed: ${error instanceof Error ? error.message : String(error)}\n`);
      const child = this.child;
      this.child = null;
      if (child) {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
      }
      this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    const delay = restartDelay(this.restartAttempt);
    this.restartAttempt += 1;
    if (delay === null) {
      this.options.onFatal?.(`Hearth 服务端连续退出 ${MAX_RESTARTS} 次，已停止重启。请查看日志。`);
      return;
    }

    this.options.onRestart?.(this.restartAttempt, delay);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.restart();
    }, delay);
    this.restartTimer.unref?.();
  }
}

export function defaultServerPaths(root: string): { dataDir: string; webDist: string } {
  return {
    dataDir: join(root, ".hearth"),
    webDist: join(root, "apps", "web", "dist")
  };
}
