import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadCodexProfile, probeCodex, type CodexProfile } from "@hearth/codex-executor";
import { runDeepSeekHarness } from "@hearth/deepseek-executor";
import type {
  ExecutorHealth,
  ExecutorId,
  ExecutorProbeResult,
  ExecutorRuntimeSettings,
  ExecutorSettings
} from "@hearth/core";
import { applyExecutorModelReadiness, markExecutorUnavailable, type ExecutorBindingReadiness } from "./executor-readiness.ts";
import { runExternalExecutor } from "./external-executor.ts";
import { hermesHealth } from "./hermes-health.ts";
import { probeHermes } from "./hermes-executor.ts";
import { completeChat } from "./model-client.ts";
import type { ModelSettings } from "./model-settings.ts";

const HEALTH_TTL_MS = 30_000;
const VERIFIED_TTL_MS = 24 * 60 * 60_000;
const VERSION_TIMEOUT_MS = 6_000;
const REAL_PROBE_TIMEOUT_MS = 60_000;

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

export interface ExecutorProbeOptions {
  modelSettings?: ModelSettings | null | undefined;
  binding?: ExecutorBindingReadiness | null | undefined;
  codexProfile?: CodexProfile | null | undefined;
  codexEnv?: Record<string, string> | undefined;
}

interface RealProbeOutcome {
  ok: boolean;
  error: string | null;
  code: string | null;
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
const verifiedHealthCache = new Map<string, CacheEntry>();
const require = createRequire(import.meta.url);

export function executorHome(settingsPath: string, id: ExecutorId): string {
  return join(dirname(settingsPath), "executors", id);
}

export function executorRuntimeSettings(settings: ExecutorSettings, id: ExecutorId): ExecutorRuntimeSettings {
  return settings.executors[id] ?? {};
}

export function isExecutorManagedInstalled(id: ExecutorId, settingsPath: string): boolean {
  const home = executorHome(settingsPath, id);
  const spec = NODE_CLI_SPECS[id];
  if (spec) return existsSync(join(home, "node_modules", spec.packageName, spec.entry));
  if (id === "qoder") {
    return existsSync(join(home, "node_modules", "@qoder-ai", "qoder-agent-sdk", "dist", "index.js"));
  }
  return false;
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
    const command = runtime.executablePath?.trim() || runtime.command?.trim() || settings.hermesCommand || "hermes";
    return {
      id,
      kind: "command",
      command,
      args: [],
      env: {},
      source: runtime.command || runtime.executablePath ? "configured" : "path",
      script: null,
      display: command
    };
  }
  if (id === "qoder") return resolveQoderLaunch(settingsPath, runtime);
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
  const verified = verifiedHealthCache.get(key);
  if (verified && Date.now() - verified.at < VERIFIED_TTL_MS) return verified.value;
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
  timeoutMs = REAL_PROBE_TIMEOUT_MS,
  options: ExecutorProbeOptions = {}
): Promise<ExecutorProbeResult> {
  const started = Date.now();
  const quick = applyExecutorModelReadiness(
    id,
    await computeHealthAsync(id, settings, settingsPath, Math.min(timeoutMs, VERSION_TIMEOUT_MS)),
    options.modelSettings ?? null,
    options.binding,
    options.codexProfile
  );
  const checkedAt = new Date().toISOString();
  let outcome: RealProbeOutcome;
  if (quick.state === "missing" || quick.state === "unconfigured" || quick.state === "failed") {
    outcome = {
      ok: false,
      error: quick.issues.join("；") || "执行器尚未配置完成",
      code: quick.state === "missing" ? "EXECUTOR_MISSING" : quick.state === "unconfigured" ? "EXECUTOR_UNCONFIGURED" : "EXECUTOR_FAILED"
    };
  } else {
    outcome = await runRealProbe(id, settings, settingsPath, timeoutMs, options);
  }
  const elapsedMs = Date.now() - started;
  const failure = outcome.ok ? null : classifyExecutorProbeFailure(outcome.error ?? "执行器测试失败", outcome.code);
  const state = outcome.ok ? "ready" : failure?.state ?? "failed";
  const error = outcome.ok ? null : failure?.message ?? outcome.error ?? "执行器测试失败";
  const health: ExecutorHealth = {
    ...quick,
    canRun: outcome.ok,
    state,
    verifiedAt: outcome.ok ? checkedAt : null,
    lastProbe: {
      ok: outcome.ok,
      state,
      error,
      code: outcome.ok ? null : failure?.code ?? outcome.code,
      elapsedMs,
      checkedAt
    },
    issues: outcome.ok ? [] : [error ?? "执行器测试失败"],
    installState: outcome.ok || state === "quota_exceeded" ? "available" : quick.installState ?? "needs_repair"
  };
  healthCache.set(cacheKey(settingsPath, id), { at: Date.now(), value: health });
  if (outcome.ok) verifiedHealthCache.set(cacheKey(settingsPath, id), { at: Date.now(), value: health });
  else verifiedHealthCache.delete(cacheKey(settingsPath, id));
  return {
    id,
    ok: health.canRun,
    command: health.command,
    version: health.version,
    error,
    elapsedMs,
    health
  };
}

