import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunUsage } from "@hearth/core";
import { compactAgentMessages, compactAgentMessagesWithSummary, estimateMessageTokens, microcompactMessages } from "./compaction.ts";
import { createAgentState, progressSummary } from "./harness/file-state.ts";
import { serializeAgentState } from "./harness/checkpoint-state.ts";
import { markLostActiveWork } from "./harness/active-work.ts";
import { runningActiveWork } from "./harness/active-work.ts";
import { goalContinuationPrompt, readGoalByRoot } from "./harness/goal.ts";
import { storeOversizedToolResult } from "./harness/tool-output-store.ts";
import { ToolCatalog, TOOL_CALL_NAME, TOOL_SEARCH_NAME, toolCallDefinition, toolSearchDefinition } from "./harness/tool-catalog.ts";
import { HookRunner, type HookEvent, type HookRunResult } from "./harness/hooks.ts";
import { planModeAllowsCommand, planModeAllowsTool } from "./harness/plan.ts";
import { buildPostCompactContext } from "./harness/post-compact.ts";
import { todoReminder } from "./harness/todo.ts";
import { normalizeModelFailure, normalizeToolFailure, type AgentFailure } from "./errors.ts";
import { resolveRetryPolicy, retryDelayFor, retryWindowExceeded, shouldRetryFailure } from "./retry-policy.ts";
import { RunJournal, replayJournalMessages } from "./journal.ts";
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
  AgentToolDefinition,
  AgentToolEffect,
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
  const digestText = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);
  const systemPromptHash = digestText(options.systemPrompt);
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
  let lastTurnSnapshot = Number.NEGATIVE_INFINITY;
  let lastToolSnapshot = Number.NEGATIVE_INFINITY;
  let summary: string | null = null;
  let emptyTurns = 0;
  let missingFinishTurns = 0;
  let goalContinuations = 0;
  let truncatedContinuations = 0;
  let finishRejections = 0;
  let stopRejections = 0;
  let sameProgressCount = 0;
  let lastProgressHash: string | null = null;
  let budgetReminderSent = false;
  let compactions = 0;
  let autoCompactPausedUntil = 0;
  let autoCompactDisabled = false;
  let summaryFailures = 0;
  const compactionTurns: number[] = [];
  const deniedPaths = new Map<string, number>();
  const registeredJobs = new Set<string>();
  const startedAt = Date.now();
  const retryPolicy = resolveRetryPolicy({
    ...(options.retryDelayMs !== undefined ? { baseDelayMs: options.retryDelayMs } : {}),
    ...(options.retryPolicy ?? {})
  });
  const runController = new AbortController();
  const externalSignal = options.signal;
  if (externalSignal) {
    if (externalSignal.aborted) runController.abort();
    else externalSignal.addEventListener("abort", () => runController.abort(), { once: true });
  }
  const signal = runController.signal;
  let stalled = false;
  let lastActivity = Date.now();
  let journal: RunJournal | null = null;
  let journalSeq = 0;
  let journalClosed = false;
  let stallTimer: ReturnType<typeof setInterval> | null = null;
  let fatalCheckpointFailure: AgentFailure | null = null;
  const state = options.state ?? options.resume?.state ?? createAgentState(options.workspaceRoot);
  const modelId = options.modelId ?? null;
  const catalog = new ToolCatalog(tools, {
    ...(options.maxDirectTools !== undefined ? { maxDirectTools: options.maxDirectTools } : {}),
    ...(state.exposedTools ? { exposed: state.exposedTools } : {})
  });
  const hookRunner = new HookRunner(options.hooks ?? [], {
    workspaceRoot: options.workspaceRoot,
    ...(options.hookTimeoutMs !== undefined ? { timeoutMs: options.hookTimeoutMs } : {})
  });
  const hiddenToolCount = tools.filter((tool) => !catalog.isDirect(tool.definition.name)).length;
  const toolSearchTool: AgentTool = {
    definition: toolSearchDefinition(hiddenToolCount),
    async execute(input): Promise<AgentToolResult> {
      const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) throw new Error("请提供 search query");
      const limit = Math.max(1, Math.min(10, Number(args.limit) || 5));
      const matches = catalog.search(query, limit);
      if (matches.length === 0) {
        const names = catalog.definitions().map((definition) => definition.name).slice(0, 40).join(", ");
        return { content: `没有匹配的工具。当前可直连：${names}`, isError: false };
      }
      catalog.expose(matches.map((match) => match.name));
      state.exposedTools = catalog.exposed();
      return {
        content: JSON.stringify({ query, results: matches.map(({ name, description, parameters }) => ({ name, description, parameters })) }, null, 2),
        metadata: { exposedTools: matches.map((match) => match.name) }
      };
    }
  };
  const toolCallTool: AgentTool = {
    definition: toolCallDefinition(),
    async execute(): Promise<AgentToolResult> {
      throw new Error("tool_call must be dispatched by the runtime, not executed directly");
    }
  };
  const syntheticTools = catalog.deferred ? [toolSearchTool, toolCallTool] : [];
  const currentDefinitions = (): AgentToolDefinition[] => {
    const definitions = catalog.definitions();
    return syntheticTools.length > 0
      ? [...definitions, ...syntheticTools.map((tool) => tool.definition)]
      : definitions;
  };
  async function runHooks(event: HookEvent, payload: Record<string, unknown>): Promise<HookRunResult> {
    if (hookRunner.size === 0) return { blocked: false, reason: null, contexts: [], failures: [], executed: 0 };
    const result = await hookRunner.run(event, payload);
    for (const context of result.contexts) messages.push({ role: "user", content: `<hook_context event="${event}">\n${context}\n</hook_context>` });
    for (const failure of result.failures) emit({ type: "notice", message: `Hook 执行失败：${failure}` });
    return result;
  }
  const deferredCall = (call: AgentToolCall): { tool: AgentTool; call: AgentToolCall } | { error: string } => {
    const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
      ? call.arguments as Record<string, unknown>
      : {};
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) return { error: "tool_call 需要提供 name" };
    const tool = catalog.resolve(name);
    if (!tool) return { error: `工具 ${name} 尚未发现或未授权；请先调用 tool_search。` };
    const targetArgs = args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
      ? args.arguments as Record<string, unknown>
      : {};
    return {
      tool,
      call: { id: call.id, name: tool.definition.name, arguments: targetArgs, rawArguments: JSON.stringify(targetArgs) }
    };
  };
  const contextPeaks: number[] = [];
  let lastRequestUsage: AgentUsage | null = null;
  let lastContextAnchor: { inputTokens: number; outputTokens: number; messageCount: number } | null = null;
  let lastContextSource: "provider" | "estimate" = "estimate";

  const emit = (event: RuntimeEvent): void => {
    lastActivity = Date.now();
    options.onEvent?.(event);
  };
  const journalAppend = (event: Parameters<RunJournal["append"]>[0]): number => {
    if (!journal) return 0;
    try {
      const next = journal.append(event);
      journalSeq = next;
      return next;
    } catch (error) {
      emit({ type: "journal.failed", message: errorMessage(error) });
      return 0;
    }
  };
  const closeJournal = (): void => {
    if (!journal || journalClosed) return;
    journalClosed = true;
    try {
      journal.close();
    } catch {
      // journal close is best effort
    }
  };
  if (options.journal) {
    try {
      journal = new RunJournal({
        path: options.journal.path,
        fsync: options.journal.fsync !== false,
        ...(options.journal.rotateBytes !== undefined ? { rotateBytes: options.journal.rotateBytes } : {})
      });
      journalAppend({
        type: "run.start",
        runId: options.runId ?? "unknown",
        goal: options.goal,
        systemPromptHash,
        budget: options.budget
      });
      if (options.resume?.journal) {
        const replay = replayJournalMessages(messages, options.resume.journal.path, options.resume.journal.seq);
        messages.splice(0, messages.length, ...replay.messages);
        if (Object.keys(replay.addedUsage).length > 0) addUsage(usage, replay.addedUsage as AgentUsage);
        if (replay.inFlight) {
          const effect = replay.inFlight.effect;
          // A crash in the middle of a tool call must never brick the task.
          // Tell the model the outcome is unknown and let it verify before
          // deciding whether to retry; the run continues either way.
          messages.push({
            role: "tool",
            toolCallId: replay.inFlight.callId,
            name: replay.inFlight.name,
            content: `工具 ${replay.inFlight.name} 在上一进程中断；结果未知，` + (effect === "read" ? "需要时请重试。" : "工作区或外部状态可能已部分改变，请先核对后再决定下一步。"),
            isError: true
          });
          if (effect !== "read") {
            messages.push({
              role: "user",
              content: `<resume_reconciliation>\n工具 ${replay.inFlight.name}（${replay.inFlight.callId}）在上一进程中断，执行结果未知。不要假设成功或失败；先用只读方式核对当前状态，再决定是否重试或换一种做法，然后继续完成目标。\n</resume_reconciliation>`
            });
          }
        }
      }
    } catch (error) {
      journal = null;
      emit({ type: "journal.failed", message: `journal 初始化失败，降级到 checkpoint：${errorMessage(error)}` });
    }
  }
  const stallPolicy = {
    warnMs: Math.max(60_000, options.stallPolicy?.warnMs ?? 10 * 60_000),
    abortMs: Math.max(120_000, options.stallPolicy?.abortMs ?? 30 * 60_000)
  };
  let stallWarned = false;
  stallTimer = setInterval(() => {
    const idleMs = Date.now() - lastActivity;
    if (!stallWarned && idleMs >= stallPolicy.warnMs) {
      stallWarned = true;
      emit({ type: "stall.warned", idleMs });
    }
    if (idleMs >= stallPolicy.abortMs && !stalled) {
      stalled = true;
      emit({ type: "stall.detected", idleMs });
      runController.abort();
    }
  }, 15_000);
  stallTimer.unref?.();
  if (options.journal) await checkpoint("turn", true);

  const lostWork = options.resume ? markLostActiveWork(state) : [];
  if (lostWork.length > 0) {
    emit({
      type: "notice",
      message: `上一轮有 ${lostWork.length} 个后台工作没有确认结束，已标记为 lost；不要假设它们仍在运行，请先检查工作区或重新启动。`
    });
  }
  if (options.resume?.promptHash && options.resume.promptHash !== systemPromptHash) {
    emit({ type: "notice", message: "系统提示或工具定义在恢复后已变化；检查点中的旧上下文可能不再适用，请谨慎继续。" });
  }
  if (hookRunner.size > 0) {
    const session = await runHooks("SessionStart", { workspaceRoot: options.workspaceRoot, modelId, resumed: Boolean(options.resume) });
    if (session.blocked) return finish("failed", session.reason ?? "SessionStart hook 拒绝了本次运行");
    const prompt = await runHooks("UserPromptSubmit", { workspaceRoot: options.workspaceRoot, prompt: options.goal });
    if (prompt.blocked) return finish("waiting_input", prompt.reason ?? "UserPromptSubmit hook 暂停了本次运行", [], prompt.reason);
  }
  const aborted = (): boolean => signal.aborted;
  const totalTokens = (): number => usage.inputTokens + usage.outputTokens;
  const executingPath = join(options.outDir, ".hearth", "executing.json");
  const markExecuting = (call: AgentToolCall): void => {
    try {
      mkdirSync(join(options.outDir, ".hearth"), { recursive: true });
      const temp = `${executingPath}.tmp`;
      writeFileSync(temp, JSON.stringify({ tool: call.name, callId: call.id, startedAt: new Date().toISOString() }), "utf8");
      renameSync(temp, executingPath);
    } catch (error) {
      emit({ type: "notice", message: `无法写入工具执行标记，自动恢复会保持保守：${errorMessage(error)}` });
    }
  };
  const clearExecuting = (): void => {
    try {
      rmSync(executingPath, { force: true });
    } catch {
      // The marker is best-effort; a stale marker only makes recovery more conservative.
    }
  };
  if (existsSync(executingPath)) {
    emit({ type: "notice", message: "检测到上一轮工具执行未确认完成，工作区可能已有部分改动；请先核对再继续。" });
    clearExecuting();
  }
  const emitContextSnapshot = (turn: number): void => {
    const definitions = currentDefinitions();    const systemChars = messages
      .filter((message) => message.role === "system")
      .reduce((sum, message) => sum + message.content.length, 0);
    const toolResultChars = messages
      .filter((message) => message.role === "tool")
      .reduce((sum, message) => sum + message.content.length, 0);
    const historyChars = messages
      .filter((message) => message.role !== "system" && message.role !== "tool")
      .reduce((sum, message) => sum + message.content.length, 0);
    const toolSchemaChars = JSON.stringify(definitions).length;
    const providerInputTokens = lastRequestUsage?.inputTokens && lastRequestUsage.inputTokens > 0
      ? lastRequestUsage.inputTokens
      : null;
    const source: "provider" | "estimate" = providerInputTokens !== null ? "provider" : "estimate";
    const estimatedTokens = estimateMessageTokens(messages) + Math.ceil(toolSchemaChars / 4);
    lastContextSource = source;
    contextPeaks.push(estimatedTokens);
    emit({
      type: "context.snapshot",
      turn,
      modelId,
      messageCount: messages.length,
      toolCount: definitions.length,
      systemChars,
      toolSchemaChars,
      historyChars,
      toolResultChars,
      estimatedTokens,
      providerInputTokens,
      providerOutputTokens: lastRequestUsage?.outputTokens ?? null,
      source
    });
  };
  // Hearth no longer enforces turn/tool/token/time budgets. Unlimited work is
  // the product default; only explicit cancellation stops a run.
  const limitOf = (_value: number | undefined): number | null => null;
  const turnLimit = limitOf(options.budget.maxTurns);
  const toolCallLimit = limitOf(options.budget.maxToolCalls);
  const tokenLimit = limitOf(options.budget.maxTokens);
  const durationLimit = limitOf(options.budget.maxDurationMs);

  async function compactContext(force: boolean): Promise<boolean> {
    const preCompact = await runHooks("PreCompact", { workspaceRoot: options.workspaceRoot, force, messageCount: messages.length });
    if (preCompact.blocked) {
      emit({ type: "notice", message: `PreCompact hook 拒绝了压缩：${preCompact.reason ?? "未说明原因"}` });
      if (!force) return false;
    }
    if (journal) await checkpoint("compaction", true);
    journalAppend({ type: "compaction", phase: "start", before: messages.length, reason: force ? "reactive" : "auto" });
    const restoredContext = buildPostCompactContext(state, { mode: options.mode ?? state.mode ?? "build" });
    const compacted = options.contextWindowTokens
      ? await compactAgentMessagesWithSummary(messages, {
          contextWindowTokens: force ? 1 : options.contextWindowTokens,
          reserveTokens: force ? 0 : options.contextReserveTokens ?? Math.max(16_000, Math.floor(options.contextWindowTokens * 0.15)),
          ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
          ...(lastContextAnchor ? { usageAnchor: lastContextAnchor } : {}),
          ...(options.recentContextTokens !== undefined ? { recentTokens: options.recentContextTokens } : {}),
          keepRecentToolOutputs: options.keepRecentToolOutputs ?? 3,
          ...(state.toolOutputs ? { toolOutputs: state.toolOutputs } : {}),
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
          keepRecentToolOutputs: options.keepRecentToolOutputs ?? 3,
          ...(state.toolOutputs ? { toolOutputs: state.toolOutputs } : {}),
          stateSummary: progressSummary(state.progress),
          ...(options.projectInstructions ? { projectInstructions: options.projectInstructions } : {}),
          restoredContext
        });
    // Output trimming applies even when history summarization is unnecessary.
    messages.splice(0, messages.length, ...compacted.messages);
    if (!compacted.compacted) {
      journalAppend({ type: "compaction", phase: "end", before: compacted.before, after: compacted.after, compacted: false });
      return false;
    }
    // The summary replaces the raw tool output, so a later read must return the
    // actual file body instead of deduplicating against a stale range.
    for (const read of state.readFiles.values()) delete read.ranges;
    compactions += 1;
    emit({ type: "compacted", before: compacted.before, after: compacted.after, reason: force ? "reactive" : "auto" });
    if (compacted.summaryFailed) {
      summaryFailures += 1;
      if (summaryFailures >= 3 && !autoCompactDisabled) {
        autoCompactDisabled = true;
        emit({ type: "notice", message: "上下文摘要连续失败 3 次，已关闭自动压缩；仍会在模型上下文超限时做一次强制压缩。" });
      }
    } else if (compacted.summarized) {
      summaryFailures = 0;
    }
    compactionTurns.push(turns);
    while (compactionTurns.length > 0 && turns - compactionTurns[0]! > 3) compactionTurns.shift();
    if (compactionTurns.length >= 3) {
      autoCompactPausedUntil = turns + 5;
      compactionTurns.length = 0;
      emit({ type: "notice", message: "3 轮内压缩 3 次，自动压缩暂停 5 轮以避免抖动；原始工具输出仍会被折叠。" });
    }
    emit({
      type: "context.watermark",
      estimatedTokens: Number("beforeTokens" in compacted ? compacted.beforeTokens : 0),
      usedTokens: totalTokens(),
      compactions,
      source: lastContextSource
    });
    if ("summary" in compacted && typeof compacted.summary === "string") summary = compacted.summary;
    journalAppend({
      type: "compaction",
      phase: "end",
      before: compacted.before,
      after: compacted.after,
      compacted: true,
      summaryFailed: compacted.summaryFailed === true
    });
    await checkpoint("compaction", true);
    await runHooks("PostCompact", { workspaceRoot: options.workspaceRoot, force, messageCount: messages.length, compactions });
    return true;
  }

  function finish(status: AgentRunStatus, resultSummary: string, outputs: string[] = [], question: string | null = null, failure?: AgentFailure): AgentRunResult {
    if (stallTimer) {
      clearInterval(stallTimer);
      stallTimer = null;
    }
    const effectiveFailure = failure ?? fatalCheckpointFailure ?? undefined;
    const effectiveStatus: AgentRunStatus = fatalCheckpointFailure && status === "completed" ? "failed" : status;
    const effectiveSummary = fatalCheckpointFailure && status === "completed"
      ? `检查点保存失败，已停止以避免不可恢复的执行：${fatalCheckpointFailure.message}`
      : resultSummary;
    journalAppend({
      type: "run.end",
      status: effectiveStatus,
      summary: effectiveSummary,
      usage: { ...usage },
      turns,
      toolCalls
    });
    closeJournal();
    return {
      status: effectiveStatus,
      summary: effectiveSummary,
      messages: cloneMessages(messages),
      usage: { ...usage },
      turns,
      toolCalls,
      outputs,
      question,
      ...(effectiveFailure ? { failure: effectiveFailure } : {}),
      metrics: {
        contextPeaks: [...contextPeaks],
        contextSource: lastContextSource,
        compactions,
        modelId
      }
    };
  }

  async function checkpoint(kind: AgentCheckpoint["kind"], force = false): Promise<void> {
    const everyTurns = Math.max(1, options.checkpointPolicy?.everyTurns ?? (journal ? 5 : 1));
    const everyToolCalls = Math.max(1, options.checkpointPolicy?.everyToolCalls ?? (journal ? 20 : 1));
    if (!force && kind === "turn" && turns - lastTurnSnapshot < everyTurns) return;
    if (!force && kind === "tool" && toolCalls - lastToolSnapshot < everyToolCalls) return;
    seq += 1;
    const snapshotJournalSeq = journalSeq;
    const checkpoint: AgentCheckpoint = {
      seq,
      kind,
      messages: cloneMessages(messages),
      usage: { ...usage },
      turns,
      toolCalls,
      summary,
      state: serializeAgentState(state),
      mode: options.mode ?? state.mode ?? "build",
      promptHash: systemPromptHash,
      ...(snapshotJournalSeq > 0 ? { journalSeq: snapshotJournalSeq } : {})
    };
    try {
      await options.onCheckpoint?.(checkpoint);
      lastTurnSnapshot = turns;
      lastToolSnapshot = toolCalls;
      journalAppend({ type: "checkpoint", checkpointSeq: seq, checkpointKind: kind, journalSeq: snapshotJournalSeq });
      emit({ type: "checkpoint.created", seq, kind, ...(snapshotJournalSeq > 0 ? { journalSeq: snapshotJournalSeq } : {}) });
    } catch (error) {
      const message = errorMessage(error);
      emit({ type: "checkpoint.failed", seq, kind, message });
      const policy = options.checkpointFailurePolicy ?? (journal ? "warn" : "stop");
      if (policy === "stop") {
        fatalCheckpointFailure = {
          code: "CHECKPOINT_FAILED",
          message,
          retryable: true
        };
      }
    }
  }

  function currentCheckpointFailure(): AgentFailure | null {
    return fatalCheckpointFailure;
  }

  function emitJobEvents(toolName: string, result: AgentToolResult): void {
    const meta = result.metadata;
    const kind = meta?.jobKind
      ?? (toolName.startsWith("agent") ? "subagent" : meta?.background || toolName.startsWith("shell") ? "shell" : null);
    const jobId = meta?.jobId ?? meta?.agentId ?? meta?.sessionId;
    if (!kind || !jobId) return;
    const status = meta?.jobStatus ?? meta?.agentStatus ?? (meta?.exitCode === undefined || meta?.exitCode === null ? "running" : meta.exitCode === 0 ? "settled" : "failed");
    if (!registeredJobs.has(jobId)) {
      registeredJobs.add(jobId);
      emit({ type: "job.registered", jobId, kind, status: "running" });
      journalAppend({ type: "job.registered", jobId, kind, status: "running" });
    }
    if (TERMINAL_JOB_STATUSES.has(status)) {
      emit({ type: "job.settled", jobId, kind, status });
      journalAppend({ type: "job.settled", jobId, kind, status });
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

  function effectForTool(tool: AgentTool | undefined, call: AgentToolCall): AgentToolEffect {
    if (!tool) return "unknown";
    try {
      const declared = tool.definition.effectForArgs?.(call.arguments) ?? tool.definition.effect;
      if (declared) return declared;
    } catch {
      return "unknown";
    }
    if (READ_ONLY_TOOL_NAMES.has(call.name)) return "read";
    if (LOCAL_WRITE_TOOL_NAMES.has(call.name)) return "local_write";
    return "unknown";
  }

  function isConcurrencySafe(tool: AgentTool | undefined, call: AgentToolCall): boolean {
    if (!tool) return false;
    try {
      if (tool.definition.isConcurrencySafe) return tool.definition.isConcurrencySafe(call.arguments) === true;
    } catch {
      return false;
    }
    return tool.definition.executionMode === "parallel" && effectForTool(tool, call) === "read";
  }

  function partitionToolCalls(calls: AgentToolCall[]): AgentToolCall[][] {
    const chunks: AgentToolCall[][] = [];
    const parallelLimit = Math.max(1, options.maxParallelTools ?? 1);
    let parallelChunk: AgentToolCall[] = [];
    for (const call of calls) {
      if (isConcurrencySafe(catalog.resolve(call.name), call)) {
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
    const entries = calls.map((call) => ({ call, tool: catalog.resolve(call.name) }));
    if (!entries.every((entry) => isConcurrencySafe(entry.tool, entry.call))) return null;
    if ((toolCallLimit !== null && toolCalls + calls.length > toolCallLimit) || aborted()) return null;

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
      journalAppend({
        type: "tool.call",
        turn: turns,
        callId: call.id,
        name: call.name,
        args: call.arguments,
        effect: effectForTool(tool, call),
        startedAt: new Date().toISOString()
      });
      let result: AgentToolResult;
      try {
        result = await executeToolWithTimeout(tool, call, {
          workspaceRoot: options.workspaceRoot,
          outDir: options.outDir,
          permissions: options.permissions,
          signal,
          state,
          ...(options.goalRoot ? { goalRoot: options.goalRoot } : {}),
          fullAccess: options.isFullPermission?.() === true,
          mode: options.mode ?? "build",
          ...(options.sandbox ? { sandbox: options.sandbox } : {}),
          ...(options.verifyGoalCompletion ? { verifyGoalCompletion: options.verifyGoalCompletion } : {})
        }, options.toolTimeoutMs ?? 120_000, signal);
      } catch (error) {
        const failure = normalizeToolFailure(error, "TOOL_EXEC_FAILED");
        result = { content: `工具执行失败：${failure.message}`, isError: true, error: failure };
      }
      journalAppend({
        type: "tool.result",
        turn: turns,
        callId: call.id,
        name: call.name,
        message: {
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: result.content,
          ...(result.isError ? { isError: true } : {})
        },
        durationMs: Date.now() - entryStarted,
        ...(result.error ? { errorCode: result.error.code } : {})
      });
      results.set(call.id, { result, durationMs: Date.now() - entryStarted });
    }));

    emit({ type: "tool.batch.finished", turn: turns, calls, parallel: true, durationMs: Date.now() - started });
    return results;
  }

  while (true) {
    const checkpointFailure = currentCheckpointFailure();
    if (checkpointFailure) {
      return finish("failed", `检查点保存失败，已停止以避免不可恢复的执行：${checkpointFailure.message}`, [], null, checkpointFailure);
    }
    if (aborted()) return finish("cancelled", "任务已取消");

    if (turnLimit !== null && turns >= turnLimit) {
      emit({ type: "budget.exceeded", budget: "turns", limit: turnLimit });
      await checkpoint("budget", true);
      return finish("budget_exceeded", summary ?? "达到最大执行轮次，任务未完成");
    }

    const goalRoot = options.goalRoot ?? options.workspaceRoot;
    const activeGoal = readGoalByRoot(goalRoot);

    if (options.steering) {
      const pending = options.steering();
      for (const message of pending) messages.push(message);
    }

    if (turns > 0 && turns % 6 === 0) {
      const reminder = todoReminder(state.todos);
      if (reminder) messages.push({ role: "user", content: reminder });
    }

    const elapsed = Date.now() - startedAt;
    if (durationLimit !== null && elapsed > durationLimit) {
      emit({ type: "budget.exceeded", budget: "duration", limit: durationLimit });
      await checkpoint("budget", true);
      return finish("budget_exceeded", summary ?? "执行时间超过预算，已停止");
    }
    if (tokenLimit !== null && totalTokens() > tokenLimit) {
      emit({ type: "budget.exceeded", budget: "tokens", limit: tokenLimit });
      await checkpoint("budget", true);
      return finish("budget_exceeded", summary ?? "Token 用量超过预算，已停止");
    }

    if (!budgetReminderSent && (
      (turnLimit !== null && turnLimit - turns <= 2) ||
      (tokenLimit !== null && totalTokens() >= tokenLimit * 0.8) ||
      (toolCallLimit !== null && toolCalls >= toolCallLimit * 0.8) ||
      (durationLimit !== null && elapsed >= durationLimit * 0.8)
    )) {
      messages.push({
        role: "user",
        content: "执行预算即将耗尽。请优先整理已有证据、写入所需交付物并调用 finish_task，明确说明未完成事项和材料缺口；如果无法满足交付要求，请如实说明，不要声称已完成。"
      });
      budgetReminderSent = true;
    }
    const micro = microcompactMessages(messages, {
      ...(options.maxToolChars !== undefined ? { maxToolChars: options.maxToolChars } : {}),
      keepRecentToolOutputs: options.keepRecentToolOutputs ?? 3
    });
    if (micro.changed) {
      const beforeMicro = messages.length;
      messages.splice(0, messages.length, ...micro.messages);
      emit({ type: "compacted", before: beforeMicro, after: messages.length, reason: "microcompact" });
    }
    if (!autoCompactDisabled && turns >= autoCompactPausedUntil) {
      await compactContext(false);
      const checkpointFailure = currentCheckpointFailure(); if (checkpointFailure) return finish("failed", `检查点保存失败，已停止以避免不可恢复的执行：${checkpointFailure.message}`, [], null, checkpointFailure);
    }
    if (tokenLimit !== null && totalTokens() >= tokenLimit) {
      emit({ type: "budget.exceeded", budget: "tokens", limit: tokenLimit });
      await checkpoint("budget", true);
      return finish("budget_exceeded", summary ?? "Token 用量达到预算，已停止");
    }

    turns += 1;
    state.turn = turns;
    emit({ type: "turn.started", turn: turns });

    let turn;
    let transientRetries = 0;
    let overflowRetried = false;
    emitContextSnapshot(turns);
    const requestDefinitions = currentDefinitions();
    const requestSchemaHash = digestText(JSON.stringify(requestDefinitions));
    emit({
      type: "prompt.snapshot",
      turn: turns,
      systemPromptHash,
      toolSchemaHash: requestSchemaHash,
      messageStart: 0,
      messageEnd: messages.length
    });
    try {
      while (true) {
      try {
        const requestMessageCount = messages.length;
        turn = await options.model(
          cloneMessages(messages),
          requestDefinitions,
          (text) => emit({ type: "assistant.delta", turn: turns, text }),
          signal
        );
        if (turn.usage) {
          lastContextAnchor = {
            inputTokens: turn.usage.inputTokens,
            outputTokens: turn.usage.outputTokens ?? 0,
            messageCount: requestMessageCount
          };
        }
        break;
      } catch (error) {
        if (aborted()) {
          return stalled
            ? finish("failed", "运行停滞，已中止", [], null, { code: "STALLED", message: "运行停滞", retryable: true })
            : finish("cancelled", "任务已取消");
        }
        if (isContextOverflow(error) && !overflowRetried && options.contextWindowTokens) {
          overflowRetried = true;
          emit({ type: "notice", message: "模型上下文超限，正在压缩历史后重试" });
          await compactContext(true);
          const checkpointFailure = currentCheckpointFailure(); if (checkpointFailure) return finish("failed", `检查点保存失败，已停止以避免不可恢复的执行：${checkpointFailure.message}`, [], null, checkpointFailure);
          if (tokenLimit !== null && totalTokens() >= tokenLimit) {
            emit({ type: "budget.exceeded", budget: "tokens", limit: tokenLimit });
            await checkpoint("budget", true);
            return finish("budget_exceeded", summary ?? "Token 用量达到预算，已停止");
          }
          continue;
        }
        const failure = normalizeModelFailure(error);
        if (shouldRetryFailure(retryPolicy, failure, transientRetries + 1) && !retryWindowExceeded(retryPolicy, startedAt)) {
          transientRetries += 1;
          const delay = retryDelayFor(retryPolicy, transientRetries, failure);
          emit({ type: "retry.scheduled", attempt: transientRetries, delayMs: delay, code: failure.code });
          journalAppend({ type: "retry.scheduled", attempt: transientRetries, delayMs: delay, code: failure.code });
          if (delay > 0) await abortableSleep(delay, signal);
          if (aborted()) {
            return stalled
              ? finish("failed", "运行停滞，已中止", [], null, { code: "STALLED", message: "运行停滞", retryable: true })
              : finish("cancelled", "任务已取消");
          }
          emit({ type: "retry.started", attempt: transientRetries });
          journalAppend({ type: "retry.started", attempt: transientRetries });
          continue;
        }
        if (!failure.retryable) {
          throw Object.assign(new Error(failure.message), {
            code: failure.code,
            retryable: false,
            ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {})
          });
        }
        emit({ type: "notice", message: `模型连续 ${retryPolicy.maxRetries} 次返回暂时性错误，已停止本次运行。` });
        return finish("failed", `模型连续多次暂时不可用：${failure.message}`, [], null, failure);
      }
    }

    if (turn.usage) lastRequestUsage = turn.usage;
    if (turn.usage) {
      addUsage(usage, turn.usage);
      emit({ type: "usage", usage: { ...usage } });
    }
    if (turn.content.trim()) emit({ type: "assistant.message", turn: turns, text: turn.content });
    const assistantMessage: AgentMessage = { role: "assistant", content: turn.content, toolCalls: turn.toolCalls };
    messages.push(assistantMessage);
    journalAppend({
      type: "message",
      turn: turns,
      message: assistantMessage,
      ...(turn.usage ? { usage: turn.usage } : {})
    });
    await checkpoint("turn");
    {
      const checkpointFailure = currentCheckpointFailure();
      if (checkpointFailure) {
        return finish("failed", `检查点保存失败，已停止以避免不可恢复的执行：${checkpointFailure.message}`, [], null, checkpointFailure);
      }
    }

    if (turn.toolCalls.length === 0 && isTruncatedFinishReason(turn.finishReason)) {
      truncatedContinuations += 1;
      if (truncatedContinuations > 3) {
        return finish("failed", `模型输出连续 ${truncatedContinuations} 次达到长度上限，仍未能完成；请缩短单次输出或提高输出上限。`);
      }
      emit({ type: "notice", message: `模型输出被长度限制截断，正在继续第 ${truncatedContinuations} 次` });
      messages.push({
        role: "user",
        content: "你的上一条输出因长度限制被截断。请从中断处继续，不要重复已经输出的内容；完成后仍要调用 finish_task。"
      });
      await checkpoint("turn");
      continue;
    }

    if (turn.toolCalls.length === 0) {
      const goalPrompt = goalContinuationPrompt(goalRoot);
      const maxGoalRounds = Math.max(1, options.maxGoalRounds ?? 256);
      const runningSubagents = runningActiveWork(state).filter((work) => work.kind === "subagent" && work.status === "running");
      if (goalPrompt && goalContinuations < maxGoalRounds && runningSubagents.length === 0) {
        goalContinuations += 1;
        emit({ type: "notice", message: "检测到进行中的持久目标，继续执行而不是结束这一轮。" });
        emit({ type: "goal.round", round: goalContinuations, maxRounds: maxGoalRounds, goalId: activeGoal?.goalId ?? "unknown" });
        journalAppend({ type: "goal.round", round: goalContinuations, maxRounds: maxGoalRounds, goalId: activeGoal?.goalId ?? "unknown" });
        messages.push({ role: "user", content: `${goalPrompt}\n\n继续执行下一步；只有成功标准全部满足后才调用 finish_task。` });
        await checkpoint("turn");
        continue;
      }
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
    goalContinuations = 0;
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
      if (toolCallLimit !== null && toolCalls >= toolCallLimit) {
        emit({ type: "budget.exceeded", budget: "toolCalls", limit: toolCallLimit });
        await checkpoint("budget", true);
        return finish("budget_exceeded", summary ?? "工具调用次数超过预算，已停止");
      }

      toolCalls += 1;
      let effectiveCall = call;
      let tool: AgentTool | undefined;
      let resolutionError: string | null = null;
      if (call.name === TOOL_CALL_NAME && catalog.deferred) {
        const resolved = deferredCall(call);
        if ("error" in resolved) resolutionError = resolved.error;
        else {
          tool = resolved.tool;
          effectiveCall = resolved.call;
        }
      } else {
        tool = call.name === TOOL_SEARCH_NAME && catalog.deferred ? toolSearchTool : catalog.resolve(call.name);
      }
      const precomputed = parallelResults.get(call.id);
      const toolStartedAt = Date.now();
      emit({ type: "tool.started", turn: turns, call });

      const signature = toolSignature(effectiveCall);

      let result: AgentToolResult = { content: resolutionError ?? `未知或未授权工具：${call.name}`, isError: true };
      const preTool = await runHooks("PreToolUse", {
        workspaceRoot: options.workspaceRoot,
        toolName: effectiveCall.name,
        toolCallId: call.id,
        arguments: effectiveCall.arguments
      });
      if (preTool.blocked) {
        result = { content: `Hook 拒绝了工具 ${effectiveCall.name}：${preTool.reason ?? "未说明原因"}`, isError: true };
      }
      if (tool && !preTool.blocked) {
        const modeError = modeIssue(effectiveCall);
        if (modeError) {
          result = { content: modeError, isError: true };
        } else if (precomputed) {
          result = precomputed.result;
        } else {
        let authorized = true;
        if (options.authorizeTool) {
          const permission = await runHooks("PermissionRequest", {
            workspaceRoot: options.workspaceRoot,
            toolName: effectiveCall.name,
            arguments: effectiveCall.arguments
          });
          if (permission.blocked) {
            authorized = false;
            result = { content: `Hook 拒绝了工具审批：${permission.reason ?? "未说明原因"}`, isError: true };
          } else {
          try {
            const authorization = await options.authorizeTool({ call: effectiveCall, definition: tool.definition });
            authorized = authorization.allowed;
            if (!authorization.allowed) {
              result = { content: `用户尚未允许这个工具：${authorization.reason}`, isError: true };
            }
          } catch (error) {
            authorized = false;
            result = { content: `工具审批失败，已跳过：${errorMessage(error)}`, isError: true };
          }
          }
        }
        if (authorized) {
          journalAppend({
            type: "tool.call",
            turn: turns,
            callId: call.id,
            name: effectiveCall.name,
            args: effectiveCall.arguments,
            effect: effectForTool(tool, effectiveCall),
            startedAt: new Date().toISOString()
          });
          markExecuting(effectiveCall);
          try {
            result = await executeToolWithTimeout(tool, effectiveCall, {
              workspaceRoot: options.workspaceRoot,
              outDir: options.outDir,
              permissions: options.permissions,
              signal,
              state,
              ...(options.goalRoot ? { goalRoot: options.goalRoot } : {}),
              fullAccess: options.isFullPermission?.() === true,
              mode: options.mode ?? "build",
              ...(options.sandbox ? { sandbox: options.sandbox } : {}),
              ...(options.verifyGoalCompletion ? { verifyGoalCompletion: options.verifyGoalCompletion } : {})
            }, options.toolTimeoutMs ?? 120_000, signal);
          } catch (error) {
            const failure = normalizeToolFailure(error, "TOOL_EXEC_FAILED");
            result = { content: `工具执行失败：${failure.message}`, isError: true, error: failure };
          }
        }
        }
      }

      if (result.content.length > 16_000) {
        const stored = storeOversizedToolResult(options.outDir, call.name, result.content);
        if (stored.fullOutputPath) {
          state.toolOutputs = {
            ...(state.toolOutputs ?? {}),
            [call.id]: { path: stored.fullOutputPath, bytes: stored.bytes, tokens: stored.tokens }
          };
        }
        result = {
          ...result,
          content: stored.content,
          ...(stored.fullOutputPath
            ? { metadata: { ...result.metadata, fullOutputPath: stored.fullOutputPath } }
            : {})
        };
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
      if (result.error) {
        emit({
          type: "tool.failed",
          turn: turns,
          callId: call.id,
          name: effectiveCall.name,
          code: result.error.code,
          retryable: result.error.retryable ?? false,
          message: result.content
        });
      }
      if (result.metadata?.orphaned) {
        emit({ type: "tool.orphaned", turn: turns, callId: call.id, name: effectiveCall.name, message: result.content });
        journalAppend({ type: "tool.orphaned", callId: call.id, name: effectiveCall.name, reason: result.content });
      }
      emitJobEvents(effectiveCall.name, result);
      const durationMs = precomputed?.durationMs ?? (Date.now() - toolStartedAt);
      emit({ type: "tool.finished", turn: turns, call, result, durationMs });
      await runHooks(result.isError ? "PostToolUseFailure" : "PostToolUse", {
        workspaceRoot: options.workspaceRoot,
        toolName: effectiveCall.name,
        toolCallId: call.id,
        isError: result.isError === true,
        content: result.content.slice(0, 16_000),
        metadata: result.metadata ?? {}
      });
      const changedFiles = result.isError ? [] : result.metadata?.filesChanged?.filter((file) => typeof file === "string" && file.length > 0) ?? [];
      if (changedFiles.length > 0 && options.afterEdit) {
        try {
          await options.afterEdit({ turn: turns, tool: call.name, files: changedFiles, result });
        } catch (error) {
          emit({ type: "notice", message: `Post-edit hook failed: ${errorMessage(error)}` });
        }
      }
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
      if (!precomputed) {
        journalAppend({
          type: "tool.result",
          turn: turns,
          callId: call.id,
          name: effectiveCall.name,
          message: {
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: result.content,
            ...(result.isError ? { isError: true } : {})
          },
          durationMs,
          ...(result.error ? { errorCode: result.error.code } : {})
        });
      }

      if (options.stopOnToolError && result.isError) {
        await checkpoint("tool");
      const checkpointFailure = currentCheckpointFailure(); if (checkpointFailure) return finish("failed", `检查点保存失败，已停止以避免不可恢复的执行：${checkpointFailure.message}`, [], null, checkpointFailure);
        clearExecuting();
        return finish("failed", result.content);
      }

      if (repeatedDenial) {
        await checkpoint("tool");
      const checkpointFailure = currentCheckpointFailure(); if (checkpointFailure) return finish("failed", `检查点保存失败，已停止以避免不可恢复的执行：${checkpointFailure.message}`, [], null, checkpointFailure);
        clearExecuting();
        return finish("failed", `同一路径连续被权限边界拒绝，已停止重复尝试。当前产物输出目录：${options.outDir}`);
      }

      if (result.action === "finish") {
        const stop = await runHooks("Stop", {
          workspaceRoot: options.workspaceRoot,
          toolName: effectiveCall.name,
          summary: result.summary ?? result.content
        });
        if (stop.blocked && stopRejections < 2) {
          stopRejections += 1;
          emit({ type: "notice", message: `Stop hook 拒绝了完成：${stop.reason ?? "未说明原因"}` });
          messages.push({
            role: "user",
            content: `Stop hook 拒绝了本次完成：${stop.reason ?? "未说明原因"}\n请先修正未满足的要求，然后重新调用 finish_task。`
          });
          await checkpoint("tool");
          {
            const checkpointFailure = currentCheckpointFailure();
            if (checkpointFailure) return finish("failed", `检查点保存失败，已停止以避免不可恢复的执行：${checkpointFailure.message}`, [], null, checkpointFailure);
          }
          clearExecuting();
          continue;
        }
        if (options.validateFinish && finishRejections < 2) {
          let issue: string | null = null;
          try {
            issue = await options.validateFinish(result, {
              workspaceRoot: options.workspaceRoot,
              outDir: options.outDir,
              permissions: options.permissions,
              signal,
              state,
              ...(options.goalRoot ? { goalRoot: options.goalRoot } : {})
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
      const checkpointFailure = currentCheckpointFailure(); if (checkpointFailure) return finish("failed", `检查点保存失败，已停止以避免不可恢复的执行：${checkpointFailure.message}`, [], null, checkpointFailure);
            clearExecuting();
            continue;
          }
        }
        summary = (result.summary ?? result.content).trim() || "任务完成";
        await checkpoint("final", true);
        clearExecuting();
        return finish("completed", summary, result.outputs ?? []);
      }
      if (result.action === "plan") {
        const plan = (result.summary ?? result.question ?? result.content).trim() || "计划已生成，等待确认";
        summary = plan;
        await checkpoint("plan", true);
        clearExecuting();
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
          {
            const checkpointFailure = currentCheckpointFailure();
            if (checkpointFailure) return finish("failed", `检查点保存失败，已停止以避免不可恢复的执行：${checkpointFailure.message}`, [], null, checkpointFailure);
          }
          clearExecuting();
          continue;
        }
        const question = (result.question ?? result.content).trim() || "需要你补充信息后才能继续";
        summary = question;
        await checkpoint("waiting_input", true);
        clearExecuting();
        return finish("waiting_input", question, [], question);
      }

      await checkpoint("tool");
      const checkpointFailure = currentCheckpointFailure(); if (checkpointFailure) return finish("failed", `检查点保存失败，已停止以避免不可恢复的执行：${checkpointFailure.message}`, [], null, checkpointFailure);
      clearExecuting();
      if (tokenLimit !== null && totalTokens() > tokenLimit) {
        emit({ type: "budget.exceeded", budget: "tokens", limit: tokenLimit });
        await checkpoint("budget", true);
        return finish("budget_exceeded", summary ?? "Token 用量超过预算，已停止");
      }
    }
    } catch (error) {
      if (error instanceof CheckpointPersistenceError) {
        return finish("failed", error.message, [], null, { code: "CHECKPOINT_FAILED", message: error.message, retryable: true });
      }
      if (stallTimer) clearInterval(stallTimer);
      closeJournal();
      throw error;
    }
  }
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

async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    setTimeout(() => signal.removeEventListener("abort", onAbort), ms + 10).unref?.();
  });
}

class CheckpointPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointPersistenceError";
  }
}

function addUsage(target: RunUsage, value: AgentUsage): void {
  target.inputTokens += (Number.isFinite(value.inputTokens) ? Math.max(0, value.inputTokens ?? 0) : 0);
  target.cachedInputTokens += (Number.isFinite(value.cachedInputTokens) ? Math.max(0, value.cachedInputTokens ?? 0) : 0);
  target.cacheWriteInputTokens += (Number.isFinite(value.cacheWriteInputTokens) ? Math.max(0, value.cacheWriteInputTokens ?? 0) : 0);
  target.outputTokens += (Number.isFinite(value.outputTokens) ? Math.max(0, value.outputTokens ?? 0) : 0);
  target.reasoningOutputTokens += (Number.isFinite(value.reasoningOutputTokens) ? Math.max(0, value.reasoningOutputTokens ?? 0) : 0);
}

const READ_ONLY_TOOL_NAMES = new Set([
  "read_file", "list_files", "search_text", "glob", "grep", "read_document", "fetch_url", "capture_screen", "stat_file", "read_tool_output"
]);

const LOCAL_WRITE_TOOL_NAMES = new Set([
  "write_file", "write_spreadsheet", "write_document", "edit_file", "apply_patch", "delete_file", "remove_file", "delete_path"
]);

