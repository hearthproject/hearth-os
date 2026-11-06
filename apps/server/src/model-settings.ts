import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelProviderPreset, ModelSettingsView } from "@hearth/core";

export interface ModelSettings {
  providerId: string;
  providerName: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  updatedAt: string | null;
}

export const MODEL_PRESETS: ModelProviderPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    note: "使用 DeepSeek 开放平台的 API Key。"
  },
  {
    id: "dashscope",
    name: "阿里云百炼",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen3-max", "qwen-plus", "qwen-turbo", "qwen-vl-max"],
    note: "使用阿里云百炼的 DashScope API Key，模型名以控制台为准。"
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.5", "glm-4.5-air", "glm-4-plus"],
    note: "使用智谱开放平台的 API Key。"
  },
  {
    id: "moonshot",
    name: "月之暗面 Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-k2-0905-preview", "moonshot-v1-32k", "moonshot-v1-8k"],
    note: "使用 Moonshot 开放平台的 API Key。"
  },
  {
    id: "volcengine",
    name: "火山方舟",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: [],
    note: "模型一栏填写方舟控制台里的推理接入点 ID（ep-...）。"
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: ["deepseek-ai/DeepSeek-V3.2-Exp", "Qwen/Qwen3-235B-A22B-Instruct-2507"],
    note: "使用 SiliconFlow 的 API Key，模型名以控制台为准。"
  },
  {
    id: "custom",
    name: "自定义 OpenAI 兼容服务",
    baseUrl: "",
    models: [],
    note: "填写完整的 OpenAI 兼容 Base URL，通常以 /v1 结尾。"
  }
];

const EMPTY: ModelSettings = {
  providerId: "custom",
  providerName: "自定义 OpenAI 兼容服务",
  baseUrl: "",
  model: "",
  apiKey: "",
  updatedAt: null
};

export function loadModelSettings(path: string): ModelSettings {
  if (!existsSync(path)) return { ...EMPTY };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ModelSettings>;
    return {
      providerId: text(parsed.providerId, EMPTY.providerId),
      providerName: text(parsed.providerName, EMPTY.providerName),
      baseUrl: text(parsed.baseUrl, ""),
      model: text(parsed.model, ""),
      apiKey: text(parsed.apiKey, ""),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null
    };
  } catch {
    return { ...EMPTY };
  }
}

export type ModelSettingsPatch = {
  providerId?: string | undefined;
  providerName?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  apiKey?: string | undefined;
};

export function saveModelSettings(path: string, patch: ModelSettingsPatch): ModelSettings {
  const current = loadModelSettings(path);
  const next: ModelSettings = {
    providerId: patch.providerId !== undefined ? patch.providerId.trim() : current.providerId,
    providerName: patch.providerName !== undefined ? patch.providerName.trim() : current.providerName,
    baseUrl: patch.baseUrl !== undefined ? normalizeBaseUrl(patch.baseUrl) : current.baseUrl,
    model: patch.model !== undefined ? patch.model.trim() : current.model,
    apiKey: patch.apiKey !== undefined ? patch.apiKey.trim() : current.apiKey,
    updatedAt: new Date().toISOString()
  };
  if (!next.providerName) next.providerName = presetName(next.providerId) ?? "自定义服务";
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows does not enforce POSIX modes.
  }
  return next;
}

export function viewModelSettings(settings: ModelSettings): ModelSettingsView {
  return {
    providerId: settings.providerId,
    providerName: settings.providerName,
    baseUrl: settings.baseUrl,
    model: settings.model,
    hasApiKey: settings.apiKey.length > 0,
    apiKeyMasked: maskKey(settings.apiKey),
    updatedAt: settings.updatedAt
  };
}

export function chatModelConfigured(settings: ModelSettings): boolean {
  return Boolean(settings.baseUrl && settings.model && settings.apiKey);
}

export function presetFor(id: string): ModelProviderPreset | undefined {
  return MODEL_PRESETS.find((preset) => preset.id === id);
}

export function presetName(id: string): string | undefined {
  return presetFor(id)?.name;
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function maskKey(key: string): string | null {
  if (!key) return null;
  if (key.length <= 8) return "********";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
