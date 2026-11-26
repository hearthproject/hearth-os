import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { applyExecutorModelReadiness, type ExecutorBindingReadiness } from "./executor-readiness.ts";
import { findCodexBinary, findDshPackage } from "./executor-installer.ts";
import { completeChat } from "./model-client.ts";
import type { ModelSettings } from "./model-settings.ts";
import { removeTempDirectory } from "./temp-cleanup.ts";

const HEALTH_TTL_MS = 30_000;
const VERIFIED_TTL_MS = 24 * 60 * 60_000;
const REAL_PROBE_TIMEOUT_MS = 60_000;

interface CacheEntry {
  at: number;
  value: ExecutorHealth;
}

export interface ExecutorProbeOptions {
  modelSettings?: ModelSettings | null | undefined;
  binding?: ExecutorBindingReadiness | null | undefined;
  codexProfile?: CodexProfile | null | undefined;
  codexEnv?: Record<string, string> | undefined;
  codexBinaryPath?: string | null | undefined;
}

interface RealProbeOutcome {
  ok: boolean;
  error: string | null;
  code: string | null;
}

const healthCache = new Map<string, CacheEntry>();
const verifiedHealthCache = new Map<string, CacheEntry>();

export function executorHome(settingsPath: string, id: ExecutorId): string {
  return join(dirname(settingsPath), "executors", id);
}

export function executorRuntimeSettings(settings: ExecutorSettings, id: ExecutorId): ExecutorRuntimeSettings {
  return settings.executors[id] ?? {};
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
  _settings: ExecutorSettings,
  settingsPath: string,
  timeoutMs = REAL_PROBE_TIMEOUT_MS,
  options: ExecutorProbeOptions = {}
): Promise<ExecutorProbeResult> {
  const started = Date.now();
  const quick = applyExecutorModelReadiness(
    id,
    computeHealthSync(id, _settings, settingsPath),
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
    outcome = await runRealProbe(id, settingsPath, timeoutMs, {
      ...options,
      codexBinaryPath: options.codexBinaryPath ?? findCodexBinary(settingsPath, executorRuntimeSettings(_settings, "codex").executablePath)
    });
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
    const binary = findCodexBinary(settingsPath, executorRuntimeSettings(settings, "codex").executablePath);
    if (!binary) {
      return {
        id,
        canRun: false,
        state: "missing",
        command: "codex",
        version: null,
        issues: ["Codex 运行程序未安装；到设置 → 执行器点击“一键安装”即可下载并启用"],
        installState: "missing"
      };
    }
    return {
      id,
      canRun: profile.canRun,
      state: profile.canRun ? "ready" : "unconfigured",
      command: binary,
      version: null,
      issues: profile.canRun ? [] : profile.issues,
      installState: profile.canRun ? "available" : "needs_repair"
    };
  }
  const packagePath = findDshPackage(settingsPath);
  return {
    id,
    canRun: false,
    state: packagePath ? "unverified" : "missing",
    command: "dsh-sdk",
    version: packagePath ? packageVersion(packagePath) : null,
    issues: packagePath
      ? ["DeepSeek Harness 已安装但尚未验证；请先在“设置 → 执行器”里运行测试，通过后才会出现在聊天执行器列表"]
      : ["未安装 DeepSeek Harness；到设置 → 执行器点击“一键安装”即可下载并启用，native / Codex 不受影响"],
    installState: packagePath ? "available" : "missing"
  };
}

async function runRealProbe(
  id: ExecutorId,
  settingsPath: string,
  timeoutMs: number,
  options: ExecutorProbeOptions
): Promise<RealProbeOutcome> {
  try {
    if (id === "codex") {
      const profile = options.codexProfile ?? loadCodexProfile();
      const result = await withProbeTimeout(
        probeCodex(profile, options.codexEnv, options.codexBinaryPath ?? process.env.HEARTH_CODEX_PATH),
        timeoutMs,
        "Codex 测试超时，请检查模型地址、网络和登录状态"
      );
      if (!result.ok) return { ok: false, error: result.error, code: null };
      return verifyProbeText(result.text);
    }
    if (id === "native") {
      if (!options.modelSettings) return { ok: false, error: "尚未绑定执行器模型", code: "EXECUTOR_UNCONFIGURED" };
      const result = await completeChat(options.modelSettings, [
        { role: "system", content: "You are a connectivity probe. Reply with exactly HEARTH_OK and nothing else." },
        { role: "user", content: "Reply with exactly HEARTH_OK. Do not use tools." }
      ], { maxTokens: 24, temperature: 0, timeoutMs: Math.min(timeoutMs, 60_000) });
      return verifyProbeText(result.content);
    }
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
      removeTempDirectory(root);
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

function packageVersion(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function cacheKey(settingsPath: string, id: ExecutorId): string {
  return `${settingsPath}::${id}`;
}
