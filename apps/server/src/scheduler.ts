import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  AgentCheckpoint,
  AgentResumeState,
  AgentToolAuthorization,
  AgentToolAuthorizationRequest,
  RuntimeEvent
} from "@hearth/agent-runtime";
import type { ContextItem, ContextSettings, DelegationJob, DelegationResult, ExecutorId, ExecutorSettings, FailureCause, FailureDiagnosis, HandoffPacket, HandoffRecord, MethodCandidate, MethodSelection, RunBudget, RunCheckpointProof, RunCheckpointRecord, RunRecord, TaskError, TaskFollowUpRecord, TaskLease, TaskProgressDetail, TaskRecord } from "@hearth/core";
import { runCodex } from "@hearth/codex-executor";
import { getTemplate } from "@hearth/templates";
import type { DshApprovalOutcome, DshApprovalRequest, DshContextEvent } from "@hearth/deepseek-executor";
import type { ApprovalRequest, ApprovalManager, PendingToolApproval, ToolApprovalDecision } from "./approvals.ts";
import { actionDigest, resolveAction, type ActionFileTarget, type ActionProposal, type ResolvedAction } from "./action-resolver.ts";
import { createFileArtifact, missingExpectedOutputs, publishArtifacts } from "./artifacts.ts";
import { CONTEXT_BLOB_DIR, EXECUTOR_SETTINGS_PATH, GIT_CACHE_DIR, MODEL_SETTINGS_PATH, REPO_ROOT, SOURCE_CONTENT_DIR, WORKSPACE_DIR } from "./config.ts";
import { ContextService, estimateTokens } from "./context.ts";
import { DelegationError, DelegationService } from "./delegation.ts";
import type { BackgroundToolService } from "./background-tools.ts";
import { diagnoseFailure } from "./context-diagnosis.ts";
import { classifyFailure, decideFailure, evaluateHandoff, isExecutorFailureCause, type FailureDecision } from "./context-policy.ts";
import { judgeCompletion, type GoalValidatorRunner } from "./completion-judge.ts";
import { ContextProjector } from "./context-projector.ts";
import { maybeModelSummary } from "./context-summary.ts";
import { HandoffService } from "./handoff.ts";
import { loadExecutorSettings } from "./executor-settings.ts";
import { HermesApprovalRequiredError, HermesStartupError } from "./hermes-executor.ts";
import type { ExternalContextItem } from "./external-executor.ts";
import { executorHealth as readExecutorHealth } from "./executor-runtime.ts";
import { sanitizeProgressDetail } from "./progress-detail.ts";
import { EXECUTOR_FALLBACK_ORDER, executorName, resolveExecutorId } from "./executors.ts";
import { extractProposedComment, inspectRepository, readPrPreview, validatePullRequestPreview } from "./github.ts";
import { canBlindRetry, classifyFailureClass, decideDisposition } from "./failure-policy.ts";
import type { CommandRunner } from "./github.ts";
import { MemoryService } from "./memory.ts";
import { renderMethodBlock } from "./method-context.ts";
import { MethodService } from "./methods.ts";
import { DEFAULT_LEASE_HEARTBEAT_MS, LeaseError, TaskLeaseService } from "./leases.ts";
import { SandboxService } from "./sandbox.ts";
import { TOOL_APPROVAL_REQUIRED, toolApprovalSummary } from "./tool-policy.ts";
import { DEFAULT_RUN_BUDGET, runNativeTask } from "./native-executor.ts";
import { ContextBroker } from "./context-broker.ts";
import { OntologyService } from "./ontology.ts";
import { createPersonalReadTools } from "./personal-tools.ts";
import { OntologyWriter } from "./ontology-writer.ts";
import { chatModelConfigured, loadModelSettings, type ModelSettings } from "./model-settings.ts";
import { prepareTaskRuntime, type RuntimePreparation } from "./runtime.ts";
import type { HearthService } from "./service.ts";
import { buildDeliveryRepairPrompt, buildTaskPrompt, prepareWorkspace, UnsupportedInputError, type PreparedWorkspace } from "./workspace.ts";
import { CapabilityUnavailableError, needsGithubRepository, wantsScreenshot } from "./task-intent.ts";

import { createExecutorAdapters, type CodexContextItem, type CodexRunner, type DshRunner, type ExecutionOutcome, type ExecutorAdapter, type ExecutorAttemptContext, type ExternalRunner, type NativeRunner } from "./executor-adapter.ts";
export type { CodexRunner, NativeRunner } from "./executor-adapter.ts";
export type ExecutorHealthProvider = (executorId: ExecutorId, settings: ExecutorSettings) => { canRun: boolean; issues: string[] };

interface AttemptResult {
  status: "completed" | "waiting_input" | "waiting_approval" | "failed" | "cancelled";
  run: RunRecord;
  executorId: ExecutorId;
  outDir: string;
  error: unknown;
  failure: TaskError | null;
  aborted: boolean;
  leaseLost: boolean;
  cancelled: boolean;
  steered?: boolean;
  queuedFollowUp?: boolean;
}

interface GoalBoundaryStop {
  code: "deadline_reached" | "budget_exhausted" | "effect_uncertain" | "declared_stop";
  currentState: "blocked" | "awaiting_user";
  message: string;
  nextAction: string;
  handoff: string;
  failureClass: NonNullable<TaskError["failureClass"]>;
  cause: NonNullable<TaskError["cause"]>;
}

export interface SchedulerOptions {
  service: HearthService;
  repoRoot?: string;
  workspaceRoot?: string;
  artifactBase?: string;
  attachmentRoot?: string;
  codexRunner?: CodexRunner;
  nativeRunner?: NativeRunner;
  deepseekRunner?: DshRunner;
  externalRunner?: ExternalRunner;
  executorHealth?: ExecutorHealthProvider;
  executorSettingsPath?: string;
  executorSettings?: ExecutorSettings;
  executorSettingsProvider?: (() => ExecutorSettings) | undefined;
  modelSettingsPath?: string;
  modelSettingsForExecutor?: ((executorId: ExecutorId) => ModelSettings | null) | undefined;
  runBudget?: RunBudget;
  approvals?: ApprovalManager;
  leases?: TaskLeaseService;
  delegations?: DelegationService;
  backgroundTools?: BackgroundToolService;
  leaseHeartbeatMs?: number;
  githubRun?: CommandRunner | undefined;
  githubCacheRoot?: string | undefined;
  sourceContentRoot?: string | undefined;
  runtimePreparer?: typeof prepareTaskRuntime | undefined;
  context?: ContextService | undefined;
  contextBlobRoot?: string | undefined;
  methods?: MethodService | undefined;
  autoLearn?: boolean | undefined;
  sandbox?: SandboxService | undefined;
  completionValidators?: Record<string, GoalValidatorRunner> | undefined;
  contextBroker?: ContextBroker | undefined;
  ontologyWriter?: OntologyWriter | undefined;
}

export class HearthScheduler {
  private readonly service: HearthService;
  private readonly repoRoot: string;
  private readonly workspaceRoot: string;
  private readonly artifactBase: string;
  private readonly attachmentRoot: string | undefined;
  private readonly codexRunner: CodexRunner;
  private readonly nativeRunner: NativeRunner;
  private readonly deepseekRunner: DshRunner | undefined;
  private readonly adapters: Record<ExecutorId, ExecutorAdapter>;
  private readonly executorHealth: ExecutorHealthProvider;
  private readonly executorSettingsPath: string;
  private readonly staticExecutorSettings: ExecutorSettings | null;
  private readonly executorSettingsProvider: (() => ExecutorSettings) | null;
  private readonly modelSettingsPath: string;
  private readonly modelSettingsForExecutor: (executorId: ExecutorId) => ModelSettings | null;
  private readonly runBudget: RunBudget;
  private readonly approvals: ApprovalManager | undefined;
  private readonly githubRun: CommandRunner | undefined;
  private readonly githubCacheRoot: string;
  private readonly sourceContentRoot: string;
  private readonly runtimePreparer: typeof prepareTaskRuntime;
  private readonly memory: MemoryService;
  private readonly methods: MethodService;
  private readonly autoLearn: boolean;
  private readonly sandbox: SandboxService;
  private readonly completionValidators: Record<string, GoalValidatorRunner> | null;
  private readonly context: ContextService;
  private readonly contextBroker: ContextBroker | undefined;
  private readonly ontology: OntologyService;
  private readonly ontologyWriter: OntologyWriter;
  private readonly projector: ContextProjector;
  private readonly handoffs: HandoffService;
  private readonly summaryTasks = new Set<Promise<void>>();
  private readonly summaryControllers = new Map<string, AbortController>();
  private readonly leases: TaskLeaseService;
  private readonly delegations: DelegationService;
  private readonly backgroundTools: BackgroundToolService | undefined;
  private readonly leaseHeartbeatMs: number;
  private readonly leaseHeartbeats = new Map<string, { epoch: number; timer: ReturnType<typeof setInterval> }>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly steering = new Map<string, string>();
  private readonly cancelled = new Set<string>();
  private readonly activeByExecutor = new Map<ExecutorId, Set<string>>();
  private readonly runPromises = new Set<Promise<void>>();
  private unsubscribe: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;
  private wakeResolver: (() => void) | null = null;
  private stopped = true;
  private stopping = false;

  constructor(options: SchedulerOptions) {
    this.service = options.service;
    this.repoRoot = options.repoRoot ?? REPO_ROOT;
    this.workspaceRoot = options.workspaceRoot ?? WORKSPACE_DIR;
    this.artifactBase = options.artifactBase ?? REPO_ROOT;
    this.attachmentRoot = options.attachmentRoot;
    this.codexRunner = options.codexRunner ?? runCodex;
    this.nativeRunner = options.nativeRunner ?? runNativeTask;
    this.deepseekRunner = options.deepseekRunner;
    this.executorSettingsPath = options.executorSettingsPath ?? EXECUTOR_SETTINGS_PATH;
    this.staticExecutorSettings = options.executorSettings ?? null;
    this.executorSettingsProvider = options.executorSettingsProvider ?? null;
    this.adapters = createExecutorAdapters({
      codex: this.codexRunner,
      native: this.nativeRunner,
      ...(this.deepseekRunner ? { deepseek: this.deepseekRunner } : {}),
      settingsPath: this.executorSettingsPath,
      ...(options.externalRunner ? { external: options.externalRunner } : {})
    });
    this.executorHealth = options.executorHealth
      ?? ((executorId, settings) => readExecutorHealth(executorId, settings, this.executorSettingsPath));
    this.modelSettingsPath = options.modelSettingsPath ?? MODEL_SETTINGS_PATH;
    this.modelSettingsForExecutor = options.modelSettingsForExecutor
      ?? ((executorId) => executorId === "native"
        ? loadModelSettings(this.modelSettingsPath)
        : null);
    this.runBudget = options.runBudget ?? DEFAULT_RUN_BUDGET;
    this.approvals = options.approvals;
    this.githubRun = options.githubRun;
    this.githubCacheRoot = options.githubCacheRoot ?? GIT_CACHE_DIR;
    this.sourceContentRoot = options.sourceContentRoot ?? SOURCE_CONTENT_DIR;
    this.runtimePreparer = options.runtimePreparer ?? prepareTaskRuntime;
    this.memory = new MemoryService(this.service);
    this.methods = options.methods ?? new MethodService(this.service);
    this.autoLearn = options.autoLearn ?? true;
    this.completionValidators = options.completionValidators ?? null;
    this.context = options.context ?? new ContextService(this.service, options.contextBlobRoot ?? CONTEXT_BLOB_DIR);
    this.contextBroker = options.contextBroker;
    this.ontology = new OntologyService(this.service);
    this.ontologyWriter = options.ontologyWriter ?? new OntologyWriter(this.service, this.ontology);
    this.projector = new ContextProjector(this.service, this.context, options.contextBroker);
    this.handoffs = new HandoffService(this.service, this.context);
    this.service.setContextSink((message) => {
      if (this.context.settings().mode !== "off") this.context.recordChatMessage(message);
    });
    this.leases = options.leases ?? new TaskLeaseService(this.service);
    this.sandbox = options.sandbox ?? new SandboxService();
    this.backgroundTools = options.backgroundTools;
    this.delegations = options.delegations ?? new DelegationService({
      service: this.service,
      sandbox: this.sandbox
    });
    this.leaseHeartbeatMs = Math.max(50, options.leaseHeartbeatMs ?? DEFAULT_LEASE_HEARTBEAT_MS);
  }

