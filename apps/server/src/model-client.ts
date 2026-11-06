import type { ModelSettings } from "./model-settings.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class ModelClientError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = "ModelClientError";
    this.code = code;
    this.status = status;
  }
}

export interface CompleteOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CompleteResult {
  content: string;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export async function completeChat(
  settings: ModelSettings,
  messages: ChatMessage[],
  options: CompleteOptions = {}
): Promise<CompleteResult> {
  assertConfigured(settings);
  const response = await fetch(chatCompletionsUrl(settings.baseUrl), {
    method: "POST",
    headers: requestHeaders(settings),
    body: JSON.stringify({
      model: settings.model,
      messages,
      stream: false,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 1_200
    }),
    signal: withTimeout(options.signal, options.timeoutMs ?? 60_000)
  });
  const payload = await readJson(response);
  if (!response.ok) throw apiError(response.status, payload);
  const content = String(payload?.choices?.[0]?.message?.content ?? "");
  return { content, usage: readUsage(payload?.usage) };
}

export async function streamChat(
  settings: ModelSettings,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  options: CompleteOptions = {}
): Promise<CompleteResult> {
  assertConfigured(settings);
  const response = await fetch(chatCompletionsUrl(settings.baseUrl), {
    method: "POST",
    headers: requestHeaders(settings),
    body: JSON.stringify({
      model: settings.model,
      messages,
      stream: true,
      temperature: options.temperature ?? 0.5
    }),
    signal: withTimeout(options.signal, options.timeoutMs ?? 180_000)
  });
  if (!response.ok) {
    const payload = await readJson(response);
    throw apiError(response.status, payload);
  }
  if (!response.body) throw new ModelClientError("EMPTY_RESPONSE", "模型服务没有返回内容");
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const payload = await readJsonFromText(await response.text());
    const content = String(payload?.choices?.[0]?.message?.content ?? "");
    if (!content) throw apiError(response.status, payload);
    onDelta(content);
    return { content, usage: readUsage(payload?.usage) };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage: CompleteResult["usage"] = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") {
          const payload = safeJson(data);
          const choice = payload?.choices?.[0];
          const delta = typeof choice?.delta?.content === "string"
            ? choice.delta.content
            : typeof choice?.message?.content === "string"
              ? choice.message.content
              : "";
          if (delta) {
            content += delta;
            onDelta(delta);
          }
          const chunkUsage = readUsage(payload?.usage);
          if (chunkUsage) usage = chunkUsage;
        }
      }
      newline = buffer.indexOf("\n");
    }
  }
  if (!content.trim()) throw new ModelClientError("EMPTY_RESPONSE", "模型没有返回文字内容");
  return { content, usage };
}

export async function listModels(settings: ModelSettings, timeoutMs = 30_000): Promise<string[]> {
  assertConfigured({ ...settings, model: settings.model || "unused" });
  const base = settings.baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  const response = await fetch(`${base}/models`, {
    headers: requestHeaders(settings),
    signal: withTimeout(undefined, timeoutMs)
  });
  const payload = await readJson(response);
  if (!response.ok) throw apiError(response.status, payload);
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return list
    .map((item: unknown) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "id" in item) return String((item as { id: unknown }).id);
      return "";
    })
    .filter((id: string) => id.length > 0)
    .sort((a: string, b: string) => a.localeCompare(b));
}

export function assertConfigured(settings: ModelSettings): void {
  if (!settings.baseUrl) throw new ModelClientError("MODEL_NOT_CONFIGURED", "还没有填写模型服务地址");
  if (!settings.model) throw new ModelClientError("MODEL_NOT_CONFIGURED", "还没有填写模型名称");
  if (!settings.apiKey) throw new ModelClientError("MODEL_NOT_CONFIGURED", "还没有填写 API Key");
}

function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function requestHeaders(settings: ModelSettings): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${settings.apiKey}`,
    "user-agent": "Hearth/0.1"
  };
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readJson(response: Response): Promise<Record<string, any> | null> {
  try {
    return await readJsonFromText(await response.text());
  } catch {
    return null;
  }
}

function readJsonFromText(text: string): Record<string, any> | null {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return null;
  }
}

function safeJson(text: string): Record<string, any> | null {
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return null;
  }
}

function apiError(status: number, payload: Record<string, any> | null): ModelClientError {
  const detail = payload?.error?.message ?? payload?.message ?? payload?.error;
  const message = typeof detail === "string" && detail.trim()
    ? detail
    : `模型服务返回了 ${status}`;
  return new ModelClientError("MODEL_REQUEST_FAILED", message, status);
}

function readUsage(usage: any): CompleteResult["usage"] {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return null;
  return { inputTokens: inputTokens || 0, outputTokens: outputTokens || 0 };
}