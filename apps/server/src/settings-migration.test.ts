import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { ExecutorSettingsStore } from "./executor-settings.ts";
import { ModelRegistry } from "./model-registry.ts";
import { SecretBox } from "./secrets.ts";
import { migrateLegacySettings } from "./settings-migration.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "hearth-migration-"));
  roots.push(directory);
  return directory;
}

function setup(directory: string) {
  const store = new HearthStore(":memory:");
  const registry = new ModelRegistry({
    store,
    secretBox: new SecretBox(Buffer.alloc(32, 7)),
    codexHome: join(directory, "executors", "codex")
  });
  return {
    store,
    registry,
    executorSettings: new ExecutorSettingsStore(store),
    modelSettingsPath: join(directory, "model-settings.json"),
    executorSettingsPath: join(directory, "executor-settings.json"),
    backupRoot: join(directory, "backups")
  };
}

describe("legacy settings migration", () => {
  it("imports model and executor JSON into SQLite with backups", () => {
    const directory = root();
    const input = setup(directory);
    writeFileSync(input.modelSettingsPath, JSON.stringify({
      providerId: "deepseek",
      providerName: "DeepSeek",
      protocol: "openai-responses",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4",
      apiKey: "sk-test"
    }), "utf8");
    writeFileSync(input.executorSettingsPath, JSON.stringify({
      defaultApprovalMode: "full",
      preferredExecutorId: "native",
      concurrency: { native: 2 },
      hermesCommand: "hermes-test"
    }), "utf8");

    const summary = migrateLegacySettings(input);
    expect(summary.map((item) => item.status)).toEqual(["completed", "completed"]);
    expect(input.registry.chatProfileId()).not.toBeNull();
    expect(input.registry.chatSettings()).toMatchObject({ model: "deepseek-v4", protocol: "openai-responses" });
    expect(input.registry.settingsForExecutor("native")).toMatchObject({ model: "deepseek-v4" });
    expect(input.registry.settingsForExecutor("codex")).toMatchObject({ model: "deepseek-v4" });
    expect(input.executorSettings.load()).toMatchObject({ defaultApprovalMode: "full", hermesCommand: "hermes-test" });
    expect(readdirSync(join(input.backupRoot, "legacy-dev"))).toHaveLength(2);
    expect(input.store.listSettingsMigrations().every((record) => record.status === "completed")).toBe(true);
    input.store.close();
  });

  it("is idempotent and does not duplicate profiles", () => {
    const directory = root();
    const input = setup(directory);
    writeFileSync(input.modelSettingsPath, JSON.stringify({
      providerId: "custom",
      providerName: "Custom",
      protocol: "openai-chat",
      baseUrl: "https://example.com/v1",
      model: "model-a",
      apiKey: "sk-test"
    }), "utf8");
    migrateLegacySettings(input);
    const firstCount = input.registry.listProfiles().length;
    const second = migrateLegacySettings(input);
    expect(second[0]?.status).toBe("completed");
    expect(input.registry.listProfiles()).toHaveLength(firstCount);
    input.store.close();
  });

  it("skips local model endpoints and reports why", () => {
    const directory = root();
    const input = setup(directory);
    writeFileSync(input.modelSettingsPath, JSON.stringify({
      providerId: "custom",
      providerName: "Local",
      protocol: "openai-chat",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "local-model",
      apiKey: "local"
    }), "utf8");
    const summary = migrateLegacySettings(input);
    expect(summary[0]).toMatchObject({ status: "skipped" });
    expect(input.registry.listProfiles()).toHaveLength(0);
    expect(existsSync(join(input.backupRoot, "legacy-dev"))).toBe(true);
    input.store.close();
  });
});
