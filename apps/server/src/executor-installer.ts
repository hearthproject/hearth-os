import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, delimiter } from "node:path";
import { createRequire } from "node:module";
import type { ExecutorId } from "@hearth/core";

const CODEX_VERSION = "0.166.0";
const DSH_VERSION = "0.2.2-rc.1";
/** Team packages are version-locked to the managed SDK so their plugin ids and
 * config schema always match the composition Hearth launches. */
export const DSH_TEAM_VERSION = DSH_VERSION;
export const DSH_TEAM_PACKAGES = [
  "@deepseek-ai/dsh-experimental-agent-team",
  "@deepseek-ai/dsh-experimental-tool-agent-team"
] as const;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TOTAL_TIMEOUT_MS = 20 * 60_000;
const REGISTRY_PROBE_TIMEOUT_MS = 6_000;
const PROGRESS_INTERVAL_MS = 750;
const CODEX_INSTALL_ESTIMATE_BYTES = 479 * 1024 * 1024;
const DSH_INSTALL_ESTIMATE_BYTES = 505 * 1024 * 1024;
const DSH_TEAM_INSTALL_ESTIMATE_BYTES = 60 * 1024 * 1024;

/**
 * npm registries tried in order. npmjs.org is often unreachable from mainland
 * China, so the domestic mirrors come first and the official registry is the
 * last resort. `HEARTH_EXECUTOR_NPM_REGISTRY` pins a single source for
 * enterprise mirrors or air-gapped tests.
 */
const DEFAULT_NPM_REGISTRIES: NpmRegistry[] = [
  { name: "npmmirror 国内镜像", url: "https://registry.npmmirror.com" },
  { name: "腾讯云镜像", url: "https://mirrors.cloud.tencent.com/npm" },
  { name: "npm 官方源", url: "https://registry.npmjs.org" }
];

interface NpmRegistry {
  name: string;
  url: string;
}

export function executorNpmRegistries(env: NodeJS.ProcessEnv = process.env): NpmRegistry[] {
  const pinned = env.HEARTH_EXECUTOR_NPM_REGISTRY?.trim();
  const candidates = pinned ? [{ name: "自定义源", url: normalizeRegistryUrl(pinned) }] : DEFAULT_NPM_REGISTRIES;
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (!candidate.url || seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });
}

function normalizeRegistryUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

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

