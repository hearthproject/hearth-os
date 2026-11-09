import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import type {
  CaseCatalogResponse,
  CaseDetailResponse,
  CaseVersionSummary,
  CompareResponse,
  CreateExperimentRequest,
  DashboardResponse,
  EvalFamily,
  EvalSystemResponse,
  ExperimentComparison,
  ExperimentDetailResponse,
  ExperimentsResponse,
  ReviewQueueItem,
  ReviewsResponse,
  RunArtifactView,
  RunDetailResponse,
  SubmitReviewRequest
} from "@hearth/eval-core";
import { EVAL_FAMILIES } from "@hearth/eval-core";
import type { LoadedCase } from "@hearth/eval-core/node";
import type { FastifyInstance, FastifyReply } from "fastify";
import Fastify from "fastify";
import { z } from "zod";
import { EvalRunnerError, type EvalRunner } from "./runner.ts";
import type { EvalStore, StoredCase } from "./store.ts";
import type { HearthClient } from "./hearth-client.ts";

const createExperimentSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  caseIds: z.array(z.string().trim().min(1).max(100)).min(1).max(200),
  executorIds: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
  repetitions: z.number().int().min(1).max(5).default(1),
  runMode: z.enum(["offline", "live"]).default("offline"),
  autoJudge: z.boolean().default(true),
  autoRetry: z.boolean().default(true),
  maxConcurrency: z.number().int().min(1).max(8).default(1),
  baselineExperimentId: z.string().trim().min(1).max(100).nullable().optional()
}).strict();

const submitReviewSchema = z.object({
  decision: z.enum(["pass", "fail", "unknown"]),
  reviewer: z.string().trim().max(80).optional(),
  note: z.string().max(4_000).optional()
}).strict();

const eventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1_000).default(300),
  experimentId: z.string().trim().min(1).max(100).optional(),
  runId: z.string().trim().min(1).max(100).optional()
}).strict();

export interface EvalAppOptions {
  store: EvalStore;
  runner: EvalRunner;
  client: HearthClient;
  catalog: Map<string, LoadedCase>;
  catalogIssues: number;
  repoRoot: string;
  artifactRoot: string;
  dataDir: string;
  evalVersion: string;
  webDist?: string;
  logger?: boolean;
}

interface JudgeInfo {
  configured: boolean;
  model: string | null;
}

