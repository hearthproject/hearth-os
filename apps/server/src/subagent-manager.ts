import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage, AgentTool, AgentToolResult, HarnessMode } from "@hearth/agent-runtime";
import type { RunBudget, TaskPermissions, TaskRecord, TaskWorktree } from "@hearth/core";

export type ManagedAgentStatus = "running" | "completed" | "failed" | "cancelled" | "lost";

export interface ManagedAgentSession {
  childId: string;
  childTitle: string;
  type: string;
  objective: string;
  childTask: TaskRecord;
  prepared: { root: string; outDir: string };
  permissions: TaskPermissions;
  budget: RunBudget;
  mode: HarnessMode;
  prompt: string;
  checkpointPath: string;
  journalPath: string;
  transcriptPath: string;
  outputSchema?: Record<string, unknown> | undefined;
  worktree?: TaskWorktree | undefined;
}

export type ManagedAgentResumeHandler = (job: ManagedAgent, message: string, signal: AbortSignal) => Promise<AgentToolResult>;

export interface ManagedAgent {
  id: string;
  type: string;
  title: string;
  status: ManagedAgentStatus;
  startedAt: string;
  endedAt: string | null;
  lastProgressAt: string;
  transcriptPath: string | null;
  sessionId: string;
  controller: AbortController;
  promise: Promise<AgentToolResult> | null;
  result: AgentToolResult | null;
  error: string | null;
  resume?: ((message: string, signal: AbortSignal) => Promise<AgentToolResult>) | undefined;
  session?: ManagedAgentSession | undefined;
  checkpointPath?: string | undefined;
  journalPath?: string | undefined;
  stallNotices?: Set<number> | undefined;
}

export interface ManagedAgentView {
  id: string;
  type: string;
  title: string;
  status: ManagedAgentStatus;
  startedAt: string;
  endedAt: string | null;
  lastProgressAt: string;
  summary: string | null;
  error: string | null;
}

const STALL_THRESHOLDS_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000, 4 * 60 * 60_000];

export class SubagentTaskManager {
  private readonly jobs = new Map<string, ManagedAgent>();
  private readonly notifications: AgentMessage[] = [];
  private readonly sessionPath: string | null;
  private resumeHandler: ManagedAgentResumeHandler | null = null;

  constructor(private readonly maxConcurrent = 4, sessionPath: string | null = null, private readonly maxTotal = 8) {
    this.sessionPath = sessionPath;
    this.load();
  }

  setResumeHandler(handler: ManagedAgentResumeHandler | null): void {
    this.resumeHandler = handler;
  }

  takeNotifications(): AgentMessage[] {
    return this.notifications.splice(0, this.notifications.length);
  }

  start(
    input: {
      id: string;
      type: string;
      title: string;
      transcriptPath?: string | null;
      session?: ManagedAgentSession;
      checkpointPath?: string;
      journalPath?: string;
    },
    run: (signal: AbortSignal) => Promise<AgentToolResult>,
    resume?: (message: string, signal: AbortSignal) => Promise<AgentToolResult>
  ): ManagedAgent {
    const running = [...this.jobs.values()].filter((job) => job.status === "running").length;
    if (running >= this.maxConcurrent) throw new Error(`同时最多运行 ${this.maxConcurrent} 个子代理`);
    if (this.jobs.size >= this.maxTotal) throw new Error(`子代理总数最多 ${this.maxTotal} 个`);
    const id = input.id;
    if (this.jobs.has(id)) throw new Error(`子代理 ID 已存在：${id}`);
    const now = new Date().toISOString();
    const job: ManagedAgent = {
      id,
      type: input.type,
      title: input.title,
      status: "running",
      startedAt: now,
      endedAt: null,
      lastProgressAt: now,
      transcriptPath: input.transcriptPath ?? null,
      sessionId: id,
      controller: new AbortController(),
      promise: null,
      result: null,
      error: null,
      ...(resume ? { resume } : {}),
      ...(input.session ? { session: input.session } : {}),
      ...(input.checkpointPath ? { checkpointPath: input.checkpointPath } : {}),
      ...(input.journalPath ? { journalPath: input.journalPath } : {}),
      stallNotices: new Set()
    };
    this.jobs.set(id, job);
    job.promise = this.attach(job, run(job.controller.signal));
    job.promise.catch(() => undefined);
    this.persist();
    return job;
  }

