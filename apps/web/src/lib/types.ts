import type {
  ApprovalMode,
  ApprovalListItem,
  ApprovalRecord,
  ApprovalStatus,
  ArtifactListItem,
  ChatAttachment,
  ChatMessageRecord,
  ContextItem,
  ContextSettings,
  ContextSettingsPatch,
  ContextSnapshot,
  HandoffRecord,
  TaskContextState,
  ConversationSettings,
  ConversationSettingsPatch,
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
  ExecutorId,
  ExecutorInstallInfo,
  ExecutorInstallJob,
  ExecutorModelBindingPatch,
  ExecutorModelBindingView,
  ExecutorProbeResult,
  ExecutorRuntimeSettings,
  ExecutorSettings,
  ExecutorSettingsPatch,
  ExecutorSettingsView,
  ExecutorView,
  HealthSnapshot,
  HermesHealth,
  MaintenanceRun,
  MemoryConflict,
  MemoryConfidence,
  MemoryConsolidationRun,
  MemoryForgetReceipt,
  MemoryKind,
  MemoryRecall,
  MemoryRecord,
  MemorySensitivity,
  MemorySettings,
  MemoryVersion,
  MethodApplication,
  MethodCandidate,
  MethodEvaluation,
  MethodMetrics,
  MethodSettings,
  MethodStatus,
  MethodTrial,
  MethodVerdict,
  ModelProviderPreset,
  ModelProfilePatch,
  ModelProfileView,
  ModelProtocol,
  ModelRegistryView,
  ModelSettingsView,
  OnboardingChecks,
  OnboardingSnapshot,
  OnboardingState,
  OutboxAttachment,
  OutboxDraft,
  OutboxDraftStatus,
  PairingRequestStatus,
  ProactiveBudget,
  ProactiveMetrics,
  ProactiveSettings,
  ProactiveSnapshot,
  ProactiveSuggestion,
  ReconcileItem,
  RunListItem,
  RunCheckpointRecord,
  RunRecord,
  RunStatus,
  RunUsage,
  ScheduleRecord,
  ScheduleRunRecord,
  ScheduleRunStatus,
  SettingsMigrationRecord,
  SourceConnection,
  SourceItem,
  SourceKind,
  SourceStatus,
  StatsSnapshot,
  SyncConflict,
  SyncPeer,
  TaskDeliverable,
  TaskFollowUpMode,
  TaskFollowUpRecord,
  TaskFollowUpStatus,
  TaskListItem,
  TaskKind,
  TaskProgressDetail,
  TaskProposalRecord,
  TaskRecord,
  TaskStatus,
  GitCheckSummary,
  GitCommitSummary,
  GitDiffScope,
  GitDiffView,
  GitFileChange,
  GitFileStatus,
  GitFileView,
  GitPullRequestView,
  GitRepositoryView,
  GoalCompletionReport,
  GoalContract
} from "@hearth/core";
import type { TaskTemplate } from "@hearth/templates";

