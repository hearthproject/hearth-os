import { describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import type { TaskRecord } from "@hearth/core";
import { LibraryTreeService } from "./tree.ts";

function task(id = "task-1"): TaskRecord {
  return {
    id,
    templateId: "T01",
    title: "整理项目资料",
    goal: "把项目资料整理成可检索的知识",
    status: "queued",
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
    deadline: null,
    inputs: [],
    networkHosts: [],
    outputDir: ".hearth/artifacts/task-1",
    currentRunId: null,
    nextAction: null,
    error: null
  };
}

function seed(store: HearthStore): void {
  const now = "2026-11-05T00:00:00.000Z";
  store.db.prepare(
    `INSERT INTO memories
      (id, kind, status, content, subject_key, scope, tags_json, source_json, confidence, sensitivity,
       allow_recall, version, created_at, updated_at, recall_count, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "mem-1", "fact", "active", "用户偏好简洁的中文回答。", "回答风格", "global", "[]",
    JSON.stringify({ type: "user", id: null, label: "用户", excerpt: null }), "high", "normal", 1, 1, now, now, 0, "hash-memory"
  );
  store.appendEvent({ type: "task.created", taskId: "task-1", payload: task() });
  store.db.prepare(
    `INSERT INTO sources
      (id, kind, provider, display_name, account, root_path, allowed_hosts_json, status, read_only, item_count, last_read_at, last_error_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, '[]', 'connected', 1, 1, NULL, NULL, ?, ?)`
  ).run("source-1", "knowledge", "local", "项目文档", now, now);
  store.db.prepare(
    `INSERT INTO source_items
      (id, source_id, item_key, label, locator, content_path, content_hash, bytes, title, status, coverage_json, duplicate_of, error_json, fetched_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'ready', ?, NULL, NULL, ?)`
  ).run("item-1", "source-1", "doc-1", "架构说明", "docs/architecture.md", "hash-item", 1200, "架构说明", JSON.stringify({ complete: true, pages: null, paragraphs: 10, sheets: [], gaps: [] }), now);
  store.appendEvent({
    type: "artifact.published",
    taskId: "task-1",
    runId: "run-1",
    payload: {
      id: "artifact-1", taskId: "task-1", runId: "run-1", relativePath: "result.md",
      absolutePath: "C:/tmp/result.md", mimeType: "text/markdown", sha256: "hash-artifact",
      bytes: 42, createdAt: now
    }
  });
  store.upsertLocalProject({ id: "project-1", name: "Hearth", path: "D:/App/hearth-os", defaultBranch: "main", createdAt: now, updatedAt: now });
}

describe("LibraryTreeService", () => {
  it("projects memories, tasks, sources, artifacts and projects into stable nodes", () => {
    const store = new HearthStore(":memory:");
    seed(store);
    const tree = new LibraryTreeService(store);
    expect(tree.syncAll().nodes).toBeGreaterThanOrEqual(9);

    const roots = tree.buildTree(1);
    expect(roots.map((node) => node.title)).toEqual(["记忆", "任务", "资料", "技能", "项目"]);

    const memory = tree.getNodeByRef("hearth://memory/mem-1");
    expect(memory?.path).toContain("记忆/事实/");
    expect(memory?.metadata.memoryId).toBe("mem-1");

    const taskNode = tree.getNodeByRef("hearth://task/task-1");
    expect(taskNode?.path).toContain("任务/进行中/");
    expect(taskNode?.projectId).toBeNull();

    const sourceItem = tree.getNodeByRef("hearth://source/item-1");
    expect(sourceItem?.path).toContain("资料/来源/项目文档");

    const artifact = tree.getNodeByRef("hearth://artifact/artifact-1");
    expect(artifact?.path).toContain("资料/产物/整理项目资料");

    const project = tree.getNodeByRef("hearth://project/project-1");
    expect(project?.path).toContain("项目/Hearth");
    store.close();
  });

  it("returns child counts and one level of children", () => {
    const store = new HearthStore(":memory:");
    seed(store);
    const tree = new LibraryTreeService(store);
    tree.syncAll();
    const memoryRoot = tree.buildTree(1).find((node) => node.title === "记忆");
    expect(memoryRoot?.childCount).toBe(1);
    const withChildren = tree.buildTree(2).find((node) => node.title === "记忆");
    expect(withChildren?.children?.[0]?.title).toContain("回答风格");
    store.close();
  });
});
