import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConversationSettings, mergeConversationSettings } from "@hearth/core";
import type {
  ArtifactRecord,
  DesktopCommandRecord,
  DesktopFrameRecord,
  DesktopSessionRecord,
  DevicePairingRequest,
  DeviceRecord,
  OutboxDraft,
  RunCheckpointRecord,
  RunRecord,
  TaskRecord
} from "@hearth/core";
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
    inputs: [{ kind: "text", label: "transcript", value: "Meeting decided to split evaluation tooling." }],
    networkHosts: [], outputDir: ".hearth/artifacts/T01", currentRunId: null, nextAction: "开始执行", error: null
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
    store.appendEvent({
      type: "task.updated",
      taskId: "task-1",
      payload: {
        status: "running",
        pinnedAt: "2026-11-05T00:01:00.000Z",
        archivedAt: "2026-11-05T00:02:00.000Z",
        updatedAt: "2026-11-05T00:02:00.000Z"
      }
    });
    store.rebuildProjections();
    expect(store.getTask("task-1")?.status).toBe("running");
    expect(store.getTask("task-1")?.pinnedAt).toBe("2026-11-05T00:01:00.000Z");
    expect(store.getTask("task-1")?.archivedAt).toBe("2026-11-05T00:02:00.000Z");
    store.close();
    const reopened = new HearthStore(path);
    expect(reopened.getTask("task-1")?.status).toBe("running");
    expect(reopened.getTask("task-1")?.pinnedAt).toBe("2026-11-05T00:01:00.000Z");
    expect(reopened.getTask("task-1")?.archivedAt).toBe("2026-11-05T00:02:00.000Z");
    reopened.close();
  });

  it("migrates a schema v8 database without losing tasks, runs, or checkpoints", () => {
    const path = tempDb();
    const createdAt = "2026-11-05T00:00:00.000Z";
    const run: RunRecord = {
      id: "run-1", taskId: "task-1", attempt: 1, status: "completed", threadId: "thread-1", workspace: "workspace/tasks/task-1",
      startedAt: createdAt, endedAt: createdAt, failure: null, usage: null, leaseEpoch: 1, createdAt,
      executorId: "native", checkpointSeq: 1
    };
    const checkpoint: RunCheckpointRecord = {
      id: "checkpoint-1", runId: "run-1", taskId: "task-1", seq: 1, kind: "tool",
      path: ".hearth/checkpoints/run-1/1.json", sha256: "c".repeat(64), usage: null, createdAt
    };
    const store = new HearthStore(path);
    store.appendEvent({ type: "task.created", taskId: "task-1", payload: task() });
    store.appendEvent({ type: "run.created", taskId: "task-1", runId: "run-1", payload: run });
    store.createRunCheckpoint(checkpoint);
    store.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DROP TABLE IF EXISTS context_items;
      DROP TABLE IF EXISTS task_context_state;
      DROP TABLE IF EXISTS handoffs;
      DROP TABLE IF EXISTS context_settings;
      DROP TABLE IF EXISTS method_applications;
      DROP INDEX IF EXISTS method_candidates_fingerprint_idx;
      ALTER TABLE runs DROP COLUMN parent_run_id;
      ALTER TABLE runs DROP COLUMN handoff_id;
      ALTER TABLE tasks DROP COLUMN method_id;
      ALTER TABLE tasks DROP COLUMN method_version;
      ALTER TABLE method_candidates DROP COLUMN generation;
      ALTER TABLE method_candidates DROP COLUMN fingerprint;
      PRAGMA user_version = 8;
    `);
    legacy.close();

    const migrated = new HearthStore(path);
    expect(migrated.getTask("task-1")?.title).toBe("Meeting notes");
    expect(migrated.listRuns("task-1")[0]?.id).toBe("run-1");
    expect(migrated.listRunCheckpoints("run-1")[0]?.sha256).toBe("c".repeat(64));
    expect(migrated.getContextSettings().mode).toBe("on");

    const handoffRun: RunRecord = {
      ...run, id: "run-2", attempt: 2, parentRunId: "run-1", handoffId: "handoff-1"
    };
    migrated.appendEvent({ type: "run.created", taskId: "task-1", runId: "run-2", payload: handoffRun });
    const loaded = migrated.listRuns("task-1").find((item) => item.id === "run-2");
    expect(loaded?.parentRunId).toBe("run-1");
    expect(loaded?.handoffId).toBe("handoff-1");

    const pinned = { ...task("task-2"), methodId: "method-1", methodVersion: 1 };
    migrated.appendEvent({ type: "task.created", taskId: "task-2", payload: pinned });
    expect(migrated.getTask("task-2")?.methodId).toBe("method-1");
    expect(migrated.getTask("task-2")?.methodVersion).toBe(1);
    migrated.insertMethodApplication({
      id: "application-1", taskId: "task-2", runId: "run-3", methodId: "method-1",
      methodVersion: 1, selection: "pinned", promptSha256: "d".repeat(64), createdAt
    });
    expect(migrated.listMethodApplications({ taskId: "task-2" })).toHaveLength(1);

    const item = migrated.appendContextItem({
      seq: 0, id: "context-1", conversationId: null, taskId: "task-1", runId: "run-2",
      executorId: "codex", kind: "assistant_message", role: "assistant", content: "continued",
      contentRef: null, sha256: null, tokens: 1, sensitivity: "normal", provenance: {},
      parentId: null, executorEventId: null, createdAt
    });
    expect(item.seq).toBe(1);
    migrated.close();
  });

  it("stores method generations and keeps applications across projection rebuilds", () => {
    const store = new HearthStore(":memory:");
    const createdAt = "2026-11-05T00:00:00.000Z";
    store.appendEvent({
      type: "method.candidate.created",
      payload: {
        id: "method-1", name: "方法", summary: "摘要", applicability: "T01", steps: ["执行"],
        sourceTaskIds: ["task-1"], templateId: "T01", status: "adopted", version: 1,
        generation: 2, fingerprint: "f".repeat(64), previousVersionId: null,
        allowedCapabilities: [], guardrails: [],
        baseline: { tasks: 0, completed: 0, failed: 0, successRate: null, avgDurationMs: null, inputTokens: 0, outputTokens: 0, approvals: 0 },
        trial: { tasks: 0, completed: 0, failed: 0, successRate: null, avgDurationMs: null, inputTokens: 0, outputTokens: 0, approvals: 0 },
        evaluationVerdict: null, createdAt, updatedAt: createdAt, adoptedAt: createdAt, retiredAt: null
      }
    });
    expect(store.getMethodCandidate("method-1")?.generation).toBe(2);
    expect(store.getMethodCandidate("method-1")?.fingerprint).toBe("f".repeat(64));
    store.insertMethodApplication({
      id: "application-1", taskId: "task-1", runId: "run-1", methodId: "method-1",
      methodVersion: 1, selection: "auto_template", promptSha256: "e".repeat(64), createdAt
    });
    store.rebuildProjections();
    expect(store.getMethodCandidate("method-1")?.generation).toBe(2);
    expect(store.listMethodApplications({ taskId: "task-1" })).toHaveLength(1);
    store.close();
  });

  it("pages audit reads without truncation and skips unrecorded usage", () => {
    const store = new HearthStore(":memory:");
    const usage = { inputTokens: 900, cachedInputTokens: 100, cacheWriteInputTokens: 0, outputTokens: 90, reasoningOutputTokens: 9 };
    const first: RunRecord = {
      id: "run-1", taskId: "task-1", attempt: 1, status: "failed", threadId: null, workspace: "w",
      startedAt: "2026-11-05T00:00:00.000Z", endedAt: null, failure: null, usage: null, leaseEpoch: null, createdAt: "2026-11-05T00:00:00.000Z"
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
    expect(store.countApprovalsByStatus()).toEqual({ pending: 0, approved: 0, rejected: 0, consumed: 0, expired: 0, revoked: 0 });
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

  it("projects device pairing, capability, frame, and command state", () => {
    const store = new HearthStore(":memory:");
    const at = "2026-11-06T02:00:00.000Z";
    const pairing: DevicePairingRequest = {
      id: "pair-1", code: "123456", secretHash: "a".repeat(64), deviceTokenHash: "b".repeat(64),
      name: "Test Desktop", platform: "windows", version: "1.0.0",
      requestedApps: ["notepad"], requestedCapabilities: ["observe", "desktop.control"],
      status: "approved", deviceId: "device-1", expiresAt: "2026-11-06T02:10:00.000Z",
      createdAt: at, updatedAt: at
    };
    const device: DeviceRecord = {
      id: "device-1", pairingRequestId: pairing.id, name: pairing.name, platform: "windows",
      version: pairing.version, status: "offline", tokenHash: pairing.deviceTokenHash,
      capabilities: [{
        kind: "observe", status: "approved", apps: ["notepad"], requestedAt: at,
        approvedAt: at, revokedAt: null
      }],
      lastSeenAt: null, createdAt: at, updatedAt: at
    };
    const session: DesktopSessionRecord = {
      id: "session-1", deviceId: device.id, status: "active", controlEpoch: 1,
      currentFrameId: "frame-1", lastError: null, createdAt: at, updatedAt: at, terminatedAt: null
    };
    const frame: DesktopFrameRecord = {
      id: "frame-1", deviceId: device.id, sessionId: session.id, mimeType: "image/jpeg",
      width: 800, height: 600, sha256: "c".repeat(64), bytes: 1000,
      storagePath: ".hearth/device-frames/device-1/frame-1.jpg", activeApp: "notepad",
      windowTitle: "Untitled - Notepad", capturedAt: at, expiresAt: "2026-11-06T02:02:00.000Z"
    };
    const command: DesktopCommandRecord = {
      id: "command-1", deviceId: device.id, sessionId: session.id, kind: "observe",
      status: "queued", frameId: null, controlEpoch: 1, payload: {}, result: null, error: null,
      createdAt: at, updatedAt: at, completedAt: null
    };

    store.appendEvent({ type: "device.pairing-requested", payload: pairing });
    store.appendEvent({ type: "device.paired", payload: device });
    store.appendEvent({ type: "desktop.session.created", payload: session });
    store.appendEvent({ type: "desktop.frame.updated", payload: frame });
    store.appendEvent({ type: "desktop.command.created", payload: command });

    expect(store.getPairingRequest(pairing.id)?.deviceId).toBe(device.id);
    expect(store.getDeviceByTokenHash(device.tokenHash)?.capabilities[0]).toMatchObject({ kind: "observe", apps: ["notepad"] });
    expect(store.getDesktopSession(session.id)?.currentFrameId).toBe(frame.id);
    expect(store.listDesktopFrames(session.id)[0]?.activeApp).toBe("notepad");
    expect(store.nextQueuedDesktopCommand(device.id)?.kind).toBe("observe");

    store.rebuildProjections();
    expect(store.listDevices()).toHaveLength(1);
    expect(store.listDesktopSessions()).toHaveLength(1);
    expect(store.listDesktopCommands(session.id)).toHaveLength(1);
    store.close();
  });

  it("persists conversation settings and fills defaults for legacy rows", () => {
    const path = tempDb();
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO conversations (id, title, created_at, updated_at)
      VALUES ('legacy-conv', '旧对话', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    `);
    raw.close();

    const store = new HearthStore(path);
    expect(store.getConversation("legacy-conv")?.settings).toEqual(defaultConversationSettings());

    const conversation = store.createConversation("新对话");
    expect(conversation.settings).toEqual(defaultConversationSettings());
    const partial = store.updateConversationSettings(conversation.id, { executorEnabled: { codex: false } });
    expect(partial?.settings).toEqual(
      mergeConversationSettings(defaultConversationSettings(), { executorEnabled: { codex: false } })
    );
    const full = store.updateConversationSettings(conversation.id, { approvalMode: "full" });
    expect(full?.settings).toEqual(
      mergeConversationSettings(defaultConversationSettings(), { executorEnabled: { codex: false }, approvalMode: "full" })
    );

    store.createChatMessage({
      id: "status-1",
      conversationId: conversation.id,
      role: "assistant",
      content: "任务开始执行。",
      taskId: "task-1",
      attachments: [],
      createdAt: "2026-11-07T00:00:00.000Z",
      kind: "task_status",
      taskStatus: "running"
    });
    expect(store.listChatMessages(conversation.id)[0]).toMatchObject({
      kind: "task_status",
      taskStatus: "running",
      taskId: "task-1"
    });
    store.close();
  });

  it("soft deletes conversations with their tasks and restores the linked batch", () => {
    const store = new HearthStore(":memory:");
    const conversation = store.createConversation("可恢复对话");
    const linkedTask = { ...task("task-linked"), conversationId: conversation.id };
    store.appendEvent({ type: "task.created", taskId: linkedTask.id, payload: linkedTask });
    store.createChatMessage({
      id: "message-1",
      conversationId: conversation.id,
      role: "user",
      content: "保留这条消息直到彻底删除",
      taskId: linkedTask.id,
      attachments: [],
      createdAt: "2026-11-07T00:00:00.000Z"
    });

    const deleted = store.softDeleteConversation(conversation.id);
    expect(deleted?.taskIds).toEqual([linkedTask.id]);
    expect(store.getConversation(conversation.id)).toBeNull();
    expect(store.getTask(linkedTask.id)).toBeNull();
    expect(store.listTrash()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "conversation", id: conversation.id, trashBatchId: deleted?.batchId }),
      expect.objectContaining({ kind: "task", id: linkedTask.id, trashBatchId: deleted?.batchId })
    ]));
    expect(store.listChatMessages(conversation.id)).toHaveLength(1);

    const restored = store.restoreConversation(conversation.id);
    expect(restored?.taskIds).toEqual([linkedTask.id]);
    expect(store.getConversation(conversation.id)?.deletedAt).toBeNull();
    expect(store.getTask(linkedTask.id)?.deletedAt).toBeNull();
    expect(store.listTrash()).toEqual([]);
    store.close();
  });

  it("restores a deleted parent conversation with a deleted task", () => {
    const store = new HearthStore(":memory:");
    const conversation = store.createConversation("父对话");
    const linkedTask = { ...task("task-parent"), conversationId: conversation.id };
    store.appendEvent({ type: "task.created", taskId: linkedTask.id, payload: linkedTask });
    store.softDeleteConversation(conversation.id);

    const restored = store.restoreTask(linkedTask.id);
    expect(restored?.conversationId).toBe(conversation.id);
    expect(store.getTask(linkedTask.id)?.deletedAt).toBeNull();
    expect(store.getConversation(conversation.id)?.deletedAt).toBeNull();
    expect(store.listTrash()).toEqual([]);
    store.close();
  });

  it("filters trash by 7, 15 and 30 day age buckets", () => {
    const path = tempDb();
    const store = new HearthStore(path);
    const oldConversation = store.createConversation("30 天前");
    const recentConversation = store.createConversation("刚刚删除");
    store.softDeleteConversation(oldConversation.id);
    store.softDeleteConversation(recentConversation.id);
    store.close();

    const raw = new DatabaseSync(path);
    const oldAt = new Date(Date.now() - 40 * 24 * 60 * 60_000).toISOString();
    raw.prepare("UPDATE conversations SET deleted_at = ? WHERE id = ?").run(oldAt, oldConversation.id);
    raw.close();

    const reopened = new HearthStore(path);
    for (const days of [7, 15, 30]) {
      expect(reopened.listTrash("all", days).map((item) => item.id)).toEqual([oldConversation.id]);
    }
    expect(reopened.listTrash("all", null).map((item) => item.id)).toEqual(
      expect.arrayContaining([oldConversation.id, recentConversation.id])
    );
    expect(reopened.listTrash("task", null)).toEqual([]);
    reopened.close();
  });

  it("overwrites a model profile API key with null instead of keeping the old cipher", () => {
    const store = new HearthStore(":memory:");
    const record = {
      id: "profile-1",
      name: "Chat model",
      providerId: "custom",
      providerName: "Custom",
      protocol: "openai-chat" as const,
      baseUrl: "https://example.com/v1",
      model: "chat-model",
      contextWindowTokens: 128_000,
      maxOutputTokens: 8_000,
      apiKeyCipher: "cipher-old",
      isLocal: false,
      createdAt: "2026-11-07T00:00:00.000Z",
      updatedAt: "2026-11-07T00:00:00.000Z"
    };
    store.upsertModelProfile(record);
    store.upsertModelProfile({ ...record, apiKeyCipher: null, updatedAt: "2026-11-07T00:01:00.000Z" });
    expect(store.getModelProfile("profile-1")?.apiKeyCipher).toBeNull();
    store.close();
  });

  it("does not persist empty task permissions as an explicit tool deny-list", () => {
    const store = new HearthStore(":memory:");
    store.appendEvent({ type: "task.created", taskId: "task-plain", payload: task("task-plain") });
    expect(store.getTask("task-plain")?.permissions).toBeUndefined();

    const explicit = {
      ...task("task-explicit"),
      permissions: { readRoots: ["/tmp"], writeRoots: [], networkHosts: [], tools: ["read_file"] }
    };
    store.appendEvent({ type: "task.created", taskId: "task-explicit", payload: explicit });
    expect(store.getTask("task-explicit")?.permissions?.tools).toEqual(["read_file"]);

    const legacyEmpty = {
      ...task("task-legacy"),
      permissions: { readRoots: [], writeRoots: [], networkHosts: [], tools: [] }
    };
    store.appendEvent({ type: "task.created", taskId: "task-legacy", payload: legacyEmpty });
    expect(store.getTask("task-legacy")?.permissions).toBeUndefined();
    store.close();
  });
});
