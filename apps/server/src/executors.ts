import { EXECUTOR_IDS, type ExecutorId, type ExecutorTier, type TaskRecord } from "@hearth/core";
import type { ExecutionCapability } from "./chat.ts";

export interface ExecutorDescriptor {
  id: ExecutorId;
  name: string;
  description: string;
  capabilities: string[];
  tier: ExecutorTier;
  provider?: string;
  experimental?: boolean;
  supportsResume?: boolean;
}

export const EXECUTORS: ExecutorDescriptor[] = [
  {
    id: "native",
    name: "Hearth 原生执行器",
    description: "使用当前配置的模型和任务授权工具直接完成工作，适合文档、分析、整理和网页任务。",
    capabilities: ["文件", "搜索", "网页", "通用交付"],
    tier: "first-class"
  },
  {
    id: "codex",
    name: "Codex 执行器",
    description: "在隔离仓库中改代码、运行测试和构建，适合工程任务。",
    capabilities: ["代码", "仓库", "测试", "GitHub"],
    tier: "first-class"
  },
  {
    id: "deepseek-harness",
    name: "DeepSeek Harness",
    description: "通过官方 SDK/JSON-RPC 驱动完整 DeepSeek Harness 运行时，支持原生工具、会话恢复和完整事件流。",
    capabilities: ["代码", "仓库", "测试", "工具", "会话恢复", "GitHub"],
    provider: "DeepSeek",
    supportsResume: true,
    tier: "first-class"
  },
  {
    id: "hermes",
    name: "Hermes 执行器",
    description: "通过本机 Hermes CLI 执行通用代理任务，适合多步研究、工具调用和自动化流程。",
    capabilities: ["通用代理", "工具调用", "多步任务", "流式执行", "会话恢复"],
    supportsResume: true,
    tier: "external"
  },
  {
    id: "qoder",
    name: "Qoder",
    description: "Use Qoder's official agent SDK with a local qodercli login for general coding tasks.",
    capabilities: ["Code", "Workspace", "Resume"],
    provider: "Qoder",
    supportsResume: true,
    tier: "external"
  },
  {
    id: "workbuddy",
    name: "WorkBuddy",
    description: "Use the official CodeBuddy CLI that powers WorkBuddy, reusing its local login.",
    capabilities: ["Code", "Workspace", "Resume"],
    provider: "Tencent WorkBuddy",
    supportsResume: true,
    tier: "external"
  },
  {
    id: "kimi",
    name: "Kimi Code",
    description: "Use the official Kimi Code CLI in non-interactive stream-json mode.",
    capabilities: ["Code", "Workspace", "Resume"],
    provider: "Moonshot AI",
    supportsResume: true,
    tier: "external"
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
  github: ["codex", "deepseek-harness", "hermes", "qoder", "workbuddy", "kimi"],
  "desktop-capture": ["native"]
};

export const EXECUTOR_FALLBACK_ORDER: ExecutorId[] = [
  "deepseek-harness",
  "codex",
  "native",
  "hermes",
  "qoder",
  "workbuddy",
  "kimi"
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

function defaultExecutorAvailability(): Record<ExecutorId, boolean> {
  const available = {} as Record<ExecutorId, boolean>;
  for (const id of EXECUTOR_IDS) available[id] = id === "native";
  return available;
}
