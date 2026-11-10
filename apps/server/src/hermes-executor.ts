import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ApprovalMode, RunUsage, TaskProgressDetail } from "@hearth/core";

export interface HermesProgress {
  type: string;
  message: string;
  detail?: TaskProgressDetail;
}

export interface HermesRunOptions {
  command: string;
  workingDirectory: string;
  prompt: string;
  mode: ApprovalMode;
  maxTurns: number;
  runBudgetSeconds: number;
  resumeSessionId?: string;
  signal?: AbortSignal;
  onEvent?: (event: HermesProgress) => void;
  onContextItem?: (event: HermesStreamEvent) => void;
}

export interface HermesRunResult {
  finalResponse: string;
  usage: RunUsage | null;
  sessionId: string | null;
  exitCode: number | null;
  durationMs: number | null;
}

export interface HermesProbeResult {
  ok: boolean;
  command: string;
  version: string | null;
  text: string | null;
  error: string | null;
  code: string | null;
  elapsedMs: number;
}

export class HermesApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesApprovalRequiredError";
  }
}

export class HermesStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesStartupError";
  }
}

export type HermesStreamEvent =
  | { type: "system"; subtype: string | null; sessionId: string | null; text: string; raw: unknown }
  | { type: "text"; text: string; raw: unknown }
  | { type: "tool_use"; name: string; input: unknown; toolCallId: string | null; raw: unknown }
  | { type: "tool_result"; name: string; output: string; durationMs: number | null; isError: boolean; toolCallId: string | null; raw: unknown }
  | { type: "result"; text: string; sessionId: string | null; exitCode: number | null; durationMs: number | null; usage: RunUsage | null; error: string | null; requiresApproval: boolean; raw: unknown }
  | { type: "error"; message: string; requiresApproval: boolean; raw: unknown };

export function parseHermesEvent(line: string): HermesStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { type: "text", text: trimmed, raw: trimmed };
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const type = String(record.type ?? record.event ?? "");
  if (type === "system" || type === "init") {
    return {
      type: "system",
      subtype: typeof record.subtype === "string" ? record.subtype : null,
      sessionId: sessionIdOf(record),
      text: typeof record.message === "string" ? record.message : "",
      raw: parsed
    };
  }
  if (type === "text" || type === "message" || type === "assistant_text") {
    return { type: "text", text: String(record.text ?? record.content ?? record.message ?? ""), raw: parsed };
  }
  if (type === "tool_use" || type === "tool_call") {
    return {
      type: "tool_use",
      name: String(record.name ?? record.tool ?? "tool"),
      input: record.input ?? record.arguments ?? null,
      toolCallId: record.tool_call_id == null ? null : String(record.tool_call_id),
      raw: parsed
    };
  }
  if (type === "tool_result") {
    return {
      type: "tool_result",
      name: String(record.name ?? record.tool ?? "tool"),
      output: stringifyOutput(record.output ?? record.result ?? record.content),
      durationMs: numberOrNull(record.duration_ms ?? record.durationMs),
      isError: Boolean(record.is_error ?? record.isError ?? record.error),
      toolCallId: record.tool_call_id == null ? null : String(record.tool_call_id),
      raw: parsed
    };
  }
  if (type === "result") {
    const requiresApproval = Boolean(record.requires_approval ?? record.requiresApproval ?? record.approval_required);
    return {
      type: "result",
      text: String(record.text ?? record.result ?? record.output ?? ""),
      sessionId: sessionIdOf(record),
      exitCode: numberOrNull(record.exit_code ?? record.exitCode),
      durationMs: numberOrNull(record.duration_ms ?? record.durationMs),
      usage: usageOf(record.tokens ?? record.usage),
      error: record.error == null ? null : String(record.error),
      requiresApproval,
      raw: parsed
    };
  }
  if (type === "error") {
    return {
      type: "error",
      message: String(record.message ?? record.error ?? "Hermes 返回错误"),
      requiresApproval: Boolean(record.requires_approval ?? record.requiresApproval ?? record.approval_required),
      raw: parsed
    };
  }
  if (type === "approval_request" || type === "permission_request" || record.requires_approval === true) {
    return {
      type: "error",
      message: String(record.message ?? "Hermes 需要人工审批才能继续"),
      requiresApproval: true,
      raw: parsed
    };
  }
  return { type: "text", text: stringifyOutput(parsed), raw: parsed };
}

