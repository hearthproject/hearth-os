import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ChatAttachment, ChatMessageRecord } from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";
import type { SecretBox } from "./secrets.ts";
import { SdkFeishuTransport, verifyFeishuCredentials } from "./feishu-transport.ts";

export type FeishuDomain = "feishu" | "lark";

export interface FeishuSettings {
  enabled: boolean;
  appId: string;
  appSecretCipher: string | null;
  allowedOpenIds: string[];
  domain: FeishuDomain;
  updatedAt: string | null;
}

export interface FeishuSettingsView {
  enabled: boolean;
  appId: string;
  hasAppSecret: boolean;
  appSecretMasked: string | null;
  allowedOpenIds: string[];
  domain: FeishuDomain;
  updatedAt: string | null;
}

export interface FeishuSettingsPatch {
  enabled?: boolean | undefined;
  appId?: string | undefined;
  appSecret?: string | undefined;
  allowedOpenIds?: string[] | undefined;
  domain?: FeishuDomain | undefined;
}

export type FeishuConnectionState = "disabled" | "starting" | "connected" | "reconnecting" | "error";

export interface FeishuStatus {
  state: FeishuConnectionState;
  lastEventAt: string | null;
  lastError: string | null;
}

export interface FeishuInboundMessage {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderOpenId: string;
  messageType: string;
  text: string;
  imageKey: string | null;
  fileKey: string | null;
  fileName: string | null;
  createdAt: string;
}

export interface FeishuTransportSettings {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
}

export interface FeishuTransportCallbacks {
  onConnected?: () => void;
  onReconnecting?: () => void;
  onError?: (message: string) => void;
}

