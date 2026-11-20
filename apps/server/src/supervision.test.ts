import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@hearth/core";
import { SupervisionService, buildDigest } from "./supervision.ts";

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    templateId: null,
    title: `任务 ${id}`,
    goal: `完成 ${id}`,
    status: "running",
    createdAt: "2026-11-20T08:00:00.000Z",
    updatedAt: "2026-11-20T08:00:00.000Z",
    deadline: null,
    inputs: [],
    networkHosts: [],
    outputDir: `/tmp/${id}`,
    currentRunId: null,
    nextAction: null,
    error: null,
    ...overrides
  };
}

const noon = new Date(2026, 10, 20, 12, 0, 0);

describe("task supervision", () => {
  it("creates unread items for long runs and failed tasks, then dedupes", () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-supervision-"));
    try {
      const service = new SupervisionService(join(root, "supervision.json"), { now: () => noon });
      const tasks = [
        task("slow", { updatedAt: new Date(noon.getTime() - 45 * 60_000).toISOString() }),
        task("failed", { status: "failed", error: { kind: "execution", message: "测试失败", recoverable: true, guidance: "" } })
      ];
      const first = service.tick(tasks);
      expect(first.items.map((item) => item.kind).sort()).toEqual(["failed", "long_running"]);
      const second = service.tick(tasks);
      expect(second.items).toHaveLength(2);
      expect(second.digest).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not notify during quiet hours", () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-supervision-quiet-"));
    try {
      const midnight = new Date(2026, 10, 20, 1, 0, 0);
      const service = new SupervisionService(join(root, "supervision.json"), { now: () => midnight });
      expect(service.tick([task("slow", { updatedAt: new Date(midnight.getTime() - 60 * 60_000).toISOString() })]).items).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks and snoozes an item", () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-supervision-mark-"));
    try {
      const service = new SupervisionService(join(root, "supervision.json"), { now: () => noon });
      const item = service.tick([task("wait", { status: "waiting_approval", updatedAt: new Date(noon.getTime() - 20 * 60_000).toISOString() })]).items[0]!;
      expect(service.mark(item.id, "snooze", 2).items).toHaveLength(0);
      expect(service.mark(item.id, "read").items[0]?.status).toBe("read");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds a yesterday digest with at most three suggestions", () => {
    const yesterday = new Date(2026, 10, 19, 12, 0, 0);
    const digest = buildDigest([
      task("done", { status: "completed", updatedAt: yesterday.toISOString() }),
      task("failed", { status: "failed", updatedAt: yesterday.toISOString() }),
      task("waiting", { status: "waiting_approval" }),
      task("running", { status: "running" })
    ], noon);
    expect(digest.date).toBe("2026-11-20");
    expect(digest.completed).toBe(1);
    expect(digest.failed).toBe(1);
    expect(digest.waitingApproval).toBe(1);
    expect(digest.suggestions.length).toBeLessThanOrEqual(3);
  });
});
