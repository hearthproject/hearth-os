import type { ModelProtocol } from "@hearth/core";
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
  switch (protocolOf(settings)) {
    case "openai-responses":
      return completeOpenAiResponses(settings, messages, options);
    case "anthropic-messages":
      return completeAnthropic(settings, messages, options);
    case "gemini":
      return completeGemini(settings, messages, options);
    default:
      return completeOpenAiChat(settings, messages, options);
  }
}

export async function streamChat(
  settings: ModelSettings,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  options: CompleteOptions = {}
): Promise<CompleteResult> {
  assertConfigured(settings);
  switch (protocolOf(settings)) {
    case "openai-responses":
      return streamOpenAiResponses(settings, messages, onDelta, options);
    case "anthropic-messages":
      return streamAnthropic(settings, messages, onDelta, options);
    case "gemini":
      return streamGemini(settings, messages, onDelta, options);
    default:
      return streamOpenAiChat(settings, messages, onDelta, options);
  }
}

export async function listModels(settings: ModelSettings, timeoutMs = 30_000): Promise<string[]> {
  assertConnection(settings);
  switch (protocolOf(settings)) {
    case "anthropic-messages":
      return listAnthropicModels(settings, timeoutMs);
    case "gemini":
      return listGeminiModels(settings, timeoutMs);
    default:
      return listOpenAiModels(settings, timeoutMs);
  }
}

export function assertConfigured(settings: ModelSettings): void {
  assertConnection(settings);
  if (!settings.model) throw new ModelClientError("MODEL_NOT_CONFIGURED", "还没有填写模型名称");
}

function assertConnection(settings: ModelSettings): void {
  if (!settings.baseUrl) throw new ModelClientError("MODEL_NOT_CONFIGURED", "还没有填写模型服务地址");
  if (!settings.apiKey) throw new ModelClientError("MODEL_NOT_CONFIGURED", "还没有填写 API Key");
}

function protocolOf(settings: ModelSettings): ModelProtocol {
  return settings.protocol ?? "openai-chat";
}

