import { afterEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { ScheduleError, ScheduleService, type ScheduleServiceOptions } from "./schedules.ts";
import { HearthService } from "./service.ts";

describe("schedule service", () => {
  let store: HearthStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
  });

  it("validates cron and timezone before creating a schedule", () => {
    const { schedules } = setup();
    expect(() => schedules.create({ name: "坏计划", prompt: "测试", cron: "not a cron" })).toThrow(ScheduleError);
    expect(() => schedules.create({ name: "坏时区", prompt: "测试", cron: "0 9 * * *", timezone: "Mars/Olympus" })).toThrow(/时区无效/);

    const schedule = schedules.create({ name: "每日", prompt: "生成简报", cron: "0 9 * * *", timezone: "Asia/Shanghai" });
    expect(schedule.nextRunAt).toBe("2026-01-01T01:00:00.000Z");
    const conversation = store?.getConversation(schedule.conversationId);
    expect(conversation?.title).toBe("定时 · 每日");
    expect(conversation?.settings.approvalMode).toBe("necessary");
  });

  it("triggers a due schedule once and records the task in its conversation", async () => {
    const state = setup();
    const schedule = state.schedules.create({ name: "每小时", prompt: "检查一次", cron: "0 * * * *", executorId: "native" });
    state.setNow(new Date("2026-01-01T01:00:00.000Z"));

    await state.schedules.tick();
    await state.schedules.tick();

    const runs = store?.listScheduleRuns(schedule.id) ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("queued");
    expect(runs[0]?.taskId).toBeTruthy();
    expect(store?.listTasks()).toHaveLength(1);
    expect(store?.listChatMessages(schedule.conversationId).some((message) => message.content.includes("已触发并排队"))).toBe(true);
    expect(store?.getSchedule(schedule.id)?.nextRunAt).toBe("2026-01-01T02:00:00.000Z");
  });

  it("catches up a run missed within 24 hours and skips older misses", async () => {
    const state = setup();
    const catchUp = state.schedules.create({ name: "补跑", prompt: "补跑一次", cron: "0 9 * * *" });
    state.setNow(new Date("2026-01-01T20:00:00.000Z"));
    await state.schedules.tick();
    const caught = store?.listScheduleRuns(catchUp.id) ?? [];
    expect(caught).toHaveLength(1);
    expect(caught[0]?.scheduledFor).toBe("2026-01-01T01:00:00.000Z");

    const old = state.schedules.create({ name: "过旧", prompt: "不应补跑", cron: "0 9 * * *" });
    state.setNow(new Date("2026-01-04T00:00:00.000Z"));
    await state.schedules.tick();
    const skipped = store?.listScheduleRuns(old.id) ?? [];
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.status).toBe("skipped");
    expect(store?.listTasks().filter((task) => task.title === "定时：过旧")).toHaveLength(0);
  });

  it("supports pause, resume and run-now", async () => {
    const state = setup();
    const schedule = state.schedules.create({ name: "可暂停", prompt: "执行", cron: "0 9 * * *" });
    const paused = state.schedules.update(schedule.id, { enabled: false });
    expect(paused.enabled).toBe(false);
    expect(paused.nextRunAt).toBeNull();
    const resumed = state.schedules.update(schedule.id, { enabled: true });
    expect(resumed.enabled).toBe(true);
    expect(resumed.nextRunAt).toBeTruthy();

    const run = state.schedules.runNow(schedule.id);
    expect(run.status).toBe("queued");
    expect(run.taskId).toBeTruthy();
  });

  it("records a skipped run when the executor is unavailable", async () => {
    const state = setup(false);
    const schedule = state.schedules.create({ name: "Hermes 计划", prompt: "执行", cron: "0 * * * *", executorId: "hermes" });
    state.setNow(new Date("2026-01-01T01:00:00.000Z"));
    await state.schedules.tick();
    const runs = store?.listScheduleRuns(schedule.id) ?? [];
    expect(runs[0]?.status).toBe("skipped");
    expect(runs[0]?.error).toContain("当前不可用");
    expect(store?.listTasks()).toHaveLength(0);
    expect(store?.listChatMessages(schedule.conversationId).some((message) => message.content.includes("本次未执行"))).toBe(true);
    expect(() => state.schedules.runNow(schedule.id)).toThrow(/当前不可用/);
  });

  it("collapses multiple missed periods to the latest run with run_once", async () => {
    const state = setup();
    const schedule = state.schedules.create({ name: "合并补跑", prompt: "执行", cron: "0 * * * *", catchUpPolicy: "run_once" });
    state.setNow(new Date("2026-01-01T04:30:00.000Z"));

    await state.schedules.tick();

    const runs = store?.listScheduleRuns(schedule.id) ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.scheduledFor).toBe("2026-01-01T04:00:00.000Z");
    expect(store?.getSchedule(schedule.id)?.nextRunAt).toBe("2026-01-01T05:00:00.000Z");
  });

  it("runs all missed periods in bounded batches", async () => {
    const state = setup();
    const schedule = state.schedules.create({
      name: "严格补跑",
      prompt: "执行",
      cron: "0 * * * *",
      catchUpPolicy: "run_all_bounded",
      catchUpMaxRuns: 3
    });
    state.setNow(new Date("2026-01-01T05:30:00.000Z"));

    await state.schedules.tick();
    expect((store?.listScheduleRuns(schedule.id) ?? []).map((run) => run.scheduledFor).sort()).toEqual([
      "2026-01-01T01:00:00.000Z",
      "2026-01-01T02:00:00.000Z",
      "2026-01-01T03:00:00.000Z"
    ]);
    expect(store?.getSchedule(schedule.id)?.nextRunAt).toBe("2026-01-01T04:00:00.000Z");

    await state.schedules.tick();
    expect(store?.listScheduleRuns(schedule.id)).toHaveLength(5);
    expect(store?.getSchedule(schedule.id)?.nextRunAt).toBe("2026-01-01T06:00:00.000Z");
  });

  it("skips overdue runs when the catch-up policy forbids them", async () => {
    const state = setup();
    const schedule = state.schedules.create({ name: "不补跑", prompt: "执行", cron: "0 * * * *", catchUpPolicy: "skip" });
    state.setNow(new Date("2026-01-01T01:10:00.000Z"));

    await state.schedules.tick();

    const runs = store?.listScheduleRuns(schedule.id) ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("skipped");
    expect(store?.listTasks()).toHaveLength(0);
  });

  it("puts a failed schedule into cooldown without blocking other schedules", async () => {
    const state = setup((executorId) => executorId !== "hermes", { failureCooldownMs: 5 * 60_000 });
    const failing = state.schedules.create({ name: "失败计划", prompt: "执行", cron: "* * * * *", executorId: "hermes" });
    const healthy = state.schedules.create({ name: "健康计划", prompt: "执行", cron: "* * * * *", executorId: "native" });
    state.setNow(new Date("2026-01-01T00:01:00.000Z"));

    await state.schedules.tick();
    expect(store?.listScheduleRuns(failing.id)).toHaveLength(1);
    expect(store?.listScheduleRuns(healthy.id)).toHaveLength(1);
    expect(store?.listTasks().map((task) => task.title)).toContain("定时：健康计划");
    expect(store?.getSchedule(failing.id)?.cooldownUntil).toBe("2026-01-01T00:06:00.000Z");

    state.setNow(new Date("2026-01-01T00:02:00.000Z"));
    await state.schedules.tick();
    expect(store?.listScheduleRuns(failing.id)).toHaveLength(1);
    expect(store?.listScheduleRuns(healthy.id)).toHaveLength(2);

    state.setNow(new Date("2026-01-01T00:06:00.000Z"));
    await state.schedules.tick();
    expect(store?.listScheduleRuns(failing.id)).toHaveLength(2);
  });

  it("records a standard effect receipt for every triggered run", async () => {
    const state = setup();
    const schedule = state.schedules.create({ name: "幂等投递", prompt: "执行", cron: "0 * * * *" });
    state.setNow(new Date("2026-01-01T01:00:00.000Z"));

    await state.schedules.tick();

    const run = store?.listScheduleRuns(schedule.id)[0];
    expect(run?.effectId).toBeTruthy();
    expect(run?.idempotencyKey).toBe(`schedule:${schedule.id}:2026-01-01T01:00:00.000Z`);
    expect(run?.receipt?.taskId).toBe(run?.taskId);
    const effect = store?.listEffects(run?.taskId ?? "").find((candidate) => candidate.id === run?.effectId);
    expect(effect?.status).toBe("committed");
    expect(effect?.receipt?.scheduleId).toBe(schedule.id);
    expect(effect?.receipt?.scheduledFor).toBe("2026-01-01T01:00:00.000Z");
  });

  it("deletes a one-shot schedule only after the delivery receipt is committed", async () => {
    const state = setup();
    const schedule = state.schedules.create({
      name: "一次性",
      prompt: "只执行一次",
      cron: "0 * * * *",
      deleteAfterRun: true
    });
    state.setNow(new Date("2026-01-01T01:00:00.000Z"));

    await state.schedules.tick();

    expect(store?.getSchedule(schedule.id)).toBeNull();
    expect(store?.getConversation(schedule.conversationId)).not.toBeNull();
    expect(store?.listTasks()).toHaveLength(1);
    const effect = store?.listAllEffects().find((candidate) => candidate.kind === "schedule.trigger");
    expect(effect?.status).toBe("committed");
    expect(effect?.receipt?.scheduleId).toBe(schedule.id);
  });

  it("keeps a one-shot schedule paused when its delivery effect is uncertain", async () => {
    const state = setup();
    const schedule = state.schedules.create({
      name: "不确定投递",
      prompt: "只执行一次",
      cron: "0 * * * *",
      deleteAfterRun: true
    });
    const scheduledFor = "2026-01-01T01:00:00.000Z";
    const idempotencyKey = `schedule:${schedule.id}:${scheduledFor}`;
    const conflict = {
      id: "EFFECT-conflict",
      taskId: "TASK-other",
      approvalId: "schedule-conflict",
      kind: "schedule.trigger",
      idempotencyKey,
      status: "prepared" as const,
      target: {},
      receipt: null,
      error: null,
      createdAt: "2026-01-01T00:59:00.000Z",
      updatedAt: "2026-01-01T00:59:00.000Z"
    };
    state.service.createEffect(conflict);
    state.setNow(new Date(scheduledFor));

    await state.schedules.tick();

    const retained = store?.getSchedule(schedule.id);
    expect(retained).not.toBeNull();
    expect(retained?.enabled).toBe(false);
    expect(retained?.pausedReason).toContain("不确定");
    expect(store?.listScheduleRuns(schedule.id)[0]?.failureClass).toBe("effect_unknown");
    expect(store?.getEffect(conflict.id)?.status).toBe("uncertain");
  });

  it("auto-pauses after consecutive failures and raises one attention item", async () => {
    const state = setup(false, { failureCooldownMs: 60_000, maxConsecutiveFailures: 3 });
    const schedule = state.schedules.create({ name: "持续失败", prompt: "执行", cron: "* * * * *", executorId: "hermes" });

    state.setNow(new Date("2026-01-01T00:01:00.000Z"));
    await state.schedules.tick();
    state.setNow(new Date("2026-01-01T00:02:00.000Z"));
    await state.schedules.tick();
    state.setNow(new Date("2026-01-01T00:04:00.000Z"));
    await state.schedules.tick();

    const paused = store?.getSchedule(schedule.id);
    expect(paused?.enabled).toBe(false);
    expect(paused?.failureCount).toBe(3);
    expect(paused?.pausedReason).toContain("连续 3 次失败");
    expect(store?.listAttentionItems({ status: "open" })).toHaveLength(1);
    expect(store?.listAttentionItems({ status: "open" })[0]?.source).toBe("schedule");
  });

  it("honors priority and a shared per-tick run budget", async () => {
    const state = setup(true, { maxRunsPerTick: 1 });
    const low = state.schedules.create({ name: "低优先级", prompt: "执行", cron: "0 * * * *", priority: 9 });
    const high = state.schedules.create({ name: "高优先级", prompt: "执行", cron: "0 * * * *", priority: 1 });
    state.setNow(new Date("2026-01-01T01:00:00.000Z"));

    await state.schedules.tick();
    const firstBatch = store?.listTasks().map((task) => task.title) ?? [];
    expect(firstBatch).toEqual(["定时：高优先级"]);

    await state.schedules.tick();
    expect(new Set(store?.listTasks().map((task) => task.title))).toEqual(new Set(["定时：高优先级", "定时：低优先级"]));
    expect(store?.listScheduleRuns(low.id)).toHaveLength(1);
  });

  it("does not duplicate the skipped 02:30 run at the spring DST jump", async () => {
    const state = setup();
    state.setNow(new Date("2026-03-07T08:00:00.000Z"));
    const schedule = state.schedules.create({
      name: "春季 DST",
      prompt: "执行",
      cron: "30 2 * * *",
      timezone: "America/New_York"
    });
    expect(schedule.nextRunAt).toBe("2026-03-08T07:00:00.000Z");

    state.setNow(new Date("2026-03-08T07:00:00.000Z"));
    await state.schedules.tick();
    await state.schedules.tick();
    expect(store?.listScheduleRuns(schedule.id)).toHaveLength(1);
    expect(store?.getSchedule(schedule.id)?.nextRunAt).toBe("2026-03-09T06:30:00.000Z");

    state.setNow(new Date("2026-03-09T06:30:00.000Z"));
    await state.schedules.tick();
    expect(store?.listScheduleRuns(schedule.id)).toHaveLength(2);
  });

  it("runs a repeated fall-back wall clock time only once", async () => {
    const state = setup();
    state.setNow(new Date("2026-10-31T06:00:00.000Z"));
    const schedule = state.schedules.create({
      name: "秋季 DST",
      prompt: "执行",
      cron: "30 1 * * *",
      timezone: "America/New_York"
    });
    expect(schedule.nextRunAt).toBe("2026-11-01T05:30:00.000Z");

    state.setNow(new Date("2026-11-01T05:30:00.000Z"));
    await state.schedules.tick();
    expect(store?.listScheduleRuns(schedule.id)).toHaveLength(1);

    state.setNow(new Date("2026-11-01T06:30:00.000Z"));
    await state.schedules.tick();
    expect(store?.listScheduleRuns(schedule.id)).toHaveLength(1);

    state.setNow(new Date("2026-11-02T06:30:00.000Z"));
    await state.schedules.tick();
    expect(store?.listScheduleRuns(schedule.id)).toHaveLength(2);
  });

  it("deletes the plan while preserving its conversation and tasks", () => {
    const state = setup();
    const schedule = state.schedules.create({ name: "待删除", prompt: "执行", cron: "0 9 * * *" });
    const run = state.schedules.runNow(schedule.id);
    expect(run.taskId).toBeTruthy();
    state.schedules.remove(schedule.id);
    expect(store?.getSchedule(schedule.id)).toBeNull();
    expect(store?.getConversation(schedule.conversationId)).not.toBeNull();
    expect(store?.getTask(run.taskId ?? "")).not.toBeNull();
  });

  function setup(
    available: boolean | ((executorId: string) => boolean) = true,
    options: Partial<ScheduleServiceOptions> = {}
  ) {
    store = new HearthStore(":memory:");
    const service = new HearthService(store);
    let now = new Date("2026-01-01T00:00:00.000Z");
    const checkAvailable = typeof available === "function" ? available : () => available;
    const schedules = new ScheduleService({
      service,
      executorAvailable: (executorId) => checkAvailable(executorId)
        ? { canRun: true, issues: [] }
        : { canRun: false, issues: ["未配置"] },
      ...options,
      now: () => now
    });
    return {
      schedules,
      service,
      setNow(value: Date) { now = value; }
    };
  }
});
