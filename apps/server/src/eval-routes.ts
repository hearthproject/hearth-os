import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { defaultTaskPermissions } from "@hearth/agent-runtime";
import { APPROVAL_MODES, EXECUTOR_IDS, TASK_KINDS, type EffectRecord, type TaskRecord } from "@hearth/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApprovalError, type ApprovalManager } from "./approvals.ts";
import { OutboxError, type OutboxService } from "./outbox.ts";
import { ReconcileError, type ReconcileService } from "./reconcile.ts";
import type { ModelSettings } from "./model-settings.ts";
import { chatModelConfigured } from "./model-settings.ts";
import { completeChat, type ChatMessage, type CompleteOptions } from "./model-client.ts";
import type { HearthService } from "./service.ts";
import type { HearthStore } from "@hearth/eventlog";

const evalInputSchema = z.object({
  kind: z.enum(["file", "url"]),
  label: z.string().trim().min(1).max(200),
  value: z.string().trim().min(1).max(4_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional()
}).strict();

const evalTaskSchema = z.object({
  externalRef: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1).max(8_000),
  inputs: z.array(evalInputSchema).max(20),
  expectedOutputs: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  executorId: z.enum(EXECUTOR_IDS).optional(),
  runMode: z.enum(["offline", "live"]),
  taskKind: z.enum(TASK_KINDS).optional(),
  approvalMode: z.enum(APPROVAL_MODES).optional(),
  allowExternalEffects: z.boolean().optional(),
  networkHosts: z.array(z.string().trim().min(1).max(255)).max(30).optional(),
  outputDir: z.string().trim().min(1).max(1_000),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).optional()
}).strict();

const judgeSchema = z.object({
  taskId: z.string().trim().min(1).max(200),
  criteria: z.array(z.object({
    id: z.string().trim().min(1).max(100),
    label: z.string().trim().min(1).max(300),
    rubric: z.string().trim().min(1).max(4_000),
    points: z.number().min(0).max(100)
  }).strict()).min(1).max(20),
  deterministic: z.array(z.object({
    criterionId: z.string().trim().min(1).max(100),
    passed: z.boolean(),
    reason: z.string().max(2_000)
  }).strict()).max(40),
  locale: z.string().trim().min(1).max(40).optional()
}).strict();

const traceQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).max(9_000_000_000).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
}).strict();

const TRACE_DEFAULT_LIMIT = 500;
const inflightOperations = new Set<string>();

const operatorSchema = z.object({
  operationId: z.string().trim().min(1).max(200),
  action: z.enum([
    "approval.decide",
    "outbox.submit",
    "outbox.retry",
    "effect.assert",
    "reconcile.mark_uncertain",
    "reconcile.check",
    "reconcile.resolve",
    "checkpoint.restore"
  ]),
  targetId: z.string().trim().min(1).max(200).optional(),
  decision: z.enum(["approve", "reject"]).optional(),
  parameterHash: z.string().trim().min(1).max(200).optional(),
  resolution: z.enum(["committed", "absent", "abandoned"]).optional(),
  note: z.string().max(2_000).optional(),
  expectedStatus: z.string().trim().min(1).max(100).optional()
}).strict();

interface EvalOperatorDeps {
  approvals: ApprovalManager;
  outbox: OutboxService;
  reconcile: ReconcileService;
  scheduler?: { retry(taskId: string, input?: string): TaskRecord };
  schedules?: { runNow(scheduleId: string): unknown };
}

class EvalOperatorError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "EvalOperatorError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

interface EvalRouteOptions {
  service: HearthService;
  store: HearthStore;
  settings: () => ModelSettings | null;
  repoRoot: string;
  evalInputRoot?: string;
  complete?: typeof completeChat;
  operator?: EvalOperatorDeps;
  operatorEnabled?: boolean;
}

interface JudgeRequest {
  taskId: string;
  criteria: Array<{ id: string; label: string; rubric: string; points: number }>;
  deterministic: Array<{ criterionId: string; passed: boolean; reason: string }>;
  locale?: string;
}

