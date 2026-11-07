import { mkdirSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type {
  ExecutorId,
  ExecutorModelBinding,
  ExecutorModelBindingPatch,
  ExecutorModelBindingView,
  ModelProfilePatch,
  ModelProfileRecord,
  ModelProfileView,
  ModelProtocol,
  ModelRegistryView
} from "@hearth/core";
import { EXECUTOR_IDS } from "@hearth/core";
import type { CodexProfile } from "@hearth/codex-executor";
import type { HearthStore } from "@hearth/eventlog";
import type { ModelSettings } from "./model-settings.ts";
import { MODEL_PRESETS, normalizeBaseUrl, normalizeProtocol } from "./model-settings.ts";
import type { SecretBox } from "./secrets.ts";

const CHAT_PROFILE_KEY = "model.chatProfileId";
const REGISTRY_UPDATED_KEY = "model.updatedAt";
const ALL_PROTOCOLS: ModelProtocol[] = ["openai-chat", "openai-responses", "anthropic-messages", "gemini"];

export const EXECUTOR_MODEL_PROTOCOLS: Record<ExecutorId, ModelProtocol[]> = {
  native: ALL_PROTOCOLS,
  codex: ["openai-responses"],
  "deepseek-harness": ["openai-chat", "openai-responses", "anthropic-messages"],
  hermes: ["openai-chat", "openai-responses", "anthropic-messages"],
  qoder: ["openai-chat", "openai-responses", "anthropic-messages"],
  workbuddy: ["openai-chat", "openai-responses", "anthropic-messages"],
  kimi: ["openai-chat", "openai-responses", "anthropic-messages"]
};

export class ModelRegistryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ModelRegistryError";
    this.code = code;
  }
}

export interface ModelRegistryOptions {
  store: HearthStore;
  secretBox: SecretBox;
  codexHome: string;
}

export class ModelRegistry {
  private readonly store: HearthStore;
  private readonly secretBox: SecretBox;
  private readonly codexHome: string;

  constructor(options: ModelRegistryOptions) {
    this.store = options.store;
    this.secretBox = options.secretBox;
    this.codexHome = options.codexHome;
  }

  presets() {
    return MODEL_PRESETS;
  }

  view(): ModelRegistryView {
    const profiles = this.store.listModelProfiles().map((profile) => this.viewProfile(profile));
    const chatProfileId = this.chatProfileId();
    return {
      chatProfileId,
      chatProfile: profiles.find((profile) => profile.id === chatProfileId) ?? null,
      profiles,
      bindings: this.bindingViews(profiles),
      updatedAt: this.store.getAppSetting(REGISTRY_UPDATED_KEY)
    };
  }

  listProfiles(): ModelProfileView[] {
    return this.store.listModelProfiles().map((profile) => this.viewProfile(profile));
  }

  getProfile(id: string): ModelProfileRecord | null {
    return this.store.getModelProfile(id);
  }

  chatProfileId(): string | null {
    const configured = this.store.getAppSetting(CHAT_PROFILE_KEY);
    if (configured && this.store.getModelProfile(configured)) return configured;
    return null;
  }

  setChatProfile(profileId: string | null): void {
    if (profileId && !this.store.getModelProfile(profileId)) {
      throw new ModelRegistryError("MODEL_PROFILE_NOT_FOUND", "找不到这个模型档案");
    }
    if (profileId) {
      this.store.setAppSetting(CHAT_PROFILE_KEY, profileId);
      this.ensureDefaultBindings(profileId);
    }
    else this.store.deleteAppSetting(CHAT_PROFILE_KEY);
    this.touch();
  }

  chatSettings(): ModelSettings | null {
    const id = this.chatProfileId();
    return id ? this.settingsForProfile(id) : null;
  }

  createProfile(patch: ModelProfilePatch): ModelProfileView {
    const now = new Date().toISOString();
    const id = uniqueProfileId(this.store, patch.name ?? patch.model ?? "model");
    const record = this.normalizeProfile({
      id,
      name: patch.name ?? patch.providerName ?? patch.model ?? "未命名模型",
      providerId: patch.providerId ?? "custom",
      providerName: patch.providerName ?? patch.name ?? "自定义服务",
      protocol: patch.protocol ?? "openai-chat",
      baseUrl: patch.baseUrl ?? "",
      model: patch.model ?? "",
      apiKeyCipher: patch.apiKey ? this.secretBox.encrypt(patch.apiKey) : null,
      isLocal: false,
      createdAt: now,
      updatedAt: now
    });
    this.store.upsertModelProfile(record);
    this.touch();
    return this.viewProfile(record);
  }

