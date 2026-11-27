// Controlled replay of recorded runtime exchanges.
//
// Strict replay executes the real agent loop with a cassette-backed model and
// tool plane: the provider call count is zero and no real tool effect leaves the
// isolated workspace. Any request the cassette cannot answer is a first-class
// divergence instead of a silent live call.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { resolveContextWindowPolicy } from "@hearth/core";
import type { RunRecord, TaskRecord, RunUsage } from "@hearth/core";
import {
  applyCounterfactualOverride,
  cassetteModel,
  cassetteTools,
  createBuiltinTools,
  defaultTaskPermissions,
  deserializeAgentState,
  digestOf,
  modelRequestFingerprint,
  describeModelRequest,
  runAgent,
  sha256Hex,
  toolCatalogDigest,
  type AgentModel,
  type AgentTool,
  type AgentToolResult,
  type AgentModelTurn,
  type CassetteMode,
  type CassetteTraceEntry,
  type CounterfactualOverride,
  type ModelRequestDescriptor,
  type RuntimeEvent
} from "@hearth/agent-runtime";
import type { ModelSettings } from "../model-settings.ts";
import { streamAgentTurn } from "../model-agent.ts";
import type { HearthService } from "../service.ts";
import { loadCassette, CassetteSession, readContentBlob, type LoadedCassette } from "./cassette-store.ts";
import type { EvidenceStore } from "./store.ts";
import { canonicalJson } from "./contracts.ts";

export const DIVERGENCE_CATEGORIES = [
  "none",
  "system_prompt",
  "tool_schema",
  "model",
  "sampling",
  "model_request",
  "tool_arguments",
  "tool_result",
  "missing_step",
  "extra_step",
  "step_order",
  "termination",
  "unknown"
] as const;
export type DivergenceCategory = (typeof DIVERGENCE_CATEGORIES)[number];

export interface FirstDivergence {
  index: number;
  category: DivergenceCategory;
  expected: string | null;
  actual: string | null;
  detail: Record<string, unknown>;
}

export interface DivergenceReport {
  schemaVersion: 1;
  id: string;
  cassetteId: string;
  candidateRunId: string;
  mode: CassetteMode;
  matched: boolean;
  totalRecordedSteps: number;
  totalCandidateSteps: number;
  firstDivergence: FirstDivergence | null;
  categories: Record<string, number>;
  providerCalls: number;
  toolExecutions: number;
  simulatedReceipts: number;
  termination: { recorded: Record<string, unknown> | null; candidate: Record<string, unknown> };
  recordedSteps: Array<{ kind: string; fingerprint: string | null; sequence: number; simulated: boolean }>;
  candidateSteps: CassetteTraceEntry[];
  origin: "replay" | "checkpoint_fork";
  parentRunId: string | null;
  checkpointSeq: number | null;
  /** Copy-paste command that reproduces this replay against the same cassette. */
  reproductionCommand: string;
  generatedAt: string;
}

export interface ReplayInput {
  cassetteId: string;
  mode?: "strict_replay" | "live_on_divergence";
  replacement?: CounterfactualOverride;
  /** Optional settings for live-on-divergence; defaults to the native binding. */
  settings?: ModelSettings | null;
  /** Optional task label used for the isolated workspace/report. */
  taskId?: string | null;
  timeoutMs?: number;
}

export interface ReplayResult {
  report: DivergenceReport;
  run: {
    id: string;
    status: string;
    finalResponse: string;
    usage: RunUsage | null;
    turns: number;
    toolCalls: number;
    failure: unknown;
  };
  workspace: string;
}

