import type { HearthStore } from "@hearth/eventlog";
import type { SecretBox } from "../secrets.ts";

export const KNOWLEDGE_SETTINGS_META_KEY = "knowledge.settings";
export const KNOWLEDGE_API_KEY_META_KEY = "knowledge.apiKeyCipher";

export type KnowledgePeerScope = "actor" | "all";
export type KnowledgeMemoryWriteMode = "off" | "curated" | "all";
export type KnowledgeTaskWriteMode = "off" | "completed" | "all";

export interface KnowledgeRecallSettings {
  maxItems: number;
  maxTokens: number;
  timeoutMs: number;
  minScore: number | null;
  includeResources: boolean;
  includeMemories: boolean;
  includeSkills: boolean;
  peerScope: KnowledgePeerScope;
}

export interface KnowledgeWriteSettings {
  memories: KnowledgeMemoryWriteMode;
  tasks: KnowledgeTaskWriteMode;
  sources: boolean;
  projects: boolean;
  reindexCron: string;
}

export interface KnowledgeSettings {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  manageProcess: boolean;
  serverCommand: string;
  serverArgs: string[];
  recall: KnowledgeRecallSettings;
  write: KnowledgeWriteSettings;
  peers: Record<string, string>;
  updatedAt: string | null;
}

export type KnowledgeSettingsPatch = {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  manageProcess?: boolean;
  serverCommand?: string;
  serverArgs?: string[];
  recall?: Partial<KnowledgeRecallSettings>;
  write?: Partial<KnowledgeWriteSettings>;
  peers?: Record<string, string>;
};

export interface KnowledgeSettingsView extends Omit<KnowledgeSettings, "apiKey"> {
  apiKeyMasked: string | null;
}

export class KnowledgeSettingsError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "KnowledgeSettingsError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const DEFAULT_KNOWLEDGE_SETTINGS: KnowledgeSettings = {
  enabled: false,
  baseUrl: "http://127.0.0.1:1933",
  apiKey: "",
  manageProcess: false,
  serverCommand: "openviking-server",
  serverArgs: ["--host", "127.0.0.1", "--port", "1933"],
  recall: {
    maxItems: 5,
    maxTokens: 1200,
    timeoutMs: 2500,
    minScore: null,
    includeResources: true,
    includeMemories: true,
    includeSkills: false,
    peerScope: "all"
  },
  write: {
    memories: "curated",
    tasks: "completed",
    sources: true,
    projects: false,
    reindexCron: "0 3 * * *"
  },
  peers: {},
  updatedAt: null
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MEMORY_WRITE_MODES: KnowledgeMemoryWriteMode[] = ["off", "curated", "all"];
const TASK_WRITE_MODES: KnowledgeTaskWriteMode[] = ["off", "completed", "all"];

interface StoredKnowledgeSettings {
  enabled?: unknown;
  baseUrl?: unknown;
  manageProcess?: unknown;
  serverCommand?: unknown;
  serverArgs?: unknown;
  recall?: unknown;
  write?: unknown;
  peers?: unknown;
  updatedAt?: unknown;
}

export class KnowledgeSettingsStore {
  private readonly store: HearthStore;
  private readonly secretBox: SecretBox;
  private readonly clock: () => Date;

  constructor(store: HearthStore, secretBox: SecretBox, clock: () => Date = () => new Date()) {
    this.store = store;
    this.secretBox = secretBox;
    this.clock = clock;
  }

  get(): KnowledgeSettings {
    const stored = this.readStored();
    const defaults = cloneDefaults();
    return {
      enabled: typeof stored.enabled === "boolean" ? stored.enabled : defaults.enabled,
      baseUrl: typeof stored.baseUrl === "string" ? stored.baseUrl : defaults.baseUrl,
      apiKey: this.readApiKey(),
      manageProcess:
        typeof stored.manageProcess === "boolean" ? stored.manageProcess : defaults.manageProcess,
      serverCommand:
        typeof stored.serverCommand === "string" ? stored.serverCommand : defaults.serverCommand,
      serverArgs: Array.isArray(stored.serverArgs)
        ? stored.serverArgs.map((value) => String(value))
        : defaults.serverArgs,
      recall: { ...defaults.recall, ...asRecord(stored.recall) } as KnowledgeRecallSettings,
      write: { ...defaults.write, ...asRecord(stored.write) } as KnowledgeWriteSettings,
      peers: asRecord(stored.peers) as Record<string, string>,
      updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null
    };
  }

  view(): KnowledgeSettingsView {
    const settings = this.get();
    const { apiKey: _apiKey, ...rest } = settings;
    return { ...rest, apiKeyMasked: maskKey(settings.apiKey) };
  }

