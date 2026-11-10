import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type {
  AttentionItem,
  ApprovalMode,
  EffectRecord,
  ExecutorId,
  FailureClass,
  ScheduleCatchUpPolicy,
  ScheduleRecord,
  ScheduleRunRecord,
  ScheduleRunStatus,
  TaskKind,
  TaskStatus
} from "@hearth/core";
import { defaultConversationSettings } from "@hearth/core";
import { executorName } from "./executors.ts";
import { classifyFailureClass } from "./failure-policy.ts";
import type { HearthService } from "./service.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CATCH_UP_GRACE_MS = DAY_MS;
const DEFAULT_SKIP_TOLERANCE_MS = 5 * 60 * 1000;
const DEFAULT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_MAX_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_MAX_RUNS_PER_TICK = 10;
const MAX_DUE_RUNS_SCAN = 2_000;

export interface ScheduleInput {
  name: string;
  prompt: string;
  cron: string;
  timezone?: string | undefined;
  executorId?: ExecutorId | undefined;
  approvalMode?: ApprovalMode | undefined;
  taskKind?: TaskKind | undefined;
  enabled?: boolean | undefined;
  catchUpPolicy?: ScheduleCatchUpPolicy | undefined;
  catchUpMaxRuns?: number | undefined;
  priority?: number | undefined;
  deleteAfterRun?: boolean | undefined;
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
  catchUpPolicy?: ScheduleCatchUpPolicy | undefined;
  catchUpMaxRuns?: number | undefined;
  priority?: number | undefined;
  deleteAfterRun?: boolean | undefined;
}

export interface ScheduleServiceOptions {
  service: HearthService;
  executorAvailable?: (executorId: ExecutorId) => { canRun: boolean; issues: string[] };
  tickMs?: number;
  now?: () => Date;
  maxRunsPerTick?: number;
  catchUpGraceMs?: number;
  failureCooldownMs?: number;
  maxFailureCooldownMs?: number;
  maxConsecutiveFailures?: number;
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
  private readonly maxRunsPerTick: number;
  private readonly catchUpGraceMs: number;
  private readonly failureCooldownMs: number;
  private readonly maxFailureCooldownMs: number;
  private readonly maxConsecutiveFailures: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private ticking = false;