interface JudgeResponse {
  model: string;
  promptHash: string;
  criteria: Array<{ id: string; passed: boolean; confidence: number; reason: string; evidence: string[] }>;
  overallConfidence: number;
  usage: { inputTokens: number; outputTokens: number };
  diagnostics: Record<string, unknown>;
}

export function registerEvalRoutes(app: FastifyInstance, options: EvalRouteOptions): void {
  const { service, store, repoRoot } = options;
  const complete = options.complete ?? completeChat;
  const evalInputRoot = resolve(options.evalInputRoot ?? process.env.HEARTH_EVAL_INPUT_ROOT ?? resolve(repoRoot, "eval"));
  const outputRoot = resolve(repoRoot, ".hearth", "eval-artifacts");
  const operatorEnabled = options.operatorEnabled ?? process.env.HEARTH_EVAL_MODE === "1";

  app.post("/api/eval/tasks", async (request, reply) => {
    const parsed = evalTaskSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_EVAL_TASK",
        message: "评测任务参数不正确",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    let body: z.infer<typeof evalTaskSchema>;
    try {
      body = {
        ...parsed.data,
        inputs: parsed.data.inputs.map((input) => input.kind === "file"
          ? { ...input, value: normalizeEvalInput(evalInputRoot, input.value) }
          : input
        ),
        expectedOutputs: parsed.data.expectedOutputs.map(validateRelativeOutput),
        outputDir: normalizeEvalOutput(repoRoot, outputRoot, parsed.data.outputDir),
        networkHosts: parsed.data.runMode === "offline" ? [] : parsed.data.networkHosts ?? []
      };
    } catch (error) {
      return reply.code(400).send({ error: "UNSAFE_EVAL_PATH", message: errorMessage(error) });
    }
    if (body.runMode === "offline" && body.inputs.some((input) => input.kind === "url")) {
      return reply.code(400).send({ error: "OFFLINE_NETWORK_FORBIDDEN", message: "离线评测不允许 URL 输入" });
    }
    const requestHash = hashEvalTask(body);
    const existing = store.getTaskByExternalRef(body.externalRef);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return reply.code(409).send({ error: "EVAL_REQUEST_CONFLICT", message: "同一 externalRef 已用于不同请求" });
      }
      return reply.code(200).send({ task: existing, created: false });
    }
    const networkHosts = [...body.networkHosts ?? []];
    for (const input of body.inputs) {
      if (input.kind !== "url") continue;
      try {
        const host = new URL(input.value).hostname;
        if (host && !networkHosts.includes(host)) networkHosts.push(host);
      } catch {
        return reply.code(400).send({ error: "INVALID_EVAL_URL", message: `无法解析评测 URL：${input.value}` });
      }
    }
    let task: TaskRecord;
    try {
      const outputDir = resolve(repoRoot, body.outputDir);
      const permissions = defaultTaskPermissions({
        workspaceRoot: evalInputRoot,
        outDir: outputDir,
        networkHosts
      });
      task = service.createTask({
        externalRef: body.externalRef,
        requestHash,
        title: body.title,
        goal: `${body.goal}\n\n评测运行约束：${body.runMode === "offline" ? "不得访问网络。" : "只允许访问声明的网络主机。"}只将产物写入 ${body.outputDir}，${body.allowExternalEffects ? "允许产生经审批的外部效果，且仅限评测专用账号与目标。" : "不得产生外部副作用。"}`,
        inputs: body.inputs.map((input) => ({ kind: input.kind, label: input.label, value: input.value, ...(input.sha256 ? { sha256: input.sha256 } : {}) })),
        networkHosts,
        ...(body.executorId ? { executorId: body.executorId } : {}),
        taskKind: body.taskKind ?? "delivery",
        expectedOutputs: body.expectedOutputs,
        outputDir: body.outputDir,
        permissions: {
          ...permissions,
          readRoots: [evalInputRoot],
          writeRoots: [outputDir],
          approvalMode: body.approvalMode ?? "full"
        }
      });
    } catch (error) {
      const raced = store.getTaskByExternalRef(body.externalRef);
      if (raced) {
        if (raced.requestHash !== requestHash) {
          return reply.code(409).send({ error: "EVAL_REQUEST_CONFLICT", message: "同一 externalRef 已用于不同请求" });
        }
        return reply.code(200).send({ task: raced, created: false });
      }
      throw error;
    }
    return reply.code(201).send({ task, created: true });
  });

  app.post<{ Params: { id: string } }>("/api/eval/tasks/:id/operator", async (request, reply) => {
    if (!operatorEnabled) {
      return reply.code(403).send({ error: "EVAL_OPERATOR_DISABLED", message: "未开启评测操作模式" });
    }
    const deps = options.operator;
    if (!deps) {
      return reply.code(503).send({ error: "EVAL_OPERATOR_UNAVAILABLE", message: "评测操作服务未装配" });
    }
    const parsed = operatorSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_EVAL_OPERATION",
        message: "评测操作参数不正确",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    const task = store.getTask(request.params.id);
    if (!task) return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "评测任务不存在" });
    if (!isEvalTask(task)) {
      return reply.code(403).send({ error: "NOT_EVAL_TASK", message: "只能对评测任务执行操作" });
    }
    const body = parsed.data;
    const requestHash = sha256(JSON.stringify({ ...body, operationId: undefined }));
    const prior = findOperatorEvent(store, task.id, body.operationId);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        return reply.code(409).send({ error: "OPERATION_ID_CONFLICT", message: "operationId 已用于不同参数的请求" });
      }
      return reply.code(200).send({ ...prior.result, replayed: true });
    }
    const key = `${task.id}:${body.operationId}`;
    if (inflightOperations.has(key)) {
      return reply.code(409).send({ error: "OPERATION_IN_PROGRESS", message: "相同 operationId 正在执行" });
    }
    inflightOperations.add(key);
    try {
      const result = await executeOperator(deps, service, store, task, body);
      store.appendEvent({
        type: "eval.operator",
        taskId: task.id,
        runId: typeof result.runId === "string" ? result.runId : task.currentRunId ?? null,
        payload: { operationId: body.operationId, action: body.action, requestHash, result, statusCode: 200 }
      });
      return reply.code(200).send({ ...result, replayed: false });
    } catch (error) {
      const mapped = mapOperatorError(error);
      return reply.code(mapped.statusCode).send({ error: mapped.code, message: mapped.message, replayed: false });
    } finally {
      inflightOperations.delete(key);
    }
  });

  app.get<{ Params: { id: string } }>("/api/eval/tasks/:id/trace", async (request, reply) => {
    const parsed = traceQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_TRACE_QUERY",
        message: "trace 查询参数不正确",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    const task = store.getTask(request.params.id);
    if (!task) return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "评测任务不存在" });
    const afterSeq = parsed.data.afterSeq ?? 0;
    const limit = parsed.data.limit ?? TRACE_DEFAULT_LIMIT;
    const pending = store.listEvents(afterSeq, task.id);
    const window = pending.slice(0, limit);
    const last = window.at(-1);
    const byType: Record<string, number> = {};
    for (const event of pending) byType[event.type] = (byType[event.type] ?? 0) + 1;
    return {
      taskId: task.id,
      externalRef: task.externalRef ?? null,
      status: task.status,
      afterSeq,
      limit,
      nextSeq: last?.seq ?? afterSeq,
      hasMore: pending.length > window.length,
      remaining: pending.length - window.length,
      total: store.countEvents(task.id),
      counts: { window: window.length, byType },
      events: window.map((event) => ({
        seq: event.seq,
        id: event.id,
        type: event.type,
        taskId: event.taskId,
        runId: event.runId,
        payload: event.payload,
        createdAt: event.createdAt
      }))
    };
  });

  app.post("/api/eval/judge", async (request, reply) => {
    const parsed = judgeSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_JUDGE_REQUEST", message: "裁判请求参数不正确" });
    }
    const body = parsed.data as JudgeRequest;
    const view = service.view(body.taskId);
    if (!view) return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "评测任务不存在" });
    const settings = options.settings();
    if (!settings || !chatModelConfigured(settings)) {
      return reply.code(503).send({ error: "JUDGE_UNAVAILABLE", message: "尚未配置可用的聊天模型" });
    }
    const prompt = buildJudgePrompt(view.artifacts.map((artifact) => ({
      path: artifact.relativePath,
      text: readTextArtifact(artifact.absolutePath)
    })), body);
    const promptHash = sha256(prompt);
    const messages: ChatMessage[] = [
      { role: "system", content: "你是严格、保守的任务评测裁判。只根据提供的产物和确定性结果判断，不臆测未展示的事实。" },
      { role: "user", content: prompt }
    ];
    const isGlm53 = /^glm-5\.3(?:-|$)/i.test(settings.model);
    const completionOptions: CompleteOptions = {
      maxTokens: settings.maxOutputTokens,
      temperature: isGlm53 ? 1 : 0,
      timeoutMs: 90_000,
      ...(settings.protocol === "openai-chat" ? {
        responseFormat: { type: "json_object" as const },
        ...(isGlm53 ? { reasoningEffort: "low" as const } : {})
      } : {})
    };
    const diagnostics: Record<string, unknown> = {
      model: settings.model,
      maxTokens: completionOptions.maxTokens,
      responseFormat: completionOptions.responseFormat?.type ?? null,
      reasoningEffort: completionOptions.reasoningEffort ?? null
    };
    try {
      const result = await complete(settings, messages, completionOptions);
      Object.assign(diagnostics, result.diagnostics, {
        usage: result.usage,
        contentCharacters: result.content.length
      });
      request.log.info({ taskId: body.taskId, diagnostics }, "评委模型响应");
      if (result.diagnostics?.finishReason === "length") {
        throw new Error(`评委输出达到 ${completionOptions.maxTokens} token 上限，结果被截断；请提高模型最大输出预算后重新评分`);
      }
      const judge = parseJudgeResult(result.content, body);
      const response: JudgeResponse = {
        model: settings.model,
        promptHash,
        criteria: judge.criteria,
        overallConfidence: judge.overallConfidence,
        usage: result.usage ?? { inputTokens: 0, outputTokens: 0 },
        diagnostics
      };
      return response;
    } catch (error) {
      return reply.code(502).send({ error: "JUDGE_FAILED", message: errorMessage(error), diagnostics });
    }
  });
}