async function completeOpenAiChat(
  settings: ModelSettings,
  messages: ChatMessage[],
  options: CompleteOptions
): Promise<CompleteResult> {
  const response = await fetch(openAiChatUrl(settings.baseUrl), {
    method: "POST",
    headers: bearerHeaders(settings),
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

async function streamOpenAiChat(
  settings: ModelSettings,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  options: CompleteOptions
): Promise<CompleteResult> {
  const response = await fetch(openAiChatUrl(settings.baseUrl), {
    method: "POST",
    headers: bearerHeaders(settings),
    body: JSON.stringify({
      model: settings.model,
      messages,
      stream: true,
      temperature: options.temperature ?? 0.5
    }),
    signal: withTimeout(options.signal, options.timeoutMs ?? 180_000)
  });
  if (!response.ok) throw apiError(response.status, await readJson(response));
  if (!response.body) throw new ModelClientError("EMPTY_RESPONSE", "模型服务没有返回内容");
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const payload = await readJsonFromText(await response.text());
    const content = String(payload?.choices?.[0]?.message?.content ?? "");
    if (!content) throw apiError(response.status, payload);
    onDelta(content);
    return { content, usage: readUsage(payload?.usage) };
  }

  let content = "";
  let usage: CompleteResult["usage"] = null;
  await readSse(response, (_event, payload) => {
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
  });
  if (!content.trim()) throw new ModelClientError("EMPTY_RESPONSE", "模型没有返回文字内容");
  return { content, usage };
}

async function completeOpenAiResponses(
  settings: ModelSettings,
  messages: ChatMessage[],
  options: CompleteOptions
): Promise<CompleteResult> {
  const response = await fetch(openAiResponsesUrl(settings.baseUrl), {
    method: "POST",
    headers: bearerHeaders(settings),
    body: JSON.stringify({
      ...responsesBody(messages),
      model: settings.model,
      stream: false,
      temperature: options.temperature ?? 0.2,
      max_output_tokens: options.maxTokens ?? 1_200
    }),
    signal: withTimeout(options.signal, options.timeoutMs ?? 60_000)
  });
  const payload = await readJson(response);
  if (!response.ok) throw apiError(response.status, payload);
  return { content: responsesText(payload), usage: readUsage(payload?.usage) };
}

async function streamOpenAiResponses(
  settings: ModelSettings,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  options: CompleteOptions
): Promise<CompleteResult> {
  const response = await fetch(openAiResponsesUrl(settings.baseUrl), {
    method: "POST",
    headers: bearerHeaders(settings),
    body: JSON.stringify({ ...responsesBody(messages), model: settings.model, stream: true }),
    signal: withTimeout(options.signal, options.timeoutMs ?? 180_000)
  });
  if (!response.ok) throw apiError(response.status, await readJson(response));

  let content = "";
  let usage: CompleteResult["usage"] = null;
  await readSse(response, (event, payload) => {
    const type = typeof payload?.type === "string" ? payload.type : event;
    if (type === "response.output_text.delta" || type === "response.refusal.delta") {
      const delta = typeof payload?.delta === "string" ? payload.delta : "";
      if (delta) {
        content += delta;
        onDelta(delta);
      }
    } else if (type === "response.completed" || type === "response.done") {
      usage = readUsage(payload?.response?.usage ?? payload?.usage) ?? usage;
    } else if (type === "error") {
      throw new ModelClientError("MODEL_REQUEST_FAILED", String(payload?.message ?? payload?.error?.message ?? "模型服务返回错误"));
    }
  });
  if (!content.trim()) throw new ModelClientError("EMPTY_RESPONSE", "模型没有返回文字内容");
  return { content, usage };
}

async function completeAnthropic(
  settings: ModelSettings,
  messages: ChatMessage[],
  options: CompleteOptions
): Promise<CompleteResult> {
  const response = await fetch(anthropicUrl(settings.baseUrl), {
    method: "POST",
    headers: anthropicHeaders(settings),
    body: JSON.stringify({
      model: settings.model,
      max_tokens: options.maxTokens ?? 1_200,
      temperature: options.temperature ?? 0.2,
      ...anthropicPayload(messages),
      stream: false
    }),
    signal: withTimeout(options.signal, options.timeoutMs ?? 60_000)
  });
  const payload = await readJson(response);
  if (!response.ok) throw apiError(response.status, payload);
  return { content: anthropicText(payload), usage: readAnthropicUsage(payload?.usage) };
}

async function streamAnthropic(
  settings: ModelSettings,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  options: CompleteOptions
): Promise<CompleteResult> {
  const response = await fetch(anthropicUrl(settings.baseUrl), {
    method: "POST",
    headers: anthropicHeaders(settings),
    body: JSON.stringify({ model: settings.model, max_tokens: options.maxTokens ?? 4_096, ...anthropicPayload(messages), stream: true }),
    signal: withTimeout(options.signal, options.timeoutMs ?? 180_000)
  });
  if (!response.ok) throw apiError(response.status, await readJson(response));

  let content = "";
  let usage: CompleteResult["usage"] = null;
  await readSse(response, (event, payload) => {
    const type = typeof payload?.type === "string" ? payload.type : event;
    if (type === "content_block_delta") {
      const delta = typeof payload?.delta?.text === "string" ? payload.delta.text : "";
      if (delta) {
        content += delta;
        onDelta(delta);
      }
    } else if (type === "message_start") {
      const inputTokens = Number(payload?.message?.usage?.input_tokens ?? 0);
      usage = { inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0, outputTokens: 0 };
    } else if (type === "message_delta") {
      const outputTokens = Number(payload?.usage?.output_tokens ?? 0);
      usage = { inputTokens: usage?.inputTokens ?? 0, outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0 };
    } else if (type === "error") {
      throw new ModelClientError("MODEL_REQUEST_FAILED", String(payload?.error?.message ?? "模型服务返回错误"));
    }
  });
  if (!content.trim()) throw new ModelClientError("EMPTY_RESPONSE", "模型没有返回文字内容");
  return { content, usage };
}

async function completeGemini(
  settings: ModelSettings,
  messages: ChatMessage[],
  options: CompleteOptions
): Promise<CompleteResult> {
  const response = await fetch(geminiUrl(settings, false), {
    method: "POST",
    headers: geminiHeaders(settings),
    body: JSON.stringify(geminiBody(messages, options)),
    signal: withTimeout(options.signal, options.timeoutMs ?? 60_000)
  });
  const payload = await readJson(response);
  if (!response.ok) throw apiError(response.status, payload);
  return { content: geminiText(payload), usage: readGeminiUsage(payload?.usageMetadata) };
}

async function streamGemini(
  settings: ModelSettings,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  options: CompleteOptions
): Promise<CompleteResult> {
  const response = await fetch(geminiUrl(settings, true), {
    method: "POST",
    headers: geminiHeaders(settings),
    body: JSON.stringify(geminiBody(messages, options)),
    signal: withTimeout(options.signal, options.timeoutMs ?? 180_000)
  });
  if (!response.ok) throw apiError(response.status, await readJson(response));

  let content = "";
  let usage: CompleteResult["usage"] = null;
  await readSse(response, (_event, payload) => {
    const delta = geminiText(payload);
    if (delta) {
      content += delta;
      onDelta(delta);
    }
    const chunkUsage = readGeminiUsage(payload?.usageMetadata);
    if (chunkUsage) usage = chunkUsage;
  });
  if (!content.trim()) throw new ModelClientError("EMPTY_RESPONSE", "模型没有返回文字内容");
  return { content, usage };
}

async function listOpenAiModels(settings: ModelSettings, timeoutMs: number): Promise<string[]> {
  const base = settings.baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "").replace(/\/responses$/, "");
  const response = await fetch(`${base}/models`, {
    headers: bearerHeaders(settings),
    signal: withTimeout(undefined, timeoutMs)
  });
  const payload = await readJson(response);
  if (!response.ok) throw apiError(response.status, payload);
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return normalizeModelIds(list);
}

async function listAnthropicModels(settings: ModelSettings, timeoutMs: number): Promise<string[]> {
  const base = settings.baseUrl.replace(/\/+$/, "").replace(/\/messages$/, "");
  const response = await fetch(`${base}/models?limit=1000`, {
    headers: anthropicHeaders(settings),
    signal: withTimeout(undefined, timeoutMs)
  });
  const payload = await readJson(response);
  if (!response.ok) throw apiError(response.status, payload);
  const list = Array.isArray(payload?.data) ? payload.data : [];
  return normalizeModelIds(list);
}

async function listGeminiModels(settings: ModelSettings, timeoutMs: number): Promise<string[]> {
  const base = geminiBase(settings.baseUrl);
  const response = await fetch(`${base}/models?pageSize=1000`, {
    headers: geminiHeaders(settings),
    signal: withTimeout(undefined, timeoutMs)
  });
  const payload = await readJson(response);
  if (!response.ok) throw apiError(response.status, payload);
  const list = Array.isArray(payload?.models) ? payload.models : [];
  return list
    .filter((item: unknown) => {
      if (!item || typeof item !== "object") return false;
      const methods = (item as { supportedGenerationMethods?: unknown }).supportedGenerationMethods;
      return !Array.isArray(methods) || methods.includes("generateContent");
    })
    .map((item: unknown) => {
      if (!item || typeof item !== "object") return "";
      const name = String((item as { name?: unknown }).name ?? "");
      return name.startsWith("models/") ? name.slice("models/".length) : name;
    })
    .filter((id: string) => id.length > 0)
    .sort((a: string, b: string) => a.localeCompare(b));
}

function responsesBody(messages: ChatMessage[]): Record<string, unknown> {
  const system = messages.filter((item) => item.role === "system").map((item) => item.content).join("\n\n");
  const input = messages
    .filter((item) => item.role !== "system")
    .map((item) => ({ role: item.role, content: item.content }));
  return {
    input,
    ...(system ? { instructions: system } : {})
  };
}

function anthropicPayload(messages: ChatMessage[]): Record<string, unknown> {
  const system = messages.filter((item) => item.role === "system").map((item) => item.content).join("\n\n");
  const rest = messages
    .filter((item) => item.role !== "system")
    .map((item) => ({ role: item.role, content: item.content }));
  return {
    ...(system ? { system } : {}),
    messages: rest
  };
}

function geminiBody(messages: ChatMessage[], options: CompleteOptions): Record<string, unknown> {
  const system = messages.filter((item) => item.role === "system").map((item) => item.content).join("\n\n");
  const contents = messages
    .filter((item) => item.role !== "system")
    .map((item) => ({ role: item.role === "assistant" ? "model" : "user", parts: [{ text: item.content }] }));
  return {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: {
      temperature: options.temperature ?? 0.5,
      ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {})
    }
  };
}

function openAiChatUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function openAiResponsesUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/responses") ? base : `${base}/responses`;
}

function anthropicUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/messages") ? base : `${base}/messages`;
}

function geminiBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/models$/, "");
}

function geminiUrl(settings: ModelSettings, stream: boolean): string {
  const suffix = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  return `${geminiBase(settings.baseUrl)}/models/${encodeURIComponent(settings.model)}:${suffix}`;
}

function bearerHeaders(settings: ModelSettings): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${settings.apiKey}`,
    "user-agent": "Hearth/0.1"
  };
}

function anthropicHeaders(settings: ModelSettings): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": settings.apiKey,
    "anthropic-version": "2023-06-01",
    "user-agent": "Hearth/0.1"
  };
}

function geminiHeaders(settings: ModelSettings): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-goog-api-key": settings.apiKey,
    "user-agent": "Hearth/0.1"
  };
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readSse(response: Response, onEvent: (event: string, payload: any) => void): Promise<void> {
  if (!response.body) throw new ModelClientError("EMPTY_RESPONSE", "模型服务没有返回内容");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let match = buffer.match(/\r?\n\r?\n/);
    while (match && match.index !== undefined) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (data.length > 0) {
        const raw = data.join("\n");
        if (raw === "[DONE]") return;
        const payload = safeJson(raw);
        if (payload) onEvent(event, payload);
      }
      match = buffer.match(/\r?\n\r?\n/);
    }
  }
}

function responsesText(payload: Record<string, any> | null): string {
  if (!payload) return "";
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  return output
    .flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
    .filter((part: any) => part?.type === "output_text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
}

function anthropicText(payload: Record<string, any> | null): string {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
}

function geminiText(payload: Record<string, any> | null): string {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((part: any) => typeof part?.text === "string" ? part.text : "").join("");
}

function normalizeModelIds(list: any[]): string[] {
  return list
    .map((item: unknown) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "id" in item) return String((item as { id: unknown }).id);
      return "";
    })
    .filter((id: string) => id.length > 0)
    .sort((a: string, b: string) => a.localeCompare(b));
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
  const detail = payload?.error?.message ?? payload?.error?.error?.message ?? payload?.message ?? payload?.error;
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

function readAnthropicUsage(usage: any): CompleteResult["usage"] {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return null;
  return { inputTokens: inputTokens || 0, outputTokens: outputTokens || 0 };
}

function readGeminiUsage(usage: any): CompleteResult["usage"] {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number(usage.promptTokenCount ?? 0);
  const outputTokens = Number(usage.candidatesTokenCount ?? 0);
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return null;
  return { inputTokens: inputTokens || 0, outputTokens: outputTokens || 0 };
}
