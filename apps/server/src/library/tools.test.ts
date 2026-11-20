import { describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { LibraryService } from "./service.ts";
import { createLibraryTools } from "./tools.ts";

const ctx = {} as never;

function seedMemory(store: HearthStore): void {
  const now = "2026-11-20T00:00:00.000Z";
  store.db.prepare(
    `INSERT INTO memories
      (id, kind, status, content, subject_key, scope, tags_json, source_json, confidence, sensitivity,
       allow_recall, version, created_at, updated_at, recall_count, content_hash)
     VALUES ('mem-tool', 'fact', 'active', '三个执行器共享同一个资料库。', '共享资料', 'global', '[]', ?, 'high', 'normal', 1, 1, ?, ?, 0, 'hash-tool')`
  ).run(JSON.stringify({ type: "user", id: null, label: "用户", excerpt: null }), now, now);
}

describe("library tools", () => {
  it("search, read, summarize and browse the shared library", async () => {
    const store = new HearthStore(":memory:");
    seedMemory(store);
    const library = new LibraryService(store);
    await library.reindex();
    const tools = createLibraryTools(library);
    const find = (name: string) => tools.find((tool) => tool.definition.name === name)!;

    const search = await find("library_search").execute({ query: "资料库" }, ctx);
    expect(search.isError).toBeUndefined();
    expect(search.content).toContain("hearth://memory/mem-tool");

    const read = await find("library_read").execute({ node: "hearth://memory/mem-tool" }, ctx);
    expect(read.content).toContain("三个执行器共享同一个资料库");

    const summary = await find("library_summary").execute({ node: "记忆" }, ctx);
    expect(summary.content).toContain("记忆");

    const tree = await find("library_tree").execute({ depth: 1 }, ctx);
    expect(tree.content).toContain("技能");
    library.stop();
    store.close();
  });
});
