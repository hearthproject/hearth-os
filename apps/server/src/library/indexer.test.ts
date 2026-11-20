import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { LibraryIndexer, chunkText, isSensitivePath } from "./indexer.ts";
import { LibraryTreeService } from "./tree.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seedMemory(store: HearthStore, id: string, content: string): void {
  const now = "2026-11-20T00:00:00.000Z";
  store.db.prepare(
    `INSERT INTO memories
      (id, kind, status, content, subject_key, scope, tags_json, source_json, confidence, sensitivity,
       allow_recall, version, created_at, updated_at, recall_count, content_hash)
     VALUES (?, 'fact', 'active', ?, '项目资料', 'global', '[]', ?, 'high', 'normal', 1, 1, ?, ?, 0, ?)`
  ).run(
    id,
    content,
    JSON.stringify({ type: "user", id: null, label: "用户", excerpt: null }),
    now,
    now,
    `hash-${id}`
  );
}

function seedSource(store: HearthStore, contentPath: string): void {
  const now = "2026-11-20T00:00:00.000Z";
  store.db.prepare(
    `INSERT INTO sources
      (id, kind, provider, display_name, account, root_path, allowed_hosts_json, status, read_only, item_count, last_read_at, last_error_json, created_at, updated_at)
     VALUES ('source-1', 'file', 'local', '本地文件', NULL, NULL, '[]', 'connected', 1, 1, NULL, NULL, ?, ?)`
  ).run(now, now);
  store.db.prepare(
    `INSERT INTO source_items
      (id, source_id, item_key, label, locator, content_path, content_hash, bytes, title, status, coverage_json, duplicate_of, error_json, fetched_at)
     VALUES ('item-1', 'source-1', 'secret', '环境变量', ?, ?, 'hash-secret', 30, '环境变量', 'ready', ?, NULL, NULL, ?)`
  ).run(
    contentPath,
    contentPath,
    JSON.stringify({ complete: true, pages: null, paragraphs: null, sheets: [], gaps: [] }),
    now
  );
}

describe("LibraryIndexer", () => {
  it("indexes Chinese text into chunks and finds it with FTS", async () => {
    const store = new HearthStore(":memory:");
    seedMemory(store, "mem-1", "统一文件树让三个执行器共享同一份项目上下文。");
    const tree = new LibraryTreeService(store);
    const indexer = new LibraryIndexer(store, tree);

    const result = await indexer.indexAll();
    expect(result.indexed).toBeGreaterThanOrEqual(1);
    expect(result.chunks).toBeGreaterThanOrEqual(1);

    const node = tree.getNodeByRef("hearth://memory/mem-1");
    expect(node).not.toBeNull();
    expect(tree.repository.listChunks(node!.id)).toHaveLength(1);
    expect(tree.repository.searchFts("统一文件树").some((hit) => hit.nodeId === node!.id)).toBe(true);
    store.close();
  });

  it("falls back to LIKE for short Chinese queries", async () => {
    const store = new HearthStore(":memory:");
    seedMemory(store, "mem-1", "资料库支持文件搜索。");
    const tree = new LibraryTreeService(store);
    const indexer = new LibraryIndexer(store, tree);
    await indexer.indexAll();

    const node = tree.getNodeByRef("hearth://memory/mem-1");
    expect(tree.repository.searchFts("文件").some((hit) => hit.nodeId === node!.id)).toBe(true);
    store.close();
  });

  it("never indexes credential files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-library-secret-"));
    tempDirs.push(dir);
    const path = join(dir, ".env");
    writeFileSync(path, "OPENAI_API_KEY=sk-secret\n", "utf8");
    const store = new HearthStore(":memory:");
    seedSource(store, path);
    const tree = new LibraryTreeService(store);
    const indexer = new LibraryIndexer(store, tree);

    const result = await indexer.indexAll();
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    const node = tree.getNodeByRef("hearth://source/item-1");
    expect(node?.status).toBe("blocked");
    expect(tree.repository.listChunks(node!.id)).toHaveLength(0);
    expect(tree.repository.searchFts("OPENAI_API_KEY")).toHaveLength(0);
    store.close();
  });

  it("keeps short content as one chunk and overlaps long chunks", () => {
    expect(chunkText("这句话很短。")).toHaveLength(1);
    const text = "一二三四五六七八九十".repeat(400);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]!.text.length).toBe(1_000);
    expect(chunks[0]!.text.slice(-150)).toBe(chunks[1]!.text.slice(0, 150));
    expect(chunks[0]!.endOffset - chunks[1]!.startOffset).toBe(150);
  });

  it("recognizes sensitive file names and directories", () => {
    expect(isSensitivePath("D:/project/.env.local")).toBe(true);
    expect(isSensitivePath("D:/project/config/master.key")).toBe(true);
    expect(isSensitivePath("D:/project/node_modules/pkg/readme.md")).toBe(true);
    expect(isSensitivePath("D:/project/docs/architecture.md")).toBe(false);
  });
});
