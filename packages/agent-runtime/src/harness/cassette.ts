// Runtime cassette: record and replay model/tool exchanges without a parallel agent loop.
//
// The wrappers below sit on the exact seams the runtime already uses
// (`AgentModel` and `AgentTool`), so a replay run is executed by the real
// runtime with a deterministic provider/tool plane. Nothing here knows about
// SQLite, HTTP or the scheduler.
import { createHash } from "node:crypto";
import type { RunUsage } from "@hearth/core";
import type {
  AgentMessage,
  AgentModel,
  AgentModelTurn,
  AgentTool,
  AgentToolContext,
  AgentToolDefinition,
  AgentToolResult,
  AgentUsage
} from "../types.ts";

export const CASSETTE_SCHEMA_VERSION = 1 as const;

export const EXCHANGE_KINDS = [
  "model.request",
  "model.response",
  "tool.call",
  "tool.result",
  "approval.decision",
  "context.candidates",
  "context.selected",
  "environment.snapshot",
  "checkpoint",
  "termination"
] as const;
export type ExchangeKind = (typeof EXCHANGE_KINDS)[number];

export type CassetteMode = "record" | "strict_replay" | "live_on_divergence";

export interface ContentDescriptor {
  /** Content-addressed blob reference (`sha256:...`). */
  ref: string;
  sha256: string;
  bytes: number;
  /** Redacted, short human summary; never the whole secret payload. */
  summary: string | null;
}

export interface RuntimeExchange {
  schemaVersion: typeof CASSETTE_SCHEMA_VERSION;
  id: string;
  runId: string;
  parentId: string | null;
  kind: ExchangeKind;
  sequence: number;
  stepId: string | null;
  requestFingerprint: string | null;
  environmentDigest: string | null;
  input: ContentDescriptor;
  output: ContentDescriptor;
  latencyMs: number | null;
  usage: RunUsage | null;
  sideEffectReceipt: unknown;
  simulated: boolean;
  createdAt: string;
}

export interface ExchangeDraft {
  kind: ExchangeKind;
  stepId?: string | null;
  requestFingerprint?: string | null;
  environmentDigest?: string | null;
  input: unknown;
  output: unknown;
  latencyMs?: number | null;
  usage?: RunUsage | null;
  sideEffectReceipt?: unknown;
  simulated?: boolean;
  parentId?: string | null;
}

/** Host-owned sink. Server mode persists content-addressed blobs plus an index. */
export interface CassetteSink {
  readonly runId: string;
  record(draft: ExchangeDraft, exchange?: RuntimeExchange): void | Promise<void>;
  /** Optional flush hook used before a replay report is generated. */
  flush?(): void | Promise<void>;
}

export interface ReplayedModelTurn {
  turn: AgentModelTurn;
  fingerprint: string;
  simulated: boolean;
}

export interface ReplayedToolResult {
  result: AgentToolResult;
  fingerprint: string;
  simulated: boolean;
}

/** Read side of a cassette, indexed by canonical request fingerprints. */
export interface CassetteSource {
  readonly cassetteId: string;
  readonly metadata: CassetteMetadata;
  findModelResponse(fingerprint: string): ReplayedModelTurn | null;
  /** Ordinal disambiguates identical calls inside one run. */
  findToolResult(fingerprint: string, ordinal: number): ReplayedToolResult | null;
}

export interface CassetteMetadata {
  cassetteId: string;
  runId: string;
  taskId: string | null;
  createdAt: string;
  modelId: string | null;
  protocol: string | null;
  /** Sampling parameters the recorded model call used; replay must reuse them. */
  sampling: SamplingDescriptor | null;
  environmentDigest: string;
  /** Tool catalogue the model saw, captured from the first model request. */
  toolCatalog: AgentToolDefinition[];
  /** Digest of the recorded live tool implementations (includes effects). */
  toolCatalogDigest: string | null;
  systemPrompt: string | null;
  goal: string | null;
  exchangeCount: number;
  kinds: Partial<Record<ExchangeKind, number>>;
  manifestFingerprint: string | null;
  termination: Record<string, unknown> | null;
}

export type CassetteMismatchCategory =
  | "model_request"
  | "model_response"
  | "tool_catalog"
  | "tool_arguments"
  | "tool_result"
  | "unknown";