  get running(): boolean {
    return !this.stopped;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.stopping = false;
    this.delegations.recoverOrphans();
    this.recoverInterruptedTasks();
    this.resumeWaitingApprovalLeases();
    this.unsubscribe = this.service.bus.subscribe((event) => {
      if (event.type === "task.created" || event.type === "task.updated") this.wake();
      if (event.type === "task.updated" && event.taskId && isTerminalStatus(this.service.store.getTask(event.taskId)?.status)) {
        this.releaseLease(event.taskId);
      }
    });
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopping = true;
    for (const controller of this.controllers.values()) controller.abort();
    for (const [taskId, heartbeat] of this.leaseHeartbeats) {
      clearInterval(heartbeat.timer);
      this.leases.release(taskId, heartbeat.epoch);
    }
    this.leaseHeartbeats.clear();
    this.wake();
    await this.loopPromise;
    await Promise.allSettled(Array.from(this.runPromises));
    for (const controller of this.summaryControllers.values()) controller.abort();
    await Promise.allSettled(Array.from(this.summaryTasks));
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  kick(): void {
    this.wake();
  }

  addFollowUp(taskId: string, content: string, mode: "queue" | "steer"): TaskFollowUpRecord {
    const task = this.service.requireTask(taskId);
    const text = content.trim();
    if (!text) throw new Error("补充内容不能为空");
    if (text.length > 20_000) throw new Error("补充内容不能超过 20000 个字符");
    if (task.status === "completed" || task.status === "cancelled") {
      throw new Error("任务已经结束，不能再追加指令");
    }
    if (mode === "steer") {
      if (task.status !== "running" || !this.controllers.has(taskId)) {
        throw new Error("只有正在运行的任务可以中止当前轮并立即补充");
      }
      if (this.service.store.listTaskFollowUps(taskId, "steering").length > 0) {
        throw new Error("已有一条补充信息正在应用中");
      }
      const followUp = this.service.createTaskFollowUp(taskId, text, "steer");
      this.steering.set(taskId, followUp.id);
      this.service.updateTask(taskId, {
        nextAction: "正在中止当前轮，准备应用补充信息"
      }, task.currentRunId ?? undefined);
      this.controllers.get(taskId)?.abort();
      return followUp;
    }
    if (this.service.store.listHandoffs(taskId).some((handoff) => handoff.status === "pending_user")
      && task.status !== "running" && task.status !== "queued") {
      throw new Error("有等待确认的接管，请先确认接管或取消任务");
    }
    const followUp = this.service.createTaskFollowUp(taskId, text, "queue");
    if (task.status === "waiting_input" || task.status === "recoverable" || task.status === "failed") {
      this.service.updateTask(taskId, {
        status: "queued", nextAction: "收到补充信息，等待继续", error: null
      }, task.currentRunId ?? undefined);
      this.wake();
    }
    return followUp;
  }

  updateFollowUp(taskId: string, followUpId: string, content: string): TaskFollowUpRecord {
    const followUp = this.service.store.getTaskFollowUp(followUpId);
    if (!followUp || followUp.taskId !== taskId) throw new Error("补充信息不存在");
    if (followUp.status !== "queued") throw new Error("只有排队中的补充信息可以编辑");
    const text = content.trim();
    if (!text) throw new Error("补充内容不能为空");
    if (text.length > 20_000) throw new Error("补充内容不能超过 20000 个字符");
    return this.service.updateTaskFollowUp(followUpId, { content: text });
  }

  cancelFollowUp(taskId: string, followUpId: string): TaskFollowUpRecord {
    const followUp = this.service.store.getTaskFollowUp(followUpId);
    if (!followUp || followUp.taskId !== taskId) throw new Error("补充信息不存在");
    if (followUp.status !== "queued") throw new Error("只有排队中的补充信息可以删除");
    return this.service.updateTaskFollowUp(followUpId, { status: "cancelled" });
  }

  resumeFollowUp(taskId: string): TaskRecord {
    const task = this.service.requireTask(taskId);
    if (!["waiting_input", "recoverable", "failed"].includes(task.status)) return task;
    if (this.service.store.listTaskFollowUps(taskId, "queued").length === 0) return task;
    if (this.service.store.listHandoffs(taskId).some((handoff) => handoff.status === "pending_user")) {
      throw new Error("有等待确认的接管，请先确认接管或取消任务");
    }
    const updated = this.service.updateTask(taskId, {
      status: "queued", nextAction: "收到补充信息，等待继续", error: null
    }, task.currentRunId ?? undefined);
    this.wake();
    return updated;
  }

  get contextService(): ContextService {
    return this.context;
  }

  confirmHandoff(taskId: string, executorId: ExecutorId): TaskRecord {
    const task = this.service.requireTask(taskId);
    if (task.status !== "waiting_input") throw new Error(`当前状态不能确认接管：${task.status}`);
    const handoff = [...this.service.store.listHandoffs(taskId)].reverse().find((item) => item.status === "pending_user");
    if (!handoff) throw new Error("没有等待确认的接管");
    if (handoff.toExecutor !== executorId) throw new Error(`当前等待确认的目标执行器是 ${handoff.toExecutor}`);
    const settings = this.executorSettings();
    const health = this.executorHealth(executorId, settings);
    if (!health.canRun) throw new Error(`目标执行器当前不可用：${health.issues.join("；") || "未检测到可用配置"}`);
    if (!this.executorEnabledForTask(task, executorId)) throw new Error("当前对话已关闭该执行器");
    const adapterCheck = this.adapters[executorId].canRun({
      task,
      prepared: null,
      settings: this.context.settings(),
      executorSettings: settings,
      modelSettings: this.modelSettingsForExecutor(executorId)
    });
    if (!adapterCheck.ok) throw new Error(adapterCheck.reason ?? "目标执行器不能执行这个任务");
    this.context.updateHandoff(handoff.id, { status: "prepared" });
    const updated = this.service.updateTask(taskId, {
      executorId, status: "queued", nextAction: `${executorId} 等待接管`, error: null
    }, task.currentRunId ?? undefined);
    this.wake();
    return updated;
  }

  cancel(taskId: string): TaskRecord {
    const task = this.service.requireTask(taskId);
    if (task.status === "completed") return task;
    if (task.status === "cancelled") {
      this.controllers.get(taskId)?.abort();
      this.releaseLease(taskId);
      return task;
    }
    this.cancelled.add(taskId);
    this.cancelDelegationJobs(taskId);
    this.steering.delete(taskId);
    for (const followUp of this.service.store.listTaskFollowUps(taskId)) {
      if (followUp.status === "queued" || followUp.status === "steering") {
        this.service.updateTaskFollowUp(followUp.id, { status: "cancelled", error: "任务已取消" });
      }
    }
    this.controllers.get(taskId)?.abort();
    this.approvals?.expireForTask(taskId);
    this.service.updateTask(taskId, {
      status: "cancelled",
      currentRunId: task.currentRunId,
      nextAction: null,
      error: null
    }, task.currentRunId ?? undefined);
    this.releaseLease(taskId);
    return this.service.requireTask(taskId);
  }

  private cancelDelegationJobs(taskId: string): void {
    const jobs = [...this.service.store.listDelegationJobs(taskId)];
    const childJob = this.service.store.getDelegationJobByChildTask(taskId);
    if (childJob) jobs.push(childJob);
    const seen = new Set<string>();
    for (const job of jobs) {
      if (seen.has(job.id) || job.status === "succeeded") continue;
      seen.add(job.id);
      try {
        this.delegations.cancel(job.id, "任务已取消");
        if (job.childTaskId) {
          this.cancelled.add(job.childTaskId);
          this.controllers.get(job.childTaskId)?.abort();
          this.approvals?.expireForTask(job.childTaskId);
        }
      } catch {
        // Cancellation is best effort; the parent task cancellation still fences new effects.
      }
    }
  }

  retry(taskId: string, input?: string): TaskRecord {
    const task = this.service.requireTask(taskId);
    if (this.service.store.listHandoffs(taskId).some((handoff) => handoff.status === "pending_user")) {
      throw new Error("有等待确认的接管，请先确认接管或取消任务");
    }
    if (task.status !== "recoverable" && task.status !== "failed" && task.status !== "waiting_input") {
      throw new Error(`当前状态不能重试：${task.status}`);
    }
    const pendingInput = input?.trim() ?? "";
    const updated = this.service.updateTask(taskId, {
      status: "queued",
      nextAction: "等待执行",
      error: null,
      ...(pendingInput ? { pendingInput } : {})
    }, task.currentRunId ?? undefined);
    this.wake();
    return updated;
  }

  private recoverInterruptedTasks(): void {
    const now = new Date().toISOString();
    for (const task of this.service.store.listTasks()) {
      if (task.status !== "running") continue;
      for (const run of this.service.store.listRuns(task.id)) {
        if (run.status !== "running") continue;
        this.service.updateRun(run.id, task.id, {
          status: "failed",
          endedAt: now,
          failure: {
            kind: "interrupted",
            message: "服务重启时任务仍在执行，已中止上一轮运行",
            recoverable: true,
            guidance: "确认工作区后点击重试"
          }
        });
      }
      this.service.updateTask(task.id, {
        status: "recoverable",
        currentRunId: task.currentRunId,
        nextAction: "服务重启后任务中断，可以重试",
        error: {
          kind: "interrupted",
          message: "服务重启中断了上一轮执行",
          recoverable: true,
          guidance: "检查已有产物后点击重试"
        }
      }, task.currentRunId ?? undefined);
      for (const followUp of this.service.store.listTaskFollowUps(task.id, "steering")) {
        this.service.updateTaskFollowUp(followUp.id, { status: "cancelled", error: "服务重启中断了这一轮补充" });
      }
    }
  }

  private resumeWaitingApprovalLeases(): void {
    for (const task of this.service.store.listTasks()) {
      if (task.status !== "waiting_approval") continue;
      if (!this.service.store.listApprovals(task.id).some((approval) => approval.status === "pending")) continue;
      try {
        const lease = this.leases.acquire(task.id);
        this.startLeaseHeartbeat(task.id, lease.epoch, () => this.wake());
      } catch {
        // Another active owner keeps the fence; approval will be refused by the guard.
      }
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const started = this.scheduleAvailable();
        if (started === 0) await this.waitForWake();
      } catch (error) {
        console.error("[scheduler] scheduling failed:", error);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  private executorSettings(): ExecutorSettings {
    return this.staticExecutorSettings ?? this.executorSettingsProvider?.() ?? loadExecutorSettings(this.executorSettingsPath);
  }

  private scheduleAvailable(): number {
    if (this.stopped) return 0;
    const settings = this.executorSettings();
    const queued = this.service.store.listTasks().filter((task) =>
      task.status === "queued"
      && !this.leases.isHeldByOther(task.id)
      && !this.activeByExecutor.get(resolveExecutorId(task))?.has(task.id)
    );
    queued.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    let started = 0;
    const scheduledDelegationExecutors = new Set<ExecutorId>();
    for (const task of queued) {
      if (this.stopped) break;
      if (this.enforceGoalBoundary(task)) continue;
      const executorId = resolveExecutorId(task);
      const delegationJob = this.service.store.getDelegationJobByChildTask(task.id);
      if (delegationJob) {
        if (delegationJob.status !== "queued") continue;
        if (scheduledDelegationExecutors.has(delegationJob.targetExecutor)) continue;
        const executorBusy = this.service.store.listActiveDelegationJobs().some((candidate) =>
          candidate.id !== delegationJob.id
          && candidate.targetExecutor === delegationJob.targetExecutor
          && ["leased", "running"].includes(candidate.status)
        );
        if (executorBusy) continue;
      }
      const active = this.activeByExecutor.get(executorId) ?? new Set<string>();
      const limit = Math.max(1, settings.concurrency[executorId] ?? 1);
      if (active.size >= limit) continue;
      const health = this.executorHealth(executorId, settings);
      const adapterCheck = this.adapters[executorId].canRun({
        task,
        prepared: null,
        settings: this.context.settings(),
        executorSettings: settings,
        modelSettings: this.modelSettingsForExecutor(executorId)
      });
      if (!health.canRun || !adapterCheck.ok) {
        this.markExecutorUnavailable(task, executorId, [
          ...health.issues,
          ...(adapterCheck.reason ? [adapterCheck.reason] : [])
        ]);
        continue;
      }
      if (delegationJob) scheduledDelegationExecutors.add(delegationJob.targetExecutor);
      active.add(task.id);
      this.activeByExecutor.set(executorId, active);
      const promise = this.runTask(task)
        .catch(() => undefined)
        .finally(() => {
          active.delete(task.id);
          this.runPromises.delete(promise);
          this.wake();
        });
      this.runPromises.add(promise);
      started += 1;
    }
    return started;
  }

  private markExecutorUnavailable(task: TaskRecord, executorId: ExecutorId, issues: string[]): void {
    const message = `${executorId === "hermes" ? "Hermes" : executorId} 执行器当前不可用：${issues.join("；") || "未检测到可用配置"}`;
    this.service.updateTask(task.id, {
      status: "recoverable",
      currentRunId: task.currentRunId,
      nextAction: "执行器不可用，配置后重试",
      error: {
        kind: "executor_unavailable",
        message,
        recoverable: true,
        guidance: executorId === "hermes"
          ? "到设置里检查 Hermes 命令路径并点击检测，确认 hermes --version 可用后重试"
          : "检查执行器配置后重试"
      }
    }, task.currentRunId ?? undefined);
  }

  private async waitForWake(): Promise<void> {
    if (this.stopped) return;
    await new Promise<void>((resolve) => {
      this.wakeResolver = resolve;
    });
  }

  private wake(): void {
    const resolve = this.wakeResolver;
    this.wakeResolver = null;
    resolve?.();
  }

  private assertCompleted(result: ExecutionOutcome): void {
    if (result.status === "completed") return;
    if (result.status === "waiting_input") return;
    if (result.status === "cancelled") throw new Error("任务已取消");
    if (result.status === "budget_exceeded") {
      throw new Error(result.finalResponse.trim() || "达到执行预算，任务未完成。可以调整或重试。");
    }
    throw new Error(result.finalResponse.trim() || "执行器没有完成当前任务");
  }

  private restoreResumeState(taskId: string, workspace: string, includeWaitingInput = false): AgentResumeState | undefined {
    const task = this.service.requireTask(taskId);
    const unresolved = this.service.store.listEffects(taskId)
      .filter((effect) => ["prepared", "admitted", "executing", "uncertain"].includes(effect.status));
    if (unresolved.length > 0) {
      throw new Error(`存在状态不确定的外部动作，必须先对账，不能从检查点自动恢复：${unresolved.map((effect) => effect.id).join("、")}`);
    }
    const goal = task.goalId ? this.service.store.getGoal(task.goalId) : null;
    const permissionsDigest = task.permissions ? hashStable(task.permissions) : null;
    const runs = this.service.store.listRuns(taskId).filter((run) => run.status !== "running");
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const run = runs[index];
      if (!run) continue;
      const checkpoint = this.service.store.latestRunCheckpoint(run.id);
      if (!checkpoint || checkpoint.kind === "final") continue;
      if (checkpoint.kind === "waiting_input" && !includeWaitingInput) continue;
      if (checkpoint.proof?.goalId && checkpoint.proof.goalId !== (task.goalId ?? null)) continue;
      if (checkpoint.proof?.goalRevision && goal && checkpoint.proof.goalRevision !== goal.updatedAt) continue;
      if (checkpoint.proof?.permissionsDigest && checkpoint.proof.permissionsDigest !== permissionsDigest) continue;
      try {
        if (run.workspace !== workspace && existsSync(run.workspace)) {
          cpSync(run.workspace, workspace, { recursive: true, force: false });
        }
        const path = isAbsolute(checkpoint.path) ? checkpoint.path : join(this.workspaceRoot, checkpoint.path);
        if (!existsSync(path)) continue;
        const body = readFileSync(path, "utf8");
        if (createHash("sha256").update(body).digest("hex") !== checkpoint.sha256) continue;
        const state = JSON.parse(body) as AgentCheckpoint;
        if (!Array.isArray(state.messages) || !state.usage) continue;
        return {
          messages: state.messages,
          usage: state.usage,
          turns: state.turns,
          toolCalls: state.toolCalls
        };
      } catch {
        // A missing or unreadable checkpoint falls back to a fresh run.
      }
    }
    return undefined;
  }

  private persistNativeCheckpoint(taskId: string, runId: string, workspace: string, checkpoint: AgentCheckpoint): void {
    const directory = join(workspace, ".hearth", "checkpoints", runId);
    mkdirSync(directory, { recursive: true });
    const absolutePath = join(directory, `${String(checkpoint.seq).padStart(4, "0")}-${checkpoint.kind}.json`);
    const body = `${JSON.stringify(checkpoint, null, 2)}\n`;
    writeFileSync(absolutePath, body, "utf8");
    const createdAt = new Date().toISOString();
    const task = this.service.requireTask(taskId);
    const effects = this.service.store.listEffects(taskId);
    const goal = task.goalId ? this.service.store.getGoal(task.goalId) : null;
    const proof: RunCheckpointProof = {
      goalId: task.goalId ?? null,
      attemptId: runId,
      identity: { executorId: "native", runtimeVersion: "0.1.0" },
      phasePrefix: checkpoint.messages
        .filter((message) => message.role === "tool")
        .map((message) => `tool:${message.name}`)
        .concat(`checkpoint:${checkpoint.kind}:${checkpoint.seq}`),
      validation: { status: "not_required", evidenceRefs: [] },
      effectReceipts: effects
        .filter((effect) => ["committed", "succeeded", "reconciled_committed"].includes(effect.status) && (effect.receipt || effect.providerRef))
        .map((effect) => effect.id),
      preparedIntents: effects
        .filter((effect) => ["prepared", "admitted", "executing", "uncertain"].includes(effect.status))
        .map((effect) => effect.id),
      ...(task.permissions ? { permissionsDigest: hashStable(task.permissions) } : {}),
      ...(goal ? { goalRevision: goal.updatedAt } : {}),
      ...(existsSync(workspace) ? { workspaceDigest: digestWorkspace(workspace) } : {}),
      createdAt
    };
    const record: RunCheckpointRecord = {
      id: randomUUID(),
      runId,
      taskId,
      seq: checkpoint.seq,
      kind: checkpoint.kind,
      path: relative(this.workspaceRoot, absolutePath).replace(/\\/g, "/"),
      sha256: createHash("sha256").update(body).digest("hex"),
      usage: checkpoint.usage,
      createdAt,
      proof
    };
    this.service.createRunCheckpoint(record);
    this.service.updateRun(runId, taskId, {
      checkpointSeq: checkpoint.seq,
      usage: this.usageWithMetrics(checkpoint.usage, checkpoint.turns, checkpoint.toolCalls)
    });
  }

  private usageWithMetrics(
    usage: RunRecord["usage"],
    turns?: number,
    toolCalls?: number
  ): RunRecord["usage"] {
    if (!usage && turns === undefined && toolCalls === undefined) return null;
    return {
      ...(usage ?? { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }),
      ...(turns === undefined ? {} : { turns }),
      ...(toolCalls === undefined ? {} : { toolCalls })
    };
  }

  private startLeaseHeartbeat(taskId: string, epoch: number, onLost: () => void, onHeartbeat?: () => void): void {
    const existing = this.leaseHeartbeats.get(taskId);
    if (existing) clearInterval(existing.timer);
    const timer = setInterval(() => {
      try {
        this.leases.heartbeat(taskId, epoch);
        onHeartbeat?.();
      } catch {
        onLost();
        this.releaseLease(taskId);
        this.wake();
      }
    }, this.leaseHeartbeatMs);
    timer.unref?.();
    this.leaseHeartbeats.set(taskId, { epoch, timer });
  }

  private assertLease(taskId: string, epoch: number, leaseLost: boolean): void {
    if (leaseLost) throw new LeaseError("LEASE_FENCED", "任务租约已失去，执行结果已拒绝", 409);
    this.leases.assertHeld(taskId, epoch);
  }

  private releaseLease(taskId: string): void {
    const heartbeat = this.leaseHeartbeats.get(taskId);
    if (!heartbeat) return;
    clearInterval(heartbeat.timer);
    this.leaseHeartbeats.delete(taskId);
    this.leases.release(taskId, heartbeat.epoch);
  }

  private async buildApproval(
    task: TaskRecord,
    template: NonNullable<ReturnType<typeof getTemplate>>,
    prepared: Awaited<ReturnType<typeof prepareWorkspace>>
  ): Promise<Omit<ApprovalRequest, "taskId" | "runId">> {
    if (template.approvalKind === "github.publish-pr") {
      const repository = prepared.repository;
      if (!repository || !repository.issue) throw new Error("创建 PR 前缺少 GitHub 仓库或 Issue 上下文");
      const inspection = await inspectRepository(repository, this.githubRun);
      if (!inspection.clean) throw new Error(`仓库仍有未提交改动：\n${inspection.status}`);
      if (inspection.branch !== repository.branch) throw new Error(`提交所在分支不是 ${repository.branch}`);
      if (inspection.commits < 1) throw new Error("没有检测到本地提交，不能创建 PR");
      const preview = validatePullRequestPreview(
        readPrPreview(join(prepared.outDir, "pr-preview.json")),
        repository
      );
      const summary = `推送 ${repository.repo} 的分支 ${repository.branch} 并创建 PR`;
      const action = this.githubNetworkAction(task, prepared, summary, `github-pr:${repository.repo}#${repository.branch}@${inspection.headSha}:sha256:${actionDigest({
        repo: repository.repo,
        branch: repository.branch,
        base: repository.base,
        headSha: inspection.headSha,
        title: preview.title,
        body: preview.body
      })}`);
      return {
        kind: "github.publish-pr",
        summary,
        target: {
          repo: repository.repo,
          workspace: repository.path,
          branch: repository.branch,
          base: repository.base,
          expectedCommit: inspection.headSha,
          title: preview.title,
          body: preview.body
        },
        preview: {
          repo: repository.repo,
          branch: repository.branch,
          base: repository.base,
          title: preview.title,
          body: preview.body,
          commit: inspection.headSha,
          commits: inspection.commits,
          diffStat: inspection.diffStat
        },
        action
      };
    }

    if (template.approvalKind === "github.comment") {
      const repository = prepared.repository;
      if (!repository || !repository.pull) throw new Error("发布评论前缺少 GitHub PR 上下文");
      const reviewFile = readFileSync(join(prepared.outDir, "pr-review.md"), "utf8").trim();
      if (!reviewFile) throw new Error("评审产物为空，不能发布评论");
      const review = extractProposedComment(reviewFile);
      if (review.length > 60_000) throw new Error("评审评论过长，不能发布");
      const summary = `在 ${repository.repo} PR #${repository.pull} 发布评审评论`;
      const action = this.githubNetworkAction(task, prepared, summary, `github-comment:${repository.repo}#${repository.pull}@${repository.headSha}:sha256:${actionDigest({
        repo: repository.repo,
        pull: repository.pull,
        headSha: repository.headSha,
        body: review
      })}`);
      return {
        kind: "github.comment",
        summary,
        target: {
          repo: repository.repo,
          pull: repository.pull,
          headSha: repository.headSha,
          body: review
        },
        preview: {
          repo: repository.repo,
          pull: repository.pull,
          headSha: repository.headSha,
          title: `评审 PR #${repository.pull}`,
          body: review
        },
        action
      };
    }

    throw new Error(`未实现的审批类型：${template.approvalKind}`);
  }

  private githubNetworkAction(
    task: TaskRecord,
    prepared: Awaited<ReturnType<typeof prepareWorkspace>>,
    summary: string,
    targetRevision: string
  ): ResolvedAction {
    return resolveAction({
      proposal: {
        kind: "network",
        summary,
        network: { host: "api.github.com", port: 443, method: "HTTPS" },
        targetRevision,
        risk: "high",
        sideEffectClass: "external_irreversible"
      },
      permissionMode: this.service.approvalModeForTask(task) === "full" ? "full" : "guarded",
      context: "interactive",
      sessionRoot: prepared.root
    });
  }

  private async deliveryIssues(
    task: TaskRecord,
    prepared: Awaited<ReturnType<typeof prepareWorkspace>>,
    expectedOutputs: string[]
  ): Promise<string[]> {
    const issues = missingExpectedOutputs(prepared.outDir, expectedOutputs)
      .map((missing) => `缺少期望产物：${missing}`);
    const template = task.templateId ? getTemplate(task.templateId) : undefined;
    if (template?.github?.issue && prepared.repository) {
      const inspection = await inspectRepository(prepared.repository, this.githubRun);
      if (!inspection.clean) issues.push(`仓库仍有未提交改动：\n${inspection.status}`);
      if (inspection.branch !== prepared.repository.branch) {
        issues.push(`提交所在分支不是 ${prepared.repository.branch}`);
      }
      if (inspection.commits < 1) issues.push("没有检测到本地提交，实现任务必须先创建本地 commit");
    }
    return issues;
  }

  private async failRun(taskId: string, runId: string, error: unknown, aborted: boolean, leaseEpoch: number): Promise<void> {
    const endedAt = new Date().toISOString();
    const task = this.service.store.getTask(taskId);
    if (!task) return;
    try {
      this.leases.assertHeld(taskId, leaseEpoch);
    } catch {
      this.service.updateRun(runId, taskId, {
        status: "failed",
        endedAt,
        failure: {
          kind: "lease_fenced",
          message: "任务已被其他实例接管，这次执行的结果已丢弃",
          recoverable: false,
          guidance: "以当前任务所有者记录的状态为准"
        }
      });
      return;
    }
    const userCancelled = this.cancelled.has(taskId) || task.status === "cancelled";
    const message = error instanceof Error ? error.message : String(error);

    if (userCancelled) {
      this.service.updateRun(runId, taskId, { status: "cancelled", endedAt });
      return;
    }

    const failure = error instanceof HermesApprovalRequiredError
      ? {
          kind: "executor_approval_required",
          message,
          recoverable: true,
          guidance: "在设置里完成 Hermes 授权，或把当前对话切换为完全权限后重试"
        }
      : error instanceof HermesStartupError
        ? {
            kind: "executor_unavailable",
            message,
            recoverable: true,
            guidance: "到设置里检查 Hermes 命令路径并点击检测"
          }
      : aborted && this.stopping
      ? {
          kind: "interrupted",
          message: "Hearth 关闭时中止了这一轮执行",
          recoverable: true,
          guidance: "重新启动后点击重试"
        }
      : error instanceof CapabilityUnavailableError
      ? {
          kind: "capability_unavailable",
          message,
          recoverable: true,
          guidance: "在对话输入框上方启用 Codex 或 Hermes 后重新发送"
        }
      : {
          kind: error instanceof UnsupportedInputError ? "input_unavailable" : "execution_failed",
          message,
          recoverable: true,
          guidance: error instanceof UnsupportedInputError ? "接入对应的抓取能力后重试" : "查看运行记录后重试"
        };

    this.service.updateRun(runId, taskId, { status: "failed", endedAt, failure });
    if (task.status === "running" || task.status === "waiting_input" || task.status === "waiting_approval") {
      this.service.updateTask(taskId, {
        status: "recoverable",
        currentRunId: runId,
        nextAction: "执行中断，可以重试",
        error: failure
      }, runId);
    }
  }

  private publishProgress(taskId: string, runId: string, kind: string, message: string, detail?: TaskProgressDetail): void {
    const sanitized = sanitizeProgressDetail(detail);
    const event = this.service.store.appendEvent({
      type: "task.progress",
      taskId,
      runId,
      payload: { kind, message, at: new Date().toISOString(), ...(sanitized ? { detail: sanitized } : {}) }
    });
    this.service.bus.publish(event);
  }
  private async runTask(startingTask: TaskRecord): Promise<void> {
    const taskId = startingTask.id;
    let lease: TaskLease;
    try {
      lease = this.leases.acquire(taskId);
    } catch (error) {
      if (error instanceof LeaseError && error.code === "LEASE_HELD") return;
      throw error;
    }
    const leaseEpoch = lease.epoch;
    const delegationJob = this.service.store.getDelegationJobByChildTask(taskId);
    const delegationJobId = delegationJob?.id ?? null;
    const delegationOwner = delegationJob ? `scheduler:${this.leases.ownerId}` : null;
    let delegationHeartbeat: (() => void) | null = null;
    const controller = new AbortController();
    let leaseLost = false;
    this.startLeaseHeartbeat(taskId, leaseEpoch, () => {
      leaseLost = true;
      controller.abort();
    }, () => delegationHeartbeat?.());
    this.controllers.set(taskId, controller);
    try {
      if (delegationJobId && delegationOwner) {
        const currentJob = this.service.store.getDelegationJob(delegationJobId);
        if (!currentJob || currentJob.status === "cancelled") {
          if (this.service.store.getTask(taskId)?.status !== "cancelled") {
            this.service.updateTask(taskId, {
              status: "cancelled",
              nextAction: null,
              error: null
            });
          }
          return;
        }
        if (!["queued", "leased", "running"].includes(currentJob.status)) {
          this.service.updateTask(taskId, {
            status: "recoverable",
            nextAction: "委派已结束，请从父任务重试或验收",
            error: {
              kind: "delegation_closed",
              message: `委派当前状态为 ${currentJob.status}`,
              recoverable: true,
              guidance: "回到父任务查看委派结果，必要时重试"
            }
          });
          return;
        }
        try {
          this.delegations.lease(currentJob.id, delegationOwner);
          this.delegations.start(currentJob.id, delegationOwner);
        } catch (error) {
          if (error instanceof DelegationError && error.code === "DELEGATION_EXECUTOR_BUSY") {
            this.service.updateTask(taskId, { status: "queued", nextAction: "等待同一执行器完成当前委派" });
            return;
          }
          throw error;
        }
        delegationHeartbeat = () => {
          this.delegations.heartbeat(currentJob.id, delegationOwner);
        };
      }
      const initialTask = this.service.requireTask(taskId);
      let methodPlan: { method: MethodCandidate; selection: MethodSelection } | null = null;
      try {
        methodPlan = this.methods.resolveForTask(initialTask);
      } catch {
        methodPlan = null;
      }
      const preparedHandoff = [...this.service.store.listHandoffs(taskId)].reverse().find((item) => item.status === "prepared") ?? null;
      let handoff: HandoffRecord | null = preparedHandoff;
      let executorId: ExecutorId = handoff?.toExecutor ?? resolveExecutorId(initialTask);
      let pendingInput = initialTask.pendingInput?.trim() ?? "";
      let resumePrompt: string | null = pendingInput ? `用户补充信息：\n${pendingInput}` : null;
      const retriesByExecutor = new Map<ExecutorId, number>();
      let handoffsUsed = this.service.store.listHandoffs(taskId).filter((item) => item.status !== "cancelled").length;
      const attemptedExecutors = new Set<ExecutorId>(this.service.store.listRuns(taskId).map((run) => run.executorId ?? "codex"));
      attemptedExecutors.add(executorId);
      let previousRun = this.latestRun(taskId, handoff?.fromRunId ?? null);
      if (handoff) {
        this.context.updateHandoff(handoff.id, { status: "running" });
        this.appendHandoffNotice(taskId, handoff);
      }
      for (;;) {
        const task = this.service.requireTask(taskId);
        if (this.enforceGoalBoundary(task)) return;
        if (this.cancelled.has(taskId) || task.status === "cancelled") {
          if (handoff) this.context.updateHandoff(handoff.id, { status: "cancelled" });
          return;
        }
        let appliedFollowUp: TaskFollowUpRecord | null = null;
        if (!pendingInput) {
          appliedFollowUp = this.takeNextFollowUp(taskId);
          if (appliedFollowUp) {
            pendingInput = appliedFollowUp.content.trim();
            resumePrompt = `用户补充信息：\n${pendingInput}`;
            this.steering.delete(taskId);
          }
        }
        const attempt = this.service.store.listRuns(taskId).length + 1;
        const runId = randomUUID();
        const taskRoot = this.taskRoot(taskId);
        const outDir = join(taskRoot, "out", runId);
        mkdirSync(join(taskRoot, "out"), { recursive: true });
        const previousOutDir = previousRun ? this.outDirForRun(taskId, previousRun) : null;
        if (previousOutDir && existsSync(previousOutDir)) cpSync(previousOutDir, outDir, { recursive: true, force: true });
        const remainingBudget = this.remainingBudget(taskId);
        const now = new Date().toISOString();
        const run: RunRecord = {
          id: runId, taskId, attempt, status: "running", threadId: null, workspace: taskRoot,
          startedAt: now, endedAt: null, failure: null, usage: null, leaseEpoch, createdAt: now,
          executorId, checkpointSeq: 0, budget: remainingBudget,
          parentRunId: previousRun?.id ?? null, handoffId: handoff?.id ?? null
        };
        this.service.createRun(run);
        if (appliedFollowUp) {
          this.service.updateTaskFollowUp(appliedFollowUp.id, {
            status: "applied", appliedRunId: runId, error: null
          });
        }
        this.service.updateTask(taskId, {
          status: "running", currentRunId: runId,
          nextAction: handoff ? `${executorId} 接管执行中` : "正在执行",
          error: null, pendingInput: null
        }, runId);
        const result = await this.runAttempt({ task, run, executorId, taskRoot, outDir, handoff, pendingInput, resumePrompt, previousRun, controller, budget: remainingBudget, methodPlan });
        if (result.status === "failed" || this.service.requireTask(taskId).status !== "completed") {
          this.assertLease(taskId, leaseEpoch, leaseLost);
        }
        if (result.steered) {
          if (handoff) {
            this.context.updateHandoff(handoff.id, { status: "cancelled", toRunId: result.run.id });
            handoff = null;
          }
          previousRun = result.run;
          pendingInput = "";
          resumePrompt = null;
          this.refreshTaskSummary(taskId);
          continue;
        }
        if (result.status !== "failed") {
          if (handoff && result.status !== "cancelled" && result.status !== "waiting_input") this.context.updateHandoff(handoff.id, { status: "completed", toRunId: runId });
          this.refreshTaskSummary(taskId);
          if (result.status === "completed" && result.queuedFollowUp) {
            previousRun = result.run;
            pendingInput = "";
            resumePrompt = null;
            continue;
          }
          return;
        }
        if (result.cancelled || result.leaseLost) {
          if (handoff) this.context.updateHandoff(handoff.id, { status: result.cancelled ? "cancelled" : "failed", toRunId: runId });
          this.refreshTaskSummary(taskId, { lastFailure: result.failure });
          return;
        }
        if (result.status === "failed" && this.enforceGoalBoundary(this.service.requireTask(taskId), result.failure)) return;
        previousRun = result.run;
        if (handoff) {
          this.context.updateHandoff(handoff.id, { status: "failed", toRunId: runId });
          handoff = null;
        }
        const failureTask = this.service.requireTask(taskId);
        const cause = classifyFailure({ service: this.service, task: failureTask, run: result.run, error: result.error, aborted: result.aborted, stopping: this.stopping });
        const uncertainEffect = this.service.store.listEffects(taskId)
          .find((effect) => effect.status === "uncertain" || effect.status === "executing");
        const failureClass = classifyFailureClass({
          message: result.failure?.message ?? (result.error instanceof Error ? result.error.message : String(result.error)),
          code: errorCode(result.error),
          aborted: result.aborted,
          stopping: this.stopping,
          effectUncertain: Boolean(uncertainEffect),
          validatorFailed: cause === "contract_failure",
          budgetExhausted: cause === "budget"
        });
        const settings = this.context.settings();
        const disposition = decideDisposition({
          failure: failureClass,
          attempt: (retriesByExecutor.get(executorId) ?? 0) + 1,
          maxAttempts: settings.maxSameExecutorRetries + 1,
          effectId: uncertainEffect?.id ?? null,
          repairTarget: (failureTask.expectedOutputs ?? []).join(", ") || "deliverable"
        });
        const target = this.selectHandoffTarget({ task: failureTask, cause, settings, attemptedExecutors, handoffsUsed, taskRoot });
        const diagnosis = await this.diagnoseFailure(taskId, failureTask, result.run, result.error, cause, target.targetExecutor);
        let decision = this.decideNextAction({
          task: failureTask,
          cause,
          effectiveCause: diagnosis.cause,
          target,
          diagnosis,
          settings,
          approvalMode: this.service.approvalModeForTask(failureTask),
          retriesUsed: retriesByExecutor.get(executorId) ?? 0,
          handoffsUsed,
          attemptedExecutors,
          taskRoot
        });
        if (decision.action === "retry_same" && (!canBlindRetry(failureClass) || disposition.type !== "retry")) {
          decision = {
            ...decision,
            action: "ask_user",
            autoAllowed: false,
            reason: `${decision.reason}；失败类别 ${failureClass} 不允许盲重试`
          };
        }
        this.capture({
          taskId, conversationId: failureTask.conversationId ?? null, runId: result.run.id, executorId,
          kind: "decision", role: "system", content: `${decision.action}：${decision.reason}`,
          provenance: { source: "fallback-policy", decision, cause, failureClass, disposition, diagnosisId: diagnosis.id },
          executorEventId: `decision:${result.run.id}`
        });
        if (decision.action === "retry_same") {
          retriesByExecutor.set(executorId, (retriesByExecutor.get(executorId) ?? 0) + 1);
          resumePrompt = `上一轮执行未完成：${clipText(result.failure?.message ?? String(result.error), 1800)}。请从当前工作区继续，不要重复已经完成的步骤。`;
          continue;
        }
        if (settings.mode === "shadow") {
          const shadowError: TaskError = {
            ...(result.failure ?? { kind: "execution_failed", message: decision.reason, recoverable: true, guidance: "查看诊断后决定是否重试" }),
            cause, diagnosisId: diagnosis.id, failureClass, disposition
          };
          this.service.updateTask(taskId, {
            status: "recoverable", currentRunId: result.run.id,
            nextAction: "shadow 模式仅记录诊断，不自动接管", error: shadowError
          }, result.run.id);
          this.refreshTaskSummary(taskId, { lastFailure: shadowError });
          return;
        }
        if (decision.action === "handoff" && decision.targetExecutor) {
          const packet = this.projector.buildPacket({
            taskId, fromRunId: result.run.id, fromExecutor: executorId, toExecutor: decision.targetExecutor,
            remainingBudget: this.remainingBudget(taskId), diagnosisSummary: diagnosis.summary, outDir: result.outDir
          });
          const status = decision.autoAllowed ? "prepared" : "pending_user";
          const preparedHandoff = this.handoffs.prepare({
            taskId, fromRunId: result.run.id, fromExecutor: executorId, toExecutor: decision.targetExecutor,
            status, reasonCode: cause, diagnosis, packet,
            contextWatermarkSeq: this.context.getState(taskId)?.summarySeq ?? 0, initiatedBy: "auto"
          });
          const finalPacket: HandoffPacket = preparedHandoff.packet;
          const verification = this.handoffs.verify(finalPacket, { baseDir: result.outDir });
          const verifiedHandoff = this.handoffs.markVerification(preparedHandoff.handoff.id, verification)
            ?? preparedHandoff.handoff;
          const verifiedPacket = verifiedHandoff.packet ?? finalPacket;
          const handoffArtifact = this.writeHandoffFile(
            failureTask,
            result.run,
            taskRoot,
            result.outDir,
            verifiedHandoff.id,
            verifiedPacket
          );
          const currentHandoff: HandoffRecord = this.context.updateHandoff(verifiedHandoff.id, {
            artifactRef: handoffArtifact.id,
            ...(verification.status === "failed" ? { status: "failed" as const } : {})
          }) ?? verifiedHandoff;
          if (verification.status !== "passed") {
            this.appendHandoffNotice(taskId, currentHandoff, false);
            const failedChecks = verification.checks
              .filter((check) => !check.ok)
              .map((check) => `${check.name}: ${check.detail}`)
              .join("；");
            const handoffError: TaskError = {
              kind: "handoff_verification_failed",
              message: `交接验证失败：${failedChecks || "未知错误"}`,
              recoverable: true,
              guidance: "交接包未通过宿主校验，已阻止执行器切换；请修复证据或产物后重试",
              cause,
              diagnosisId: diagnosis.id,
              failureClass: "validation_failed",
              disposition
            };
            this.service.updateTask(taskId, {
              status: "recoverable",
              currentRunId: result.run.id,
              nextAction: "交接验证失败，未切换执行器",
              error: handoffError,
              resultSummary: handoffError.message
            }, result.run.id);
            this.refreshTaskSummary(taskId, { lastFailure: handoffError });
            return;
          }
          if (status === "prepared") {
            executorId = decision.targetExecutor;
            attemptedExecutors.add(decision.targetExecutor);
            handoffsUsed += 1;
            handoff = currentHandoff;
            resumePrompt = null;
            pendingInput = "";
            this.service.updateTask(taskId, { executorId: decision.targetExecutor, nextAction: `${decision.targetExecutor} 接管中` }, result.run.id);
            continue;
          }
          this.appendHandoffNotice(taskId, currentHandoff, false);
          const taskError: TaskError = {
            ...(result.failure ?? { kind: "execution_failed", message: decision.reason, recoverable: true, guidance: "确认后可以切换执行器继续" }),
            cause, diagnosisId: diagnosis.id, failureClass, disposition
          };
          this.service.updateTask(taskId, {
            status: "waiting_input", currentRunId: result.run.id,
            nextAction: `是否切换到 ${executorName(decision.targetExecutor)} 继续？`, error: taskError,
            resultSummary: decision.reason
          }, result.run.id);
          this.refreshTaskSummary(taskId, { lastFailure: taskError });
          return;
        }
        const taskError: TaskError = {
          ...(result.failure ?? { kind: "execution_failed", message: decision.reason, recoverable: true, guidance: "查看运行记录后重试" }),
          cause, diagnosisId: diagnosis.id, failureClass, disposition
        };
        const diagnosisSummary = diagnosis.source === "model" ? diagnosis.summary : decision.reason;
        if (result.failure?.kind === "input_unavailable") {
          this.service.updateTask(taskId, {
            status: "recoverable", currentRunId: result.run.id,
            nextAction: this.nextActionForCause(cause), error: taskError, resultSummary: diagnosisSummary
          }, result.run.id);
        } else if (cause === "permission" || cause === "budget" || cause === "input_missing" || cause === "effect_uncertain") {
          this.service.updateTask(taskId, {
            status: "waiting_input", currentRunId: result.run.id,
            nextAction: this.nextActionForCause(cause),
            error: taskError, resultSummary: diagnosisSummary
          }, result.run.id);
        } else {
          this.service.updateTask(taskId, {
            status: "recoverable", currentRunId: result.run.id,
            nextAction: decision.reason || this.nextActionForCause(cause), error: taskError,
            resultSummary: diagnosisSummary
          }, result.run.id);
        }
        this.refreshTaskSummary(taskId, { lastFailure: taskError });
        return;
      }
    } finally {
      this.finalizeDelegation(taskId, delegationJobId, delegationOwner);
      this.controllers.delete(taskId);
      this.cancelled.delete(taskId);
      if (this.service.store.getTask(taskId)?.status !== "waiting_approval") this.releaseLease(taskId);
      this.learnFromTask(taskId);
      try {
        this.memory.captureExperience(taskId);
      } catch {
        // Experience capture is best effort and never changes the task outcome.
      }
      try {
        const finalTask = this.service.store.getTask(taskId);
        if (finalTask && ["completed", "failed", "recoverable", "cancelled"].includes(finalTask.status)) {
          this.ontologyWriter.captureTaskOutcome(taskId);
        }
      } catch {
        // Ontology writeback is best effort and never changes the task outcome.
      }
    }
  }

  private finalizeDelegation(taskId: string, jobId: string | null, owner: string | null): void {
    if (!jobId || !owner) return;
    try {
      const job = this.service.store.getDelegationJob(jobId);
      if (!job || !["leased", "running"].includes(job.status) || job.lease?.owner !== owner) return;
      const task = this.service.store.getTask(taskId);
      if (!task) {
        this.delegations.fail(jobId, "子任务记录丢失", false);
        return;
      }
      if (task.status === "completed") {
        const artifacts = this.service.store.listArtifacts(taskId);
        const evidenceRefs = artifacts.map((artifact) => `artifact:${artifact.id}`);
        if (evidenceRefs.length === 0) evidenceRefs.push(`run:${task.currentRunId ?? task.id}`);
        const result: DelegationResult = {
          summary: task.resultSummary?.trim() || "子任务已完成",
          evidenceRefs,
          artifacts: artifacts.map((artifact) => artifact.relativePath),
          unresolved: [],
          status: "completed",
          producedAt: new Date().toISOString()
        };
        this.delegations.complete(jobId, result);
        return;
      }
      if (task.status === "cancelled") {
        this.delegations.cancel(jobId, "子任务已取消");
        return;
      }
      if (task.status === "waiting_input" || task.status === "waiting_approval") {
        this.delegations.requeue(jobId, owner);
        return;
      }
      const message = task.error?.message ?? task.nextAction ?? `子任务以 ${task.status} 结束`;
      this.delegations.fail(jobId, message, task.error?.recoverable !== false);
    } catch (error) {
      console.error("[scheduler] delegation finalization failed:", error);
    }
  }

  private learnFromTask(taskId: string): void {
    try {
      const task = this.service.store.getTask(taskId);
      if (!task || !["completed", "failed", "recoverable"].includes(task.status)) return;
      if (task.methodId) {
        try {
          this.methods.recordTrial(task.methodId, taskId);
        } catch {
          // Trial evidence is best effort; explicit recording remains available.
        }
        return;
      }
      if (!this.autoLearn || !this.methods.settings().autoLearn) return;
      if (task.status !== "completed") return;
      if (this.service.store.listContextItems(taskId, { limit: 3 }).items.length < 3) return;
      this.methods.autoLearnFromTask(taskId);
    } catch {
      // Learning must never change the task outcome.
    }
  }

  private async runAttempt(input: {
    task: TaskRecord;
    run: RunRecord;
    executorId: ExecutorId;
    taskRoot: string;
    outDir: string;
    handoff: HandoffRecord | null;
    pendingInput: string;
    resumePrompt: string | null;
    previousRun: RunRecord | null;
    controller: AbortController;
    budget: RunBudget;
    methodPlan: { method: MethodCandidate; selection: MethodSelection } | null;
  }): Promise<AttemptResult> {
    const { task, run, executorId, taskRoot, outDir, handoff, pendingInput, controller, budget } = input;
    const taskId = task.id;
    const runId = run.id;
    try {
      this.recordRunInput(task, run, pendingInput);
      const template = task.templateId ? getTemplate(task.templateId) : undefined;
      const hasGithubInput = task.inputs.some((item) => item.kind === "github");
      if (executorId === "native" && !hasGithubInput && needsGithubRepository(task.title + " " + task.goal)) {
        throw new CapabilityUnavailableError("这个任务需要读取你的 GitHub 仓库（PR / 评审 / rebase），Native 执行器只能访问隔离工作区。请在对话输入框上方启用 Codex 或 Hermes 后重新发送。");
      }
      const expectedOutputs = template?.expectedOutputs ?? expectedOutputsForTask(task);
      const fullPermission = this.service.approvalModeForTask(task) === "full";
      const permissionNote = fullPermission
        ? "\n\n完全权限：当前对话已授权你自主决策。不要向用户提问或等待确认；遇到不确定项时选择最安全、可撤销的处理方式，并在最终结果中说明假设。"
        : "";
      const executorModelSettings = this.modelSettingsForExecutor(executorId);
      const nativeSettings = executorId === "native" ? executorModelSettings : null;
      const dshSettings = executorId === "deepseek-harness" ? executorModelSettings : null;
      if (executorId === "native" && (!nativeSettings || !chatModelConfigured(nativeSettings))) {
        throw new Error("还没有配置聊天模型。请到“设置”里选择服务商并填入 API Key，然后重试。");
      }
      const resumeState = executorId === "native" && !handoff ? this.restoreResumeState(taskId, taskRoot, Boolean(pendingInput)) : undefined;
      const prepared = await prepareWorkspace({
        repoRoot: this.repoRoot,
        workspaceDir: taskRoot,
        outDir,
        task,
        githubCacheRoot: this.githubCacheRoot,
        sourceContentRoot: this.sourceContentRoot,
        getSourceItem: (itemId) => this.service.store.getSourceItem(itemId),
        ...(this.attachmentRoot ? { attachmentRoot: this.attachmentRoot } : {}),
        ...(this.githubRun ? { githubRun: this.githubRun } : {})
      });
      this.assertLease(taskId, run.leaseEpoch ?? 0, controller.signal.aborted && this.stopping);
      let runtime: RuntimePreparation | null = null;
      if (prepared.repository && template?.github?.runtime) {
        runtime = await this.runtimePreparer({ spec: template.github.runtime, repoPath: prepared.repository.path, workspaceRoot: prepared.root });
        if (!runtime.ok && !template.github.runtime.optional) {
          throw new UnsupportedInputError(`依赖环境准备失败：${runtime.errors.join("；")}。日志：${runtime.logPath}`);
        }
      }
      let memoryContext = "";
      try {
        memoryContext = this.memory.recall({ taskId, runId, text: template?.goal ?? "" }).contextPack;
      } catch {
        memoryContext = "";
      }
      if (memoryContext) {
        this.capture({
          taskId, conversationId: task.conversationId ?? null, runId, executorId,
          kind: "memory_recall", role: "system", content: memoryContext,
          provenance: { source: "memory-service" }, executorEventId: `memory:${runId}`
        });
      }
      const methodContext = input.methodPlan ? renderMethodBlock(input.methodPlan.method) : "";
      const basePrompt = buildTaskPrompt(task, prepared, expectedOutputs, template?.acceptance ?? [], runtime, template?.approvalKind, memoryContext, methodContext) + permissionNote;
      const handoffPrompt = handoff?.packet
        ? this.buildHandoffPrompt(task, prepared, expectedOutputs, handoff.packet, permissionNote, memoryContext, methodContext)
        : null;
      let prompt = handoffPrompt?.prompt ?? basePrompt;
      let contextPackId = handoffPrompt?.packId ?? null;
      if (!contextPackId && this.contextBroker) {
        try {
          const pack = this.contextBroker.compile({
            scopeKind: "task",
            scopeId: task.id,
            goalId: task.goalId ?? null,
            taskId: task.id,
            query: [task.goal, task.nextAction ?? "", memoryContext, methodContext].filter(Boolean).join("\n"),
            budgetTokens: Math.max(500, Math.floor(this.context.settings().projectionTokenBudget * 0.25)),
            parentPackId: this.inheritedPackId(task.id)
          });
          prompt = `${prompt}\n\n## 个人上下文包\npack: ${pack.id}\n${this.contextBroker.render(pack)}`;
          contextPackId = pack.id;
        } catch {
          contextPackId = null;
        }
      }
      if (pendingInput && !resumeState && executorId !== "codex") prompt = `${basePrompt}\n\n用户补充信息：\n${pendingInput}`;
      let activeThreadId = !handoff && input.previousRun?.executorId === executorId
        ? input.previousRun.threadId ?? undefined
        : undefined;
      if (executorId === "codex" && activeThreadId && input.resumePrompt) prompt = input.resumePrompt;
      if (methodContext && input.methodPlan) {
        if (prompt.includes(methodContext)) {
          const promptSha256 = createHash("sha256").update(methodContext).digest("hex");
          try {
            this.methods.recordApplication({
              taskId, runId,
              methodId: input.methodPlan.method.id,
              methodVersion: input.methodPlan.method.version,
              selection: input.methodPlan.selection,
              promptSha256
            });
          } catch {
            // Method audit is best effort and never blocks execution.
          }
          this.capture({
            taskId, conversationId: task.conversationId ?? null, runId, executorId,
            kind: "method", role: "system", content: methodContext,
            provenance: {
              source: "method-selection",
              methodId: input.methodPlan.method.id,
              methodVersion: input.methodPlan.method.version,
              generation: input.methodPlan.method.generation ?? null,
              selection: input.methodPlan.selection,
              promptSha256
            },
            executorEventId: `method:${runId}`
          });
        } else {
          this.capture({
            taskId, conversationId: task.conversationId ?? null, runId, executorId,
            kind: "notice", role: "system",
            content: `方法“${input.methodPlan.method.name}”v${input.methodPlan.method.version} 未注入本轮提示词（命中续接或预算限制）。`,
            provenance: {
              source: "method-selection",
              methodId: input.methodPlan.method.id,
              methodVersion: input.methodPlan.method.version,
              selection: input.methodPlan.selection
            },
            executorEventId: `method:${runId}:skipped`
          });
        }
      }
      const extraNativeTools: import("@hearth/agent-runtime").AgentTool[] = createPersonalReadTools({
        service: this.service,
        ontology: this.ontology
      });
      if (contextPackId && this.contextBroker) extraNativeTools.push(this.expandRefTool(contextPackId));
      if (this.backgroundTools) extraNativeTools.push(...this.backgroundTools.toolsFor(task));
      const adapter = this.adapters[executorId];
      const attemptContext: ExecutorAttemptContext = {
        task,
        run,
        prepared,
        budget,
        signal: controller.signal,
        fullPermission,
        contextSettings: this.context.settings(),
        nativeSettings,
        dshSettings,
        executorSettings: this.executorSettings(),
        expectedOutputs,
        ...(extraNativeTools.length > 0 ? { extraNativeTools } : {}),
        ...(activeThreadId ? { activeThreadId } : {}),
        onProgress: (event) => this.publishProgress(taskId, runId, event.kind, event.message, event.detail),
        onNativeContextEvent: (event) => this.captureNativeEvent(task, run, event),
        onNativeCheckpoint: (checkpoint) => this.persistNativeCheckpoint(taskId, runId, prepared.root, checkpoint),
        ...(executorId === "native"
          ? {
              onAuthorizeTool: (request) => this.authorizeNativeTool({
                task,
                run,
                request,
                fullPermission,
                workspaceRoot: prepared.root,
                signal: controller.signal
              })
            }
          : {}),
        ...(executorId === "deepseek-harness"
          ? {
              onDshApprovalRequest: (request) => this.authorizeDshTool({
                task,
                run,
                request,
                fullPermission,
                signal: controller.signal
              })
            }
          : {}),
        onExternalContextItem: (event) => this.captureExternalContextEvent(task, run, event),
        onDshContextItem: (event) => this.captureDshContextEvent(task, run, event),
        onCodexContextItem: (item) => this.captureCodexItem(task, run, item),
        onCodexThreadStarted: (threadId) => {
          activeThreadId = threadId;
          attemptContext.activeThreadId = threadId;
          run.threadId = threadId;
          this.service.updateRun(runId, taskId, { threadId });
        }
      };
      const execute = async (executionPrompt: string, resume?: AgentResumeState, resumePrompt?: string): Promise<ExecutionOutcome> => {
        const invocation = {
          ...attemptContext,
          prompt: executionPrompt,
          ...(resumePrompt ? { resumePrompt } : {})
        };
        if (resume && adapter.resume) return adapter.resume({ ...invocation, resume });
        return adapter.execute(invocation);
      };

      const rememberSession = (outcome: ExecutionOutcome) => {
        if (!outcome.threadId) return;
        activeThreadId = outcome.threadId;
        attemptContext.activeThreadId = outcome.threadId;
        if (run.threadId !== outcome.threadId) {
          run.threadId = outcome.threadId;
          this.service.updateRun(runId, taskId, { threadId: outcome.threadId });
        }
      };
      let result = await execute(prompt, resumeState, input.resumePrompt ?? undefined);
      rememberSession(result);
      this.assertLease(taskId, run.leaseEpoch ?? 0, controller.signal.aborted && this.stopping);
      if (result.status === "waiting_input") return this.finishWaitingInput(taskId, run, result);
      this.assertCompleted(result);
      for (let repairAttempt = 1; repairAttempt <= 2; repairAttempt += 1) {
        const issues = await this.deliveryIssues(task, prepared, expectedOutputs);
        if (issues.length === 0) break;
        const missing = missingExpectedOutputs(prepared.outDir, expectedOutputs);
        const repairPrompt = buildDeliveryRepairPrompt({ task, prepared, expectedOutputs, missing, issues, attempt: repairAttempt, ...(methodContext ? { methodContext } : {}) }) + permissionNote;
        result = await execute(repairPrompt, result.resume, repairPrompt);
        rememberSession(result);
        this.assertLease(taskId, run.leaseEpoch ?? 0, controller.signal.aborted && this.stopping);
        if (result.status === "waiting_input") return this.finishWaitingInput(taskId, run, result);
        this.assertCompleted(result);
      }
      const remainingIssues = await this.deliveryIssues(task, prepared, expectedOutputs);
      if (remainingIssues.length > 0) throw new Error(remainingIssues.join("\n"));
      if (!result.finalResponse.trim()) throw new Error("执行器没有返回最终总结");
      this.assertLease(taskId, run.leaseEpoch ?? 0, controller.signal.aborted && this.stopping);
      const artifacts = publishArtifacts({
        task, run, outDir: prepared.outDir, artifactBase: this.artifactBase, expectedOutputs, inputs: prepared.inputs,
        excludeRelativePaths: ["HANDOFF.md"],
        executor: { id: executorId, threadId: result.threadId, label: result.label, usage: result.usage },
        ...(executorId === "codex" ? { codex: { threadId: result.threadId, profileLabel: result.label, usage: result.usage } } : {})
      });
      for (const artifact of artifacts) {
        this.service.publishArtifact(artifact);
        this.capture({
          taskId, conversationId: task.conversationId ?? null, runId, executorId,
          kind: "artifact", role: "system", content: `${artifact.relativePath}\nsha256: ${artifact.sha256}\nbytes: ${artifact.bytes}`,
          provenance: { source: "artifact", artifactId: artifact.id, path: artifact.relativePath, mimeType: artifact.mimeType },
          executorEventId: `artifact:${artifact.id}`
        });
      }
      if (result.finalResponse.trim()) {
        this.capture({
          taskId, conversationId: task.conversationId ?? null, runId, executorId,
          kind: "assistant_message", role: "assistant", content: result.finalResponse,
          provenance: { source: "executor-final", executorId, label: result.label }, executorEventId: `final:${runId}`
        });
      }
      this.service.updateRun(runId, taskId, {
        status: "completed", threadId: result.threadId, endedAt: new Date().toISOString(),
        usage: this.usageWithMetrics(result.usage, result.turns, result.toolCalls), executorId, failure: null
      });
      if (template && template.approvalKind !== "none") {
        if (!this.approvals) throw new Error("审批管理器未启动，无法安全执行外部动作");
        const request = await this.buildApproval(task, template, prepared);
        this.assertLease(taskId, run.leaseEpoch ?? 0, controller.signal.aborted && this.stopping);
        this.service.updateTask(taskId, {
          status: "waiting_approval", currentRunId: runId, nextAction: "等待你确认外部动作",
          error: null, resultSummary: result.finalResponse
        }, runId);
        await this.approvals.request({ ...request, taskId, runId });
        return { status: "waiting_approval", run: { ...run, status: "completed" }, executorId, outDir, error: null, failure: null, aborted: controller.signal.aborted, leaseLost: false, cancelled: false };
      }
      if (this.hasPendingFollowUp(taskId)) {
        this.service.updateTask(taskId, {
          status: "running", currentRunId: runId, nextAction: "收到补充信息，正在继续",
          error: null, resultSummary: result.finalResponse
        }, runId);
        this.refreshTaskSummary(taskId);
        return { status: "completed", run: { ...run, status: "completed", threadId: result.threadId, usage: this.usageWithMetrics(result.usage, result.turns, result.toolCalls) }, executorId, outDir, error: null, failure: null, aborted: controller.signal.aborted, leaseLost: false, cancelled: false, queuedFollowUp: true };
      }
      const goal = task.goalId ? this.service.store.getGoal(task.goalId) : null;
      if (goal) {
        const goalTasks = this.service.store.listTasks().filter((item) => item.goalId === goal.goalId);
        const goalArtifacts = goalTasks.flatMap((item) => this.service.store.listArtifacts(item.id));
        const goalEffects = goalTasks.flatMap((item) => this.service.store.listEffects(item.id));
        this.service.updateGoal(goal.goalId, { currentState: "validating" });
        const report = await judgeCompletion({
          goal,
          task: this.service.requireTask(taskId),
          artifacts: goalArtifacts,
          effects: goalEffects,
          workspaceRoot: prepared.root,
          sandbox: this.sandbox,
          ...(this.completionValidators ? { validators: this.completionValidators } : {})
        });
        this.service.recordCompletionReport(report);
        this.capture({
          taskId, conversationId: task.conversationId ?? null, runId, executorId,
          kind: "notice", role: "system", content: `完成判定 ${report.verdict}：${report.summary}`,
          provenance: { source: "completion-judge", report }, executorEventId: `completion:${runId}`
        });
        if (report.verdict !== "pass") {
          const blockedEffect = goalEffects.find((effect) => effect.status === "uncertain" || effect.status === "executing");
          const failureClass = report.verdict === "blocked" ? "effect_unknown" : "validation_failed";
          const disposition = report.verdict === "blocked"
            ? { type: "reconcile" as const, effectId: blockedEffect?.id ?? "" }
            : { type: "repair" as const, target: goal.successCriteria.map((criterion) => criterion.check).join(", ") || goal.objective, reason: report.summary };
          const goalError: TaskError = {
            kind: "completion_not_proven",
            message: report.summary,
            recoverable: true,
            guidance: report.verdict === "blocked" ? "先完成 effect 对账，再重新判定完成" : "按失败项修复证据或请求人工确认",
            cause: report.verdict === "blocked" ? "effect_uncertain" : "contract_failure",
            failureClass,
            disposition
          };
          if (report.verdict === "needs_human" || report.verdict === "blocked") {
            this.service.updateGoal(goal.goalId, {
              currentState: report.verdict === "blocked" ? "blocked" : "awaiting_user",
              nextHandoff: report.summary
            });
            this.service.updateTask(taskId, {
              status: "waiting_input", currentRunId: runId,
              nextAction: report.verdict === "blocked" ? "外部动作结果未确定，请先对账" : "完成证据仍需人工确认",
              error: goalError
            }, runId);
            this.refreshTaskSummary(taskId, { lastFailure: goalError });
            return { status: "waiting_input", run: { ...run, status: "completed", threadId: result.threadId, usage: this.usageWithMetrics(result.usage, result.turns, result.toolCalls) }, executorId, outDir, error: null, failure: goalError, aborted: controller.signal.aborted, leaseLost: false, cancelled: false };
          }
          this.service.updateGoal(goal.goalId, { currentState: "active", nextHandoff: report.summary });
          throw new Error(`完成判定失败：${report.summary}`);
        }
        this.service.updateGoal(goal.goalId, { currentState: "done", nextHandoff: "" });
      }
      this.service.updateTask(taskId, {
        status: "completed", currentRunId: runId, nextAction: "产物已保存",
        error: null, resultSummary: result.finalResponse
      }, runId);
      this.refreshTaskSummary(taskId);
      return { status: "completed", run: { ...run, status: "completed", threadId: result.threadId, usage: this.usageWithMetrics(result.usage, result.turns, result.toolCalls) }, executorId, outDir, error: null, failure: null, aborted: controller.signal.aborted, leaseLost: false, cancelled: false };
    } catch (error) {
      if (controller.signal.aborted && this.steering.has(taskId)) {
        this.service.updateRun(runId, taskId, { status: "cancelled", endedAt: new Date().toISOString(), failure: null });
        this.service.updateTask(taskId, {
          status: "running", currentRunId: runId, nextAction: "正在应用补充信息", error: null
        }, runId);
        return {
          status: "cancelled", run: { ...run, status: "cancelled" }, executorId, outDir,
          error, failure: null, aborted: true, leaseLost: false, cancelled: false, steered: true
        };
      }
      const failure = this.markRunFailed(taskId, runId, error, controller.signal.aborted, run.leaseEpoch ?? 0);
      this.refreshTaskSummary(taskId, { lastFailure: failure.failure });
      return {
        status: failure.cancelled ? "cancelled" : "failed",
        run: { ...run, status: failure.cancelled ? "cancelled" : "failed", failure: failure.failure },
        executorId, outDir, error, failure: failure.failure,
        aborted: controller.signal.aborted, leaseLost: failure.leaseLost, cancelled: failure.cancelled
      };
    }
  }

  private async authorizeNativeTool(input: {
    task: TaskRecord;
    run: RunRecord;
    request: AgentToolAuthorizationRequest;
    fullPermission: boolean;
    workspaceRoot: string;
    signal: AbortSignal;
  }): Promise<AgentToolAuthorization> {
    const toolName = input.request.call.name;
    if (!TOOL_APPROVAL_REQUIRED.has(toolName)) return { allowed: true };
    if (input.signal.aborted) return { allowed: false, reason: "任务已取消" };
    const argumentsValue = approvalArguments(input.request.call.arguments);
    const summary = toolApprovalSummary(toolName, input.request.call.arguments);
    let action: ResolvedAction;
    try {
      const resolved = resolveToolAction({
        toolName,
        argumentsValue,
        summary,
        workspaceRoot: input.workspaceRoot,
        fullPermission: input.fullPermission,
        context: this.service.store.listScheduleRunByTask(input.task.id) ? "scheduled" : "interactive"
      });
      if (!resolved) {
        return { allowed: false, reason: `敏感工具 ${toolName} 无法解析为可绑定动作，已拒绝执行` };
      }
      action = resolved;
    } catch (error) {
      return { allowed: false, reason: `敏感工具 ${toolName} 无法绑定到真实动作：${errorMessage(error)}` };
    }
    if (input.fullPermission) {
      this.recordAutoApprovedTool(input.task, input.run, {
        toolName,
        arguments: argumentsValue,
        metadata: {
          actionId: action.actionId,
          actionDigest: action.actionDigest,
          actionKind: action.kind,
          permissionMode: action.permissionMode,
          risk: action.risk
        }
      });
      return { allowed: true };
    }
    const decision = await this.requestToolApproval({
      task: input.task,
      run: input.run,
      toolName,
      summary,
      target: { tool: toolName, arguments: argumentsValue },
      preview: { arguments: argumentsValue },
      action,
      signal: input.signal
    });
    return decision.allowed
      ? { allowed: true }
      : { allowed: false, reason: decision.reason };
  }

  private async authorizeDshTool(input: {
    task: TaskRecord;
    run: RunRecord;
    request: DshApprovalRequest;
    fullPermission: boolean;
    signal: AbortSignal;
  }): Promise<DshApprovalOutcome> {
    if (input.signal.aborted) return "cancelled";
    const metadata = dshApprovalMetadata(input.request);
    if (input.fullPermission) {
      this.recordAutoApprovedTool(input.task, input.run, {
        toolName: input.request.toolName,
        arguments: null,
        metadata
      });
      return "allowed-once";
    }
    const decision = await this.requestToolApproval({
      task: input.task,
      run: input.run,
      toolName: input.request.toolName,
      summary: dshToolApprovalSummary(input.request),
      target: metadata,
      preview: metadata,
      signal: input.signal
    });
    if (decision.allowed) return "allowed-once";
    if (input.signal.aborted || decision.reason === "任务已取消") return "cancelled";
    return "rejected";
  }

  private async requestToolApproval(input: {
    task: TaskRecord;
    run: RunRecord;
    toolName: string;
    summary: string;
    target: Record<string, unknown>;
    preview: Record<string, unknown>;
    action?: ResolvedAction;
    signal: AbortSignal;
  }): Promise<ToolApprovalDecision> {
    if (!this.approvals) {
      return { allowed: false, reason: "审批管理器未启动，敏感工具没有执行" };
    }
    let pending: PendingToolApproval;
    try {
      pending = await this.approvals.requestTool({
        taskId: input.task.id,
        runId: input.run.id,
        toolName: input.toolName,
        summary: input.summary,
        target: input.target,
        preview: input.preview,
        ...(input.action ? { action: input.action } : {})
      });
    } catch (error) {
      return { allowed: false, reason: `无法创建工具审批：${errorMessage(error)}` };
    }
    return this.awaitToolApproval(pending, input.signal);
  }

  private awaitToolApproval(pending: PendingToolApproval, signal: AbortSignal): Promise<ToolApprovalDecision> {
    if (signal.aborted) {
      this.approvals?.cancelToolApproval(pending.approval.id, "任务已取消");
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
        this.approvals?.cancelToolApproval(pending.approval.id, "任务已取消");
        finish({ allowed: false, reason: "任务已取消" });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      pending.decision.then(finish, (error) => finish({ allowed: false, reason: errorMessage(error) }));
    });
  }

  private recordAutoApprovedTool(
    task: TaskRecord,
    run: RunRecord,
    input: { toolName: string; arguments: unknown; metadata?: Record<string, unknown> }
  ): void {
    try {
      const event = this.service.store.appendEvent({
        type: "approval.auto_approved",
        taskId: task.id,
        runId: run.id,
        payload: {
          approvalId: null,
          kind: `tool.${input.toolName}`,
          toolName: input.toolName,
          arguments: input.arguments,
          ...(input.metadata ?? {}),
          conversationId: task.conversationId ?? null,
          policy: "conversation.full",
          effectId: null
        }
      });
      this.service.bus.publish(event);
    } catch {
      // Full-permission execution must not fail because an audit event could not be written.
    }
  }

  private finishWaitingInput(taskId: string, run: RunRecord, result: ExecutionOutcome): AttemptResult {
    const usage = this.usageWithMetrics(result.usage, result.turns, result.toolCalls);
    this.service.updateRun(run.id, taskId, { status: "waiting_input", endedAt: new Date().toISOString(), usage, failure: null });
    this.service.updateTask(taskId, {
      status: "waiting_input", currentRunId: run.id, nextAction: "等待你补充信息",
      error: null, resultSummary: result.question ?? result.finalResponse
    }, run.id);
      this.refreshTaskSummary(taskId);
    return { status: "waiting_input", run: { ...run, status: "waiting_input", usage }, executorId: run.executorId ?? "codex", outDir: this.outDirForRun(taskId, run), error: null, failure: null, aborted: false, leaseLost: false, cancelled: false };
  }

  private markRunFailed(taskId: string, runId: string, error: unknown, aborted: boolean, leaseEpoch: number): { failure: TaskError | null; cancelled: boolean; leaseLost: boolean } {
    const endedAt = new Date().toISOString();
    const task = this.service.store.getTask(taskId);
    if (!task) return { failure: null, cancelled: false, leaseLost: false };
    try {
      this.leases.assertHeld(taskId, leaseEpoch);
    } catch {
      this.service.updateRun(runId, taskId, {
        status: "failed", endedAt,
        failure: { kind: "lease_fenced", message: "任务已被其他实例接管，这次执行的结果已丢弃", recoverable: false, guidance: "以当前任务所有者记录的状态为准" }
      });
      return { failure: null, cancelled: false, leaseLost: true };
    }
    const userCancelled = this.cancelled.has(taskId) || task.status === "cancelled";
    if (userCancelled) {
      this.service.updateRun(runId, taskId, { status: "cancelled", endedAt });
      return { failure: null, cancelled: true, leaseLost: false };
    }
    const failure = this.taskErrorFor(error, aborted);
    this.service.updateRun(runId, taskId, { status: "failed", endedAt, failure });
    const currentTask = this.service.store.getTask(taskId);
    if (currentTask) {
      try {
        this.context.recordFailure(currentTask, runId, currentTask.executorId ?? "codex", error);
      } catch {
        // Failure capture is best effort.
      }
    }
    return { failure, cancelled: false, leaseLost: false };
  }

  private taskErrorFor(error: unknown, aborted: boolean): TaskError {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof HermesApprovalRequiredError) {
      return { kind: "executor_approval_required", message, recoverable: true, guidance: "在设置里完成 Hermes 授权，或把当前对话切换为完全权限后重试" };
    }
    if (error instanceof HermesStartupError) {
      return { kind: "executor_unavailable", message, recoverable: true, guidance: "到设置里检查 Hermes 命令路径并点击检测" };
    }
    if (aborted && this.stopping) {
      return { kind: "interrupted", message: "Hearth 关闭时中止了这一轮执行", recoverable: true, guidance: "重新启动后点击重试" };
    }
    if (error instanceof CapabilityUnavailableError) {
      return { kind: "capability_unavailable", message, recoverable: true, guidance: "在对话输入框上方启用 Codex 或 Hermes 后重新发送" };
    }
    return {
      kind: error instanceof UnsupportedInputError ? "input_unavailable" : "execution_failed",
      message, recoverable: true,
      guidance: error instanceof UnsupportedInputError ? "接入对应的抓取能力后重试" : "查看运行记录后重试"
    };
  }

