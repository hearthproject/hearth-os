import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, loadModelSettings, saveModelSettings, viewModelSettings } from "./model-settings.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempSettingsPath(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-model-settings-"));
  roots.push(root);
  return join(root, "model-settings.json");
}

describe("model context settings", () => {
  it("defaults legacy settings to 128K context and 8K output", () => {
    const path = tempSettingsPath();
    writeFileSync(path, JSON.stringify({ providerId: "custom", providerName: "Legacy", protocol: "openai-chat", baseUrl: "https://example.com/v1", model: "legacy", apiKey: "sk-test" }));
    const settings = loadModelSettings(path);
    expect(settings.contextWindowTokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(settings.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(viewModelSettings(settings)).toMatchObject({ contextWindowTokens: 128_000, maxOutputTokens: 8_000 });
  });

  it("persists edited token limits and clamps invalid values", () => {
    const path = tempSettingsPath();
    const saved = saveModelSettings(path, {
      providerId: "custom",
      providerName: "Test",
      protocol: "openai-chat",
      baseUrl: "https://example.com/v1",
      model: "test",
      contextWindowTokens: 200_000,
      maxOutputTokens: 16_000
    });
    expect(saved.contextWindowTokens).toBe(200_000);
    expect(loadModelSettings(path).maxOutputTokens).toBe(16_000);
    expect(JSON.parse(readFileSync(path, "utf8")).contextWindowTokens).toBe(200_000);

    const clamped = saveModelSettings(path, { contextWindowTokens: 1, maxOutputTokens: Number.POSITIVE_INFINITY });
    expect(clamped.contextWindowTokens).toBe(4_096);
    expect(clamped.maxOutputTokens).toBe(16_000);
  });
});
