import type { RunBudget, RunUsage, TaskPermissions } from "@hearth/core";

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
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

export interface AgentModelTurn {
  content: string;
  toolCalls: AgentToolCall[];
  usage: Pick<RunUsage, "inputTokens" | "outputTokens"> | null;
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
}

export type AgentToolAction = "finish" | "ask_user";

export interface AgentToolResult {
  content: string;
  isError?: boolean;
  action?: AgentToolAction;
  summary?: string;
  outputs?: string[];
  question?: string;
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
  | { type: "checkpoint.created"; seq: number; kind: string }
  | { type: "checkpoint.failed"; seq: number; kind: string; message: string }
  | { type: "compacted"; before: number; after: number }
  | { type: "usage"; usage: RunUsage }
  | { type: "budget.exceeded"; budget: "turns" | "toolCalls" | "tokens" | "duration"; limit: number }
  | { type: "notice"; message: string };

export interface AgentCheckpoint {
  seq: number;
  kind: "turn" | "tool" | "final" | "budget" | "waiting_input";
  messages: AgentMessage[];
  usage: RunUsage;
  turns: number;
  toolCalls: number;
  summary: string | null;
}

export interface AgentResumeState {
  messages: AgentMessage[];
  usage: RunUsage;
  turns: number;
  toolCalls: number;
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
}
