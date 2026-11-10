import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalRecord, RunRecord } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { IntakeRouter } from "./intake-router.ts";
import { PreparedActionService } from "./prepared-actions.ts";
import { HearthService } from "./service.ts";
import { StandingIntentService } from "./standing-intents.ts";
import { ThreadSubscriptionService } from "./thread-subscriptions.ts";
import { WatchdogService } from "./watchdog.ts";

describe("Personal agent runtime services", () => {
  let root: string | null = null;
  let store: HearthStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "hearth-runtime-"));
    store = new HearthStore(":memory:");
    return { service: new HearthService(store), store };
  }

  describe("PreparedActionService", () => {
    it("commits read-only previews but gates external actions on prior approval", () => {
      const { service } = setup();
      const actions = new PreparedActionService(service);
      const task = service.createTask({ title: "prepare", goal: "prepare" });
      const research = actions.prepare({
        taskId: task.id, kind: "research", preview: { query: "竞品" }, evidenceRefs: ["src:1"]
      });
      expect(research.status).toBe("prepared");
      expect(actions.commit(research.id).status).toBe("committed");

      const email = actions.prepare({
        taskId: task.id, kind: "draft_email", preview: { to: "a@example.com" }, evidenceRefs: ["src:1"]
      });
      expect(() => actions.commit(email.id)).toThrowError(
        expect.objectContaining({ code: "PREPARED_ACTION_APPROVAL_REQUIRED" })
      );

      const approval = makeApproval(task.id, "approved", { actionDigest: email.actionDigest });
      service.store.appendEvent({ type: "approval.created", taskId: task.id, payload: approval });
      expect(actions.commit(email.id, { approvalRef: approval.id }).status).toBe("committed");
    });

    it("rejects a stale approval that is not bound to the prepared action", () => {
      const { service } = setup();
      const actions = new PreparedActionService(service);
      const task = service.createTask({ title: "prepare", goal: "prepare" });
      const email = actions.prepare({
        taskId: task.id, kind: "draft_email", preview: { to: "a@example.com", body: "hello" }, evidenceRefs: ["src:1"]
      });
      const unrelated = makeApproval(task.id, "approved", { actionDigest: "digest-of-another-action" });
      service.store.appendEvent({ type: "approval.created", taskId: task.id, payload: unrelated });
      expect(() => actions.commit(email.id, { approvalRef: unrelated.id })).toThrowError(
        expect.objectContaining({ code: "PREPARED_ACTION_APPROVAL_MISMATCH" })
      );
    });

    it("accepts an explicit prepared-action binding and an outbox draft binding", () => {
      const { service } = setup();
      const actions = new PreparedActionService(service);
      const task = service.createTask({ title: "prepare", goal: "prepare" });
      const email = actions.prepare({
        taskId: task.id, kind: "draft_email", preview: { outboxDraftId: "draft-1" }, evidenceRefs: ["src:1"]
      });
      const explicit = makeApproval(task.id, "approved", {
        target: { preparedActionId: email.id, actionDigest: email.actionDigest }
      });
      service.store.appendEvent({ type: "approval.created", taskId: task.id, payload: explicit });
      expect(actions.commit(email.id, { approvalRef: explicit.id }).status).toBe("committed");

      const second = actions.prepare({
        taskId: task.id, kind: "draft_email", preview: { outboxDraftId: "draft-2" }, evidenceRefs: ["src:2"]
      });
      const draftBound = makeApproval(task.id, "approved", { target: { draftId: "draft-2" } });
      service.store.appendEvent({ type: "approval.created", taskId: task.id, payload: draftBound });
      expect(actions.commit(second.id, { approvalRef: draftBound.id }).status).toBe("committed");
    });

    it("expires stale previews and requires evidence", () => {
      const { service } = setup();
      const now = new Date("2026-11-10T00:00:00.000Z");
      const actions = new PreparedActionService(service, () => now);
      const task = service.createTask({ title: "prepare", goal: "prepare" });
      expect(() => actions.prepare({ taskId: task.id, kind: "diff", preview: {}, evidenceRefs: [] }))
        .toThrowError(expect.objectContaining({ code: "PREPARED_ACTION_EVIDENCE_REQUIRED" }));
      const stale = actions.prepare({
        taskId: task.id, kind: "diff", preview: { file: "a.ts" }, evidenceRefs: ["src:1"],
        expiresAt: "2026-11-09T00:00:00.000Z"
      });
      expect(actions.expireStale().map((record) => record.id)).toContain(stale.id);
      expect(actions.get(stale.id)?.status).toBe("expired");
    });
  });

  describe("ThreadSubscriptionService", () => {
    it("delivers matching events, advances the cursor and respects pause", () => {
      const { service } = setup();
      const threads = new ThreadSubscriptionService(service);
      const task = service.createTask({ title: "thread", goal: "thread" });
      const subscription = threads.subscribe({ threadKey: "codex:abc", taskId: task.id, filter: { types: ["task.*"] } });
      service.updateTask(task.id, { status: "running" });
      const deliveries = threads.recentDeliveries();
      expect(deliveries.length).toBeGreaterThan(0);
      expect(deliveries[0]?.type).toBe("task.updated");
      expect(threads.list({ taskId: task.id })[0]?.cursor).toBe(String(deliveries[0]?.seq));

      threads.pause(subscription.id);
      service.updateTask(task.id, { nextAction: "继续" });
      expect(threads.recentDeliveries()).toHaveLength(deliveries.length);
      expect(() => threads.resume(subscription.id)).not.toThrow();
      threads.close();
    });

    it("does not recursively deliver its own subscription updates with the default filter", () => {
      const { service } = setup();
      const threads = new ThreadSubscriptionService(service);
      const task = service.createTask({ title: "thread", goal: "thread" });
      threads.subscribe({ threadKey: "codex:abc", taskId: task.id });
      service.updateTask(task.id, { status: "running" });
      expect(threads.recentDeliveries().every((delivery) => !delivery.type.startsWith("thread-subscription."))).toBe(true);
      expect(threads.recentDeliveries().length).toBeLessThan(10);
      threads.close();
    });

    it("does not deliver events excluded by the filter", () => {
      const { service } = setup();
      const threads = new ThreadSubscriptionService(service);
      const task = service.createTask({ title: "thread", goal: "thread" });
      threads.subscribe({ threadKey: "codex:abc", taskId: task.id, filter: { types: ["approval.*"] } });
      service.updateTask(task.id, { status: "running" });
      expect(threads.recentDeliveries()).toHaveLength(0);
      threads.close();
    });
  });

  describe("WatchdogService", () => {
    it("detects repeated failures, escalates from warning to pause and cancel", () => {
      const { service } = setup();
      const standing = new StandingIntentService({ service });
      let clock = new Date("2026-11-10T03:00:00.000Z");
      const watchdog = new WatchdogService({
        service, standingIntents: standing, now: () => clock,
        settings: { repeatedFailureCount: 3, shadow: true, dedupeMinutes: 1 }
      });
      const task = service.createTask({ title: "unstable", goal: "unstable" });
      service.updateTask(task.id, { status: "running" });
      for (let index = 0; index < 3; index += 1) createFailedRun(service, task.id, index);

      const first = watchdog.scan();
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ reason: "repeated_failures", action: "warn" });
      expect(service.store.listAttentionItems({ status: "open" }).length).toBeGreaterThan(0);
      expect(watchdog.scan()).toHaveLength(0);

      clock = new Date(clock.getTime() + 2 * 60_000);
      watchdog.updateSettings({ shadow: false });
      const paused = watchdog.scan();
      expect(paused[0]).toMatchObject({ reason: "repeated_failures", action: "pause" });
      expect(service.requireTask(task.id).status).toBe("recoverable");

      clock = new Date(clock.getTime() + 2 * 60_000);
      watchdog.updateSettings({ autoCancel: true });
      const cancelled = watchdog.scan();
      expect(cancelled[0]).toMatchObject({ reason: "repeated_failures", action: "cancel" });
      expect(service.requireTask(task.id).status).toBe("cancelled");
      expect(service.store.listWatchdogEvents({ taskId: task.id })).toHaveLength(3);
    });
  });

  describe("IntakeRouter", () => {
    it("routes deterministically and records every decision", () => {
      const { service } = setup();
      const intake = new IntakeRouter(service);
      expect(intake.route({ sourceRef: "mail:1", text: "请帮我调研三家竞品并整理对比" }).route).toBe("task");
      expect(intake.route({ sourceRef: "mail:2", text: "验证码 123456，今晚截止" }).route).toBe("attention");
      expect(intake.route({ sourceRef: "mail:3", text: "你好，在吗？" }).route).toBe("chat");
      expect(intake.route({ sourceRef: "mail:4", text: "Unsubscribe from this newsletter" }).route).toBe("ignore");
      expect(intake.list()).toHaveLength(4);
    });
  });
});

function makeApproval(
  taskId: string,
  status: ApprovalRecord["status"],
  patch: Partial<ApprovalRecord> = {}
): ApprovalRecord {
  return {
    id: `approval:test-${Math.random().toString(16).slice(2)}`, taskId, runId: "run:test", kind: "send_email", summary: "发送邮件",
    target: {}, preview: {}, parameterHash: "hash", status,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), decidedAt: null, effectId: null,
    createdAt: new Date().toISOString(),
    ...patch
  };
}

function createFailedRun(service: HearthService, taskId: string, index: number): void {
  const now = new Date(Date.now() + index).toISOString();
  const run: RunRecord = {
    id: `run:failed-${index}`, taskId, attempt: index + 1, status: "failed", threadId: null,
    workspace: "ws", startedAt: now, endedAt: now,
    failure: { kind: "test", message: "boom", recoverable: true, guidance: "retry" },
    usage: null, leaseEpoch: null, createdAt: now
  };
  service.createRun(run);
}