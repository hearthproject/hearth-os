import { randomUUID } from "node:crypto";
import type { RunRecord } from "@hearth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { ApprovalManager, EffectUncertainError, hashApprovalParameters } from "./approvals.ts";
import { HearthService } from "./service.ts";

describe("approval manager", () => {
  let store: HearthStore;
  let service: HearthService;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    service = new HearthService(store);
  });

  afterEach(() => store.close());

  it("executes an approved effect once and records a receipt", async () => {
    let calls = 0;
    const manager = new ApprovalManager(service, async (effect) => {
      calls += 1;
      return { url: "https://github.com/JasonBuildAI/GoldMind/pull/17", idempotencyKey: effect.idempotencyKey };
    });
    const { task, approval } = await waitingTask(service);

    const result = await manager.decide(approval.id, "approve", approval.parameterHash);
    expect(result.effect?.status).toBe("succeeded");
    expect(result.effect?.receipt?.url).toBe("https://github.com/JasonBuildAI/GoldMind/pull/17");
    expect(result.task.status).toBe("completed");
    expect(calls).toBe(1);

    const duplicate = await manager.decide(approval.id, "approve", approval.parameterHash);
    expect(duplicate.effect?.id).toBe(result.effect?.id);
    expect(calls).toBe(1);
    expect(service.requireTask(task.id).status).toBe("completed");
  });

  it("rejects changed parameters without executing anything", async () => {
    let calls = 0;
    const manager = new ApprovalManager(service, async () => {
      calls += 1;
      return {};
    });
    const { approval } = await waitingTask(service);

    await expect(manager.decide(approval.id, "approve", "0".repeat(64)))
      .rejects.toMatchObject({ code: "PARAMETERS_CHANGED" });
    expect(calls).toBe(0);
    expect(store.listEffects(approval.taskId)).toHaveLength(0);
  });

  it("refuses to execute an approved effect after the task lease is lost", async () => {
    let calls = 0;
    const { approval } = await waitingTask(service);
    const manager = new ApprovalManager(service, async () => {
      calls += 1;
      return {};
    }, {
      guard: () => { throw new Error("lease fenced"); }
    });

    await expect(manager.decide(approval.id, "approve", approval.parameterHash)).rejects.toThrow("lease fenced");
    expect(calls).toBe(0);
    expect(store.listEffects(approval.taskId)).toHaveLength(0);
    expect(store.getApproval(approval.id)?.status).toBe("pending");
  });

  it("records a rejection without executing the effect", async () => {
    let calls = 0;
    const manager = new ApprovalManager(service, async () => {
      calls += 1;
      return {};
    });
    const { task, approval } = await waitingTask(service);

    const result = await manager.decide(approval.id, "reject", approval.parameterHash);
    expect(result.task.status).toBe("recoverable");
    expect(result.task.error?.kind).toBe("approval_rejected");
    expect(result.effect).toBeNull();
    expect(calls).toBe(0);
    expect(service.requireTask(task.id).status).toBe("recoverable");
  });

  it("expires pending approvals when their task is cancelled", async () => {
    const manager = new ApprovalManager(service, async () => ({}));
    const { task, approval } = await waitingTask(service);

    expect(manager.expireForTask(task.id)).toBe(1);
    expect(store.getApproval(approval.id)?.status).toBe("expired");
  });

  it("marks an uncertain effect and asks the user to verify before retrying", async () => {
    const manager = new ApprovalManager(service, async () => {
      throw new EffectUncertainError("request timed out after upload");
    });
    const { task, approval } = await waitingTask(service);

    const result = await manager.decide(approval.id, "approve", approval.parameterHash);
    expect(result.effect?.status).toBe("uncertain");
    expect(result.task.status).toBe("recoverable");
    expect(result.task.error?.kind).toBe("effect_uncertain");
    expect(service.requireTask(task.id).status).toBe("recoverable");
  });

  it("auto-approves full-permission conversation effects and writes an audit event", async () => {
    const conversation = store.createConversation("完全权限对话", {
      executorEnabled: { native: true, codex: true, hermes: true, qoder: false, workbuddy: false, zcode: false, kimi: false },
      approvalMode: "full",
      preferredExecutorId: null
    });
    const task = service.createTask({ templateId: "T07", conversationId: conversation.id });
    const now = new Date().toISOString();
    const runId = randomUUID();
    service.createRun({
      id: runId,
      taskId: task.id,
      attempt: 1,
      status: "running",
      threadId: "thread-full",
      workspace: "C:/tmp/full",
      startedAt: now,
      endedAt: null,
      failure: null,
      usage: null,
      leaseEpoch: null,
      createdAt: now
    });
    service.updateTask(task.id, { status: "running", currentRunId: runId }, runId);
    service.updateTask(task.id, { status: "waiting_approval", currentRunId: runId }, runId);

    let calls = 0;
    const manager = new ApprovalManager(service, async () => {
      calls += 1;
      return { url: "https://example.test/pull/1" };
    });
    const approval = await manager.request({
      taskId: task.id,
      runId,
      kind: "github.publish-pr",
      summary: "推送分支并创建 PR",
      target: { repo: "example/repo", branch: "hearth/full", base: "main" },
      preview: { title: "Full permission", body: "Auto-approved effect" }
    });

    expect(approval.status).toBe("approved");
    expect(calls).toBe(1);
    expect(service.requireTask(task.id).status).toBe("completed");
    const audit = store.listEvents().find((event) => event.type === "approval.auto_approved");
    expect(audit?.payload).toMatchObject({
      approvalId: approval.id,
      conversationId: conversation.id,
      kind: "github.publish-pr",
      policy: "conversation.full"
    });
    expect((audit?.payload as { effectId?: string }).effectId).toBeTruthy();
  });

  async function waitingTask(service: HearthService) {
    const task = service.createTask({ templateId: "T07" });
    const now = new Date().toISOString();
    const runId = randomUUID();
    const run: RunRecord = {
      id: runId,
      taskId: task.id,
      attempt: 1,
      status: "running",
      threadId: "thread-test",
      workspace: "C:/tmp/test",
      startedAt: now,
      endedAt: null,
      failure: null,
      usage: null,
      leaseEpoch: null,
      createdAt: now
    };
    service.createRun(run);
    service.updateTask(task.id, { status: "running", currentRunId: runId, nextAction: "正在执行" }, runId);
    service.updateTask(task.id, { status: "waiting_approval", currentRunId: runId, nextAction: "等待确认" }, runId);
    const manager = new ApprovalManager(service, async () => ({}));
    const approval = await manager.request({
      taskId: task.id,
      runId,
      kind: "github.publish-pr",
      summary: "推送分支并创建 PR",
      target: { repo: "JasonBuildAI/GoldMind", branch: "hearth/test", base: "main" },
      preview: { title: "Fix issue 16", body: "Test PR body" }
    });
    expect(approval.parameterHash).toBe(hashApprovalParameters(
      "github.publish-pr",
      "推送分支并创建 PR",
      { repo: "JasonBuildAI/GoldMind", branch: "hearth/test", base: "main" },
      { title: "Fix issue 16", body: "Test PR body" }
    ));
    return { task: service.requireTask(task.id), approval };
  }
});
