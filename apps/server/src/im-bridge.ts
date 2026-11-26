import { createCipheriv, createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { defaultConversationSettings, type ChatAttachment, type ChatMessageRecord } from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";
import { LocalImChatClient, type ImChatClient } from "./im-chat-client.ts";
import { storeOutgoingAttachment } from "./chat-file-delivery.ts";
import {
  WECHAT_MAX_FILE_BYTES,
  bundlePreparedAttachments,
  prepareImAttachments,
  type PreparedImAttachment
} from "./im-media.ts";
import type { SecretBox } from "./secrets.ts";

const SETTINGS_KEY = "integrations.im.v1";
const SHARED_CONVERSATION_KEY = "integrations.im.conversationId";
const WECHAT_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const WECHAT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
// Official Weixin iLink plugin identity. File upload is gated more strictly
// than text send, so these headers must match the plugin's published values.
const WECHAT_APP_ID = "bot";
const WECHAT_APP_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 10);
const MAX_SENT_MEMORY = 2_000;
const MAX_TEXT_CHARS = 3_000;
/**
 * iLink only renders a bounded number of bot messages after one inbound. The
 * live gateway silently drops the rest, so a turn gets: 正在执行中 + 文件 + 结果.
 */
const WECHAT_MAX_MESSAGES_PER_TURN = 3;
const WECHAT_TEXT_GAP_MS = 1_800;
const WECHAT_MEDIA_GAP_MS = 5_000;

export type ImChannelId = "wechat";
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
  /** True while an inbound WeChat turn is executing. */
  running: boolean;
  /** Inbound turns accepted but not yet started. */
  queued: number;
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

interface ImSettings {
  wechat: WechatSettings;
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
  kind: "wechat-user";
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
  accountLabel: null,
  running: false,
  queued: 0
});

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

export interface ImBridgeView {
  settings: { wechat: WechatSettingsView };
  status: Record<ImChannelId, ImChannelStatus>;
  qrcode: { active: boolean; expiresAt: string | null } | null;
}

export interface ImBridgeOptions {
  store: HearthStore;
  secretBox: SecretBox;
  baseUrl: () => string;
  chatClient?: ImChatClient;
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
  private readonly chatClient: ImChatClient;
  private readonly attachmentRoot: string | null;
  private readonly now: () => Date;
  private settings: ImSettings;
  private status: Record<ImChannelId, ImChannelStatus> = {
    wechat: EMPTY_STATUS()
  };
  private wechatLoop: Promise<void> | null = null;
  private wechatAbort: AbortController | null = null;
  private wechatQr: WechatQrSession | null = null;
  private wechatContextTokens = new Map<string, string>();
  /** Per-context-token send counter + last-send time, used to respect iLink quota/rate limits. */
  private wechatUsage = new Map<string, { count: number; lastAt: number }>();
  private readonly sentMessageIds = new Set<string>();
  private readonly seenInboundIds = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private stopping = false;