export class CassetteMismatchError extends Error {
  readonly category: CassetteMismatchCategory;
  readonly fingerprint: string;
  readonly detail: Record<string, unknown>;

  constructor(category: CassetteMismatchCategory, fingerprint: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "CassetteMismatchError";
    this.category = category;
    this.fingerprint = fingerprint;
    this.detail = detail;
  }
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Deterministic JSON: object keys sorted, `undefined` dropped, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown, seen: Set<unknown> = new Set()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) continue;
    output[key] = canonicalize(item, seen);
  }
  return output;
}

export function digestOf(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

export interface SamplingDescriptor {
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
  seed?: number;
  toolChoice?: string;
}

function toRequestMessage(message: AgentMessage): {
  role: string;
  content: string;
  name?: string;
  toolCalls?: Array<{ name: string; arguments: unknown }>;
} {
  if (message.role === "tool") {
    return { role: "tool", content: message.content, name: message.name };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      ...(message.toolCalls.length > 0
        ? { toolCalls: message.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })) }
        : {})
    };
  }
  return { role: message.role, content: message.content };
}

function normalizeUsage(usage: AgentUsage | null | undefined): RunUsage | null {
  if (!usage) return null;
  return {
    inputTokens: usage.inputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    reasoningOutputTokens: usage.reasoningOutputTokens ?? 0,
    ...(usage.turns === undefined ? {} : { turns: usage.turns }),
    ...(usage.toolCalls === undefined ? {} : { toolCalls: usage.toolCalls })
  };
}

/** Normalized shape of one model request that must stay stable across harnesses. */
export interface ModelRequestDescriptor {
  modelId: string;
  protocol: string;
  messages: Array<{
    role: string;
    content: string;
    name: string | null;
    toolCalls: Array<{ name: string; arguments: unknown }> | null;
  }>;
  tools: Array<{ name: string; description: string; parameters: unknown }>;
  sampling: SamplingDescriptor;
}

export function describeModelRequest(input: {
  modelId: string;
  protocol: string;
  messages: Array<{ role: string; content: string; name?: string; toolCalls?: Array<{ name: string; arguments: unknown }> }>;
  tools: AgentToolDefinition[];
  sampling?: SamplingDescriptor;
}): ModelRequestDescriptor {  return {
    modelId: input.modelId,
    protocol: input.protocol,
    messages: input.messages.map((message) => ({
      role: message.role,
      content: message.content,
      name: message.name ?? null,
      toolCalls: message.toolCalls
        ? message.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments }))
        : null
    })),
    tools: input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    })),
    sampling: input.sampling ?? {}
  };
}

export function modelRequestFingerprint(descriptor: ModelRequestDescriptor): string {
  return sha256Hex(canonicalJson(descriptor));
}

export function toolCallFingerprint(toolName: string, args: unknown, toolCatalogDigest?: string): string {
  return sha256Hex(canonicalJson({
    toolName,
    args,
    ...(toolCatalogDigest ? { toolCatalogDigest } : {})
  }));
}

export function toolCatalogDigest(tools: Array<{ definition: AgentToolDefinition }>): string {
  return sha256Hex(canonicalJson(tools.map((tool) => ({
    name: tool.definition.name,
    description: tool.definition.description,
    parameters: tool.definition.parameters,
    effect: tool.definition.effect ?? null
  })).sort((left, right) => left.name.localeCompare(right.name))));
}