  constructor(options: ScheduleServiceOptions) {
    this.service = options.service;
    this.executorAvailable = options.executorAvailable ?? (() => ({ canRun: true, issues: [] }));
    this.tickMs = options.tickMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
    this.maxRunsPerTick = boundedInt(options.maxRunsPerTick, DEFAULT_MAX_RUNS_PER_TICK, 1, 100, "maxRunsPerTick");
    this.catchUpGraceMs = boundedInt(options.catchUpGraceMs, DEFAULT_CATCH_UP_GRACE_MS, 0, 30 * DAY_MS, "catchUpGraceMs");
    this.failureCooldownMs = boundedInt(options.failureCooldownMs, DEFAULT_FAILURE_COOLDOWN_MS, 1_000, DAY_MS, "failureCooldownMs");
    this.maxFailureCooldownMs = boundedInt(options.maxFailureCooldownMs, DEFAULT_MAX_FAILURE_COOLDOWN_MS, this.failureCooldownMs, 7 * DAY_MS, "maxFailureCooldownMs");
    this.maxConsecutiveFailures = boundedInt(options.maxConsecutiveFailures, DEFAULT_MAX_CONSECUTIVE_FAILURES, 1, 20, "maxConsecutiveFailures");
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
    const catchUpPolicy = input.catchUpPolicy ?? "run_once";
    const catchUpMaxRuns = boundedInt(input.catchUpMaxRuns, 3, 1, 20, "catchUpMaxRuns");
    const priority = boundedInt(input.priority, 5, 0, 100, "priority");
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
      catchUpPolicy,
      catchUpMaxRuns,
      priority,
      failureCount: 0,
      cooldownUntil: null,
      deleteAfterRun: input.deleteAfterRun ?? false,
      pausedReason: null,
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
    const reenabled = !current.enabled && enabled;
    const next = this.service.store.updateSchedule(id, {
      name,
      prompt,
      cron,
      timezone,
      enabled,
      approvalMode,
      executorId: patch.executorId ?? current.executorId,
      taskKind: patch.taskKind ?? current.taskKind,
      catchUpPolicy: patch.catchUpPolicy ?? current.catchUpPolicy,
      catchUpMaxRuns: patch.catchUpMaxRuns === undefined
        ? current.catchUpMaxRuns
        : boundedInt(patch.catchUpMaxRuns, current.catchUpMaxRuns, 1, 20, "catchUpMaxRuns"),
      priority: patch.priority === undefined
        ? current.priority
        : boundedInt(patch.priority, current.priority, 0, 100, "priority"),
      deleteAfterRun: patch.deleteAfterRun ?? current.deleteAfterRun,
      nextRunAt: enabled
        ? changedSchedule || !current.nextRunAt ? nextRunAt(cron, timezone, this.now()) : current.nextRunAt
        : null,
      ...(reenabled ? { failureCount: 0, cooldownUntil: null, pausedReason: null } : {})
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
    const run = this.trigger(schedule, this.uniqueScheduledFor(schedule.id, this.now()));
    if (!run) throw new ScheduleError("SCHEDULE_RUN_CONFLICT", "这一刻的定时运行已存在，请稍后重试", 409);
    return run;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const due = this.service.store.listSchedules()
        .filter((schedule) => {
          if (!schedule.enabled || !schedule.nextRunAt) return false;
          const dueAt = Date.parse(schedule.nextRunAt);
          if (!Number.isFinite(dueAt) || dueAt > now.getTime()) return false;
          return schedule.cooldownUntil === null || Date.parse(schedule.cooldownUntil) <= now.getTime();
        })
        .sort((left, right) => left.priority - right.priority || Date.parse(left.nextRunAt ?? "") - Date.parse(right.nextRunAt ?? ""));

      let budget = this.maxRunsPerTick;
      for (const dueSchedule of due) {
        if (budget <= 0) break;
        const schedule = this.service.store.getSchedule(dueSchedule.id);
        if (!schedule || !schedule.enabled || !schedule.nextRunAt) continue;
        try {
          budget -= this.processDue(schedule, now, budget);
        } catch (error) {
          this.recordUnexpectedFailure(schedule, error);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private processDue(schedule: ScheduleRecord, now: Date, budget: number): number {
    if (!schedule.nextRunAt || budget <= 0) return 0;
    const dueTimes = this.listDueTimes(schedule, now);
    if (dueTimes.length === 0) return 0;

    const firstDue = dueTimes[0]!;
    const latestDue = dueTimes[dueTimes.length - 1]!;
    let selected: string[] = [];
    let nextAfterBatch: string | null;

    if (schedule.catchUpPolicy === "skip") {
      if (now.getTime() - Date.parse(latestDue) > DEFAULT_SKIP_TOLERANCE_MS) {
        this.skipMissed(schedule, firstDue, "按 skip 策略跳过逾期的计划运行", nextRunAt(schedule.cron, schedule.timezone, now));
        return 0;
      }
      selected = [latestDue];
      nextAfterBatch = nextRunAt(schedule.cron, schedule.timezone, now);
    } else if (schedule.catchUpPolicy === "run_once") {
      if (now.getTime() - Date.parse(firstDue) > this.catchUpGraceMs) {
        this.skipMissed(
          schedule,
          firstDue,
          `错过超过 ${Math.round(this.catchUpGraceMs / 3_600_000)} 小时，已跳过本次补跑`,
          nextRunAt(schedule.cron, schedule.timezone, now)
        );
        return 0;
      }
      selected = [latestDue];
      nextAfterBatch = nextRunAt(schedule.cron, schedule.timezone, now);
    } else {
      if (now.getTime() - Date.parse(firstDue) > this.catchUpGraceMs) {
        this.skipMissed(
          schedule,
          firstDue,
          `错过超过 ${Math.round(this.catchUpGraceMs / 3_600_000)} 小时，已跳过本次补跑`,
          nextRunAt(schedule.cron, schedule.timezone, now)
        );
        return 0;
      }
      selected = dueTimes.slice(0, schedule.catchUpMaxRuns);
      nextAfterBatch = nextRunAt(schedule.cron, schedule.timezone, new Date(selected[selected.length - 1]!));
    }

    selected = selected.slice(0, budget);
    if (selected.length === 0) return 0;

    for (const scheduledFor of selected) {
      const run = this.trigger(schedule, scheduledFor);
      if (!run) continue;
      if (run.status === "queued" || run.status === "running") continue;
      if (schedule.catchUpPolicy !== "run_once" && schedule.catchUpPolicy !== "skip") {
        nextAfterBatch = nextRunAt(schedule.cron, schedule.timezone, new Date(scheduledFor));
      }
      break;
    }

    const current = this.service.store.getSchedule(schedule.id);
    if (current?.enabled) {
      this.service.store.updateSchedule(schedule.id, { nextRunAt: nextAfterBatch });
      this.publish("schedule.updated", this.require(schedule.id));
    }
    return selected.length;
  }

  private listDueTimes(schedule: ScheduleRecord, now: Date): string[] {
    if (!schedule.nextRunAt) return [];
    let cursor = new Date(schedule.nextRunAt);
    if (!Number.isFinite(cursor.getTime())) return [];
    const result: string[] = [];
    for (let index = 0; index < MAX_DUE_RUNS_SCAN && cursor.getTime() <= now.getTime(); index += 1) {
      const value = cursor.toISOString();
      if (result[result.length - 1] !== value) result.push(value);
      const next = nextRunAt(schedule.cron, schedule.timezone, cursor);
      if (!next) break;
      const nextDate = new Date(next);
      if (nextDate.getTime() <= cursor.getTime()) break;
      cursor = nextDate;
    }
    return result;
  }

  private trigger(schedule: ScheduleRecord, scheduledFor: string): ScheduleRunRecord | null {
    const now = this.now().toISOString();
    const idempotencyKey = `schedule:${schedule.id}:${scheduledFor}`;
    const run: ScheduleRunRecord = {
      id: `SRUN-${randomUUID()}`,
      scheduleId: schedule.id,
      scheduledFor,
      taskId: null,
      effectId: null,
      idempotencyKey,
      attempt: 1,
      failureClass: null,
      receipt: null,
      status: "queued",
      error: null,
      createdAt: now,
      updatedAt: now
    };
    const created = this.service.store.createScheduleRun(run);
    if (!created) return null;
    this.publish("schedule.run.created", created);

    const health = this.executorAvailable(schedule.executorId);
    if (!health.canRun) {
      const message = `${executorName(schedule.executorId)}当前不可用：${health.issues.join("；") || "未检测到配置"}`;
      return this.failRun(schedule, created, message, "internal", "skipped");
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
      return this.failRun(schedule, created, message, classifyFailureClass({ message }), "failed");
    }

    const receipt: Record<string, unknown> = {
      scheduleId: schedule.id,
      scheduledFor,
      taskId: task.id,
      executorId: schedule.executorId,
      conversationId: schedule.conversationId,
      deliveredAt: now
    };
    const effectId = `EFFECT-${randomUUID()}`;
    const effect: EffectRecord = {
      id: effectId,
      taskId: task.id,
      approvalId: `schedule:${schedule.id}`,
      kind: "schedule.trigger",
      idempotencyKey,
      status: "prepared",
      target: receipt,
      receipt: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      effectType: "schedule.trigger",
      replayPolicy: "never_replay",
      attemptCount: 1,
      maxAttempts: 1,
      availableAt: now,
      targetKey: idempotencyKey
    };

    try {
      this.service.createEffect(effect);
      this.service.updateEffect(effect.id, {
        status: "committed",
        receipt,
        error: null,
        updatedAt: this.now().toISOString()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const existing = this.service.store.listAllEffects().find((candidate) => candidate.idempotencyKey === idempotencyKey);
      if (existing && existing.status === "committed" && existing.receipt) {
        const queuedEffect = this.finishQueuedRun(schedule, created, task.id, existing.id, existing.receipt);
        this.maybeDeleteAfterRun(schedule, queuedEffect);
        return queuedEffect;
      }
      if (existing) {
        try {
          this.service.updateEffect(existing.id, { status: "uncertain", error: message, updatedAt: this.now().toISOString() });
        } catch {
          // The pause below still prevents a second delivery.
        }
      }
      return this.markUncertain(schedule, created, task.id, existing?.id ?? null, message);
    }

    const queued = this.finishQueuedRun(schedule, created, task.id, effect.id, receipt);
    this.maybeDeleteAfterRun(schedule, queued);
    return queued;
  }

  private finishQueuedRun(
    schedule: ScheduleRecord,
    run: ScheduleRunRecord,
    taskId: string,
    effectId: string,
    receipt: Record<string, unknown>
  ): ScheduleRunRecord {
    const now = this.now().toISOString();
    const queued = this.service.store.updateScheduleRun(run.id, {
      taskId,
      effectId,
      receipt,
      status: "queued"
    }) ?? run;
    const current = this.service.store.getSchedule(schedule.id);
    if (current) {
      this.service.store.updateSchedule(schedule.id, {
        lastRunAt: now,
        lastTaskId: taskId,
        lastStatus: "queued",
        failureCount: 0,
        cooldownUntil: null,
        pausedReason: current.enabled ? null : current.pausedReason
      });
    }
    this.service.appendChatMessage({
      id: randomUUID(),
      conversationId: schedule.conversationId,
      role: "assistant",
      content: `定时任务「${schedule.name}」已触发并排队。\n\n执行器：${executorName(schedule.executorId)}。后续进度和结果会自动出现在这个对话里。`,
      taskId,
      attachments: [],
      createdAt: now,
      kind: "task_status",
      taskStatus: "queued"
    });
    this.publish("schedule.run.updated", queued);
    const updatedSchedule = this.service.store.getSchedule(schedule.id);
    if (updatedSchedule) this.publish("schedule.updated", updatedSchedule);
    return queued;
  }

  private maybeDeleteAfterRun(schedule: ScheduleRecord, run: ScheduleRunRecord): void {
    if (!schedule.deleteAfterRun) return;
    const effect = run.effectId ? this.service.store.getEffect(run.effectId) : null;
    const receiptTaskId = effect?.receipt?.taskId;
    if (!effect || effect.status !== "committed" || receiptTaskId !== run.taskId) {
      const current = this.service.store.getSchedule(schedule.id);
      if (current) {
        this.service.store.updateSchedule(schedule.id, {
          enabled: false,
          nextRunAt: null,
          pausedReason: "最后一次投递缺少可对账回执，已暂停等待确认"
        });
        this.publish("schedule.updated", this.require(schedule.id));
      }
      return;
    }
    this.service.store.deleteSchedule(schedule.id);
    this.publish("schedule.updated", { id: schedule.id, deleted: true, afterRun: true, conversationKept: true });
  }

  private markUncertain(
    schedule: ScheduleRecord,
    run: ScheduleRunRecord,
    taskId: string,
    effectId: string | null,
    message: string
  ): ScheduleRunRecord {
    const failed = this.service.store.updateScheduleRun(run.id, {
      taskId,
      effectId,
      failureClass: "effect_unknown",
      status: "failed",
      error: `投递结果不确定：${message}`
    }) ?? run;
    this.publish("schedule.run.updated", failed);
    const current = this.service.store.updateSchedule(schedule.id, {
      enabled: false,
      nextRunAt: null,
      lastRunAt: this.now().toISOString(),
      lastTaskId: taskId,
      lastStatus: "failed",
      failureCount: schedule.failureCount + 1,
      cooldownUntil: null,
      pausedReason: "投递结果不确定，必须先对账再继续"
    });
    this.appendScheduleMessage(
      schedule,
      `定时任务「${schedule.name}」已创建任务，但投递回执不确定，计划已暂停。请先核对任务 ${taskId} 和 effect ${effectId ?? "未知"} 的真实状态。`
    );
    if (current) {
      this.raiseAttention(current, "reconcile", "user", "定时投递结果不确定", "核对投递是否真的发生，再决定恢复或取消");
      this.publish("schedule.updated", current);
    }
    return failed;
  }

  private failRun(
    schedule: ScheduleRecord,
    run: ScheduleRunRecord,
    message: string,
    failureClass: FailureClass,
    status: "failed" | "skipped"
  ): ScheduleRunRecord {
    const now = this.now();
    const current = this.service.store.getSchedule(schedule.id) ?? schedule;
    const failureCount = current.failureCount + 1;
    const fatal = failureClass === "auth" || failureClass === "policy_denied" || failureClass === "effect_unknown";
    const paused = fatal || failureCount >= this.maxConsecutiveFailures;
    const cooldownUntil = paused
      ? null
      : new Date(now.getTime() + Math.min(
          this.maxFailureCooldownMs,
          this.failureCooldownMs * 2 ** Math.max(0, failureCount - 1)
        )).toISOString();
    const failed = this.service.store.updateScheduleRun(run.id, {
      status,
      failureClass,
      error: message
    }) ?? run;
    const updated = this.service.store.updateSchedule(schedule.id, {
      enabled: paused ? false : current.enabled,
      nextRunAt: paused ? null : current.nextRunAt,
      lastRunAt: now.toISOString(),
      lastStatus: status,
      failureCount,
      cooldownUntil,
      pausedReason: paused ? this.pausedReasonFor(failureClass, failureCount, message) : null
    });
    this.appendScheduleMessage(
      schedule,
      `${status === "skipped" ? "本次未执行" : "创建执行时失败"}：${message}${paused ? "\n\n连续失败已达到上限，计划已暂停。" : "\n\n计划会按冷却时间自动重试。"}`
    );
    this.publish("schedule.run.updated", failed);
    if (updated) {
      if (paused) {
        this.raiseAttention(
          updated,
          failureClass === "auth" ? "credential" : "decision",
          "user",
          `定时任务已暂停：${schedule.name}`,
          failureClass === "auth" ? "更新凭据后重新启用计划" : "检查失败原因并决定恢复或调整计划"
        );
      }
      this.publish("schedule.updated", updated);
    }
    return failed;
  }

  private pausedReasonFor(failureClass: FailureClass, failureCount: number, message: string): string {
    if (failureClass === "auth") return `认证或凭据失败，已暂停：${message}`;
    if (failureClass === "policy_denied") return `权限策略拒绝，已暂停：${message}`;
    if (failureClass === "effect_unknown") return `投递结果不确定，已暂停等待对账：${message}`;
    return `连续 ${failureCount} 次失败，已自动暂停：${message}`;
  }

  private recordUnexpectedFailure(schedule: ScheduleRecord, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const current = this.service.store.getSchedule(schedule.id);
    if (!current) return;
    const syntheticRun: ScheduleRunRecord = {
      id: `SRUN-${randomUUID()}`,
      scheduleId: schedule.id,
      scheduledFor: this.uniqueScheduledFor(schedule.id, this.now()),
      taskId: null,
      effectId: null,
      idempotencyKey: null,
      attempt: 1,
      failureClass: null,
      receipt: null,
      status: "queued",
      error: null,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString()
    };
    const created = this.service.store.createScheduleRun(syntheticRun);
    if (!created) return;
    this.publish("schedule.run.created", created);
    this.failRun(current, created, message, classifyFailureClass({ message }), "failed");
  }

  private skipMissed(schedule: ScheduleRecord, scheduledFor: string, reason: string, next: string | null): void {
    const now = this.now().toISOString();
    const run = this.service.store.createScheduleRun({
      id: `SRUN-${randomUUID()}`,
      scheduleId: schedule.id,
      scheduledFor,
      taskId: null,
      effectId: null,
      idempotencyKey: `schedule:${schedule.id}:${scheduledFor}`,
      attempt: 1,
      failureClass: null,
      receipt: null,
      status: "skipped",
      error: reason,
      createdAt: now,
      updatedAt: now
    });
    this.service.store.updateSchedule(schedule.id, {
      nextRunAt: next,
      lastRunAt: now,
      lastStatus: "skipped"
    });
    if (run) {
      this.appendScheduleMessage(schedule, `定时任务「${schedule.name}」错过了计划时间（${scheduledFor}）。${reason}。下一次会按计划继续。`);
      this.publish("schedule.run.created", run);
    }
    this.publish("schedule.updated", this.require(schedule.id));
  }

  private raiseAttention(
    schedule: ScheduleRecord,
    kind: AttentionItem["kind"],
    waitingOn: AttentionItem["waitingOn"],
    title: string,
    nextAction: string
  ): void {
    const now = this.now().toISOString();
    const dedupeKey = `schedule:${schedule.id}:attention`;
    const existing = this.service.store.findOpenAttentionByDedupe(dedupeKey);
    const item: AttentionItem = existing
      ? {
          ...existing,
          kind,
          priority: kind === "credential" ? 2 : kind === "reconcile" ? 4 : 5,
          critical: kind === "credential" || kind === "reconcile",
          title,
          waitingOn,
          nextAction,
          consequence: "计划不会继续自动触发，直到问题被处理",
          whyNow: schedule.pausedReason ?? "计划已停止自动执行",
          updatedAt: now
        }
      : {
          id: `ATT-${randomUUID()}`,
          dedupeKey,
          kind,
          priority: kind === "credential" ? 2 : kind === "reconcile" ? 4 : 5,
          critical: kind === "credential" || kind === "reconcile",
          title,
          waitingOn,
          waitingSince: now,
          nextAction,
          consequence: "计划不会继续自动触发，直到问题被处理",
          whyNow: schedule.pausedReason ?? "计划已停止自动执行",
          goalId: null,
          taskId: schedule.lastTaskId,
          intentId: null,
          source: "schedule",
          status: "open",
          snoozeUntil: null,
          createdAt: now,
          updatedAt: now
        };
    const event = this.service.store.appendEvent({ type: "attention.updated", payload: item });
    this.service.bus.publish(event);
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
    const schedule = this.service.store.getSchedule(run.scheduleId);
    if (!schedule) return;
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

function boundedInt(value: number | undefined, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ScheduleError("INVALID_SCHEDULE_SETTING", `${field} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return value;
}

function scheduleStatusForTask(status: TaskStatus): ScheduleRunStatus {
  if (status === "queued") return "queued";
  if (status === "running" || status === "waiting_input" || status === "waiting_approval" || status === "waiting_budget") return "running";
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}
