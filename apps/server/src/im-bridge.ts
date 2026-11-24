import { createCipheriv, createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { defaultConversationSettings, type ChatAttachment, type ChatMessageRecord } from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";
import { LocalFeishuChatClient, type FeishuChatClient } from "./feishu.ts";
import type { SecretBox } from "./secrets.ts";

const SETTINGS_KEY = "integrations.im.v1";
const SHARED_CONVERSATION_KEY = "integrations.im.conversationId";
const WECHAT_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const WECHAT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const QQ_TOKEN_URL = "https://api.bot.qq.com/app/getAppAccessToken";
const QQ_API_BASE = "https://api.bot.qq.com";
const QQ_SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com";
// Official Weixin iLink plugin identity. File upload is gated more strictly
// than text send, so these headers must match the plugin's published values.
const WECHAT_APP_ID = "bot";
const WECHAT_APP_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 10);
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
  projectId: string | null;
  cursor: string;
  updatedAt: string | null;
}

interface QqSettings {
  enabled: boolean;
  appId: string;
  clientSecretCipher: string | null;
  sandbox: boolean;
  conversationId: string | null;
  projectId: string | null;
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
    projectId: null,
    cursor: "",
    updatedAt: null
  },
  qq: {
    enabled: false,
    appId: "",
    clientSecretCipher: null,
    sandbox: false,
    conversationId: null,
    projectId: null,
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

/** WeChat cannot edit an existing bubble, so live output is split into
 * sentence-sized messages as the model produces them. */
class ImDeltaStream {
  private buffer = "";
  private sent = "";
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;
  private finishing = false;

  constructor(
    private readonly reply: (text: string) => Promise<void>,
    private readonly timerMs = 850
  ) {}

  push(text: string): void {
    if (!text || this.finishing) return;
    this.buffer += text;
    this.schedule();
    void this.pump(false);
  }

  async finish(): Promise<string> {
    this.finishing = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.pump(true, true);
    await this.chain;
    return this.sent;
  }

  /** Text still missing after the live chunks, so the final answer is not repeated. */
  remainingFor(finalText: string): string {
    const sent = this.sent;
    if (!sent.trim()) return finalText;
    if (finalText === sent) return "";
    if (finalText.startsWith(sent)) return finalText.slice(sent.length);
    const trimmedSent = sent.trim();
    const trimmedFinal = finalText.trim();
    if (trimmedFinal === trimmedSent) return "";
    if (trimmedFinal.startsWith(trimmedSent)) {
      const index = finalText.indexOf(trimmedSent);
      return index >= 0 ? finalText.slice(index + trimmedSent.length) : "";
    }
    return "";
  }

  private schedule(): void {
    if (this.finishing || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump(true);
    }, this.timerMs);
  }

  private async pump(timerTick: boolean, force = false): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      let emitted = 0;
      while (force || emitted < 5) {
        const cut = streamChunkCut(this.buffer, force ? "force" : timerTick && emitted === 0 ? "timer" : "normal");
        if (cut <= 0) break;
        const chunk = this.buffer.slice(0, cut);
        this.buffer = this.buffer.slice(cut);
        emitted += 1;
        if (!chunk.trim()) continue;
        this.sent += chunk;
        this.chain = this.chain.then(() => this.reply(chunk)).catch(() => undefined);
        timerTick = false;
      }
    } finally {
      this.pumping = false;
      if (this.buffer && !this.finishing) this.schedule();
    }
  }
}