  update(patch: KnowledgeSettingsPatch): KnowledgeSettings {
    const current = this.get();
    const next: KnowledgeSettings = {
      ...current,
      ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
      ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl.trim() } : {}),
      ...(patch.manageProcess !== undefined ? { manageProcess: Boolean(patch.manageProcess) } : {}),
      ...(patch.serverCommand !== undefined ? { serverCommand: patch.serverCommand.trim() } : {}),
      ...(patch.serverArgs !== undefined ? { serverArgs: patch.serverArgs.map((value) => String(value)) } : {}),
      ...(patch.recall !== undefined ? { recall: { ...current.recall, ...patch.recall } } : {}),
      ...(patch.write !== undefined ? { write: { ...current.write, ...patch.write } } : {}),
      ...(patch.peers !== undefined ? { peers: normalizePeers(patch.peers) } : {})
    };
    validateSettings({ ...next, apiKey: patch.apiKey !== undefined ? patch.apiKey : current.apiKey });
    next.updatedAt = this.clock().toISOString();

    if (patch.apiKey !== undefined) {
      const key = patch.apiKey.trim();
      if (key) this.store.setMeta(KNOWLEDGE_API_KEY_META_KEY, this.secretBox.encrypt(key));
      else this.store.setMeta(KNOWLEDGE_API_KEY_META_KEY, "");
    }

    const { apiKey: _apiKey, ...persisted } = next;
    this.store.setMeta(KNOWLEDGE_SETTINGS_META_KEY, JSON.stringify(persisted));
    return next;
  }

  private readStored(): StoredKnowledgeSettings {
    const raw = this.store.getMeta(KNOWLEDGE_SETTINGS_META_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) return {};
      return parsed as StoredKnowledgeSettings;
    } catch {
      throw new KnowledgeSettingsError("KNOWLEDGE_SETTINGS_CORRUPT", "知识库设置已损坏，请重新保存", 500);
    }
  }

  private readApiKey(): string {
    const cipher = this.store.getMeta(KNOWLEDGE_API_KEY_META_KEY);
    if (!cipher) return "";
    try {
      return this.secretBox.decrypt(cipher);
    } catch {
      throw new KnowledgeSettingsError(
        "KNOWLEDGE_API_KEY_UNREADABLE",
        "知识库 API Key 无法解密，请重新填写",
        500
      );
    }
  }
}

export function validateSettings(settings: KnowledgeSettings): void {
  validateBaseUrl(settings.baseUrl);
  if (!settings.serverCommand.trim()) {
    throw new KnowledgeSettingsError("KNOWLEDGE_SETTINGS_INVALID", "serverCommand 不能为空");
  }
  validateRecall(settings.recall);
  validateWrite(settings.write);
  if (!Array.isArray(settings.serverArgs) || settings.serverArgs.some((arg) => typeof arg !== "string")) {
    throw new KnowledgeSettingsError("KNOWLEDGE_SETTINGS_INVALID", "serverArgs 必须是字符串数组");
  }
  validatePeers(settings.peers);
}

function validateBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new KnowledgeSettingsError("KNOWLEDGE_SETTINGS_INVALID", "知识库地址不是合法 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new KnowledgeSettingsError("KNOWLEDGE_SETTINGS_INVALID", "知识库地址必须是 http 或 https");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new KnowledgeSettingsError(
      "KNOWLEDGE_BASE_URL_NOT_LOCAL",
      "知识库地址必须是本机回环地址（127.0.0.1 / localhost）",
      400
    );
  }
}

function validateRecall(recall: KnowledgeRecallSettings): void {
  if (!Number.isInteger(recall.maxItems) || recall.maxItems < 1 || recall.maxItems > 20) {
    throw new KnowledgeSettingsError("KNOWLEDGE_SETTINGS_INVALID", "maxItems 必须在 1 到 20 之间");
  }
  if (!Number.isInteger(recall.maxTokens) || recall.maxTokens < 200 || recall.maxTokens > 4000) {
    throw new KnowledgeSettingsError("KNOWLEDGE_SETTINGS_INVALID", "maxTokens 必须在 200 到 4000 之间");
  }
  if (!Number.isInteger(recall.timeoutMs) || recall.timeoutMs < 500 || recall.timeoutMs > 10000) {
    throw new KnowledgeSettingsError("KNOWLEDGE_SETTINGS_INVALID", "timeoutMs 必须在 500 到 10000 之间");
  }
  if (recall.minScore !== null && (typeof recall.minScore !== "number" || recall.minScore < 0 || recall.minScore > 1)) {
    throw new KnowledgeSettingsError("KNOWLEDGE_SETTINGS_INVALID", "minScore 必须是 0 到 1 之间的数字或 null");
  }
  if (recall.peerScope !== "actor" && recall.peerScope !== "all") {
    throw new KnowledgeSettingsError("KNOWLEDGE_SETTINGS_INVALID", "peerScope 只能是 actor 或 all");
  }
}

function validateWrite(write: KnowledgeWriteSettings): void {
  if (!MEMORY_WRITE_MODES.includes(write.memories)) {
    throw new KnowledgeSettingsError("KNOWLEDGE_SETTINGS_INVALID", "write.memories 取值不正确");
  }
  if (!TASK_WRITE_MODES.includes(write.tasks)) {
    throw new KnowledgeSettingsError("KNOWLEDGE_SETTINGS_INVALID", "write.tasks 取值不正确");
  }
  if (!isCronExpression(write.reindexCron)) {
    throw new KnowledgeSettingsError("KNOWLEDGE_SETTINGS_INVALID", "reindexCron 必须是 5 段 cron 表达式");
  }
}

function validatePeers(peers: Record<string, string>): void {
  for (const [executorId, peerId] of Object.entries(peers)) {
    if (!executorId.trim() || !peerId.trim()) {
      throw new KnowledgeSettingsError("KNOWLEDGE_SETTINGS_INVALID", "peers 的键值不能为空");
    }
  }
}

function normalizePeers(peers: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
    for (const [executorId, peerId] of Object.entries(peers)) {
    next[executorId.trim()] = String(peerId).trim();
  }
  return next;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maskKey(value: string): string | null {
  if (!value) return null;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function cloneDefaults(): KnowledgeSettings {
  return {
    ...DEFAULT_KNOWLEDGE_SETTINGS,
    serverArgs: [...DEFAULT_KNOWLEDGE_SETTINGS.serverArgs],
    recall: { ...DEFAULT_KNOWLEDGE_SETTINGS.recall },
    write: { ...DEFAULT_KNOWLEDGE_SETTINGS.write },
    peers: {}
  };
}

function isCronExpression(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && fields.every((field) => /^[0-9*/,\-]+$/.test(field));
}
