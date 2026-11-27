import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DeepSeekHarness, HarnessNotification, RunResult } from "@deepseek-ai/dsh-sdk-client";

export type DshProtocol = "openai-chat" | "openai-responses" | "anthropic-messages";

export interface DshModelSettings {
  protocol: DshProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Effective model window shared with Hearth's profile. */
  contextWindowTokens?: number;
  /** Per-response max output shared with Hearth's profile. */
  maxOutputTokens?: number;
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

export interface DshMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface DshAgentTeamOptions {
  enabled: boolean;
  /** Harness defaults are 8; kept as an explicit contract for the UI. */
  maxMembers?: number;
  maxTasks?: number;
}

export interface DshTeamMemberEvent {
  memberId: string;
  parentId: string | null;
  title?: string;
  status: "started" | "completed" | "failed";
}

export interface DeepSeekHarnessRunOptions {
  settings: DshModelSettings;
  dshHome: string;
  workingDirectory: string;
  outDir: string;
  prompt: string;
  mode: "necessary" | "full";
  /** A planning run enters DSH Plan Mode and can never widen permissions. */
  planMode?: boolean | undefined;
  permissionMode?: "read-only" | "workspace-write" | "danger-full-access" | undefined;
  maxTurns?: number | undefined;
  runBudgetSeconds?: number | undefined;
  resumeSessionId?: string | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((event: { type: string; message: string; detail?: Record<string, unknown> }) => void) | undefined;
  onContextItem?: ((event: DshContextEvent) => void) | undefined;
  onApprovalRequest?: ((request: DshApprovalRequest) => DshApprovalOutcome | Promise<DshApprovalOutcome>) | undefined;
  mcpServers?: Record<string, DshMcpServer> | undefined;
  /** Native DSH Team composition. Omitted keeps the base subagent tools. */
  agentTeam?: DshAgentTeamOptions | undefined;
  onTeamMember?: ((event: DshTeamMemberEvent) => void) | undefined;
}

export interface DeepSeekHarnessRunResult {
  finalResponse: string;
  /** Full plan captured from a native plan-review question, when present. */
  planMarkdown: string | null;
  /** Ordinary clarification captured from a native user question, when present. */
  question?: string | null;
  /** True when DSH submitted a plan-review request. */
  planSubmitted?: boolean;
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

export class DeepSeekRuntimeMissingError extends DeepSeekHarnessError {
  constructor(message: string, options?: ErrorOptions) {
    super("EXECUTOR_RUNTIME_MISSING", message, options);
    this.name = "DeepSeekRuntimeMissingError";
  }
}

async function loadDeepSeekHarness(dshHome?: string): Promise<typeof import("@deepseek-ai/dsh-sdk-client")> {
  const managedPackage = dshHome
    ? join(dshHome, "runtime", "node_modules", "@deepseek-ai", "dsh-sdk-client", "package.json")
    : null;
  if (managedPackage && existsSync(managedPackage)) {
    try {
      const require = createRequire(managedPackage);
      const entry = require.resolve("@deepseek-ai/dsh-sdk-client");
      return await import(pathToFileURL(entry).href) as typeof import("@deepseek-ai/dsh-sdk-client");
    } catch {
      // Fall back to the bundled SDK when the managed copy is incomplete.
    }
  }
  try {
    return await import("@deepseek-ai/dsh-sdk-client");
  } catch (error) {
    throw new DeepSeekRuntimeMissingError(
      "DeepSeek Harness 运行时未安装。请到设置 → 执行器点击“一键安装”，或改用 native / Codex 执行器。",
      { cause: error }
    );
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
  const { DeepSeekHarness } = await loadDeepSeekHarness(options.dshHome);
  validateSettings(options.settings);
  mkdirSync(options.dshHome, { recursive: true });
  const patchPath = writeProviderPatch(options.dshHome, options.settings, options.mcpServers, options.agentTeam);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [API_KEY_ENV]: options.settings.apiKey,
    DSH_PERMISSION_MODE: dshPermissionMode(options),
    DSH_TELEMETRY_MODE: "DISABLED"
  };
  let planMarkdown: string | null = null;
  let question: string | null = null;
  let planSubmitted = false;
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
    ...(options.runBudgetSeconds !== undefined
      ? { requestTimeoutMs: Math.max(60_000, options.runBudgetSeconds * 1_000) }
      : {}),
    env,
    onUserQuestion: async (request) => {
      const detail = options.planMode ? planReviewMarkdown(request.questions) : null;
      if (detail) {
        planMarkdown = detail;
        planSubmitted = true;
      }
      const clarification = ordinaryQuestionMarkdown(request.questions);
      if (clarification) question = [question, clarification].filter(Boolean).join("\n\n");
      return { cancelled: true };
    }
  });
  harness.client.start();
  harness.client.onRequest(async (method, params) => {
    if (method !== "approval/request") throw new Error(`Unsupported DSH request: ${method}`);
    if (options.signal?.aborted) return { outcome: "cancelled" };
    if (options.planMode) return { outcome: "rejected" };
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
      : await harness.run(promptForRun(options), { onNotification: notificationHandler(options) });
    if (options.signal?.aborted) throw new DeepSeekHarnessError("DSH_CANCELLED", "DeepSeek Harness 执行已取消");
    options.onProgress?.({ type: "dsh.done", message: "DeepSeek Harness 已完成本轮执行" });
    return {
      finalResponse: runResult.finalResponse.trim() || planMarkdown || question || "",
      planMarkdown,
      question,
      planSubmitted,
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
    return await session.run(promptForRun(options), { onNotification: notificationHandler(options) });
  } catch (error) {
    options.onProgress?.({
      type: "dsh.resume.fallback",
      message: `无法恢复会话 ${sessionId}，将从当前任务上下文创建新会话`,
      detail: { error: error instanceof Error ? error.message : String(error) }
    });
    return harness.run(promptForRun(options), { onNotification: notificationHandler(options) });
  }
}

export function dshPermissionMode(options: DeepSeekHarnessRunOptions): "read-only" | "workspace-write" | "danger-full-access" {
  return options.planMode
    ? "read-only"
    : options.permissionMode ?? (options.mode === "full" ? "danger-full-access" : "workspace-write");
}

export function promptForRun(options: DeepSeekHarnessRunOptions): string {
  return options.planMode ? `/plan ${options.prompt}` : options.prompt;
}

export function planReviewMarkdown(
  questions: Array<{ intent?: { kind?: string } | null; detail?: string | null }>
): string | null {
  const detail = questions
    .filter((question) => question.intent?.kind === "plan-review")
    .map((question) => question.detail?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
  return detail || null;
}

export function ordinaryQuestionMarkdown(
  questions: Array<{
    question?: string | null;
    detail?: string | null;
    intent?: { kind?: string } | null;
  }>
): string | null {
  const text = questions
    .filter((question) => question.intent?.kind !== "plan-review")
    .map((question) => [question.question?.trim(), question.detail?.trim()].filter(Boolean).join("\n\n"))
    .filter(Boolean)
    .join("\n\n");
  return text || null;
}

function notificationHandler(options: DeepSeekHarnessRunOptions): (notification: HarnessNotification) => void {
  return (notification) => {
    const directMember = teamMemberFromNotification(notification);
    if (directMember) {
      options.onTeamMember?.(directMember);
      options.onProgress?.({
        type: `dsh.team.${directMember.status}`,
        message: directMember.status === "started"
          ? `团队成员开始：${directMember.title || directMember.memberId}`
          : `团队成员${directMember.status === "completed" ? "完成" : "失败"}：${directMember.title || directMember.memberId}`
      });
      return;
    }
    if (notification.method !== "session.event") return;
    const event = notification.params.event;
    if (!event || typeof event !== "object") return;
    const record = event as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "session.event";
    const seq = typeof record.seq === "number" ? record.seq : null;
    const data = isRecord(record.data) ? record.data : {};
    const sessionId = typeof notification.params.sessionId === "string" ? notification.params.sessionId : "session";
    const sessionMember = teamMemberFromSessionEvent(type, data, sessionId);
    if (sessionMember) {
      options.onTeamMember?.(sessionMember);
      options.onProgress?.({
        type: `dsh.team.${sessionMember.status}`,
        message: sessionMember.status === "started"
          ? `团队成员开始：${sessionMember.title || sessionMember.memberId}`
          : `团队成员${sessionMember.status === "completed" ? "完成" : "失败"}：${sessionMember.title || sessionMember.memberId}`
      });
      return;
    }
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

const TEAM_METHOD_PATTERN = /(subagent|agent-team|team-member)/i;

function teamStatusFromText(text: string): DshTeamMemberEvent["status"] | null {
  if (/fail|error|cancel|abort/i.test(text)) return "failed";
  if (/finish|complete|done|end|exit/i.test(text)) return "completed";
  if (/start|spawn|begin|create/i.test(text)) return "started";
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Maps documented DSH subagent notifications to roster events. Field names vary
 * across the experimental line, so every known alias is accepted and nothing is
 * inferred when the id is missing.
 */
export function teamMemberFromNotification(notification: HarnessNotification): DshTeamMemberEvent | null {
  if (!TEAM_METHOD_PATTERN.test(notification.method)) return null;
  const status = teamStatusFromText(notification.method);
  if (!status) return null;
  const params = isRecord(notification.params) ? notification.params : {};
  const memberId = firstString(
    params.childId,
    params.memberId,
    params.agentId,
    params.sessionId,
    params.id
  );
  if (!memberId) return null;
  const title = firstString(params.title, params.name, params.description);
  const parentId = firstString(params.parentId, params.parentSessionId, params.parent);
  return {
    memberId,
    parentId: parentId && parentId !== memberId ? parentId : null,
    status,
    ...(title ? { title } : {})
  };
}

export function teamMemberFromSessionEvent(
  type: string,
  data: Record<string, unknown>,
  rootSessionId: string
): DshTeamMemberEvent | null {
  if (!TEAM_METHOD_PATTERN.test(type) || !type.includes("/")) return null;
  const status = teamStatusFromText(type.slice(type.indexOf("/") + 1));
  if (!status) return null;
  const memberId = firstString(data.childId, data.memberId, data.agentId, data.sessionId, data.id);
  if (!memberId) return null;
  // A subagent event carrying only the root session id is not a member event.
  if (memberId === rootSessionId && !firstString(data.childId, data.memberId, data.agentId)) return null;
  const title = firstString(data.title, data.name, data.description);
  const parentId = firstString(data.parentId, data.parentSessionId, data.parent);
  return {
    memberId,
    parentId: parentId && parentId !== memberId ? parentId : null,
    status,
    ...(title ? { title } : {})
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

export function buildDshPatch(
  settings: DshModelSettings,
  mcpServers: Record<string, DshMcpServer> = {},
  agentTeam?: DshAgentTeamOptions
): string {
  const api = API_BY_PROTOCOL[settings.protocol];
  const lines = [
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
    `            contextWindow: ${Math.max(4_096, Math.floor(settings.contextWindowTokens ?? 131_072))}`,
    `            maxTokens: ${Math.max(256, Math.floor(settings.maxOutputTokens ?? 32_768))}`
  ];
  for (const [name, server] of Object.entries(mcpServers)) {
    lines.push(
      `- id: mcp-${name}`,
      "  name: '@deepseek-ai/dsh-mcp-client'",
      "  config:",
      `    serverName: ${yamlString(name)}`,
      "    transport: stdio",
      `    command: ${yamlString(server.command)}`,
      "    toolCallTimeoutMs: 120000",
      "    failOnStartupError: false"
    );
    if (server.args?.length) {
      lines.push("    args:");
      for (const arg of server.args) lines.push(`      - ${yamlString(arg)}`);
    }
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push("    env:");
      for (const [key, value] of Object.entries(server.env)) lines.push(`      ${key}: ${yamlString(value)}`);
    }
  }
  if (agentTeam) {
    // Base subagent tools stay off in both modes: single must be enforced, and
    // the Team layer replaces them with its own role-aware tools.
    lines.push(
      "- id: tool-subagent-control",
      "  disabled: true",
      "- id: tool-subagent",
      "  disabled: true",
      "- id: tool-subagent-fork",
      "  disabled: true"
    );
    if (agentTeam.enabled) {
      lines.push(
        "- insert:",
        "    - id: agent-team",
        "      name: '@deepseek-ai/dsh-experimental-agent-team'",
        "      config:",
        `        maxMembers: ${Math.max(1, Math.floor(agentTeam.maxMembers ?? 8))}`,
        `        maxTasks: ${Math.max(1, Math.floor(agentTeam.maxTasks ?? 256))}`,
        "        maxMessageBytes: 65536",
        "        disposalTimeoutMs: 5000",
        "    - id: tool-agent-team",
        "      name: '@deepseek-ai/dsh-experimental-tool-agent-team'",
        "      config:",
        "        freshProvider: spawn",
        "        forkProvider: fork"
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function writeProviderPatch(
  dshHome: string,
  settings: DshModelSettings,
  mcpServers?: Record<string, DshMcpServer>,
  agentTeam?: DshAgentTeamOptions
): string {
  const directory = join(dshHome, "hearth");
  mkdirSync(directory, { recursive: true });
  const mcpKey = JSON.stringify(mcpServers ?? {});
  const teamKey = JSON.stringify(agentTeam ?? null);
  const digest = Buffer.from(`${settings.baseUrl}\n${settings.model}\n${settings.protocol}\n${settings.contextWindowTokens ?? 131072}\n${settings.maxOutputTokens ?? 32768}\n${mcpKey}\n${teamKey}`).toString("base64url").slice(0, 18);
  const path = join(directory, `provider-${digest}.yml`);
  const content = buildDshPatch(settings, mcpServers, agentTeam);
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
