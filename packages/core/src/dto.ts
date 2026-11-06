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

export interface StatsSnapshot {
  tasks: { total: number; byStatus: Record<TaskStatus, number> };
  runs: {
    total: number;
    byStatus: Record<RunStatus, number>;
    durationMs: number;
    durationCounted: number;
    durationUncounted: number;
    usage: RunUsage | null;
  };
  approvals: { byStatus: Record<ApprovalStatus, number> };
  effects: { byStatus: Record<EffectStatus, number> };
  artifacts: { count: number; bytes: number };
  events: { total: number; latestSeq: number };
}

export type WithTaskTitle<T> = T & { taskTitle: string };

export type ArtifactListItem = WithTaskTitle<Omit<ArtifactRecord, "absolutePath">>;

export type RunListItem = WithTaskTitle<RunRecord>;

export type ApprovalListItem = WithTaskTitle<ApprovalRecord>;

export type EffectListItem = WithTaskTitle<EffectRecord>;

export interface SourceListResponse {
  sources: SourceConnection[];
}

export interface SourceItemsResponse {
  items: SourceItem[];
}
