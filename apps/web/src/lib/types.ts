import type {
  ApprovalDisplay,
  ApprovalMode,
  ApprovalGrant,
  ApprovalListItem,
  ApprovalRecord,
  ApprovalView,
  ApprovalStatus,
  ArtifactListItem,
  ChatAttachment,
  ChatMessageRecord,
  ContextItem,
  ContextSettings,
  ContextSettingsPatch,
  ContextSnapshot,
  ContextUsageSnapshot,
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
  ExecutorModelBindingPatch,
  ExecutorModelBindingView,
  ExecutorProbeResult,
  ExecutorRuntimeSettings,
  ExecutorSettings,
  ExecutorSettingsPatch,
  ExecutorSettingsView,
  ExecutorView,
  HealthSnapshot,
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
  ModelProviderPreset,
  ModelProfilePatch,
  ModelProfileView,
  ModelProtocol,
  ModelRegistryView,
  ModelSettingsView,
  ReasoningEffort,
  OnboardingChecks,
  OnboardingSnapshot,
  OnboardingState,
  PairingRequestStatus,
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
  TaskDeliverable,
  TaskFollowUpMode,
  TaskFollowUpRecord,
  TaskFollowUpStatus,
  TaskListItem,
  TaskKind,
  TaskProgressDetail,
  TaskPauseResult,
  TaskProposalRecord,
  TaskResumeReference,
  TaskRecord,
  TaskStatus,
  TrashItem,
  TrashKind,
  GitCheckSummary,
  GitCommitSummary,
  GitDiffScope,
  GitDiffView,
  GitFileChange,
  GitFileStatus,
  GitFileView,
  GitPullRequestView,
  GitRepositoryView,
  AssertionConfidence,
  BackgroundToolJob,
  CommitmentRecord,
  DecisionRecord,
  EntityAliasRecord,
  EntityKind,
  EntityRecord,
  EntityStateRecord,
  LocalProject,
  LocalProjectView,
  McpRegistrySearchView,
  McpServerView,
  TaskWorktreeView,
  WebSearchProvider,
  WebSearchSettingsView,
  SkillView,
  PlanView,
  PlanActionName
} from "@hearth/core";

export type {
  ApprovalDisplay,
  ApprovalMode,
  ApprovalGrant,
  ApprovalListItem,
  ApprovalRecord,
  ApprovalStatus,
  ArtifactListItem,
  ArtifactRecord,
  ChatAttachment,
  ChatMessageRecord,
  PlanView,
  PlanActionName,
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
  ExecutorModelBindingPatch,
  ExecutorModelBindingView,
  ExecutorProbeResult,
  ExecutorRuntimeSettings,
  ExecutorSettings,
  ExecutorSettingsPatch,
  ExecutorSettingsView,
  ExecutorView,
  HealthSnapshot,
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
  ModelProviderPreset,
  ModelProfilePatch,
  ModelProfileView,
  ModelProtocol,
  ModelRegistryView,
  ModelSettingsView,
  ReasoningEffort,
  OnboardingChecks,
  OnboardingSnapshot,
  OnboardingState,
  PairingRequestStatus,
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
  TaskDeliverable,
  TaskFollowUpMode,
  TaskFollowUpRecord,
  TaskFollowUpStatus,
  TaskListItem,
  TaskKind,
  TaskProgressDetail,
  TaskPauseResult,
  TaskProposalRecord,
  TaskResumeReference,
  TaskRecord,
  TaskStatus,
  TrashItem,
  TrashKind,
  GitCheckSummary,
  GitCommitSummary,
  GitDiffScope,
  GitDiffView,
  GitFileChange,
  GitFileStatus,
  GitFileView,
  GitPullRequestView,
  GitRepositoryView,
  AssertionConfidence,
  BackgroundToolJob,
  CommitmentRecord,
  DecisionRecord,
  EntityAliasRecord,
  EntityKind,
  EntityRecord,
  EntityStateRecord,
  LocalProject,
  LocalProjectView,
  McpRegistrySearchView,
  McpServerView,
  TaskWorktreeView,
  WebSearchProvider,
  WebSearchSettingsView,
  SkillView
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
  lastPrune?: {
    at: string;
    olderThanDays: number;
    bytes: number;
    entries: Array<{ path: string; bytes: number }>;
  } | null;
}

