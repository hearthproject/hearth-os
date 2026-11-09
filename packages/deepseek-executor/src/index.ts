import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DeepSeekHarness, type HarnessNotification, type RunResult } from "@deepseek-ai/dsh-sdk-client";

export type DshProtocol = "openai-chat" | "openai-responses" | "anthropic-messages";

export interface DshModelSettings {
  protocol: DshProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface DshUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface DshContextEvent {
  type: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  executorEventId: string;
  seq: number | null;
  usage?: DshUsage | undefined;
}

export interface DshApprovalRequest {
  sessionId: string;
  toolName: string;
  callId?: string;
  reason?: string;
}

export type DshApprovalOutcome = "allowed-once" | "rejected" | "cancelled";

export interface DeepSeekHarnessRunOptions {
  settings: DshModelSettings;
  dshHome: string;
  workingDirectory: string;
  outDir: string;
  prompt: string;
  mode: "necessary" | "full";
  maxTurns: number;
  runBudgetSeconds: number;
  resumeSessionId?: string | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((event: { type: string; message: string; detail?: Record<string, unknown> }) => void) | undefined;
  onContextItem?: ((event: DshContextEvent) => void) | undefined;
  onApprovalRequest?: ((request: DshApprovalRequest) => DshApprovalOutcome | Promise<DshApprovalOutcome>) | undefined;
}

export interface DeepSeekHarnessRunResult {
  finalResponse: string;
  sessionId: string;
  usage: DshUsage | null;
  finishReason: string | null;
}

export class DeepSeekHarnessError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeepSeekHarnessError";
    this.code = code;
  }
}

const API_KEY_ENV = "HEARTH_DSH_API_KEY";
const PROVIDER = "hearth";
const API_BY_PROTOCOL: Record<DshProtocol, string> = {
  "openai-chat": "openai-completions",
  "openai-responses": "openai-responses",
  "anthropic-messages": "anthropic-messages"
};

