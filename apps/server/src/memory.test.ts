import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConversationSettings } from "@hearth/core";
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

  it("persists provenance, trust, taint, retention, and a content hash", () => {
    const created = createMemory({
      tier: "episodic",
      originClass: "web",
      sourceKind: "webpage",
      sourceRef: "https://example.com/notes",
      sessionId: "session-1",
      trust: "low",
      taint: "suspected",
      importance: 0.7,
      retention: "30d",
      lastVerifiedAt: now.toISOString(),
      expiresAt: "2026-12-06T10:00:00.000Z",
      source: { type: "source", id: "source-1", label: "网页摘录", excerpt: "项目代号是 Ember" }
    });

    const loaded = store.getMemory(created.id);
    expect(loaded).toMatchObject({
      tier: "episodic",
      originClass: "web",
      sourceKind: "webpage",
      sourceRef: "https://example.com/notes",
      sessionId: "session-1",
      trust: "low",
      taint: "suspected",
      importance: 0.7,
      retention: "30d",
      lastVerifiedAt: now.toISOString(),
      expiresAt: "2026-12-06T10:00:00.000Z"
    });
    expect(loaded?.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const corrected = memory.correct(created.id, { content: "项目代号是 Ember，来源仍待核验。", reason: "补充来源" });
    expect(corrected.contentHash).not.toBe(loaded?.contentHash);
    expect(store.listMemoryVersions(created.id)[0]?.contentHash).toBe(corrected.contentHash);
  });

  it("recalls memories for a conversation and records a chat audit id", () => {
    const conversation = store.createConversation("Ember 发布计划", defaultConversationSettings());
    const created = createMemory();
    memory.confirm(created.id);

    const recalled = memory.recallForConversation({
      conversationId: conversation.id,
      text: "发布窗口是什么时候？"
    });

    expect(recalled.memories.map((item) => item.id)).toContain(created.id);
    expect(recalled.recalls[0]?.taskId).toBe(`chat:${conversation.id}`);
    expect(store.listMemoryRecalls(created.id)[0]?.taskId).toBe(`chat:${conversation.id}`);
    expect(recalled.contextPack).toContain("<hearth-memories");
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
    const task = createTask("准备 Ember 项目周报", "整理 Ember 项目代号和发布时间");
    memory.recall({ taskId: task.id });
    memory.correct(created.id, { content: "项目代号是 Ember，发布窗口推迟到十二月。", reason: "用户更新发布时间" });
    const forgotten = memory.forget(created.id, "用户要求删除项目代号");
    expect(forgotten.status).toBe("forgotten");
    expect(forgotten.content).toBe("[已遗忘]");
    expect(forgotten.subjectKey).toBe("forgotten:" + created.id);
    expect(forgotten.source.label).toBe("[已遗忘]");
    expect(forgotten.allowRecall).toBe(false);

    expect(memory.recall({ taskId: task.id }).memories).toHaveLength(0);
    const versions = store.listMemoryVersions(created.id);
    expect(versions[0]?.reason).toBe("用户要求删除项目代号");
    expect(versions.every((version) => version.content === "[已遗忘]")).toBe(true);
    expect(versions.every((version) => version.source.label === "[已遗忘]" && version.tags.length === 0)).toBe(true);

    const exported = memory.exportData();
    const exportedText = JSON.stringify(exported);
    expect(exportedText).not.toContain("Ember");
    expect(exportedText).not.toContain("十一月");
    expect(exportedText).not.toContain("project.ember");
    expect(exported.recalls[0]?.reason).toBe("[记忆已遗忘]");

    const eventText = JSON.stringify(store.listEvents().filter((event) => event.type.startsWith("memory.")));
    expect(eventText).not.toContain("Ember");
    expect(eventText).not.toContain("十一月");
    expect(eventText).not.toContain("project.ember");

    const receipt = exported.forgets[0];
    expect(receipt?.memoryId).toBe(created.id);
    expect(receipt?.redactedVersions).toBeGreaterThanOrEqual(3);
    expect(receipt?.redactedEvents).toBeGreaterThan(0);
    expect(receipt?.targets.every((target) => target.status === "complete")).toBe(true);
  });

  it("captures and activates experience automatically without duplicating the same task", () => {
    const task = createTask();
    store.appendEvent({ type: "task.updated", taskId: task.id, payload: { status: "completed", resultSummary: "周报已生成" } });
    expect(memory.settings().autoCapture).toBe("experience");
    const captured = memory.captureExperience(task.id);
    expect(captured?.kind).toBe("experience");
    expect(captured?.status).toBe("active");
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
