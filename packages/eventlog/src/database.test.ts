import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskRecord } from "@hearth/core";
import { HearthStore } from "./database.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-eventlog-"));
  tempDirs.push(dir);
  return join(dir, "hearth.sqlite");
}

function task(id = "task-1"): TaskRecord {
  return {
    id, templateId: "T01", title: "Meeting notes", goal: "Summarize a meeting", status: "queued",
    createdAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:00.000Z", deadline: null,
    inputs: [{ kind: "file", label: "transcript", value: "eval/inputs/T01-meeting-transcript.md" }],
    networkHosts: [], outputDir: "eval/runs/T01", currentRunId: null, nextAction: "开始执行", error: null
  };
}

describe("HearthStore", () => {
  it("appends events and updates projections", () => {
    const store = new HearthStore(":memory:");
    store.appendEvent({ type: "task.created", taskId: "task-1", payload: task() });
    store.appendEvent({ type: "task.updated", taskId: "task-1", payload: { status: "running", updatedAt: "2026-11-05T00:01:00.000Z" } });
    expect(store.getTask("task-1")?.status).toBe("running");
    expect(store.listEvents()).toHaveLength(2);
    store.close();
  });

  it("rebuilds projections and survives reopening", () => {
    const path = tempDb();
    const store = new HearthStore(path);
    store.appendEvent({ type: "task.created", taskId: "task-1", payload: task() });
    store.appendEvent({ type: "task.updated", taskId: "task-1", payload: { status: "running", updatedAt: "2026-11-05T00:01:00.000Z" } });
    store.rebuildProjections();
    expect(store.getTask("task-1")?.status).toBe("running");
    store.close();
    const reopened = new HearthStore(path);
    expect(reopened.getTask("task-1")?.status).toBe("running");
    reopened.close();
  });
});