export async function runDeepSeekHarness(options: DeepSeekHarnessRunOptions): Promise<DeepSeekHarnessRunResult> {
  validateSettings(options.settings);
  mkdirSync(options.dshHome, { recursive: true });
  const patchPath = writeProviderPatch(options.dshHome, options.settings);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [API_KEY_ENV]: options.settings.apiKey,
    DSH_PERMISSION_MODE: options.mode === "full" ? "danger-full-access" : "workspace-write",
    DSH_TELEMETRY_MODE: "DISABLED"
  };
  const harness = new DeepSeekHarness({
    profile: "sdk",
    dshHome: options.dshHome,
    patches: [patchPath],
    processCwd: options.workingDirectory,
    cwd: options.workingDirectory,
    provider: PROVIDER,
    model: options.settings.model,
    maxTokens: 32_768,
    approvalRequests: true,
    requestTimeoutMs: Math.max(60_000, options.runBudgetSeconds * 1_000),
    env,
    onUserQuestion: async () => ({ cancelled: true })
  });
  harness.client.start();
  harness.client.onRequest(async (method, params) => {
    if (method !== "approval/request") throw new Error(`Unsupported DSH request: ${method}`);
    if (options.signal?.aborted) return { outcome: "cancelled" };
    const request = approvalRequestFromParams(params);
    if (!options.onApprovalRequest) {
      return { outcome: options.mode === "full" ? "allowed-once" : "rejected" };
    }
    try {
      return { outcome: await options.onApprovalRequest(request) };
    } catch (error) {
      if (options.signal?.aborted) return { outcome: "cancelled" };
      options.onProgress?.({
        type: "dsh.approval.failed",
        message: "工具审批失败，已拒绝本次工具",
        detail: { error: clip(error instanceof Error ? error.message : String(error), 500) }
      });
      return { outcome: "rejected" };
    }
  });
  let closed = false;
  const abort = (): void => {
    if (closed) return;
    closed = true;
    void harness.close();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    options.onProgress?.({ type: "dsh.start", message: options.resumeSessionId ? "正在恢复 DeepSeek Harness 会话" : "正在启动 DeepSeek Harness" });
    const runResult = options.resumeSessionId
      ? await runResumed(harness, options)
      : await harness.run(options.prompt, { onNotification: notificationHandler(options) });
    if (options.signal?.aborted) throw new DeepSeekHarnessError("DSH_CANCELLED", "DeepSeek Harness 执行已取消");
    options.onProgress?.({ type: "dsh.done", message: "DeepSeek Harness 已完成本轮执行" });
    return {
      finalResponse: runResult.finalResponse,
      sessionId: runResult.sessionId,
      usage: usageFromResult(runResult),
      finishReason: runResult.finishReason
    };
  } catch (error) {
    if (options.signal?.aborted) throw new DeepSeekHarnessError("DSH_CANCELLED", "DeepSeek Harness 执行已取消", { cause: error });
    if (error instanceof DeepSeekHarnessError) throw error;
    throw new DeepSeekHarnessError(
      runtimeFailureCode(error),
      `DeepSeek Harness 执行失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (!closed) {
      closed = true;
      await harness.close();
    }
  }
}

export function dshHomeFor(settingsPath: string): string {
  return join(settingsPath, "deepseek-harness");
}

async function runResumed(harness: DeepSeekHarness, options: DeepSeekHarnessRunOptions): Promise<RunResult> {
  const sessionId = options.resumeSessionId as string;
  try {
    const session = await harness.resumeSession(sessionId);
    options.onProgress?.({ type: "dsh.resume", message: `已恢复会话 ${sessionId}` });
    return await session.run(options.prompt, { onNotification: notificationHandler(options) });
  } catch (error) {
    options.onProgress?.({
      type: "dsh.resume.fallback",
      message: `无法恢复会话 ${sessionId}，将从当前任务上下文创建新会话`,
      detail: { error: error instanceof Error ? error.message : String(error) }
    });
    return harness.run(options.prompt, { onNotification: notificationHandler(options) });
  }
}

function notificationHandler(options: DeepSeekHarnessRunOptions): (notification: HarnessNotification) => void {
  return (notification) => {
    if (notification.method !== "session.event") return;
    const event = notification.params.event;
    if (!event || typeof event !== "object") return;
    const record = event as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "session.event";
    const seq = typeof record.seq === "number" ? record.seq : null;
    const data = isRecord(record.data) ? record.data : {};
    const sessionId = typeof notification.params.sessionId === "string" ? notification.params.sessionId : "session";
    const executorEventId = `dsh:${sessionId}:${seq ?? executorEventIdFromData(data)}`;
    if (type === "assistant/message") {
      const message = isRecord(data.message) ? data.message : {};
      const content = contentText(message.content);
      if (content) options.onContextItem?.({
        type, role: "assistant", content, executorEventId, seq,
        ...(isRecord(data.usage) ? { usage: normalizeUsage(data.usage) } : {})
      });
      options.onProgress?.({ type: "dsh.assistant", message: clip(content || "模型正在生成回复", 1_200) });
      return;
    }
    if (type === "assistant/attempt") {
      const message = isRecord(data.message) ? data.message : {};
      const content = contentText(message.content);
      options.onProgress?.({ type: "dsh.assistant.attempt", message: clip(content || "模型正在准备回复", 1_200) });
      return;
    }
    if (type === "tool/call") {
      const name = typeof data.name === "string" ? data.name : "tool";
      const args = typeof data.arguments === "string" ? data.arguments : "";
      const content = `${name} ${args}`.trim();
      options.onContextItem?.({ type, role: "tool", content, executorEventId, seq });
      options.onProgress?.({ type: "dsh.tool.call", message: `调用工具：${name}`, detail: { command: clip(args, 1_000) } });
      return;
    }
    if (type === "tool/result") {
      const message = isRecord(data.message) ? data.message : {};
      const content = contentText(message.content);
      options.onContextItem?.({ type, role: "tool", content, executorEventId, seq });
      options.onProgress?.({ type: "dsh.tool.result", message: clip(content || "工具已返回", 1_200) });
      return;
    }
    if (type === "user/message") {
      const content = contentText(data.content);
      if (content) options.onContextItem?.({ type, role: "user", content, executorEventId, seq });
      return;
    }
    if (type === "system/message") {
      const message = isRecord(data.message) ? data.message : {};
      const content = contentText(message.content);
      if (content) options.onContextItem?.({ type, role: "system", content, executorEventId, seq });
      return;
    }
    if (type === "turn/start") options.onProgress?.({ type, message: "DeepSeek Harness 开始新一轮推理" });
    if (type === "turn/end") options.onProgress?.({ type, message: "DeepSeek Harness 完成一轮推理" });
  };
}

function approvalRequestFromParams(params: Record<string, unknown>): DshApprovalRequest {
  const sessionId = typeof params.sessionId === "string" && params.sessionId.trim() ? params.sessionId : "session";
  const toolName = typeof params.toolName === "string" && params.toolName.trim() ? params.toolName : "tool";
  const callId = typeof params.callId === "string" && params.callId.trim() ? params.callId : null;
  const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason : null;
  return {
    sessionId,
    toolName,
    ...(callId ? { callId } : {}),
    ...(reason ? { reason } : {})
  };
}

function writeProviderPatch(dshHome: string, settings: DshModelSettings): string {
  const directory = join(dshHome, "hearth");
  mkdirSync(directory, { recursive: true });
  const digest = Buffer.from(`${settings.baseUrl}\n${settings.model}\n${settings.protocol}`).toString("base64url").slice(0, 18);
  const path = join(directory, `provider-${digest}.yml`);
  const api = API_BY_PROTOCOL[settings.protocol];
  const content = [
    "- id: llm-pi-ai",
    "  config:",
    "    providers:",
    `      ${PROVIDER}:`,
    `        apiKeyEnv: ${API_KEY_ENV}`,
    '        displayName: "Hearth"',
    `        api: "${api}"`,
    `        baseURL: ${yamlString(settings.baseUrl)}`,
    "        defaultInput:",
    '          - text',
    "        models:",
    `          - id: ${yamlString(settings.model)}`,
    `            name: ${yamlString(settings.model)}`,
    "            contextWindow: 131072",
    "            maxTokens: 32768",
    ""
  ].join("\n");
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
  return path;
}

function validateSettings(settings: DshModelSettings): void {
  if (!settings.baseUrl.trim() || !settings.model.trim() || !settings.apiKey.trim()) {
    throw new DeepSeekHarnessError("DSH_MODEL_INCOMPLETE", "DeepSeek Harness 需要完整的模型地址、模型名和 API Key");
  }
  if (!API_BY_PROTOCOL[settings.protocol]) {
    throw new DeepSeekHarnessError("DSH_PROTOCOL_UNSUPPORTED", `DeepSeek Harness 不支持 ${settings.protocol} 协议`);
  }
}

function usageFromResult(result: RunResult): DshUsage | null {
  for (let index = result.events.length - 1; index >= 0; index -= 1) {
    const event = result.events[index] as unknown as Record<string, unknown>;
    if (event.type !== "assistant/message" || !isRecord(event.data) || !isRecord(event.data.usage)) continue;
    return normalizeUsage(event.data.usage);
  }
  return null;
}

function normalizeUsage(value: Record<string, unknown>): DshUsage {
  return {
    inputTokens: numberValue(value.inputTokens),
    cachedInputTokens: numberValue(value.cacheReadTokens),
    cacheWriteInputTokens: numberValue(value.cacheWriteTokens),
    outputTokens: numberValue(value.outputTokens),
    reasoningOutputTokens: numberValue(value.reasoningTokens)
  };
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((block) => {
    if (!isRecord(block)) return "";
    if (typeof block.text === "string") return block.text;
    if (typeof block.content === "string") return block.content;
    if (block.type === "tool-call") return `${typeof block.name === "string" ? block.name : "tool"} ${typeof block.arguments === "string" ? block.arguments : ""}`.trim();
    return "";
  }).filter(Boolean).join("\n");
}

function runtimeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|403|unauthorized|forbidden|api key/i.test(message)) return "DSH_AUTH_FAILED";
  if (/ENOENT|spawn|exited|transport closed|进程.*退出/i.test(message)) return "DSH_RUNTIME_FAULT";
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return "DSH_TIMEOUT";
  return "DSH_EXECUTION_FAILED";
}

function executorEventIdFromData(data: Record<string, unknown>): string {
  if (typeof data.messageId === "string") return data.messageId;
  if (typeof data.callId === "string") return data.callId;
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function clip(value: string, limit: number): string {
  const clean = value.trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
