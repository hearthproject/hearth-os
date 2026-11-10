import { randomUUID } from "node:crypto";
import type { TaskRecord, WatchdogAction, WatchdogEvent } from "@hearth/core";
import type { HearthService } from "./service.ts";
import type { StandingIntentService } from "./standing-intents.ts";

export interface WatchdogSettings {
  enabled: boolean;
  shadow: boolean;
  stallMinutes: number;
  maxRunMinutes: number;
  repeatedFailureCount: number;
  failureWindowMinutes: number;
  dedupeMinutes: number;
  intervalMs: number;
  autoCancel: boolean;
}

export interface WatchdogOptions {
  service: HearthService;
  standingIntents?: StandingIntentService;
  settings?: Partial<WatchdogSettings>;
  now?: () => Date;
}

const ACTIVE = new Set(["queued", "running", "waiting_input", "waiting_approval", "waiting_budget", "recoverable"]);
const DEFAULTS: WatchdogSettings = {
  enabled: true,
  shadow: true,
  stallMinutes: 30,
  maxRunMinutes: 120,
  repeatedFailureCount: 3,
  failureWindowMinutes: 60,
  dedupeMinutes: 60,
  intervalMs: 60_000,
  autoCancel: false
};

export class WatchdogService {
  private readonly service: HearthService;
  private readonly standingIntents: StandingIntentService | undefined;
  private readonly now: () => Date;
  private settingsValue: WatchdogSettings;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WatchdogOptions) {
    this.service = options.service;
    this.standingIntents = options.standingIntents;
    this.now = options.now ?? (() => new Date());
    this.settingsValue = { ...DEFAULTS, ...(options.settings ?? {}) };
  }

  settings(): WatchdogSettings {
    return { ...this.settingsValue };
  }

  updateSettings(patch: Partial<WatchdogSettings>): WatchdogSettings {
    this.settingsValue = { ...this.settingsValue, ...clampSettings(patch) };
    return this.settings();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.scan();
      } catch {
        // Watchdog must never take down the scheduler.
      }
    }, this.settingsValue.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  scan(): WatchdogEvent[] {
    if (!this.settingsValue.enabled) return [];
    const now = this.now();
    const events: WatchdogEvent[] = [];
    for (const task of this.service.store.listTasks()) {
      if (!ACTIVE.has(task.status)) continue;
      for (const finding of this.findings(task, now)) {
        if (this.recentlyRecorded(task.id, finding.reason, now)) continue;
        events.push(this.record(task, finding, now));
      }
    }
    return events;
  }

  private findings(task: TaskRecord, now: Date): Array<{ reason: string; detail: string; action: WatchdogAction; critical: boolean }> {
    const findings: Array<{ reason: string; detail: string; action: WatchdogAction; critical: boolean }> = [];
    const settings = this.settingsValue;
    const staleMs = settings.stallMinutes * 60_000;
    const updatedAge = now.getTime() - Date.parse(task.updatedAt);
    if (task.status === "running" && updatedAge >= staleMs) {
      findings.push({
        reason: "task_stalled",
        detail: `任务已 ${Math.round(updatedAge / 60_000)} 分钟没有状态更新（阈值 ${settings.stallMinutes} 分钟）`,
        action: settings.shadow ? "warn" : "pause",
        critical: false
      });
    }
    if (task.status === "running" && task.currentRunId) {
      const run = this.service.store.listRuns(task.id).find((candidate) => candidate.id === task.currentRunId);
      if (run) {
        const runAge = now.getTime() - Date.parse(run.startedAt ?? run.createdAt);
        if (runAge >= settings.maxRunMinutes * 60_000) {
          findings.push({
            reason: "run_over_budget",
            detail: `当前运行已持续 ${Math.round(runAge / 60_000)} 分钟，超过 ${settings.maxRunMinutes} 分钟上限`,
            action: "warn",
            critical: false
          });
        }
      }
    }
    const windowStart = now.getTime() - settings.failureWindowMinutes * 60_000;
    const recentFailures = this.service.store.listRuns(task.id)
      .filter((run) => run.failure && Date.parse(run.startedAt ?? run.createdAt) >= windowStart);
    if (recentFailures.length >= settings.repeatedFailureCount) {
      findings.push({
        reason: "repeated_failures",
        detail: `${settings.failureWindowMinutes} 分钟内连续失败 ${recentFailures.length} 次`,
        action: settings.shadow ? "warn" : "pause",
        critical: true
      });
    }
    const failedTools = this.service.store.listBackgroundToolJobs({ taskId: task.id, limit: 50 })
      .filter((job) => ["failed", "stopped"].includes(job.status) && Date.parse(job.updatedAt) >= windowStart);
    if (failedTools.length > 0) {
      findings.push({
        reason: "background_tool_failed",
        detail: `后台工具 ${failedTools[0]!.toolName} 异常结束：${failedTools[0]!.stopReason ?? failedTools[0]!.status}`,
        action: "warn",
        critical: false
      });
    }
    if (settings.autoCancel && findings.some((finding) => finding.critical)) {
      for (const finding of findings) if (finding.critical) finding.action = "cancel";
    }
    return findings;
  }

  private record(task: TaskRecord, finding: { reason: string; detail: string; action: WatchdogAction; critical: boolean }, now: Date): WatchdogEvent {
    const event: WatchdogEvent = {
      id: `wd:${randomUUID()}`,
      taskId: task.id,
      runId: task.currentRunId,
      reason: finding.reason,
      detail: finding.detail,
      action: finding.action,
      evidenceRefs: [`task:${task.id}`, ...(task.currentRunId ? [`run:${task.currentRunId}`] : [])],
      createdAt: now.toISOString()
    };
    const stored = this.service.store.appendEvent({ type: "watchdog.recorded", taskId: task.id, runId: task.currentRunId, payload: event });
    this.service.bus.publish(stored);
    this.apply(task, finding, now);
    this.raiseAttention(task, finding, now);
    return event;
  }

  private apply(task: TaskRecord, finding: { reason: string; detail: string; action: WatchdogAction }, now: Date): void {
    if (finding.action === "pause" && task.status === "running") {
      try {
        this.service.updateTask(task.id, {
          status: "recoverable",
          nextAction: "看门狗已暂停任务，等待确认后继续",
          error: {
            kind: "watchdog",
            message: finding.detail,
            recoverable: true,
            guidance: "检查任务是否卡住或失控；确认后重新排队",
            cause: "unknown"
          }
        }, task.currentRunId ?? undefined);
      } catch {
        // If the executor already advanced the task, the watchdog only records the observation.
      }
    }
    if (finding.action === "cancel" && task.status !== "completed" && task.status !== "cancelled") {
      try {
        this.service.updateTask(task.id, { status: "cancelled", nextAction: null, error: null });
      } catch {
        // Cancellation is best effort and remains visible in the watchdog event.
      }
    }
    void now;
  }

  private raiseAttention(task: TaskRecord, finding: { reason: string; detail: string; critical: boolean }, now: Date): void {
    if (!this.standingIntents) return;
    try {
      this.standingIntents.ensureAttention({
        dedupeKey: `watchdog:${task.id}:${finding.reason}`,
        kind: "blocked",
        title: `看门狗：${task.title}`,
        waitingOn: "agent",
        waitingSince: now.toISOString(),
        nextAction: "查看看门狗记录，决定继续、暂停或取消",
        consequence: finding.detail,
        whyNow: "代理可能卡住、反复失败或后台工具异常",
        source: "watchdog",
        taskId: task.id,
        goalId: task.goalId ?? null,
        critical: finding.critical
      });
    } catch {
      // Attention creation is best effort; watchdog events remain the audit trail.
    }
  }

  private recentlyRecorded(taskId: string, reason: string, now: Date): boolean {
    const since = now.getTime() - this.settingsValue.dedupeMinutes * 60_000;
    return this.service.store.listWatchdogEvents({ taskId, limit: 100 })
      .some((event) => event.reason === reason && Date.parse(event.createdAt) >= since);
  }
}

