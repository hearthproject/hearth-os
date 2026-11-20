import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAction } from "./action-resolver.ts";
import type { ApprovalRecord, RunRecord } from "@hearth/core";
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
    expect(result.effect).toMatchObject({
      effectType: "github.publish-pr",
      replayPolicy: "never_replay",
      attemptCount: 1,
      maxAttempts: 1
    });
    expect(result.effect?.targetKey).toContain("github.publish-pr:");
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

  it("pauses a running task for an external write and resumes after approval", async () => {
    const manager = new ApprovalManager(service, async () => ({}));
    const { task, runId } = runningTask(service);
    const pending = await manager.requestTool({
      taskId: task.id,
      runId,
      toolName: "browser_submit",
      summary: "提交网页表单",
      target: { tool: "browser_submit", arguments: { form: "publish" } },
      preview: { arguments: { form: "publish" } }
    });

    expect(service.requireTask(task.id).status).toBe("waiting_approval");
    expect(store.getApproval(pending.approval.id)?.kind).toBe("tool.browser_submit");

    const result = await manager.decide(pending.approval.id, "approve", pending.approval.parameterHash);
    await expect(pending.decision).resolves.toEqual({ allowed: true, reason: "已批准" });
    expect(result.task.status).toBe("running");
    expect(result.effect).toBeNull();
    expect(service.requireTask(task.id).status).toBe("running");
  });

  it("revokes a pending action approval when executable revalidation fails", async ({ onTestFinished }) => {
    const root = mkdtempSync(join(tmpdir(), "hearth-tool-tamper-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const executable = join(root, "tool.exe");
    writeFileSync(executable, "original");
    const action = resolveAction({
      proposal: { kind: "shell", summary: "运行工具", command: { executable, cwd: root } },
      permissionMode: "guarded",
      context: "interactive",
      sessionRoot: root
    });
    const { task, runId } = runningTask(service);
    service.updateTask(task.id, { status: "waiting_approval" }, runId);
    const now = new Date().toISOString();
    const approval: ApprovalRecord = {
      id: randomUUID(),
      taskId: task.id,
      runId,
      kind: "tool.shell",
      summary: "运行工具",
      target: { tool: "shell", executable },
      preview: {},
      parameterHash: "c".repeat(64),
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      decidedAt: null,
      effectId: null,
      createdAt: now,
      goalId: null,
      actionDigest: action.actionDigest,
      permissionMode: "guarded",
      context: "interactive",
      maxUses: 1,
      usedCount: 0,
      approvedBy: null,
      issuedAt: now,
      revokedAt: null,
      action: { resolvedAction: action as unknown as Record<string, unknown>, preauthorized: false },
      rejectionCount: 0
    };
    service.createApproval(approval);
    const manager = new ApprovalManager(service, async () => ({}));
    writeFileSync(executable, "replaced");

    await expect(manager.decide(approval.id, "approve", approval.parameterHash))
      .rejects.toMatchObject({ code: "ACTION_CHANGED" });
    expect(store.getApproval(approval.id)?.status).toBe("revoked");
    expect(service.requireTask(task.id).status).toBe("recoverable");
    expect(store.listEffects(task.id)).toHaveLength(0);
  });

  it("executes local tools immediately and records the policy decision", async () => {
    const manager = new ApprovalManager(service, async () => ({}));
    const { task, runId } = runningTask(service);
    const pending = await manager.requestTool({
      taskId: task.id,
      runId,
      toolName: "shell",
      summary: "运行命令：npm test",
      target: { tool: "shell", arguments: { command: "npm test" } },
      preview: { arguments: { command: "npm test" } }
    });

    expect(pending.approval.status).toBe("consumed");
    await expect(pending.decision).resolves.toEqual({ allowed: true, reason: "无需确认" });
    expect(store.getApproval(pending.approval.id)?.status).toBe("consumed");
    expect(service.requireTask(task.id).status).toBe("running");
    expect(store.listEvents().some((event) =>
      event.type === "approval.auto_approved"
      && (event.payload as { approvalId?: string }).approvalId === pending.approval.id
      && (event.payload as { policy?: string }).policy === "local.direct"
    )).toBe(true);
  });

  it("resumes the agent without executing a rejected tool", async () => {
    const manager = new ApprovalManager(service, async () => ({}));
    const { task, runId } = runningTask(service);
    const pending = await manager.requestTool({
      taskId: task.id,
      runId,
      toolName: "browser_submit",
      summary: "提交网页表单",
      target: { tool: "browser_submit", arguments: { form: "publish" } },
      preview: { arguments: { form: "publish" } }
    });

    const result = await manager.decide(pending.approval.id, "reject", pending.approval.parameterHash);
    await expect(pending.decision).resolves.toEqual({ allowed: false, reason: "用户拒绝了这个工具调用" });
    expect(result.task.status).toBe("running");
    expect(result.effect).toBeNull();
    expect(store.listEffects(task.id)).toHaveLength(0);
  });

  it("resolves a pending tool decision when its approval is cancelled", async () => {
    const manager = new ApprovalManager(service, async () => ({}));
    const { task, runId } = runningTask(service);
    const pending = await manager.requestTool({
      taskId: task.id,
      runId,
      toolName: "browser_submit",
      summary: "提交网页表单",
      target: { tool: "browser_submit", arguments: { form: "publish" } },
      preview: { arguments: { form: "publish" } }
    });

    expect(manager.cancelToolApproval(pending.approval.id, "任务已取消")).toBe(true);
    await expect(pending.decision).resolves.toEqual({ allowed: false, reason: "任务已取消" });
    expect(store.getApproval(pending.approval.id)?.status).toBe("expired");
    expect(service.requireTask(task.id).status).toBe("running");
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

  it("still confirms external effects in full mode and remembers approve-always grants", async () => {
    const conversation = store.createConversation("完全权限对话", {
      executorEnabled: { native: true, codex: true, "deepseek-harness": false },
      approvalMode: "full",
      preferredExecutorId: null
    });
    const task = service.createTask({ title: "Publish PR", goal: "Publish a reviewed pull request", conversationId: conversation.id });
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

    expect(approval.status).toBe("pending");
    expect(calls).toBe(0);
    const decided = await manager.decide(approval.id, "approve_always", approval.parameterHash);
    expect(decided.effect?.status).toBe("succeeded");
    expect(calls).toBe(1);
    expect(service.requireTask(task.id).status).toBe("completed");
    expect(manager.grants.find("external-write", "github.publish-pr")).toBeTruthy();
    expect(store.listEvents().some((event) => event.type === "approval.grant.created")).toBe(true);

    const second = service.createTask({ title: "Publish again", goal: "Publish another pull request", conversationId: conversation.id });
    const secondRunId = randomUUID();
    service.createRun({
      id: secondRunId,
      taskId: second.id,
      attempt: 1,
      status: "running",
      threadId: "thread-full-2",
      workspace: "C:/tmp/full-2",
      startedAt: now,
      endedAt: null,
      failure: null,
      usage: null,
      leaseEpoch: null,
      createdAt: now
    });
    service.updateTask(second.id, { status: "running", currentRunId: secondRunId }, secondRunId);
    service.updateTask(second.id, { status: "waiting_approval", currentRunId: secondRunId }, secondRunId);
    const auto = await manager.request({
      taskId: second.id,
      runId: secondRunId,
      kind: "github.publish-pr",
      summary: "推送分支并创建 PR",
      target: { repo: "example/repo", branch: "hearth/full-2", base: "main" },
      preview: { title: "Second", body: "Reuses the grant" }
    });
    expect(auto.status).toBe("consumed");
    expect(calls).toBe(2);
    const audit = store.listEvents().find((event) => event.type === "approval.auto_approved"
      && (event.payload as { approvalId?: string }).approvalId === auto.id);
    expect(audit?.payload).toMatchObject({ policy: "external-write.grant", actionClass: "external_write" });
  });

  async function waitingTask(service: HearthService) {
    const task = service.createTask({ title: "Publish PR", goal: "Publish a reviewed pull request" });
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
      { title: "Fix issue 16", body: "Test PR body", actionClass: "external_write", canAlwaysAllow: true }
    ));
    return { task: service.requireTask(task.id), approval };
  }

  function runningTask(service: HearthService) {
    const task = service.createTask({ title: "Publish PR", goal: "Publish a reviewed pull request" });
    const now = new Date().toISOString();
    const runId = randomUUID();
    service.createRun({
      id: runId,
      taskId: task.id,
      attempt: 1,
      status: "running",
      threadId: "thread-tool",
      workspace: "C:/tmp/tool",
      startedAt: now,
      endedAt: null,
      failure: null,
      usage: null,
      leaseEpoch: null,
      createdAt: now
    });
    service.updateTask(task.id, { status: "running", currentRunId: runId, nextAction: "正在执行" }, runId);
    return { task: service.requireTask(task.id), runId };
  }
});


