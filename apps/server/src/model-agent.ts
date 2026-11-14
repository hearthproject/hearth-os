import type { ModelProtocol } from "@hearth/core";
import {
  ModelClientError,
  anthropicHeaders,
  anthropicUrl,
  apiError,
  assertConfigured,
  bearerHeaders,
  geminiHeaders,
  geminiUrl,
  openAiChatUrl,
  openAiResponsesUrl,
  protocolOf,
  readAnthropicUsage,
  readGeminiUsage,
  readJson,
  readSse,
  readUsage,
  safeJson,
  withTimeout,
  type CompleteOptions,
  type CompleteResult
} from "./model-client.ts";
import type { ModelSettings } from "./model-settings.ts";

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: unknown;
  rawArguments: string;
}

export type AgentMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: AgentToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export interface AgentTurnResult {
  content: string;
  toolCalls: AgentToolCall[];
  usage: CompleteResult["usage"];
  finishReason: string | null;
}

export interface AgentTurnOptions extends CompleteOptions {
  toolChoice?: "auto" | "none";
}


//把不同模型协议转换成统一的文本和工具调用
export async function streamAgentTurn(
  settings: ModelSettings,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
  onDelta: (text: string) => void,
  options: AgentTurnOptions = {}
): Promise<AgentTurnResult> {
  assertConfigured(settings);
  switch (protocolOf(settings)) {
    case "openai-responses":
      return streamResponsesTurn(settings, messages, tools, onDelta, options);
    case "anthropic-messages":
      return streamAnthropicTurn(settings, messages, tools, onDelta, options);
    case "gemini":
      return streamGeminiTurn(settings, messages, tools, onDelta, options);
    default:
      return streamOpenAiChatTurn(settings, messages, tools, onDelta, options);
  }
}

async function streamOpenAiChatTurn(
  settings: ModelSettings,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
  onDelta: (text: string) => void,
  options: AgentTurnOptions
): Promise<AgentTurnResult> {
  const response = await fetch(openAiChatUrl(settings.baseUrl), {
    method: "POST",
    headers: bearerHeaders(settings),
    body: JSON.stringify({
      model: settings.model,
      messages: openAiAgentMessages(messages),
      ...(tools.length > 0 ? { tools: tools.map(openAiTool), tool_choice: options.toolChoice ?? "auto" } : {}),
      stream: true,
      temperature: options.temperature ?? 0.2,
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {})
    }),
    signal: withTimeout(options.signal, options.timeoutMs ?? 180_000)
  });
  if (!response.ok) throw apiError(response.status, await readJson(response));
  if (!response.body) throw new ModelClientError("EMPTY_RESPONSE", "模型服务没有返回内容");

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const payload = await readJson(response);
    return openAiChatPayloadResult(payload, onDelta);
  }

  let content = "";
  let finishReason: string | null = null;
  let usage: CompleteResult["usage"] = null;
  const partialTools = new Map<number, { id: string; name: string; raw: string }>();
  await readSse(response, (_event, payload) => {
    const choice = payload?.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === "string" && delta) {
      content += delta;
      onDelta(delta);
    }
    const calls = Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : [];
    for (const [fallbackIndex, call] of calls.entries()) {
      const index = Number.isInteger(call?.index) ? Number(call.index) : fallbackIndex;
      const current = partialTools.get(index) ?? { id: "", name: "", raw: "" };
      if (typeof call?.id === "string" && call.id) current.id = call.id;
      if (typeof call?.function?.name === "string" && call.function.name) current.name = call.function.name;
      if (typeof call?.function?.arguments === "string") current.raw += call.function.arguments;
      partialTools.set(index, current);
    }
    const legacyCall = choice?.delta?.function_call;
    if (legacyCall) {
      const current = partialTools.get(0) ?? { id: "call_0", name: "", raw: "" };
      if (typeof legacyCall.name === "string" && legacyCall.name) current.name = legacyCall.name;
      if (typeof legacyCall.arguments === "string") current.raw += legacyCall.arguments;
      partialTools.set(0, current);
    }
    if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    usage = readUsage(payload?.usage) ?? usage;
  });
  return {
    content,
    toolCalls: finalizeToolCalls(partialTools),
    usage,
    finishReason
  };
}

