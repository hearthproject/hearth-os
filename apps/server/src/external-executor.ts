import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { ApprovalMode, ExecutorId, RunUsage, TaskProgressDetail } from "@hearth/core";
import type { ExecutorLaunch } from "./executor-runtime.ts";

export interface ExternalProgress {
  type: string;
  message: string;
  detail?: TaskProgressDetail;
}

export interface ExternalRunOptions {
  id: ExecutorId;
  launch: ExecutorLaunch;
  workingDirectory: string;
  prompt: string;
  mode: ApprovalMode;
  maxTurns: number;
  runBudgetSeconds: number;
  resumeSessionId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: ExternalProgress) => void;
}

export interface ExternalRunResult {
  finalResponse: string;
  usage: RunUsage | null;
  sessionId: string | null;
  exitCode: number | null;
  durationMs: number | null;
}

interface LineState {
  finalText: string;
  sessionId: string | null;
  usage: RunUsage | null;
  error: string | null;
  exitCode: number | null;
  durationMs: number | null;
}

type LineHandler = (
  record: Record<string, unknown>,
  state: LineState,
  emit: (type: string, message: string, detail?: TaskProgressDetail) => void
) => void;

interface LineRunnerSpec {
  args: string[];
  stdin: string | null;
  env: Record<string, string>;
  handle: LineHandler;
}

export function runExternalExecutor(options: ExternalRunOptions): Promise<ExternalRunResult> {
  if (options.id === "qoder") return runQoderSdk(options);
  if (options.id === "zcode") return runZcodeJson(options);
  if (options.id === "workbuddy") {
    return runLineJson(options, {
      args: workbuddyArgs(options),
      stdin: options.prompt,
      env: { CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: "1" },
      handle: handleWorkbuddyLine
    });
  }
  if (options.id === "kimi") {
    return runLineJson(options, {
      args: kimiArgs(options),
      stdin: null,
      env: {},
      handle: handleKimiLine
    });
  }
  throw new Error(`${options.id} 不是外部 CLI 执行器`);
}

export function kimiArgs(options: Pick<ExternalRunOptions, "prompt" | "resumeSessionId">): string[] {
  const args = ["-p", options.prompt, "--output-format", "stream-json"];
  if (options.resumeSessionId) args.push("-r", options.resumeSessionId);
  return args;
}

export function workbuddyArgs(options: Pick<ExternalRunOptions, "mode" | "resumeSessionId">): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (options.mode === "full") args.push("-y");
  else args.push("--permission-mode", "acceptEdits");
  if (options.resumeSessionId) args.push("-r", options.resumeSessionId);
  return args;
}

export function zcodeArgs(options: Pick<ExternalRunOptions, "prompt" | "workingDirectory" | "mode" | "resumeSessionId">): string[] {
  const args = [
    "--prompt", options.prompt,
    "--json",
    "--cwd", options.workingDirectory,
    "--mode", options.mode === "full" ? "yolo" : "guarded"
  ];
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  return args;
}

