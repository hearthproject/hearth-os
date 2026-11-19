import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { SecretBox } from "../secrets.ts";
import { KnowledgeClient, KnowledgeClientError, type KnowledgeHit } from "./client.ts";
import { KnowledgeRecallService } from "./recall.ts";
import { KnowledgeSettingsStore } from "./settings.ts";

const RESOURCE_HIT: KnowledgeHit = {
  uri: "viking://resources/hearth/p0/baseline.md",
  contextType: "resource",
  level: 2,
  score: 0.77,
  abstract: null,
  tags: []
};

const MEMORY_HIT: KnowledgeHit = {
  uri: "viking://user/default/memories/curated/preference-zh.md",
  contextType: "memory",
  level: 2,
  score: 0.66,
  abstract: "用户偏好简体中文",
  tags: []
};

function fakeClient(options: {
  resources?: KnowledgeHit[];
  memories?: KnowledgeHit[];
  failResources?: boolean;
  failMemories?: boolean;
  readError?: boolean;
}): KnowledgeClient {
  const client = {
    find: async (input: { contextTypes?: string[] }) => {
      if (input.contextTypes?.includes("resource")) {
        if (options.failResources) throw new KnowledgeClientError("KNOWLEDGE_UNREACHABLE", "down");
        return options.resources ?? [RESOURCE_HIT];
      }
      if (options.failMemories) throw new KnowledgeClientError("KNOWLEDGE_UNREACHABLE", "down");
      return options.memories ?? [MEMORY_HIT];
    },
    read: async () => {
      if (options.readError) throw new KnowledgeClientError("KNOWLEDGE_TIMEOUT", "slow");
      return "Hearth 部署回滚步骤：先停止本地服务，再用 SQLite 快照恢复。";
    }
  };
  return client as unknown as KnowledgeClient;
}

describe("KnowledgeRecallService", () => {
  let store: HearthStore;
  let settings: KnowledgeSettingsStore;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    settings = new KnowledgeSettingsStore(store, new SecretBox(Buffer.alloc(32, 3)));
  });

  afterEach(() => store.close());

  it("returns nothing while disabled", async () => {
    const recall = new KnowledgeRecallService({ store, settings, clientFactory: () => fakeClient({}) });
    const result = await recall.recall({ query: "部署" });
    expect(result.block).toBe("");
    expect(result.reason).toBe("disabled");
  });

  it("merges resource and memory hits into one block", async () => {
    settings.update({ enabled: true, recall: { maxItems: 5, maxTokens: 1200 } });
    const recall = new KnowledgeRecallService({ store, settings, clientFactory: () => fakeClient({}) });
    const result = await recall.recall({ query: "部署回滚" });
    expect(result.block).toContain("viking://resources/hearth/p0/baseline.md");
    expect(result.block).toContain("viking://user/default/memories/curated/preference-zh.md");
    expect(result.items).toHaveLength(2);
    expect(result.degraded).toBe(false);
    expect(result.hits[0]?.uri).toBe(RESOURCE_HIT.uri);
  });

  it("degrades when every backend call fails", async () => {
    settings.update({ enabled: true });
    const recall = new KnowledgeRecallService({
      store,
      settings,
      clientFactory: () => fakeClient({ failResources: true, failMemories: true })
    });
    const result = await recall.recall({ query: "部署回滚" });
    expect(result.block).toBe("");
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain("KNOWLEDGE_UNREACHABLE");
  });

  it("keeps partial results when only one call fails", async () => {
    settings.update({ enabled: true });
    const recall = new KnowledgeRecallService({
      store,
      settings,
      clientFactory: () => fakeClient({ failMemories: true })
    });
    const result = await recall.recall({ query: "部署回滚" });
    expect(result.block).toContain(RESOURCE_HIT.uri);
    expect(result.degraded).toBe(false);
  });

  it("falls back to a pointer when reading the full text fails", async () => {
    settings.update({ enabled: true });
    const recall = new KnowledgeRecallService({
      store,
      settings,
      clientFactory: () => fakeClient({ readError: true })
    });
    const result = await recall.recall({ query: "部署回滚" });
    expect(result.block).toContain("可按 URI 读取原文");
  });
});
