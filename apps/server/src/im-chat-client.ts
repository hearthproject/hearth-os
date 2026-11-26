import type { ChatAttachment, ChatMessageRecord } from "@hearth/core";

export interface ImChatResult {
  conversationId: string;
  messages: ChatMessageRecord[];
  error: string | null;
}

export interface ImChatClient {
  send(
    input: { conversationId?: string | undefined; message: string; attachments: ChatAttachment[] },
    hooks?: {
      onTask?: (payload: unknown) => void;
      /** Incremental assistant text as the model emits it, for IM streaming. */
      onDelta?: (text: string) => void;
    }
  ): Promise<ImChatResult>;
}

export class ImChatError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 500) {
    super(message);
    this.name = "ImChatError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** Uses this Hearth instance's own `/api/chat` SSE endpoint; not a remote service. */
export class LocalImChatClient implements ImChatClient {
  constructor(
    private readonly baseUrl: () => string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async send(
    input: { conversationId?: string | undefined; message: string; attachments: ChatAttachment[] },
    hooks: { onTask?: (payload: unknown) => void; onDelta?: (text: string) => void } = {}
  ): Promise<ImChatResult> {
    const base = this.baseUrl();
    if (!base) throw new ImChatError("IM_NOT_READY", "Hearth 本机服务尚未就绪", 503);
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
      throw new ImChatError("IM_CHAT_FAILED", text || `Hearth 聊天接口返回 ${response.status}`, response.status);
    }
    if (!response.body) throw new ImChatError("IM_CHAT_FAILED", "Hearth 聊天接口没有返回事件流");

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
          } else if (parsed.event === "delta") {
            const text = typeof parsed.data.text === "string" ? parsed.data.text : "";
            if (text) hooks.onDelta?.(text);
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
    if (!conversationId) throw new ImChatError("IM_CHAT_FAILED", error ?? "Hearth 没有返回对话标识");
    return { conversationId, messages, error };
  }
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
