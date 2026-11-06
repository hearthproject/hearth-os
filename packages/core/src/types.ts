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

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled"
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export interface TaskInput {
  kind: "file" | "url" | "github" | "text" | "source";
  label: string;
  value: string;
  sha256?: string;
  source?: TaskSourceRef;
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

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

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

export const EFFECT_STATUSES = ["pending", "executing", "succeeded", "failed", "uncertain"] as const;

export type EffectStatus = (typeof EFFECT_STATUSES)[number];

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

export const SOURCE_KINDS = ["file", "knowledge", "web", "email", "calendar"] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_STATUSES = ["connected", "reading", "needs_user", "error", "disconnected"] as const;

export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export const SOURCE_ITEM_STATUSES = ["ready", "failed", "cleared"] as const;

export type SourceItemStatus = (typeof SOURCE_ITEM_STATUSES)[number];

export interface SourceError {
  code: string;
  message: string;
  at: string;
}

export interface SourceCoverage {
  complete: boolean;
  pages: number | null;
  paragraphs: number | null;
  sheets: string[];
  gaps: string[];
}

export interface SourceConnection {
  id: string;
  kind: SourceKind;
  provider: string;
  displayName: string;
  account: string | null;
  rootPath: string | null;
  allowedHosts: string[];
  status: SourceStatus;
  readOnly: true;
  itemCount: number;
  lastReadAt: string | null;
  lastError: SourceError | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceItem {
  id: string;
  sourceId: string;
  itemKey: string;
  label: string;
  locator: string;
  contentPath: string | null;
  contentHash: string | null;
  bytes: number;
  title: string | null;
  status: SourceItemStatus;
  coverage: SourceCoverage;
  duplicateOf: string | null;
  error: SourceError | null;
  fetchedAt: string;
}

export interface TaskSourceRef {
  sourceId: string;
  sourceKind: SourceKind;
  sourceName: string;
  itemId: string;
  itemKey: string;
  title: string | null;
  locator: string;
  fetchedAt: string;
  contentHash: string | null;
  coverage: SourceCoverage;
}

export const OUTBOX_DRAFT_STATUSES = [
  "draft",
  "pending_approval",
  "stored",
  "rejected",
  "failed",
  "uncertain",
  "discarded"
] as const;

export type OutboxDraftStatus = (typeof OUTBOX_DRAFT_STATUSES)[number];

export interface OutboxAttachment {
  artifactId: string;
  name: string;
  mimeType: string;
  sha256: string;
  bytes: number;
}

export interface OutboxDraft {
  id: string;
  account: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachments: OutboxAttachment[];
  status: OutboxDraftStatus;
  taskId: string | null;
  approvalId: string | null;
  effectId: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  discardedAt: string | null;
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
