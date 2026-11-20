import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "./types.ts";
import { notificationForEvent } from "./notifications.ts";

function envelope(type: string, payload: unknown, taskId: string | null = "task-1", runId: string | null = null): EventEnvelope {
  return {
    seq: 1,
    id: "event-1",
    type,
    taskId,
    runId,
    payload,
    originInstanceId: null,
    originSeq: null,
    createdAt: "2026-11-08T00:00:00.000Z"
  };
}

describe("notificationForEvent", () => {
  it("maps pending approvals to the conversation", () => {
    const notification = notificationForEvent("approval.created", envelope("approval.created", {
      id: "approval-1",
      taskId: "task-1",
      status: "pending",
      summary: "发送邮件给客户"
    }));
    expect(notification).toMatchObject({
      tone: "approval",
      title: "有一项外部动作等你确认",
      body: "发送邮件给客户",
      href: "/"
    });
  });

  it("ignores approvals that are no longer pending", () => {
    expect(notificationForEvent("approval.created", envelope("approval.created", {
      id: "approval-1",
      status: "approved",
      summary: "已自动批准"
    }))).toBeNull();
  });

  it("does not surface task status as a notification", () => {
    expect(notificationForEvent("task.updated", envelope("task.updated", { status: "waiting_input" }))).toBeNull();
    expect(notificationForEvent("task.updated", envelope("task.updated", { status: "waiting_budget" }, "task-1", "run-1"))).toBeNull();
    expect(notificationForEvent("task.budget.exhausted", envelope("task.budget.exhausted", { dimension: "tokens" }, "task-1", "run-1"))).toBeNull();
  });

  it("maps uncertain effects to the conversation", () => {
    expect(notificationForEvent("effect.updated", envelope("effect.updated", { status: "uncertain" })))
      .toMatchObject({ tone: "effect", href: "/" });
    expect(notificationForEvent("effect.updated", envelope("effect.updated", { status: "succeeded" }))).toBeNull();
  });

  it("returns null without an envelope", () => {
    expect(notificationForEvent("approval.created")).toBeNull();
  });
});
