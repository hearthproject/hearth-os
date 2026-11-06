import type {
  ApprovalListItem,
  ApprovalRecord,
  ApprovalStatus,
  ArtifactListItem,
  ArtifactRecord,
  EffectListItem,
  EffectRecord,
  EffectStatus,
  EventEnvelope,
  EventWindow,
  RunListItem,
  RunRecord,
  RunStatus,
  RunUsage,
  SourceConnection,
  SourceItem,
  SourceKind,
  SourceStatus,
  StatsSnapshot,
  TaskListItem,
  TaskRecord,
  TaskStatus
} from "@hearth/core";
import type { TaskTemplate } from "@hearth/templates";

export type {
  ApprovalListItem,
  ApprovalRecord,
  ApprovalStatus,
  ArtifactListItem,
  ArtifactRecord,
  EffectListItem,
  EffectRecord,
  EffectStatus,
  EventEnvelope,
  EventWindow,
  RunListItem,
  RunRecord,
  RunStatus,
  RunUsage,
  SourceConnection,
  SourceItem,
  SourceKind,
  SourceStatus,
  StatsSnapshot,
  TaskListItem,
  TaskRecord,
  TaskStatus,
  TaskTemplate
};

export interface TaskView {
  task: TaskRecord;
  runs: RunRecord[];
  approvals: ApprovalRecord[];
  artifacts: ArtifactRecord[];
  effects: EffectRecord[];
  events: EventEnvelope[];
  eventTotal: number;
}

export interface SystemStatus {
  running: boolean;
  schedulerEnabled: boolean;
  queued: number;
  runningTasks: number;
  waitingApproval: number;
}

export interface HealthResponse {
  status: "ok";
  name: string;
  now: string;
  codex: {
    canRun: boolean;
    providerId: string;
    providerName: string;
    model: string | null;
    authSource: "provider-env" | "openai-login" | "missing" | "unknown";
    issues: string[];
  };
}

export type PreviewableArtifact = Pick<ArtifactRecord, "id" | "taskId" | "relativePath" | "mimeType" | "bytes">;

export interface CreateTaskRequest {
  templateId?: string;
  title?: string;
  goal?: string;
  textInput?: string;
  sourceItemIds?: string[];
}

export interface ApprovalDecisionResult {
  approval: ApprovalRecord;
  task: TaskRecord;
  effect: EffectRecord | null;
}

export interface SourceReadResult {
  source: SourceConnection;
  items: SourceItem[];
  changed: number;
}

export interface RunManifest {
  schemaVersion: number;
  taskId: string;
  templateId: string | null;
  title: string;
  runId: string;
  attempt: number;
  generatedAt: string;
  inputs: { label: string; kind: string; source: string; sha256: string; metadata?: unknown }[];
  expectedOutputs: string[];
  codex: { threadId: string | null; profileLabel: string; usage: RunUsage | null };
  artifacts: { path: string; sha256: string; bytes: number }[];
}
