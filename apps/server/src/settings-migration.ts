import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { SettingsMigrationRecord } from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";
import type { ExecutorSettingsStore } from "./executor-settings.ts";
import { loadExecutorSettings } from "./executor-settings.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { loadModelSettings } from "./model-settings.ts";

const MODEL_MIGRATION_ID = "legacy-model-settings-v1";
const EXECUTOR_MIGRATION_ID = "legacy-executor-settings-v1";
const EXECUTOR_SETTINGS_KEY = "executor.settings";

export interface SettingsMigrationSummary {
  id: string;
  status: SettingsMigrationRecord["status"];
  backupPath: string | null;
  sourcePath: string;
}

export function migrateLegacySettings(input: {
  store: HearthStore;
  registry: ModelRegistry;
  executorSettings: ExecutorSettingsStore;
  modelSettingsPath: string;
  executorSettingsPath: string;
  backupRoot: string;
  now?: () => Date;
}): SettingsMigrationSummary[] {
  const now = input.now ?? (() => new Date());
  const directory = join(input.backupRoot, "legacy-dev");
  return [
    migrateModelSettings(input, directory, now),
    migrateExecutorSettings(input, directory, now)
  ];
}

function migrateModelSettings(
  input: Parameters<typeof migrateLegacySettings>[0],
  backupDirectory: string,
  now: () => Date
): SettingsMigrationSummary {
  const existing = input.store.getSettingsMigration(MODEL_MIGRATION_ID);
  if (existing?.status === "completed") {
    return { id: existing.id, status: existing.status, backupPath: existing.backupPath, sourcePath: existing.sourcePath };
  }
  const startedAt = now().toISOString();
  if (!existsSync(input.modelSettingsPath)) {
    return record(input.store, {
      id: MODEL_MIGRATION_ID,
      sourcePath: input.modelSettingsPath,
      backupPath: null,
      status: "skipped",
      error: null,
      createdAt: startedAt,
      updatedAt: startedAt
    });
  }
  const legacy = loadModelSettings(input.modelSettingsPath);
  if (!legacy.baseUrl || !legacy.model) {
    return record(input.store, {
      id: MODEL_MIGRATION_ID,
      sourcePath: input.modelSettingsPath,
      backupPath: null,
      status: "skipped",
      error: "旧模型设置没有完整配置",
      createdAt: startedAt,
      updatedAt: startedAt
    });
  }
  const backupPath = backupFile(input.modelSettingsPath, backupDirectory, now());
  const snapshot = snapshotModelRegistry(input.store);
  try {
    const imported = input.registry.importLegacy(legacy);
    if (!imported) {
      return record(input.store, {
        id: MODEL_MIGRATION_ID,
        sourcePath: input.modelSettingsPath,
        backupPath,
        status: "skipped",
        error: "本地模型不进入统一模型管理",
        createdAt: startedAt,
        updatedAt: now().toISOString()
      });
    }
    return record(input.store, {
      id: MODEL_MIGRATION_ID,
      sourcePath: input.modelSettingsPath,
      backupPath,
      status: "completed",
      error: null,
      createdAt: startedAt,
      updatedAt: now().toISOString()
    });
  } catch (error) {
    restoreModelRegistry(input.store, snapshot);
    return record(input.store, {
      id: MODEL_MIGRATION_ID,
      sourcePath: input.modelSettingsPath,
      backupPath,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      createdAt: startedAt,
      updatedAt: now().toISOString()
    });
  }
}

function migrateExecutorSettings(
  input: Parameters<typeof migrateLegacySettings>[0],
  backupDirectory: string,
  now: () => Date
): SettingsMigrationSummary {
  const existing = input.store.getSettingsMigration(EXECUTOR_MIGRATION_ID);
  if (existing?.status === "completed") {
    return { id: existing.id, status: existing.status, backupPath: existing.backupPath, sourcePath: existing.sourcePath };
  }
  const startedAt = now().toISOString();
  if (!existsSync(input.executorSettingsPath)) {
    return record(input.store, {
      id: EXECUTOR_MIGRATION_ID,
      sourcePath: input.executorSettingsPath,
      backupPath: null,
      status: "skipped",
      error: null,
      createdAt: startedAt,
      updatedAt: startedAt
    });
  }
  const backupPath = backupFile(input.executorSettingsPath, backupDirectory, now());
  const hadStoredSettings = input.executorSettings.hasStoredSettings();
  try {
    const legacy = loadExecutorSettings(input.executorSettingsPath);
    input.store.setAppSetting(EXECUTOR_SETTINGS_KEY, JSON.stringify({ ...legacy, updatedAt: startedAt }));
    return record(input.store, {
      id: EXECUTOR_MIGRATION_ID,
      sourcePath: input.executorSettingsPath,
      backupPath,
      status: "completed",
      error: null,
      createdAt: startedAt,
      updatedAt: now().toISOString()
    });
  } catch (error) {
    if (!hadStoredSettings) input.store.deleteAppSetting(EXECUTOR_SETTINGS_KEY);
    return record(input.store, {
      id: EXECUTOR_MIGRATION_ID,
      sourcePath: input.executorSettingsPath,
      backupPath,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      createdAt: startedAt,
      updatedAt: now().toISOString()
    });
  }
}

function backupFile(sourcePath: string, directory: string, date: Date): string {
  mkdirSync(directory, { recursive: true });
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  const target = join(directory, `${basename(sourcePath)}.${stamp}.bak`);
  copyFileSync(sourcePath, target);
  return target;
}

function record(store: HearthStore, record: SettingsMigrationRecord): SettingsMigrationSummary {
  store.upsertSettingsMigration(record);
  return { id: record.id, status: record.status, backupPath: record.backupPath, sourcePath: record.sourcePath };
}

function snapshotModelRegistry(store: HearthStore) {
  return {
    profiles: store.listModelProfiles(),
    bindings: store.listExecutorModelBindings(),
    chatProfileId: store.getAppSetting("model.chatProfileId"),
    updatedAt: store.getAppSetting("model.updatedAt")
  };
}

function restoreModelRegistry(
  store: HearthStore,
  snapshot: ReturnType<typeof snapshotModelRegistry>
): void {
  const profileIds = new Set(snapshot.profiles.map((profile) => profile.id));
  for (const profile of store.listModelProfiles()) {
    if (!profileIds.has(profile.id)) store.deleteModelProfile(profile.id);
  }
  for (const profile of snapshot.profiles) store.upsertModelProfile(profile);
  const bindingIds = new Set(snapshot.bindings.map((binding) => binding.executorId));
  for (const binding of store.listExecutorModelBindings()) {
    if (!bindingIds.has(binding.executorId)) store.deleteExecutorModelBinding(binding.executorId);
  }
  for (const binding of snapshot.bindings) store.setExecutorModelBinding(binding);
  if (snapshot.chatProfileId) store.setAppSetting("model.chatProfileId", snapshot.chatProfileId);
  else store.deleteAppSetting("model.chatProfileId");
  if (snapshot.updatedAt) store.setAppSetting("model.updatedAt", snapshot.updatedAt);
  else store.deleteAppSetting("model.updatedAt");
}
