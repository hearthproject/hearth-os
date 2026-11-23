import type {
  ApprovalRecord,
  ApprovalStatus,
  ArtifactRecord,
  EffectRecord,
  EffectStatus,
  EventEnvelope,
  RunRecord,
  RunStatus,
  RunUsage,
  SourceConnection,
  SourceItem,
  TaskRecord,
  TaskStatus
} from "./types.ts";

export interface ApprovalDisplayField {
  label: string;
  value: string;
  redacted?: boolean;
  truncated?: boolean;
}

export interface ApprovalDisplay {
  kind: "tool";
  toolName: string;
  fields: ApprovalDisplayField[];
}

/** API projection for approval UIs; the persisted ApprovalRecord stays unchanged. */
export type ApprovalView = ApprovalRecord & { display: ApprovalDisplay | null };

export interface TaskResumeReference {
  taskId: string;
  runId: string;
  checkpointSeq: number;
  checkpointKind: string;
}

export interface TaskPauseResult {
  task: TaskRecord;
  resume: TaskResumeReference | null;
}

export interface TaskSummary {
  runs: number;
  lastDurationMs: number | null;
  lastUsage: RunUsage | null;
  artifacts: number;
  phase: string;
  deliverables: TaskDeliverable[];
  effects: { total: number; uncertain: number };
  approvalId: string | null;
}

export interface TaskDeliverable {
  id: string;
  name: string;
  relativePath: string;
  mimeType: string;
  bytes: number;
}

export type TaskListItem = TaskRecord & { summary: TaskSummary };

export interface EventWindow {
  events: EventEnvelope[];
  total: number;
  nextAfter: number | null;
  nextBefore: number | null;
}


export type WithTaskTitle<T> = T & { taskTitle: string };

export type ArtifactListItem = WithTaskTitle<Omit<ArtifactRecord, "absolutePath">>;

export type RunListItem = WithTaskTitle<RunRecord>;

export type ApprovalListItem = WithTaskTitle<ApprovalView>;

export type EffectListItem = WithTaskTitle<EffectRecord>;

export interface SourceListResponse {
  sources: SourceConnection[];
}

export interface SourceItemsResponse {
  items: SourceItem[];
}
