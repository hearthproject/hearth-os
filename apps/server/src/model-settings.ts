import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelProtocol, ModelProviderPreset, ModelSettingsView } from "@hearth/core";

export interface ModelSettings {
  providerId: string;
  providerName: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  apiKey: string;
  updatedAt: string | null;
}

const PROTOCOLS: ModelProtocol[] = ["openai-chat", "openai-responses", "anthropic-messages", "gemini"];

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_000;

export const MODEL_PRESETS: ModelProviderPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-chat",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-flash", "deepseek-v4-pro"],
    note: "DeepSeek 官方 API，模型可点击获取按钮拉取。"
  },
  {
    id: "dashscope",
    name: "阿里云百炼",
    protocol: "openai-chat",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [],
    note: "阿里云百炼 OpenAI 兼容接口，模型名以控制台为准。"
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    protocol: "openai-chat",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: [],
    note: "智谱开放平台 OpenAI 兼容接口。"
  },
  {
    id: "moonshot",
    name: "月之暗面 Kimi",
    protocol: "openai-chat",
    baseUrl: "https://api.moonshot.cn/v1",
    models: [],
    note: "Moonshot 开放平台 OpenAI 兼容接口。"
  },
  {
    id: "volcengine",
    name: "火山方舟",
    protocol: "openai-chat",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: [],
    note: "模型填写方舟控制台的推理接入点 ID（ep-...）。"
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    models: [],
    note: "OpenAI 官方接口。"
  },
  {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    models: [],
    note: "Claude Messages API。"
  },
  {
    id: "gemini",
    name: "Google Gemini",
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: [],
    note: "Gemini generateContent API。"
  },
  {
    id: "custom",
    name: "自定义服务",
    protocol: "openai-chat",
    baseUrl: "",
    models: [],
    note: "支持 OpenAI、Anthropic、Gemini 协议。"
  }
];

const EMPTY: ModelSettings = {
  providerId: "custom",
  providerName: "自定义服务",
  protocol: "openai-chat",
  baseUrl: "",
  model: "",
  contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  apiKey: "",
  updatedAt: null
};

export function normalizeProtocol(value: unknown): ModelProtocol {
  return typeof value === "string" && (PROTOCOLS as string[]).includes(value) ? value as ModelProtocol : "openai-chat";
}

export function loadModelSettings(path: string): ModelSettings {
  if (!existsSync(path)) return { ...EMPTY };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ModelSettings>;
    return {
      providerId: text(parsed.providerId, EMPTY.providerId),
      providerName: text(parsed.providerName, EMPTY.providerName),
      protocol: normalizeProtocol(parsed.protocol),
      baseUrl: text(parsed.baseUrl, ""),
      model: text(parsed.model, ""),
      contextWindowTokens: tokenLimit(parsed.contextWindowTokens, DEFAULT_CONTEXT_WINDOW_TOKENS, 4_096, 10_000_000),
      maxOutputTokens: tokenLimit(parsed.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 256, 1_000_000),
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
  protocol?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  contextWindowTokens?: number | undefined;
  maxOutputTokens?: number | undefined;
  apiKey?: string | undefined;
};

export function saveModelSettings(path: string, patch: ModelSettingsPatch): ModelSettings {
  const current = loadModelSettings(path);
  const next: ModelSettings = {
    providerId: patch.providerId !== undefined ? patch.providerId.trim() : current.providerId,
    providerName: patch.providerName !== undefined ? patch.providerName.trim() : current.providerName,
    protocol: patch.protocol !== undefined ? normalizeProtocol(patch.protocol) : current.protocol,
    baseUrl: patch.baseUrl !== undefined ? normalizeBaseUrl(patch.baseUrl) : current.baseUrl,
    model: patch.model !== undefined ? patch.model.trim() : current.model,
    contextWindowTokens: patch.contextWindowTokens !== undefined
      ? tokenLimit(patch.contextWindowTokens, current.contextWindowTokens, 4_096, 10_000_000)
      : current.contextWindowTokens,
    maxOutputTokens: patch.maxOutputTokens !== undefined
      ? tokenLimit(patch.maxOutputTokens, current.maxOutputTokens, 256, 1_000_000)
      : current.maxOutputTokens,
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
    protocol: settings.protocol,
    baseUrl: settings.baseUrl,
    model: settings.model,
    contextWindowTokens: settings.contextWindowTokens,
    maxOutputTokens: settings.maxOutputTokens,
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

function tokenLimit(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value)))
    : fallback;
}
