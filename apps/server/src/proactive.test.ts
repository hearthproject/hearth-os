import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import type { EffectRecord, EventEnvelope } from "@hearth/core";
import { ProactiveService } from "./proactive.ts";
import { HearthService } from "./service.ts";

describe("ProactiveService", () => {
  let store: HearthStore;
  let service: HearthService;
  let proactive: ProactiveService;
  let now: Date;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    service = new HearthService(store);
    now = new Date(2026, 10, 6, 10, 0, 0, 0);
    proactive = new ProactiveService(service, () => now);
  });

  afterEach(() => {
    proactive.stop();
    vi.useRealTimers();
    store.close();
  });

  function taskWithDeadline(title = "准备发布说明"): string {
    const task = service.createTask({ title, goal: "完成发布准备" });
    store.appendEvent({
      type: "task.updated",
      taskId: task.id,
      payload: { deadline: new Date(now.getTime() + 2 * 3_600_000).toISOString(), updatedAt: now.toISOString() }
    });
    return task.id;
  }

  function seedUncertainEffect(taskId: string): EffectRecord {
    const effect: EffectRecord = {
      id: "effect-uncertain-1",
      taskId,
      approvalId: "approval-1",
      kind: "github.comment",
      idempotencyKey: "approval:approval-1:hash",
      status: "uncertain",
      target: { repo: "owner/repo", pull: 1 },
      receipt: null,
      error: "结果不确定",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    store.appendEvent({ type: "effect.created", taskId, payload: effect });
    return effect;
  }

  it("aggregates repeated triggers into one suggestion", () => {
    taskWithDeadline();
    const first = proactive.scan();
    expect(first.created).toBe(1);
    expect(first.delivered).toBe(1);

    now = new Date(now.getTime() + 10 * 60_000);
    const second = proactive.scan();
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.delivered).toBe(0);

    const suggestions = store.listSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.occurrenceCount).toBe(2);
    expect(suggestions[0]?.triggerKind).toBe("task.deadline");
  });

  it("honors cooldown for new suggestions", () => {
    taskWithDeadline("任务一");
    expect(proactive.scan().delivered).toBe(1);

    taskWithDeadline("任务二");
    now = new Date(now.getTime() + 10 * 60_000);
    const duringCooldown = proactive.scan();
    expect(duringCooldown.created).toBe(1);
    expect(duringCooldown.delivered).toBe(0);

    now = new Date(now.getTime() + 51 * 60_000);
    const afterCooldown = proactive.scan();
    expect(afterCooldown.delivered).toBe(1);
  });

  it("stops delivering when the daily attention budget is exhausted", () => {
    proactive.updateSettings({ dailyLimit: 1, cooldownMinutes: 0 });
    taskWithDeadline("任务一");
    taskWithDeadline("任务二");

    expect(proactive.scan().delivered).toBe(1);
    const exhausted = proactive.scan();
    expect(exhausted.delivered).toBe(0);
    expect(proactive.snapshot().budget.usedToday).toBe(1);
    expect(proactive.snapshot().budget.nextAllowedAt).not.toBeNull();
  });

  it("keeps quiet hours from interrupting but still records suggestions", () => {
    now = new Date(2026, 10, 6, 23, 0, 0, 0);
    taskWithDeadline();

    const result = proactive.scan();
    expect(result.created).toBe(1);
    expect(result.delivered).toBe(0);
    const snapshot = proactive.snapshot();
    expect(snapshot.budget.quiet).toBe(true);
    expect(snapshot.budget.nextAllowedAt).not.toBeNull();
  });

  it("pauses, resumes, and leaves an audit trail", () => {
    taskWithDeadline();
    proactive.pause({ minutes: 30 });

    const paused = proactive.scan();
    expect(paused.delivered).toBe(0);
    expect(proactive.snapshot().budget.paused).toBe(true);

    now = new Date(now.getTime() + 31 * 60_000);
    proactive.pause({ resume: true });
    expect(proactive.scan().delivered).toBe(1);

    const settingsEvents = store.listEvents(0).filter((event) => event.type === "proactive.settings.updated");
    expect(settingsEvents.length).toBeGreaterThanOrEqual(2);
  });

  it("does not notify again after the user ignores a suggestion", () => {
    taskWithDeadline();
    const created = proactive.scan();
    const suggestion = created.suggestions[0];
    expect(suggestion).toBeDefined();
    proactive.ignore(suggestion!.id);

    now = new Date(now.getTime() + 61 * 60_000);
    const rescanned = proactive.scan();
    expect(rescanned.delivered).toBe(0);
    const stored = store.getSuggestion(suggestion!.id);
    expect(stored?.status).toBe("ignored");
    expect(stored?.notifiedAt).not.toBeNull();
  });

  it("redelivers a snoozed suggestion after its reminder time", () => {
    taskWithDeadline();
    const suggestion = proactive.scan().suggestions[0]!;
    proactive.snooze(suggestion.id, 5);

    expect(proactive.snapshot().budget.usedToday).toBe(1);
    now = new Date(now.getTime() + 6 * 60_000);
    const rescanned = proactive.scan();
    expect(rescanned.delivered).toBe(1);
    expect(store.getSuggestion(suggestion.id)?.status).toBe("new");
  });

  it("converts a suggestion into a queued task without bypassing approval", () => {
    const taskId = taskWithDeadline();
    const effect = seedUncertainEffect(taskId);
    const suggestion = proactive.scan().suggestions.find((item) => item.triggerKind === "effect.uncertain");
    expect(suggestion?.requiresApproval).toBe(true);

    const accepted = proactive.accept(suggestion!.id);
    expect(accepted.status).toBe("accepted");
    expect(accepted.taskId).toBeNull();
    expect(store.listAllEffects()).toHaveLength(1);
    expect(store.getEffect(effect.id)?.status).toBe("uncertain");

    const converted = proactive.convert(suggestion!.id, { title: "核对评论结果" });
    const task = store.getTask(converted.taskId);
    expect(task?.status).toBe("queued");
    expect(converted.suggestion.status).toBe("converted");
    expect(store.listAllEffects()).toHaveLength(1);
    expect(store.getEffect(effect.id)?.status).toBe("uncertain");
  });

  it("scans once on startup, then on the configured interval, and stops cleanly", () => {
    vi.useFakeTimers();
    const scan = vi.spyOn(proactive, "scan").mockReturnValue({ created: 0, updated: 0, delivered: 0, suggestions: [] });

    proactive.start(60_000);
    vi.advanceTimersByTime(5_000);
    expect(scan).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(scan).toHaveBeenCalledTimes(2);

    proactive.stop();
    vi.advanceTimersByTime(120_000);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("debounces domain events into a single scan", () => {
    vi.useFakeTimers();
    const scan = vi.spyOn(proactive, "scan").mockReturnValue({ created: 0, updated: 0, delivered: 0, suggestions: [] });
    proactive.start(60_000);
    vi.advanceTimersByTime(5_000);
    scan.mockClear();

    const event: EventEnvelope = {
      seq: 1,
      id: "event-task-updated",
      type: "task.updated",
      taskId: "task-1",
      runId: null,
      payload: {},
      originInstanceId: null,
      originSeq: null,
      createdAt: now.toISOString()
    };
    service.bus.publish(event);
    vi.advanceTimersByTime(1_999);
    expect(scan).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(scan).toHaveBeenCalledTimes(1);

    service.bus.publish({
      ...event,
      seq: 2,
      id: "event-approval-updated",
      type: "approval.updated"
    });
    vi.advanceTimersByTime(2_000);
    expect(scan).toHaveBeenCalledTimes(2);
  });
});
