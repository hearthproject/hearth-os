import type {
  ApprovalListItem,
  ApprovalRecord,
  ApprovalStatus,
  ArtifactListItem,
  ChatAttachment,
  ChatMessageRecord,
  ConversationRecord,
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
  ModelProviderPreset,
  ModelSettingsView,
  OutboxAttachment,
  OutboxDraft,
  OutboxDraftStatus,
  PairingRequestStatus,
  RunListItem,
  RunRecord,
  RunStatus,
  RunUsage,
  SourceConnection,
  SourceItem,
  SourceKind,
  SourceStatus,
  StatsSnapshot,
  TaskDeliverable,
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
  ChatAttachment,
  ChatMessageRecord,
  ConversationRecord,
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
  ModelProviderPreset,
  ModelSettingsView,
  OutboxAttachment,
  OutboxDraft,
  OutboxDraftStatus,
  PairingRequestStatus,
  RunListItem,
  RunRecord,
  RunStatus,
  RunUsage,
  SourceConnection,
  SourceItem,
  SourceKind,
  SourceStatus,
  StatsSnapshot,
  TaskDeliverable,
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
  chatModel: {
    configured: boolean;
    settings: ModelSettingsView;
  };
  codex: {
    canRun: boolean;
    providerId: string;
    providerName: string;
    model: string | null;
    authSource: "provider-env" | "openai-login" | "missing" | "unknown";
    issues: string[];
    configPath: string;
    codexHome: string;
    baseUrl: string | null;
    wireApi: string | null;
    envKey: string | null;
    envKeyPresent: boolean;
  };
}

export interface ConversationListItem extends ConversationRecord {
  messageCount: number;
  preview: string;
}

export interface ConversationDetail {
  conversation: ConversationRecord;
  messages: ChatMessageRecord[];
}

export interface AttachmentUploadResult {
  attachments: ChatAttachment[];
}

export interface ModelSettingsResponse {
  settings: ModelSettingsView;
  presets?: ModelProviderPreset[];
  configured?: boolean;
}

export interface ModelListResponse {
  models: string[];
  error?: string;
  code?: string;
}

export interface ModelTestResponse {
  ok: boolean;
  reply?: string;
  error?: string;
  code?: string;
  elapsedMs?: number;
}

export interface CodexProbeResponse {
  ok: boolean;
  text?: string;
  error?: string;
  canRun: boolean;
  configPath: string;
  codexHome: string;
  providerId: string;
  providerName: string;
  model: string | null;
  baseUrl: string | null;
  wireApi: string | null;
  envKey: string | null;
  envKeyPresent: boolean;
  authSource: HealthResponse["codex"]["authSource"];
  issues: string[];
  elapsedMs: number;
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