  private decideNextAction(input: {
    task: TaskRecord;
    cause: FailureCause;
    effectiveCause: FailureCause;
    target: { targetExecutor: ExecutorId | null; highRisk: boolean; reason: string };
    diagnosis: FailureDiagnosis;
    settings: ContextSettings;
    approvalMode: "necessary" | "full";
    retriesUsed: number;
    handoffsUsed: number;
    attemptedExecutors: Set<ExecutorId>;
    taskRoot: string;
  }): FailureDecision {
    const canRetry = input.retriesUsed < input.settings.maxSameExecutorRetries;
    if (input.cause === "transient" && canRetry) {
      return { cause: input.cause, action: "retry_same", targetExecutor: null, autoAllowed: true, highRisk: false, reason: "临时故障，先重试同一执行器" };
    }
    if (!isExecutorFailureCause(input.effectiveCause)) {
      return {
        cause: input.effectiveCause,
        action: input.effectiveCause === "permission" || input.effectiveCause === "input_missing" || input.effectiveCause === "budget" || input.effectiveCause === "effect_uncertain" || input.effectiveCause === "interrupted" ? "ask_user" : "fail",
        targetExecutor: null,
        autoAllowed: false,
        highRisk: false,
        reason: input.diagnosis.summary || this.nextActionForCause(input.effectiveCause)
      };
    }
    const targetExecutor = input.target.targetExecutor;
    if (!targetExecutor) {
      const exhausted = input.handoffsUsed >= input.settings.maxHandoffs;
      return {
        cause: input.effectiveCause,
        action: "fail",
        targetExecutor: null,
        autoAllowed: false,
        highRisk: false,
        reason: exhausted ? "已达到最大接管次数，所有已尝试执行器均未完成任务" : input.target.reason
      };
    }
    const settings = this.executorSettings();
    const health = this.executorHealth(targetExecutor, settings);
    const targetEnabled = this.executorEnabledForTask(input.task, targetExecutor);
    const adapterCheck = this.adapters[targetExecutor].canRun({
      task: input.task,
      prepared: null,
      settings: input.settings,
      executorSettings: settings,
      modelSettings: this.modelSettingsForExecutor(targetExecutor)
    });
    const evaluation = evaluateHandoff({
      service: this.service, task: input.task, targetExecutor,
      targetAvailable: health.canRun && adapterCheck.ok, targetEnabled, settings: input.settings, taskWorkspace: input.taskRoot
    });
    const decision = decideFailure({
      cause: input.effectiveCause, settings: input.settings, evaluation, targetExecutor,
      retriesUsed: input.retriesUsed, handoffsUsed: input.handoffsUsed, attemptedExecutors: [...input.attemptedExecutors]
    });
    if (decision.action !== "handoff") return decision;
    const autoAllowed = input.approvalMode === "full" && input.settings.mode === "on" && input.settings.autoHandoffRisk === "low";
    return {
      ...decision,
      autoAllowed,
      highRisk: input.target.highRisk,
      reason: autoAllowed
        ? `执行器故障：${input.diagnosis.summary}，自动切换到 ${executorName(targetExecutor)} 继续`
        : `执行器故障：${input.diagnosis.summary}。是否切换到 ${executorName(targetExecutor)} 继续？`
    };
  }

