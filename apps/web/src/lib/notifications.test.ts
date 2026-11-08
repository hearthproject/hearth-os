import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "./types.ts";
import { notificationForEvent } from "./notifications.ts";

function envelope(type: string, payload: unknown, taskId: string | null = "task-1"): EventEnvelope {
  return {
    seq: 1,
    id: "event-1",
    type,
    taskId,
    runId: null,
    payload,
    originInstanceId: null,
    originSeq: null,
    createdAt: "2026-11-08T00:00:00.000Z"
  };
}

describe("notificationForEvent", () => {
  it("maps pending approvals to a task link", () => {
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
      href: "/tasks/task-1"
    });
  });

  it("ignores approvals that are no longer pending", () => {
    expect(notificationForEvent("approval.created", envelope("approval.created", {
      id: "approval-1",
      status: "approved",
      summary: "已自动批准"
    }))).toBeNull();
  });

  it("maps delivered suggestions to the inbox", () => {
    const notification = notificationForEvent("suggestion.event", envelope("suggestion.event", {
      suggestionId: "suggestion-1",
      action: "delivered",
      title: "任务临近截止",
      whyNow: "还有 3 小时到期"
    }));
    expect(notification).toMatchObject({
      tone: "suggestion",
      title: "任务临近截止",
      body: "还有 3 小时到期",
      href: "/inbox"
    });
  });

  it("only notifies waiting_input task updates", () => {
    expect(notificationForEvent("task.updated", envelope("task.updated", { status: "waiting_input" })))
      .toMatchObject({ tone: "task", href: "/tasks/task-1" });
    expect(notificationForEvent("task.updated", envelope("task.updated", { status: "running" }))).toBeNull();
  });

  it("maps uncertain effects to the task", () => {
    expect(notificationForEvent("effect.updated", envelope("effect.updated", { status: "uncertain" })))
      .toMatchObject({ tone: "effect", href: "/tasks/task-1" });
    expect(notificationForEvent("effect.updated", envelope("effect.updated", { status: "succeeded" }))).toBeNull();
  });

  it("returns null without an envelope", () => {
    expect(notificationForEvent("approval.created")).toBeNull();
  });
});