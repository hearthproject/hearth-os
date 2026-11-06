import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { AgentCheckpoint, AgentResumeState } from "@hearth/agent-runtime";
import type { ExecutorId, RunBudget, RunCheckpointRecord, RunRecord, RunUsage, TaskLease, TaskRecord } from "@hearth/core";
import { runCodex, type CodexRunOptions, type CodexRunResult } from "@hearth/codex-executor";
import { getTemplate } from "@hearth/templates";
import type { ApprovalRequest, ApprovalManager } from "./approvals.ts";
import { missingExpectedOutputs, publishArtifacts } from "./artifacts.ts";
import { GIT_CACHE_DIR, MODEL_SETTINGS_PATH, REPO_ROOT, SOURCE_CONTENT_DIR, WORKSPACE_DIR } from "./config.ts";
import { resolveExecutorId } from "./executors.ts";
import { extractProposedComment, inspectRepository, readPrPreview, validatePullRequestPreview } from "./github.ts";
import type { CommandRunner } from "./github.ts";
import { MemoryService } from "./memory.ts";
import { DEFAULT_LEASE_HEARTBEAT_MS, LeaseError, TaskLeaseService } from "./leases.ts";
import { DEFAULT_RUN_BUDGET, nativePermissionsFor, runNativeTask, type NativeRunOptions, type NativeRunResult } from "./native-executor.ts";
import { chatModelConfigured, loadModelSettings } from "./model-settings.ts";
import { prepareTaskRuntime, type RuntimePreparation } from "./runtime.ts";
import type { HearthService } from "./service.ts";
import { buildDeliveryRepairPrompt, buildTaskPrompt, prepareWorkspace, UnsupportedInputError } from "./workspace.ts";

export type CodexRunner = (options: CodexRunOptions) => Promise<CodexRunResult>;
export type NativeRunner = (options: NativeRunOptions) => Promise<NativeRunResult>;

interface ExecutionOutcome {
  status: "completed" | "waiting_input" | "failed" | "cancelled" | "budget_exceeded";
  finalResponse: string;
  usage: RunUsage | null;
  threadId: string | null;
  label: string;
  question: string | null;
}

export interface SchedulerOptions {
  service: HearthService;
  repoRoot?: string;
  workspaceRoot?: string;
  artifactBase?: string;
  attachmentRoot?: string;
  codexRunner?: CodexRunner;
  nativeRunner?: NativeRunner;
  modelSettingsPath?: string;
  runBudget?: RunBudget;
  approvals?: ApprovalManager;
  leases?: TaskLeaseService;
  leaseHeartbeatMs?: number;
  githubRun?: CommandRunner | undefined;
  githubCacheRoot?: string | undefined;
  sourceContentRoot?: string | undefined;
  runtimePreparer?: typeof prepareTaskRuntime | undefined;
}

