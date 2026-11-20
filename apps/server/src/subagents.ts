import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { RunBudget, TaskPermissions, TaskRecord, TaskWorktree } from "@hearth/core";
import { zeroUsage, agentProfile, finishActiveWork, startActiveWork, type AgentTool, type AgentToolResult, type SubagentType } from "@hearth/agent-runtime";
import { runNativeTask, type NativeRunOptions, type NativeRunResult } from "./native-executor.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { PreparedWorkspace } from "./workspace.ts";
import type { TaskWorktreeService } from "./worktrees.ts";
import type { SubagentTaskManager } from "./subagent-manager.ts";

const MAX_SUBAGENTS = 4;

export type SubagentRunner = (options: NativeRunOptions) => Promise<NativeRunResult>;

export interface SubagentToolOptions {
  task: TaskRecord;
  prepared: PreparedWorkspace;
  settings: ModelSettings;
  permissions: TaskPermissions;
  signal: AbortSignal;
  worktrees: TaskWorktreeService;
  parentWorktree?: TaskWorktree | null;
  runner?: SubagentRunner | undefined;
  budget?: RunBudget | undefined;
  maxSubagents?: number | undefined;
  depth?: number | undefined;
  compatibility?: boolean | undefined;
  manager?: SubagentTaskManager | undefined;
  onStarted?: ((info: { childId: string; mode: "read-only" | "isolated-write"; title: string; type: SubagentType }) => void) | undefined;
}

export function createAgentTool(options: SubagentToolOptions): AgentTool {
  return createDispatchTool(options, false);
}

export function createSubagentTool(options: SubagentToolOptions): AgentTool {
  return createDispatchTool(options, true);
}