function openAiChatPayloadResult(payload: Record<string, any> | null, onDelta: (text: string) => void): AgentTurnResult {
  const choice = payload?.choices?.[0];
  const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
  if (content) onDelta(content);
  const calls = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [];
  return {
    content,
    toolCalls: calls.map((call: any, index: number) => toToolCall(call?.id, call?.function?.name, call?.function?.arguments, index)),
    usage: readUsage(payload?.usage),
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null
  };
}

function openAiAgentMessages(messages: AgentMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    }
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content || null,
        ...(message.toolCalls.length > 0 ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.rawArguments || "{}" }
          }))
        } : {})
      };
    }
    return { role: message.role, content: message.content };
  });
}

function openAiTool(tool: AgentToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  };
}

async function streamResponsesTurn(
  settings: ModelSettings,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
  onDelta: (text: string) => void,
  options: AgentTurnOptions
): Promise<AgentTurnResult> {
  const { instructions, input } = responsesAgentInput(messages);
  const response = await fetch(openAiResponsesUrl(settings.baseUrl), {
    method: "POST",
    headers: bearerHeaders(settings),
    body: JSON.stringify({
      model: settings.model,
      input,
      ...(instructions ? { instructions } : {}),
      ...(tools.length > 0 ? {
        tools: tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        })),
        tool_choice: options.toolChoice ?? "auto"
      } : {}),
      stream: true,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens ? { max_output_tokens: options.maxTokens } : {})
    }),
    signal: withTimeout(options.signal, options.timeoutMs ?? 180_000)
  });
  if (!response.ok) throw apiError(response.status, await readJson(response));

  let content = "";
  let usage: CompleteResult["usage"] = null;
  let finishReason: string | null = null;
  const partial = new Map<string, { index: number; id: string; name: string; raw: string }>();
  await readSse(response, (event, payload) => {
    const type = typeof payload?.type === "string" ? payload.type : event;
    if (type === "response.output_text.delta" || type === "response.refusal.delta") {
      const delta = typeof payload?.delta === "string" ? payload.delta : "";
      if (delta) {
        content += delta;
        onDelta(delta);
      }
    } else if (type === "response.output_item.added" && payload?.item?.type === "function_call") {
      const key = String(payload.item.id ?? payload.output_index ?? partial.size);
      partial.set(key, {
        index: Number(payload.output_index ?? partial.size),
        id: String(payload.item.call_id ?? payload.item.id ?? key),
        name: String(payload.item.name ?? ""),
        raw: String(payload.item.arguments ?? "")
      });
    } else if (type === "response.function_call_arguments.delta") {
      const key = String(payload?.item_id ?? payload?.output_index ?? 0);
      const current = partial.get(key) ?? { index: Number(payload?.output_index ?? 0), id: key, name: "", raw: "" };
      current.raw += String(payload?.delta ?? "");
      partial.set(key, current);
    } else if (type === "response.output_item.done" && payload?.item?.type === "function_call") {
      const key = String(payload.item.id ?? payload.output_index ?? 0);
      const current = partial.get(key) ?? { index: Number(payload.output_index ?? 0), id: key, name: "", raw: "" };
      current.id = String(payload.item.call_id ?? current.id);
      current.name = String(payload.item.name ?? current.name);
      current.raw = String(payload.item.arguments ?? current.raw);
      partial.set(key, current);
    } else if (type === "response.completed" || type === "response.done") {
      usage = readUsage(payload?.response?.usage ?? payload?.usage) ?? usage;
      finishReason = String(payload?.response?.status ?? "completed");
    } else if (type === "error") {
      throw new ModelClientError("MODEL_REQUEST_FAILED", String(payload?.message ?? payload?.error?.message ?? "模型服务返回错误"));
    }
  });
  return {
    content,
    toolCalls: finalizeToolCalls(partial),
    usage,
    finishReason
  };
}

