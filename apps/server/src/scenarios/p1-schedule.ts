import { ScheduleService } from "../schedules.ts";
import { result, withHarness } from "./common.ts";
import type { ScenarioHandler } from "./types.ts";

export const p1ScheduleScenarios: Record<string, ScenarioHandler> = {
  "reminder-roundtrip": async (context) => withHarness(async (service, store) => {
    context.clock.set("2026-01-01T00:00:00.000Z");
    const schedules = new ScheduleService({
      service,
      now: context.clock.now,
      executorAvailable: () => ({ canRun: true, issues: [] })
    });
    const schedule = schedules.create({ name: "提醒回环", prompt: "提醒假用户", cron: "0 * * * *", executorId: "native" });
    context.clock.set("2026-01-01T01:00:00.000Z");
    await schedules.tick();
    await schedules.tick();
    const firstRuns = schedules.listRuns(schedule.id);
    context.check("single-trigger", firstRuns.length === 1, `同一计划时刻运行次数=${firstRuns.length}`);
    context.check("task-created", Boolean(firstRuns[0]?.taskId && store.getTask(firstRuns[0].taskId)), "计划运行必须关联任务");
    const taskId = firstRuns[0]?.taskId ?? null;
    const taskCountBeforeCancel = store.listTasks().length;
    const createdRunsBeforeCancel = store.listEvents(0).filter((event) => event.type === "schedule.run.created").length;
    context.record("firstRun", firstRuns[0] ?? null);
    context.record("task", taskId ? store.getTask(taskId) : null);
    schedules.remove(schedule.id);
    context.clock.advance(60 * 60_000);
    await schedules.tick();
    const createdRunsAfterCancel = store.listEvents(0).filter((event) => event.type === "schedule.run.created").length;
    const taskCountAfterCancel = store.listTasks().length;
    context.check(
      "cancel-stops",
      store.getSchedule(schedule.id) === null
        && createdRunsAfterCancel === createdRunsBeforeCancel
        && taskCountAfterCancel === taskCountBeforeCancel,
      `计划已删除=${store.getSchedule(schedule.id) === null}, 运行事件=${createdRunsBeforeCancel}->${createdRunsAfterCancel}, 任务数=${taskCountBeforeCancel}->${taskCountAfterCancel}`
    );
    context.record("runsAfterCancel", store.listScheduleRuns(schedule.id));
    context.record("createdRunEvents", { before: createdRunsBeforeCancel, after: createdRunsAfterCancel });
    context.record("taskCounts", { before: taskCountBeforeCancel, after: taskCountAfterCancel });
    return result(context);
  }),

  "schedule-catchup-dst": async (context) => withHarness(async (service, store) => {
    context.clock.set("2026-01-01T00:00:00.000Z");
    const schedules = new ScheduleService({
      service,
      now: context.clock.now,
      executorAvailable: () => ({ canRun: true, issues: [] })
    });
    const catchUp = schedules.create({
      name: "合并补跑",
      prompt: "补跑一次",
      cron: "0 * * * *",
      catchUpPolicy: "run_once",
      executorId: "native"
    });
    context.clock.set("2026-01-01T04:30:00.000Z");
    await schedules.tick();
    const catchRuns = schedules.listRuns(catchUp.id);
    context.check("catch-up-once", catchRuns.length === 1 && catchRuns[0]?.scheduledFor === "2026-01-01T04:00:00.000Z", `补跑=${JSON.stringify(catchRuns.map((run) => run.scheduledFor))}`);
    schedules.remove(catchUp.id);

    context.clock.set("2026-10-31T06:00:00.000Z");
    const dst = schedules.create({
      name: "秋季 DST",
      prompt: "DST 执行",
      cron: "30 1 * * *",
      timezone: "America/New_York",
      executorId: "native"
    });
    context.check("dst-next-run", dst.nextRunAt === "2026-11-01T05:30:00.000Z", `nextRunAt=${dst.nextRunAt}`);
    context.clock.set("2026-11-01T05:30:00.000Z");
    await schedules.tick();
    await schedules.tick();
    context.clock.set("2026-11-01T06:30:00.000Z");
    await schedules.tick();
    const repeated = schedules.listRuns(dst.id);
    context.clock.set("2026-11-02T06:30:00.000Z");
    await schedules.tick();
    const afterNextDay = schedules.listRuns(dst.id);
    context.check("dst-wall-clock-once", repeated.length === 1, `重复墙钟运行次数=${repeated.length}`);
    context.check("dst-next-day-runs", afterNextDay.length === 2, `次日运行总数=${afterNextDay.length}`);
    context.record("catchUpRuns", catchRuns);
    context.record("dstRuns", afterNextDay);
    context.record("taskCount", store.listTasks().length);
    return result(context);
  })
};