function runLineJson(options: ExternalRunOptions, spec: LineRunnerSpec): Promise<ExternalRunResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(options.launch.command, [...options.launch.args, ...spec.args], {
      cwd: options.workingDirectory,
      windowsHide: true,
      stdio: [spec.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.launch.env, ...spec.env },
      shell: false
    });
    const state: LineState = {
      finalText: "",
      sessionId: null,
      usage: null,
      error: null,
      exitCode: null,
      durationMs: null
    };
    const emit = (type: string, message: string, detail?: TaskProgressDetail) => {
      options.onProgress?.({
        type,
        message,
        ...(detail ? { detail: { ...detail, executorId: options.id } } : {})
      });
    };
    let buffer = "";
    let stderr = "";
    let settled = false;

    const finish = (result: ExternalRunResult | Error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const onAbort = () => {
      killProcessTree(child.pid);
      finish(new Error("任务已取消"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        emit("text", clip(trimmed, 160), { executorId: options.id, eventType: "text", text: clip(trimmed, 8_000) });
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      spec.handle(parsed as Record<string, unknown>, state, emit);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        handleLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on("error", (error) => {
      finish(new Error(`无法启动 ${options.id}：${error.message}`));
    });
    child.on("close", (code) => {
      if (buffer.trim()) handleLine(buffer);
      state.exitCode = code;
      state.durationMs = Date.now() - started;
      if (state.error) {
        finish(new Error(`${options.id} 执行失败：${clip(state.error, 4_000)}`));
        return;
      }
      if (code !== 0) {
        finish(new Error(`${options.id} 执行失败：${clip(stderr.trim() || `退出码 ${code ?? "未知"}`, 4_000)}`));
        return;
      }
      finish({
        finalResponse: state.finalText,
        usage: state.usage,
        sessionId: state.sessionId,
        exitCode: code,
        durationMs: state.durationMs
      });
    });
    if (spec.stdin !== null) child.stdin?.end(spec.stdin);
  });
}

function handleKimiLine(record: Record<string, unknown>, state: LineState, emit: Emit): void {
  const role = stringValue(record.role);
  if (role === "assistant") {
    const content = stringValue(record.content);
    if (content) {
      state.finalText = content;
      emit("text", clip(content.replace(/\s+/g, " "), 160), { executorId: "kimi", eventType: "text", text: clip(content, 8_000) });
    }
    for (const call of arrayValue(record.tool_calls)) {
      const fn = asRecord(asRecord(call)?.function);
      const name = stringValue(fn?.name) || "tool";
      emit("tool_use", `调用工具：${name}`, { executorId: "kimi", eventType: "tool_use", title: name, input: fn?.arguments ?? null });
    }
    return;
  }
  if (role === "tool") {
    const output = stringValue(record.content);
    emit("tool_result", "工具返回结果", { executorId: "kimi", eventType: "tool_result", output: clip(output, 8_000) });
    return;
  }
  if (role === "meta") {
    const type = stringValue(record.type);
    if (type === "session.resume_hint") state.sessionId = stringValue(record.session_id) || state.sessionId;
    if (type === "system.version") {
      emit("system", `Kimi Code ${stringValue(record.version)}`, { executorId: "kimi", eventType: "system", status: "started" });
    }
    return;
  }
  if (record.type === "error") {
    state.error = stringValue(record.message) || "Kimi 返回错误";
    emit("error", state.error, { executorId: "kimi", eventType: "error", text: state.error });
  }
}

function handleWorkbuddyLine(record: Record<string, unknown>, state: LineState, emit: Emit): void {
  const type = stringValue(record.type);
  const sessionId = stringValue(record.session_id);
  if (sessionId) state.sessionId = sessionId;
  if (type === "system") {
    if (record.subtype === "init") {
      emit("system", "WorkBuddy 已启动", { executorId: "workbuddy", eventType: "system", status: "started", text: sessionId });
    }
    return;
  }
  if (type === "assistant") {
    const message = asRecord(record.message);
    for (const block of arrayValue(message?.content)) {
      const item = asRecord(block);
      if (!item) continue;
      if (item.type === "text") {
        const text = stringValue(item.text);
        if (text) {
          state.finalText = text;
          emit("text", clip(text.replace(/\s+/g, " "), 160), { executorId: "workbuddy", eventType: "text", text: clip(text, 8_000) });
        }
      }
      if (item.type === "tool_use") {
        const name = stringValue(item.name) || "tool";
        emit("tool_use", `调用工具：${name}`, { executorId: "workbuddy", eventType: "tool_use", title: name, input: item.input ?? null });
      }
      if (item.type === "tool_result") {
        const output = stringValue(item.content);
        emit("tool_result", item.is_error === true ? "工具失败" : "工具完成", {
          executorId: "workbuddy",
          eventType: "tool_result",
          output: clip(output, 8_000),
          status: item.is_error === true ? "failed" : "completed"
        });
      }
    }
    return;
  }
  if (type === "result") {
    state.sessionId = stringValue(record.session_id) || state.sessionId;
    state.usage = usageOf(record.usage) ?? state.usage;
    if (record.subtype === "success") {
      const text = stringValue(record.result);
      if (text) state.finalText = text;
      state.durationMs = numberValue(record.duration_ms);
      emit("result", "WorkBuddy 执行完成", { executorId: "workbuddy", eventType: "result", text: clip(state.finalText, 8_000) });
    } else {
      const errors = arrayValue(record.errors).map((value) => stringValue(value)).filter(Boolean);
      state.error = errors.join("；") || stringValue(record.error_message) || `WorkBuddy 返回 ${stringValue(record.subtype)}`;
      emit("error", state.error, { executorId: "workbuddy", eventType: "error", text: state.error });
    }
  }
}

function runZcodeJson(options: ExternalRunOptions): Promise<ExternalRunResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(options.launch.command, [...options.launch.args, ...zcodeArgs(options)], {
      cwd: options.workingDirectory,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.launch.env },
      shell: false
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const emit = (type: string, message: string, detail?: TaskProgressDetail) => {
      options.onProgress?.({
        type,
        message,
        ...(detail ? { detail: { ...detail, executorId: "zcode" } } : {})
      });
    };
    const finish = (result: ExternalRunResult | Error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const onAbort = () => {
      killProcessTree(child.pid);
      finish(new Error("任务已取消"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    emit("system", "ZCode 已启动", { executorId: "zcode", eventType: "system", status: "started" });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 4_000_000) stdout = stdout.slice(-4_000_000);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on("error", (error) => finish(new Error(`无法启动 ZCode：${error.message}`)));
    child.on("close", (code) => {
      const elapsed = Date.now() - started;
      const parsed = extractJson(stdout);
      if (code !== 0) {
        const message = parsed ? stringValue(parsed.error_message) || stringValue(parsed.response) : "";
        finish(new Error(`ZCode 执行失败：${clip(message || stderr.trim() || `退出码 ${code ?? "未知"}`, 4_000)}`));
        return;
      }
      if (!parsed) {
        const text = stdout.trim();
        if (!text) {
          finish(new Error(`ZCode 没有返回结果：${clip(stderr.trim(), 2_000)}`));
          return;
        }
        finish({ finalResponse: text, usage: null, sessionId: null, exitCode: code, durationMs: elapsed });
        return;
      }
      const finalResponse = stringValue(parsed.response) || stringValue(parsed.result) || stringValue(parsed.text);
      emit("result", "ZCode 执行完成", { executorId: "zcode", eventType: "result", text: clip(finalResponse, 8_000) });
      finish({
        finalResponse,
        usage: usageOf(parsed.usage),
        sessionId: stringValue(parsed.sessionId) || stringValue(parsed.session_id) || null,
        exitCode: code,
        durationMs: numberValue(parsed.duration_ms) ?? elapsed
      });
    });
  });
}

interface QoderSdkModule {
  query?: (input: { prompt: string; options: Record<string, unknown> }) => QoderQuery;
  qodercliAuth?: () => unknown;
  accessTokenFromEnv?: () => unknown;
}

interface QoderQuery extends AsyncIterable<Record<string, unknown>> {
  close?: () => Promise<void> | void;
}

async function runQoderSdk(options: ExternalRunOptions): Promise<ExternalRunResult> {
  if (!options.launch.script) throw new Error("Qoder SDK 路径未配置");
  const cliPath = options.launch.env.QODERCLI_PATH;
  if (cliPath && !process.env.QODERCLI_PATH) process.env.QODERCLI_PATH = cliPath;
  const sdk = await import(pathToFileURL(options.launch.script).href) as QoderSdkModule;
  if (typeof sdk.query !== "function") throw new Error("Qoder SDK 缺少 query 导出");
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) controller.abort();

  const auth = process.env.QODER_PERSONAL_ACCESS_TOKEN && sdk.accessTokenFromEnv
    ? sdk.accessTokenFromEnv()
    : sdk.qodercliAuth ? sdk.qodercliAuth() : { type: "qodercli" };
  const queryOptions: Record<string, unknown> = {
    auth,
    cwd: options.workingDirectory,
    maxTurns: Math.max(1, options.maxTurns),
    permissionMode: options.mode === "full" ? "bypassPermissions" : "acceptEdits",
    abortController: controller,
    ...(options.resumeSessionId ? { resume: options.resumeSessionId } : {})
  };

  const emit = (type: string, message: string, detail?: TaskProgressDetail) => {
    options.onProgress?.({
      type,
      message,
      ...(detail ? { detail: { ...detail, executorId: "qoder" } } : {})
    });
  };

  let finalText = "";
  let sessionId: string | null = null;
  let usage: RunUsage | null = null;
  let terminalError: string | null = null;
  let durationMs: number | null = null;
  const started = Date.now();
  const query = sdk.query({ prompt: options.prompt, options: queryOptions });
  try {
    for await (const raw of query) {
      const message = asRecord(raw) ?? {};
      const type = stringValue(message.type);
      const messageSession = stringValue(message.session_id);
      if (messageSession) sessionId = messageSession;
      if (type === "system" && message.subtype === "init") {
        emit("system", "Qoder 已启动", { executorId: "qoder", eventType: "system", status: "started", text: sessionId ?? "" });
      }
      if (type === "assistant") {
        const body = asRecord(message.message);
        for (const block of arrayValue(body?.content)) {
          const item = asRecord(block);
          if (!item) continue;
          if (item.type === "text") {
            const text = stringValue(item.text);
            if (text) {
              finalText = text;
              emit("text", clip(text.replace(/\s+/g, " "), 160), { executorId: "qoder", eventType: "text", text: clip(text, 8_000) });
            }
          }
          if (item.type === "tool_use") {
            const name = stringValue(item.name) || "tool";
            emit("tool_use", `调用工具：${name}`, { executorId: "qoder", eventType: "tool_use", title: name, input: item.input ?? null });
          }
          if (item.type === "tool_result") {
            emit("tool_result", item.is_error === true ? "工具失败" : "工具完成", {
              executorId: "qoder",
              eventType: "tool_result",
              output: clip(stringValue(item.content), 8_000),
              status: item.is_error === true ? "failed" : "completed"
            });
          }
        }
      }
      if (type === "result") {
        usage = usageOf(message.usage) ?? usage;
        durationMs = numberValue(message.duration_ms);
        if (message.subtype === "success") {
          const text = stringValue(message.result);
          if (text) finalText = text;
          emit("result", "Qoder 执行完成", { executorId: "qoder", eventType: "result", text: clip(finalText, 8_000) });
        } else {
          const errors = arrayValue(message.errors).map((value) => stringValue(value)).filter(Boolean);
          terminalError = errors.join("；") || stringValue(message.error_message) || `Qoder 返回 ${stringValue(message.subtype)}`;
        }
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    try {
      await query.close?.();
    } catch {
      // Closing a finished query is best effort.
    }
  }
  if (options.signal?.aborted) throw new Error("任务已取消");
  if (terminalError) throw new Error(`Qoder 执行失败：${clip(terminalError, 4_000)}`);
  return {
    finalResponse: finalText,
    usage,
    sessionId,
    exitCode: 0,
    durationMs: durationMs ?? Date.now() - started
  };
}

type Emit = (type: string, message: string, detail?: TaskProgressDetail) => void;

function usageOf(value: unknown): RunUsage | null {
  const record = asRecord(value);
  if (!record) return null;
  const input = numberValue(record.input_tokens ?? record.inputTokens ?? record.prompt_tokens) ?? 0;
  const output = numberValue(record.output_tokens ?? record.completion_tokens) ?? 0;
  const cached = numberValue(record.cache_read_input_tokens ?? record.cached_input_tokens ?? record.cachedInputTokens) ?? 0;
  const cacheWrite = numberValue(record.cache_creation_input_tokens ?? record.cacheWriteInputTokens) ?? 0;
  const reasoning = numberValue(record.reasoning_output_tokens ?? record.reasoningOutputTokens) ?? 0;
  if (input === 0 && output === 0 && cached === 0 && cacheWrite === 0) return null;
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: reasoning
  };
}

function extractJson(output: string): Record<string, unknown> | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const lines = trimmed.split(/\r?\n/).reverse();
  for (const line of lines) {
    if (line.trim().startsWith("{")) {
      candidates.push(line.trim());
      break;
    }
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const record = asRecord(parsed);
      if (record) return record;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
