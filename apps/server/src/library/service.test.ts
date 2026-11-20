import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LibraryTreeNode } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { LibraryService } from "./service.ts";

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

function flatten(nodes: LibraryTreeNode[]): LibraryTreeNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

describe("LibraryService", () => {
  it("searches, previews and restores a trashed memory", async () => {
    const store = new HearthStore(":memory:");
    seedMemory(store, "mem-1", "统一文件树让三个执行器共享同一份项目上下文。");
    const library = new LibraryService(store);

    const result = await library.search("统一文件树");
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.node.ref).toBe("hearth://memory/mem-1");
    expect(library.getNodeDetails(result.hits[0]!.node.id).document?.content).toContain("三个执行器");

    const entry = library.removeNode(result.hits[0]!.node.id);
    expect(library.tree.getNode(result.hits[0]!.node.id)).toBeNull();
    expect((await library.search("统一文件树")).hits).toHaveLength(0);
    expect(library.listTrash().map((item) => item.id)).toContain(entry.id);

    library.restoreTrash(entry.id);
    expect(library.tree.getNodeByRef("hearth://memory/mem-1")).not.toBeNull();
    expect((await library.search("统一文件树")).hits).toHaveLength(1);
    library.stop();
    store.close();
  });

  it("scans a local folder into the shared tree but hides credential files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-library-root-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "项目地图.md"), "# 项目地图\n\n执行器共享技能和资料。\n", "utf8");
    writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=sk-secret\n", "utf8");
    const store = new HearthStore(":memory:");
    const library = new LibraryService(store);
    embeddedRoot(library, dir);

    const tree = library.tree.buildTree(5);
    const nodes = flatten(tree);
    expect(nodes.some((node) => node.title === "项目地图.md")).toBe(true);
    expect(nodes.some((node) => node.title === ".env")).toBe(false);

    const result = await library.search("共享技能");
    expect(result.hits.some((hit) => hit.node.title === "项目地图.md")).toBe(true);
    library.stop();
    store.close();
  });
});

function embeddedRoot(library: LibraryService, dir: string): void {
  library.tree.addRoot(dir);
}
