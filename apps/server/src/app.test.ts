import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRecord, ArtifactRecord, EffectRecord, RunRecord, SourceConnection, SourceItem } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";

const HASH = "a".repeat(64);

function seedAuditFixtures(store: HearthStore, taskId: string): void {
  const base = { taskId, createdAt: "2026-11-05T01:00:00.000Z" };
  const runs: RunRecord[] = [
    {
      id: "run-1", taskId, attempt: 1, status: "failed", threadId: null,
      workspace: ".hearth/workspaces/x", startedAt: "2026-11-05T01:00:00.000Z",
      endedAt: "2026-11-05T01:00:30.000Z", failure: { kind: "execution_failed", message: "boom", recoverable: true, guidance: "重试" },
      usage: null, leaseEpoch: null, createdAt: "2026-11-05T01:00:00.000Z"
    },
    {
      id: "run-2", taskId, attempt: 2, status: "completed", threadId: "thread-2",
      workspace: ".hearth/workspaces/x", startedAt: "2026-11-05T02:00:00.000Z",
      endedAt: "2026-11-05T02:01:40.000Z", failure: null,
      usage: { inputTokens: 1000, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 20 },
      leaseEpoch: null, createdAt: "2026-11-05T02:00:00.000Z"
    }
  ];
  const approvals: ApprovalRecord[] = [{
    ...base, runId: "run-2", id: "approval-1", kind: "github.comment", summary: "发布评论",
    target: { repo: "o/r", body: "private body" }, preview: { pull: 15, body: "private body" },
    parameterHash: HASH, status: "pending", expiresAt: "2026-11-07T02:00:00.000Z", decidedAt: null, effectId: null
  }];
  const effects: EffectRecord[] = [{
    ...base, id: "effect-1", approvalId: "approval-1", kind: "github.comment",
    idempotencyKey: `approval:approval-1:${HASH}`, status: "uncertain",
    target: { repo: "o/r", pull: 15 }, receipt: { pull: 15 }, error: "结果不确定",
    createdAt: "2026-11-05T02:02:00.000Z", updatedAt: "2026-11-05T02:02:05.000Z"
  }];
  const artifacts: ArtifactRecord[] = [{
    ...base, id: "artifact-1", runId: "run-2", relativePath: "run-manifest.json",
    absolutePath: "D:/secret/path/run-manifest.json", mimeType: "application/json; charset=utf-8",
    sha256: HASH, bytes: 1024, createdAt: "2026-11-05T02:03:00.000Z"
  }];

  for (const run of runs) store.appendEvent({ type: "run.created", taskId, runId: run.id, payload: run });
  for (const approval of approvals) store.appendEvent({ type: "approval.created", taskId, runId: approval.runId, payload: approval });
  for (const effect of effects) store.appendEvent({ type: "effect.created", taskId, payload: effect });
  for (const artifact of artifacts) store.appendEvent({ type: "artifact.published", taskId, runId: artifact.runId, payload: artifact });
}

function seedSourceItem(store: HearthStore, overrides: Partial<SourceItem> = {}): SourceItem {
  const now = "2026-11-05T01:00:00.000Z";
  const source: SourceConnection = {
    id: "source-1",
    kind: "knowledge",
    provider: "local-knowledge",
    displayName: "项目知识库",
    account: null,
    rootPath: "C:/knowledge",
    allowedHosts: [],
    status: "connected",
    readOnly: true,
    itemCount: 1,
    lastReadAt: now,
    lastError: null,
    createdAt: now,
    updatedAt: now
  };
  const item: SourceItem = {
    id: "source-item-1",
    sourceId: source.id,
    itemKey: "docs/brief.md",
    label: "brief.md",
    locator: "docs/brief.md",
    contentPath: `C:/hearth/sources/${source.id}/${HASH}.md`,
    contentHash: HASH,
    bytes: 42,
    title: "项目简报",
    status: "ready",
    coverage: { complete: true, pages: null, paragraphs: 3, sheets: [], gaps: [] },
    duplicateOf: null,
    error: null,
    fetchedAt: now,
    ...overrides
  };
  store.appendEvent({ type: "source.created", payload: source });
  store.appendEvent({ type: "source.item.updated", payload: item });
  return item;
}

