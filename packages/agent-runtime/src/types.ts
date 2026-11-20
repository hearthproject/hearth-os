//消息、工具、模型、检查点和运行结果的数据结构

import type { RunBudget, RunUsage, TaskPermissions } from "@hearth/core";

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
}

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
  snapshotId?: string;
  snapshotIds?: string[];
}

export interface AgentToolResult {
  content: string;
  isError?: boolean;
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
  planPath?: string;
  mode?: HarnessMode;
  activeSkills?: string[];
  subagents?: AgentSubagentState[];
}

export interface SerializedAgentToolState {
  workspaceRoot: string;
  readFiles: Array<{ path: string; size: number; mtimeMs: number; hash: string; ranges?: Array<{ start: number; end: number }> }>;
  todos: AgentTodo[];
  progress: AgentProgress;
  startedAt: number;
  snapshots: Array<{ id: string; path: string }>;
  snapshotSeq: number;
  planPath?: string;
  mode?: HarnessMode;
  activeSkills?: string[];
  subagents?: AgentSubagentState[];
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
  | { type: "tool.finished"; turn: number; call: AgentToolCall; result: AgentToolResult; durationMs: number }
  | { type: "tool.batch.started"; turn: number; calls: AgentToolCall[]; parallel: boolean }
  | { type: "tool.batch.finished"; turn: number; calls: AgentToolCall[]; parallel: boolean; durationMs: number }
  | { type: "checkpoint.created"; seq: number; kind: string }
  | { type: "checkpoint.failed"; seq: number; kind: string; message: string }
  | { type: "compacted"; before: number; after: number }
  | { type: "context.watermark"; estimatedTokens: number; usedTokens: number; compactions: number }
  | { type: "progress.updated"; filesRead: number; filesModified: number; commands: number; tests: number; todosOpen?: number }
  | { type: "usage"; usage: RunUsage }
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
}

export interface AgentResumeState {
  messages: AgentMessage[];
  usage: RunUsage;
  turns: number;
  toolCalls: number;
  state?: AgentToolState;
}

export interface AgentRuntimeOptions {
  model: AgentModel;
  tools: AgentTool[];
  goal: string;
  systemPrompt: string;
  budget: RunBudget;
  permissions: TaskPermissions;
  workspaceRoot: string;
  outDir: string;
  signal?: AbortSignal;
  resume?: AgentResumeState;
  onEvent?: (event: RuntimeEvent) => void;
  onCheckpoint?: (checkpoint: AgentCheckpoint) => void | Promise<void>;
  authorizeTool?: (request: AgentToolAuthorizationRequest) => Promise<AgentToolAuthorization>;
  validateFinish?: (result: AgentToolResult, context: AgentToolContext) => string | null | Promise<string | null>;
  isFullPermission?: () => boolean;
  contextWindowTokens?: number;
  contextReserveTokens?: number;
  recentContextTokens?: number;
  summarizeContext?: (messages: AgentMessage[], signal: AbortSignal) => Promise<ContextSummary>;
  requireFinishTool?: boolean;
  stopOnToolError?: boolean;
  retryDelayMs?: number;
  profile?: HarnessProfile;
  mode?: HarnessMode;
  state?: AgentToolState;
  steering?: () => AgentMessage[];
  toolTimeoutMs?: number;
  maxParallelTools?: number;
  keepRecentToolOutputs?: number;
  projectInstructions?: string;
  reminders?: AgentRuntimeReminders;
}

export interface AgentRuntimeReminders {
  emptyTurn?: string;
  missingFinish?: string;
  repeated?: string;
}

export type AgentRunStatus = "completed" | "waiting_input" | "failed" | "cancelled" | "budget_exceeded";

export interface AgentRunResult {
  status: AgentRunStatus;
  summary: string;
  messages: AgentMessage[];
  usage: RunUsage;
  turns: number;
  toolCalls: number;
  outputs: string[];
  question: string | null;
}

export interface CompactOptions {
  keepRecent?: number;
  maxChars?: number;
  maxToolChars?: number;
  keepRecentToolOutputs?: number;
  contextWindowTokens?: number;
  reserveTokens?: number;
  recentTokens?: number;
  stateSummary?: string;
  projectInstructions?: string;
  restoredContext?: string;
  signal?: AbortSignal;
}