function responsesAgentInput(messages: AgentMessage[]): { instructions: string; input: Record<string, unknown>[] } {
  const instructions = messages.filter((item) => item.role === "system").map((item) => item.content).join("\n\n");
  const input: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
      continue;
    }
    if (message.role === "assistant") {
      if (message.content) input.push({ role: "assistant", content: message.content });
      for (const call of message.toolCalls) {
        input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.rawArguments || "{}" });
      }
      continue;
    }
    input.push({ role: "user", content: message.content });
  }
  return { instructions, input };
}

async function streamAnthropicTurn(
  settings: ModelSettings,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
  onDelta: (text: string) => void,
  options: AgentTurnOptions
): Promise<AgentTurnResult> {
  const { system, messages: anthropicMessages } = anthropicAgentPayload(messages);
  const response = await fetch(anthropicUrl(settings.baseUrl), {
    method: "POST",
    headers: anthropicHeaders(settings),
    body: JSON.stringify({
      model: settings.model,
      max_tokens: options.maxTokens ?? 4_096,
      ...(system ? { system } : {}),
      messages: anthropicMessages,
      ...(tools.length > 0 ? {
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
        tool_choice: { type: options.toolChoice === "none" ? "none" : "auto" }
      } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      stream: true
    }),
    signal: withTimeout(options.signal, options.timeoutMs ?? 180_000)
  });
  if (!response.ok) throw apiError(response.status, await readJson(response));

  let content = "";
  let usage: CompleteResult["usage"] = null;
  let finishReason: string | null = null;
  const partial = new Map<number, { id: string; name: string; raw: string }>();
  await readSse(response, (event, payload) => {
    const type = typeof payload?.type === "string" ? payload.type : event;
    if (type === "message_start") {
      const inputTokens = Number(payload?.message?.usage?.input_tokens ?? 0);
      usage = { inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0, outputTokens: 0 };
    } else if (type === "content_block_start" && payload?.content_block?.type === "tool_use") {
      partial.set(Number(payload.index ?? partial.size), {
        id: String(payload.content_block.id ?? `tool_${payload.index ?? partial.size}`),
        name: String(payload.content_block.name ?? ""),
        raw: ""
      });
    } else if (type === "content_block_delta") {
      const text = typeof payload?.delta?.text === "string" ? payload.delta.text : "";
      if (text) {
        content += text;
        onDelta(text);
      }
      if (typeof payload?.delta?.partial_json === "string") {
        const index = Number(payload.index ?? 0);
        const current = partial.get(index) ?? { id: `tool_${index}`, name: "", raw: "" };
        current.raw += payload.delta.partial_json;
        partial.set(index, current);
      }
    } else if (type === "message_delta") {
      const outputTokens = Number(payload?.usage?.output_tokens ?? 0);
      usage = { inputTokens: usage?.inputTokens ?? 0, outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0 };
      finishReason = payload?.delta?.stop_reason == null ? finishReason : String(payload.delta.stop_reason);
    } else if (type === "error") {
      throw new ModelClientError("MODEL_REQUEST_FAILED", String(payload?.error?.message ?? "模型服务返回错误"));
    }
  });
  return {
    content,
    toolCalls: finalizeToolCalls(partial),
    usage,
    finishReason
  };
}

function anthropicAgentPayload(messages: AgentMessage[]): { system: string; messages: Record<string, unknown>[] } {
  const system = messages.filter((item) => item.role === "system").map((item) => item.content).join("\n\n");
  const result: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      appendAnthropicMessage(result, "user", [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content, ...(message.isError ? { is_error: true } : {}) }]);
      continue;
    }
    if (message.role === "assistant") {
      const blocks: Record<string, unknown>[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments ?? {} });
      }
      if (blocks.length > 0) appendAnthropicMessage(result, "assistant", blocks);
      continue;
    }
    appendAnthropicMessage(result, "user", [{ type: "text", text: message.content }]);
  }
  return { system, messages: result };
}

