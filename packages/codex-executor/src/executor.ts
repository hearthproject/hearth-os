import { Codex, type ThreadItem } from "@openai/codex-sdk";
import type { RunUsage, TaskProgressDetail } from "@hearth/core";
import { buildCodexEnv, describeCodexProfile, loadCodexProfile, type CodexProfile } from "./profile.ts";

export interface CodexRunOptions {
  workingDirectory: string;
  outDir?: string;
  prompt: string;
  signal?: AbortSignal;
  outputSchema?: unknown;
  onEvent?: (event: CodexProgress) => void;
  onContextItem?: (item: ThreadItem) => void;
  onThreadStarted?: (threadId: string) => void;
  profile?: CodexProfile;
  codex?: Codex;
  threadId?: string;
  networkAccessEnabled?: boolean;
}

export interface CodexProgress {
  type: "thread.started" | "item.completed" | "turn.completed" | "error";
  message: string;
  detail?: TaskProgressDetail;
}

export interface CodexRunResult {
  threadId: string | null;
  finalResponse: string;
  usage: RunUsage | null;
  profileLabel: string;
}

export async function runCodex(options: CodexRunOptions): Promise<CodexRunResult> {
  const profile = options.profile ?? loadCodexProfile();
  if (!profile.canRun) throw new Error(`Codex 不可用：${profile.issues.join("；")}`);

  const codex = options.codex ?? new Codex({ env: buildCodexEnv(profile) });
  const threadOptions = {
    ...(profile.model ? { model: profile.model } : {}),
    workingDirectory: options.workingDirectory,
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled: options.networkAccessEnabled ?? false,
    webSearchMode: "disabled"
  } as const;
  const thread = options.threadId
    ? codex.resumeThread(options.threadId, threadOptions)
    : codex.startThread(threadOptions);

  const turnOptions = options.signal
    ? { signal: options.signal, ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}) }
    : options.outputSchema
      ? { outputSchema: options.outputSchema }
      : {};
  const { events } = await thread.runStreamed(options.prompt, turnOptions);
  let finalResponse = "";
  let usage: RunUsage | null = null;
  let lastProgress = "";
  const emit = (type: CodexProgress["type"], message: string, detail?: TaskProgressDetail) => {
    if (!message || message === lastProgress) return;
    lastProgress = message;
    options.onEvent?.({ type, message, ...(detail ? { detail } : {}) });
  };

  for await (const event of events) {
    if (event.type === "thread.started") {
      options.onThreadStarted?.(event.thread_id);
      emit("thread.started", "开始执行");
    } else if (event.type === "item.completed") {
      options.onContextItem?.(event.item);
      if (event.item.type === "agent_message") finalResponse = event.item.text;
      const described = describeItem(event.item);
      emit("item.completed", described.message, described.detail);
    } else if (event.type === "turn.completed") {
      usage = {
        inputTokens: event.usage.input_tokens,
        cachedInputTokens: event.usage.cached_input_tokens,
        cacheWriteInputTokens: event.usage.cache_write_input_tokens,
        outputTokens: event.usage.output_tokens,
        reasoningOutputTokens: event.usage.reasoning_output_tokens
      };
      emit("turn.completed", "执行完成");
    } else if (event.type === "turn.failed") {
      emit("error", event.error.message);
      throw new Error(event.error.message);
    } else if (event.type === "error") {
      if (!isIgnorableNotice(event.message)) emit("error", event.message);
    }
  }

  return { threadId: thread.id, finalResponse, usage, profileLabel: describeCodexProfile(profile) };
}

