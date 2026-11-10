import type { ApprovalMode, TaskRecord, TaskStatus } from "@hearth/core";

const EXECUTOR_TEXT: Record<string, string> = {
  native: "Hearth 原生执行器",
  codex: "Codex"
};

export interface TaskStatusMessageInput {
  task: TaskRecord;
  previousStatus: TaskStatus;
  approvalMode: ApprovalMode;
  approvalSummary?: string | null;
  attempt?: number;
}

export function buildTaskStatusMessage(input: TaskStatusMessageInput): string {
  const { task, previousStatus, approvalMode } = input;
  const title = task.title || "未命名任务";
  const executor = EXECUTOR_TEXT[task.executorId ?? "native"] ?? "执行器";

  if (task.status === "queued") {
    const retry = ["recoverable", "failed", "waiting_input"].includes(previousStatus);
    return retry
      ? `任务「${title}」已重新排队，准备第 ${input.attempt ?? 2} 次执行。\n\n执行器：${executor}`
      : `任务「${title}」已排队。\n\n执行器：${executor}`;
  }

  if (task.status === "running") {
    const retry = ["recoverable", "failed", "waiting_input"].includes(previousStatus);
    const stage = task.nextAction && task.nextAction !== "正在执行" ? `\n阶段：${task.nextAction}` : "";
    return retry
      ? `任务「${title}」开始重试（第 ${input.attempt ?? 2} 次执行）。\n\n执行器：${executor}${stage}`
      : `任务「${title}」开始执行。\n\n执行器：${executor}${stage}`;
  }

  if (task.status === "waiting_input") {
    const question = clip(task.resultSummary || task.nextAction || "执行器需要你补充一些信息。", 900);
    return `任务「${title}」需要你补充信息。\n\n${question}`;
  }

  if (task.status === "waiting_approval") {
    if (approvalMode === "full") {
      return `完全权限已开启：任务「${title}」的外部动作会自动批准并执行。${
        input.approvalSummary ? `\n\n${input.approvalSummary}` : ""
      }`;
    }
    return `任务「${title}」等待你确认外部动作。${
      input.approvalSummary ? `\n\n${input.approvalSummary}` : ""
    }`;
  }

  if (task.status === "waiting_budget") {
    return `任务「${title}」的执行预算已触顶，等待你决定是否扩展。${errorLines(task)}`;
  }

  if (task.status === "completed") {
    const summary = task.resultSummary?.trim();
    return `任务「${title}」已完成。${summary ? `\n\n${clip(summary, 700)}` : ""}`;
  }

  if (task.status === "failed") {
    return `任务「${title}」执行失败。${errorLines(task)}`;
  }

  if (task.status === "recoverable") {
    return `任务「${title}」执行中断，可以重试。${errorLines(task)}`;
  }

  if (task.status === "cancelled") {
    return `任务「${title}」已取消。`;
  }

  return `任务「${title}」状态更新为：${task.status}。`;
}

function errorLines(task: TaskRecord): string {
  if (!task.error) return "";
  const guidance = task.error.guidance ? `\n建议：${task.error.guidance}` : "";
  return `\n\n${task.error.message}${guidance}`;
}

function clip(value: string, limit: number): string {
  const clean = value.trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}