async function executeOperator(
  deps: EvalOperatorDeps,
  service: HearthService,
  store: HearthStore,
  task: TaskRecord,
  body: z.infer<typeof operatorSchema>
): Promise<Record<string, unknown>> {
  switch (body.action) {
    case "approval.decide": {
      if (!body.decision || !body.parameterHash) {
        throw new EvalOperatorError("INVALID_EVAL_OPERATION", "approval.decide 需要 decision 与 parameterHash", 400);
      }
      const approvalId = requireTarget(body);
      const approval = store.getApproval(approvalId);
      if (!approval) throw new EvalOperatorError("APPROVAL_NOT_FOUND", "审批不存在", 404);
      if (approval.taskId !== task.id) {
        throw new EvalOperatorError("APPROVAL_TASK_MISMATCH", "审批不属于该评测任务", 409);
      }
      const result = await deps.approvals.decide(approvalId, body.decision, body.parameterHash);
      deps.outbox.reconcileApproval(result.approval.id);
      return { approval: result.approval, task: result.task, effect: result.effect ?? null };
    }
    case "outbox.submit":
    case "outbox.retry": {
      const draftId = requireTarget(body);
      const draft = service.requireOutboxDraft(draftId);
      if (draft.taskId && draft.taskId !== task.id) {
        throw new EvalOperatorError("OUTBOX_TASK_MISMATCH", "草稿已属于其他任务", 409);
      }
      if (draft.taskId !== task.id) service.updateOutboxDraft(draftId, { taskId: task.id });
      const result = await deps.outbox.submit(draftId);
      return { ...result, effects: store.listEffects(task.id) };
    }
    case "effect.assert": {
      const effects = store.listEffects(task.id)
        .filter((effect) => !body.targetId || effect.id === body.targetId);
      const satisfied = effects.length > 0
        && (!body.expectedStatus || effects.some((effect) => effect.status === body.expectedStatus));
      return { satisfied, expectedStatus: body.expectedStatus ?? null, effects };
    }
    case "reconcile.mark_uncertain": {
      const effectId = requireTarget(body);
      const effect = store.getEffect(effectId);
      if (!effect) throw new EvalOperatorError("EFFECT_NOT_FOUND", "效果不存在", 404);
      if (effect.taskId !== task.id) {
        throw new EvalOperatorError("EFFECT_TASK_MISMATCH", "效果不属于该评测任务", 409);
      }
      const reason = body.note ?? "评测注入的不确定状态";
      service.updateEffect(effect.id, { status: "uncertain", suspendReason: reason });
      const uncertain: EffectRecord = { ...effect, status: "uncertain", suspendReason: reason };
      const item = deps.reconcile.enqueue(uncertain, reason);
      return { effect: store.getEffect(effect.id), reconcileItem: item };
    }
    case "reconcile.check":
      return { reconcileItem: await deps.reconcile.check(requireTarget(body)) };
    case "reconcile.resolve": {
      if (!body.resolution) {
        throw new EvalOperatorError("INVALID_EVAL_OPERATION", "reconcile.resolve 需要 resolution", 400);
      }
      const item = deps.reconcile.resolveManually(requireTarget(body), body.resolution, body.note ?? "");
      return { reconcileItem: item };
    }
    case "checkpoint.restore": {
      if (!deps.scheduler) {
        throw new EvalOperatorError("EVAL_OPERATOR_UNAVAILABLE", "调度器未装配，无法恢复检查点", 503);
      }
      return { task: deps.scheduler.retry(task.id) };
    }
  }
}