function createDispatchTool(options: SubagentToolOptions, compatibility: boolean): AgentTool {
  const runner = options.runner ?? runNativeTask;
  const maxSubagents = Math.max(1, Math.min(MAX_SUBAGENTS, options.maxSubagents ?? MAX_SUBAGENTS));
  const depth = options.depth ?? 0;
  let started = 0;

  return {
    definition: compatibility ? delegationDefinition() : agentDefinition(),
    async execute(input, context): Promise<AgentToolResult> {
      if (depth > 0) throw new Error("子代理不能继续委派，只允许单层委派");
      const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const parsed = compatibility ? parseDelegationArgs(args) : parseAgentArgs(args);
      if (!parsed.objective) throw new Error(compatibility ? "请提供子任务目标" : "请提供 prompt");
      if (parsed.objective.length > 20_000) throw new Error("子任务目标过长");
      const profile = agentProfile(parsed.type);
      if (!profile) throw new Error(`未知子代理类型：${parsed.type}`);
      if (started >= maxSubagents) throw new Error(`每个任务最多启动 ${maxSubagents} 个子代理`);
      if (options.signal.aborted) throw new Error("任务已取消");

      started += 1;
      const childId = subagentTaskId(options.task.id, profile.type);
      const childTitle = parsed.title || `${profile.type} ${started}`;
      if (profile.isolation === "worktree" && !options.task.projectId) throw new Error("general-purpose 子代理只能用于本地项目任务");
      const transcriptPath = join(tmpdir(), "hearth-subagents", options.task.id.replace(/[^A-Za-z0-9._-]/g, "-"), `${childId}.jsonl`);
      appendTranscript(transcriptPath, {
        at: new Date().toISOString(),
        event: "started",
        agentId: childId,
        type: profile.type,
        title: childTitle,
        prompt: parsed.objective
      });

      const runAgentJob = async (signal: AbortSignal, extra?: string): Promise<AgentToolResult> => {
        const objective = extra ? `${parsed.objective}\n\n## Follow-up instruction\n${extra}` : parsed.objective;
        const worktree = profile.isolation === "worktree" ? createChildWorktree(childId, options) : null;
        options.onStarted?.({
          childId,
          mode: profile.isolation === "worktree" ? "isolated-write" : "read-only",
          title: childTitle,
          type: profile.type
        });
        const childRoot = worktree?.path ?? options.prepared.root;
        const childOutDir = worktree ? join(worktree.path, ".hearth", "subagent-out") : options.prepared.outDir;
        const childTask = childTaskRecord({
          id: childId,
          title: childTitle,
          objective,
          task: options.task,
          root: childRoot,
          outDir: childOutDir,
          permissions: profile.isolation === "worktree" ? isolatedWritePermissions(options, childRoot, childOutDir) : readOnlyPermissions(options, profile.tools)
        });
        const narrow = (base: number | undefined, cap: number | undefined): number | undefined =>
          base === undefined ? cap : cap === undefined ? base : Math.min(base, cap);
        const budget = {
          ...profile.budget,
          ...(parsed.maxTurns ? { maxTurns: narrow(profile.budget.maxTurns, parsed.maxTurns) } : {}),
          ...(options.budget?.maxTokens !== undefined
            ? { maxTokens: narrow(profile.budget.maxTokens, options.budget.maxTokens) }
            : {})
        };
        const result = await runner({
          task: childTask,
          prepared: { root: childRoot, outDir: childOutDir, inputs: [] },
          settings: options.settings,
          prompt: agentPrompt(profile.type, objective, options.task, profile.outputContract),
          permissions: childTask.permissions ?? readOnlyPermissions(options, profile.tools),
          budget,
          mode: profile.mode,
          isSubagent: true,
          signal: AbortSignal.any([options.signal, signal]),
          expectedOutputs: [],
          ...(options.manager ? { onProgress: () => options.manager!.progress(childId) } : {})
        });
        if (result.status !== "completed") {
          const details = result.status === "waiting_input"
            ? `需要补充信息：${result.question ?? result.finalResponse}`
            : result.finalResponse || result.status;
          throw new Error(`子代理未完成（${result.status}）：${details}${worktree ? `；已保留 Worktree ${worktree.path}（${worktree.branch}）` : ""}`);
        }

        const usage = result.usage ?? zeroUsage();
        const summary = result.finalResponse || "未返回总结";
        if (!worktree) {
          appendTranscript(transcriptPath, {
            at: new Date().toISOString(),
            event: "completed",
            agentId: childId,
            type: profile.type,
            summary,
            usage,
            messages: result.messages ?? []
          });
          return {
            content: `agentId: ${childId}\nstatus: completed\ntype: ${profile.type}\nsummary: ${summary}\ntranscript: ${transcriptPath}`,
            usage,
            metadata: { agentId: childId, subagentType: profile.type, agentStatus: "completed", transcriptPath }
          };
        }

        const commit = commitChildWorktree(worktree.path, options.task.id, childTitle);
        appendTranscript(transcriptPath, {
          at: new Date().toISOString(),
          event: "completed",
          agentId: childId,
          type: profile.type,
          summary,
          usage,
          branch: worktree.branch,
          commit,
          messages: result.messages ?? []
        });
        return {
          content: [
            `agentId: ${childId}`,
            "status: completed",
            `type: ${profile.type}`,
            `summary: ${summary}`,
            `branch: ${worktree.branch}`,
            `commit: ${commit}`,
            `transcript: ${transcriptPath}`,
            "结果尚未合并。请检查该分支和提交后，由父任务手动 cherry-pick。"
          ].join("\n"),
          usage,
          metadata: { agentId: childId, subagentType: profile.type, agentStatus: "completed", branch: worktree.branch, commitSha: commit, transcriptPath }
        };
      };

      const launch = async (signal: AbortSignal, extra?: string): Promise<AgentToolResult> => {
        startActiveWork(context.state, { id: childId, kind: "subagent", label: childTitle });
        try {
          const result = await runAgentJob(signal, extra);
          finishActiveWork(context.state, childId, "completed");
          return result;
        } catch (error) {
          finishActiveWork(context.state, childId, signal.aborted ? "cancelled" : "failed");
          throw error;
        }
      };

      if (parsed.runInBackground) {
        if (!options.manager) throw new Error("后台子代理需要 manager 支持");
        const job = options.manager.start(
          { id: childId, type: profile.type, title: childTitle, transcriptPath },
          launch,
          (message, signal) => launch(signal, message)
        );
        return {
          content: `agentId: ${job.id}\nstatus: running\ntype: ${profile.type}\ntranscript: ${transcriptPath}\n请用 agent_wait 等待结果，或继续其他工作；agent_status 可查看状态，agent_kill 可取消。`,
          metadata: { agentId: job.id, subagentType: profile.type, agentStatus: "running", transcriptPath }
        };
      }

      return launch(options.signal);
    }
  };
}

