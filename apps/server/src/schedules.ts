import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { ApprovalMode, ExecutorId, ScheduleRecord, ScheduleRunRecord, ScheduleRunStatus, TaskKind, TaskStatus } from "@hearth/core";
import { defaultConversationSettings } from "@hearth/core";
import { executorName } from "./executors.ts";
import type { HearthService } from "./service.ts";

export interface ScheduleInput {
  name: string;
  prompt: string;
  cron: string;
  timezone?: string | undefined;
  executorId?: ExecutorId | undefined;
  approvalMode?: ApprovalMode | undefined;
  taskKind?: TaskKind | undefined;
  enabled?: boolean | undefined;
}

export interface SchedulePatch {
  name?: string | undefined;
  prompt?: string | undefined;
  cron?: string | undefined;
  timezone?: string | undefined;
  executorId?: ExecutorId | undefined;
  approvalMode?: ApprovalMode | undefined;
  taskKind?: TaskKind | undefined;
  enabled?: boolean | undefined;
}

export interface ScheduleServiceOptions {
  service: HearthService;
  executorAvailable?: (executorId: ExecutorId) => { canRun: boolean; issues: string[] };
  tickMs?: number;
  now?: () => Date;
}

export class ScheduleError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "ScheduleError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ScheduleService {
  private readonly service: HearthService;
  private readonly executorAvailable: (executorId: ExecutorId) => { canRun: boolean; issues: string[] };
  private readonly tickMs: number;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private ticking = false;

  constructor(options: ScheduleServiceOptions) {
    this.service = options.service;
    this.executorAvailable = options.executorAvailable ?? (() => ({ canRun: true, issues: [] }));
    this.tickMs = options.tickMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.unsubscribe = this.service.bus.subscribe((event) => {
      if (event.type === "task.updated" && event.taskId) this.syncRunFromTask(event.taskId);
    });
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  list(): ScheduleRecord[] {
    return this.service.store.listSchedules();
  }

  require(id: string): ScheduleRecord {
    const schedule = this.service.store.getSchedule(id);
    if (!schedule) throw new ScheduleError("SCHEDULE_NOT_FOUND", "定时任务不存在", 404);
    return schedule;
  }

  listRuns(id: string): ScheduleRunRecord[] {
    this.require(id);
    return this.service.store.listScheduleRuns(id);
  }

  create(input: ScheduleInput): ScheduleRecord {
    const name = cleanName(input.name);
    const prompt = cleanPrompt(input.prompt);
    const timezone = cleanTimezone(input.timezone);
    const cron = cleanCron(input.cron, timezone);
    const approvalMode = input.approvalMode ?? "necessary";
    const executorId = input.executorId ?? "native";
    const taskKind = input.taskKind ?? "general";
    const enabled = input.enabled ?? true;
    const conversation = this.service.store.createConversation(
      `定时 · ${name}`,
      defaultConversationSettings(approvalMode)
    );
    const now = this.now();
    const schedule: ScheduleRecord = {
      id: `SCHED-${randomUUID()}`,
      name,
      prompt,
      cron,
      timezone,
      enabled,
      conversationId: conversation.id,
      executorId,
      approvalMode,
      taskKind,
      nextRunAt: enabled ? nextRunAt(cron, timezone, now) : null,
      lastRunAt: null,
      lastTaskId: null,
      lastStatus: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.service.store.createSchedule(schedule);
    this.publish("schedule.created", schedule);
    return schedule;
  }

  update(id: string, patch: SchedulePatch): ScheduleRecord {
    const current = this.require(id);
    const name = patch.name === undefined ? current.name : cleanName(patch.name);
    const prompt = patch.prompt === undefined ? current.prompt : cleanPrompt(patch.prompt);
    const timezone = patch.timezone === undefined ? current.timezone : cleanTimezone(patch.timezone);
    const cron = patch.cron === undefined ? current.cron : cleanCron(patch.cron, timezone);
    const enabled = patch.enabled ?? current.enabled;
    const approvalMode = patch.approvalMode ?? current.approvalMode;
    const changedSchedule = patch.cron !== undefined || patch.timezone !== undefined || patch.enabled !== undefined;
    const next = this.service.store.updateSchedule(id, {
      name,
      prompt,
      cron,
      timezone,
      enabled,
      approvalMode,
      executorId: patch.executorId ?? current.executorId,
      taskKind: patch.taskKind ?? current.taskKind,
      nextRunAt: enabled
        ? changedSchedule || !current.nextRunAt ? nextRunAt(cron, timezone, this.now()) : current.nextRunAt
        : null
    });
    if (!next) throw new ScheduleError("SCHEDULE_NOT_FOUND", "定时任务不存在", 404);
    if (name !== current.name) this.service.store.renameConversation(current.conversationId, `定时 · ${name}`);
    const executorId = patch.executorId ?? current.executorId;
    this.service.store.updateConversationSettings(current.conversationId, {
      approvalMode,
      executorEnabled: { [executorId]: true }
    });
    this.publish("schedule.updated", next);
    return next;
  }

  remove(id: string): void {
    this.require(id);
    this.service.store.deleteSchedule(id);
    this.publish("schedule.updated", { id, deleted: true, conversationKept: true });
  }

  runNow(id: string): ScheduleRunRecord {
    const schedule = this.require(id);
    const health = this.executorAvailable(schedule.executorId);
    if (!health.canRun) {
      throw new ScheduleError("EXECUTOR_UNAVAILABLE", `${executorName(schedule.executorId)}当前不可用：${health.issues.join("；") || "未检测到配置"}`, 409);
    }
    const run = this.trigger(schedule, this.uniqueScheduledFor(schedule.id, this.now()), false);
    if (!run) throw new ScheduleError("SCHEDULE_RUN_CONFLICT", "这一刻的定时运行已存在，请稍后重试", 409);
    return run;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const schedule of this.service.store.listSchedules()) {
        if (!schedule.enabled || !schedule.nextRunAt) continue;
        const due = Date.parse(schedule.nextRunAt);
        if (!Number.isFinite(due) || due > now.getTime()) continue;
        const missedBy = now.getTime() - due;
        if (missedBy > 24 * 60 * 60 * 1000) {
          this.skipMissed(schedule, schedule.nextRunAt, "错过超过 24 小时，已跳过这一次运行");
          continue;
        }
        const triggered = this.trigger(schedule, schedule.nextRunAt, true);
        if (!triggered) {
          this.service.store.updateSchedule(schedule.id, {
            nextRunAt: nextRunAt(schedule.cron, schedule.timezone, now)
          });
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private trigger(schedule: ScheduleRecord, scheduledFor: string, advance: boolean): ScheduleRunRecord | null {
    const now = this.now().toISOString();
    const run: ScheduleRunRecord = {
      id: `SRUN-${randomUUID()}`,
      scheduleId: schedule.id,
      scheduledFor,
      taskId: null,
      status: "queued",
      error: null,
      createdAt: now,
      updatedAt: now
    };
    const created = this.service.store.createScheduleRun(run);
    if (!created) return null;
    this.publish("schedule.run.created", created);

    const nextRun = advance ? nextRunAt(schedule.cron, schedule.timezone, this.now()) : schedule.nextRunAt;
    const health = this.executorAvailable(schedule.executorId);
    if (!health.canRun) {
      const message = `${executorName(schedule.executorId)}当前不可用：${health.issues.join("；") || "未检测到配置"}`;
      const skipped = this.service.store.updateScheduleRun(created.id, { status: "skipped", error: message });
      this.service.store.updateSchedule(schedule.id, { nextRunAt: nextRun, lastRunAt: now, lastStatus: "skipped" });
      this.appendScheduleMessage(schedule, `定时任务「${schedule.name}」本次未执行。\n\n${message}\n\n在设置里完成配置后可以点“立即运行”补跑。`);
      if (skipped) this.publish("schedule.run.updated", skipped);
      this.publish("schedule.updated", this.require(schedule.id));
      return skipped ?? created;
    }

    let task;
    try {
      task = this.service.createTask({
        title: `定时：${schedule.name}`,
        goal: schedule.prompt,
        textInput: schedule.prompt,
        conversationId: schedule.conversationId,
        executorId: schedule.executorId,
        taskKind: schedule.taskKind,
        expectedOutputs: ["result.md"]
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.service.store.updateScheduleRun(created.id, { status: "failed", error: message });
      this.service.store.updateSchedule(schedule.id, { nextRunAt: nextRun, lastRunAt: now, lastStatus: "failed" });
      this.appendScheduleMessage(schedule, `定时任务「${schedule.name}」创建执行时失败：${message}`);
      if (failed) this.publish("schedule.run.updated", failed);
      this.publish("schedule.updated", this.require(schedule.id));
      return failed ?? created;
    }

    const queued = this.service.store.updateScheduleRun(created.id, { taskId: task.id, status: "queued" }) ?? created;
    this.service.store.updateSchedule(schedule.id, {
      nextRunAt: nextRun,
      lastRunAt: now,
      lastTaskId: task.id,
      lastStatus: "queued"
    });
    this.service.appendChatMessage({
      id: randomUUID(),
      conversationId: schedule.conversationId,
      role: "assistant",
      content: `定时任务「${schedule.name}」已触发并排队。\n\n执行器：${executorName(schedule.executorId)}。后续进度和结果会自动出现在这个对话里。`,
      taskId: task.id,
      attachments: [],
      createdAt: now,
      kind: "task_status",
      taskStatus: "queued"
    });
    this.publish("schedule.run.updated", queued);
    this.publish("schedule.updated", this.require(schedule.id));
    return queued;
  }

  private skipMissed(schedule: ScheduleRecord, scheduledFor: string, reason: string): void {
    const now = this.now().toISOString();
    const run = this.service.store.createScheduleRun({
      id: `SRUN-${randomUUID()}`,
      scheduleId: schedule.id,
      scheduledFor,
      taskId: null,
      status: "skipped",
      error: reason,
      createdAt: now,
      updatedAt: now
    });
    this.service.store.updateSchedule(schedule.id, {
      nextRunAt: nextRunAt(schedule.cron, schedule.timezone, this.now()),
      lastRunAt: now,
      lastStatus: "skipped"
    });
    if (run) {
      this.appendScheduleMessage(schedule, `定时任务「${schedule.name}」错过了计划时间（${scheduledFor}）。${reason}。下一次会按计划继续。`);
      this.publish("schedule.run.created", run);
    }
    this.publish("schedule.updated", this.require(schedule.id));
  }

  private appendScheduleMessage(schedule: ScheduleRecord, content: string): void {
    this.service.appendChatMessage({
      id: randomUUID(),
      conversationId: schedule.conversationId,
      role: "assistant",
      content,
      taskId: null,
      attachments: [],
      createdAt: this.now().toISOString(),
      kind: "task_status",
      taskStatus: null
    });
  }

  private syncRunFromTask(taskId: string): void {
    const run = this.service.store.listScheduleRunByTask(taskId);
    if (!run) return;
    const task = this.service.store.getTask(taskId);
    if (!task) return;
    const status = scheduleStatusForTask(task.status);
    if (status === run.status) return;
    const updated = this.service.store.updateScheduleRun(run.id, { status });
    this.service.store.updateSchedule(run.scheduleId, { lastStatus: status, lastTaskId: taskId });
    if (updated) this.publish("schedule.run.updated", updated);
    this.publish("schedule.updated", this.service.store.getSchedule(run.scheduleId));
  }

  private uniqueScheduledFor(scheduleId: string, date: Date): string {
    let candidate = date.getTime();
    while (this.service.store.listScheduleRuns(scheduleId, 500).some((run) => run.scheduledFor === new Date(candidate).toISOString())) {
      candidate += 1;
    }
    return new Date(candidate).toISOString();
  }

  private publish(type: string, payload: unknown): void {
    const event = this.service.store.appendEvent({ type, payload });
    this.service.bus.publish(event);
  }
}

export function validateCron(cron: string, timezone: string): string {
  return cleanCron(cron, timezone);
}

export function timezoneIsValid(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function cleanName(value: string): string {
  const name = value.trim();
  if (!name) throw new ScheduleError("INVALID_SCHEDULE_NAME", "请填写定时任务名称");
  return name.slice(0, 80);
}

function cleanPrompt(value: string): string {
  const prompt = value.trim();
  if (!prompt) throw new ScheduleError("INVALID_SCHEDULE_PROMPT", "请填写固定提示词");
  return prompt.slice(0, 20_000);
}

function cleanTimezone(value: string | undefined): string {
  const timezone = value?.trim() || "Asia/Shanghai";
  if (!timezoneIsValid(timezone)) throw new ScheduleError("INVALID_TIMEZONE", `时区无效：${timezone}`);
  return timezone;
}

function cleanCron(value: string, timezone: string): string {
  const cron = value.trim();
  if (!cron) throw new ScheduleError("INVALID_CRON", "请填写 Cron 表达式");
  try {
    const instance = new Cron(cron, { timezone, paused: true });
    instance.stop();
  } catch (error) {
    throw new ScheduleError("INVALID_CRON", `Cron 表达式无效：${error instanceof Error ? error.message : String(error)}`);
  }
  return cron;
}

function nextRunAt(cron: string, timezone: string, from: Date): string | null {
  const instance = new Cron(cron, { timezone, paused: true });
  try {
    return instance.nextRun(from)?.toISOString() ?? null;
  } finally {
    instance.stop();
  }
}

function scheduleStatusForTask(status: TaskStatus): ScheduleRunStatus {
  if (status === "queued") return "queued";
  if (status === "running" || status === "waiting_input" || status === "waiting_approval") return "running";
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}