  updateProfile(id: string, patch: ModelProfilePatch): ModelProfileView {
    const current = this.store.getModelProfile(id);
    if (!current) throw new ModelRegistryError("MODEL_PROFILE_NOT_FOUND", "找不到这个模型档案");
    const record = this.normalizeProfile({
      ...current,
      name: patch.name ?? current.name,
      providerId: patch.providerId ?? current.providerId,
      providerName: patch.providerName ?? current.providerName,
      protocol: patch.protocol !== undefined ? normalizeProtocol(patch.protocol) : current.protocol,
      baseUrl: patch.baseUrl !== undefined ? normalizeBaseUrl(patch.baseUrl) : current.baseUrl,
      model: patch.model !== undefined ? patch.model.trim() : current.model,
      apiKeyCipher: patch.apiKey === undefined
        ? current.apiKeyCipher
        : patch.apiKey.trim()
          ? this.secretBox.encrypt(patch.apiKey.trim())
          : null,
      updatedAt: new Date().toISOString()
    });
    this.store.upsertModelProfile(record);
    this.touch();
    return this.viewProfile(record);
  }

  deleteProfile(id: string): void {
    if (!this.store.getModelProfile(id)) {
      throw new ModelRegistryError("MODEL_PROFILE_NOT_FOUND", "找不到这个模型档案");
    }
    this.store.deleteModelProfile(id);
    if (this.chatProfileId() === id) this.store.deleteAppSetting(CHAT_PROFILE_KEY);
    this.touch();
  }

  bindings(): ExecutorModelBinding[] {
    return this.store.listExecutorModelBindings();
  }

  bindingViews(profiles = this.listProfiles()): ExecutorModelBindingView[] {
    const bindings = new Map(this.bindings().map((binding) => [binding.executorId, binding]));
    return EXECUTOR_IDS.map((executorId) => {
      const binding = bindings.get(executorId) ?? {
        executorId,
        profileId: null,
        protocolOverride: null,
        modelOverride: null,
        updatedAt: null
      };
      const profile = binding.profileId ? profiles.find((item) => item.id === binding.profileId) ?? null : null;
      const allowedProtocols = EXECUTOR_MODEL_PROTOCOLS[executorId];
      const effectiveProtocol = profile ? binding.protocolOverride ?? profile.protocol : null;
      const effectiveModel = profile ? binding.modelOverride ?? profile.model : null;
      const issue = !profile
        ? null
        : !allowedProtocols.includes(effectiveProtocol as ModelProtocol)
          ? `${executorName(executorId)} 不支持 ${effectiveProtocol} 协议`
          : profile.isLocal
            ? "本地模型不进入统一模型管理"
            : !profile.baseUrl || !profile.model
              ? "模型档案缺少服务地址或模型名"
              : !profile.hasApiKey
                ? "模型档案缺少 API Key"
                : null;
      return {
        ...binding,
        profile,
        effectiveProtocol,
        effectiveModel,
        allowedProtocols,
        protocolLocked: allowedProtocols.length === 1,
        available: Boolean(profile && !issue),
        issue
      };
    });
  }