export type {
  ApprovalMode,
  ApprovalListItem,
  ApprovalRecord,
  ApprovalStatus,
  ArtifactListItem,
  ArtifactRecord,
  ChatAttachment,
  ChatMessageRecord,
  ContextItem,
  ContextSettings,
  ContextSettingsPatch,
  ContextSnapshot,
  HandoffRecord,
  TaskContextState,
  ConversationSettings,
  ConversationSettingsPatch,
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
  ExecutorId,
  ExecutorInstallInfo,
  ExecutorInstallJob,
  ExecutorModelBindingPatch,
  ExecutorModelBindingView,
  ExecutorProbeResult,
  ExecutorRuntimeSettings,
  ExecutorSettings,
  ExecutorSettingsPatch,
  ExecutorSettingsView,
  ExecutorView,
  HealthSnapshot,
  HermesHealth,
  MaintenanceRun,
  MemoryConflict,
  MemoryConfidence,
  MemoryForgetReceipt,
  MemoryKind,
  MemoryRecall,
  MemoryRecord,
  MemorySensitivity,
  MemorySettings,
  MemoryVersion,
  MethodApplication,
  MethodCandidate,
  MethodEvaluation,
  MethodMetrics,
  MethodSettings,
  MethodStatus,
  MethodTrial,
  MethodVerdict,
  ModelProviderPreset,
  ModelProfilePatch,
  ModelProfileView,
  ModelProtocol,
  ModelRegistryView,
  ModelSettingsView,
  OnboardingChecks,
  OnboardingSnapshot,
  OnboardingState,
  OutboxAttachment,
  OutboxDraft,
  OutboxDraftStatus,
  PairingRequestStatus,
  ProactiveBudget,
  ProactiveMetrics,
  ProactiveSettings,
  ProactiveSnapshot,
  ProactiveSuggestion,
  ReconcileItem,
  RunListItem,
  RunCheckpointRecord,
  RunRecord,
  RunStatus,
  RunUsage,
  ScheduleRecord,
  ScheduleRunRecord,
  ScheduleRunStatus,
  SettingsMigrationRecord,
  SourceConnection,
  SourceItem,
  SourceKind,
  SourceStatus,
  StatsSnapshot,
  SyncConflict,
  SyncPeer,
  TaskDeliverable,
  TaskFollowUpMode,
  TaskFollowUpRecord,
  TaskFollowUpStatus,
  TaskListItem,
  TaskKind,
  TaskProgressDetail,
  TaskProposalRecord,
  TaskRecord,
  TaskStatus,
  GitCheckSummary,
  GitCommitSummary,
  GitDiffScope,
  GitDiffView,
  GitFileChange,
  GitFileStatus,
  GitFileView,
  GitPullRequestView,
  GitRepositoryView,
  GoalCompletionReport,
  GoalContract,
  TaskTemplate
};

export interface ModelRegistryResponse extends ModelRegistryView {
  presets: ModelProviderPreset[];
  chatConfigured: boolean;
}

export interface SettingsStorageResponse {
  dataDir: string;
  schemaVersion: number;
  paths: {
    database: string;
    executors: string;
    codexHome: string;
    deepseekHarnessHome: string;
    contextBlobs: string;
    backups: string;
    attachments: string;
  };
  legacy: {
    modelSettings: string;
    executorSettings: string;
  };
  migrations: SettingsMigrationRecord[];
  startupMigrations: SettingsMigrationRecord[];
}

export interface TaskView {
  task: TaskRecord;
  goal: GoalContract | null;
  completionReport: GoalCompletionReport | null;
  runs: RunRecord[];
  approvals: ApprovalRecord[];
  artifacts: ArtifactRecord[];
  effects: EffectRecord[];
  checkpoints: RunCheckpointRecord[];
  events: EventEnvelope[];
  eventTotal: number;
  followUps: TaskFollowUpRecord[];
}

export interface TaskContextResponse extends ContextSnapshot {}

export interface TaskHandoffsResponse {
  state: TaskContextState | null;
  handoffs: HandoffRecord[];
}

export interface ConfirmHandoffResponse {
  task: TaskRecord;
  handoff: HandoffRecord | null;
}

export interface ContextSettingsResponse {
  settings: ContextSettings;
}

export interface ContextMetricsResponse {
  generatedAt: string;
  ledger: { tasks: number; items: number };
  handoffs: {
    total: number;
    automatic: number;
    userConfirmed: number;
    pendingUser: number;
    prepared: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
    successRate: number | null;
    averageContextTokens: number | null;
    averageRecoveryMs: number | null;
  };
  diagnosis: {
    total: number;
    model: number;
    rules: number;
    averageDurationMs: number | null;
    averageContextTokens: number | null;
  };
}

export interface SystemStatus {
  running: boolean;
  schedulerEnabled: boolean;
  queued: number;
  runningTasks: number;
  waitingApproval: number;
  killSwitch: boolean;
}

export type HealthResponse = Omit<HealthSnapshot, "codex"> & {
  codex: HealthSnapshot["codex"] & {
    configPath: string;
    codexHome: string;
    baseUrl: string | null;
    wireApi: string | null;
    envKey: string | null;
    envKeyPresent: boolean;
  };
  chatModel: {
    configured: boolean;
    settings: ModelSettingsView;
  };
};

export interface MaintenanceSnapshot {
  latest: MaintenanceRun | null;
  runs: MaintenanceRun[];
  running: boolean;
  policy: {
    claimedCommandTtlMinutes: number;
    temporaryFileTtlHours: number;
    keptRuns: number;
  };
}