function streamChunkCut(buffer: string, mode: "normal" | "timer" | "force"): number {
  if (!buffer) return 0;
  if (mode === "force") return buffer.length;
  const window = buffer.slice(0, 260);
  const boundary = Math.max(
    window.lastIndexOf("\n"),
    window.lastIndexOf("。"),
    window.lastIndexOf("！"),
    window.lastIndexOf("？"),
    window.lastIndexOf("；"),
    window.lastIndexOf("!"),
    window.lastIndexOf("?")
  );
  if (boundary >= 6) return boundary + 1;
  if (mode === "timer" && buffer.length >= 16) {
    const whitespace = window.lastIndexOf(" ");
    return whitespace >= 8 ? whitespace + 1 : Math.min(buffer.length, 80);
  }
  if (buffer.length >= 180) {
    const whitespace = window.lastIndexOf(" ");
    return whitespace >= 60 ? whitespace + 1 : 180;
  }
  return 0;
}


export interface WechatSettingsView {
  enabled: boolean;
  hasToken: boolean;
  baseUrl: string;
  accountId: string | null;
  userId: string | null;
  conversationId: string | null;
  conversationTitle: string | null;
  projectId: string | null;
  projectTitle: string | null;
  updatedAt: string | null;
}

export interface QqSettingsView {
  enabled: boolean;
  appId: string;
  hasClientSecret: boolean;
  sandbox: boolean;
  conversationId: string | null;
  conversationTitle: string | null;
  projectId: string | null;
  projectTitle: string | null;
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
  attachmentRoot?: string;
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
  private readonly attachmentRoot: string | null;
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
    this.attachmentRoot = options.attachmentRoot?.trim() || null;
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
    const projectTitle = (projectId: string | null): string | null =>
      projectId ? this.store.getLocalProject(projectId)?.name ?? null : null;
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
          projectId: this.settings.wechat.projectId,
          projectTitle: projectTitle(this.settings.wechat.projectId),
          updatedAt: this.settings.wechat.updatedAt
        },
        qq: {
          enabled: this.settings.qq.enabled,
          appId: this.settings.qq.appId,
          hasClientSecret: Boolean(this.settings.qq.clientSecretCipher),
          sandbox: this.settings.qq.sandbox,
          conversationId: this.settings.qq.conversationId,
          conversationTitle: qqConversation?.title ?? null,
          projectId: this.settings.qq.projectId,
          projectTitle: projectTitle(this.settings.qq.projectId),
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
    projectId?: string | null | undefined;
  }): void {
    const current = this.settings.wechat;
    const nextProjectId = patch.projectId !== undefined ? patch.projectId || null : current.projectId;
    const projectConversationId = nextProjectId ? this.ensureProjectConversation("wechat", nextProjectId) : null;
    const next: WechatSettings = {
      ...current,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.baseUrl !== undefined ? { baseUrl: normalizeBaseUrl(patch.baseUrl) } : {}),
      ...(nextProjectId
        ? { projectId: nextProjectId, conversationId: projectConversationId }
        : {
            projectId: null,
            conversationId: patch.conversationId !== undefined
              ? patch.conversationId || null
              : current.projectId
                ? null
                : current.conversationId
          }),
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
    projectId?: string | null | undefined;
  }): void {
    const current = this.settings.qq;
    const nextProjectId = patch.projectId !== undefined ? patch.projectId || null : current.projectId;
    const projectConversationId = nextProjectId ? this.ensureProjectConversation("qq", nextProjectId) : null;
    const next: QqSettings = {
      ...current,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.appId !== undefined ? { appId: patch.appId.trim() } : {}),
      ...(patch.clientSecret !== undefined && patch.clientSecret.trim()
        ? { clientSecretCipher: this.secretBox.encrypt(patch.clientSecret.trim()) }
        : {}),
      ...(patch.sandbox !== undefined ? { sandbox: patch.sandbox } : {}),
      ...(nextProjectId
        ? { projectId: nextProjectId, conversationId: projectConversationId }
        : {
            projectId: null,
            conversationId: patch.conversationId !== undefined
              ? patch.conversationId || null
              : current.projectId
                ? null
                : current.conversationId
          })
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
      await this.deliverChat("wechat", text, (reply) => this.sendWechat(from, contextToken, reply, token));
    });
  }

  private async sendWechat(
    to: string,
    contextToken: string | null,
    text: string,
    token: string,
    attachments: ChatAttachment[] = []
  ): Promise<void> {
    const tokenValue = contextToken ?? this.wechatContextTokens.get(to) ?? "";
    if (!tokenValue) {
      this.status.wechat = { ...this.status.wechat, outboundFailed: this.status.wechat.outboundFailed + 1, lastError: "缺少微信 context_token，无法回复" };
      return;
    }
    const base = this.settings.wechat.baseUrl || WECHAT_DEFAULT_BASE_URL;
    try {
      if (text.trim()) {
        for (const chunk of splitText(text)) {
          if (!chunk.trim()) continue;
          await this.postWechatMessage(token, {
            from_user_id: "",
            to_user_id: to,
            client_id: randomUUID(),
            message_type: 2,
            message_state: 2,
            context_token: tokenValue,
            item_list: [{ type: 1, text_item: { text: chunk } }]
          });
        }
      }
      for (const attachment of attachments.slice(0, 6)) {
        await this.sendWechatFile(to, tokenValue, attachment, token, base);
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

  private async postWechatMessage(token: string, msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const base = this.settings.wechat.baseUrl || WECHAT_DEFAULT_BASE_URL;
    const response = await fetch(`${base}/ilink/bot/sendmessage`, {
      method: "POST",
      headers: this.wechatHeaders(token),
      body: JSON.stringify({
        msg,
        base_info: { channel_version: "hearth/1.0", bot_agent: "Hearth" }
      }),
      signal: AbortSignal.timeout(20_000)
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    const code = numberValue(data.errcode) ?? numberValue(data.ret);
    if (!response.ok || (code !== null && code !== 0)) {
      throw new Error(stringValue(data.errmsg) ?? `微信发送接口返回 ${response.status}`);
    }
    return data;
  }

  private async sendWechatFile(
    to: string,
    contextToken: string,
    attachment: ChatAttachment,
    token: string,
    base: string
  ): Promise<void> {
    const filePath = this.findAttachmentPath(attachment.id);
    if (!filePath) throw new Error(`附件已失效：${attachment.name}`);
    const plaintext = readFileSync(filePath);
    const rawSize = plaintext.byteLength;
    if (rawSize <= 0) throw new Error(`附件为空：${attachment.name}`);
    const rawMd5 = createHash("md5").update(plaintext).digest("hex");
    const aesKey = randomBytes(16);
    const fileKey = randomBytes(16).toString("hex");
    const paddedSize = Math.ceil((rawSize + 1) / 16) * 16;
    const response = await fetch(`${base}/ilink/bot/getuploadurl`, {
      method: "POST",
      headers: this.wechatHeaders(token),
      body: JSON.stringify({
        filekey: fileKey,
        media_type: 3,
        to_user_id: to,
        rawsize: rawSize,
        rawfilemd5: rawMd5,
        filesize: paddedSize,
        no_need_thumb: true,
        aeskey: aesKey.toString("hex"),
        base_info: { channel_version: "hearth/1.0", bot_agent: "Hearth" }
      }),
      signal: AbortSignal.timeout(30_000)
    });
    const uploadInfo = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(stringValue(uploadInfo.errmsg) ?? `微信文件上传申请失败 ${response.status}`);
    const uploadFullUrl = stringValue(uploadInfo.upload_full_url)?.trim();
    const uploadParam = stringValue(uploadInfo.upload_param);
    if (!uploadFullUrl && !uploadParam) throw new Error("微信没有返回文件上传地址");

    const cipher = createCipheriv("aes-128-ecb", aesKey, null);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const uploadUrl = uploadFullUrl
      || `${WECHAT_CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam ?? "")}&filekey=${encodeURIComponent(fileKey)}`;
    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: ciphertext,
      signal: AbortSignal.timeout(120_000)
    });
    if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
      const reason = uploadResponse.headers.get("x-error-message")
        ?? await uploadResponse.text().catch(() => "")
        ?? "";
      throw new Error(`微信 CDN 上传失败 ${uploadResponse.status}${reason ? `：${reason}` : ""}`);
    }
    const downloadParam = uploadResponse.headers.get("x-encrypted-param");
    if (!downloadParam) throw new Error("微信 CDN 没有返回文件下载参数");

    await this.postWechatMessage(token, {
      from_user_id: "",
      to_user_id: to,
      client_id: randomUUID(),
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{
        type: 4,
        file_item: {
          media: {
            encrypt_query_param: downloadParam,
            aes_key: Buffer.from(aesKey.toString("hex"), "utf8").toString("base64"),
            encrypt_type: 1
          },
          file_name: attachment.name,
          len: String(rawSize)
        }
      }]
    });
  }

  private findAttachmentPath(id: string): string | null {
    const root = this.attachmentRoot;
    if (!root || !existsSync(root)) return null;
    const safe = id.replace(/[^0-9a-fA-F-]/g, "");
    if (safe !== id) return null;
    try {
      const file = readdirSync(root).find((name) => name.startsWith(`${safe}.`));
      if (!file) return null;
      const path = join(root, file);
      return statSync(path).isFile() ? path : null;
    } catch {
      return null;
    }
  }

  private wechatHeaders(token: string): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${token}`,
      "iLink-App-Id": WECHAT_APP_ID,
      "iLink-App-ClientVersion": WECHAT_APP_CLIENT_VERSION,
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
    reply: (text: string, attachments?: ChatAttachment[]) => Promise<void>
  ): Promise<void> {
    try {
      const conversationId = this.resolveConversation(channel);
      let taskId: string | null = null;
      const stream = channel === "wechat"
        ? new ImDeltaStream((chunk) => reply(chunk))
        : null;
      const result = await this.chatClient.send({
        conversationId,
        message: text,
        attachments: [] as ChatAttachment[]
      }, {
        onTask: (payload) => {
          const task = isRecord(payload) && isRecord(payload.task) ? payload.task : null;
          if (task && typeof task.id === "string" && task.id.trim()) taskId = task.id;
        },
        onDelta: (delta) => {
          stream?.push(delta);
        }
      }).finally(async () => {
        await stream?.finish();
      });
      if (result.error) {
        await reply(`处理失败：${result.error}`);
        return;
      }
      let replies = 0;
      for (const message of result.messages) {
        if (message.taskId && !taskId) taskId = message.taskId;
        // Progress/status messages are not answers. IM only receives the final
        // conclusion, question, or failure for this turn.
        if (!isAssistantMessage(message) || message.kind === "task_status") continue;
        const content = stream ? stream.remainingFor(message.content) : message.content;
        if (!content.trim() && message.attachments.length === 0) continue;
        if (this.sentMessageIds.has(message.id) && message.attachments.length === 0) continue;
        if (!this.sentMessageIds.has(message.id)) this.rememberSent(message.id);
        replies += 1;
        await reply(content, message.attachments);
      }
      if (taskId) {
        await this.waitForTaskConclusion(taskId, conversationId, reply);
      } else if (replies === 0) {
        // A direct chat should always produce an assistant message. Stay silent on
        // empty status-only turns rather than sending a synthetic "processing" line.
        return;
      }
    } catch (error) {
      await reply(`处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async waitForTaskConclusion(
    taskId: string,
    conversationId: string,
    reply: (text: string, attachments?: ChatAttachment[]) => Promise<void>
  ): Promise<void> {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const task = this.store.getTask(taskId);
      if (!task) {
        await reply("处理失败：任务记录不存在。");
        return;
      }
      const terminal = task.status === "completed"
        || task.status === "failed"
        || task.status === "cancelled"
        || task.status === "waiting_input"
        || task.status === "waiting_approval";
      if (!terminal) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      if (task.status === "waiting_approval") {
        await reply(`任务「${task.title}」需要你在 Hearth 确认外部动作后才能继续。`);
        return;
      }
      const finalMessage = this.store.listChatMessages(conversationId)
        .filter((message) => message.taskId === taskId && message.role === "assistant" && message.kind !== "task_status")
        .at(-1);
      const summary = task.resultSummary?.trim()
        || finalMessage?.content.trim()
        || "";
      if (task.status === "waiting_input") {
        await reply(summary || "需要你补充一些信息才能继续。");
        return;
      }
      if (task.status === "completed") {
        await reply(summary || "任务已完成，详情请在 Hearth 对话里查看。", finalMessage?.attachments ?? []);
        return;
      }
      if (task.status === "cancelled") {
        await reply(summary || "任务已取消。");
        return;
      }
      const reason = task.error?.message ? `${task.error.message}` : summary;
      await reply(reason ? `处理失败：${reason}` : "处理失败：任务没有完成。");
      return;
    }
    await reply("任务还在执行，可稍后在 Hearth 对话里查看结果。");
  }

  private resolveConversation(channel: ImChannelId): string {
    const configured = channel === "wechat" ? this.settings.wechat : this.settings.qq;
    if (configured.projectId) {
      const projectConversationId = this.ensureProjectConversation(channel, configured.projectId);
      if (configured.conversationId !== projectConversationId) {
        if (channel === "wechat") {
          this.settings.wechat = { ...this.settings.wechat, conversationId: projectConversationId };
        } else {
          this.settings.qq = { ...this.settings.qq, conversationId: projectConversationId };
        }
        this.persist();
      }
      return projectConversationId;
    }
    const current = configured.conversationId;
    if (current) {
      const existing = this.store.getConversation(current);
      if (existing) return existing.id;
    }
    // Default: WeChat and QQ share one "IM 对话" window. A project-bound channel
    // gets its own dedicated conversation above, so project context never leaks
    // into ordinary IM chats.
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

  /**
   * Project-bound IM always owns a dedicated conversation. The mapping is
   * persisted, so later messages stay in the same window even after restarts.
   */
  private ensureProjectConversation(channel: ImChannelId, projectId: string): string {
    const project = this.store.getLocalProject(projectId);
    if (!project) throw new ImBridgeError("PROJECT_NOT_FOUND", "绑定的项目不存在", 404);
    const current = channel === "wechat" ? this.settings.wechat : this.settings.qq;
    if (current.conversationId) {
      const existing = this.store.getConversation(current.conversationId);
      if (existing?.projectId === projectId) return existing.id;
    }
    const key = `integrations.im.project.${projectId}`;
    const savedId = this.store.getAppSetting(key);
    if (savedId) {
      const saved = this.store.getConversation(savedId);
      if (saved?.projectId === projectId) return saved.id;
    }
    const conversation = this.store.createConversation(
      `IM · ${project.name}`,
      defaultConversationSettings(),
      projectId
    );
    this.store.setAppSetting(key, conversation.id);
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
          projectId: typeof wechatRaw.projectId === "string" ? wechatRaw.projectId : null,
          cursor: typeof wechatRaw.cursor === "string" ? wechatRaw.cursor : "",
          updatedAt: typeof wechatRaw.updatedAt === "string" ? wechatRaw.updatedAt : null
        },
        qq: {
          enabled: qqRaw.enabled === true,
          appId: typeof qqRaw.appId === "string" ? qqRaw.appId : "",
          clientSecretCipher: typeof qqRaw.clientSecretCipher === "string" ? qqRaw.clientSecretCipher : null,
          sandbox: qqRaw.sandbox === true,
          conversationId: typeof qqRaw.conversationId === "string" ? qqRaw.conversationId : null,
          projectId: typeof qqRaw.projectId === "string" ? qqRaw.projectId : null,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
