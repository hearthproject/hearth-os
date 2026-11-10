import { describe, expect, it } from "vitest";
import type { ApprovalRecord, EffectRecord } from "@hearth/core";
import { APPROVAL_STATUSES, EFFECT_STATUSES, EXECUTOR_IDS, RUN_STATUSES, TASK_STATUSES } from "@hearth/core";
import {
  APPROVAL_STATUS_LABELS,
  EFFECT_STATUS_LABELS,
  EXECUTOR_LABELS,
  RUN_STATUS_LABELS,
  TASK_STATUS_LABELS,
  eventDescription,
  executorLabel,
  externalEffectSummary,
  statusExplanation
} from "./labels.ts";
import type { TaskRecord } from "./types.ts";

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "approval-1", taskId: "task-1", runId: "run-1", kind: "github.comment", summary: "发布评论",
    target: {}, preview: {}, parameterHash: "a".repeat(64), status: "pending",
    expiresAt: "2026-11-07T00:00:00.000Z", decidedAt: null, effectId: null,
    createdAt: "2026-11-05T00:00:00.000Z", ...overrides
  };
}

function effect(overrides: Partial<EffectRecord> = {}): EffectRecord {
  return {
    id: "effect-1", taskId: "task-1", approvalId: "approval-1", kind: "github.comment",
    idempotencyKey: "approval:approval-1", status: "succeeded", target: {}, receipt: null, error: null,
    createdAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:00.000Z", ...overrides
  };
}

const task = (status: TaskRecord["status"]): TaskRecord => ({
  id: "task-1", templateId: "T01", title: "标题", goal: "目标", status,
  createdAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:00.000Z", deadline: null,
  inputs: [], networkHosts: [], outputDir: ".hearth/artifacts/T01", currentRunId: null, nextAction: null, error: null
});

describe("status labels", () => {
  it("labels every task status without collapsing them", () => {
    const labels = TASK_STATUSES.map((status) => TASK_STATUS_LABELS[status]);
    expect(labels).toHaveLength(8);
    expect(labels.every((label) => label.trim().length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("labels every run, approval and effect status", () => {
    expect(RUN_STATUSES.every((status) => RUN_STATUS_LABELS[status])).toBe(true);
    expect(APPROVAL_STATUSES.every((status) => APPROVAL_STATUS_LABELS[status])).toBe(true);
    expect(EFFECT_STATUSES.every((status) => EFFECT_STATUS_LABELS[status])).toBe(true);
  });

  it("keeps an uncertain external action distinct from a failure", () => {
    expect(EFFECT_STATUS_LABELS.uncertain).not.toBe(EFFECT_STATUS_LABELS.failed);
    expect(EFFECT_STATUS_LABELS.uncertain).toContain("不确定");
  });

  it("explains every status as one next step", () => {
    for (const status of TASK_STATUSES) {
      expect(statusExplanation(task(status)).length).toBeGreaterThan(4);
    }
  });
});

describe("external effect summary", () => {
  it("says so when nothing left this machine", () => {
    expect(externalEffectSummary([], [])).toBe("没有外部动作。");
  });

  it("prompts for a pending confirmation first", () => {
    expect(externalEffectSummary([approval()], [])).toContain("等待你确认");
  });

  it("asks for reconciliation before retrying an uncertain effect", () => {
    const summary = externalEffectSummary([approval({ status: "approved", effectId: "effect-1" })], [effect({ status: "uncertain" })]);
    expect(summary).toContain("不确定");
    expect(summary).toContain("对账");
  });

  it("reports recorded receipts", () => {
    expect(externalEffectSummary([approval({ status: "approved", effectId: "effect-1" })], [effect()])).toContain("回执");
  });
});

describe("event description", () => {
  it("translates a status change into the task label", () => {
    const description = eventDescription({
      seq: 1, id: "e1", type: "task.updated", taskId: "task-1", runId: null,
      payload: { status: "waiting_approval" }, originInstanceId: null, originSeq: 1, createdAt: "2026-11-05T00:00:00.000Z"
    });
    expect(description).toBe("状态变为：等你确认");
  });

  it("shows the progress message from the executor", () => {
    const description = eventDescription({
      seq: 1, id: "e1", type: "task.progress", taskId: "task-1", runId: "run-1",
      payload: { kind: "item.completed", message: "执行了一条命令", at: "2026-11-05T00:00:00.000Z" },
      originInstanceId: null, originSeq: 1, createdAt: "2026-11-05T00:00:00.000Z"
    });
    expect(description).toBe("执行了一条命令");
  });
});

describe("executor labels", () => {
  it("labels every registered executor", () => {
    for (const id of EXECUTOR_IDS) expect(EXECUTOR_LABELS[id]).toBeTruthy();
  });

  it("labels DeepSeek Harness instead of falling back to the raw id", () => {
    expect(executorLabel("deepseek-harness")).toBe("DeepSeek Harness");
  });
});
