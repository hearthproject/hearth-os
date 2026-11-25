import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, delimiter } from "node:path";
import { createRequire } from "node:module";
import type { ExecutorId } from "@hearth/core";

const CODEX_VERSION = "0.166.0";
const DSH_VERSION = "0.2.2-rc.1";
const INSTALL_TIMEOUT_MS = 20 * 60_000;
const PROGRESS_INTERVAL_MS = 750;
const CODEX_INSTALL_ESTIMATE_BYTES = 479 * 1024 * 1024;
const DSH_INSTALL_ESTIMATE_BYTES = 505 * 1024 * 1024;

export type ExecutorInstallPhase = "install" | "verify" | "bind" | "probe";

export interface ExecutorInstallProgress {
  phase: ExecutorInstallPhase;
  message: string;
  bytes?: number;
  estimatedBytes?: number;
  percent?: number;
}

export type ExecutorInstallProgressHandler = (progress: ExecutorInstallProgress) => void;

export interface ExecutorInstallResult {
  installed: boolean;
  path: string | null;
  message: string;
}

export function executorRuntimeDir(settingsPath: string, id: "codex" | "deepseek-harness"): string {
  return join(dirname(settingsPath), "executors", id, "runtime");
}

export function managedCodexBinary(settingsPath: string): string | null {
  const home = executorRuntimeDir(settingsPath, "codex");
  const candidates = [
    join(home, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
    join(home, "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function managedDshPackage(settingsPath: string): string | null {
  const home = executorRuntimeDir(settingsPath, "deepseek-harness");
  const path = join(home, "node_modules", "@deepseek-ai", "dsh-sdk-client", "package.json");
  return existsSync(path) ? path : null;
}

export function findDshPackage(settingsPath?: string | null): string | null {
  if (settingsPath) {
    const managed = managedDshPackage(settingsPath);
    if (managed) return managed;
  }
  try {
    const require = createRequire(import.meta.url);
    return require.resolve("@deepseek-ai/dsh-sdk-client/package.json");
  } catch {
    return null;
  }
}

export function findCodexBinary(settingsPath: string, executablePath?: string | null): string | null {
  const explicit = executablePath?.trim() || process.env.HEARTH_CODEX_PATH?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const managed = managedCodexBinary(settingsPath);
  if (managed) return managed;
  for (const candidate of bundledCodexBinaries()) {
    if (existsSync(candidate)) return candidate;
  }
  const pathDirs = (process.env.PATH ?? "").split(delimiter);
  for (const dir of pathDirs) {
    const direct = join(dir, "codex.exe");
    if (existsSync(direct)) return direct;
    const adjacent = join(dir, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    if (existsSync(adjacent)) return adjacent;
    const nested = join(dir, "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    if (existsSync(nested)) return nested;
  }
  return null;
}

export async function installExecutorRuntime(
  id: ExecutorId,
  settingsPath: string,
  onProgress?: ExecutorInstallProgressHandler
): Promise<ExecutorInstallResult> {
  if (id === "native") {
    onProgress?.({ phase: "verify", message: "原生执行器已内置可用", percent: 100 });
    return { installed: true, path: null, message: "原生执行器内置可用，无需安装。" };
  }
  if (id === "codex") {
    const existing = findCodexBinary(settingsPath);
    if (existing) {
      onProgress?.({ phase: "verify", message: "已检测到本机 Codex，正在验证入口", percent: 100 });
      return { installed: true, path: existing, message: "Codex 已在本机可用，无需重复下载。" };
    }
    const home = executorRuntimeDir(settingsPath, "codex");
    mkdirSync(home, { recursive: true });
    await runNpmInstall(home, [`@openai/codex@${CODEX_VERSION}`], "Codex", CODEX_INSTALL_ESTIMATE_BYTES, onProgress);
    onProgress?.({ phase: "verify", message: "下载完成，正在验证 Codex 运行程序", percent: 99 });
    const binary = managedCodexBinary(settingsPath);
    if (!binary) throw new Error("Codex 安装完成，但没有找到 Windows 运行程序。");
    return { installed: true, path: binary, message: "Codex 已下载并安装到 Hearth 的托管目录。" };
  }
  const existing = findDshPackage(settingsPath);
  if (existing) {
    onProgress?.({ phase: "verify", message: "已检测到本机 DeepSeek Harness，正在验证 SDK", percent: 100 });
    return { installed: true, path: existing, message: "DeepSeek Harness 已在本机可用，无需重复下载。" };
  }
  const home = executorRuntimeDir(settingsPath, "deepseek-harness");
  mkdirSync(home, { recursive: true });
  await runNpmInstall(home, [`@deepseek-ai/dsh-sdk-client@${DSH_VERSION}`], "DeepSeek Harness", DSH_INSTALL_ESTIMATE_BYTES, onProgress);
  onProgress?.({ phase: "verify", message: "下载完成，正在验证 DeepSeek Harness SDK", percent: 99 });
  const packagePath = managedDshPackage(settingsPath);
  if (!packagePath) throw new Error("DeepSeek Harness 安装完成，但没有找到 SDK 包。");
  return { installed: true, path: packagePath, message: "DeepSeek Harness 已下载并安装到 Hearth 的托管目录。" };
}

function bundledCodexBinaries(): string[] {
  try {
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve("@openai/codex/package.json");
    const packageRoot = dirname(packagePath);
    return [
      join(packageRoot, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
      join(dirname(packageRoot), "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe")
    ];
  } catch {
    return [];
  }
}

async function runNpmInstall(
  prefix: string,
  packages: string[],
  label: string,
  estimatedBytes: number,
  onProgress?: ExecutorInstallProgressHandler
): Promise<void> {
  const args = [
    "install",
    "--prefix", prefix,
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    ...packages
  ];
  const bundledNpm = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const command = existsSync(bundledNpm) ? process.execPath : (process.env.ComSpec ?? "cmd.exe");
  const commandArgs = existsSync(bundledNpm)
    ? [bundledNpm, ...args]
    : ["/d", "/s", "/c", `npm ${args.map(quoteWindowsArg).join(" ")}`];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_loglevel: "error"
      }
    });
    let output = "";
    let settled = false;
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-4000);
    };
    const reportProgress = () => {
      const bytes = directorySize(prefix);
      onProgress?.({
        phase: "install",
        message: `正在下载并安装 ${label}（已写入 ${formatBytes(bytes)}）`,
        bytes,
        estimatedBytes,
        percent: Math.max(0, Math.min(95, Math.round((bytes / estimatedBytes) * 100)))
      });
    };
    const finish = (failure?: Error) => {
      if (settled) return;
      settled = true;
      if (progressTimer) clearInterval(progressTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (failure) reject(failure);
      else resolve();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    reportProgress();
    progressTimer = setInterval(reportProgress, PROGRESS_INTERVAL_MS);
    timeoutTimer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("执行器安装超时，请检查网络后重试。"));
    }, INSTALL_TIMEOUT_MS);
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (code === 0) finish();
      else finish(new Error(`执行器安装失败（退出码 ${code ?? "未知"}）：${output.trim() || "没有安装日志"}`));
    });
  });
}

function directorySize(root: string): number {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        try {
          total += statSync(path).size;
        } catch {
          // Files can disappear while npm replaces an existing dependency tree.
        }
      }
    }
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0)} MB`;
}

function quoteWindowsArg(value: string): string {
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
