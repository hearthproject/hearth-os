import { randomInt, randomUUID } from "node:crypto";
import type { ChatAttachment, ChatMessageRecord } from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";
import { LocalFeishuChatClient, type FeishuChatClient } from "./feishu.ts";
import type { SecretBox } from "./secrets.ts";

const SETTINGS_KEY = "integrations.im.v1";
const SHARED_CONVERSATION_KEY = "integrations.im.conversationId";
const WECHAT_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const QQ_TOKEN_URL = "https://api.bot.qq.com/app/getAppAccessToken";
const QQ_API_BASE = "https://api.bot.qq.com";
const QQ_SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com";
// C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE 都属于 GROUP_AND_C2C_EVENT。
const QQ_INTENTS = 1 << 25;
const MAX_SENT_MEMORY = 2_000;
const MAX_TEXT_CHARS = 3_000;

export type ImChannelId = "wechat" | "qq";
export type ImConnectionState = "disabled" | "starting" | "connected" | "reconnecting" | "error";

export interface ImChannelStatus {
  state: ImConnectionState;
  lastEventAt: string | null;
  lastError: string | null;
  connectedAt: string | null;
  reconnectAttempts: number;
  inboundCount: number;
  outboundSent: number;
  outboundFailed: number;
  accountLabel: string | null;
}

interface WechatSettings {
  enabled: boolean;
  tokenCipher: string | null;
  baseUrl: string;
  accountId: string | null;
  userId: string | null;
  conversationId: string | null;
  cursor: string;
  updatedAt: string | null;
}

interface QqSettings {
  enabled: boolean;
  appId: string;
  clientSecretCipher: string | null;
  sandbox: boolean;
  conversationId: string | null;
  updatedAt: string | null;
}

interface ImSettings {
  wechat: WechatSettings;
  qq: QqSettings;
  updatedAt: string | null;
}

interface WechatQrSession {
  qrcode: string;
  content: string;
  createdAt: number;
  expiresAt: string;
  confirmedAccount: string | null;
}

interface InboundTarget {
  kind: "wechat-user" | "qq-user" | "qq-group";
  id: string;
  messageId: string;
  contextToken: string | null;
  msgSeq: number;
}

const DEFAULT_SETTINGS: ImSettings = {
  wechat: {
    enabled: false,
    tokenCipher: null,
    baseUrl: WECHAT_DEFAULT_BASE_URL,
    accountId: null,
    userId: null,
    conversationId: null,
    cursor: "",
    updatedAt: null
  },
  qq: {
    enabled: false,
    appId: "",
    clientSecretCipher: null,
    sandbox: false,
    conversationId: null,
    updatedAt: null
  },
  updatedAt: null
};

const EMPTY_STATUS = (): ImChannelStatus => ({
  state: "disabled",
  lastEventAt: null,
  lastError: null,
  connectedAt: null,
  reconnectAttempts: 0,
  inboundCount: 0,
  outboundSent: 0,
  outboundFailed: 0,
  accountLabel: null
});

export interface WechatSettingsView {
  enabled: boolean;
  hasToken: boolean;
  baseUrl: string;
  accountId: string | null;
  userId: string | null;
  conversationId: string | null;
  conversationTitle: string | null;
  updatedAt: string | null;
}

export interface QqSettingsView {
  enabled: boolean;
  appId: string;
  hasClientSecret: boolean;
  sandbox: boolean;
  conversationId: string | null;
  conversationTitle: string | null;
  updatedAt: string | null;
}

export interface ImBridgeView {
  settings: { wechat: WechatSettingsView; qq: QqSettingsView };
  status: Record<ImChannelId, ImChannelStatus>;
  qrcode: { active: boolean; expiresAt: string | null } | null;
}

export interface ImBridgeOptions {
  store: HearthStore;
  secretBox: SecretBox;
  baseUrl: () => string;
  chatClient?: FeishuChatClient;
  now?: () => Date;
}

