import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply } from "fastify";
import type { EventEnvelope, ExecutorHealth, ExecutorId, ExecutorView, GoalBudget } from "@hearth/core";
import { APPROVAL_STATUSES, AUTONOMY_LEVELS, DELEGATION_WORKSPACE_POLICIES, DEVICE_CAPABILITY_KINDS, EFFECT_STATUSES, EXECUTOR_IDS, GOAL_REVIEW_POLICIES, GOAL_STATES, GOAL_VALIDATORS, MEMORY_CONFIDENCES, MEMORY_KINDS, MEMORY_ORIGINS, MEMORY_RETENTIONS, MEMORY_SENSITIVITIES, MEMORY_TAINT_STATES, MEMORY_TIERS, MEMORY_TRUST_LEVELS, PROACTIVE_MODES, RECONCILE_STATUSES, RUN_STATUSES, SKILL_STATUSES, SKILL_USAGE_SOURCES, SKILL_USAGE_STATUSES, SOURCE_KINDS, TRIGGER_KINDS } from "@hearth/core";
import { HearthStore, type PageOptions } from "@hearth/eventlog";
import { getTemplate } from "@hearth/templates";
import { loadCodexProfile, runCodex } from "@hearth/codex-executor";
import { z } from "zod";
import { ATTACHMENT_DIR, BACKUP_DIR, CODEX_HOME_DIR, CONTEXT_BLOB_DIR, DATA_DIR, DB_PATH, DEVICE_FRAME_DIR, DSH_HOME_DIR, EXECUTOR_HOME_DIR, EXECUTOR_SETTINGS_PATH, MASTER_KEY_PATH, MODEL_SETTINGS_PATH, OUTBOX_DIR, REPO_ROOT, SOURCE_CONTENT_DIR, WEB_DIST, WORKSPACE_DIR } from "./config.ts";
import { registerChatRoutes } from "./chat-routes.ts";
import { registerEvalRoutes } from "./eval-routes.ts";
import { ReconcileError, ReconcileService } from "./reconcile.ts";
import { ExecutorSettingsStore } from "./executor-settings.ts";
import { clearHermesHealthCache } from "./hermes-health.ts";
import { clearExecutorHealthCache, executorHealth as readExecutorHealth, executorRuntimeSettings, probeExecutor } from "./executor-runtime.ts";
import { applyExecutorModelReadiness } from "./executor-readiness.ts";
import { ExecutorInstallError, ExecutorInstaller } from "./executor-install.ts";
import { EXECUTORS } from "./executors.ts";
import { ScheduleError, ScheduleService } from "./schedules.ts";
import { chatModelConfigured, loadModelSettings, viewModelSettings } from "./model-settings.ts";
import { ModelRegistry, ModelRegistryError } from "./model-registry.ts";
import { migrateLegacySettings } from "./settings-migration.ts";
import { ApprovalError, ApprovalManager, type EffectExecutor, type PendingToolApproval, type ToolApprovalDecision } from "./approvals.ts";
import { BackupError, BackupService } from "./backups.ts";
import { DelegationError, DelegationService, type CreateDelegationInput } from "./delegation.ts";
import { executeEffect } from "./effects.ts";
import { HearthScheduler, resolveToolAction } from "./scheduler.ts";
import { GitViewError, TaskGitService } from "./task-git.ts";
import { TaskLeaseService } from "./leases.ts";
import { SandboxError, SandboxService } from "./sandbox.ts";
import { SecurityError, SecurityService } from "./security.ts";
import { ContextService } from "./context.ts";
import { ContextBroker } from "./context-broker.ts";
import { MentionResolver } from "./mentions.ts";
import { OntologyService } from "./ontology.ts";
import { OntologyWriter } from "./ontology-writer.ts";
import type { ContextIndex } from "./context-index.ts";
import { contextMetrics } from "./context-metrics.ts";
import { HearthService, TaskInputSelectionError, type CreateGoalInput, type CreateTaskInput } from "./service.ts";
import { HealthService } from "./health.ts";
import { MaintenanceError, MaintenanceService } from "./maintenance.ts";
import { DiagnosticsService } from "./diagnostics.ts";
import { SourceRegistry, SourceRegistryError } from "./sources.ts";
import { OutboxError, OutboxService } from "./outbox.ts";
import { OnboardingService } from "./onboarding.ts";
import { FeishuError, FeishuService, type FeishuChatClient, type FeishuTransportFactory } from "./feishu.ts";
import { EmailService, MailError, type MailImapFactory, type MailSmtpFactory } from "./email.ts";
import { DesktopError, DesktopService } from "./desktop.ts";
import { ConnectionError, ConnectionService } from "./connections.ts";
import { MemoryError, MemoryService } from "./memory.ts";
import { MethodError, MethodService } from "./methods.ts";
import { SkillPackageError } from "./skill-package.ts";
import { SkillPackageService } from "./skills.ts";
import { SkillCuratorService } from "./skill-curator.ts";
import { ProactiveError, ProactiveService } from "./proactive.ts";
import { AttentionGovernor } from "./attention-governor.ts";
import { BackgroundToolError, BackgroundToolService } from "./background-tools.ts";
import { PreparedActionService } from "./prepared-actions.ts";
import { ThreadSubscriptionService } from "./thread-subscriptions.ts";
import { WatchdogService } from "./watchdog.ts";
import { IntakeRouter } from "./intake-router.ts";
import { isBackgroundToolReadOnly, requiresToolApproval, toolApprovalSummary } from "./tool-policy.ts";
import { createBuiltinTools } from "@hearth/agent-runtime";
import { StandingIntentError, StandingIntentService } from "./standing-intents.ts";
import { SyncError, SyncService } from "./sync.ts";
import { SecretBox } from "./secrets.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function awaitToolDecision(
  pending: PendingToolApproval,
  signal: AbortSignal,
  approvals: ApprovalManager,
  toolName: string
): Promise<ToolApprovalDecision> {
  if (signal.aborted) {
    approvals.cancelToolApproval(pending.approval.id, "任务已取消");
    return Promise.resolve({ allowed: false, reason: "任务已取消" });
  }
  return new Promise<ToolApprovalDecision>((resolve) => {
    let settled = false;
    const finish = (decision: ToolApprovalDecision): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(decision);
    };
    const onAbort = (): void => {
      approvals.cancelToolApproval(pending.approval.id, "任务已取消");
      finish({ allowed: false, reason: "任务已取消" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void pending.decision.then((decision) => finish({
      ...decision,
      reason: decision.reason || `后台工具 ${toolName} 审批结束`
    })).catch((error: unknown) => finish({
      allowed: false,
      reason: error instanceof Error ? error.message : String(error)
    }));
  });
}

const createTaskSchema = z.object({
  templateId: z.string().trim().min(1).max(20).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  goal: z.string().trim().min(1).max(4000).optional(),
  textInput: z.string().max(100_000).optional(),
  sourceItemIds: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  executorId: z.enum(EXECUTOR_IDS).optional(),
  taskKind: z.enum(["delivery", "workspace", "general"]).optional(),
  expectedOutputs: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  methodId: z.string().trim().min(1).max(100).optional(),
  goalId: z.string().trim().min(1).max(100).optional(),
  permissions: z.object({
    readRoots: z.array(z.string().trim().min(1).max(1000)).max(20),
    writeRoots: z.array(z.string().trim().min(1).max(1000)).max(20),
    networkHosts: z.array(z.string().trim().min(1).max(255)).max(20),
    tools: z.array(z.string().trim().min(1).max(80)).max(40)
  }).optional()
}).strict();

const goalAuthoritySourceSchema = z.object({
  kind: z.enum(["user", "document", "system"]),
  ref: z.string().trim().min(1).max(1000)
}).strict();

const goalCriterionSchema = z.object({
  id: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(2000),
  validator: z.enum(GOAL_VALIDATORS),
  check: z.string().trim().min(1).max(4000),
  required: z.boolean()
}).strict();

const goalBudgetSchema = z.object({
  maxTurns: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  maxHumanMinutes: z.number().int().positive().optional()
}).strict();

function normalizeGoalBudget(input: z.infer<typeof goalBudgetSchema>): GoalBudget {
  const budget: GoalBudget = {};
  if (input.maxTurns !== undefined) budget.maxTurns = input.maxTurns;
  if (input.maxToolCalls !== undefined) budget.maxToolCalls = input.maxToolCalls;
  if (input.maxTokens !== undefined) budget.maxTokens = input.maxTokens;
  if (input.maxDurationMs !== undefined) budget.maxDurationMs = input.maxDurationMs;
  if (input.maxHumanMinutes !== undefined) budget.maxHumanMinutes = input.maxHumanMinutes;
  return budget;
}

const createGoalSchema = z.object({
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(20_000),
  constraints: z.array(z.string().trim().min(1).max(2000)).max(100).optional(),
  forbiddenActions: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  authoritySources: z.array(goalAuthoritySourceSchema).max(50).optional(),
  successCriteria: z.array(goalCriterionSchema).max(100).optional(),
  evidenceRequirements: z.array(z.string().trim().min(1).max(1000)).max(100).optional(),
  budget: goalBudgetSchema.optional(),
  deadline: z.string().datetime().optional(),
  stopConditions: z.array(z.string().trim().min(1).max(2000)).max(100).optional(),
  reviewPolicy: z.enum(GOAL_REVIEW_POLICIES).optional(),
  currentState: z.enum(GOAL_STATES).optional()
}).strict();

const updateGoalSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  objective: z.string().trim().min(1).max(20_000).optional(),
  constraints: z.array(z.string().trim().min(1).max(2000)).max(100).optional(),
  forbiddenActions: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  authoritySources: z.array(goalAuthoritySourceSchema).max(50).optional(),
  successCriteria: z.array(goalCriterionSchema).max(100).optional(),
  evidenceRequirements: z.array(z.string().trim().min(1).max(1000)).max(100).optional(),
  budget: goalBudgetSchema.optional(),
  deadline: z.string().datetime().optional(),
  stopConditions: z.array(z.string().trim().min(1).max(2000)).max(100).optional(),
  reviewPolicy: z.enum(GOAL_REVIEW_POLICIES).optional(),
  currentState: z.enum(GOAL_STATES).optional(),
  nextHandoff: z.string().trim().max(4000).optional()
}).strict();

const retryTaskSchema = z.object({
  message: z.string().trim().max(20_000).optional()
}).strict();

const taskFollowUpSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  mode: z.enum(["queue", "steer"]).default("queue")
}).strict();

const taskFollowUpPatchSchema = z.object({
  content: z.string().trim().min(1).max(20_000)
}).strict();

const contextQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional()
}).strict();

const confirmHandoffSchema = z.object({
  executorId: z.enum(EXECUTOR_IDS)
}).strict();

const delegationPermissionsSchema = z.object({
  readRoots: z.array(z.string().trim().min(1).max(1000)).max(20),
  writeRoots: z.array(z.string().trim().min(1).max(1000)).max(20),
  networkHosts: z.array(z.string().trim().min(1).max(255)).max(20),
  tools: z.array(z.string().trim().min(1).max(80)).max(40)
}).strict();

const createDelegationSchema = z.object({
  goalSlice: z.string().trim().min(1).max(4000),
  targetExecutor: z.enum(EXECUTOR_IDS),
  contextPackRef: z.string().trim().min(1).max(1000),
  contextPack: z.record(z.string(), z.unknown()).optional(),
  workspacePolicy: z.enum(DELEGATION_WORKSPACE_POLICIES).optional(),
  toolPolicy: z.array(z.string().trim().min(1).max(80)).max(40).optional(),
  networkPolicy: z.array(z.string().trim().min(1).max(255)).max(20).optional(),
  budget: z.object({
    tokens: z.number().int().positive().optional(),
    wallClockMs: z.number().int().positive().optional(),
    maxSteps: z.number().int().positive().optional()
  }).strict().optional(),
  deadline: z.string().datetime().nullable().optional(),
  resultSchemaRef: z.string().trim().min(1).max(1000).nullable().optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
  requestedPermissions: delegationPermissionsSchema.optional(),
  createChildTask: z.boolean().optional()
}).strict();

const verifyDelegationSchema = z.object({
  verdict: z.enum(["accepted", "rejected"]),
  summary: z.string().trim().min(1).max(4000),
  evidenceRefs: z.array(z.string().trim().min(1).max(1000)).min(1).max(50),
  checkedAt: z.string().datetime().optional()
}).strict();

const cancelDelegationSchema = z.object({
  reason: z.string().trim().min(1).max(1000).default("用户取消")
}).strict();

const contextSettingsPatchSchema = z.object({
  mode: z.enum(["off", "shadow", "on"]).optional(),
  maxHandoffs: z.number().int().min(0).max(5).optional(),
  maxSameExecutorRetries: z.number().int().min(0).max(3).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  maxInlineBytes: z.number().int().min(1024).max(1_000_000).optional(),
  projectionTokenBudget: z.number().int().min(1000).max(200_000).optional(),
  summarizeAfterTokens: z.number().int().min(1000).max(500_000).optional(),
  autoHandoffRisk: z.enum(["low", "none"]).optional(),
  allowCodexNetwork: z.boolean().optional()
}).strict();

const modelProtocolEnum = z.enum(["openai-chat", "openai-responses", "anthropic-messages", "gemini"]);

const createModelProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  providerId: z.string().trim().max(60).optional(),
  providerName: z.string().trim().max(80).optional(),
  protocol: modelProtocolEnum.optional(),
  baseUrl: z.string().trim().min(1).max(500),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().max(500).optional()
}).strict();

const updateModelProfileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  providerId: z.string().trim().max(60).optional(),
  providerName: z.string().trim().max(80).optional(),
  protocol: modelProtocolEnum.optional(),
  baseUrl: z.string().trim().max(500).optional(),
  model: z.string().trim().max(200).optional(),
  apiKey: z.string().max(500).optional()
}).strict();

const chatProfileSchema = z.object({
  profileId: z.string().trim().min(1).max(100).nullable()
}).strict();

const executorModelBindingSchema = z.object({
  profileId: z.string().trim().min(1).max(100).nullable().optional(),
  protocolOverride: modelProtocolEnum.nullable().optional(),
  modelOverride: z.string().trim().max(200).nullable().optional()
}).strict();

const memorySourceSchema = z.object({
  type: z.enum(["user", "task", "source", "method", "system"]),
  id: z.string().trim().max(100).nullable(),
  label: z.string().trim().min(1).max(200),
  excerpt: z.string().max(2000).nullable()
}).strict();

const createMemorySchema = z.object({
  kind: z.enum(MEMORY_KINDS),
  content: z.string().trim().min(1).max(8000),
  subjectKey: z.string().trim().min(1).max(200),
  scope: z.string().trim().min(1).max(120).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  source: memorySourceSchema,
  confidence: z.enum(MEMORY_CONFIDENCES).optional(),
  sensitivity: z.enum(MEMORY_SENSITIVITIES).optional(),
  allowRecall: z.boolean().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  derivedFromId: z.string().trim().max(100).nullable().optional(),
  tier: z.enum(MEMORY_TIERS).optional(),
  originClass: z.enum(MEMORY_ORIGINS).optional(),
  sourceKind: z.string().trim().min(1).max(100).optional(),
  sourceRef: z.string().trim().max(1000).optional(),
  sessionId: z.string().trim().max(100).nullable().optional(),
  trust: z.enum(MEMORY_TRUST_LEVELS).optional(),
  taint: z.enum(MEMORY_TAINT_STATES).optional(),
  importance: z.number().min(0).max(1).optional(),
  retention: z.enum(MEMORY_RETENTIONS).optional(),
  supersessionKey: z.string().trim().max(200).nullable().optional(),
  lastVerifiedAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional()
}).strict();

const correctMemorySchema = z.object({
  content: z.string().trim().min(1).max(8000).optional(),
  scope: z.string().trim().min(1).max(120).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  confidence: z.enum(MEMORY_CONFIDENCES).optional(),
  sensitivity: z.enum(MEMORY_SENSITIVITIES).optional(),
  allowRecall: z.boolean().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  reason: z.string().trim().min(1).max(500)
}).strict();