  saveBinding(executorId: ExecutorId, patch: ExecutorModelBindingPatch): ExecutorModelBindingView {
    const current = this.store.getExecutorModelBinding(executorId);
    const profileId = patch.profileId !== undefined ? patch.profileId : current?.profileId ?? null;
    const profile = profileId ? this.store.getModelProfile(profileId) : null;
    if (profileId && !profile) throw new ModelRegistryError("MODEL_PROFILE_NOT_FOUND", "找不到这个模型档案");
    if (profile?.isLocal) throw new ModelRegistryError("LOCAL_MODEL_NOT_MANAGED", "本地模型不进入统一模型管理");
    const protocolOverride = patch.protocolOverride !== undefined
      ? patch.protocolOverride
      : current?.protocolOverride ?? null;
    if (protocolOverride && !EXECUTOR_MODEL_PROTOCOLS[executorId].includes(protocolOverride)) {
      throw new ModelRegistryError("PROTOCOL_NOT_SUPPORTED", `${executorName(executorId)} 不支持 ${protocolOverride} 协议`);
    }
    const effectiveProtocol = protocolOverride ?? profile?.protocol ?? null;
    if (profile && effectiveProtocol && !EXECUTOR_MODEL_PROTOCOLS[executorId].includes(effectiveProtocol)) {
      throw new ModelRegistryError("PROTOCOL_NOT_SUPPORTED", `${executorName(executorId)} 只支持 ${EXECUTOR_MODEL_PROTOCOLS[executorId].join(" / ")}`);
    }
    this.store.setExecutorModelBinding({
      executorId,
      profileId,
      protocolOverride,
      modelOverride: patch.modelOverride !== undefined ? patch.modelOverride?.trim() || null : current?.modelOverride ?? null,
      updatedAt: new Date().toISOString()
    });
    this.touch();
    return this.bindingViews().find((binding) => binding.executorId === executorId) as ExecutorModelBindingView;
  }

  settingsForExecutor(executorId: ExecutorId): ModelSettings | null {
    const binding = this.bindingViews().find((item) => item.executorId === executorId);
    if (!binding?.profile || !binding.available) return null;
    const record = this.store.getModelProfile(binding.profile.id);
    if (!record) return null;
    return {
      providerId: record.providerId,
      providerName: record.providerName,
      protocol: binding.effectiveProtocol ?? record.protocol,
      baseUrl: record.baseUrl,
      model: binding.effectiveModel ?? record.model,
      apiKey: record.apiKeyCipher ? this.secretBox.decrypt(record.apiKeyCipher) : "",
      updatedAt: record.updatedAt
    };
  }

  settingsForProfile(id: string): ModelSettings | null {
    const record = this.store.getModelProfile(id);
    if (!record) return null;
    return {
      providerId: record.providerId,
      providerName: record.providerName,
      protocol: record.protocol,
      baseUrl: record.baseUrl,
      model: record.model,
      apiKey: record.apiKeyCipher ? this.secretBox.decrypt(record.apiKeyCipher) : "",
      updatedAt: record.updatedAt
    };
  }

  settingsForExecutorOrChat(executorId: ExecutorId): ModelSettings | null {
    const bound = this.settingsForExecutor(executorId);
    if (bound) return bound;
    if (executorId !== "native") return null;
    const chat = this.chatSettings();
    return chat ?? null;
  }

  codexProfile(): CodexProfile | null {
    const settings = this.settingsForExecutor("codex");
    if (!settings || settings.protocol !== "openai-responses") return null;
    const configPath = join(this.codexHome, "config.toml");
    mkdirSync(this.codexHome, { recursive: true });
    const envKey = "HEARTH_CODEX_API_KEY";
    writeFileSync(configPath, [
      `model = ${tomlString(settings.model)}`,
      'model_provider = "hearth"',
      "",
      "[model_providers.hearth]",
      `name = ${tomlString(settings.providerName)}`,
      `base_url = ${tomlString(settings.baseUrl)}`,
      `env_key = "${envKey}"`,
      'wire_api = "responses"',
      ""
    ].join("\n"), { encoding: "utf8", mode: 0o600 });
    return {
      codexHome: this.codexHome,
      configPath,
      model: settings.model,
      providerId: "hearth",
      providerName: settings.providerName,
      baseUrl: settings.baseUrl,
      wireApi: "responses",
      envKey,
      envKeyPresent: Boolean(settings.apiKey),
      envKeySource: settings.apiKey ? "process" : "missing",
      authSource: settings.apiKey ? "provider-env" : "missing",
      canRun: Boolean(settings.apiKey),
      issues: settings.apiKey ? [] : ["Codex 模型档案缺少 API Key"]
    };
  }

  codexEnv(): Record<string, string> {
    const settings = this.settingsForExecutor("codex");
    return settings?.apiKey ? { HEARTH_CODEX_API_KEY: settings.apiKey, CODEX_HOME: this.codexHome } : {};
  }

