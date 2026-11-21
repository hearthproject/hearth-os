import type {
  AgentTool,
  AgentToolCall,
  AgentToolContext,
  AgentToolResult
} from "../types.ts";

export type ToolExecutionStatus = "completed" | "failed" | "timeout" | "aborted";

export interface ToolExecutionOutcome {
  status: ToolExecutionStatus;
  result: AgentToolResult | null;
  error: unknown;
  durationMs: number;
}

type Settled =
  | { kind: "result"; result: AgentToolResult }
  | { kind: "error"; error: unknown };

const TIMEOUT_GRACE_MS = 5_000;

/**
 * One cancellable tool execution with a hard deadline.
 *
 * A bare Promise.race can return while the underlying tool keeps running. This
 * handle aborts the tool, waits a bounded grace period for cooperative
 * cancellation, and reports a timeout/abort outcome that the operation ledger
 * records as unknown.
 */
export class ToolExecutionHandle {
  private readonly controller = new AbortController();
  private readonly execution: Promise<Settled>;
  private readonly startedAt = Date.now();
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private parentAbortResolve: (() => void) | null = null;
  private readonly timeoutMs: number | null;
  private readonly parentSignal: AbortSignal;
  private readonly onParentAbort: () => void;

  private constructor(
    private readonly tool: AgentTool,
    private readonly call: AgentToolCall,
    private readonly context: AgentToolContext,
    timeoutMs: number | null,
    parentSignal: AbortSignal
  ) {
    this.timeoutMs = timeoutMs;
    this.parentSignal = parentSignal;
    this.onParentAbort = (): void => this.controller.abort();
    if (parentSignal.aborted) this.controller.abort();
    else parentSignal.addEventListener("abort", this.onParentAbort, { once: true });

    this.execution = Promise.resolve()
      .then(() => tool.execute(call.arguments, { ...context, signal: this.controller.signal }))
      .then((result) => ({ kind: "result" as const, result }))
      .catch((error: unknown) => ({ kind: "error" as const, error }));
  }

  static start(
    tool: AgentTool,
    call: AgentToolCall,
    context: AgentToolContext,
    fallbackTimeoutMs: number,
    parentSignal: AbortSignal
  ): ToolExecutionHandle {
    const declared = tool.definition.timeoutMs ?? fallbackTimeoutMs;
    return new ToolExecutionHandle(
      tool,
      call,
      context,
      Number.isFinite(declared) && declared > 0 ? declared : null,
      parentSignal
    );
  }

  get abortSignal(): AbortSignal {
    return this.controller.signal;
  }

  async wait(): Promise<ToolExecutionOutcome> {
    if (this.parentSignal.aborted) {
      this.controller.abort();
      return this.abortOutcome("aborted");
    }

    const timeout = this.timeoutPromise();
    const parentAbort = this.parentAbortPromise();
    const first = await Promise.race([this.execution, timeout, parentAbort]);
    this.clearTimers();
    if (first.kind === "result") {
      return { status: "completed", result: first.result, error: null, durationMs: Date.now() - this.startedAt };
    }
    if (first.kind === "error") {
      return { status: "failed", result: null, error: first.error, durationMs: Date.now() - this.startedAt };
    }

    this.controller.abort();
    if (first.kind === "timeout") return this.finishInterrupted("timeout");
    return this.finishInterrupted("aborted");
  }

  private async finishInterrupted(reason: "timeout" | "aborted"): Promise<ToolExecutionOutcome> {
    const settled = await this.waitForGrace();
    if (settled?.kind === "result") {
      return {
        status: reason,
        result: markInterrupted(settled.result, reason, this.timeoutMs),
        error: null,
        durationMs: Date.now() - this.startedAt
      };
    }
    if (settled?.kind === "error") {
      return {
        status: reason,
        result: interruptedResult(this.call.name, reason, this.timeoutMs, settled.error),
        error: settled.error,
        durationMs: Date.now() - this.startedAt
      };
    }
    return this.abortOutcome(reason);
  }

  private abortOutcome(reason: "timeout" | "aborted"): ToolExecutionOutcome {
    const result = interruptedResult(this.call.name, reason, this.timeoutMs, null);
    return {
      status: reason,
      result,
      error: result.error ?? null,
      durationMs: Date.now() - this.startedAt
    };
  }

  private async waitForGrace(): Promise<Settled | null> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        this.execution,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), TIMEOUT_GRACE_MS);
          timer.unref?.();
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private timeoutPromise(): Promise<{ kind: "timeout" }> {
    const timeoutMs = this.timeoutMs;
    if (timeoutMs === null) return new Promise(() => undefined);
    return new Promise((resolve) => {
      this.timeoutTimer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      this.timeoutTimer.unref?.();
    });
  }

  private parentAbortPromise(): Promise<{ kind: "parent-abort" }> {
    return new Promise((resolve) => {
      this.parentAbortResolve = () => resolve({ kind: "parent-abort" });
      if (this.parentSignal.aborted) this.parentAbortResolve();
      else this.parentSignal.addEventListener("abort", this.parentAbortResolve, { once: true });
    });
  }

  private clearTimers(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = null;
    if (this.parentAbortResolve) this.parentSignal.removeEventListener("abort", this.parentAbortResolve);
    this.parentAbortResolve = null;
    this.parentSignal.removeEventListener("abort", this.onParentAbort);
  }
}

function markInterrupted(
  result: AgentToolResult,
  reason: "timeout" | "aborted",
  timeoutMs: number | null
): AgentToolResult {
  const code = reason === "timeout" ? "TOOL_TIMEOUT" : "TOOL_ABORTED";
  const note = reason === "timeout"
    ? `工具执行超时${timeoutMs ? `（${timeoutMs}ms）` : ""}，已中止；结果可能不完整。`
    : "工具因任务中止而取消；结果可能不完整。";
  return {
    ...result,
    content: result.content ? `${result.content}\n\n[${note}]` : note,
    isError: true,
    error: result.error ?? { code, retryable: true },
    metadata: { ...result.metadata, timedOut: reason === "timeout", orphaned: true }
  };
}

function interruptedResult(
  name: string,
  reason: "timeout" | "aborted",
  timeoutMs: number | null,
  error: unknown
): AgentToolResult {
  const detail = error instanceof Error ? `：${error.message}` : error ? `：${String(error)}` : "";
  return {
    content: reason === "timeout"
      ? `工具 ${name} 执行超时${timeoutMs ? `（${timeoutMs}ms）` : ""}，已中止，且未在 5s 内响应中止${detail}`
      : `工具 ${name} 因任务中止而取消${detail}`,
    isError: true,
    error: {
      code: reason === "timeout" ? "TOOL_TIMEOUT" : "TOOL_ABORTED",
      retryable: true
    },
    metadata: { timedOut: reason === "timeout", orphaned: true, cooperative: false }
  };
}
