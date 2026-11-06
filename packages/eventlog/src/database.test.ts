import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactRecord, OutboxDraft, RunRecord, TaskRecord } from "@hearth/core";
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

  it("pages audit reads without truncation and skips unrecorded usage", () => {
    const store = new HearthStore(":memory:");
    const usage = { inputTokens: 900, cachedInputTokens: 100, cacheWriteInputTokens: 0, outputTokens: 90, reasoningOutputTokens: 9 };
    const first: RunRecord = {
      id: "run-1", taskId: "task-1", attempt: 1, status: "failed", threadId: null, workspace: "w",
      startedAt: "2026-11-05T00:00:00.000Z", endedAt: null, failure: null, usage: null, createdAt: "2026-11-05T00:00:00.000Z"
    };
    const second: RunRecord = {
      ...first, id: "run-2", attempt: 2, status: "completed", threadId: "thread-2",
      startedAt: "2026-11-05T00:01:00.000Z", endedAt: "2026-11-05T00:02:00.000Z", usage, createdAt: "2026-11-05T00:01:00.000Z"
    };
    const artifact: ArtifactRecord = {
      id: "artifact-1", taskId: "task-1", runId: "run-2", relativePath: "notes.md", absolutePath: "/tmp/notes.md",
      mimeType: "text/markdown; charset=utf-8", sha256: "b".repeat(64), bytes: 2048, createdAt: "2026-11-05T00:02:00.000Z"
    };
    store.appendEvent({ type: "task.created", taskId: "task-1", payload: task() });
    store.appendEvent({ type: "run.created", taskId: "task-1", runId: "run-1", payload: first });
    store.appendEvent({ type: "run.created", taskId: "task-1", runId: "run-2", payload: second });
    store.appendEvent({ type: "artifact.published", taskId: "task-1", runId: "run-2", payload: artifact });

    expect(store.countEvents()).toBe(4);
    expect(store.listEventsWindow({ limit: 3 }).map((event) => event.seq)).toEqual([2, 3, 4]);
    expect(store.listEventsWindow({ limit: 3, afterSeq: 3, taskId: "task-1" }).map((event) => event.seq)).toEqual([4]);
    expect(store.listEventsWindow({ limit: 2, beforeSeq: 4, taskId: "task-1" }).map((event) => event.seq)).toEqual([2, 3]);
    expect(store.listEventsWindow({ limit: 10, type: "run.created" })).toHaveLength(2);
    expect(store.latestEventSeq()).toBe(4);

    const page = store.listRunsPage({ limit: 1, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.runs.map((run) => run.id)).toEqual(["run-2"]);
    expect(store.listRunsPage({ limit: 10, offset: 0, taskId: "task-1", status: "failed" }).runs.map((run) => run.id)).toEqual(["run-1"]);

    expect(store.usageTotals()).toEqual(usage);
    expect(store.runDurationTotals()).toEqual({ ms: 60_000, counted: 1, uncounted: 1 });
    expect(store.runAggregatesByTask().get("task-1")).toEqual({ runs: 2, lastDurationMs: 60_000, lastUsage: usage });
    expect(store.artifactTotals()).toEqual({ count: 1, bytes: 2048 });
    expect(store.artifactCountsByTask().get("task-1")).toBe(1);
    expect(store.countRunsByStatus()).toEqual({
      queued: 0, running: 0, waiting_input: 0, waiting_approval: 0, completed: 1, failed: 1, cancelled: 0
    });
    expect(store.countApprovalsByStatus()).toEqual({ pending: 0, approved: 0, rejected: 0, expired: 0 });
    expect(store.countEffectsByStatus().uncertain).toBe(0);
    store.close();
  });

  it("projects local outbox drafts through the event log", () => {
    const store = new HearthStore(":memory:");
    const createdAt = "2026-11-06T01:00:00.000Z";
    const draft: OutboxDraft = {
      id: "draft-1",
      account: "local-test",
      to: ["reviewer@example.test"],
      cc: [],
      bcc: [],
      subject: "Weekly update",
      body: "Draft body",
      attachments: [],
      status: "draft",
      taskId: null,
      approvalId: null,
      effectId: null,
      createdAt,
      updatedAt: createdAt,
      submittedAt: null,
      discardedAt: null
    };
    store.appendEvent({ type: "outbox.created", payload: draft });
    store.appendEvent({
      type: "outbox.updated",
      payload: { id: draft.id, status: "pending_approval", approvalId: "approval-1", updatedAt: "2026-11-06T01:01:00.000Z" }
    });

    expect(store.getOutboxDraft(draft.id)).toMatchObject({
      subject: "Weekly update",
      to: ["reviewer@example.test"],
      status: "pending_approval",
      approvalId: "approval-1"
    });

    store.rebuildProjections();
    expect(store.listOutboxDrafts()).toHaveLength(1);
    expect(store.getOutboxDraft(draft.id)?.status).toBe("pending_approval");
    store.close();
  });
});