export interface BackupView {
  id: string;
  kind: string;
  bytes: number;
  sha256: string;
  createdAt: string;
}

export interface BackupSnapshot {
  records: BackupView[];
  scope: {
    includes: string[];
    excludes: string[];
  };
  encryption: {
    cipher: string;
    kdf: string;
    minimumPassphraseLength: number;
  };
}

export interface BackupRestoreResult {
  restoredAt: string;
  sourceInstanceId: string;
  schemaVersion: number;
  counts: Record<string, number>;
  masterKeyRestored: boolean;
  warnings: string[];
  schedulerStopped: boolean;
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

export interface ConversationListItem extends ConversationRecord {
  messageCount: number;
  preview: string;
}

export interface ConversationDetail {
  conversation: ConversationRecord;
  messages: ChatMessageRecord[];
  tasks: TaskRecord[];
  proposals: TaskProposalRecord[];
}

export interface AttachmentUploadResult {
  attachments: ChatAttachment[];
}

export interface ModelSettingsResponse {
  settings: ModelSettingsView;
  presets?: ModelProviderPreset[];
  configured?: boolean;
}

export type FeishuDomain = "feishu" | "lark";
export type FeishuConnectionState = "disabled" | "starting" | "connected" | "reconnecting" | "error";

export interface FeishuSettingsView {
  enabled: boolean;
  appId: string;
  hasAppSecret: boolean;
  appSecretMasked: string | null;
  allowedOpenIds: string[];
  domain: FeishuDomain;
  updatedAt: string | null;
}

export interface FeishuStatus {
  state: FeishuConnectionState;
  lastEventAt: string | null;
  lastError: string | null;
}

export interface FeishuIntegrationResponse {
  settings: FeishuSettingsView;
  status: FeishuStatus;
}

export interface FeishuTestResponse {
  ok: boolean;
  error?: string;
  elapsedMs: number;
}

export interface MailServerView {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  hasPassword: boolean;
  passwordMasked: string | null;
}

export interface MailAccountView {
  id: string;
  name: string;
  fromName: string;
  fromAddress: string;
  smtp: MailServerView;
  imap: MailServerView;
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export interface MailServerInput {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password?: string;
}

export interface MailAccountInput {
  name: string;
  fromName: string;
  fromAddress: string;
  smtp: MailServerInput;
  imap: MailServerInput;
  syncEnabled?: boolean;
  syncIntervalMinutes?: number;
}

export interface MailTestResult {
  ok: boolean;
  smtp: { ok: boolean; error: string | null; elapsedMs: number };
  imap: { ok: boolean; error: string | null; elapsedMs: number };
}

export interface MailSyncResult {
  sourceId: string;
  fetched: number;
  changed: number;
}


export interface ExecutorSettingsResponse {
  settings: ExecutorSettingsView;
  hermes: HermesHealth;
}

export interface ExecutorListResponse {
  executors: ExecutorView[];
  preferredExecutorId: ExecutorId | null;
  updatedAt: string | null;
}

export interface ExecutorInstallResponse {
  job: ExecutorInstallJob | null;
  install: ExecutorInstallInfo;
  health: ExecutorView["health"];
}

export interface HermesProbeResponse {
  ok: boolean;
  command: string;
  version: string | null;
  error: string | null;
  elapsedMs: number;
  health: HermesHealth;
}

export interface ScheduleSnapshot {
  schedules: ScheduleRecord[];
}

export interface ScheduleRunSnapshot {
  runs: ScheduleRunRecord[];
}

export interface ScheduleInput {
  name: string;
  prompt: string;
  cron: string;
  timezone?: string;
  executorId?: ExecutorId;
  approvalMode?: ApprovalMode;
  taskKind?: ScheduleRecord["taskKind"];
  enabled?: boolean;
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
  methodId?: string;
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
  executor?: { id: string; threadId: string | null; label: string; usage: RunUsage | null };
  codex?: { threadId: string | null; profileLabel: string; usage: RunUsage | null };
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
  consolidations: MemoryConsolidationRun[];
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
  applications: MethodApplication[];
  settings: MethodSettings;
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
