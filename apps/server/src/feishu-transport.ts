import type { FeishuInboundMessage, FeishuTransport, FeishuTransportCallbacks, FeishuTransportSettings } from "./feishu.ts";
import { parseFeishuMessage } from "./feishu-parse.ts";

const FEISHU_BASE = "https://open.feishu.cn";
const LARK_BASE = "https://open.larksuite.com";

export class FeishuApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FeishuApiError";
    this.code = code;
  }
}

export class FeishuApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private tokenValue: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly settings: Pick<FeishuTransportSettings, "appId" | "appSecret" | "domain">,
    fetchImpl: typeof fetch = fetch
  ) {
    this.baseUrl = settings.domain === "lark" ? LARK_BASE : FEISHU_BASE;
    this.fetchImpl = fetchImpl;
  }

  async verify(): Promise<void> {
    await this.tenantToken();
  }

  async tenantToken(): Promise<string> {
    if (this.tokenValue && Date.now() < this.tokenExpiresAt - 30_000) return this.tokenValue;
    const response = await this.fetchImpl(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: this.settings.appId, app_secret: this.settings.appSecret })
    });
    const body = await parseJson(response);
    if (!response.ok || body.code !== 0 || typeof body.tenant_access_token !== "string") {
      throw new FeishuApiError(
        `FEISHU_AUTH_${body.code ?? response.status}`,
        typeof body.msg === "string" ? body.msg : `飞书鉴权失败（${response.status}）`
      );
    }
    this.tokenValue = body.tenant_access_token;
    this.tokenExpiresAt = Date.now() + (typeof body.expire === "number" ? body.expire : 7200) * 1000;
    return this.tokenValue;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const token = await this.tenantToken();
    const response = await this.fetchImpl(`${this.baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text })
      })
    });
    const body = await parseJson(response);
    if (!response.ok || body.code !== 0) {
      throw new FeishuApiError(
        `FEISHU_SEND_${body.code ?? response.status}`,
        typeof body.msg === "string" ? body.msg : `飞书消息发送失败（${response.status}）`
      );
    }
  }

  async download(messageId: string, fileKey: string, type: "image" | "file"): Promise<{ buffer: Buffer; mimeType: string }> {
    const token = await this.tenantToken();
    const response = await this.fetchImpl(
      `${this.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${type}`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new FeishuApiError(`FEISHU_DOWNLOAD_${response.status}`, body || `飞书资源下载失败（${response.status}）`);
    }
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type") ?? "application/octet-stream"
    };
  }
}

export class SdkFeishuTransport implements FeishuTransport {
  private readonly api: FeishuApi;
  private client: { start(params: { eventDispatcher: unknown }): Promise<void>; close(params?: { force?: boolean }): void } | null = null;

  constructor(
    private readonly settings: FeishuTransportSettings,
    private readonly callbacks: FeishuTransportCallbacks = {}
  ) {
    this.api = new FeishuApi(settings);
  }

  async start(onMessage: (message: FeishuInboundMessage) => void): Promise<void> {
    const lark = await import("@larksuiteoapi/node-sdk");
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": (data: unknown) => {
        // ACK immediately: Feishu retries when the handler takes more than 3s.
        try {
          const parsed = parseFeishuMessage(data);
          if (parsed) onMessage(parsed);
        } catch {
          // Malformed events must not break the long connection.
        }
      }
    });
    const client = new lark.WSClient({
      appId: this.settings.appId,
      appSecret: this.settings.appSecret,
      domain: this.settings.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
      autoReconnect: true,
      handshakeTimeoutMs: 15_000,
      onReady: () => this.callbacks.onConnected?.(),
      onReconnected: () => this.callbacks.onConnected?.(),
      onReconnecting: () => this.callbacks.onReconnecting?.(),
      onError: (error: Error) => this.callbacks.onError?.(error.message)
    });
    this.client = client;
    await client.start({ eventDispatcher: dispatcher });
  }

  async stop(): Promise<void> {
    try {
      this.client?.close({ force: true });
    } finally {
      this.client = null;
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    await this.api.sendText(chatId, text);
  }

  async downloadResource(messageId: string, key: string, type: "image" | "file"): Promise<{ buffer: Buffer; mimeType: string }> {
    return this.api.download(messageId, key, type);
  }
}

export async function verifyFeishuCredentials(
  settings: FeishuTransportSettings,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; error?: string; elapsedMs: number }> {
  const started = Date.now();
  try {
    await new FeishuApi(settings, fetchImpl).verify();
    return { ok: true, elapsedMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - started
    };
  }
}

function parseJson(response: Response): Promise<Record<string, unknown>> {
  return response.text().then((text) => {
    try {
      const value = JSON.parse(text) as unknown;
      return value && typeof value === "object" ? value as Record<string, unknown> : {};
    } catch {
      return { msg: text.slice(0, 500) };
    }
  });
}