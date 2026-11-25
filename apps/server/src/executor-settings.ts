import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ApprovalMode,
  ExecutorId,
  ExecutorRuntimeSettings,
  ExecutorSettings,
  ExecutorSettingsPatch,
  ExecutorSettingsView,
  ReasoningEffort
} from "@hearth/core";
import { EXECUTOR_IDS } from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";

const SETTINGS_KEY = "executor.settings";

export function defaultExecutorSettings(): ExecutorSettings {
  return {
    defaultApprovalMode: "full",
    preferredExecutorId: "native",
    reasoningEffort: "max",
    executors: {}
  };
}

export function loadExecutorSettings(path: string): ExecutorSettings {
  if (!existsSync(path)) return defaultExecutorSettings();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ExecutorSettings> & { updatedAt?: unknown };
    return normalizeExecutorSettings(parsed);
  } catch {
    return defaultExecutorSettings();
  }
}

export function saveExecutorSettings(
  path: string,
  patch: {
    defaultApprovalMode?: ApprovalMode | undefined;
    preferredExecutorId?: ExecutorId | null | undefined;
    reasoningEffort?: ReasoningEffort | undefined;
    executors?: Partial<Record<ExecutorId, ExecutorRuntimeSettings>> | undefined;
  }
): ExecutorSettingsView {
  const current = loadExecutorSettings(path);
  const next = normalizeExecutorSettings({
    defaultApprovalMode: patch.defaultApprovalMode ?? current.defaultApprovalMode,
    preferredExecutorId: patch.preferredExecutorId !== undefined ? patch.preferredExecutorId : current.preferredExecutorId,
    reasoningEffort: patch.reasoningEffort ?? current.reasoningEffort,
    executors: mergeExecutorRuntimeSettings(current.executors, patch.executors)
  });
  const updatedAt = new Date().toISOString();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...next, updatedAt }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows does not enforce POSIX modes.
  }
  return { ...next, updatedAt };
}

export function viewExecutorSettings(path: string): ExecutorSettingsView {
  if (!existsSync(path)) return { ...defaultExecutorSettings(), updatedAt: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ExecutorSettings> & { updatedAt?: unknown };
    return {
      ...normalizeExecutorSettings(parsed),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null
    };
  } catch {
    return { ...defaultExecutorSettings(), updatedAt: null };
  }
}

export class ExecutorSettingsStore {
  constructor(
    private readonly store: HearthStore,
    private readonly legacyPath?: string
  ) {}

  load(): ExecutorSettings {
    const raw = this.store.getAppSetting(SETTINGS_KEY);
    if (!raw) return this.legacyPath ? loadExecutorSettings(this.legacyPath) : defaultExecutorSettings();
    try {
      return normalizeExecutorSettings(JSON.parse(raw) as Partial<ExecutorSettings>);
    } catch {
      return defaultExecutorSettings();
    }
  }

  view(): ExecutorSettingsView {
    const raw = this.store.getAppSetting(SETTINGS_KEY);
    if (!raw) {
      return this.legacyPath
        ? viewExecutorSettings(this.legacyPath)
        : { ...defaultExecutorSettings(), updatedAt: null };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ExecutorSettings> & { updatedAt?: unknown };
      return {
        ...normalizeExecutorSettings(parsed),
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null
      };
    } catch {
      return { ...defaultExecutorSettings(), updatedAt: null };
    }
  }

  save(patch: {
    defaultApprovalMode?: ApprovalMode | undefined;
    preferredExecutorId?: ExecutorId | null | undefined;
    reasoningEffort?: ReasoningEffort | undefined;
    executors?: Partial<Record<ExecutorId, ExecutorRuntimeSettings>> | undefined;
  }): ExecutorSettingsView {
    const current = this.load();
    const next = normalizeExecutorSettings({
      defaultApprovalMode: patch.defaultApprovalMode ?? current.defaultApprovalMode,
      preferredExecutorId: patch.preferredExecutorId !== undefined ? patch.preferredExecutorId : current.preferredExecutorId,
      reasoningEffort: patch.reasoningEffort ?? current.reasoningEffort,
      executors: mergeExecutorRuntimeSettings(current.executors, patch.executors)
    });
    const updatedAt = new Date().toISOString();
    this.store.setAppSetting(SETTINGS_KEY, JSON.stringify({ ...next, updatedAt }));
    return { ...next, updatedAt };
  }

  hasStoredSettings(): boolean {
    return Boolean(this.store.getAppSetting(SETTINGS_KEY));
  }
}

function mergeExecutorRuntimeSettings(
  current: Partial<Record<ExecutorId, ExecutorRuntimeSettings>>,
  patch: Partial<Record<ExecutorId, ExecutorRuntimeSettings>> | undefined
): Partial<Record<ExecutorId, ExecutorRuntimeSettings>> {
  const merged: Partial<Record<ExecutorId, ExecutorRuntimeSettings>> = { ...current };
  for (const id of EXECUTOR_IDS) {
    const next = patch?.[id];
    if (!next) continue;
    const defined = Object.fromEntries(
      Object.entries(next).filter(([, value]) => value !== undefined)
    ) as ExecutorRuntimeSettings;
    merged[id] = { ...merged[id], ...defined };
  }
  return merged;
}

export function normalizeExecutorSettings(input: {
  defaultApprovalMode?: ApprovalMode | undefined;
  preferredExecutorId?: ExecutorId | null | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  /** Legacy concurrency settings are accepted during migration, then omitted. */
  concurrency?: unknown;
  executors?: Partial<Record<ExecutorId, ExecutorRuntimeSettings>> | undefined;
}): ExecutorSettings {
  const executors = normalizeExecutors(input.executors);
  return {
    defaultApprovalMode: normalizeApprovalMode(input.defaultApprovalMode),
    preferredExecutorId: normalizeExecutorId(input.preferredExecutorId),
    reasoningEffort: normalizeReasoningEffort(input.reasoningEffort),
    executors
  };
}

function normalizeExecutorId(value: unknown): ExecutorId | null {
  if (typeof value === "string" && (EXECUTOR_IDS as readonly string[]).includes(value)) return value as ExecutorId;
  return "native";
}

function normalizeExecutors(input: Partial<Record<ExecutorId, ExecutorRuntimeSettings>> | undefined): Partial<Record<ExecutorId, ExecutorRuntimeSettings>> {
  const output: Partial<Record<ExecutorId, ExecutorRuntimeSettings>> = {};
  if (!input || typeof input !== "object") return output;
  for (const id of EXECUTOR_IDS) {
    const raw = input[id];
    if (!raw || typeof raw !== "object") continue;
    const runtime: ExecutorRuntimeSettings = {};
    if (typeof raw.command === "string" && raw.command.trim()) runtime.command = raw.command.trim();
    if (typeof raw.executablePath === "string" && raw.executablePath.trim()) runtime.executablePath = raw.executablePath.trim();
    if (raw.installMode === "managed" || raw.installMode === "existing" || raw.installMode === "detected") runtime.installMode = raw.installMode;
    if (raw.authMode === "local" || raw.authMode === "pat" || raw.authMode === "env") runtime.authMode = raw.authMode;
    if (typeof raw.version === "string" || raw.version === null) runtime.version = raw.version;
    output[id] = runtime;
  }
  return output;
}

function normalizeApprovalMode(_value: unknown): ApprovalMode {
  return "full";
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "max" ? value : "max";
}
