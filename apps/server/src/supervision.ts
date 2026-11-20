import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TaskRecord } from "@hearth/core";

export type SupervisionKind = "long_running" | "budget_near_limit" | "waiting_approval" | "failed";
export type SupervisionStatus = "unread" | "read" | "dismissed" | "snoozed";

export interface SupervisionItem {
  id: string;
  kind: SupervisionKind;
  taskId: string;
  title: string;
  body: string;
  createdAt: string;
  status: SupervisionStatus;
  snoozeUntil: string | null;
}

export interface DailyDigest {
  date: string;
  generatedAt: string;
  completed: number;
  open: number;
  waitingApproval: number;
  failed: number;
  suggestions: string[];
}

export interface SupervisionSnapshot {
  items: SupervisionItem[];
  digest: DailyDigest | null;
  generatedAt: string;
}

interface SupervisionState {
  items: SupervisionItem[];
  cooldowns: Record<string, string>;
  digest: DailyDigest | null;
}

const MAX_ITEMS = 100;
const MAX_NEW_PER_SCAN = 5;
const LONG_RUNNING_MS = 30 * 60_000;
const APPROVAL_WAIT_MS = 10 * 60_000;
const COOLDOWN_MS = 6 * 60 * 60_000;

export class SupervisionService {
  private readonly path: string;
  private readonly now: () => Date;

  constructor(path: string, options: { now?: () => Date } = {}) {
    this.path = path;
    this.now = options.now ?? (() => new Date());
  }

  snapshot(): SupervisionSnapshot {
    const state = this.read();
    const visible = state.items.filter((item) => item.status !== "dismissed" && !isSnoozed(item, this.now()));
    return { items: visible.slice(0, 50), digest: state.digest, generatedAt: this.now().toISOString() };
  }

  tick(tasks: TaskRecord[]): SupervisionSnapshot {
    const state = this.read();
    const now = this.now();
    if (!isQuietHour(now)) {
      let created = 0;
      for (const task of tasks) {
        if (created >= MAX_NEW_PER_SCAN) break;
        for (const candidate of candidatesFor(task, now)) {
          const key = `${candidate.kind}:${task.id}`;
          const last = state.cooldowns[key];
          if (last && now.getTime() - new Date(last).getTime() < COOLDOWN_MS) continue;
          if (state.items.some((item) => item.taskId === task.id && item.kind === candidate.kind && item.status === "unread")) continue;
          state.items.unshift({
            id: `supervision_${task.id}_${candidate.kind}_${now.getTime()}`,
            kind: candidate.kind,
            taskId: task.id,
            title: candidate.title,
            body: candidate.body,
            createdAt: now.toISOString(),
            status: "unread",
            snoozeUntil: null
          });
          state.cooldowns[key] = now.toISOString();
          created += 1;
          if (created >= MAX_NEW_PER_SCAN) break;
        }
      }
    }
    state.items = state.items.slice(0, MAX_ITEMS);
    if (this.shouldGenerateDigest(state, now)) state.digest = buildDigest(tasks, now);
    this.write(state);
    return this.snapshot();
  }

  mark(id: string, action: "read" | "dismiss" | "snooze", hours = 4): SupervisionSnapshot {
    const state = this.read();
    const item = state.items.find((entry) => entry.id === id);
    if (item) {
      if (action === "read") item.status = "read";
      if (action === "dismiss") item.status = "dismissed";
      if (action === "snooze") {
        item.status = "snoozed";
        item.snoozeUntil = new Date(this.now().getTime() + Math.max(1, Math.min(168, hours)) * 60 * 60_000).toISOString();
      }
    }
    this.write(state);
    return this.snapshot();
  }

  private shouldGenerateDigest(state: SupervisionState, now: Date): boolean {
    if (now.getHours() < 8) return false;
    const today = localDate(now);
    return state.digest?.date !== today;
  }