function requireTarget(body: z.infer<typeof operatorSchema>): string {
  if (!body.targetId) {
    throw new EvalOperatorError("INVALID_EVAL_OPERATION", `${body.action} 需要 targetId`, 400);
  }
  return body.targetId;
}

function mapOperatorError(error: unknown): { code: string; message: string; statusCode: number } {
  if (error instanceof EvalOperatorError) {
    return { code: error.code, message: error.message, statusCode: error.statusCode };
  }
  if (error instanceof ApprovalError) {
    const statusCode = error.code === "APPROVAL_NOT_FOUND" ? 404 : error.code === "APPROVAL_EXPIRED" ? 410 : 409;
    return { code: error.code, message: error.message, statusCode };
  }
  if (error instanceof OutboxError) {
    return { code: error.code, message: error.message, statusCode: error.statusCode };
  }
  if (error instanceof ReconcileError) {
    const statusCode = error.code === "RECONCILE_NOT_FOUND" ? 404 : 409;
    return { code: error.code, message: error.message, statusCode };
  }
  return { code: "EVAL_OPERATION_FAILED", message: errorMessage(error), statusCode: 500 };
}

function findOperatorEvent(
  store: HearthStore,
  taskId: string,
  operationId: string
): { requestHash: string; result: Record<string, unknown> } | null {
  const events = store.listEvents(0, taskId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "eval.operator") continue;
    const payload = event.payload as { operationId?: unknown; requestHash?: unknown; result?: unknown } | null;
    if (payload?.operationId !== operationId) continue;
    return {
      requestHash: String(payload.requestHash ?? ""),
      result: (payload.result as Record<string, unknown> | null) ?? {}
    };
  }
  return null;
}

