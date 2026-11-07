import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ApprovalMode,
  ExecutorId,
  ExecutorRuntimeSettings,
  ExecutorSettings,
  ExecutorSettingsPatch,
  ExecutorSettingsView
} from "@hearth/core";
import { APPROVAL_MODES, EXECUTOR_IDS } from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";

export const DEFAULT_EXECUTOR_CONCURRENCY = 3;
export const MIN_EXECUTOR_CONCURRENCY = 1;
export const MAX_EXECUTOR_CONCURRENCY = 4;
const SETTINGS_KEY = "executor.settings";

export function defaultExecutorSettings(): ExecutorSettings {
  const concurrency = {} as Record<ExecutorId, number>;
  for (const id of EXECUTOR_IDS) concurrency[id] = DEFAULT_EXECUTOR_CONCURRENCY;
  return {
    defaultApprovalMode: "necessary",
    preferredExecutorId: null,
    concurrency,
    executors: {},
    hermesCommand: "hermes"
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
    concurrency?: Partial<Record<ExecutorId, number | undefined>> | undefined;
    executors?: Partial<Record<ExecutorId, ExecutorRuntimeSettings>> | undefined;
    hermesCommand?: string | undefined;
  }
): ExecutorSettingsView {
  const current = loadExecutorSettings(path);
  const next = normalizeExecutorSettings({
    defaultApprovalMode: patch.defaultApprovalMode ?? current.defaultApprovalMode,
    preferredExecutorId: patch.preferredExecutorId !== undefined ? patch.preferredExecutorId : current.preferredExecutorId,
    concurrency: { ...current.concurrency, ...(patch.concurrency ?? {}) },
    executors: mergeExecutorRuntimeSettings(current.executors, patch.executors),
    hermesCommand: patch.hermesCommand ?? current.hermesCommand
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
    concurrency?: Partial<Record<ExecutorId, number | undefined>> | undefined;
    executors?: Partial<Record<ExecutorId, ExecutorRuntimeSettings>> | undefined;
    hermesCommand?: string | undefined;
  }): ExecutorSettingsView {
    const current = this.load();
    const next = normalizeExecutorSettings({
      defaultApprovalMode: patch.defaultApprovalMode ?? current.defaultApprovalMode,
      preferredExecutorId: patch.preferredExecutorId !== undefined ? patch.preferredExecutorId : current.preferredExecutorId,
      concurrency: { ...current.concurrency, ...(patch.concurrency ?? {}) },
      executors: mergeExecutorRuntimeSettings(current.executors, patch.executors),
      hermesCommand: patch.hermesCommand ?? current.hermesCommand
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
  concurrency?: Partial<Record<ExecutorId, number | undefined>> | undefined;
  executors?: Partial<Record<ExecutorId, ExecutorRuntimeSettings>> | undefined;
  hermesCommand?: string | undefined;
}): ExecutorSettings {
  const defaults = defaultExecutorSettings();
  const concurrency = {} as Record<ExecutorId, number>;
  for (const id of EXECUTOR_IDS) {
    concurrency[id] = normalizeConcurrency(input.concurrency?.[id], defaults.concurrency[id]);
  }
  const executors = normalizeExecutors(input.executors);
  const configuredHermesCommand = typeof input.hermesCommand === "string" && input.hermesCommand.trim()
    ? input.hermesCommand.trim()
    : executors.hermes?.command?.trim() || defaults.hermesCommand;
  executors.hermes = { ...executors.hermes, command: configuredHermesCommand };
  return {
    defaultApprovalMode: normalizeApprovalMode(input.defaultApprovalMode),
    preferredExecutorId: normalizeExecutorId(input.preferredExecutorId),
    concurrency,
    executors,
    hermesCommand: configuredHermesCommand
  };
}

function normalizeExecutorId(value: unknown): ExecutorId | null {
  return typeof value === "string" && (EXECUTOR_IDS as readonly string[]).includes(value)
    ? value as ExecutorId
    : null;
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

function normalizeApprovalMode(value: unknown): ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value)
    ? value as ApprovalMode
    : "necessary";
}

function normalizeConcurrency(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(MIN_EXECUTOR_CONCURRENCY, Math.min(MAX_EXECUTOR_CONCURRENCY, Math.round(value)));
}
