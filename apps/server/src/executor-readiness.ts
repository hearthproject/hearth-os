import type { ExecutorHealth, ExecutorId } from "@hearth/core";
import { supportsToolCalling } from "./model-agent.ts";
import { chatModelConfigured, type ModelSettings } from "./model-settings.ts";

const NATIVE_MODEL_ISSUE = "尚未配置聊天模型，原生执行器无法运行任务";
const NATIVE_PROTOCOL_ISSUE = "当前聊天模型协议不支持工具调用，原生执行器无法运行任务";
const CODEX_KEY_ISSUE = "Codex 模型档案缺少 API Key";
const DSH_MODEL_ISSUE = "DeepSeek Harness 还没有绑定模型，请到设置中选择模型档案";
const DSH_FIELDS_ISSUE = "DeepSeek Harness 的模型档案缺少服务地址、模型名或 API Key";
const DSH_PROTOCOL_ISSUE = "DeepSeek Harness 不支持 Gemini 协议";

export interface ExecutorBindingReadiness {
  explicit: boolean;
  available: boolean;
  issue: string | null;
}

export function applyExecutorModelReadiness(
  id: ExecutorId,
  health: ExecutorHealth,
  modelSettings: ModelSettings | null,
  binding?: ExecutorBindingReadiness | null | undefined
): ExecutorHealth {
  if (id === "native") {
    if (modelSettings && !chatModelConfigured(modelSettings)) return markUnavailable(health, NATIVE_MODEL_ISSUE);
    if (modelSettings && !supportsToolCalling(modelSettings.protocol)) return markUnavailable(health, NATIVE_PROTOCOL_ISSUE);
    if (modelSettings) return markReady(health);
    return markUnavailable(health, NATIVE_MODEL_ISSUE);
  }
  if (id === "codex") {
    if (binding?.explicit && !binding.available) {
      return markUnavailable(
        health,
        `Codex 的 Hearth 模型绑定不可用：${binding.issue ?? "请重新选择模型档案"}`,
        "failed"
      );
    }
    if (binding?.explicit && modelSettings) return markReady({ ...health, issues: [] });
    if (!binding?.explicit && !modelSettings) return health;
    if (!modelSettings) return markUnavailable(health, CODEX_KEY_ISSUE);
    if (modelSettings.apiKey) {
      return markReady({ ...health, issues: [] });
    }
    return markUnavailable(health, CODEX_KEY_ISSUE);
  }
  if (id === "deepseek-harness") {
    if (!modelSettings) return markUnavailable(health, DSH_MODEL_ISSUE);
    if (!modelSettings.baseUrl || !modelSettings.model || !modelSettings.apiKey) {
      return markUnavailable(health, DSH_FIELDS_ISSUE);
    }
    if (modelSettings.protocol === "gemini") return markUnavailable(health, DSH_PROTOCOL_ISSUE);
    return markReady(health);
  }
  return health;
}

function markReady(health: ExecutorHealth): ExecutorHealth {
  return { ...health, canRun: true, state: "ready", installState: "available" };
}

export function markExecutorUnavailable(
  health: ExecutorHealth,
  issue: string,
  state: ExecutorHealth["state"] = "unconfigured"
): ExecutorHealth {
  return {
    ...health,
    canRun: false,
    state,
    issues: health.issues.includes(issue) ? health.issues : [...health.issues, issue],
    installState: "needs_repair"
  };
}

const markUnavailable = markExecutorUnavailable;
