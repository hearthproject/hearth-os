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
  resultSummary?: string | null;
  conversationId?: string | null;
}

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
}

export interface ConversationRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageRecord {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  taskId: string | null;
  attachments: ChatAttachment[];
  createdAt: string;
}

export type ModelProtocol = "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini";

export interface ModelProviderPreset {
  id: string;
  name: string;
  protocol: ModelProtocol;
  baseUrl: string;
  models: string[];
  note: string;
}

export interface ModelSettingsView {
  providerId: string;
  providerName: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  updatedAt: string | null;
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
  leaseEpoch: number | null;
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

export const DEVICE_CAPABILITY_KINDS = ["observe", "desktop.control", "ui.automation"] as const;

export type DeviceCapabilityKind = (typeof DEVICE_CAPABILITY_KINDS)[number];

export const DEVICE_CAPABILITY_STATUSES = ["pending", "approved", "revoked"] as const;

export type DeviceCapabilityStatus = (typeof DEVICE_CAPABILITY_STATUSES)[number];

export interface DeviceCapability {
  kind: DeviceCapabilityKind;
  status: DeviceCapabilityStatus;
  apps: string[];
  requestedAt: string;
  approvedAt: string | null;
  revokedAt: string | null;
}

export const DEVICE_STATUSES = ["offline", "online", "revoked"] as const;

export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export interface DeviceRecord {
  id: string;
  pairingRequestId: string;
  name: string;
  platform: "windows";
  version: string;
  status: DeviceStatus;
  tokenHash: string;
  capabilities: DeviceCapability[];
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const PAIRING_REQUEST_STATUSES = ["pending", "approved", "rejected", "expired", "redeemed"] as const;

export type PairingRequestStatus = (typeof PAIRING_REQUEST_STATUSES)[number];

export interface DevicePairingRequest {
  id: string;
  code: string;
  secretHash: string;
  deviceTokenHash: string;
  name: string;
  platform: "windows";
  version: string;
  requestedApps: string[];
  requestedCapabilities: DeviceCapabilityKind[];
  status: PairingRequestStatus;
  deviceId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export const DESKTOP_SESSION_STATUSES = ["active", "paused", "taken_over", "terminated"] as const;

export type DesktopSessionStatus = (typeof DESKTOP_SESSION_STATUSES)[number];

export interface DesktopSessionRecord {
  id: string;
  deviceId: string;
  status: DesktopSessionStatus;
  controlEpoch: number;
  currentFrameId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  terminatedAt: string | null;
}

export interface DesktopFrameRecord {
  id: string;
  deviceId: string;
  sessionId: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  sha256: string;
  bytes: number;
  storagePath: string;
  activeApp: string;
  windowTitle: string;
  capturedAt: string;
  expiresAt: string;
}

export const DESKTOP_COMMAND_STATUSES = ["queued", "claimed", "succeeded", "failed", "cancelled", "expired"] as const;

export type DesktopCommandStatus = (typeof DESKTOP_COMMAND_STATUSES)[number];

export const DESKTOP_COMMAND_KINDS = ["observe", "click", "type", "press", "focus", "uia.invoke", "uia.setvalue"] as const;

export type DesktopCommandKind = (typeof DESKTOP_COMMAND_KINDS)[number];

export interface DesktopCommandRecord {
  id: string;
  deviceId: string;
  sessionId: string;
  kind: DesktopCommandKind;
  status: DesktopCommandStatus;
  frameId: string | null;
  controlEpoch: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface EventEnvelope<T = unknown> {
  seq: number;
  id: string;
  type: string;
  taskId: string | null;
  runId: string | null;
  payload: T;
  originInstanceId: string | null;
  originSeq: number | null;
  createdAt: string;
}


export interface AppMeta {
  instanceId: string;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export const TRIGGER_KINDS = [
  "task.deadline",
  "task.failed",
  "effect.uncertain",
  "approval.pending",
  "source.new_items",
  "system.health",
  "email.new_message",
  "calendar.upcoming"
] as const;

export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const AUTONOMY_LEVELS = ["A0", "A1", "A2"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const SUGGESTION_STATUSES = ["new", "accepted", "ignored", "snoozed", "converted", "expired"] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export const SUGGESTION_RISK_LEVELS = ["low", "medium", "high"] as const;
export type SuggestionRisk = (typeof SUGGESTION_RISK_LEVELS)[number];

export const PROACTIVE_MODES = ["off", "suggest", "prepare", "auto"] as const;
export type ProactiveMode = (typeof PROACTIVE_MODES)[number];

export interface SuggestionSourceRef {
  kind: "task" | "source" | "effect" | "approval" | "system" | "email" | "calendar";
  id: string | null;
  label: string;
  detail: string | null;
}

export interface ProactiveSuggestion {
  id: string;
  triggerKind: TriggerKind;
  dedupeKey: string;
  title: string;
  whyNow: string;
  suggestedAction: string;
  expectedImpact: string;
  estimatedCost: string;
  riskLevel: SuggestionRisk;
  requiresApproval: boolean;
  autonomy: AutonomyLevel;
  status: SuggestionStatus;
  priority: number;
  source: SuggestionSourceRef;
  evidence: Record<string, unknown>;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  notifiedAt: string | null;
  snoozeUntil: string | null;
  expiresAt: string | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerPolicy {
  enabled: boolean;
  autonomy: AutonomyLevel;
}

export interface ProactiveSettings {
  enabled: boolean;
  mode: ProactiveMode;
  dailyLimit: number;
  quietStart: string;
  quietEnd: string;
  cooldownMinutes: number;
  aggregateWindowMinutes: number;
  pausedUntil: string | null;
  triggers: Record<TriggerKind, TriggerPolicy>;
  updatedAt: string;
}

export interface ProactiveBudget {
  usedToday: number;
  limit: number;
  quiet: boolean;
  paused: boolean;
  nextAllowedAt: string | null;
}

export interface ProactiveMetrics {
  delivered: number;
  accepted: number;
  ignored: number;
  converted: number;
  acceptanceRate: number | null;
  interruptionsPerTask: number | null;
}

export interface ProactiveSnapshot {
  settings: ProactiveSettings;
  suggestions: ProactiveSuggestion[];
  budget: ProactiveBudget;
  metrics: ProactiveMetrics;
}

export const MEMORY_KINDS = ["fact", "preference", "project", "commitment", "experience", "method"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_STATUSES = ["candidate", "active", "conflict", "forgotten", "superseded"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_SENSITIVITIES = ["normal", "sensitive", "secret"] as const;
export type MemorySensitivity = (typeof MEMORY_SENSITIVITIES)[number];

export const MEMORY_CONFIDENCES = ["low", "medium", "high"] as const;
export type MemoryConfidence = (typeof MEMORY_CONFIDENCES)[number];

export interface MemorySourceRef {
  type: "user" | "task" | "source" | "method" | "system";
  id: string | null;
  label: string;
  excerpt: string | null;
}

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  status: MemoryStatus;
  content: string;
  subjectKey: string;
  scope: string;
  tags: string[];
  source: MemorySourceRef;
  confidence: MemoryConfidence;
  sensitivity: MemorySensitivity;
  allowRecall: boolean;
  version: number;
  supersedesId: string | null;
  derivedFromId: string | null;
  validUntil: string | null;
  createdAt: string;
  updatedAt: string;
  lastRecalledAt: string | null;
  recallCount: number;
}

export interface MemoryVersion {
  id: string;
  memoryId: string;
  version: number;
  content: string;
  status: MemoryStatus;
  source: MemorySourceRef;
  confidence: MemoryConfidence;
  sensitivity: MemorySensitivity;
  allowRecall: boolean;
  scope: string;
  tags: string[];
  reason: string;
  createdAt: string;
}

export const MEMORY_CONFLICT_STATUSES = ["pending", "resolved"] as const;
export type MemoryConflictStatus = (typeof MEMORY_CONFLICT_STATUSES)[number];

export interface MemoryConflict {
  id: string;
  subjectKey: string;
  memoryIds: string[];
  status: MemoryConflictStatus;
  resolution: "keep_left" | "keep_right" | "merged" | null;
  note: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface MemoryRecall {
  id: string;
  memoryId: string;
  taskId: string;
  runId: string | null;
  reason: string;
  score: number;
  createdAt: string;
}

export interface MemorySettings {
  autoCapture: "off" | "experience";
  maxItems: number;
  maxChars: number;
  allowSensitive: boolean;
  updatedAt: string;
}

export const MEMORY_FORGET_TARGETS = ["projection", "versions", "event-log", "recall-audit", "devices"] as const;
export type MemoryForgetTarget = (typeof MEMORY_FORGET_TARGETS)[number];

export interface MemoryForgetPropagation {
  target: MemoryForgetTarget;
  status: "complete" | "pending";
  detail: string;
}

export interface MemoryForgetReceipt {
  id: string;
  memoryId: string;
  affectedMemoryIds: string[];
  reason: string;
  redactedVersions: number;
  redactedEvents: number;
  targets: MemoryForgetPropagation[];
  createdAt: string;
}

export const METHOD_STATUSES = ["candidate", "evaluating", "trial", "adopted", "rejected", "reverted"] as const;
export type MethodStatus = (typeof METHOD_STATUSES)[number];

export const METHOD_VERDICTS = ["insufficient", "improved", "flat", "regressed"] as const;
export type MethodVerdict = (typeof METHOD_VERDICTS)[number];

export interface MethodMetrics {
  tasks: number;
  completed: number;
  failed: number;
  successRate: number | null;
  avgDurationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  approvals: number;
}

export interface MethodCandidate {
  id: string;
  name: string;
  summary: string;
  applicability: string;
  steps: string[];
  sourceTaskIds: string[];
  templateId: string | null;
  status: MethodStatus;
  version: number;
  previousVersionId: string | null;
  allowedCapabilities: string[];
  guardrails: string[];
  baseline: MethodMetrics;
  trial: MethodMetrics;
  evaluationVerdict: MethodVerdict | null;
  createdAt: string;
  updatedAt: string;
  adoptedAt: string | null;
  retiredAt: string | null;
}

export interface MethodEvaluation {
  id: string;
  methodId: string;
  methodVersion: number;
  baselineTaskIds: string[];
  trialTaskIds: string[];
  baseline: MethodMetrics;
  trial: MethodMetrics;
  verdict: MethodVerdict;
  notes: string;
  createdAt: string;
}

export interface MethodTrial {
  id: string;
  methodId: string;
  methodVersion: number;
  taskId: string;
  createdAt: string;
}

export const SYNC_PEER_STATUSES = ["active", "revoked", "error"] as const;
export type SyncPeerStatus = (typeof SYNC_PEER_STATUSES)[number];

export interface SyncPeer {
  id: string;
  name: string;
  baseUrl: string;
  status: SyncPeerStatus;
  tokenHash: string;
  lastPullSeq: number;
  lastPullAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export const SYNC_CONFLICT_STATUSES = ["pending", "local", "remote"] as const;
export type SyncConflictStatus = (typeof SYNC_CONFLICT_STATUSES)[number];

export interface SyncConflict {
  id: string;
  entityType: string;
  entityId: string;
  localUpdatedAt: string | null;
  remoteUpdatedAt: string | null;
  localPayload: Record<string, unknown>;
  remotePayload: Record<string, unknown>;
  status: SyncConflictStatus;
  createdAt: string;
  resolvedAt: string | null;
}

export interface TaskLease {
  taskId: string;
  ownerInstanceId: string;
  ownerDeviceId: string | null;
  epoch: number;
  expiresAt: string;
  heartbeatAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface BackupRecord {
  id: string;
  kind: string;
  path: string;
  bytes: number;
  sha256: string;
  createdAt: string;
}

export const MAINTENANCE_STATUSES = ["running", "completed", "failed"] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

export interface MaintenanceRun {
  id: string;
  startedAt: string;
  endedAt: string | null;
  status: MaintenanceStatus;
  actions: Record<string, number>;
  error: string | null;
}

export interface HealthSnapshot {
  status: "ok" | "degraded";
  name: string;
  now: string;
  startedAt: string;
  uptimeSeconds: number;
  schemaVersion: number;
  instanceId: string;
  memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number };
  disk: { freeBytes: number | null; dataBytes: number; walBytes: number };
  tasks: { total: number; queued: number; running: number; recoverable: number; waitingApproval: number };
  maintenance: { lastRunAt: string | null; lastStatus: MaintenanceStatus | null; lastError: string | null };
  scheduler: { enabled: boolean; running: boolean };
  security: { killSwitch: boolean };
  issues: string[];
  codex: {
    canRun: boolean;
    providerId: string;
    providerName: string;
    model: string | null;
    authSource: "provider-env" | "openai-login" | "missing" | "unknown";
    envKeySource: "process" | "windows-user" | "missing" | "none";
    issues: string[];
  };
}
