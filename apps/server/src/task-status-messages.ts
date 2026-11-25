import type { ApprovalMode, TaskRecord, TaskStatus } from "@hearth/core";

const EXECUTOR_TEXT: Record<string, string> = {
  native: "Hearth 原生执行器",
  codex: "Codex"
};

const INTERNAL_ARTIFACT_NAMES = new Set(["run-manifest.json", "pr-preview.json"]);
const ANSWER_BODY_LIMIT = 20_000;
const ANSWER_ARTIFACT_LIMIT = 6;
const ANSWER_FILE_BYTES_LIMIT = 96 * 1024;
export const TASK_ANSWER_FILE_BYTES_LIMIT = ANSWER_FILE_BYTES_LIMIT;

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
    return `任务「${title}」已完成。`;
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

export interface TaskAnswerArtifact {
  id: string;
  relativePath: string;
  bytes: number;
  mimeType?: string;
  absolutePath?: string;
}

export interface TaskResultAnswerInput {
  task: TaskRecord;
  artifacts: TaskAnswerArtifact[];
  /** Full body of the primary result document, when it is available. */
  answerBody?: string;
}

/**
 * Pick the document that carries the answer itself. Reports and result files
 * are ranked above incidental Markdown (README edits, notes).
 */
export function selectPrimaryAnswerArtifact(
  task: TaskRecord,
  artifacts: TaskAnswerArtifact[],
  options: { allowAnyText?: boolean } = {}
): TaskAnswerArtifact | null {
  const candidates = filterDeliverableArtifacts(task, artifacts).filter((artifact) => {
    const name = artifact.relativePath.replace(/\\/g, "/").split("/").pop() ?? "";
    if (/\.(md|markdown|txt|text)$/i.test(name)) return true;
    return artifact.mimeType?.startsWith("text/") === true;
  });
  if (candidates.length === 0) return null;
  const ranked = candidates.map((artifact) => ({
    artifact,
    score: answerDocumentScore(artifact.relativePath)
  }));
  const answerLike = ranked.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score)[0];
  if (answerLike) return answerLike.artifact;
  return options.allowAnyText && candidates.length === 1 ? candidates[0]! : null;
}

/**
 * True when the summary does not itself answer the question and only points
 * at a file. Such runs must inline the document body into the chat answer.
 */
export function summaryLooksLikePointer(summary: string | null | undefined): boolean {
  const text = summary?.trim() ?? "";
  if (!text) return true;
  if (text.length <= 320) return true;
  return /结果(已)?写入|已?(写入|保存到|输出到|见|详见)\s*[`"']?[^\n]{0,80}\.(md|markdown|txt|json|pdf|docx?|xlsx?)/i.test(text);
}

function answerDocumentScore(relativePath: string): number {
  const name = (relativePath.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
  if (/^(result|answer|最终结果|结果|答案)([._-]|$)/i.test(name)) return 100;
  if (/^(report|summary|final|结论|总结|报告|说明|分析|findings)([._-]|$)/i.test(name)) return 80;
  return 0;
}

/**
 * Chat-facing answer for a completed task. The status bubble only reports the
 * state; this message carries the actual result and the files it produced.
 */
export function buildTaskResultAnswer(
  input: TaskResultAnswerInput,
  options: { includeFiles?: boolean } = {}
): string {
  const title = input.task.title || "未命名任务";
  const summary = input.task.resultSummary?.trim() ?? "";
  const answerBody = input.answerBody?.trim() ?? "";
  // Prefer the result document only when it is clearly the richer answer. A
  // one-line stub must never replace a useful executor summary.
  const useAnswerBody = answerBody.length > 0 && (
    summary.length === 0
      ? answerBody.length >= 20
      : answerBody.length >= 50 && answerBody.length > summary.length * 2
  );
  const body = clip(useAnswerBody ? answerBody : summary, ANSWER_BODY_LIMIT);
  const files = deliverableArtifacts(input.task, input.artifacts);
  if (!body && files.length === 0) {
    return `任务「${title}」已完成，但没有返回文字结果或交付文件。`;
  }
  const sections: string[] = [];
  if (body) sections.push(body);
  if (files.length > 0 && options.includeFiles !== false) {
    const links = files.map((file) => {
      const url = `/api/tasks/${encodeURIComponent(input.task.id)}/artifacts/${encodeURIComponent(file.id)}`;
      return `- [${file.name}](${url}) · ${formatBytes(file.bytes)}`;
    });
    sections.push(["**交付文件**", "", ...links].join("\n"));
  }
  if (files.length > 0 && options.includeFiles === false && !body) {
    sections.push("任务已完成，交付文件见下方。");
  }
  return sections.join("\n\n");
}

function deliverableArtifacts(
  task: TaskRecord,
  artifacts: TaskAnswerArtifact[]
): Array<{ id: string; name: string; bytes: number }> {
  return filterDeliverableArtifacts(task, artifacts)
    .slice(0, ANSWER_ARTIFACT_LIMIT)
    .map((artifact) => ({
      id: artifact.id,
      name: artifact.relativePath.replace(/\\/g, "/").split("/").pop() ?? artifact.relativePath,
      bytes: artifact.bytes
    }));
}

function filterDeliverableArtifacts(
  task: TaskRecord,
  artifacts: TaskAnswerArtifact[]
): TaskAnswerArtifact[] {
  return artifacts.filter((artifact) => {
    const path = artifact.relativePath.replace(/\\/g, "/");
    const name = path.split("/").pop() ?? path;
    if (INTERNAL_ARTIFACT_NAMES.has(name)) return false;
    if (path.startsWith("inputs/") || path.startsWith("runtime/") || path.startsWith(".hearth/")) return false;
    if (path.toLowerCase().endsWith(".json") && !isExpectedPath(path, task.expectedOutputs)) return false;
    return true;
  });
}

function isExpectedPath(path: string, expectedOutputs: string[] | undefined): boolean {
  if (!expectedOutputs) return true;
  return expectedOutputs.some((expected) => {
    const normalized = expected.replace(/\\/g, "/").replace(/\/+$/, "");
    return path === normalized || path.startsWith(`${normalized}/`);
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function clip(value: string, limit: number): string {
  const clean = value.trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}
