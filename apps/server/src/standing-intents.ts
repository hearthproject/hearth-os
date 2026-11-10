import { randomUUID } from "node:crypto";
import type {
  AttentionBudgetSettings,
  AttentionItem,
  AttentionItemKind,
  EffectRecord,
  GoalContract,
  HeartbeatRun,
  SourceConnection,
  StandingIntentAction,
  StandingIntentRecord,
  StandingIntentScope,
  StandingIntentSnapshot,
  StandingIntentState,
  StandingIntentTriggerEntry,
  TaskRecord
} from "@hearth/core";
import { STANDING_INTENT_ACTIONS } from "@hearth/core";
import type { HearthService } from "./service.ts";

export const DEFAULT_INTENT_COOLDOWN_SECONDS = 24 * 60 * 60;
export const DEFAULT_INTENT_MAX_FIRES = 3;
export const DEFAULT_INTENT_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_INTENT_CANDIDATES = 256;
export const STALE_TASK_MS = 30 * 60 * 1000;
const ATTENTION_BUDGET_KEY = "attention.budget";
const IGNORED_PENALTY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_ATTENTION_BUDGET: AttentionBudgetSettings = {
  dailyLimit: 5,
  quietStart: "22:00",
  quietEnd: "08:00",
  cooldownSeconds: 15 * 60,
  maxPerGoalPerDay: 1,
  maxHighPriorityPerDay: 3,
  ignoredPenalty: 1
};

const ATTENTION_PRIORITY: Record<AttentionItemKind, number> = {
  decision: 1,
  credential: 2,
  approval: 3,
  reconcile: 4,
  progress: 5,
  suggestion: 6
};

export interface CreateStandingIntentInput {
  ownerId?: string;
  description: string;
  triggerEntries: StandingIntentTriggerEntry[];
  scope?: Partial<StandingIntentScope>;
  action?: StandingIntentAction;
  cooldownSeconds?: number;
  maxFires?: number;
  expiresAt?: string;
  armed?: boolean;
}

export interface IntentMatchInput {
  ownerId?: string;
  text: string;
  channel?: string | null;
  sender?: string | null;
  taskId?: string | null;
  goalId?: string | null;
}

export interface IntentMatchResult {
  intent: StandingIntentRecord;
  attention: AttentionItem;
}

export interface HeartbeatInput extends Partial<IntentMatchInput> {
  since?: string;
}

export interface AttentionCandidate {
  dedupeKey: string;
  kind: AttentionItemKind;
  title: string;
  waitingOn: AttentionItem["waitingOn"];
  waitingSince?: string;
  nextAction: string;
  consequence: string;
  whyNow: string;
  goalId?: string | null;
  taskId?: string | null;
  intentId?: string | null;
  source: string;
  critical?: boolean;
  priority?: number;
}

export interface AttentionBudgetPatch {
  dailyLimit?: number;
  quietStart?: string;
  quietEnd?: string;
  cooldownSeconds?: number;
  maxPerGoalPerDay?: number;
  maxHighPriorityPerDay?: number;
  ignoredPenalty?: number;
}

export interface StandingIntentOptions {
  service: HearthService;
  clock?: () => Date;
  maxCandidates?: number;
  staleTaskMs?: number;
  defaultBudget?: AttentionBudgetSettings;
  notifier?: (run: HeartbeatRun, items: AttentionItem[]) => void | Promise<void>;
}