function recordedRequestDetail(descriptor: ReturnType<typeof describeModelRequest>): Record<string, unknown> {
  return {
    modelId: descriptor.modelId,
    protocol: descriptor.protocol,
    messageCount: descriptor.messages.length,
    toolCount: descriptor.tools.length,
    systemPromptHash: sha256Hex(descriptor.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n")),
    toolSchemaHash: sha256Hex(canonicalJson([...descriptor.tools].sort((left, right) => left.name.localeCompare(right.name)))),
    sampling: descriptor.sampling
  };
}

interface RecordedStep {
  kind: "model.request" | "tool.call";
  fingerprint: string | null;
  sequence: number;
  detail: Record<string, unknown> | null;
}

function loadRecordedSteps(cassette: LoadedCassette, store: EvidenceStore): RecordedStep[] {
  const steps: RecordedStep[] = [];
  for (const exchange of cassette.exchanges) {
    if (exchange.kind !== "model.request" && exchange.kind !== "tool.call") continue;
    let detail: Record<string, unknown> | null = null;
    const raw = readContentBlob(store.blobRoot, exchange.input.ref);
    if (exchange.kind === "model.request" && raw && typeof raw === "object") {
      detail = recordedRequestDetail(raw as ReturnType<typeof describeModelRequest>);
    } else if (exchange.kind === "tool.call" && raw && typeof raw === "object") {
      detail = raw as Record<string, unknown>;
    }
    steps.push({ kind: exchange.kind, fingerprint: exchange.requestFingerprint, sequence: exchange.sequence, detail });
  }
  return steps;
}

function classifyModelDivergence(recorded: RecordedStep, candidate: CassetteTraceEntry): { category: DivergenceCategory; detail: Record<string, unknown> } {
  const expected = (recorded.detail ?? {}) as Record<string, unknown>;
  const actual = (candidate.detail ?? {}) as Record<string, unknown>;
  if (expected.systemPromptHash && actual.systemPromptHash && expected.systemPromptHash !== actual.systemPromptHash) {
    return { category: "system_prompt", detail: { expected: expected.systemPromptHash, actual: actual.systemPromptHash } };
  }
  if (expected.toolSchemaHash && actual.toolSchemaHash && expected.toolSchemaHash !== actual.toolSchemaHash) {
    return { category: "tool_schema", detail: { expected: expected.toolSchemaHash, actual: actual.toolSchemaHash } };
  }
  if (expected.modelId && actual.modelId && expected.modelId !== actual.modelId) {
    return { category: "model", detail: { expected: expected.modelId, actual: actual.modelId } };
  }
  const expectedSampling = expected.sampling as Record<string, unknown> | undefined;
  const actualSampling = actual.sampling as Record<string, unknown> | undefined;
  if (expectedSampling && actualSampling && canonicalJson(expectedSampling) !== canonicalJson(actualSampling)) {
    return { category: "sampling", detail: { expected: expectedSampling, actual: actualSampling } };
  }
  return { category: "model_request", detail: { expectedCount: expected.messageCount ?? null, actualCount: actual.messageCount ?? null } };
}

export function buildDivergenceReport(input: {
  id: string;
  cassette: LoadedCassette;
  candidateRunId: string;
  mode: CassetteMode;
  recordedSteps: RecordedStep[];
  candidateSteps: CassetteTraceEntry[];
  termination: { recorded: Record<string, unknown> | null; candidate: Record<string, unknown> };
  origin: "replay" | "checkpoint_fork";
  parentRunId: string | null;
  checkpointSeq: number | null;
  now?: Date;
}): DivergenceReport {
  const categories: Record<string, number> = {};
  let firstDivergence: FirstDivergence | null = null;
  const recordedComparable = input.recordedSteps;
  const candidateComparable = input.candidateSteps.filter((entry) => entry.kind === "model.request" || entry.kind === "tool.call");
  const total = Math.max(recordedComparable.length, candidateComparable.length);
  for (let index = 0; index < total; index++) {
    const recorded = recordedComparable[index];
    const candidate = candidateComparable[index];
    if (!recorded || !candidate) {
      const category: DivergenceCategory = recorded ? "missing_step" : "extra_step";
      categories[category] = (categories[category] ?? 0) + 1;
      if (!firstDivergence) {
        firstDivergence = {
          index,
          category,
          expected: recorded?.fingerprint ?? null,
          actual: candidate?.fingerprint ?? null,
          detail: { side: recorded ? "missing_in_candidate" : "extra_in_candidate" }
        };
      }
      continue;
    }
    if (recorded.kind !== candidate.kind) {
      const category: DivergenceCategory = "step_order";
      categories[category] = (categories[category] ?? 0) + 1;
      if (!firstDivergence) {
        firstDivergence = { index, category, expected: recorded.kind, actual: candidate.kind, detail: {} };
      }
      continue;
    }
    if (recorded.fingerprint && recorded.fingerprint === candidate.fingerprint) continue;
    const classified = recorded.kind === "model.request"
      ? classifyModelDivergence(recorded, candidate)
      : { category: "tool_arguments" as DivergenceCategory, detail: { expected: recorded.fingerprint, actual: candidate.fingerprint } };
    categories[classified.category] = (categories[classified.category] ?? 0) + 1;
    if (!firstDivergence) {
      firstDivergence = {
        index,
        category: classified.category,
        expected: recorded.fingerprint,
        actual: candidate.fingerprint,
        detail: classified.detail
      };
    }
  }
  if (!firstDivergence && input.termination.recorded) {
    const recordedStatus = String(input.termination.recorded.status ?? input.termination.recorded.reason ?? "");
    const candidateStatus = String(input.termination.candidate.status ?? input.termination.candidate.reason ?? "");
    if (recordedStatus && candidateStatus && recordedStatus !== candidateStatus) {
      categories.termination = 1;
      firstDivergence = {
        index: total,
        category: "termination",
        expected: recordedStatus,
        actual: candidateStatus,
        detail: {}
      };
    }
  }
  const providerCalls = input.candidateSteps.filter((entry) => entry.kind === "model.request" && !entry.simulated).length;
  const toolExecutions = input.candidateSteps.filter((entry) => entry.kind === "tool.call" && !entry.simulated).length;
  const simulatedReceipts = input.candidateSteps.filter((entry) => entry.kind === "tool.result" && entry.simulated).length;
  return {
    schemaVersion: 1,
    id: input.id,
    cassetteId: input.cassette.metadata.cassetteId,
    candidateRunId: input.candidateRunId,
    mode: input.mode,
    matched: firstDivergence === null,
    totalRecordedSteps: input.recordedSteps.length,
    totalCandidateSteps: input.candidateSteps.length,
    firstDivergence,
    categories,
    providerCalls,
    toolExecutions,
    simulatedReceipts,
    termination: input.termination,
    recordedSteps: input.recordedSteps.map((step) => ({
      kind: step.kind, fingerprint: step.fingerprint, sequence: step.sequence, simulated: false
    })),
    candidateSteps: input.candidateSteps,
    origin: input.origin,
    parentRunId: input.parentRunId,
    checkpointSeq: input.checkpointSeq,
    reproductionCommand: `curl -X POST http://127.0.0.1:4317/api/replay/runs -H "content-type: application/json" -d '${JSON.stringify({
      cassetteId: input.cassette.metadata.cassetteId,
      mode: input.mode
    })}'`,
    generatedAt: (input.now ?? new Date()).toISOString()
  };
}

function liveModel(settings: ModelSettings | null): AgentModel {
  if (!settings) {
    return async () => {
      throw new Error("live_on_divergence 需要可用的模型绑定");
    };
  }
  return async (messages, tools, onDelta, signal) => {
    const result = await streamAgentTurn(settings, messages, tools, onDelta, {
      signal,
      temperature: 0.2,
      maxTokens: settings.maxOutputTokens,
      timeoutMs: 180_000,
      reasoningEffort: settings.reasoningEffort ?? "max"
    });
    return {
      content: result.content,
      toolCalls: result.toolCalls,
      usage: result.usage,
      finishReason: result.finishReason
    } satisfies AgentModelTurn;
  };
}

function recordedRequestAt(cassette: LoadedCassette, store: EvidenceStore, index: number): ModelRequestDescriptor | null {
  const exchanges = cassette.exchanges.filter((item) => item.kind === "model.request");
  const exchange = exchanges[index] ?? exchanges.at(-1);
  if (!exchange) return null;
  const raw = readContentBlob(store.blobRoot, exchange.input.ref);
  return raw && typeof raw === "object" ? raw as ModelRequestDescriptor : null;
}

function preview(value: unknown, limit = 120): string {
  const text = typeof value === "string" ? value : canonicalJson(value ?? null);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function describeRequestMismatch(recorded: ModelRequestDescriptor | null, candidate: ModelRequestDescriptor | null): string {
  if (!recorded || !candidate) return "缺少可比较的请求描述";
  const diffs: string[] = [];
  if (recorded.modelId !== candidate.modelId) diffs.push(`modelId ${preview(recorded.modelId)} != ${preview(candidate.modelId)}`);
  if (recorded.protocol !== candidate.protocol) diffs.push(`protocol ${preview(recorded.protocol)} != ${preview(candidate.protocol)}`);
  if (sha256Hex(canonicalJson(recorded.sampling ?? {})) !== sha256Hex(canonicalJson(candidate.sampling ?? {}))) {
    diffs.push(`sampling ${preview(recorded.sampling ?? {})} != ${preview(candidate.sampling ?? {})}`);
  }
  if (recorded.messages.length !== candidate.messages.length) {
    diffs.push(`messages ${recorded.messages.length} != ${candidate.messages.length} recorded=[${recorded.messages.map((item, index) => `${index}:${item.role}:${item.content.length}`).join(",")}] candidate=[${candidate.messages.map((item, index) => `${index}:${item.role}:${item.content.length}:${preview(item.content, 30)}`).join(",")}]`);
  }
  const limit = Math.min(recorded.messages.length, candidate.messages.length);
  for (let index = 0; index < limit; index += 1) {
    const left = recorded.messages[index];
    const right = candidate.messages[index];
    if (sha256Hex(canonicalJson(left ?? null)) !== sha256Hex(canonicalJson(right ?? null))) {
      diffs.push(`message[${index}] role=${preview(left?.role)}=>${preview(right?.role)} content=${preview(left?.content)}=>${preview(right?.content)}`);
      break;
    }
  }
  if (recorded.tools.length !== candidate.tools.length) diffs.push(`tools ${recorded.tools.length} != ${candidate.tools.length}`);
  const toolLimit = Math.min(recorded.tools.length, candidate.tools.length);
  for (let index = 0; index < toolLimit; index += 1) {
    if (sha256Hex(canonicalJson(recorded.tools[index] ?? null)) !== sha256Hex(canonicalJson(candidate.tools[index] ?? null))) {
      diffs.push(`tool[${index}] ${preview(recorded.tools[index]?.name)} != ${preview(candidate.tools[index]?.name)}`);
      break;
    }
  }
  return diffs.slice(0, 6).join("; ") || "字段一致但组合指纹不同";
}

function prepareWorkspace(dataDir: string, runId: string): { workspace: string; outDir: string } {
  // Run ids intentionally contain ':' for readability; Windows forbids it in
  // path segments, so the on-disk directory uses a filesystem-safe encoding.
  const directory = runId.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
  const workspace = join(dataDir, "evidence", "replay", directory, "workspace");
  const outDir = join(workspace, "out");
  mkdirSync(outDir, { recursive: true });
  return { workspace, outDir };
}

export class ReplayService {
  constructor(
    private readonly service: HearthService,
    private readonly store: EvidenceStore,
    private readonly options: {
      dataDir: string;
      /** Root that relative checkpoint paths in the run ledger are resolved against. */
      workspaceRoot: string;
      settingsForNative: () => ModelSettings | null;
      now?: () => Date;
    }
  ) {}

  async replay(input: ReplayInput): Promise<ReplayResult> {
    const cassette = loadCassette(this.store, input.cassetteId);
    if (!cassette) throw new Error(`cassette 不存在：${input.cassetteId}`);
    const mode: CassetteMode = input.mode ?? "strict_replay";
    const runId = input.taskId ? `replay:${input.taskId}:${randomUUID().slice(0, 8)}` : `replay:${randomUUID().slice(0, 8)}`;
    const { workspace, outDir } = prepareWorkspace(this.options.dataDir, runId);
    const recordedSteps = loadRecordedSteps(cassette, this.store);
    const candidateSteps: CassetteTraceEntry[] = [];
    const candidateRequests: ModelRequestDescriptor[] = [];
    const settings = input.settings ?? this.options.settingsForNative();
    const baseModel = liveModel(settings);
    const recordedCatalog = cassette.metadata.toolCatalog;
    const pureToolNames = ["submit_plan", "todo_write", "todo_read"];
    const liveTools = new Map(createBuiltinTools().map((tool) => [tool.definition.name, tool]));
    const replayTools: AgentTool[] = recordedCatalog.length > 0
      ? recordedCatalog.map((definition) => {
          const pure = pureToolNames.includes(definition.name) ? liveTools.get(definition.name) : null;
          return {
            definition: {
              ...definition,
              executionMode: "sequential" as const
            },
            async execute(input: unknown, context: Parameters<AgentTool["execute"]>[1]): Promise<AgentToolResult> {
              if (pure) return pure.execute(input, context);
              return { content: "严格重放不会执行真实工具。", isError: true };
            }
          } as AgentTool;
        })
      : createBuiltinTools();
    if (recordedCatalog.length === 0) {
      throw new Error("cassette 缺少工具目录，无法严格重放");
    }
    const permissions = defaultTaskPermissions({
      workspaceRoot: workspace,
      outDir,
      networkHosts: [],
      extraTools: replayTools.map((tool) => tool.definition.name)
    });
    permissions.tools = replayTools.map((tool) => tool.definition.name);
    const model = cassetteModel(baseModel, {
      mode,
      runId,
      modelId: cassette.metadata.modelId ?? settings?.model ?? "replay",
      protocol: cassette.metadata.protocol ?? settings?.protocol ?? "openai-chat",
      sampling: cassette.metadata.sampling ?? {
        temperature: 0.2,
        maxTokens: settings?.maxOutputTokens ?? 4096,
        reasoningEffort: settings?.reasoningEffort ?? "max"
      },
      source: cassette.source,
      onRequestDescriptor: (descriptor) => {
        candidateRequests.push(descriptor);
      },
      onExchange: (entry) => candidateSteps.push(entry)
    });
    const tools = cassetteTools(replayTools, {
      mode,
      runId,
      catalogDigest: cassette.metadata.toolCatalogDigest ?? toolCatalogDigest(replayTools),
      pureTools: pureToolNames,
      source: cassette.source,
      onExchange: (entry) => candidateSteps.push(entry),
      onDivergence: () => undefined
    });
    const forkTools = input.replacement
      ? applyCounterfactualOverride(tools, input.replacement).tools
      : tools;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(1_800_000, input.timeoutMs ?? 600_000)));
    const events: RuntimeEvent[] = [];
    let result;
    try {
      result = await runAgent({
        model,
        tools: forkTools,
        goal: cassette.metadata.goal ?? "重放录制运行",
        systemPrompt: cassette.metadata.systemPrompt ?? "",
        budget: { maxTurns: 80, maxToolCalls: 400, maxTokens: 3_000_000, maxDurationMs: 600_000 },
        permissions,
        workspaceRoot: workspace,
        outDir,
        signal: controller.signal,
        onEvent: (event) => events.push(event),
        requireFinishTool: false,
        contextWindowTokens: settings?.contextWindowTokens ?? 128_000,
        compactTriggerTokens: 80_000,
        contextReserveTokens: Math.max(4_000, (settings?.contextWindowTokens ?? 128_000) - resolveContextWindowPolicy(settings ?? { contextWindowTokens: 128_000 }).compactThresholdTokens - 16_000),
        maxOutputTokens: settings?.maxOutputTokens ?? 4096
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("request_fingerprint_mismatch")) {
        const recorded = recordedRequestAt(cassette, this.store, candidateRequests.length - 1);
        const candidate = candidateRequests.at(-1) ?? null;
        throw new Error(`request_fingerprint_mismatch: 候选 Harness 的模型请求与录制不一致 [${describeRequestMismatch(recorded, candidate)}]`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const termination = {
      status: result.status,
      summary: result.summary.slice(0, 2_000),
      turns: result.turns,
      toolCalls: result.toolCalls,
      usage: result.usage,
      failure: result.failure ?? null
    };
    const report = buildDivergenceReport({
      id: `replay-report:${runId}`,
      cassette,
      candidateRunId: runId,
      mode,
      recordedSteps,
      candidateSteps,
      termination: { recorded: cassette.termination, candidate: termination },
      origin: "replay",
      parentRunId: null,
      checkpointSeq: null,
      ...(this.options.now ? { now: this.options.now() } : {})
    });
    this.store.saveReplayReport({
      id: report.id,
      cassetteId: report.cassetteId,
      runId,
      mode,
      matched: report.matched,
      createdAt: report.generatedAt,
      payload: report as unknown as Record<string, unknown>
    });
    return {
      report,
      run: {
        id: runId,
        status: result.status,
        finalResponse: result.summary,
        usage: result.usage,
        turns: result.turns,
        toolCalls: result.toolCalls,
        failure: result.failure ?? null
      },
      workspace
    };
  }

  /**
   * Counterfactual fork: start from a persisted checkpoint and let the changed
   * step run live inside the isolated replay workspace.
   */
  async fork(input: {
    parentRunId: string;
    checkpointSeq?: number;
    replacement?: CounterfactualOverride;
    mode?: "strict_replay" | "live_on_divergence";
    timeoutMs?: number;
  }): Promise<ReplayResult & { forkRunId: string }> {
    const parent = this.service.store.getRun(input.parentRunId);
    if (!parent) throw new Error(`run 不存在：${input.parentRunId}`);
    const task = this.service.store.getTask(parent.taskId);
    if (!task) throw new Error(`task 不存在：${parent.taskId}`);
    const cassetteId = `cassette:${parent.id}`;
    const cassette = loadCassette(this.store, cassetteId);
    if (!cassette) throw new Error(`run 没有可重放的 cassette：${parent.id}`);
    const checkpoints = this.service.listRunCheckpoints(parent.id);
    const selected = input.checkpointSeq !== undefined
      ? checkpoints.find((checkpoint) => checkpoint.seq === input.checkpointSeq)
      : checkpoints.at(-1);
    if (!selected) throw new Error(`run 没有 checkpoint：${parent.id}`);
    const checkpointPath = isAbsolute(selected.path) ? selected.path : join(this.options.workspaceRoot, selected.path);
    if (!existsSync(checkpointPath)) throw new Error(`checkpoint 文件不存在：${checkpointPath}`);
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as {
      messages: Array<unknown>;
      usage?: RunUsage;
      turns?: number;
      toolCalls?: number;
      state?: unknown;
      promptHash?: string;
      toolsDigest?: string;
    };
    const forkRunId = `fork:${parent.id.slice(0, 12)}:${selected.seq}`;
    const forkDirectory = forkRunId.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
    const workspace = join(this.options.dataDir, "evidence", "forks", forkDirectory, "workspace");
    const outDir = join(workspace, "out");
    mkdirSync(outDir, { recursive: true });
    const run: RunRecord = {
      id: forkRunId,
      taskId: parent.taskId,
      attempt: (parent.attempt ?? 1) + 1,
      status: "running",
      threadId: null,
      workspace,
      startedAt: new Date().toISOString(),
      endedAt: null,
      failure: null,
      usage: null,
      leaseEpoch: null,
      createdAt: new Date().toISOString(),
      ...(parent.executorId ? { executorId: parent.executorId } : {}),
      checkpointSeq: selected.seq,
      parentRunId: parent.id
    };
    this.service.createRun(run);
    const recordedSteps = loadRecordedSteps(cassette, this.store);
    const candidateSteps: CassetteTraceEntry[] = [];
    const settings = this.options.settingsForNative();
    const mode = input.mode ?? "live_on_divergence";
    const builtin = createBuiltinTools();
    const permissions = defaultTaskPermissions({ workspaceRoot: workspace, outDir, networkHosts: [], extraTools: builtin.map((tool) => tool.definition.name) });
    permissions.tools = builtin.map((tool) => tool.definition.name);
    const model = cassetteModel(liveModel(settings), {
      mode,
      runId: forkRunId,
      modelId: cassette.metadata.modelId ?? settings?.model ?? "replay",
      protocol: settings?.protocol ?? "openai-chat",
      source: cassette.source,
      onExchange: (entry) => candidateSteps.push(entry)
    });
    const tools = cassetteTools(builtin, {
      mode,
      runId: forkRunId,
      catalogDigest: toolCatalogDigest(builtin),
      source: cassette.source,
      onExchange: (entry) => candidateSteps.push(entry)
    });
    const forkTools = input.replacement ? applyCounterfactualOverride(tools, input.replacement).tools : tools;
    // Checkpoint files persist the serialized form (readFiles as a tuple array).
    // Passing it raw makes post-compaction treat numeric tuple indexes as paths.
    const restoredState = deserializeAgentState(checkpoint.state as never);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(1_800_000, input.timeoutMs ?? 600_000)));
    let result;
    try {
      result = await runAgent({
        model,
        tools: forkTools,
        goal: cassette.metadata.goal ?? "反事实分叉",
        systemPrompt: cassette.metadata.systemPrompt ?? "",
        budget: { maxTurns: 80, maxToolCalls: 400, maxTokens: 3_000_000, maxDurationMs: 600_000 },
        permissions,
        workspaceRoot: workspace,
        outDir,
        signal: controller.signal,
        resume: {
          messages: checkpoint.messages as never,
          usage: checkpoint.usage ?? { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
          turns: checkpoint.turns ?? 0,
          toolCalls: checkpoint.toolCalls ?? 0,
          ...(checkpoint.state ? { state: (restoredState ?? checkpoint.state) as never } : {}),
          ...(checkpoint.promptHash ? { promptHash: checkpoint.promptHash } : {}),
          ...(checkpoint.toolsDigest ? { toolsDigest: checkpoint.toolsDigest } : {})
        },
        requireFinishTool: false,
        contextWindowTokens: settings?.contextWindowTokens ?? 128_000,
        maxOutputTokens: settings?.maxOutputTokens ?? 4096
      });
    } finally {
      clearTimeout(timer);
    }
    this.service.updateRun(forkRunId, parent.taskId, {
      status: result.status === "completed" ? "completed" : result.status === "failed" ? "failed" : result.status === "waiting_input" ? "waiting_input" : "cancelled",
      endedAt: new Date().toISOString(),
      usage: result.usage,
      failure: result.failure
        ? {
            kind: result.failure.code,
            message: result.failure.message,
            recoverable: result.failure.retryable,
            guidance: "",
            code: result.failure.code
          }
        : null
    });
    const termination = {
      status: result.status,
      summary: result.summary.slice(0, 2_000),
      turns: result.turns,
      toolCalls: result.toolCalls,
      usage: result.usage
    };
    const report = buildDivergenceReport({
      id: `replay-report:${forkRunId}`,
      cassette,
      candidateRunId: forkRunId,
      mode,
      recordedSteps,
      candidateSteps,
      termination: { recorded: cassette.termination, candidate: termination },
      origin: "checkpoint_fork",
      parentRunId: parent.id,
      checkpointSeq: selected.seq,
      ...(this.options.now ? { now: this.options.now() } : {})
    });
    this.store.saveReplayReport({
      id: report.id, cassetteId: report.cassetteId, runId: forkRunId, mode, matched: report.matched,
      createdAt: report.generatedAt, payload: report as unknown as Record<string, unknown>
    });
    this.store.saveFork({
      runId: forkRunId,
      parentRunId: parent.id,
      checkpointSeq: selected.seq,
      createdAt: report.generatedAt,
      payload: {
        forkRunId,
        parentRunId: parent.id,
        checkpointSeq: selected.seq,
        replacement: input.replacement ?? null,
        reportId: report.id,
        workspace
      }
    });
    return {
      report,
      run: {
        id: forkRunId,
        status: result.status,
        finalResponse: result.summary,
        usage: result.usage,
        turns: result.turns,
        toolCalls: result.toolCalls,
        failure: result.failure ?? null
      },
      workspace,
      forkRunId
    };
  }

  report(id: string): Record<string, unknown> | null {
    return this.store.getReplayReport(id);
  }
}

/** Ensure a cassette exists for a run before replay/fork is offered. */
export function cassetteAvailable(store: EvidenceStore, runId: string): boolean {
  return store.getCassette(`cassette:${runId}`) !== null;
}

export function cassetteSession(options: ConstructorParameters<typeof CassetteSession>[0]): CassetteSession {
  return new CassetteSession(options);
}

export { digestOf, modelRequestFingerprint };