export async function probeCodex(profile = loadCodexProfile()): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (!profile.canRun) return { ok: false, error: profile.issues.join("；") };
  try {
    const result = await runCodex({
      profile,
      workingDirectory: process.cwd(),
      prompt: "Reply with exactly HEARTH_OK and nothing else. Do not use tools."
    });
    const text = result.finalResponse.trim();
    const reachable = text.includes("HEARTH_OK");
    return reachable ? { ok: true, text } : { ok: false, error: `执行器返回了意外内容：${text.slice(0, 500)}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function describeItem(item: ThreadItem): { message: string; detail: TaskProgressDetail } {
  if (item.type === "command_execution") {
    return {
      message: classifyCommand(item.command),
      detail: {
        executorId: "codex",
        eventType: "item.completed",
        itemType: item.type,
        command: humanizeCommand(item.command),
        output: clip(item.aggregated_output ?? "", 8_000),
        status: item.status,
        ...(item.exit_code === undefined ? {} : { exitCode: item.exit_code })
      }
    };
  }
  if (item.type === "file_change") {
    const paths = item.changes.map((change) => change.path).join("、");
    return {
      message: (item.status === "failed" ? "文件修改失败" : "修改文件") + "：" + clip(paths || "未记录路径", 160),
      detail: {
        executorId: "codex",
        eventType: "item.completed",
        itemType: item.type,
        status: item.status,
        paths: item.changes.map((change) => `${change.kind}:${change.path}`)
      }
    };
  }
  if (item.type === "mcp_tool_call") {
    return {
      message: "调用工具：" + item.server + "/" + item.tool,
      detail: {
        executorId: "codex",
        eventType: "item.completed",
        itemType: item.type,
        title: `${item.server}/${item.tool}`,
        input: item.arguments,
        status: item.status,
        ...(item.error ? { output: item.error.message } : item.result ? { output: clip(safeStringify(item.result.structured_content ?? item.result), 8_000) } : {})
      }
    };
  }
  if (item.type === "web_search") {
    return {
      message: "网页搜索：" + clip(item.query, 120),
      detail: { executorId: "codex", eventType: "item.completed", itemType: item.type, query: item.query }
    };
  }
  if (item.type === "reasoning") {
    return {
      message: "正在分析",
      detail: { executorId: "codex", eventType: "item.completed", itemType: item.type, text: clip(item.text, 8_000) }
    };
  }
  if (item.type === "agent_message") {
    return {
      message: "整理最终结果",
      detail: { executorId: "codex", eventType: "item.completed", itemType: item.type, text: clip(item.text, 8_000) }
    };
  }
  if (item.type === "todo_list") {
    return {
      message: "更新了执行计划",
      detail: {
        executorId: "codex",
        eventType: "item.completed",
        itemType: item.type,
        text: item.items.map((todo) => `${todo.completed ? "[x]" : "[ ]"} ${todo.text}`).join("\n")
      }
    };
  }
  if (item.type === "error") {
    return {
      message: isIgnorableNotice(item.message) ? "" : "执行提示：" + clip(item.message, 160),
      detail: { executorId: "codex", eventType: "error", itemType: item.type, text: item.message }
    };
  }
  return { message: "处理了一步工作", detail: { executorId: "codex", eventType: "item.completed" } };
}

function classifyCommand(command: string): string {
  const text = humanizeCommand(command).toLowerCase();
  if (/(^|[\s;&|])(npm|pnpm|yarn|bun)\s+(run\s+)?(test|typecheck|lint|build)|vitest|jest|pytest|tsc|eslint|prettier/.test(text)) return "运行检查";
  if (/(^|[\s;&|])(npm|pnpm|yarn|bun)\s+(install|add|i)\b|pip\s+install|uv\s+(add|pip)/.test(text)) return "安装依赖";
  if (/(^|[\s;&|])(node|python|python3|py)\b/.test(text)) return "运行脚本";
  if (/(^|[\s;&|])(curl|invoke-webrequest|wget)\b/.test(text)) return "访问网页";
  if (/(^|[\s;&|])(npm|pnpm|yarn|bun)\b/.test(text)) return "运行项目命令";
  if (/(^|[\s;&|])(git|rg|grep|find|dir|ls|cat|type|head|tail|get-childitem|get-content|select-string)\b/.test(text)) return "查看项目文件";
  if (/(^|[\s;&|])(mkdir|new-item|copy|cp|move|mv|remove-item|rm|del)\b/.test(text)) return "整理工作目录";
  return "执行操作";
}

function isIgnorableNotice(message: string): boolean {
  return /model metadata|defaulting to fallback|fallback metadata|unknown model/i.test(message);
}

function humanizeCommand(command: string): string {
  const trimmed = command.trim();
  const wrapper = /^(?:"[^"]*(?:pwsh|powershell)\.exe"|(?:pwsh|powershell)\.exe)\s+-Command\s+([\s\S]*)$/i.exec(trimmed)
    ?? /^(?:"[^"]*cmd\.exe"|cmd\.exe)\s+(?:\/d\s+\/s\s+\/c|\/c)\s+([\s\S]*)$/i.exec(trimmed);
  if (!wrapper?.[1]) return trimmed;
  let inner = wrapper[1].trim();
  if (!inner) return trimmed;
  const quote = inner.charAt(0);
  if ((quote.charCodeAt(0) === 34 || quote.charCodeAt(0) === 39) && inner.endsWith(quote)) inner = inner.slice(1, -1);
  return inner.replace(/\\"/g, String.fromCharCode(34)).trim() || trimmed;
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