export class StandingIntentError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "StandingIntentError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class StandingIntentService {
  private readonly service: HearthService;
  private readonly clock: () => Date;
  private readonly maxCandidates: number;
  private readonly staleTaskMs: number;
  private readonly defaultBudget: AttentionBudgetSettings;
  private readonly notifier: StandingIntentOptions["notifier"];
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: StandingIntentOptions) {
    this.service = options.service;
    this.clock = options.clock ?? (() => new Date());
    this.maxCandidates = Math.max(1, Math.min(options.maxCandidates ?? MAX_INTENT_CANDIDATES, MAX_INTENT_CANDIDATES));
    this.staleTaskMs = options.staleTaskMs ?? STALE_TASK_MS;
    this.defaultBudget = { ...DEFAULT_ATTENTION_BUDGET, ...(options.defaultBudget ?? {}) };
    this.notifier = options.notifier;
  }

  start(intervalMs = 5 * 60_000): void {
    if (this.timer) return;
    const tick = () => {
      try {
        void this.heartbeat();
      } catch {
        // Heartbeat checks must never block task execution or the scheduler.
      }
    };
    this.timer = setInterval(tick, Math.max(60_000, intervalMs));
    this.timer.unref?.();
    this.initialTimer = setTimeout(tick, 5_000);
    this.initialTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.initialTimer) clearTimeout(this.initialTimer);
    this.timer = null;
    this.initialTimer = null;
  }

  create(input: CreateStandingIntentInput): StandingIntentRecord {
    const now = this.clock();
    const nowIso = now.toISOString();
    const description = input.description.trim();
    if (!description || description.length > 500) {
      throw new StandingIntentError("INVALID_DESCRIPTION", "意图描述必须为 1 到 500 个字符");
    }
    const triggerEntries = normalizeTriggerEntries(input.triggerEntries);
    const action = input.action ?? "remind";
    if (!STANDING_INTENT_ACTIONS.includes(action)) {
      throw new StandingIntentError("INVALID_ACTION", "意图动作不正确");
    }
    const cooldownSeconds = input.cooldownSeconds ?? DEFAULT_INTENT_COOLDOWN_SECONDS;
    if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > 365 * 24 * 60 * 60) {
      throw new StandingIntentError("INVALID_COOLDOWN", "冷却时间必须是有效的秒数");
    }
    const maxFires = input.maxFires ?? DEFAULT_INTENT_MAX_FIRES;
    if (!Number.isInteger(maxFires) || maxFires < 1 || maxFires > 100) {
      throw new StandingIntentError("INVALID_MAX_FIRES", "最大触发次数必须在 1 到 100 之间");
    }
    const expiresAt = input.expiresAt ?? new Date(now.getTime() + DEFAULT_INTENT_EXPIRY_MS).toISOString();
    if (!Number.isFinite(Date.parse(expiresAt))) {
      throw new StandingIntentError("INVALID_EXPIRY", "到期时间不是有效的 ISO 时间");
    }
    const scope = normalizeScope(input.scope);
    const intent: StandingIntentRecord = {
      id: `SI-${randomUUID()}`,
      ownerId: input.ownerId?.trim() || "local",
      description,
      triggerEntries,
      scope,
      action,
      cooldownSeconds,
      maxFires,
      fireCount: 0,
      state: input.armed === false ? "pending" : "armed",
      expiresAt,
      lastFiredAt: null,
      lastMatchedAt: null,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    return this.persistIntent(intent);
  }

  get(id: string): StandingIntentRecord | null {
    return this.service.store.getStandingIntent(id);
  }

  list(state?: StandingIntentState): StandingIntentRecord[] {
    return this.service.store.listStandingIntents(state);
  }

  arm(id: string): StandingIntentRecord {
    const intent = this.requireIntent(id);
    if (intent.state !== "pending") {
      throw new StandingIntentError("INTENT_NOT_PENDING", "只有待启用意图可以启用", 409);
    }
    return this.persistIntent({ ...intent, state: "armed", updatedAt: this.nowIso() });
  }

  cancel(id: string): StandingIntentRecord {
    const intent = this.requireIntent(id);
    if (intent.state === "cancelled" || intent.state === "expired") return intent;
    if (intent.state === "done") {
      throw new StandingIntentError("INTENT_DONE", "已完成的意图不能取消", 409);
    }
    return this.persistIntent({ ...intent, state: "cancelled", updatedAt: this.nowIso() });
  }

  match(input: IntentMatchInput): IntentMatchResult[] {
    const now = this.clock();
    const ownerId = input.ownerId?.trim() || "local";
    const text = String(input.text ?? "").slice(0, 200_000);
    if (!text) return [];
    const candidates = this.service.store.listStandingIntents()
      .filter((intent) => intent.ownerId === ownerId)
      .filter((intent) => intent.state === "armed" || intent.state === "fired")
      .slice(0, this.maxCandidates);
    const results: IntentMatchResult[] = [];
    for (const raw of candidates) {
      const intent = this.refreshIntent(raw, now);
      if (!intent || intent.state !== "armed") continue;
      if (!this.scopeMatches(intent.scope, input)) continue;
      if (intent.expiresAt && Date.parse(intent.expiresAt) <= now.getTime()) continue;
      if (intent.lastFiredAt && intent.cooldownSeconds > 0) {
        if (now.getTime() - Date.parse(intent.lastFiredAt) < intent.cooldownSeconds * 1000) continue;
      }
      if (intent.fireCount >= intent.maxFires) {
        this.persistIntent({ ...intent, state: "done", updatedAt: this.nowIso() });
        continue;
      }
      const matchedTerms = matchingTerms(intent.triggerEntries, text);
      if (matchedTerms.length === 0) continue;
      const fireCount = intent.fireCount + 1;
      const firedAt = this.nowIso();
      const updated: StandingIntentRecord = {
        ...intent,
        fireCount,
        state: fireCount >= intent.maxFires ? "done" : "fired",
        lastFiredAt: firedAt,
        lastMatchedAt: firedAt,
        updatedAt: firedAt
      };
      this.persistIntent(updated);
      const attention = this.ensureAttention({
        dedupeKey: `intent:${intent.id}:${fireCount}`,
        kind: intent.action === "ask" ? "decision" : intent.action === "prepare_task" ? "suggestion" : "progress",
        title: `意图触发：${intent.description}`,
        waitingOn: "user",
        waitingSince: firedAt,
        nextAction: actionNextStep(intent.action),
        consequence: "如果不处理，这个前瞻意图可能错过当前上下文或重复提醒",
        whyNow: `匹配到触发词：${matchedTerms.join("、")}`,
        intentId: intent.id,
        goalId: intent.scope.goalId,
        taskId: intent.scope.taskId,
        source: "standing-intent",
        priority: ATTENTION_PRIORITY[intent.action === "ask" ? "decision" : intent.action === "prepare_task" ? "suggestion" : "progress"]
      });
      results.push({ intent: updated, attention });
    }
    return results;
  }

  snapshot(): StandingIntentSnapshot {
    return {
      intents: this.service.store.listStandingIntents(),
      attention: this.queue(),
      budget: this.budget(),
      lastHeartbeat: this.service.store.latestHeartbeatRun()
    };
  }

  budget(): AttentionBudgetSettings {
    const raw = this.service.store.getAppSetting(ATTENTION_BUDGET_KEY);
    if (!raw) return { ...this.defaultBudget };
    try {
      const parsed = JSON.parse(raw) as Partial<AttentionBudgetSettings>;
      return normalizeBudget({ ...this.defaultBudget, ...parsed }, this.defaultBudget);
    } catch {
      return { ...this.defaultBudget };
    }
  }

  updateBudget(patch: AttentionBudgetPatch): AttentionBudgetSettings {
    const next = normalizeBudget({ ...this.budget(), ...patch }, this.defaultBudget);
    this.service.store.setAppSetting(ATTENTION_BUDGET_KEY, JSON.stringify(next));
    return next;
  }

  queue(): AttentionItem[] {
    const now = this.clock();
    for (const item of this.service.store.listAttentionItems({ status: "snoozed", limit: 500 })) {
      if (item.snoozeUntil && Date.parse(item.snoozeUntil) <= now.getTime()) {
        this.persistAttention({ ...item, status: "open", snoozeUntil: null, updatedAt: this.nowIso() });
      }
    }
    return this.service.store.listAttentionItems({ status: "open", limit: 500 })
      .sort((left, right) => this.effectivePriority(left) - this.effectivePriority(right)
        || Date.parse(left.waitingSince) - Date.parse(right.waitingSince)
        || left.createdAt.localeCompare(right.createdAt));
  }

  acknowledge(id: string): AttentionItem {
    return this.transitionAttention(id, "acknowledged");
  }

  ignore(id: string): AttentionItem {
    return this.transitionAttention(id, "ignored");
  }

  snooze(id: string, minutes = 60): AttentionItem {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10_080) {
      throw new StandingIntentError("INVALID_SNOOZE", "稍后提醒时间必须在 1 到 10080 分钟之间");
    }
    const item = this.requireAttention(id);
    const now = this.clock();
    return this.persistAttention({
      ...item,
      status: "snoozed",
      snoozeUntil: new Date(now.getTime() + minutes * 60_000).toISOString(),
      updatedAt: now.toISOString()
    });
  }

  resolve(id: string): AttentionItem {
    return this.transitionAttention(id, "resolved");
  }

  async heartbeat(input: HeartbeatInput = {}): Promise<HeartbeatRun> {
    const now = this.clock();
    const startedAt = now.toISOString();
    const triggerKinds = new Set<string>();
    const candidateIds = new Set<string>();
    const addCandidate = (candidate: AttentionCandidate) => {
      const item = this.ensureAttention(candidate);
      candidateIds.add(item.id);
      return item;
    };

    for (const task of this.service.store.listTasks()) {
      if (task.status === "waiting_input") {
        triggerKinds.add("task.waiting_input");
        addCandidate(this.taskInputCandidate(task));
      }
      if (isStale(task, now, this.staleTaskMs)) {
        triggerKinds.add("task.stale");
        addCandidate(this.staleTaskCandidate(task));
      }
      for (const approval of this.service.store.listApprovals(task.id)) {
        if (approval.status !== "pending") continue;
        triggerKinds.add("approval.pending");
        addCandidate({
          dedupeKey: `approval:${approval.id}`,
          kind: "approval",
          title: `等待审批：${approval.summary}`,
          waitingOn: "user",
          waitingSince: approval.createdAt,
          nextAction: "检查动作详情并批准或拒绝",
          consequence: "任务会停在审批前，不能继续执行",
          whyNow: `审批将在 ${approval.expiresAt} 到期`,
          goalId: approval.goalId ?? task.goalId ?? null,
          taskId: task.id,
          source: "approval",
          priority: ATTENTION_PRIORITY.approval
        });
      }
    }

    for (const goal of this.service.store.listGoals()) {
      if (!isGoalDue(goal, now)) continue;
      triggerKinds.add("goal.due");
      addCandidate(this.dueGoalCandidate(goal));
    }

    for (const effect of this.service.store.listAllEffects()) {
      if (effect.status !== "uncertain") continue;
      triggerKinds.add("effect.uncertain");
      addCandidate(this.uncertainEffectCandidate(effect));
    }
    for (const reconcile of this.service.store.listReconcileItems("needs_human")) {
      triggerKinds.add("reconcile.needs_human");
      addCandidate({
        dedupeKey: `reconcile:${reconcile.id}`,
        kind: "reconcile",
        title: `需要对账：${reconcile.summary}`,
        waitingOn: "user",
        waitingSince: reconcile.createdAt,
        nextAction: "确认外部结果并选择补记、重试或放弃",
        consequence: "未知副作用可能被重复执行或永久遗漏",
        whyNow: reconcile.reason,
        goalId: reconcile.goalId,
        taskId: reconcile.taskId,
        source: "reconcile",
        priority: ATTENTION_PRIORITY.reconcile,
        critical: reconcile.risk === "critical"
      });
    }

    for (const source of this.service.store.listSources()) {
      if (source.status === "needs_user") {
        triggerKinds.add("source.needs_user");
        addCandidate(this.sourceCredentialCandidate(source));
      }
    }

    const since = input.since ?? this.service.store.latestHeartbeatRun()?.endedAt ?? new Date(now.getTime() - 5 * 60_000).toISOString();
    for (const source of this.service.store.listSources()) {
      for (const item of this.service.store.listSourceItems(source.id)) {
        if (item.status !== "ready" || item.fetchedAt <= since) continue;
        triggerKinds.add("source.new_items");
        addCandidate({
          dedupeKey: `source:${item.id}`,
          kind: "suggestion",
          title: `新外部证据：${item.title ?? item.label}`,
          waitingOn: "agent",
          waitingSince: item.fetchedAt,
          nextAction: "判断是否加入下一步任务或忽略",
          consequence: "新证据可能改变当前计划或结论",
          whyNow: `来源「${source.displayName}」在 ${item.fetchedAt} 更新`,
          goalId: null,
          taskId: null,
          source: "source",
          priority: ATTENTION_PRIORITY.suggestion
        });
      }
    }

    if (input.text) {
      const matches = this.match({
        ...(input.ownerId ? { ownerId: input.ownerId } : {}),
        text: input.text,
        ...(input.channel !== undefined ? { channel: input.channel } : {}),
        ...(input.sender !== undefined ? { sender: input.sender } : {}),
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.goalId !== undefined ? { goalId: input.goalId } : {})
      });
      if (matches.length > 0) triggerKinds.add("intent.match");
      for (const match of matches) candidateIds.add(match.attention.id);
    }

    const candidates = [...candidateIds]
      .map((id) => this.service.store.getAttentionItem(id))
      .filter((item): item is AttentionItem => Boolean(item) && item!.status === "open")
      .sort((left, right) => this.effectivePriority(left) - this.effectivePriority(right)
        || Date.parse(left.waitingSince) - Date.parse(right.waitingSince));
    const usage = this.usageToday(now);
    const settings = this.budget();
    const delivered: AttentionItem[] = [];
    const suppressionReasons: string[] = [];
    const cooldownBlocked = usage.lastNotifiedAt
      && settings.cooldownSeconds > 0
      && now.getTime() - Date.parse(usage.lastNotifiedAt) < settings.cooldownSeconds * 1000;

    for (const item of candidates) {
      const check = cooldownBlocked && !item.critical
        ? { allowed: false, reason: "冷却窗口" }
        : this.canDeliver(item, settings, usage, now);
      if (!check.allowed) {
        suppressionReasons.push(check.reason);
        continue;
      }
      delivered.push(item);
      usage.delivered += item.critical ? 0 : 1;
      if (item.goalId) usage.byGoal.set(item.goalId, (usage.byGoal.get(item.goalId) ?? 0) + 1);
      if (this.isHighPriority(item)) usage.highPriority += 1;
      if (item.critical) usage.criticalBypass += 1;
    }

    const endedAt = this.clock().toISOString();
    const run: HeartbeatRun = {
      id: `HB-${randomUUID()}`,
      decision: delivered.length > 0 ? "notify" : "NO_REPLY",
      triggerKinds: [...triggerKinds].sort(),
      attentionIds: delivered.map((item) => item.id),
      reason: delivered.length > 0
        ? `投递 ${delivered.length} 条注意力事项；触发源：${[...triggerKinds].join("、") || "无"}`
        : this.noReplyReason(candidates.length, suppressionReasons),
      startedAt,
      endedAt
    };
    this.persistHeartbeat(run);
    if (this.notifier && delivered.length > 0) {
      try {
        await this.notifier(run, delivered);
      } catch {
        // Delivery transport failures must not erase the recorded decision.
      }
    }
    return run;
  }

  getAttention(id: string): AttentionItem | null {
    return this.service.store.getAttentionItem(id);
  }

  listHeartbeatRuns(limit = 50): HeartbeatRun[] {
    return this.service.store.listHeartbeatRuns(limit);
  }

  latestHeartbeatRun(): HeartbeatRun | null {
    return this.service.store.latestHeartbeatRun();
  }

  ensureAttention(candidate: AttentionCandidate): AttentionItem {
    const now = this.nowIso();
    const existing = this.findAttention(candidate.dedupeKey);
    if (existing) {
      if (existing.status !== "open" && existing.status !== "snoozed") return existing;
      const updated: AttentionItem = {
        ...existing,
        kind: candidate.kind,
        title: candidate.title,
        waitingOn: candidate.waitingOn,
        nextAction: candidate.nextAction,
        consequence: candidate.consequence,
        whyNow: candidate.whyNow,
        goalId: candidate.goalId ?? existing.goalId,
        taskId: candidate.taskId ?? existing.taskId,
        intentId: candidate.intentId ?? existing.intentId,
        critical: candidate.critical === true || existing.critical,
        priority: candidate.priority ?? ATTENTION_PRIORITY[candidate.kind],
        updatedAt: now
      };
      return this.persistAttention(updated);
    }
    const item: AttentionItem = {
      id: `AT-${randomUUID()}`,
      dedupeKey: candidate.dedupeKey,
      kind: candidate.kind,
      priority: candidate.priority ?? ATTENTION_PRIORITY[candidate.kind],
      critical: candidate.critical === true,
      title: candidate.title,
      waitingOn: candidate.waitingOn,
      waitingSince: candidate.waitingSince ?? now,
      nextAction: candidate.nextAction,
      consequence: candidate.consequence,
      whyNow: candidate.whyNow,
      goalId: candidate.goalId ?? null,
      taskId: candidate.taskId ?? null,
      intentId: candidate.intentId ?? null,
      source: candidate.source,
      status: "open",
      snoozeUntil: null,
      createdAt: now,
      updatedAt: now
    };
    return this.persistAttention(item);
  }

  private requireIntent(id: string): StandingIntentRecord {
    const intent = this.service.store.getStandingIntent(id);
    if (!intent) throw new StandingIntentError("INTENT_NOT_FOUND", "意图不存在", 404);
    return intent;
  }

  private requireAttention(id: string): AttentionItem {
    const item = this.service.store.getAttentionItem(id);
    if (!item) throw new StandingIntentError("ATTENTION_NOT_FOUND", "注意力事项不存在", 404);
    return item;
  }

  private refreshIntent(intent: StandingIntentRecord, now: Date): StandingIntentRecord | null {
    if ((intent.state === "armed" || intent.state === "fired" || intent.state === "pending")
      && Date.parse(intent.expiresAt) <= now.getTime()) {
      return this.persistIntent({ ...intent, state: "expired", updatedAt: now.toISOString() });
    }
    if (intent.state === "fired" && intent.fireCount < intent.maxFires) {
      const cooldownReady = !intent.lastFiredAt
        || intent.cooldownSeconds === 0
        || now.getTime() - Date.parse(intent.lastFiredAt) >= intent.cooldownSeconds * 1000;
      if (cooldownReady) return this.persistIntent({ ...intent, state: "armed", updatedAt: now.toISOString() });
    }
    return intent;
  }

  private scopeMatches(scope: StandingIntentScope, input: IntentMatchInput): boolean {
    if (scope.anywhere) return true;
    if (scope.channel !== null && scope.channel !== input.channel) return false;
    if (scope.sender !== null && scope.sender !== input.sender) return false;
    if (scope.taskId !== null && scope.taskId !== input.taskId) return false;
    if (scope.goalId !== null && scope.goalId !== input.goalId) return false;
    return scope.channel !== null || scope.sender !== null || scope.taskId !== null || scope.goalId !== null;
  }

  private effectivePriority(item: AttentionItem): number {
    if (item.critical) return 0;
    const ignored = this.service.store.listAttentionItems({ status: "ignored", limit: 1000 })
      .filter((entry) => entry.kind === item.kind && Date.parse(entry.updatedAt) >= this.clock().getTime() - IGNORED_PENALTY_WINDOW_MS)
      .length;
    return item.priority + ignored * this.budget().ignoredPenalty;
  }

  private transitionAttention(id: string, status: AttentionItem["status"]): AttentionItem {
    const item = this.requireAttention(id);
    return this.persistAttention({ ...item, status, snoozeUntil: null, updatedAt: this.nowIso() });
  }

  private canDeliver(
    item: AttentionItem,
    settings: AttentionBudgetSettings,
    usage: ReturnType<StandingIntentService["usageToday"]>,
    now: Date
  ): { allowed: boolean; reason: string } {
    if (item.critical) return { allowed: true, reason: "critical 越过高危预算" };
    if (this.isQuiet(settings, now)) return { allowed: false, reason: "免打扰时段" };
    if (usage.delivered >= settings.dailyLimit) return { allowed: false, reason: "每日预算已用尽" };
    if (item.goalId && (usage.byGoal.get(item.goalId) ?? 0) >= settings.maxPerGoalPerDay) {
      return { allowed: false, reason: "该 Goal 今日已达到提醒上限" };
    }
    if (this.isHighPriority(item) && usage.highPriority >= settings.maxHighPriorityPerDay) {
      return { allowed: false, reason: "高优先级提醒今日已达上限" };
    }
    return { allowed: true, reason: "允许" };
  }

  private usageToday(now: Date) {
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const runs = this.service.store.listHeartbeatRuns(500)
      .filter((run) => run.decision === "notify" && run.startedAt >= dayStart);
    const usage = { delivered: 0, highPriority: 0, criticalBypass: 0, byGoal: new Map<string, number>(), lastNotifiedAt: runs[0]?.endedAt ?? null as string | null };
    for (const run of runs) {
      for (const id of run.attentionIds) {
        const item = this.service.store.getAttentionItem(id);
        if (!item) continue;
        usage.delivered += item.critical ? 0 : 1;
        if (item.goalId) usage.byGoal.set(item.goalId, (usage.byGoal.get(item.goalId) ?? 0) + 1);
        if (this.isHighPriority(item)) usage.highPriority += 1;
        if (item.critical) usage.criticalBypass += 1;
      }
    }
    return usage;
  }

  private isHighPriority(item: AttentionItem): boolean {
    return !item.critical && item.priority <= ATTENTION_PRIORITY.approval;
  }

  private isQuiet(settings: AttentionBudgetSettings, now: Date): boolean {
    const minutes = now.getHours() * 60 + now.getMinutes();
    const start = clockMinutes(settings.quietStart);
    const end = clockMinutes(settings.quietEnd);
    if (start === end) return false;
    return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  }

  private findAttention(dedupeKey: string): AttentionItem | null {
    return this.service.store.findOpenAttentionByDedupe(dedupeKey)
      ?? this.service.store.listAttentionItems({ limit: 2000 }).find((item) => item.dedupeKey === dedupeKey)
      ?? null;
  }

  private taskInputCandidate(task: TaskRecord): AttentionCandidate {
    return {
      dedupeKey: `task:input:${task.id}`,
      kind: "decision",
      title: `任务需要输入：${task.title}`,
      waitingOn: "user",
      waitingSince: task.updatedAt,
      nextAction: task.pendingInput ?? "补充任务所需信息",
      consequence: "任务会停在等待输入状态，无法产生可用结果",
      whyNow: task.nextAction ?? "任务正在等待用户输入",
      goalId: task.goalId ?? null,
      taskId: task.id,
      source: "task",
      priority: ATTENTION_PRIORITY.decision
    };
  }

  private staleTaskCandidate(task: TaskRecord): AttentionCandidate {
    return {
      dedupeKey: `task:stale:${task.id}`,
      kind: "progress",
      title: `任务长时间无进展：${task.title}`,
      waitingOn: "agent",
      waitingSince: task.updatedAt,
      nextAction: "检查运行心跳、重试或标记失败原因",
      consequence: "任务可能已经卡死，继续等待会浪费时间预算",
      whyNow: `超过 ${Math.round(this.staleTaskMs / 60_000)} 分钟没有状态更新`,
      goalId: task.goalId ?? null,
      taskId: task.id,
      source: "task",
      priority: ATTENTION_PRIORITY.progress
    };
  }

  private dueGoalCandidate(goal: GoalContract): AttentionCandidate {
    return {
      dedupeKey: `goal:due:${goal.goalId}:${goal.deadline ?? "none"}`,
      kind: "decision",
      title: `目标已到期：${goal.title}`,
      waitingOn: "user",
      waitingSince: goal.deadline ?? goal.updatedAt,
      nextAction: "确认延期、缩小范围、继续验证或停止",
      consequence: "目标状态会与真实交付脱节，后续任务可能继续消耗预算",
      whyNow: `截止时间 ${goal.deadline} 已过`,
      goalId: goal.goalId,
      taskId: null,
      source: "goal",
      priority: ATTENTION_PRIORITY.decision
    };
  }

  private uncertainEffectCandidate(effect: EffectRecord): AttentionCandidate {
    return {
      dedupeKey: `effect:uncertain:${effect.id}`,
      kind: "reconcile",
      title: `外部动作结果不确定：${effect.kind}`,
      waitingOn: "user",
      waitingSince: effect.updatedAt,
      nextAction: "检查外部系统并确认已提交、未提交或需要重试",
      consequence: "直接重试可能造成重复副作用，不处理又可能遗漏结果",
      whyNow: effect.error ?? "执行过程中断，尚未取得确定回执",
      goalId: effect.goalId ?? null,
      taskId: effect.taskId,
      source: "effect",
      priority: ATTENTION_PRIORITY.reconcile
    };
  }

  private sourceCredentialCandidate(source: SourceConnection): AttentionCandidate {
    return {
      dedupeKey: `source:needs_user:${source.id}`,
      kind: "credential",
      title: `连接需要重新授权：${source.displayName}`,
      waitingOn: "user",
      waitingSince: source.updatedAt,
      nextAction: "重新登录或更新凭据",
      consequence: "该来源停止更新，依赖它的判断会使用过期信息",
      whyNow: source.lastError?.message ?? "连接状态为 needs_user",
      goalId: null,
      taskId: null,
      source: "source",
      priority: ATTENTION_PRIORITY.credential
    };
  }

  private noReplyReason(candidateCount: number, suppressionReasons: string[]): string {
    if (candidateCount === 0) return "NO_REPLY：没有到期、阻塞或需要行动的事项";
    const unique = [...new Set(suppressionReasons)];
    return `NO_REPLY：${candidateCount} 个候选未投递${unique.length ? `（${unique.join("；")}）` : ""}`;
  }

  private persistIntent(intent: StandingIntentRecord): StandingIntentRecord {
    const event = this.service.store.appendEvent({ type: "standing-intent.updated", payload: intent });
    this.service.bus.publish(event);
    return intent;
  }

  private persistAttention(item: AttentionItem): AttentionItem {
    const event = this.service.store.appendEvent({ type: "attention.updated", payload: item });
    this.service.bus.publish(event);
    return item;
  }

  private persistHeartbeat(run: HeartbeatRun): HeartbeatRun {
    const event = this.service.store.appendEvent({ type: "heartbeat.recorded", payload: run });
    this.service.bus.publish(event);
    return run;
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }
}

