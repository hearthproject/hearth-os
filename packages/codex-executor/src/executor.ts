import { Codex, type ThreadItem } from "@openai/codex-sdk";
import type { RunUsage } from "@hearth/core";
import { buildCodexEnv, describeCodexProfile, loadCodexProfile, type CodexProfile } from "./profile.ts";

export interface CodexRunOptions {
  workingDirectory: string;
  prompt: string;
  signal?: AbortSignal;
  outputSchema?: unknown;
  onEvent?: (event: CodexProgress) => void;
  profile?: CodexProfile;
  codex?: Codex;
}

export interface CodexProgress {
  type: "thread.started" | "item.completed" | "turn.completed" | "error";
  message: string;
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
  const thread = codex.startThread({
    ...(profile.model ? { model: profile.model } : {}),
    workingDirectory: options.workingDirectory,
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchMode: "disabled"
  });

  const turnOptions = options.signal
    ? { signal: options.signal, ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}) }
    : options.outputSchema
      ? { outputSchema: options.outputSchema }
      : {};
  const { events } = await thread.runStreamed(options.prompt, turnOptions);
  let finalResponse = "";
  let usage: RunUsage | null = null;
  let lastProgress = "";
  const emit = (type: CodexProgress["type"], message: string) => {
    if (!message || message === lastProgress) return;
    lastProgress = message;
    options.onEvent?.({ type, message });
  };

  for await (const event of events) {
    if (event.type === "thread.started") {
      emit("thread.started", "开始执行");
    } else if (event.type === "item.completed") {
      if (event.item.type === "agent_message") finalResponse = event.item.text;
      emit("item.completed", describeItem(event.item));
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

export function describeItem(item: ThreadItem): string {
  if (item.type === "command_execution") return classifyCommand(item.command);
  if (item.type === "file_change") {
    const paths = item.changes.map((change) => change.path).join("、");
    return (item.status === "failed" ? "文件修改失败" : "修改文件") + "：" + clip(paths || "未记录路径", 160);
  }
  if (item.type === "mcp_tool_call") return "调用工具：" + item.server + "/" + item.tool;
  if (item.type === "web_search") return "网页搜索：" + clip(item.query, 120);
  if (item.type === "reasoning") return "正在分析";
  if (item.type === "agent_message") return "整理最终结果";
  if (item.type === "todo_list") return "更新了执行计划";
  if (item.type === "error") return isIgnorableNotice(item.message) ? "" : "执行提示：" + clip(item.message, 160);
  return "处理了一步工作";
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