export class HearthScheduler {
  private readonly service: HearthService;
  private readonly repoRoot: string;
  private readonly workspaceRoot: string;
  private readonly artifactBase: string;
  private readonly attachmentRoot: string | undefined;
  private readonly codexRunner: CodexRunner;
  private readonly nativeRunner: NativeRunner;
  private readonly modelSettingsPath: string;
  private readonly runBudget: RunBudget;
  private readonly approvals: ApprovalManager | undefined;
  private readonly githubRun: CommandRunner | undefined;
  private readonly githubCacheRoot: string;
  private readonly sourceContentRoot: string;
  private readonly runtimePreparer: typeof prepareTaskRuntime;
  private readonly memory: MemoryService;
  private readonly leases: TaskLeaseService;
  private readonly leaseHeartbeatMs: number;
  private readonly leaseHeartbeats = new Map<string, { epoch: number; timer: ReturnType<typeof setInterval> }>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();
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
    this.modelSettingsPath = options.modelSettingsPath ?? MODEL_SETTINGS_PATH;
    this.runBudget = options.runBudget ?? DEFAULT_RUN_BUDGET;
    this.approvals = options.approvals;
    this.githubRun = options.githubRun;
    this.githubCacheRoot = options.githubCacheRoot ?? GIT_CACHE_DIR;
    this.sourceContentRoot = options.sourceContentRoot ?? SOURCE_CONTENT_DIR;
    this.runtimePreparer = options.runtimePreparer ?? prepareTaskRuntime;
    this.memory = new MemoryService(this.service);
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
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  kick(): void {
    this.wake();
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
      const task = this.nextQueuedTask();
      if (!task) {
        await this.waitForWake();
        continue;
      }
      await this.runTask(task);
    }
  }

  private nextQueuedTask(): TaskRecord | null {
    const queued = this.service.store.listTasks().filter((task) => task.status === "queued" && !this.leases.isHeldByOther(task.id));
    queued.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return queued[0] ?? null;
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
    const now = new Date().toISOString();
    const attempt = this.service.store.listRuns(taskId).length + 1;
    const runId = randomUUID();
    const workspace = join(this.workspaceRoot, runId);
    const task = this.service.requireTask(taskId);
    const pendingInput = task.pendingInput?.trim() ?? "";
    const executorId = resolveExecutorId(task);
    const run: RunRecord = {
      id: runId,
      taskId,
      attempt,
      status: "running",
      threadId: null,
      workspace,
      startedAt: now,
      endedAt: null,
      failure: null,
      usage: null,
      leaseEpoch,
      createdAt: now,
      executorId,
      checkpointSeq: 0,
      budget: this.runBudget
    };
    const controller = new AbortController();
    let leaseLost = false;

    this.startLeaseHeartbeat(taskId, leaseEpoch, () => {
      leaseLost = true;
      controller.abort();
    });

    this.service.createRun(run);
    this.service.updateTask(taskId, {
      status: "running",
      currentRunId: runId,
      nextAction: "正在执行",
      error: null,
      pendingInput: null
    }, runId);
    this.controllers.set(taskId, controller);

    try {

      const task = this.service.requireTask(taskId);
      const template = task.templateId ? getTemplate(task.templateId) : undefined;
      const expectedOutputs = template?.expectedOutputs ?? task.expectedOutputs ?? ["result.md"];
      const nativeSettings = executorId === "native" ? loadModelSettings(this.modelSettingsPath) : null;
      if (executorId === "native" && (!nativeSettings || !chatModelConfigured(nativeSettings))) {
        throw new Error("还没有配置聊天模型。请到“设置”里选择服务商并填入 API Key，然后重试。");
      }
      const resumeState = executorId === "native" ? this.restoreResumeState(taskId, workspace, Boolean(pendingInput)) : undefined;
      if (pendingInput && resumeState) {
        resumeState.messages.push({ role: "user", content: `用户补充信息：\n${pendingInput}` });
      }
      const prepared = await prepareWorkspace({
        repoRoot: this.repoRoot,
        workspaceDir: workspace,
        task,
        githubCacheRoot: this.githubCacheRoot,
        sourceContentRoot: this.sourceContentRoot,
        getSourceItem: (itemId) => this.service.store.getSourceItem(itemId),
        ...(this.attachmentRoot ? { attachmentRoot: this.attachmentRoot } : {}),
        ...(this.githubRun ? { githubRun: this.githubRun } : {})
      });
      this.assertLease(taskId, leaseEpoch, leaseLost);
      let runtime: RuntimePreparation | null = null;
      if (prepared.repository && template?.github?.runtime) {
        runtime = await this.runtimePreparer({
          spec: template.github.runtime,
          repoPath: prepared.repository.path,
          workspaceRoot: prepared.root
        });
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
      const basePrompt = buildTaskPrompt(task, prepared, expectedOutputs, template?.acceptance ?? [], runtime, template?.approvalKind, memoryContext);
      const prompt = pendingInput && !resumeState ? `${basePrompt}\n\n用户补充信息：\n${pendingInput}` : basePrompt;
      const execute = async (executionPrompt: string, resume?: AgentResumeState): Promise<ExecutionOutcome> => {
        if (executorId === "native") {
          if (!nativeSettings) throw new Error("原生执行器缺少模型设置");
          const outcome = await this.nativeRunner({
            task,
            prepared,
            settings: nativeSettings,
            prompt: executionPrompt,
            permissions: nativePermissionsFor(task, prepared),
            budget: this.runBudget,
            signal: controller.signal,
            ...(resume ? { resume } : {}),
            expectedOutputs,
            onProgress: (event) => this.publishProgress(taskId, runId, event.kind, event.message),
            onCheckpoint: (checkpoint) => this.persistNativeCheckpoint(taskId, runId, prepared.root, checkpoint)
          });
          return {
            status: outcome.status,
            finalResponse: outcome.finalResponse,
            usage: outcome.usage,
            threadId: null,
            label: `native / ${nativeSettings.model}`,
            question: outcome.question
          };
        }
        const codexResult = await this.codexRunner({
          workingDirectory: prepared.root,
          prompt: executionPrompt,
          signal: controller.signal,
          onEvent: (event) => this.publishProgress(taskId, runId, event.type, event.message)
        });
        return {
          status: "completed",
          finalResponse: codexResult.finalResponse,
          usage: codexResult.usage,
          threadId: codexResult.threadId,
          label: codexResult.profileLabel,
          question: null
        };
      };

      let result = await execute(prompt, resumeState);
      this.assertLease(taskId, leaseEpoch, leaseLost);
      if (result.status === "waiting_input") {
        this.service.updateRun(runId, taskId, {
          status: "waiting_input",
          endedAt: new Date().toISOString(),
          usage: result.usage,
          failure: null
        });
        this.service.updateTask(taskId, {
          status: "waiting_input",
          currentRunId: runId,
          nextAction: "等待你补充信息",
          error: null,
          resultSummary: result.question ?? result.finalResponse
        }, runId);
        return;
      }
      this.assertCompleted(result);

      for (let repairAttempt = 1; repairAttempt <= 2; repairAttempt += 1) {
        const issues = await this.deliveryIssues(task, prepared, expectedOutputs);
        if (issues.length === 0) break;
        const missing = missingExpectedOutputs(prepared.outDir, expectedOutputs);
        result = await execute(buildDeliveryRepairPrompt({
            task,
            prepared,
            expectedOutputs,
            missing,
            issues,
            attempt: repairAttempt
          }));
        this.assertLease(taskId, leaseEpoch, leaseLost);
        if (result.status === "waiting_input") {
          this.service.updateRun(runId, taskId, {
            status: "waiting_input",
            endedAt: new Date().toISOString(),
            usage: result.usage,
            failure: null
          });
          this.service.updateTask(taskId, {
            status: "waiting_input",
            currentRunId: runId,
            nextAction: "等待你补充信息",
            error: null,
            resultSummary: result.question ?? result.finalResponse
          }, runId);
          return;
        }
        this.assertCompleted(result);
      }
      const remainingIssues = await this.deliveryIssues(task, prepared, expectedOutputs);
      if (remainingIssues.length > 0) throw new Error(remainingIssues.join("\n"));
      if (!result.finalResponse.trim()) throw new Error("执行器没有返回最终总结");

      this.assertLease(taskId, leaseEpoch, leaseLost);

      const artifacts = publishArtifacts({
        task,
        run,
        outDir: prepared.outDir,
        artifactBase: this.artifactBase,
        expectedOutputs,
        inputs: prepared.inputs,
        executor: {
          id: executorId,
          threadId: result.threadId,
          label: result.label,
          usage: result.usage
        },
        ...(executorId === "codex" ? { codex: { threadId: result.threadId, profileLabel: result.label, usage: result.usage } } : {})
      });
      for (const artifact of artifacts) this.service.publishArtifact(artifact);

      const endedAt = new Date().toISOString();
      this.service.updateRun(runId, taskId, {
        status: "completed",
        threadId: result.threadId,
        endedAt,
        usage: result.usage,
        executorId,
        failure: null
      });

      if (template && template.approvalKind !== "none") {
        if (!this.approvals) throw new Error("审批管理器未启动，无法安全执行外部动作");
        const request = await this.buildApproval(task, template, prepared);
        this.assertLease(taskId, leaseEpoch, leaseLost);
        this.service.updateTask(taskId, {
          status: "waiting_approval",
          currentRunId: runId,
          nextAction: "等待你确认外部动作",
          error: null,
          resultSummary: result.finalResponse
        }, runId);
        this.approvals.request({ ...request, taskId, runId });
        return;
      }

      this.service.updateTask(taskId, {
        status: "completed",
        currentRunId: runId,
        nextAction: "产物已保存",
        error: null,
        resultSummary: result.finalResponse
      }, runId);
      try {
        this.memory.captureExperience(taskId);
      } catch {
        // Experience capture is best effort and never changes task success.
      }
    } catch (error) {
      await this.failRun(taskId, runId, error, controller.signal.aborted, leaseEpoch);
    } finally {
      this.controllers.delete(taskId);
      this.cancelled.delete(taskId);
      if (this.service.store.getTask(taskId)?.status !== "waiting_approval") this.releaseLease(taskId);
    }
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
    const directory = join(workspace, ".hearth", "checkpoints");
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

    const failure = aborted && this.stopping
      ? {
          kind: "interrupted",
          message: "Hearth 关闭时中止了这一轮执行",
          recoverable: true,
          guidance: "重新启动后点击重试"
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

  private publishProgress(taskId: string, runId: string, kind: string, message: string): void {
    const event = this.service.store.appendEvent({
      type: "task.progress",
      taskId,
      runId,
      payload: { kind, message, at: new Date().toISOString() }
    });
    this.service.bus.publish(event);
  }
}

function isTerminalStatus(status: TaskRecord["status"] | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "recoverable";
}
