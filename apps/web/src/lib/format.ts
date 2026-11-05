import type { TaskStatus } from "./types.ts";

export const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "排队中",
  running: "正在做",
  waiting_input: "需要补充",
  waiting_approval: "等你确认",
  completed: "已完成",
  failed: "失败",
  recoverable: "可以继续",
  cancelled: "已取消"
};

export const CATEGORY_LABELS: Record<string, string> = {
  document: "文档",
  web: "网页",
  code: "代码",
  data: "数据",
  people: "人事",
  marketing: "营销"
};

export const EVENT_LABELS: Record<string, string> = {
  "task.created": "任务已创建",
  "task.updated": "任务状态更新",
  "task.progress": "执行进展",
  "run.created": "开始新一轮执行",
  "run.updated": "运行状态更新",
  "approval.created": "等待你的确认",
  "approval.updated": "确认结果已记录",
  "artifact.published": "产物已保存",
  "effect.created": "准备执行外部动作",
  "effect.updated": "外部动作状态更新"
};

export function needsAttention(status: TaskStatus): boolean {
  return status === "waiting_approval" || status === "waiting_input" || status === "recoverable" || status === "failed";
}

export function isActive(status: TaskStatus): boolean {
  return status === "queued" || status === "running";
}

export function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function relativeTime(value: string): string {
  const delta = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

export function todayLabel(): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long"
  }).format(new Date());
}
