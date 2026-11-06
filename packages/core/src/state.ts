import type { TaskStatus } from "./types.ts";

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["waiting_input", "waiting_approval", "completed", "failed", "recoverable", "cancelled"],
  waiting_input: ["queued", "running", "recoverable", "cancelled"],
  waiting_approval: ["running", "recoverable", "cancelled"],
  completed: [],
  failed: ["queued", "cancelled"],
  recoverable: ["queued", "running", "cancelled"],
  cancelled: []
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new Error(`Invalid task transition: ${from} -> ${to}`);
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "排队中",
  running: "正在做",
  waiting_input: "需要补充信息",
  waiting_approval: "等你确认",
  completed: "已完成",
  failed: "失败",
  recoverable: "可以继续",
  cancelled: "已取消"
};

export function isTerminal(status: TaskStatus): boolean {
  return status === "completed" || status === "cancelled";
}
