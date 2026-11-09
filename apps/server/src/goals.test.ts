import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { HearthService } from "./service.ts";

describe("goal contracts", () => {
  let root: string | null = null;
  let store: HearthStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("persists objective, criteria and next handoff across a store restart", () => {
    root = mkdtempSync(join(tmpdir(), "hearth-goals-"));
    const path = join(root, "hearth.sqlite");
    store = new HearthStore(path);
    const service = new HearthService(store);
    const goal = service.createGoal({
      title: "每周研究摘要",
      objective: "每周一产出过去七天的研究摘要，并保留可核验来源",
      constraints: ["只读取已授权来源"],
      forbiddenActions: ["未经审批发送邮件"],
      successCriteria: [
        {
          id: "summary",
          description: "摘要文件存在且包含来源链接",
          validator: "schema",
          check: "research-summary.json",
          required: true
        }
      ],
      evidenceRequirements: ["research-summary.json"],
      reviewPolicy: "human_on_complete",
      currentState: "active"
    });
    const updated = service.updateGoal(goal.goalId, { nextHandoff: "完成后等待用户确认再发送" });
    expect(updated.nextHandoff).toBe("完成后等待用户确认再发送");

    const task = service.createTask({ title: "本周摘要", goalId: goal.goalId, executorId: "native" });
    expect(task.goalId).toBe(goal.goalId);
    service.recordCompletionReport({
      goalId: goal.goalId,
      taskId: task.id,
      verdict: "needs_human",
      summary: "等待用户确认",
      criteria: [{ criterionId: "summary", status: "passed", evidenceRefs: ["research-summary.json"], detail: "ok" }],
      evidenceRefs: ["research-summary.json"],
      missingEvidence: [],
      forbiddenActions: [],
      checkedAt: "2026-11-09T00:00:00.000Z"
    });
    store.close();
    store = new HearthStore(path);
    const reopened = new HearthService(store);
    expect(reopened.getGoal(goal.goalId)).toMatchObject({
      objective: "每周一产出过去七天的研究摘要，并保留可核验来源",
      nextHandoff: "完成后等待用户确认再发送",
      currentState: "active",
      successCriteria: [{ id: "summary", required: true }]
    });
    expect(reopened.view(task.id)?.goal?.goalId).toBe(goal.goalId);
    expect(reopened.view(task.id)?.task.goalId).toBe(goal.goalId);
    expect(reopened.view(task.id)?.completionReport).toMatchObject({ verdict: "needs_human", checkedAt: "2026-11-09T00:00:00.000Z" });
  });

  it("rejects duplicate or incomplete criteria", () => {
    root = mkdtempSync(join(tmpdir(), "hearth-goals-"));
    store = new HearthStore(join(root, "hearth.sqlite"));
    const service = new HearthService(store);
    expect(() => service.createGoal({
      title: "bad",
      objective: "bad",
      successCriteria: [
        { id: "same", description: "one", validator: "file", check: "a", required: true },
        { id: "same", description: "two", validator: "file", check: "b", required: true }
      ]
    })).toThrow(/Duplicate goal criterion/);
    expect(() => service.createGoal({
      title: "bad",
      objective: "bad",
      successCriteria: [{ id: "missing", description: "", validator: "file", check: "a", required: true }]
    })).toThrow(/description and check/);
  });
});
