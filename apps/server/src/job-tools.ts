import type { AgentTool, AgentToolContext } from "@hearth/agent-runtime";
import { killShellSession } from "@hearth/agent-runtime";
import type { BackgroundToolService } from "./background-tools.ts";
import type { SubagentTaskManager } from "./subagent-manager.ts";

export interface JobToolRegistry {
  owner: { taskId: string; runId: string };
  background: BackgroundToolService | null;
  subagents: SubagentTaskManager | null;
}

interface JobView {
  id: string;
  kind: "shell" | "background_tool" | "subagent";
  status: string;
  owner: { taskId: string | null; runId: string | null };
  label: string;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
  stopReason: string | null;
  output: string | null;
}

export function createJobTools(registry: JobToolRegistry): AgentTool[] {
  const listJobs = (context: AgentToolContext): JobView[] => {
    const views: JobView[] = [];
    for (const job of registry.background?.list({ limit: 100 }) ?? []) {
      views.push({
        id: job.id,
        kind: "background_tool",
        status: normalizeBackgroundStatus(job.status),
        owner: { taskId: job.taskId, runId: job.runId },
        label: job.toolName,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        settledAt: job.finishedAt,
        stopReason: job.stopReason,
        output: job.output ? job.output.slice(-2_000) : null
      });
    }
    for (const job of registry.subagents?.status() ?? []) {
      views.push({
        id: job.id,
        kind: "subagent",
        status: normalizeSubagentStatus(job.status),
        owner: { ...registry.owner },
        label: `${job.type}: ${job.title}`,
        createdAt: job.startedAt,
        updatedAt: job.lastProgressAt,
        settledAt: job.endedAt,
        stopReason: job.error,
        output: job.summary
      });
    }
    for (const work of context.state?.activeWork ?? []) {
      views.push({
        id: work.id,
        kind: "shell",
        status: work.status,
        owner: { ...registry.owner },
        label: work.label ?? "shell session",
        createdAt: new Date(work.startedAt).toISOString(),
        updatedAt: new Date(work.endedAt ?? work.startedAt).toISOString(),
        settledAt: work.endedAt ? new Date(work.endedAt).toISOString() : null,
        stopReason: work.exitCode === null || work.exitCode === undefined ? null : `exit ${work.exitCode}`,
        output: null
      });
    }
    return views;
  };

  const jobList: AgentTool = {
    definition: {
      name: "job_list",
      description: "列出当前任务的后台工具、子代理和 shell 会话。用于并行推进多条工作线，而不是轮询单个工具。",
      executionMode: "parallel",
      effect: "read",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    },
    async execute(_input, context) {
      const jobs = listJobs(context);
      if (jobs.length === 0) return { content: "当前没有运行中的 job。", metadata: { totalChars: 0 } };
      return { content: jobs.map((job) => `${job.id} | ${job.kind} | ${job.status} | ${job.label}`).join("\n") };
    }
  };

  const jobStatus: AgentTool = {
    definition: {
      name: "job_status",
      description: "查看一个 job 的标准化状态、所属任务/运行、输出尾部与停止原因。",
      executionMode: "parallel",
      effect: "read",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "job ID" } },
        required: ["id"],
        additionalProperties: false
      }
    },
    async execute(input, context) {
      const id = stringArg(input, "id");
      const job = listJobs(context).find((item) => item.id === id);
      if (!job) throw new Error(`没有找到 job：${id}`);
      return { content: JSON.stringify(job, null, 2), metadata: { jobId: job.id, jobKind: job.kind, jobStatus: job.status } };
    }
  };

  const jobWait: AgentTool = {
    definition: {
      name: "job_wait",
      description: "等待后台工具或子代理完成，超时返回结构化 JOB_TIMEOUT。shell 会话用 shell_wait。",
      executionMode: "sequential",
      timeoutMs: 310_000,
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "job ID" },
          timeoutMs: { type: "number", description: "最长等待毫秒，默认 30 秒，上限 5 分钟" }
        },
        required: ["id"],
        additionalProperties: false
      }
    },
    async execute(input, context) {
      const id = stringArg(input, "id");
      const timeoutMs = Math.min(300_000, Math.max(1_000, numberArg(input, "timeoutMs", 30_000)));
      if (registry.background?.get(id)) {
        const job = await registry.background.waitFor(id, timeoutMs);
        return { content: `${job.id} ${job.status}${job.output ? `\n${job.output.slice(-2_000)}` : ""}`, metadata: { jobId: job.id, jobKind: "background_tool", jobStatus: job.status } };
      }
      if (registry.subagents?.get(id)) {
        const job = await registry.subagents.wait(id, timeoutMs);
        if (job.status === "running") throw jobTimeout(id, timeoutMs);
        return { content: `${job.id} ${job.status}${job.summary ? `\n${job.summary}` : ""}`, metadata: { jobId: job.id, jobKind: "subagent", jobStatus: job.status } };
      }
      const shell = context.state?.activeWork?.find((work) => work.id === id);
      if (shell) {
        if (shell.status === "running") throw jobTimeout(id, timeoutMs);
        return { content: `${shell.id} ${shell.status}${shell.exitCode === undefined || shell.exitCode === null ? "" : ` exit=${shell.exitCode}`}`, metadata: { jobId: shell.id, jobKind: "shell", jobStatus: shell.status } };
      }
      throw new Error(`没有找到 job：${id}`);
    }
  };

  const jobStop: AgentTool = {
    definition: {
      name: "job_stop",
      description: "停止一个后台工具、子代理或 shell 会话，并记录停止原因。",
      executionMode: "sequential",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "job ID" },
          reason: { type: "string", description: "停止原因" }
        },
        required: ["id"],
        additionalProperties: false
      }
    },
    async execute(input, context) {
      const id = stringArg(input, "id");
      const reason = typeof (input as { reason?: unknown }).reason === "string" ? String((input as { reason?: unknown }).reason) : "用户停止";
      if (registry.background?.get(id)) {
        const job = registry.background.stop(id, reason);
        return { content: `${job.id} ${job.status}`, metadata: { jobId: job.id, jobKind: "background_tool", jobStatus: job.status } };
      }
      if (registry.subagents?.get(id)) {
        const killed = registry.subagents.kill(id);
        return killed
          ? { content: `${id} stopped`, metadata: { jobId: id, jobKind: "subagent", jobStatus: "stopped" } }
          : { content: `${id} not_running` };
      }
      if (context.state?.activeWork?.some((work) => work.id === id)) {
        const killed = killShellSession(id);
        return killed
          ? { content: `${id} stopped`, metadata: { jobId: id, jobKind: "shell", jobStatus: "stopped" } }
          : { content: `${id} not_running` };
      }
      throw new Error(`没有找到 job：${id}`);
    }
  };

  return [jobList, jobStatus, jobWait, jobStop];
}

function stringArg(input: unknown, key: string): string {
  const value = (input as Record<string, unknown> | null)?.[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少 ${key}`);
  return value.trim();
}

function numberArg(input: unknown, key: string, fallback: number): number {
  const value = (input as Record<string, unknown> | null)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeBackgroundStatus(status: string): string {
  if (status === "finished") return "settled";
  if (status === "running" || status === "queued") return status;
  return status;
}

function normalizeSubagentStatus(status: string): string {
  if (status === "completed") return "settled";
  return status;
}

function jobTimeout(id: string, timeoutMs: number): Error & { code: string } {
  return Object.assign(new Error(`等待 job ${id} 超时（${timeoutMs}ms）`), { code: "JOB_TIMEOUT" });
}