function appendAnthropicMessage(messages: Record<string, unknown>[], role: "user" | "assistant", blocks: Record<string, unknown>[]): void {
  const last = messages.at(-1);
  if (last?.role === role && Array.isArray(last.content)) {
    (last.content as Record<string, unknown>[]).push(...blocks);
    return;
  }
  messages.push({ role, content: blocks });
}

async function streamGeminiTurn(
  settings: ModelSettings,
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
  onDelta: (text: string) => void,
  options: AgentTurnOptions
): Promise<AgentTurnResult> {
  const body = geminiAgentBody(messages, tools, options);
  const response = await fetch(geminiUrl(settings, true), {
    method: "POST",
    headers: geminiHeaders(settings),
    body: JSON.stringify(body),
    signal: withTimeout(options.signal, options.timeoutMs ?? 180_000)
  });
  if (!response.ok) throw apiError(response.status, await readJson(response));

  let content = "";
  let usage: CompleteResult["usage"] = null;
  let finishReason: string | null = null;
  const calls: AgentToolCall[] = [];
  await readSse(response, (_event, payload) => {
    const candidate = payload?.candidates?.[0];
    for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
      if (typeof part?.text === "string" && part.text) {
        content += part.text;
        onDelta(part.text);
      }
      if (part?.functionCall) {
        calls.push(toToolCall(
          `gemini_${calls.length}`,
          String(part.functionCall.name ?? ""),
          JSON.stringify(part.functionCall.args ?? {}),
          calls.length
        ));
      }
    }
    usage = readGeminiUsage(payload?.usageMetadata) ?? usage;
    if (typeof candidate?.finishReason === "string") finishReason = candidate.finishReason;
  });
  return { content, toolCalls: dedupeToolCalls(calls), usage, finishReason };
}

function geminiAgentBody(messages: AgentMessage[], tools: AgentToolDefinition[], options: AgentTurnOptions): Record<string, unknown> {
  const system = messages.filter((item) => item.role === "system").map((item) => item.content).join("\n\n");
  const contents: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      appendGeminiContent(contents, "user", [{
        functionResponse: {
          name: message.name,
          response: { result: message.content, ...(message.isError ? { isError: true } : {}) }
        }
      }]);
      continue;
    }
    if (message.role === "assistant") {
      const parts: Record<string, unknown>[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: call.arguments ?? {} } });
      }
      if (parts.length > 0) appendGeminiContent(contents, "model", parts);
      continue;
    }
    appendGeminiContent(contents, "user", [{ text: message.content }]);
  }
  return {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(tools.length > 0 ? {
      tools: [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }]
    } : {}),
    generationConfig: {
      temperature: options.temperature ?? 0.2,
      ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {})
    }
  };
}

function appendGeminiContent(contents: Record<string, unknown>[], role: "user" | "model", parts: Record<string, unknown>[]): void {
  const last = contents.at(-1);
  if (last?.role === role && Array.isArray(last.parts)) {
    (last.parts as Record<string, unknown>[]).push(...parts);
    return;
  }
  contents.push({ role, parts });
}

function finalizeToolCalls(partial: Map<number | string, { id: string; name: string; raw: string }>): AgentToolCall[] {
  return Array.from(partial.entries())
    .sort(([left], [right]) => String(left).localeCompare(String(right), undefined, { numeric: true }))
    .filter(([, call]) => call.name)
    .map(([key, call], index) => toToolCall(call.id || `call_${key}`, call.name, call.raw, index));
}

function toToolCall(id: unknown, name: unknown, raw: unknown, index = 0): AgentToolCall {
  const rawArguments = typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
  return {
    id: typeof id === "string" && id ? id : `tool_${index}`,
    name: typeof name === "string" ? name : "",
    arguments: parseArguments(rawArguments),
    rawArguments
  };
}

function parseArguments(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __invalidJson: raw };
  }
}

function dedupeToolCalls(calls: AgentToolCall[]): AgentToolCall[] {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${call.name}:${call.rawArguments}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function supportsToolCalling(protocol: ModelProtocol): boolean {
  return protocol === "openai-chat" || protocol === "openai-responses" || protocol === "anthropic-messages" || protocol === "gemini";
}
