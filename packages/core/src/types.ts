import type { ExecutionMode } from "./execution-mode.ts";

export const TASK_STATUSES = [
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "waiting_budget",
  "paused",
  "completed",
  "failed",
  "recoverable",
  "cancelled"
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const EXECUTOR_IDS = ["native", "codex", "deepseek-harness"] as const;
export type ExecutorId = (typeof EXECUTOR_IDS)[number];

export const FIRST_CLASS_EXECUTOR_IDS = ["deepseek-harness", "codex", "native"] as const;
export type FirstClassExecutorId = (typeof FIRST_CLASS_EXECUTOR_IDS)[number];

export const APPROVAL_MODES = ["necessary", "workspace", "full"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export type CollaborationMode = "build" | "plan";

export interface ConversationSettings {
  executionMode?: ExecutionMode;
  executorEnabled: Record<ExecutorId, boolean>;
  approvalMode: ApprovalMode;
  preferredExecutorId: ExecutorId | null;
  collaborationMode?: CollaborationMode;
}

export interface ConversationSettingsPatch {
  executionMode?: ExecutionMode | undefined;
  executorEnabled?: Partial<Record<ExecutorId, boolean | undefined>> | undefined;
  approvalMode?: ApprovalMode | undefined;
  preferredExecutorId?: ExecutorId | null | undefined;
  collaborationMode?: CollaborationMode | undefined;
}

export function defaultConversationSettings(
  approvalMode: ApprovalMode = "full",
  enabled: Partial<Record<ExecutorId, boolean | undefined>> = { native: true, codex: true }
): ConversationSettings {
  const executorEnabled = {} as Record<ExecutorId, boolean>;
  for (const id of EXECUTOR_IDS) executorEnabled[id] = enabled[id] ?? false;
  return { executorEnabled, approvalMode, preferredExecutorId: "native", executionMode: "standard", collaborationMode: "build" };
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
    executionMode: patch?.executionMode ?? base.executionMode ?? "standard",
    // Hearth always runs with full permissions: no approval gate can be
    // reintroduced through a conversation patch or an old saved setting.
    approvalMode: "full",
    preferredExecutorId: patch?.preferredExecutorId !== undefined
      ? patch.preferredExecutorId
      : base.preferredExecutorId ?? "native",
    collaborationMode: patch?.collaborationMode ?? base.collaborationMode ?? "build"
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

export interface ExecutorView {
  id: ExecutorId;
  name: string;
  description: string;
  capabilities: string[];
  provider?: string | undefined;
  experimental?: boolean | undefined;
  supportsResume?: boolean | undefined;
  runtime: ExecutorRuntimeSettings;
  health: ExecutorHealth;
  modelBinding?: ExecutorModelBindingView | undefined;
  effectiveModel: ModelSettingsView | null;
}

export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "max";

/** What a model/provider actually accepts for reasoning control, exposed so the UI can show valid options. */
export interface ReasoningCapability {
  /** Provider family detected from model name / endpoint. */
  family: "glm" | "deepseek" | "openai-compatible" | "openai" | "anthropic" | "gemini" | "unknown";
  /** UI effort levels the model can actually use, in display order. */
  levels: ReasoningEffort[];
  /** Recommended default level for this model. */
  defaultLevel: ReasoningEffort;
  /** Whether thinking can be switched off (otherwise off is degraded to the lightest level). */
  canDisable: boolean;
  /** Whether reasoning_effort values are sent at all (false = toggle-only models). */
  supportsEffort: boolean;
  /** Native value sent for each UI level; omitted when it equals the UI value. */
  nativeValues?: Partial<Record<ReasoningEffort, string>>;
  /** Human-readable explanation of the mapping, shown in the model picker. */
  note: string;
  /** How the capability was identified. */
  source: "catalog" | "endpoint" | "fallback";
}

export interface ReasoningCapabilityView extends ReasoningCapability {
  model: string;
  baseUrl: string;
  protocol: ModelProtocol;
}

export interface ExecutorSettings {
  defaultApprovalMode: ApprovalMode;
  preferredExecutorId: ExecutorId | null;
  followUpMode: TaskFollowUpMode;
  reasoningEffort?: ReasoningEffort;
  executors: Partial<Record<ExecutorId, ExecutorRuntimeSettings>>;
}

export interface ExecutorSettingsPatch {
  defaultApprovalMode?: ApprovalMode | undefined;
  preferredExecutorId?: ExecutorId | null | undefined;
  followUpMode?: TaskFollowUpMode | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  executors?: Partial<Record<ExecutorId, ExecutorRuntimeSettings>> | undefined;
}

export interface ExecutorSettingsView extends ExecutorSettings {
  updatedAt: string | null;
}

export const TASK_KINDS = ["delivery", "workspace", "general"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export interface LocalProject {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocalProjectView extends LocalProject {
  kind: "git" | "folder";
  available: boolean;
  currentBranch: string | null;
  dirty: boolean;
  error: string | null;
}

export interface TaskWorktree {
  taskId: string;
  projectId: string;
  path: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskWorktreeView extends TaskWorktree {
  available: boolean;
  dirty: boolean;
  error: string | null;
}

export const MCP_SERVER_STATUSES = ["unchecked", "ready", "error"] as const;
export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number];

export const MCP_TRANSPORTS = ["stdio", "streamable-http"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  url: string | null;
  envKeys: string[];
  headerKeys: string[];
  authMode: "none" | "headers";
  registryServerId: string | null;
  registryName: string | null;
  packageName: string | null;
  packageVersion: string | null;
  runtime: string | null;
  manifest: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerView extends McpServerConfig {
  status: McpServerStatus;
  tools: McpToolDescriptor[];
  error: string | null;
  lastProbeAt: string | null;
}

export interface McpRegistryVariable {
  name: string;
  description: string;
  required: boolean;
  secret: boolean;
  placeholder: string | null;
  defaultValue: string | null;
}

export interface McpRegistryCandidate {
  serverName: string;
  title: string;
  description: string;
  version: string;
  transport: McpTransport;
  runtime: string;
  packageName: string | null;
  packageVersion: string | null;
  command: string;
  args: string[];
  url: string | null;
  requiredEnv: string[];
  requiredHeaders: string[];
  envVariables: McpRegistryVariable[];
  headerVariables: McpRegistryVariable[];
  homepage: string | null;
  repositoryUrl: string | null;
  installable: boolean;
  unsupportedReason: string | null;
}

export interface McpRegistrySearchView {
  query: string;
  candidates: McpRegistryCandidate[];
  total: number;
  registryUrl: string;
  fetchedAt: string;
}

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
  kind: "file" | "url" | "github" | "text" | "source" | "workspace";
  label: string;
  value: string;
  sha256?: string;
  source?: TaskSourceRef;
}

export interface TaskErrorDetail {
  code: string;
  message: string;
  severity?: "blocking" | "advisory";
}

export interface TaskError {
  kind: string;
  message: string;
  recoverable: boolean;
  guidance: string;
  code?: string;
  retryAfterMs?: number;
  cause?: FailureCause;
  diagnosisId?: string;
  failureClass?: FailureClass;
  disposition?: FailureDisposition;
  budgetExhaustion?: BudgetExhaustion;
  /** Every concrete reason behind the failure, so the UI can explain what stopped the run. */
  details?: TaskErrorDetail[];
}

export type TaskNetworkMode = "deny" | "open";

export interface TaskPermissions {
  readRoots: string[];
  writeRoots: string[];
  networkHosts: string[];
  /** Hard switch the sandbox honours. `open` never implies a working allowlist. */
  networkMode?: TaskNetworkMode | undefined;
  tools: string[];
  fullAccess?: boolean | undefined;
  approvalMode?: ApprovalMode | undefined;
  sandboxMode?: SandboxMode | undefined;
}

export interface RunBudget {
  maxTurns?: number | undefined;
  maxToolCalls?: number | undefined;
  maxTokens?: number | undefined;
  maxDurationMs?: number | undefined;
}

export type BudgetDimension = "turns" | "toolCalls" | "tokens" | "duration";

export interface BudgetExhaustion {
  dimension: BudgetDimension;
  used: number;
  limit: number;
}

export interface TaskRecord {
  executionMode?: ExecutionMode;
  id: string;
  goalId?: string | null;
  planId?: string | null;
  mode?: CollaborationMode;
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
  projectId?: string | null;
  mcpServerIds?: string[];
  pinnedAt?: string | null;
  archivedAt?: string | null;
  budgetOverride?: RunBudget | null;
  deletedAt?: string | null;
  trashBatchId?: string | null;
}

export const GOAL_STATES = ["draft", "active", "paused", "blocked", "awaiting_user", "validating", "done", "failed", "cancelled"] as const;
export type GoalState = (typeof GOAL_STATES)[number];

export const GOAL_STOP_REASONS = [
  "host_restart",
  "needs_input",
  "approval",
  "verifier",
  "round_limit",
  "deadline",
  "budget",
  "task_failed",
  "no_progress",
  "user_stop"
] as const;
export type GoalStopReason = (typeof GOAL_STOP_REASONS)[number];

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

export interface GoalExecutionProfile {
  executorId: ExecutorId;
  taskKind: TaskKind;
  expectedOutputs: string[];
  projectId?: string | null;
  workspacePath?: string | null;
  networkHosts: string[];
  executionMode?: "quick" | "standard" | "deep";
}

export interface GoalContractSnapshot {
  title: string;
  objective: string;
  constraints: string[];
  forbiddenActions: string[];
  successCriteria: GoalCriterion[];
  evidenceRequirements: string[];
  budget: GoalBudget;
  deadline?: string;
  stopConditions: string[];
  reviewPolicy: GoalReviewPolicy;
}

/** User-authored contract changes are append-only and retain the complete before/after shape. */
export interface GoalContractAmendment {
  revision: number;
  at: string;
  source: "user";
  note: string;
  previous: GoalContractSnapshot;
  next: GoalContractSnapshot;
  commandsApprovalCleared: boolean;
}

export interface GoalContract {
  goalId: string;
  title: string;
  objective: string;
  /** The objective from goal creation. Contract amendments never overwrite it. */
  originalObjective?: string;
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
  /** Execution profile frozen at creation so every round runs the same way. */
  projectId?: string | null;
  conversationId?: string | null;
  /** Anchor task; all rounds are runs of this task. */
  taskId?: string | null;
  execution?: GoalExecutionProfile;
  /** Host-controlled auto-advance switch. Always false after a host restart. */
  armed?: boolean;
  roundCount?: number;
  maxRounds?: number;
  noProgressCount?: number;
  lastProgressDigest?: string | null;
  nextWakeAt?: string | null;
  stopReason?: GoalStopReason | null;
  /** Optimistic concurrency counter; every goal write increments it. */
  revision?: number;
  /** Contract-only version. Every explicit user amendment increments it. */
  contractRevision?: number;
  /** Execution-profile version. Every executor switch increments it. */
  executionRevision?: number;
  /** Append-only history of explicit user contract changes. */
  amendments?: GoalContractAmendment[];
  pauseReference?: { taskId: string; runId: string; checkpointSeq: number; checkpointKind: string } | null;
  /** Command criteria are frozen at creation and only run after explicit approval. */
  commandsApprovedAt?: string | null;
}

/** User-editable fields in a goal contract. Identity, history and runtime fields are immutable here. */
export interface GoalContractPatch {
  title?: string;
  objective?: string;
  constraints?: string[];
  forbiddenActions?: string[];
  successCriteria?: GoalCriterion[];
  evidenceRequirements?: string[];
  budget?: GoalBudget;
  deadline?: string | null;
  stopConditions?: string[];
  reviewPolicy?: GoalReviewPolicy;
}

export const PLAN_STAGES = ["planning", "awaiting_approval", "executing", "completed", "failed", "cancelled"] as const;
export type PlanStage = (typeof PLAN_STAGES)[number];

export const PLAN_ACTIONS = ["approve", "replan", "cancel", "retry"] as const;
export type PlanActionName = (typeof PLAN_ACTIONS)[number];

export interface PlanExecutionProfile {
  executorId: ExecutorId;
  taskKind: TaskKind;
  projectId?: string | null;
  workspacePath?: string | null;
  networkHosts: string[];
  expectedOutputs: string[];
  executionMode?: ExecutionMode;
}

export interface PlanRecord {
  id: string;
  conversationId: string;
  projectId: string | null;
  title: string;
  objective: string;
  stage: PlanStage;
  planningTaskId: string | null;
  executionTaskId: string | null;
  execution?: PlanExecutionProfile;
  planMarkdown: string | null;
  planPath: string | null;
  planSha256?: string | null;
  planningAttempt?: number;
  planningRunId?: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface PlanView extends PlanRecord {}

export const GOAL_ROUND_STATUSES = ["running", "gated", "paused", "completed", "failed", "interrupted"] as const;
export type GoalRoundStatus = (typeof GOAL_ROUND_STATUSES)[number];

export const GOAL_ROUND_INTENT_STATUSES = ["progress", "complete", "blocked", "needs_input"] as const;
export type GoalRoundIntentStatus = (typeof GOAL_ROUND_INTENT_STATUSES)[number];

/** Evidence may remain a legacy string or carry durable source metadata. */
export type GoalEvidenceRef = string | {
  ref: string;
  kind?: "artifact" | "command" | "file" | "note" | "review" | "run" | "test";
  sha256?: string;
  runId?: string;
  observedAt?: string;
};

export interface GoalRoundIntent {
  status: GoalRoundIntentStatus;
  note: string;
  evidence: GoalEvidenceRef[];
  createdAt: string;
}

export interface GoalRoundUsage {
  tokens: number;
  turns: number;
  toolCalls: number;
  durationMs: number;
}

export interface GoalRoundRecord {
  id: string;
  goalId: string;
  taskId: string;
  index: number;
  runIds: string[];
  status: GoalRoundStatus;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  intent: GoalRoundIntent | null;
  artifactRefs: string[];
  evidenceRefs: GoalEvidenceRef[];
  usage: GoalRoundUsage | null;
  progressDigest: string | null;
  verifier: GoalCompletionReport | null;
  workspaceRoot: string | null;
  outDir: string | null;
  /** Immutable execution identity captured when the round begins. */
  executionFence?: GoalRoundExecutionFence | null;
}

export interface GoalRoundExecutionFence {
  taskId: string;
  runId: string;
  executorId: ExecutorId;
  goalRevision: number;
  contractRevision: number;
  executionRevision: number;
}

export const GOAL_ELIGIBILITY_REASONS = [
  "ok",
  "disarmed",
  "state_not_active",
  "round_open",
  "task_open",
  "round_limit",
  "budget",
  "deadline",
  "gate",
  "executor_unavailable",
  "backoff",
  "verifying"
] as const;
export type GoalEligibilityReason = (typeof GOAL_ELIGIBILITY_REASONS)[number];

export interface GoalEligibility {
  eligible: boolean;
  reason: GoalEligibilityReason;
  detail: string;
  nextWakeAt?: string | null;
}

export const GOAL_ACTIONS = ["start", "pause", "resume", "stop", "replan", "complete", "approve", "switch_executor", "amend_contract"] as const;
export type GoalAction = (typeof GOAL_ACTIONS)[number];

export interface GoalView {
  goal: GoalContract;
  rounds: GoalRoundRecord[];
  latestReport: GoalCompletionReport | null;
  task?: TaskRecord | null;
  eligibility?: GoalEligibility | null;
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

export const TASK_FOLLOW_UP_ORIGINS = ["user", "goal", "plan"] as const;
export type TaskFollowUpOrigin = (typeof TASK_FOLLOW_UP_ORIGINS)[number];

export interface TaskFollowUpRecord {
  id: string;
  taskId: string;
  conversationId: string | null;
  content: string;
  mode: TaskFollowUpMode;
  status: TaskFollowUpStatus;
  /** Goal-authored continuation prompts stay out of the user chat transcript. */
  origin?: TaskFollowUpOrigin;
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
  projectId?: string | null;
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
  todos?: Array<{ id: string; content: string; status: string }>;
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
  errorCode?: string;
  retryable?: boolean;
  severity?: "blocking" | "advisory";
  sandbox?: {
    backend: string;
    mode: string;
    enforcement: string;
    networkEnforcement: string;
    networkMode?: TaskNetworkMode;
  };
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
  contextWindowTokens: number;
  maxOutputTokens: number;
  reasoningEffort?: ReasoningEffort;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  updatedAt: string | null;
}

/** User-selectable legacy provider. Auto is the zero-configuration default. */
export type WebSearchProvider = "auto" | "tavily" | "searxng";

/** The source that actually fulfilled a search request. */
export type WebSearchSource = "tavily" | "searxng" | "relay" | "bing-rss" | "duckduckgo" | "browser";

export interface WebSearchSettingsView {
  enabled: boolean;
  provider: WebSearchProvider;
  searxngUrl: string;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  updatedAt: string | null;
}

export interface WebSearchResult {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface WebSearchResponse {
  query: string;
  provider: WebSearchSource;
  attemptedProviders: WebSearchSource[];
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
  contextWindowTokens: number;
  maxOutputTokens: number;
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
  contextWindowTokens: number;
  maxOutputTokens: number;
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
  contextWindowTokens?: number | undefined;
  maxOutputTokens?: number | undefined;
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
  /** Event-log sequence of the durable checkpoint snapshot. */
  eventSeq?: number;
  createdAt: string;
  proof?: RunCheckpointProof;
}

export interface RunCheckpointProof {
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
  networkMode?: TaskNetworkMode;
  workspaceDigest?: string;
  journalSeq?: number;
  journalPath?: string;
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
  /** 技能描述的中文展示版本；由 Hearth 在安装/启动时翻译并缓存。 */
  descriptionZh?: string | null;
  /** 生成 descriptionZh 时对应的原始描述哈希，原文变化后自动失效。 */
  descriptionHash?: string | null;
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
  sourceUrl: string | null;
  sourceRef: string | null;
  readOnly: boolean;
  permissions: SkillPermissions;
  actions: SkillActionDefinition[];
  lastCheckedAt: string | null;
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
  tasks: { total: number; queued: number; running: number; paused: number; recoverable: number; waitingApproval: number };
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
  "library_recall",
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
  libraryRefs?: string[];
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
  conversationContextEnabled: boolean;
  conversationContextBudgetTokens: number;
  conversationKeepTokens: number;
  conversationSummaryMaxTokens: number;
  conversationAutoCompact: boolean;
  conversationCompactRatio: number;
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
  conversationContextEnabled?: boolean | undefined;
  conversationContextBudgetTokens?: number | undefined;
  conversationKeepTokens?: number | undefined;
  conversationSummaryMaxTokens?: number | undefined;
  conversationAutoCompact?: boolean | undefined;
  conversationCompactRatio?: number | undefined;
  autoHandoffRisk?: "low" | "none" | undefined;
  allowCodexNetwork?: boolean | undefined;
}

export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  mode: "on",
  maxHandoffs: 2,
  maxSameExecutorRetries: 5,
  retentionDays: 30,
  maxInlineBytes: 16_384,
  projectionTokenBudget: 12_000,
  summarizeAfterTokens: 8_000,
  conversationContextEnabled: true,
  // 0 means "derive from the active model window". The legacy 12K/8K/4K
  // values are intentionally no longer used: a 1M model must be allowed to
  // grow to 800K before compaction, while a 256K model compacts at 204.8K.
  conversationContextBudgetTokens: 0,
  conversationKeepTokens: 0,
  conversationSummaryMaxTokens: 0,
  conversationAutoCompact: true,
  conversationCompactRatio: 0.8,
  autoHandoffRisk: "low",
  allowCodexNetwork: false,
  updatedAt: null
};

export interface ConversationFact {
  key: string;
  value: string;
  source: string;
  asOf: string;
  superseded?: boolean;
}

export interface ConversationDecision {
  decision: string;
  rationale: string;
  source: string;
}

export interface ConversationCompletedTask {
  taskId: string;
  title: string;
  status: TaskStatus;
  executor: ExecutorId | null;
  outcome: string;
  artifacts: string[];
}

export interface ConversationContextSummary {
  goal: string;
  constraints: string[];
  facts: ConversationFact[];
  decisions: ConversationDecision[];
  completed: ConversationCompletedTask[];
  blockers: string[];
  nextSteps: string[];
  openQuestions: string[];
}

export type ContextUsageSource = "measured" | "estimated" | "pending";
export type ContextUsageScope = "chat" | "task" | "executor";

/**
 * The last real (provider-reported) or explicit estimate of the prompt sent to
 * the active model. Persisted per conversation so the UI does not fall back to
 * a partial visible-message count after a reload.
 */
export interface ContextUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  contextWindowTokens: number;
  model: string;
  reasoningEffort?: string;
  source: ContextUsageSource;
  scope: ContextUsageScope;
  breakdown: Record<string, number>;
  measuredAt: string;
}

export interface ConversationContextState {
  conversationId: string;
  version: number;
  summary: string;
  summaryData: ConversationContextSummary | null;
  firstKeptMessageId: string | null;
  lastSummarizedAt: string | null;
  tokensBefore: number;
  tokensAfter: number;
  lastUsage?: ContextUsageSnapshot | null;
  updatedAt: string;
}

export type ConversationCompactionTrigger = "auto" | "manual" | "overflow";
export type ConversationCompactionStatus = "running" | "completed" | "failed";

export interface ConversationCompactionRecord {
  id: string;
  conversationId: string;
  trigger: ConversationCompactionTrigger;
  status: ConversationCompactionStatus;
  summary: string | null;
  coveredMessageIds: string[];
  firstKeptMessageId: string | null;
  tokensBefore: number;
  tokensAfter: number | null;
  model: string | null;
  usage: RunUsage | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

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

// Library //////////////////////////////////////////////////////////////////

export const LIBRARY_NODE_KINDS = [
  "root",
  "memory",
  "task",
  "source",
  "artifact",
  "file",
  "folder",
  "skill",
  "mcp",
  "project"
] as const;
export type LibraryNodeKind = (typeof LIBRARY_NODE_KINDS)[number];

export const LIBRARY_NODE_STATUSES = ["ready", "indexing", "stale", "error", "trashed", "blocked"] as const;
export type LibraryNodeStatus = (typeof LIBRARY_NODE_STATUSES)[number];

export interface LibraryNode {
  id: string;
  ref: string;
  kind: LibraryNodeKind;
  refId: string;
  parentId: string | null;
  path: string;
  title: string;
  projectId: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  contentHash: string | null;
  status: LibraryNodeStatus;
  sensitivity: ContextSensitivity;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
}

export interface LibraryTreeNode extends LibraryNode {
  childCount: number;
  summary: string | null;
  children?: LibraryTreeNode[];
}

export interface LibrarySearchHit {
  node: LibraryNode;
  score: number;
  snippet: string;
  matchedBy: "like" | "fts" | "vector" | "hybrid";
}

export interface LibrarySearchResult {
  query: string;
  hits: LibrarySearchHit[];
  total: number;
  semanticUsed: boolean;
  tookMs: number;
}

export interface LibraryRoot {
  id: string;
  path: string;
  kind: "file" | "folder";
  projectId: string | null;
  recursive: boolean;
  includeGlobs: string[];
  excludeGlobs: string[];
  lastScanAt: string | null;
  status: "ready" | "scanning" | "error";
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryTrashEntry {
  id: string;
  nodeId: string;
  ref: string;
  kind: LibraryNodeKind;
  title: string;
  path: string;
  snapshot: Record<string, unknown> | null;
  deletedAt: string;
  expiresAt: string;
  restoredAt: string | null;
}

export interface LibrarySettings {
  semanticEnabled: boolean;
  modelId: string;
  modelVersion: string;
  dailySummaryTokens: number;
  summaryTokensUsedToday: number;
  maxFileBytes: number;
  maxChunksPerNode: number;
  includeGlobs: string[];
  excludeGlobs: string[];
  updatedAt: string | null;
}

export interface LibrarySettingsPatch {
  semanticEnabled?: boolean | undefined;
  modelId?: string | undefined;
  modelVersion?: string | undefined;
  dailySummaryTokens?: number | undefined;
  maxFileBytes?: number | undefined;
  maxChunksPerNode?: number | undefined;
  includeGlobs?: string[] | undefined;
  excludeGlobs?: string[] | undefined;
}

export interface LibraryStatus {
  nodeCount: number;
  itemCount: number;
  chunkCount: number;
  indexedCount: number;
  pendingJobs: number;
  semanticReady: boolean;
  semanticEnabled: boolean;
  modelId: string;
  modelState: "missing" | "downloading" | "ready" | "error";
  modelDownloadProgress: number | null;
  lastIndexAt: string | null;
  summaryTokensUsedToday: number;
}

export interface LibraryNodeInput {
  path: string;
  kind: "file" | "folder";
  projectId?: string | null;
  recursive?: boolean;
  includeGlobs?: string[];
  excludeGlobs?: string[];
}

// Skill ////////////////////////////////////////////////////////////////////

export interface SkillActionPermission {
  network: boolean;
  readRoots: string[];
  writeRoots: string[];
  env: string[];
  timeoutMs: number;
}

export interface SkillActionDefinition {
  name: string;
  description: string;
  runtime: "python" | "node" | "shell";
  command: string[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  permissions: SkillActionPermission;
}

export interface HearthSkillManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  entry: string | null;
  runtime: "python" | "node" | "shell" | null;
  actions: SkillActionDefinition[];
  dependencies: {
    python: string[];
    node: string[];
  };
}

export interface SkillInstallSource {
  kind: "github" | "local";
  url: string | null;
  path: string | null;
  ref: string | null;
}

export interface SkillView extends SkillRecord {
  readOnly: boolean;
  sourceUrl: string | null;
  sourceRef: string | null;
  actions: SkillActionDefinition[];
  /** 中文描述；旧数据或翻译失败时为 null，前端回退到 manifest.description。 */
  descriptionZh: string | null;
}

export interface SkillRunInput {
  skillId: string;
  action: string;
  input: Record<string, unknown>;
  taskId: string | null;
  runId: string | null;
}

export interface SkillRunResult {
  skillId: string;
  action: string;
  status: "completed" | "failed";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  structured: unknown | null;
  durationMs: number;
}

// Approval /////////////////////////////////////////////////////////////////

export const ACTION_CLASSES = [
  "local_read",
  "local_write",
  "local_delete",
  "local_exec",
  "browser_read",
  "desktop",
  "host_read",
  "external_read",
  "external_write",
  "skill_install",
  "skill_update",
  "unknown"
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export interface ActionClassification {
  actionClass: ActionClass;
  service: string;
  action: string;
  summary: string;
  requiresApproval: boolean;
}

export interface ApprovalGrant {
  id: string;
  service: string;
  action: string;
  scope: Record<string, unknown>;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