export interface TaskView {
  task: TaskRecord;
  runs: RunRecord[];
  approvals: ApprovalView[];
  resume: TaskResumeReference | null;
  artifacts: ArtifactRecord[];
  effects: EffectRecord[];
  checkpoints: RunCheckpointRecord[];
  events: EventEnvelope[];
  eventTotal: number;
  followUps: TaskFollowUpRecord[];
}

export interface TaskTurnFile {
  path: string;
  created: boolean;
  insertions: number | null;
  deletions: number | null;
  beforeHash: string | null;
  afterHash: string | null;
  snapshotId: string | null;
  snapshotPath: string | null;
  snapshotAvailable: boolean;
}

export interface TaskTurnVerification {
  toolCalls: number;
  failedTests: string[];
  diagnostics: Array<{ file: string; line?: number; code?: string; message: string }>;
  exitCodes: Array<number | null>;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  browserAssertions: Array<{ kind: string; expected: string; passed: boolean; actual?: string }>;
}

export interface TaskTurn {
  runId: string;
  attempt: number;
  turn: number;
  createdAt: string;
  files: TaskTurnFile[];
  failed: Array<{ path: string; reason: string }>;
  verification?: TaskTurnVerification;
}

export interface TaskTurnsResponse {
  runs: Array<{
    id: string;
    attempt: number;
    status: string;
    startedAt: string | null;
    endedAt: string | null;
  }>;
  turns: TaskTurn[];
}

export interface TaskRewindReport {
  runId: string;
  turn: number;
  restored: string[];
  removed: string[];
  failed: Array<{ path: string; reason: string }>;
  force: boolean;
}

export interface TaskRewindResponse {
  report: TaskRewindReport;
  turn: TaskTurn | null;
}

