import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DATA_DIR } from "../config.ts";
import type { KnowledgeSettingsStore } from "./settings.ts";

export interface KnowledgeSetupState {
  installed: boolean;
  serverPath: string | null;
  uv: boolean;
  uvPath: string | null;
  running: boolean;
  managed: boolean;
  install: {
    status: "idle" | "running" | "succeeded" | "failed";
    log: string;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
  };
  installCommand: string;
  message: string | null;
}

export class KnowledgeSetupError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "KnowledgeSetupError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

interface InstallState {
  status: "idle" | "running" | "succeeded" | "failed";
  log: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  child: ChildProcess | null;
}

const INSTALL_ARGS = ["tool", "install", "--python", "3.13", "openviking[local-embed]", "--upgrade"];
const LOG_LIMIT = 200_000;

export class KnowledgeManagedService {
  private readonly settings: KnowledgeSettingsStore;
  private readonly logDir: string;
  private child: ChildProcess | null = null;
  private managed = false;
  private installState: InstallState = {
    status: "idle",
    log: "",
    startedAt: null,
    finishedAt: null,
    error: null,
    child: null
  };

  constructor(deps: { settings: KnowledgeSettingsStore; logDir?: string }) {
    this.settings = deps.settings;
    this.logDir = deps.logDir ?? join(DATA_DIR, "logs");
    mkdirSync(this.logDir, { recursive: true });
  }

  async status(): Promise<KnowledgeSetupState> {
    const settings = this.settings.get();
    const serverPath = this.resolveCommand(settings.serverCommand);
    const uvPath = this.resolveUv();
    const running = await portOpen(hostOf(settings.baseUrl), portOf(settings.baseUrl), 800);
    let message: string | null = null;
    if (!serverPath) message = "尚未安装 OpenViking";
    else if (!running) message = "已安装，服务未运行";
    else if (!settings.enabled) message = "服务正在运行，但知识库未启用";
    return {
      installed: Boolean(serverPath),
      serverPath,
      uv: Boolean(uvPath),
      uvPath,
      running,
      managed: this.managed && Boolean(this.child),
      install: {
        status: this.installState.status,
        log: this.installState.log,
        startedAt: this.installState.startedAt,
        finishedAt: this.installState.finishedAt,
        error: this.installState.error
      },
      installCommand: `uv ${INSTALL_ARGS.join(" ")}`,
      message
    };
  }

  install(): KnowledgeSetupState["install"] & { started: boolean } {
    if (this.installState.status === "running") {
      return { ...this.publicInstall(), started: false };
    }
    const uvPath = this.resolveUv();
    if (!uvPath) {
      throw new KnowledgeSetupError(
        "UV_NOT_FOUND",
        "没有找到 uv。请先安装 uv（https://docs.astral.sh/uv/），或手动执行安装命令。"
      );
    }
    this.installState = {
      status: "running",
      log: `$ uv ${INSTALL_ARGS.join(" ")}\n`,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      child: null
    };
    const child = spawn(uvPath, INSTALL_ARGS, {
      cwd: homedir(),
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" }
    });
    this.installState.child = child;
    const append = (chunk: Buffer) => {
      this.installState.log = `${this.installState.log}${chunk.toString("utf8")}`.slice(-LOG_LIMIT);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      this.installState.status = "failed";
      this.installState.error = error.message;
      this.installState.finishedAt = new Date().toISOString();
      this.installState.child = null;
    });
    child.on("exit", (code) => {
      this.installState.finishedAt = new Date().toISOString();
      this.installState.child = null;
      if (code === 0) {
        this.installState.status = "succeeded";
      } else {
        this.installState.status = "failed";
        this.installState.error = `安装进程以退出码 ${code ?? "unknown"} 结束`;
      }
    });
    return { ...this.publicInstall(), started: true };
  }

  async ensureStarted(): Promise<void> {
    const settings = this.settings.get();
    if (!settings.manageProcess) return;
    const host = hostOf(settings.baseUrl);
    const port = portOf(settings.baseUrl);
    if (await portOpen(host, port, 800)) return;
    const serverPath = this.resolveCommand(settings.serverCommand);
    if (!serverPath) {
      throw new KnowledgeSetupError("NOT_INSTALLED", "尚未安装 OpenViking，请先在知识库设置里完成安装", 424);
    }
    await this.start(serverPath, settings.serverArgs);
  }

  async start(serverPath = this.resolveCommand(this.settings.get().serverCommand), args = this.settings.get().serverArgs): Promise<void> {
    if (!serverPath) throw new KnowledgeSetupError("NOT_INSTALLED", "尚未安装 OpenViking", 424);
    const settings = this.settings.get();
    const host = hostOf(settings.baseUrl);
    const port = portOf(settings.baseUrl);
    if (await portOpen(host, port, 800)) return;
    const logPath = join(this.logDir, "openviking.log");
    appendFileSync(logPath, `\n[${new Date().toISOString()}] starting ${serverPath} ${args.join(" ")}\n`, "utf8");
    const child = spawn(serverPath, args, {
      cwd: homedir(),
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child;
    this.managed = true;
    const write = (chunk: Buffer) => {
      try {
        appendFileSync(logPath, chunk.toString("utf8"), "utf8");
      } catch {
        // Logging is best effort.
      }
    };
    child.stdout?.on("data", write);
    child.stderr?.on("data", write);
    child.on("exit", () => {
      if (this.child === child) {
        this.child = null;
        this.managed = false;
      }
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await portOpen(host, port, 500)) return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
    throw new KnowledgeSetupError("START_TIMEOUT", "OpenViking 启动超时，请查看 %LOCALAPPDATA%\\Hearth\\logs\\openviking.log 或数据目录 logs/openviking.log", 504);
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.managed = false;
    if (!child?.pid) return;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore shutdown races.
      }
    }
  }

  private publicInstall(): Omit<KnowledgeSetupState["install"], never> {
    return {
      status: this.installState.status,
      log: this.installState.log,
      startedAt: this.installState.startedAt,
      finishedAt: this.installState.finishedAt,
      error: this.installState.error
    };
  }

  private resolveCommand(command: string): string | null {
    const found = which(command);
    if (found) return found;
    const candidate = join(homedir(), ".local", "bin", process.platform === "win32" ? `${command}.exe` : command);
    return existsSync(candidate) ? safeReal(candidate) : null;
  }

  private resolveUv(): string | null {
    const found = which("uv");
    if (found) return found;
    const candidate = join(homedir(), ".local", "bin", process.platform === "win32" ? "uv.exe" : "uv");
    return existsSync(candidate) ? safeReal(candidate) : null;
  }
}

function which(command: string): string | null {
  const tool = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(tool, [command], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  const first = (result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return first ? safeReal(first) : null;
}

function safeReal(path: string): string {
  try {
    return realpathSync.native(resolve(path));
  } catch {
    return resolve(path);
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "127.0.0.1";
  }
}

function portOf(baseUrl: string): number {
  try {
    const parsed = new URL(baseUrl);
    return parsed.port ? Number(parsed.port) : 1933;
  } catch {
    return 1933;
  }
}

export function portOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = connect({ host, port });
    const finish = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveOpen(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}