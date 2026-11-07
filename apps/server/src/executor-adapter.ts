import type { AgentCheckpoint, AgentResumeState, RuntimeEvent } from "@hearth/agent-runtime";
import type {
  ContextSettings,
  ExecutorId,
  ExecutorSettings,
  RunBudget,
  RunRecord,
  RunUsage,
  TaskProgressDetail,
  TaskRecord
} from "@hearth/core";
import type { CodexRunOptions, CodexRunResult } from "@hearth/codex-executor";
import type { HermesRunOptions, HermesRunResult, HermesStreamEvent } from "./hermes-executor.ts";
import type { ModelSettings } from "./model-settings.ts";
import { nativePermissionsFor, type NativeRunOptions, type NativeRunResult } from "./native-executor.ts";
import type { PreparedWorkspace } from "./workspace.ts";
import { needsGithubRepository, wantsScreenshot } from "./task-intent.ts";

export type CodexRunner = (options: CodexRunOptions) => Promise<CodexRunResult>;
export type NativeRunner = (options: NativeRunOptions) => Promise<NativeRunResult>;
export type HermesRunner = (options: HermesRunOptions) => Promise<HermesRunResult>;
export type CodexContextItem = Parameters<NonNullable<CodexRunOptions["onContextItem"]>>[0];

export interface ExecutionOutcome {
  status: "completed" | "waiting_input" | "failed" | "cancelled" | "budget_exceeded";
  finalResponse: string;
  usage: RunUsage | null;
  threadId: string | null;
  label: string;
  question: string | null;
  resume?: AgentResumeState;
}

export interface ExecutorAttemptContext {
  task: TaskRecord;
  run: RunRecord;
  prepared: PreparedWorkspace;
  budget: RunBudget;
  signal: AbortSignal;
  fullPermission: boolean;
  contextSettings: ContextSettings;
  nativeSettings: ModelSettings | null;
  executorSettings: ExecutorSettings;
  expectedOutputs: string[];
  activeThreadId?: string;
  onProgress: (event: { kind: string; message: string; detail?: TaskProgressDetail }) => void;
  onNativeContextEvent: (event: RuntimeEvent) => void;
  onNativeCheckpoint: (checkpoint: AgentCheckpoint) => void | Promise<void>;
  onHermesContextItem: (event: HermesStreamEvent) => void;
  onCodexContextItem: (item: CodexContextItem) => void;
  onCodexThreadStarted: (threadId: string) => void;
}

export interface ExecutorInvocation extends ExecutorAttemptContext {
  prompt: string;
  resume?: AgentResumeState;
  resumePrompt?: string;
}

export interface ExecutorAvailabilityInput {
  task: TaskRecord;
  prepared: PreparedWorkspace | null;
  settings: ContextSettings;
}

export interface ExecutorAvailability {
  ok: boolean;
  reason?: string;
}

export interface ExecutorAdapter {
  id: ExecutorId;
  supportsResume: boolean;
  canRun(input: ExecutorAvailabilityInput): ExecutorAvailability;
  execute(input: ExecutorInvocation): Promise<ExecutionOutcome>;
  resume?(input: ExecutorInvocation & { resume: AgentResumeState }): Promise<ExecutionOutcome>;
}

export class NativeExecutorAdapter implements ExecutorAdapter {
  readonly id = "native" as const;
  readonly supportsResume = true;

  constructor(private readonly runner: NativeRunner) {}

  canRun(input: ExecutorAvailabilityInput): ExecutorAvailability {
    const hasGithubInput = input.task.inputs.some((item) => item.kind === "github");
    if (!hasGithubInput && needsGithubRepository(`${input.task.title} ${input.task.goal}`)) {
      return { ok: false, reason: "Native 执行器无法访问 GitHub 仓库" };
    }
    return { ok: true };
  }

  async execute(input: ExecutorInvocation): Promise<ExecutionOutcome> {
    if (!input.nativeSettings) throw new Error("原生执行器缺少模型设置");
    const resumable = input.resume
      ? {
          ...input.resume,
          messages: input.resumePrompt
            ? [...input.resume.messages, { role: "user" as const, content: input.resumePrompt }]
            : input.resume.messages
        }
      : undefined;
    const permissions = nativePermissionsFor(input.task, input.prepared);
    if (input.fullPermission) permissions.tools = permissions.tools.filter((tool) => tool !== "ask_user");
    const outcome = await this.runner({
      task: input.task,
      prepared: input.prepared,
      settings: input.nativeSettings,
      prompt: input.prompt,
      permissions,
      budget: input.budget,
      signal: input.signal,
      ...(resumable ? { resume: resumable } : {}),
      expectedOutputs: input.expectedOutputs,
      onProgress: input.onProgress,
      onContextEvent: input.onNativeContextEvent,
      onCheckpoint: input.onNativeCheckpoint
    });
    return {
      status: outcome.status,
      finalResponse: outcome.finalResponse,
      usage: outcome.usage,
      threadId: null,
      label: `native / ${input.nativeSettings.model}`,
      question: outcome.question,
      ...(outcome.messages
        ? { resume: { messages: outcome.messages, usage: outcome.usage, turns: outcome.turns, toolCalls: outcome.toolCalls } }
        : {})
    };
  }