function isEvalTask(task: TaskRecord): boolean {
  return Boolean(task.externalRef?.startsWith("eval:")) || Boolean(task.requestHash);
}

function normalizeEvalInput(evalInputRoot: string, value: string): string {
  const candidate = isAbsolute(value) ? resolve(value) : resolve(evalInputRoot, value);
  if (!isPathInside(evalInputRoot, candidate)) throw new Error(`输入必须位于 HEARTH_EVAL_INPUT_ROOT：${value}`);
  if (!existsSync(candidate) || !statSync(candidate).isFile()) throw new Error(`评测输入文件不存在：${value}`);
  return candidate;
}

function normalizeEvalOutput(repoRoot: string, outputRoot: string, value: string): string {
  if (isAbsolute(value)) throw new Error("outputDir 必须是仓库相对路径");
  const candidate = resolve(repoRoot, value);
  if (!isPathInside(outputRoot, candidate) || candidate === outputRoot) {
    throw new Error("outputDir 必须位于 .hearth/eval-artifacts/ 下");
  }
  return relative(repoRoot, candidate).replace(/\\/g, "/");
}

function validateRelativeOutput(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`期望产物路径不安全：${value}`);
  }
  return normalized;
}

function hashEvalTask(body: z.infer<typeof evalTaskSchema>): string {
  return sha256(JSON.stringify({
    externalRef: body.externalRef,
    title: body.title,
    goal: body.goal,
    inputs: body.inputs,
    expectedOutputs: body.expectedOutputs,
    executorId: body.executorId ?? null,
    runMode: body.runMode,
    taskKind: body.taskKind ?? "delivery",
    approvalMode: body.approvalMode ?? "full",
    allowExternalEffects: body.allowExternalEffects ?? false,
    networkHosts: [...body.networkHosts ?? []].sort(),
    outputDir: body.outputDir,
    timeoutMs: body.timeoutMs ?? null
  }));
}