export interface BrowserTabView {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export type BrowserControlState = "agent" | "awaiting_user" | "user" | "closed" | "unavailable";
export type BrowserTakeoverKind = "login" | "captcha" | "payment_confirmation" | "complex_interaction" | "other";

export interface BrowserStatusView {
  running: boolean;
  backend: string | null;
  profileDir: string;
  pages: number;
  tabs: BrowserTabView[];
  controlState: BrowserControlState;
  controlEpoch: number;
  takeoverKind: BrowserTakeoverKind | null;
  takeoverReason: string | null;
  requiresFreshObservation: boolean;
  lastSnapshotDigest: string | null;
  lastObservedAt: string | null;
  unavailableReason: string | null;
  extension: {
    extensionId: string;
    installUrl: string;
    paired: boolean;
  };
}
export interface BrowserEvidenceView {
  taskId: string;
  runId: string | null;
  kind: string;
  url: string;
  title: string;
  pageDigest: string;
  actionDigest: string;
  screenshotBefore: string | null;
  screenshotAfter: string | null;
  createdAt: string;
}


export interface DossierSectionsView {
  overview: string[];
  stack: string[];
  commands: string[];
  conventions: string[];
  decisions: string[];
  openTasks: string[];
  pitfalls: string[];
  evidence: string[];
}

export interface ProjectDossierView {
  projectId: string;
  projectName: string;
  projectPath: string;
  generatedAt: string;
  sections: DossierSectionsView;
  markdown: string;
}

export interface WorkstyleView {
  content: string;
  updatedAt: string;
  isDefault: boolean;
}

export interface OnboardingVerificationView {
  ok: boolean;
  status: "passed" | "failed";
  summary: string;
  filesChanged: string[];
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

export type SupervisionKindView = "long_running" | "budget_near_limit" | "waiting_approval" | "failed";

export interface SupervisionItemView {
  id: string;
  kind: SupervisionKindView;
  taskId: string;
  title: string;
  body: string;
  createdAt: string;
  status: "unread" | "read" | "dismissed" | "snoozed";
  snoozeUntil: string | null;
}

export interface DailyDigestView {
  date: string;
  generatedAt: string;
  completed: number;
  open: number;
  waitingApproval: number;
  failed: number;
  suggestions: string[];
}

export interface SupervisionSnapshotView {
  items: SupervisionItemView[];
  digest: DailyDigestView | null;
  generatedAt: string;
}

export interface DogfoodReportView {
  generatedAt: string;
  windowDays: number;
  projectId: string | null;
  totals: {
    tasks: number;
    completed: number;
    failed: number;
    active: number;
    successRate: number | null;
    firstPassRate: number | null;
    attempts: number;
    turns: number;
    toolCalls: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    approvals: number;
    approved: number;
    rejected: number;
  };
  friction: {
    topErrors: Array<{ message: string; count: number }>;
    retriedTasks: Array<{ id: string; title: string; status: string; attempts: number; firstPass: boolean; updatedAt: string }>;
  };
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

export interface FolderBrowseEntry {
  name: string;
  path: string;
}

export interface FolderBrowseResult {
  path: string | null;
  parent: string | null;
  roots: FolderBrowseEntry[];
  entries: FolderBrowseEntry[];
  separator: string;
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
  contextUsage?: ContextUsageSnapshot | null;
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
  connectedAt: string | null;
  reconnectAttempts: number;
  inboundCount: number;
  outboundPending: number;
  outboundSent: number;
  outboundFailed: number;
  lastOutboundAt: string | null;
}

export interface FeishuPairingCodeResponse {
  code: string;
  expiresAt: string;
  conversationId: string;
  conversationTitle: string;
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

export interface ExecutorSettingsResponse {
  settings: ExecutorSettingsView;
}

export interface ExecutorListResponse {
  executors: ExecutorView[];
  preferredExecutorId: ExecutorId | null;
  updatedAt: string | null;
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
  title?: string;
  goal?: string;
  textInput?: string;
  sourceItemIds?: string[];
  methodId?: string;
  projectId?: string;
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

export interface OntologyEntityView extends EntityRecord {
  states: EntityStateRecord[];
  aliases: EntityAliasRecord[];
}

export interface ExecutorBootstrapResult {
  install: {
    installed: boolean;
    path: string | null;
    message: string;
  };
  binding: ExecutorModelBindingView | null;
  bindingError: string | null;
  probe: ExecutorProbeResult;
  health: ExecutorProbeResult["health"];
}

export type ExecutorInstallPhase = "install" | "verify" | "bind" | "probe";

export interface ExecutorInstallProgress {
  phase: ExecutorInstallPhase;
  message: string;
  bytes?: number;
  estimatedBytes?: number;
  percent?: number;
}

export type ExecutorBootstrapStreamEvent =
  | ({ type: "progress" } & ExecutorInstallProgress)
  | { type: "complete"; result: ExecutorBootstrapResult }
  | { type: "error"; code?: string; message: string };

export type ImChannelId = "wechat" | "qq";
export type ImConnectionState = "disabled" | "starting" | "connected" | "reconnecting" | "error";

export interface ImChannelStatus {
  state: ImConnectionState;
  lastEventAt: string | null;
  lastError: string | null;
  connectedAt: string | null;
  reconnectAttempts: number;
  inboundCount: number;
  outboundSent: number;
  outboundFailed: number;
  accountLabel: string | null;
}

export interface WechatSettingsView {
  enabled: boolean;
  hasToken: boolean;
  baseUrl: string;
  accountId: string | null;
  userId: string | null;
  conversationId: string | null;
  conversationTitle: string | null;
  projectId: string | null;
  projectTitle: string | null;
  updatedAt: string | null;
}

export interface QqSettingsView {
  enabled: boolean;
  appId: string;
  hasClientSecret: boolean;
  sandbox: boolean;
  conversationId: string | null;
  conversationTitle: string | null;
  projectId: string | null;
  projectTitle: string | null;
  updatedAt: string | null;
}

export interface ImBridgeView {
  settings: { wechat: WechatSettingsView; qq: QqSettingsView };
  status: Record<ImChannelId, ImChannelStatus>;
  qrcode: { active: boolean; expiresAt: string | null } | null;
}

export interface WechatQrView {
  qrcode: string;
  image: string;
  expiresAt: string;
}

export interface WechatQrStatusView {
  status: "wait" | "scaned" | "confirmed" | "expired" | "error";
  accountId: string | null;
  message: string | null;
}