function createChildWorktree(childId: string, options: SubagentToolOptions): TaskWorktree {
  if (!options.task.projectId) throw new Error("隔离写子代理只能用于本地项目任务");
  const parent = options.parentWorktree ?? options.worktrees.ensure(options.task);
  const baseSha = gitStdout(parent.path, ["rev-parse", "HEAD"]);
  return options.worktrees.ensure(
    { id: childId, projectId: parent.projectId },
    { baseBranch: parent.branch, baseSha }
  );
}

function childTaskRecord(input: {
  id: string;
  title: string;
  objective: string;
  task: TaskRecord;
  root: string;
  outDir: string;
  permissions: TaskPermissions;
}): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: input.id,
    templateId: null,
    title: input.title,
    goal: input.objective,
    status: "running",
    createdAt: now,
    updatedAt: now,
    deadline: null,
    inputs: [],
    networkHosts: [...input.permissions.networkHosts],
    outputDir: ".hearth/subagent-out",
    currentRunId: null,
    nextAction: null,
    error: null,
    executorId: "native",
    taskKind: "general",
    expectedOutputs: [],
    permissions: input.permissions,
    projectId: input.task.projectId ?? null
  };
}

function agentDefinition(): AgentTool["definition"] {
  return {
    name: "agent",
    description: "Start a typed subagent with its own context. explore/plan/review are read-only; general-purpose writes in an isolated worktree. Subagents cannot delegate further.",
    parameters: {
      type: "object",
      properties: {
        subagent_type: { type: "string", enum: ["explore", "plan", "review", "general-purpose"], description: "explore locates code, plan designs steps, review checks a diff, general-purpose implements in a worktree" },
        description: { type: "string", description: "3-8 word label shown to the parent and UI" },
        prompt: { type: "string", description: "Self-contained task; the child cannot see the parent conversation" },
        run_in_background: { type: "boolean", description: "Return immediately and continue in the background" },
        maxTurns: { type: "number", description: "Optional turn cap for this child, bounded by the profile default" }
      },
      required: ["subagent_type", "description", "prompt"],
      additionalProperties: false
    }
  };
}

function delegationDefinition(): AgentTool["definition"] {
  return {
    name: "delegate_task",
    description: "Compatibility alias for agent. read-only maps to explore; isolated-write maps to general-purpose in a worktree.",
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "子任务目标、边界和期望输出" },
        mode: { type: "string", enum: ["read-only", "isolated-write"], description: "只读，或从父任务当前提交创建独立 Worktree 写入" },
        title: { type: "string", description: "便于识别的子任务名称" }
      },
      required: ["objective", "mode"],
      additionalProperties: false
    }
  };
}

function parseAgentArgs(args: Record<string, unknown>): { type: string; objective: string; title: string; maxTurns?: number; runInBackground?: boolean } {
  const type = typeof args.subagent_type === "string" ? args.subagent_type : "";
  const objective = typeof args.prompt === "string" ? args.prompt.trim() : "";
  const title = typeof args.description === "string" ? args.description.trim().slice(0, 120) : "";
  const maxTurns = Number.isFinite(args.maxTurns) ? Math.max(1, Math.floor(Number(args.maxTurns))) : undefined;
  const runInBackground = args.run_in_background === true;
  return { type, objective, title, ...(maxTurns ? { maxTurns } : {}), ...(runInBackground ? { runInBackground: true } : {}) };
}

