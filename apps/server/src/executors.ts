import type { ExecutorId, TaskRecord } from "@hearth/core";
import type { ExecutionCapability } from "./chat.ts";

export interface ExecutorDescriptor {
  id: ExecutorId;
  name: string;
  description: string;
  capabilities: string[];
}

export const EXECUTORS: ExecutorDescriptor[] = [
  {
    id: "native",
    name: "Hearth 原生执行器",
    description: "使用当前配置的模型和任务授权工具直接完成工作，适合文档、分析、整理和网页任务。",
    capabilities: ["文件", "搜索", "网页", "通用交付"]
  },
  {
    id: "codex",
    name: "Codex 执行器",
    description: "在隔离仓库中改代码、运行测试和构建，适合工程任务。",
    capabilities: ["代码", "仓库", "测试", "GitHub"]
  },
  {
    id: "hermes",
    name: "Hermes 执行器",
    description: "通过本机 Hermes CLI 执行通用代理任务，适合多步研究、工具调用和自动化流程。",
    capabilities: ["通用代理", "工具调用", "多步任务", "流式执行"]
  }
];

export function resolveExecutorId(task: TaskRecord): ExecutorId {
  if (task.executorId) return task.executorId;
  if (task.templateId) return "codex";
  return "native";
}

export function executorName(id: ExecutorId): string {
  return EXECUTORS.find((executor) => executor.id === id)?.name ?? id;
}

const CAPABILITY_SUPPORT: Record<ExecutionCapability, ExecutorId[]> = {
  github: ["codex", "hermes"],
  "desktop-capture": ["native"]
};

export function executorSupportsCapability(id: ExecutorId, capability?: ExecutionCapability): boolean {
  return !capability || CAPABILITY_SUPPORT[capability].includes(id);
}

function capabilityLabel(capability: ExecutionCapability): string {
  return capability === "github" ? "GitHub 仓库任务" : "桌面截图任务";
}

export function resolveExecutorFromEnabled(
  preferred: ExecutorId,
  enabled: Record<ExecutorId, boolean>,
  available: Record<ExecutorId, boolean> = { native: true, codex: true, hermes: true },
  capability?: ExecutionCapability
): { executorId: ExecutorId | null; reroutedFrom: ExecutorId | null; reason: string | null } {
  if (enabled[preferred] && available[preferred] && executorSupportsCapability(preferred, capability)) {
    return { executorId: preferred, reroutedFrom: null, reason: null };
  }
  for (const candidate of ["native", "codex", "hermes"] as const) {
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
