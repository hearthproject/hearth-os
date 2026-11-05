import { Codex } from "@openai/codex-sdk";
import type { RunUsage } from "@hearth/core";
import { describeCodexProfile, loadCodexProfile, type CodexProfile } from "./profile.ts";

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

  const codex = options.codex ?? new Codex();
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

  for await (const event of events) {
    if (event.type === "thread.started") {
      options.onEvent?.({ type: "thread.started", message: "Codex 已开始工作" });
    } else if (event.type === "item.completed") {
      if (event.item.type === "agent_message") finalResponse = event.item.text;
      options.onEvent?.({ type: "item.completed", message: describeItem(event.item.type) });
    } else if (event.type === "turn.completed") {
      usage = {
        inputTokens: event.usage.input_tokens,
        cachedInputTokens: event.usage.cached_input_tokens,
        cacheWriteInputTokens: event.usage.cache_write_input_tokens,
        outputTokens: event.usage.output_tokens,
        reasoningOutputTokens: event.usage.reasoning_output_tokens
      };
      options.onEvent?.({ type: "turn.completed", message: "Codex 已完成本轮工作" });
    } else if (event.type === "turn.failed") {
      options.onEvent?.({ type: "error", message: event.error.message });
      throw new Error(event.error.message);
    } else if (event.type === "error") {
      options.onEvent?.({ type: "error", message: event.message });
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
      prompt: "Reply with exactly HEARTH_OK and nothing else.",
      outputSchema: {
        type: "object",
        properties: { status: { type: "string", enum: ["ok"] }, answer: { type: "string" } },
        required: ["status", "answer"],
        additionalProperties: false
      }
    });
    return { ok: true, text: result.finalResponse };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function describeItem(type: string): string {
  if (type === "command_execution") return "执行了一条命令";
  if (type === "file_change") return "修改了工作文件";
  if (type === "reasoning") return "正在分析";
  if (type === "web_search") return "进行了网页搜索";
  return "处理了一步工作";
}
