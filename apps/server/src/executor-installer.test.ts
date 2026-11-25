import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  executorNpmRegistries,
  executorRuntimeDir,
  findCodexBinary,
  managedCodexBinary,
  managedDshPackage
} from "./executor-installer.ts";

describe("executor installer paths", () => {
  let root: string;
  let settingsPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hearth-installer-"));
    settingsPath = join(root, "executor-settings.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("uses a per-executor runtime directory beside the settings file", () => {
    expect(executorRuntimeDir(settingsPath, "codex")).toBe(join(root, "executors", "codex", "runtime"));
    expect(executorRuntimeDir(settingsPath, "deepseek-harness")).toBe(join(root, "executors", "deepseek-harness", "runtime"));
  });

  it("finds a managed Codex binary before falling back to bundled installs", () => {
    const binary = join(executorRuntimeDir(settingsPath, "codex"), "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    mkdirSync(join(binary, ".."), { recursive: true });
    writeFileSync(binary, "");
    expect(managedCodexBinary(settingsPath)).toBe(binary);
    expect(findCodexBinary(settingsPath)).toBe(binary);
  });

  it("prefers an explicitly configured executable", () => {
    const explicit = join(root, "custom-codex.exe");
    writeFileSync(explicit, "");
    expect(findCodexBinary(settingsPath, explicit)).toBe(explicit);
  });

  it("detects a managed DeepSeek Harness package", () => {
    const packagePath = join(executorRuntimeDir(settingsPath, "deepseek-harness"), "node_modules", "@deepseek-ai", "dsh-sdk-client", "package.json");
    mkdirSync(join(packagePath, ".."), { recursive: true });
    writeFileSync(packagePath, "{}");
    expect(managedDshPackage(settingsPath)).toBe(packagePath);
  });
});

describe("executor npm registries", () => {
  it("tries domestic mirrors before the official npm registry", () => {
    const registries = executorNpmRegistries({} as NodeJS.ProcessEnv);
    expect(registries[0]?.url).toBe("https://registry.npmmirror.com");
    expect(registries.at(-1)?.url).toBe("https://registry.npmjs.org");
    expect(registries).toHaveLength(3);
  });

  it("pins a custom registry from the environment and trims a trailing slash", () => {
    const registries = executorNpmRegistries({
      HEARTH_EXECUTOR_NPM_REGISTRY: "https://npm.example.com/mirror/"
    } as NodeJS.ProcessEnv);
    expect(registries).toEqual([{ name: "自定义源", url: "https://npm.example.com/mirror" }]);
  });
});
