import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ApprovalRecord, ChatAttachment, ChatMessageRecord, TaskRecord } from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";
import type { SecretBox } from "./secrets.ts";
import type { HearthService } from "./service.ts";
import type { ApprovalManager } from "./approvals.ts";
import { SdkFeishuTransport, verifyFeishuCredentials } from "./feishu-transport.ts";
import { ChannelIngressService } from "./channel-adapter.ts";

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
  connectedAt: string | null;
  reconnectAttempts: number;
  inboundCount: number;
  outboundPending: number;
  outboundSent: number;
  outboundFailed: number;
  lastOutboundAt: string | null;
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
  send(
    input: { conversationId?: string | undefined; message: string; attachments: ChatAttachment[] },
    hooks?: { onTask?: (payload: unknown) => void }
  ): Promise<FeishuChatResult>;
}

export interface FeishuRoute {
  conversationId: string;
  createdAt: string;
}

interface OutboundItem {
  id: string;
  chatId: string;
  text: string;
  attempts: number;
  nextAt: string;
  createdAt: string;
}

interface FeishuPairingCode {
  code: string;
  conversationId: string;
  createdAt: string;
  expiresAt: string;
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
const OUTBOUND_KEY = "integrations.feishu.outbound.v1";
const PAIRING_KEY = "integrations.feishu.pairing.v1";
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_OUTBOUND_ITEMS = 200;
const MAX_SENT_MEMORY = 2_000;
const OUTBOUND_MAX_ATTEMPTS = 8;
const PAIRING_TTL_MS = 10 * 60_000;

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