export function clearExecutorHealthCache(id?: ExecutorId): void {
  if (!id) {
    healthCache.clear();
    verifiedHealthCache.clear();
    return;
  }
  const suffix = `::${id}`;
  for (const key of [...healthCache.keys()]) {
    if (key.endsWith(suffix)) healthCache.delete(key);
  }
  for (const key of [...verifiedHealthCache.keys()]) {
    if (key.endsWith(suffix)) verifiedHealthCache.delete(key);
  }
}

function computeHealthSync(id: ExecutorId, settings: ExecutorSettings, settingsPath: string): ExecutorHealth {
  if (id === "native") {
    return { id, canRun: true, state: "ready", command: "native", version: "builtin", issues: [], installState: "available" };
  }
  if (id === "codex") {
    const profile = loadCodexProfile();
    return {
      id,
      canRun: profile.canRun,
      state: profile.canRun ? "ready" : "unconfigured",
      command: "codex",
      version: null,
      issues: profile.issues,
      installState: profile.canRun ? "available" : "needs_repair"
    };
  }
  if (id === "deepseek-harness") {
    const packagePath = dshPackagePath();
    return {
      id,
      canRun: Boolean(packagePath),
      state: packagePath ? "unverified" : "missing",
      command: "dsh-sdk",
      version: packagePath ? packageVersion(packagePath) : null,
      issues: packagePath ? [] : ["DeepSeek Harness SDK 未安装；请重新安装项目依赖"],
      installState: packagePath ? "available" : "missing"
    };
  }
  if (id === "hermes") {
    const command = executorRuntimeSettings(settings, id).command?.trim() || settings.hermesCommand || "hermes";
    const health = hermesHealth(command);
    return {
      id,
      canRun: false,
      state: health.canRun ? "unverified" : health.version ? "unconfigured" : "missing",
      command: health.command,
      version: health.version,
      issues: health.canRun
        ? ["Hermes 尚未完成真实可用性测试；请在设置中点击“测试可用性”"]
        : health.issues,
      installState: health.canRun ? "available" : health.version ? "needs_repair" : "missing"
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
  if (id === "native" || id === "codex" || id === "deepseek-harness" || id === "hermes") return computeHealthSync(id, settings, settingsPath);
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
    display: script
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
    canRun: false,
    state: check.ok ? "unverified" : "failed",
    command: launch.display,
    version: check.version,
    issues: check.ok ? ["尚未完成真实可用性测试；请在设置中点击“测试可用性”"] : [check.error ?? "无法启动执行器"],
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
    canRun: false,
    state: issues.length === 0 ? "unverified" : "failed",
    command: launch.display,
    version: versionParts.length > 0 ? versionParts.join(" / ") : null,
    issues: issues.length === 0 ? ["尚未完成真实可用性测试；请在设置中点击“测试可用性”"] : issues,
    installState: issues.length === 0 ? "available" : "needs_repair"
  };
}

function missingHealth(id: ExecutorId): ExecutorHealth {
  return {
    id,
    canRun: false,
    state: "missing",
    command: "",
    version: null,
    issues: ["未检测到该执行器；请在设置中安装或填写可执行文件路径。"],
    installState: "missing"
  };
}

async function runRealProbe(
  id: ExecutorId,
  settings: ExecutorSettings,
  settingsPath: string,
  timeoutMs: number,
  options: ExecutorProbeOptions
): Promise<RealProbeOutcome> {
  try {
    if (id === "codex") {
      const profile = options.codexProfile ?? loadCodexProfile();
      const result = await withProbeTimeout(
        probeCodex(profile, options.codexEnv),
        timeoutMs,
        "Codex 测试超时，请检查模型地址、网络和登录状态"
      );
      if (!result.ok) return { ok: false, error: result.error, code: null };
      return verifyProbeText(result.text);
    }
    if (id === "native") {
      if (!options.modelSettings) return { ok: false, error: "尚未配置聊天模型", code: "EXECUTOR_UNCONFIGURED" };
      const result = await completeChat(options.modelSettings, [
        { role: "system", content: "You are a connectivity probe. Reply with exactly HEARTH_OK and nothing else." },
        { role: "user", content: "Reply with exactly HEARTH_OK. Do not use tools." }
      ], { maxTokens: 24, temperature: 0, timeoutMs: Math.min(timeoutMs, 60_000) });
      return verifyProbeText(result.content);
    }
    if (id === "deepseek-harness") {
      if (!options.modelSettings) return { ok: false, error: "DeepSeek Harness 还没有绑定模型", code: "EXECUTOR_UNCONFIGURED" };
      const root = mkdtempSync(join(tmpdir(), "hearth-probe-dsh-"));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const result = await runDeepSeekHarness({
          settings: {
            protocol: options.modelSettings.protocol as "openai-chat" | "openai-responses" | "anthropic-messages",
            baseUrl: options.modelSettings.baseUrl,
            model: options.modelSettings.model,
            apiKey: options.modelSettings.apiKey
          },
          dshHome: executorHome(settingsPath, "deepseek-harness"),
          workingDirectory: root,
          outDir: root,
          prompt: "Reply with exactly HEARTH_OK and nothing else. Do not use tools.",
          mode: "full",
          maxTurns: 1,
          runBudgetSeconds: Math.max(1, Math.round(timeoutMs / 1_000)),
          signal: controller.signal
        });
        return verifyProbeText(result.finalResponse);
      } finally {
        clearTimeout(timer);
        rmSync(root, { recursive: true, force: true });
      }
    }

    const launch = resolveExecutorLaunch(id, settings, settingsPath);
    if (!launch) return { ok: false, error: "未检测到该执行器；请先安装或配置命令路径", code: "EXECUTOR_MISSING" };
    if (id === "hermes") {
      const result = await withProbeTimeout(
        probeHermes(launch.command, timeoutMs),
        timeoutMs,
        "Hermes 测试超时，请检查 provider、网络和额度"
      );
      if (!result.ok) return { ok: false, error: result.error ?? "Hermes 测试失败", code: result.code ?? null };
      return verifyProbeText(result.text ?? "");
    }

    const root = mkdtempSync(join(tmpdir(), `hearth-probe-${id}-`));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await runExternalExecutor({
        id,
        launch,
        workingDirectory: root,
        prompt: "Reply with exactly HEARTH_OK and nothing else. Do not use tools.",
        mode: "full",
        maxTurns: 1,
        runBudgetSeconds: Math.max(1, Math.round(timeoutMs / 1_000)),
        signal: controller.signal
      });
      return verifyProbeText(result.finalResponse);
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, error: `${id} 测试超时（${Math.round(timeoutMs / 1_000)} 秒）`, code: "PROBE_TIMEOUT" };
      throw error;
    } finally {
      clearTimeout(timer);
      rmSync(root, { recursive: true, force: true });
    }
  } catch (error) {
    return probeOutcomeFromError(error);
  }
}

