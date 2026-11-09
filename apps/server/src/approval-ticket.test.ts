import { randomUUID } from "node:crypto";
import type { ApprovalRecord, RunRecord } from "@hearth/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { HearthService } from "./service.ts";

describe("approval ticket v2", () => {
  let store: HearthStore;
  let service: HearthService;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    service = new HearthService(store);
  });

  afterEach(() => store.close());

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
});

function createRun(service: HearthService, taskId: string): string {
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
  service.updateTask(taskId, { status: "waiting_approval", currentRunId: runId }, runId);
  return runId;
}