function clampSettings(patch: Partial<WatchdogSettings>): Partial<WatchdogSettings> {
  const result: Partial<WatchdogSettings> = {};
  if (patch.enabled !== undefined) result.enabled = Boolean(patch.enabled);
  if (patch.shadow !== undefined) result.shadow = Boolean(patch.shadow);
  if (patch.autoCancel !== undefined) result.autoCancel = Boolean(patch.autoCancel);
  if (patch.stallMinutes !== undefined) result.stallMinutes = clamp(patch.stallMinutes, 1, 24 * 60);
  if (patch.maxRunMinutes !== undefined) result.maxRunMinutes = clamp(patch.maxRunMinutes, 1, 24 * 60);
  if (patch.repeatedFailureCount !== undefined) result.repeatedFailureCount = clamp(patch.repeatedFailureCount, 2, 20);
  if (patch.failureWindowMinutes !== undefined) result.failureWindowMinutes = clamp(patch.failureWindowMinutes, 5, 24 * 60);
  if (patch.dedupeMinutes !== undefined) result.dedupeMinutes = clamp(patch.dedupeMinutes, 1, 24 * 60);
  if (patch.intervalMs !== undefined) result.intervalMs = clamp(patch.intervalMs, 10_000, 60 * 60_000);
  return result;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
