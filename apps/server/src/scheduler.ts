import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { AgentCheckpoint, AgentResumeState, RuntimeEvent } from "@hearth/agent-runtime";
import type { ContextItem, ContextSettings, ExecutorId, ExecutorSettings, FailureCause, FailureDiagnosis, HandoffPacket, HandoffRecord, RunBudget, RunCheckpointRecord, RunRecord, TaskError, TaskLease, TaskProgressDetail, TaskRecord } from "@hearth/core";
import { runCodex } from "@hearth/codex-executor";
import { getTemplate } from "@hearth/templates";
import type { DshContextEvent } from "@hearth/deepseek-executor";
import type { ApprovalRequest, ApprovalManager } from "./approvals.ts";
import { missingExpectedOutputs, publishArtifacts } from "./artifacts.ts";
import { CONTEXT_BLOB_DIR, EXECUTOR_SETTINGS_PATH, GIT_CACHE_DIR, MODEL_SETTINGS_PATH, REPO_ROOT, SOURCE_CONTENT_DIR, WORKSPACE_DIR } from "./config.ts";
import { ContextService, estimateTokens } from "./context.ts";
import { diagnoseFailure } from "./context-diagnosis.ts";
import { classifyFailure, decideFailure, evaluateHandoff, isExecutorFailureCause, type FailureDecision } from "./context-policy.ts";
import { ContextProjector } from "./context-projector.ts";
import { maybeModelSummary } from "./context-summary.ts";
import { loadExecutorSettings } from "./executor-settings.ts";
import { HermesApprovalRequiredError, HermesStartupError } from "./hermes-executor.ts";
import type { ExternalContextItem } from "./external-executor.ts";
import { executorHealth as readExecutorHealth } from "./executor-runtime.ts";
import { sanitizeProgressDetail } from "./progress-detail.ts";
import { EXECUTOR_FALLBACK_ORDER, executorName, resolveExecutorId } from "./executors.ts";
import { extractProposedComment, inspectRepository, readPrPreview, validatePullRequestPreview } from "./github.ts";
import type { CommandRunner } from "./github.ts";
import { MemoryService } from "./memory.ts";
import { DEFAULT_LEASE_HEARTBEAT_MS, LeaseError, TaskLeaseService } from "./leases.ts";
import { DEFAULT_RUN_BUDGET, runNativeTask } from "./native-executor.ts";
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
  leaseHeartbeatMs?: number;
  githubRun?: CommandRunner | undefined;
  githubCacheRoot?: string | undefined;
  sourceContentRoot?: string | undefined;
  runtimePreparer?: typeof prepareTaskRuntime | undefined;
  context?: ContextService | undefined;
  contextBlobRoot?: string | undefined;
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
  private readonly context: ContextService;
  private readonly projector: ContextProjector;
  private readonly summaryTasks = new Set<Promise<void>>();
  private readonly summaryControllers = new Map<string, AbortController>();
  private readonly leases: TaskLeaseService;
  private readonly leaseHeartbeatMs: number;
  private readonly leaseHeartbeats = new Map<string, { epoch: number; timer: ReturnType<typeof setInterval> }>();
  private readonly controllers = new Map<string, AbortController>();
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
    this.context = options.context ?? new ContextService(this.service, options.contextBlobRoot ?? CONTEXT_BLOB_DIR);
    this.projector = new ContextProjector(this.service, this.context);
    this.service.setContextSink((message) => {
      if (this.context.settings().mode !== "off") this.context.recordChatMessage(message);
    });
    this.leases = options.leases ?? new TaskLeaseService(this.service);
    this.leaseHeartbeatMs = Math.max(50, options.leaseHeartbeatMs ?? DEFAULT_LEASE_HEARTBEAT_MS);
  }

  get running(): boolean {
    return !this.stopped;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.stopping = false;
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
    if (task.status === "completed" || task.status === "cancelled") return task;
    this.cancelled.add(taskId);
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
    for (const task of queued) {
      if (this.stopped) break;
      const executorId = resolveExecutorId(task);
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
    const runs = this.service.store.listRuns(taskId).filter((run) => run.status !== "running");
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const run = runs[index];
      if (!run) continue;
      const checkpoint = this.service.store.latestRunCheckpoint(run.id);
      if (!checkpoint || checkpoint.kind === "final") continue;
      if (checkpoint.kind === "waiting_input" && !includeWaitingInput) continue;
      try {
        if (run.workspace !== workspace && existsSync(run.workspace)) {
          cpSync(run.workspace, workspace, { recursive: true, force: false });
        }
        const path = isAbsolute(checkpoint.path) ? checkpoint.path : join(this.workspaceRoot, checkpoint.path);
        if (!existsSync(path)) continue;
        const state = JSON.parse(readFileSync(path, "utf8")) as AgentCheckpoint;
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
    const record: RunCheckpointRecord = {
      id: randomUUID(),
      runId,
      taskId,
      seq: checkpoint.seq,
      kind: checkpoint.kind,
      path: relative(this.workspaceRoot, absolutePath).replace(/\\/g, "/"),
      sha256: createHash("sha256").update(body).digest("hex"),
      usage: checkpoint.usage,
      createdAt: new Date().toISOString()
    };
    this.service.createRunCheckpoint(record);
    this.service.updateRun(runId, taskId, { checkpointSeq: checkpoint.seq, usage: checkpoint.usage });
  }

  private startLeaseHeartbeat(taskId: string, epoch: number, onLost: () => void): void {
    const existing = this.leaseHeartbeats.get(taskId);
    if (existing) clearInterval(existing.timer);
    const timer = setInterval(() => {
      try {
        this.leases.heartbeat(taskId, epoch);
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
      const inspection = await inspectRepository(repository);
      if (!inspection.clean) throw new Error(`仓库仍有未提交改动：\n${inspection.status}`);
      if (inspection.branch !== repository.branch) throw new Error(`提交所在分支不是 ${repository.branch}`);
      if (inspection.commits < 1) throw new Error("没有检测到本地提交，不能创建 PR");
      const preview = validatePullRequestPreview(
        readPrPreview(join(prepared.outDir, "pr-preview.json")),
        repository
      );
      return {
        kind: "github.publish-pr",
        summary: `推送 ${repository.repo} 的分支 ${repository.branch} 并创建 PR`,
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
        }
      };
    }

    if (template.approvalKind === "github.comment") {
      const repository = prepared.repository;
      if (!repository || !repository.pull) throw new Error("发布评论前缺少 GitHub PR 上下文");
      const reviewFile = readFileSync(join(prepared.outDir, "pr-review.md"), "utf8").trim();
      if (!reviewFile) throw new Error("评审产物为空，不能发布评论");
      const review = extractProposedComment(reviewFile);
      if (review.length > 60_000) throw new Error("评审评论过长，不能发布");
      return {
        kind: "github.comment",
        summary: `在 ${repository.repo} PR #${repository.pull} 发布评审评论`,
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
        }
      };
    }

    throw new Error(`未实现的审批类型：${template.approvalKind}`);
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
      const inspection = await inspectRepository(prepared.repository);
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
    const controller = new AbortController();
    let leaseLost = false;
    this.startLeaseHeartbeat(taskId, leaseEpoch, () => {
      leaseLost = true;
      controller.abort();
    });
    this.controllers.set(taskId, controller);
    try {
      const initialTask = this.service.requireTask(taskId);
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
        if (this.cancelled.has(taskId) || task.status === "cancelled") {
          if (handoff) this.context.updateHandoff(handoff.id, { status: "cancelled" });
          return;
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
        this.service.updateTask(taskId, {
          status: "running", currentRunId: runId,
          nextAction: handoff ? `${executorId} 接管执行中` : "正在执行",
          error: null, pendingInput: null
        }, runId);
        const result = await this.runAttempt({ task, run, executorId, taskRoot, outDir, handoff, pendingInput, resumePrompt, previousRun, controller, budget: remainingBudget });
        if (result.status === "failed" || this.service.requireTask(taskId).status !== "completed") {
          this.assertLease(taskId, leaseEpoch, leaseLost);
        }
        if (result.status !== "failed") {
          if (handoff && result.status !== "cancelled" && result.status !== "waiting_input") this.context.updateHandoff(handoff.id, { status: "completed", toRunId: runId });
          this.refreshTaskSummary(taskId);
          return;
        }
        if (result.cancelled || result.leaseLost) {
          if (handoff) this.context.updateHandoff(handoff.id, { status: result.cancelled ? "cancelled" : "failed", toRunId: runId });
          this.refreshTaskSummary(taskId, { lastFailure: result.failure });
          return;
        }
        previousRun = result.run;
        if (handoff) {
          this.context.updateHandoff(handoff.id, { status: "failed", toRunId: runId });
          handoff = null;
        }
        const failureTask = this.service.requireTask(taskId);
        const cause = classifyFailure({ service: this.service, task: failureTask, run: result.run, error: result.error, aborted: result.aborted, stopping: this.stopping });
        const settings = this.context.settings();
        const target = this.selectHandoffTarget({ task: failureTask, cause, settings, attemptedExecutors, handoffsUsed, taskRoot });
        const diagnosis = await this.diagnoseFailure(taskId, failureTask, result.run, result.error, cause, target.targetExecutor);
        const decision = this.decideNextAction({
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
        this.capture({
          taskId, conversationId: failureTask.conversationId ?? null, runId: result.run.id, executorId,
          kind: "decision", role: "system", content: `${decision.action}：${decision.reason}`,
          provenance: { source: "fallback-policy", decision, cause, diagnosisId: diagnosis.id },
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
            cause, diagnosisId: diagnosis.id
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
          const created = this.context.createHandoff({
            taskId, fromRunId: result.run.id, fromExecutor: executorId, toExecutor: decision.targetExecutor,
            status, reasonCode: cause, diagnosis, packet,
            contextWatermarkSeq: this.context.getState(taskId)?.summarySeq ?? 0, initiatedBy: "auto"
          });
          const finalPacket: HandoffPacket = { ...packet, handoffId: created.id };
          this.context.updateHandoff(created.id, { packet: finalPacket });
          this.writeHandoffFile(taskRoot, result.outDir, created.id, finalPacket);
          const currentHandoff: HandoffRecord = { ...created, packet: finalPacket };
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
            cause, diagnosisId: diagnosis.id
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
          cause, diagnosisId: diagnosis.id
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
      this.controllers.delete(taskId);
      this.cancelled.delete(taskId);
      if (this.service.store.getTask(taskId)?.status !== "waiting_approval") this.releaseLease(taskId);
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
      const basePrompt = buildTaskPrompt(task, prepared, expectedOutputs, template?.acceptance ?? [], runtime, template?.approvalKind, memoryContext) + permissionNote;
      let prompt = handoff?.packet
        ? this.buildHandoffPrompt(task, prepared, expectedOutputs, handoff.packet, permissionNote, memoryContext)
        : basePrompt;
      if (pendingInput && !resumeState && executorId !== "codex") prompt = `${basePrompt}\n\n用户补充信息：\n${pendingInput}`;
      let activeThreadId = !handoff && input.previousRun?.executorId === executorId
        ? input.previousRun.threadId ?? undefined
        : undefined;
      if (executorId === "codex" && activeThreadId && input.resumePrompt) prompt = input.resumePrompt;
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
        ...(activeThreadId ? { activeThreadId } : {}),
        onProgress: (event) => this.publishProgress(taskId, runId, event.kind, event.message, event.detail),
        onNativeContextEvent: (event) => this.captureNativeEvent(task, run, event),
        onNativeCheckpoint: (checkpoint) => this.persistNativeCheckpoint(taskId, runId, prepared.root, checkpoint),
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
        const repairPrompt = buildDeliveryRepairPrompt({ task, prepared, expectedOutputs, missing, issues, attempt: repairAttempt }) + permissionNote;
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
        usage: result.usage, executorId, failure: null
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
      this.service.updateTask(taskId, {
        status: "completed", currentRunId: runId, nextAction: "产物已保存",
        error: null, resultSummary: result.finalResponse
      }, runId);
      try {
        this.memory.captureExperience(taskId);
      } catch {
        // Experience capture is best effort and never changes task success.
      }
      this.refreshTaskSummary(taskId);
      return { status: "completed", run: { ...run, status: "completed", threadId: result.threadId, usage: result.usage }, executorId, outDir, error: null, failure: null, aborted: controller.signal.aborted, leaseLost: false, cancelled: false };
    } catch (error) {
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

  private finishWaitingInput(taskId: string, run: RunRecord, result: ExecutionOutcome): AttemptResult {
    this.service.updateRun(run.id, taskId, { status: "waiting_input", endedAt: new Date().toISOString(), usage: result.usage, failure: null });
    this.service.updateTask(taskId, {
      status: "waiting_input", currentRunId: run.id, nextAction: "等待你补充信息",
      error: null, resultSummary: result.question ?? result.finalResponse
    }, run.id);
      this.refreshTaskSummary(taskId);
    return { status: "waiting_input", run: { ...run, status: "waiting_input", usage: result.usage }, executorId: run.executorId ?? "codex", outDir: this.outDirForRun(taskId, run), error: null, failure: null, aborted: false, leaseLost: false, cancelled: false };
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

  private taskRoot(taskId: string): string {
    return join(this.workspaceRoot, "tasks", taskId);
  }

  private outDirForRun(taskId: string, run: RunRecord): string {
    const root = this.taskRoot(taskId);
    return run.workspace === root ? join(root, "out", run.id) : join(run.workspace, "out");
  }

  private remainingBudget(taskId: string): RunBudget {
    const runs = this.service.store.listRuns(taskId);
    const usedTokens = runs.reduce((sum, run) => sum + (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0), 0);
    const usedMs = runs.reduce((sum, run) => {
      if (!run.startedAt || !run.endedAt) return sum;
      return sum + Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt));
    }, 0);
    return {
      maxTurns: Math.max(1, this.runBudget.maxTurns - runs.length),
      maxToolCalls: this.runBudget.maxToolCalls,
      maxTokens: Math.max(1, this.runBudget.maxTokens - usedTokens),
      maxDurationMs: Math.max(1_000, this.runBudget.maxDurationMs - usedMs)
    };
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

  private buildHandoffPrompt(task: TaskRecord, prepared: PreparedWorkspace, expectedOutputs: string[], packet: HandoffPacket, permissionNote: string, memoryContext: string): string {
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
      packetOverride: packet
    });
    return [
      projected.prompt,
      "## 工作区",
      `- 当前工作区：${prepared.root}`,
      `- 本轮输出目录：${prepared.outDir}`,
      `- 期望产物：${expectedOutputs.join("、")}`,
      `- 任务：${task.title}`,
      "",
      "请先核对工作区和产物哈希，再从“下一步”继续执行；不要重复已经产生外部副作用的动作。" + permissionNote
    ].join("\n");
  }

  private writeHandoffFile(taskRoot: string, previousOutDir: string, handoffId: string, packet: HandoffPacket): void {
    const markdown = this.projector.renderHandoffMarkdown(packet);
    const directory = join(taskRoot, ".hearth", "handoffs", handoffId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "HANDOFF.md"), markdown, "utf8");
    writeFileSync(join(taskRoot, "HANDOFF.md"), markdown, "utf8");
    if (existsSync(previousOutDir)) writeFileSync(join(previousOutDir, "HANDOFF.md"), markdown, "utf8");
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
