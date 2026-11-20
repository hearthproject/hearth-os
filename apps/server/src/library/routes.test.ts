import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "../app.ts";

function seedMemory(store: HearthStore): void {
  const now = "2026-11-20T00:00:00.000Z";
  store.db.prepare(
    `INSERT INTO memories
      (id, kind, status, content, subject_key, scope, tags_json, source_json, confidence, sensitivity,
       allow_recall, version, created_at, updated_at, recall_count, content_hash)
     VALUES ('mem-api', 'fact', 'active', '资料库搜索可以直接使用。', '搜索', 'global', '[]', ?, 'high', 'normal', 1, 1, ?, ?, 0, 'hash-api')`
  ).run(JSON.stringify({ type: "user", id: null, label: "用户", excerpt: null }), now, now);
}

describe("library routes", () => {
  let store: HearthStore;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    seedMemory(store);
  });

  afterEach(() => {
    store.close();
  });

  it("serves tree, status, search, preview and trash over HTTP", async () => {
    const app = await buildServer({ store, serveWeb: false, libraryEmbeddingProvider: null });

    const status = await app.inject({ method: "GET", url: "/api/library/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json().nodeCount).toBeGreaterThan(0);

    const tree = await app.inject({ method: "GET", url: "/api/library/tree?depth=2" });
    expect(tree.statusCode).toBe(200);
    expect(tree.json().nodes.map((node: { title: string }) => node.title)).toEqual(["记忆", "任务", "资料", "技能", "项目"]);

    const search = await app.inject({ method: "GET", url: "/api/library/search?q=" + encodeURIComponent("资料库搜索") });
    expect(search.statusCode).toBe(200);
    const hit = search.json().hits[0];
    expect(hit.node.ref).toBe("hearth://memory/mem-api");

    const preview = await app.inject({ method: "GET", url: `/api/library/nodes/${hit.node.id}` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().document.content).toContain("可以直接使用");

    const removed = await app.inject({ method: "DELETE", url: `/api/library/nodes/${hit.node.id}`, payload: {} });
    expect(removed.statusCode).toBe(200);
    const trash = await app.inject({ method: "GET", url: "/api/library/trash" });
    expect(trash.json().entries).toHaveLength(1);

    const restored = await app.inject({ method: "POST", url: `/api/library/trash/${trash.json().entries[0].id}/restore` });
    expect(restored.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/api/library/search?q=" + encodeURIComponent("资料库搜索") });
    expect(after.json().hits).toHaveLength(1);

    await app.close();
  });
});
