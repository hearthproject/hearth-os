import { describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { computeDogfood, renderDogfoodMarkdown } from "./dogfood.ts";

const now = new Date("2026-11-20T12:00:00.000Z");

function seed(store: HearthStore): void {
  const task = {
    id: "task-dogfood",
    templateId: null,
    title: "修一个测试",
    goal: "让测试通过",
    status: "completed",
    createdAt: "2026-11-19T09:00:00.000Z",
    updatedAt: "2026-11-19T09:30:00.000Z",
    deadline: null,
    inputs: [],
    networkHosts: [],
    outputDir: "/tmp/task-dogfood",
    currentRunId: "run-1",
    nextAction: null,
    error: null,
    projectId: "hearth-os"
  };
  store.appendEvent({ type: "task.created", taskId: task.id, payload: task, createdAt: task.createdAt });
  for (const attempt of [1, 2]) {
    store.appendEvent({
      type: "run.created",
      taskId: task.id,
      runId: `run-${attempt}`,
      payload: {
        id: `run-${attempt}`,
        taskId: task.id,
        attempt,
        status: attempt === 1 ? "failed" : "completed",
        threadId: null,
        workspace: "/tmp/task-dogfood",
        startedAt: "2026-11-19T09:00:00.000Z",
        endedAt: "2026-11-19T09:30:00.000Z",
        failure: null,
        usage: { inputTokens: 100, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 0, turns: 3, toolCalls: 5 },
        leaseEpoch: null,
        createdAt: "2026-11-19T09:00:00.000Z"
      },
      createdAt: "2026-11-19T09:00:00.000Z"
    });
  }
  store.appendEvent({
    type: "approval.created",
    taskId: task.id,
    runId: "run-2",
    payload: {
      id: "approval-1",
      taskId: task.id,
      runId: "run-2",
      kind: "shell",
      summary: "运行测试",
      target: {},
      preview: {},
      parameterHash: "abc",
      status: "approved",
      expiresAt: "2026-11-19T10:00:00.000Z",
      decidedAt: "2026-11-19T09:10:00.000Z",
      effectId: null,
      createdAt: "2026-11-19T09:05:00.000Z"
    },
    createdAt: "2026-11-19T09:05:00.000Z"
  });
}

describe("dogfood report", () => {
  it("sums runs, tokens and approvals for a project window", () => {
    const store = new HearthStore(":memory:");
    try {
      seed(store);
      const report = computeDogfood(store, { days: 3, projectId: "hearth-os", now });
      expect(report.totals.tasks).toBe(1);
      expect(report.totals.completed).toBe(1);
      expect(report.totals.attempts).toBe(2);
      expect(report.totals.successRate).toBe(1);
      expect(report.totals.firstPassRate).toBe(0);
      expect(report.totals.inputTokens).toBe(200);
      expect(report.totals.toolCalls).toBe(10);
      expect(report.totals.approved).toBe(1);
      expect(report.friction.retriedTasks).toHaveLength(1);
      const markdown = renderDogfoodMarkdown(report);
      expect(markdown).toContain("# Hearth dogfood report");
      expect(markdown).toContain("first-attempt success: 0%");
      expect(markdown).toContain("not a public benchmark");
    } finally {
      store.close();
    }
  });
});
