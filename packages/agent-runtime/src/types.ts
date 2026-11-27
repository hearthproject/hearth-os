//消息、工具、模型、检查点和运行结果的数据结构

import type { RunBudget, RunUsage, TaskPermissions } from "@hearth/core";
import type { SandboxRuntime } from "./harness/sandbox.ts";
import type { BackgroundTaskRegistry } from "./harness/background-tasks.ts";
import type { AgentHookDefinition } from "./harness/hooks.ts";
import type { AgentFailure, AgentToolError } from "./errors.ts";
import type { RetryPolicy } from "./retry-policy.ts";
import type { OperationLedger, OperationPhase } from "./operations/types.ts";
import type { JournalEvent, JournalSink } from "./journal.ts";

export type HarnessProfile = "general" | "coding";
export type HarnessMode = "build" | "plan";

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Read-only tools can run in a bounded parallel batch. */
  executionMode?: "parallel" | "sequential";
  /** Per-tool timeout. Defaults to 120s, shell tools may override. */
  timeoutMs?: number;
  /** Fail-closed dynamic concurrency check; unknown/absent tools stay exclusive. */
  isConcurrencySafe?: (args: unknown) => boolean;
  /** Recovery effect class used by the run journal. */
  effect?: AgentToolEffect;
  /** Dynamic effect override for argument-dependent tools such as shell. */
  effectForArgs?: (args: unknown) => AgentToolEffect;
}

export type AgentToolEffect = "read" | "local_write" | "external_write" | "destructive" | "unknown";

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: unknown;
  rawArguments: string;
}

export interface AgentToolAuthorizationRequest {
  call: AgentToolCall;
  definition: AgentToolDefinition;
}

export type AgentToolAuthorization =
  | { allowed: true }
  | { allowed: false; reason: string };

export type AgentMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: AgentToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export type AgentUsage = Pick<RunUsage, "inputTokens" | "outputTokens"> & Partial<RunUsage>;

export type ContextSummary = string | null | { summary: string | null; usage: AgentUsage | null };

export interface AgentModelTurn {
  content: string;
  toolCalls: AgentToolCall[];
  usage: AgentUsage | null;
  finishReason: string | null;
}

export type AgentModel = (
  messages: AgentMessage[],
  tools: AgentToolDefinition[],
  onDelta: (text: string) => void,
  signal: AbortSignal
) => Promise<AgentModelTurn>;

export interface AgentToolContext {
  workspaceRoot: string;
  outDir: string;
  permissions: TaskPermissions;
  signal: AbortSignal;
  state?: AgentToolState;
  fullAccess?: boolean;
  mode?: HarnessMode;
  /** Task-scoped root for goal/plan files. Defaults to workspaceRoot. */
  goalRoot?: string;
  sandbox?: SandboxRuntime;
  backgroundTasks?: BackgroundTaskRegistry;
  taskId?: string;
  runId?: string;
  verifyGoalCompletion?: (goal: {
    goalId: string;
    title: string;
    objective: string;
    constraints: string[];
    successCriteria: string[];
    note: string | null;
  }) => Promise<{ ok: boolean; reason?: string }>;
}

export type AgentToolAction = "finish" | "ask_user" | "plan";

export interface AgentToolMetadata {
  title?: string;
  truncated?: boolean;
  fullOutputPath?: string;
  exitCode?: number | null;
  durationMs?: number;
  filesChanged?: string[];
  diff?: string;
  failedTests?: string[];
  diagnostics?: Array<{ file: string; line?: number; code?: string; message: string }>;
  sessionId?: string;
  background?: boolean;
  jobId?: string;
  jobKind?: "shell" | "background_tool" | "subagent";
  jobStatus?: string;
  snapshotId?: string;
  snapshotIds?: string[];
  unchanged?: boolean;
  offset?: number;
  end?: number;
  totalChars?: number;
  eof?: boolean;
  agentId?: string;
  subagentType?: string;
  agentStatus?: "running" | "completed" | "failed" | "cancelled";
  branch?: string;
  commitSha?: string;
  transcriptPath?: string;
  reportPath?: string;
  structured?: unknown;
  exposedTools?: string[];
  matched?: boolean;
  timedOut?: boolean;
  aborted?: boolean;
  orphaned?: boolean;
  cooperative?: boolean;
  sandbox?: { backend: string; enforcement: string; networkEnforcement: string; mode: string };
  sandboxFailure?: "denied" | "runner_failure";
  insertions?: number;
  deletions?: number;
  failures?: Array<{ path: string; reason: string }>;
  browserAssertions?: Array<{ kind: string; expected: string; passed: boolean; actual?: string }>;
  browserUrl?: string;
  browserPageDigest?: string;
  browserTabs?: Array<{ id: string; url: string }>;
  browserTabId?: string;
  browserScreenshot?: string;
  browserDownload?: string;
  browserEvidence?: Record<string, string | null>;
  browserTakeover?: boolean;
  browserTakeoverKind?: string;
  browserTakeoverReason?: string;
  browserControlState?: string;
  provider?: string;
  attemptedProviders?: string[];
  count?: number;
  browserControlEpoch?: number | null;
  browserCapturedAt?: string;
  browserTruncated?: boolean;
  browserRecipes?: Array<{ name: string; domain: string }>;
  browserRecipe?: string;
  operationId?: string;
  operationPhase?: OperationPhase;
  operationUnsettled?: boolean;
  requiresReconciliation?: boolean;
  effectRef?: string;
  receipt?: unknown;
}