  private read(): SupervisionState {
    if (!existsSync(this.path)) return { items: [], cooldowns: {}, digest: null };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<SupervisionState>;
      return {
        items: Array.isArray(parsed.items) ? parsed.items.filter(isItem) : [],
        cooldowns: parsed.cooldowns && typeof parsed.cooldowns === "object" ? parsed.cooldowns : {},
        digest: isDigest(parsed.digest) ? parsed.digest : null
      };
    } catch {
      return { items: [], cooldowns: {}, digest: null };
    }
  }

  private write(state: SupervisionState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(state, null, 2), "utf8");
  }
}

export function buildDigest(tasks: TaskRecord[], now = new Date()): DailyDigest {
  const yesterday = localDate(new Date(now.getTime() - 24 * 60 * 60_000));
  const touched = tasks.filter((task) => localDate(new Date(task.updatedAt)) === yesterday);
  const completed = touched.filter((task) => task.status === "completed").length;
  const failed = touched.filter((task) => task.status === "failed" || task.status === "recoverable").length;
  const waitingApproval = tasks.filter((task) => task.status === "waiting_approval").length;
  const open = tasks.filter((task) => ["running", "queued", "waiting_input", "waiting_approval", "waiting_budget"].includes(task.status)).length;
  const suggestions: string[] = [];
  if (failed > 0) suggestions.push(`先处理 ${failed} 个失败任务，看看是模型、权限还是测试命令的问题。`);
  if (waitingApproval > 0) suggestions.push(`有 ${waitingApproval} 个任务在等审批，处理完才能继续。`);
  if (completed === 0 && open > 0) suggestions.push("昨天没有完成任务；挑一个最小的任务先跑通，再继续铺开。");
  return {
    date: localDate(now),
    generatedAt: now.toISOString(),
    completed,
    open,
    waitingApproval,
    failed,
    suggestions: suggestions.slice(0, 3)
  };
}

function candidatesFor(task: TaskRecord, now: Date): Array<{ kind: SupervisionKind; title: string; body: string }> {
  const updated = new Date(task.updatedAt).getTime();
  const out: Array<{ kind: SupervisionKind; title: string; body: string }> = [];
  if (task.status === "running" && now.getTime() - updated > LONG_RUNNING_MS) {
    out.push({ kind: "long_running", title: "任务跑得有点久", body: `“${task.title}”已经运行 ${Math.round((now.getTime() - updated) / 60_000)} 分钟，可以打开看看进度。` });
  }
  if (task.status === "waiting_approval" && now.getTime() - updated > APPROVAL_WAIT_MS) {
    out.push({ kind: "waiting_approval", title: "有一个审批在等你", body: `“${task.title}”停在审批，超过 10 分钟没有处理。` });
  }
  if (task.status === "waiting_budget") {
    out.push({ kind: "budget_near_limit", title: "任务到了预算上限", body: `“${task.title}”达到预算上限，可以选择延长或收窄目标。` });
  }
  if (task.status === "failed" || task.status === "recoverable") {
    out.push({ kind: "failed", title: "任务没有完成", body: `“${task.title}”需要处理：${task.error?.message ?? "打开详情看失败原因"}` });
  }
  return out;
}

function isSnoozed(item: SupervisionItem, now: Date): boolean {
  return item.status === "snoozed" && Boolean(item.snoozeUntil) && new Date(item.snoozeUntil!).getTime() > now.getTime();
}

function isQuietHour(now: Date): boolean {
  const hour = now.getHours();
  return hour >= 22 || hour < 8;
}

function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isItem(value: unknown): value is SupervisionItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && typeof item.taskId === "string" && typeof item.kind === "string" && typeof item.status === "string";
}

function isDigest(value: unknown): value is DailyDigest {
  if (!value || typeof value !== "object") return false;
  const digest = value as Record<string, unknown>;
  return typeof digest.date === "string" && typeof digest.generatedAt === "string" && Array.isArray(digest.suggestions);
}
