import type {
  ApprovalListItem,
  ApprovalRecord,
  ApprovalStatus,
  ArtifactListItem,
  ArtifactRecord,
  DesktopCommandKind,
  DesktopCommandRecord,
  DesktopCommandStatus,
  DesktopFrameRecord,
  DesktopSessionRecord,
  DesktopSessionStatus,
  DeviceCapability,
  DeviceCapabilityKind,
  DeviceCapabilityStatus,
  DevicePairingRequest,
  DeviceRecord,
  EffectListItem,
  EffectRecord,
  EffectStatus,
  EventEnvelope,
  EventWindow,
  MemoryConflict,
  MemoryConfidence,
  MemoryForgetReceipt,
  MemoryKind,
  MemoryRecall,
  MemoryRecord,
  MemorySensitivity,
  MemorySettings,
  MemoryVersion,
  MethodCandidate,
  MethodEvaluation,
  MethodMetrics,
  MethodStatus,
  MethodTrial,
  MethodVerdict,
  OutboxAttachment,
  OutboxDraft,
  OutboxDraftStatus,
  PairingRequestStatus,
  ProactiveBudget,
  ProactiveMetrics,
  ProactiveSettings,
  ProactiveSnapshot,
  ProactiveSuggestion,
  RunListItem,
  RunRecord,
  RunStatus,
  RunUsage,
  SourceConnection,
  SourceItem,
  SourceKind,
  SourceStatus,
  StatsSnapshot,
  SyncConflict,
  SyncPeer,
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
  DesktopCommandKind,
  DesktopCommandRecord,
  DesktopCommandStatus,
  DesktopFrameRecord,
  DesktopSessionRecord,
  DesktopSessionStatus,
  DeviceCapability,
  DeviceCapabilityKind,
  DeviceCapabilityStatus,
  DevicePairingRequest,
  DeviceRecord,
  EffectListItem,
  EffectRecord,
  EffectStatus,
  EventEnvelope,
  EventWindow,
  MemoryConflict,
  MemoryConfidence,
  MemoryForgetReceipt,
  MemoryKind,
  MemoryRecall,
  MemoryRecord,
  MemorySensitivity,
  MemorySettings,
  MemoryVersion,
  MethodCandidate,
  MethodEvaluation,
  MethodMetrics,
  MethodStatus,
  MethodTrial,
  MethodVerdict,
  OutboxAttachment,
  OutboxDraft,
  OutboxDraftStatus,
  PairingRequestStatus,
  ProactiveBudget,
  ProactiveMetrics,
  ProactiveSettings,
  ProactiveSnapshot,
  ProactiveSuggestion,
  RunListItem,
  RunRecord,
  RunStatus,
  RunUsage,
  SourceConnection,
  SourceItem,
  SourceKind,
  SourceStatus,
  StatsSnapshot,
  SyncConflict,
  SyncPeer,
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
  killSwitch: boolean;
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

export type SyncPeerView = Omit<SyncPeer, "tokenHash">;

export interface SyncSnapshot {
  instanceId: string;
  latestSeq: number;
  peers: SyncPeerView[];
  conflicts: SyncConflict[];
}

export interface CreateSyncPeerRequest {
  name: string;
  baseUrl: string;
  token?: string;
  lastPullSeq?: number;
}

export interface SyncPeerResult {
  peer: SyncPeerView;
  token: string;
}

export interface SyncPullResult {
  imported: number;
  skipped: number;
  conflicts: number;
  peer: SyncPeerView;
}

export interface SecurityState {
  killSwitch: boolean;
  reason: string | null;
  updatedAt: string | null;
}

export interface SecurityAudit {
  id: string;
  action: string;
  subjectId: string | null;
  subjectLabel: string | null;
  detail: string;
  at: string;
}

export interface SecuritySnapshot {
  state: SecurityState;
  audits: SecurityAudit[];
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

export interface OutboxDraftRequest {
  account?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  attachmentIds?: string[];
}

export interface OutboxSubmitResult {
  draft: OutboxDraft;
  approval: ApprovalRecord;
  task: TaskRecord;
}

export interface OutboxDraftListItem extends OutboxDraft {
  effect: EffectRecord | null;
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

export interface DeviceView extends Omit<DeviceRecord, "tokenHash"> {
  online: boolean;
}

export interface PairingRequestView extends Omit<DevicePairingRequest, "secretHash" | "deviceTokenHash"> {}

export interface DesktopFrameView extends Omit<DesktopFrameRecord, "storagePath"> {
  url: string;
}

export interface DesktopCommandView extends DesktopCommandRecord {}

export interface DesktopSessionView {
  session: DesktopSessionRecord;
  device: DeviceView;
  frame: DesktopFrameView | null;
  frames: DesktopFrameView[];
  commands: DesktopCommandView[];
}

export interface DesktopDashboard {
  devices: DeviceView[];
  pairings: PairingRequestView[];
  sessions: DesktopSessionView[];
}

export type DesktopActionRequest =
  | { kind: "click"; frameId: string; x: number; y: number }
  | { kind: "type"; frameId: string; text: string }
  | { kind: "press"; frameId: string; keys: string }
  | { kind: "focus"; frameId: string; app: string; windowTitle?: string }
  | { kind: "uia.invoke"; frameId: string; elementName: string; controlType?: string }
  | { kind: "uia.setvalue"; frameId: string; elementName: string; value: string; controlType?: string };

export interface MemorySnapshot {
  settings: MemorySettings;
  memories: MemoryRecord[];
  conflicts: MemoryConflict[];
  recalls: MemoryRecall[];
  forgets: MemoryForgetReceipt[];
}

export interface CreateMemoryRequest {
  kind: MemoryKind;
  content: string;
  subjectKey: string;
  scope?: string;
  tags?: string[];
  source: MemoryRecord["source"];
  confidence?: MemoryConfidence;
  sensitivity?: MemorySensitivity;
  allowRecall?: boolean;
  validUntil?: string | null;
  derivedFromId?: string | null;
}

export interface CorrectMemoryRequest {
  content?: string;
  scope?: string;
  tags?: string[];
  confidence?: MemoryConfidence;
  sensitivity?: MemorySensitivity;
  allowRecall?: boolean;
  validUntil?: string | null;
  reason: string;
}

export interface MethodSnapshot {
  methods: MethodCandidate[];
  evaluations: MethodEvaluation[];
  trials: MethodTrial[];
}

export interface CreateMethodRequest {
  name: string;
  summary: string;
  applicability: string;
  steps: string[];
  sourceTaskIds: string[];
  templateId?: string | null;
  allowedCapabilities?: string[];
  guardrails?: string[];
}
