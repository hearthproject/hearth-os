import { randomUUID } from "node:crypto";
import type {
  AutonomyLevel,
  ProactiveMode,
  ProactiveSettings,
  ProactiveSuggestion,
  ProactiveSnapshot,
  SuggestionRisk,
  SuggestionSourceRef,
  TriggerKind
} from "@hearth/core";
import { PROACTIVE_MODES, TRIGGER_KINDS } from "@hearth/core";
import type { HearthService } from "./service.ts";

const DEFAULT_DAILY_LIMIT = 5;
const DEFAULT_COOLDOWN_MINUTES = 60;
const DEFAULT_AGGREGATE_MINUTES = 30;
const METRIC_WINDOW_DAYS = 7;
const DEADLINE_WINDOW_MS = 24 * 60 * 60 * 1000;
const APPROVAL_AGE_MS = 2 * 60 * 60 * 1000;

export const DEFAULT_PROACTIVE_SETTINGS: ProactiveSettings = {
  enabled: true,
  mode: "suggest",
  dailyLimit: DEFAULT_DAILY_LIMIT,
  quietStart: "22:00",
  quietEnd: "08:00",
  cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
  aggregateWindowMinutes: DEFAULT_AGGREGATE_MINUTES,
  pausedUntil: null,
  triggers: {
    "task.deadline": { enabled: true, autonomy: "A0" },
    "task.failed": { enabled: true, autonomy: "A0" },
    "effect.uncertain": { enabled: true, autonomy: "A0" },
    "approval.pending": { enabled: true, autonomy: "A0" },
    "source.new_items": { enabled: true, autonomy: "A0" },
    "system.health": { enabled: true, autonomy: "A0" },
    "email.new_message": { enabled: false, autonomy: "A0" },
    "calendar.upcoming": { enabled: false, autonomy: "A0" }
  },
  updatedAt: new Date().toISOString()
};

export interface SuggestionActionInput {
  title?: string;
  goal?: string;
  textInput?: string;
}

export interface SettingsPatch {
  enabled?: boolean;
  mode?: ProactiveMode;
  dailyLimit?: number;
  quietStart?: string;
  quietEnd?: string;
  cooldownMinutes?: number;
  aggregateWindowMinutes?: number;
  pausedUntil?: string | null;
  triggers?: Partial<Record<TriggerKind, { enabled?: boolean; autonomy?: AutonomyLevel }>>;
}

export class ProactiveError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "ProactiveError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

interface Candidate {
  triggerKind: TriggerKind;
  dedupeKey: string;
  title: string;
  whyNow: string;
  suggestedAction: string;
  expectedImpact: string;
  estimatedCost: string;
  riskLevel: SuggestionRisk;
  requiresApproval: boolean;
  autonomy: AutonomyLevel;
  priority: number;
  source: SuggestionSourceRef;
  evidence: Record<string, unknown>;
  expiresAt: string | null;
}

export class ProactiveService {
  private readonly service: HearthService;
  private readonly clock: () => Date;

  constructor(service: HearthService, clock: () => Date = () => new Date()) {
    this.service = service;
    this.clock = clock;
  }

  settings(): ProactiveSettings {
    return this.service.store.getProactiveSettings() ?? structuredClone(DEFAULT_PROACTIVE_SETTINGS);
  }

