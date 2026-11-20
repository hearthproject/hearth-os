import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { RunUsage } from "@hearth/core";
import { compactAgentMessages, compactAgentMessagesWithSummary } from "./compaction.ts";
import { createAgentState, progressSummary } from "./harness/file-state.ts";
import { serializeAgentState } from "./harness/checkpoint-state.ts";
import { planModeAllowsCommand, planModeAllowsTool } from "./harness/plan.ts";
import { buildPostCompactContext } from "./harness/post-compact.ts";
import { todoReminder } from "./harness/todo.ts";
import type {
  AgentCheckpoint,
  AgentUsage,
  AgentMessage,
  AgentRunResult,
  AgentRunStatus,
  AgentRuntimeOptions,
  AgentTool,
  AgentToolCall,
  AgentToolContext,
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


//整个agent的执行循环
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
  let finishRejections = 0;
  let sameProgressCount = 0;
  let lastProgressHash: string | null = null;
  let budgetReminderSent = false;
  let compactions = 0;
  const deniedPaths = new Map<string, number>();
  const startedAt = Date.now();
  const signal = options.signal ?? new AbortController().signal;
  const state = options.state ?? options.resume?.state ?? createAgentState(options.workspaceRoot);

  const emit = (event: RuntimeEvent): void => options.onEvent?.(event);
  const aborted = (): boolean => signal.aborted;
  const totalTokens = (): number => usage.inputTokens + usage.outputTokens;

  async function compactContext(force: boolean): Promise<boolean> {
    const restoredContext = buildPostCompactContext(state, { mode: options.mode ?? state.mode ?? "build" });
    const compacted = options.contextWindowTokens
      ? await compactAgentMessagesWithSummary(messages, {
          contextWindowTokens: force ? 1 : options.contextWindowTokens,
          reserveTokens: force ? 0 : options.contextReserveTokens ?? Math.max(16_000, Math.floor(options.contextWindowTokens * 0.15)),
          ...(options.recentContextTokens !== undefined ? { recentTokens: options.recentContextTokens } : {}),
          keepRecentToolOutputs: options.keepRecentToolOutputs ?? 0,
          stateSummary: progressSummary(state.progress),
          ...(options.projectInstructions ? { projectInstructions: options.projectInstructions } : {}),
          restoredContext,
          signal
        }, options.summarizeContext ? async (omitted, signal) => {
          const result = await options.summarizeContext!(omitted, signal);
          if (result && typeof result === "object") {
            if (result.usage) {
              addUsage(usage, result.usage);
              emit({ type: "usage", usage: { ...usage } });
            }
            return result.summary;
          }
          return result;
        } : undefined)
      : compactAgentMessages(messages, {
          keepRecentToolOutputs: options.keepRecentToolOutputs ?? 0,
          stateSummary: progressSummary(state.progress),
          ...(options.projectInstructions ? { projectInstructions: options.projectInstructions } : {}),
          restoredContext
        });
    // Output trimming applies even when history summarization is unnecessary.
    messages.splice(0, messages.length, ...compacted.messages);
    if (!compacted.compacted) return false;
    // The summary replaces the raw tool output, so a later read must return the
    // actual file body instead of deduplicating against a stale range.
    for (const read of state.readFiles.values()) delete read.ranges;
    compactions += 1;
    emit({ type: "compacted", before: compacted.before, after: compacted.after });
    emit({
      type: "context.watermark",
      estimatedTokens: Number("beforeTokens" in compacted ? compacted.beforeTokens : 0),
      usedTokens: totalTokens(),
      compactions
    });
    if ("summary" in compacted && typeof compacted.summary === "string") summary = compacted.summary;
    await checkpoint("compaction");
    return true;
  }

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
      summary,
      state: serializeAgentState(state),
      mode: options.mode ?? state.mode ?? "build"
    };
    try {
      await options.onCheckpoint?.(checkpoint);
      emit({ type: "checkpoint.created", seq, kind });
    } catch (error) {
      emit({ type: "checkpoint.failed", seq, kind, message: errorMessage(error) });
    }
  }

  function modeIssue(call: AgentToolCall): string | null {
    if (options.mode !== "plan") return null;
    if (!planModeAllowsTool(call.name)) {
      return `plan mode 不允许调用工具 ${call.name}。当前阶段只能读取和调查；请调用 submit_plan 提交方案，等待用户批准后再执行修改。`;
    }
    if (call.name === "shell") {
      const args = call.arguments && typeof call.arguments === "object" ? call.arguments as Record<string, unknown> : {};
      const command = typeof args.command === "string" ? args.command.trim() : "";
      if (!command || !planModeAllowsCommand(command)) {
        return `plan mode 只允许只读命令：${command || "（空命令）"}。请使用 git status/diff/log、rg、ls 等只读命令，或提交计划等待批准。`;
      }
    }
    return null;
  }

  function partitionToolCalls(calls: AgentToolCall[]): AgentToolCall[][] {
    const chunks: AgentToolCall[][] = [];
    const parallelLimit = Math.max(1, options.maxParallelTools ?? 1);
    let parallelChunk: AgentToolCall[] = [];
    for (const call of calls) {
      const executionMode = toolMap.get(call.name)?.definition.executionMode;
      if (executionMode === "parallel") {
        parallelChunk.push(call);
        if (parallelChunk.length >= parallelLimit) {
          chunks.push(parallelChunk);
          parallelChunk = [];
        }
        continue;
      }
      if (parallelChunk.length > 0) {
        chunks.push(parallelChunk);
        parallelChunk = [];
      }
      chunks.push([call]);
    }
    if (parallelChunk.length > 0) chunks.push(parallelChunk);
    return chunks;
  }

  async function executeParallelBatch(calls: AgentToolCall[]): Promise<Map<string, { result: AgentToolResult; durationMs: number }> | null> {
    const limit = options.maxParallelTools ?? 1;
    if (limit < 2 || calls.length < 2 || calls.length > limit) return null;
    const entries = calls.map((call) => ({ call, tool: toolMap.get(call.name) }));
    if (!entries.every((entry) => entry.tool?.definition.executionMode === "parallel")) return null;
    if (toolCalls + calls.length > options.budget.maxToolCalls || aborted()) return null;

    emit({ type: "tool.batch.started", turn: turns, calls, parallel: true });
    const started = Date.now();
    const results = new Map<string, { result: AgentToolResult; durationMs: number }>();
    const runnable: Array<{ call: AgentToolCall; tool: AgentTool }> = [];
    for (const entry of entries) {
      if (!entry.tool) continue;
      const modeError = modeIssue(entry.call);
      if (modeError) {
        results.set(entry.call.id, { result: { content: modeError, isError: true }, durationMs: 0 });
        continue;
      }
      let authorized = true;
      if (options.authorizeTool) {
        try {
          const authorization = await options.authorizeTool({ call: entry.call, definition: entry.tool.definition });
          authorized = authorization.allowed;
          if (!authorization.allowed) {
            results.set(entry.call.id, { result: { content: `用户尚未允许这个工具：${"reason" in authorization ? authorization.reason : "未授权"}`, isError: true }, durationMs: 0 });
          }
        } catch (error) {
          authorized = false;
          results.set(entry.call.id, { result: { content: `工具审批失败，已跳过：${errorMessage(error)}`, isError: true }, durationMs: 0 });
        }
      }
      if (authorized) runnable.push({ call: entry.call, tool: entry.tool });
    }

    await Promise.all(runnable.map(async ({ call, tool }) => {
      const entryStarted = Date.now();
      let result: AgentToolResult;
      try {
        result = await executeToolWithTimeout(tool, call, {
          workspaceRoot: options.workspaceRoot,
          outDir: options.outDir,
          permissions: options.permissions,
          signal,
          state,
          fullAccess: options.isFullPermission?.() === true,
          mode: options.mode ?? "build"
        }, options.toolTimeoutMs ?? 120_000, signal);
      } catch (error) {
        result = { content: `工具执行失败：${errorMessage(error)}`, isError: true };
      }
      results.set(call.id, { result, durationMs: Date.now() - entryStarted });
    }));

    emit({ type: "tool.batch.finished", turn: turns, calls, parallel: true, durationMs: Date.now() - started });
    return results;
  }

  while (turns < options.budget.maxTurns) {
    if (aborted()) return finish("cancelled", "任务已取消");

    if (options.steering) {
      const pending = options.steering();
      for (const message of pending) messages.push(message);
    }

    if (turns > 0 && turns % 6 === 0) {
      const reminder = todoReminder(state.todos);
      if (reminder) messages.push({ role: "user", content: reminder });
    }

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

    if (!budgetReminderSent && (
      options.budget.maxTurns - turns <= 2 ||
      totalTokens() >= options.budget.maxTokens * 0.8 ||
      toolCalls >= options.budget.maxToolCalls * 0.8 ||
      elapsed >= options.budget.maxDurationMs * 0.8
    )) {
      messages.push({
        role: "user",
        content: "执行预算即将耗尽。请优先整理已有证据、写入所需交付物并调用 finish_task，明确说明未完成事项和材料缺口；如果无法满足交付要求，请如实说明，不要声称已完成。"
      });
      budgetReminderSent = true;
    }
    await compactContext(false);
    if (totalTokens() >= options.budget.maxTokens) {
      emit({ type: "budget.exceeded", budget: "tokens", limit: options.budget.maxTokens });
      await checkpoint("budget");
      return finish("budget_exceeded", summary ?? "Token 用量达到预算，已停止");
    }

    turns += 1;
    state.turn = turns;
    emit({ type: "turn.started", turn: turns });

    let turn;
    let transientRetries = 0;
    let overflowRetried = false;
    while (true) {
      try {
        turn = await options.model(
          cloneMessages(messages),
          definitions,
          (text) => emit({ type: "assistant.delta", turn: turns, text }),
          signal
        );
        break;
      } catch (error) {
        if (aborted()) return finish("cancelled", "任务已取消");
        if (isContextOverflow(error) && !overflowRetried && options.contextWindowTokens) {
          overflowRetried = true;
          emit({ type: "notice", message: "模型上下文超限，正在压缩历史后重试" });
          await compactContext(true);
          if (totalTokens() >= options.budget.maxTokens) {
            emit({ type: "budget.exceeded", budget: "tokens", limit: options.budget.maxTokens });
            await checkpoint("budget");
            return finish("budget_exceeded", summary ?? "Token 用量达到预算，已停止");
          }
          continue;
        }
        if (isTransientModelError(error) && transientRetries < 2) {
          transientRetries += 1;
          emit({ type: "notice", message: `模型暂时不可用，正在进行第 ${transientRetries} 次重试` });
          const delay = (options.retryDelayMs ?? 1_000) * transientRetries;
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }

    if (turn.usage) {
      addUsage(usage, turn.usage);
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
        messages.push({ role: "user", content: options.reminders?.missingFinish ?? "不要只用文本回复完成。请先核对产物，然后调用 finish_task，提供中文总结和输出路径。" });
        continue;
      }
      emptyTurns += 1;
      if (emptyTurns >= 3) return finish("failed", "模型连续没有返回可执行内容");
      messages.push({ role: "user", content: options.reminders?.emptyTurn ?? "请继续完成当前任务；如果已经完成，请调用 finish_task 并给出中文总结。" });
      continue;
    }
    emptyTurns = 0;
    missingFinishTurns = 0;
    const parallelChunks = new Map<string, AgentToolCall[]>();
    for (const chunk of partitionToolCalls(turn.toolCalls)) {
      if (chunk.length > 1 && chunk[0]) parallelChunks.set(chunk[0].id, chunk);
    }
    const parallelResults = new Map<string, { result: AgentToolResult; durationMs: number }>();

    for (const call of turn.toolCalls) {
      const chunk = parallelChunks.get(call.id);
      if (chunk) {
        const results = await executeParallelBatch(chunk);
        if (results) for (const [id, value] of results) parallelResults.set(id, value);
      }
      if (aborted()) return finish("cancelled", "任务已取消");
      if (toolCalls >= options.budget.maxToolCalls) {
        emit({ type: "budget.exceeded", budget: "toolCalls", limit: options.budget.maxToolCalls });
        await checkpoint("budget");
        return finish("budget_exceeded", summary ?? "工具调用次数超过预算，已停止");
      }

      toolCalls += 1;
      const tool = toolMap.get(call.name);
      const precomputed = parallelResults.get(call.id);
      const toolStartedAt = Date.now();
      emit({ type: "tool.started", turn: turns, call });

      const signature = toolSignature(call);

      let result: AgentToolResult = { content: `未知或未授权工具：${call.name}`, isError: true };
      if (tool) {
        const modeError = modeIssue(call);
        if (modeError) {
          result = { content: modeError, isError: true };
        } else if (precomputed) {
          result = precomputed.result;
        } else {
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
            result = await executeToolWithTimeout(tool, call, {
              workspaceRoot: options.workspaceRoot,
              outDir: options.outDir,
              permissions: options.permissions,
              signal,
              state,
              fullAccess: options.isFullPermission?.() === true,
              mode: options.mode ?? "build"
            }, options.toolTimeoutMs ?? 120_000, signal);
          } catch (error) {
            result = { content: `工具执行失败：${errorMessage(error)}`, isError: true };
          }
        }
        }
      }

      const deniedPath = result.isError ? /路径不在授权范围内[：:]\s*(.+)/.exec(result.content)?.[1]?.trim() : undefined;
      let repeatedDenial = false;
      if (deniedPath) {
        const key = resolve(options.workspaceRoot, deniedPath.replace(/[\\/]/g, "/")).toLowerCase();
        const count = (deniedPaths.get(key) ?? 0) + 1;
        deniedPaths.set(key, count);
        repeatedDenial = count >= 2;
        result = { ...result, content: `${result.content}\n当前产物输出目录：${options.outDir}。请使用当前目录；更换工具或路径分隔符不会扩大权限。` };
      }
      emit({ type: "tool.finished", turn: turns, call, result, durationMs: precomputed?.durationMs ?? (Date.now() - toolStartedAt) });
      const progressHash = `${signature}|${result.isError === true}|${createHash("sha1").update(result.content).digest("hex")}`;
      sameProgressCount = progressHash === lastProgressHash ? sameProgressCount + 1 : 0;
      lastProgressHash = progressHash;
      if (sameProgressCount >= 4) {
        emit({ type: "notice", message: "检测到连续相同工具调用和结果。请不要重复同一调用；重新读取相关文件、缩小验证范围或改变策略。" });
        messages.push({ role: "user", content: options.reminders?.repeated ?? "连续多次工具调用和结果完全相同。请停止重复，重新阅读错误信息并换一种做法；如果被环境阻塞，请调用 finish_task 说明阻塞原因。" });
      }
      if (sameProgressCount >= 5) {
        return finish("failed", "模型连续多次产生重复相同工具调用和结果，已停止以避免死循环");
      }
      emit({
        type: "progress.updated",
        filesRead: state.progress.filesRead.length,
        filesModified: state.progress.filesModified.length,
        commands: state.progress.commands.length,
        tests: state.progress.tests.length,
        todosOpen: state.todos.filter((todo) => todo.status !== "completed").length
      });
      if (result.usage) {
        addUsage(usage, result.usage);
        emit({ type: "usage", usage: { ...usage } });
      }
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result.content,
        ...(result.isError ? { isError: true } : {})
      });

      if (options.stopOnToolError && result.isError) {
        await checkpoint("tool");
        return finish("failed", result.content);
      }

      if (repeatedDenial) {
        await checkpoint("tool");
        return finish("failed", `同一路径连续被权限边界拒绝，已停止重复尝试。当前产物输出目录：${options.outDir}`);
      }

      if (result.action === "finish") {
        if (options.validateFinish && finishRejections < 2) {
          let issue: string | null = null;
          try {
            issue = await options.validateFinish(result, {
              workspaceRoot: options.workspaceRoot,
              outDir: options.outDir,
              permissions: options.permissions,
              signal,
              state
            });
          } catch (error) {
            issue = `交付物自检失败：${errorMessage(error)}`;
          }
          if (issue) {
            finishRejections += 1;
            emit({ type: "notice", message: `交付物自检未通过：${issue}` });
            messages.push({
              role: "user",
              content: `交付物自检未通过：${issue}\n请先修正产物，然后重新调用 finish_task。`
            });
            await checkpoint("tool");
            continue;
          }
        }
        summary = (result.summary ?? result.content).trim() || "任务完成";
        await checkpoint("final");
        return finish("completed", summary, result.outputs ?? []);
      }
      if (result.action === "plan") {
        const plan = (result.summary ?? result.question ?? result.content).trim() || "计划已生成，等待确认";
        summary = plan;
        await checkpoint("plan");
        return finish("waiting_input", plan, result.outputs ?? [], plan);
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

function addUsage(target: RunUsage, value: AgentUsage): void {
  target.inputTokens += (Number.isFinite(value.inputTokens) ? Math.max(0, value.inputTokens ?? 0) : 0);
  target.cachedInputTokens += (Number.isFinite(value.cachedInputTokens) ? Math.max(0, value.cachedInputTokens ?? 0) : 0);
  target.cacheWriteInputTokens += (Number.isFinite(value.cacheWriteInputTokens) ? Math.max(0, value.cacheWriteInputTokens ?? 0) : 0);
  target.outputTokens += (Number.isFinite(value.outputTokens) ? Math.max(0, value.outputTokens ?? 0) : 0);
  target.reasoningOutputTokens += (Number.isFinite(value.reasoningOutputTokens) ? Math.max(0, value.reasoningOutputTokens ?? 0) : 0);
}

async function executeToolWithTimeout(
  tool: AgentTool,
  call: AgentToolCall,
  context: AgentToolContext,
  fallbackTimeoutMs: number,
  parentSignal: AbortSignal
): Promise<AgentToolResult> {
  const timeoutMs = tool.definition.timeoutMs ?? fallbackTimeoutMs;
  if (!timeoutMs || timeoutMs <= 0) return tool.execute(call.arguments, context);
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (parentSignal.aborted) controller.abort();
  else parentSignal.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`工具 ${call.name} 执行超时（${timeoutMs}ms）`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([tool.execute(call.arguments, { ...context, signal: controller.signal }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal.removeEventListener("abort", onAbort);
  }
}

function toolSignature(call: AgentToolCall): string {
  return `${call.name}:${stableJson(call.arguments)}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function isTransientModelError(error: unknown): boolean {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = typeof record.status === "number" ? record.status : null;
  if (status === 429 || (status !== null && status >= 500 && status <= 599)) return true;
  const code = typeof record.code === "string" ? record.code : "";
  if (/^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR_|ENOTFOUND)/.test(code)) return true;
  const message = errorMessage(error);
  return /(fetch failed|network error|socket hang up|connection reset|temporarily unavailable|rate limit|too many requests)/i.test(message);
}

function isContextOverflow(error: unknown): boolean {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = typeof record.status === "number" ? record.status : null;
  const message = errorMessage(error);
  return status === 413
    || /(context[_ ]length|context window|maximum context|too many tokens|prompt is too long|input is too long|token limit)/i.test(message);
}