export async function buildEvalApp(options: EvalAppOptions): Promise<FastifyInstance> {
  const { store, runner, client, catalog, repoRoot, artifactRoot } = options;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1_000_000 });
  let judgeCache: { expiresAt: number; info: JudgeInfo } | null = null;

  const judgeInfo = async (): Promise<JudgeInfo> => {
    if (judgeCache && judgeCache.expiresAt > Date.now()) return judgeCache.info;
    let info: JudgeInfo = { configured: false, model: null };
    try {
      const health = await client.health();
      const chatModel = asRecord(health.chatModel);
      const settings = asRecord(chatModel?.settings);
      info = {
        configured: chatModel?.configured === true,
        model: typeof settings?.model === "string" ? settings.model : null
      };
    } catch {
      info = { configured: false, model: null };
    }
    judgeCache = { expiresAt: Date.now() + 5_000, info };
    return info;
  };

  const systemInfo = async (): Promise<EvalSystemResponse> => {
    const judge = await judgeInfo();
    let reachable = false;
    let hearthStatus = "offline";
    try {
      const health = await client.health();
      reachable = true;
      hearthStatus = typeof health.status === "string" ? health.status : "online";
    } catch {
      reachable = false;
    }
    return {
      evalVersion: options.evalVersion,
      hearthUrl: client.baseUrl,
      hearthReachable: reachable,
      hearthStatus,
      judgeConfigured: judge.configured,
      judgeModel: judge.model,
      catalogCases: catalog.size,
      catalogIssues: options.catalogIssues,
      artifactRoot,
      dataDir: options.dataDir,
      runningExperiments: store.countRunningExperiments(),
      pendingReviews: store.countPendingReviews(),
      generatedAt: new Date().toISOString()
    };
  };

  app.get("/api/health", async () => ({
    ok: true,
    service: "hearth-eval",
    version: options.evalVersion,
    cases: catalog.size,
    time: new Date().toISOString()
  }));

  app.get("/api/system", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return systemInfo();
  });

  app.get("/api/dashboard", async (_request, reply): Promise<DashboardResponse> => {
    reply.header("cache-control", "no-store");
    const experiments = store.listExperiments(5);
    return {
      catalog: catalogResponse(store.listCases()),
      recentExperiments: experiments,
      latestSummary: experiments[0]?.summary ?? null,
      pendingReviews: store.countPendingReviews(),
      runningExperiments: store.countRunningExperiments(),
      system: await systemInfo()
    };
  });

  app.get<{ Querystring: { family?: string; difficulty?: string; runMode?: string; search?: string } }>("/api/cases", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const family = request.query.family;
    const difficulty = request.query.difficulty;
    const runMode = request.query.runMode;
    const search = request.query.search?.trim().toLowerCase();
    const cases = store.listCases().filter((item) => {
      if (family && item.summary.family !== family) return false;
      if (difficulty && item.summary.difficulty !== difficulty) return false;
      if (runMode && !item.summary.runModes.includes(runMode as CaseVersionSummary["runModes"][number])) return false;
      if (search) {
        const haystack = [item.summary.caseKey, item.summary.title, ...item.manifest.tags].join(" ").toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
    return { ...catalogResponse(cases), cases: cases.map((item) => item.summary) };
  });

  app.get<{ Params: { caseKey: string } }>("/api/cases/:caseKey", async (request, reply): Promise<CaseDetailResponse | FastifyReply> => {
    const stored = store.getCase(request.params.caseKey);
    if (!stored) return reply.code(404).send({ error: "CASE_NOT_FOUND", message: "case 不存在" });
    return {
      case: stored.summary,
      manifest: stored.manifest,
      hasGolden: existsSync(join(repoRoot, "eval", "cases", stored.summary.caseKey, "golden"))
    };
  });

  app.get("/api/experiments", async (_request, reply): Promise<ExperimentsResponse> => {
    reply.header("cache-control", "no-store");
    return { experiments: store.listExperiments(200) };
  });

  app.post("/api/experiments", async (request, reply) => {
    const parsed = createExperimentSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_EXPERIMENT", message: "实验参数不正确", issues: parsed.error.issues });
    }
    try {
      const judge = await judgeInfo();
      const environment = await runner.collectEnvironment(judge.model);
      const experiment = runner.createExperiment(parsed.data as CreateExperimentRequest, environment);
      runner.start(experiment.id);
      return reply.code(201).send(experiment);
    } catch (error) {
      return sendRunnerError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/experiments/:id", async (request, reply): Promise<ExperimentDetailResponse | FastifyReply> => {
    const experiment = store.getExperiment(request.params.id);
    if (!experiment) return reply.code(404).send({ error: "EXPERIMENT_NOT_FOUND", message: "实验不存在" });
    return {
      experiment,
      runs: store.listRuns(experiment.id),
      summary: experiment.summary ?? runner.summarize(experiment.id),
      events: store.listEvents({ experimentId: experiment.id, limit: 500 })
    };
  });

  app.post<{ Params: { id: string } }>("/api/experiments/:id/cancel", async (request, reply) => {
    try {
      return runner.cancel(request.params.id);
    } catch (error) {
      return sendRunnerError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request, reply): Promise<RunDetailResponse | FastifyReply> => {
    const run = store.getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: "RUN_NOT_FOUND", message: "评测运行不存在" });
    const storedCase = store.getCase(run.caseKey);
    let hearthTask: Record<string, unknown> | null = null;
    if (run.hearthTaskId) {
      try {
        hearthTask = asRecord(await client.getTask(run.hearthTaskId));
      } catch (error) {
        hearthTask = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    return {
      run,
      case: storedCase?.summary ?? null,
      manifest: storedCase?.manifest ?? null,
      graders: store.listGraderResults(run.id),
      review: store.getHumanReview(run.id),
      events: store.listEvents({ runId: run.id, limit: 500 }),
      artifacts: listRunArtifacts(repoRoot, artifactRoot, run.outputDir),
      hearthTask
    };
  });

  app.get("/api/reviews", async (_request, reply): Promise<ReviewsResponse> => {
    reply.header("cache-control", "no-store");
    const reviews = store.listPendingReviewRuns().map((run): ReviewQueueItem => {
      const storedCase = store.getCase(run.caseKey);
      const experiment = store.getExperiment(run.experimentId);
      const score = run.score === null ? "未评分" : `${run.score.toFixed(1)} 分`;
      const detail = run.error ?? (run.reviewReasons.length > 0 ? run.reviewReasons.join(", ") : "等待人工确认");
      return {
        run,
        case: storedCase?.summary ?? null,
        experimentName: experiment?.name ?? run.experimentId,
        reasons: run.reviewReasons,
        summary: `${score} · ${detail}`
      };
    });
    return { reviews };
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/review", async (request, reply) => {
    const parsed = submitReviewSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_REVIEW", message: "复核参数不正确", issues: parsed.error.issues });
    }
    try {
      const review = runner.review(request.params.id, parsed.data.decision, parsed.data.reviewer, parsed.data.note);
      const run = store.getRun(request.params.id);
      return { review, run, experiment: run ? store.getExperiment(run.experimentId) : null };
    } catch (error) {
      return sendRunnerError(reply, error);
    }
  });

  app.get<{ Querystring: { left?: string; right?: string } }>("/api/compare", async (request, reply): Promise<CompareResponse | FastifyReply> => {
    const leftId = request.query.left?.trim();
    const rightId = request.query.right?.trim();
    if (!leftId || !rightId) {
      return reply.code(400).send({ error: "COMPARE_REQUIRES_TWO", message: "比较需要 left 与 right 两个实验 ID" });
    }
    const left = store.getExperiment(leftId);
    const right = store.getExperiment(rightId);
    if (!left || !right) {
      return reply.code(404).send({ error: "EXPERIMENT_NOT_FOUND", message: `实验不存在：${!left ? leftId : rightId}` });
    }
    const leftSummary = left.summary ?? runner.summarize(left.id);
    const rightSummary = right.summary ?? runner.summarize(right.id);
    const warnings: string[] = [];
    if (!leftSummary || !rightSummary) warnings.push("至少一侧实验还没有可用的汇总结果。");
    if (left.config.runMode !== right.config.runMode) warnings.push("两侧运行模式不同。");
    if (left.config.repetitions !== right.config.repetitions) warnings.push("两侧重复次数不同。");
    if (!sameStrings(left.config.executorIds, right.config.executorIds)) warnings.push("两侧执行器集合不同。");
    if (!sameStrings(left.config.caseIds, right.config.caseIds)) warnings.push("两侧 case 集合不同。");
    const familyDeltas = EVAL_FAMILIES.map((family) => {
      const leftPassRate = leftSummary?.families.find((item) => item.family === family)?.passRate ?? null;
      const rightPassRate = rightSummary?.families.find((item) => item.family === family)?.passRate ?? null;
      return {
        family,
        leftPassRate,
        rightPassRate,
        delta: leftPassRate === null || rightPassRate === null ? null : Math.round((rightPassRate - leftPassRate) * 100) / 100
      };
    });
    return {
      leftExperimentId: left.id,
      rightExperimentId: right.id,
      leftName: left.name,
      rightName: right.name,
      aligned: warnings.length === 0,
      warnings,
      left: leftSummary,
      right: rightSummary,
      familyDeltas
    };
  });

  app.get<{ Querystring: { after?: string; limit?: string; experimentId?: string; runId?: string } }>("/api/events", async (request, reply) => {
    const parsed = eventsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_EVENTS_QUERY", message: "事件查询参数不正确", issues: parsed.error.issues });
    }
    reply.header("cache-control", "no-store");
    return {
      events: store.listEvents({
        afterSeq: parsed.data.after,
        limit: parsed.data.limit,
        ...(parsed.data.experimentId ? { experimentId: parsed.data.experimentId } : {}),
        ...(parsed.data.runId ? { runId: parsed.data.runId } : {})
      })
    };
  });

  app.get<{ Params: { id: string; "*": string } }>("/api/runs/:id/artifacts/*", async (request, reply): Promise<RunArtifactView | FastifyReply> => {
    const run = store.getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: "RUN_NOT_FOUND", message: "评测运行不存在" });
    const root = resolve(repoRoot, run.outputDir);
    const relative = decodeURIComponent(request.params["*"] ?? "");
    if (!relative) return reply.code(400).send({ error: "ARTIFACT_PATH_REQUIRED", message: "缺少产物路径" });
    const candidate = resolve(root, relative);
    if (!isPathInside(root, candidate) || !isPathInside(artifactRoot, candidate)) {
      return reply.code(403).send({ error: "ARTIFACT_PATH_DENIED", message: "不允许访问该产物路径" });
    }
    if (!existsSync(candidate)) return reply.code(404).send({ error: "ARTIFACT_NOT_FOUND", message: "产物不存在" });
    const stats = statSync(candidate);
    if (!stats.isFile()) return reply.code(400).send({ error: "ARTIFACT_NOT_FILE", message: "目标不是文件" });
    const mimeType = mimeFor(candidate);
    const preview = isTextMime(mimeType) && stats.size <= 1_000_000
      ? readFileSync(candidate, "utf8")
      : null;
    return {
      path: relative.replace(/\\/g, "/"),
      bytes: stats.size,
      mimeType,
      preview
    };
  });

  if (options.webDist && existsSync(join(options.webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: options.webDist, wildcard: false });
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api/") && options.webDist && existsSync(join(options.webDist, "index.html"))) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({ error: "NOT_FOUND", message: `未找到：${request.url}` });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof EvalRunnerError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    app.log.error({ err: error, method: request.method, url: request.url }, "eval request failed");
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) });
  });

  return app;
}

