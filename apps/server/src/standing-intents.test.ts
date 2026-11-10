import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { HearthService } from "./service.ts";
import { StandingIntentService } from "./standing-intents.ts";

describe("StandingIntentService", () => {
  let store: HearthStore;
  let service: HearthService;
  let intents: StandingIntentService;
  let now: Date;
  const notify = vi.fn();

  beforeEach(() => {
    store = new HearthStore(":memory:");
    service = new HearthService(store);
    now = new Date(2026, 10, 10, 10, 0, 0, 0);
    notify.mockReset();
    intents = new StandingIntentService({ service, clock: () => now, notifier: notify });
  });

  afterEach(() => {
    intents.stop();
    store.close();
  });

  function createIntent(overrides: Partial<Parameters<StandingIntentService["create"]>[0]> = {}) {
    return intents.create({
      description: "发布前提醒检查回滚负责人",
      triggerEntries: [{ terms: ["发布", "rollback"], mode: "all" }],
      scope: { anywhere: true },
      cooldownSeconds: 0,
      ...overrides
    });
  }

  it("matches deterministically with CJK substrings and Latin whole words", () => {
    createIntent();
    const fired = intents.match({ text: "准备发布，请确认 rollback 负责人" });
    expect(fired).toHaveLength(1);
    expect(fired[0]?.intent.fireCount).toBe(1);
    expect(fired[0]?.attention.kind).toBe("progress");
    expect(store.listAttentionItems({ status: "open" })).toHaveLength(1);

    const latin = createIntent({
      description: "cat 提醒",
      triggerEntries: [{ terms: ["cat"], mode: "any" }]
    });
    expect(intents.match({ text: "concatenate strings" })).toHaveLength(0);
    expect(intents.match({ text: "a cat appeared" })).toHaveLength(1);
    expect(intents.get(latin.id)?.fireCount).toBe(1);
  });

  it("enforces scope, expiry, cooldown, max fires, and explicit cancellation", () => {
    const scoped = createIntent({
      scope: { channel: "feishu", sender: "user-1", taskId: null, goalId: null, anywhere: false }
    });
    expect(intents.match({ text: "发布 rollback", channel: "web", sender: "user-1" })).toHaveLength(0);
    expect(intents.match({ text: "发布 rollback", channel: "feishu", sender: "user-1" })).toHaveLength(1);

    const limited = createIntent({
      description: "两次提醒",
      cooldownSeconds: 600,
      maxFires: 2
    });
    expect(intents.match({ text: "发布 rollback" })).toHaveLength(1);
    expect(intents.get(limited.id)?.fireCount).toBe(1);
    expect(intents.match({ text: "发布 rollback" })).toHaveLength(0);

    now = new Date(now.getTime() + 601_000);
    expect(intents.match({ text: "发布 rollback" })).toHaveLength(1);
    expect(intents.get(limited.id)?.state).toBe("done");
    now = new Date(now.getTime() + 601_000);
    expect(intents.match({ text: "发布 rollback" })).toHaveLength(0);

    intents.cancel(scoped.id);
    expect(intents.get(scoped.id)?.state).toBe("cancelled");
    expect(intents.match({ text: "发布 rollback", channel: "feishu", sender: "user-1" })).toHaveLength(0);
  });

  it("supports pending to armed and expires stale intents", () => {
    const pending = createIntent({ description: "待确认", armed: false });
    expect(pending.state).toBe("pending");
    expect(intents.match({ text: "发布 rollback" })).toHaveLength(0);
    intents.arm(pending.id);
    expect(intents.match({ text: "发布 rollback" })).toHaveLength(1);

    const expired = createIntent({
      description: "已过期",
      expiresAt: new Date(now.getTime() - 1_000).toISOString()
    });
    expect(intents.match({ text: "发布 rollback" })).toHaveLength(1);
    expect(intents.get(expired.id)?.state).toBe("expired");
  });

  it("records NO_REPLY without invoking the notifier", async () => {
    const run = await intents.heartbeat();
    expect(run.decision).toBe("NO_REPLY");
    expect(run.attentionIds).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(store.latestHeartbeatRun()?.decision).toBe("NO_REPLY");
  });

  it("creates a due-goal attention item and respects the daily budget", async () => {
    service.createGoal({
      title: "发布 1",
      objective: "完成发布",
      deadline: new Date(now.getTime() - 60_000).toISOString(),
      currentState: "active"
    });
    service.createGoal({
      title: "发布 2",
      objective: "完成发布",
      deadline: new Date(now.getTime() - 60_000).toISOString(),
      currentState: "active"
    });
    intents.updateBudget({ dailyLimit: 1, cooldownSeconds: 0, quietStart: "00:00", quietEnd: "00:00" });

    const first = await intents.heartbeat();
    expect(first.decision).toBe("notify");
    expect(first.attentionIds).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);

    const second = await intents.heartbeat();
    expect(second.decision).toBe("NO_REPLY");
    expect(second.reason).toContain("每日预算");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("sorts the attention queue by blocking severity and lowers ignored kinds", () => {
    const suggestion = intents.ensureAttention({
      dedupeKey: "s1",
      kind: "suggestion",
      title: "低优先级建议",
      waitingOn: "user",
      nextAction: "查看",
      consequence: "错过",
      whyNow: "现在",
      source: "test"
    });
    const progress = intents.ensureAttention({
      dedupeKey: "p1",
      kind: "progress",
      title: "进度",
      waitingOn: "user",
      nextAction: "查看",
      consequence: "错过",
      whyNow: "现在",
      source: "test"
    });
    const decision = intents.ensureAttention({
      dedupeKey: "d1",
      kind: "decision",
      title: "决策",
      waitingOn: "user",
      nextAction: "决定",
      consequence: "阻塞",
      whyNow: "现在",
      source: "test"
    });
    expect(intents.queue().map((item) => item.id)).toEqual([decision.id, progress.id, suggestion.id]);

    intents.ignore(suggestion.id);
    const nextSuggestion = intents.ensureAttention({
      dedupeKey: "s2",
      kind: "suggestion",
      title: "另一个建议",
      waitingOn: "user",
      nextAction: "查看",
      consequence: "错过",
      whyNow: "现在",
      source: "test"
    });
    expect(intents.queue().map((item) => item.id)).toEqual([decision.id, progress.id, nextSuggestion.id]);
  });
});