  importLegacy(settings: ModelSettings): ModelProfileView | null {
    if (!settings.baseUrl || !settings.model || isLocalModelEndpoint(settings.baseUrl)) return null;
    const existing = this.store.listModelProfiles().find((profile) =>
      profile.providerId === settings.providerId
      && profile.baseUrl === settings.baseUrl
      && profile.model === settings.model
      && profile.protocol === settings.protocol
    );
    if (existing) {
      this.setChatProfile(existing.id);
      return this.viewProfile(existing);
    }
    const created = this.createProfile({
      name: `${settings.providerName} / ${settings.model}`,
      providerId: settings.providerId,
      providerName: settings.providerName,
      protocol: settings.protocol,
      baseUrl: settings.baseUrl,
      model: settings.model,
      ...(settings.apiKey ? { apiKey: settings.apiKey } : {})
    });
    this.setChatProfile(created.id);
    return created;
  }

  private ensureDefaultBindings(profileId: string): void {
    if (!this.store.getExecutorModelBinding("native")) {
      this.store.setExecutorModelBinding({
        executorId: "native",
        profileId,
        protocolOverride: null,
        modelOverride: null,
        updatedAt: new Date().toISOString()
      });
    }
    if (!this.store.getExecutorModelBinding("codex")) {
      const profile = this.store.getModelProfile(profileId);
      if (profile?.protocol === "openai-responses") {
        this.store.setExecutorModelBinding({
          executorId: "codex",
          profileId,
          protocolOverride: "openai-responses",
          modelOverride: null,
          updatedAt: new Date().toISOString()
        });
      }
    }
  }

  private normalizeProfile(record: ModelProfileRecord): ModelProfileRecord {
    if (!record.name.trim()) throw new ModelRegistryError("INVALID_MODEL_PROFILE", "请填写模型档案名称");
    if (!record.baseUrl) throw new ModelRegistryError("INVALID_MODEL_PROFILE", "请填写服务地址");
    if (isLocalModelEndpoint(record.baseUrl)) {
      throw new ModelRegistryError("LOCAL_MODEL_NOT_MANAGED", "本地模型不进入统一模型管理；请直接在本地工具中使用");
    }
    return {
      ...record,
      name: record.name.trim(),
      providerId: record.providerId.trim() || "custom",
      providerName: record.providerName.trim() || record.name.trim(),
      protocol: normalizeProtocol(record.protocol),
      baseUrl: normalizeBaseUrl(record.baseUrl),
      model: record.model.trim(),
      isLocal: false
    };
  }

  private viewProfile(record: ModelProfileRecord): ModelProfileView {
    const apiKey = record.apiKeyCipher ? this.secretBox.decrypt(record.apiKeyCipher) : "";
    return {
      id: record.id,
      name: record.name,
      providerId: record.providerId,
      providerName: record.providerName,
      protocol: record.protocol,
      baseUrl: record.baseUrl,
      model: record.model,
      hasApiKey: Boolean(apiKey),
      apiKeyMasked: maskKey(apiKey),
      isLocal: record.isLocal,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    };
  }

  private touch(): void {
    this.store.setAppSetting(REGISTRY_UPDATED_KEY, new Date().toISOString());
  }
}

export function isLocalModelEndpoint(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "::1" || hostname.endsWith(".local")) return true;
    const version = isIP(hostname);
    if (version === 4) {
      const parts = hostname.split(".").map(Number);
      const first = parts[0] ?? -1;
      const second = parts[1] ?? -1;
      return first === 10
        || first === 127
        || (first === 169 && second === 254)
        || (first === 172 && second >= 16 && second <= 31)
        || (first === 192 && second === 168);
    }
    return version === 6 && (hostname === "::1" || hostname.startsWith("fe80:") || hostname.startsWith("fc") || hostname.startsWith("fd"));
  } catch {
    return false;
  }
}

function uniqueProfileId(store: HearthStore, label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "model";
  let id = base;
  let index = 2;
  while (store.getModelProfile(id)) id = `${base}-${index++}`;
  return id;
}

function maskKey(key: string): string | null {
  if (!key) return null;
  if (key.length <= 8) return "********";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function executorName(id: ExecutorId): string {
  if (id === "deepseek-harness") return "DeepSeek Harness";
  if (id === "native") return "Hearth 原生执行器";
  return id.charAt(0).toUpperCase() + id.slice(1);
}