export class ImBridgeError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "ImBridgeError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ImBridgeService {
  private readonly store: HearthStore;
  private readonly secretBox: SecretBox;
  private readonly baseUrl: () => string;
  private runtimeBaseUrl: string | null = null;
  private readonly chatClient: FeishuChatClient;
  private readonly now: () => Date;
  private settings: ImSettings;
  private status: Record<ImChannelId, ImChannelStatus> = {
    wechat: EMPTY_STATUS(),
    qq: EMPTY_STATUS()
  };
  private wechatLoop: Promise<void> | null = null;
  private wechatAbort: AbortController | null = null;
  private wechatQr: WechatQrSession | null = null;
  private wechatContextTokens = new Map<string, string>();
  private qqSocket: WebSocket | null = null;
  private qqAbort: AbortController | null = null;
  private qqHeartbeat: ReturnType<typeof setInterval> | null = null;
  private qqReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private qqToken: { value: string; expiresAt: number; appId: string } | null = null;
  private qqSeq = 0;
  private qqLastSeq: number | null = null;
  private readonly sentMessageIds = new Set<string>();
  private readonly seenInboundIds = new Set<string>();
  private readonly queues = new Map<ImChannelId, Promise<void>>();
  private stopping = false;

  constructor(options: ImBridgeOptions) {
    this.store = options.store;
    this.secretBox = options.secretBox;
    this.baseUrl = options.baseUrl;
    this.chatClient = options.chatClient ?? new LocalFeishuChatClient(() => this.currentBaseUrl());
    this.now = options.now ?? (() => new Date());
    this.settings = this.load();
  }

  setRuntimeBaseUrl(url: string): void {
    this.runtimeBaseUrl = url.replace(/\/+$/, "");
  }

  private currentBaseUrl(): string {
    return this.runtimeBaseUrl ?? this.baseUrl();
  }

  view(): ImBridgeView {
    const wechatConversation = this.settings.wechat.conversationId
      ? this.store.getConversation(this.settings.wechat.conversationId)
      : null;
    const qqConversation = this.settings.qq.conversationId
      ? this.store.getConversation(this.settings.qq.conversationId)
      : null;
    return {
      settings: {
        wechat: {
          enabled: this.settings.wechat.enabled,
          hasToken: Boolean(this.settings.wechat.tokenCipher),
          baseUrl: this.settings.wechat.baseUrl,
          accountId: this.settings.wechat.accountId,
          userId: this.settings.wechat.userId,
          conversationId: this.settings.wechat.conversationId,
          conversationTitle: wechatConversation?.title ?? null,
          updatedAt: this.settings.wechat.updatedAt
        },
        qq: {
          enabled: this.settings.qq.enabled,
          appId: this.settings.qq.appId,
          hasClientSecret: Boolean(this.settings.qq.clientSecretCipher),
          sandbox: this.settings.qq.sandbox,
          conversationId: this.settings.qq.conversationId,
          conversationTitle: qqConversation?.title ?? null,
          updatedAt: this.settings.qq.updatedAt
        }
      },
      status: this.snapshot(),
      qrcode: this.wechatQr
        ? { active: true, expiresAt: this.wechatQr.expiresAt }
        : null
    };
  }

  snapshot(): Record<ImChannelId, ImChannelStatus> {
    return {
      wechat: { ...this.status.wechat },
      qq: { ...this.status.qq }
    };
  }

  async connectAll(): Promise<void> {
    this.stopping = false;
    await this.startWechat();
    this.startQq();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wechatAbort?.abort();
    this.wechatAbort = null;
    this.wechatLoop = null;
    this.qqAbort?.abort();
    this.qqAbort = null;
    if (this.qqReconnectTimer) clearTimeout(this.qqReconnectTimer);
    this.qqReconnectTimer = null;
    if (this.qqHeartbeat) clearInterval(this.qqHeartbeat);
    this.qqHeartbeat = null;
    try {
      this.qqSocket?.close();
    } catch {
      // Socket close is best effort.
    }
    this.qqSocket = null;
  }

  saveWechat(patch: {
    enabled?: boolean | undefined;
    token?: string | undefined;
    baseUrl?: string | undefined;
    conversationId?: string | null | undefined;
  }): void {
    const current = this.settings.wechat;
    const next: WechatSettings = {
      ...current,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.baseUrl !== undefined ? { baseUrl: normalizeBaseUrl(patch.baseUrl) } : {}),
      ...(patch.conversationId !== undefined ? { conversationId: patch.conversationId || null } : {}),
      ...(patch.token !== undefined && patch.token.trim()
        ? { tokenCipher: this.secretBox.encrypt(patch.token.trim()), accountId: null, userId: null }
        : {})
    };
    if (next.enabled && !next.tokenCipher) {
      throw new ImBridgeError("WECHAT_TOKEN_REQUIRED", "启用微信前需要先扫码登录，或填写 Bot Token");
    }
    next.updatedAt = this.now().toISOString();
    this.settings = { ...this.settings, wechat: next, updatedAt: next.updatedAt };
    this.persist();
  }

  saveQq(patch: {
    enabled?: boolean | undefined;
    appId?: string | undefined;
    clientSecret?: string | undefined;
    sandbox?: boolean | undefined;
    conversationId?: string | null | undefined;
  }): void {
    const current = this.settings.qq;
    const next: QqSettings = {
      ...current,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.appId !== undefined ? { appId: patch.appId.trim() } : {}),
      ...(patch.clientSecret !== undefined && patch.clientSecret.trim()
        ? { clientSecretCipher: this.secretBox.encrypt(patch.clientSecret.trim()) }
        : {}),
      ...(patch.sandbox !== undefined ? { sandbox: patch.sandbox } : {}),
      ...(patch.conversationId !== undefined ? { conversationId: patch.conversationId || null } : {})
    };
    if (next.enabled && (!next.appId || !next.clientSecretCipher)) {
      throw new ImBridgeError("QQ_CREDENTIALS_REQUIRED", "启用 QQ 前需要填写 App ID 和 App Secret");
    }
    next.updatedAt = this.now().toISOString();
    this.settings = { ...this.settings, qq: next, updatedAt: next.updatedAt };
    this.persist();
  }

  async restartWechat(): Promise<void> {
    this.wechatAbort?.abort();
    this.wechatAbort = null;
    this.wechatLoop = null;
    this.status.wechat = { ...EMPTY_STATUS(), state: this.settings.wechat.enabled ? "starting" : "disabled" };
    await this.startWechat();
  }

  async restartQq(): Promise<void> {
    this.stopQqSocket();
    this.status.qq = { ...EMPTY_STATUS(), state: this.settings.qq.enabled ? "starting" : "disabled" };
    this.startQq();
  }

  async startWechatQr(): Promise<{ qrcode: string; image: string; expiresAt: string }> {
    const base = this.settings.wechat.baseUrl || WECHAT_DEFAULT_BASE_URL;
    const response = await fetch(`${base}/ilink/bot/get_bot_qrcode?bot_type=3`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new ImBridgeError("WECHAT_QR_FAILED", `获取微信二维码失败（${response.status}）`, 502);
    const data = await response.json() as { qrcode?: unknown; qrcode_img_content?: unknown };
    if (typeof data.qrcode !== "string" || !data.qrcode) {
      throw new ImBridgeError("WECHAT_QR_FAILED", "微信没有返回二维码", 502);
    }
    const content = typeof data.qrcode_img_content === "string" ? data.qrcode_img_content : data.qrcode;
    const expiresAt = new Date(this.now().getTime() + 5 * 60_000).toISOString();
    this.wechatQr = {
      qrcode: data.qrcode,
      content,
      createdAt: this.now().getTime(),
      expiresAt,
      confirmedAccount: null
    };
    return { qrcode: data.qrcode, image: content, expiresAt };
  }

  async pollWechatQr(qrcode: string): Promise<{
    status: "wait" | "scaned" | "confirmed" | "expired" | "error";
    accountId: string | null;
    message: string | null;
  }> {
    const session = this.wechatQr;
    if (!session || session.qrcode !== qrcode) {
      return { status: "error", accountId: null, message: "二维码已失效，请重新获取" };
    }
    const base = this.settings.wechat.baseUrl || WECHAT_DEFAULT_BASE_URL;
    let data: Record<string, unknown>;
    try {
      const response = await fetch(`${base}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(40_000)
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { status: "error", accountId: null, message: text || `微信返回 ${response.status}` };
      }
      data = await response.json() as Record<string, unknown>;
    } catch (error) {
      // iLink 的扫码状态接口是长轮询，未扫码时会挂起几十秒；超时代表“仍在等待”，不是失败。
      if (error instanceof Error && /timeout/i.test(error.name)) {
        return { status: "wait", accountId: null, message: null };
      }
      return { status: "error", accountId: null, message: error instanceof Error ? error.message : String(error) };
    }
    const status = typeof data.status === "string" ? data.status : "";
    if (status === "wait") return { status: "wait", accountId: null, message: null };
    if (status === "scaned") return { status: "scaned", accountId: null, message: "已扫码，请在手机上确认" };
    if (status === "expired") {
      this.wechatQr = null;
      return { status: "expired", accountId: null, message: "二维码已过期，请重新获取" };
    }
    if (status !== "confirmed") {
      return { status: "error", accountId: null, message: status || "未知扫码状态" };
    }
    const token = typeof data.bot_token === "string" ? data.bot_token : "";
    if (!token) return { status: "error", accountId: null, message: "微信没有返回 Bot Token" };
    const accountId = stringValue(data.ilink_bot_id) ?? stringValue(data.bot_id) ?? "微信";
    const userId = stringValue(data.ilink_user_id);
    const nextBase = normalizeBaseUrl(stringValue(data.baseurl) ?? base);
    const next: WechatSettings = {
      ...this.settings.wechat,
      enabled: true,
      tokenCipher: this.secretBox.encrypt(token),
      baseUrl: nextBase,
      accountId,
      userId,
      updatedAt: this.now().toISOString()
    };
    this.settings = { ...this.settings, wechat: next, updatedAt: next.updatedAt };
    this.persist();
    this.wechatQr = null;
    this.status.wechat = { ...EMPTY_STATUS(), state: "starting", accountLabel: accountId };
    await this.restartWechat();
    return { status: "confirmed", accountId, message: "扫码成功，已开始接收消息" };
  }

  private async startWechat(): Promise<void> {
    const wechat = this.settings.wechat;
    if (!wechat.enabled) {
      this.status.wechat = { ...this.status.wechat, state: "disabled", lastError: null };
      return;
    }
    const token = this.wechatToken();
    if (!token) {
      this.status.wechat = { ...this.status.wechat, state: "error", lastError: "还没有微信 Bot Token，请先扫码登录" };
      return;
    }
    this.status.wechat = { ...this.status.wechat, state: "starting", lastError: null };
    this.wechatAbort = new AbortController();
    this.wechatLoop = this.wechatPollLoop(token, this.wechatAbort.signal);
  }

  private async wechatPollLoop(token: string, signal: AbortSignal): Promise<void> {
    const base = this.settings.wechat.baseUrl || WECHAT_DEFAULT_BASE_URL;
    while (!signal.aborted && !this.stopping) {
      try {
        const response = await fetch(`${base}/ilink/bot/getupdates`, {
          method: "POST",
          headers: this.wechatHeaders(token),
          body: JSON.stringify({
            get_updates_buf: this.settings.wechat.cursor,
            base_info: { channel_version: "hearth/1.0" }
          }),
          signal
        });
        if (!response.ok) throw new Error(`微信消息接口返回 ${response.status}`);
        const data = await response.json() as {
          ret?: unknown;
          errcode?: unknown;
          errmsg?: unknown;
          msgs?: unknown;
          get_updates_buf?: unknown;
        };
        const code = numberValue(data.errcode) ?? numberValue(data.ret);
        if (code === -14) {
          this.status.wechat = {
            ...this.status.wechat,
            state: "error",
            lastError: "微信登录已过期，请重新扫码",
            connectedAt: null
          };
          return;
        }
        if (code !== null && code !== 0) {
          throw new Error(stringValue(data.errmsg) ?? `微信返回错误码 ${code}`);
        }
        if (typeof data.get_updates_buf === "string" && data.get_updates_buf !== this.settings.wechat.cursor) {
          this.settings.wechat = { ...this.settings.wechat, cursor: data.get_updates_buf };
          this.persist();
        }
        this.status.wechat = {
          ...this.status.wechat,
          state: "connected",
          connectedAt: this.status.wechat.connectedAt ?? this.now().toISOString(),
          lastError: null,
          accountLabel: this.settings.wechat.accountId
        };
        const messages = Array.isArray(data.msgs) ? data.msgs : [];
        for (const message of messages) {
          if (!message || typeof message !== "object") continue;
          await this.handleWechatMessage(message as Record<string, unknown>, token);
        }
      } catch (error) {
        if (signal.aborted || this.stopping) return;
        this.status.wechat = {
          ...this.status.wechat,
          state: "reconnecting",
          lastError: error instanceof Error ? error.message : String(error),
          reconnectAttempts: this.status.wechat.reconnectAttempts + 1
        };
        await sleep(3_000, signal);
      }
    }
  }

  private async handleWechatMessage(message: Record<string, unknown>, token: string): Promise<void> {
    const from = stringValue(message.from_user_id);
    const contextToken = stringValue(message.context_token);
    const messageId = stringValue(message.message_id) ?? stringValue(message.client_id) ?? randomUUID();
    if (!from) return;
    if (this.seenInboundIds.has(`wechat:${messageId}`)) return;
    this.rememberInbound(`wechat:${messageId}`);
    if (contextToken) this.wechatContextTokens.set(from, contextToken);
    const text = extractWechatText(message);
    this.status.wechat = {
      ...this.status.wechat,
      lastEventAt: this.now().toISOString(),
      inboundCount: this.status.wechat.inboundCount + 1
    };
    if (!text) {
      await this.sendWechat(from, contextToken, "目前只支持文字消息，图片和文件请直接在 Hearth 对话里发送。", token);
      return;
    }
    await this.enqueue("wechat", async () => {
      await this.sendWechat(from, contextToken, "收到，正在处理…", token);
      await this.deliverChat("wechat", text, (reply) => this.sendWechat(from, contextToken, reply, token));
    });
  }

  private async sendWechat(to: string, contextToken: string | null, text: string, token: string): Promise<void> {
    const tokenValue = contextToken ?? this.wechatContextTokens.get(to) ?? "";
    if (!tokenValue) {
      this.status.wechat = { ...this.status.wechat, outboundFailed: this.status.wechat.outboundFailed + 1, lastError: "缺少微信 context_token，无法回复" };
      return;
    }
    const base = this.settings.wechat.baseUrl || WECHAT_DEFAULT_BASE_URL;
    try {
      for (const chunk of splitText(text)) {
        const response = await fetch(`${base}/ilink/bot/sendmessage`, {
          method: "POST",
          headers: this.wechatHeaders(token),
          body: JSON.stringify({
            msg: {
              from_user_id: "",
              to_user_id: to,
              client_id: randomUUID(),
              message_type: 2,
              message_state: 2,
              context_token: tokenValue,
              item_list: [{ type: 1, text_item: { text: chunk } }]
            },
            base_info: { channel_version: "hearth/1.0" }
          }),
          signal: AbortSignal.timeout(20_000)
        });
        const data = await response.json().catch(() => ({})) as Record<string, unknown>;
        const code = numberValue(data.errcode) ?? numberValue(data.ret);
        if (!response.ok || (code !== null && code !== 0)) {
          throw new Error(stringValue(data.errmsg) ?? `微信发送接口返回 ${response.status}`);
        }
      }
      this.status.wechat = {
        ...this.status.wechat,
        outboundSent: this.status.wechat.outboundSent + 1
      };
    } catch (error) {
      this.status.wechat = {
        ...this.status.wechat,
        outboundFailed: this.status.wechat.outboundFailed + 1,
        lastError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private wechatHeaders(token: string): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${token}`,
      "X-WECHAT-UIN": Buffer.from(String(randomInt(0, 0xffff_ffff))).toString("base64")
    };
  }

  private wechatToken(): string | null {
    if (!this.settings.wechat.tokenCipher) return null;
    try {
      return this.secretBox.decrypt(this.settings.wechat.tokenCipher);
    } catch {
      return null;
    }
  }

  private startQq(): void {
    const qq = this.settings.qq;
    if (!qq.enabled) {
      this.status.qq = { ...this.status.qq, state: "disabled", lastError: null };
      return;
    }
    if (!qq.appId || !qq.clientSecretCipher) {
      this.status.qq = { ...this.status.qq, state: "error", lastError: "还没有填写 QQ 机器人 App ID / App Secret" };
      return;
    }
    this.status.qq = { ...this.status.qq, state: "starting", lastError: null };
    this.qqAbort = new AbortController();
    void this.connectQq(this.qqAbort.signal);
  }

  private async connectQq(signal: AbortSignal): Promise<void> {
    try {
      const secret = this.secretBox.decrypt(this.settings.qq.clientSecretCipher as string);
      const access = await this.qqAccessToken(this.settings.qq.appId, secret);
      const apiBase = this.settings.qq.sandbox ? QQ_SANDBOX_API_BASE : QQ_API_BASE;
      const response = await fetch(`${apiBase}/gateway`, {
        headers: { Authorization: `QQBot ${access}` },
        signal
      });
      if (!response.ok) throw new Error(`获取 QQ 网关失败（${response.status}）`);
      const data = await response.json() as { url?: unknown };
      if (typeof data.url !== "string") throw new Error("QQ 网关没有返回连接地址");
      this.openQqSocket(data.url, access, apiBase, signal);
    } catch (error) {
      if (signal.aborted) return;
      this.status.qq = {
        ...this.status.qq,
        state: "reconnecting",
        lastError: error instanceof Error ? error.message : String(error),
        reconnectAttempts: this.status.qq.reconnectAttempts + 1
      };
      this.scheduleQqReconnect();
    }
  }

  private openQqSocket(url: string, access: string, apiBase: string, signal: AbortSignal): void {
    this.stopQqSocket();
    const socket = new WebSocket(url);
    this.qqSocket = socket;
    socket.addEventListener("open", () => {
      this.status.qq = { ...this.status.qq, state: "starting", lastError: null };
    });
    socket.addEventListener("message", (event) => {
      void this.handleQqPacket(String(event.data), access, apiBase, signal);
    });
    socket.addEventListener("error", () => {
      this.status.qq = { ...this.status.qq, lastError: "QQ WebSocket 连接出错" };
    });
    socket.addEventListener("close", () => {
      if (signal.aborted || this.stopping || this.qqSocket !== socket) return;
      this.status.qq = {
        ...this.status.qq,
        state: "reconnecting",
        connectedAt: null,
        reconnectAttempts: this.status.qq.reconnectAttempts + 1
      };
      this.scheduleQqReconnect();
    });
  }

  private async handleQqPacket(raw: string, access: string, apiBase: string, signal: AbortSignal): Promise<void> {
    let packet: Record<string, unknown>;
    try {
      packet = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const op = numberValue(packet.op);
    if (packet.s !== undefined && numberValue(packet.s) !== null) this.qqLastSeq = numberValue(packet.s);
    if (op === 10) {
      this.startQqHeartbeat(signal);
      try {
        this.qqSocket?.send(JSON.stringify({
          op: 2,
          d: {
            token: `QQBot ${access}`,
            intents: QQ_INTENTS,
            shard: [0, 1],
            properties: { $os: "windows", $browser: "hearth", $device: "hearth" }
          }
        }));
      } catch {
        // The close handler will retry.
      }
      return;
    }
    if (op === 11) return;
    if (op === 7) {
      this.stopQqSocket();
      this.status.qq = { ...this.status.qq, state: "reconnecting", lastError: null };
      this.scheduleQqReconnect();
      return;
    }
    if (op === 9) {
      this.qqToken = null;
      this.stopQqSocket();
      this.status.qq = { ...this.status.qq, state: "reconnecting", lastError: "QQ 会话失效，正在重连" };
      this.scheduleQqReconnect();
      return;
    }
    if (op !== 0) return;
    const eventType = stringValue(packet.t);
    const payload = packet.d && typeof packet.d === "object" ? packet.d as Record<string, unknown> : {};
    if (eventType === "READY") {
      this.status.qq = {
        ...this.status.qq,
        state: "connected",
        connectedAt: this.now().toISOString(),
        lastError: null,
        accountLabel: stringValue(payload.session_id) ?? null
      };
      return;
    }
    if (eventType === "C2C_MESSAGE_CREATE") {
      const author = payload.author && typeof payload.author === "object" ? payload.author as Record<string, unknown> : {};
      const openid = stringValue(author.user_openid) ?? stringValue(author.id);
      const content = stringValue(payload.content)?.trim() ?? "";
      const messageId = stringValue(payload.id) ?? randomUUID();
      if (!openid || !content) return;
      await this.handleQqInbound({
        kind: "qq-user",
        id: openid,
        messageId,
        contextToken: null,
        msgSeq: 1
      }, content, access, apiBase);
      return;
    }
    if (eventType === "GROUP_AT_MESSAGE_CREATE") {
      const author = payload.author && typeof payload.author === "object" ? payload.author as Record<string, unknown> : {};
      const groupId = stringValue(payload.group_openid) ?? stringValue(payload.group_id);
      const content = stringValue(payload.content)?.replace(/^\s+/, "").trim() ?? "";
      const messageId = stringValue(payload.id) ?? randomUUID();
      if (!groupId || !content) return;
      await this.handleQqInbound({
        kind: "qq-group",
        id: groupId,
        messageId,
        contextToken: null,
        msgSeq: 1
      }, content, access, apiBase);
    }
  }

  private async handleQqInbound(
    target: InboundTarget,
    text: string,
    access: string,
    apiBase: string
  ): Promise<void> {
    const key = `qq:${target.messageId}`;
    if (this.seenInboundIds.has(key)) return;
    this.rememberInbound(key);
    this.status.qq = {
      ...this.status.qq,
      lastEventAt: this.now().toISOString(),
      inboundCount: this.status.qq.inboundCount + 1
    };
    await this.enqueue("qq", async () => {
      await this.sendQq(target, "收到，正在处理…", access, apiBase);
      await this.deliverChat("qq", text, (reply) => this.sendQq(target, reply, access, apiBase));
    });
  }

  private async sendQq(target: InboundTarget, text: string, access: string, apiBase: string): Promise<void> {
    const path = target.kind === "qq-group"
      ? `/v2/groups/${encodeURIComponent(target.id)}/messages`
      : `/v2/users/${encodeURIComponent(target.id)}/messages`;
    try {
      for (const chunk of splitText(text)) {
        const response = await fetch(`${apiBase}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `QQBot ${access}`
          },
          body: JSON.stringify({
            content: chunk,
            msg_type: 0,
            msg_id: target.messageId,
            msg_seq: this.qqSeq = (this.qqSeq % 1_000) + 1
          }),
          signal: AbortSignal.timeout(15_000)
        });
        const raw = await response.text();
        if (!response.ok) {
          throw new Error(raw || `QQ 发送接口返回 ${response.status}`);
        }
        if (raw) {
          try {
            const data = JSON.parse(raw) as { code?: unknown; err_code?: unknown; message?: unknown; err_msg?: unknown };
            const code = typeof data.code === "number" ? data.code : typeof data.err_code === "number" ? data.err_code : 0;
            if (code !== 0) {
              throw new Error(String(data.message ?? data.err_msg ?? raw));
            }
          } catch (error) {
            if (error instanceof SyntaxError) {
              // 有些代理会返回纯文本成功页，忽略解析失败。
            } else {
              throw error;
            }
          }
        }
      }
      this.status.qq = { ...this.status.qq, outboundSent: this.status.qq.outboundSent + 1 };
    } catch (error) {
      this.status.qq = {
        ...this.status.qq,
        outboundFailed: this.status.qq.outboundFailed + 1,
        lastError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async qqAccessToken(appId: string, secret: string): Promise<string> {
    const cached = this.qqToken;
    if (cached && cached.appId === appId && cached.expiresAt > Date.now() + 60_000) return cached.value;
    const response = await fetch(QQ_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId, clientSecret: secret }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`获取 QQ Access Token 失败（${response.status}）`);
    const data = await response.json() as { access_token?: unknown; expires_in?: unknown; message?: unknown };
    if (typeof data.access_token !== "string") {
      throw new Error(stringValue(data.message) ?? "QQ 没有返回 Access Token");
    }
    const expiresIn = numberValue(data.expires_in) ?? 7_200;
    this.qqToken = { value: data.access_token, expiresAt: Date.now() + expiresIn * 1_000, appId };
    return data.access_token;
  }

  private startQqHeartbeat(signal: AbortSignal): void {
    if (this.qqHeartbeat) clearInterval(this.qqHeartbeat);
    this.qqHeartbeat = setInterval(() => {
      if (signal.aborted) return;
      try {
        this.qqSocket?.send(JSON.stringify({ op: 1, d: this.qqLastSeq }));
      } catch {
        // The close handler owns reconnects.
      }
    }, 25_000);
  }

  private scheduleQqReconnect(): void {
    if (this.qqReconnectTimer || this.stopping) return;
    this.qqReconnectTimer = setTimeout(() => {
      this.qqReconnectTimer = null;
      if (this.stopping) return;
      this.qqToken = null;
      this.qqAbort = new AbortController();
      void this.connectQq(this.qqAbort.signal);
    }, 5_000);
  }

  private stopQqSocket(): void {
    if (this.qqHeartbeat) clearInterval(this.qqHeartbeat);
    this.qqHeartbeat = null;
    const socket = this.qqSocket;
    this.qqSocket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // Best effort.
      }
    }
  }

  private async deliverChat(
    channel: ImChannelId,
    text: string,
    reply: (text: string) => Promise<void>
  ): Promise<void> {
    try {
      const conversationId = this.resolveConversation(channel);
      const result = await this.chatClient.send({
        conversationId,
        message: text,
        attachments: [] as ChatAttachment[]
      });
      if (result.error) {
        await reply(`处理失败：${result.error}`);
        return;
      }
      let replies = 0;
      for (const message of result.messages) {
        if (!isAssistantMessage(message) || !message.content.trim()) continue;
        if (this.sentMessageIds.has(message.id)) continue;
        this.rememberSent(message.id);
        replies += 1;
        await reply(message.content);
      }
      if (replies === 0) await reply("这一轮没有产生可发送的回复，详情请在 Hearth 对话里查看。");
    } catch (error) {
      await reply(`处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private resolveConversation(channel: ImChannelId): string {
    const current = channel === "wechat" ? this.settings.wechat.conversationId : this.settings.qq.conversationId;
    if (current) {
      const existing = this.store.getConversation(current);
      if (existing) return existing.id;
    }
    // 默认让微信和 QQ 共用同一个“IM 对话”窗口；用户也可以单独指定各自的对话。
    const sharedId = this.store.getAppSetting(SHARED_CONVERSATION_KEY);
    if (sharedId) {
      const shared = this.store.getConversation(sharedId);
      if (shared) {
        if (channel === "wechat") {
          this.settings.wechat = { ...this.settings.wechat, conversationId: shared.id };
        } else {
          this.settings.qq = { ...this.settings.qq, conversationId: shared.id };
        }
        this.persist();
        return shared.id;
      }
    }
    const conversation = this.store.createConversation("IM 对话");
    this.store.setAppSetting(SHARED_CONVERSATION_KEY, conversation.id);
    if (channel === "wechat") {
      this.settings.wechat = { ...this.settings.wechat, conversationId: conversation.id };
    } else {
      this.settings.qq = { ...this.settings.qq, conversationId: conversation.id };
    }
    this.persist();
    return conversation.id;
  }

  private enqueue(channel: ImChannelId, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(channel) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(channel, next.catch(() => undefined));
    return next;
  }

  private rememberInbound(key: string): void {
    if (this.seenInboundIds.size >= MAX_SENT_MEMORY) {
      const oldest = this.seenInboundIds.values().next().value;
      if (oldest) this.seenInboundIds.delete(oldest);
    }
    this.seenInboundIds.add(key);
  }

  private rememberSent(id: string): void {
    if (this.sentMessageIds.size >= MAX_SENT_MEMORY) {
      const oldest = this.sentMessageIds.values().next().value;
      if (oldest) this.sentMessageIds.delete(oldest);
    }
    this.sentMessageIds.add(id);
  }

  private load(): ImSettings {
    const raw = this.store.getAppSetting(SETTINGS_KEY);
    if (!raw) return cloneDefaults();
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const wechatRaw = parsed.wechat && typeof parsed.wechat === "object" ? parsed.wechat as Record<string, unknown> : {};
      const qqRaw = parsed.qq && typeof parsed.qq === "object" ? parsed.qq as Record<string, unknown> : {};
      return {
        wechat: {
          enabled: wechatRaw.enabled === true,
          tokenCipher: typeof wechatRaw.tokenCipher === "string" ? wechatRaw.tokenCipher : null,
          baseUrl: normalizeBaseUrl(typeof wechatRaw.baseUrl === "string" ? wechatRaw.baseUrl : WECHAT_DEFAULT_BASE_URL),
          accountId: typeof wechatRaw.accountId === "string" ? wechatRaw.accountId : null,
          userId: typeof wechatRaw.userId === "string" ? wechatRaw.userId : null,
          conversationId: typeof wechatRaw.conversationId === "string" ? wechatRaw.conversationId : null,
          cursor: typeof wechatRaw.cursor === "string" ? wechatRaw.cursor : "",
          updatedAt: typeof wechatRaw.updatedAt === "string" ? wechatRaw.updatedAt : null
        },
        qq: {
          enabled: qqRaw.enabled === true,
          appId: typeof qqRaw.appId === "string" ? qqRaw.appId : "",
          clientSecretCipher: typeof qqRaw.clientSecretCipher === "string" ? qqRaw.clientSecretCipher : null,
          sandbox: qqRaw.sandbox === true,
          conversationId: typeof qqRaw.conversationId === "string" ? qqRaw.conversationId : null,
          updatedAt: typeof qqRaw.updatedAt === "string" ? qqRaw.updatedAt : null
        },
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null
      };
    } catch {
      return cloneDefaults();
    }
  }

  private persist(): void {
    this.store.setAppSetting(SETTINGS_KEY, JSON.stringify(this.settings));
  }
}

function cloneDefaults(): ImSettings {
  return {
    wechat: { ...DEFAULT_SETTINGS.wechat },
    qq: { ...DEFAULT_SETTINGS.qq },
    updatedAt: null
  };
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return WECHAT_DEFAULT_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

function extractWechatText(message: Record<string, unknown>): string {
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const textItem = entry.text_item && typeof entry.text_item === "object" ? entry.text_item as Record<string, unknown> : null;
    const voiceItem = entry.voice_item && typeof entry.voice_item === "object" ? entry.voice_item as Record<string, unknown> : null;
    const text = stringValue(textItem?.text) ?? stringValue(voiceItem?.text);
    if (text?.trim()) return text.trim();
  }
  return "";
}

function splitText(text: string): string[] {
  const clean = text.trim();
  if (!clean) return [""];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > MAX_TEXT_CHARS) {
    let boundary = rest.lastIndexOf("\n", MAX_TEXT_CHARS);
    if (boundary < MAX_TEXT_CHARS * 0.6) boundary = MAX_TEXT_CHARS;
    chunks.push(rest.slice(0, boundary));
    rest = rest.slice(boundary).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function isAssistantMessage(message: ChatMessageRecord): boolean {
  return message.role === "assistant";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

declare module "fastify" {
  interface FastifyInstance {
    im: ImBridgeService;
  }
}
