import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadCodexProfile } from "@hearth/codex-executor";
import type {
  ExecutorHealth,
  ExecutorId,
  ExecutorProbeResult,
  ExecutorRuntimeSettings,
  ExecutorSettings
} from "@hearth/core";
import { hermesHealth } from "./hermes-health.ts";

const HEALTH_TTL_MS = 30_000;
const VERSION_TIMEOUT_MS = 6_000;

export type ExecutorLaunchKind = "builtin" | "command" | "node-script" | "qoder-sdk";
export type ExecutorLaunchSource = "builtin" | "configured" | "managed" | "detected" | "path";

export interface ExecutorLaunch {
  id: ExecutorId;
  kind: ExecutorLaunchKind;
  command: string;
  args: string[];
  env: Record<string, string>;
  source: ExecutorLaunchSource;
  script: string | null;
  display: string;
}

interface NodeCliSpec {
  packageName: string;
  entry: string;
  command: string;
}

interface VersionCheck {
  ok: boolean;
  version: string | null;
  error: string | null;
}

interface CacheEntry {
  at: number;
  value: ExecutorHealth;
}

const NODE_CLI_SPECS: Partial<Record<ExecutorId, NodeCliSpec>> = {
  workbuddy: {
    packageName: "@tencent-ai/codebuddy-code",
    entry: "bin/codebuddy",
    command: "codebuddy"
  },
  kimi: {
    packageName: "@moonshot-ai/kimi-code",
    entry: "dist/main.mjs",
    command: "kimi"
  }
};

const healthCache = new Map<string, CacheEntry>();

export function executorHome(settingsPath: string, id: ExecutorId): string {
  return join(dirname(settingsPath), "executors", id);
}

export function executorRuntimeSettings(settings: ExecutorSettings, id: ExecutorId): ExecutorRuntimeSettings {
  return settings.executors[id] ?? {};
}

export function resolveExecutorLaunch(
  id: ExecutorId,
  settings: ExecutorSettings,
  settingsPath: string
): ExecutorLaunch | null {
  if (id === "native" || id === "codex") {
    return {
      id,
      kind: "builtin",
      command: id,
      args: [],
      env: {},
      source: "builtin",
      script: null,
      display: id === "native" ? "Hearth 原生运行时" : "Codex CLI"
    };
  }

  const runtime = executorRuntimeSettings(settings, id);
  if (id === "hermes") {
    const command = runtime.command?.trim() || settings.hermesCommand || "hermes";
    return {
      id,
      kind: "command",
      command,
      args: [],
      env: {},
      source: runtime.command ? "configured" : "path",
      script: null,
      display: command
    };
  }
  if (id === "qoder") return resolveQoderLaunch(settingsPath, runtime);
  if (id === "zcode") return resolveZcodeLaunch(settingsPath, runtime);
  const spec = NODE_CLI_SPECS[id];
  return spec ? resolveNodeCliLaunch(id, settingsPath, runtime, spec) : null;
}

export function executorHealth(
  id: ExecutorId,
  settings: ExecutorSettings,
  settingsPath: string,
  maxAgeMs = HEALTH_TTL_MS
): ExecutorHealth {
  const key = cacheKey(settingsPath, id);
  const cached = healthCache.get(key);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.value;
  const value = computeHealthSync(id, settings, settingsPath);
  healthCache.set(key, { at: Date.now(), value });
  return value;
}

export async function probeExecutor(
  id: ExecutorId,
  settings: ExecutorSettings,
  settingsPath: string,
  timeoutMs = VERSION_TIMEOUT_MS
): Promise<ExecutorProbeResult> {
  const started = Date.now();
  const health = await computeHealthAsync(id, settings, settingsPath, timeoutMs);
  healthCache.set(cacheKey(settingsPath, id), { at: Date.now(), value: health });
  return {
    id,
    ok: health.canRun,
    command: health.command,
    version: health.version,
    error: health.issues.length > 0 ? health.issues.join("；") : null,
    elapsedMs: Date.now() - started,
    health
  };
}

export function clearExecutorHealthCache(id?: ExecutorId): void {
  if (!id) {
    healthCache.clear();
    return;
  }
  const suffix = `::${id}`;
  for (const key of [...healthCache.keys()]) {
    if (key.endsWith(suffix)) healthCache.delete(key);
  }
}

