import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { SecretBox } from "../secrets.ts";
import {
  DEFAULT_KNOWLEDGE_SETTINGS,
  KNOWLEDGE_API_KEY_META_KEY,
  KnowledgeSettingsError,
  KnowledgeSettingsStore
} from "./settings.ts";

describe("knowledge settings", () => {
  let store: HearthStore;
  let settings: KnowledgeSettingsStore;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    settings = new KnowledgeSettingsStore(store, new SecretBox(Buffer.alloc(32, 7)));
  });

  afterEach(() => store.close());

  it("returns defaults with no stored settings", () => {
    const value = settings.get();
    expect(value.enabled).toBe(false);
    expect(value.baseUrl).toBe(DEFAULT_KNOWLEDGE_SETTINGS.baseUrl);
    expect(value.recall.maxTokens).toBe(1200);
    expect(value.write.tasks).toBe("completed");
    expect(settings.view().apiKeyMasked).toBeNull();
  });

  it("merges nested patches without dropping siblings", () => {
    settings.update({ recall: { maxItems: 3 } });
    const value = settings.get();
    expect(value.recall.maxItems).toBe(3);
    expect(value.recall.maxTokens).toBe(1200);
    expect(value.recall.includeResources).toBe(true);
  });

  it("encrypts the api key and never exposes it in the view", () => {
    settings.update({ apiKey: "sk-openviking-secret-1234" });
    expect(store.getMeta(KNOWLEDGE_API_KEY_META_KEY)).not.toContain("sk-openviking-secret-1234");
    expect(settings.view().apiKeyMasked).toBe("sk-****1234");
    expect(settings.get().apiKey).toBe("sk-openviking-secret-1234");

    const reopened = new KnowledgeSettingsStore(store, new SecretBox(Buffer.alloc(32, 7)));
    expect(reopened.get().apiKey).toBe("sk-openviking-secret-1234");
  });

  it("clears the api key when given an empty string", () => {
    settings.update({ apiKey: "abc12345" });
    settings.update({ apiKey: "" });
    expect(settings.get().apiKey).toBe("");
    expect(settings.view().apiKeyMasked).toBeNull();
  });

  it("normalizes peers", () => {
    settings.update({ peers: { " codex ": " codex-peer " } });
    expect(settings.get().peers).toEqual({ codex: "codex-peer" });
  });

  it("rejects non-loopback base urls", () => {
    expect(() => settings.update({ baseUrl: "http://10.0.0.8:1933" })).toThrow(KnowledgeSettingsError);
    try {
      settings.update({ baseUrl: "http://10.0.0.8:1933" });
    } catch (error) {
      expect((error as KnowledgeSettingsError).code).toBe("KNOWLEDGE_BASE_URL_NOT_LOCAL");
    }
  });

  it("rejects out-of-range budgets and cron", () => {
    expect(() => settings.update({ recall: { timeoutMs: 20 } })).toThrow(KnowledgeSettingsError);
    expect(() => settings.update({ recall: { maxItems: 50 } })).toThrow(KnowledgeSettingsError);
    expect(() => settings.update({ write: { reindexCron: "every day" } })).toThrow(KnowledgeSettingsError);
    expect(() => settings.update({ write: { memories: "everything" as never } })).toThrow(KnowledgeSettingsError);
  });
});