function buildJudgePrompt(artifacts: Array<{ path: string; text: string }>, body: JudgeRequest): string {
  let remaining = 120_000;
  const rendered = artifacts.map((artifact) => {
    const cap = Math.min(24_000, remaining);
    const text = artifact.text.slice(0, cap);
    remaining -= text.length;
    return `### ${artifact.path}\n${text}`;
  }).join("\n\n");
  return [
    "请对以下 Hearth 评测任务产物逐项评分。",
    "只输出一个 JSON 对象，不要 Markdown 代码块。格式：",
    '{"criteria":[{"id":"criterion-id","passed":true,"confidence":0.0,"reason":"依据","evidence":["引用片段"]}],"overallConfidence":0.0}',
    "confidence 必须在 0 到 1 之间；证据不足时 passed=false 且降低 confidence。",
    "必须为每个 criterion id 返回且只返回一条结果。",
    "",
    "## 裁判项",
    body.criteria.map((criterion) => `- ${criterion.id}｜${criterion.label}｜${criterion.points} 分\n  rubric: ${criterion.rubric}`).join("\n"),
    "",
    "## 确定性结果",
    body.deterministic.length === 0 ? "（无）" : body.deterministic.map((item) => `- ${item.criterionId}: ${item.passed ? "通过" : "失败"}｜${item.reason}`).join("\n"),
    "",
    "## 产物",
    rendered || "（无产物）"
  ].join("\n");
}

function parseJudgeResult(content: string, body: JudgeRequest): Pick<JudgeResponse, "criteria" | "overallConfidence"> {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("裁判没有返回 JSON 对象");
  const parsed = JSON.parse(content.slice(start, end + 1)) as {
    criteria?: Array<{ id?: unknown; passed?: unknown; confidence?: unknown; reason?: unknown; evidence?: unknown }>;
    overallConfidence?: unknown;
  };
  const results = new Map((parsed.criteria ?? []).map((item) => [String(item.id ?? ""), item]));
  const criteria = body.criteria.map((criterion) => {
    const item = results.get(criterion.id);
    if (!item) throw new Error(`裁判缺少评分项：${criterion.id}`);
    return {
      id: criterion.id,
      passed: item.passed === true,
      confidence: clampConfidence(item.confidence),
      reason: typeof item.reason === "string" ? item.reason.slice(0, 2_000) : "未提供理由",
      evidence: Array.isArray(item.evidence) ? item.evidence.filter((value): value is string => typeof value === "string").slice(0, 8) : []
    };
  });
  const confidenceValues = criteria.map((item) => item.confidence);
  const overallConfidence = clampConfidence(parsed.overallConfidence ?? (confidenceValues.reduce((sum, value) => sum + value, 0) / Math.max(1, confidenceValues.length)));
  return { criteria, overallConfidence };
}

function readTextArtifact(path: string): string {
  if (!existsSync(path)) return "";
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return `[产物过大或不可读取：${stat.size} bytes]`;
  const extension = path.split(".").pop()?.toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "pdf", "zip", "xlsx", "docx"].includes(extension ?? "")) {
    return `[二进制产物：${stat.size} bytes]`;
  }
  return readFileSync(path, "utf8");
}

function clampConfidence(value: unknown): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(1, Math.round(number * 100) / 100));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}${sep}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