export function hermesProgress(event: HermesStreamEvent): HermesProgress | null {
  if (event.type === "system") {
    if (!event.sessionId) return null;
    return {
      type: "system",
      message: "Hermes 已启动",
      detail: { executorId: "hermes", eventType: "system", ...(event.subtype ? { status: event.subtype } : {}), text: event.sessionId }
    };
  }
  if (event.type === "text") {
    const text = event.text.trim();
    if (!text) return null;
    return {
      type: "text",
      message: clip(text.replace(/\s+/g, " "), 160),
      detail: { executorId: "hermes", eventType: "text", text: clip(text, 8_000) }
    };
  }
  if (event.type === "tool_use") {
    return {
      type: "tool_use",
      message: `调用工具：${event.name}`,
      detail: { executorId: "hermes", eventType: "tool_use", title: event.name, input: event.input }
    };
  }
  if (event.type === "tool_result") {
    return {
      type: "tool_result",
      message: `${event.isError ? "工具失败" : "工具完成"}：${event.name}`,
      detail: {
        executorId: "hermes",
        eventType: "tool_result",
        title: event.name,
        output: clip(event.output, 8_000),
        ...(event.durationMs === null ? {} : { durationMs: event.durationMs }),
        status: event.isError ? "failed" : "completed"
      }
    };
  }
  if (event.type === "result") {
    return {
      type: "result",
      message: event.error ? `执行结束：${clip(event.error, 120)}` : "执行完成",
      detail: {
        executorId: "hermes",
        eventType: "result",
        ...(event.exitCode === null ? {} : { exitCode: event.exitCode }),
        ...(event.durationMs === null ? {} : { durationMs: event.durationMs }),
        text: clip(event.text, 8_000)
      }
    };
  }
  return { type: "error", message: event.message, detail: { executorId: "hermes", eventType: "error", text: event.message } };
}

export async function runHermes(options: HermesRunOptions): Promise<HermesRunResult> {
  const started = Date.now();
  const promptDir = mkdtempSync(join(tmpdir(), "hearth-hermes-"));
  const promptPath = join(promptDir, "prompt.md");
  writeFileSync(promptPath, options.prompt, "utf8");
  const args = hermesArgs({
    promptPath,
    mode: options.mode,
    maxTurns: options.maxTurns,
    runBudgetSeconds: options.runBudgetSeconds,
    ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {})
  });

  try {
    return await new Promise<HermesRunResult>((resolve, reject) => {
      const child = spawn(options.command, args, {
        cwd: options.workingDirectory,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false
      });
      let settled = false;
      let buffer = "";
      let stderr = "";
      let finalText = "";
      let sessionId: string | null = null;
      let usage: RunUsage | null = null;
      let exitCode: number | null = null;
      let durationMs: number | null = null;
      let terminalError: string | null = null;
      let approvalRequired = false;

      const finish = (result: HermesRunResult | Error) => {
        if (settled) return;
        settled = true;
        if (options.signal) options.signal.removeEventListener("abort", onAbort);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const onAbort = () => {
        killProcessTree(child.pid);
        finish(new Error("任务已取消"));
      };
      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      const handleLine = (line: string) => {
        const event = parseHermesEvent(line);
        if (!event) return;
        options.onContextItem?.(event);
        const progress = hermesProgress(event);
        if (progress) options.onEvent?.(progress);
        if (event.type === "system" && event.sessionId) sessionId = event.sessionId;
        if (event.type === "text") finalText = event.text;
        if (event.type === "result") {
          if (event.sessionId) sessionId = event.sessionId;
          if (event.text.trim()) finalText = event.text;
          usage = event.usage ?? usage;
          exitCode = event.exitCode;
          durationMs = event.durationMs;
          terminalError = event.error;
          approvalRequired = approvalRequired || event.requiresApproval;
        }
        if (event.type === "error") {
          approvalRequired = approvalRequired || event.requiresApproval;
          terminalError = event.message;
        }
      };

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          handleLine(line);
          index = buffer.indexOf("\n");
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
      });
      child.on("error", (error) => {
        finish(new HermesStartupError(`无法启动 Hermes：${error.message}。请在设置里检查 Hermes 命令路径。`));
      });
      child.on("close", (code) => {
        if (buffer.trim()) handleLine(buffer);
        const elapsed = durationMs ?? Date.now() - started;
        if (approvalRequired) {
          finish(new HermesApprovalRequiredError("Hermes 需要人工审批才能继续。必要审批模式下不会静默放行；请配置 Hermes 授权或切换为完全权限后重试。"));
          return;
        }
        if (code !== 0 || (exitCode !== null && exitCode !== 0) || terminalError) {
          const detail = terminalError || stderr.trim() || `退出码 ${code ?? exitCode ?? "未知"}`;
          finish(new Error(`Hermes 执行失败：${clip(detail, 4_000)}`));
          return;
        }
        finish({ finalResponse: finalText, usage, sessionId, exitCode: exitCode ?? code, durationMs: elapsed });
      });
    });
  } finally {
    try {
      rmSync(promptDir, { recursive: true, force: true });
    } catch {
      // Temp cleanup is best effort.
    }
  }
}