  resume(input: ExecutorInvocation & { resume: AgentResumeState }): Promise<ExecutionOutcome> {
    return this.execute(input);
  }
}

export class CodexExecutorAdapter implements ExecutorAdapter {
  readonly id = "codex" as const;
  readonly supportsResume = true;

  constructor(private readonly runner: CodexRunner) {}

  canRun(input: ExecutorAvailabilityInput): ExecutorAvailability {
    if (wantsScreenshot(`${input.task.title}\n${input.task.goal}`) || input.task.permissions?.tools.includes("capture_screen")) {
      return { ok: false, reason: "Codex 不支持桌面截图任务" };
    }
    return { ok: true };
  }

  async execute(input: ExecutorInvocation): Promise<ExecutionOutcome> {
    const result = await this.runner({
      workingDirectory: input.prepared.root,
      outDir: input.prepared.outDir,
      prompt: input.prompt,
      signal: input.signal,
      networkAccessEnabled: input.contextSettings.allowCodexNetwork,
      ...(input.activeThreadId ? { threadId: input.activeThreadId } : {}),
      onEvent: (event) => input.onProgress({
        kind: event.type,
        message: event.message,
        ...(event.detail ? { detail: event.detail } : {})
      }),
      onContextItem: input.onCodexContextItem,
      onThreadStarted: input.onCodexThreadStarted
    });
    if (result.threadId && result.threadId !== input.activeThreadId) input.onCodexThreadStarted(result.threadId);
    return {
      status: "completed",
      finalResponse: result.finalResponse,
      usage: result.usage,
      threadId: result.threadId,
      label: result.profileLabel,
      question: null
    };
  }

  resume(input: ExecutorInvocation & { resume: AgentResumeState }): Promise<ExecutionOutcome> {
    return this.execute(input);
  }
}

export class HermesExecutorAdapter implements ExecutorAdapter {
  readonly id = "hermes" as const;
  readonly supportsResume = false;

  constructor(private readonly runner: HermesRunner) {}

  canRun(input: ExecutorAvailabilityInput): ExecutorAvailability {
    if (wantsScreenshot(`${input.task.title}\n${input.task.goal}`) || input.task.permissions?.tools.includes("capture_screen")) {
      return { ok: false, reason: "Hermes 不支持桌面截图任务" };
    }
    return { ok: true };
  }

  async execute(input: ExecutorInvocation): Promise<ExecutionOutcome> {
    const result = await this.runner({
      command: input.executorSettings.hermesCommand,
      workingDirectory: input.prepared.root,
      prompt: input.prompt,
      mode: input.fullPermission ? "full" : "necessary",
      maxTurns: input.budget.maxTurns,
      runBudgetSeconds: Math.max(1, Math.round(input.budget.maxDurationMs / 1000)),
      signal: input.signal,
      onEvent: (event) => input.onProgress({
        kind: event.type,
        message: event.message,
        ...(event.detail ? { detail: event.detail } : {})
      }),
      onContextItem: input.onHermesContextItem
    });
    return {
      status: "completed",
      finalResponse: result.finalResponse,
      usage: result.usage,
      threadId: result.sessionId,
      label: `hermes / ${result.sessionId ?? "session"}`,
      question: null
    };
  }
}

export function createExecutorAdapters(input: { native: NativeRunner; codex: CodexRunner; hermes: HermesRunner }): Record<ExecutorId, ExecutorAdapter> {
  return {
    native: new NativeExecutorAdapter(input.native),
    codex: new CodexExecutorAdapter(input.codex),
    hermes: new HermesExecutorAdapter(input.hermes),
    qoder: unavailableAdapter("qoder"),
    workbuddy: unavailableAdapter("workbuddy"),
    zcode: unavailableAdapter("zcode"),
    kimi: unavailableAdapter("kimi")
  };
}

function unavailableAdapter(id: ExecutorId): ExecutorAdapter {
  return {
    id,
    supportsResume: false,
    canRun: () => ({ ok: false, reason: `${id} adapter is not installed yet` }),
    execute: async () => {
      throw new Error(`${id} adapter is not installed yet`);
    }
  };
}
