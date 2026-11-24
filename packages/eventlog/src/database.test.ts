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
  GoalContract,
  GoalRoundRecord,
  PlanRecord,
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

  it("adds the background_processes table when upgrading a v39 database", () => {
    const path = tempDb();
    const store = new HearthStore(path);
    store.close();

    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE IF EXISTS background_processes; PRAGMA user_version = 39;");
    legacy.close();

    const migrated = new HearthStore(path);
    const row = migrated.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'background_processes'"
    ).get() as { name?: string } | undefined;
    expect(row?.name).toBe("background_processes");
    migrated.close();
  });

  it("adds conversation context tables when upgrading a v42 database", () => {
    const path = tempDb();
    const store = new HearthStore(path);
    store.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DROP TABLE IF EXISTS conversation_compactions;
      DROP TABLE IF EXISTS conversation_context_state;
      PRAGMA user_version = 42;
    `);
    legacy.close();

    const migrated = new HearthStore(path);
    const tables = migrated.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('conversation_context_state', 'conversation_compactions')"
    ).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name).sort()).toEqual([
      "conversation_compactions",
      "conversation_context_state"
    ]);
    migrated.close();
  });

  it("migrates v43 goal, round, and plan rows without losing readable state", () => {
    const path = tempDb();
    const store = new HearthStore(path);
    const legacyGoal: GoalContract = {
      goalId: "goal-v43",
      title: "Legacy goal",
      objective: "Preserve the original request",
      originalObjective: "Preserve the original request",
      constraints: [],
      forbiddenActions: [],
      authoritySources: [{ kind: "user", ref: "conversation-v43" }],
      successCriteria: [],
      evidenceRequirements: [],
      budget: {},
      stopConditions: [],
      reviewPolicy: "human_on_risk",
      currentState: "active",
      createdAt: "2026-11-23T00:00:00.000Z",
      updatedAt: "2026-11-23T00:00:00.000Z",
      conversationId: "conversation-v43",
      taskId: "task-v43",
      armed: true,
      roundCount: 1,
      revision: 3,
      contractRevision: 0,
      executionRevision: 0,
      amendments: [],
      execution: { executorId: "native", taskKind: "general", expectedOutputs: [], networkHosts: [] }
    };
    store.appendEvent({ type: "goal.created", taskId: "task-v43", payload: legacyGoal });
    const round: GoalRoundRecord = {
      id: "round-v43",
      goalId: "goal-v43",
      taskId: "task-v43",
      index: 1,
      runIds: ["run-v43"],
      status: "completed",
      startedAt: "2026-11-23T00:00:00.000Z",
      endedAt: "2026-11-23T00:01:00.000Z",
      summary: "legacy round",
      intent: null,
      artifactRefs: [],
      evidenceRefs: ["run:run-v43"],
      usage: null,
      progressDigest: "legacy-digest",
      verifier: null,
      workspaceRoot: "C:/legacy/workspace",
      outDir: "C:/legacy/out",
      executionFence: null
    };
    store.appendEvent({ type: "goal.round.settled", taskId: "task-v43", runId: "run-v43", payload: round });
    const plan: PlanRecord = {
      id: "plan-v43",
      conversationId: "conversation-v43",
      projectId: null,
      title: "Legacy plan",
      objective: "Keep old plans readable",
      stage: "awaiting_approval",
      planningTaskId: "task-plan-v43",
      executionTaskId: null,
      planMarkdown: "## Legacy plan\n\n- preserved",
      planPath: "C:/legacy/plan.md",
      planSha256: null,
      planningAttempt: 0,
      planningRunId: null,
      revision: 1,
      createdAt: "2026-11-23T00:00:00.000Z",
      updatedAt: "2026-11-23T00:01:00.000Z",
      approvedAt: null,
      completedAt: null,
      error: null
    };
    store.appendEvent({ type: "plan.created", taskId: "task-plan-v43", payload: plan });
    store.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      ALTER TABLE goals DROP COLUMN original_objective;
      ALTER TABLE goals DROP COLUMN contract_revision;
      ALTER TABLE goals DROP COLUMN execution_revision;
      ALTER TABLE goals DROP COLUMN amendments_json;
      ALTER TABLE goal_rounds DROP COLUMN execution_fence_json;
      ALTER TABLE plans DROP COLUMN plan_sha256;
      ALTER TABLE plans DROP COLUMN planning_attempt;
      ALTER TABLE plans DROP COLUMN planning_run_id;
      PRAGMA user_version = 43;
    `);
    legacy.close();

    const migrated = new HearthStore(path);
    const loadedGoal = migrated.getGoal("goal-v43");
    expect(loadedGoal).toMatchObject({
      objective: "Preserve the original request",
      originalObjective: "Preserve the original request",
      contractRevision: 0,
      executionRevision: 0,
      amendments: []
    });
    expect(migrated.latestGoalRound("goal-v43")).toMatchObject({ status: "completed", executionFence: null });
    expect(migrated.getPlan("plan-v43")).toMatchObject({
      planMarkdown: "## Legacy plan\n\n- preserved",
      planSha256: null,
      planningAttempt: 0,
      planningRunId: null
    });
    migrated.close();
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

  it("creates the library schema and skill install columns", () => {
    const store = new HearthStore(":memory:");
    const tables = new Set(
      (store.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: string }>)
        .map((row) => row.name)
    );
    for (const table of [
      "context_nodes",
      "context_documents",
      "context_chunks",
      "context_chunks_fts",
      "context_summaries",
      "library_roots",
      "library_trash",
      "library_jobs",
      "library_settings",
      "approval_grants",
      "run_operations"
    ]) {
      expect(tables.has(table)).toBe(true);
    }
    const skillColumns = new Set(
      (store.db.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>).map((row) => row.name)
    );
    for (const column of ["source_url", "source_ref", "read_only", "permissions_json", "actions_json", "last_checked_at"]) {
      expect(skillColumns.has(column)).toBe(true);
    }
    store.close();
  });

  it("persists T1/T2 operations and rejects replay", () => {
    const store = new HearthStore(":memory:");
    const input = {
      operationId: "run-1:call-1",
      runId: "run-1",
      taskId: "task-1",
      toolCallId: "call-1",
      toolName: "write_file",
      argsHash: "args-1",
      effect: "local_write",
      beforeDigest: "before-1",
      permissionsDigest: "permissions-1"
    } as const;
    const prepared = store.prepareRunOperation(input);
    expect(prepared.phase).toBe("prepared");
    expect(store.prepareRunOperation(input).operationId).toBe(prepared.operationId);

    const dispatched = store.dispatchRunOperation(prepared.operationId, "2026-11-21T10:00:00.000Z");
    expect(dispatched.phase).toBe("dispatched");
    expect(dispatched.dispatchedAt).toBe("2026-11-21T10:00:00.000Z");
    expect(() => store.dispatchRunOperation(prepared.operationId)).toThrow(/already dispatched/);

    const settled = store.settleRunOperation({
      operationId: prepared.operationId,
      phase: "settled",
      resultDigest: "result-1",
      outputRef: "out/result.md",
      effectRef: "effect-1",
      receipt: { ok: true },
      settledAt: "2026-11-21T10:00:01.000Z"
    });
    expect(settled.phase).toBe("settled");
    expect(settled.receipt).toEqual({ ok: true });
    expect(store.settleRunOperation({
      operationId: prepared.operationId,
      phase: "settled",
      resultDigest: "result-1",
      settledAt: "2026-11-21T10:00:01.000Z"
    }).phase).toBe("settled");
    expect(() => store.settleRunOperation({
      operationId: prepared.operationId,
      phase: "settled",
      resultDigest: "different"
    })).toThrow(/different outcome/);
    expect(store.listUnsettledRunOperations("run-1")).toHaveLength(0);
    store.close();
  });

  it("records checkpoint event sequences and queries runtime events per run", () => {
    const store = new HearthStore(":memory:");
    const start = store.appendEvent({
      type: "runtime.run.started",
      taskId: "task-1",
      runId: "run-1",
      payload: { type: "run.start", runId: "run-1", goal: "g" }
    });
    const checkpoint: RunCheckpointRecord = {
      id: "checkpoint-event-1", runId: "run-1", taskId: "task-1", seq: 1, kind: "turn",
      path: ".hearth/checkpoints/run-1/0001-turn.json", sha256: "d".repeat(64), usage: null,
      eventSeq: start.seq, createdAt: "2026-11-21T10:00:00.000Z"
    };
    store.createRunCheckpoint(checkpoint);
    const message = store.appendEvent({
      type: "runtime.message",
      taskId: "task-1",
      runId: "run-1",
      payload: { type: "message", message: { role: "assistant", content: "after checkpoint" } }
    });
    expect(store.latestRunCheckpoint("run-1")?.eventSeq).toBe(start.seq);
    expect(store.getEventBySeq(start.seq)?.type).toBe("runtime.run.started");
    expect(store.listEventsForRun("run-1", start.seq).map((event) => event.seq)).toEqual([message.seq]);
    expect(store.listEventsForRun("run-2")).toHaveLength(0);
    store.close();
  });

  it("reopens dispatched operations as unsettled", () => {
    const path = tempDb();
    const store = new HearthStore(path);
    const prepared = store.prepareRunOperation({
      operationId: "run-2:call-2",
      runId: "run-2",
      taskId: "task-2",
      toolCallId: "call-2",
      toolName: "shell",
      argsHash: "args-2",
      effect: "local_write"
    });
    store.dispatchRunOperation(prepared.operationId);
    store.close();

    const reopened = new HearthStore(path);
    expect(reopened.getRunOperation(prepared.operationId)?.phase).toBe("dispatched");
    expect(reopened.listUnsettledRunOperations("run-2")).toHaveLength(1);
    reopened.close();
  });

  it("persists goal metadata and rounds across reopen", () => {
    const path = tempDb();
    const store = new HearthStore(path);
    const goal: GoalContract = {
      goalId: "goal-1", title: "Ship goal mode", objective: "Make goals durable",
      constraints: ["no breaking changes"], forbiddenActions: ["force push"],
      authoritySources: [{ kind: "user", ref: "conversation-1" }],
      successCriteria: [{ id: "c1", description: "tests pass", validator: "llm_review", check: "tests", required: true }],
      evidenceRequirements: [],
      budget: { maxTokens: 1000 },
      stopConditions: [], reviewPolicy: "human_on_risk", currentState: "active",
      createdAt: "2026-11-24T00:00:00.000Z", updatedAt: "2026-11-24T00:00:00.000Z",
      conversationId: "conversation-1", taskId: "task-1", armed: true,
      roundCount: 1, maxRounds: 24, noProgressCount: 0, revision: 2,
      execution: { executorId: "native", taskKind: "general", expectedOutputs: ["result.md"], networkHosts: [] }
    };
    store.appendEvent({ type: "goal.created", taskId: "task-1", payload: goal });
    const round: GoalRoundRecord = {
      id: "round-1", goalId: "goal-1", taskId: "task-1", index: 1, runIds: ["run-1"],
      status: "completed", startedAt: "2026-11-24T00:00:00.000Z", endedAt: "2026-11-24T00:01:00.000Z",
      summary: "first round", intent: { status: "progress", note: "still working", evidence: [], createdAt: "2026-11-24T00:01:00.000Z" },
      artifactRefs: ["artifacts/result.md"], evidenceRefs: ["run-evidence.json"], usage: { tokens: 10, turns: 1, toolCalls: 2, durationMs: 1000 },
      progressDigest: "abc", verifier: null, workspaceRoot: "C:/tmp/workspace", outDir: "C:/tmp/out"
    };
    store.appendEvent({ type: "goal.round.started", taskId: "task-1", runId: "run-1", payload: { ...round, status: "running", endedAt: null } });
    store.appendEvent({ type: "goal.round.settled", taskId: "task-1", runId: "run-1", payload: round });
    expect(store.getGoal("goal-1")?.armed).toBe(true);
    expect(store.getGoal("goal-1")?.revision).toBe(2);
    expect(store.getGoal("goal-1")?.execution?.executorId).toBe("native");
    expect(store.listGoalRounds("goal-1")).toHaveLength(1);
    expect(store.latestGoalRound("goal-1")?.intent?.status).toBe("progress");
    store.close();

    const reopened = new HearthStore(path);
    expect(reopened.getGoal("goal-1")?.taskId).toBe("task-1");
    expect(reopened.getGoal("goal-1")?.conversationId).toBe("conversation-1");
    expect(reopened.latestGoalRound("goal-1")?.status).toBe("completed");
    reopened.close();
  });
});
