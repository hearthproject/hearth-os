import type { ExecutorHealth, ExecutorId } from "@hearth/core";
import { chatModelConfigured, type ModelSettings } from "./model-settings.ts";

const NATIVE_MODEL_ISSUE = "尚未配置聊天模型，原生执行器无法运行任务";
const CODEX_KEY_ISSUE = "Codex 模型档案缺少 API Key";
const DSH_MODEL_ISSUE = "DeepSeek Harness 还没有绑定模型，请到设置中选择模型档案";
const DSH_FIELDS_ISSUE = "DeepSeek Harness 的模型档案缺少服务地址、模型名或 API Key";
const DSH_PROTOCOL_ISSUE = "DeepSeek Harness 不支持 Gemini 协议";

export function applyExecutorModelReadiness(
  id: ExecutorId,
  health: ExecutorHealth,
  modelSettings: ModelSettings | null
): ExecutorHealth {
  if (id === "native") {
    if (modelSettings && chatModelConfigured(modelSettings)) return health;
    return markUnavailable(health, NATIVE_MODEL_ISSUE);
  }
  if (id === "codex") {
    if (!modelSettings) return health;
    if (modelSettings.apiKey) {
      return { ...health, canRun: true, issues: [], installState: "available" };
    }
    return markUnavailable(health, CODEX_KEY_ISSUE);
  }
  if (id === "deepseek-harness") {
    if (!modelSettings) return markUnavailable(health, DSH_MODEL_ISSUE);
    if (!modelSettings.baseUrl || !modelSettings.model || !modelSettings.apiKey) {
      return markUnavailable(health, DSH_FIELDS_ISSUE);
    }
    if (modelSettings.protocol === "gemini") return markUnavailable(health, DSH_PROTOCOL_ISSUE);
    return health;
  }
  return health;
}

function markUnavailable(health: ExecutorHealth, issue: string): ExecutorHealth {
  return {
    ...health,
    canRun: false,
    issues: health.issues.includes(issue) ? health.issues : [...health.issues, issue],
    installState: "needs_repair"
  };
}