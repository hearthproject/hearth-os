import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
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

export function spawnServer(launch: ServerLaunch): ChildProcess {
  const child = spawn(launch.command, launch.args, {
    env: { ...process.env, ...launch.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[hearth-server] ${chunk.toString()}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[hearth-server] ${chunk.toString()}`);
  });

  return child;
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
  if (!child || child.killed) return;

  const exited = new Promise<void>((resolvePromise) => {
    child.once("exit", () => resolvePromise());
  });

  child.kill();
  await Promise.race([
    exited,
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, timeoutMs))
  ]);
}

export function defaultServerPaths(root: string): { dataDir: string; webDist: string } {
  return {
    dataDir: join(root, ".hearth"),
    webDist: join(root, "apps", "web", "dist")
  };
}