function verifyProbeText(text: string): RealProbeOutcome {
  const normalized = text.trim();
  if (normalized.includes("HEARTH_OK")) return { ok: true, error: null, code: null };
  return {
    ok: false,
    error: `执行器未返回预期的最小响应 HEARTH_OK，实际返回：${normalized.slice(0, 500) || "（空）"}`,
    code: "UNEXPECTED_PROBE_RESPONSE"
  };
}

function probeOutcomeFromError(error: unknown): RealProbeOutcome {
  const record = typeof error === "object" && error !== null ? error as { status?: unknown; code?: unknown } : {};
  const status = typeof record.status === "number" ? record.status : null;
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    code: typeof record.code === "string" ? record.code : status ? `HTTP_${status}` : null
  };
}

function withProbeTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function classifyExecutorProbeFailure(
  message: string,
  code?: string | null
): { state: "failed" | "quota_exceeded"; code: string; message: string } {
  const text = message.trim();
  if (
    code === "HTTP_429"
    || /(?:HTTP\s*)?\b429\b|too many requests|rate.?limit|quota|insufficient_quota|usage limit|exceeded.*(?:quota|limit)|额度|余额不足|配额|请求过于频繁/i.test(`${code ?? ""} ${text}`)
  ) {
    return { state: "quota_exceeded", code: code ?? "QUOTA_EXCEEDED", message: text };
  }
  return { state: "failed", code: code ?? "PROBE_FAILED", message: text };
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

function dshPackagePath(): string | null {
  try {
    return require.resolve("@deepseek-ai/dsh-sdk-client/package.json");
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
