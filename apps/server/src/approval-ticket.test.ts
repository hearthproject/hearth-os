import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRecord, RunRecord } from "@hearth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { resolveAction } from "./action-resolver.ts";
import { ApprovalManager } from "./approvals.ts";
import { HearthService } from "./service.ts";

describe("approval ticket v2", () => {
  let store: HearthStore;
  let service: HearthService;
  const tempDirs: string[] = [];

  beforeEach(() => {
    store = new HearthStore(":memory:");
    service = new HearthService(store);
  });

  afterEach(() => {
    store.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("persists action binding, context, and one-use counters", () => {
    const task = service.createTask({ templateId: "T07" });
    const runId = createRun(service, task.id);
    const now = new Date().toISOString();
    const approval: ApprovalRecord = {
      id: randomUUID(),
      taskId: task.id,
      runId,
      kind: "tool.shell",
      summary: "运行命令",
      target: { tool: "shell" },
      preview: { command: "npm test" },
      parameterHash: "a".repeat(64),
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      decidedAt: null,
      effectId: null,
      createdAt: now,
      goalId: "goal-1",
      actionDigest: "b".repeat(64),
      permissionMode: "guarded",
      context: "interactive",
      maxUses: 1,
      usedCount: 0,
      approvedBy: null,
      issuedAt: now,
      revokedAt: null,
      action: { actionId: "ACT-1", resolverVersion: "hearth-action-v1" },
      rejectionCount: 0
    };

    service.createApproval(approval);
    expect(store.getApproval(approval.id)).toMatchObject({
      goalId: "goal-1",
      actionDigest: "b".repeat(64),
      permissionMode: "guarded",
      context: "interactive",
      maxUses: 1,
      usedCount: 0,
      action: { actionId: "ACT-1", resolverVersion: "hearth-action-v1" }
    });

    const consumed = service.updateApproval(approval.id, {
      status: "consumed",
      usedCount: 1,
      approvedBy: "user",
      decidedAt: new Date().toISOString()
    });
    expect(consumed).toMatchObject({ status: "consumed", usedCount: 1, approvedBy: "user" });
  });

  it("rejects execution when the executable changed after approval", async () => {
    const root = tempRoot();
    const executable = join(root, process.platform === "win32" ? "fake.cmd" : "fake.sh");
    writeFileSync(executable, process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n", "utf8");
    if (process.platform !== "win32") chmodSync(executable, 0o755);
    const action = resolveAction({
      proposal: {
        kind: "shell",
        summary: "运行测试命令",
        command: { executable, argv: ["--version"], cwd: root }
      },
      permissionMode: "guarded",
      context: "interactive",
      sessionRoot: root
    });
    const task = service.createTask({ templateId: "T07" });
    const runId = createRun(service, task.id, "running");
    const manager = new ApprovalManager(service, async () => ({}));
    const pending = await manager.requestTool({
      taskId: task.id,
      runId,
      toolName: "shell",
      summary: action.summary,
      target: { tool: "shell" },
      preview: { command: action.preview },
      action
    });

    writeFileSync(executable, `${process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n"}echo changed\n`, "utf8");
    await expect(manager.decide(pending.approval.id, "approve", pending.approval.parameterHash))
      .rejects.toMatchObject({ code: "ACTION_CHANGED" });
    expect(store.getApproval(pending.approval.id)?.status).toBe("revoked");
    expect(store.listEvents().some((event) => event.type === "approval.revalidation_failed")).toBe(true);
  });

  it("denies high-risk scheduled actions without preauthorization", async () => {
    const root = tempRoot();
    const action = resolveAction({
      proposal: {
        kind: "email",
        summary: "发送邮件",
        network: { host: "smtp.example.test", port: 465 }
      },
      permissionMode: "guarded",
      context: "scheduled",
      sessionRoot: root
    });
    const task = service.createTask({ templateId: "T07" });
    const runId = createRun(service, task.id, "running");
    const manager = new ApprovalManager(service, async () => ({}));

    await expect(manager.requestTool({
      taskId: task.id,
      runId,
      toolName: "email",
      summary: action.summary,
      target: { tool: "email" },
      preview: { host: "smtp.example.test" },
      action
    })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(service.requireTask(task.id).status).toBe("recoverable");
    expect(store.listEvents().some((event) => event.type === "approval.policy_denied")).toBe(true);
  });

  it("escalates after three consecutive rejections", async () => {
    const task = service.createTask({ templateId: "T07" });
    const runId = createRun(service, task.id, "running");
    const manager = new ApprovalManager(service, async () => ({}));
    for (let index = 0; index < 3; index += 1) {
      const pending = await manager.requestTool({
        taskId: task.id,
        runId,
        toolName: "shell",
        summary: `运行命令 ${index + 1}`,
        target: { tool: "shell", index },
        preview: { command: `echo ${index + 1}` }
      });
      await manager.decide(pending.approval.id, "reject", pending.approval.parameterHash);
    }
    expect(store.listEvents().filter((event) => event.type === "approval.escalation_required")).toHaveLength(1);
    expect(service.requireTask(task.id).nextAction).toContain("人工复核");
  });

  function tempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "hearth-approval-ticket-"));
    tempDirs.push(dir);
    return dir;
  }
});

function createRun(service: HearthService, taskId: string, status: "running" | "waiting_approval" = "waiting_approval"): string {
  const now = new Date().toISOString();
  const runId = randomUUID();
  const run: RunRecord = {
    id: runId,
    taskId,
    attempt: 1,
    status: "running",
    threadId: "thread-approval-ticket",
    workspace: "C:/tmp/approval-ticket",
    startedAt: now,
    endedAt: null,
    failure: null,
    usage: null,
    leaseEpoch: null,
    createdAt: now
  };
  service.createRun(run);
  service.updateTask(taskId, { status: "running", currentRunId: runId }, runId);
  if (status === "waiting_approval") {
    service.updateTask(taskId, { status: "waiting_approval", currentRunId: runId }, runId);
  }
  return runId;
}