const memorySettingsSchema = z.object({
  autoCapture: z.enum(["off", "experience"]).optional(),
  maxItems: z.number().int().min(1).max(50).optional(),
  maxChars: z.number().int().min(200).max(100000).optional(),
  allowSensitive: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0, { message: "至少需要修改一个设置" });

const memorySensitiveSchema = z.object({
  sensitivity: z.enum(MEMORY_SENSITIVITIES),
  allowRecall: z.boolean().optional()
}).strict();

const memoryRecallSchema = z.object({
  taskId: z.string().trim().min(1).max(100),
  runId: z.string().trim().max(100).optional(),
  text: z.string().max(20000).optional(),
  scope: z.string().trim().min(1).max(120).optional(),
  maxItems: z.number().int().min(1).max(50).optional(),
  maxChars: z.number().int().min(200).max(100000).optional()
}).strict();

const memoryCaptureSchema = z.object({ taskId: z.string().trim().min(1).max(100) }).strict();

const memoryConsolidationSchema = z.object({
  scope: z.string().trim().min(1).max(120).optional(),
  apply: z.boolean().optional(),
  minClusterSize: z.number().int().min(2).max(20).optional(),
  maxGroups: z.number().int().min(1).max(50).optional()
}).strict();

const memoryForgetSourceSchema = z.object({
  sourceId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(500).optional(),
  dryRun: z.boolean().optional()
}).strict();

const memoryConflictResolveSchema = z.object({
  resolution: z.enum(["keep_left", "keep_right", "merged"]),
  note: z.string().max(1000).optional(),
  content: z.string().trim().min(1).max(8000).optional()
}).strict();

const createMethodSchema = z.object({
  name: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(2000),
  applicability: z.string().trim().min(1).max(1000),
  steps: z.array(z.string().trim().min(1).max(1000)).min(1).max(30),
  sourceTaskIds: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
  templateId: z.string().trim().min(1).max(20).nullable().optional(),
  allowedCapabilities: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  guardrails: z.array(z.string().trim().min(1).max(500)).max(50).optional()
}).strict();

const generateMethodSchema = z.object({
  taskId: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200).optional(),
  summary: z.string().trim().min(1).max(2000).optional()
}).strict();

const evaluateMethodSchema = z.object({
  baselineTaskIds: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
  trialTaskIds: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
  notes: z.string().max(2000).optional()
}).strict();

const methodTrialSchema = z.object({ taskId: z.string().trim().min(1).max(100) }).strict();
const methodRollbackSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
const methodRejectSchema = z.object({ reason: z.string().trim().max(1000).optional() }).strict();
const skillExportSchema = z.object({ methodId: z.string().trim().min(1).max(100) }).strict();
const skillImportSchema = z.object({
  content: z.string().min(1).max(200_000),
  origin: z.enum(["imported", "user"]).optional()
}).strict();
const skillTrialSchema = z.object({
  taskIds: z.array(z.string().trim().min(1).max(100)).min(1).max(50)
}).strict();
const skillCheckSchema = z.object({
  taskId: z.string().trim().min(1).max(100),
  readPaths: z.array(z.string().trim().min(1).max(2000)).max(100).optional(),
  writePaths: z.array(z.string().trim().min(1).max(2000)).max(100).optional(),
  networkHosts: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
  tools: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  allowImported: z.boolean().optional()
}).strict();
const skillPermissionQuerySchema = z.object({ taskId: z.string().trim().min(1).max(100) }).strict();
const skillPinSchema = z.object({ pinned: z.boolean() }).strict();
const skillArchiveSchema = z.object({ reason: z.string().trim().max(1000).optional() }).strict();
const skillTransitionSchema = z.object({
  status: z.enum(SKILL_STATUSES),
  reason: z.string().trim().max(1000).optional()
}).strict();
const skillUsageSchema = z.object({
  taskId: z.string().trim().min(1).max(100).nullable().optional(),
  runId: z.string().trim().min(1).max(100).nullable().optional(),
  status: z.enum(SKILL_USAGE_STATUSES),
  source: z.enum(SKILL_USAGE_SOURCES).optional(),
  note: z.string().trim().max(1000).optional()
}).strict();
const skillCuratorRunSchema = z.object({ dryRun: z.boolean().optional() }).strict();
const skillCuratorRollbackSchema = z.object({ runId: z.string().trim().min(1).max(100) }).strict();
const assignTaskMethodSchema = z.object({ methodId: z.string().trim().min(1).max(100).nullable() }).strict();
const taskOrganizationSchema = z.object({
  pinned: z.boolean().optional(),
  archived: z.boolean().optional()
}).strict();
const methodSettingsPatchSchema = z.object({ autoLearn: z.boolean().optional() }).strict();

const createSyncPeerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().trim().url().max(2000),
  token: z.string().trim().min(32).max(256).optional(),
  lastPullSeq: z.number().int().min(0).optional()
}).strict();

const syncExportSchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200)
});

const syncConflictResolveSchema = z.object({ resolution: z.enum(["local", "remote"]) }).strict();

const connectionScopeSchema = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9*._:-]+$/);
const createConnectionSchema = z.object({
  deviceId: z.string().trim().min(1).max(120),
  userId: z.string().trim().min(1).max(120),
  scopes: z.array(connectionScopeSchema).max(20).optional()
}).strict();
const connectionGenerationSchema = z.object({ generation: z.number().int().min(1) }).strict();
const disconnectConnectionSchema = z.object({
  generation: z.number().int().min(1),
  reason: z.string().trim().max(500).optional()
}).strict();
const reconnectConnectionSchema = z.object({
  generation: z.number().int().min(1),
  scopes: z.array(connectionScopeSchema).max(20).optional()
}).strict();
const connectionProjectionQuerySchema = z.object({
  scope: z.string().trim().max(80).default("all"),
  generation: z.coerce.number().int().min(1).optional()
}).strict();
const connectionOutboxSchema = z.object({
  generation: z.number().int().min(1),
  scope: z.string().trim().min(1).max(80),
  kind: z.string().trim().min(1).max(80),
  idempotencyKey: z.string().trim().min(8).max(200),
  payload: z.record(z.string(), z.unknown()).default({})
}).strict();
const connectionOutboxResolveSchema = z.object({
  generation: z.number().int().min(1),
  status: z.enum(["committed", "rejected", "conflict"]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().trim().max(2000).optional()
}).strict();
const connectionScopesSchema = z.object({ scopes: z.array(connectionScopeSchema).min(1).max(20) }).strict();

const killSwitchSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().max(500).optional()
}).strict();

const optionalExecutorText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(1).max(max).optional()
  );

const executorSettingsSchema = z.object({
  defaultApprovalMode: z.enum(["necessary", "full"]).optional(),
  preferredExecutorId: z.enum(EXECUTOR_IDS).nullable().optional(),
  concurrency: z.partialRecord(z.enum(EXECUTOR_IDS), z.number().int().min(1).max(4)).optional(),
  executors: z.partialRecord(z.enum(EXECUTOR_IDS), z.object({
    command: optionalExecutorText(1000),
    executablePath: optionalExecutorText(2000),
    installMode: z.enum(["managed", "existing", "detected"]).optional(),
    authMode: z.enum(["local", "pat", "env"]).optional(),
    version: z.string().max(200).nullable().optional()
  }).strict()).optional(),
  hermesCommand: optionalExecutorText(500)
}).strict().refine((value) => Object.keys(value).length > 0, { message: "至少需要修改一个设置" });

const scheduleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(20_000),
  cron: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).max(80).optional(),
  executorId: z.enum(EXECUTOR_IDS).optional(),
  approvalMode: z.enum(["necessary", "full"]).optional(),
  taskKind: z.enum(["delivery", "workspace", "general"]).optional(),
  enabled: z.boolean().optional(),
  catchUpPolicy: z.enum(["skip", "run_once", "run_all_bounded"]).optional(),
  catchUpMaxRuns: z.number().int().min(1).max(20).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  deleteAfterRun: z.boolean().optional()
}).strict();

const schedulePatchSchema = scheduleSchema.partial().strict().refine((value) => Object.keys(value).length > 0, { message: "至少需要修改一个设置" });

const createBackupSchema = z.object({
  passphrase: z.string().min(12).max(500)
}).strict();

const restoreBackupSchema = z.object({
  passphrase: z.string().min(12).max(500),
  envelope: z.string().min(1)
}).strict();

const restoreStoredBackupSchema = z.object({
  passphrase: z.string().min(12).max(500)
}).strict();

const proactiveSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(PROACTIVE_MODES).optional(),
  dailyLimit: z.number().int().min(0).max(50).optional(),
  quietStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  quietEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  cooldownMinutes: z.number().int().min(0).max(10080).optional(),
  aggregateWindowMinutes: z.number().int().min(0).max(1440).optional(),
  pausedUntil: z.string().datetime().nullable().optional(),
  triggers: z.record(
    z.enum(TRIGGER_KINDS),
    z.object({ enabled: z.boolean().optional(), autonomy: z.enum(AUTONOMY_LEVELS).optional() }).strict()
  ).optional()
}).strict().refine((value) => Object.keys(value).length > 0, { message: "至少需要修改一个设置" });

const proactivePauseSchema = z.object({
  minutes: z.number().int().min(1).max(10080).optional(),
  off: z.boolean().optional(),
  resume: z.boolean().optional()
}).strict().refine((value) => value.minutes !== undefined || value.off === true || value.resume === true, { message: "暂停参数不完整" });

const standingIntentEntrySchema = z.object({
  terms: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
  mode: z.enum(["all", "any"])
}).strict();

const standingIntentSchema = z.object({
  ownerId: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().min(1).max(500),
  triggerEntries: z.array(standingIntentEntrySchema).min(1).max(20),
  scope: z.object({
    channel: z.string().trim().min(1).max(120).nullable().optional(),
    sender: z.string().trim().min(1).max(200).nullable().optional(),
    taskId: z.string().trim().min(1).max(120).nullable().optional(),
    goalId: z.string().trim().min(1).max(120).nullable().optional(),
    anywhere: z.boolean().optional()
  }).strict().optional(),
  action: z.enum(["remind", "ask", "prepare_task", "notify"]).optional(),
  cooldownSeconds: z.number().int().min(0).max(31_536_000).optional(),
  maxFires: z.number().int().min(1).max(100).optional(),
  expiresAt: z.string().datetime().optional(),
  armed: z.boolean().optional()
}).strict();

const intentMatchSchema = z.object({
  ownerId: z.string().trim().min(1).max(120).optional(),
  text: z.string().min(1).max(200_000),
  channel: z.string().trim().min(1).max(120).nullable().optional(),
  sender: z.string().trim().min(1).max(200).nullable().optional(),
  taskId: z.string().trim().min(1).max(120).nullable().optional(),
  goalId: z.string().trim().min(1).max(120).nullable().optional()
}).strict();

const heartbeatRunSchema = intentMatchSchema.partial().extend({
  since: z.string().datetime().optional()
}).strict().refine((value) => value.text === undefined || value.text.length > 0, { message: "text 不能为空" });

const attentionBudgetSchema = z.object({
  dailyLimit: z.number().int().min(0).max(100).optional(),
  quietStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  quietEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  cooldownSeconds: z.number().int().min(0).max(604_800).optional(),
  maxPerGoalPerDay: z.number().int().min(0).max(100).optional(),
  maxHighPriorityPerDay: z.number().int().min(0).max(100).optional(),
  ignoredPenalty: z.number().int().min(0).max(10).optional()
}).strict().refine((value) => Object.keys(value).length > 0, { message: "至少需要修改一个设置" });

const attentionSnoozeSchema = z.object({
  minutes: z.number().int().min(1).max(10_080).optional()
}).strict();

const onboardingCompleteSchema = z.object({
  skipped: z.boolean().optional()
}).strict();

const feishuSettingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  appId: z.string().trim().max(100).optional(),
  appSecret: z.string().max(500).optional(),
  allowedOpenIds: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  domain: z.enum(["feishu", "lark"]).optional()
}).strict().refine((value) => Object.keys(value).length > 0, { message: "至少需要修改一个设置" });

const feishuTestSchema = z.object({
  appId: z.string().trim().max(100).optional(),
  appSecret: z.string().max(500).optional(),
  domain: z.enum(["feishu", "lark"]).optional()
}).strict();

const mailServerSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().min(1).max(320),
  password: z.string().max(500).optional()
}).strict();

const mailAccountSchema = z.object({
  name: z.string().trim().min(1).max(80),
  fromName: z.string().trim().min(1).max(120),
  fromAddress: z.string().trim().min(3).max(320),
  smtp: mailServerSchema,
  imap: mailServerSchema,
  syncEnabled: z.boolean().optional(),
  syncIntervalMinutes: z.number().int().min(5).max(1440).optional()
}).strict();

const suggestionActionSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  goal: z.string().trim().min(1).max(4000).optional(),
  textInput: z.string().max(100_000).optional()
}).strict();

const suggestionSnoozeSchema = z.object({
  minutes: z.number().int().min(5).max(10080).optional()
}).strict();

const decideApprovalSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  parameterHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

const createSourceSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  displayName: z.string().trim().min(1).max(120).optional(),
  rootPath: z.string().trim().min(1).max(4096).optional(),
  allowedHosts: z.array(z.string().trim().min(1).max(253)).max(50).optional(),
  account: z.string().trim().min(1).max(200).optional()
}).strict();

const readSourceSchema = z.object({
  url: z.string().trim().min(1).max(2_048).optional()
}).strict();

const outboxDraftSchema = z.object({
  account: z.string().max(200).optional(),
  to: z.array(z.string().max(320)).max(50).optional(),
  cc: z.array(z.string().max(320)).max(50).optional(),
  bcc: z.array(z.string().max(320)).max(50).optional(),
  subject: z.string().max(500).optional(),
  body: z.string().max(200_000).optional(),
  attachmentIds: z.array(z.string().trim().min(1).max(80)).max(20).optional()
}).strict();

const pairingStartSchema = z.object({
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(40),
  deviceToken: z.string().min(32).max(256),
  apps: z.array(z.string().trim().min(1).max(120)).min(1).max(30),
  capabilities: z.array(z.enum(DEVICE_CAPABILITY_KINDS)).min(1).max(DEVICE_CAPABILITY_KINDS.length)
}).strict();

const capabilityApprovalSchema = z.object({
  apps: z.array(z.string().trim().min(1).max(120)).min(1).max(30)
}).strict();

const createDesktopSessionSchema = z.object({
  deviceId: z.string().trim().min(1).max(80),
  targetApp: z.string().trim().min(1).max(120).optional()
}).strict();

const desktopObservationRequestSchema = z.object({
  targetApp: z.string().trim().min(1).max(120).optional()
}).strict();

const desktopActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), frameId: z.string().trim().min(1).max(80), x: z.number(), y: z.number() }).strict(),
  z.object({ kind: z.literal("type"), frameId: z.string().trim().min(1).max(80), text: z.string().min(1).max(1000) }).strict(),
  z.object({ kind: z.literal("press"), frameId: z.string().trim().min(1).max(80), keys: z.string().min(1).max(40) }).strict(),
  z.object({ kind: z.literal("focus"), frameId: z.string().trim().min(1).max(80), app: z.string().trim().min(1).max(120), windowTitle: z.string().trim().max(200).optional() }).strict(),
  z.object({ kind: z.literal("uia.invoke"), frameId: z.string().trim().min(1).max(80), elementName: z.string().trim().min(1).max(200), controlType: z.string().trim().max(40).optional() }).strict(),
  z.object({ kind: z.literal("uia.setvalue"), frameId: z.string().trim().min(1).max(80), elementName: z.string().trim().min(1).max(200), value: z.string().max(500), controlType: z.string().trim().max(40).optional() }).strict()
]);

const commandResultSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(1000).optional()
}).strict();

const observationSchema = z.object({
  sessionId: z.string().trim().min(1).max(80),
  commandId: z.string().trim().min(1).max(80).optional(),
  jpegBase64: z.string().min(1).max(5_500_000),
  width: z.number().int().min(1).max(10_000),
  height: z.number().int().min(1).max(10_000),
  activeApp: z.string().trim().min(1).max(120),
  windowTitle: z.string().trim().max(300),
  targetApp: z.string().trim().min(1).max(120).optional()
}).strict();

const sourceItemQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional()
}).strict();

const listQuerySchema = z.object({
  taskId: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  brief: z.enum(["0", "1"]).optional()
}).strict();

const runQuerySchema = listQuerySchema.extend({ status: z.enum(RUN_STATUSES).optional() }).strict();
const approvalQuerySchema = listQuerySchema.extend({ status: z.enum(APPROVAL_STATUSES).optional() }).strict();
const effectQuerySchema = listQuerySchema.extend({ status: z.enum(EFFECT_STATUSES).optional() }).strict();
const reconcileQuerySchema = z.object({ status: z.enum(RECONCILE_STATUSES).optional() }).strict();
const reconcileResolveSchema = z.object({
  resolution: z.enum(["committed", "absent", "abandoned"]),
  note: z.string().trim().min(1).max(2000)
}).strict();
const reconcileTaskSchema = z.object({ note: z.string().trim().max(2000).optional() }).strict();

const seqParam = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const eventQuerySchema = z.object({
  after: seqParam.optional(),
  before: seqParam.optional(),
  taskId: z.string().trim().min(1).max(80).optional(),
  type: z.string().trim().min(1).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
}).strict();

const taskEventQuerySchema = eventQuerySchema.omit({ taskId: true });

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_EVENT_LIMIT = 100;