function computeHealthSync(id: ExecutorId, settings: ExecutorSettings, settingsPath: string): ExecutorHealth {
  if (id === "native") {
    return { id, canRun: true, command: "native", version: "builtin", issues: [], installState: "available" };
  }
  if (id === "codex") {
    const profile = loadCodexProfile();
    return {
      id,
      canRun: profile.canRun,
      command: "codex",
      version: null,
      issues: profile.issues,
      installState: profile.canRun ? "available" : "needs_repair"
    };
  }
  if (id === "hermes") {
    const command = executorRuntimeSettings(settings, id).command?.trim() || settings.hermesCommand || "hermes";
    const health = hermesHealth(command);
    return {
      id,
      canRun: health.canRun,
      command: health.command,
      version: health.version,
      issues: health.issues,
      installState: health.canRun ? "available" : "missing"
    };
  }

  const launch = resolveExecutorLaunch(id, settings, settingsPath);
  if (!launch) return missingHealth(id);
  if (id === "qoder") return qoderHealth(launch, executorRuntimeSettings(settings, id));
  return genericLaunchHealth(id, launch, checkVersionSync(launch));
}

async function computeHealthAsync(
  id: ExecutorId,
  settings: ExecutorSettings,
  settingsPath: string,
  timeoutMs: number
): Promise<ExecutorHealth> {
  if (id === "native" || id === "codex" || id === "hermes") return computeHealthSync(id, settings, settingsPath);
  const launch = resolveExecutorLaunch(id, settings, settingsPath);
  if (!launch) return missingHealth(id);
  if (id === "qoder") return qoderHealth(launch, executorRuntimeSettings(settings, id));
  return genericLaunchHealth(id, launch, await checkVersionAsync(launch, timeoutMs));
}

function resolveNodeCliLaunch(
  id: ExecutorId,
  settingsPath: string,
  runtime: ExecutorRuntimeSettings,
  spec: NodeCliSpec
): ExecutorLaunch | null {
  const configuredPath = runtime.executablePath?.trim();
  if (configuredPath && existsSync(configuredPath)) {
    if (isScriptPath(configuredPath)) return scriptLaunch(id, configuredPath, "configured", {});
    return commandLaunch(id, configuredPath, "configured");
  }

  const configuredCommand = runtime.command?.trim();
  if (configuredCommand) {
    const resolved = resolveConfiguredCommand(id, configuredCommand, spec);
    if (resolved) return resolved;
  }

  const managed = join(executorHome(settingsPath, id), "node_modules", spec.packageName, spec.entry);
  if (existsSync(managed)) return scriptLaunch(id, managed, "managed", {});

  if (detectGlobalInstallations()) {
    for (const root of globalNodeModuleRoots()) {
      const candidate = join(root, spec.packageName, spec.entry);
      if (existsSync(candidate)) return scriptLaunch(id, candidate, "detected", {});
    }
    const shim = findOnPath(spec.command);
    if (shim) {
      const siblingRoot = join(dirname(shim), "node_modules", spec.packageName, spec.entry);
      if (existsSync(siblingRoot)) return scriptLaunch(id, siblingRoot, "path", {});
      if (!isShellShim(shim)) return commandLaunch(id, shim, "path");
    }
  }
  return null;
}

function resolveConfiguredCommand(id: ExecutorId, command: string, spec: NodeCliSpec): ExecutorLaunch | null {
  if (isScriptPath(command) && existsSync(command)) return scriptLaunch(id, command, "configured", {});
  const onPath = findOnPath(command) ?? (existsSync(command) ? command : null);
  if (!onPath) return commandLaunch(id, command, "configured");
  if (isShellShim(onPath)) {
    const siblingRoot = join(dirname(onPath), "node_modules", spec.packageName, spec.entry);
    if (existsSync(siblingRoot)) return scriptLaunch(id, siblingRoot, "configured", {});
    return null;
  }
  return commandLaunch(id, onPath, "configured");
}

