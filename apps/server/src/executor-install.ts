import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExecutorId, ExecutorInstallInfo, ExecutorInstallJob } from "@hearth/core";
import { clearExecutorHealthCache, executorHome } from "./executor-runtime.ts";

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_LOG = 8_000;

export interface ExecutorInstallSpec {
  packageName: string;
  version: string;
  hint: string;
  packageSpec: string;
}

export const EXECUTOR_INSTALL_SPECS: Partial<Record<ExecutorId, ExecutorInstallSpec>> = {
  qoder: {
    packageName: "@qoder-ai/qoder-agent-sdk",
    version: "1.0.59",
    hint: "安装官方 Qoder Agent SDK 及其 qodercli；首次使用前请在本机完成 qodercli 登录或配置 PAT。",
    packageSpec: "@qoder-ai/qoder-agent-sdk@1.0.59"
  },
  workbuddy: {
    packageName: "@tencent-ai/codebuddy-code",
    version: "2.181.0",
    hint: "安装 WorkBuddy 同源的腾讯 CodeBuddy CLI，并复用本机 CodeBuddy 登录。",
    packageSpec: "@tencent-ai/codebuddy-code@2.181.0"
  },
  kimi: {
    packageName: "@moonshot-ai/kimi-code",
    version: "2.5.2",
    hint: "安装 Moonshot Kimi Code CLI；Windows 需要 Git Bash，首次使用前请运行 kimi 登录。",
    packageSpec: "@moonshot-ai/kimi-code@2.5.2"
  }
};

export interface InstallRunnerInput {
  command: string;
  args: string[];
  cwd: string;
  onOutput: (chunk: string) => void;
}

export interface InstallRunnerResult {
  code: number | null;
  error: string | null;
}

export type InstallRunner = (input: InstallRunnerInput) => Promise<InstallRunnerResult>;

export class ExecutorInstallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ExecutorInstallError";
  }
}

export class ExecutorInstaller {
  private readonly jobs = new Map<string, ExecutorInstallJob>();

  constructor(private readonly runner: InstallRunner = defaultInstallRunner) {}

  info(id: ExecutorId, settingsPath: string): ExecutorInstallInfo {
    const spec = EXECUTOR_INSTALL_SPECS[id];
    if (!spec) {
      return {
        supported: false,
        packageSpec: null,
        hint: unsupportedHint(id),
        job: this.status(id, settingsPath)
      };
    }
    return {
      supported: true,
      packageSpec: spec.packageSpec,
      hint: spec.hint,
      job: this.status(id, settingsPath)
    };
  }

  status(id: ExecutorId, settingsPath: string): ExecutorInstallJob | null {
    const running = this.jobs.get(jobKey(settingsPath, id));
    if (running) return { ...running };
    return readRecord(id, settingsPath);
  }

  start(id: ExecutorId, settingsPath: string): ExecutorInstallJob {
    const spec = EXECUTOR_INSTALL_SPECS[id];
    if (!spec) throw new ExecutorInstallError("INSTALL_UNSUPPORTED", unsupportedHint(id));
    const key = jobKey(settingsPath, id);
    const active = this.jobs.get(key);
    if (active?.status === "running") return { ...active };

    const home = executorHome(settingsPath, id);
    mkdirSync(home, { recursive: true });
    const job: ExecutorInstallJob = {
      id,
      status: "running",
      packageSpec: spec.packageSpec,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      log: "",
      error: null
    };
    this.jobs.set(key, job);
    writeRecord(settingsPath, id, job);

    const npm = npmInvocation();
    void this.runner({
      command: npm.command,
      args: [
        ...npm.prefixArgs,
        "install",
        "--prefix", home,
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        "--save=false",
        spec.packageSpec
      ],
      cwd: home,
      onOutput: (chunk) => {
        job.log = appendLog(job.log, chunk);
      }
    }).then((result) => {
      job.finishedAt = new Date().toISOString();
      if (result.code === 0) {
        job.status = "succeeded";
        job.log = appendLog(job.log, `\n已安装 ${spec.packageSpec}\n`);
        clearExecutorHealthCache(id);
      } else {
        job.status = "failed";
        job.error = result.error ?? `npm 退出码 ${result.code ?? "未知"}`;
      }
      writeRecord(settingsPath, id, job);
    }).catch((error: unknown) => {
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
      job.error = error instanceof Error ? error.message : String(error);
      writeRecord(settingsPath, id, job);
    });

    return { ...job };
  }
}

function defaultInstallRunner(input: InstallRunnerInput): Promise<InstallRunnerResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const finish = (result: InstallRunnerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        npm_config_yes: "true",
        npm_config_audit: "false",
        npm_config_fund: "false"
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, INSTALL_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => input.onOutput(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => input.onOutput(chunk));
    child.on("error", (error) => finish({ code: null, error: `无法启动 npm：${error.message}` }));
    child.on("close", (code) => {
      finish(timedOut
        ? { code: null, error: "安装超时（15 分钟）" }
        : { code, error: code === 0 ? null : `npm 退出码 ${code ?? "未知"}` });
    });
  });
}

function npmInvocation(): { command: string; prefixArgs: string[] } {
  const cli = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ].find(existsSync);
  if (cli) return { command: process.execPath, prefixArgs: [cli] };
  if (process.platform === "win32") {
    return { command: process.env.ComSpec ?? "cmd.exe", prefixArgs: ["/d", "/s", "/c", "npm"] };
  }
  return { command: "npm", prefixArgs: [] };
}

function unsupportedHint(id: ExecutorId): string {
  if (id === "zcode") {
    return "ZCode 不支持托管安装；请安装 ZCode 桌面端，或在执行器设置中指定 resources/glm/zcode.cjs。";
  }
  if (id === "native" || id === "codex" || id === "hermes") {
    return "该执行器无需托管安装；请使用现有命令或独立安装流程。";
  }
  return "该执行器暂不支持托管安装。";
}

function jobKey(settingsPath: string, id: ExecutorId): string {
  return `${settingsPath}::${id}`;
}

function recordPath(id: ExecutorId, settingsPath: string): string {
  return join(executorHome(settingsPath, id), "install.json");
}

function readRecord(id: ExecutorId, settingsPath: string): ExecutorInstallJob | null {
  try {
    const parsed = JSON.parse(readFileSync(recordPath(id, settingsPath), "utf8")) as Partial<ExecutorInstallJob>;
    if (parsed.id !== id || typeof parsed.status !== "string" || typeof parsed.startedAt !== "string") return null;
    return {
      id,
      status: parsed.status === "succeeded" || parsed.status === "failed" ? parsed.status : "failed",
      packageSpec: typeof parsed.packageSpec === "string" ? parsed.packageSpec : "",
      startedAt: parsed.startedAt,
      finishedAt: typeof parsed.finishedAt === "string" ? parsed.finishedAt : null,
      log: typeof parsed.log === "string" ? parsed.log : "",
      error: typeof parsed.error === "string" ? parsed.error : null
    };
  } catch {
    return null;
  }
}

function writeRecord(settingsPath: string, id: ExecutorId, job: ExecutorInstallJob): void {
  const path = recordPath(id, settingsPath);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(job, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  } catch {
    // Install records are best-effort; the in-memory job remains authoritative.
  }
}

function appendLog(current: string, chunk: string): string {
  const next = `${current}${chunk}`;
  return next.length > MAX_LOG ? next.slice(-MAX_LOG) : next;
}