export interface AgentToolResult {
  content: string;
  isError?: boolean;
  /** Structured failure for scheduler routing; content stays model-readable. */
  error?: AgentToolError;
  action?: AgentToolAction;
  summary?: string;
  outputs?: string[];
  question?: string;
  usage?: RunUsage;
  metadata?: AgentToolMetadata;
}

export type AgentTodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface AgentTodo {
  id: string;
  content: string;
  status: AgentTodoStatus;
}

/**
 * 一等公民的结构化计划。每一步都带 state，供模型在执行时读取最新进度；
 * owner 与 note 为后续多智能体分派、取消原因预留。
 */
export type AgentPlanStepState = "pending" | "in_progress" | "completed" | "cancelled";

export interface AgentPlanStep {
  id: string;
  title: string;
  detail?: string;
  state: AgentPlanStepState;
  /** 后续多智能体：把步骤分派给某个 agent。 */
  owner?: string;
  /** 取消或改派的原因。 */
  note?: string;
}

export interface AgentPlan {
  title: string;
  /** submit_plan 的自由文字方案。 */
  goal: string;
  steps: AgentPlanStep[];
  createdAt: number;
}

export interface AgentReadFileState {
  size: number;
  mtimeMs: number;
  hash: string;
  ranges?: Array<{ start: number; end: number }>;
}

