import type {
  EvalDifficulty,
  EvalFamily,
  ExperimentRunStatus,
  ExperimentStatus,
  ReviewTriggerKind
} from "@hearth/eval-core";

export const FAMILY_LABELS: Record<EvalFamily, string> = {
  email: "邮件",
  calendar: "日程",
  documents: "文档",
  research: "研究",
  code: "代码",
  web: "网页",
  desktop: "桌面",
  "cross-app": "跨应用"
};

export const FAMILY_COLORS: Record<EvalFamily, string> = {
  email: "#c26d4d",
  calendar: "#b28c33",
  documents: "#527a5b",
  research: "#4f6fa8",
  code: "#7762a8",
  web: "#357d85",
  desktop: "#8a6252",
  "cross-app": "#9a4f67"
};

export const DIFFICULTY_LABELS: Record<EvalDifficulty, string> = {
  normal: "常规",
  edge: "边界",
  failure: "故障",
  adversarial: "对抗"
};

export const RUN_MODE_LABELS: Record<string, string> = {
  offline: "离线",
  "live-optional": "可选在线",
  "live-only": "仅在线"
};

export const EXECUTOR_LABELS: Record<string, string> = {
  native: "Hearth Native",
  codex: "Codex",
  "deepseek-harness": "DeepSeek Harness",
  hermes: "Hermes",
  qoder: "Qoder",
  workbuddy: "WorkBuddy",
  kimi: "Kimi Code"
};

export const REASON_LABELS: Record<ReviewTriggerKind, string> = {
  low_confidence: "低置信度",
  judge_conflict: "评委冲突",
  blocker_anomaly: "阻塞项异常",
  failed_sample: "失败抽样",
  judge_unavailable: "评委不可用",
  sampled: "固定抽样"
};

type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "muted";

export interface StatusMeta {
  label: string;
  tone: Tone;
  step: number;
}

export const RUN_STATUS_META: Record<ExperimentRunStatus, StatusMeta> = {
  queued: { label: "排队中", tone: "muted", step: 0 },
  created: { label: "已创建任务", tone: "info", step: 1 },
  running: { label: "执行中", tone: "info", step: 2 },
  waiting: { label: "等待处理", tone: "warning", step: 3 },
  grading: { label: "评分中", tone: "info", step: 4 },
  needs_review: { label: "等待复核", tone: "warning", step: 5 },
  passed: { label: "通过", tone: "success", step: 6 },
  failed: { label: "失败", tone: "danger", step: 6 },
  blocked: { label: "阻塞", tone: "warning", step: 6 },
  cancelled: { label: "已取消", tone: "muted", step: 6 },
  error: { label: "运行错误", tone: "danger", step: 6 }
};

export const EXPERIMENT_STATUS_META: Record<ExperimentStatus, StatusMeta> = {
  queued: { label: "排队中", tone: "muted", step: 0 },
  running: { label: "执行中", tone: "info", step: 2 },
  grading: { label: "评分中", tone: "info", step: 4 },
  needs_review: { label: "等待复核", tone: "warning", step: 5 },
  completed: { label: "已完成", tone: "success", step: 6 },
  failed: { label: "失败", tone: "danger", step: 6 },
  cancelled: { label: "已取消", tone: "muted", step: 6 }
};

export const LIFECYCLE_STEPS = [
  { step: 0, label: "排队", detail: "实验与运行已入队" },
  { step: 1, label: "创建任务", detail: "向 Hearth 提交隔离任务" },
  { step: 2, label: "Agent 执行", detail: "执行器在产物目录中工作" },
  { step: 3, label: "等待处理", detail: "等待输入、审批或恢复" },
  { step: 4, label: "自动评分", detail: "确定性与模型评委并行" },
  { step: 5, label: "人工复核", detail: "确认低置信度或冲突结果" },
  { step: 6, label: "完成", detail: "归档结论与产物" }
];

export const STATUS_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "active", label: "进行中" },
  { value: "passed", label: "通过" },
  { value: "failed", label: "失败" },
  { value: "needs_review", label: "待复核" },
  { value: "blocked", label: "阻塞" },
  { value: "error", label: "错误" }
] as const;

export const EVENT_LABELS: Record<string, string> = {
  "experiment.created": "创建实验",
  "experiment.started": "实验开始",
  "experiment.failed": "实验失败",
  "experiment.cancelled": "实验取消",
  "run.created": "运行入队",
  "run.task-created": "Hearth 任务已创建",
  "run.waiting": "任务等待中",
  "run.grading": "开始评分",
  "run.judge-unavailable": "评委不可用",
  "run.judge-retry": "重试评委",
  "run.finished": "运行结束",
  "run.error": "运行错误",
  "review.submitted": "人工复核提交",
  "system.recovered": "服务恢复"
};

export function statusMeta(status: ExperimentRunStatus | ExperimentStatus): StatusMeta {
  return RUN_STATUS_META[status as ExperimentRunStatus] ?? EXPERIMENT_STATUS_META[status as ExperimentStatus] ?? {
    label: status,
    tone: "neutral",
    step: 0
  };
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

export function formatDuration(start: string | null, end: string | null): string {
  if (!start) return "—";
  const startMs = Date.parse(start);
  const endMs = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "—";
  const seconds = Math.max(0, Math.round((endMs - startMs) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

export function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${value.toFixed(1)}%`;
}

export function shortId(value: string | null | undefined, length = 10): string {
  if (!value) return "—";
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

export function isActiveRun(status: ExperimentRunStatus): boolean {
  return ["queued", "created", "running", "waiting", "grading"].includes(status);
}

export function isActiveExperiment(status: ExperimentStatus): boolean {
  return ["queued", "running", "grading"].includes(status);
}

export function executorLabel(id: string | null | undefined): string {
  return id ? EXECUTOR_LABELS[id] ?? id : "—";
}
