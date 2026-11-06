import type { ExecutorId, TaskRecord } from "@hearth/core";

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