export interface AgentSubagentState {
  id: string;
  type: "explore" | "plan" | "review" | "general-purpose";
  status: "running" | "completed" | "failed" | "cancelled";
  title?: string;
  transcriptPath?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface AgentActiveWork {
  id: string;
  kind: "shell" | "subagent";
  status: "running" | "completed" | "failed" | "lost" | "cancelled";
  label?: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
}

export interface AgentProgress {
  filesRead: string[];
  filesModified: string[];
  commands: Array<{ command: string; exitCode: number | null; test: boolean; at: number }>;
  tests: Array<{ command: string; passed: boolean | null; at: number }>;
  diagnostics: Array<{ file: string; line?: number; code?: string; message: string; at: number }>;
}

export interface AgentToolState {
  workspaceRoot: string;
  readFiles: Map<string, AgentReadFileState>;
  todos: AgentTodo[];
  /** 当前生效的结构化计划；存在时每轮回注给模型。 */
  plan?: AgentPlan;
  progress: AgentProgress;
  startedAt: number;
  snapshots: Map<string, string>;
  snapshotSeq: number;
  turn?: number;
  planPath?: string;
  mode?: HarnessMode;
  activeSkills?: string[];
  subagents?: AgentSubagentState[];
  activeWork?: AgentActiveWork[];
  /** Names discovered through tool_search and callable on later turns. */
  exposedTools?: string[];
  /** Full output paths for oversized tool results, keyed by tool call ID. */
  toolOutputs?: Record<string, { path: string; bytes: number; tokens: number }>;
}

export interface SerializedAgentToolState {
  workspaceRoot: string;
  readFiles: Array<{ path: string; size: number; mtimeMs: number; hash: string; ranges?: Array<{ start: number; end: number }> }>;
  todos: AgentTodo[];
  plan?: AgentPlan;
  progress: AgentProgress;
  startedAt: number;
  snapshots: Array<{ id: string; path: string }>;
  snapshotSeq: number;
  turn?: number;
  planPath?: string;
  mode?: HarnessMode;
  activeSkills?: string[];
  subagents?: AgentSubagentState[];
  activeWork?: AgentActiveWork[];
  /** Names discovered through tool_search and callable on later turns. */
  exposedTools?: string[];
  /** Full output paths for oversized tool results, keyed by tool call ID. */
  toolOutputs?: Record<string, { path: string; bytes: number; tokens: number }>;
}

export interface AgentTool {
  definition: AgentToolDefinition;
  execute(input: unknown, context: AgentToolContext): Promise<AgentToolResult>;
}

/** One named block of the system prompt, reported for context transparency. */
export interface ContextPromptSectionStat {
  id: string;
  label: string;
  chars: number;
  content: string;
}

export type RuntimeEvent =
  | { type: "turn.started"; turn: number }
  | { type: "assistant.delta"; turn: number; text: string }
  | { type: "assistant.message"; turn: number; text: string }
  | { type: "tool.started"; turn: number; call: AgentToolCall }
  | { type: "tool.finished"; turn: number; call: AgentToolCall; result: AgentToolResult; durationMs: number; retries?: number; totalDurationMs?: number }
  | { type: "tool.failed"; turn: number; callId: string; name: string; code: string; retryable: boolean; message: string; retries?: number; totalDurationMs?: number }
  | { type: "tool.rejected"; turn: number; callId: string; name: string; issues: Array<{ path: string; message: string }> }
  | { type: "tool.orphaned"; turn: number; callId: string; name: string; message: string }
  | { type: "tool.batch.started"; turn: number; calls: AgentToolCall[]; parallel: boolean }
  | { type: "tool.batch.finished"; turn: number; calls: AgentToolCall[]; parallel: boolean; durationMs: number }
  | { type: "checkpoint.created"; seq: number; kind: string; journalSeq?: number }
  | { type: "checkpoint.failed"; seq: number; kind: string; message: string }
  | { type: "compacted"; before: number; after: number; reason?: "microcompact" | "auto" | "reactive" | "forced" }
  | { type: "context.snapshot"; turn: number; modelId: string | null; messageCount: number; toolCount: number; systemChars: number; toolSchemaChars: number; historyChars: number; toolResultChars: number; estimatedTokens: number; providerInputTokens: number | null; providerOutputTokens: number | null; source: "provider" | "estimate" }
  | { type: "context.usage"; turn: number; modelId: string | null; inputTokens: number; outputTokens: number; cachedInputTokens: number; systemChars: number; toolSchemaChars: number; historyChars: number; toolResultChars: number; estimatedTokens: number; systemPrompt?: string; systemSections?: ContextPromptSectionStat[] }
  | { type: "prompt.snapshot"; turn: number; systemPromptHash: string; toolSchemaHash: string; messageStart: number; messageEnd: number }
  | { type: "context.watermark"; estimatedTokens: number; usedTokens: number; compactions: number; source?: "provider" | "estimate" }
  | { type: "progress.updated"; filesRead: number; filesModified: number; commands: number; tests: number; todosOpen?: number }
  | { type: "model.timing"; turn: number; durationMs: number; firstDeltaMs: number | null; toolCalls: number }
  | { type: "todos.updated"; turn: number; todos: AgentTodo[] }
  | { type: "usage"; usage: RunUsage }
  | { type: "retry.scheduled"; attempt: number; delayMs: number; code: string }
  | { type: "retry.started"; attempt: number }
  | { type: "stall.warned"; idleMs: number }
  | { type: "stall.detected"; idleMs: number }
  | { type: "goal.round"; round: number; maxRounds?: number; goalId: string }
  | { type: "job.registered"; jobId: string; kind: "shell" | "background_tool" | "subagent"; status: string }
  | { type: "job.settled"; jobId: string; kind: "shell" | "background_tool" | "subagent"; status: string }
  | { type: "journal.failed"; message: string }
  | { type: "budget.exceeded"; budget: "turns" | "toolCalls" | "tokens" | "duration"; limit: number }
  | { type: "notice"; message: string };

export interface AgentCheckpoint {
  seq: number;
  kind: "turn" | "tool" | "compaction" | "final" | "budget" | "waiting_input" | "plan";
  messages: AgentMessage[];
  usage: RunUsage;
  turns: number;
  toolCalls: number;
  summary: string | null;
  state?: SerializedAgentToolState;
  mode?: HarnessMode;
  promptHash?: string;
  /** Digest of the tool definitions the model saw. */
  toolsDigest?: string;
  /** Last journal event covered by this snapshot. */
  journalSeq?: number;
}

export interface AgentResumeState {
  messages: AgentMessage[];
  usage: RunUsage;
  turns: number;
  toolCalls: number;
  state?: AgentToolState;
  promptHash?: string;
  toolsDigest?: string;
  journal?: { path?: string; seq: number; events?: JournalEvent[] };
}

export interface AgentPostEditEvent {
  turn: number;
  tool: string;
  files: string[];
  result: AgentToolResult;
}

export interface AgentRuntimeOptions {
  model: AgentModel;
  modelId?: string;
  tools: AgentTool[];
  goal: string;
  systemPrompt: string;
  budget: RunBudget;
  permissions: TaskPermissions;
  workspaceRoot: string;
  outDir: string;
  sandbox?: SandboxRuntime;
  backgroundTasks?: BackgroundTaskRegistry;
  signal?: AbortSignal;
  resume?: AgentResumeState;
  onEvent?: (event: RuntimeEvent) => void;
  onCheckpoint?: (checkpoint: AgentCheckpoint) => void | Promise<void>;
  /** Stop the run when a checkpoint cannot be persisted. Defaults to stop. */
  checkpointFailurePolicy?: "stop" | "warn";
  afterEdit?: (event: AgentPostEditEvent) => void | Promise<void>;
  authorizeTool?: (request: AgentToolAuthorizationRequest) => Promise<AgentToolAuthorization>;
  validateFinish?: (result: AgentToolResult, context: AgentToolContext) => string | null | Promise<string | null>;
  verifyGoalCompletion?: AgentToolContext["verifyGoalCompletion"];
  isFullPermission?: () => boolean;
  contextWindowTokens?: number;
  contextReserveTokens?: number;
  compactTriggerTokens?: number;
  maxOutputTokens?: number;
  recentContextTokens?: number;
  summarizeContext?: (messages: AgentMessage[], signal: AbortSignal) => Promise<ContextSummary>;
  requireFinishTool?: boolean;
  /**
   * 首轮必须先提交结构化计划（submit_plan / todo_write）才允许执行其它工具。
   * 拒绝执行时把要求推回给模型，连续拒绝后由运行时生成最小计划兜底，
   * 保证 plan 与 todos 始终有数据可供回注和界面展示。
   */
  requirePlanFirst?: boolean;
  stopOnToolError?: boolean;
  retryDelayMs?: number;
  retryPolicy?: Partial<RetryPolicy>;
  stallPolicy?: { warnMs?: number; abortMs?: number };
  journal?: AgentJournalOptions;
  checkpointPolicy?: { everyTurns?: number; everyToolCalls?: number; maxSnapshots?: number };
  goalRoot?: string;
  maxGoalRounds?: number;
  runId?: string;
  taskId?: string;
  /** Durable T1/T2 operation ledger. Server mode injects the SQLite implementation. */
  operationLedger?: OperationLedger;
  profile?: HarnessProfile;
  mode?: HarnessMode;
  state?: AgentToolState;
  steering?: () => AgentMessage[];
  toolTimeoutMs?: number;
  maxParallelTools?: number;
  keepRecentToolOutputs?: number;
  maxToolChars?: number;
  /** Above this count, only core tools are sent directly and tool_search is added. */
  maxDirectTools?: number;
  /** Profile-specific tools exposed directly instead of requiring tool_search. */
  directTools?: string[];
  /** Explicitly defer every tool that is not in directTools. */
  deferRemaining?: boolean;
  /** Per-tool retry policy. Defaults to 3 retries with exponential backoff for transient tool failures. */
  toolRetryPolicy?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitter?: number;
    retryableCodes?: string[];
  };
  /** Circuit breaker for consecutive tool failures. Defaults to 5 consecutive failures before stopping the run. */
  toolCircuitBreaker?: {
    threshold?: number;
    maxConsecutiveFailures?: number;
  };
  hooks?: AgentHookDefinition[];
  hookTimeoutMs?: number;
  projectInstructions?: string;
  reminders?: AgentRuntimeReminders;
}

