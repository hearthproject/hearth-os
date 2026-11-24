import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalRecord } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";
import { HearthService } from "./service.ts";

const PARAMETER_HASH = "a".repeat(64);

function seedPendingExternalApproval(store: HearthStore): ApprovalRecord {
  const now = new Date().toISOString();
  const service = new HearthService(store);
  const task = service.createTask({ title: "提交外部表单", goal: "确认全局停止会拦截外部动作审批" });
  const runId = "run-kill-switch";
  service.createRun({
    id: runId,
    taskId: task.id,
    attempt: 1,
    status: "waiting_approval",
    threadId: null,
    workspace: ".hearth/workspaces/kill-switch",
    startedAt: now,
    endedAt: null,
    failure: null,
    usage: null,
    leaseEpoch: null,
    createdAt: now
  });
  service.updateTask(task.id, {
    status: "running",
    currentRunId: runId,
    nextAction: "准备提交外部表单",
    error: null
  }, runId);
  service.updateTask(task.id, {
    status: "waiting_approval",
    currentRunId: runId,
    nextAction: "等待确认提交外部表单",
    error: null
  }, runId);
  return service.createApproval({
    id: "approval-kill-switch",
    taskId: task.id,
    runId,
    kind: "tool.browser_submit",
    summary: "提交一次外部网页表单",
    target: { tool: "browser_submit" },
    preview: { impact: "会把内容提交到外部服务。" },
    parameterHash: PARAMETER_HASH,
    status: "pending",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    decidedAt: null,
    effectId: null,
    createdAt: now,
    maxUses: 1,
    usedCount: 0,
    approvedBy: null,
    issuedAt: now,
    revokedAt: null,
    action: null,
    rejectionCount: 0
  });
}

describe("security API", () => {
  let store: HearthStore;

  beforeEach(() => {
    store = new HearthStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("blocks approvals and scheduler restart until the kill switch is cleared", async () => {
    const app = await buildServer({ store, serveWeb: false, startScheduler: true });
    try {
      const enabled = await app.inject({
        method: "POST",
        url: "/api/security/kill-switch",
        payload: { enabled: true, reason: "设备丢失演练" }
      });
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json().state).toMatchObject({ killSwitch: true, reason: "设备丢失演练" });

      const approval = seedPendingExternalApproval(store);
      const blocked = await app.inject({
        method: "POST",
        url: `/api/approvals/${approval.id}/decide`,
        payload: { decision: "approve", parameterHash: PARAMETER_HASH }
      });
      expect(blocked.statusCode).toBe(423);
      expect(blocked.json().error).toBe("KILL_SWITCH_ACTIVE");

      const restart = await app.inject({ method: "POST", url: "/api/system/start" });
      expect(restart.statusCode).toBe(423);

      const disabled = await app.inject({
        method: "POST",
        url: "/api/security/kill-switch",
        payload: { enabled: false }
      });
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json().state.killSwitch).toBe(false);

      const approved = await app.inject({
        method: "POST",
        url: `/api/approvals/${approval.id}/decide`,
        payload: { decision: "approve", parameterHash: PARAMETER_HASH }
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().approval.status).toBe("consumed");
      expect(approved.json().effect).toBeNull();

      const snapshot = await app.inject({ method: "GET", url: "/api/security" });
      expect(snapshot.json().audits.map((audit: { action: string }) => audit.action)).toEqual(
        expect.arrayContaining(["security.kill-switch.enabled", "security.kill-switch.disabled"])
      );
    } finally {
      await app.close();
    }
  });
});
