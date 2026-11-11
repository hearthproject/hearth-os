import { describe, expect, it } from "vitest";
import type { CodexProfile } from "@hearth/codex-executor";
import type { ExecutorHealth, ExecutorId } from "@hearth/core";
import { applyExecutorModelReadiness } from "./executor-readiness.ts";
import type { ModelSettings } from "./model-settings.ts";

function health(id: ExecutorId, canRun = true): ExecutorHealth {
  return { id, canRun, command: id, version: null, issues: [], installState: canRun ? "available" : "missing" };
}

function settings(overrides: Partial<ModelSettings> = {}): ModelSettings {
  return {
    providerId: "custom",
    providerName: "Custom",
    protocol: "openai-chat",
    baseUrl: "https://example.com/v1",
    model: "test-model",
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_000,
    apiKey: "sk-test",
    updatedAt: null,
    ...overrides
  };
}

function codexProfile(overrides: Partial<CodexProfile> = {}): CodexProfile {
  return {
    codexHome: "C:/Users/test/.codex",
    configPath: "C:/Users/test/.codex/config.toml",
    model: "gpt-test",
    providerId: "openai",
    providerName: "OpenAI",
    baseUrl: null,
    wireApi: null,
    envKey: null,
    envKeyPresent: false,
    envKeySource: "none",
    authSource: "openai-login",
    canRun: true,
    issues: [],
    ...overrides
  };
}

describe("executor model readiness", () => {
  it("marks native unavailable until a chat model is configured", () => {
    const readied = applyExecutorModelReadiness("native", health("native"), null);
    expect(readied.canRun).toBe(false);
    expect(readied.issues.join(" ")).toContain("聊天模型");
  });

  it("keeps native available with a usable model", () => {
    const base = health("native");
    expect(applyExecutorModelReadiness("native", base, settings()).canRun).toBe(true);
    expect(applyExecutorModelReadiness("native", base, settings({ apiKey: "" })).canRun).toBe(false);
  });

  it("requires an API key when Codex has a bound profile", () => {
    const base = health("codex");
    expect(applyExecutorModelReadiness("codex", base, null, null, codexProfile())).toEqual({
      ...base,
      canRun: true,
      state: "ready",
      installState: "available"
    });
    expect(applyExecutorModelReadiness("codex", base, settings(), { explicit: true, available: true, issue: null }).canRun).toBe(true);
    const missing = applyExecutorModelReadiness(
      "codex",
      base,
      settings({ apiKey: "" }),
      { explicit: true, available: true, issue: null }
    );
    expect(missing.canRun).toBe(false);
    expect(missing.issues.join(" ")).toContain("API Key");

    const invalidBinding = applyExecutorModelReadiness("codex", base, null, {
      explicit: true,
      available: false,
      issue: "模型档案缺少 API Key"
    });
    expect(invalidBinding.canRun).toBe(false);
    expect(invalidBinding.issues.join(" ")).toContain("Hearth 模型绑定不可用");
  });

  it("falls back to the local Codex profile only when no explicit binding exists", () => {
    const base = health("codex", false);
    const local = applyExecutorModelReadiness("codex", base, null, null, codexProfile());
    expect(local.canRun).toBe(true);
    expect(local.issues).toEqual([]);

    const missing = applyExecutorModelReadiness(
      "codex",
      base,
      null,
      null,
      codexProfile({ canRun: false, authSource: "missing", issues: ["未找到本机 Codex 登录"] })
    );
    expect(missing.canRun).toBe(false);
    expect(missing.state).toBe("unconfigured");
    expect(missing.issues.join(" ")).toContain("未找到本机 Codex 登录");

    const brokenBinding = applyExecutorModelReadiness(
      "codex",
      base,
      null,
      { explicit: true, available: false, issue: "模型档案缺少 API Key" },
      codexProfile()
    );
    expect(brokenBinding.canRun).toBe(false);
    expect(brokenBinding.state).toBe("failed");
    expect(brokenBinding.issues.join(" ")).toContain("Hearth 模型绑定不可用");
  });

  it("requires a usable DeepSeek Harness binding", () => {
    const base = health("deepseek-harness");
    expect(applyExecutorModelReadiness("deepseek-harness", base, null).issues.join(" ")).toContain("绑定模型");
    expect(applyExecutorModelReadiness("deepseek-harness", base, settings()).canRun).toBe(true);
    expect(applyExecutorModelReadiness("deepseek-harness", base, settings({ baseUrl: "" })).canRun).toBe(false);
    expect(applyExecutorModelReadiness("deepseek-harness", base, settings({ protocol: "gemini" })).issues.join(" ")).toContain("Gemini");
  });

  it("leaves external executors unchanged", () => {
    const base = health("hermes");
    expect(applyExecutorModelReadiness("hermes", base, null)).toEqual(base);
  });
});