function normalizeTriggerEntries(entries: StandingIntentTriggerEntry[]): StandingIntentTriggerEntry[] {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 20) {
    throw new StandingIntentError("INVALID_TRIGGERS", "触发条件必须包含 1 到 20 个条目");
  }
  return entries.map((entry) => {
    if (!entry || (entry.mode !== "all" && entry.mode !== "any")) {
      throw new StandingIntentError("INVALID_TRIGGER_MODE", "触发条件模式必须是 all 或 any");
    }
    if (!Array.isArray(entry.terms) || entry.terms.length === 0 || entry.terms.length > 20) {
      throw new StandingIntentError("INVALID_TRIGGER_TERMS", "每个触发条目必须包含 1 到 20 个词");
    }
    const terms = [...new Set(entry.terms.map((term) => term.trim()).filter(Boolean))];
    if (terms.length === 0 || terms.some((term) => term.length > 64)) {
      throw new StandingIntentError("INVALID_TRIGGER_TERMS", "触发词不能为空且不能超过 64 个字符");
    }
    return { terms, mode: entry.mode };
  });
}

function normalizeScope(input: Partial<StandingIntentScope> | undefined): StandingIntentScope {
  const scope: StandingIntentScope = {
    channel: input?.channel ?? null,
    sender: input?.sender ?? null,
    taskId: input?.taskId ?? null,
    goalId: input?.goalId ?? null,
    anywhere: input?.anywhere ?? (input?.channel == null && input?.sender == null && input?.taskId == null && input?.goalId == null)
  };
  for (const value of [scope.channel, scope.sender, scope.taskId, scope.goalId]) {
    if (value !== null && (typeof value !== "string" || !value.trim())) {
      throw new StandingIntentError("INVALID_SCOPE", "意图 scope 字段必须是非空字符串或 null");
    }
  }
  return scope;
}