  private async diagnoseFailure(taskId: string, task: TaskRecord, run: RunRecord, error: unknown, cause: FailureCause, targetExecutor: ExecutorId | null): Promise<FailureDiagnosis> {
    const startedAt = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    let diagnosis: FailureDiagnosis = {
      id: randomUUID(), taskId, runId: run.id, cause, confidence: 0.7,
      summary: clipText(message, 500), evidenceItemIds: [],
      recommendedAction: cause === "transient" ? "retry_same" : ["permission", "input_missing", "budget", "effect_uncertain", "interrupted"].includes(cause) ? "ask_user" : targetExecutor ? "handoff" : "fail",
      targetExecutor, doNotRepeat: [], source: "rules", createdAt: new Date().toISOString()
    };
    const modelAttempted = isExecutorFailureCause(cause);
    let contextTokens = 0;
    if (modelAttempted) {
      const items = [...this.context.listItems(taskId, { limit: 50 }).items].reverse();
      contextTokens = estimateTokens(items.map((item) => item.content).join("\n"));
      const chatSettings = this.modelSettingsForExecutor("native") ?? loadModelSettings(this.modelSettingsPath);
      const modelDiagnosis = chatSettings
        ? await diagnoseFailure({ settings: chatSettings, task, run, error, cause, items })
        : null;
      if (modelDiagnosis) diagnosis = modelDiagnosis;
    }
    try {
      this.context.recordDiagnosis(diagnosis, {
        durationMs: Date.now() - startedAt,
        contextTokens,
        modelAttempted,
        modelUsed: diagnosis.source === "model"
      });
    } catch {
      // Diagnosis capture is best effort.
    }
    return diagnosis;
  }

