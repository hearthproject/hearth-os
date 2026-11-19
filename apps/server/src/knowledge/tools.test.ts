import { beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { SecretBox } from "../secrets.ts";
import { KnowledgeClient } from "./client.ts";
import { KnowledgeSettingsStore } from "./settings.ts";
import { createKnowledgeTools } from "./tools.ts";

const ctx = {} as never;

describe("knowledge tools", () => {
  let store: HearthStore;
  let settings: KnowledgeSettingsStore;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    settings = new KnowledgeSettingsStore(store, new SecretBox(Buffer.alloc(32, 7)));
    settings.update({ enabled: true });
  });

  function tools() {
    const client = {
      find: async () => [{ uri: "viking://resources/hearth/a.md", contextType: "resource", level: 2, score: 0.9, abstract: "摘要", tags: [] }],
      read: async () => "完整原文",
      health: async () => ({ ok: true, latencyMs: 12, version: "0.5.5", authMode: "dev", detail: null })
    };
    return createKnowledgeTools({
      settings,
      clientFactory: () => client as unknown as KnowledgeClient
    });
  }

  it("finds knowledge through ov_find", async () => {
    const find = tools().find((tool) => tool.definition.name === "ov_find")!;
    const result = await find.execute({ query: "部署", limit: 2 }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("viking://resources/hearth/a.md");
  });

  it("reads a viking uri through ov_read", async () => {
    const read = tools().find((tool) => tool.definition.name === "ov_read")!;
    const result = await read.execute({ uri: "viking://resources/hearth/a.md" }, ctx);
    expect(result.content).toBe("完整原文");
    const invalid = await read.execute({ uri: "https://example.com" }, ctx);
    expect(invalid.isError).toBe(true);
  });

  it("reports health through ov_status", async () => {
    const status = tools().find((tool) => tool.definition.name === "ov_status")!;
    const result = await status.execute({}, ctx);
    expect(result.content).toContain("0.5.5");
  });
});
