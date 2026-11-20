import { EXECUTOR_IDS, type ExecutorId, type TaskRecord } from "@hearth/core";
import type { ExecutionCapability } from "./chat.ts";

export interface ExecutorDescriptor {
  id: ExecutorId;
  name: string;
  description: string;
  capabilities: string[];
  provider?: string;
  experimental?: boolean;
  supportsResume?: boolean;
}

export const EXECUTORS: ExecutorDescriptor[] = [
  {
    id: "native",
    name: "Hearth 原生执行器",
    description: "使用当前配置的模型和任务授权工具直接完成工作；工作区或仓库任务会自动启用编码 profile，支持仓库分析、编辑、测试、计划和验证闭环。",
    capabilities: ["文件", "搜索", "网页", "通用交付", "代码", "仓库", "测试", "计划"]
  },
  {
    id: "codex",
    name: "Codex 执行器",
    description: "在隔离仓库中改代码、运行测试和构建，适合工程任务。",
    capabilities: ["代码", "仓库", "测试", "GitHub"]
  },
  {
    id: "deepseek-harness",
    name: "DeepSeek Harness",
    description: "通过官方 SDK/JSON-RPC 驱动完整 DeepSeek Harness 运行时，支持原生工具、会话恢复和完整事件流。",
    capabilities: ["代码", "仓库", "测试", "工具", "会话恢复", "GitHub"],
    provider: "DeepSeek",
    supportsResume: true
  }
];

export function resolveExecutorId(task: TaskRecord): ExecutorId {
  return task.executorId ?? "native";
}

export function executorName(id: ExecutorId): string {
  return EXECUTORS.find((executor) => executor.id === id)?.name ?? id;
}

const CAPABILITY_SUPPORT: Record<ExecutionCapability, ExecutorId[]> = {
  github: ["native", "codex", "deepseek-harness"],
  "desktop-capture": ["native"]
};

export const EXECUTOR_FALLBACK_ORDER: ExecutorId[] = [
  "deepseek-harness",
  "codex",
  "native"
];

export function executorSupportsCapability(id: ExecutorId, capability?: ExecutionCapability): boolean {
  return !capability || CAPABILITY_SUPPORT[capability].includes(id);
}

function capabilityLabel(capability: ExecutionCapability): string {
  return capability === "github" ? "GitHub 仓库任务" : "桌面截图任务";
}

export function resolveExecutorFromEnabled(
  preferred: ExecutorId,
  enabled: Record<ExecutorId, boolean>,
  available: Record<ExecutorId, boolean> = defaultExecutorAvailability(),
  capability?: ExecutionCapability,
  fallbackOrder: ExecutorId[] = [...EXECUTOR_IDS]
): { executorId: ExecutorId | null; reroutedFrom: ExecutorId | null; reason: string | null } {
  if (enabled[preferred] && available[preferred] && executorSupportsCapability(preferred, capability)) {
    return { executorId: preferred, reroutedFrom: null, reason: null };
  }
  for (const candidate of fallbackOrder) {
    if (candidate === preferred) continue;
    if (enabled[candidate] && available[candidate] && executorSupportsCapability(candidate, capability)) {
      return {
        executorId: candidate,
        reroutedFrom: preferred,
        reason: enabled[preferred] && available[preferred]
          ? `${executorName(preferred)}不支持这项任务所需的能力`
          : enabled[preferred]
            ? `${executorName(preferred)}当前不可用`
            : `${executorName(preferred)}已关闭`
      };
    }
  }
  return {
    executorId: null,
    reroutedFrom: null,
    reason: capability ? `${capabilityLabel(capability)}没有已启用的执行器可用` : null
  };
}

export function resolveExecutorLocked(
  preferred: ExecutorId,
  enabled: Record<ExecutorId, boolean>,
  available: Record<ExecutorId, boolean> = defaultExecutorAvailability(),
  capability?: ExecutionCapability
): { executorId: ExecutorId | null; reroutedFrom: null; reason: string | null } {
  if (!enabled[preferred]) {
    return { executorId: null, reroutedFrom: null, reason: "它已关闭" };
  }
  if (!available[preferred]) {
    return { executorId: null, reroutedFrom: null, reason: "它当前不可用" };
  }
  if (!executorSupportsCapability(preferred, capability)) {
    return { executorId: null, reroutedFrom: null, reason: "它不支持这项任务所需的能力" };
  }
  return { executorId: preferred, reroutedFrom: null, reason: null };
}

function defaultExecutorAvailability(): Record<ExecutorId, boolean> {
  const available = {} as Record<ExecutorId, boolean>;
  for (const id of EXECUTOR_IDS) available[id] = id === "native";
  return available;
}