  updateSettings(patch: SettingsPatch): ProactiveSettings {
    const current = this.settings();
    const next: ProactiveSettings = structuredClone(current);
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.mode !== undefined) {
      if (!PROACTIVE_MODES.includes(patch.mode)) throw new ProactiveError("INVALID_MODE", "主动模式不正确");
      next.mode = patch.mode;
    }
    if (patch.dailyLimit !== undefined) {
      if (!Number.isInteger(patch.dailyLimit) || patch.dailyLimit < 0 || patch.dailyLimit > 50) {
        throw new ProactiveError("INVALID_LIMIT", "每日上限必须在 0 到 50 之间");
      }
      next.dailyLimit = patch.dailyLimit;
    }
    if (patch.quietStart !== undefined) next.quietStart = validClock(patch.quietStart, "安静开始时间");
    if (patch.quietEnd !== undefined) next.quietEnd = validClock(patch.quietEnd, "安静结束时间");
    if (patch.cooldownMinutes !== undefined) {
      if (!Number.isInteger(patch.cooldownMinutes) || patch.cooldownMinutes < 0 || patch.cooldownMinutes > 10080) {
        throw new ProactiveError("INVALID_COOLDOWN", "冷却时间必须在 0 到 10080 分钟之间");
      }
      next.cooldownMinutes = patch.cooldownMinutes;
    }
    if (patch.aggregateWindowMinutes !== undefined) {
      if (!Number.isInteger(patch.aggregateWindowMinutes) || patch.aggregateWindowMinutes < 0 || patch.aggregateWindowMinutes > 1440) {
        throw new ProactiveError("INVALID_AGGREGATE", "聚合窗口必须在 0 到 1440 分钟之间");
      }
      next.aggregateWindowMinutes = patch.aggregateWindowMinutes;
    }
    if (patch.pausedUntil !== undefined) next.pausedUntil = patch.pausedUntil;
    if (patch.triggers) {
      for (const [kind, value] of Object.entries(patch.triggers)) {
        if (!TRIGGER_KINDS.includes(kind as TriggerKind)) throw new ProactiveError("INVALID_TRIGGER", "触发类型不正确");
        const target = next.triggers[kind as TriggerKind];
        if (value.enabled !== undefined) target.enabled = value.enabled;
        if (value.autonomy !== undefined) {
          if (!["A0", "A1", "A2"].includes(value.autonomy)) throw new ProactiveError("INVALID_AUTONOMY", "自主级别不正确");
          target.autonomy = value.autonomy;
        }
      }
    }
    next.updatedAt = this.nowIso();
    this.emitSettings(next);
    return next;
  }

  pause(input: { minutes?: number; off?: boolean; resume?: boolean }): ProactiveSettings {
    const now = this.clock();
    if (input.off) {
      const next = this.updateSettings({ enabled: false, pausedUntil: null });
      return next;
    }
    if (input.resume) return this.updateSettings({ enabled: true, pausedUntil: null });
    const minutes = input.minutes ?? 60;
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 10080) {
      throw new ProactiveError("INVALID_PAUSE", "暂停时长必须在 1 到 10080 分钟之间");
    }
    return this.updateSettings({
      enabled: true,
      pausedUntil: new Date(now.getTime() + minutes * 60_000).toISOString()
    });
  }

  snapshot(): ProactiveSnapshot {
    const settings = this.settings();
    const suggestions = this.service.store.listSuggestions({ limit: 100 });
    return {
      settings,
      suggestions,
      budget: this.budget(settings),
      metrics: this.metrics()
    };
  }

  scan(): { created: number; updated: number; delivered: number; suggestions: ProactiveSuggestion[] } {
    const settings = this.settings();
    if (!settings.enabled || settings.mode === "off") {
      return { created: 0, updated: 0, delivered: 0, suggestions: [] };
    }
    const candidates = this.collectCandidates(settings);
    let created = 0;
    let updated = 0;
    const touched: ProactiveSuggestion[] = [];

    for (const candidate of candidates) {
      const existing = this.service.store.findSuggestionByDedupeKey(candidate.dedupeKey);
      const now = this.nowIso();
      if (existing) {
        const next = mergeSuggestion(existing, candidate, now);
        if (next) {
          this.emitSuggestion("suggestion.updated", next);
          updated += 1;
          touched.push(next);
        }
        continue;
      }
      const suggestion = this.newSuggestion(candidate);
      this.emitSuggestion("suggestion.created", suggestion);
      created += 1;
      touched.push(suggestion);
    }

    let delivered = 0;
    const currentSettings = this.settings();
    if (!this.isPaused(currentSettings) && !this.isQuiet(currentSettings) && !this.isCoolingDown(currentSettings)) {
      let used = this.usedToday(currentSettings);
      const pending = this.service.store.listSuggestions({ status: "new", limit: 100 })
        .filter((suggestion) => suggestion.notifiedAt === null)
        .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt));
      for (const suggestion of pending) {
        if (used >= currentSettings.dailyLimit) break;
        const next: ProactiveSuggestion = {
          ...suggestion,
          notifiedAt: this.nowIso(),
          updatedAt: this.nowIso()
        };
        this.emitSuggestion("suggestion.updated", next);
        this.emitSuggestionEvent(suggestion.id, "delivered", { priority: suggestion.priority });
        used += 1;
        delivered += 1;
        const idx = touched.findIndex((item) => item.id === suggestion.id);
        if (idx >= 0) touched[idx] = next;
      }
    }

    return { created, updated, delivered, suggestions: touched };
  }

  accept(id: string, input: SuggestionActionInput = {}): { suggestion: ProactiveSuggestion; taskId: string } {
    return this.resolveToTask(id, input, "accepted");
  }

  convert(id: string, input: SuggestionActionInput = {}): { suggestion: ProactiveSuggestion; taskId: string } {
    return this.resolveToTask(id, input, "converted");
  }

  ignore(id: string): ProactiveSuggestion {
    const suggestion = this.requireSuggestion(id);
    const next: ProactiveSuggestion = {
      ...suggestion,
      status: "ignored",
      snoozeUntil: null,
      updatedAt: this.nowIso()
    };
    this.emitSuggestion("suggestion.updated", next);
    this.emitSuggestionEvent(id, "ignored", {});
    return next;
  }

  snooze(id: string, minutes = 60): ProactiveSuggestion {
    const suggestion = this.requireSuggestion(id);
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 10080) {
      throw new ProactiveError("INVALID_SNOOZE", "稍后提醒必须在 5 到 10080 分钟之间");
    }
    const next: ProactiveSuggestion = {
      ...suggestion,
      status: "snoozed",
      snoozeUntil: new Date(this.clock().getTime() + minutes * 60_000).toISOString(),
      notifiedAt: null,
      updatedAt: this.nowIso()
    };
    this.emitSuggestion("suggestion.updated", next);
    this.emitSuggestionEvent(id, "snoozed", { minutes });
    return next;
  }

  private resolveToTask(
    id: string,
    input: SuggestionActionInput,
    status: "accepted" | "converted"
  ): { suggestion: ProactiveSuggestion; taskId: string } {
    const suggestion = this.requireSuggestion(id);
    if (suggestion.taskId) {
      throw new ProactiveError("ALREADY_HAS_TASK", "这条建议已经关联了任务", 409);
    }
    const goal = input.goal?.trim()
      || [suggestion.whyNow, `建议动作：${suggestion.suggestedAction}`, suggestion.expectedImpact].join("\n\n");
    const task = this.service.createTask({
      title: input.title?.trim() || suggestion.title,
      goal,
      ...(input.textInput ? { textInput: input.textInput } : {})
    });
    const next: ProactiveSuggestion = {
      ...suggestion,
      status,
      taskId: task.id,
      snoozeUntil: null,
      updatedAt: this.nowIso()
    };
    this.emitSuggestion("suggestion.updated", next);
    this.emitSuggestionEvent(id, status, { taskId: task.id });
    return { suggestion: next, taskId: task.id };
  }

  private requireSuggestion(id: string): ProactiveSuggestion {
    const suggestion = this.service.store.getSuggestion(id);
    if (!suggestion) throw new ProactiveError("SUGGESTION_NOT_FOUND", "主动建议不存在", 404);
    return suggestion;
  }

  private newSuggestion(candidate: Candidate): ProactiveSuggestion {
    const now = this.nowIso();
    return {
      id: randomUUID(),
      ...candidate,
      status: "new",
      occurrenceCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      notifiedAt: null,
      snoozeUntil: null,
      taskId: null,
      createdAt: now,
      updatedAt: now
    };
  }

  private collectCandidates(settings: ProactiveSettings): Candidate[] {
    const result: Candidate[] = [];
    const now = this.clock();
    const nowIso = this.nowIso();
    const tasks = this.service.store.listTasks();

    if (this.triggerEnabled(settings, "task.deadline")) {
      for (const task of tasks) {
        if (!task.deadline || task.status === "completed" || task.status === "cancelled") continue;
        const deadlineMs = Date.parse(task.deadline);
        if (!Number.isFinite(deadlineMs)) continue;
        const remaining = deadlineMs - now.getTime();
        if (remaining < 0 || remaining > DEADLINE_WINDOW_MS) continue;
        const hours = Math.max(1, Math.ceil(remaining / 3_600_000));
        result.push(this.candidate(settings, "task.deadline", `task.deadline:${task.id}`, {
          title: `任务还有 ${hours} 小时到期：${task.title}`,
          whyNow: `截止时间 ${task.deadline} 已进入 24 小时窗口。`,
          suggestedAction: "检查任务进度，必要时立即处理或调整截止时间。",
          expectedImpact: "避免错过已经承诺的截止时间。",
          estimatedCost: "约 1 次查看或执行",
          riskLevel: "low",
          requiresApproval: false,
          priority: 100 - hours,
          source: { kind: "task", id: task.id, label: task.title, detail: task.nextAction },
          evidence: { taskId: task.id, deadline: task.deadline, status: task.status },
          expiresAt: task.deadline
        }));
      }
    }

    if (this.triggerEnabled(settings, "task.failed")) {
      for (const task of tasks) {
        if (task.status !== "failed" && task.status !== "recoverable") continue;
        result.push(this.candidate(settings, "task.failed", `task.failed:${task.id}`, {
          title: `处理失败任务：${task.title}`,
          whyNow: task.error?.message || "任务已经停止，等待用户决定是否重试。",
          suggestedAction: "打开任务详情，核对失败原因，然后重试、修复输入或取消。",
          expectedImpact: "让停住的任务重新进入可完成状态，或明确结束。",
          estimatedCost: "约 1 次执行",
          riskLevel: "medium",
          requiresApproval: false,
          priority: 90,
          source: { kind: "task", id: task.id, label: task.title, detail: task.nextAction },
          evidence: { taskId: task.id, status: task.status, error: task.error },
          expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString()
        }));
      }
    }

    if (this.triggerEnabled(settings, "effect.uncertain")) {
      for (const effect of this.service.store.listAllEffects()) {
        if (effect.status !== "uncertain") continue;
        result.push(this.candidate(settings, "effect.uncertain", `effect.uncertain:${effect.id}`, {
          title: `核对不确定的外部动作：${effect.kind}`,
          whyNow: "上一次外部动作结果不确定，继续重试可能产生重复副作用。",
          suggestedAction: "先核对外部系统状态，再决定标记成功、重试或放弃。",
          expectedImpact: "避免重复执行外部写入。",
          estimatedCost: "约 1 次人工核对",
          riskLevel: "high",
          requiresApproval: true,
          priority: 95,
          source: { kind: "effect", id: effect.id, label: effect.kind, detail: effect.error },
          evidence: { effectId: effect.id, taskId: effect.taskId, status: effect.status },
          expiresAt: null
        }));
      }
    }

    if (this.triggerEnabled(settings, "approval.pending")) {
      for (const task of tasks) {
        for (const approval of this.service.store.listApprovals(task.id)) {
          if (approval.status !== "pending") continue;
          if (now.getTime() - Date.parse(approval.createdAt) < APPROVAL_AGE_MS) continue;
          result.push(this.candidate(settings, "approval.pending", `approval.pending:${approval.id}`, {
            title: `等待确认：${approval.summary}`,
            whyNow: `审批已经等待超过 2 小时，任务停在 ${task.title}。`,
            suggestedAction: "打开审批卡，核对外部动作、影响和参数后批准或拒绝。",
            expectedImpact: "让任务继续，或者明确停止不再需要的动作。",
            estimatedCost: "约 1 次审批",
            riskLevel: "medium",
            requiresApproval: true,
            priority: 85,
            source: { kind: "approval", id: approval.id, label: approval.summary, detail: task.title },
            evidence: { approvalId: approval.id, taskId: task.id, kind: approval.kind },
            expiresAt: approval.expiresAt
          }));
        }
      }
    }

    if (this.triggerEnabled(settings, "source.new_items")) {
      const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
      for (const source of this.service.store.listSources()) {
        if (source.status !== "connected") continue;
        const items = this.service.store.listSourceItems(source.id)
          .filter((item) => item.status === "ready" && item.fetchedAt >= since);
        if (items.length === 0) continue;
        result.push(this.candidate(settings, "source.new_items", `source.new_items:${source.id}`, {
          title: `${source.displayName} 有 ${items.length} 条新资料`,
          whyNow: `最近 24 小时读取到 ${items.length} 条可用来源条目。`,
          suggestedAction: "查看来源条目，判断是否需要转成任务或加入已有任务。",
          expectedImpact: "避免新资料只停留在来源页，没有被使用。",
          estimatedCost: "约 1 次查看",
          riskLevel: "low",
          requiresApproval: false,
          priority: 40,
          source: { kind: "source", id: source.id, label: source.displayName, detail: source.kind },
          evidence: { sourceId: source.id, itemIds: items.slice(0, 20).map((item) => item.id), count: items.length },
          expiresAt: new Date(now.getTime() + 3 * 86_400_000).toISOString()
        }));
      }
    }

    if (this.triggerEnabled(settings, "system.health")) {
      const queued = tasks.filter((task) => task.status === "queued").length;
      const runningOld = tasks.filter((task) => task.status === "running" && now.getTime() - Date.parse(task.updatedAt) > 2 * 3_600_000);
      if (queued > 20 || runningOld.length > 0) {
        result.push(this.candidate(settings, "system.health", "system.health:runtime", {
          title: "执行队列需要关注",
          whyNow: `当前有 ${queued} 个排队任务，${runningOld.length} 个长时间运行任务。`,
          suggestedAction: "检查执行器状态、队列积压和长时间运行任务，必要时暂停或重试。",
          expectedImpact: "避免队列积压或任务长期卡住。",
          estimatedCost: "约 1 次检查",
          riskLevel: "medium",
          requiresApproval: false,
          priority: 70,
          source: { kind: "system", id: null, label: "执行器", detail: "queue" },
          evidence: { queued, longRunning: runningOld.map((task) => task.id) },
          expiresAt: new Date(now.getTime() + 3_600_000).toISOString()
        }));
      }
    }

    return result.sort((left, right) => right.priority - left.priority);
  }

  private candidate(
    settings: ProactiveSettings,
    triggerKind: TriggerKind,
    dedupeKey: string,
    value: Omit<Candidate, "triggerKind" | "dedupeKey" | "autonomy">
  ): Candidate {
    return {
      triggerKind,
      dedupeKey,
      autonomy: settings.triggers[triggerKind].autonomy,
      ...value
    };
  }

  private triggerEnabled(settings: ProactiveSettings, kind: TriggerKind): boolean {
    return settings.triggers[kind].enabled && settings.enabled && settings.mode !== "off";
  }

  private budget(settings: ProactiveSettings): ProactiveSnapshot["budget"] {
    const used = this.usedToday(settings);
    const quiet = this.isQuiet(settings);
    const paused = this.isPaused(settings);
    let nextAllowedAt: string | null = null;
    if (paused) nextAllowedAt = settings.pausedUntil;
    else if (quiet) nextAllowedAt = this.quietEndsAt(settings).toISOString();
    else if (used >= settings.dailyLimit) nextAllowedAt = this.tomorrowStart().toISOString();
    return { usedToday: used, limit: settings.dailyLimit, quiet, paused, nextAllowedAt };
  }

  private metrics(): ProactiveSnapshot["metrics"] {
    const since = new Date(this.clock().getTime() - METRIC_WINDOW_DAYS * 86_400_000).toISOString();
    const counts = this.service.store.countSuggestionActionsSince(since);
    const decided = counts.accepted + counts.ignored + counts.converted;
    const completedTasks = this.service.store.listTasks()
      .filter((task) => task.status === "completed" && task.updatedAt >= since).length;
    return {
      delivered: counts.delivered,
      accepted: counts.accepted,
      ignored: counts.ignored,
      converted: counts.converted,
      acceptanceRate: decided > 0 ? (counts.accepted + counts.converted) / decided : null,
      interruptionsPerTask: completedTasks > 0 ? counts.delivered / completedTasks : null
    };
  }

  private usedToday(settings: ProactiveSettings): number {
    const start = this.dayStart().toISOString();
    return this.service.store.countSuggestionActionsSince(start).delivered;
  }

  private isCoolingDown(settings: ProactiveSettings): boolean {
    if (settings.cooldownMinutes <= 0) return false;
    const since = new Date(this.clock().getTime() - settings.cooldownMinutes * 60_000).toISOString();
    return this.service.store.listSuggestionsNotifiedSince(since).length > 0;
  }

  private isPaused(settings: ProactiveSettings): boolean {
    return Boolean(settings.pausedUntil && Date.parse(settings.pausedUntil) > this.clock().getTime());
  }

  private isQuiet(settings: ProactiveSettings): boolean {
    const minutes = this.clock().getHours() * 60 + this.clock().getMinutes();
    const start = clockMinutes(settings.quietStart);
    const end = clockMinutes(settings.quietEnd);
    if (start === end) return false;
    if (start < end) return minutes >= start && minutes < end;
    return minutes >= start || minutes < end;
  }

  private quietEndsAt(settings: ProactiveSettings): Date {
    const now = this.clock();
    const end = clockMinutes(settings.quietEnd);
    const result = new Date(now);
    result.setHours(Math.floor(end / 60), end % 60, 0, 0);
    if (result.getTime() <= now.getTime()) result.setDate(result.getDate() + 1);
    return result;
  }

  private dayStart(): Date {
    const now = this.clock();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  private tomorrowStart(): Date {
    const start = this.dayStart();
    start.setDate(start.getDate() + 1);
    return start;
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  private emitSettings(settings: ProactiveSettings): void {
    const event = this.service.store.appendEvent({ type: "proactive.settings.updated", payload: settings });
    this.service.bus.publish(event);
  }

  private emitSuggestion(type: "suggestion.created" | "suggestion.updated", suggestion: ProactiveSuggestion): void {
    const event = this.service.store.appendEvent({ type, payload: suggestion });
    this.service.bus.publish(event);
  }

  private emitSuggestionEvent(suggestionId: string, action: string, payload: Record<string, unknown>): void {
    const event = this.service.store.appendEvent({
      type: "suggestion.event",
      payload: { id: randomUUID(), suggestionId, action, createdAt: this.nowIso(), ...payload }
    });
    this.service.bus.publish(event);
  }
}

function mergeSuggestion(existing: ProactiveSuggestion, candidate: Candidate, now: string): ProactiveSuggestion | null {
  if (existing.status === "ignored") {
    return {
      ...existing,
      occurrenceCount: existing.occurrenceCount + 1,
      lastSeenAt: now,
      evidence: candidate.evidence,
      updatedAt: now
    };
  }
  if (existing.status === "snoozed") {
    if (existing.snoozeUntil && Date.parse(existing.snoozeUntil) > Date.parse(now)) {
      return {
        ...existing,
        occurrenceCount: existing.occurrenceCount + 1,
        lastSeenAt: now,
        evidence: candidate.evidence,
        updatedAt: now
      };
    }
    return {
      ...existing,
      ...candidate,
      status: "new",
      occurrenceCount: existing.occurrenceCount + 1,
      lastSeenAt: now,
      notifiedAt: null,
      snoozeUntil: null,
      updatedAt: now
    };
  }
  if (existing.status === "accepted" || existing.status === "converted") {
    return {
      ...existing,
      occurrenceCount: existing.occurrenceCount + 1,
      lastSeenAt: now,
      evidence: candidate.evidence,
      updatedAt: now
    };
  }
  return {
    ...existing,
    ...candidate,
    status: existing.status === "expired" ? "new" : existing.status,
    occurrenceCount: existing.occurrenceCount + 1,
    firstSeenAt: existing.status === "expired" ? now : existing.firstSeenAt,
    lastSeenAt: now,
    notifiedAt: existing.status === "expired" ? null : existing.notifiedAt,
    snoozeUntil: null,
    updatedAt: now
  };
}

function validClock(value: string, label: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new ProactiveError("INVALID_CLOCK", `${label}必须使用 HH:mm 格式`);
  }
  return value;
}

function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}
