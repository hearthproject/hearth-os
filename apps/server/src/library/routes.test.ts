import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(tree.json().nodes.map((node: { title: string }) => node.title)).toEqual(["记忆", "任务", "资料", "技能", "MCP", "项目"]);

    const memoryRoot = tree.json().nodes.find((node: { title: string }) => node.title === "记忆");
    const summary = await app.inject({ method: "POST", url: `/api/library/nodes/${memoryRoot.id}/summary`, payload: {} });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().summary.content).toContain("记忆");

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

  it("stores a handoff package over HTTP", async () => {
    const handoffDir = mkdtempSync(join(tmpdir(), "hearth-handoff-route-"));
    const app = await buildServer({ store, serveWeb: false, libraryEmbeddingProvider: null, handoffRoot: handoffDir });

    const response = await app.inject({
      method: "POST",
      url: "/api/library/handoffs",
      payload: {
        title: "资料库交接",
        markdown: "# 交接说明\n\n任务目标：验证接口\n最近决定或结果：交接包入库",
        memories: [{ id: "mem-api", content: "资料库搜索可以直接使用。", updatedAt: "2026-11-20T00:00:00.000Z" }]
      }
    });
    expect(response.statusCode).toBe(201);
    const saved = response.json();
    expect(saved.node.kind).toBe("artifact");
    expect(saved.node.path).toContain("资料/交接");

    const search = await app.inject({ method: "GET", url: "/api/library/search?q=" + encodeURIComponent("交接包入库") });
    expect(search.json().hits.some((hit: { node: { id: string } }) => hit.node.id === saved.node.id)).toBe(true);

    await app.close();
    rmSync(handoffDir, { recursive: true, force: true });
  });
});