/** Short, redacted summary for evidence UIs; never stores whole payloads. */
export function summarizeValue(value: unknown, limit = 240): string {
  const text = typeof value === "string" ? value : canonicalJson(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export function describeContent(value: unknown): ContentDescriptor {
  const serialized = typeof value === "string" ? value : `${canonicalJson(value)}`;
  const bytes = Buffer.byteLength(serialized, "utf8");
  const sha256 = sha256Hex(serialized);
  return {
    ref: `sha256:${sha256}`,
    sha256,
    bytes,
    summary: summarizeValue(value)
  };
}

interface ExchangeLedgerState {
  sequence: number;
  lastId: string | null;
}

export class ExchangeRecorder {
  private readonly state: ExchangeLedgerState = { sequence: 0, lastId: null };

  constructor(
    private readonly sink: CassetteSink,
    private readonly environmentDigest: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  async record(draft: ExchangeDraft): Promise<RuntimeExchange> {
    const sequence = this.state.sequence + 1;
    this.state.sequence = sequence;
    const id = `${this.sink.runId}:x${sequence}`;
    const exchange: RuntimeExchange = {
      schemaVersion: CASSETTE_SCHEMA_VERSION,
      id,
      runId: this.sink.runId,
      parentId: draft.parentId ?? this.state.lastId,
      kind: draft.kind,
      sequence,
      stepId: draft.stepId ?? null,
      requestFingerprint: draft.requestFingerprint ?? null,
      environmentDigest: draft.environmentDigest ?? this.environmentDigest,
      input: describeContent(draft.input),
      output: describeContent(draft.output),
      latencyMs: draft.latencyMs ?? null,
      usage: draft.usage ?? null,
      sideEffectReceipt: draft.sideEffectReceipt ?? null,
      simulated: draft.simulated ?? false,
      createdAt: this.now().toISOString()
    };
    this.state.lastId = id;
    await this.sink.record({ ...draft, parentId: exchange.parentId }, exchange);
    return exchange;
  }
}

export interface CassetteTraceEntry {
  kind: "model.request" | "model.response" | "tool.call" | "tool.result";
  fingerprint: string;
  simulated: boolean;
  detail?: Record<string, unknown>;
}

function systemPromptDigest(messages: Array<{ role: string; content: string }>): string {
  return sha256Hex(messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n"));
}

function requestDetail(options: CassetteModelOptions, descriptor: ModelRequestDescriptor): Record<string, unknown> {
  return {
    modelId: options.modelId,
    protocol: options.protocol,
    messageCount: descriptor.messages.length,
    toolCount: descriptor.tools.length,
    systemPromptHash: systemPromptDigest(descriptor.messages),
    toolSchemaHash: sha256Hex(canonicalJson([...descriptor.tools].sort((left, right) => left.name.localeCompare(right.name))))
  };
}

export interface CassetteModelOptions {
  mode: CassetteMode;
  runId: string;
  modelId: string;
  protocol: string;
  sampling?: SamplingDescriptor;
  recorder?: ExchangeRecorder;
  source?: CassetteSource;
  /** Called when live-on-divergence leaves the recorded path. */
  onDivergence?: (info: { category: CassetteMismatchCategory; fingerprint: string; detail: Record<string, unknown> }) => void;
  /** Called for every candidate request, including requests the cassette misses. */
  onRequestDescriptor?: (descriptor: ModelRequestDescriptor, fingerprint: string) => void;
  onExchange?: (entry: CassetteTraceEntry) => void;
}

/**
 * Wraps an `AgentModel`.
 *
 * - record: always calls the live model and records request/response.
 * - strict_replay: never calls the live model; a missing fingerprint throws
 *   `request_fingerprint_mismatch` instead of silently reusing an old answer.
 * - live_on_divergence: replays when possible, otherwise calls live and reports
 *   the divergence so the caller can label the run as exploratory.
 */
export function cassetteModel(base: AgentModel, options: CassetteModelOptions): AgentModel {
  return async (messages, tools, onDelta, signal) => {
    const descriptor = describeModelRequest({
      modelId: options.modelId,
      protocol: options.protocol,
      messages: messages.map(toRequestMessage),
      tools,
      ...(options.sampling ? { sampling: options.sampling } : {})
    });
    const fingerprint = modelRequestFingerprint(descriptor);
    options.onRequestDescriptor?.(descriptor, fingerprint);

    if (options.mode !== "record") {
      const replayed = options.source?.findModelResponse(fingerprint) ?? null;
      if (replayed) {
        options.onExchange?.({
          kind: "model.request",
          fingerprint,
          simulated: true,
          detail: requestDetail(options, descriptor)
        });
        options.onExchange?.({ kind: "model.response", fingerprint, simulated: true, detail: { replayed: true } });
        if (replayed.turn.content) onDelta(replayed.turn.content);
        return { ...replayed.turn, usage: replayed.turn.usage };
      }
      if (options.mode === "strict_replay") {
        throw new CassetteMismatchError(
          "model_request",
          fingerprint,
          "request_fingerprint_mismatch: 候选 Harness 的模型请求与录制不一致，拒绝复用旧响应",
          { modelId: options.modelId, messageCount: descriptor.messages.length, toolCount: descriptor.tools.length }
        );
      }
      options.onDivergence?.({ category: "model_request", fingerprint, detail: { modelId: options.modelId } });
    }

    const startedAt = Date.now();
    options.onExchange?.({ kind: "model.request", fingerprint, simulated: false, detail: requestDetail(options, descriptor) });
    await options.recorder?.record({
      kind: "model.request",
      requestFingerprint: fingerprint,
      input: descriptor,
      output: { status: "sent" }
    });
    const turn = await base(messages, tools, onDelta, signal);
    options.onExchange?.({ kind: "model.response", fingerprint, simulated: false });
    await options.recorder?.record({
      kind: "model.response",
      requestFingerprint: fingerprint,
      input: { requestFingerprint: fingerprint },
      output: { content: turn.content, toolCalls: turn.toolCalls, finishReason: turn.finishReason },
      latencyMs: Date.now() - startedAt,
      usage: normalizeUsage(turn.usage)
    });
    return turn;
  };
}

export interface CassetteToolOptions {
  mode: CassetteMode;
  runId: string;
  recorder?: ExchangeRecorder;
  source?: CassetteSource;
  catalogDigest?: string;
  /**
   * Pure state-mutating tools (plan/todo) that must really execute during
   * replay so the harness state evolves like the recording. Their live result
   * is compared with the recorded result; any drift is a divergence.
   */
  pureTools?: string[];
  onDivergence?: (info: { category: CassetteMismatchCategory; fingerprint: string; detail: Record<string, unknown> }) => void;
  /** Called for every tool call so the host can isolate side effects or simulate receipts. */
  onCall?: (info: { toolName: string; fingerprint: string; ordinal: number }) => void;
  onExchange?: (entry: CassetteTraceEntry) => void;
}

/**
 * Wraps tools with a cassette gateway.
 *
 * Strict replay returns recorded results and never executes the real tool; a
 * missing call is a `tool_arguments` / `tool_result` mismatch, not a silent
 * live execution. Recording mode executes normally and records both sides.
 */
export function cassetteTools(tools: AgentTool[], options: CassetteToolOptions): AgentTool[] {
  const ordinals = new Map<string, number>();
  return tools.map((tool) => ({
    definition: tool.definition,
    async execute(input: unknown, context: AgentToolContext): Promise<AgentToolResult> {
      const fingerprint = toolCallFingerprint(tool.definition.name, input, options.catalogDigest);
      const ordinal = ordinals.get(fingerprint) ?? 0;
      ordinals.set(fingerprint, ordinal + 1);
      options.onCall?.({ toolName: tool.definition.name, fingerprint, ordinal });

      if (options.mode !== "record") {
        const replayed = options.source?.findToolResult(fingerprint, ordinal) ?? null;
        if (replayed) {
          options.onExchange?.({ kind: "tool.call", fingerprint, simulated: true, detail: { toolName: tool.definition.name, ordinal } });
          if (options.pureTools?.includes(tool.definition.name)) {
            const live = await tool.execute(input, context);
            if (canonicalJson(live) !== canonicalJson(replayed.result)) {
              throw new CassetteMismatchError(
                "tool_result",
                fingerprint,
                "tool_result_mismatch: 纯状态工具在重放中产生了与录制不同的结果",
                { toolName: tool.definition.name, ordinal }
              );
            }
            options.onExchange?.({ kind: "tool.result", fingerprint, simulated: true, detail: { toolName: tool.definition.name, ordinal, pure: true } });
            return live;
          }
          options.onExchange?.({ kind: "tool.result", fingerprint, simulated: true, detail: { toolName: tool.definition.name, ordinal } });
          return replayed.result;
        }
        if (options.mode === "strict_replay") {
          throw new CassetteMismatchError(
            "tool_arguments",
            fingerprint,
            "tool_cassette_miss: 候选 Harness 请求的工具调用没有录制结果，Strict Replay 拒绝真实执行",
            { toolName: tool.definition.name, ordinal }
          );
        }
        options.onDivergence?.({ category: "tool_arguments", fingerprint, detail: { toolName: tool.definition.name, ordinal } });
      }

      const startedAt = Date.now();
      options.onExchange?.({ kind: "tool.call", fingerprint, simulated: false, detail: { toolName: tool.definition.name, ordinal } });
      await options.recorder?.record({
        kind: "tool.call",
        requestFingerprint: fingerprint,
        input: { toolName: tool.definition.name, arguments: input, ordinal },
        output: { status: "dispatched", effect: tool.definition.effect ?? null }
      });
      let result: AgentToolResult;
      try {
        result = await tool.execute(input, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await options.recorder?.record({
          kind: "tool.result",
          requestFingerprint: fingerprint,
          input: { toolName: tool.definition.name, ordinal },
          output: { error: message },
          latencyMs: Date.now() - startedAt,
          sideEffectReceipt: { simulated: false, error: message }
        });
        throw error;
      }
      options.onExchange?.({ kind: "tool.result", fingerprint, simulated: false, detail: { toolName: tool.definition.name, ordinal } });
      await options.recorder?.record({
        kind: "tool.result",
        requestFingerprint: fingerprint,
        input: { toolName: tool.definition.name, ordinal },
        output: result,
        latencyMs: Date.now() - startedAt,
        sideEffectReceipt: { simulated: false, effect: tool.definition.effect ?? null, isError: result.isError ?? false }
      });
      return result;
    }
  }));
}

/** In-memory source used by tests and by the replay service after loading blobs. */
export class MemoryCassetteSource implements CassetteSource {
  private readonly models = new Map<string, ReplayedModelTurn>();
  private readonly tools = new Map<string, ReplayedToolResult>();

  constructor(
    readonly cassetteId: string,
    readonly metadata: CassetteMetadata,
    private readonly toolOrdinals = new Map<string, number>()
  ) {}

  addModel(fingerprint: string, turn: AgentModelTurn): void {
    this.models.set(fingerprint, { turn, fingerprint, simulated: true });
  }

  addTool(fingerprint: string, result: AgentToolResult, ordinal = 0): void {
    this.tools.set(`${fingerprint}#${ordinal}`, { result, fingerprint, simulated: true });
  }

  findModelResponse(fingerprint: string): ReplayedModelTurn | null {
    return this.models.get(fingerprint) ?? null;
  }

  findToolResult(fingerprint: string, ordinal: number): ReplayedToolResult | null {
    return this.tools.get(`${fingerprint}#${ordinal}`) ?? null;
  }

  nextToolOrdinal(fingerprint: string): number {
    const current = this.toolOrdinals.get(fingerprint) ?? 0;
    this.toolOrdinals.set(fingerprint, current + 1);
    return current;
  }
}

/** Applies a single-step override before a counterfactual fork continues live. */
export interface CounterfactualOverride {
  /** Match the ordinal-th call of this tool and replace its arguments. */
  toolName: string;
  ordinal?: number;
  arguments: unknown;
  /** Replacement tool name; defaults to the same tool. */
  replaceWith?: string;
}

export function applyCounterfactualOverride(
  tools: AgentTool[],
  override: CounterfactualOverride
): { tools: AgentTool[]; applied: () => boolean; markApplied: () => void } {
  let seen = 0;
  let applied = false;
  const matched = tools.map((tool) => {
    if (tool.definition.name !== override.toolName && tool.definition.name !== override.replaceWith) return tool;
    if (tool.definition.name !== override.toolName) return tool;
    return {
      definition: tool.definition,
      async execute(input: unknown, context: AgentToolContext): Promise<AgentToolResult> {
        const ordinal = seen;
        seen += 1;
        if (!applied && ordinal === (override.ordinal ?? 0)) {
          applied = true;
          const replacement = override.replaceWith
            ? tools.find((candidate) => candidate.definition.name === override.replaceWith)
            : tool;
          if (!replacement) throw new Error(`反事实替换的工具不存在：${override.replaceWith}`);
          return replacement.execute(override.arguments, context);
        }
        return tool.execute(input, context);
      }
    } satisfies AgentTool;
  });
  return { tools: matched, applied: () => applied, markApplied: () => { applied = true; } };
}
