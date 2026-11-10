import { randomUUID } from "node:crypto";
import type { AgentTool } from "@hearth/agent-runtime";
import type { BackgroundToolJob } from "@hearth/core";
import type { HearthService } from "./service.ts";
import { isBackgroundToolReadOnly } from "./tool-policy.ts";

export type BackgroundToolRunner = (job: BackgroundToolJob, signal: AbortSignal) => Promise<{ output: string; exitCode: number | null }>;

export interface BackgroundToolAuthorizeInput {
  job: BackgroundToolJob;
  signal: AbortSignal;
}

export type BackgroundToolAuthorizer = (input: BackgroundToolAuthorizeInput) => Promise<void>;

export interface BackgroundToolOptions {
  runner: BackgroundToolRunner;
  authorize?: BackgroundToolAuthorizer;
  maxConcurrent?: number;
  maxOutputChars?: number;
  timeoutMs?: number;
  now?: () => Date;
}

export class BackgroundToolError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "BackgroundToolError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface StartBackgroundToolInput {
  taskId: string;
  runId?: string | null;
  toolName: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
}

const TERMINAL = new Set(["finished", "failed", "stopped"]);

export class BackgroundToolService {
  private readonly running = new Map<string, AbortController>();
  private readonly waiters = new Map<string, Array<(job: BackgroundToolJob) => void>>();
  private readonly runner: BackgroundToolRunner;
  private readonly authorize: BackgroundToolAuthorizer | undefined;
  private readonly maxConcurrent: number;
  private readonly maxOutputChars: number;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly service: HearthService, options: BackgroundToolOptions) {
    this.runner = options.runner;
    this.authorize = options.authorize;
    this.maxConcurrent = Math.max(1, Math.min(8, options.maxConcurrent ?? 2));
    this.maxOutputChars = Math.max(1000, Math.min(1_000_000, options.maxOutputChars ?? 64_000));
    this.defaultTimeoutMs = Math.max(1_000, Math.min(30 * 60_000, options.timeoutMs ?? 10 * 60_000));
    this.now = options.now ?? (() => new Date());
  }

  async start(input: StartBackgroundToolInput): Promise<BackgroundToolJob> {
    const task = this.service.requireTask(input.taskId);
    if (["completed", "cancelled"].includes(task.status)) {
      throw new BackgroundToolError("BACKGROUND_TOOL_TASK_CLOSED", `任务 ${task.status}，不能再启动后台工具`, 409);
    }
    const toolName = input.toolName.trim();
    if (!toolName) throw new BackgroundToolError("BACKGROUND_TOOL_NAME_REQUIRED", "必须指定工具名");
    if (task.permissions && !task.permissions.tools.includes(toolName)) {
      throw new BackgroundToolError("BACKGROUND_TOOL_NOT_AUTHORIZED", `任务未授权工具：${toolName}`, 403);
    }
    if (!isBackgroundToolReadOnly(toolName) && !this.authorize) {
      throw new BackgroundToolError(
        "BACKGROUND_TOOL_APPROVAL_REQUIRED",
        `后台工具 ${toolName} 不是只读工具，且当前没有审批授权通道`,
        403
      );
    }
    if (this.running.size >= this.maxConcurrent) {
      throw new BackgroundToolError("BACKGROUND_TOOL_BUSY", `后台工具已达到并发上限 ${this.maxConcurrent}`, 429);
    }
    const now = this.now().toISOString();
    const job: BackgroundToolJob = {
      id: `bgtool:${randomUUID()}`,
      taskId: task.id,
      runId: input.runId ?? task.currentRunId ?? null,
      toolName,
      args: input.args ?? {},
      status: "queued",
      output: "",
      outputRef: null,
      exitCode: null,
      stopReason: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null
    };
    const controller = new AbortController();
    if (!isBackgroundToolReadOnly(toolName)) {
      try {
        await this.authorize!({ job, signal: controller.signal });
      } catch (error) {
        if (error instanceof BackgroundToolError) throw error;
        throw new BackgroundToolError(
          "BACKGROUND_TOOL_AUTHORIZATION_FAILED",
          error instanceof Error ? error.message : String(error),
          403
        );
      }
    }
    if (controller.signal.aborted) {
      throw new BackgroundToolError("BACKGROUND_TOOL_CANCELLED", "后台工具在启动前已取消", 409);
    }
    if (this.running.size >= this.maxConcurrent) {
      throw new BackgroundToolError("BACKGROUND_TOOL_BUSY", `后台工具已达到并发上限 ${this.maxConcurrent}`, 429);
    }
    this.persist(job);
    this.running.set(job.id, controller);
    const timeoutMs = Math.max(1_000, Math.min(30 * 60_000, input.timeoutMs ?? this.defaultTimeoutMs));
    const timer = setTimeout(() => controller.abort(new Error("后台工具执行超时")), timeoutMs);
    void this.execute(job, controller, timeoutMs).finally(() => clearTimeout(timer));
    return this.require(job.id);
  }

  stop(jobId: string, reason = "用户停止"): BackgroundToolJob {
    const job = this.require(jobId);
    if (TERMINAL.has(job.status)) return job;
    const controller = this.running.get(jobId);
    if (controller) controller.abort(new Error(reason));
    this.running.delete(jobId);
    return this.update(job, { status: "stopped", stopReason: reason, finishedAt: this.now().toISOString() });
  }

  get(jobId: string): BackgroundToolJob | null {
    return this.service.store.getBackgroundToolJob(jobId);
  }

  list(opts: { taskId?: string; runId?: string; status?: string; limit?: number } = {}): BackgroundToolJob[] {
    return this.service.store.listBackgroundToolJobs(opts);
  }

  waitFor(jobId: string, timeoutMs = 30_000): Promise<BackgroundToolJob> {
    const job = this.require(jobId);
    if (TERMINAL.has(job.status)) return Promise.resolve(job);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new BackgroundToolError("BACKGROUND_TOOL_WAIT_TIMEOUT", "等待后台工具超时", 408)), timeoutMs);
      const done = (finished: BackgroundToolJob): void => {
        clearTimeout(timer);
        resolve(finished);
      };
      const queue = this.waiters.get(jobId) ?? [];
      queue.push(done);
      this.waiters.set(jobId, queue);
    });
  }

  toolsFor(task: { id: string; currentRunId: string | null }): AgentTool[] {
    return [
      {
        definition: {
          name: "start_background_tool",
          description: "启动一个耗时工具并立即返回任务号；完成后用 check_background_tool 读取结果。用于避免长时间阻塞对话。",
          parameters: {
            type: "object",
            properties: {
              toolName: { type: "string", description: "要调用的工具名，例如 shell 或 fetch_url" },
              args: { type: "object", description: "传给工具的原始参数" }
            },
            required: ["toolName"],
            additionalProperties: false
          }
        },
        execute: async (input) => {
          const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
          const toolName = String(args.toolName ?? "");
          const toolArgs = args.args && typeof args.args === "object" ? args.args as Record<string, unknown> : {};
          const job = await this.start({ taskId: task.id, runId: task.currentRunId, toolName, args: toolArgs });
          return { content: `后台工具已启动：${job.id}（${job.toolName}）。可用 check_background_tool 查询结果。` };
        }
      },
      {
        definition: {
          name: "check_background_tool",
          description: "查询后台工具状态；完成后返回截断后的输出。",
          parameters: {
            type: "object",
            properties: { jobId: { type: "string" } },
            required: ["jobId"],
            additionalProperties: false
          }
        },
        execute: async (input) => {
          const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
          const job = this.require(String(args.jobId ?? ""));
          return {
            content: `状态：${job.status}\n${job.output || job.stopReason || "（暂无输出）"}`,
            ...(job.status === "failed" ? { isError: true } : {})
          };
        }
      }
    ] as AgentTool[];
  }

  private async execute(job: BackgroundToolJob, controller: AbortController, timeoutMs: number): Promise<void> {
    let current = this.update(job, { status: "running" });
    try {
      const result = await this.runner(current, controller.signal);
      if (controller.signal.aborted) {
        this.finish(current, {
          status: "stopped",
          output: clip(result.output, this.maxOutputChars),
          stopReason: String(controller.signal.reason ?? "已停止"),
          exitCode: result.exitCode
        });
        return;
      }
      this.finish(current, {
        status: result.exitCode === 0 || result.exitCode == null ? "finished" : "failed",
        output: clip(result.output, this.maxOutputChars),
        exitCode: result.exitCode,
        finishedAt: this.now().toISOString()
      });
    } catch (error) {
      current = this.require(job.id);
      this.finish(current, {
        status: controller.signal.aborted ? "stopped" : "failed",
        output: clip(error instanceof Error ? error.message : String(error), this.maxOutputChars),
        stopReason: controller.signal.aborted ? String(controller.signal.reason ?? `超时（${timeoutMs}ms）`) : null,
        exitCode: null
      });
    } finally {
      this.running.delete(job.id);
    }
  }

  private finish(job: BackgroundToolJob, patch: Partial<BackgroundToolJob>): void {
    const updated = this.update(job, {
      ...patch,
      finishedAt: patch.finishedAt ?? this.now().toISOString()
    });
    const waiters = this.waiters.get(updated.id) ?? [];
    this.waiters.delete(updated.id);
    for (const waiter of waiters) waiter(updated);
  }

  private update(job: BackgroundToolJob, patch: Partial<BackgroundToolJob>): BackgroundToolJob {
    const updated: BackgroundToolJob = { ...job, ...patch, updatedAt: this.now().toISOString() };
    this.persist(updated);
    return updated;
  }

  private persist(job: BackgroundToolJob): void {
    const event = this.service.store.appendEvent({ type: "tool.job.updated", taskId: job.taskId, runId: job.runId, payload: job });
    this.service.bus.publish(event);
  }

  private require(jobId: string): BackgroundToolJob {
    const job = this.service.store.getBackgroundToolJob(jobId);
    if (!job) throw new BackgroundToolError("BACKGROUND_TOOL_NOT_FOUND", "后台工具任务不存在", 404);
    return job;
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断，原长 ${text.length} 字符）`;
}