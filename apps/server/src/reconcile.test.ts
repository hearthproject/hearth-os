import { randomUUID } from "node:crypto";
import type { EffectRecord } from "@hearth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { ReconcileService } from "./reconcile.ts";
import { HearthService } from "./service.ts";

describe("effect reconcile queue", () => {
  let store: HearthStore;
  let service: HearthService;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    service = new HearthService(store);
  });

  afterEach(() => store.close());

  it("settles a committed effect without replaying it", async () => {
    const effect = createEffect(service, "uncertain", { repo: "acme/repo", pull: 12 });
    const reconcile = new ReconcileService(service, {
      providers: {
        github: { check: () => ({ status: "committed", providerRef: "server-msg-1", receipt: { messageId: "server-msg-1" } }) }
      }
    });
    const item = reconcile.enqueue(effect, "发送响应中断");
    expect(item.status).toBe("open");

    const resolved = await reconcile.check(item.id);
    expect(resolved.status).toBe("resolved_committed");
    expect(store.getEffect(effect.id)).toMatchObject({
      status: "reconciled_committed",
      providerRef: "server-msg-1",
      receipt: { messageId: "server-msg-1" },
      reconcileRef: item.id
    });
  });

  it("marks an absent effect as not executed", async () => {
    const effect = createEffect(service, "uncertain", { repo: "acme/repo", pull: 12 });
    const reconcile = new ReconcileService(service, {
      providers: { github: { check: () => ({ status: "absent" }) } }
    });
    const item = reconcile.enqueue(effect, "发送响应中断");
    await reconcile.check(item.id);
    expect(store.getEffect(effect.id)?.status).toBe("reconciled_absent");
  });

  it("moves repeated unknown results to the human queue", async () => {
    const effect = createEffect(service, "uncertain", { repo: "acme/repo", pull: 12 });
    const reconcile = new ReconcileService(service, {
      providers: { github: { check: () => ({ status: "unknown", reason: "IMAP 暂不可读" }) } }
    });
    const item = reconcile.enqueue(effect, "发送响应中断");
    await reconcile.check(item.id);
    await reconcile.check(item.id);
    const third = await reconcile.check(item.id);
    expect(third.status).toBe("needs_human");
    expect(third.checkCount).toBe(3);
  });

  it("suspends and resumes effects on the same target", async () => {
    const first = createEffect(service, "uncertain", { repo: "acme/repo", pull: 12 }, "2026-11-09T01:00:00.000Z");
    const following = createEffect(service, "prepared", { repo: "acme/repo", pull: 12 }, "2026-11-09T01:01:00.000Z", first.taskId);
    const reconcile = new ReconcileService(service, {
      providers: { github: { check: () => ({ status: "committed" }) } }
    });
    const item = reconcile.enqueue(first, "发送响应中断");
    const suspended = store.getEffect(following.id);
    expect(suspended?.suspendReason).toContain(first.id);
    expect(suspended?.availableAt).toBe("9999-12-31T23:59:59.999Z");

    await reconcile.check(item.id);
    const resumed = store.getEffect(following.id);
    expect(resumed?.suspendReason).toBeNull();
    expect(resumed?.availableAt).not.toBe("9999-12-31T23:59:59.999Z");
  });

  it("keeps manual resolution explicit and records the human note", () => {
    const effect = createEffect(service, "uncertain", { repo: "acme/repo", pull: 12 });
    const reconcile = new ReconcileService(service);
    const item = reconcile.enqueue(effect, "发送响应中断");

    const resolved = reconcile.resolveManually(item.id, "committed", "在 GitHub 上已看到评论发布成功");

    expect(resolved.status).toBe("resolved_committed");
    expect(resolved.resolutionNote).toContain("评论发布成功");
    expect(store.getEffect(effect.id)).toMatchObject({
      status: "reconciled_committed",
      reconcileRef: item.id,
      receipt: { manualResolution: "committed", note: "在 GitHub 上已看到评论发布成功" }
    });
  });

  it("creates a human follow-up task without closing the reconcile item", () => {
    const effect = createEffect(service, "uncertain", { repo: "acme/repo", pull: 12 });
    const reconcile = new ReconcileService(service);
    const item = reconcile.enqueue(effect, "发送响应中断");

    const task = reconcile.createTask(item.id, "请到 GitHub 核对评论是否已发布");

    expect(task.goal).toContain(item.id);
    expect(task.goal).toContain("请到 GitHub 核对评论是否已发布");
    expect(store.getReconcileItem(item.id)?.status).toBe("open");
    expect(store.getReconcileItem(item.id)?.attempted).toContain(`task:${task.id}`);
    expect(reconcile.list("open")).toHaveLength(1);
  });
});

function createEffect(
  service: HearthService,
  status: EffectRecord["status"],
  target: Record<string, unknown>,
  createdAt = new Date().toISOString(),
  taskId?: string
): EffectRecord {
  const resolvedTaskId = taskId ?? service.createTask({ title: "Publish PR", goal: "Publish a reviewed pull request" }).id;
  const effect: EffectRecord = {
    id: randomUUID(),
    taskId: resolvedTaskId,
    approvalId: randomUUID(),
    kind: "github.comment",
    idempotencyKey: randomUUID(),
    status,
    target,
    receipt: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
    effectType: "github.comment",
    replayPolicy: "never_replay",
    provider: "github",
    attemptCount: 1,
    maxAttempts: 1
  };
  service.createEffect(effect);
  return effect;
}

