import { randomUUID } from "node:crypto";
import type { EffectRecord } from "@hearth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { HearthService } from "./service.ts";

describe("effect ledger v2", () => {
  let store: HearthStore;
  let service: HearthService;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    service = new HearthService(store);
  });

  afterEach(() => store.close());

  it("persists replay policy, leases, and reconcile metadata", () => {
    const task = service.createTask({ templateId: "T07" });
    const now = new Date().toISOString();
    const effect: EffectRecord = {
      id: randomUUID(),
      taskId: task.id,
      approvalId: "approval-1",
      kind: "email.smtp-send",
      idempotencyKey: "approval:approval-1:hash",
      status: "prepared",
      target: { accountId: "acct-1" },
      receipt: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      goalId: "goal-1",
      effectType: "email.send",
      replayPolicy: "never_replay",
      actionDigest: "a".repeat(64),
      resolvedActionDigest: "b".repeat(64),
      attemptCount: 0,
      maxAttempts: 3,
      leaseOwner: null,
      leaseExpiresAt: null,
      availableAt: now,
      provider: "smtp",
      providerRef: null,
      reconcileRef: null,
      reconciledAt: null,
      targetKey: "email:acct-1:reviewer@example.test",
      suspendReason: null
    };

    service.createEffect(effect);
    expect(store.getEffect(effect.id)).toMatchObject({
      goalId: "goal-1",
      effectType: "email.send",
      replayPolicy: "never_replay",
      actionDigest: "a".repeat(64),
      resolvedActionDigest: "b".repeat(64),
      maxAttempts: 3,
      targetKey: "email:acct-1:reviewer@example.test",
      provider: "smtp"
    });

    const updated = service.updateEffect(effect.id, {
      status: "reconciled_committed",
      reconcileRef: "reconcile-1",
      reconciledAt: now,
      receipt: { messageId: "server-msg-1" }
    });
    expect(updated).toMatchObject({
      status: "reconciled_committed",
      reconcileRef: "reconcile-1",
      reconciledAt: now,
      receipt: { messageId: "server-msg-1" }
    });
  });
});