  private captureDshContextEvent(task: TaskRecord, run: RunRecord, event: DshContextEvent): void {
    const base = { taskId: task.id, conversationId: task.conversationId ?? null, runId: run.id, executorId: "deepseek-harness" as const };
    const kind = event.type === "tool/call"
      ? "tool_call" as const
      : event.type === "tool/result"
        ? "tool_result" as const
        : event.type === "user/message"
          ? "user_message" as const
          : event.type === "system/message"
            ? "notice" as const
            : "assistant_message" as const;
    this.capture({
      ...base,
      kind,
      role: event.role,
      content: event.content,
      provenance: { source: "deepseek-harness", eventType: event.type, seq: event.seq },
      executorEventId: event.executorEventId
    });
    if (event.usage) {
      this.capture({
        ...base,
        kind: "usage",
        role: "system",
        content: JSON.stringify(event.usage),
        provenance: { source: "deepseek-harness", eventType: event.type, usage: event.usage },
        executorEventId: `${event.executorEventId}:usage`
      });
    }
  }

  private recordRunInput(task: TaskRecord, run: RunRecord, pendingInput: string): void {
    const inputs = task.inputs.map((item) => `${item.kind}: ${item.label}`).join("\n") || "无额外输入";
    this.capture({
      taskId: task.id, conversationId: task.conversationId ?? null, runId: run.id, executorId: run.executorId ?? null,
      kind: "task_input", role: "user",
      content: [`目标：${task.goal}`, `输入：\n${inputs}`, `期望产物：${(task.expectedOutputs ?? expectedOutputsForTask(task)).join("、")}`].join("\n\n"),
      provenance: { source: "scheduler", attempt: run.attempt }, executorEventId: `task-input:${run.id}`
    });
    if (pendingInput.trim()) {
      this.capture({
        taskId: task.id, conversationId: task.conversationId ?? null, runId: run.id, executorId: run.executorId ?? null,
        kind: "user_message", role: "user", content: pendingInput,
        provenance: { source: "user-pending-input" }, executorEventId: `user-input:${run.id}`
      });
    }
  }

