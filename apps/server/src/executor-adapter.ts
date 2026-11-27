import type {
  AgentCheckpoint,
  AgentFailure,
  AgentMessage,
  AgentResumeState,
  AgentTool,
  AgentToolAuthorization,
  AgentToolAuthorizationRequest,
  JournalSink,
  OperationLedger,
  RuntimeEvent
} from "@hearth/agent-runtime";
import type {
  BudgetExhaustion,
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
import { runDeepSeekHarness, type DeepSeekHarnessRunOptions, type DeepSeekHarnessRunResult, type DshApprovalOutcome, type DshApprovalRequest, type DshContextEvent } from "@hearth/deepseek-executor";
import { executorHome } from "./executor-runtime.ts";
import type { ModelSettings } from "./model-settings.ts";
import { nativePermissionsFor, withExtraToolPermissions, type NativeRunOptions, type NativeRunResult } from "./native-executor.ts";
import type { PreparedWorkspace } from "./workspace.ts";
import { wantsScreenshot } from "./task-intent.ts";

export type CodexRunner = (options: CodexRunOptions) => Promise<CodexRunResult>;
export type NativeRunner = (options: NativeRunOptions) => Promise<NativeRunResult>;
export type DshRunner = (options: DeepSeekHarnessRunOptions) => Promise<DeepSeekHarnessRunResult>;
export type CodexContextItem = Parameters<NonNullable<CodexRunOptions["onContextItem"]>>[0];

export interface ExecutionOutcome {
  status: "completed" | "waiting_input" | "failed" | "cancelled" | "budget_exceeded";
  finalResponse: string;
  usage: RunUsage | null;
  turns?: number;
  toolCalls?: number;
  threadId: string | null;
  label: string;
  question: string | null;
  planPath?: string | null;
  planMarkdown?: string | null;
  planSubmitted?: boolean;
  resume?: AgentResumeState;
  failure?: AgentFailure;
  budgetExhaustion?: Pick<BudgetExhaustion, "dimension" | "limit">;
}

export interface ExecutorAttemptContext {
  task: TaskRecord;
  run: RunRecord;
  prepared: PreparedWorkspace;
  budget: RunBudget;
  signal: AbortSignal;
  fullPermission: boolean;
  operationLedger?: OperationLedger;
  runtimeJournal?: JournalSink;
  isFullPermission?: (() => boolean) | undefined;
  contextSettings: ContextSettings;
  nativeSettings: ModelSettings | null;
  dshSettings: ModelSettings | null;
  executorSettings: ExecutorSettings;
  expectedOutputs: string[];
  mode?: "build" | "plan";
  maxParallelTools?: number;
  activeThreadId?: string;
  extraNativeTools?: AgentTool[];
  skipBuiltinGoalTools?: boolean;
  finishGuards?: Array<() => string | null>;
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  steering?: (() => AgentMessage[]) | undefined;
  onProgress: (event: { kind: string; message: string; detail?: TaskProgressDetail }) => void;
  onNativeContextEvent: (event: RuntimeEvent) => void;
  onNativeCheckpoint: (checkpoint: AgentCheckpoint) => void | Promise<void>;
  onAuthorizeTool?: (request: AgentToolAuthorizationRequest) => Promise<AgentToolAuthorization>;
  onDshApprovalRequest?: (request: DshApprovalRequest) => Promise<DshApprovalOutcome>;
  onDshContextItem: (event: DshContextEvent) => void;
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
  executorSettings: ExecutorSettings;
  modelSettings?: ModelSettings | null;
}

export interface ExecutorAvailability {
  ok: boolean;
  reason?: string;
}


//用统一接口约定“怎么调用执行器”
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

  canRun(_input: ExecutorAvailabilityInput): ExecutorAvailability {
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
    const permissions = withExtraToolPermissions(nativePermissionsFor(input.task, input.prepared), input.extraNativeTools ?? []);
    const outcome = await this.runner({
      task: input.task,
      prepared: input.prepared,
      settings: input.nativeSettings,
      prompt: input.prompt,
      permissions,
      budget: input.budget,
      signal: input.signal,
      runId: input.run.id,
      taskId: input.task.id,
      ...(input.operationLedger ? { operationLedger: input.operationLedger } : {}),
      ...(input.runtimeJournal ? { journalSink: input.runtimeJournal } : {}),
      goalRoot: input.prepared.root,
      checkpointPolicy: { everyTurns: 5, everyToolCalls: 20, maxSnapshots: 40 },
      ...(resumable ? { resume: resumable } : {}),
      ...(input.extraNativeTools?.length ? { extraTools: input.extraNativeTools } : {}),
      ...(input.skipBuiltinGoalTools ? { skipBuiltinGoalTools: true } : {}),
      ...(input.finishGuards?.length ? { finishGuards: input.finishGuards } : {}),
      ...(input.steering ? { steering: input.steering } : {}),
      expectedOutputs: input.expectedOutputs,
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.maxParallelTools ? { maxParallelTools: input.maxParallelTools } : {}),
      onProgress: input.onProgress,
      onContextEvent: input.onNativeContextEvent,
      onCheckpoint: input.onNativeCheckpoint,
      ...(input.onAuthorizeTool ? { onAuthorizeTool: input.onAuthorizeTool } : {}),
      ...(input.isFullPermission ? { isFullPermission: input.isFullPermission } : {})
    });
    return {
      status: outcome.status,
      finalResponse: outcome.finalResponse,
      usage: outcome.usage,
      turns: outcome.turns,
      toolCalls: outcome.toolCalls,
      threadId: null,
      label: `native / ${input.nativeSettings.model}`,
      question: outcome.question,
      ...(outcome.planPath ? { planPath: outcome.planPath } : {}),
      ...(input.mode === "plan" && outcome.planSubmitted && (outcome.question || outcome.finalResponse)
        ? { planMarkdown: outcome.finalResponse || outcome.question, planSubmitted: true }
        : {}),
      ...(outcome.failure ? { failure: outcome.failure } : {}),
      ...(outcome.budgetExhaustion ? { budgetExhaustion: outcome.budgetExhaustion } : {}),
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
    const planMode = input.mode === "plan";
    const resumeThreadId = planMode ? undefined : input.activeThreadId;
    const result = await this.runner({
      workingDirectory: input.prepared.root,
      outDir: input.prepared.outDir,
      prompt: input.prompt,
      signal: input.signal,
      networkAccessEnabled: planMode ? false : input.fullPermission || input.contextSettings.allowCodexNetwork,
      sandboxMode: planMode ? "read-only" : "danger-full-access",
      approvalPolicy: "never",
      ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
      ...(resumeThreadId ? { threadId: resumeThreadId } : {}),
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
      question: null,
      ...(planMode ? { planMarkdown: result.finalResponse, planSubmitted: true } : {})
    };
  }

  resume(input: ExecutorInvocation & { resume: AgentResumeState }): Promise<ExecutionOutcome> {
    return this.execute(input);
  }
}

export class DeepSeekHarnessExecutorAdapter implements ExecutorAdapter {
  readonly id = "deepseek-harness" as const;
  readonly supportsResume = true;

  constructor(
    private readonly runner: DshRunner,
    private readonly settingsPath: string
  ) {}

  canRun(input: ExecutorAvailabilityInput): ExecutorAvailability {
    if (wantsScreenshot(`${input.task.title}\n${input.task.goal}`) || input.task.permissions?.tools.includes("capture_screen")) {
      return { ok: false, reason: "DeepSeek Harness 不支持桌面截图任务" };
    }
    const settings = input.modelSettings;
    if (!settings) return { ok: false, reason: "DeepSeek Harness 还没有绑定模型，请到设置中选择模型档案" };
    if (!settings.baseUrl || !settings.model || !settings.apiKey) {
      return { ok: false, reason: "DeepSeek Harness 的模型档案缺少服务地址、模型名或 API Key" };
    }
    if (settings.protocol === "gemini") {
      return { ok: false, reason: "DeepSeek Harness 不支持 Gemini 协议" };
    }
    return { ok: true };
  }

  async execute(input: ExecutorInvocation): Promise<ExecutionOutcome> {
    const settings = input.dshSettings;
    if (!settings) throw new Error("DeepSeek Harness 还没有绑定模型，请到设置中选择模型档案");
    if (settings.protocol === "gemini") throw new Error("DeepSeek Harness 不支持 Gemini 协议");
    const planMode = input.mode === "plan";
    const result = await this.runner({
      settings: {
        protocol: settings.protocol,
        baseUrl: settings.baseUrl,
        model: settings.model,
        apiKey: settings.apiKey,
        ...(settings.contextWindowTokens !== undefined ? { contextWindowTokens: settings.contextWindowTokens } : {}),
        ...(settings.maxOutputTokens !== undefined ? { maxOutputTokens: settings.maxOutputTokens } : {})
      },
      dshHome: executorHome(this.settingsPath, "deepseek-harness"),
      workingDirectory: input.prepared.root,
      outDir: input.prepared.outDir,
      prompt: input.prompt,
      mode: planMode ? "necessary" : input.fullPermission ? "full" : "necessary",
      planMode,
      permissionMode: planMode ? "read-only" : input.fullPermission ? "danger-full-access" : "workspace-write",
      ...(input.budget.maxTurns !== undefined ? { maxTurns: input.budget.maxTurns } : {}),
      ...(input.budget.maxDurationMs !== undefined
        ? { runBudgetSeconds: Math.max(1, Math.ceil(input.budget.maxDurationMs / 1000)) }
        : {}),
      ...(!planMode && input.activeThreadId ? { resumeSessionId: input.activeThreadId } : {}),
      signal: input.signal,
      onProgress: (event) => input.onProgress({
        kind: event.type,
        message: event.message,
        ...(event.detail ? { detail: event.detail as TaskProgressDetail } : {})
      }),
      onContextItem: input.onDshContextItem,
      ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
      ...(input.onDshApprovalRequest ? { onApprovalRequest: input.onDshApprovalRequest } : {})
    });
    const question = result.question?.trim() || null;
    const planMarkdown = planMode ? result.planMarkdown?.trim() || null : null;
    return {
      status: planMarkdown || !question ? "completed" : "waiting_input",
      finalResponse: result.finalResponse,
      usage: result.usage,
      threadId: result.sessionId,
      label: `deepseek-harness / ${result.sessionId}`,
      question,
      ...(planMarkdown ? { planMarkdown, planSubmitted: true } : {})
    };
  }

  resume(input: ExecutorInvocation & { resume: AgentResumeState }): Promise<ExecutionOutcome> {
    return this.execute(input);
  }
}


export function createExecutorAdapters(input: {
  native: NativeRunner;
  codex: CodexRunner;
  deepseek?: DshRunner;
  settingsPath: string;
}): Record<ExecutorId, ExecutorAdapter> {
  const deepseek = input.deepseek ?? runDeepSeekHarness;
  return {
    native: new NativeExecutorAdapter(input.native),
    codex: new CodexExecutorAdapter(input.codex),
    "deepseek-harness": new DeepSeekHarnessExecutorAdapter(deepseek, input.settingsPath)
  };
}