export interface FeishuTransport {
  start(onMessage: (message: FeishuInboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
  downloadResource(messageId: string, key: string, type: "image" | "file"): Promise<{ buffer: Buffer; mimeType: string }>;
}

export type FeishuTransportFactory = (
  settings: FeishuTransportSettings,
  callbacks: FeishuTransportCallbacks
) => FeishuTransport;

export interface FeishuChatResult {
  conversationId: string;
  messages: ChatMessageRecord[];
  error: string | null;
}

export interface FeishuChatClient {
  send(input: { conversationId?: string | undefined; message: string; attachments: ChatAttachment[] }): Promise<FeishuChatResult>;
}

export interface FeishuRoute {
  conversationId: string;
  createdAt: string;
}

export class FeishuError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "FeishuError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const SETTINGS_KEY = "integrations.feishu.v1";
const ROUTES_KEY = "integrations.feishu.routes.v1";
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const DEFAULT_SETTINGS: FeishuSettings = {
  enabled: false,
  appId: "",
  appSecretCipher: null,
  allowedOpenIds: [],
  domain: "feishu",
  updatedAt: null
};

export class FeishuSettingsStore {
  constructor(
    private readonly store: HearthStore,
    private readonly secretBox: SecretBox
  ) {}

  load(): FeishuSettings {
    const raw = this.store.getAppSetting(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
      const value = JSON.parse(raw) as unknown;
      if (!value || typeof value !== "object") return { ...DEFAULT_SETTINGS };
      const record = value as Record<string, unknown>;
      return {
        enabled: record.enabled === true,
        appId: typeof record.appId === "string" ? record.appId : "",
        appSecretCipher: typeof record.appSecretCipher === "string" ? record.appSecretCipher : null,
        allowedOpenIds: Array.isArray(record.allowedOpenIds)
          ? record.allowedOpenIds.filter((item): item is string => typeof item === "string")
          : [],
        domain: record.domain === "lark" ? "lark" : "feishu",
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  view(): FeishuSettingsView {
    const settings = this.load();
    return {
      enabled: settings.enabled,
      appId: settings.appId,
      hasAppSecret: Boolean(settings.appSecretCipher),
      appSecretMasked: settings.appSecretCipher ? "••••••••" : null,
      allowedOpenIds: settings.allowedOpenIds,
      domain: settings.domain,
      updatedAt: settings.updatedAt
    };
  }

  save(patch: FeishuSettingsPatch): FeishuSettings {
    const current = this.load();
    const next: FeishuSettings = {
      ...current,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.appId !== undefined ? { appId: patch.appId.trim() } : {}),
      ...(patch.domain !== undefined ? { domain: patch.domain } : {}),
      ...(patch.allowedOpenIds !== undefined ? { allowedOpenIds: normalizeOpenIds(patch.allowedOpenIds) } : {}),
      ...(patch.appSecret !== undefined && patch.appSecret.trim()
        ? { appSecretCipher: this.secretBox.encrypt(patch.appSecret.trim()) }
        : {})
    };
    if (next.appId.length > 100) throw new FeishuError("INVALID_FEISHU_APP_ID", "App ID 过长");
    if (next.enabled && (!next.appId || !next.appSecretCipher || next.allowedOpenIds.length === 0)) {
      throw new FeishuError("INCOMPLETE_FEISHU_SETTINGS", "启用前需要填写 App ID、App Secret，并至少加入一个允许的用户 open_id");
    }
    next.updatedAt = new Date().toISOString();
    this.store.setAppSetting(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  secret(): string | null {
    const settings = this.load();
    if (!settings.appSecretCipher) return null;
    try {
      return this.secretBox.decrypt(settings.appSecretCipher);
    } catch {
      throw new FeishuError("FEISHU_SECRET_UNREADABLE", "App Secret 无法解密，请重新填写", 409);
    }
  }
}

export class LocalFeishuChatClient implements FeishuChatClient {
  constructor(
    private readonly baseUrl: () => string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async send(input: { conversationId?: string | undefined; message: string; attachments: ChatAttachment[] }): Promise<FeishuChatResult> {
    const base = this.baseUrl();
    if (!base) throw new FeishuError("FEISHU_NOT_READY", "Hearth 本机服务尚未就绪", 503);
    const response = await this.fetchImpl(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.message ? { message: input.message } : {}),
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {})
      }),
      signal: AbortSignal.timeout(180_000)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new FeishuError("FEISHU_CHAT_FAILED", text || `Hearth 聊天接口返回 ${response.status}`, response.status);
    }
    if (!response.body) throw new FeishuError("FEISHU_CHAT_FAILED", "Hearth 聊天接口没有返回事件流");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let conversationId = "";
    let error: string | null = null;
    const messages: ChatMessageRecord[] = [];
    const seen = new Set<string>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary).replace(/\r/g, "");
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseBlock(block);
        if (parsed) {
          if (parsed.event === "conversation" && typeof parsed.data.id === "string") {
            conversationId = parsed.data.id;
          } else if (parsed.event === "done") {
            const message = asChatMessage(parsed.data);
            if (message && !seen.has(message.id)) {
              seen.add(message.id);
              messages.push(message);
            }
          } else if (parsed.event === "task") {
            const message = asChatMessage(parsed.data.message);
            if (message && !seen.has(message.id)) {
              seen.add(message.id);
              messages.push(message);
            }
          } else if (parsed.event === "error") {
            error = typeof parsed.data.message === "string" ? parsed.data.message : "处理失败";
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    if (!conversationId) throw new FeishuError("FEISHU_CHAT_FAILED", error ?? "Hearth 没有返回对话标识");
    return { conversationId, messages, error };
  }
}

export class FeishuService {
  readonly settingsStore: FeishuSettingsStore;
  private readonly store: HearthStore;
  private readonly attachmentRoot: string;
  private readonly transportFactory: FeishuTransportFactory;
  private readonly chatClient: FeishuChatClient;
  private readonly now: () => Date;
  private transport: FeishuTransport | null = null;
  private baseUrl = "";
  private state: FeishuStatus = { state: "disabled", lastEventAt: null, lastError: null };
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly seenMessages = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly sentMessageIds = new Set<string>();

  constructor(options: {
    store: HearthStore;
    secretBox: SecretBox;
    attachmentRoot: string;
    transportFactory?: FeishuTransportFactory;
    chatClient?: FeishuChatClient;
    now?: () => Date;
  }) {
    this.store = options.store;
    this.attachmentRoot = options.attachmentRoot;
    this.settingsStore = new FeishuSettingsStore(options.store, options.secretBox);
    this.transportFactory = options.transportFactory ?? ((settings, callbacks) => new SdkFeishuTransport(settings, callbacks));
    this.chatClient = options.chatClient ?? new LocalFeishuChatClient(() => this.baseUrl);
    this.now = options.now ?? (() => new Date());
    mkdirSync(this.attachmentRoot, { recursive: true });
  }

  view(): FeishuSettingsView {
    return this.settingsStore.view();
  }

  snapshot(): FeishuStatus {
    return { ...this.state };
  }

  async start(baseUrl?: string): Promise<void> {
    if (baseUrl) this.baseUrl = baseUrl.replace(/\/+$/, "");
    await this.disposeTransport();
    const settings = this.settingsStore.load();
    if (!settings.enabled) {
      this.state = { state: "disabled", lastEventAt: this.state.lastEventAt, lastError: null };
      return;
    }
    if (!this.baseUrl) {
      this.state = { state: "starting", lastEventAt: this.state.lastEventAt, lastError: null };
      return;
    }
    const secret = this.settingsStore.secret();
    if (!secret) {
      this.state = { state: "error", lastEventAt: this.state.lastEventAt, lastError: "App Secret 尚未配置" };
      return;
    }
    this.state = { state: "starting", lastEventAt: this.state.lastEventAt, lastError: null };
    this.connectTimer = setTimeout(() => {
      if (this.state.state === "starting") {
        this.state = { ...this.state, state: "error", lastError: "长连接未在 15 秒内建立，请检查应用凭据与网络" };
      }
    }, 15_000);
    this.connectTimer.unref?.();
    try {
      this.transport = this.transportFactory(
        { appId: settings.appId, appSecret: secret, domain: settings.domain },
        {
          onConnected: () => {
            this.clearConnectTimer();
            this.state = { ...this.state, state: "connected", lastError: null };
          },
          onReconnecting: () => {
            this.state = { ...this.state, state: "reconnecting" };
          },
          onError: (message) => {
            this.clearConnectTimer();
            this.state = { ...this.state, state: "error", lastError: message };
          }
        }
      );
      await this.transport.start((message) => this.enqueue(message));
      if (this.state.state === "starting") {
        this.clearConnectTimer();
        this.state = { ...this.state, state: "connected", lastError: null };
      }
    } catch (error) {
      this.clearConnectTimer();
      this.state = {
        ...this.state,
        state: "error",
        lastError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async stop(): Promise<void> {
    await this.disposeTransport();
    this.state = { state: "disabled", lastEventAt: this.state.lastEventAt, lastError: null };
  }

  async restart(): Promise<void> {
    await this.start(this.baseUrl || undefined);
  }

  async updateSettings(patch: FeishuSettingsPatch): Promise<{ settings: FeishuSettingsView; status: FeishuStatus }> {
    this.settingsStore.save(patch);
    await this.restart();
    return { settings: this.view(), status: this.snapshot() };
  }

  async test(input: { appId?: string | undefined; appSecret?: string | undefined; domain?: FeishuDomain | undefined } = {}) {
    const settings = this.settingsStore.load();
    const appId = input.appId?.trim() || settings.appId;
    const appSecret = input.appSecret?.trim() || this.settingsStore.secret();
    if (!appId || !appSecret) return { ok: false, error: "请填写 App ID 和 App Secret", elapsedMs: 0 };
    return verifyFeishuCredentials({ appId, appSecret, domain: input.domain ?? settings.domain });
  }

  route(chatId: string): FeishuRoute | null {
    const routes = this.loadRoutes();
    return routes[chatId] ?? null;
  }

  private enqueue(message: FeishuInboundMessage): void {
    const previous = this.queues.get(message.chatId) ?? Promise.resolve();
    const next = previous
      .then(() => this.processMessage(message))
      .catch(() => undefined)
      .finally(() => {
        if (this.queues.get(message.chatId) === next) this.queues.delete(message.chatId);
      });
    this.queues.set(message.chatId, next);
  }

  private async processMessage(message: FeishuInboundMessage): Promise<void> {
    const settings = this.settingsStore.load();
    if (!settings.enabled) return;
    if (!settings.allowedOpenIds.includes(message.senderOpenId)) return;
    if (this.seenMessages.has(message.messageId)) return;
    this.seenMessages.add(message.messageId);
    if (this.seenMessages.size > 500) {
      const oldest = this.seenMessages.values().next().value;
      if (oldest) this.seenMessages.delete(oldest);
    }
    this.state = { ...this.state, lastEventAt: this.now().toISOString() };

    if (!["text", "image", "file"].includes(message.messageType)) {
      await this.safeSend(message.chatId, "目前支持文字、图片和文件消息。");
      return;
    }
    if (!message.text && !message.imageKey && !message.fileKey) {
      await this.safeSend(message.chatId, "我只收到了空消息，请再发一次。");
      return;
    }

    await this.safeSend(message.chatId, "收到，正在处理…");
    try {
      const attachments = await this.prepareAttachments(message);
      const route = this.route(message.chatId);
      const result = await this.chatClient.send({
        ...(route ? { conversationId: route.conversationId } : {}),
        message: message.text,
        attachments
      });
      if (result.conversationId && !route) this.saveRoute(message.chatId, result.conversationId);
      if (result.error) await this.safeSend(message.chatId, `处理失败：${result.error}`);
      for (const reply of result.messages) {
        if (reply.role !== "assistant" || !reply.content.trim()) continue;
        if (this.sentMessageIds.has(reply.id)) continue;
        this.sentMessageIds.add(reply.id);
        await this.safeSend(message.chatId, reply.content);
      }
    } catch (error) {
      await this.safeSend(message.chatId, `处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async prepareAttachments(message: FeishuInboundMessage): Promise<ChatAttachment[]> {
    const attachments: ChatAttachment[] = [];
    if (message.imageKey) {
      const resource = await this.requireTransport().downloadResource(message.messageId, message.imageKey, "image");
      attachments.push(this.storeAttachment(resource.buffer, `image-${message.messageId}${extensionForMime(resource.mimeType)}`, resource.mimeType));
    }
    if (message.fileKey) {
      const resource = await this.requireTransport().downloadResource(message.messageId, message.fileKey, "file");
      const name = sanitizeFileName(message.fileName || `file-${message.messageId}`, extensionForMime(resource.mimeType));
      attachments.push(this.storeAttachment(resource.buffer, name, resource.mimeType));
    }
    return attachments;
  }

  private storeAttachment(buffer: Buffer, name: string, mimeType: string): ChatAttachment {
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new FeishuError("FEISHU_ATTACHMENT_TOO_LARGE", `附件超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
    }
    const id = randomUUID();
    const extension = extname(name).toLowerCase();
    const safeExtension = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
    writeFileSync(join(this.attachmentRoot, `${id}${safeExtension}`), buffer, { flag: "wx" });
    return { id, name, mimeType, bytes: buffer.byteLength };
  }

  private saveRoute(chatId: string, conversationId: string): void {
    const routes = this.loadRoutes();
    routes[chatId] = { conversationId, createdAt: this.now().toISOString() };
    this.store.setAppSetting(ROUTES_KEY, JSON.stringify(routes));
  }

  private loadRoutes(): Record<string, FeishuRoute> {
    const raw = this.store.getAppSetting(ROUTES_KEY);
    if (!raw) return {};
    try {
      const value = JSON.parse(raw) as unknown;
      return value && typeof value === "object" ? value as Record<string, FeishuRoute> : {};
    } catch {
      return {};
    }
  }

  private async safeSend(chatId: string, text: string): Promise<void> {
    try {
      await this.requireTransport().sendText(chatId, clip(text, 4_000));
    } catch {
      // Sending failures are visible in Feishu status; never crash the gateway.
    }
  }

  private requireTransport(): FeishuTransport {
    if (!this.transport) throw new FeishuError("FEISHU_NOT_CONNECTED", "飞书长连接尚未建立", 503);
    return this.transport;
  }

  private async disposeTransport(): Promise<void> {
    this.clearConnectTimer();
    const transport = this.transport;
    this.transport = null;
    if (transport) {
      try {
        await transport.stop();
      } catch {
        // Closing a broken connection must not block shutdown.
      }
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }
}

function normalizeOpenIds(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 50);
}

function sanitizeFileName(name: string, fallbackExtension: string): string {
  const raw = basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  const base = raw && raw !== "." && raw !== ".." ? raw : `attachment-${Date.now()}${fallbackExtension}`;
  return extname(base) ? base : `${base}${fallbackExtension}`;
}

function extensionForMime(mimeType: string): string {
  const clean = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (clean === "image/png") return ".png";
  if (clean === "image/jpeg") return ".jpg";
  if (clean === "image/gif") return ".gif";
  if (clean === "image/webp") return ".webp";
  if (clean === "application/pdf") return ".pdf";
  if (clean === "text/plain") return ".txt";
  return ".bin";
}

function parseSseBlock(block: string): { event: string; data: Record<string, unknown> } | null {
  let event = "message";
  const lines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) lines.push(line.slice(5).trim());
  }
  if (lines.length === 0) return null;
  try {
    const data = JSON.parse(lines.join("\n")) as unknown;
    return data && typeof data === "object" ? { event, data: data as Record<string, unknown> } : null;
  } catch {
    return null;
  }
}

function asChatMessage(value: unknown): ChatMessageRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.content !== "string") return null;
  return value as ChatMessageRecord;
}

function clip(value: string, limit: number): string {
  const clean = value.trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

export { parseFeishuMessage } from "./feishu-parse.ts";

declare module "fastify" {
  interface FastifyInstance {
    feishu: FeishuService;
  }
}