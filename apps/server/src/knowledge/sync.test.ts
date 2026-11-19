import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryRecord, SourceItem, TaskRecord } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { SecretBox } from "../secrets.ts";
import { KnowledgeClient, type KnowledgeWriteInput } from "./client.ts";
import { KnowledgeSettingsStore } from "./settings.ts";
import { KnowledgeSyncService, memoryDocument, taskDocument } from "./sync.ts";

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-1", kind: "preference", status: "active", content: "所有总结使用简体中文", subjectKey: "输出语言",
    scope: "global", tags: [], allowRecall: true, version: 1, supersedesId: null, derivedFromId: null,
    validUntil: null, updatedAt: "2026-11-19T00:00:00.000Z", lastRecalledAt: null, recallCount: 0,
    tier: "curated", originClass: "user", sourceKind: "user", sourceRef: "user", sessionId: null,
    trust: "high", taint: "clean", sensitivity: "normal", confidence: "high", importance: 0.8,
    retention: "permanent", supersessionKey: null, contentHash: "hash", createdAt: "2026-11-19T00:00:00.000Z",
    lastVerifiedAt: null, expiresAt: null,
    source: { type: "user", id: null, label: "用户", excerpt: null },
    ...overrides
  };
}

function completedTask(): TaskRecord {
  return {
    id: "task-1", templateId: null, title: "修复 OAuth 回调", goal: "定位并修复 500", status: "completed",
    createdAt: "2026-11-19T00:00:00.000Z", updatedAt: "2026-11-19T01:00:00.000Z", deadline: null,
    inputs: [], networkHosts: [], outputDir: ".hearth/artifacts/task-1", currentRunId: null,
    nextAction: null, error: null, resultSummary: "已修复并加测试", executorId: "codex"
  };
}

function sourceItem(root: string): SourceItem {
  const path = join(root, "doc.md");
  writeFileSync(path, "部署说明：端口 4317。", "utf8");
  return {
    id: "src-item-1", sourceId: "src-1", itemKey: "docs/deploy.md", label: "deploy",
    locator: "file:///docs/deploy.md", contentPath: path, contentHash: "sha256:abc", bytes: 30,
    title: "部署文档", status: "ready",
    coverage: { complete: true, pages: null, paragraphs: null, sheets: [], gaps: [] },
    duplicateOf: null, error: null, fetchedAt: "2026-11-19T00:00:00.000Z"
  };
}

describe("KnowledgeSyncService", () => {
  let store: HearthStore;
  let settings: KnowledgeSettingsStore;
  let root: string;
  const writes: KnowledgeWriteInput[] = [];
  const removes: string[] = [];

  beforeEach(() => {
    store = new HearthStore(":memory:");
    settings = new KnowledgeSettingsStore(store, new SecretBox(Buffer.alloc(32, 4)));
    root = mkdtempSync(join(tmpdir(), "hearth-knowledge-sync-"));
    writes.length = 0;
    removes.length = 0;
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function service(): KnowledgeSyncService {
    const client = {
      write: async (input: KnowledgeWriteInput) => {
        writes.push(input);
        return { uri: input.uri };
      },
      remove: async (uri: string) => {
        removes.push(uri);
      }
    };
    return new KnowledgeSyncService({
      store,
      settings,
      clientFactory: () => client as unknown as KnowledgeClient
    });
  }

  it("does nothing while knowledge is disabled", async () => {
    const sync = service();
    expect(sync.enqueueMemory(memory())).toBe(false);
    expect(await sync.flush()).toEqual({ written: 0, failed: 0, skipped: 0 });
  });

  it("writes a curated memory once and records the mapping", async () => {
    settings.update({ enabled: true });
    const record = memory();
    store.appendEvent({ type: "memory.updated", payload: record });
    const sync = service();
    expect(sync.enqueueMemory(record)).toBe(true);
    expect(sync.enqueueMemory(record)).toBe(false);
    const flushed = await sync.flush();
    expect(flushed.written).toBe(1);
    expect(writes[0]?.uri).toContain("viking://user/default/memories/");
    expect(writes[0]?.tags).toContain("source=hearth");
    expect(store.knowledgeMapGet("mem-1")?.uri).toBe(writes[0]?.uri);
  });

  it("skips secret and untrusted memories", async () => {
    settings.update({ enabled: true });
    const sync = service();
    expect(sync.enqueueMemory(memory({ sensitivity: "secret" }))).toBe(false);
    expect(sync.enqueueMemory(memory({ taint: "tainted" }))).toBe(false);
    expect(sync.enqueueMemory(memory({ originClass: "untrusted" }))).toBe(false);
  });

  it("writes completed tasks with an acceptance and result section", async () => {
    settings.update({ enabled: true });
    const task = completedTask();
    store.appendEvent({ type: "task.created", taskId: task.id, payload: task });
    const sync = service();
    expect(sync.enqueueTask({ ...task, status: "running" })).toBe(false);
    expect(sync.enqueueTask(task)).toBe(true);
    await sync.flush();
    expect(writes[0]?.uri).toBe("viking://resources/hearth/tasks/task-1/task.md");
    expect(writes[0]?.content).toContain("## 结果");
    expect(taskDocument(task).content).toContain("## 验收");
  });

  it("writes ready source items from their content path", async () => {
    settings.update({ enabled: true });
    const item = sourceItem(root);
    store.appendEvent({ type: "source.item.updated", payload: item });
    const sync = service();
    expect(sync.enqueueSource(item)).toBe(true);
    await sync.flush();
    expect(writes[0]?.content).toContain("部署说明");
    expect(writes[0]?.uri).toContain("viking://resources/hearth/sources/src-1/");
  });

  it("redacts secrets and exposes a stable hash", () => {
    const doc = memoryDocument(memory({ content: "api_key: sk-abcdefgh12345" }));
    expect(doc.content).not.toContain("sk-abcdefgh12345");
    expect(doc.contentHash).toHaveLength(64);
  });

  it("deletes the indexed file and mapping after a memory is forgotten", async () => {
    settings.update({ enabled: true });
    const record = memory();
    store.appendEvent({ type: "memory.updated", payload: record });
    const sync = service();
    sync.enqueueMemory(record);
    await sync.flush();
    const uri = writes[0]?.uri;
    expect(uri).toBeTruthy();

    expect(sync.enqueueDelete("memory", record.id)).toBe(true);
    expect(sync.enqueueDelete("memory", record.id)).toBe(false);
    const deleted = await sync.flush();
    expect(deleted.written).toBe(1);
    expect(removes).toEqual([uri]);
    expect(store.knowledgeMapGet(record.id)).toBeNull();
  });
});
