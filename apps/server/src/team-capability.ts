import { execFileSync } from "node:child_process";
import type { ExecutorId, ExecutorRuntimeSettings, ExecutorTeamCapability } from "@hearth/core";
import {
  DSH_TEAM_VERSION,
  dshTeamRuntimeStatus,
  findCodexBinary,
  findDshPackage
} from "./executor-installer.ts";

/** Codex added native multi-agent in 0.124; older builds silently ignore the config. */
const CODEX_TEAM_MIN_VERSION = "0.124.0";
const CAPABILITY_TTL_MS = 60_000;
const CODEX_VERSION_TTL_MS = 10 * 60_000;

const HEARTH_CAPABILITY: ExecutorTeamCapability = {
  owner: "hearth",
  single: "enforced",
  team: "managed",
  state: "available",
  visibility: "members",
  limits: { maxConcurrent: 4, maxTotal: 8, maxDepth: 2 }
};

const cache = new Map<string, { value: ExecutorTeamCapability; at: number }>();
const codexVersionCache = new Map<string, { version: string | null; at: number }>();

export function clearTeamCapabilityCache(executorId?: ExecutorId): void {
  if (!executorId) {
    cache.clear();
    codexVersionCache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${executorId}:`)) cache.delete(key);
  }
  if (executorId === "codex") codexVersionCache.clear();
}

function parseVersion(value: string | null | undefined): number[] | null {
  if (!value) return null;
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(version: string | null | undefined, minimum: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(minimum);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

function readCodexVersion(binary: string): string | null {
  const key = binary;
  const cached = codexVersionCache.get(key);
  if (cached && Date.now() - cached.at < CODEX_VERSION_TTL_MS) return cached.version;
  let version: string | null = null;
  try {
    const output = execFileSync(binary, ["--version"], {
      timeout: 5_000,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const parsed = parseVersion(output);
    version = parsed ? parsed.join(".") : null;
  } catch {
    version = null;
  }
  codexVersionCache.set(key, { version, at: Date.now() });
  return version;
}

function codexCapability(settingsPath: string, runtime: ExecutorRuntimeSettings | null | undefined): ExecutorTeamCapability {
  const binary = findCodexBinary(settingsPath, runtime?.executablePath ?? null);
  if (!binary) {
    return {
      owner: "codex",
      single: "enforced",
      team: "native",
      state: "unavailable",
      visibility: "none",
      limits: null,
      reason: "未检测到 Codex 运行程序，请先安装或更新执行器。",
      repair: "update-executor"
    };
  }
  const version = readCodexVersion(binary);
  if (!version) {
    return {
      owner: "codex",
      single: "enforced",
      team: "native",
      state: "probe_failed",
      visibility: "none",
      limits: null,
      reason: "无法读取 Codex 版本，不能确认原生多 Agent 是否可用。",
      repair: "update-executor"
    };
  }
  if (!atLeast(version, CODEX_TEAM_MIN_VERSION)) {
    return {
      owner: "codex",
      single: "enforced",
      team: "native",
      state: "unavailable",
      visibility: "none",
      limits: null,
      reason: `Codex ${version} 不支持原生多 Agent（需要 ${CODEX_TEAM_MIN_VERSION} 及以上）。`,
      repair: "update-executor"
    };
  }
  return {
    owner: "codex",
    single: "enforced",
    team: "native",
    state: "available",
    visibility: "none",
    limits: { maxConcurrent: 4, maxTotal: 4, maxDepth: 1 }
  };
}

function dshCapability(settingsPath: string): ExecutorTeamCapability {
  const sdk = findDshPackage(settingsPath);
  if (!sdk) {
    return {
      owner: "deepseek-harness",
      single: "enforced",
      team: "native",
      state: "unavailable",
      visibility: "session-tree",
      limits: null,
      reason: "DeepSeek Harness 尚未安装，请先安装执行器。",
      repair: "update-executor"
    };
  }
  const status = dshTeamRuntimeStatus(settingsPath);
  if (status.sdkVersion !== DSH_TEAM_VERSION) {
    return {
      owner: "deepseek-harness",
      single: "enforced",
      team: "native",
      state: "unavailable",
      visibility: "session-tree",
      limits: null,
      reason: `托管 DSH 版本为 ${status.sdkVersion ?? "未知"}，团队运行时需要 ${DSH_TEAM_VERSION}；请更新执行器后重试。`,
      repair: "update-executor"
    };
  }
  if (!status.available) {
    return {
      owner: "deepseek-harness",
      single: "enforced",
      team: "native",
      state: "unavailable",
      visibility: "session-tree",
      limits: null,
      reason: `缺少 DSH 团队运行时（需要 ${DSH_TEAM_VERSION}）。安装后即可启用原生团队。`,
      repair: "install-team-runtime"
    };
  }
  return {
    owner: "deepseek-harness",
    single: "enforced",
    team: "native",
    state: "available",
    visibility: "session-tree",
    limits: { maxConcurrent: 8, maxTotal: 8 }
  };
}

/**
 * Team capability for one executor. Cheap disk/version checks are cached for a
 * minute; Codex `--version` is cached longer because it spawns a process.
 */
export function teamCapabilityFor(
  executorId: ExecutorId,
  settingsPath: string,
  runtimeSettings?: ExecutorRuntimeSettings | null
): ExecutorTeamCapability {
  const key = `${executorId}:${settingsPath}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CAPABILITY_TTL_MS) return cached.value;
  let value: ExecutorTeamCapability;
  switch (executorId) {
    case "native":
      value = { ...HEARTH_CAPABILITY };
      break;
    case "codex":
      value = codexCapability(settingsPath, runtimeSettings);
      break;
    case "deepseek-harness":
      value = dshCapability(settingsPath);
      break;
    default:
      value = {
        owner: "none",
        single: "enforced",
        team: "unsupported",
        state: "unavailable",
        visibility: "none",
        limits: null,
        reason: "未知执行器"
      };
  }
  cache.set(key, { value, at: Date.now() });
  return value;
}