export interface AgentRuntimeReminders {
  emptyTurn?: string;
  missingFinish?: string;
  repeated?: string;
}

export type AgentRunStatus = "completed" | "waiting_input" | "failed" | "cancelled" | "budget_exceeded";

export interface AgentRunMetrics {
  contextPeaks: number[];
  contextSource: "provider" | "estimate";
  compactions: number;
  modelId: string | null;
}

export interface AgentJournalOptions {
  path?: string;
  fsync?: boolean;
  rotateBytes?: number;
  /** Host-owned durable sink. When set, the runtime does not open a JSONL file. */
  sink?: JournalSink;
  startSeq?: number;
}

export interface AgentRunResult {
  status: AgentRunStatus;
  summary: string;
  messages: AgentMessage[];
  usage: RunUsage;
  turns: number;
  toolCalls: number;
  outputs: string[];
  question: string | null;
  planPath?: string;
  /** True only when a plan tool submitted a plan; ask_user remains a clarification. */
  planSubmitted?: boolean;
  metrics?: AgentRunMetrics;
  failure?: AgentFailure;
}

export interface ContextUsageAnchor {
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
}

export interface CompactOptions {
  keepRecent?: number;
  maxChars?: number;
  maxToolChars?: number;
  keepRecentToolOutputs?: number;
  toolOutputs?: Record<string, { path: string; bytes: number; tokens: number }>;
  contextWindowTokens?: number;
  reserveTokens?: number;
  maxOutputTokens?: number;
  usageAnchor?: ContextUsageAnchor;
  recentTokens?: number;
  stateSummary?: string;
  projectInstructions?: string;
  restoredContext?: string;
  signal?: AbortSignal;
}