  async send(
    input: { conversationId?: string | undefined; message: string; attachments: ChatAttachment[] },
    hooks: { onTask?: (payload: unknown) => void } = {}
  ): Promise<FeishuChatResult> {
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
            hooks.onTask?.(parsed.data);
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
  private readonly service: HearthService | null;
  private readonly approvals: ApprovalManager | null;
  private readonly channels: ChannelIngressService;
  private transport: FeishuTransport | null = null;
  private baseUrl = "";
  private state: FeishuStatus = {
    state: "disabled",
    lastEventAt: null,
    lastError: null,
    connectedAt: null,
    reconnectAttempts: 0,
    inboundCount: 0,
    outboundPending: 0,
    outboundSent: 0,
    outboundFailed: 0,
    lastOutboundAt: null
  };
  private reconnectAttempts = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private outboundTimer: ReturnType<typeof setTimeout> | null = null;
  private pumpingOutbound = false;
  private unsubscribe: (() => void) | null = null;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly sentMessageIds = new Set<string>();
  private readonly taskStatusNotified = new Map<string, string>();
  private outbound: OutboundItem[] = [];
  private outboundSent = 0;
  private outboundFailed = 0;
  private lastOutboundAt: string | null = null;

  constructor(options: {
    store: HearthStore;
    secretBox: SecretBox;
    attachmentRoot: string;
    transportFactory?: FeishuTransportFactory;
    chatClient?: FeishuChatClient;
    service?: HearthService;
    approvals?: ApprovalManager;
    channels?: ChannelIngressService;
    now?: () => Date;
  }) {
    this.store = options.store;
    this.attachmentRoot = options.attachmentRoot;
    this.settingsStore = new FeishuSettingsStore(options.store, options.secretBox);
    this.transportFactory = options.transportFactory ?? ((settings, callbacks) => new SdkFeishuTransport(settings, callbacks));
    this.chatClient = options.chatClient ?? new LocalFeishuChatClient(() => this.baseUrl);
    this.service = options.service ?? null;
    this.approvals = options.approvals ?? null;
    this.now = options.now ?? (() => new Date());
    this.channels = options.channels ?? new ChannelIngressService(options.store, this.now);
    this.outbound = this.loadOutbound();
    mkdirSync(this.attachmentRoot, { recursive: true });
  }

  view(): FeishuSettingsView {
    return this.settingsStore.view();
  }

  snapshot(): FeishuStatus {
    return {
      ...this.state,
      outboundPending: this.outbound.length,
      outboundSent: this.outboundSent,
      outboundFailed: this.outboundFailed,
      lastOutboundAt: this.lastOutboundAt,
      reconnectAttempts: this.reconnectAttempts
    };
  }

  createPairingCode(conversationId?: string): {
    code: string;
    expiresAt: string;
    conversationId: string;
    conversationTitle: string;
  } {
    if (!this.service) throw new FeishuError("FEISHU_PAIRING_UNAVAILABLE", "服务尚未就绪", 503);
    const conversation = conversationId
      ? this.store.getConversation(conversationId)
      : this.store.listConversations()[0] ?? null;
    if (!conversation) throw new FeishuError("FEISHU_NO_CONVERSATION", "还没有可配对的对话，请先在 Hearth 里发一条消息", 409);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const createdAt = this.now().toISOString();
    const pairing: FeishuPairingCode = {
      code,
      conversationId: conversation.id,
      createdAt,
      expiresAt: new Date(this.now().getTime() + PAIRING_TTL_MS).toISOString()
    };
    this.store.setAppSetting(PAIRING_KEY, JSON.stringify(pairing));
    return { code, expiresAt: pairing.expiresAt, conversationId: conversation.id, conversationTitle: conversation.title };
  }

  async start(baseUrl?: string): Promise<void> {
    if (baseUrl) this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.clearReconnectTimer();
    await this.disposeTransport();
    const settings = this.settingsStore.load();
    if (!settings.enabled) {
      this.setState({ state: "disabled", lastError: null });
      return;
    }
    if (!this.baseUrl) {
      this.setState({ state: "starting", lastError: null });
      return;
    }
    const secret = this.settingsStore.secret();
    if (!secret) {
      this.setState({ state: "error", lastError: "App Secret 尚未配置" });
      return;
    }
    this.setState({ state: "starting", lastError: null });
    this.connectTimer = setTimeout(() => {
      if (this.state.state === "starting") {
        const message = "长连接未在 15 秒内建立，请检查应用凭据与网络";
        this.setState({ state: "error", lastError: message });
        this.scheduleReconnect();
      }
    }, 15_000);
    this.connectTimer.unref?.();
    try {
      this.transport = this.transportFactory(
        { appId: settings.appId, appSecret: secret, domain: settings.domain },
        {
          onConnected: () => {
            this.clearConnectTimer();
            this.reconnectAttempts = 0;
            this.setState({ state: "connected", lastError: null, connectedAt: this.now().toISOString() });
            void this.pumpOutbound();
          },
          onReconnecting: () => {
            this.setState({ state: "reconnecting" });
          },
          onError: (message) => {
            this.clearConnectTimer();
            this.setState({ state: "error", lastError: message });
            this.scheduleReconnect();
          }
        }
      );
      await this.transport.start((message) => this.enqueue(message));
      this.subscribeEvents();
      this.startOutboundPump();
      if (this.state.state === "starting") {
        this.clearConnectTimer();
        this.setState({ state: "connected", lastError: null, connectedAt: this.now().toISOString() });
        void this.pumpOutbound();
      }
    } catch (error) {
      this.clearConnectTimer();
      this.setState({
        state: "error",
        lastError: error instanceof Error ? error.message : String(error)
      });
      this.scheduleReconnect();
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearReconnectTimer();
    if (this.outboundTimer) clearTimeout(this.outboundTimer);
    this.outboundTimer = null;
    await this.disposeTransport();
    this.setState({ state: "disabled", lastError: null });
  }

  async restart(): Promise<void> {
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    await this.start(this.baseUrl || undefined);
  }

  private setState(patch: Partial<FeishuStatus>): void {
    this.state = { ...this.state, ...patch };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (!this.settingsStore.load().enabled) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(this.reconnectAttempts - 1, 6));
    this.setState({ state: "reconnecting", reconnectAttempts: this.reconnectAttempts });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start(this.baseUrl || undefined);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private loadOutbound(): OutboundItem[] {
    const raw = this.store.getAppSetting(OUTBOUND_KEY);
    if (!raw) return [];
    try {
      const value = JSON.parse(raw) as unknown;
      if (!Array.isArray(value)) return [];
      return value.filter((item): item is OutboundItem => {
        if (!item || typeof item !== "object") return false;
        const record = item as Record<string, unknown>;
        return typeof record.id === "string"
          && typeof record.chatId === "string"
          && typeof record.text === "string"
          && typeof record.nextAt === "string"
          && typeof record.createdAt === "string"
          && typeof record.attempts === "number";
      }).slice(-MAX_OUTBOUND_ITEMS);
    } catch {
      return [];
    }
  }

  private persistOutbound(): void {
    try {
      this.store.setAppSetting(OUTBOUND_KEY, JSON.stringify(this.outbound.slice(-MAX_OUTBOUND_ITEMS)));
    } catch {
      // Queue persistence is best effort; delivery still proceeds in memory.
    }
  }

  private startOutboundPump(): void {
    if (this.outboundTimer || this.outbound.length === 0) return;
    this.outboundTimer = setTimeout(() => {
      this.outboundTimer = null;
      void this.pumpOutbound();
    }, 1_000);
    this.outboundTimer.unref?.();
  }

  private async pumpOutbound(): Promise<void> {
    if (this.pumpingOutbound || this.outbound.length === 0) return;
    if (!this.transport || this.state.state !== "connected") {
      this.startOutboundPump();
      return;
    }
    this.pumpingOutbound = true;
    try {
      const due = this.outbound.filter((item) => Date.parse(item.nextAt) <= this.now().getTime()).slice(0, 20);
      for (const item of due) await this.deliverOutbound(item);
    } finally {
      this.pumpingOutbound = false;
      this.persistOutbound();
      if (this.outbound.length > 0) this.startOutboundPump();
    }
  }

  private async deliverOutbound(item: OutboundItem): Promise<void> {
    if (!this.transport || this.state.state !== "connected") {
      item.nextAt = new Date(this.now().getTime() + 3_000).toISOString();
      this.persistOutbound();
      return;
    }
    try {
      await this.requireTransport().sendText(item.chatId, item.text);
      this.outbound = this.outbound.filter((entry) => entry.id !== item.id);
      this.outboundSent += 1;
      this.lastOutboundAt = this.now().toISOString();
    } catch (error) {
      item.attempts += 1;
      if (item.attempts >= OUTBOUND_MAX_ATTEMPTS) {
        this.outbound = this.outbound.filter((entry) => entry.id !== item.id);
        this.outboundFailed += 1;
        this.setState({ lastError: `飞书消息发送失败：${error instanceof Error ? error.message : String(error)}` });
      } else {
        const delay = Math.min(60_000, 2_000 * 2 ** Math.min(item.attempts - 1, 5));
        item.nextAt = new Date(this.now().getTime() + delay).toISOString();
      }
    }
    this.persistOutbound();
  }

  private async enqueueOutbound(chatId: string, text: string): Promise<void> {
    const clean = clip(text.trim(), 4_000);
    if (!clean) return;
    const now = this.now();
    const item: OutboundItem = {
      id: randomUUID(),
      chatId,
      text: clean,
      attempts: 0,
      nextAt: now.toISOString(),
      createdAt: now.toISOString()
    };
    this.outbound.push(item);
    if (this.outbound.length > MAX_OUTBOUND_ITEMS) {
      this.outbound.splice(0, this.outbound.length - MAX_OUTBOUND_ITEMS);
      this.outboundFailed += 1;
    }
    this.persistOutbound();
    if (this.transport && this.state.state === "connected") {
      await this.deliverOutbound(item);
      return;
    }
    this.startOutboundPump();
  }

  private markSent(id: string): void {
    this.sentMessageIds.add(id);
    if (this.sentMessageIds.size <= MAX_SENT_MEMORY) return;
    const oldest = this.sentMessageIds.values().next().value;
    if (oldest) this.sentMessageIds.delete(oldest);
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
    if (isDirectControlCommand(message.text)) {
      void this.processMessage(message);
      return;
    }
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

    let received;
    try {
      received = this.channels.receive({
        channel: "feishu",
        externalId: message.messageId,
        threadKey: message.chatId,
        sender: message.senderOpenId,
        text: message.text,
        attachments: [
          ...(message.imageKey ? [`image:${message.imageKey}`] : []),
          ...(message.fileKey ? [`file:${message.fileKey}`] : [])
        ],
        receivedAt: message.createdAt,
        generation: 1,
        cursor: Date.parse(message.createdAt) || 0,
        auth: { ok: true, principal: message.senderOpenId }
      });
    } catch (error) {
      this.state = { ...this.state, lastError: error instanceof Error ? error.message : String(error) };
      return;
    }
    if (received.duplicate && !["received", "processing", "retrying"].includes(received.record.status)) return;
    this.setState({ lastEventAt: this.now().toISOString(), inboundCount: this.state.inboundCount + 1 });

    try {
      const receipt = await this.handleMessage(message);
      this.channels.ack(received.record.id, receipt);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.channels.fail(received.record.id, error, isRetryableFeishuFailure(error));
      this.state = { ...this.state, lastError: detail };
      await this.safeSend(message.chatId, `处理失败：${detail}`);
    }
  }

  private async handleMessage(message: FeishuInboundMessage): Promise<Record<string, unknown>> {
    if (!["text", "image", "file"].includes(message.messageType)) {
      await this.safeSend(message.chatId, "目前支持文字、图片和文件消息。");
      return { outcome: "unsupported", messageType: message.messageType };
    }
    if (!message.text && !message.imageKey && !message.fileKey) {
      await this.safeSend(message.chatId, "我只收到了空消息，请再发一次。");
      return { outcome: "empty" };
    }

    const pairCode = parsePairCommand(message.text);
    if (pairCode) {
      await this.handlePairCommand(message, pairCode);
      return { outcome: "pair_command" };
    }
    if (/^(?:\/pair|配对)(?:\s|$)/i.test(message.text.trim())) {
      await this.safeSend(message.chatId, "用法：/pair <6位配对码>。配对码可在 Hearth 的“连接”页生成，10 分钟内有效。");
      return { outcome: "pair_usage" };
    }
    const command = parseApprovalCommand(message.text);
    if (command) {
      await this.handleApprovalCommand(message, command);
      return { outcome: "approval_command", decision: command.decision };
    }
    if (/^(?:\/approve|\/reject|批准|拒绝)(?:\s|$)/i.test(message.text.trim())) {
      await this.safeSend(message.chatId, "用法：/approve <审批ID前8位> 或 /reject <审批ID前8位>");
      return { outcome: "approval_usage" };
    }

    const attachments = await this.prepareAttachments(message);
    const route = this.route(message.chatId);
    const result = await this.chatClient.send({
      ...(route ? { conversationId: route.conversationId } : {}),
      message: message.text,
      attachments
    }, {
      onTask: (payload) => this.notifyTaskAccepted(message.chatId, payload)
    });
    if (result.conversationId && !route) this.saveRoute(message.chatId, result.conversationId);
    if (result.error) await this.safeSend(message.chatId, `处理失败：${result.error}`);
    let replyCount = 0;
    for (const reply of result.messages) {
      if (reply.role !== "assistant" || !reply.content.trim()) continue;
      if (this.sentMessageIds.has(reply.id)) continue;
      this.markSent(reply.id);
      replyCount += 1;
      await this.safeSend(message.chatId, reply.content);
    }
    return {
      outcome: "chat",
      conversationId: result.conversationId,
      replyCount,
      ...(result.error ? { error: result.error } : {})
    };
  }

  private subscribeEvents(): void {
    if (this.unsubscribe || !this.service) return;
    this.unsubscribe = this.service.bus.subscribe((event) => {
      if (event.type === "chat.message.created") {
        const payload = event.payload as { message?: ChatMessageRecord; conversationId?: string } | null;
        if (payload?.message) void this.forwardChatMessage(payload.message, payload.conversationId);
      } else if (event.type === "task.updated" && event.taskId) {
        void this.notifyTaskProgress(event.taskId);
      } else if (event.type === "approval.created") {
        void this.notifyApproval(event.payload as ApprovalRecord);
      }
    });
  }

  private async notifyTaskAccepted(chatId: string, payload: unknown): Promise<void> {
    const record = asChatMessage(isRecord(payload) ? payload.message : null);
    if (!record || !record.content.trim()) return;
    if (this.sentMessageIds.has(record.id)) return;
    this.markSent(record.id);
    await this.safeSend(chatId, record.content);
  }

  private async forwardChatMessage(message: ChatMessageRecord, conversationId?: string): Promise<void> {
    if (message.role !== "assistant" || !message.content.trim()) return;
    // Task status lines have their own concise progress channel below.
    if (message.kind === "task_status") return;
    if (this.sentMessageIds.has(message.id)) return;
    const chatId = (conversationId ? this.findChatByConversation(conversationId) : null)
      ?? this.findChatByConversation(message.conversationId);
    if (!chatId) return;
    this.markSent(message.id);
    await this.safeSend(chatId, message.content);
  }

  private async notifyTaskProgress(taskId: string): Promise<void> {
    if (!this.service) return;
    const task = this.service.store.getTask(taskId);
    if (!task || !task.conversationId) return;
    const chatId = this.findChatByConversation(task.conversationId);
    if (!chatId) return;
    if (task.status === "waiting_approval") return;
    if (this.taskStatusNotified.get(task.id) === task.status) return;
    const text = taskProgressText(task);
    if (!text) return;
    this.taskStatusNotified.set(task.id, task.status);
    await this.safeSend(chatId, text);
  }

  private async notifyApproval(payload: ApprovalRecord): Promise<void> {
    if (!payload?.id || !this.service) return;
    const approval = this.service.store.getApproval(payload.id);
    if (!approval || approval.status !== "pending") return;
    const task = this.service.store.getTask(approval.taskId);
    if (!task || task.status !== "waiting_approval") return;
    const chatId = this.findChatByConversation(task.conversationId);
    if (!chatId) return;
    const impact = isRecord(approval.preview) && typeof approval.preview.impact === "string"
      ? approval.preview.impact
      : "这是一个需要你确认的外部动作。";
    const prefix = approval.id.slice(0, 8);
    await this.safeSend(chatId, [
      `任务「${task.title}」等待你确认外部动作。`,
      `审批：${approval.summary}`,
      `影响：${impact}`,
      `有效期至：${new Date(approval.expiresAt).toLocaleString("zh-CN")}`,
      "",
      `批准：/approve ${prefix}`,
      `拒绝：/reject ${prefix}`
    ].join("\n"));
  }

  private async handleApprovalCommand(
    message: FeishuInboundMessage,
    command: { decision: "approve" | "reject"; prefix: string }
  ): Promise<void> {
    if (!this.service || !this.approvals) {
      await this.safeSend(message.chatId, "审批命令当前不可用。");
      return;
    }
    const route = this.route(message.chatId);
    if (!route) {
      await this.safeSend(message.chatId, "这个会话还没有关联任务。");
      return;
    }
    const tasks = this.service.store.listTasks().filter((task) => task.conversationId === route.conversationId);
    const matches = tasks
      .flatMap((task) => this.service!.store.listApprovals(task.id))
      .filter((approval) => approval.status === "pending" && approval.id.startsWith(command.prefix));
    const unique = [...new Map(matches.map((approval) => [approval.id, approval])).values()];
    if (unique.length === 0) {
      await this.safeSend(message.chatId, `没有找到以 ${command.prefix} 开头的待处理审批。`);
      return;
    }
    if (unique.length > 1) {
      await this.safeSend(message.chatId, `有 ${unique.length} 个待处理审批以 ${command.prefix} 开头，请输入更长的前缀。`);
      return;
    }
    const approval = unique[0]!;
    try {
      await this.approvals.decide(approval.id, command.decision, approval.parameterHash);
      await this.safeSend(message.chatId, command.decision === "approve" ? "已批准，正在执行外部动作。" : "已拒绝，没有产生外部副作用。");
    } catch (error) {
      await this.safeSend(message.chatId, `审批失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handlePairCommand(message: FeishuInboundMessage, code: string): Promise<void> {
    if (!this.service) {
      await this.safeSend(message.chatId, "配对功能当前不可用。");
      return;
    }
    const pairing = this.loadPairing();
    if (!pairing || Date.parse(pairing.expiresAt) <= this.now().getTime()) {
      await this.safeSend(message.chatId, "配对码已过期。请在 Hearth 的“连接”页重新生成。");
      return;
    }
    if (pairing.code !== code) {
      await this.safeSend(message.chatId, "配对码不正确。请在 Hearth 的“连接”页核对后重试。");
      return;
    }
    const conversation = this.store.getConversation(pairing.conversationId);
    if (!conversation) {
      await this.safeSend(message.chatId, "配对码指向的对话已不存在，请重新生成。");
      return;
    }
    this.saveRoute(message.chatId, conversation.id);
    this.store.setAppSetting(PAIRING_KEY, "");
    await this.safeSend(message.chatId, `已配对到对话「${conversation.title}」。之后消息、任务进度和审批都会出现在这里。`);
  }

  private loadPairing(): FeishuPairingCode | null {
    const raw = this.store.getAppSetting(PAIRING_KEY);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as unknown;
      if (!isRecord(value)) return null;
      if (typeof value.code !== "string" || typeof value.conversationId !== "string" || typeof value.expiresAt !== "string") return null;
      return {
        code: value.code,
        conversationId: value.conversationId,
        createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
        expiresAt: value.expiresAt
      };
    } catch {
      return null;
    }
  }

  private findChatByConversation(conversationId: string | null | undefined): string | null {
    if (!conversationId) return null;
    for (const [chatId, route] of Object.entries(this.loadRoutes())) {
      if (route.conversationId === conversationId) return chatId;
    }
    return null;
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
    // Never throw into the gateway: messages are queued, retried, and surfaced
    // through connection metrics instead.
    await this.enqueueOutbound(chatId, text);
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

function parseApprovalCommand(text: string): { decision: "approve" | "reject"; prefix: string } | null {
  const trimmed = text.trim();
  const approve = trimmed.match(/^(?:\/approve|批准)\s+([0-9a-f-]{6,36})$/i);
  if (approve) return { decision: "approve", prefix: approve[1]!.toLowerCase() };
  const reject = trimmed.match(/^(?:\/reject|拒绝)\s+([0-9a-f-]{6,36})$/i);
  if (reject) return { decision: "reject", prefix: reject[1]!.toLowerCase() };
  return null;
}

function parsePairCommand(text: string): string | null {
  const match = text.trim().match(/^(?:\/pair|配对)\s+(\d{6})$/i);
  return match?.[1] ?? null;
}

function isDirectControlCommand(text: string): boolean {
  return Boolean(parseApprovalCommand(text) || parsePairCommand(text));
}

function taskProgressText(task: TaskRecord): string | null {
  const title = task.title.trim() || "未命名任务";
  switch (task.status) {
    case "queued":
      return `任务已排队：${title}`;
    case "running":
      return `开始执行：${title}`;
    case "waiting_input":
      return `需要你补充信息：${title}${task.nextAction ? `\n${clip(task.nextAction, 600)}` : ""}`;
    case "waiting_budget":
      return `等待预算确认：${title}${task.nextAction ? `\n${clip(task.nextAction, 600)}` : ""}`;
    case "paused":
      return `已暂停：${title}${task.nextAction ? `\n${clip(task.nextAction, 600)}` : ""}`;
    case "completed":
      return `已完成：${title}${task.resultSummary ? `\n${clip(task.resultSummary, 1_200)}` : ""}`;
    case "failed":
    case "recoverable":
      return `执行失败：${title}${task.error ? `\n${clip(task.error.message, 800)}` : ""}`;
    case "cancelled":
      return `已取消：${title}`;
    default:
      return null;
  }
}

function isRetryableFeishuFailure(error: unknown): boolean {
  if (error instanceof FeishuError) {
    return error.statusCode === 408 || error.statusCode === 425 || error.statusCode === 429 || error.statusCode >= 500;
  }
  if (error instanceof Error && "code" in error) {
    const code = String((error as NodeJS.ErrnoException).code);
    if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE"].includes(code)) return true;
  }
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) return true;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