function catalogResponse(cases: StoredCase[]): CaseCatalogResponse {
  const counts = Object.fromEntries(EVAL_FAMILIES.map((family) => [family, 0])) as Record<EvalFamily, number>;
  for (const stored of cases) counts[stored.summary.family] += 1;
  return {
    cases: cases.map((stored) => stored.summary),
    counts,
    generatedAt: new Date().toISOString()
  };
}

function sendRunnerError(reply: FastifyReply, error: unknown) {
  if (error instanceof EvalRunnerError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  return reply.code(500).send({
    error: "EVAL_INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error)
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function listRunArtifacts(repoRoot: string, artifactRoot: string, outputDir: string): RunArtifactView[] {
  const root = resolve(repoRoot, outputDir);
  if (!isPathInside(artifactRoot, root) || !existsSync(root)) return [];
  const artifacts: RunArtifactView[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 12 || artifacts.length >= 500) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || artifacts.length >= 500) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const stats = statSync(absolute);
      if (stats.size > 20 * 1024 * 1024) continue;
      const mimeType = mimeFor(absolute);
      artifacts.push({
        path: absolute.slice(root.length + 1).replace(/\\/g, "/"),
        bytes: stats.size,
        mimeType,
        preview: isTextMime(mimeType) && stats.size <= 1_000_000 ? readFileSync(absolute, "utf8") : null
      });
    }
  };
  visit(root, 0);
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

function mimeFor(path: string): string {
  const extension = extname(path).toLowerCase();
  if ([".md", ".markdown"].includes(extension)) return "text/markdown";
  if (extension === ".json") return "application/json";
  if ([".html", ".htm"].includes(extension)) return "text/html";
  if (extension === ".csv") return "text/csv";
  if ([".txt", ".log", ".yaml", ".yml", ".js", ".ts", ".css"].includes(extension)) return "text/plain";
  return "application/octet-stream";
}

function isTextMime(mimeType: string): boolean {
  return mimeType.startsWith("text/") || mimeType === "application/json";
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root).replace(/[\\/]+$/, "");
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}\\`)
    || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}
