import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { RunBudget, RunUsage, TaskPermissions, TaskRecord, TaskWorktree } from "@hearth/core";
import { zeroUsage, type AgentTool, type AgentToolResult } from "@hearth/agent-runtime";
import { runNativeTask, type NativeRunOptions, type NativeRunResult } from "./native-executor.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { PreparedWorkspace } from "./workspace.ts";
import type { TaskWorktreeService } from "./worktrees.ts";

const MAX_SUBAGENTS = 2;
const READ_ONLY_TOOLS = new Set([
  "read_file",
  "read_document",
  "list_files",
  "search_text",
  "glob",
  "grep",
  "fetch_url",
  "ask_user",
  "finish_task"
]);
const SUBAGENT_BUDGET: RunBudget = {
  maxTurns: 40,
  maxToolCalls: 400,
  maxTokens: 200_000,
  maxDurationMs: 10 * 60_000
};

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
  onStarted?: ((info: { childId: string; mode: "read-only" | "isolated-write"; title: string }) => void) | undefined;
}

export function createSubagentTool(options: SubagentToolOptions): AgentTool {
  const runner = options.runner ?? runNativeTask;
  const maxSubagents = Math.max(1, Math.min(MAX_SUBAGENTS, options.maxSubagents ?? MAX_SUBAGENTS));
  const depth = options.depth ?? 0;
  let started = 0;

  return {
    definition: {
      name: "delegate_task",
      description: "把一段边界清晰的子任务交给独立上下文的子代理。只读模式不能写入；隔离写模式会从父任务当前提交创建独立 Worktree，返回分支与提交，供你检查后手动合并。每次任务最多委派两次，不能嵌套委派，也不会自动合并。",
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
    },
    async execute(input): Promise<AgentToolResult> {
      if (depth > 0) throw new Error("子代理不能继续委派，只允许单层委派");
      const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const objective = typeof args.objective === "string" ? args.objective.trim() : "";
      const mode = args.mode === "isolated-write" ? "isolated-write" : args.mode === "read-only" ? "read-only" : null;
      const title = typeof args.title === "string" ? args.title.trim().slice(0, 120) : "";
      if (!objective) throw new Error("请提供子任务目标");
      if (objective.length > 20_000) throw new Error("子任务目标过长");
      if (!mode) throw new Error("mode 必须是 read-only 或 isolated-write");
      if (started >= maxSubagents) throw new Error(`每个任务最多委派 ${maxSubagents} 个子代理`);
      if (options.signal.aborted) throw new Error("任务已取消");

      started += 1;
      const childId = subagentTaskId(options.task.id);
      const childTitle = title || `子任务 ${started}`;
      const worktree = mode === "isolated-write" ? createChildWorktree(childId, options) : null;
      options.onStarted?.({ childId, mode, title: childTitle });
      const childRoot = worktree?.path ?? options.prepared.root;
      const childOutDir = worktree ? join(worktree.path, ".hearth", "subagent-out") : options.prepared.outDir;
      const childTask = childTaskRecord({
        id: childId,
        title: childTitle,
        objective,
        task: options.task,
        root: childRoot,
        outDir: childOutDir,
        permissions: mode === "read-only" ? readOnlyPermissions(options) : isolatedWritePermissions(options, childRoot, childOutDir)
      });
      const result = await runner({
        task: childTask,
        prepared: { root: childRoot, outDir: childOutDir, inputs: [] },
        settings: options.settings,
        prompt: subagentPrompt(objective, mode, options.task),
        permissions: childTask.permissions ?? readOnlyPermissions(options),
        budget: options.budget ?? SUBAGENT_BUDGET,
        signal: options.signal,
        expectedOutputs: []
      });
      if (result.status !== "completed") {
        const details = result.status === "waiting_input"
          ? `需要补充信息：${result.question ?? result.finalResponse}`
          : result.finalResponse || result.status;
        throw new Error(`子代理未完成（${result.status}）：${details}${worktree ? `；已保留 Worktree ${worktree.path}（${worktree.branch}）` : ""}`);
      }

      const usage = result.usage ?? zeroUsage();
      if (!worktree) {
        return {
          content: `子代理（只读）完成：${result.finalResponse || "未返回总结"}`,
          usage
        };
      }

      const commit = commitChildWorktree(worktree.path, options.task.id, childTitle);
      return {
        content: [
          `子代理（隔离写）完成：${result.finalResponse || "未返回总结"}`,
          `分支：${worktree.branch}`,
          `提交：${commit}`,
          "结果尚未合并。请检查该分支和提交后，由父任务手动 cherry-pick。"
        ].join("\n"),
        usage
      };
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

function readOnlyPermissions(options: SubagentToolOptions): TaskPermissions {
  return {
    readRoots: [options.prepared.root],
    writeRoots: [],
    networkHosts: [...options.permissions.networkHosts],
    tools: [...new Set(["finish_task", ...options.permissions.tools.filter((tool) => READ_ONLY_TOOLS.has(tool))])]
  };
}

function isolatedWritePermissions(options: SubagentToolOptions, root: string, outDir: string): TaskPermissions {
  const tools = options.permissions.tools.filter((tool) => tool !== "delegate_task" && !tool.startsWith("mcp__"));
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

function subagentPrompt(objective: string, mode: "read-only" | "isolated-write", parent: TaskRecord): string {
  return [
    `你是一个独立子代理，只负责下面这段子任务。父任务：${parent.title}`,
    `目标：${objective}`,
    mode === "read-only"
      ? "你处于只读模式：不要尝试写入、删除、移动文件或执行 shell。请调查、分析并返回带证据的结论。"
      : "你处于隔离写模式：只能修改当前 Worktree。完成后必须调用 finish_task；不要尝试合并、推送或操作父工作区。",
    "不要做超出目标的扩展，不要请求用户确认，不要委派其他子代理。"
  ].join("\n");
}

function subagentTaskId(parentId: string): string {
  const safeParent = parentId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "task";
  return `${safeParent}-sub-${randomUUID().slice(0, 8)}`;
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