function parseDelegationArgs(args: Record<string, unknown>): { type: string; objective: string; title: string; maxTurns?: number; runInBackground?: boolean } {
  const objective = typeof args.objective === "string" ? args.objective.trim() : "";
  const title = typeof args.title === "string" ? args.title.trim().slice(0, 120) : "";
  const mode = args.mode === "isolated-write" ? "general-purpose" : args.mode === "read-only" ? "explore" : "";
  if (!mode) throw new Error("mode 必须是 read-only 或 isolated-write");
  return { type: mode, objective, title };
}

function readOnlyPermissions(options: SubagentToolOptions, allowed: readonly string[]): TaskPermissions {
  const allow = new Set(allowed);
  return {
    readRoots: [options.prepared.root],
    writeRoots: [],
    networkHosts: [...options.permissions.networkHosts],
    tools: [...new Set(["finish_task", ...options.permissions.tools.filter((tool) => allow.has(tool))])]
  };
}

function isolatedWritePermissions(options: SubagentToolOptions, root: string, outDir: string): TaskPermissions {
  const blocked = new Set(["delegate_task", "agent", "agent_wait", "agent_status", "agent_kill"]);
  const tools = options.permissions.tools.filter((tool) => !blocked.has(tool) && !tool.startsWith("mcp__"));
  if (!tools.includes("finish_task")) tools.push("finish_task");
  if (!tools.some((tool) => ["write_file", "write_spreadsheet", "write_document", "edit_file", "apply_patch", "shell"].includes(tool))) {
    throw new Error("父任务没有授予任何写入能力，不能启动隔离写子代理");
  }
  return {
    readRoots: [root],
    writeRoots: [root, outDir],
    networkHosts: [...options.permissions.networkHosts],
    tools: [...new Set(tools)]
  };
}

function agentPrompt(type: string, objective: string, parent: TaskRecord, outputContract: string): string {
  return [
    `你是一个 ${type} 子代理，只负责下面这段子任务。父任务：${parent.title}`,
    `目标：${objective}`,
    `输出契约：${outputContract}`,
    "上下文是隔离的：不要假设父代理知道你的中间过程，结论必须自带文件路径、行号和证据。",
    "不要做超出目标的扩展，不要请求用户确认，不要委派其他子代理。"
  ].join("\n");
}

function appendTranscript(path: string, record: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Transcripts are diagnostic; a read-only outDir must not fail the child.
  }
}

function subagentTaskId(parentId: string, type: string): string {
  const safeParent = parentId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "task";
  const safeType = type.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 16) || "agent";
  return `${safeParent}-${safeType}-${randomUUID().slice(0, 8)}`;
}

function commitChildWorktree(path: string, parentId: string, title: string): string {
  const status = git(path, ["status", "--porcelain"]);
  if (!status.ok) throw new Error(status.stderr.trim() || "无法读取子代理 Worktree 状态");
  if (status.stdout.trim()) {
    const added = git(path, ["add", "-A"]);
    if (!added.ok) throw new Error(added.stderr.trim() || "无法暂存子代理改动");
    const message = `hearth subagent: ${title}\n\nparent: ${parentId}`;
    const committed = git(path, ["-c", "user.name=Hearth Subagent", "-c", "user.email=hearth-subagent@localhost", "commit", "-m", message]);
    if (!committed.ok) throw new Error(committed.stderr.trim() || "无法提交子代理改动");
  }
  return gitStdout(path, ["rev-parse", "HEAD"]);
}

function gitStdout(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  if (!result.ok || !result.stdout.trim()) throw new Error(result.stderr.trim() || `git ${args.join(" ")} 没有返回结果`);
  return result.stdout.trim();
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error) return { ok: false, stdout: "", stderr: result.error.message };
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