export interface BuildServerOptions {
  store?: HearthStore;
  logger?: boolean;
  serveWeb?: boolean;
  startScheduler?: boolean;
  startMaintenance?: boolean;
  startProactive?: boolean;
  startHeartbeat?: boolean;
  startMailSync?: boolean;
  feishuTransportFactory?: FeishuTransportFactory;
  feishuChatClient?: FeishuChatClient;
  mailSmtpFactory?: MailSmtpFactory;
  mailImapFactory?: MailImapFactory;
  effectExecutor?: EffectExecutor;
  sourceContentRoot?: string;
  outboxRoot?: string;
  deviceFrameRoot?: string;
  backupRoot?: string;
  masterKeyPath?: string;
  dataDir?: string;
  dbPath?: string;
  syncFetch?: typeof fetch;
  syncSecretBox?: SecretBox;
  modelSettingsPath?: string;
  attachmentRoot?: string;
  executorSettingsPath?: string;
  executorInstaller?: ExecutorInstaller;
  contextBlobRoot?: string;
  contextIndex?: ContextIndex;
  skillRoot?: string;
}

export async function buildServer(options: BuildServerOptions = {}) {
  const ownsStore = !options.store;
  const store = options.store ?? new HearthStore(DB_PATH);
  const serverStartedAt = new Date().toISOString();
  const service = new HearthService(store);
  const taskGit = new TaskGitService({ workspaceRoot: WORKSPACE_DIR });
  const context = new ContextService(service, options.contextBlobRoot ?? CONTEXT_BLOB_DIR);
  if (options.contextIndex) context.setIndex(options.contextIndex);
  const ontology = new OntologyService(service);
  const mentions = new MentionResolver(service, ontology);
  const contextBroker = new ContextBroker(service, context, ontology);
  const ontologyWriter = new OntologyWriter(service, ontology);
  service.setContextSink((message) => {
    if (context.settings().mode !== "off") context.recordChatMessage(message);
  });

  const sources = new SourceRegistry(service, {
    contentRoot: options.sourceContentRoot ?? SOURCE_CONTENT_DIR,
    onItemReady: (item) => ontologyWriter.captureSourceItem(item)
  });
  const secretBox = options.syncSecretBox ?? SecretBox.fromKeyFile(options.masterKeyPath ?? MASTER_KEY_PATH);
  const mail = new EmailService({
    store,
    secretBox,
    sources,
    ...(options.mailSmtpFactory ? { smtpFactory: options.mailSmtpFactory } : {}),
    ...(options.mailImapFactory ? { imapFactory: options.mailImapFactory } : {})
  });
  const effectExecutor = options.effectExecutor ?? ((effect) => executeEffect(effect, {
    outboxRoot: options.outboxRoot ?? OUTBOX_DIR,
    getArtifact: (id) => store.getArtifact(id),
    mail
  }));
  const proactive = new ProactiveService(service);
  const attentionGovernor = new AttentionGovernor(service);
  const standingIntents = new StandingIntentService({
    service,
    deliveryGate: (run) => attentionGovernor.deliveryAllowed(run)
  });
  const preparedActions = new PreparedActionService(service);
  const threadSubscriptions = new ThreadSubscriptionService(service);
  const watchdog = new WatchdogService({ service, standingIntents });
  const intake = new IntakeRouter(service);
  const memory = new MemoryService(service);
  const methods = new MethodService(service);
  const skills = new SkillPackageService(service, methods, {
    rootDir: options.skillRoot ?? join(options.dataDir ?? DATA_DIR, "skills")
  });
  const skillCurator = new SkillCuratorService({ service, skills });
  const sync = new SyncService(service, {
    ...(options.syncFetch ? { fetchImpl: options.syncFetch } : {}),
    ...(options.syncSecretBox ? { secretBox: options.syncSecretBox } : {})
  });
  const connections = new ConnectionService({ service });
  const security = new SecurityService(service);
  const leases = new TaskLeaseService(service);
  const sandbox = new SandboxService();
  const delegations = new DelegationService({ service, sandbox });
  const backups = new BackupService({
    service,
    backupRoot: options.backupRoot ?? BACKUP_DIR,
    masterKeyPath: options.masterKeyPath ?? MASTER_KEY_PATH
  });
  const reconcile = new ReconcileService(service);
  const approvals = new ApprovalManager(service, effectExecutor, {
    guard: (taskId) => {
      security.assertActionsAllowed();
      leases.assertOwnedIfLeased(taskId);
      delegations.assertEffectAllowed(taskId);
    },
    onUncertain: (effect, reason) => {
      reconcile.enqueue(effect, reason);
    },
    onDecided: (approval) => ontologyWriter.captureApprovalDecision(approval)
  });
  approvals.recoverInterruptedEffects();
  reconcile.scanUncertain();
  const backgroundTools = new BackgroundToolService(service, {
    runner: async (job, signal) => {
      const task = service.requireTask(job.taskId);
      const tool = createBuiltinTools().find((candidate) => candidate.definition.name === job.toolName);
      if (!tool) throw new Error(`后台工具不支持：${job.toolName}`);
      const permissions = task.permissions ?? {
        readRoots: [task.outputDir],
        writeRoots: [],
        networkHosts: task.networkHosts,
        tools: ["read_file", "list_files", "search_text"]
      };
      if (!permissions.tools.includes(job.toolName)) throw new Error(`任务未授权工具：${job.toolName}`);
      const result = await tool.execute(job.args, {
        workspaceRoot: task.outputDir, outDir: task.outputDir, permissions, signal
      });
      return { output: result.content, exitCode: result.isError ? 1 : 0 };
    },
    authorize: async ({ job, signal }) => {
      if (isBackgroundToolReadOnly(job.toolName) && !requiresToolApproval(job.toolName)) return;
      const task = service.requireTask(job.taskId);
      if (!job.runId) {
        throw new BackgroundToolError("BACKGROUND_TOOL_RUN_REQUIRED", "后台敏感工具必须绑定运行中的 run", 409);
      }
      const run = store.getRun(job.runId);
      if (!run || run.taskId !== task.id || run.status !== "running") {
        throw new BackgroundToolError("BACKGROUND_TOOL_RUN_NOT_ACTIVE", "后台敏感工具只能由当前运行中的任务发起", 409);
      }
      const summary = toolApprovalSummary(job.toolName, job.args);
      let action;
      try {
        action = resolveToolAction({
          toolName: job.toolName,
          argumentsValue: job.args,
          summary,
          workspaceRoot: task.outputDir,
          fullPermission: false,
          context: "interactive"
        });
      } catch (error) {
        throw new BackgroundToolError(
          "BACKGROUND_TOOL_ACTION_UNRESOLVED",
          `后台敏感工具无法绑定为可审批动作：${error instanceof Error ? error.message : String(error)}`,
          403
        );
      }
      if (!action) {
        throw new BackgroundToolError("BACKGROUND_TOOL_ACTION_UNRESOLVED", `后台敏感工具 ${job.toolName} 无法解析为可绑定动作`, 403);
      }
      const pending = await approvals.requestTool({
        taskId: task.id,
        runId: run.id,
        toolName: job.toolName,
        summary,
        target: { tool: job.toolName, arguments: job.args },
        preview: { arguments: job.args },
        action
      });
      const decision = await awaitToolDecision(pending, signal, approvals, job.toolName);
      if (!decision.allowed) {
        throw new BackgroundToolError("BACKGROUND_TOOL_APPROVAL_DENIED", decision.reason, 403);
      }
    }
  });
  const outbox = new OutboxService(service, approvals, undefined, mail);
  const desktop = new DesktopService(service, options.deviceFrameRoot ?? DEVICE_FRAME_DIR, security);
  const modelSettingsPath = options.modelSettingsPath ?? MODEL_SETTINGS_PATH;
  const executorSettingsPath = options.executorSettingsPath ?? EXECUTOR_SETTINGS_PATH;
  const executorSettingsStore = new ExecutorSettingsStore(store, executorSettingsPath);
  const modelRegistry = new ModelRegistry({
    store,
    secretBox,
    codexHome: CODEX_HOME_DIR
  });
  const settingsMigrations = migrateLegacySettings({
    store,
    registry: modelRegistry,
    executorSettings: executorSettingsStore,
    modelSettingsPath,
    executorSettingsPath,
    backupRoot: options.backupRoot ?? BACKUP_DIR
  });
  const modelSettingsForExecutor = (executorId: ExecutorId) => modelRegistry.settingsForExecutorOrChat(executorId);
  const codexProfile = () => {
    const binding = modelRegistry.bindingViews().find((item) => item.executorId === "codex");
    if (binding?.profileId && !binding.available) {
      return {
        ...loadCodexProfile(),
        canRun: false,
        issues: [`Codex 的 Hearth 模型绑定不可用：${binding.issue ?? "请重新选择模型档案"}`]
      };
    }
    return modelRegistry.codexProfile() ?? loadCodexProfile();
  };
  const codexEnv = () => modelRegistry.codexEnv();
  const attachmentRoot = options.attachmentRoot ?? ATTACHMENT_DIR;
  const feishu = new FeishuService({
    store,
    secretBox,
    attachmentRoot,
    service,
    approvals,
    outbox,
    ...(options.feishuTransportFactory ? { transportFactory: options.feishuTransportFactory } : {}),
    ...(options.feishuChatClient ? { chatClient: options.feishuChatClient } : {})
  });
  const executorInstaller = options.executorInstaller ?? new ExecutorInstaller();
  const executorHealth = (executorId: ExecutorId): ExecutorHealth => {
    const health = readExecutorHealth(executorId, executorSettingsStore.load(), executorSettingsPath);
    const binding = modelRegistry.bindingViews().find((item) => item.executorId === executorId);
    return applyExecutorModelReadiness(
      executorId,
      health,
      modelRegistry.settingsForExecutorOrChat(executorId),
      binding?.profileId
        ? { explicit: true, available: binding.available, issue: binding.issue }
        : null
    );
  };
  const onboarding = new OnboardingService({
    store,
    isChatModelConfigured: () => {
      const settings = modelRegistry.chatSettings() ?? loadModelSettings(modelSettingsPath);
      return Boolean(settings && chatModelConfigured(settings));
    },
    readyExecutorIds: () => EXECUTORS.map((executor) => executor.id).filter((id) => executorHealth(id).canRun),
    memoryAutoCapture: () => memory.settings().autoCapture,
    proactiveEnabled: () => proactive.snapshot().settings.enabled
  });
  const scheduler = options.startScheduler
    ? new HearthScheduler({
        service,
        approvals,
        context,
        contextBroker,
        methods,
        autoLearn: true,
        leases,
        delegations,
        backgroundTools,
        attachmentRoot,
        executorSettingsPath,
        executorSettingsProvider: () => executorSettingsStore.load(),
        executorHealth,
        modelSettingsPath,
        modelSettingsForExecutor,
        codexRunner: (runOptions) => runCodex({ ...runOptions, profile: codexProfile(), env: codexEnv() }),
        ...(options.sourceContentRoot ? { sourceContentRoot: options.sourceContentRoot } : {})
      })
    : null;
  const schedules = new ScheduleService({ service, executorAvailable: executorHealth });
  const maintenance = new MaintenanceService({
    service,
    approvals,
    context,
    backupRoot: options.backupRoot ?? BACKUP_DIR,
    deviceFrameRoot: options.deviceFrameRoot ?? DEVICE_FRAME_DIR
  });
  const health = new HealthService({
    service,
    startedAt: serverStartedAt,
    dataDir: options.dataDir ?? DATA_DIR,
    dbPath: options.dbPath ?? DB_PATH,
    schedulerEnabled: Boolean(scheduler),
    schedulerRunning: () => scheduler?.running ?? false,
    executorSettingsPath,
    executorSettingsProvider: () => executorSettingsStore.load(),
    codexProfile
  });
  const diagnostics = new DiagnosticsService({ service, health, maintenance, webDist: WEB_DIST });
  if (options.startMaintenance ?? options.startScheduler) {
    maintenance.start();
    skillCurator.start();
    watchdog.start();
  }
  if (options.startProactive) proactive.start();
  if (options.startHeartbeat) standingIntents.start();
  if (options.startMailSync) mail.start();
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 8_000_000
  });
  app.decorate("feishu", feishu);

  schedules.start();
  await registerChatRoutes(app, {
    service,
    modelSettingsPath,
    attachmentRoot,
    executorSettingsPath,
    executorSettingsStore,
    registry: modelRegistry,
    codexProfile,
    codexEnv,
    modelSettingsForExecutor,
    executorHealth,
    memory,
    personal: { ontology, mentions, broker: contextBroker, writer: ontologyWriter }
  });
  registerEvalRoutes(app, {
    service,
    store,
    settings: () => modelRegistry.chatSettings() ?? loadModelSettings(modelSettingsPath),
    repoRoot: REPO_ROOT
  });

  app.addHook("onClose", async () => {
    await feishu.stop();
    mail.stop();
    proactive.stop();
    standingIntents.stop();
    watchdog.stop();
    threadSubscriptions.close();
    maintenance.stop();
    skillCurator.stop();
    schedules.stop();
    await scheduler?.stop();
    if (ownsStore) store.close();
  });

  app.addHook("onRequest", async (request, reply) => {
    const inboundSync = request.url.startsWith("/api/sync/events");
    if (!LOOPBACK_HOSTS.has(request.hostname) && !inboundSync) {
      return reply.code(403).send({ error: "LOCAL_ONLY", message: "Hearth 仅接受本机访问" });
    }
    if (request.headers["sec-fetch-site"] === "cross-site") {
      return reply.code(403).send({ error: "CROSS_SITE_BLOCKED", message: "已阻止跨站请求" });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.origin) {
      if (!isLoopbackOrigin(request.headers.origin)) {
        return reply.code(403).send({ error: "ORIGIN_BLOCKED", message: "请求来源不是本机页面" });
      }
    }
  });

  app.get("/api/health", async () => {
    const snapshot = health.snapshot();
    const profile = codexProfile();
    const modelSettings = modelRegistry.chatSettings() ?? loadModelSettings(modelSettingsPath);
    return {
      ...snapshot,
      chatModel: {
        configured: Boolean(modelSettings && chatModelConfigured(modelSettings)),
        settings: viewModelSettings(modelSettings)
      },
      codex: {
        ...snapshot.codex,
        configPath: profile.configPath,
        codexHome: profile.codexHome,
        baseUrl: profile.baseUrl,
        wireApi: profile.wireApi,
        envKey: profile.envKey,
        envKeyPresent: profile.envKeyPresent
      }
    };
  });

  app.get("/api/onboarding", async () => onboarding.snapshot());

  app.post("/api/onboarding/complete", async (request, reply) => {
    const parsed = onboardingCompleteSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_ONBOARDING", message: "首次运行设置参数不正确" });
    return onboarding.complete(parsed.data);
  });

  app.post("/api/onboarding/reset", async () => onboarding.reset());

  app.get("/api/integrations/feishu", async () => ({
    settings: feishu.view(),
    status: feishu.snapshot()
  }));

  app.put("/api/integrations/feishu", async (request, reply) => {
    const parsed = feishuSettingsPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_FEISHU_SETTINGS", message: "飞书设置参数不正确" });
    try {
      return await feishu.updateSettings(parsed.data);
    } catch (error) {
      if (error instanceof FeishuError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      return reply.code(500).send({ error: "FEISHU_SETTINGS_FAILED", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/integrations/feishu/test", async (request, reply) => {
    const parsed = feishuTestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_FEISHU_TEST", message: "飞书测试参数不正确" });
    try {
      return await feishu.test(parsed.data);
    } catch (error) {
      if (error instanceof FeishuError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      return reply.code(500).send({ error: "FEISHU_TEST_FAILED", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/integrations/feishu/reconnect", async () => {
    await feishu.restart();
    return { settings: feishu.view(), status: feishu.snapshot() };
  });

  app.get("/api/mail/accounts", async () => ({ accounts: mail.list() }));

  app.post("/api/mail/accounts", async (request, reply) => {
    const parsed = mailAccountSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MAIL_ACCOUNT", message: "邮件账户参数不正确" });
    try {
      return reply.code(201).send({ account: mail.create(parsed.data) });
    } catch (error) {
      return sendMailError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/mail/accounts/:id", async (request, reply) => {
    const parsed = mailAccountSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MAIL_ACCOUNT", message: "邮件账户参数不正确" });
    try {
      return { account: mail.update(request.params.id, parsed.data) };
    } catch (error) {
      return sendMailError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/mail/accounts/:id", async (request, reply) => {
    try {
      mail.remove(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return sendMailError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/mail/accounts/:id/test", async (request, reply) => {
    try {
      return await mail.test(request.params.id);
    } catch (error) {
      return sendMailError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/mail/accounts/:id/sync", async (request, reply) => {
    try {
      return await mail.syncInbox(request.params.id);
    } catch (error) {
      return sendMailError(reply, error);
    }
  });

  app.get("/api/model-registry", async () => {
    const chat = modelRegistry.chatSettings();
    return {
      ...modelRegistry.view(),
      presets: modelRegistry.presets(),
      chatConfigured: Boolean(chat && chatModelConfigured(chat))
    };
  });

  app.get("/api/settings/storage", async () => ({
    dataDir: options.dataDir ?? DATA_DIR,
    schemaVersion: store.getAppMeta().schemaVersion,
    paths: {
      database: options.dbPath ?? DB_PATH,
      executors: EXECUTOR_HOME_DIR,
      codexHome: CODEX_HOME_DIR,
      deepseekHarnessHome: DSH_HOME_DIR,
      contextBlobs: options.contextBlobRoot ?? CONTEXT_BLOB_DIR,
      backups: options.backupRoot ?? BACKUP_DIR,
      attachments: attachmentRoot
    },
    legacy: {
      modelSettings: modelSettingsPath,
      executorSettings: executorSettingsPath
    },
    migrations: store.listSettingsMigrations(),
    startupMigrations: settingsMigrations
  }));

  app.post("/api/model-profiles", async (request, reply) => {
    const parsed = createModelProfileSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MODEL_PROFILE", message: "模型档案格式不正确" });
    try {
      const profile = modelRegistry.createProfile(parsed.data);
      clearExecutorHealthCache();
      return reply.code(201).send({ profile });
    } catch (error) {
      return sendModelRegistryError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/model-profiles/:id", async (request, reply) => {
    const parsed = updateModelProfileSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MODEL_PROFILE", message: "模型档案格式不正确" });
    try {
      const profile = modelRegistry.updateProfile(request.params.id, parsed.data);
      clearExecutorHealthCache();
      return { profile };
    } catch (error) {
      return sendModelRegistryError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/model-profiles/:id", async (request, reply) => {
    try {
      modelRegistry.deleteProfile(request.params.id);
      clearExecutorHealthCache();
      return reply.code(204).send();
    } catch (error) {
      return sendModelRegistryError(reply, error);
    }
  });

  app.put("/api/model-registry/chat-profile", async (request, reply) => {
    const parsed = chatProfileSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_CHAT_PROFILE", message: "聊天模型选择格式不正确" });
    try {
      modelRegistry.setChatProfile(parsed.data.profileId);
      clearExecutorHealthCache();
      const chat = modelRegistry.chatSettings();
      return { registry: modelRegistry.view(), chatConfigured: Boolean(chat && chatModelConfigured(chat)) };
    } catch (error) {
      return sendModelRegistryError(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>("/api/executors/:id/model-binding", async (request, reply) => {
    const id = request.params.id;
    if (!(EXECUTOR_IDS as readonly string[]).includes(id)) {
      return reply.code(404).send({ error: "EXECUTOR_NOT_FOUND", message: "执行器不存在" });
    }
    const parsed = executorModelBindingSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MODEL_BINDING", message: "执行器模型绑定格式不正确" });
    try {
      const binding = modelRegistry.saveBinding(id as ExecutorId, parsed.data);
      clearExecutorHealthCache(id as ExecutorId);
      return { binding };
    } catch (error) {
      return sendModelRegistryError(reply, error);
    }
  });

  app.get("/api/executor-settings", async () => {
    const settings = executorSettingsStore.view();
    return { settings, hermes: executorHealth("hermes") };
  });

  app.put("/api/executor-settings", async (request, reply) => {
    const parsed = executorSettingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_EXECUTOR_SETTINGS", message: "执行器设置格式不正确" });
    const settings = executorSettingsStore.save(parsed.data);
    if (parsed.data.hermesCommand !== undefined || parsed.data.executors?.hermes !== undefined) {
      clearHermesHealthCache();
      clearExecutorHealthCache("hermes");
    }
    for (const id of Object.keys(parsed.data.executors ?? {}) as ExecutorId[]) {
      if (id !== "hermes") clearExecutorHealthCache(id);
    }
    return { settings, hermes: executorHealth("hermes") };
  });

  app.post("/api/hermes/probe", async () => {
    const settings = executorSettingsStore.load();
    clearHermesHealthCache(executorRuntimeSettings(settings, "hermes").command?.trim() || settings.hermesCommand);
    clearExecutorHealthCache("hermes");
    const binding = modelRegistry.bindingViews().find((item) => item.executorId === "hermes");
    const result = await probeExecutor("hermes", settings, executorSettingsPath, 60_000, {
      modelSettings: modelRegistry.settingsForExecutorOrChat("hermes"),
      binding: binding?.profileId ? { explicit: true, available: binding.available, issue: binding.issue } : null
    });
    return {
      ...result,
      code: result.health.lastProbe?.code ?? null,
      health: executorHealth("hermes")
    };
  });

  app.get("/api/executors", async () => {
    const settings = executorSettingsStore.load();
    const modelBindings = modelRegistry.bindingViews();
    const executors: ExecutorView[] = EXECUTORS.map((descriptor) => ({
      ...descriptor,
      runtime: executorRuntimeSettings(settings, descriptor.id),
      concurrency: settings.concurrency[descriptor.id],
      health: executorHealth(descriptor.id),
      install: executorInstaller.info(descriptor.id, executorSettingsPath),
      modelBinding: modelBindings.find((binding) => binding.executorId === descriptor.id)
    }));
    return {
      executors,
      preferredExecutorId: settings.preferredExecutorId,
      updatedAt: executorSettingsStore.view().updatedAt
    };
  });

  app.post<{ Params: { id: string } }>("/api/executors/:id/probe", async (request, reply) => {
    const id = request.params.id;
    if (!(EXECUTOR_IDS as readonly string[]).includes(id)) {
      return reply.code(404).send({ error: "EXECUTOR_NOT_FOUND", message: "执行器不存在" });
    }
    const settings = executorSettingsStore.load();
    if (id === "hermes") clearHermesHealthCache(settings.hermesCommand);
    const executorId = id as ExecutorId;
    const binding = modelRegistry.bindingViews().find((item) => item.executorId === executorId);
    const result = await probeExecutor(executorId, settings, executorSettingsPath, 60_000, {
      modelSettings: modelRegistry.settingsForExecutorOrChat(executorId),
      binding: binding?.profileId ? { explicit: true, available: binding.available, issue: binding.issue } : null,
      codexProfile: codexProfile(),
      codexEnv: codexEnv()
    });
    return { ...result, health: executorHealth(executorId) };
  });

  app.post<{ Params: { id: string } }>("/api/executors/:id/install", async (request, reply) => {
    const id = request.params.id;
    if (!(EXECUTOR_IDS as readonly string[]).includes(id)) {
      return reply.code(404).send({ error: "EXECUTOR_NOT_FOUND", message: "执行器不存在" });
    }
    try {
      const job = executorInstaller.start(id as ExecutorId, executorSettingsPath);
      return reply.code(202).send({
        job,
        install: executorInstaller.info(id as ExecutorId, executorSettingsPath),
        health: executorHealth(id as ExecutorId)
      });
    } catch (error) {
      if (error instanceof ExecutorInstallError) {
        return reply.code(400).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/api/executors/:id/install", async (request, reply) => {
    const id = request.params.id;
    if (!(EXECUTOR_IDS as readonly string[]).includes(id)) {
      return reply.code(404).send({ error: "EXECUTOR_NOT_FOUND", message: "执行器不存在" });
    }
    return {
      job: executorInstaller.status(id as ExecutorId, executorSettingsPath),
      install: executorInstaller.info(id as ExecutorId, executorSettingsPath),
      health: executorHealth(id as ExecutorId)
    };
  });

  app.get("/api/schedules", async () => ({ schedules: schedules.list() }));

  app.post("/api/schedules", async (request, reply) => {
    const parsed = scheduleSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SCHEDULE", message: "定时任务参数不正确" });
    try {
      return reply.code(201).send(schedules.create(parsed.data));
    } catch (error) {
      return sendScheduleError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/schedules/:id", async (request, reply) => {
    const parsed = schedulePatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SCHEDULE", message: "定时任务参数不正确" });
    try {
      return schedules.update(request.params.id, parsed.data);
    } catch (error) {
      return sendScheduleError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/schedules/:id", async (request, reply) => {
    try {
      schedules.remove(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return sendScheduleError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/schedules/:id/run", async (request, reply) => {
    try {
      return schedules.runNow(request.params.id);
    } catch (error) {
      return sendScheduleError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/schedules/:id/runs", async (request, reply) => {
    try {
      return { runs: schedules.listRuns(request.params.id) };
    } catch (error) {
      return sendScheduleError(reply, error);
    }
  });

  app.get("/api/maintenance", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return maintenance.snapshot();
  });

  app.post("/api/maintenance/run", async (_request, reply) => {
    try {
      return maintenance.run();
    } catch (error) {
      if (error instanceof MaintenanceError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message, run: error.run });
      }
      return reply.code(500).send({ error: "MAINTENANCE_FAILED", message: "维护任务失败" });
    }
  });

  app.get("/api/diagnostics", async (_request, reply) => {
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header("cache-control", "no-store");
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="hearth-diagnostics-${stamp}.json"`);
    return diagnostics.snapshot();
  });

  const systemStatus = () => {
    const tasks = service.listTasks();
    return {
      running: scheduler?.running ?? false,
      schedulerEnabled: Boolean(scheduler),
      queued: tasks.filter((task) => task.status === "queued").length,
      runningTasks: tasks.filter((task) => task.status === "running").length,
      waitingApproval: tasks.filter((task) => task.status === "waiting_approval").length,
      killSwitch: security.state().killSwitch
    };
  };

  app.get("/api/security", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return security.snapshot();
  });

  app.post("/api/security/kill-switch", async (request, reply) => {
    const parsed = killSwitchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_KILL_SWITCH", message: "全局停止参数不正确" });
    const state = security.setKillSwitch(parsed.data.enabled, parsed.data.reason);
    if (state.killSwitch) {
      await scheduler?.stop();
      desktop.freezeAll("全局停止已启用");
      for (const task of service.store.listTasks()) {
        if (task.status !== "waiting_approval") continue;
        approvals.expireForTask(task.id);
        service.updateTask(task.id, {
          status: "recoverable",
          currentRunId: task.currentRunId,
          nextAction: "全局停止已启用，审批已取消",
          error: {
            kind: "kill_switch",
            message: "全局停止已启用，外部动作被拒绝",
            recoverable: true,
            guidance: "确认安全后关闭全局停止，再重新执行任务"
          }
        }, task.currentRunId ?? undefined);
      }
    }
    return security.snapshot();
  });

  app.get("/api/system", async () => systemStatus());

  app.post("/api/system/stop", async (_request, reply) => {
    if (!scheduler) {
      return reply.code(409).send({ error: "SCHEDULER_DISABLED", message: "执行器未启用，无需停止" });
    }
    await scheduler.stop();
    return systemStatus();
  });

  app.post("/api/system/start", async (_request, reply) => {
    if (!scheduler) {
      return reply.code(409).send({ error: "SCHEDULER_DISABLED", message: "执行器未启用" });
    }
    if (security.state().killSwitch) {
      return reply.code(423).send({ error: "KILL_SWITCH_ACTIVE", message: "全局停止启用期间不能恢复执行器" });
    }
    scheduler.start();
    return systemStatus();
  });

  app.get("/api/proactive", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return proactive.snapshot();
  });

  app.post("/api/proactive/scan", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return proactive.scan();
  });

  app.patch("/api/proactive/settings", async (request, reply) => {
    const parsed = proactiveSettingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_PROACTIVE_SETTINGS", message: "主动设置参数不正确" });
    try {
      return proactive.updateSettings(definedObject(parsed.data) as Parameters<ProactiveService["updateSettings"]>[0]);
    } catch (error) {
      return sendProactiveError(reply, error);
    }
  });

  app.post("/api/proactive/pause", async (request, reply) => {
    const parsed = proactivePauseSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_PAUSE", message: "暂停参数不正确" });
    try {
      return proactive.pause(definedObject(parsed.data) as Parameters<ProactiveService["pause"]>[0]);
    } catch (error) {
      return sendProactiveError(reply, error);
    }
  });

  for (const action of ["accept", "convert"] as const) {
    app.post<{ Params: { id: string } }>("/api/suggestions/:id/" + action, async (request, reply) => {
      const parsed = suggestionActionSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "INVALID_SUGGESTION_ACTION", message: "建议动作参数不正确" });
      try {
        const input: { title?: string; goal?: string; textInput?: string } = {};
        if (parsed.data.title !== undefined) input.title = parsed.data.title;
        if (parsed.data.goal !== undefined) input.goal = parsed.data.goal;
        if (parsed.data.textInput !== undefined) input.textInput = parsed.data.textInput;
        return action === "accept" ? proactive.accept(request.params.id) : proactive.convert(request.params.id, input);
      } catch (error) {
        return sendProactiveError(reply, error);
      }
    });
  }

  app.post<{ Params: { id: string } }>("/api/suggestions/:id/ignore", async (request, reply) => {
    try {
      return proactive.ignore(request.params.id);
    } catch (error) {
      return sendProactiveError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/suggestions/:id/snooze", async (request, reply) => {
    const parsed = suggestionSnoozeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SNOOZE", message: "稍后提醒参数不正确" });
    try {
      return proactive.snooze(request.params.id, parsed.data.minutes);
    } catch (error) {
      return sendProactiveError(reply, error);
    }
  });

  app.get("/api/intents", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { intents: standingIntents.list(), budget: standingIntents.budget() };
  });

  app.post("/api/intents", async (request, reply) => {
    const parsed = standingIntentSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_INTENT", message: "意图参数不正确" });
    try {
      return reply.code(201).send(standingIntents.create(definedObject(parsed.data) as unknown as Parameters<StandingIntentService["create"]>[0]));
    } catch (error) {
      return sendStandingIntentError(reply, error);
    }
  });

  app.post("/api/intents/match", async (request, reply) => {
    const parsed = intentMatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_INTENT_MATCH", message: "意图匹配参数不正确" });
    try {
      const matches = standingIntents.match(definedObject(parsed.data) as unknown as Parameters<StandingIntentService["match"]>[0]);
      return { matches, intents: matches.map((match) => match.intent), attention: matches.map((match) => match.attention) };
    } catch (error) {
      return sendStandingIntentError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/intents/:id/arm", async (request, reply) => {
    try {
      return standingIntents.arm(request.params.id);
    } catch (error) {
      return sendStandingIntentError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/intents/:id/cancel", async (request, reply) => {
    try {
      return standingIntents.cancel(request.params.id);
    } catch (error) {
      return sendStandingIntentError(reply, error);
    }
  });

  app.get("/api/attention", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return {
      items: attentionGovernor.list(standingIntents.queue()),
      budget: standingIntents.budget(),
      governor: attentionGovernor.settings()
    };
  });

  app.get<{ Params: { id: string } }>("/api/attention/:id/explain", async (request, reply) => {
    const explanation = attentionGovernor.explain(request.params.id);
    if (!explanation) return reply.code(404).send({ error: "ATTENTION_NOT_FOUND", message: "注意力事项不存在" });
    return explanation;
  });

  app.post<{ Params: { id: string } }>("/api/attention/:id/feedback", async (request, reply) => {
    const parsed = z.object({
      action: z.enum(["accept", "ignore", "snooze", "resolve", "wrong"]),
      channel: z.string().trim().max(80).optional(),
      note: z.string().trim().max(500).optional()
    }).strict().safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_ATTENTION_FEEDBACK", message: "反馈格式不正确" });
    try {
      return attentionGovernor.feedback(request.params.id, definedObject(parsed.data) as unknown as Parameters<AttentionGovernor["feedback"]>[1]);
    } catch (error) {
      if (error instanceof Error && error.message === "ATTENTION_NOT_FOUND") {
        return reply.code(404).send({ error: "ATTENTION_NOT_FOUND", message: "注意力事项不存在" });
      }
      throw error;
    }
  });

  app.patch("/api/attention/governor", async (request, reply) => {
    const parsed = z.object({
      shadowMode: z.boolean().optional(),
      minFeedbackSamples: z.number().int().min(20).max(500).optional()
    }).strict().safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_ATTENTION_GOVERNOR", message: "注意力治理设置不正确" });
    return attentionGovernor.updateSettings(definedObject(parsed.data) as Parameters<AttentionGovernor["updateSettings"]>[0]);
  });

  app.patch("/api/attention/settings", async (request, reply) => {
    const parsed = attentionBudgetSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_ATTENTION_BUDGET", message: "注意力预算设置不正确" });
    try {
      return standingIntents.updateBudget(definedObject(parsed.data) as unknown as Parameters<StandingIntentService["updateBudget"]>[0]);
    } catch (error) {
      return sendStandingIntentError(reply, error);
    }
  });

  for (const action of ["ack", "ignore", "resolve"] as const) {
    app.post<{ Params: { id: string } }>("/api/attention/:id/" + action, async (request, reply) => {
      try {
        if (action === "ack") return standingIntents.acknowledge(request.params.id);
        if (action === "ignore") return standingIntents.ignore(request.params.id);
        return standingIntents.resolve(request.params.id);
      } catch (error) {
        return sendStandingIntentError(reply, error);
      }
    });
  }

  app.post<{ Params: { id: string } }>("/api/attention/:id/snooze", async (request, reply) => {
    const parsed = attentionSnoozeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_ATTENTION_SNOOZE", message: "稍后提醒参数不正确" });
    try {
      return standingIntents.snooze(request.params.id, parsed.data.minutes);
    } catch (error) {
      return sendStandingIntentError(reply, error);
    }
  });

  app.get<{ Querystring: { query?: string; kind?: string; limit?: string } }>("/api/ontology/entities", async (request) => {
    const queryText = (request.query.query ?? "").trim().toLowerCase();
    const kind = (request.query.kind ?? "").trim();
    const limit = Math.max(1, Math.min(500, Number(request.query.limit ?? 100) || 100));
    const entities = service.store.listEntities({ ...(kind ? { kind } : {}), status: "active", limit: 2000 })
      .filter((entity) => !queryText || entity.canonicalName.toLowerCase().includes(queryText) || entity.id.toLowerCase().includes(queryText))
      .slice(0, limit)
      .map((entity) => ({
        ...entity,
        states: service.store.listEntityStates({ entityId: entity.id, activeOnly: true, limit: 30 }),
        aliases: service.store.listEntityAliases(entity.id)
      }));
    return { entities };
  });

  app.get<{ Querystring: { status?: string; limit?: string } }>("/api/ontology/commitments", async (request) => {
    const limit = Math.max(1, Math.min(500, Number(request.query.limit ?? 100) || 100));
    return { commitments: service.store.listCommitments({ status: request.query.status ?? "open", limit }) };
  });

  app.get<{ Querystring: { status?: string; limit?: string } }>("/api/ontology/decisions", async (request) => {
    const limit = Math.max(1, Math.min(500, Number(request.query.limit ?? 100) || 100));
    return { decisions: service.store.listDecisions({ status: request.query.status ?? "active", limit }) };
  });

  app.post<{ Params: { id: string } }>("/api/ontology/entities/:id/correct", async (request, reply) => {
    const parsed = z.object({
      key: z.string().trim().min(1).max(120),
      value: z.unknown(),
      evidenceRef: z.string().trim().min(1).max(500).optional()
    }).strict().safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_ONTOLOGY_CORRECTION", message: "纠正内容格式不正确" });
    if (!service.store.getEntity(request.params.id)) return reply.code(404).send({ error: "ENTITY_NOT_FOUND", message: "实体不存在" });
    return ontologyWriter.userCorrects({
      entityId: request.params.id,
      key: parsed.data.key,
      value: parsed.data.value,
      evidenceRef: parsed.data.evidenceRef ?? `user-correction:${request.params.id}:${Date.now()}`
    });
  });

  app.post("/api/ontology/forget", async (request, reply) => {
    const parsed = z.object({ evidenceRef: z.string().trim().min(1).max(500) }).strict().safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_ONTOLOGY_FORGET", message: "遗忘请求格式不正确" });
    return ontologyWriter.forget(parsed.data.evidenceRef);
  });

  app.get("/api/heartbeat", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const limit = Number((request.query as { limit?: string } | undefined)?.limit ?? 50);
    return {
      runs: standingIntents.listHeartbeatRuns(Number.isInteger(limit) ? Math.max(1, Math.min(limit, 500)) : 50),
      last: standingIntents.latestHeartbeatRun()
    };
  });

  app.post("/api/heartbeat/run", async (request, reply) => {
    const parsed = heartbeatRunSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_HEARTBEAT", message: "心跳参数不正确" });
    try {
      return await standingIntents.heartbeat(definedObject(parsed.data) as unknown as Parameters<StandingIntentService["heartbeat"]>[0]);
    } catch (error) {
      return sendStandingIntentError(reply, error);
    }
  });

  app.get("/api/prepared-actions", async (request) => {
    const query = request.query as { taskId?: string; status?: string; limit?: string };
    return {
      actions: preparedActions.list({
        ...(query.taskId ? { taskId: query.taskId } : {}),
        ...(query.status ? { status: query.status } : {}),
        limit: query.limit ? Number(query.limit) : 100
      })
    };
  });

  app.post("/api/prepared-actions", async (request, reply) => {
    const body = definedObject((request.body ?? {}) as Record<string, unknown>);
    const kinds = new Set(["draft_email", "calendar_check", "research", "test_run", "diff"]);
    if (!kinds.has(String(body.kind))) {
      return reply.code(400).send({ error: "INVALID_PREPARED_ACTION", message: "预备动作类型不正确" });
    }
    try {
      return reply.code(201).send(preparedActions.prepare({
        ...(typeof body.taskId === "string" ? { taskId: body.taskId } : {}),
        ...(typeof body.goalId === "string" ? { goalId: body.goalId } : {}),
        kind: String(body.kind) as Parameters<PreparedActionService["prepare"]>[0]["kind"],
        preview: body.preview && typeof body.preview === "object" ? body.preview as Record<string, unknown> : {},
        evidenceRefs: Array.isArray(body.evidenceRefs) ? body.evidenceRefs.filter((ref): ref is string => typeof ref === "string") : [],
        ...(typeof body.expiresAt === "string" ? { expiresAt: body.expiresAt } : {})
      }));
    } catch (error) {
      return reply.code((error as { statusCode?: number }).statusCode ?? 400).send({
        error: (error as { code?: string }).code ?? "PREPARED_ACTION_FAILED",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post<{ Params: { id: string } }>("/api/prepared-actions/:id/commit", async (request, reply) => {
    const body = definedObject((request.body ?? {}) as Record<string, unknown>);
    try {
      return preparedActions.commit(request.params.id, {
        ...(typeof body.approvalRef === "string" ? { approvalRef: body.approvalRef } : {})
      });
    } catch (error) {
      return reply.code((error as { statusCode?: number }).statusCode ?? 400).send({
        error: (error as { code?: string }).code ?? "PREPARED_ACTION_FAILED",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post<{ Params: { id: string } }>("/api/prepared-actions/:id/discard", async (request, reply) => {
    try {
      return preparedActions.discard(request.params.id);
    } catch (error) {
      return reply.code((error as { statusCode?: number }).statusCode ?? 400).send({
        error: (error as { code?: string }).code ?? "PREPARED_ACTION_FAILED",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/api/background-tools", async (request) => {
    const query = request.query as { taskId?: string; status?: string; limit?: string };
    return {
      jobs: backgroundTools.list({
        ...(query.taskId ? { taskId: query.taskId } : {}),
        ...(query.status ? { status: query.status } : {}),
        limit: query.limit ? Number(query.limit) : 100
      })
    };
  });

  app.post("/api/background-tools", async (request, reply) => {
    const body = definedObject((request.body ?? {}) as Record<string, unknown>);
    try {
      return reply.code(202).send(await backgroundTools.start({
        taskId: String(body.taskId ?? ""),
        toolName: String(body.toolName ?? ""),
        ...(typeof body.runId === "string" ? { runId: body.runId } : {}),
        args: body.args && typeof body.args === "object" ? body.args as Record<string, unknown> : {},
        ...(typeof body.timeoutMs === "number" ? { timeoutMs: body.timeoutMs } : {})
      }));
    } catch (error) {
      return reply.code((error as { statusCode?: number }).statusCode ?? 400).send({
        error: (error as { code?: string }).code ?? "BACKGROUND_TOOL_FAILED",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post<{ Params: { id: string } }>("/api/background-tools/:id/stop", async (request, reply) => {
    const body = definedObject((request.body ?? {}) as Record<string, unknown>);
    try {
      return backgroundTools.stop(request.params.id, typeof body.reason === "string" ? body.reason : undefined);
    } catch (error) {
      return reply.code((error as { statusCode?: number }).statusCode ?? 400).send({
        error: (error as { code?: string }).code ?? "BACKGROUND_TOOL_FAILED",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/api/thread-subscriptions/deliveries", async (request) => {
    const query = request.query as { limit?: string };
    return { deliveries: threadSubscriptions.recentDeliveries(query.limit ? Number(query.limit) : 50) };
  });

  app.get("/api/thread-subscriptions", async (request) => {
    const query = request.query as { threadKey?: string; taskId?: string; status?: string };
    return {
      subscriptions: threadSubscriptions.list({
        ...(query.threadKey ? { threadKey: query.threadKey } : {}),
        ...(query.taskId ? { taskId: query.taskId } : {}),
        ...(query.status ? { status: query.status } : {})
      })
    };
  });

  app.post("/api/thread-subscriptions", async (request, reply) => {
    const body = definedObject((request.body ?? {}) as Record<string, unknown>);
    try {
      return reply.code(201).send(threadSubscriptions.subscribe({
        threadKey: String(body.threadKey ?? ""),
        taskId: String(body.taskId ?? ""),
        ...(typeof body.runId === "string" ? { runId: body.runId } : {}),
        filter: body.filter && typeof body.filter === "object" ? body.filter as Record<string, unknown> : {}
      }));
    } catch (error) {
      return reply.code((error as { statusCode?: number }).statusCode ?? 400).send({
        error: (error as { code?: string }).code ?? "THREAD_SUBSCRIPTION_FAILED",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  for (const action of ["pause", "resume", "end"] as const) {
    app.post<{ Params: { id: string } }>(`/api/thread-subscriptions/:id/${action}`, async (request, reply) => {
      try {
        return threadSubscriptions[action](request.params.id);
      } catch (error) {
        return reply.code((error as { statusCode?: number }).statusCode ?? 400).send({
          error: (error as { code?: string }).code ?? "THREAD_SUBSCRIPTION_FAILED",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }

  app.get("/api/watchdog", async (request) => {
    const query = request.query as { limit?: string };
    return {
      settings: watchdog.settings(),
      events: store.listWatchdogEvents({ limit: query.limit ? Number(query.limit) : 100 })
    };
  });

  app.post("/api/watchdog/scan", async () => ({ events: watchdog.scan(), settings: watchdog.settings() }));

  app.patch("/api/watchdog/settings", async (request, reply) => {
    const body = definedObject((request.body ?? {}) as Record<string, unknown>);
    try {
      return watchdog.updateSettings(body as Parameters<WatchdogService["updateSettings"]>[0]);
    } catch (error) {
      return reply.code(400).send({ error: "INVALID_WATCHDOG_SETTINGS", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/intake/decisions", async (request) => {
    const query = request.query as { limit?: string };
    return { decisions: intake.list(query.limit ? Number(query.limit) : 100) };
  });

  app.post("/api/intake/route", async (request, reply) => {
    const body = definedObject((request.body ?? {}) as Record<string, unknown>);
    try {
      return intake.route({
        sourceRef: String(body.sourceRef ?? ""),
        text: String(body.text ?? ""),
        ...(typeof body.sender === "string" ? { sender: body.sender } : {}),
        ...(typeof body.channel === "string" ? { channel: body.channel } : {})
      });
    } catch (error) {
      return reply.code(400).send({ error: "INVALID_INTAKE_INPUT", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/memory", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return memory.snapshot();
  });

  app.patch("/api/memory/settings", async (request, reply) => {
    const parsed = memorySettingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MEMORY_SETTINGS", message: "记忆设置参数不正确" });
    try {
      return memory.updateSettings(definedObject(parsed.data) as Parameters<MemoryService["updateSettings"]>[0]);
    } catch (error) {
      return sendMemoryError(reply, error);
    }
  });

  app.post("/api/memory", async (request, reply) => {
    const parsed = createMemorySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MEMORY", message: "记忆参数不正确" });
    try {
      return reply.code(201).send(memory.create(definedObject(parsed.data) as unknown as Parameters<MemoryService["create"]>[0]));
    } catch (error) {
      return sendMemoryError(reply, error);
    }
  });

  app.post("/api/memory/recall", async (request, reply) => {
    const parsed = memoryRecallSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MEMORY_RECALL", message: "记忆召回参数不正确" });
    try {
      return memory.recall(definedObject(parsed.data) as unknown as Parameters<MemoryService["recall"]>[0]);
    } catch (error) {
      return sendMemoryError(reply, error);
    }
  });

  app.post("/api/memory/capture", async (request, reply) => {
    const parsed = memoryCaptureSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MEMORY_CAPTURE", message: "经历捕获参数不正确" });
    try {
      return { memory: memory.captureExperience(parsed.data.taskId) };
    } catch (error) {
      return sendMemoryError(reply, error);
    }
  });

  app.post("/api/memory/consolidate", async (request, reply) => {
    const parsed = memoryConsolidationSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MEMORY_CONSOLIDATION", message: "记忆巩固参数不正确" });
    try {
      return memory.consolidate(parsed.data);
    } catch (error) {
      return sendMemoryError(reply, error);
    }
  });

  app.post("/api/memory/forget-source", async (request, reply) => {
    const parsed = memoryForgetSourceSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MEMORY_FORGET_SOURCE", message: "来源遗忘参数不正确" });
    try {
      return memory.forgetSource(parsed.data);
    } catch (error) {
      return sendMemoryError(reply, error);
    }
  });

  app.get("/api/memory/export", async (_request, reply) => {
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", "attachment; filename=\"hearth-memories-" + stamp + ".json\"");
    return memory.exportData();
  });

  app.get<{ Params: { id: string } }>("/api/memory/:id/explain", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      return memory.explain(request.params.id);
    } catch (error) {
      return sendMemoryError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/memory/:id/forget-preview", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      return memory.previewForget(request.params.id);
    } catch (error) {
      return sendMemoryError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/memory/:id", async (request, reply) => {
    const parsed = correctMemorySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MEMORY_CORRECTION", message: "记忆纠正参数不正确" });
    try {
      return memory.correct(request.params.id, definedObject(parsed.data) as unknown as Parameters<MemoryService["correct"]>[1]);
    } catch (error) {
      return sendMemoryError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/memory/:id/confirm", async (request, reply) => {
    try {
      return memory.confirm(request.params.id);
    } catch (error) {
      return sendMemoryError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/memory/:id/forget", async (request, reply) => {
    try {
      return memory.forget(request.params.id);
    } catch (error) {
      return sendMemoryError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/memory/:id/sensitive", async (request, reply) => {
    const parsed = memorySensitiveSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MEMORY_SENSITIVITY", message: "敏感度参数不正确" });
    try {
      return memory.markSensitive(request.params.id, parsed.data.sensitivity, parsed.data.allowRecall);
    } catch (error) {
      return sendMemoryError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/memory/conflicts/:id/resolve", async (request, reply) => {
    const parsed = memoryConflictResolveSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MEMORY_CONFLICT", message: "冲突解决参数不正确" });
    try {
      return memory.resolveConflict(request.params.id, parsed.data.resolution, parsed.data.note, parsed.data.content);
    } catch (error) {
      return sendMemoryError(reply, error);
    }
  });

  app.get("/api/methods/settings", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { settings: methods.settings() };
  });

  app.patch("/api/methods/settings", async (request, reply) => {
    const parsed = methodSettingsPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_METHOD_SETTINGS", message: "方法设置格式不正确" });
    }
    try {
      return { settings: methods.updateSettings(parsed.data) };
    } catch (error) {
      return sendMethodError(reply, error);
    }
  });

  app.get("/api/methods", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return methods.snapshot();
  });

  app.post("/api/methods/generate", async (request, reply) => {
    const parsed = generateMethodSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_METHOD_GENERATE", message: "生成候选方法的参数不正确" });
    try {
      return reply.code(201).send(methods.generateFromTask(parsed.data.taskId, definedObject({ name: parsed.data.name, summary: parsed.data.summary })));
    } catch (error) {
      return sendMethodError(reply, error);
    }
  });

  app.post("/api/methods", async (request, reply) => {
    const parsed = createMethodSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_METHOD", message: "候选方法参数不正确" });
    try {
      return reply.code(201).send(methods.create(definedObject(parsed.data) as unknown as Parameters<MethodService["create"]>[0]));
    } catch (error) {
      return sendMethodError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/methods/:id/evaluate", async (request, reply) => {
    const parsed = evaluateMethodSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_METHOD_EVALUATION", message: "方法评估参数不正确" });
    try {
      return methods.evaluate(request.params.id, definedObject(parsed.data) as unknown as Parameters<MethodService["evaluate"]>[1]);
    } catch (error) {
      return sendMethodError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/methods/:id/pairing", async (request, reply) => {
    try {
      return methods.pairingSuggestion(request.params.id);
    } catch (error) {
      return sendMethodError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/methods/:id/trials", async (request, reply) => {
    const parsed = methodTrialSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_METHOD_TRIAL", message: "试跑样本参数不正确" });
    try {
      return methods.recordTrial(request.params.id, parsed.data.taskId);
    } catch (error) {
      return sendMethodError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/methods/:id/promote", async (request, reply) => {
    try {
      return methods.promote(request.params.id);
    } catch (error) {
      return sendMethodError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/methods/:id/rollback", async (request, reply) => {
    const parsed = methodRollbackSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_METHOD_ROLLBACK", message: "回退参数不正确" });
    try {
      return methods.rollback(request.params.id, parsed.data.reason);
    } catch (error) {
      return sendMethodError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/methods/:id/reject", async (request, reply) => {
    const parsed = methodRejectSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_METHOD_REJECT", message: "拒绝参数不正确" });
    try {
      return methods.reject(request.params.id, parsed.data.reason);
    } catch (error) {
      return sendMethodError(reply, error);
    }
  });

  app.get("/api/skills", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return skills.snapshot();
  });

  app.post("/api/skills/export", async (request, reply) => {
    const parsed = skillExportSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SKILL_EXPORT", message: "技能导出参数不正确" });
    try {
      const exported = skills.exportMethod(parsed.data.methodId);
      return reply.code(201).send({ package: exported, skill: skills.getSkill(exported.id) });
    } catch (error) {
      return sendSkillError(reply, error);
    }
  });

  app.post("/api/skills/import", async (request, reply) => {
    const parsed = skillImportSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SKILL_IMPORT", message: "技能导入参数不正确" });
    try {
      const imported = skills.importPackage(parsed.data.content, parsed.data.origin ?? "imported");
      return reply.code(201).send(imported);
    } catch (error) {
      return sendSkillError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/skills/:id/permissions", async (request, reply) => {
    const parsed = skillPermissionQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SKILL_PERMISSION_QUERY", message: "技能权限查询参数不正确" });
    try {
      return {
        effective: skills.effectivePermissions(request.params.id, parsed.data.taskId),
        changes: skills.permissionChanges(request.params.id)
      };
    } catch (error) {
      return sendSkillError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/skills/:id/trials", async (request, reply) => {
    const parsed = skillTrialSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SKILL_TRIAL", message: "技能试跑参数不正确" });
    try {
      return skills.setTrialTasks(request.params.id, parsed.data.taskIds);
    } catch (error) {
      return sendSkillError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/skills/:id/check", async (request, reply) => {
    const parsed = skillCheckSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SKILL_CHECK", message: "技能执行检查参数不正确" });
    try {
      const permissionRequest = {
        ...(parsed.data.readPaths ? { readPaths: parsed.data.readPaths } : {}),
        ...(parsed.data.writePaths ? { writePaths: parsed.data.writePaths } : {}),
        ...(parsed.data.networkHosts ? { networkHosts: parsed.data.networkHosts } : {}),
        ...(parsed.data.tools ? { tools: parsed.data.tools } : {})
      };
      return skills.checkExecution(request.params.id, parsed.data.taskId, permissionRequest, {
        allowImported: parsed.data.allowImported === true
      });
    } catch (error) {
      return sendSkillError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/skills/:id/authorize", async (request, reply) => {
    const parsed = skillCheckSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SKILL_AUTHORIZE", message: "技能授权参数不正确" });
    try {
      const permissionRequest = {
        ...(parsed.data.readPaths ? { readPaths: parsed.data.readPaths } : {}),
        ...(parsed.data.writePaths ? { writePaths: parsed.data.writePaths } : {}),
        ...(parsed.data.networkHosts ? { networkHosts: parsed.data.networkHosts } : {}),
        ...(parsed.data.tools ? { tools: parsed.data.tools } : {})
      };
      return skills.assertExecution(request.params.id, parsed.data.taskId, permissionRequest, {
        allowImported: parsed.data.allowImported === true
      });
    } catch (error) {
      return sendSkillError(reply, error);
    }
  });

  app.get("/api/skills/usage", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const skillId = typeof (request.query as { skillId?: unknown } | undefined)?.skillId === "string"
      ? String((request.query as { skillId: string }).skillId)
      : undefined;
    return { usage: skills.snapshot().skills.length ? store.listSkillUsage(skillId, 200) : [] };
  });

  app.get("/api/skills/curator", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return skillCurator.snapshot();
  });

  app.post("/api/skills/curator/run", async (request, reply) => {
    const parsed = skillCuratorRunSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SKILL_CURATOR_RUN", message: "Curator 参数不正确" });
    return skillCurator.run({ dryRun: parsed.data.dryRun === true });
  });

  app.post("/api/skills/curator/rollback", async (request, reply) => {
    const parsed = skillCuratorRollbackSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SKILL_CURATOR_ROLLBACK", message: "Curator 回滚参数不正确" });
    try {
      return skillCurator.rollback(parsed.data.runId);
    } catch (error) {
      return reply.code(409).send({ error: "SKILL_CURATOR_ROLLBACK_FAILED", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/skills/:id/usage", async (request, reply) => {
    const parsed = skillUsageSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SKILL_USAGE", message: "技能使用记录参数不正确" });
    try {
      return skills.recordUsage({
        skillId: request.params.id,
        taskId: parsed.data.taskId ?? null,
        runId: parsed.data.runId ?? null,
        status: parsed.data.status,
        ...(parsed.data.source ? { source: parsed.data.source } : {}),
        ...(parsed.data.note ? { note: parsed.data.note } : {})
      });
    } catch (error) {
      return sendSkillError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/skills/:id", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      const skill = skills.getSkill(request.params.id);
      if (!skill) return reply.code(404).send({ error: "SKILL_NOT_FOUND", message: "技能不存在" });
      return {
        skill,
        document: skills.readDocument(request.params.id),
        resources: skills.readResources(request.params.id),
        versions: skills.versions(request.params.id)
      };
    } catch (error) {
      return sendSkillError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/skills/:id/pin", async (request, reply) => {
    const parsed = skillPinSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SKILL_PIN", message: "技能固定参数不正确" });
    try {
      return skills.pin(request.params.id, parsed.data.pinned);
    } catch (error) {
      return sendSkillError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/skills/:id/archive", async (request, reply) => {
    const parsed = skillArchiveSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SKILL_ARCHIVE", message: "技能归档参数不正确" });
    try {
      return skills.archive(request.params.id, parsed.data.reason ?? "用户归档");
    } catch (error) {
      return sendSkillError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/skills/:id/restore", async (request, reply) => {
    try {
      return skills.restore(request.params.id);
    } catch (error) {
      return sendSkillError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/skills/:id/status", async (request, reply) => {
    const parsed = skillTransitionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SKILL_STATUS", message: "技能状态参数不正确" });
    try {
      return skills.transition(request.params.id, parsed.data.status, parsed.data.reason ?? "");
    } catch (error) {
      return sendSkillError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/skills/:id/used", async (request, reply) => {
    try {
      const parsed = skillUsageSchema.partial().safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "INVALID_SKILL_USAGE", message: "技能使用记录参数不正确" });
      return skills.markUsed(request.params.id, {
        taskId: parsed.data.taskId ?? null,
        runId: parsed.data.runId ?? null,
        ...(parsed.data.source ? { source: parsed.data.source } : {})
      });
    } catch (error) {
      return sendSkillError(reply, error);
    }
  });

  app.get("/api/sync", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return sync.snapshot();
  });

  app.post("/api/sync/peers", async (request, reply) => {
    const parsed = createSyncPeerSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SYNC_PEER", message: "同步对端参数不正确" });
    try {
      return reply.code(201).send(sync.createPeer(definedObject(parsed.data) as unknown as Parameters<SyncService["createPeer"]>[0]));
    } catch (error) {
      return sendSyncError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/sync/peers/:id/pull", async (request, reply) => {
    try {
      return await sync.pull(request.params.id);
    } catch (error) {
      return sendSyncError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/sync/peers/:id/rotate", async (request, reply) => {
    try {
      return sync.rotatePeerToken(request.params.id);
    } catch (error) {
      return sendSyncError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/sync/peers/:id/revoke", async (request, reply) => {
    try {
      return sync.revokePeer(request.params.id);
    } catch (error) {
      return sendSyncError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/sync/conflicts/:id/resolve", async (request, reply) => {
    const parsed = syncConflictResolveSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SYNC_CONFLICT", message: "同步冲突处理参数不正确" });
    try {
      return sync.resolveConflict(request.params.id, parsed.data.resolution);
    } catch (error) {
      return sendSyncError(reply, error);
    }
  });

  app.get<{ Querystring: Record<string, string> }>("/api/sync/events", async (request, reply) => {
    const parsed = syncExportSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SYNC_CURSOR", message: "同步 cursor 参数不正确" });
    try {
      sync.authenticateInbound(syncBearerToken(request.headers.authorization));
      reply.header("cache-control", "no-store");
      return sync.exportEvents(parsed.data.after, parsed.data.limit);
    } catch (error) {
      return sendSyncError(reply, error);
    }
  });

  app.post("/api/connections", async (request, reply) => {
    const parsed = createConnectionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_CONNECTION", message: "连接参数不正确" });
    try {
      return reply.code(201).send(connections.connect(parsed.data));
    } catch (error) {
      return sendConnectionError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/connections/:id/status", async (request, reply) => {
    try {
      reply.header("cache-control", "no-store");
      return connections.status(request.params.id);
    } catch (error) {
      return sendConnectionError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/connections/:id/heartbeat", async (request, reply) => {
    const parsed = connectionGenerationSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_CONNECTION_GENERATION", message: "缺少有效的连接代次" });
    try {
      return connections.heartbeat(request.params.id, parsed.data.generation);
    } catch (error) {
      return sendConnectionError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/connections/:id/disconnect", async (request, reply) => {
    const parsed = disconnectConnectionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_CONNECTION_GENERATION", message: "断开连接需要有效的连接代次" });
    try {
      return connections.disconnect(request.params.id, parsed.data.generation, parsed.data.reason);
    } catch (error) {
      return sendConnectionError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/connections/:id/reconnect", async (request, reply) => {
    const parsed = reconnectConnectionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_CONNECTION_RECONNECT", message: "重连参数不正确" });
    try {
      return connections.reconnect(request.params.id, parsed.data);
    } catch (error) {
      return sendConnectionError(reply, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>("/api/connections/:id/projection", async (request, reply) => {
    const parsed = connectionProjectionQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_PROJECTION", message: "离线投影参数不正确" });
    try {
      reply.header("cache-control", "no-store");
      return connections.projection(request.params.id, parsed.data.scope, parsed.data.generation);
    } catch (error) {
      return sendConnectionError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/connections/:id/outbox", async (request, reply) => {
    try {
      reply.header("cache-control", "no-store");
      return { items: connections.listOutbox(request.params.id) };
    } catch (error) {
      return sendConnectionError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/connections/:id/outbox", async (request, reply) => {
    const parsed = connectionOutboxSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_CONNECTION_OUTBOX", message: "离线操作参数不正确" });
    try {
      return reply.code(201).send(connections.enqueue(request.params.id, parsed.data));
    } catch (error) {
      return sendConnectionError(reply, error);
    }
  });

  app.post<{ Params: { id: string; itemId: string } }>("/api/connections/:id/outbox/:itemId/submit", async (request, reply) => {
    const parsed = connectionGenerationSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_CONNECTION_GENERATION", message: "提交离线操作需要有效的连接代次" });
    try {
      return connections.submit(request.params.id, request.params.itemId, parsed.data.generation);
    } catch (error) {
      return sendConnectionError(reply, error);
    }
  });

  app.post<{ Params: { id: string; itemId: string } }>("/api/connections/:id/outbox/:itemId/resolve", async (request, reply) => {
    const parsed = connectionOutboxResolveSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_OUTBOX_RESOLUTION", message: "对账参数不正确" });
    try {
      return connections.resolveOutbox(request.params.id, request.params.itemId, parsed.data);
    } catch (error) {
      return sendConnectionError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/connections/:id/scopes", async (request, reply) => {
    const parsed = connectionScopesSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_CONNECTION_SCOPES", message: "能力扩权参数不正确" });
    try {
      return connections.approveScopes(request.params.id, parsed.data.scopes);
    } catch (error) {
      return sendConnectionError(reply, error);
    }
  });

  app.get("/api/templates", async () => ({ templates: service.listTemplates() }));

  app.get("/api/sources", async () => ({ sources: sources.list() }));

  app.post("/api/sources", async (request, reply) => {
    const parsed = createSourceSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SOURCE", message: "来源参数不正确" });
    try {
      return reply.code(201).send(sources.create(parsed.data));
    } catch (error) {
      return sendSourceError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/sources/:id/items", async (request, reply) => {
    try {
      return { items: sources.items(request.params.id) };
    } catch (error) {
      return sendSourceError(reply, error);
    }
  });

  app.get<{ Params: { id: string; itemId: string } }>("/api/sources/:id/items/:itemId/content", async (request, reply) => {
    try {
      const item = sources.getItem(request.params.itemId);
      if (item.sourceId !== request.params.id) {
        return reply.code(404).send({ error: "SOURCE_ITEM_NOT_FOUND", message: "来源条目不存在" });
      }
      reply.header("content-type", "text/plain; charset=utf-8");
      return sources.readItemContent(item.id);
    } catch (error) {
      return sendSourceError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/sources/:id/read", async (request, reply) => {
    const parsed = readSourceSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_READ_REQUEST", message: "读取参数不正确" });
    try {
      return await sources.read(request.params.id, parsed.data);
    } catch (error) {
      return sendSourceError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/sources/:id/disconnect", async (request, reply) => {
    try {
      return sources.disconnect(request.params.id);
    } catch (error) {
      return sendSourceError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/sources/:id/reconnect", async (request, reply) => {
    try {
      return sources.reconnect(request.params.id);
    } catch (error) {
      return sendSourceError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/sources/:id/clear", async (request, reply) => {
    try {
      return sources.clear(request.params.id);
    } catch (error) {
      return sendSourceError(reply, error);
    }
  });

  app.get<{ Querystring: Record<string, string> }>("/api/source-items", async (request, reply) => {
    const parsed = sourceItemQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalidQuery(reply);
    reply.header("cache-control", "no-store");
    return { items: store.listReadySourceItems(parsed.data.limit ?? 100) };
  });

  app.get("/api/outbox", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return {
      drafts: outbox.list().map((draft) => ({
        ...draft,
        effect: draft.effectId ? store.getEffect(draft.effectId) : null
      }))
    };
  });

  app.get<{ Params: { id: string } }>("/api/outbox/:id", async (request, reply) => {
    try {
      reply.header("cache-control", "no-store");
      const draft = outbox.get(request.params.id);
      return { ...draft, effect: draft.effectId ? store.getEffect(draft.effectId) : null };
    } catch (error) {
      return sendOutboxError(reply, error);
    }
  });

  app.post("/api/outbox", async (request, reply) => {
    const parsed = outboxDraftSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_OUTBOX_DRAFT", message: "发件箱草稿参数格式不正确" });
    }
    try {
      return reply.code(201).send(outbox.create(parsed.data));
    } catch (error) {
      return sendOutboxError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/outbox/:id", async (request, reply) => {
    const parsed = outboxDraftSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_OUTBOX_DRAFT", message: "发件箱草稿参数格式不正确" });
    }
    try {
      return outbox.update(request.params.id, parsed.data);
    } catch (error) {
      return sendOutboxError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/outbox/:id/discard", async (request, reply) => {
    try {
      return outbox.discard(request.params.id);
    } catch (error) {
      return sendOutboxError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/outbox/:id/submit", async (request, reply) => {
    try {
      return outbox.submit(request.params.id);
    } catch (error) {
      return sendOutboxError(reply, error);
    }
  });

  app.get("/api/desktop", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return desktop.dashboard();
  });

  app.get<{ Params: { id: string } }>("/api/desktop/sessions/:id", async (request, reply) => {
    try {
      reply.header("cache-control", "no-store");
      return desktop.sessionView(request.params.id);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post("/api/desktop/sessions", async (request, reply) => {
    const parsed = createDesktopSessionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SESSION", message: "创建设备会话的参数不正确" });
    try {
      return reply.code(201).send(desktop.createSession(parsed.data.deviceId, parsed.data.targetApp));
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/desktop/sessions/:id/observe", async (request, reply) => {
    const parsed = desktopObservationRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_OBSERVATION_REQUEST", message: "观察请求的参数不正确" });
    try {
      return reply.code(202).send(desktop.requestObservation(request.params.id, parsed.data.targetApp));
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  for (const action of ["pause", "resume", "takeover", "release", "terminate"] as const) {
    app.post<{ Params: { id: string } }>(`/api/desktop/sessions/:id/${action}`, async (request, reply) => {
      try {
        if (action === "pause") return desktop.pauseSession(request.params.id);
        if (action === "resume") return desktop.resumeSession(request.params.id);
        if (action === "takeover") return desktop.takeOverSession(request.params.id);
        if (action === "release") return desktop.releaseSession(request.params.id);
        return desktop.terminateSession(request.params.id);
      } catch (error) {
        return sendDesktopError(reply, error);
      }
    });
  }

  app.post<{ Params: { id: string } }>("/api/desktop/sessions/:id/actions", async (request, reply) => {
    const parsed = desktopActionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_DESKTOP_ACTION", message: "桌面动作不在低风险白名单内" });
    }
    try {
      return reply.code(202).send(desktop.enqueueAction(request.params.id, parsed.data));
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post("/api/device-pairings", async (request, reply) => {
    const parsed = pairingStartSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_PAIRING", message: "配对请求参数不正确" });
    }
    try {
      return reply.code(201).send(desktop.createPairingRequest(parsed.data));
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/device-pairings/:id", async (request, reply) => {
    const secret = headerValue(request.headers["x-pairing-secret"]);
    try {
      reply.header("cache-control", "no-store");
      return desktop.getPairingStatus(request.params.id, secret);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/devices/pairing-requests/:id/approve", async (request, reply) => {
    try {
      return desktop.approvePairing(request.params.id);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/devices/pairing-requests/:id/reject", async (request, reply) => {
    try {
      return desktop.rejectPairing(request.params.id);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post<{ Params: { id: string; kind: string } }>("/api/devices/:id/capabilities/:kind/approve", async (request, reply) => {
    const kind = z.enum(DEVICE_CAPABILITY_KINDS).safeParse(request.params.kind);
    const parsed = capabilityApprovalSchema.safeParse(request.body ?? {});
    if (!kind.success || !parsed.success) {
      return reply.code(400).send({ error: "INVALID_CAPABILITY_APPROVAL", message: "能力审批参数不正确" });
    }
    try {
      return desktop.approveCapability(request.params.id, kind.data, parsed.data.apps);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post<{ Params: { id: string; kind: string } }>("/api/devices/:id/capabilities/:kind/revoke", async (request, reply) => {
    const kind = z.enum(DEVICE_CAPABILITY_KINDS).safeParse(request.params.kind);
    if (!kind.success) return reply.code(400).send({ error: "INVALID_CAPABILITY", message: "设备能力类型不正确" });
    try {
      return desktop.revokeCapability(request.params.id, kind.data);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/devices/:id/revoke", async (request, reply) => {
    try {
      return desktop.revokeDevice(request.params.id);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/devices/:id/rotate-token", async (request, reply) => {
    try {
      return desktop.rotateDeviceToken(request.params.id);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.get<{ Params: { deviceId: string; frameId: string } }>("/api/devices/:deviceId/frames/:frameId", async (request, reply) => {
    try {
      const stored = desktop.readFrame(request.params.deviceId, request.params.frameId);
      reply.header("cache-control", "no-store, max-age=0");
      reply.header("content-type", stored.frame.mimeType);
      return reply.send(readFileSync(stored.absolutePath));
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post("/api/device/heartbeat", async (request, reply) => {
    try {
      const device = desktop.authenticateDevice(bearerToken(request.headers.authorization));
      reply.header("cache-control", "no-store");
      return desktop.deviceState(device.id);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.get("/api/device/state", async (request, reply) => {
    try {
      const device = desktop.authenticateDevice(bearerToken(request.headers.authorization));
      reply.header("cache-control", "no-store");
      return desktop.deviceState(device.id);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.get("/api/device/commands/next", async (request, reply) => {
    try {
      const device = desktop.authenticateDevice(bearerToken(request.headers.authorization));
      reply.header("cache-control", "no-store");
      return { command: desktop.nextCommand(device) };
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/device/commands/:id/result", async (request, reply) => {
    const parsed = commandResultSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_COMMAND_RESULT", message: "桌面命令结果格式不正确" });
    try {
      const device = desktop.authenticateDevice(bearerToken(request.headers.authorization));
      return desktop.completeCommand(device, request.params.id, parsed.data);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.post("/api/device/observations", async (request, reply) => {
    const parsed = observationSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_OBSERVATION", message: "桌面观察参数格式不正确" });
    try {
      const device = desktop.authenticateDevice(bearerToken(request.headers.authorization));
      return desktop.uploadObservation(device, parsed.data);
    } catch (error) {
      return sendDesktopError(reply, error);
    }
  });

  app.get("/api/export", async (_request, reply) => {
    const stamp = new Date().toISOString().slice(0, 10);
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="hearth-export-${stamp}.json"`);
    return service.exportSnapshot();
  });

  app.get("/api/backups", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return backups.snapshot();
  });

  app.post("/api/backups", async (request, reply) => {
    const parsed = createBackupSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_BACKUP", message: "备份口令至少需要 12 个字符" });
    }
    try {
      return reply.code(201).send(backups.create(parsed.data.passphrase));
    } catch (error) {
      return sendBackupFailure(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/backups/:id/download", async (request, reply) => {
    try {
      const { record, text } = backups.readEnvelope(request.params.id);
      reply.header("cache-control", "no-store");
      reply.header("content-type", "application/vnd.hearth.backup+json; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="hearth-backup-${record.createdAt.slice(0, 10)}.hearth-backup"`);
      return reply.send(Buffer.from(text, "utf8"));
    } catch (error) {
      return sendBackupFailure(reply, error);
    }
  });

  const restore = async (operation: () => ReturnType<BackupService["restoreRecord"]>) => {
    const schedulerWasRunning = scheduler?.running ?? false;
    if (schedulerWasRunning) await scheduler?.stop();
    try {
      const result = operation();
      sync.reloadSecrets();
      security.record(
        "backup.restored",
        null,
        null,
        `已从 schema ${result.schemaVersion} 加密归档恢复；来源实例 ${result.sourceInstanceId}`
      );
      return { ...result, schedulerStopped: schedulerWasRunning };
    } catch (error) {
      if (schedulerWasRunning && !security.state().killSwitch) scheduler?.start();
      throw error;
    }
  };

  app.post<{ Params: { id: string } }>("/api/backups/:id/restore", async (request, reply) => {
    const parsed = restoreStoredBackupSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_BACKUP_RESTORE", message: "恢复口令至少需要 12 个字符" });
    }
    try {
      return await restore(() => backups.restoreRecord(request.params.id, parsed.data.passphrase));
    } catch (error) {
      return sendBackupFailure(reply, error);
    }
  });

  app.post("/api/backups/restore", { bodyLimit: 512 * 1024 * 1024 }, async (request, reply) => {
    const parsed = restoreBackupSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_BACKUP_RESTORE", message: "需要备份文件和至少 12 个字符的恢复口令" });
    }
    try {
      return await restore(() => backups.restoreUploadedEnvelope(parsed.data.envelope, parsed.data.passphrase));
    } catch (error) {
      return sendBackupFailure(reply, error);
    }
  });

  app.get("/api/backup", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return reply.code(410).send({
      error: "ENCRYPTED_BACKUP_REQUIRED",
      message: "明文数据库下载已停用。请使用设置中的加密备份功能。"
    });
  });

  const sendBackupFailure = (reply: FastifyReply, error: unknown) => {
    if (error instanceof BackupError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    return reply.code(500).send({ error: "BACKUP_FAILED", message: "备份操作失败，请检查服务端日志" });
  };

  app.get("/api/goals", async () => ({ goals: service.listGoals() }));

  app.post("/api/goals", async (request, reply) => {
    const parsed = createGoalSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_GOAL",
        message: "目标参数不完整或格式不正确",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    try {
      const input: CreateGoalInput = { title: parsed.data.title, objective: parsed.data.objective };
      if (parsed.data.constraints !== undefined) input.constraints = parsed.data.constraints;
      if (parsed.data.forbiddenActions !== undefined) input.forbiddenActions = parsed.data.forbiddenActions;
      if (parsed.data.authoritySources !== undefined) input.authoritySources = parsed.data.authoritySources;
      if (parsed.data.successCriteria !== undefined) input.successCriteria = parsed.data.successCriteria;
      if (parsed.data.evidenceRequirements !== undefined) input.evidenceRequirements = parsed.data.evidenceRequirements;
      if (parsed.data.budget !== undefined) input.budget = normalizeGoalBudget(parsed.data.budget);
      if (parsed.data.deadline !== undefined) input.deadline = parsed.data.deadline;
      if (parsed.data.stopConditions !== undefined) input.stopConditions = parsed.data.stopConditions;
      if (parsed.data.reviewPolicy !== undefined) input.reviewPolicy = parsed.data.reviewPolicy;
      if (parsed.data.currentState !== undefined) input.currentState = parsed.data.currentState;
      return reply.code(201).send(service.createGoal(input));
    } catch (error) {
      return reply.code(400).send({ error: "INVALID_GOAL", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/goals/:id", async (request, reply) => {
    const goal = service.getGoal(request.params.id);
    if (!goal) return reply.code(404).send({ error: "GOAL_NOT_FOUND", message: "目标不存在" });
    return { goal, completionReports: store.listGoalCompletionReports(goal.goalId) };
  });

  app.patch<{ Params: { id: string } }>("/api/goals/:id", async (request, reply) => {
    const parsed = updateGoalSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_GOAL", message: "目标更新参数不正确" });
    }
    if (!service.getGoal(request.params.id)) {
      return reply.code(404).send({ error: "GOAL_NOT_FOUND", message: "目标不存在" });
    }
    try {
      const patch: Parameters<HearthService["updateGoal"]>[1] = {};
      if (parsed.data.title !== undefined) patch.title = parsed.data.title;
      if (parsed.data.objective !== undefined) patch.objective = parsed.data.objective;
      if (parsed.data.constraints !== undefined) patch.constraints = parsed.data.constraints;
      if (parsed.data.forbiddenActions !== undefined) patch.forbiddenActions = parsed.data.forbiddenActions;
      if (parsed.data.authoritySources !== undefined) patch.authoritySources = parsed.data.authoritySources;
      if (parsed.data.successCriteria !== undefined) patch.successCriteria = parsed.data.successCriteria;
      if (parsed.data.evidenceRequirements !== undefined) patch.evidenceRequirements = parsed.data.evidenceRequirements;
      if (parsed.data.budget !== undefined) patch.budget = normalizeGoalBudget(parsed.data.budget);
      if (parsed.data.deadline !== undefined) patch.deadline = parsed.data.deadline;
      if (parsed.data.stopConditions !== undefined) patch.stopConditions = parsed.data.stopConditions;
      if (parsed.data.reviewPolicy !== undefined) patch.reviewPolicy = parsed.data.reviewPolicy;
      if (parsed.data.currentState !== undefined) patch.currentState = parsed.data.currentState;
      if (parsed.data.nextHandoff !== undefined) patch.nextHandoff = parsed.data.nextHandoff;
      return service.updateGoal(request.params.id, patch);
    } catch (error) {
      return reply.code(400).send({ error: "INVALID_GOAL", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/tasks", async (request, reply) => {
    const parsed = createTaskSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_INPUT",
        message: "任务参数不完整或格式不正确",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
    }

    const input: CreateTaskInput = {};
    if (parsed.data.templateId !== undefined) input.templateId = parsed.data.templateId;
    if (parsed.data.title !== undefined) input.title = parsed.data.title;
    if (parsed.data.goal !== undefined) input.goal = parsed.data.goal;
    if (parsed.data.textInput !== undefined) input.textInput = parsed.data.textInput;
    if (parsed.data.sourceItemIds !== undefined) input.sourceItemIds = parsed.data.sourceItemIds;
    if (parsed.data.executorId !== undefined) input.executorId = parsed.data.executorId;
    if (parsed.data.taskKind !== undefined) input.taskKind = parsed.data.taskKind;
    if (parsed.data.expectedOutputs !== undefined) input.expectedOutputs = parsed.data.expectedOutputs;
    if (parsed.data.permissions !== undefined) input.permissions = parsed.data.permissions;
    if (parsed.data.goalId !== undefined) input.goalId = parsed.data.goalId;
    if (input.templateId && !getTemplate(input.templateId)) {
      return reply.code(400).send({ error: "UNKNOWN_TEMPLATE", message: `没有找到任务模板 ${input.templateId}` });
    }
    if (input.goalId && !service.getGoal(input.goalId)) {
      return reply.code(400).send({ error: "UNKNOWN_GOAL", message: `没有找到目标 ${input.goalId}` });
    }
    if (parsed.data.methodId !== undefined) {
      try {
        const assignment = methods.validateAssignment({
          methodId: parsed.data.methodId,
          templateId: parsed.data.templateId ?? null
        });
        input.methodId = assignment.methodId;
        input.methodVersion = assignment.methodVersion;
      } catch (error) {
        return sendMethodError(reply, error);
      }
    }

    try {
      const task = service.createTask(input);
      return reply.code(201).send(task);
    } catch (error) {
      if (error instanceof TaskInputSelectionError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/tasks/:id/method", async (request, reply) => {
    const parsed = assignTaskMethodSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_METHOD_ASSIGNMENT", message: "方法绑定参数不正确" });
    }
    if (!store.getTask(request.params.id)) {
      return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
    }
    try {
      return methods.assignToTask(request.params.id, parsed.data.methodId);
    } catch (error) {
      return sendMethodError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/tasks/:id/organization", async (request, reply) => {
    const parsed = taskOrganizationSchema.safeParse(request.body ?? {});
    if (!parsed.success || (parsed.data.pinned === undefined && parsed.data.archived === undefined)) {
      return reply.code(400).send({ error: "INVALID_TASK_ORGANIZATION", message: "需要指定置顶或归档状态" });
    }
    if (!store.getTask(request.params.id)) {
      return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
    }
    return service.setTaskOrganization(request.params.id, {
      ...(parsed.data.pinned === undefined ? {} : { pinned: parsed.data.pinned }),
      ...(parsed.data.archived === undefined ? {} : { archived: parsed.data.archived })
    });
  });

  app.get("/api/tasks", async () => ({ tasks: service.listTaskItems() }));

  app.get("/api/artifacts", async () => {
    const titles = service.taskTitles();
    return {
      artifacts: store.listAllArtifacts().map((artifact) => ({
        id: artifact.id,
        taskId: artifact.taskId,
        runId: artifact.runId,
        relativePath: artifact.relativePath,
        mimeType: artifact.mimeType,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        createdAt: artifact.createdAt,
        taskTitle: titles.get(artifact.taskId) ?? "未命名任务"
      }))
    };
  });

  app.get<{ Querystring: Record<string, string> }>("/api/runs", async (request, reply) => {
    const parsed = runQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalidQuery(reply);
    reply.header("cache-control", "no-store");
    return service.listRunItems(pageOptions(parsed.data));
  });

  app.get<{ Querystring: Record<string, string> }>("/api/approvals", async (request, reply) => {
    const parsed = approvalQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalidQuery(reply);
    reply.header("cache-control", "no-store");
    return service.listApprovalItems({ ...pageOptions(parsed.data), brief: parsed.data.brief === "1" });
  });

  app.get<{ Querystring: Record<string, string> }>("/api/effects", async (request, reply) => {
    const parsed = effectQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalidQuery(reply);
    reply.header("cache-control", "no-store");
    return service.listEffectItems(pageOptions(parsed.data));
  });

  app.get<{ Querystring: Record<string, string> }>("/api/reconcile", async (request, reply) => {
    const parsed = reconcileQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalidQuery(reply);
    reply.header("cache-control", "no-store");
    const items = reconcile.list(parsed.data.status);
    return { items, total: items.length };
  });

  app.post<{ Params: { id: string } }>("/api/reconcile/:id/check", async (request, reply) => {
    try {
      reply.header("cache-control", "no-store");
      return await reconcile.check(request.params.id);
    } catch (error) {
      return sendReconcileError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/reconcile/:id/resolve", async (request, reply) => {
    const parsed = reconcileResolveSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_RECONCILE_RESOLUTION", message: "请选择已提交、未执行或放弃，并填写核对说明。" });
    }
    try {
      return reconcile.resolveManually(request.params.id, parsed.data.resolution, parsed.data.note);
    } catch (error) {
      return sendReconcileError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/reconcile/:id/task", async (request, reply) => {
    const parsed = reconcileTaskSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_RECONCILE_TASK", message: "人工任务说明过长或格式不正确。" });
    }
    try {
      return reply.code(201).send(reconcile.createTask(request.params.id, parsed.data.note ?? ""));
    } catch (error) {
      return sendReconcileError(reply, error);
    }
  });

  app.get("/api/stats", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return service.stats();
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>("/api/tasks/:id/events", async (request, reply) => {
    const parsed = taskEventQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalidQuery(reply);
    if (!store.getTask(request.params.id)) {
      return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
    }
    reply.header("cache-control", "no-store");
    return service.eventWindow({
      limit: parsed.data.limit ?? DEFAULT_EVENT_LIMIT,
      afterSeq: parsed.data.after,
      beforeSeq: parsed.data.before,
      taskId: request.params.id,
      type: parsed.data.type
    });
  });

  app.get<{ Querystring: Record<string, string> }>("/api/events/history", async (request, reply) => {
    const parsed = eventQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalidQuery(reply);
    reply.header("cache-control", "no-store");
    return service.eventWindow({
      limit: parsed.data.limit ?? DEFAULT_EVENT_LIMIT,
      afterSeq: parsed.data.after,
      beforeSeq: parsed.data.before,
      taskId: parsed.data.taskId,
      type: parsed.data.type
    });
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>("/api/tasks/:id/context", async (request, reply) => {
    const parsed = contextQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return invalidQuery(reply);
    if (!store.getTask(request.params.id)) {
      return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
    }
    reply.header("cache-control", "no-store");
    return context.snapshot(request.params.id, {
      limit: parsed.data.limit ?? 50,
      beforeSeq: parsed.data.before ?? null
    });
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/delegations", async (request, reply) => {
    if (!store.getTask(request.params.id)) {
      return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
    }
    reply.header("cache-control", "no-store");
    return { delegations: delegations.list(request.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/delegations", async (request, reply) => {
    if (!store.getTask(request.params.id)) {
      return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
    }
    const parsed = createDelegationSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_DELEGATION",
        message: "委派参数不正确",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    try {
      const input: CreateDelegationInput = {
        parentTaskId: request.params.id,
        goalSlice: parsed.data.goalSlice,
        targetExecutor: parsed.data.targetExecutor,
        contextPackRef: parsed.data.contextPackRef,
        idempotencyKey: parsed.data.idempotencyKey
      };
      if (parsed.data.contextPack !== undefined) input.contextPack = parsed.data.contextPack;
      if (parsed.data.workspacePolicy !== undefined) input.workspacePolicy = parsed.data.workspacePolicy;
      if (parsed.data.toolPolicy !== undefined) input.toolPolicy = parsed.data.toolPolicy;
      if (parsed.data.networkPolicy !== undefined) input.networkPolicy = parsed.data.networkPolicy;
      if (parsed.data.budget !== undefined) {
        input.budget = {
          ...(parsed.data.budget.tokens !== undefined ? { tokens: parsed.data.budget.tokens } : {}),
          ...(parsed.data.budget.wallClockMs !== undefined ? { wallClockMs: parsed.data.budget.wallClockMs } : {}),
          ...(parsed.data.budget.maxSteps !== undefined ? { maxSteps: parsed.data.budget.maxSteps } : {})
        };
      }
      if (parsed.data.deadline !== undefined) input.deadline = parsed.data.deadline;
      if (parsed.data.resultSchemaRef !== undefined) input.resultSchemaRef = parsed.data.resultSchemaRef;
      if (parsed.data.requestedPermissions !== undefined) input.requestedPermissions = parsed.data.requestedPermissions;
      if (parsed.data.createChildTask !== undefined) input.createChildTask = parsed.data.createChildTask;
      return reply.code(201).send(delegations.create(input));
    } catch (error) {
      return sendDelegationFailure(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/delegations/:id", async (request, reply) => {
    const job = store.getDelegationJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "DELEGATION_NOT_FOUND", message: "委派不存在" });
    reply.header("cache-control", "no-store");
    return job;
  });

  app.post<{ Params: { id: string } }>("/api/delegations/:id/verify", async (request, reply) => {
    const job = store.getDelegationJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "DELEGATION_NOT_FOUND", message: "委派不存在" });
    const parsed = verifyDelegationSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_DELEGATION_VERIFICATION", message: "验收参数不正确" });
    }
    try {
      return delegations.verify(job.id, {
        parentTaskId: job.parentTaskId,
        verdict: parsed.data.verdict,
        summary: parsed.data.summary,
        evidenceRefs: parsed.data.evidenceRefs,
        checkedAt: parsed.data.checkedAt ?? new Date().toISOString()
      });
    } catch (error) {
      return sendDelegationFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/delegations/:id/cancel", async (request, reply) => {
    const job = store.getDelegationJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "DELEGATION_NOT_FOUND", message: "委派不存在" });
    const parsed = cancelDelegationSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_DELEGATION_CANCEL", message: "取消原因不正确" });
    }
    try {
      const cancelled = delegations.cancel(job.id, parsed.data.reason);
      if (scheduler && cancelled.childTaskId) scheduler.cancel(cancelled.childTaskId);
      return cancelled;
    } catch (error) {
      return sendDelegationFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/delegations/:id/retry", async (request, reply) => {
    const job = store.getDelegationJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "DELEGATION_NOT_FOUND", message: "委派不存在" });
    try {
      return delegations.retry(job.id);
    } catch (error) {
      return sendDelegationFailure(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/handoffs", async (request, reply) => {
    if (!store.getTask(request.params.id)) {
      return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
    }
    reply.header("cache-control", "no-store");
    return {
      state: context.getState(request.params.id),
      handoffs: context.listHandoffs(request.params.id)
    };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/handoff", async (request, reply) => {
    if (!scheduler) return reply.code(503).send({ error: "SCHEDULER_OFF", message: "执行器未启动" });
    if (!store.getTask(request.params.id)) {
      return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
    }
    const parsed = confirmHandoffSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_INPUT", message: "请指定要接管的目标执行器" });
    }
    try {
      const task = scheduler.confirmHandoff(request.params.id, parsed.data.executorId);
      const handoff = [...context.listHandoffs(request.params.id)].reverse().find((item) => item.status === "prepared") ?? null;
      return { task, handoff };
    } catch (error) {
      return reply.code(409).send({ error: "HANDOFF_NOT_ALLOWED", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/context/settings", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { settings: context.settings() };
  });

  app.get("/api/context/metrics", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return contextMetrics(service);
  });

  app.patch("/api/context/settings", async (request, reply) => {
    const parsed = contextSettingsPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_INPUT", message: "上下文设置格式不正确" });
    }
    try {
      return { settings: context.updateSettings(parsed.data) };
    } catch (error) {
      return reply.code(400).send({ error: "INVALID_CONTEXT_SETTINGS", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/tasks/:id/context", async (request, reply) => {
    if (!store.getTask(request.params.id)) {
      return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
    }
    try {
      return context.deleteTaskContext(request.params.id);
    } catch (error) {
      return reply.code(409).send({ error: "CONTEXT_DELETE_FAILED", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const view = service.view(request.params.id);
    if (!view) return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
    return view;
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/follow-ups", async (request, reply) => {
    if (!store.getTask(request.params.id)) return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
    return { followUps: store.listTaskFollowUps(request.params.id) };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/git", async (request, reply) => {
    if (!store.getTask(request.params.id)) return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
    try {
      return await taskGit.view(request.params.id);
    } catch (error) {
      if (error instanceof GitViewError) return reply.code(error.statusCode).send({ error: "GIT_VIEW_FAILED", message: error.message });
      return reply.code(500).send({ error: "GIT_VIEW_FAILED", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { scope?: string; path?: string } }>("/api/tasks/:id/git/diff", async (request, reply) => {
    if (!store.getTask(request.params.id)) return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
    const scope = request.query.scope === "branch" ? "branch" : request.query.scope === "working" || !request.query.scope ? "working" : null;
    if (!scope) return reply.code(400).send({ error: "INVALID_SCOPE", message: "diff 范围只能是 working 或 branch" });
    try {
      return await taskGit.diff(request.params.id, scope, request.query.path ?? null);
    } catch (error) {
      if (error instanceof GitViewError) return reply.code(error.statusCode).send({ error: "GIT_DIFF_FAILED", message: error.message });
      return reply.code(500).send({ error: "GIT_DIFF_FAILED", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string; fromHead?: string } }>("/api/tasks/:id/git/file", async (request, reply) => {
    if (!store.getTask(request.params.id)) return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "任务不存在" });
    if (!request.query.path) return reply.code(400).send({ error: "PATH_REQUIRED", message: "需要提供文件路径" });
    try {
      return await taskGit.file(request.params.id, request.query.path, request.query.fromHead === "true");
    } catch (error) {
      if (error instanceof GitViewError) return reply.code(error.statusCode).send({ error: "GIT_FILE_FAILED", message: error.message });
      return reply.code(500).send({ error: "GIT_FILE_FAILED", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/api/tasks/:id/follow-ups", async (request, reply) => {
    if (!scheduler) return reply.code(503).send({ error: "SCHEDULER_OFF", message: "执行器未启动" });
    const parsed = taskFollowUpSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_INPUT", message: "补充信息格式不正确" });
    try {
      return scheduler.addFollowUp(request.params.id, parsed.data.content, parsed.data.mode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("不存在") ? 404 : 409).send({ error: "FOLLOW_UP_REJECTED", message });
    }
  });

  app.patch<{ Params: { id: string; followUpId: string }; Body: unknown }>("/api/tasks/:id/follow-ups/:followUpId", async (request, reply) => {
    if (!scheduler) return reply.code(503).send({ error: "SCHEDULER_OFF", message: "执行器未启动" });
    const parsed = taskFollowUpPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_INPUT", message: "补充信息格式不正确" });
    try {
      return scheduler.updateFollowUp(request.params.id, request.params.followUpId, parsed.data.content);
    } catch (error) {
      return reply.code(409).send({ error: "FOLLOW_UP_NOT_EDITABLE", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete<{ Params: { id: string; followUpId: string } }>("/api/tasks/:id/follow-ups/:followUpId", async (request, reply) => {
    if (!scheduler) return reply.code(503).send({ error: "SCHEDULER_OFF", message: "执行器未启动" });
    try {
      return scheduler.cancelFollowUp(request.params.id, request.params.followUpId);
    } catch (error) {
      return reply.code(409).send({ error: "FOLLOW_UP_NOT_DELETABLE", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string }; Body: { message?: string } | undefined }>("/api/tasks/:id/retry", async (request, reply) => {
    if (!scheduler) return reply.code(503).send({ error: "SCHEDULER_OFF", message: "执行器未启动" });
    const parsed = retryTaskSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_INPUT", message: "补充说明格式不正确" });
    try {
      return scheduler.retry(request.params.id, parsed.data.message);
    } catch (error) {
      return reply.code(409).send({ error: "RETRY_NOT_ALLOWED", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (request, reply) => {
    if (!scheduler) return reply.code(503).send({ error: "SCHEDULER_OFF", message: "执行器未启动" });
    try {
      const task = scheduler.cancel(request.params.id);
      outbox.reconcileTask(request.params.id);
      return task;
    } catch (error) {
      return reply.code(404).send({ error: "TASK_NOT_FOUND", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Querystring: { conversationId?: string } }>("/api/task-proposals", async (request) => ({
    proposals: service.store.listTaskProposals(request.query.conversationId)
  }));

  app.post<{ Params: { id: string } }>("/api/task-proposals/:id/confirm", async (request, reply) => {
    try {
      const available = {} as Record<ExecutorId, boolean>;
      for (const id of EXECUTOR_IDS) available[id] = executorHealth(id).canRun;
      const result = service.confirmTaskProposal(request.params.id, available);
      scheduler?.kick();
      return result;
    } catch (error) {
      return reply.code(409).send({ error: "PROPOSAL_NOT_CONFIRMABLE", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/task-proposals/:id/reject", async (request, reply) => {
    try {
      return service.rejectTaskProposal(request.params.id);
    } catch (error) {
      return reply.code(409).send({ error: "PROPOSAL_NOT_REJECTABLE", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/approvals/:id/decide", async (request, reply) => {
    const parsed = decideApprovalSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_DECISION", message: "需要明确批准或拒绝，并提交当前审批参数哈希" });
    }
    try {
      const result = await approvals.decide(request.params.id, parsed.data.decision, parsed.data.parameterHash);
      outbox.reconcileApproval(result.approval.id);
      if (result.effect?.status === "succeeded" && result.task.status === "recoverable"
        && store.listTaskFollowUps(result.task.id, "queued").length > 0) {
        try {
          scheduler?.resumeFollowUp(result.task.id);
        } catch {
          // The user can resume the queued follow-up from the task page.
        }
      }
      return result;
    } catch (error) {
      if (error instanceof ApprovalError) {
        outbox.reconcileApproval(request.params.id);
        const status = error.code === "APPROVAL_NOT_FOUND" ? 404 : error.code === "APPROVAL_EXPIRED" ? 410 : 409;
        return reply.code(status).send({ error: error.code, message: error.message });
      }
      if (error instanceof SecurityError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      return reply.code(500).send({ error: "APPROVAL_FAILED", message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string; artifactId: string } }>("/api/tasks/:id/artifacts/:artifactId", async (request, reply) => {
    const artifact = store.getArtifact(request.params.artifactId);
    if (!artifact || artifact.taskId !== request.params.id) {
      return reply.code(404).send({ error: "ARTIFACT_NOT_FOUND", message: "产物不存在" });
    }
    if (!isPathInside(REPO_ROOT, artifact.absolutePath) || !existsSync(artifact.absolutePath)) {
      return reply.code(410).send({ error: "ARTIFACT_UNAVAILABLE", message: "产物文件已不可用" });
    }
    reply.header("content-type", artifact.mimeType);
    reply.header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(basename(artifact.absolutePath))}`);
    return reply.send(readFileSync(artifact.absolutePath));
  });

  app.get<{ Querystring: { after?: string; taskId?: string } }>("/api/events", async (request, reply) => {
    const afterSeq = parseAfterSeq(request.query.after);
    if (afterSeq === null) {
      return reply.code(400).send({ error: "INVALID_CURSOR", message: "after 必须是非负整数" });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    reply.raw.flushHeaders();

    let closed = false;
    let ready = false;
    let lastSeq = afterSeq;
    const buffered: EventEnvelope[] = [];
    const taskId = request.query.taskId;

    const writeEvent = (event: EventEnvelope) => {
      if (closed || (taskId && event.taskId !== taskId)) return;
      if (!ready) {
        buffered.push(event);
        return;
      }
      if (event.seq <= lastSeq) return;
      lastSeq = event.seq;
      reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    const unsubscribe = service.bus.subscribe(writeEvent);
    for (const event of store.listEvents(afterSeq, taskId)) writeEvent(event);
    ready = true;
    for (const event of buffered.splice(0)) writeEvent(event);

    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(": heartbeat\n\n");
    }, 15_000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    reply.raw.on("close", cleanup);
    reply.raw.on("error", cleanup);
    request.raw.socket.on("close", cleanup);
    return reply;
  });

  const hasWeb = options.serveWeb !== false && existsSync(join(WEB_DIST, "index.html"));
  if (hasWeb) await app.register(fastifyStatic, { root: WEB_DIST });

  if (!security.state().killSwitch) scheduler?.start();

  app.setNotFoundHandler((request, reply) => {
    if (hasWeb && request.method === "GET" && !request.url.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "NOT_FOUND", message: "没有找到这个页面" });
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    reply.code(500).send({ error: "INTERNAL_ERROR", message: "Hearth 处理请求时遇到问题" });
  });

  return app;
}

function sendDelegationFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof DelegationError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  if (error instanceof SandboxError) {
    return reply.code(error.statusCode).send({
      error: error.code,
      message: error.message,
      failureClass: error.failureClass
    });
  }
  throw error;
}

function parseAfterSeq(value: string | undefined): number | null {
  if (value === undefined || value === "") return 0;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function pageOptions(query: {
  taskId?: string | undefined;
  status?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}): PageOptions {
  const options: PageOptions = { limit: query.limit ?? DEFAULT_LIST_LIMIT, offset: query.offset ?? 0 };
  if (query.taskId !== undefined) options.taskId = query.taskId;
  if (query.status !== undefined) options.status = query.status;
  return options;
}

function invalidQuery(reply: FastifyReply) {
  return reply.code(400).send({ error: "INVALID_QUERY", message: "分页参数不正确" });
}

function sendReconcileError(reply: FastifyReply, error: unknown) {
  if (error instanceof ReconcileError) {
    return reply.code(error.code === "RECONCILE_NOT_FOUND" ? 404 : 409).send({ error: error.code, message: error.message });
  }
  throw error;
}

function sendSourceError(reply: FastifyReply, error: unknown) {
  if (error instanceof SourceRegistryError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

function sendOutboxError(reply: FastifyReply, error: unknown) {
  if (error instanceof OutboxError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

function sendMailError(reply: FastifyReply, error: unknown) {
  if (error instanceof MailError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

function sendScheduleError(reply: FastifyReply, error: unknown) {
  if (error instanceof ScheduleError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

function definedObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function sendMemoryError(reply: FastifyReply, error: unknown) {
  if (error instanceof MemoryError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

function sendMethodError(reply: FastifyReply, error: unknown) {
  if (error instanceof MethodError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

function sendSkillError(reply: FastifyReply, error: unknown) {
  if (error instanceof SkillPackageError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

function sendSyncError(reply: FastifyReply, error: unknown) {
  if (error instanceof SyncError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

function syncBearerToken(value: string | string[] | undefined): string {
  const header = headerValue(value);
  if (!header.startsWith("Bearer ")) throw new SyncError("SYNC_UNAUTHORIZED", "缺少同步令牌", 401);
  return header.slice(7).trim();
}

function sendStandingIntentError(reply: FastifyReply, error: unknown) {
  if (error instanceof StandingIntentError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

function sendProactiveError(reply: FastifyReply, error: unknown) {
  if (error instanceof ProactiveError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

function sendConnectionError(reply: FastifyReply, error: unknown) {
  if (error instanceof ConnectionError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

function sendDesktopError(reply: FastifyReply, error: unknown) {
  if (error instanceof DesktopError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

function sendModelRegistryError(reply: FastifyReply, error: unknown) {
  if (error instanceof ModelRegistryError) {
    return reply.code(error.code === "MODEL_PROFILE_NOT_FOUND" ? 404 : 400).send({ error: error.code, message: error.message });
  }
  throw error;
}

function bearerToken(value: string | string[] | undefined): string {
  const header = headerValue(value);
  if (!header.startsWith("Bearer ")) throw new DesktopError("DEVICE_UNAUTHORIZED", "缺少设备令牌", 401);
  return header.slice(7).trim();
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}\\`) || candidate.startsWith(`${normalizedRoot}/`);
}