  constructor(options: ImBridgeOptions) {
    this.store = options.store;
    this.secretBox = options.secretBox;
    this.baseUrl = options.baseUrl;
    this.chatClient = options.chatClient ?? new LocalImChatClient(() => this.currentBaseUrl());
    this.attachmentRoot = options.attachmentRoot?.trim() || null;
    this.now = options.now ?? (() => new Date());
    this.settings = this.load();
    this.migrateConversationTitles();
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
      wechat: { ...this.status.wechat }
    };
  }

  async connectAll(): Promise<void> {
    this.stopping = false;
    await this.startWechat();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wechatAbort?.abort();
    this.wechatAbort = null;
    this.wechatLoop = null;
    this.status.wechat = { ...this.status.wechat, running: false, queued: 0 };
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
    const projectConversationId = nextProjectId ? this.ensureProjectConversation(nextProjectId) : null;
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

  async restartWechat(): Promise<void> {
    this.wechatAbort?.abort();
    this.wechatAbort = null;
    this.wechatLoop = null;
    this.status.wechat = { ...EMPTY_STATUS(), state: this.settings.wechat.enabled ? "starting" : "disabled" };
    await this.startWechat();
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
    // Reply immediately so the user sees that the message was received before
    // the model/tool run starts. This is message 1 of the 3-message WeChat budget.
    await this.sendWechat(from, contextToken, "正在执行中…", token);
    await this.enqueue(async () => {
      await this.deliverChat(text, (reply, attachments) => this.sendWechat(from, contextToken, reply, token, attachments));
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
    const usage = this.wechatUsageFor(tokenValue);
    if (usage.count >= WECHAT_MAX_MESSAGES_PER_TURN) {
      // Do not even call the gateway: extra messages are silently dropped and
      // would make the bridge report a success that the user never sees.
      this.status.wechat = {
        ...this.status.wechat,
        outboundFailed: this.status.wechat.outboundFailed + 1,
        lastError: `微信单轮最多回复 ${WECHAT_MAX_MESSAGES_PER_TURN} 条，后续内容请在 Hearth 查看`
      };
      return;
    }
    const base = this.settings.wechat.baseUrl || WECHAT_DEFAULT_BASE_URL;
    const attachmentRoot = this.attachmentRoot ?? "";
    try {
      let items: PreparedImAttachment[] = [];
      const failures: string[] = [];
      if (attachments.length > 0) {
        const prepared = await prepareImAttachments(attachments, attachmentRoot, {
          maxBytes: WECHAT_MAX_FILE_BYTES
        });
        items = prepared.items;
        failures.push(...prepared.failures);
      }

      let file: PreparedImAttachment | null = null;
      if (items.length === 1) {
        file = items[0]!;
      } else if (items.length > 1) {
        file = bundlePreparedAttachments(items, attachmentRoot);
        if (!file) {
          file = items[0]!;
          failures.push(`其余 ${items.length - 1} 个文件超过微信单文件上限，请在 Hearth 对话中下载`);
        }
      }

      let finalText = text.trim();
      if (file?.compressed && finalText) {
        finalText = finalText.split(file.originalName).join(file.attachment.name);
        if (!finalText.includes(file.attachment.name)) {
          finalText += `\n\n已附上《${file.attachment.name}》。`;
        }
        if (file.note) finalText += `\n\n${file.note}。`;
      }
      if (failures.length > 0) {
        finalText += `${finalText ? "\n\n" : ""}文件发送提示：${failures.join("；")}。原文件可在 Hearth 对话中下载。`;
      }
      if (!finalText && !file) return;

      // File first, text second. WeChat's gateway merges back-to-back bot
      // messages; media sent after the caption is the pattern its frequency
      // control drops. This order also guarantees the file itself is attempted
      // before the remaining message budget can be spent on text.
      if (file && usage.count < WECHAT_MAX_MESSAGES_PER_TURN) {
        await this.paceWechat(tokenValue, true);
        await this.sendWechatFile(to, tokenValue, file.attachment, token, base);
        this.status.wechat = { ...this.status.wechat, outboundSent: this.status.wechat.outboundSent + 1 };
      }
      if (finalText && usage.count < WECHAT_MAX_MESSAGES_PER_TURN) {
        const message = this.wechatMessageText(finalText);
        if (message) {
          await this.paceWechat(tokenValue, false);
          await this.postWechatMessage(token, {
            from_user_id: "",
            to_user_id: to,
            client_id: randomUUID(),
            message_type: 2,
            message_state: 2,
            context_token: tokenValue,
            item_list: [{ type: 1, text_item: { text: message } }]
          });
          this.status.wechat = { ...this.status.wechat, outboundSent: this.status.wechat.outboundSent + 1 };
        }
      }
    } catch (error) {
      this.status.wechat = {
        ...this.status.wechat,
        outboundFailed: this.status.wechat.outboundFailed + 1,
        lastError: error instanceof Error ? error.message : String(error)
      };
      // A hard failure still deserves a visible error, if the 3-message budget
      // has room for one.
      if (usage.count < WECHAT_MAX_MESSAGES_PER_TURN) {
        try {
          const message = this.wechatMessageText(`执行失败：${error instanceof Error ? error.message : String(error)}`);
          await this.paceWechat(tokenValue, false);
          await this.postWechatMessage(token, {
            from_user_id: "",
            to_user_id: to,
            client_id: randomUUID(),
            message_type: 2,
            message_state: 2,
            context_token: tokenValue,
            item_list: [{ type: 1, text_item: { text: message } }]
          });
          this.status.wechat = { ...this.status.wechat, outboundSent: this.status.wechat.outboundSent + 1 };
        } catch {
          // The failure is already in lastError/status; nothing else to send.
        }
      }
    }
  }

  private wechatUsageFor(token: string): { count: number; lastAt: number } {
    let usage = this.wechatUsage.get(token);
    if (!usage) {
      if (this.wechatUsage.size >= 200) {
        const oldest = this.wechatUsage.keys().next().value;
        if (oldest) this.wechatUsage.delete(oldest);
      }
      usage = { count: 0, lastAt: 0 };
      this.wechatUsage.set(token, usage);
    }
    return usage;
  }

  private async paceWechat(token: string, media: boolean): Promise<void> {
    const usage = this.wechatUsageFor(token);
    const gap = media ? WECHAT_MEDIA_GAP_MS : WECHAT_TEXT_GAP_MS;
    const wait = usage.lastAt + gap - Date.now();
    if (wait > 0 && wait < 60_000) await new Promise((resolve) => setTimeout(resolve, wait));
    usage.lastAt = Date.now();
    usage.count += 1;
  }

  private wechatMessageText(text: string): string {
    const clean = text.trim();
    if (!clean) return "";
    if (clean.length <= MAX_TEXT_CHARS) return clean;
    return `${clean.slice(0, MAX_TEXT_CHARS - 28)}\n\n（内容较长，完整结果请在 Hearth 对话中查看）`;
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
    if (rawSize > WECHAT_MAX_FILE_BYTES) {
      throw new Error(`${attachment.name} 为 ${(rawSize / 1024 / 1024).toFixed(1)}MB，超过微信 ${WECHAT_MAX_FILE_BYTES / 1024 / 1024}MB 单文件上限`);
    }
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
    const uploadCode = numberValue(uploadInfo.ret) ?? numberValue(uploadInfo.errcode);
    if (!response.ok || (uploadCode !== null && uploadCode !== 0)) {
      throw new Error(stringValue(uploadInfo.errmsg) ?? `微信文件上传申请失败 ${response.status}`);
    }
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

  private async deliverChat(
    text: string,
    reply: (text: string, attachments?: ChatAttachment[]) => Promise<void>
  ): Promise<void> {
    try {
      const conversationId = this.resolveConversation();
      let taskId: string | null = null;
      // IM does not stream token-by-token: every delta is a separate outbound
      // message and would exhaust WeChat's 3-message-per-turn budget before the
      // file attachment is reached. The user gets one status message, then one
      // final result message (plus at most one file message).
      const result = await this.chatClient.send({
        conversationId,
        message: text,
        attachments: [] as ChatAttachment[]
      }, {
        onTask: (payload) => {
          const task = isRecord(payload) && isRecord(payload.task) ? payload.task : null;
          if (task && typeof task.id === "string" && task.id.trim()) taskId = task.id;
        }
      });
      if (result.error) {
        await reply(`执行失败：${result.error}`);
        return;
      }
      let finalMessage: ChatMessageRecord | null = null;
      for (const message of result.messages) {
        if (message.taskId && !taskId) taskId = message.taskId;
        if (!isAssistantMessage(message) || message.kind === "task_status") continue;
        // "已派出任务：…" is an acknowledgement, not the result. In IM we only
        // send the final conclusion (or question/failure) for this turn.
        if (message.content.trim().startsWith("已派出任务：")) continue;
        finalMessage = message;
      }
      if (taskId) {
        await this.waitForTaskConclusion(taskId, conversationId, reply);
        return;
      }
      if (!finalMessage) return;
      if (this.sentMessageIds.has(finalMessage.id) && finalMessage.attachments.length === 0) return;
      this.rememberSent(finalMessage.id);
      await reply(finalMessage.content, finalMessage.attachments);
    } catch (error) {
      await reply(`执行失败：${error instanceof Error ? error.message : String(error)}`);
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
        await reply("执行失败：任务记录不存在。");
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
        await reply(summary || "任务已完成，详情请在 Hearth 对话里查看。", this.taskDeliverableAttachments(taskId, finalMessage?.attachments ?? []));
        return;
      }
      if (task.status === "cancelled") {
        await reply(summary || "任务已取消。");
        return;
      }
      const reason = task.error?.message ? `${task.error.message}` : summary;
      await reply(reason ? `执行失败：${reason}` : "执行失败：任务没有完成。");
      return;
    }
    await reply("任务还在执行，可稍后在 Hearth 对话里查看结果。");
  }

  /**
   * IM 侧要拿到真正的文件本体：任务产物在 artifacts 目录里，先复制成对话附件，
   * 后续微信才能按 media 上传，而不是只回复一个文件名。
   */
  private taskDeliverableAttachments(taskId: string, existing: ChatAttachment[]): ChatAttachment[] {
    const root = this.attachmentRoot;
    if (!root) return existing;
    const seen = new Set(existing.map((item) => item.name));
    const result = [...existing];
    try {
      const artifacts = this.store.listArtifacts(taskId)
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
        .slice(0, 6);
      for (const artifact of artifacts) {
        if (seen.has(artifact.relativePath.split(/[\\/]/).pop() ?? "")) continue;
        try {
          const attachment = storeOutgoingAttachment(artifact.absolutePath, root);
          if (seen.has(attachment.name)) continue;
          seen.add(attachment.name);
          result.push(attachment);
        } catch {
          // 单个产物不可读不影响其余文件发送。
        }
      }
    } catch {
      // 没有 artifact 记录时只发送已有的对话附件。
    }
    return result.slice(0, 6);
  }


  private resolveConversation(): string {
    const configured = this.settings.wechat;
    if (configured.projectId) {
      const projectConversationId = this.ensureProjectConversation(configured.projectId);
      if (configured.conversationId !== projectConversationId) {
        this.settings.wechat = { ...this.settings.wechat, conversationId: projectConversationId };
        this.persist();
      }
      return projectConversationId;
    }
    const current = configured.conversationId;
    if (current) {
      const existing = this.store.getConversation(current);
      if (existing) return existing.id;
    }
    // A project-bound WeChat channel gets its own dedicated conversation above,
    // so project context never leaks into the ordinary WeChat IM chat.
    const sharedId = this.store.getAppSetting(SHARED_CONVERSATION_KEY);
    if (sharedId) {
      const shared = this.store.getConversation(sharedId);
      if (shared) {
        this.settings.wechat = { ...this.settings.wechat, conversationId: shared.id };
        this.persist();
        return shared.id;
      }
    }
    const conversation = this.store.createConversation("微信IM");
    this.store.setAppSetting(SHARED_CONVERSATION_KEY, conversation.id);
    this.settings.wechat = { ...this.settings.wechat, conversationId: conversation.id };
    this.persist();
    return conversation.id;
  }

  /**
   * Project-bound IM always owns a dedicated conversation. The mapping is
   * persisted, so later messages stay in the same window even after restarts.
   */
  private ensureProjectConversation(projectId: string): string {
    const project = this.store.getLocalProject(projectId);
    if (!project) throw new ImBridgeError("PROJECT_NOT_FOUND", "绑定的项目不存在", 404);
    const current = this.settings.wechat;
    if (current.conversationId) {
      const existing = this.store.getConversation(current.conversationId);
      if (existing?.projectId === projectId) {
        this.renameFromLegacyTitle(existing.id, existing.title);
        return existing.id;
      }
    }
    const key = `integrations.im.project.${projectId}`;
    const savedId = this.store.getAppSetting(key);
    if (savedId) {
      const saved = this.store.getConversation(savedId);
      if (saved?.projectId === projectId) {
        this.renameFromLegacyTitle(saved.id, saved.title);
        return saved.id;
      }
    }
    const conversation = this.store.createConversation(
      `微信IM · ${project.name}`,
      defaultConversationSettings(),
      projectId
    );
    this.store.setAppSetting(key, conversation.id);
    return conversation.id;
  }

  /**
   * Old databases still carry the "IM 对话" / "IM · X" titles. Renaming the
   * conversations the IM bridge owns is idempotent and keeps ordinary chats untouched.
   */
  private migrateConversationTitles(): void {
    const candidates = new Set<string>();
    const sharedId = this.store.getAppSetting(SHARED_CONVERSATION_KEY);
    if (sharedId) candidates.add(sharedId);
    if (this.settings.wechat.conversationId) candidates.add(this.settings.wechat.conversationId);
    for (const conversation of this.store.listConversations()) {
      if (conversation.projectId && conversation.title.startsWith("IM · ")) candidates.add(conversation.id);
    }
    for (const id of candidates) {
      const conversation = this.store.getConversation(id);
      if (conversation) this.renameFromLegacyTitle(id, conversation.title);
    }
  }

  private renameFromLegacyTitle(conversationId: string, title: string): void {
    if (title === "IM 对话") {
      this.store.renameConversation(conversationId, "微信IM");
    } else if (title.startsWith("IM · ")) {
      this.store.renameConversation(conversationId, `微信IM · ${title.slice(5)}`);
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.status.wechat = { ...this.status.wechat, queued: this.status.wechat.queued + 1 };
    const run = async (): Promise<void> => {
      this.status.wechat = {
        ...this.status.wechat,
        queued: Math.max(0, this.status.wechat.queued - 1),
        running: true
      };
      try {
        await task();
      } finally {
        this.status.wechat = { ...this.status.wechat, running: false };
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
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
      if ("qq" in parsed) {
        // Drop the retired QQ block (including its encrypted secret) on the next read.
        this.store.setAppSetting(SETTINGS_KEY, JSON.stringify({ wechat: wechatRaw, updatedAt: parsed.updatedAt ?? null }));
      }
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
