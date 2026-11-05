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
    const { task, approval } = waitingTask(service);

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
    const { approval } = waitingTask(service);

    await expect(manager.decide(approval.id, "approve", "0".repeat(64)))
      .rejects.toMatchObject({ code: "PARAMETERS_CHANGED" });
    expect(calls).toBe(0);
    expect(store.listEffects(approval.taskId)).toHaveLength(0);
  });

  it("records a rejection without executing the effect", async () => {
    let calls = 0;
    const manager = new ApprovalManager(service, async () => {
      calls += 1;
      return {};
    });
    const { task, approval } = waitingTask(service);

    const result = await manager.decide(approval.id, "reject", approval.parameterHash);
    expect(result.task.status).toBe("recoverable");
    expect(result.task.error?.kind).toBe("approval_rejected");
    expect(result.effect).toBeNull();
    expect(calls).toBe(0);
    expect(service.requireTask(task.id).status).toBe("recoverable");
  });

  it("marks an uncertain effect and asks the user to verify before retrying", async () => {
    const manager = new ApprovalManager(service, async () => {
      throw new EffectUncertainError("request timed out after upload");
    });
    const { task, approval } = waitingTask(service);

    const result = await manager.decide(approval.id, "approve", approval.parameterHash);
    expect(result.effect?.status).toBe("uncertain");
    expect(result.task.status).toBe("recoverable");
    expect(result.task.error?.kind).toBe("effect_uncertain");
    expect(service.requireTask(task.id).status).toBe("recoverable");
  });

  function waitingTask(service: HearthService) {
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
      createdAt: now
    };
    service.createRun(run);
    service.updateTask(task.id, { status: "running", currentRunId: runId, nextAction: "正在执行" }, runId);
    service.updateTask(task.id, { status: "waiting_approval", currentRunId: runId, nextAction: "等待确认" }, runId);
    const manager = new ApprovalManager(service, async () => ({}));
    const approval = manager.request({
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
