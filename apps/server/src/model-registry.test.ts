import { describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { ModelRegistry, ModelRegistryError } from "./model-registry.ts";
import { SecretBox } from "./secrets.ts";

function setup(): ModelRegistry {
  const store = new HearthStore(":memory:");
  return new ModelRegistry({
    store,
    secretBox: new SecretBox(Buffer.alloc(32, 7)),
    codexHome: "C:/tmp/hearth-codex"
  });
}

describe("model registry protocol constraints", () => {
  it("only allows Responses models to bind to Codex", () => {
    const registry = setup();
    const chat = registry.createProfile({
      name: "Chat model",
      protocol: "openai-chat",
      baseUrl: "https://example.com/v1",
      model: "chat-model",
      apiKey: "sk-chat"
    });
    expect(() => registry.saveBinding("codex", { profileId: chat.id })).toThrow(ModelRegistryError);

    const responses = registry.createProfile({
      name: "Responses model",
      protocol: "openai-responses",
      baseUrl: "https://example.com/v1",
      model: "responses-model",
      apiKey: "sk-responses"
    });
    const binding = registry.saveBinding("codex", { profileId: responses.id });
    expect(binding.effectiveProtocol).toBe("openai-responses");
    expect(binding.protocolLocked).toBe(true);
    expect(binding.available).toBe(true);
  });

  it("rejects local model endpoints from the unified registry", () => {
    const registry = setup();
    expect(() => registry.createProfile({
      name: "Ollama",
      protocol: "openai-chat",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen",
      apiKey: ""
    })).toThrow(/本地模型/);
  });

  it("allows DeepSeek Harness to bind chat, responses, and Anthropic profiles", () => {
    const registry = setup();
    for (const protocol of ["openai-chat", "openai-responses", "anthropic-messages"] as const) {
      const profile = registry.createProfile({
        name: protocol,
        protocol,
        baseUrl: "https://example.com/v1",
        model: protocol,
        apiKey: "sk-key"
      });
      expect(registry.saveBinding("deepseek-harness", { profileId: profile.id }).effectiveProtocol).toBe(protocol);
    }
  });

  it("auto-binds Codex to the current chat model with a Responses override", () => {
    const registry = setup();
    const chat = registry.createProfile({
      name: "Chat model",
      protocol: "openai-chat",
      baseUrl: "https://example.com/v1",
      model: "chat-model",
      apiKey: "sk-chat"
    });
    registry.setChatProfile(chat.id);

    const binding = registry.autoBind("codex");
    expect(binding.profile?.id).toBe(chat.id);
    expect(binding.effectiveProtocol).toBe("openai-responses");
    expect(binding.available).toBe(true);
  });

  it("auto-binds an executor to the chat model and preserves an already usable binding", () => {
    const registry = setup();
    const chat = registry.createProfile({
      name: "Chat model",
      protocol: "openai-chat",
      baseUrl: "https://example.com/v1",
      model: "chat-model",
      apiKey: "sk-chat"
    });
    const other = registry.createProfile({
      name: "Other model",
      protocol: "openai-chat",
      baseUrl: "https://example.com/v1",
      model: "other-model",
      apiKey: "sk-other"
    });
    registry.setChatProfile(chat.id);

    const binding = registry.autoBind("deepseek-harness");
    expect(binding.profile?.id).toBe(chat.id);
    expect(binding.protocolOverride).toBeNull();

    registry.saveBinding("deepseek-harness", { profileId: other.id });
    expect(registry.autoBind("deepseek-harness").profile?.id).toBe(other.id);
  });

  it("reports a clear error when no model can be auto-bound", () => {
    const registry = setup();
    expect(() => registry.autoBind("codex")).toThrow(/没有可用的模型档案/);
  });
});

describe("model registry persistence", () => {
  it("stores context-window and output-token limits", () => {
    const registry = setup();
    const profile = registry.createProfile({
      name: "Long context",
      protocol: "openai-chat",
      baseUrl: "https://example.com/v1",
      model: "long-context",
      contextWindowTokens: 256_000,
      maxOutputTokens: 32_000,
      apiKey: "sk-secret"
    });
    expect(profile).toMatchObject({ contextWindowTokens: 256_000, maxOutputTokens: 32_000 });
    expect(registry.settingsForProfile(profile.id)).toMatchObject({ contextWindowTokens: 256_000, maxOutputTokens: 32_000 });

    const updated = registry.updateProfile(profile.id, { contextWindowTokens: 512_000 });
    expect(updated.contextWindowTokens).toBe(512_000);
    expect(updated.maxOutputTokens).toBe(32_000);
  });

  it("clears a stored API key when the profile is updated with an empty key", () => {
    const registry = setup();
    const profile = registry.createProfile({
      name: "Chat model",
      protocol: "openai-chat",
      baseUrl: "https://example.com/v1",
      model: "chat-model",
      apiKey: "sk-secret"
    });
    expect(registry.settingsForProfile(profile.id)?.apiKey).toBe("sk-secret");

    const updated = registry.updateProfile(profile.id, { apiKey: "" });
    expect(updated.hasApiKey).toBe(false);
    expect(registry.settingsForProfile(profile.id)?.apiKey).toBe("");
    expect(registry.listProfiles().find((item) => item.id === profile.id)?.apiKeyMasked).toBeNull();
  });

  it("clears the chat profile pointer when the selected profile is deleted", () => {
    const registry = setup();
    const profile = registry.createProfile({
      name: "Chat model",
      protocol: "openai-chat",
      baseUrl: "https://example.com/v1",
      model: "chat-model",
      apiKey: "sk-secret"
    });
    registry.setChatProfile(profile.id);
    expect(registry.chatProfileId()).toBe(profile.id);

    registry.deleteProfile(profile.id);
    expect(registry.chatProfileId()).toBeNull();
    expect(registry.chatSettings()).toBeNull();
  });

  it("repairs legacy 128k defaults when the same model already uses 328k", () => {
    const store = new HearthStore(":memory:");
    const secretBox = new SecretBox(Buffer.alloc(32, 7));
    const first = new ModelRegistry({ store, secretBox, codexHome: "C:/tmp/hearth-codex" });
    const full = first.createProfile({
      name: "DeepSeek Chat",
      protocol: "openai-chat",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-flash",
      contextWindowTokens: 328_000,
      apiKey: "sk-a"
    });
    const legacy = first.createProfile({
      name: "DeepSeek Responses",
      protocol: "openai-responses",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-flash",
      contextWindowTokens: 128_000,
      apiKey: "sk-b"
    });

    const reopened = new ModelRegistry({ store, secretBox, codexHome: "C:/tmp/hearth-codex" });
    expect(reopened.listProfiles().find((item) => item.id === full.id)?.contextWindowTokens).toBe(328_000);
    expect(reopened.listProfiles().find((item) => item.id === legacy.id)?.contextWindowTokens).toBe(328_000);
    store.close();
  });
});