  private capture(input: Parameters<ContextService["record"]>[0]): void {
    try {
      if (this.context.settings().mode !== "off") this.context.record(input);
    } catch {
      // Context capture must never break task execution.
    }
  }

  private captureNativeEvent(task: TaskRecord, run: RunRecord, event: RuntimeEvent): void {
    const base = { taskId: task.id, conversationId: task.conversationId ?? null, runId: run.id, executorId: "native" as const, role: "system" as const };
    if (event.type === "assistant.message") {
      this.capture({ ...base, kind: "assistant_message", role: "assistant", content: event.text, provenance: { source: "native", turn: event.turn }, executorEventId: `native:${event.turn}:assistant` });
      return;
    }
    if (event.type === "tool.started") {
      this.capture({ ...base, kind: "tool_call", content: `${event.call.name}\n${safeStringify(event.call.arguments)}`, provenance: { source: "native", turn: event.turn, toolCallId: event.call.id, tool: event.call.name }, executorEventId: `native:tool:${event.call.id}:started` });
      return;
    }
    if (event.type === "tool.finished") {
      this.capture({ ...base, kind: "tool_result", role: "tool", content: event.result.content, provenance: { source: "native", turn: event.turn, toolCallId: event.call.id, tool: event.call.name, isError: Boolean(event.result.isError), durationMs: event.durationMs }, executorEventId: `native:tool:${event.call.id}:finished` });
      return;
    }
    if (event.type === "checkpoint.created") {
      this.capture({ ...base, kind: "checkpoint", content: `${event.kind} checkpoint #${event.seq}`, provenance: { source: "native", seq: event.seq, checkpointKind: event.kind }, executorEventId: `native:checkpoint:${event.seq}:${event.kind}` });
      return;
    }
    if (event.type === "checkpoint.failed") {
      this.capture({ ...base, kind: "notice", content: `检查点保存失败：${event.message}`, provenance: { source: "native", seq: event.seq }, executorEventId: `native:checkpoint-failed:${event.seq}` });
      return;
    }
    if (event.type === "budget.exceeded") {
      this.capture({ ...base, kind: "notice", content: `达到预算上限：${event.budget} (${event.limit})`, provenance: { source: "native", budget: event.budget, limit: event.limit }, executorEventId: `native:budget:${event.budget}:${event.limit}` });
      return;
    }
    if (event.type === "compacted") {
      this.capture({ ...base, kind: "notice", content: `上下文压缩：${event.before} → ${event.after}`, provenance: { source: "native", before: event.before, after: event.after }, executorEventId: `native:compacted:${event.before}:${event.after}` });
      return;
    }
    if (event.type === "notice") {
      this.capture({ ...base, kind: "notice", content: event.message, provenance: { source: "native" }, executorEventId: `native:notice:${createHash("sha256").update(event.message).digest("hex").slice(0, 16)}` });
    }
  }

