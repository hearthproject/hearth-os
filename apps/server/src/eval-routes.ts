import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { defaultTaskPermissions } from "@hearth/agent-runtime";
import { EXECUTOR_IDS, type TaskRecord } from "@hearth/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
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

interface EvalRouteOptions {
  service: HearthService;
  store: HearthStore;
  settings: () => ModelSettings | null;
  repoRoot: string;
  evalInputRoot?: string;
  complete?: typeof completeChat;
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
        goal: `${body.goal}\n\n评测运行约束：${body.runMode === "offline" ? "不得访问网络。" : "只允许访问声明的网络主机。"}只将产物写入 ${body.outputDir}，不得产生外部副作用。`,
        inputs: body.inputs.map((input) => ({ kind: input.kind, label: input.label, value: input.value, ...(input.sha256 ? { sha256: input.sha256 } : {}) })),
        networkHosts,
        ...(body.executorId ? { executorId: body.executorId } : {}),
        taskKind: "delivery",
        expectedOutputs: body.expectedOutputs,
        outputDir: body.outputDir,
        permissions: {
          ...permissions,
          readRoots: [evalInputRoot],
          writeRoots: [outputDir],
          approvalMode: "full"
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
