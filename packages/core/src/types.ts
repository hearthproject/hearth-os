export const TASK_STATUSES = [
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "completed",
  "failed",
  "recoverable",
  "cancelled"
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskInput {
  kind: "file" | "url" | "github" | "text";
  label: string;
  value: string;
  sha256?: string;
}

export interface TaskError {
  kind: string;
  message: string;
  recoverable: boolean;
  guidance: string;
}

export interface TaskRecord {
  id: string;
  templateId: string | null;
  title: string;
  goal: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  deadline: string | null;
  inputs: TaskInput[];
  networkHosts: string[];
  outputDir: string;
  currentRunId: string | null;
  nextAction: string | null;
  error: TaskError | null;
}

export interface RunUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface RunRecord {
  id: string;
  taskId: string;
  attempt: number;
  status: RunStatus;
  threadId: string | null;
  workspace: string;
  startedAt: string | null;
  endedAt: string | null;
  failure: TaskError | null;
  usage: RunUsage | null;
  createdAt: string;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalRecord {
  id: string;
  taskId: string;
  runId: string;
  kind: string;
  summary: string;
  target: Record<string, unknown>;
  preview: Record<string, unknown>;
  parameterHash: string;
  status: ApprovalStatus;
  expiresAt: string;
  decidedAt: string | null;
  effectId: string | null;
  createdAt: string;
}

export type EffectStatus = "pending" | "executing" | "succeeded" | "failed" | "uncertain";

export interface EffectRecord {
  id: string;
  taskId: string;
  approvalId: string;
  kind: string;
  idempotencyKey: string;
  status: EffectStatus;
  target: Record<string, unknown>;
  receipt: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRecord {
  id: string;
  taskId: string;
  runId: string;
  relativePath: string;
  absolutePath: string;
  mimeType: string;
  sha256: string;
  bytes: number;
  createdAt: string;
}

export interface EventEnvelope<T = unknown> {
  seq: number;
  id: string;
  type: string;
  taskId: string | null;
  runId: string | null;
  payload: T;
  createdAt: string;
}
