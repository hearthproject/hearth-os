// Deterministic model/tool fixtures for long-running runtime tests.
// No network, no API key, no real provider.

import type {
  AgentMessage,
  AgentModel,
  AgentModelTurn,
  AgentToolCall,
  AgentToolDefinition,
  AgentUsage
} from "../types.ts";

export interface FakeModelStep {
  content?: string;
  toolCalls?: AgentToolCall[];
  usage?: AgentUsage | null;
  finishReason?: string | null;
  /** Throw this error instead of returning a turn. */
  error?: Error;
}

export interface FakeModelRequest {
  index: number;
  messages: AgentMessage[];
  tools: AgentToolDefinition[];
}

export interface FakeModelState {
  calls: number;
  requests: FakeModelRequest[];
}

export interface FakeModel {
  model: AgentModel;
  state: FakeModelState;
}

export function fakeToolCall(name: string, args: Record<string, unknown> = {}, id?: string): AgentToolCall {
  const rawArguments = JSON.stringify(args);
  return {
    id: id ?? `fake-${name}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    arguments: args,
    rawArguments
  };
}

export function fakeUsage(inputTokens: number, outputTokens: number, extra: Partial<AgentUsage> = {}): AgentUsage {
  return { inputTokens, outputTokens, ...extra };
}

/**
 * Returns a model that plays the given steps in order. Once the script is
 * exhausted it repeats the last step, which keeps long-run fixtures short.
 */
export function createFakeModel(steps: FakeModelStep[], fallback?: FakeModelStep): FakeModel {
  const state: FakeModelState = { calls: 0, requests: [] };
  const last = fallback ?? steps.at(-1) ?? { content: "", toolCalls: [], usage: null, finishReason: "stop" };

  const model: AgentModel = async (messages, tools, onDelta) => {
    const index = state.calls;
    state.calls += 1;
    state.requests.push({ index, messages: structuredClone(messages), tools: structuredClone(tools) });
    const step = steps[index] ?? last;
    if (step.error) throw step.error;
    if (onDelta && step.content) onDelta(step.content);
    const turn: AgentModelTurn = {
      content: step.content ?? "",
      toolCalls: step.toolCalls ?? [],
      usage: step.usage ?? null,
      finishReason: step.finishReason ?? ((step.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "stop")
    };
    return turn;
  };

  return { model, state };
}