export function hermesArgs(options: {
  promptPath: string;
  mode: ApprovalMode;
  maxTurns: number;
  runBudgetSeconds: number;
  resumeSessionId?: string;
}): string[] {
  const args = [
    "chat",
    "--query-file", options.promptPath,
    "--format", "stream-json",
    "--oneshot",
    "--max-turns", String(Math.max(1, options.maxTurns)),
    "--run-budget", String(Math.max(1, Math.round(options.runBudgetSeconds)))
  ];
  if (options.mode === "full") args.push("--yolo");
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  return args;
}

export function probeHermes(command: string, timeoutMs = 60_000): Promise<HermesProbeResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(command, ["--version"], { timeout: Math.min(timeoutMs, 8_000), windowsHide: true }, async (error, stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          command,
          version: null,
          text: null,
          error: `无法运行“${command} --version”：${error.message}`,
          code: "EXECUTOR_MISSING",
          elapsedMs: Date.now() - started
        });
        return;
      }
      const version = `${stdout}${stderr}`.trim().split(/\r?\n/)[0] ?? null;
      const root = mkdtempSync(join(tmpdir(), "hearth-hermes-probe-"));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs - (Date.now() - started)));
      try {
        const result = await runHermes({
          command,
          workingDirectory: root,
          prompt: "Reply with exactly HEARTH_OK and nothing else. Do not use tools or read any files.",
          mode: "full",
          maxTurns: 1,
          runBudgetSeconds: Math.max(1, Math.round(timeoutMs / 1_000)),
          signal: controller.signal
        });
        const text = result.finalResponse.trim();
        if (text.includes("HEARTH_OK")) {
          resolve({ ok: true, command, version: version || null, text, error: null, code: null, elapsedMs: Date.now() - started });
        } else {
          resolve({
            ok: false,
            command,
            version: version || null,
            text,
            error: `Hermes 未返回预期的最小响应 HEARTH_OK，实际返回：${clip(text, 500) || "（空）"}`,
            code: "UNEXPECTED_PROBE_RESPONSE",
            elapsedMs: Date.now() - started
          });
        }
      } catch (caught) {
        const message = controller.signal.aborted
          ? `Hermes 测试超时（${Math.round(timeoutMs / 1_000)} 秒）`
          : caught instanceof Error ? caught.message : String(caught);
        resolve({
          ok: false,
          command,
          version: version || null,
          text: null,
          error: message,
          code: hermesProbeErrorCode(message),
          elapsedMs: Date.now() - started
        });
      } finally {
        clearTimeout(timer);
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}

export function hermesProbeErrorCode(message: string): string {
  if (/\b429\b|too many requests|rate.?limit|quota|额度|配额|余额|上限/i.test(message)) return "HTTP_429";
  if (/approval|审批/i.test(message)) return "APPROVAL_REQUIRED";
  if (/login|auth|api.?key|credential|登录|认证/i.test(message)) return "AUTH_FAILED";
  return "PROBE_FAILED";
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

function sessionIdOf(record: Record<string, unknown>): string | null {
  const value = record.session_id ?? record.sessionId ?? record.id;
  return value == null ? null : String(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function usageOf(value: unknown): RunUsage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const input = numberOrNull(record.input_tokens ?? record.inputTokens ?? record.input) ?? 0;
  const output = numberOrNull(record.output_tokens ?? record.outputTokens ?? record.output) ?? 0;
  const cached = numberOrNull(record.cached_input_tokens ?? record.cachedInputTokens ?? record.cached) ?? 0;
  if (input === 0 && output === 0 && cached === 0) return null;
  return { inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 };
}

function stringifyOutput(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