function readPackageVersion(packageJsonPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

export interface DshTeamRuntimeStatus {
  available: boolean;
  path: string | null;
  sdkVersion: string | null;
  versions: Record<string, string | null>;
  expectedVersion: string;
}

/**
 * Reports whether the managed DSH runtime has the Team packages pinned to the
 * same version as the SDK. This is a pure disk check: no network, no probe run.
 */
export function dshTeamRuntimeStatus(settingsPath: string): DshTeamRuntimeStatus {
  const home = executorRuntimeDir(settingsPath, "deepseek-harness");
  const sdkPath = managedDshPackage(settingsPath);
  const sdkVersion = sdkPath ? readPackageVersion(sdkPath) : null;
  const versions: Record<string, string | null> = {};
  let allPresent = sdkPath !== null;
  for (const name of DSH_TEAM_PACKAGES) {
    const packageJson = join(home, "node_modules", "@deepseek-ai", name.slice("@deepseek-ai/".length), "package.json");
    const version = existsSync(packageJson) ? readPackageVersion(packageJson) : null;
    versions[name] = version;
    if (version !== DSH_TEAM_VERSION) allPresent = false;
  }
  return {
    available: allPresent && sdkVersion === DSH_TEAM_VERSION,
    path: sdkPath ? home : null,
    sdkVersion,
    versions,
    expectedVersion: DSH_TEAM_VERSION
  };
}

/**
 * Installs the Team packages into the existing DSH runtime prefix. Unlike the
 * initial bootstrap, a failed registry attempt must NOT wipe the prefix: that
 * would delete the already working SDK. `allowReset: false` keeps retries safe.
 */
export async function installDshTeamRuntime(
  settingsPath: string,
  onProgress?: ExecutorInstallProgressHandler
): Promise<ExecutorInstallResult> {
  const existingSdk = findDshPackage(settingsPath);
  if (!existingSdk) {
    throw new Error("请先安装 DeepSeek Harness，再安装团队运行时。");
  }
  const home = executorRuntimeDir(settingsPath, "deepseek-harness");
  mkdirSync(home, { recursive: true });
  const status = dshTeamRuntimeStatus(settingsPath);
  if (status.available) {
    onProgress?.({ phase: "verify", message: "DSH 团队运行时已就绪", percent: 100 });
    return { installed: true, path: home, message: "DSH 团队运行时已安装，无需重复下载。" };
  }
  await installNpmPackages({
    prefix: home,
    packages: DSH_TEAM_PACKAGES.map((name) => `${name}@${DSH_TEAM_VERSION}`),
    label: "DeepSeek Harness Team",
    estimatedBytes: DSH_TEAM_INSTALL_ESTIMATE_BYTES,
    allowReset: false,
    onProgress
  });
  onProgress?.({ phase: "verify", message: "下载完成，正在校验团队包版本", percent: 99 });
  const after = dshTeamRuntimeStatus(settingsPath);
  if (!after.available) {
    const missing = Object.entries(after.versions)
      .filter(([, version]) => version !== DSH_TEAM_VERSION)
      .map(([name, version]) => `${name}=${version ?? "缺失"}`)
      .join("，");
    throw new Error(`DSH 团队运行时安装后校验失败（需要 ${DSH_TEAM_VERSION}）：${missing}`);
  }
  return { installed: true, path: home, message: `DSH 团队运行时已安装（${DSH_TEAM_VERSION}）。` };
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
    await installNpmPackages({
      prefix: home,
      packages: [`@openai/codex@${CODEX_VERSION}`],
      label: "Codex",
      estimatedBytes: CODEX_INSTALL_ESTIMATE_BYTES,
      onProgress
    });
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
  await installNpmPackages({
    prefix: home,
    packages: [`@deepseek-ai/dsh-sdk-client@${DSH_VERSION}`],
    label: "DeepSeek Harness",
    estimatedBytes: DSH_INSTALL_ESTIMATE_BYTES,
    onProgress
  });
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

/**
 * Orders the configured registries by reachability and latency. A blocked
 * registry is moved to the end after a short probe instead of burning a full
 * npm timeout, while offline environments still keep the configured order so
 * npm reports the real network error.
 */
async function rankNpmRegistries(registries: NpmRegistry[]): Promise<NpmRegistry[]> {
  const probes = await Promise.all(
    registries.map(async (registry, index) => {
      const startedAt = Date.now();
      try {
        const response = await fetch(`${registry.url}/-/ping`, {
          signal: AbortSignal.timeout(REGISTRY_PROBE_TIMEOUT_MS),
          headers: { "user-agent": "hearth-executor-installer" }
        });
        await response.body?.cancel();
        return { registry, index, reachable: true, latency: Date.now() - startedAt };
      } catch {
        return { registry, index, reachable: false, latency: Number.POSITIVE_INFINITY };
      }
    })
  );
  return probes
    .sort((a, b) => {
      if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
      return a.latency - b.latency || a.index - b.index;
    })
    .map((probe) => probe.registry);
}

interface NpmInstallOptions {
  prefix: string;
  packages: string[];
  label: string;
  estimatedBytes: number;
  /** Initial bootstrap may restart from a clean prefix; add-on installs must not. */
  allowReset?: boolean;
  onProgress: ExecutorInstallProgressHandler | undefined;
}

async function installNpmPackages(options: NpmInstallOptions): Promise<void> {
  options.onProgress?.({
    phase: "install",
    message: `正在探测 ${options.label} 的下载源`,
    bytes: 0,
    estimatedBytes: options.estimatedBytes,
    percent: 0
  });
  const registries = await rankNpmRegistries(executorNpmRegistries());
  const failures: string[] = [];
  const deadline = Date.now() + INSTALL_TOTAL_TIMEOUT_MS;
  for (let index = 0; index < registries.length; index += 1) {
    const registry = registries[index];
    if (!registry) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    if (index > 0 && options.allowReset !== false) resetInstallPrefix(options.prefix);
    try {
      await runNpmInstallAttempt(options, registry, Math.min(INSTALL_TIMEOUT_MS, remaining));
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${registry.name}（${registry.url}）：${reason}`);
      const next = registries[index + 1];
      if (next) {
        options.onProgress?.({
          phase: "install",
          message: `${registry.name}下载失败，正在改用${next.name}重试`,
          bytes: 0,
          estimatedBytes: options.estimatedBytes,
          percent: 0
        });
      }
    }
  }
  throw new Error(
    `${options.label} 下载失败，已尝试 ${failures.length} 个下载源：${failures.join("；")}。请检查网络，或通过 HEARTH_EXECUTOR_NPM_REGISTRY 指定可用的 npm 镜像。`
  );
}

async function runNpmInstallAttempt(options: NpmInstallOptions, registry: NpmRegistry, timeoutMs: number): Promise<void> {
  const { prefix, packages, label, estimatedBytes, onProgress } = options;
  const args = [
    "install",
    "--prefix", prefix,
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    "--registry", registry.url,
    "--fetch-retries", "2",
    "--fetch-timeout", "120000",
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
        npm_config_loglevel: "error",
        npm_config_registry: registry.url
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
        message: `正在从${registry.name}下载并安装 ${label}（已写入 ${formatBytes(bytes)}）`,
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
      finish(new Error(`从${registry.name}下载超时`));
    }, timeoutMs);
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (code === 0) finish();
      else finish(new Error(`退出码 ${code ?? "未知"}：${output.trim() || "没有安装日志"}`));
    });
  });
}

function resetInstallPrefix(prefix: string): void {
  for (const name of ["node_modules", "package.json", "package-lock.json", ".package-lock.json"]) {
    rmSync(join(prefix, name), { recursive: true, force: true });
  }
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
