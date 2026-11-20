import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { bufferToEmbedding, cosineSimilarity, embeddingToBuffer, LocalEmbeddingProvider } from "./embedding.ts";
import { LibraryService } from "./service.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeProvider(): LocalEmbeddingProvider {
  const cacheDir = mkdtempSync(join(tmpdir(), "hearth-embedding-"));
  tempDirs.push(cacheDir);
  return new LocalEmbeddingProvider({
    cacheDir,
    modelId: "test/bge",
    loader: async () => async (texts: string[]) => ({
      tolist: () => texts.map((text, index) => {
        const vector = new Array<number>(512).fill(0);
        vector[0] = 1;
        vector[1] = text.length === 0 ? 0 : 1 / (index + 1);
        return vector;
      })
    })
  });
}

function seedMemory(store: HearthStore): void {
  const now = "2026-11-20T00:00:00.000Z";
  store.db.prepare(
    `INSERT INTO memories
      (id, kind, status, content, subject_key, scope, tags_json, source_json, confidence, sensitivity,
       allow_recall, version, created_at, updated_at, recall_count, content_hash)
     VALUES ('mem-embed', 'fact', 'active', '本地语义模型可以在离线时帮助找回资料。', '语义', 'global', '[]', ?, 'high', 'normal', 1, 1, ?, ?, 0, 'hash-embed')`
  ).run(JSON.stringify({ type: "user", id: null, label: "用户", excerpt: null }), now, now);
}

function semanticProvider(): LocalEmbeddingProvider {
  const cacheDir = mkdtempSync(join(tmpdir(), "hearth-semantic-"));
  tempDirs.push(cacheDir);
  return new LocalEmbeddingProvider({
    cacheDir,
    modelId: "test/semantic",
    loader: async () => async (texts: string[]) => ({
      tolist: () => texts.map((text) => {
        const vector = new Array<number>(512).fill(0);
        vector[/互联网|网络/.test(text) ? 0 : 1] = 1;
        return vector;
      })
    })
  });
}

function seedMemoryWith(store: HearthStore, id: string, content: string): void {
  const now = "2026-11-20T00:00:00.000Z";
  store.db.prepare(
    `INSERT INTO memories
      (id, kind, status, content, subject_key, scope, tags_json, source_json, confidence, sensitivity,
       allow_recall, version, created_at, updated_at, recall_count, content_hash)
     VALUES (?, 'fact', 'active', ?, ?, 'global', '[]', ?, 'high', 'normal', 1, 1, ?, ?, 0, ?)`
  ).run(
    id, content, id,
    JSON.stringify({ type: "user", id: null, label: "用户", excerpt: null }),
    now, now, `hash-${id}`
  );
}

describe("library embeddings", () => {
  it("round-trips vectors and computes cosine similarity", () => {
    const left = Float32Array.from({ length: 512 }, (_, index) => index === 0 ? 1 : 0);
    const right = Float32Array.from({ length: 512 }, (_, index) => index === 0 ? 1 : 0);
    const restored = bufferToEmbedding(embeddingToBuffer(left));
    expect(restored).toEqual(left);
    expect(cosineSimilarity(left, right)).toBeCloseTo(1, 5);
  });

  it("fills missing chunk embeddings during library refresh", async () => {
    const store = new HearthStore(":memory:");
    seedMemory(store);
    const library = new LibraryService(store, { embeddingProvider: fakeProvider() });

    const result = await library.reindex();
    expect(result.semanticError).toBeNull();
    expect(result.embedded).toBe(1);
    const node = library.tree.getNodeByRef("hearth://memory/mem-embed");
    expect(library.tree.repository.listChunks(node!.id)[0]?.embedding).not.toBeNull();
    expect(library.tree.repository.countEmbeddedChunks("test/bge")).toBe(1);
    expect(library.status().semanticReady).toBe(true);
    library.stop();
    store.close();
  });

  it("returns vector-only hits when the query has no lexical overlap", async () => {
    const store = new HearthStore(":memory:");
    seedMemoryWith(store, "mem-relevant", "Hearth 内置的检索能力不依赖互联网连接。");
    seedMemoryWith(store, "mem-other", "今天适合整理桌面。");
    const library = new LibraryService(store, { embeddingProvider: semanticProvider() });

    await library.reindex();
    const result = await library.search("没有网络时还能找到以前写下的东西吗");
    expect(result.semanticUsed).toBe(true);
    expect(result.hits[0]?.node.ref).toBe("hearth://memory/mem-relevant");
    expect(result.hits[0]?.matchedBy).toBe("vector");
    library.stop();
    store.close();
  });
});
