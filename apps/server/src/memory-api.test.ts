import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";

describe("memory API", () => {
  let store: HearthStore;

  beforeEach(() => {
    store = new HearthStore(":memory:");
  });

  afterEach(() => store.close());

  function payload(content: string, subjectKey = "project.ember") {
    return {
      kind: "project",
      content,
      subjectKey,
      tags: ["项目"],
      source: { type: "user", id: null, label: "用户说明", excerpt: null },
      confidence: "high",
      sensitivity: "normal",
      allowRecall: true
    };
  }

  it("creates, confirms, recalls, corrects, exports, and forgets memory", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const created = await app.inject({ method: "POST", url: "/api/memory", payload: payload("项目 Ember 在十一月发布。") });
    expect(created.statusCode).toBe(201);
    const memoryId = created.json().id as string;
    expect(created.json().status).toBe("candidate");

    const confirmed = await app.inject({ method: "POST", url: "/api/memory/" + memoryId + "/confirm" });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().status).toBe("active");

    const task = await app.inject({ method: "POST", url: "/api/tasks", payload: { title: "准备 Ember 周报", goal: "整理 Ember 项目发布进度" } });
    const recall = await app.inject({ method: "POST", url: "/api/memory/recall", payload: { taskId: task.json().id } });
    expect(recall.statusCode).toBe(200);
    expect(recall.json().memories).toHaveLength(1);
    expect(recall.json().recalls[0].reason).toContain("主题");

    const corrected = await app.inject({
      method: "PATCH",
      url: "/api/memory/" + memoryId,
      payload: { content: "项目 Ember 推迟到十二月发布。", reason: "用户更新窗口" }
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json().version).toBe(2);

    const exported = await app.inject({ method: "GET", url: "/api/memory/export" });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-disposition"]).toContain("hearth-memories-");
    expect(exported.json().versions).toHaveLength(2);

    const forgotten = await app.inject({ method: "POST", url: "/api/memory/" + memoryId + "/forget" });
    expect(forgotten.statusCode).toBe(200);
    expect(forgotten.json().status).toBe("forgotten");
    const snapshot = await app.inject({ method: "GET", url: "/api/memory" });
    expect(snapshot.json().forgets[0].memoryId).toBe(memoryId);
    expect(snapshot.json().forgets[0].targets.every((target: { status: string }) => target.status === "complete")).toBe(true);
    const forgottenExport = await app.inject({ method: "GET", url: "/api/memory/export" });
    const forgottenExportText = forgottenExport.body;
    expect(forgottenExportText).not.toContain("Ember");
    expect(forgottenExportText).not.toContain("project.ember");
    await app.close();
  });

  it("requires explicit conflict resolution", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const first = await app.inject({ method: "POST", url: "/api/memory", payload: payload("发布窗口在十一月。") });
    await app.inject({ method: "POST", url: "/api/memory/" + first.json().id + "/confirm" });
    const second = await app.inject({ method: "POST", url: "/api/memory", payload: payload("发布窗口在十二月。") });
    const conflicted = await app.inject({ method: "POST", url: "/api/memory/" + second.json().id + "/confirm" });
    expect(conflicted.statusCode).toBe(200);
    expect(conflicted.json().status).toBe("conflict");

    const snapshot = await app.inject({ method: "GET", url: "/api/memory" });
    const conflict = snapshot.json().conflicts[0];
    expect(snapshot.json().memories.filter((item: { status: string }) => item.status === "conflict")).toHaveLength(2);
    expect(conflict.memoryIds).toHaveLength(2);

    const resolved = await app.inject({
      method: "POST",
      url: "/api/memory/conflicts/" + conflict.id + "/resolve",
      payload: { resolution: "keep_right", note: "用户确认十二月" }
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().status).toBe("resolved");
    await app.close();
  });

  it("validates settings and supports sensitive recall controls", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const invalid = await app.inject({ method: "PATCH", url: "/api/memory/settings", payload: { maxItems: 100 } });
    expect(invalid.statusCode).toBe(400);

    const settings = await app.inject({ method: "PATCH", url: "/api/memory/settings", payload: { autoCapture: "experience", maxItems: 3 } });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().maxItems).toBe(3);

    const created = await app.inject({
      method: "POST",
      url: "/api/memory",
      payload: { ...payload("敏感的项目预算。"), sensitivity: "sensitive", subjectKey: "project.ember.budget" }
    });
    const marked = await app.inject({
      method: "POST",
      url: "/api/memory/" + created.json().id + "/sensitive",
      payload: { sensitivity: "sensitive", allowRecall: false }
    });
    expect(marked.statusCode).toBe(200);
    expect(marked.json().allowRecall).toBe(false);
    await app.close();
  });
});
