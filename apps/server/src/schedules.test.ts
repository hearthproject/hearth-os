import { afterEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { ScheduleError, ScheduleService } from "./schedules.ts";
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

  function setup(available = true) {
    store = new HearthStore(":memory:");
    const service = new HearthService(store);
    let now = new Date("2026-01-01T00:00:00.000Z");
    const schedules = new ScheduleService({
      service,
      executorAvailable: () => available ? { canRun: true, issues: [] } : { canRun: false, issues: ["未配置"] },
      now: () => now
    });
    return {
      schedules,
      setNow(value: Date) { now = value; }
    };
  }
});
