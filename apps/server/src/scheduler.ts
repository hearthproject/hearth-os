import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { RunRecord, TaskRecord } from "@hearth/core";
import { runCodex, type CodexRunOptions, type CodexRunResult } from "@hearth/codex-executor";
import { getTemplate } from "@hearth/templates";
import { publishArtifacts } from "./artifacts.ts";
import { REPO_ROOT, WORKSPACE_DIR } from "./config.ts";
import type { HearthService } from "./service.ts";
import { buildTaskPrompt, prepareWorkspace, UnsupportedInputError } from "./workspace.ts";

export type CodexRunner = (options: CodexRunOptions) => Promise<CodexRunResult>;

export interface SchedulerOptions {
  service: HearthService;
  repoRoot?: string;
  workspaceRoot?: string;
  artifactBase?: string;
  codexRunner?: CodexRunner;
}

export class HearthScheduler {
  private readonly service: HearthService;
  private readonly repoRoot: string;
  private readonly workspaceRoot: string;
  private readonly artifactBase: string;
  private readonly codexRunner: CodexRunner;
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
      const prepared = prepareWorkspace({ repoRoot: this.repoRoot, workspaceDir: workspace, task });
      const prompt = buildTaskPrompt(task, prepared, expectedOutputs, template?.acceptance ?? []);
      const result = await this.codexRunner({
        workingDirectory: prepared.root,
        prompt,
        signal: controller.signal,
        onEvent: (event) => this.publishProgress(taskId, runId, event.type, event.message)
      });

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
