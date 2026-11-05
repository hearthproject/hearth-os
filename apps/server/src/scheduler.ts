import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRecord, TaskRecord } from "@hearth/core";
import { runCodex, type CodexRunOptions, type CodexRunResult } from "@hearth/codex-executor";
import { getTemplate } from "@hearth/templates";
import type { ApprovalRequest, ApprovalManager } from "./approvals.ts";
import { missingExpectedOutputs, publishArtifacts } from "./artifacts.ts";
import { GIT_CACHE_DIR, REPO_ROOT, WORKSPACE_DIR } from "./config.ts";
import { extractProposedComment, inspectRepository, readPrPreview, validatePullRequestPreview } from "./github.ts";
import type { CommandRunner } from "./github.ts";
import { prepareTaskRuntime, type RuntimePreparation } from "./runtime.ts";
import type { HearthService } from "./service.ts";
import { buildDeliveryRepairPrompt, buildTaskPrompt, prepareWorkspace, UnsupportedInputError } from "./workspace.ts";

export type CodexRunner = (options: CodexRunOptions) => Promise<CodexRunResult>;

export interface SchedulerOptions {
  service: HearthService;
  repoRoot?: string;
  workspaceRoot?: string;
  artifactBase?: string;
  codexRunner?: CodexRunner;
  approvals?: ApprovalManager;
  githubRun?: CommandRunner | undefined;
  githubCacheRoot?: string | undefined;
  runtimePreparer?: typeof prepareTaskRuntime | undefined;
}

export class HearthScheduler {
  private readonly service: HearthService;
  private readonly repoRoot: string;
  private readonly workspaceRoot: string;
  private readonly artifactBase: string;
  private readonly codexRunner: CodexRunner;
  private readonly approvals: ApprovalManager | undefined;
  private readonly githubRun: CommandRunner | undefined;
  private readonly githubCacheRoot: string;
  private readonly runtimePreparer: typeof prepareTaskRuntime;
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
    this.codexRunner = options.codexRunner ?? runCodex;
    this.approvals = options.approvals;
    this.githubRun = options.githubRun;
    this.githubCacheRoot = options.githubCacheRoot ?? GIT_CACHE_DIR;
    this.runtimePreparer = options.runtimePreparer ?? prepareTaskRuntime;
  }

  get running(): boolean {
    return !this.stopped;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.stopping = false;
    this.recoverInterruptedTasks();
    this.unsubscribe = this.service.bus.subscribe((event) => {
      if (event.type === "task.created" || event.type === "task.updated") this.wake();
    });
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopping = true;
    for (const controller of this.controllers.values()) controller.abort();
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
    return this.service.requireTask(taskId);
  }

  retry(taskId: string): TaskRecord {
    const task = this.service.requireTask(taskId);
    if (task.status !== "recoverable" && task.status !== "failed") {
      throw new Error(`当前状态不能重试：${task.status}`);
    }
    const updated = this.service.updateTask(taskId, {
      status: "queued",
      nextAction: "等待执行",
      error: null
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
    const queued = this.service.store.listTasks().filter((task) => task.status === "queued");
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
    const now = new Date().toISOString();
    const attempt = this.service.store.listRuns(taskId).length + 1;
    const runId = randomUUID();
    const workspace = join(this.workspaceRoot, runId);
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
      createdAt: now
    };
    const controller = new AbortController();

    this.service.createRun(run);
    this.service.updateTask(taskId, {
      status: "running",
      currentRunId: runId,
      nextAction: "正在执行",
      error: null
    }, runId);
    this.controllers.set(taskId, controller);

    try {
      const task = this.service.requireTask(taskId);
      const template = task.templateId ? getTemplate(task.templateId) : undefined;
      const expectedOutputs = template?.expectedOutputs ?? ["report.md"];
      const prepared = await prepareWorkspace({
        repoRoot: this.repoRoot,
        workspaceDir: workspace,
        task,
        githubCacheRoot: this.githubCacheRoot,
        ...(this.githubRun ? { githubRun: this.githubRun } : {})
      });
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
      const prompt = buildTaskPrompt(task, prepared, expectedOutputs, template?.acceptance ?? [], runtime, template?.approvalKind);
      let result = await this.codexRunner({
        workingDirectory: prepared.root,
        prompt,
        signal: controller.signal,
        onEvent: (event) => this.publishProgress(taskId, runId, event.type, event.message)
      });

      for (let repairAttempt = 1; repairAttempt <= 2; repairAttempt += 1) {
        const missing = missingExpectedOutputs(prepared.outDir, expectedOutputs);
        if (missing.length === 0) break;
        result = await this.codexRunner({
          workingDirectory: prepared.root,
          prompt: buildDeliveryRepairPrompt({
            task,
            prepared,
            expectedOutputs,
            missing,
            attempt: repairAttempt
          }),
          signal: controller.signal,
          onEvent: (event) => this.publishProgress(taskId, runId, event.type, event.message)
        });
      }
      const stillMissing = missingExpectedOutputs(prepared.outDir, expectedOutputs);
      if (stillMissing.length > 0) throw new Error(`缺少期望产物：${stillMissing.join("、")}`);

      const artifacts = publishArtifacts({
        task,
        run,
        outDir: prepared.outDir,
        artifactBase: this.artifactBase,
        expectedOutputs,
        inputs: prepared.inputs,
        codex: {
          threadId: result.threadId,
          profileLabel: result.profileLabel,
          usage: result.usage
        }
      });
      for (const artifact of artifacts) this.service.publishArtifact(artifact);

      const endedAt = new Date().toISOString();
      this.service.updateRun(runId, taskId, {
        status: "completed",
        threadId: result.threadId,
        endedAt,
        usage: result.usage,
        failure: null
      });

      if (template && template.approvalKind !== "none") {
        if (!this.approvals) throw new Error("审批管理器未启动，无法安全执行外部动作");
        const request = await this.buildApproval(task, template, prepared);
        this.service.updateTask(taskId, {
          status: "waiting_approval",
          currentRunId: runId,
          nextAction: "等待你确认外部动作",
          error: null
        }, runId);
        this.approvals.request({ ...request, taskId, runId });
        return;
      }

      this.service.updateTask(taskId, {
        status: "completed",
        currentRunId: runId,
        nextAction: "产物已保存",
        error: null
      }, runId);
    } catch (error) {
      await this.failRun(taskId, runId, error, controller.signal.aborted);
    } finally {
      this.controllers.delete(taskId);
      this.cancelled.delete(taskId);
    }
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

  private async failRun(taskId: string, runId: string, error: unknown, aborted: boolean): Promise<void> {
    const endedAt = new Date().toISOString();
    const task = this.service.store.getTask(taskId);
    if (!task) return;
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