const TERMINAL_JOB_STATUSES = new Set(["settled", "completed", "finished", "failed", "stopped", "cancelled", "lost"]);

const TOOL_TIMEOUT_DEFAULTS: Record<string, number> = {
  shell: 300_000,
  shell_wait: 300_000,
  run_tests: 1_200_000,
  diagnostics: 900_000,
  workflow: 120_000,
  fetch_url: 60_000,
  capture_screen: 60_000,
  read_file: 30_000,
  read_document: 60_000,
  read_tool_output: 30_000,
  list_files: 30_000,
  search_text: 30_000,
  glob: 30_000,
  grep: 30_000,
  write_file: 60_000,
  write_spreadsheet: 60_000,
  write_document: 60_000,
  edit_file: 60_000,
  apply_patch: 60_000,
  shell_output: 15_000,
  shell_kill: 15_000,
  ask_user: 0,
  finish_task: 0,
};

function toolTimeoutFor(toolName: string, fallback: number): number {
  return TOOL_TIMEOUT_DEFAULTS[toolName] ?? fallback;
}

async function executeToolWithTimeout(
  tool: AgentTool,
  call: AgentToolCall,
  context: AgentToolContext,
  fallbackTimeoutMs: number,
  parentSignal: AbortSignal
): Promise<AgentToolResult> {
  const timeoutMs = tool.definition.timeoutMs ?? toolTimeoutFor(call.name, fallbackTimeoutMs);
  if (!timeoutMs || timeoutMs <= 0) return tool.execute(call.arguments, context);
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (parentSignal.aborted) controller.abort();
  else parentSignal.addEventListener("abort", onAbort, { once: true });

  const execution = Promise.resolve()
    .then(() => tool.execute(call.arguments, { ...context, signal: controller.signal }))
    .then((result) => ({ kind: "result" as const, result }))
    .catch((error: unknown) => ({ kind: "error" as const, error }));

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timeoutTimer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    timeoutTimer.unref?.();
  });  let parentAbortResolve: (() => void) | null = null;
  const parentAbort = new Promise<{ kind: "parent-abort" }>((resolve) => {
    parentAbortResolve = () => resolve({ kind: "parent-abort" });
    if (parentSignal.aborted) parentAbortResolve();
    else parentSignal.addEventListener("abort", parentAbortResolve, { once: true });
  });

  let first: { kind: "result"; result: AgentToolResult } | { kind: "error"; error: unknown } | { kind: "timeout" } | { kind: "parent-abort" };
  try {
    first = await Promise.race([execution, timeout, parentAbort]);
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);    parentSignal.removeEventListener("abort", onAbort);
    if (parentAbortResolve) parentSignal.removeEventListener("abort", parentAbortResolve);
  }

  if (first.kind === "parent-abort") {
    controller.abort();
    return {
      content: `工具 ${call.name} 因任务中止而取消。`,
      isError: true,
      error: { code: "TOOL_ABORTED", retryable: true }
    };
  }
  if (first.kind === "result") return first.result;
  if (first.kind === "error") throw first.error;

  controller.abort();
  const grace = await Promise.race([
    execution,
    new Promise<{ kind: "grace-timeout" }>((resolve) => {
      const timer = setTimeout(() => resolve({ kind: "grace-timeout" }), 5_000);
      timer.unref?.();
    })
  ]);
  if (grace.kind === "result") return grace.result;
  if (grace.kind === "error") throw grace.error;
  return {
    content: `工具 ${call.name} 执行超时（${timeoutMs}ms），且未在 5s 内响应中止；后台可能仍在执行，请先核对工作区或外部状态。`,
    isError: true,
    error: { code: "TOOL_TIMEOUT", retryable: true },
    metadata: { timedOut: true, orphaned: true, cooperative: false }
  };
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

function isTruncatedFinishReason(reason: string | null): boolean {
  if (!reason) return false;
  const value = reason.toLowerCase();
  return value === "length"
    || value === "max_tokens"
    || value === "max_output_tokens"
    || value === "incomplete"
    || value === "max_tokens_reached";
}

function isContextOverflow(error: unknown): boolean {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = typeof record.status === "number" ? record.status : null;
  const message = errorMessage(error);
  return status === 413
    || /(context[_ ]length|context window|maximum context|too many tokens|prompt is too long|input is too long|token limit)/i.test(message);
}