describe("Hearth server", () => {
  let store: HearthStore;

  beforeEach(() => {
    store = new HearthStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("exposes health without leaking the provider key", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.name).toBe("Hearth");
    expect(body.codex).toBeTypeOf("object");
    expect(JSON.stringify(body)).not.toContain("CODEX_OPEN_DESIGN_API_KEY=");
    await app.close();
  });

  it("keeps outbox drafts separate from approval until the user submits them", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const created = await app.inject({
      method: "POST",
      url: "/api/outbox",
      payload: {
        account: "local-test",
        to: ["reviewer@example.test"],
        subject: "Weekly update",
        body: "This stays local."
      }
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json();
    expect(draft.status).toBe("draft");
    expect(draft.taskId).toBeNull();

    const submitted = await app.inject({ method: "POST", url: `/api/outbox/${draft.id}/submit` });
    expect(submitted.statusCode).toBe(200);
    const approval = submitted.json().approval;
    expect(approval.kind).toBe("outbox.local-write");
    expect(approval.target).toMatchObject({ draftId: draft.id, account: "local-test" });
    expect(approval.preview.impact).toContain("不会发送");

    const rejected = await app.inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/decide`,
      payload: { decision: "reject", parameterHash: approval.parameterHash }
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().effect).toBeNull();

    const drafts = await app.inject({ method: "GET", url: "/api/outbox" });
    expect(drafts.json().drafts[0]).toMatchObject({ id: draft.id, status: "rejected" });
    await app.close();
  });

  it("writes an approved outbox draft locally without claiming delivery", async () => {
    const outboxRoot = mkdtempSync(join(tmpdir(), "hearth-app-outbox-"));
    const app = await buildServer({ store, serveWeb: false, outboxRoot });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/outbox",
        payload: {
          account: "local-test",
          to: ["reviewer@example.test"],
          subject: "Local only",
          body: "This message must not be sent."
        }
      });
      const draft = created.json();
      const submitted = await app.inject({ method: "POST", url: `/api/outbox/${draft.id}/submit` });
      const approval = submitted.json().approval;
      const approved = await app.inject({
        method: "POST",
        url: `/api/approvals/${approval.id}/decide`,
        payload: { decision: "approve", parameterHash: approval.parameterHash }
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().effect).toMatchObject({
        status: "succeeded",
        receipt: { transport: "local-outbox", delivery: "not_sent" }
      });

      const effectId = approved.json().effect.id as string;
      expect(existsSync(join(outboxRoot, effectId, "message.eml"))).toBe(true);
      const drafts = await app.inject({ method: "GET", url: "/api/outbox" });
      expect(drafts.json().drafts[0]).toMatchObject({
        id: draft.id,
        status: "stored",
        effectId,
        effect: { status: "succeeded", receipt: { transport: "local-outbox", delivery: "not_sent" } }
      });
    } finally {
      await app.close();
      rmSync(outboxRoot, { recursive: true, force: true });
    }
  });

  it("returns an outbox draft to editable state when its task is cancelled", async () => {
    const outboxRoot = mkdtempSync(join(tmpdir(), "hearth-app-outbox-"));
    const app = await buildServer({ store, serveWeb: false, startScheduler: true, outboxRoot });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/outbox",
        payload: {
          account: "local-test",
          to: ["reviewer@example.test"],
          subject: "Cancel me",
          body: "No write should happen."
        }
      });
      const draft = created.json();
      const submitted = await app.inject({ method: "POST", url: `/api/outbox/${draft.id}/submit` });
      const taskId = submitted.json().task.id as string;

      const cancelled = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/cancel` });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json().status).toBe("cancelled");

      const drafts = await app.inject({ method: "GET", url: "/api/outbox" });
      expect(drafts.json().drafts[0]).toMatchObject({
        id: draft.id,
        status: "draft",
        taskId: null,
        approvalId: null,
        effectId: null,
        submittedAt: null
      });
    } finally {
      await app.close();
      rmSync(outboxRoot, { recursive: true, force: true });
    }
  });

  it("pairs a desktop helper, separates capabilities, and serves short-lived observations", async () => {
    const frameRoot = mkdtempSync(join(tmpdir(), "hearth-app-frames-"));
    const deviceToken = "p".repeat(43);
    const app = await buildServer({ store, serveWeb: false, deviceFrameRoot: frameRoot });
    try {
      const started = await app.inject({
        method: "POST",
        url: "/api/device-pairings",
        payload: {
          name: "Test Workstation",
          version: "1.0.0",
          deviceToken,
          apps: ["notepad"],
          capabilities: ["observe", "desktop.control"]
        }
      });
      expect(started.statusCode).toBe(201);
      const pairing = started.json();
      expect(pairing.request.status).toBe("pending");
      expect(pairing.request).not.toHaveProperty("secretHash");
      expect(pairing.request).not.toHaveProperty("deviceTokenHash");
      expect(pairing.request.code).toMatch(/^\d{6}$/);

      const pending = await app.inject({
        method: "GET",
        url: `/api/device-pairings/${pairing.request.id}`,
        headers: { "x-pairing-secret": pairing.secret }
      });
      expect(pending.statusCode).toBe(200);
      expect(pending.json().request.status).toBe("pending");

      const approvedPairing = await app.inject({
        method: "POST",
        url: `/api/devices/pairing-requests/${pairing.request.id}/approve`
      });
      expect(approvedPairing.statusCode).toBe(200);
      const device = approvedPairing.json();
      const deviceId = device.id as string;
      expect(device.capabilities.map((capability: { status: string }) => capability.status)).toEqual(["pending", "pending"]);

      const blockedSession = await app.inject({
        method: "POST",
        url: "/api/desktop/sessions",
        payload: { deviceId }
      });
      expect(blockedSession.statusCode).toBe(409);

      for (const capability of ["observe", "desktop.control"]) {
        const granted = await app.inject({
          method: "POST",
          url: `/api/devices/${deviceId}/capabilities/${capability}/approve`,
          payload: { apps: ["notepad"] }
        });
        expect(granted.statusCode).toBe(200);
      }

      const heartbeat = await app.inject({
        method: "POST",
        url: "/api/device/heartbeat",
        headers: { authorization: `Bearer ${deviceToken}` }
      });
      expect(heartbeat.statusCode).toBe(200);
      expect(heartbeat.json().device.online).toBe(true);

      const sessionResponse = await app.inject({
        method: "POST",
        url: "/api/desktop/sessions",
        payload: { deviceId }
      });
      expect(sessionResponse.statusCode).toBe(201);
      const session = sessionResponse.json().session;

      const next = await app.inject({
        method: "GET",
        url: "/api/device/commands/next",
        headers: { authorization: `Bearer ${deviceToken}` }
      });
      expect(next.statusCode).toBe(200);
      const observationCommand = next.json().command;
      expect(observationCommand).toMatchObject({ kind: "observe", status: "claimed" });

      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      const observation = await app.inject({
        method: "POST",
        url: "/api/device/observations",
        headers: { authorization: `Bearer ${deviceToken}` },
        payload: {
          sessionId: session.id,
          commandId: observationCommand.id,
          jpegBase64: jpeg.toString("base64"),
          width: 100,
          height: 80,
          activeApp: "notepad",
          windowTitle: "Draft - Notepad"
        }
      });
      expect(observation.statusCode).toBe(200);
      const frame = observation.json();
      const image = await app.inject({ method: "GET", url: frame.url });
      expect(image.statusCode).toBe(200);
      expect(image.headers["content-type"]).toBe("image/jpeg");
      expect(image.rawPayload.equals(jpeg)).toBe(true);

      const action = await app.inject({
        method: "POST",
        url: `/api/desktop/sessions/${session.id}/actions`,
        payload: { kind: "click", frameId: frame.id, x: 0.5, y: 0.5 }
      });
      expect(action.statusCode).toBe(202);
      const claimed = await app.inject({
        method: "GET",
        url: "/api/device/commands/next",
        headers: { authorization: `Bearer ${deviceToken}` }
      });
      expect(claimed.json().command).toMatchObject({ kind: "click", status: "claimed" });

      const paused = await app.inject({ method: "POST", url: `/api/desktop/sessions/${session.id}/pause` });
      expect(paused.statusCode).toBe(200);
      expect(paused.json().session.status).toBe("paused");

      const dashboard = await app.inject({ method: "GET", url: "/api/desktop" });
      expect(dashboard.statusCode).toBe(200);
      expect(JSON.stringify(dashboard.json())).not.toContain(deviceToken);
      expect(JSON.stringify(dashboard.json())).not.toContain("tokenHash");

      const revoked = await app.inject({ method: "POST", url: `/api/devices/${deviceId}/revoke` });
      expect(revoked.statusCode).toBe(200);
      const rejectedHeartbeat = await app.inject({
        method: "POST",
        url: "/api/device/heartbeat",
        headers: { authorization: `Bearer ${deviceToken}` }
      });
      expect(rejectedHeartbeat.statusCode).toBe(401);
    } finally {
      await app.close();
      rmSync(frameRoot, { recursive: true, force: true });
    }
  });

  it("lists the fifteen evaluation templates", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const response = await app.inject({ method: "GET", url: "/api/templates" });
    expect(response.statusCode).toBe(200);
    expect(response.json().templates).toHaveLength(15);
    await app.close();
  });

  it("attaches ready source items to a task and rejects stale selections", async () => {
    const item = seedSourceItem(store);
    const app = await buildServer({ store, serveWeb: false });

    const ready = await app.inject({ method: "GET", url: "/api/source-items" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().items).toHaveLength(1);

    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title: "整理来源",
        goal: "根据已读取资料整理简报",
        sourceItemIds: [item.id, item.id]
      }
    });
    expect(created.statusCode).toBe(201);
    const task = created.json();
    expect(task.inputs).toHaveLength(1);
    expect(task.inputs[0]).toMatchObject({
      kind: "source",
      label: "项目知识库 · 项目简报",
      value: item.id,
      sha256: HASH,
      source: {
        sourceId: "source-1",
        itemId: item.id,
        locator: "docs/brief.md",
        contentHash: HASH
      }
    });

    store.appendEvent({
      type: "source.item.updated",
      payload: { ...item, status: "cleared", contentPath: null, contentHash: null }
    });
    const stale = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "过期资料", goal: "不应创建", sourceItemIds: [item.id] }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("SOURCE_ITEM_NOT_READY");
    await app.close();
  });

  it("rejects source items from a disconnected source", async () => {
    const item = seedSourceItem(store);
    const source = store.getSource(item.sourceId);
    store.appendEvent({ type: "source.updated", payload: { id: item.sourceId, status: "disconnected", updatedAt: new Date().toISOString() } });
    expect(source).not.toBeNull();

    const app = await buildServer({ store, serveWeb: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { title: "断开来源", goal: "不应创建", sourceItemIds: [item.id] }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("SOURCE_DISCONNECTED");
    await app.close();
  });

  it("stops and resumes the scheduler from the local control plane", async () => {
    const app = await buildServer({ store, serveWeb: false, startScheduler: true });
    const initial = await app.inject({ method: "GET", url: "/api/system" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ running: true, schedulerEnabled: true });

    const stopped = await app.inject({ method: "POST", url: "/api/system/stop" });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().running).toBe(false);

    const resumed = await app.inject({ method: "POST", url: "/api/system/start" });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().running).toBe(true);
    await app.close();
  });

  it("exports task records and refuses the legacy plaintext backup", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const created = await app.inject({ method: "POST", url: "/api/tasks", payload: { templateId: "T04" } });
    expect(created.statusCode).toBe(201);

    const exported = await app.inject({ method: "GET", url: "/api/export" });
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toMatchObject({ format: "hearth-export", version: 1 });
    expect(exported.json().tasks).toHaveLength(1);

    const backup = await app.inject({ method: "GET", url: "/api/backup" });
    expect(backup.statusCode).toBe(410);
    expect(backup.json().error).toBe("ENCRYPTED_BACKUP_REQUIRED");
    await app.close();
  });

  it("creates a task and projects its event", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { templateId: "T01" }
    });
    expect(response.statusCode).toBe(201);
    const task = response.json();
    expect(task.templateId).toBe("T01");
    expect(task.status).toBe("queued");
    expect(task.outputDir).toBe("eval/runs/T01");

    const detail = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(detail.statusCode).toBe(200);
    const view = detail.json();
    expect(view.task.id).toBe(task.id);
    expect(view.events[0].type).toBe("task.created");

    const list = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(list.json().tasks).toHaveLength(1);
    await app.close();
  });

  it("pins and archives tasks without changing task status", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const created = await app.inject({ method: "POST", url: "/api/tasks", payload: { templateId: "T01" } });
    const taskId = created.json().id as string;

    const pinned = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}/organization`,
      payload: { pinned: true }
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json()).toMatchObject({ id: taskId, status: "queued" });
    expect(pinned.json().pinnedAt).toBeTypeOf("string");
    expect(pinned.json().archivedAt).toBeNull();

    const archived = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}/organization`,
      payload: { archived: true }
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().archivedAt).toBeTypeOf("string");
    expect(archived.json().status).toBe("queued");

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}/organization`,
      payload: { pinned: false, archived: false }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ pinnedAt: null, archivedAt: null, status: "queued" });

    const invalid = await app.inject({ method: "PATCH", url: `/api/tasks/${taskId}/organization`, payload: {} });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

  it("creates idempotent delegations and cancels the child task", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-app-delegation-"));
    try {
      const app = await buildServer({ store, serveWeb: false });
      const created = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: {
          title: "委派父任务",
          goal: "验证委派 API",
          permissions: {
            readRoots: [root],
            writeRoots: [],
            networkHosts: [],
            tools: ["read_file", "finish_task"]
          }
        }
      });
      expect(created.statusCode).toBe(201);
      const parentId = created.json().id as string;
      const payload = {
        goalSlice: "只读检索",
        targetExecutor: "native",
        contextPackRef: "context:task",
        workspacePolicy: "read-only",
        idempotencyKey: "app-delegation-1"
      };

      const first = await app.inject({ method: "POST", url: `/api/tasks/${parentId}/delegations`, payload });
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ status: "queued", parentTaskId: parentId });
      const childTaskId = first.json().childTaskId as string;

      const duplicate = await app.inject({ method: "POST", url: `/api/tasks/${parentId}/delegations`, payload });
      expect(duplicate.statusCode).toBe(201);
      expect(duplicate.json().id).toBe(first.json().id);

      const listed = await app.inject({ method: "GET", url: `/api/tasks/${parentId}/delegations` });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().delegations).toHaveLength(1);

      const cancelled = await app.inject({ method: "POST", url: `/api/delegations/${first.json().id}/cancel`, payload: { reason: "测试取消" } });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toMatchObject({ status: "cancelled", cancelReason: "测试取消" });
      expect(store.getTask(childTaskId)?.status).toBe("cancelled");
      await app.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown templates and cross-site writes", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const unknown = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { templateId: "T99" }
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe("UNKNOWN_TEMPLATE");

    const crossSite = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { origin: "https://example.com", "sec-fetch-site": "cross-site" },
      payload: { templateId: "T01" }
    });
    expect(crossSite.statusCode).toBe(403);
    await app.close();
  });

  it("pages the audit lists and reports honest totals", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const created = await app.inject({ method: "POST", url: "/api/tasks", payload: { templateId: "T01" } });
    const taskId = created.json().id as string;
    seedAuditFixtures(store, taskId);

    const runs = await app.inject({ method: "GET", url: "/api/runs?limit=1" });
    expect(runs.statusCode).toBe(200);
    expect(runs.json().total).toBe(2);
    expect(runs.json().runs).toHaveLength(1);
    expect(runs.json().runs[0].taskTitle).toBe(created.json().title);
    expect(runs.headers["cache-control"]).toBe("no-store");

    const unknownStatus = await app.inject({ method: "GET", url: "/api/runs?status=uncertain" });
    expect(unknownStatus.statusCode).toBe(400);
    expect(unknownStatus.json().error).toBe("INVALID_QUERY");

    const oversized = await app.inject({ method: "GET", url: "/api/runs?limit=500" });
    expect(oversized.statusCode).toBe(400);

    const detail = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
    const eventTotal = detail.json().eventTotal as number;
    const seen: number[] = [];
    let before: number | null = null;
    for (let page = 0; page < 20; page += 1) {
      const cursor: string = before === null ? "" : `&before=${before}`;
      const response = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/events?limit=2${cursor}` });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { total: number; nextBefore: number | null; events: { seq: number }[] };
      expect(body.total).toBe(eventTotal);
      if (body.events.length === 0) break;
      seen.unshift(...body.events.map((event) => event.seq));
      before = body.nextBefore;
      if (before === null) break;
    }
    expect(seen).toHaveLength(eventTotal);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));

    const missingTask = await app.inject({ method: "GET", url: "/api/tasks/nope/events" });
    expect(missingTask.statusCode).toBe(404);

    const globalHistory = await app.inject({ method: "GET", url: "/api/events/history?type=run.created" });
    expect(globalHistory.json().total).toBe(2);
    await app.close();
  });

  it("aggregates stats and summaries without inventing numbers", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const created = await app.inject({ method: "POST", url: "/api/tasks", payload: { templateId: "T08" } });
    const taskId = created.json().id as string;
    seedAuditFixtures(store, taskId);

    const list = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(list.json().tasks[0].summary).toEqual({
      runs: 2,
      lastDurationMs: 100_000,
      lastUsage: { inputTokens: 1000, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 20 },
      artifacts: 1,
      phase: "排队中",
      deliverables: [],
      effects: { total: 1, uncertain: 1 },
      approvalId: "approval-1"
    });

    const stats = await app.inject({ method: "GET", url: "/api/stats" });
    expect(stats.json()).toMatchObject({
      tasks: { total: 1, byStatus: { queued: 1, completed: 0 } },
      runs: {
        total: 2, byStatus: { failed: 1, completed: 1 },
        durationMs: 130_000, durationCounted: 2, durationUncounted: 0,
        usage: { inputTokens: 1000, outputTokens: 200 }
      },
      approvals: { byStatus: { pending: 1, approved: 0 } },
      effects: { byStatus: { uncertain: 1, succeeded: 0 } },
      artifacts: { count: 1, bytes: 1024 },
      events: { total: 6, latestSeq: 6 }
    });

    const brief = await app.inject({ method: "GET", url: "/api/approvals?brief=1" });
    expect(brief.json().approvals[0].target.body).toBeUndefined();
    expect(brief.json().approvals[0].preview.body).toBeUndefined();
    const full = await app.inject({ method: "GET", url: "/api/approvals" });
    expect(full.json().approvals[0].target.body).toBe("private body");

    const uncertain = await app.inject({ method: "GET", url: "/api/effects?status=uncertain" });
    expect(uncertain.json().total).toBe(1);

    const artifacts = await app.inject({ method: "GET", url: "/api/artifacts" });
    expect(JSON.stringify(artifacts.json())).not.toContain("D:/secret/path");
    expect(artifacts.json().artifacts[0].sha256).toBe(HASH);
    await app.close();
  });

  it("streams newly created events over SSE", async () => {
    const app = await buildServer({ store, serveWeb: false });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, { signal: controller.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing response stream");

      const created = await fetch(`http://127.0.0.1:${address.port}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateId: "T04" }),
        signal: controller.signal
      });
      expect(created.status).toBe(201);

      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes("task.created")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
      expect(received).toContain("event: task.created");
      expect(received).toContain('"templateId":"T04"');
      await reader.cancel();
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await app.close();
    }
  });

  it("replays context events after a reconnect cursor", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const created = await app.inject({ method: "POST", url: "/api/tasks", payload: { templateId: "T04" } });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().id as string;
    const cursor = store.latestEventSeq();
    store.appendEvent({
      type: "context.item.appended",
      taskId,
      payload: { id: "context-1", kind: "assistant_message", content: "replayed context" }
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/events?after=${cursor}&taskId=${taskId}`, { signal: controller.signal });
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing response stream");
      const decoder = new TextDecoder();
      let received = "";
      while (!received.includes("context.item.appended")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
      expect(received).toContain("event: context.item.appended");
      expect(received).toContain("replayed context");
      expect(received).not.toContain("event: task.created");
      await reader.cancel();
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await app.close();
    }
  });
});