  private captureCodexItem(task: TaskRecord, run: RunRecord, item: CodexContextItem): void {
    if (item.type === "reasoning") return;
    const base = { taskId: task.id, conversationId: task.conversationId ?? null, runId: run.id, executorId: "codex" as const };
    if (item.type === "agent_message") {
      this.capture({ ...base, kind: "assistant_message", role: "assistant", content: item.text, provenance: { source: "codex", itemType: item.type }, executorEventId: `codex:${item.id}` });
      return;
    }
    if (item.type === "command_execution") {
      this.capture({ ...base, kind: "tool_call", role: "assistant", content: item.command, provenance: { source: "codex", itemType: item.type, status: item.status, exitCode: item.exit_code ?? null }, executorEventId: `codex:${item.id}:command` });
      if (item.aggregated_output.trim()) {
        this.capture({ ...base, kind: "tool_result", role: "tool", content: item.aggregated_output, provenance: { source: "codex", itemType: item.type, command: item.command, status: item.status, exitCode: item.exit_code ?? null }, executorEventId: `codex:${item.id}:output` });
      }
      return;
    }
    if (item.type === "file_change") {
      this.capture({ ...base, kind: "tool_result", role: "tool", content: item.changes.map((change) => `${change.kind}: ${change.path}`).join("\n"), provenance: { source: "codex", itemType: item.type, status: item.status, paths: item.changes }, executorEventId: `codex:${item.id}` });
      return;
    }
    if (item.type === "mcp_tool_call") {
      this.capture({ ...base, kind: "tool_call", role: "assistant", content: `${item.server}/${item.tool}\n${safeStringify(item.arguments)}`, provenance: { source: "codex", itemType: item.type, status: item.status }, executorEventId: `codex:${item.id}:call` });
      const output = item.error?.message ?? (item.result ? safeStringify(item.result.structured_content ?? item.result) : "");
      if (output) {
        this.capture({ ...base, kind: "tool_result", role: "tool", content: output, provenance: { source: "codex", itemType: item.type, status: item.status }, executorEventId: `codex:${item.id}:result` });
      }
      return;
    }
    if (item.type === "web_search") {
      this.capture({ ...base, kind: "tool_call", role: "assistant", content: item.query, provenance: { source: "codex", itemType: item.type }, executorEventId: `codex:${item.id}` });
      return;
    }
    if (item.type === "todo_list") {
      this.capture({ ...base, kind: "decision", role: "assistant", content: item.items.map((todo) => `${todo.completed ? "[x]" : "[ ]"} ${todo.text}`).join("\n"), provenance: { source: "codex", itemType: item.type }, executorEventId: `codex:${item.id}` });
      return;
    }
    if (item.type === "error") {
      this.capture({ ...base, kind: "notice", role: "system", content: item.message, provenance: { source: "codex", itemType: item.type }, executorEventId: `codex:${item.id}` });
    }
  }

  private captureExternalContextEvent(task: TaskRecord, run: RunRecord, event: ExternalContextItem): void {
    const kind = event.type.includes("tool")
      ? event.type.includes("result") ? "tool_result" as const : "tool_call" as const
      : event.type === "system" ? "notice" as const
        : event.type === "error" ? "notice" as const
          : "assistant_message" as const;
    this.capture({
      taskId: task.id,
      conversationId: task.conversationId ?? null,
      runId: run.id,
      executorId: run.executorId ?? task.executorId ?? "native",
      kind,
      role: event.role,
      content: event.content,
      provenance: { source: "external-executor", eventType: event.type },
      executorEventId: event.executorEventId
    });
  }

  private latestRun(taskId: string, preferredId: string | null): RunRecord | null {
    const runs = this.service.store.listRuns(taskId);
    if (preferredId) {
      const preferred = runs.find((run) => run.id === preferredId);
      if (preferred) return preferred;
    }
    return runs.at(-1) ?? null;
  }

  private takeNextFollowUp(taskId: string): TaskFollowUpRecord | null {
    const steering = this.service.store.listTaskFollowUps(taskId, "steering")[0];
    if (steering) return steering;
    return this.service.store.listTaskFollowUps(taskId, "queued")[0] ?? null;
  }

  private hasPendingFollowUp(taskId: string): boolean {
    return this.service.store.listTaskFollowUps(taskId, "steering").length > 0
      || this.service.store.listTaskFollowUps(taskId, "queued").length > 0;
  }

  private taskRoot(taskId: string): string {
    return join(this.workspaceRoot, "tasks", taskId);
  }

  private outDirForRun(taskId: string, run: RunRecord): string {
    const root = this.taskRoot(taskId);
    return run.workspace === root ? join(root, "out", run.id) : join(run.workspace, "out");
  }

  private remainingBudget(taskId: string): RunBudget {
    const task = this.service.requireTask(taskId);
    const goal = task.goalId ? this.service.store.getGoal(task.goalId) : null;
    const runs = goal ? this.goalRuns(goal.goalId) : this.service.store.listRuns(taskId);
    const used = this.usageForRuns(runs);
    const goalBudget = goal?.budget ?? {};
    const maxTurns = Math.min(goalBudget.maxTurns ?? this.runBudget.maxTurns, this.runBudget.maxTurns);
    const maxToolCalls = Math.min(goalBudget.maxToolCalls ?? this.runBudget.maxToolCalls, this.runBudget.maxToolCalls);
    const maxTokens = Math.min(goalBudget.maxTokens ?? this.runBudget.maxTokens, this.runBudget.maxTokens);
    const maxDurationMs = Math.min(goalBudget.maxDurationMs ?? this.runBudget.maxDurationMs, this.runBudget.maxDurationMs);
    return {
      maxTurns: Math.max(0, maxTurns - used.turns),
      maxToolCalls: Math.max(0, maxToolCalls - used.toolCalls),
      maxTokens: Math.max(0, maxTokens - used.tokens),
      maxDurationMs: Math.max(0, maxDurationMs - used.durationMs)
    };
  }

  private goalRuns(goalId: string): RunRecord[] {
    return this.goalTasks(goalId).flatMap((task) => this.service.store.listRuns(task.id));
  }

  private usageForRuns(runs: RunRecord[]): { tokens: number; turns: number; toolCalls: number; durationMs: number } {
    const now = Date.now();
    return runs.reduce((usage, run) => {
      const endedAt = run.endedAt ? Date.parse(run.endedAt) : null;
      const startedAt = run.startedAt ? Date.parse(run.startedAt) : null;
      const durationMs = startedAt === null || !Number.isFinite(startedAt)
        ? 0
        : Math.max(0, (endedAt !== null && Number.isFinite(endedAt) ? endedAt : now) - startedAt);
      return {
        tokens: usage.tokens + (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0),
        turns: usage.turns + Math.max(0, run.usage?.turns ?? (run.status === "running" ? 0 : 1)),
        toolCalls: usage.toolCalls + Math.max(0, run.usage?.toolCalls ?? 0),
        durationMs: usage.durationMs + durationMs
      };
    }, { tokens: 0, turns: 0, toolCalls: 0, durationMs: 0 });
  }

  private goalBoundaryStop(task: TaskRecord, failure: TaskError | null = null): GoalBoundaryStop | null {
    if (!task.goalId) return null;
    const goal = this.service.store.getGoal(task.goalId);
    if (!goal || goal.currentState === "done" || goal.currentState === "cancelled") return null;
    const runs = this.goalRuns(goal.goalId);
    const used = this.usageForRuns(runs);
    const deadline = goal.deadline ? Date.parse(goal.deadline) : Number.NaN;
    if (Number.isFinite(deadline) && deadline <= Date.now()) {
      return {
        code: "deadline_reached",
        currentState: "awaiting_user",
        message: `Goal「${goal.title}」已超过截止时间 ${goal.deadline}，不能继续自动执行`,
        nextAction: "Goal 已超过截止时间，等待调整期限或终止",
        handoff: `截止时间已到（${goal.deadline}）。已完成 ${runs.length} 轮；下一步：请用户调整 deadline、缩小目标，或确认终止。`,
        failureClass: "budget_exhausted",
        cause: "budget"
      };
    }

    const goalBudget = goal.budget;
    const maxTurns = Math.min(goalBudget.maxTurns ?? this.runBudget.maxTurns, this.runBudget.maxTurns);
    const maxToolCalls = Math.min(goalBudget.maxToolCalls ?? this.runBudget.maxToolCalls, this.runBudget.maxToolCalls);
    const maxTokens = Math.min(goalBudget.maxTokens ?? this.runBudget.maxTokens, this.runBudget.maxTokens);
    const maxDurationMs = Math.min(goalBudget.maxDurationMs ?? this.runBudget.maxDurationMs, this.runBudget.maxDurationMs);
    const exhausted = [
      used.turns >= maxTurns ? `轮次 ${used.turns}/${maxTurns}` : null,
      used.toolCalls >= maxToolCalls ? `工具调用 ${used.toolCalls}/${maxToolCalls}` : null,
      used.tokens >= maxTokens ? `tokens ${used.tokens}/${maxTokens}` : null,
      used.durationMs >= maxDurationMs ? `时长 ${Math.round(used.durationMs / 1000)}s/${Math.round(maxDurationMs / 1000)}s` : null
    ].filter((item): item is string => item !== null);
    if (exhausted.length > 0) {
      return {
        code: "budget_exhausted",
        currentState: "awaiting_user",
        message: `Goal「${goal.title}」预算已耗尽：${exhausted.join("，")}`,
        nextAction: "Goal 预算已耗尽，等待调整预算或人工接手",
        handoff: `预算已耗尽（${exhausted.join("，")}）。已完成 ${runs.length} 轮；下一步：检查已证明阶段，调整 budget 后继续，或由用户接手。`,
        failureClass: "budget_exhausted",
        cause: "budget"
      };
    }

    const goalEffects = this.goalTasks(goal.goalId).flatMap((item) => this.service.store.listEffects(item.id));
    const unresolved = goalEffects.filter((effect) => effect.status === "executing" || effect.status === "uncertain");
    if (unresolved.length > 0) {
      return {
        code: "effect_uncertain",
        currentState: "blocked",
        message: `Goal「${goal.title}」存在未结算外部动作：${unresolved.map((effect) => effect.id).join("、")}`,
        nextAction: "外部动作结果未确定，请先完成对账",
        handoff: `外部动作 ${unresolved.map((effect) => effect.id).join("、")} 状态未知；下一步：先完成 reconcile，确认 committed 或 absent 后再继续。`,
        failureClass: "effect_unknown",
        cause: "effect_uncertain"
      };
    }

    const conditions = new Set(goal.stopConditions.map((condition) => condition.trim().toLowerCase()));
    const taskFailure = failure ?? task.error;
    if (conditions.has("task_failed") && taskFailure) {
      return {
        code: "declared_stop",
        currentState: "awaiting_user",
        message: `Goal「${goal.title}」命中停止条件 task_failed：${taskFailure.message}`,
        nextAction: "Goal 命中停止条件，等待你决定是否继续",
        handoff: `命中停止条件 task_failed。上一步失败：${taskFailure.message}；下一步：确认原因、补充授权或调整目标后再继续。`,
        failureClass: "validation_failed",
        cause: "unknown"
      };
    }
    const latestApproval = this.service.store.listApprovals(task.id).at(-1);
    if (conditions.has("approval_rejected") && latestApproval?.status === "rejected") {
      return {
        code: "declared_stop",
        currentState: "awaiting_user",
        message: `Goal「${goal.title}」命中停止条件 approval_rejected`,
        nextAction: "审批已被拒绝，等待你调整方案或目标",
        handoff: "命中停止条件 approval_rejected。下一步：不要重试同一动作，先由用户调整范围或授权。",
        failureClass: "policy_denied",
        cause: "permission"
      };
    }
    return null;
  }

