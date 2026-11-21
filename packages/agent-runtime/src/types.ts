//消息、工具、模型、检查点和运行结果的数据结构

import type { RunBudget, RunUsage, TaskPermissions } from "@hearth/core";
import type { SandboxRuntime } from "./harness/sandbox.ts";
import type { AgentHookDefinition } from "./harness/hooks.ts";
import type { AgentFailure, AgentToolError } from "./errors.ts";
import type { RetryPolicy } from "./retry-policy.ts";

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
  exposedTools?: string[];
  matched?: boolean;
  timedOut?: boolean;
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

export type AgentTodoStatus = "pending" | "in_progress" | "completed";

export interface AgentTodo {
  id: string;
  content: string;
  status: AgentTodoStatus;
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

export type RuntimeEvent =
  | { type: "turn.started"; turn: number }
  | { type: "assistant.delta"; turn: number; text: string }
  | { type: "assistant.message"; turn: number; text: string }
  | { type: "tool.started"; turn: number; call: AgentToolCall }
  | { type: "tool.finished"; turn: number; call: AgentToolCall; result: AgentToolResult; durationMs: number; retries?: number; totalDurationMs?: number }
  | { type: "tool.failed"; turn: number; callId: string; name: string; code: string; retryable: boolean; message: string; retries?: number; totalDurationMs?: number }
  | { type: "tool.orphaned"; turn: number; callId: string; name: string; message: string }
  | { type: "tool.batch.started"; turn: number; calls: AgentToolCall[]; parallel: boolean }
  | { type: "tool.batch.finished"; turn: number; calls: AgentToolCall[]; parallel: boolean; durationMs: number }
  | { type: "checkpoint.created"; seq: number; kind: string; journalSeq?: number }
  | { type: "checkpoint.failed"; seq: number; kind: string; message: string }
  | { type: "compacted"; before: number; after: number; reason?: "microcompact" | "auto" | "reactive" | "forced" }
  | { type: "context.snapshot"; turn: number; modelId: string | null; messageCount: number; toolCount: number; systemChars: number; toolSchemaChars: number; historyChars: number; toolResultChars: number; estimatedTokens: number; providerInputTokens: number | null; providerOutputTokens: number | null; source: "provider" | "estimate" }
  | { type: "prompt.snapshot"; turn: number; systemPromptHash: string; toolSchemaHash: string; messageStart: number; messageEnd: number }
  | { type: "context.watermark"; estimatedTokens: number; usedTokens: number; compactions: number; source?: "provider" | "estimate" }
  | { type: "progress.updated"; filesRead: number; filesModified: number; commands: number; tests: number; todosOpen?: number }
  | { type: "usage"; usage: RunUsage }
  | { type: "retry.scheduled"; attempt: number; delayMs: number; code: string }
  | { type: "retry.started"; attempt: number }
  | { type: "stall.warned"; idleMs: number }
  | { type: "stall.detected"; idleMs: number }
  | { type: "goal.round"; round: number; maxRounds: number; goalId: string }
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
  journal?: { path: string; seq: number };
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
  maxOutputTokens?: number;
  recentContextTokens?: number;
  summarizeContext?: (messages: AgentMessage[], signal: AbortSignal) => Promise<ContextSummary>;
  requireFinishTool?: boolean;
  stopOnToolError?: boolean;
  retryDelayMs?: number;
  retryPolicy?: Partial<RetryPolicy>;
  stallPolicy?: { warnMs?: number; abortMs?: number };
  journal?: AgentJournalOptions;
  checkpointPolicy?: { everyTurns?: number; everyToolCalls?: number; maxSnapshots?: number };
  goalRoot?: string;
  maxGoalRounds?: number;
  runId?: string;
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
  path: string;
  fsync?: boolean;
  rotateBytes?: number;
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
