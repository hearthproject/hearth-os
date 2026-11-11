import type { RunUsage } from "@hearth/core";
import { compactAgentMessages, compactAgentMessagesWithSummary } from "./compaction.ts";
import type {
  AgentCheckpoint,
  AgentMessage,
  AgentRunResult,
  AgentRunStatus,
  AgentRuntimeOptions,
  AgentToolResult,
  RuntimeEvent
} from "./types.ts";

export function zeroUsage(): RunUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0
  };
}

export async function runAgent(options: AgentRuntimeOptions): Promise<AgentRunResult> {
  const allowed = new Set(options.permissions.tools);
  const tools = options.tools.filter((tool) => allowed.has(tool.definition.name));
  const toolMap = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const definitions = tools.map((tool) => tool.definition);
  const messages: AgentMessage[] = options.resume
    ? cloneMessages(options.resume.messages)
    : [
        { role: "system", content: options.systemPrompt },
        { role: "user", content: options.goal }
      ];
  let usage: RunUsage = options.resume ? { ...options.resume.usage } : zeroUsage();
  let turns = options.resume?.turns ?? 0;
  let toolCalls = options.resume?.toolCalls ?? 0;
  let seq = 0;
  let summary: string | null = null;
  let emptyTurns = 0;
  let missingFinishTurns = 0;
  const startedAt = Date.now();
  const signal = options.signal ?? new AbortController().signal;

  const emit = (event: RuntimeEvent): void => options.onEvent?.(event);
  const aborted = (): boolean => signal.aborted;
  const totalTokens = (): number => usage.inputTokens + usage.outputTokens;

  function finish(status: AgentRunStatus, resultSummary: string, outputs: string[] = [], question: string | null = null): AgentRunResult {
    return {
      status,
      summary: resultSummary,
      messages: cloneMessages(messages),
      usage: { ...usage },
      turns,
      toolCalls,
      outputs,
      question
    };
  }

  async function checkpoint(kind: AgentCheckpoint["kind"]): Promise<void> {
    seq += 1;
    const checkpoint: AgentCheckpoint = {
      seq,
      kind,
      messages: cloneMessages(messages),
      usage: { ...usage },
      turns,
      toolCalls,
      summary
    };
    try {
      await options.onCheckpoint?.(checkpoint);
      emit({ type: "checkpoint.created", seq, kind });
    } catch (error) {
      emit({ type: "checkpoint.failed", seq, kind, message: errorMessage(error) });
    }
  }

  while (turns < options.budget.maxTurns) {
    if (aborted()) return finish("cancelled", "任务已取消");

    const elapsed = Date.now() - startedAt;
    if (elapsed > options.budget.maxDurationMs) {
      emit({ type: "budget.exceeded", budget: "duration", limit: options.budget.maxDurationMs });
      await checkpoint("budget");
      return finish("budget_exceeded", summary ?? "执行时间超过预算，已停止");
    }
    if (totalTokens() > options.budget.maxTokens) {
      emit({ type: "budget.exceeded", budget: "tokens", limit: options.budget.maxTokens });
      await checkpoint("budget");
      return finish("budget_exceeded", summary ?? "Token 用量超过预算，已停止");
    }

    const compacted = options.contextWindowTokens
      ? await compactAgentMessagesWithSummary(messages, {
          contextWindowTokens: options.contextWindowTokens,
          ...(options.contextReserveTokens !== undefined ? { reserveTokens: options.contextReserveTokens } : {}),
          ...(options.recentContextTokens !== undefined ? { recentTokens: options.recentContextTokens } : {}),
          signal
        }, options.summarizeContext)
      : compactAgentMessages(messages);
    if (compacted.compacted) {
      messages.splice(0, messages.length, ...compacted.messages);
      emit({ type: "compacted", before: compacted.before, after: compacted.after });
      if ("summary" in compacted && typeof compacted.summary === "string") summary = compacted.summary;
      await checkpoint("compaction");
    }

    turns += 1;
    emit({ type: "turn.started", turn: turns });

    let turn;
    try {
      turn = await options.model(
        cloneMessages(messages),
        definitions,
        (text) => emit({ type: "assistant.delta", turn: turns, text }),
        signal
      );
    } catch (error) {
      if (aborted()) return finish("cancelled", "任务已取消");
      throw error;
    }

    if (turn.usage) {
      usage.inputTokens += Math.max(0, turn.usage.inputTokens);
      usage.outputTokens += Math.max(0, turn.usage.outputTokens);
      emit({ type: "usage", usage: { ...usage } });
    }
    if (turn.content.trim()) emit({ type: "assistant.message", turn: turns, text: turn.content });
    messages.push({ role: "assistant", content: turn.content, toolCalls: turn.toolCalls });
    await checkpoint("turn");

    if (turn.toolCalls.length === 0) {
      if (turn.content.trim() && !options.requireFinishTool) return finish("completed", turn.content.trim());
      if (turn.content.trim()) {
        missingFinishTurns += 1;
        if (missingFinishTurns > 1) return finish("failed", "模型连续用纯文本声称完成，但没有调用 finish_task");
        emit({ type: "notice", message: "原生任务必须调用 finish_task 收尾；已要求模型补充正式完成结果" });
        messages.push({ role: "user", content: "不要只用文本回复完成。请先核对产物，然后调用 finish_task，提供中文总结和输出路径。" });
        continue;
      }
      emptyTurns += 1;
      if (emptyTurns >= 3) return finish("failed", "模型连续没有返回可执行内容");
      messages.push({ role: "user", content: "请继续完成当前任务；如果已经完成，请调用 finish_task 并给出中文总结。" });
      continue;
    }
    emptyTurns = 0;
    missingFinishTurns = 0;

    for (const call of turn.toolCalls) {
      if (aborted()) return finish("cancelled", "任务已取消");
      if (toolCalls >= options.budget.maxToolCalls) {
        emit({ type: "budget.exceeded", budget: "toolCalls", limit: options.budget.maxToolCalls });
        await checkpoint("budget");
        return finish("budget_exceeded", summary ?? "工具调用次数超过预算，已停止");
      }

      toolCalls += 1;
      const tool = toolMap.get(call.name);
      const toolStartedAt = Date.now();
      emit({ type: "tool.started", turn: turns, call });

      let result: AgentToolResult = { content: `未知或未授权工具：${call.name}`, isError: true };
      if (tool) {
        let authorized = true;
        if (options.authorizeTool) {
          try {
            const authorization = await options.authorizeTool({ call, definition: tool.definition });
            authorized = authorization.allowed;
            if (!authorization.allowed) {
              result = { content: `用户尚未允许这个工具：${authorization.reason}`, isError: true };
            }
          } catch (error) {
            authorized = false;
            result = { content: `工具审批失败，已跳过：${errorMessage(error)}`, isError: true };
          }
        }
        if (authorized) {
          try {
            result = await tool.execute(call.arguments, {
              workspaceRoot: options.workspaceRoot,
              outDir: options.outDir,
              permissions: options.permissions,
              signal
            });
          } catch (error) {
            result = { content: `工具执行失败：${errorMessage(error)}`, isError: true };
          }
        }
      }

      emit({ type: "tool.finished", turn: turns, call, result, durationMs: Date.now() - toolStartedAt });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result.content,
        ...(result.isError ? { isError: true } : {})
      });

      if (result.action === "finish") {
        summary = (result.summary ?? result.content).trim() || "任务完成";
        await checkpoint("final");
        return finish("completed", summary, result.outputs ?? []);
      }
      if (result.action === "ask_user") {
        if (options.isFullPermission?.()) {
          emit({ type: "notice", message: "完全权限已开启，改为自行决策并继续" });
          messages.push({
            role: "user",
            content: "当前对话已切换为完全权限。请自行决策并继续完成剩余工作，不要再询问用户；在最终结果中说明关键假设。"
          });
          await checkpoint("tool");
          continue;
        }
        const question = (result.question ?? result.content).trim() || "需要你补充信息后才能继续";
        summary = question;
        await checkpoint("waiting_input");
        return finish("waiting_input", question, [], question);
      }

      await checkpoint("tool");
      if (totalTokens() > options.budget.maxTokens) {
        emit({ type: "budget.exceeded", budget: "tokens", limit: options.budget.maxTokens });
        await checkpoint("budget");
        return finish("budget_exceeded", summary ?? "Token 用量超过预算，已停止");
      }
    }
  }

  emit({ type: "budget.exceeded", budget: "turns", limit: options.budget.maxTurns });
  await checkpoint("budget");
  return finish("budget_exceeded", summary ?? "达到最大执行轮次，任务未完成");
}

function cloneMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      return { role: "assistant", content: message.content, toolCalls: message.toolCalls.map((call) => ({ ...call })) };
    }
    return { ...message };
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
