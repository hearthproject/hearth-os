import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatAttachment, TaskRecord } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";

const roots: string[] = [];

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `hearth-${label}-`));
  roots.push(root);
  return root;
}

function seedTask(store: HearthStore, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const record: TaskRecord = {
    id: "task-trash",
    templateId: "T01",
    title: "回收站任务",
    goal: "验证回收站",
    status: "completed",
    createdAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z",
    deadline: null,
    inputs: [],
    networkHosts: [],
    outputDir: ".hearth/artifacts/task-trash",
    currentRunId: null,
    nextAction: null,
    error: null,
    ...overrides
  };
  store.appendEvent({ type: "task.created", taskId: record.id, payload: record });
  return record;
}

function attachment(id: string, name: string): ChatAttachment {
  return { id, name, mimeType: "text/plain", bytes: 1 };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("trash API", () => {
  let store: HearthStore;
  let dataDir: string;
  let attachmentRoot: string;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    dataDir = tempRoot("trash-data");
    attachmentRoot = tempRoot("trash-attachments");
  });

  afterEach(() => store.close());

  it("soft deletes a conversation with its tasks and restores the batch", async () => {
    const app = await buildServer({ store, serveWeb: false, dataDir, attachmentRoot });
    const conversation = store.createConversation("待删除对话");
    const linked = seedTask(store, { id: "task-linked", title: "联动任务", conversationId: conversation.id });
    store.createChatMessage({
      id: "message-linked",
      conversationId: conversation.id,
      role: "user",
      content: "恢复后仍应看到这条消息",
      taskId: linked.id,
      attachments: [],
      createdAt: "2026-11-08T00:01:00.000Z"
    });

    const deleted = await app.inject({ method: "DELETE", url: `/api/conversations/${conversation.id}` });
    expect(deleted.statusCode).toBe(204);
    expect(store.getConversation(conversation.id)).toBeNull();
    expect(store.getTask(linked.id)).toBeNull();

    const trash = await app.inject({ method: "GET", url: "/api/trash" });
    expect(trash.statusCode).toBe(200);
    expect(trash.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "conversation", id: conversation.id }),
      expect.objectContaining({ kind: "task", id: linked.id, conversationId: conversation.id })
    ]));

    const restored = await app.inject({
      method: "POST",
      url: "/api/trash/restore",
      payload: { items: [{ kind: "conversation", id: conversation.id }] }
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().restoredTasks).toContain(linked.id);
    expect(store.getTask(linked.id)?.status).toBe("completed");
    expect(store.listChatMessages(conversation.id)).toHaveLength(1);
    await app.close();
  });

  it("requires confirmation before deleting running tasks or conversations", async () => {
    const app = await buildServer({ store, serveWeb: false, dataDir, attachmentRoot });
    const conversation = store.createConversation("运行中的对话");
    const running = seedTask(store, { id: "task-running", conversationId: conversation.id, status: "running" });
    const taskConflict = await app.inject({ method: "DELETE", url: `/api/tasks/${running.id}` });
    expect(taskConflict.statusCode).toBe(409);
    expect(taskConflict.json()).toMatchObject({ error: "TASK_RUNNING", runningTaskIds: [running.id] });

    const cancelled = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${running.id}`,
      payload: { cancelRunning: true }
    });
    expect(cancelled.statusCode).toBe(204);
    expect(store.getTask(running.id, { includeDeleted: true })?.status).toBe("cancelled");

    const second = store.createConversation("另一个运行中的对话");
    const secondTask = seedTask(store, { id: "task-running-2", conversationId: second.id, status: "running" });
    const conversationConflict = await app.inject({ method: "DELETE", url: `/api/conversations/${second.id}` });
    expect(conversationConflict.statusCode).toBe(409);
    expect(conversationConflict.json()).toMatchObject({
      error: "TASK_RUNNING",
      runningTaskIds: [secondTask.id]
    });
    const conversationCancelled = await app.inject({
      method: "DELETE",
      url: `/api/conversations/${second.id}`,
      payload: { cancelRunning: true }
    });
    expect(conversationCancelled.statusCode).toBe(204);
    expect(store.getTask(secondTask.id, { includeDeleted: true })?.status).toBe("cancelled");
    await app.close();
  });

  it("purges only managed paths and preserves shared attachments and the git cache", async () => {
    const app = await buildServer({ store, serveWeb: false, dataDir, attachmentRoot });
    const externalRoot = tempRoot("trash-external");
    const externalOutput = join(externalRoot, "user-owned.txt");
    writeFileSync(externalOutput, "must survive purge");

    const target = store.createConversation("彻底删除");
    const retained = store.createConversation("保留对话");
    const taskId = "task-purged";
    seedTask(store, {
      id: taskId,
      conversationId: target.id,
      outputDir: externalRoot
    });

    const owned = randomUUID();
    const shared = randomUUID();
    writeFileSync(join(attachmentRoot, `${owned}.txt`), "owned attachment");
    writeFileSync(join(attachmentRoot, `${shared}.txt`), "shared attachment");
    store.createChatMessage({
      id: "message-owned",
      conversationId: target.id,
      role: "user",
      content: "仅此对话引用",
      taskId,
      attachments: [attachment(owned, "owned.txt"), attachment(shared, "shared.txt")],
      createdAt: "2026-11-08T00:02:00.000Z"
    });
    store.createChatMessage({
      id: "message-shared",
      conversationId: retained.id,
      role: "user",
      content: "保留共享附件",
      taskId: null,
      attachments: [attachment(shared, "shared.txt")],
      createdAt: "2026-11-08T00:03:00.000Z"
    });

    const workspaceTask = join(dataDir, "workspaces", "tasks", taskId);
    const checkpoint = join(workspaceTask, ".hearth", "checkpoints", "run-1", "1.json");
    const artifact = join(dataDir, "artifacts", taskId, "result.md");
    const gitCache = join(dataDir, "git-cache", "shared-repository");
    mkdirSync(join(workspaceTask, ".hearth", "checkpoints", "run-1"), { recursive: true });
    mkdirSync(join(dataDir, "artifacts", taskId), { recursive: true });
    mkdirSync(gitCache, { recursive: true });
    writeFileSync(checkpoint, "{}");
    writeFileSync(artifact, "# result");
    writeFileSync(join(gitCache, "HEAD"), "shared");

    store.softDeleteConversation(target.id);
    const purged = await app.inject({
      method: "POST",
      url: "/api/trash/purge",
      payload: { items: [{ kind: "conversation", id: target.id }] }
    });
    expect(purged.statusCode, purged.body).toBe(200);
    expect(purged.json()).toMatchObject({ purgedConversations: 1, purgedTasks: 1, removedAttachments: 1 });
    expect(store.getConversation(target.id, { includeDeleted: true })).toBeNull();
    expect(store.getTask(taskId, { includeDeleted: true })).toBeNull();
    expect(existsSync(workspaceTask)).toBe(false);
    expect(existsSync(join(dataDir, "artifacts", taskId))).toBe(false);
    expect(existsSync(externalOutput)).toBe(true);
    expect(existsSync(join(gitCache, "HEAD"))).toBe(true);
    expect(existsSync(join(attachmentRoot, `${owned}.txt`))).toBe(false);
    expect(existsSync(join(attachmentRoot, `${shared}.txt`))).toBe(true);
    await app.close();
  });
});
