import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { MemoryService } from "./memory.ts";
import { HearthService } from "./service.ts";

describe("MemoryService", () => {
  let store: HearthStore;
  let service: HearthService;
  let memory: MemoryService;
  let now: Date;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    service = new HearthService(store);
    now = new Date("2026-11-06T10:00:00.000Z");
    memory = new MemoryService(service, () => now);
  });

  afterEach(() => store.close());

  function createTask(title = "准备项目周报", goal = "整理项目进度并给出发布建议") {
    return service.createTask({ title, goal });
  }

  function createMemory(overrides: Partial<Parameters<MemoryService["create"]>[0]> = {}) {
    return memory.create({
      kind: "project",
      content: "项目代号是 Ember，发布窗口在十一月。",
      subjectKey: "project.ember",
      scope: "global",
      tags: ["项目", "发布"],
      source: { type: "user", id: null, label: "用户说明", excerpt: null },
      confidence: "high",
      sensitivity: "normal",
      allowRecall: true,
      ...overrides
    });
  }

  it("keeps new memories as candidates until the user confirms them", () => {
    const created = createMemory();
    expect(created.status).toBe("candidate");

    const task = createTask();
    expect(memory.recall({ taskId: task.id }).memories).toHaveLength(0);

    const confirmed = memory.confirm(created.id);
    expect(confirmed.status).toBe("active");
    const recalled = memory.recall({ taskId: task.id });
    expect(recalled.memories.map((item) => item.id)).toContain(created.id);
    expect(recalled.contextPack).toContain("<hearth-memories");
    expect(recalled.recalls[0]?.reason).toBeTruthy();
    expect(store.getMemory(created.id)?.recallCount).toBe(1);
  });

  it("enforces recall item and character budgets", () => {
    memory.updateSettings({ maxItems: 1, maxChars: 200 });
    const first = createMemory({ content: "项目 Ember 的发布窗口在十一月。", subjectKey: "project.ember.release" });
    const second = createMemory({ content: "项目 Ember 的负责人是林。", subjectKey: "project.ember.owner" });
    memory.confirm(first.id);
    memory.confirm(second.id);

    const task = createTask();
    const recalled = memory.recall({ taskId: task.id });
    expect(recalled.memories).toHaveLength(1);
    expect(recalled.usedChars).toBeLessThanOrEqual(200);
    expect(recalled.budget).toEqual({ maxItems: 1, maxChars: 200 });
  });

  it("does not recall sensitive or secret memories by default", () => {
    const sensitive = createMemory({ sensitivity: "sensitive", subjectKey: "project.ember.secret" });
    const secret = createMemory({ sensitivity: "secret", subjectKey: "project.ember.token", allowRecall: true });
    memory.confirm(sensitive.id);
    memory.confirm(secret.id);
    const task = createTask();

    expect(memory.recall({ taskId: task.id }).memories.map((item) => item.id)).not.toContain(sensitive.id);
    expect(memory.recall({ taskId: task.id }).memories.map((item) => item.id)).not.toContain(secret.id);

    memory.updateSettings({ allowSensitive: true });
    const allowed = memory.recall({ taskId: task.id }).memories.map((item) => item.id);
    expect(allowed).toContain(sensitive.id);
    expect(allowed).not.toContain(secret.id);
  });

  it("records corrections as versions", () => {
    const created = createMemory();
    memory.confirm(created.id);
    const corrected = memory.correct(created.id, {
      content: "项目代号是 Ember，发布窗口推迟到十二月。",
      reason: "用户更新发布时间"
    });
    expect(corrected.version).toBe(2);
    const versions = store.listMemoryVersions(created.id);
    expect(versions).toHaveLength(2);
    expect(versions.some((item) => item.content.includes("十一月"))).toBe(true);
    expect(versions.some((item) => item.reason === "用户更新发布时间")).toBe(true);
  });

  it("opens a conflict instead of silently overwriting a fact", () => {
    const first = createMemory({ content: "发布窗口在十一月。" });
    memory.confirm(first.id);
    const second = createMemory({ content: "发布窗口在十二月。" });
    const conflicted = memory.confirm(second.id);

    expect(conflicted.status).toBe("conflict");
    expect(store.getMemory(first.id)?.status).toBe("conflict");
    const conflict = store.listMemoryConflicts("pending")[0];
    expect(conflict?.memoryIds).toEqual([first.id, second.id]);

    memory.resolveConflict(conflict!.id, "keep_right", "用户确认十二月");
    expect(store.getMemory(first.id)?.status).toBe("superseded");
    expect(store.getMemory(second.id)?.status).toBe("active");
    expect(store.listMemoryConflicts("pending")).toHaveLength(0);
  });

  it("forgets content, blocks recall, and audit records the tombstone", () => {
    const created = createMemory();
    memory.confirm(created.id);
    const forgotten = memory.forget(created.id, "用户要求删除项目代号");
    expect(forgotten.status).toBe("forgotten");
    expect(forgotten.content).toBe("[已遗忘]");
    expect(forgotten.allowRecall).toBe(false);

    const task = createTask();
    expect(memory.recall({ taskId: task.id }).memories).toHaveLength(0);
    expect(store.listMemoryVersions(created.id)[0]?.reason).toBe("用户要求删除项目代号");
  });

  it("captures experience only when enabled and never duplicates the same task", () => {
    const task = createTask();
    store.appendEvent({ type: "task.updated", taskId: task.id, payload: { status: "completed", resultSummary: "周报已生成" } });
    expect(memory.captureExperience(task.id)).toBeNull();

    memory.updateSettings({ autoCapture: "experience" });
    const captured = memory.captureExperience(task.id);
    expect(captured?.kind).toBe("experience");
    expect(captured?.status).toBe("candidate");
    expect(memory.captureExperience(task.id)?.id).toBe(captured?.id);
    expect(store.listMemories({ kind: "experience" })).toHaveLength(1);
  });

  it("exports source, versions, conflicts, and recall audit", () => {
    const created = createMemory();
    memory.confirm(created.id);
    const task = createTask();
    memory.recall({ taskId: task.id });
    const exported = memory.exportData();
    expect(exported.memories).toHaveLength(1);
    expect(exported.versions).toHaveLength(1);
    expect(exported.recalls).toHaveLength(1);
    expect(exported.memories[0]?.source.label).toBe("用户说明");
  });
});
