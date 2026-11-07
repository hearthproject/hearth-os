import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ApprovalMode,
  ExecutorId,
  ExecutorSettings,
  ExecutorSettingsPatch,
  ExecutorSettingsView
} from "@hearth/core";
import { APPROVAL_MODES, EXECUTOR_IDS } from "@hearth/core";

export const DEFAULT_EXECUTOR_CONCURRENCY = 3;
export const MIN_EXECUTOR_CONCURRENCY = 1;
export const MAX_EXECUTOR_CONCURRENCY = 4;

export function defaultExecutorSettings(): ExecutorSettings {
  return {
    defaultApprovalMode: "necessary",
    concurrency: { native: DEFAULT_EXECUTOR_CONCURRENCY, codex: DEFAULT_EXECUTOR_CONCURRENCY, hermes: DEFAULT_EXECUTOR_CONCURRENCY },
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
    concurrency?: Partial<Record<ExecutorId, number | undefined>> | undefined;
    hermesCommand?: string | undefined;
  }
): ExecutorSettingsView {
  const current = loadExecutorSettings(path);
  const next = normalizeExecutorSettings({
    defaultApprovalMode: patch.defaultApprovalMode ?? current.defaultApprovalMode,
    concurrency: { ...current.concurrency, ...(patch.concurrency ?? {}) },
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

export function normalizeExecutorSettings(input: {
  defaultApprovalMode?: ApprovalMode | undefined;
  concurrency?: Partial<Record<ExecutorId, number | undefined>> | undefined;
  hermesCommand?: string | undefined;
}): ExecutorSettings {
  const defaults = defaultExecutorSettings();
  const concurrency = {} as Record<ExecutorId, number>;
  for (const id of EXECUTOR_IDS) {
    concurrency[id] = normalizeConcurrency(input.concurrency?.[id], defaults.concurrency[id]);
  }
  return {
    defaultApprovalMode: normalizeApprovalMode(input.defaultApprovalMode),
    concurrency,
    hermesCommand: typeof input.hermesCommand === "string" && input.hermesCommand.trim()
      ? input.hermesCommand.trim()
      : defaults.hermesCommand
  };
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
