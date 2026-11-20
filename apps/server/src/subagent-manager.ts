import type { AgentTool, AgentToolResult } from "@hearth/agent-runtime";

export type ManagedAgentStatus = "running" | "completed" | "failed" | "cancelled";

export interface ManagedAgent {
  id: string;
  type: string;
  title: string;
  status: ManagedAgentStatus;
  startedAt: string;
  endedAt: string | null;
  controller: AbortController;
  promise: Promise<AgentToolResult> | null;
  result: AgentToolResult | null;
  error: string | null;
}

export interface ManagedAgentView {
  id: string;
  type: string;
  title: string;
  status: ManagedAgentStatus;
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  error: string | null;
}

export class SubagentTaskManager {
  private readonly jobs = new Map<string, ManagedAgent>();

  constructor(private readonly maxConcurrent = 4) {}

  start(input: { id: string; type: string; title: string }, run: (signal: AbortSignal) => Promise<AgentToolResult>): ManagedAgent {
    const running = [...this.jobs.values()].filter((job) => job.status === "running").length;
    if (running >= this.maxConcurrent) throw new Error(`同时最多运行 ${this.maxConcurrent} 个子代理`);
    const id = input.id;
    if (this.jobs.has(id)) throw new Error(`子代理 ID 已存在：${id}`);
    const job: ManagedAgent = {
      id,
      type: input.type,
      title: input.title,
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      controller: new AbortController(),
      promise: null,
      result: null,
      error: null
    };
    this.jobs.set(id, job);
    job.promise = run(job.controller.signal)
      .then((result) => {
        job.result = result;
        job.status = job.controller.signal.aborted ? "cancelled" : "completed";
        return result;
      })
      .catch((error) => {
        job.error = error instanceof Error ? error.message : String(error);
        job.status = job.controller.signal.aborted ? "cancelled" : "failed";
        throw error;
      })
      .finally(() => {
        job.endedAt = new Date().toISOString();
      });
    job.promise.catch(() => undefined);
    return job;
  }

  get(id: string): ManagedAgent | null {
    return this.jobs.get(id) ?? null;
  }

  status(): ManagedAgentView[] {
    return [...this.jobs.values()].map((job) => ({
      id: job.id,
      type: job.type,
      title: job.title,
      status: job.status,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      summary: job.result?.content.slice(0, 2_000) ?? null,
      error: job.error
    }));
  }

  async wait(id: string, timeoutMs = 300_000): Promise<ManagedAgentView> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`没有找到子代理：${id}`);
    if (job.promise) {
      if (timeoutMs <= 0) {
        await job.promise;
      } else {
        await Promise.race([job.promise, new Promise((resolvePromise) => setTimeout(resolvePromise, timeoutMs))]);
      }
    }
    return this.status().find((item) => item.id === id)!;
  }

  kill(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return false;
    job.controller.abort();
    job.status = "cancelled";
    job.endedAt = new Date().toISOString();
    return true;
  }

  cancelAll(): void {
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      job.controller.abort();
      job.status = "cancelled";
      job.endedAt = new Date().toISOString();
    }
  }
}

export function createAgentLifecycleTools(manager: SubagentTaskManager): AgentTool[] {
  return [
    {
      definition: {
        name: "agent_status",
        description: "List child agents started in this run with their status and summary.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      },
      async execute(): Promise<AgentToolResult> {
        const agents = manager.status();
        return { content: agents.length === 0 ? "没有子代理" : agents.map(formatAgent).join("\n") };
      }
    },
    {
      definition: {
        name: "agent_wait",
        description: "Wait for a child agent to finish and return its summary.",
        parameters: {
          type: "object",
          properties: {
            agent_id: { type: "string", description: "ID returned by agent" },
            timeout_seconds: { type: "number", description: "Maximum wait in seconds, default 300" }
          },
          required: ["agent_id"],
          additionalProperties: false
        }
      },
      async execute(input): Promise<AgentToolResult> {
        const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
        const id = typeof args.agent_id === "string" ? args.agent_id : "";
        if (!id) throw new Error("请提供 agent_id");
        const timeout = Math.min(600, Math.max(1, Number(args.timeout_seconds) || 300));
        const view = await manager.wait(id, timeout * 1_000);
        return { content: formatAgent(view) };
      }
    },
    {
      definition: {
        name: "agent_kill",
        description: "Cancel a running child agent. Completed agents are unaffected.",
        parameters: {
          type: "object",
          properties: { agent_id: { type: "string", description: "ID returned by agent" } },
          required: ["agent_id"],
          additionalProperties: false
        }
      },
      async execute(input): Promise<AgentToolResult> {
        const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
        const id = typeof args.agent_id === "string" ? args.agent_id : "";
        if (!id) throw new Error("请提供 agent_id");
        return { content: manager.kill(id) ? `已取消 ${id}` : `没有可取消的运行中子代理：${id}` };
      }
    }
  ];
}

function formatAgent(agent: ManagedAgentView): string {
  return [
    `agentId: ${agent.id}`,
    `type: ${agent.type}`,
    `status: ${agent.status}`,
    ...(agent.summary ? [`summary: ${agent.summary}`] : []),
    ...(agent.error ? [`error: ${agent.error}`] : [])
  ].join("\n");
}