  private goalTasks(goalId: string): TaskRecord[] {
    return this.service.store.listTasks().filter((task) => task.goalId === goalId);
  }

  private enforceGoalBoundary(task: TaskRecord, failure: TaskError | null = null): boolean {
    const stop = this.goalBoundaryStop(task, failure);
    const goal = task.goalId ? this.service.store.getGoal(task.goalId) : null;
    if (!stop || !goal) return false;
    const handoff = goal.nextHandoff?.trim() || stop.handoff;
    this.service.updateGoal(goal.goalId, { currentState: stop.currentState, nextHandoff: handoff });
    const error: TaskError = {
      kind: `goal_${stop.code}`,
      message: stop.message,
      recoverable: true,
      guidance: stop.code === "effect_uncertain" ? "先完成外部动作对账，再重新开始任务" : "调整 Goal 的预算或截止时间后重试",
      cause: stop.cause,
      failureClass: stop.failureClass,
      disposition: { type: "handoff", note: handoff }
    };
    const status = task.status === "running" || task.status === "waiting_approval" ? "waiting_input" : "recoverable";
    this.service.updateTask(task.id, {
      status, currentRunId: task.currentRunId,
      nextAction: stop.nextAction, error, resultSummary: stop.message
    }, task.currentRunId ?? undefined);
    this.refreshTaskSummary(task.id, { lastFailure: error });
    return true;
  }

  private selectHandoffTarget(input: {
    task: TaskRecord;
    cause: FailureCause;
    settings: ContextSettings;
    attemptedExecutors: Set<ExecutorId>;
    handoffsUsed: number;
    taskRoot: string;
  }): { targetExecutor: ExecutorId | null; highRisk: boolean; reason: string } {
    if (!isExecutorFailureCause(input.cause)) {
      return { targetExecutor: null, highRisk: false, reason: "这不是执行器故障，不需要切换执行器" };
    }
    if (input.handoffsUsed >= input.settings.maxHandoffs) {
      return { targetExecutor: null, highRisk: false, reason: "已达到最大接管次数，所有已尝试执行器均未完成任务" };
    }
    const executorSettings = this.executorSettings();
    for (const candidate of EXECUTOR_FALLBACK_ORDER) {
      if (input.attemptedExecutors.has(candidate)) continue;
      if (!this.executorEnabledForTask(input.task, candidate)) continue;
      const health = this.executorHealth(candidate, executorSettings);
      if (!health.canRun) continue;
      const adapterCheck = this.adapters[candidate].canRun({
        task: input.task,
        prepared: null,
        settings: input.settings,
        executorSettings,
        modelSettings: this.modelSettingsForExecutor(candidate)
      });
      if (!adapterCheck.ok) continue;
      const evaluation = evaluateHandoff({
        service: this.service,
        task: input.task,
        targetExecutor: candidate,
        targetAvailable: true,
        targetEnabled: true,
        settings: input.settings,
        taskWorkspace: input.taskRoot
      });
      if (!evaluation.eligible || !evaluation.targetAvailable) continue;
      return { targetExecutor: candidate, highRisk: evaluation.highRisk, reason: evaluation.reason };
    }
    return { targetExecutor: null, highRisk: false, reason: "没有其他已启用且可用的执行器可以接管" };
  }

  private executorEnabledForTask(task: TaskRecord, executorId: ExecutorId): boolean {
    const settings = this.service.conversationSettings(task.conversationId);
    return !settings || settings.executorEnabled[executorId] !== false;
  }

  private nextActionForCause(cause: FailureCause): string {
    if (cause === "effect_uncertain") return "外部动作状态不确定，请先对账后再重试";
    if (cause === "interrupted") return "执行中断，可以重试";
    if (cause === "input_missing") return "缺少必要输入，补充后重试";
    if (cause === "permission") return "等待你授权后重试";
    if (cause === "budget") return "达到执行预算，等待你调整";
    return "执行未完成，可以重试";
  }

  private inheritedPackId(taskId: string): string | null {
    const job = this.service.store.getDelegationJobByChildTask(taskId);
    if (job?.contextPackRef?.startsWith("ctxpack:")) return job.contextPackRef;
    const parentTaskId = this.service.store.listTaskEdges({ childTaskId: taskId })[0]?.parentTaskId;
    if (!parentTaskId) return null;
    return this.service.store.listContextPacks({ scopeKind: "task", scopeId: parentTaskId, limit: 1 })[0]?.id ?? null;
  }

  private buildHandoffPrompt(task: TaskRecord, prepared: PreparedWorkspace, expectedOutputs: string[], packet: HandoffPacket, permissionNote: string, memoryContext: string, methodContext: string): { prompt: string; packId: string | null } {
    const projected = this.projector.project({
      taskId: task.id,
      fromRunId: packet.fromRunId,
      fromExecutor: packet.fromExecutor,
      toExecutor: packet.toExecutor,
      remainingBudget: packet.remainingBudget,
      diagnosisSummary: packet.summary,
      outDir: prepared.outDir,
      purpose: "handoff",
      maxTokens: this.context.settings().projectionTokenBudget,
      memoryContext,
      methodContext,
      packetOverride: packet
    });
    return {
      packId: projected.packId,
      prompt: [
      projected.prompt,
      "## 工作区",
      `- 当前工作区：${prepared.root}`,
      `- 本轮输出目录：${prepared.outDir}`,
      `- 期望产物：${expectedOutputs.join("、")}`,
      `- 任务：${task.title}`,
      "",
      "请先核对工作区和产物哈希，再从“下一步”继续执行；不要重复已经产生外部副作用的动作。" + permissionNote
      ].join("\n")
    };
  }

  private expandRefTool(packId: string): import("@hearth/agent-runtime").AgentTool {
    return {
      definition: {
        name: "expand_ref",
        description: "展开个人上下文包中的引用（ent:/st:/rel:/dec:/cmt:/mem:/src:/goal:/task:），读取被省略或摘要化的原文。",
        parameters: {
          type: "object",
          properties: { ref: { type: "string", description: "上下文包中的稳定引用" } },
          required: ["ref"],
          additionalProperties: false
        }
      },
      execute: async (input) => {
        const ref = input && typeof input === "object" && "ref" in input && typeof input.ref === "string" ? input.ref.trim() : "";
        if (!ref) return { content: "缺少 ref。", isError: true };
        return { content: this.contextBroker?.expandRef(ref, packId) ?? "上下文服务不可用。" };
      }
    };
  }

  private writeHandoffFile(
    task: TaskRecord,
    run: RunRecord,
    taskRoot: string,
    previousOutDir: string,
    handoffId: string,
    packet: HandoffPacket
  ): ReturnType<typeof createFileArtifact> {
    const markdown = this.projector.renderHandoffMarkdown(packet);
    const directory = join(taskRoot, ".hearth", "handoffs", handoffId);
    mkdirSync(directory, { recursive: true });
    const absolutePath = join(directory, "HANDOFF.md");
    writeFileSync(absolutePath, markdown, "utf8");
    writeFileSync(join(taskRoot, "HANDOFF.md"), markdown, "utf8");
    if (existsSync(previousOutDir)) writeFileSync(join(previousOutDir, "HANDOFF.md"), markdown, "utf8");
    const artifact = createFileArtifact({
      task,
      run,
      absolutePath,
      relativePath: `handoffs/${handoffId}/HANDOFF.md`
    });
    this.service.publishArtifact(artifact);
    return artifact;
  }

  private appendHandoffNotice(taskId: string, handoff: HandoffRecord, started = true): void {
    const task = this.service.store.getTask(taskId);
    if (!task?.conversationId) return;
    const summary = handoff.packet?.summary ?? handoff.diagnosis?.summary ?? handoff.reasonCode;
    const artifacts = handoff.packet?.artifacts.map((artifact) => artifact.path).slice(0, 5).join("、") || "无";
    const content = started
      ? `执行器已从 ${handoff.fromExecutor} 切换到 ${handoff.toExecutor} 继续。\n\n原因：${summary}\n已交接产物：${artifacts}`
      : `是否切换到 ${executorName(handoff.toExecutor)} 继续？`;
    try {
      this.service.appendChatMessage({
        id: randomUUID(), conversationId: task.conversationId, role: "assistant", content, taskId,
        attachments: [], createdAt: new Date().toISOString(), kind: "task_status", taskStatus: task.status
      });
    } catch {
      // Chat notice is best effort.
    }
  }

  private refreshTaskSummary(taskId: string, options: { lastFailure?: TaskError | null; handoffCount?: number } = {}): void {
    this.context.refreshSummary(taskId, options);
    const task = this.service.store.getTask(taskId);
    const state = this.context.getState(taskId);
    if (!task || !state) return;
    const controller = new AbortController();
    this.summaryControllers.set(taskId, controller);
    let promise: Promise<void> = Promise.resolve();
    promise = maybeModelSummary({
      context: this.context,
      task,
      state,
      settings: this.modelSettingsForExecutor("native") ?? loadModelSettings(this.modelSettingsPath),
      signal: controller.signal
    }).then(() => undefined).catch(() => undefined).finally(() => {
      this.summaryTasks.delete(promise);
      if (this.summaryControllers.get(taskId) === controller) this.summaryControllers.delete(taskId);
    });
    this.summaryTasks.add(promise);
  }


}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestWorkspace(root: string, limit = 5_000): string {
  const hash = createHash("sha256");
  let count = 0;
  const walk = (directory: string): void => {
    if (count >= limit) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (count >= limit) return;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      const stat = statSync(absolute);
      hash.update(`${relative(root, absolute).replace(/\\/g, "/")}\0${stat.size}\0${stat.mtimeMs}\n`);
      count += 1;
    }
  };
  walk(root);
  return hash.digest("hex");
}

function dshApprovalMetadata(request: DshApprovalRequest): Record<string, unknown> {
  return {
    provider: "deepseek-harness",
    sessionId: request.sessionId,
    toolName: request.toolName,
    ...(request.callId ? { callId: request.callId } : {}),
    ...(request.reason ? { reason: clipText(request.reason, 2_000) } : {})
  };
}

function dshToolApprovalSummary(request: DshApprovalRequest): string {
  const reason = request.reason ? `：${clipText(request.reason, 240)}` : "";
  return `DeepSeek Harness 请求执行工具 ${request.toolName}${reason}`;
}

function approvalArguments(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= 16_000) return JSON.parse(serialized) as unknown;
    return { truncated: true, preview: serialized.slice(0, 16_000) };
  } catch {
    return { truncated: true, preview: String(value).slice(0, 16_000) };
  }
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function resolveToolAction(input: {
  toolName: string;
  argumentsValue: unknown;
  summary: string;
  workspaceRoot: string;
  fullPermission: boolean;
  context: "interactive" | "scheduled";
}): ResolvedAction | null {
  const args = input.argumentsValue && typeof input.argumentsValue === "object"
    ? input.argumentsValue as Record<string, unknown>
    : {};
  const permissionMode = input.fullPermission ? "full" as const : "guarded" as const;
  let proposal: ActionProposal | null = null;
  if (input.toolName === "shell" && typeof args.command === "string" && args.command.trim()) {
    const windows = process.platform === "win32";
    proposal = {
      kind: "shell",
      summary: input.summary,
      command: {
        executable: windows ? "powershell.exe" : "sh",
        argv: windows ? ["-NoProfile", "-NonInteractive", "-Command", args.command] : ["-c", args.command],
        cwd: input.workspaceRoot,
        shell: windows ? "powershell" : "sh"
      }
    };
  } else if (input.toolName === "write_file" || input.toolName === "edit_file") {
    const path = typeof args.path === "string" ? args.path : typeof args.fileName === "string" ? args.fileName : null;
    if (path) {
      const absolute = isAbsolute(path) ? resolve(path) : resolve(input.workspaceRoot, path);
      proposal = {
        kind: "file_write",
        summary: input.summary,
        files: [{ path: absolute, mode: existsSync(absolute) ? "replace" : "create" }]
      };
    }
  } else if (input.toolName === "apply_patch" && typeof args.patch === "string") {
    const files = patchFileTargets(args.patch, input.workspaceRoot);
    if (files.length > 0) {
      proposal = {
        kind: "file_write",
        summary: input.summary,
        files,
        targetRevision: `patch-sha256:${createHash("sha256").update(args.patch).digest("hex")}`
      };
    }
  } else if (input.toolName === "fetch_url" && typeof args.url === "string") {
    try {
      const url = new URL(args.url);
      proposal = {
        kind: "network",
        summary: input.summary,
        network: {
          host: url.hostname,
          ...(url.port ? { port: Number(url.port) } : {}),
          method: "GET"
        }
      };
    } catch {
      proposal = null;
    }
  } else if (input.toolName === "capture_screen") {
    const path = typeof args.path === "string" ? args.path : "desktop.png";
    const absolute = isAbsolute(path) ? resolve(path) : resolve(input.workspaceRoot, path);
    proposal = {
      kind: "desktop",
      summary: input.summary,
      files: [{ path: absolute, mode: existsSync(absolute) ? "replace" : "create" }]
    };
  }
  if (!proposal) return null;
  return resolveAction({
    proposal,
    permissionMode,
    context: input.context,
    sessionRoot: input.workspaceRoot
  });
}

function patchFileTargets(patch: string, workspaceRoot: string): ActionFileTarget[] {
  const files = new Map<string, ActionFileTarget>();
  for (const line of patch.split(/\r?\n/)) {
    const match = /^\*\*\* (Update File|Add File|Delete File):\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const rawPath = match[2];
    if (!rawPath) continue;
    const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(workspaceRoot, rawPath);
    if (match[1] === "Delete File" && !existsSync(absolute)) continue;
    const mode = match[1] === "Add File" ? "create" : match[1] === "Delete File" ? "delete" : "replace";
    files.set(absolute, { path: absolute, mode });
  }
  return [...files.values()];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function expectedOutputsForTask(task: TaskRecord): string[] {
  const declared = task.expectedOutputs ?? ["result.md"];
  const hasImage = declared.some((output) => /\.(png|jpe?g|webp)$/i.test(output));
  if (!hasImage && wantsScreenshot(task.title + " " + task.goal)) return ["desktop.png"];
  return declared;
}
function isTerminalStatus(status: TaskRecord["status"] | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "recoverable";
}

function clipText(text: string, max: number): string {
  const normalized = text.trim();
  return normalized.length > max ? `${normalized.slice(0, max)}��` : normalized;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