  progress(id: string): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return;
    job.lastProgressAt = new Date().toISOString();
    this.persist();
  }

  sendMessage(id: string, text: string, requireResumable = true): ManagedAgentView | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === "running") throw new Error(`子代理仍在运行，不能追加消息：${id}`);
    if (!job.resume && job.session && this.resumeHandler) {
      job.resume = (message, signal) => this.resumeHandler!(job, message, signal);
    }
    if (!job.resume) throw new Error(requireResumable ? `子代理没有可恢复的会话：${id}` : `子代理无法恢复：${id}`);
    const now = new Date().toISOString();
    job.controller = new AbortController();
    job.status = "running";
    job.endedAt = null;
    job.lastProgressAt = now;
    job.error = null;
    job.result = null;
    job.stallNotices = new Set();
    job.promise = this.attach(job, job.resume(text, job.controller.signal));
    job.promise.catch(() => undefined);
    this.persist();
    return this.status().find((item) => item.id === id) ?? null;
  }

  stallNotices(now = Date.now()): AgentMessage[] {
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      const elapsed = now - Date.parse(job.lastProgressAt);
      for (const threshold of STALL_THRESHOLDS_MS) {
        if (elapsed < threshold || job.stallNotices?.has(threshold)) continue;
        job.stallNotices?.add(threshold);
        this.notifications.push({
          role: "user",
          content: `<subagent_notification>\nagentId: ${job.id}\ntype: ${job.type}\nstatus: running\nstall: ${Math.round(elapsed / 60_000)} minutes without progress\nsummary: 子代理可能停滞；可用 agent_status 检查，或 agent_kill 后通过 sendMessage 续跑。\n</subagent_notification>`
        });
      }
    }
    return this.takeNotifications();
  }

  private attach(job: ManagedAgent, promise: Promise<AgentToolResult>): Promise<AgentToolResult> {
    return promise
      .then((result) => {
        job.result = result;
        job.status = job.controller.signal.aborted ? "cancelled" : "completed";
        job.lastProgressAt = new Date().toISOString();
        this.notify(job);
        return result;
      })
      .catch((error) => {
        job.error = error instanceof Error ? error.message : String(error);
        job.status = job.controller.signal.aborted ? "cancelled" : "failed";
        job.lastProgressAt = new Date().toISOString();
        this.notify(job);
        throw error;
      })
      .finally(() => {
        job.endedAt = new Date().toISOString();
        this.persist();
      });
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
      lastProgressAt: job.lastProgressAt,
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
    job.lastProgressAt = job.endedAt;
    this.persist();
    return true;
  }

  cancelAll(): void {
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      job.controller.abort();
      job.status = "cancelled";
      job.endedAt = new Date().toISOString();
      job.lastProgressAt = job.endedAt;
    }
    this.persist();
  }

  private persist(): void {
    if (!this.sessionPath) return;
    try {
      mkdirSync(dirname(this.sessionPath), { recursive: true });
      const sessions = [...this.jobs.values()].map((job) => ({
        id: job.id,
        type: job.type,
        title: job.title,
        status: job.status,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        lastProgressAt: job.lastProgressAt,
        transcriptPath: job.transcriptPath,
        sessionId: job.sessionId,
        error: job.error,
        ...(job.session ? { session: job.session } : {}),
        ...(job.checkpointPath ? { checkpointPath: job.checkpointPath } : {}),
        ...(job.journalPath ? { journalPath: job.journalPath } : {})
      }));
      const temp = `${this.sessionPath}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ sessions }, null, 2)}\n`, "utf8");
      renameSync(temp, this.sessionPath);
    } catch {
      // Session persistence is best-effort; an in-memory job still works.
    }
  }

  private load(): void {
    if (!this.sessionPath || !existsSync(this.sessionPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.sessionPath, "utf8")) as { sessions?: Array<Partial<ManagedAgent>> };
      for (const entry of Array.isArray(parsed.sessions) ? parsed.sessions : []) {
        if (!entry || typeof entry.id !== "string") continue;
        const status = entry.status === "running" ? "lost" : entry.status;
        const session = isValidSession(entry.session) ? entry.session : undefined;
        const job: ManagedAgent = {
          id: entry.id,
          type: typeof entry.type === "string" ? entry.type : "general-purpose",
          title: typeof entry.title === "string" ? entry.title : entry.id,
          status: status === "completed" || status === "failed" || status === "cancelled" || status === "lost" ? status : "lost",
          startedAt: typeof entry.startedAt === "string" ? entry.startedAt : new Date().toISOString(),
          endedAt: typeof entry.endedAt === "string" ? entry.endedAt : new Date().toISOString(),
          lastProgressAt: typeof entry.lastProgressAt === "string" ? entry.lastProgressAt : new Date().toISOString(),
          transcriptPath: typeof entry.transcriptPath === "string" ? entry.transcriptPath : null,
          sessionId: typeof entry.sessionId === "string" ? entry.sessionId : entry.id,
          controller: new AbortController(),
          promise: null,
          result: null,
          error: typeof entry.error === "string" ? entry.error : "服务重启后子代理会话已丢失",
          ...(session ? { session } : {}),
          ...(typeof entry.checkpointPath === "string" ? { checkpointPath: entry.checkpointPath } : {}),
          ...(typeof entry.journalPath === "string" ? { journalPath: entry.journalPath } : {}),
          stallNotices: new Set()
        };
        this.jobs.set(job.id, job);
      }
    } catch {
      // Corrupt session files fall back to an empty in-memory manager.
    }
  }

  private notify(job: ManagedAgent): void {
    if (job.status === "running") return;
    const summary = job.result?.content.slice(0, 2_000) ?? job.error ?? "(no summary)";
    this.notifications.push({
      role: "user",
      content: `<subagent_notification>\nagentId: ${job.id}\ntype: ${job.type}\nstatus: ${job.status}\nsummary: ${summary}\n</subagent_notification>`
    });
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
        return { content: formatAgent(view), metadata: { jobId: view.id, jobKind: "subagent", jobStatus: view.status } };
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
    },
    {
      definition: {
        name: "agent_cancel",
        description: "Alias for agent_kill: cancel a running child agent.",
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
    },
    {
      definition: {
        name: "agent_resume",
        description: "Resume a child agent after a service restart or interruption, using its persisted checkpoint and session metadata. Optional instruction continues the original objective.",
        parameters: {
          type: "object",
          properties: {
            agent_id: { type: "string", description: "ID returned by agent, or listed by agent_status" },
            instruction: { type: "string", description: "Optional follow-up instruction; defaults to continuing the original task" }
          },
          required: ["agent_id"],
          additionalProperties: false
        }
      },
      async execute(input): Promise<AgentToolResult> {
        const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
        const id = typeof args.agent_id === "string" ? args.agent_id : "";
        if (!id) throw new Error("请提供 agent_id");
        const instruction = typeof args.instruction === "string" && args.instruction.trim()
          ? args.instruction.trim()
          : "继续完成原任务；已有检查点记录了此前的进度，不要重复已经完成的工作。";
        return { content: formatAgent(manager.sendMessage(id, instruction)!) };
      }
    },
    {
      definition: {
        name: "agent_send",
        description: "Send a follow-up message to a completed or lost child agent and resume it.",
        parameters: {
          type: "object",
          properties: {
            agent_id: { type: "string", description: "ID returned by agent" },
            message: { type: "string", description: "Follow-up instruction for the child" }
          },
          required: ["agent_id", "message"],
          additionalProperties: false
        }
      },
      async execute(input): Promise<AgentToolResult> {
        const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
        const id = typeof args.agent_id === "string" ? args.agent_id : "";
        const message = typeof args.message === "string" ? args.message.trim() : "";
        if (!id || !message) throw new Error("请提供 agent_id 和 message");
        return { content: formatAgent(manager.sendMessage(id, message)!) };
      }
    }
  ];
}

function isValidSession(value: unknown): value is ManagedAgentSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<ManagedAgentSession>;
  return typeof session.childId === "string"
    && typeof session.objective === "string"
    && typeof session.prompt === "string"
    && typeof session.checkpointPath === "string"
    && typeof session.journalPath === "string"
    && Boolean(session.childTask && typeof session.childTask === "object")
    && Boolean(session.prepared && typeof session.prepared.root === "string" && typeof session.prepared.outDir === "string")
    && Boolean(session.permissions && Array.isArray(session.permissions.tools));
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
