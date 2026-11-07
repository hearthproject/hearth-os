import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer, type BuildServerOptions } from "./app.ts";
import { ContextService } from "./context.ts";
import { HearthService } from "./service.ts";

describe("context and handoff API", () => {
  let store: HearthStore | null = null;
  let root: string | null = null;
  let closeApp: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await closeApp?.();
    closeApp = null;
    store?.close();
    store = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "hearth-context-api-"));
    store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const context = new ContextService(service, join(root, "blobs"));
    return { service, context };
  }

  async function makeApp(blobRoot: string, extra: Partial<BuildServerOptions> = {}) {
    const app = await buildServer({
      store: store as HearthStore,
      serveWeb: false,
      modelSettingsPath: join(root as string, "model-settings.json"),
      attachmentRoot: join(root as string, "attachments"),
      contextBlobRoot: blobRoot,
      ...extra
    });
    closeApp = () => app.close();
    return app;
  }

  it("returns defaults and validates context setting updates", async () => {
    setup();
    const app = await makeApp(join(root as string, "blobs"));

    const defaults = await app.inject({ method: "GET", url: "/api/context/settings" });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().settings).toMatchObject({
      mode: "on",
      maxHandoffs: 2,
      maxSameExecutorRetries: 1,
      retentionDays: 30,
      maxInlineBytes: 16_384,
      projectionTokenBudget: 12_000,
      allowCodexNetwork: false
    });

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/context/settings",
      payload: { mode: "shadow", maxHandoffs: 2, allowCodexNetwork: true }
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().settings).toMatchObject({ mode: "shadow", maxHandoffs: 2, allowCodexNetwork: true });

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/context/settings",
      payload: { maxHandoffs: 9 }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe("INVALID_INPUT");
  });

  it("paginates a task context timeline and rejects unknown tasks", async () => {
    const { service, context } = setup();
    const app = await makeApp(join(root as string, "blobs"));
    const task = service.createTask({ title: "timeline", goal: "record context" });
    for (let index = 0; index < 3; index += 1) {
      context.record({
        taskId: task.id,
        kind: "assistant_message",
        role: "assistant",
        content: `step ${index}`,
        executorEventId: `step:${index}`
      });
    }

    const page = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/context?limit=2` });
    expect(page.statusCode).toBe(200);
    expect(page.json().items.items).toHaveLength(2);
    expect(page.json().items.total).toBe(3);
    expect(page.json().items.nextBefore).not.toBeNull();

    const missing = await app.inject({ method: "GET", url: "/api/tasks/missing/context" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("TASK_NOT_FOUND");
  });

  it("deletes context items, summary, handoffs and blobs with a receipt", async () => {
    const { service, context } = setup();
    const app = await makeApp(join(root as string, "blobs"));
    const task = service.createTask({ title: "cleanup", goal: "delete context" });
    const item = context.record({
      taskId: task.id,
      kind: "tool_result",
      role: "tool",
      content: "y".repeat(20_000),
      executorEventId: "large:1"
    });
    context.createHandoff({
      taskId: task.id,
      fromRunId: "run-1",
      fromExecutor: "native",
      toExecutor: "codex",
      status: "pending_user",
      reasonCode: "capability_gap",
      diagnosis: null,
      packet: null,
      contextWatermarkSeq: 0,
      initiatedBy: "auto"
    });
    context.refreshSummary(task.id);
    const blobPath = join(root as string, "blobs", item.contentRef ?? "");
    expect(existsSync(blobPath)).toBe(true);

    const deleted = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}/context` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().deletedItems).toBeGreaterThanOrEqual(2);
    expect(deleted.json().deletedBlobs).toBe(1);
    expect(deleted.json().deletedHandoffs).toBe(1);
    expect(existsSync(blobPath)).toBe(false);

    const after = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/context` });
    expect(after.json().items.total).toBe(0);
    expect(after.json().state).toBeNull();
  });

  it("guards handoff confirmation behind the scheduler", async () => {
    const { service } = setup();
    const app = await makeApp(join(root as string, "blobs"));
    const task = service.createTask({ title: "handoff", goal: "continue" });

    const handoffs = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/handoffs` });
    expect(handoffs.statusCode).toBe(200);
    expect(handoffs.json().handoffs).toEqual([]);

    const confirm = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/handoff`, payload: { executorId: "codex" } });
    expect(confirm.statusCode).toBe(503);
    expect(confirm.json().error).toBe("SCHEDULER_OFF");
  });

  it("returns 409 when the scheduler has no pending handoff to confirm", async () => {
    const { service } = setup();
    const task = service.createTask({ title: "nothing pending", goal: "continue" });
    service.updateTask(task.id, { status: "running" });
    service.updateTask(task.id, { status: "waiting_input" });
    const app = await makeApp(join(root as string, "blobs"), { startScheduler: true });
    const confirm = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/handoff`, payload: { executorId: "codex" } });
    expect(confirm.statusCode).toBe(409);
    expect(confirm.json().error).toBe("HANDOFF_NOT_ALLOWED");
  });

  it("exposes handoff and diagnosis observability metrics", async () => {
    const { service, context } = setup();
    const app = await makeApp(join(root as string, "blobs"));
    const task = service.createTask({ title: "metrics", goal: "measure" });
    context.recordDiagnosis({
      id: "diagnosis-1", taskId: task.id, runId: "run-1", cause: "capability_gap",
      confidence: 0.8, summary: "工具能力不足", evidenceItemIds: [], recommendedAction: "handoff",
      targetExecutor: "codex", doNotRepeat: [], source: "rules", createdAt: new Date().toISOString()
    }, { durationMs: 120, contextTokens: 300, modelAttempted: true, modelUsed: false });
    context.createHandoff({
      taskId: task.id, fromRunId: "run-1", fromExecutor: "native", toExecutor: "codex",
      status: "pending_user", reasonCode: "capability_gap", diagnosis: null, packet: null,
      contextWatermarkSeq: 0, initiatedBy: "auto"
    });

    const metrics = await app.inject({ method: "GET", url: "/api/context/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json().handoffs).toMatchObject({ total: 1, automatic: 1, pendingUser: 1 });
    expect(metrics.json().diagnosis).toMatchObject({ total: 1, rules: 1, averageDurationMs: 120, averageContextTokens: 300 });
  });
});
