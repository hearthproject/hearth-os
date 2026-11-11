export const TASK_STATUSES = [
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "waiting_budget",
  "completed",
  "failed",
  "recoverable",
  "cancelled"
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const EXECUTOR_IDS = ["native", "codex", "deepseek-harness", "hermes", "qoder", "workbuddy", "kimi"] as const;
export type ExecutorId = (typeof EXECUTOR_IDS)[number];

export const EXECUTOR_TIERS = ["first-class", "external"] as const;
export type ExecutorTier = (typeof EXECUTOR_TIERS)[number];

export const FIRST_CLASS_EXECUTOR_IDS = ["deepseek-harness", "codex", "native"] as const;
export type FirstClassExecutorId = (typeof FIRST_CLASS_EXECUTOR_IDS)[number];

export const APPROVAL_MODES = ["necessary", "full"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export interface ConversationSettings {
  executorEnabled: Record<ExecutorId, boolean>;
  approvalMode: ApprovalMode;
  preferredExecutorId: ExecutorId | null;
}

export interface ConversationSettingsPatch {
  executorEnabled?: Partial<Record<ExecutorId, boolean | undefined>> | undefined;
  approvalMode?: ApprovalMode | undefined;
  preferredExecutorId?: ExecutorId | null | undefined;
}

export function defaultConversationSettings(
  approvalMode: ApprovalMode = "necessary",
  enabled: Partial<Record<ExecutorId, boolean | undefined>> = { native: true, codex: true, hermes: true }
): ConversationSettings {
  const executorEnabled = {} as Record<ExecutorId, boolean>;
  for (const id of EXECUTOR_IDS) executorEnabled[id] = enabled[id] ?? false;
  return { executorEnabled, approvalMode, preferredExecutorId: null };
}

export function mergeConversationSettings(
  current: ConversationSettings | null | undefined,
  patch: ConversationSettingsPatch | null | undefined
): ConversationSettings {
  const base = current ?? defaultConversationSettings();
  const executorEnabled = {} as Record<ExecutorId, boolean>;
  for (const id of EXECUTOR_IDS) {
    executorEnabled[id] = patch?.executorEnabled?.[id] ?? base.executorEnabled?.[id] ?? false;
  }
  return {
    executorEnabled,
    approvalMode: patch?.approvalMode ?? base.approvalMode,
    preferredExecutorId: patch?.preferredExecutorId !== undefined
      ? patch.preferredExecutorId
      : base.preferredExecutorId ?? null
  };
}

export interface ExecutorRuntimeSettings {
  command?: string | undefined;
  executablePath?: string | undefined;
  installMode?: "managed" | "existing" | "detected" | undefined;
  authMode?: "local" | "pat" | "env" | undefined;
  version?: string | null | undefined;
}

export interface ExecutorHealth {
  id: ExecutorId;
  canRun: boolean;
  command: string;
  version: string | null;
  issues: string[];
  experimental?: boolean | undefined;
  installState?: "available" | "missing" | "needs_repair" | "update_available" | "unsupported" | undefined;
  state?: ExecutorHealthState | undefined;
  verifiedAt?: string | null | undefined;
  lastProbe?: ExecutorProbeSummary | null | undefined;
}

export type ExecutorHealthState = "missing" | "unconfigured" | "unverified" | "ready" | "failed" | "quota_exceeded";

export interface ExecutorProbeSummary {
  ok: boolean;
  state: ExecutorHealthState;
  error: string | null;
  code: string | null;
  elapsedMs: number;
  checkedAt: string;
}

export interface ExecutorProbeResult {
  id: ExecutorId;
  ok: boolean;
  command: string;
  version: string | null;
  error: string | null;
  elapsedMs: number;
  health: ExecutorHealth;
}

export type ExecutorInstallStatus = "running" | "succeeded" | "failed";

export interface ExecutorInstallJob {
  id: ExecutorId;
  status: ExecutorInstallStatus;
  packageSpec: string;
  startedAt: string;
  finishedAt: string | null;
  log: string;
  error: string | null;
}

export interface ExecutorInstallInfo {
  supported: boolean;
  packageSpec: string | null;
  hint: string | null;
  job: ExecutorInstallJob | null;
}

export interface ExecutorView {
  id: ExecutorId;
  name: string;
  description: string;
  capabilities: string[];
  tier: ExecutorTier;
  provider?: string | undefined;
  experimental?: boolean | undefined;
  supportsResume?: boolean | undefined;
  runtime: ExecutorRuntimeSettings;
  concurrency: number;
  health: ExecutorHealth;
  install: ExecutorInstallInfo;
  modelBinding?: ExecutorModelBindingView | undefined;
}

export interface ExecutorSettings {
  defaultApprovalMode: ApprovalMode;
  preferredExecutorId: ExecutorId | null;
  concurrency: Record<ExecutorId, number>;
  executors: Partial<Record<ExecutorId, ExecutorRuntimeSettings>>;
  hermesCommand: string;
}

export interface ExecutorSettingsPatch {
  defaultApprovalMode?: ApprovalMode | undefined;
  preferredExecutorId?: ExecutorId | null | undefined;
  concurrency?: Partial<Record<ExecutorId, number>> | undefined;
  executors?: Partial<Record<ExecutorId, ExecutorRuntimeSettings>> | undefined;
  hermesCommand?: string | undefined;
}

export interface ExecutorSettingsView extends ExecutorSettings {
  updatedAt: string | null;
}

export interface HermesHealth {
  canRun: boolean;
  command: string;
  version: string | null;
  issues: string[];
  configured?: boolean | undefined;
  configPath?: string | null | undefined;
}

export const TASK_KINDS = ["delivery", "workspace", "general"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

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
  cause?: FailureCause;
  diagnosisId?: string;
  failureClass?: FailureClass;
  disposition?: FailureDisposition;
  budgetExhaustion?: BudgetExhaustion;
}

export interface TaskPermissions {
  readRoots: string[];
  writeRoots: string[];
  networkHosts: string[];
  tools: string[];
}

export interface RunBudget {
  maxTurns: number;
  maxToolCalls: number;
  maxTokens: number;
  maxDurationMs: number;
}

export type BudgetDimension = "turns" | "toolCalls" | "tokens" | "duration";

export interface BudgetExhaustion {
  dimension: BudgetDimension;
  used: number;
  limit: number;
}

export interface TaskRecord {
  id: string;
  goalId?: string | null;
  externalRef?: string | null;
  requestHash?: string | null;
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
  executorId?: ExecutorId;
  taskKind?: TaskKind;
  expectedOutputs?: string[];
  permissions?: TaskPermissions;
  pendingInput?: string | null;
  methodId?: string | null;
  methodVersion?: number | null;
  pinnedAt?: string | null;
  archivedAt?: string | null;
  budgetOverride?: RunBudget | null;
  deletedAt?: string | null;
  trashBatchId?: string | null;
}

export const GOAL_STATES = ["draft", "active", "blocked", "awaiting_user", "validating", "done", "failed", "cancelled"] as const;
export type GoalState = (typeof GOAL_STATES)[number];

export const GOAL_VALIDATORS = ["command", "file", "schema", "git", "manual", "llm_review"] as const;
export type GoalValidator = (typeof GOAL_VALIDATORS)[number];

export const GOAL_REVIEW_POLICIES = ["auto", "human_on_risk", "human_on_complete"] as const;
export type GoalReviewPolicy = (typeof GOAL_REVIEW_POLICIES)[number];

export interface GoalAuthoritySource {
  kind: "user" | "document" | "system";
  ref: string;
}

export interface GoalCriterion {
  id: string;
  description: string;
  validator: GoalValidator;
  check: string;
  required: boolean;
}

export interface GoalBudget {
  maxTurns?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  maxDurationMs?: number;
  maxHumanMinutes?: number;
}

export interface GoalContract {
  goalId: string;
  title: string;
  objective: string;
  constraints: string[];
  forbiddenActions: string[];
  authoritySources: GoalAuthoritySource[];
  successCriteria: GoalCriterion[];
  evidenceRequirements: string[];
  budget: GoalBudget;
  deadline?: string;
  stopConditions: string[];
  reviewPolicy: GoalReviewPolicy;
  currentState: GoalState;
  nextHandoff?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GoalCriterionResult {
  criterionId: string;
  status: "passed" | "failed" | "not_run" | "not_required";
  evidenceRefs: string[];
  detail: string;
}

export interface GoalCompletionReport {
  goalId: string;
  taskId: string;
  verdict: "pass" | "fail" | "needs_human" | "blocked";
  summary: string;
  criteria: GoalCriterionResult[];
  evidenceRefs: string[];
  missingEvidence: string[];
  forbiddenActions: string[];
  checkedAt: string;
}

export const TASK_FOLLOW_UP_MODES = ["queue", "steer"] as const;
export type TaskFollowUpMode = (typeof TASK_FOLLOW_UP_MODES)[number];

export const TASK_FOLLOW_UP_STATUSES = ["queued", "steering", "applied", "cancelled"] as const;
export type TaskFollowUpStatus = (typeof TASK_FOLLOW_UP_STATUSES)[number];

export interface TaskFollowUpRecord {
  id: string;
  taskId: string;
  conversationId: string | null;
  content: string;
  mode: TaskFollowUpMode;
  status: TaskFollowUpStatus;
  appliedRunId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
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
  settings: ConversationSettings;
  deletedAt?: string | null;
  trashBatchId?: string | null;
}

export type TrashKind = "conversation" | "task";

export interface TrashItem {
  kind: TrashKind;
  id: string;
  title: string;
  deletedAt: string;
  trashBatchId: string | null;
  status: TaskStatus | null;
  conversationId: string | null;
}

export type ChatMessageKind = "text" | "task_status";

export interface ChatMessageRecord {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  taskId: string | null;
  attachments: ChatAttachment[];
  createdAt: string;
  kind?: ChatMessageKind;
  taskStatus?: TaskStatus | null;
}

export interface TaskProgressDetail {
  executorId?: ExecutorId;
  eventType?: string;
  itemType?: string;
  title?: string;
  command?: string;
  output?: string;
  input?: unknown;
  status?: string;
  exitCode?: number;
  durationMs?: number;
  text?: string;
  query?: string;
  paths?: string[];
  truncated?: boolean;
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

export type WebSearchProvider = "tavily" | "searxng";

export interface WebSearchSettingsView {
  enabled: boolean;
  provider: WebSearchProvider;
  searxngUrl: string;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  updatedAt: string | null;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  query: string;
  provider: WebSearchProvider;
  results: WebSearchResult[];
  fetchedAt: string;
}

export interface ModelProfileRecord {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  apiKeyCipher: string | null;
  isLocal: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelProfileView {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  isLocal: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelProfilePatch {
  name?: string | undefined;
  providerId?: string | undefined;
  providerName?: string | undefined;
  protocol?: ModelProtocol | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  apiKey?: string | undefined;
}

export interface ExecutorModelBinding {
  executorId: ExecutorId;
  profileId: string | null;
  protocolOverride: ModelProtocol | null;
  modelOverride: string | null;
  updatedAt: string | null;
}

export interface ExecutorModelBindingPatch {
  profileId?: string | null | undefined;
  protocolOverride?: ModelProtocol | null | undefined;
  modelOverride?: string | null | undefined;
}

export interface ExecutorModelBindingView extends ExecutorModelBinding {
  profile: ModelProfileView | null;
  effectiveProtocol: ModelProtocol | null;
  effectiveModel: string | null;
  allowedProtocols: ModelProtocol[];
  protocolLocked: boolean;
  available: boolean;
  issue: string | null;
}

export interface ModelRegistryView {
  chatProfileId: string | null;
  chatProfile: ModelProfileView | null;
  profiles: ModelProfileView[];
  bindings: ExecutorModelBindingView[];
  updatedAt: string | null;
}

export type SettingsMigrationStatus = "pending" | "completed" | "failed" | "skipped";

export interface SettingsMigrationRecord {
  id: string;
  sourcePath: string;
  backupPath: string | null;
  status: SettingsMigrationStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  turns?: number;
  toolCalls?: number;
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
  executorId?: ExecutorId;
  checkpointSeq?: number;
  budget?: RunBudget;
  parentRunId?: string | null;
  handoffId?: string | null;
}

export const TASK_PROPOSAL_STATUSES = ["pending", "confirmed", "rejected", "expired"] as const;
export type TaskProposalStatus = (typeof TASK_PROPOSAL_STATUSES)[number];

export interface TaskProposalRecord {
  id: string;
  conversationId: string;
  title: string;
  goal: string;
  executorId: ExecutorId;
  taskKind: TaskKind;
  expectedOutputs: string[];
  permissions: TaskPermissions;
  inputs: TaskInput[];
  reason: string;
  status: TaskProposalStatus;
  expiresAt: string;
  createdAt: string;
  decidedAt: string | null;
}

export type ScheduleRunStatus = "queued" | "running" | "completed" | "failed" | "skipped" | "cancelled";

export const SCHEDULE_CATCH_UP_POLICIES = ["skip", "run_once", "run_all_bounded"] as const;
export type ScheduleCatchUpPolicy = (typeof SCHEDULE_CATCH_UP_POLICIES)[number];

export interface ScheduleRecord {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  conversationId: string;
  executorId: ExecutorId;
  approvalMode: ApprovalMode;
  taskKind: TaskKind;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastTaskId: string | null;
  lastStatus: ScheduleRunStatus | null;
  catchUpPolicy: ScheduleCatchUpPolicy;
  catchUpMaxRuns: number;
  priority: number;
  failureCount: number;
  cooldownUntil: string | null;
  deleteAfterRun: boolean;
  pausedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleRunRecord {
  id: string;
  scheduleId: string;
  scheduledFor: string;
  taskId: string | null;
  effectId: string | null;
  idempotencyKey: string | null;
  attempt: number;
  failureClass: FailureClass | null;
  receipt: Record<string, unknown> | null;
  status: ScheduleRunStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunCheckpointRecord {
  id: string;
  runId: string;
  taskId: string;
  seq: number;
  kind: string;
  path: string;
  sha256: string;
  usage: RunUsage | null;
  createdAt: string;
  proof?: RunCheckpointProof;
}

export interface RunCheckpointProof {
  goalId: string | null;
  attemptId: string;
  identity: {
    executorId: string;
    runtimeVersion: string;
    modelId?: string;
  };
  phasePrefix: string[];
  hostResult?: unknown;
  validation?: {
    status: "passed" | "failed" | "not_required";
    evidenceRefs: string[];
  };
  effectReceipts: string[];
  preparedIntents: string[];
  permissionsDigest?: string;
  goalRevision?: string;
  workspaceDigest?: string;
  createdAt: string;
}

export type GitFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface GitFileChange {
  path: string;
  oldPath?: string | null;
  status: GitFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  staged: boolean;
  unstaged: boolean;
}

export interface GitCommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authoredAt: string;
}

export interface GitCheckSummary {
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
}

export interface GitPullRequestView {
  number: number;
  url: string;
  title: string;
  state: string;
  draft: boolean;
  mergeable: string | null;
  reviewDecision: string | null;
  headSha: string | null;
  updatedAt: string | null;
  checks: GitCheckSummary[];
}

export interface GitRepositoryView {
  available: boolean;
  reason: string | null;
  repo: string | null;
  branch: string | null;
  base: string | null;
  baseSha: string | null;
  headSha: string | null;
  filesScope: GitDiffScope;
  clean: boolean;
  statusText: string;
  commitsAhead: number;
  additions: number;
  deletions: number;
  files: GitFileChange[];
  branchAdditions: number;
  branchDeletions: number;
  branchFiles: GitFileChange[];
  commits: GitCommitSummary[];
  pullRequest: GitPullRequestView | null;
  pullRequestError: string | null;
}

export type GitDiffScope = "working" | "branch";

export interface GitDiffView {
  scope: GitDiffScope;
  path: string | null;
  patch: string;
  truncated: boolean;
}

export interface GitFileView {
  path: string;
  exists: boolean;
  fromHead: boolean;
  binary: boolean;
  truncated: boolean;
  bytes: number;
  content: string;
}

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "consumed", "expired", "revoked"] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_CONTEXTS = ["interactive", "scheduled", "webhook", "remote", "delegated"] as const;
export type ApprovalContext = (typeof APPROVAL_CONTEXTS)[number];

export const PERMISSION_MODES = ["read-only", "guarded", "workspace", "full"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const APPROVAL_DECIDERS = ["user", "policy", "auto_review"] as const;
export type ApprovalDecider = (typeof APPROVAL_DECIDERS)[number];

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
  goalId?: string | null;
  actionDigest?: string | null;
  permissionMode?: PermissionMode | null;
  context?: ApprovalContext | null;
  maxUses?: number;
  usedCount?: number;
  approvedBy?: ApprovalDecider | null;
  issuedAt?: string;
  revokedAt?: string | null;
  action?: Record<string, unknown> | null;
  rejectionCount?: number;
}

export const EFFECT_STATUSES = [
  "pending",
  "prepared",
  "admitted",
  "executing",
  "committed",
  "succeeded",
  "failed",
  "uncertain",
  "reconciled_committed",
  "reconciled_absent",
  "abandoned"
] as const;

export type EffectStatus = (typeof EFFECT_STATUSES)[number];

export const EFFECT_REPLAY_POLICIES = ["replay_safe", "process_bound", "never_replay"] as const;
export type EffectReplayPolicy = (typeof EFFECT_REPLAY_POLICIES)[number];

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
  goalId?: string | null;
  effectType?: string;
  replayPolicy?: EffectReplayPolicy;
  actionDigest?: string | null;
  resolvedActionDigest?: string | null;
  attemptCount?: number;
  maxAttempts?: number;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  availableAt?: string;
  provider?: string | null;
  providerRef?: string | null;
  reconcileRef?: string | null;
  reconciledAt?: string | null;
  targetKey?: string | null;
  suspendReason?: string | null;
}

export const RECONCILE_STATUSES = ["open", "checking", "needs_human", "resolved_committed", "resolved_absent", "conflicting", "abandoned"] as const;
export type ReconcileStatus = (typeof RECONCILE_STATUSES)[number];

export const RECONCILE_ACTIONS = ["recheck", "mark_committed", "mark_absent", "abandon", "create_task"] as const;
export type ReconcileAction = (typeof RECONCILE_ACTIONS)[number];

export interface ReconcileItem {
  id: string;
  effectId: string;
  taskId: string;
  goalId: string | null;
  targetKey: string | null;
  summary: string;
  status: ReconcileStatus;
  reason: string;
  attempted: string[];
  risk: "low" | "medium" | "high" | "critical";
  suggestedActions: ReconcileAction[];
  provider: string | null;
  checkCount: number;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
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
  "sent",
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

export const MEMORY_TIERS = ["instructions", "curated", "episodic", "prospective", "review"] as const;
export type MemoryTier = (typeof MEMORY_TIERS)[number];

export const MEMORY_ORIGINS = ["user", "verified_system", "agent", "imported", "web", "email", "untrusted"] as const;
export type MemoryOriginClass = (typeof MEMORY_ORIGINS)[number];

export const MEMORY_TRUST_LEVELS = ["high", "medium", "low", "none"] as const;
export type MemoryTrust = (typeof MEMORY_TRUST_LEVELS)[number];

export const MEMORY_TAINT_STATES = ["clean", "suspected", "tainted"] as const;
export type MemoryTaint = (typeof MEMORY_TAINT_STATES)[number];

export const MEMORY_RETENTIONS = ["session", "30d", "1y", "permanent"] as const;
export type MemoryRetention = (typeof MEMORY_RETENTIONS)[number];

export interface MemorySourceRef {
  type: "user" | "task" | "source" | "method" | "system";
  id: string | null;
  label: string;
  excerpt: string | null;
}

export interface MemoryMeta {
  tier: MemoryTier;
  originClass: MemoryOriginClass;
  sourceKind: string;
  sourceRef: string;
  sessionId: string | null;
  trust: MemoryTrust;
  taint: MemoryTaint;
  sensitivity: MemorySensitivity;
  confidence: MemoryConfidence;
  importance: number;
  retention: MemoryRetention;
  supersessionKey: string | null;
  contentHash: string;
  createdAt: string;
  lastVerifiedAt: string | null;
  expiresAt: string | null;
}

export interface MemoryRecord extends MemoryMeta {
  id: string;
  kind: MemoryKind;
  status: MemoryStatus;
  content: string;
  subjectKey: string;
  scope: string;
  tags: string[];
  source: MemorySourceRef;
  allowRecall: boolean;
  version: number;
  supersedesId: string | null;
  derivedFromId: string | null;
  validUntil: string | null;
  updatedAt: string;
  lastRecalledAt: string | null;
  recallCount: number;
}

export interface MemoryVersion extends MemoryMeta {
  id: string;
  memoryId: string;
  version: number;
  content: string;
  status: MemoryStatus;
  source: MemorySourceRef;
  allowRecall: boolean;
  scope: string;
  tags: string[];
  reason: string;
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
  lane: MemoryRecallLane;
  reason: string;
  score: number;
  createdAt: string;
}

export const MEMORY_RECALL_LANES = ["always_on", "on_demand"] as const;
export type MemoryRecallLane = (typeof MEMORY_RECALL_LANES)[number];

export interface MemorySettings {
  autoCapture: "off" | "experience";
  maxItems: number;
  maxChars: number;
  allowSensitive: boolean;
  updatedAt: string;
}

export type OnboardingStatus = "completed" | "skipped";

export interface OnboardingState {
  status: OnboardingStatus;
  completedAt: string;
}

export interface OnboardingChecks {
  chatModelConfigured: boolean;
  readyExecutorIds: ExecutorId[];
  memoryAutoCapture: MemorySettings["autoCapture"];
  proactiveEnabled: boolean;
}

export interface OnboardingSnapshot {
  required: boolean;
  state: OnboardingState | null;
  checks: OnboardingChecks;
}

export const MEMORY_FORGET_TARGETS = ["projection", "versions", "event-log", "recall-audit", "devices", "derivations", "consolidation"] as const;
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
  tombstones?: MemoryForgetTombstone[];
  createdAt: string;
}

export interface MemoryForgetTombstone {
  id: string;
  memoryId: string;
  contentHash: string;
  subjectKey: string;
  sourceKind: string;
  sourceRef: string;
  reason: string;
  createdAt: string;
}

export const MEMORY_CONSOLIDATION_STATUSES = ["planned", "applied", "failed"] as const;
export type MemoryConsolidationStatus = (typeof MEMORY_CONSOLIDATION_STATUSES)[number];

export interface MemoryConsolidationSource {
  memoryId: string;
  version: number;
  contentHash: string;
  status: MemoryStatus;
  content: string;
  sourceLabel: string;
  updatedAt: string;
}

export interface MemoryConsolidationGroup {
  id: string;
  kind: MemoryKind;
  supersessionKey: string;
  subjectKey: string;
  scope: string;
  sourceMemoryIds: string[];
  proposedContent: string;
  score: number;
  reasons: string[];
  conflicts: string[];
}

export interface MemoryConsolidationRun {
  id: string;
  status: MemoryConsolidationStatus;
  dryRun: boolean;
  scope: string | null;
  startedAt: string;
  completedAt: string | null;
  groups: MemoryConsolidationGroup[];
  sources: MemoryConsolidationSource[];
  appliedMemoryIds: string[];
  skipped: Array<{ memoryId: string; reason: string }>;
  error: string | null;
  report: string;
}

export const METHOD_STATUSES = ["candidate", "evaluating", "trial", "adopted", "rejected", "reverted", "superseded"] as const;
export type MethodStatus = (typeof METHOD_STATUSES)[number];

export const METHOD_VERDICTS = ["insufficient", "improved", "flat", "regressed"] as const;
export type MethodVerdict = (typeof METHOD_VERDICTS)[number];

export const METHOD_SELECTIONS = ["pinned", "auto_template"] as const;
export type MethodSelection = (typeof METHOD_SELECTIONS)[number];

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
  generation?: number | null;
  fingerprint?: string | null;
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

export interface MethodApplication {
  id: string;
  taskId: string;
  runId: string;
  methodId: string;
  methodVersion: number;
  selection: MethodSelection;
  promptSha256: string;
  createdAt: string;
}

export interface MethodSettings {
  autoLearn: boolean;
  updatedAt: string | null;
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

export const SKILL_STATUSES = [
  "candidate",
  "trial",
  "evaluating",
  "adopted",
  "stale",
  "archived",
  "rejected",
  "reverted",
  "superseded"
] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

export const SKILL_PLATFORMS = ["windows", "macos", "linux"] as const;
export type SkillPlatform = (typeof SKILL_PLATFORMS)[number];

export const SKILL_ORIGINS = ["agent", "user", "imported", "system"] as const;
export type SkillOrigin = (typeof SKILL_ORIGINS)[number];

export interface SkillPermissions {
  readRoots: string[];
  writeRoots: string[];
  networkHosts: string[];
}

export interface SkillHearthMetadata {
  category: string;
  originTaskId: string | null;
  originHash: string | null;
  adoptedAt: string | null;
  origin: SkillOrigin;
  pinned: boolean;
}

export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  platforms: SkillPlatform[];
  tools: string[];
  permissions: SkillPermissions;
  metadata: {
    hearth: SkillHearthMetadata;
  };
}

export interface SkillDocument {
  manifest: SkillManifest;
  body: string;
  contentHash: string;
}

export interface SkillIndexEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  platforms: SkillPlatform[];
  tags: string[];
  category: string;
  status: SkillStatus;
  pinned: boolean;
  origin: SkillOrigin;
}

export interface SkillResourceRef {
  path: string;
  kind: "reference" | "script" | "template" | "test" | "other";
  bytes: number | null;
}

export interface SkillPackageRecord {
  schemaVersion: 1;
  id: string;
  methodId: string | null;
  methodVersion: number | null;
  version: string;
  sourceTaskIds: string[];
  exportedAt: string;
  contentHash: string;
  manifest: SkillManifest;
}

export interface SkillPackageExport extends SkillPackageRecord {
  path: string;
}

export interface SkillRecord {
  id: string;
  methodId: string | null;
  methodVersion: number | null;
  name: string;
  version: string;
  status: SkillStatus;
  pinned: boolean;
  path: string;
  contentHash: string;
  manifest: SkillManifest;
  origin: SkillOrigin;
  sourceTaskIds: string[];
  trialTaskIds: string[];
  previousVersionId: string | null;
  changeReport: string;
  createdAt: string;
  updatedAt: string;
  adoptedAt: string | null;
  lastUsedAt: string | null;
  archivedAt: string | null;
  archiveReason: string | null;
  previousStatus: SkillStatus | null;
}

export interface SkillVersion {
  id: string;
  skillId: string;
  version: string;
  manifest: SkillManifest;
  contentHash: string;
  path: string;
  methodId: string | null;
  methodVersion: number | null;
  changeReport: string;
  createdAt: string;
}

export const STANDING_INTENT_STATES = ["pending", "armed", "fired", "done", "cancelled", "expired"] as const;
export type StandingIntentState = (typeof STANDING_INTENT_STATES)[number];

export const STANDING_INTENT_ACTIONS = ["remind", "ask", "prepare_task", "notify"] as const;
export type StandingIntentAction = (typeof STANDING_INTENT_ACTIONS)[number];

export interface StandingIntentTriggerEntry {
  terms: string[];
  mode: "all" | "any";
}

export interface StandingIntentScope {
  channel: string | null;
  sender: string | null;
  taskId: string | null;
  goalId: string | null;
  anywhere: boolean;
}

export interface StandingIntentRecord {
  id: string;
  ownerId: string;
  description: string;
  triggerEntries: StandingIntentTriggerEntry[];
  scope: StandingIntentScope;
  action: StandingIntentAction;
  cooldownSeconds: number;
  maxFires: number;
  fireCount: number;
  state: StandingIntentState;
  expiresAt: string;
  lastFiredAt: string | null;
  lastMatchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const ATTENTION_ITEM_KINDS = [
  "decision",
  "approval",
  "credential",
  "reconcile",
  "conflict",
  "commitment",
  "deadline",
  "blocked",
  "opportunity",
  "progress",
  "suggestion"
] as const;
export type AttentionItemKind = (typeof ATTENTION_ITEM_KINDS)[number];

export const ATTENTION_ITEM_STATUSES = ["open", "acknowledged", "ignored", "snoozed", "resolved"] as const;
export type AttentionItemStatus = (typeof ATTENTION_ITEM_STATUSES)[number];

export interface AttentionBudgetSettings {
  dailyLimit: number;
  quietStart: string;
  quietEnd: string;
  cooldownSeconds: number;
  maxPerGoalPerDay: number;
  maxHighPriorityPerDay: number;
  ignoredPenalty: number;
}

export interface AttentionItem {
  id: string;
  dedupeKey: string;
  kind: AttentionItemKind;
  priority: number;
  critical: boolean;
  title: string;
  waitingOn: "user" | "external" | "agent";
  waitingSince: string;
  nextAction: string;
  consequence: string;
  whyNow: string;
  goalId: string | null;
  taskId: string | null;
  intentId: string | null;
  source: string;
  status: AttentionItemStatus;
  snoozeUntil: string | null;
  entityId?: string | null;
  evidenceRefs?: string[];
  options?: AttentionOption[];
  impact?: number;
  urgency?: number;
  confidence?: number;
  reversibility?: "easy" | "hard" | "irreversible";
  blastRadius?: "self" | "team" | "public";
  score?: number;
  aggregationKey?: string | null;
  shadowed?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AttentionOption {
  id: string;
  label: string;
  action: string;
  consequence?: string;
}

export interface AttentionCandidate {
  id: string;
  kind: AttentionItemKind;
  subjectRef: string;
  title: string;
  whyNow: string;
  consequence: string;
  nextAction: string;
  options: AttentionOption[];
  impact: 1 | 2 | 3 | 4 | 5;
  urgency: 1 | 2 | 3 | 4 | 5;
  confidence: number;
  reversibility: "easy" | "hard" | "irreversible";
  blastRadius: "self" | "team" | "public";
  critical: boolean;
  evidenceRefs: string[];
  dedupeKey: string;
  expiresAt?: string;
}

export interface HeartbeatRun {
  id: string;
  decision: "notify" | "NO_REPLY";
  triggerKinds: string[];
  attentionIds: string[];
  reason: string;
  startedAt: string;
  endedAt: string;
}

export interface StandingIntentSnapshot {
  intents: StandingIntentRecord[];
  attention: AttentionItem[];
  budget: AttentionBudgetSettings;
  lastHeartbeat: HeartbeatRun | null;
}

export const SKILL_USAGE_STATUSES = ["started", "completed", "failed", "cancelled"] as const;
export type SkillUsageStatus = (typeof SKILL_USAGE_STATUSES)[number];

export const SKILL_USAGE_SOURCES = ["manual", "api", "scheduler", "agent", "trial"] as const;
export type SkillUsageSource = (typeof SKILL_USAGE_SOURCES)[number];

export interface SkillUsageEvent {
  id: string;
  skillId: string;
  taskId: string | null;
  runId: string | null;
  status: SkillUsageStatus;
  source: SkillUsageSource;
  note: string;
  createdAt: string;
}

export const SKILL_CURATOR_RUN_STATUSES = ["planned", "applied", "failed", "rolled_back"] as const;
export type SkillCuratorRunStatus = (typeof SKILL_CURATOR_RUN_STATUSES)[number];

export interface SkillCuratorAction {
  skillId: string;
  name: string;
  from: SkillStatus;
  to: SkillStatus;
  reason: string;
}

export interface SkillCuratorRun {
  id: string;
  status: SkillCuratorRunStatus;
  dryRun: boolean;
  startedAt: string;
  endedAt: string | null;
  actions: SkillCuratorAction[];
  backupPath: string | null;
  report: string;
  rolledBackAt: string | null;
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

export const CONNECTION_TRANSPORT_STATES = ["connected", "connecting", "disconnected", "failed"] as const;
export type ConnectionTransportState = (typeof CONNECTION_TRANSPORT_STATES)[number];

export const CONNECTION_SUBSCRIPTION_STATES = ["live", "catching_up", "stale", "failed"] as const;
export type ConnectionSubscriptionState = (typeof CONNECTION_SUBSCRIPTION_STATES)[number];

export const CONNECTION_DATA_FRESHNESS = ["current", "cached", "expired"] as const;
export type ConnectionDataFreshness = (typeof CONNECTION_DATA_FRESHNESS)[number];

export const CONNECTION_EXECUTION_OWNERSHIP = ["owned", "leased", "unknown"] as const;
export type ConnectionExecutionOwnership = (typeof CONNECTION_EXECUTION_OWNERSHIP)[number];

export const CONNECTION_SESSION_STATUSES = ["connected", "disconnected"] as const;
export type ConnectionSessionStatus = (typeof CONNECTION_SESSION_STATUSES)[number];

export interface ConnectionSession {
  id: string;
  deviceId: string;
  userId: string;
  generation: number;
  cursor: number | null;
  scopes: string[];
  pendingScopes: string[];
  status: ConnectionSessionStatus;
  lastError: string | null;
  connectedAt: string;
  expiresAt: string;
  lastHeartbeatAt: string;
  cursorAt: string;
  disconnectedAt: string | null;
  disconnectReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionRuntimeStatus {
  connectionId: string;
  deviceId: string;
  generation: number;
  transport: ConnectionTransportState;
  subscription: ConnectionSubscriptionState;
  dataFreshness: ConnectionDataFreshness;
  executionOwnership: ConnectionExecutionOwnership;
  sourceCursor: number;
  latestCursor: number;
  asOf: string;
  cacheExpiresAt: string;
  pendingScopes: string[];
  scopeApprovalRequired: boolean;
  lastError: string | null;
  session: ConnectionSession;
}

export const CONNECTION_OUTBOX_STATUSES = ["queued", "submitted", "committed", "uncertain", "rejected", "conflict"] as const;
export type ConnectionOutboxStatus = (typeof CONNECTION_OUTBOX_STATUSES)[number];

export interface ConnectionOutboxItem {
  id: string;
  connectionId: string;
  generation: number;
  deviceId: string;
  userId: string;
  scope: string;
  kind: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: ConnectionOutboxStatus;
  error: string | null;
  effectId: string | null;
  result: Record<string, unknown> | null;
  submittedAt: string | null;
  committedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OfflineProjection<T = unknown> {
  connectionId: string;
  generation: number;
  scope: string;
  data: T;
  dataFreshness: ConnectionDataFreshness;
  cached: boolean;
  asOf: string;
  sourceCursor: number;
  latestCursor: number;
}

export interface ConnectionReplayPlan {
  connectionId: string;
  generation: number;
  ready: boolean;
  reason: string | null;
  sourceCursor: number;
  latestCursor: number;
  pulledEvents: number;
  staleItems: number;
  items: ConnectionOutboxItem[];
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
  hermes: HermesHealth;
}

export const CONTEXT_ITEM_KINDS = [
  "user_message",
  "task_input",
  "assistant_message",
  "tool_call",
  "tool_result",
  "artifact",
  "checkpoint",
  "failure",
  "diagnosis",
  "handoff",
  "decision",
  "summary",
  "memory_recall",
  "method",
  "usage",
  "notice"
] as const;
export type ContextItemKind = (typeof CONTEXT_ITEM_KINDS)[number];

export const CONTEXT_ITEM_ROLES = ["system", "user", "assistant", "tool"] as const;
export type ContextItemRole = (typeof CONTEXT_ITEM_ROLES)[number];

export const CONTEXT_SENSITIVITIES = ["normal", "sensitive", "secret"] as const;
export type ContextSensitivity = (typeof CONTEXT_SENSITIVITIES)[number];

export interface ContextItem {
  seq: number;
  id: string;
  conversationId: string | null;
  taskId: string;
  runId: string | null;
  executorId: ExecutorId | null;
  kind: ContextItemKind;
  role: ContextItemRole;
  content: string;
  contentRef: string | null;
  sha256: string | null;
  tokens: number;
  sensitivity: ContextSensitivity;
  provenance: Record<string, unknown>;
  parentId: string | null;
  executorEventId: string | null;
  createdAt: string;
}

export interface ContextStep {
  text: string;
  contextItemId: string | null;
}

export interface ContextArtifactRef {
  artifactId: string;
  path: string;
  sha256: string;
  bytes: number;
  mimeType: string;
}

export interface TaskContextState {
  taskId: string;
  summary: string;
  plan: string[];
  completed: ContextStep[];
  failed: ContextStep[];
  artifacts: ContextArtifactRef[];
  openQuestions: string[];
  lastFailure: TaskError | null;
  handoffCount: number;
  summarySeq: number;
  updatedAt: string;
}

export const FAILURE_CAUSES = [
  "runtime_fault",
  "transient",
  "capability_gap",
  "contract_failure",
  "permission",
  "input_missing",
  "budget",
  "effect_uncertain",
  "interrupted",
  "unknown"
] as const;
export type FailureCause = (typeof FAILURE_CAUSES)[number];

export const FAILURE_ACTIONS = ["retry_same", "handoff", "ask_user", "fail"] as const;
export type FailureAction = (typeof FAILURE_ACTIONS)[number];

export const FAILURE_CLASSES = [
  "user_cancelled",
  "policy_denied",
  "validation_failed",
  "effect_unknown",
  "timeout",
  "capacity",
  "rate_limit",
  "transport",
  "auth",
  "budget_exhausted",
  "internal"
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export type FailureDisposition =
  | { type: "retry"; afterMs: number; attempt: number }
  | { type: "wait"; until: string; reason: string }
  | { type: "repair"; target: string; reason: string }
  | { type: "reconcile"; effectId: string }
  | { type: "ask_user"; question: string; options: string[] }
  | { type: "handoff"; note: string }
  | { type: "stop"; reason: string };

export interface FailureDiagnosis {
  id: string;
  taskId: string;
  runId: string;
  cause: FailureCause;
  confidence: number;
  summary: string;
  evidenceItemIds: string[];
  recommendedAction: FailureAction;
  targetExecutor: ExecutorId | null;
  doNotRepeat: string[];
  source: "rules" | "model";
  createdAt: string;
}

export interface HandoffArtifactRef {
  path: string;
  sha256: string;
  bytes: number;
  mimeType: string;
}

export interface HandoffPacket {
  handoffId: string;
  taskId: string;
  fromRunId: string;
  fromExecutor: ExecutorId;
  toExecutor: ExecutorId;
  generation: number;
  sourceCursor: number;
  createdAt: string;
  goal: string;
  acceptance: string[];
  permissions: TaskPermissions;
  remainingBudget: RunBudget;
  summary: string;
  completed: ContextStep[];
  failed: ContextStep[];
  artifacts: HandoffArtifactRef[];
  doNotRepeat: string[];
  openQuestions: string[];
  nextAction: string;
  omittedHistory: string[];
  redaction: HandoffRedaction;
  verification: HandoffVerification;
}

export interface HandoffRedaction {
  policy: "host-redaction-v1";
  redactedFields: string[];
}

export interface HandoffVerification {
  action: string;
  expected: string[];
  status: "pending" | "passed" | "failed";
  checkedAt?: string | null;
  evidenceRefs?: string[];
}

export const HANDOFF_STATUSES = ["pending_user", "prepared", "running", "completed", "failed", "cancelled"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export interface HandoffRecord {
  id: string;
  taskId: string;
  fromRunId: string;
  toRunId: string | null;
  fromExecutor: ExecutorId;
  toExecutor: ExecutorId;
  generation: number;
  sourceCursor: number;
  status: HandoffStatus;
  reasonCode: FailureCause;
  diagnosis: FailureDiagnosis | null;
  packet: HandoffPacket | null;
  verification: HandoffVerification | null;
  artifactRef: string | null;
  contextWatermarkSeq: number;
  initiatedBy: "auto" | "user";
  createdAt: string;
  updatedAt: string;
}

export const DELEGATION_JOB_STATUSES = [
  "queued",
  "leased",
  "running",
  "awaiting_verification",
  "succeeded",
  "failed",
  "cancelled",
  "orphaned"
] as const;
export type DelegationJobStatus = (typeof DELEGATION_JOB_STATUSES)[number];

export const DELEGATION_WORKSPACE_POLICIES = ["read-only", "isolated-write", "shared-read"] as const;
export type DelegationWorkspacePolicy = (typeof DELEGATION_WORKSPACE_POLICIES)[number];

export interface DelegationBudget {
  tokens?: number;
  wallClockMs?: number;
  maxSteps?: number;
}

export interface DelegationFailure {
  code: string;
  message: string;
  retryable: boolean;
  occurredAt: string;
}

export interface DelegationResult {
  summary: string;
  evidenceRefs: string[];
  artifacts: string[];
  unresolved: string[];
  status: "completed" | "failed";
  producedAt: string;
}

export interface DelegationVerification {
  parentTaskId: string;
  verdict: "accepted" | "rejected";
  summary: string;
  evidenceRefs: string[];
  checkedAt: string;
}

export interface DelegationJob {
  id: string;
  parentTaskId: string;
  parentRunId: string | null;
  childTaskId: string | null;
  childRunId: string | null;
  goalSlice: string;
  targetExecutor: ExecutorId;
  contextPackRef: string;
  contextPack: Record<string, unknown>;
  workspacePolicy: DelegationWorkspacePolicy;
  permissions: TaskPermissions;
  toolPolicy: string[];
  networkPolicy: string[];
  budget: DelegationBudget;
  deadline: string | null;
  resultSchemaRef: string | null;
  status: DelegationJobStatus;
  depth: number;
  idempotencyKey: string;
  lease: { owner: string; expiresAt: string } | null;
  attempt: number;
  result: DelegationResult | null;
  verification: DelegationVerification | null;
  failure: DelegationFailure | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export const CHANNEL_DIRECTIONS = ["inbound", "outbound"] as const;
export type ChannelDirection = (typeof CHANNEL_DIRECTIONS)[number];

export const CHANNEL_DELIVERY_STATUSES = [
  "received",
  "processing",
  "processed",
  "duplicate",
  "retrying",
  "failed",
  "uncertain"
] as const;
export type ChannelDeliveryStatus = (typeof CHANNEL_DELIVERY_STATUSES)[number];

export interface ChannelDeliveryRecord {
  id: string;
  channel: string;
  externalId: string;
  threadKey: string;
  direction: ChannelDirection;
  idempotencyKey: string;
  generation: number;
  status: ChannelDeliveryStatus;
  payload: Record<string, unknown>;
  attemptCount: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  processedAt: string | null;
  effectId: string | null;
  receipt: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelCursor {
  channel: string;
  threadKey: string;
  generation: number;
  cursor: number;
  updatedAt: string;
}

export const CONTEXT_MODES = ["off", "shadow", "on"] as const;
export type ContextMode = (typeof CONTEXT_MODES)[number];

export interface ContextSettings {
  mode: ContextMode;
  maxHandoffs: number;
  maxSameExecutorRetries: number;
  retentionDays: number;
  maxInlineBytes: number;
  projectionTokenBudget: number;
  summarizeAfterTokens: number;
  autoHandoffRisk: "low" | "none";
  allowCodexNetwork: boolean;
  updatedAt: string | null;
}

export interface ContextSettingsPatch {
  mode?: ContextMode | undefined;
  maxHandoffs?: number | undefined;
  maxSameExecutorRetries?: number | undefined;
  retentionDays?: number | undefined;
  maxInlineBytes?: number | undefined;
  projectionTokenBudget?: number | undefined;
  summarizeAfterTokens?: number | undefined;
  autoHandoffRisk?: "low" | "none" | undefined;
  allowCodexNetwork?: boolean | undefined;
}

export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  mode: "on",
  maxHandoffs: 2,
  maxSameExecutorRetries: 1,
  retentionDays: 30,
  maxInlineBytes: 16_384,
  projectionTokenBudget: 12_000,
  summarizeAfterTokens: 8_000,
  autoHandoffRisk: "low",
  allowCodexNetwork: false,
  updatedAt: null
};

export interface ContextItemPage {
  items: ContextItem[];
  total: number;
  nextBefore: number | null;
}

export interface ContextSnapshot {
  settings: ContextSettings;
  state: TaskContextState | null;
  handoffs: HandoffRecord[];
  items: ContextItemPage;
}

export interface ContextDeleteReceipt {
  taskId: string;
  deletedItems: number;
  deletedBlobs: number;
  deletedHandoffs: number;
  createdAt: string;
}
