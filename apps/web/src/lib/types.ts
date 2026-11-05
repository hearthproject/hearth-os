import type {
  ApprovalRecord,
  ArtifactRecord,
  EffectRecord,
  EventEnvelope,
  RunRecord,
  TaskRecord,
  TaskStatus
} from "@hearth/core";
import type { TaskTemplate } from "@hearth/templates";

export type {
  ApprovalRecord,
  ArtifactRecord,
  EffectRecord,
  EventEnvelope,
  RunRecord,
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

export interface ArtifactListItem extends ArtifactRecord {
  taskTitle: string;
}

export interface CreateTaskRequest {
  templateId?: string;
  title?: string;
  goal?: string;
  textInput?: string;
}

export interface ApprovalDecisionResult {
  approval: ApprovalRecord;
  task: TaskRecord;
  effect: EffectRecord | null;
}
