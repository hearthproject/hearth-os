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
    const effect = createEffect(service, "uncertain", { to: ["reviewer@example.test"] });
    const reconcile = new ReconcileService(service, {
      providers: {
        email: { check: () => ({ status: "committed", providerRef: "server-msg-1", receipt: { messageId: "server-msg-1" } }) }
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
    const effect = createEffect(service, "uncertain", { to: ["reviewer@example.test"] });
    const reconcile = new ReconcileService(service, {
      providers: { email: { check: () => ({ status: "absent" }) } }
    });
    const item = reconcile.enqueue(effect, "发送响应中断");
    await reconcile.check(item.id);
    expect(store.getEffect(effect.id)?.status).toBe("reconciled_absent");
  });

  it("moves repeated unknown results to the human queue", async () => {
    const effect = createEffect(service, "uncertain", { to: ["reviewer@example.test"] });
    const reconcile = new ReconcileService(service, {
      providers: { email: { check: () => ({ status: "unknown", reason: "IMAP 暂不可读" }) } }
    });
    const item = reconcile.enqueue(effect, "发送响应中断");
    await reconcile.check(item.id);
    await reconcile.check(item.id);
    const third = await reconcile.check(item.id);
    expect(third.status).toBe("needs_human");
    expect(third.checkCount).toBe(3);
  });

  it("suspends and resumes effects on the same target", async () => {
    const first = createEffect(service, "uncertain", { to: ["reviewer@example.test"] }, "2026-11-09T01:00:00.000Z");
    const following = createEffect(service, "prepared", { to: ["reviewer@example.test"] }, "2026-11-09T01:01:00.000Z", first.taskId);
    const reconcile = new ReconcileService(service, {
      providers: { email: { check: () => ({ status: "committed" }) } }
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
});

function createEffect(
  service: HearthService,
  status: EffectRecord["status"],
  target: Record<string, unknown>,
  createdAt = new Date().toISOString(),
  taskId?: string
): EffectRecord {
  const resolvedTaskId = taskId ?? service.createTask({ templateId: "T07" }).id;
  const effect: EffectRecord = {
    id: randomUUID(),
    taskId: resolvedTaskId,
    approvalId: randomUUID(),
    kind: "email.smtp-send",
    idempotencyKey: randomUUID(),
    status,
    target,
    receipt: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
    effectType: "email.send",
    replayPolicy: "never_replay",
    provider: "email",
    attemptCount: 1,
    maxAttempts: 1
  };
  service.createEffect(effect);
  return effect;
}