function resolveQoderLaunch(settingsPath: string, runtime: ExecutorRuntimeSettings): ExecutorLaunch | null {
  let sdk: string | null = null;
  let source: ExecutorLaunchSource = "managed";
  const configuredPath = runtime.executablePath?.trim();
  if (configuredPath && existsSync(configuredPath) && isScriptPath(configuredPath)) {
    sdk = configuredPath;
    source = "configured";
  }
  if (!sdk) {
    const managed = join(
      executorHome(settingsPath, "qoder"),
      "node_modules",
      "@qoder-ai",
      "qoder-agent-sdk",
      "dist",
      "index.js"
    );
    if (existsSync(managed)) sdk = managed;
  }
  if (!sdk && detectGlobalInstallations()) {
    for (const root of globalNodeModuleRoots()) {
      const candidate = join(root, "@qoder-ai", "qoder-agent-sdk", "dist", "index.js");
      if (existsSync(candidate)) {
        sdk = candidate;
        source = "detected";
        break;
      }
    }
  }
  if (!sdk) return null;

  const cli = runtime.command?.trim()
    || process.env.QODERCLI_PATH?.trim()
    || findQoderCli()
    || (configuredPath && !isScriptPath(configuredPath) && existsSync(configuredPath) ? configuredPath : null);
  return {
    id: "qoder",
    kind: "qoder-sdk",
    command: cli ?? "",
    args: [],
    env: cli ? { QODERCLI_PATH: cli } : {},
    source,
    script: sdk,
    display: cli ? `qodercli ${cli}` : `SDK ${sdk}`
  };
}

function resolveZcodeLaunch(settingsPath: string, runtime: ExecutorRuntimeSettings): ExecutorLaunch | null {
  let script: string | null = null;
  let source: ExecutorLaunchSource = "detected";
  let electron = runtime.command?.trim() || null;
  const configuredPath = runtime.executablePath?.trim();
  if (configuredPath && existsSync(configuredPath)) {
    if (isScriptPath(configuredPath)) {
      script = configuredPath;
      source = "configured";
    } else {
      electron = electron ?? configuredPath;
    }
  }
  if (!script) {
    const managed = join(executorHome(settingsPath, "zcode"), "zcode.cjs");
    if (existsSync(managed)) {
      script = managed;
      source = "managed";
    }
  }
  if (!script && detectGlobalInstallations()) script = detectZcodeScript();
  if (!script) {
    if (electron) return commandLaunch("zcode", electron, "configured");
    return null;
  }
  const command = electron ?? findZcodeElectron(script);
  if (!command) return null;
  return scriptLaunch("zcode", script, source, { ELECTRON_RUN_AS_NODE: "1" }, command);
}

function scriptLaunch(
  id: ExecutorId,
  script: string,
  source: ExecutorLaunchSource,
  env: Record<string, string>,
  command = process.execPath
): ExecutorLaunch {
  return {
    id,
    kind: "node-script",
    command,
    args: [script],
    env,
    source,
    script,
    display: id === "zcode" ? `${command} ${script}` : script
  };
}

function commandLaunch(id: ExecutorId, command: string, source: ExecutorLaunchSource): ExecutorLaunch {
  return {
    id,
    kind: "command",
    command,
    args: [],
    env: {},
    source,
    script: null,
    display: command
  };
}

function genericLaunchHealth(id: ExecutorId, launch: ExecutorLaunch, check: VersionCheck): ExecutorHealth {
  return {
    id,
    canRun: check.ok,
    command: launch.display,
    version: check.version,
    issues: check.ok ? [] : [check.error ?? "无法启动执行器"],
    experimental: id === "zcode",
    installState: check.ok ? "available" : "needs_repair"
  };
}

function qoderHealth(launch: ExecutorLaunch, runtime: ExecutorRuntimeSettings): ExecutorHealth {
  const issues: string[] = [];
  const sdkVersion = launch.script ? packageVersion(join(dirname(launch.script), "..", "package.json")) : null;
  let cliVersion: string | null = null;
  if (launch.command) {
    const check = checkVersionSync(launch);
    if (check.ok) cliVersion = check.version;
    else issues.push(check.error ?? "无法运行 qodercli --version");
  } else if (!launch.script || !existsSync(join(dirname(launch.script), "..", "_bundled"))) {
    issues.push("未找到 qodercli；请安装 Qoder SDK 内置 CLI、把 qodercli 加入 PATH，或在设置中填写命令路径。");
  }
  if (!qoderAuthConfigured(runtime)) {
    issues.push("未检测到 Qoder 登录状态；请先运行 qodercli 登录，或配置 PAT。");
  }
  const versionParts = [sdkVersion ? `sdk ${sdkVersion}` : null, cliVersion ? `cli ${cliVersion}` : null].filter(Boolean);
  return {
    id: "qoder",
    canRun: issues.length === 0,
    command: launch.display,
    version: versionParts.length > 0 ? versionParts.join(" / ") : null,
    issues,
    installState: issues.length === 0 ? "available" : "needs_repair"
  };
}