function normalizeBudget(input: AttentionBudgetSettings, fallback: AttentionBudgetSettings): AttentionBudgetSettings {
  const result: AttentionBudgetSettings = {
    dailyLimit: integerInRange(input.dailyLimit, 0, 100, fallback.dailyLimit, "dailyLimit"),
    quietStart: clockValue(input.quietStart, fallback.quietStart, "quietStart"),
    quietEnd: clockValue(input.quietEnd, fallback.quietEnd, "quietEnd"),
    cooldownSeconds: integerInRange(input.cooldownSeconds, 0, 7 * 24 * 60 * 60, fallback.cooldownSeconds, "cooldownSeconds"),
    maxPerGoalPerDay: integerInRange(input.maxPerGoalPerDay, 0, 100, fallback.maxPerGoalPerDay, "maxPerGoalPerDay"),
    maxHighPriorityPerDay: integerInRange(input.maxHighPriorityPerDay, 0, 100, fallback.maxHighPriorityPerDay, "maxHighPriorityPerDay"),
    ignoredPenalty: integerInRange(input.ignoredPenalty, 0, 10, fallback.ignoredPenalty, "ignoredPenalty")
  };
  return result;
}

function integerInRange(value: unknown, min: number, max: number, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new StandingIntentError("INVALID_ATTENTION_BUDGET", `${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return value;
}

function clockValue(value: unknown, fallback: string, name: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new StandingIntentError("INVALID_ATTENTION_BUDGET", `${name} 必须使用 HH:mm 格式`);
  }
  return value;
}

function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function matchingTerms(entries: StandingIntentTriggerEntry[], text: string): string[] {
  const matched: string[] = [];
  for (const entry of entries) {
    const hits = entry.terms.filter((term) => termMatches(term, text));
    if ((entry.mode === "all" && hits.length === entry.terms.length) || (entry.mode === "any" && hits.length > 0)) {
      for (const hit of hits) if (!matched.includes(hit)) matched.push(hit);
    }
  }
  return matched;
}

const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/;
const LATIN_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_ .'-]*[A-Za-z0-9_]$|^[A-Za-z0-9_]$/;

function termMatches(term: string, text: string): boolean {
  if (!term) return false;
  if (CJK_PATTERN.test(term) || !LATIN_PATTERN.test(term)) {
    return text.toLocaleLowerCase().includes(term.toLocaleLowerCase());
  }
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, "i").test(text);
}

function actionNextStep(action: StandingIntentAction): string {
  switch (action) {
    case "ask": return "回答触发该意图的问题";
    case "prepare_task": return "确认是否创建一个准备好的任务";
    case "notify": return "查看提醒并决定是否处理";
    default: return "查看上下文并决定下一步";
  }
}

function isGoalDue(goal: GoalContract, now: Date): boolean {
  if (!goal.deadline) return false;
  if (["done", "failed", "cancelled"].includes(goal.currentState)) return false;
  return Date.parse(goal.deadline) <= now.getTime();
}

function isStale(task: TaskRecord, now: Date, staleTaskMs: number): boolean {
  if (!["queued", "running", "recoverable"].includes(task.status)) return false;
  return now.getTime() - Date.parse(task.updatedAt) >= staleTaskMs;
}
