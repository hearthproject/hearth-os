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
});