function missingHealth(id: ExecutorId): ExecutorHealth {
  return {
    id,
    canRun: false,
    command: "",
    version: null,
    issues: ["未检测到该执行器；请在设置中安装或填写可执行文件路径。"],
    experimental: id === "zcode",
    installState: "missing"
  };
}

function checkVersionSync(launch: ExecutorLaunch): VersionCheck {
  try {
    const output = execFileSync(launch.command, [...launch.args, "--version"], {
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
      encoding: "utf8",
      env: { ...process.env, ...launch.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { ok: true, version: firstLine(output), error: null };
  } catch (error) {
    return { ok: false, version: null, error: versionError(launch, error) };
  }
}

function checkVersionAsync(launch: ExecutorLaunch, timeoutMs: number): Promise<VersionCheck> {
  return new Promise((resolve) => {
    execFile(
      launch.command,
      [...launch.args, "--version"],
      { timeout: timeoutMs, windowsHide: true, env: { ...process.env, ...launch.env } },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, version: null, error: versionError(launch, error, stderr) });
          return;
        }
        resolve({ ok: true, version: firstLine(`${stdout}${stderr}`), error: null });
      }
    );
  });
}

function versionError(launch: ExecutorLaunch, error: unknown, stderr?: string): string {
  const detail = stderr?.trim() || (error instanceof Error ? error.message : String(error));
  return `无法运行“${launch.display} --version”：${detail}`;
}

function firstLine(output: string): string | null {
  const line = output.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
  return line ?? null;
}

function packageVersion(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function qoderAuthConfigured(runtime: ExecutorRuntimeSettings): boolean {
  if (runtime.authMode) return true;
  if (process.env.QODER_PERSONAL_ACCESS_TOKEN) return true;
  return [join(homedir(), ".qoder"), join(homedir(), ".qodercli"), join(homedir(), ".config", "qoder")].some(existsSync);
}

function findQoderCli(): string | null {
  const onPath = findOnPath("qodercli");
  if (onPath) return onPath;
  const roots = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Qoder") : null,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Qoder") : null,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Qoder CN") : null,
    "D:\\App\\Qoder CN"
  ].filter((value): value is string => Boolean(value));
  const relative = [
    ["resources", "bin", "qodercli.exe"],
    ["resources", "bin", "qodercli"],
    ["resources", "app", "bin", "qodercli.exe"],
    ["bin", "qodercli.exe"],
    ["bin", "qodercli"]
  ];
  for (const root of roots) {
    for (const parts of relative) {
      const candidate = join(root, ...parts);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function detectZcodeScript(): string | null {
  const roots = [
    process.env.ZCODE_HOME ?? null,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "ZCode") : null,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ZCode") : null,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "ZCode") : null,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "ZCode CN") : null,
    "D:\\App\\ZCode"
  ].filter((value): value is string => Boolean(value));
  for (const root of roots) {
    const candidate = join(root, "resources", "glm", "zcode.cjs");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findZcodeElectron(script: string): string | null {
  const appRoot = dirname(dirname(dirname(script)));
  const candidates = [
    join(appRoot, "ZCode.exe"),
    join(appRoot, "zcode.exe"),
    join(appRoot, "ZCode"),
    join(appRoot, "electron.exe")
  ];
  return candidates.find(existsSync) ?? null;
}

function globalNodeModuleRoots(): string[] {
  return [
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules") : null,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "nodejs", "node_modules") : null,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "pnpm", "global", "5", "node_modules") : null,
    join(homedir(), ".npm-global", "lib", "node_modules")
  ].filter((value): value is string => Boolean(value));
}

function findOnPath(command: string): string | null {
  try {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const output = execFileSync(locator, [command], {
      timeout: 3_000,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return output.split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

function detectGlobalInstallations(): boolean {
  return process.env.HEARTH_EXECUTOR_DETECT !== "off";
}

function isScriptPath(path: string): boolean {
  return /\.(cjs|mjs|js)$/i.test(path);
}

function isShellShim(path: string): boolean {
  return /\.(cmd|bat)$/i.test(path);
}

function cacheKey(settingsPath: string, id: ExecutorId): string {
  return `${settingsPath}::${id}`;
}
