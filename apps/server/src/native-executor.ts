import type { RunBudget, RunUsage, TaskPermissions, TaskRecord } from "@hearth/core";
import {
  createBuiltinTools,
  defaultTaskPermissions,
  runAgent,
  zeroUsage,
  type AgentCheckpoint,
  type AgentMessage,
  type AgentModel,
  type AgentResumeState,
  type AgentRunResult
} from "@hearth/agent-runtime";
import { supportsToolCalling, streamAgentTurn } from "./model-agent.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { PreparedWorkspace } from "./workspace.ts";

export const DEFAULT_RUN_BUDGET: RunBudget = {
  maxTurns: 12,
  maxToolCalls: 40,
  maxTokens: 200_000,
  maxDurationMs: 15 * 60_000
};

export interface NativeRunOptions {
  task: TaskRecord;
  prepared: PreparedWorkspace;
  settings: ModelSettings;
  prompt: string;
  permissions?: TaskPermissions;
  budget?: RunBudget;
  signal: AbortSignal;
  resume?: AgentResumeState;
  expectedOutputs: string[];
  onProgress?: (event: { kind: string; message: string }) => void;
  onCheckpoint?: (checkpoint: AgentCheckpoint) => void | Promise<void>;
}

export interface NativeRunResult {
  status: AgentRunResult["status"];
  finalResponse: string;
  usage: RunUsage;
  turns: number;
  toolCalls: number;
  question: string | null;
  outputs: string[];
  messages?: AgentMessage[];
}

export async function runNativeTask(options: NativeRunOptions): Promise<NativeRunResult> {
  if (!supportsToolCalling(options.settings.protocol)) {
    throw new Error(`当前模型协议不支持工具调用：${options.settings.protocol}`);
  }
  const permissions = options.permissions ?? defaultTaskPermissions({
    workspaceRoot: options.prepared.root,
    outDir: options.prepared.outDir,
    networkHosts: options.task.networkHosts,
    ...(options.task.taskKind === "workspace" ? { writeRoots: [options.prepared.outDir, options.prepared.root], extraTools: ["shell"] } : {})
  });
  const result = await runAgent({
    model: modelAdapter(options.settings),
    tools: createBuiltinTools(),
    goal: options.prompt,
    systemPrompt: nativeSystemPrompt(options.task, options.expectedOutputs),
    budget: options.budget ?? DEFAULT_RUN_BUDGET,
    permissions,
    workspaceRoot: options.prepared.root,
    outDir: options.prepared.outDir,
    signal: options.signal,
    ...(options.resume ? { resume: options.resume } : {}),
    onEvent: (event) => {
      if (event.type === "tool.started") {
        options.onProgress?.({ kind: "tool", message: describeToolStart(event.call.name, event.call.arguments) });
      } else if (event.type === "tool.finished" && event.result.isError) {
        options.onProgress?.({ kind: "tool", message: `有一项操作没有完成，正在调整` });
      } else if (event.type === "compacted") {
        options.onProgress?.({ kind: "context", message: "整理执行上下文，继续推进" });
      } else if (event.type === "budget.exceeded") {
        options.onProgress?.({ kind: "budget", message: "达到本轮执行预算，正在收尾" });
      }
    },
    ...(options.onCheckpoint ? { onCheckpoint: options.onCheckpoint } : {})
  });

  return {
    status: result.status,
    finalResponse: result.summary,
    usage: result.usage ?? zeroUsage(),
    turns: result.turns,
    toolCalls: result.toolCalls,
    question: result.question,
    outputs: result.outputs,
    messages: result.messages
  };
}

export function nativePermissionsFor(task: TaskRecord, prepared: PreparedWorkspace): TaskPermissions {
  if (task.permissions) {
    return {
      ...task.permissions,
      readRoots: [prepared.root],
      writeRoots: task.taskKind === "workspace" ? [prepared.outDir, prepared.root] : [prepared.outDir],
      networkHosts: [...task.networkHosts]
    };
  }
  return defaultTaskPermissions({
    workspaceRoot: prepared.root,
    outDir: prepared.outDir,
    networkHosts: task.networkHosts,
    ...(task.taskKind === "workspace" ? { writeRoots: [prepared.outDir, prepared.root], extraTools: ["shell"] } : {})
  });
}

function modelAdapter(settings: ModelSettings): AgentModel {
  return async (messages: AgentMessage[], tools, onDelta, signal) => {
    const result = await streamAgentTurn(settings, messages, tools, onDelta, {
      signal,
      temperature: 0.2,
      maxTokens: 8_000,
      timeoutMs: 180_000
    });
    return {
      content: result.content,
      toolCalls: result.toolCalls,
      usage: result.usage,
      finishReason: result.finishReason
    };
  };
}

function nativeSystemPrompt(task: TaskRecord, expectedOutputs: string[]): string {
  return [
    "你是 Hearth 的原生 Agent 执行器，在自己的工作区里独立完成用户任务。",
    "你必须通过工具真正完成工作，不能只描述步骤或假装已经完成。",
    "可用的工具遵循最小权限：只能访问任务授权的目录和域名；没有授权就明确说明限制。",
    "先用 list_files、read_file、search_text 了解已有资料，再生成结果。",
    "用户需要的最终产物必须写入输出目录；不要生成中间 JSON、命令日志或调试文件作为交付物。",
    "任务完成后必须调用 finish_task，用中文简洁总结完成结果；如果确实缺少关键输入，才调用 ask_user。",
    "回答使用简体中文，不要编造没有依据的事实。",
    `当前任务：${task.title}`,
    `期望产物：${expectedOutputs.join("、")}`
  ].join("\n");
}

function describeToolStart(name: string, args: unknown): string {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const path = typeof record.path === "string" ? record.path : "";
  if (name === "read_file") return path ? `查看资料：${shortPath(path)}` : "查看资料";
  if (name === "list_files") return "了解工作区结构";
  if (name === "search_text") {
    const query = typeof record.query === "string" ? record.query : "";
    return query ? `查找：${query.slice(0, 40)}` : "查找相关资料";
  }
  if (name === "write_file" || name === "edit_file" || name === "apply_patch") return path ? `写入产物：${shortPath(path)}` : "写入产物";
  if (name === "fetch_url") return "读取网页资料";
  if (name === "shell") return "运行检查命令";
  if (name === "ask_user") return "需要你补充信息";
  if (name === "finish_task") return "整理最终结果";
  return "执行一步工作";
}

function shortPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}
