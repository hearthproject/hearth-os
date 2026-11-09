import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type {
  ArtifactMap,
  CaseManifest,
  CreateExperimentRequest,
  EvalInput,
  ExperimentEnvironment,
  ExperimentRecord,
  ExperimentRunRecord,
  ExperimentRunStatus,
  ExperimentSummary,
  GraderResultRecord,
  HumanReviewRecord,
  JudgeCriterionResult
} from "@hearth/eval-core";
import {
  EVAL_FAMILIES,
  emptyFamilySummaries,
  familySummary,
  runGrader,
  scoreRun,
  type GraderOutcome,
  type JudgeOutcome
} from "@hearth/eval-core";
import { resolveCaseInput, type LoadedCase } from "@hearth/eval-core/node";
import { HearthClient, isTerminalTaskStatus, type HearthTaskView } from "./hearth-client.ts";
import type { EvalStore, RunMetrics } from "./store.ts";

export class EvalRunnerError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "EvalRunnerError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

interface RunnerOptions {
  store: EvalStore;
  client: HearthClient;
  repoRoot: string;
  artifactRoot: string;
  catalog: Map<string, LoadedCase>;
  evalVersion: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  pollIntervalMs?: number;
}

interface TaskWaitResult {
  status: string;
  task: HearthTaskView["task"];
  view: HearthTaskView | null;
  timedOut: boolean;
}

interface GradeResult {
  graderRecords: GraderResultRecord[];
  deterministic: Record<string, GraderOutcome>;
  judge: JudgeOutcome | null;
  judgeExpected: boolean;
  outcome: ReturnType<typeof scoreRun>;
}

export class EvalRunner {
  private readonly store: EvalStore;
  private readonly client: HearthClient;
  private readonly repoRoot: string;
  private readonly artifactRoot: string;
  private readonly catalog: Map<string, LoadedCase>;
  private readonly evalVersion: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private readonly active = new Set<string>();

  constructor(options: RunnerOptions) {
    this.store = options.store;
    this.client = options.client;
    this.repoRoot = options.repoRoot;
    this.artifactRoot = resolve(options.artifactRoot);
    this.catalog = options.catalog;
    this.evalVersion = options.evalVersion;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
  }

  async collectEnvironment(judgeModel: string | null): Promise<ExperimentEnvironment> {
    let health: Record<string, unknown> = {};
    try {
      health = await this.client.health();
    } catch {
      health = {};
    }
    return {
      hearthUrl: this.client.baseUrl,
      hearthNow: typeof health.now === "string" ? health.now : null,
      schemaVersion: typeof health.schemaVersion === "number" ? health.schemaVersion : null,
      instanceId: typeof health.instanceId === "string" ? health.instanceId : null,
      executorSettings: asRecord(health.executors) ?? {},
      judgeModel,
      evalVersion: this.evalVersion
    };
  }

  createExperiment(request: CreateExperimentRequest, environment: ExperimentEnvironment): ExperimentRecord {
    const caseIds = [...new Set(request.caseIds.map((id) => id.trim()).filter(Boolean))];
    if (caseIds.length === 0) throw new EvalRunnerError("NO_CASES", "至少选择一个 case", 400);
    if (caseIds.length > 200) throw new EvalRunnerError("TOO_MANY_CASES", "单次实验最多包含 200 个 case", 400);
    const executorIds = [...new Set(request.executorIds.map((id) => id.trim()).filter(Boolean))];
    if (executorIds.length === 0) throw new EvalRunnerError("NO_EXECUTORS", "至少选择一个执行器", 400);
    if (request.repetitions < 1 || request.repetitions > 5) throw new EvalRunnerError("INVALID_REPETITIONS", "重复次数必须在 1 到 5 之间", 400);
    if (request.maxConcurrency < 1 || request.maxConcurrency > 8) throw new EvalRunnerError("INVALID_CONCURRENCY", "并发数必须在 1 到 8 之间", 400);

    const unsupported: string[] = [];
    const selected: LoadedCase[] = [];
    for (const caseId of caseIds) {
      const loaded = this.catalog.get(caseId);
      if (!loaded) throw new EvalRunnerError("CASE_NOT_FOUND", `case 不存在：${caseId}`, 404);
      if (!supportsRunMode(loaded.manifest, request.runMode)) {
        unsupported.push(caseId);
        continue;
      }
      selected.push(loaded);
    }
    if (unsupported.length > 0) {
      throw new EvalRunnerError("CASE_MODE_UNSUPPORTED", `这些 case 不支持 ${request.runMode} 模式：${unsupported.join(", ")}`, 400);
    }

    const id = `EXP-${this.now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
    const createdAt = this.now().toISOString();
    const config = {
      name: request.name?.trim() || `评测 ${id.slice(-6)}`,
      caseIds,
      executorIds,
      repetitions: request.repetitions,
      runMode: request.runMode,
      autoJudge: request.autoJudge,
      autoRetry: request.autoRetry,
      maxConcurrency: request.maxConcurrency,
      baselineExperimentId: request.baselineExperimentId ?? null
    };
    const experiment: ExperimentRecord = {
      id,
      name: config.name,
      status: "queued",
      config,
      environment,
      createdAt,
      startedAt: null,
      finishedAt: null,
      summary: null
    };
    const runs: ExperimentRunRecord[] = [];
    for (const loaded of selected) {
      for (const executorId of executorIds) {
        for (let repetition = 1; repetition <= request.repetitions; repetition += 1) {
          runs.push({
            id: randomUUID(),
            experimentId: id,
            caseKey: loaded.manifest.id,
            caseVersion: loaded.manifest.version,
            caseContentHash: loaded.contentHash,
            executorId,
            repetition,
            status: "queued",
            hearthTaskId: null,
            outputDir: `.hearth/eval-artifacts/${id}/${loaded.manifest.id}/${executorId}/r${repetition}`,
            externalRef: `eval:${id}:${loaded.manifest.id}:${executorId}:r${repetition}`,
            attempt: 1,
            startedAt: null,
            finishedAt: null,
            score: null,
            error: null,
            reviewReasons: [],
            createdAt,
            updatedAt: createdAt
          });
        }
      }
    }
    this.store.createExperiment(experiment);
    this.store.createRuns(runs);
    this.store.appendEvent("experiment.created", {
      experimentId: id,
      payload: { cases: selected.length, executors: executorIds.length, repetitions: request.repetitions, runs: runs.length }
    });
    return experiment;
  }

  start(experimentId: string): void {
    if (this.active.has(experimentId)) return;
    this.active.add(experimentId);
    void this.runExperiment(experimentId)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.store.updateExperiment(experimentId, { status: "failed", finishedAt: this.now().toISOString() });
        this.store.appendEvent("experiment.failed", { experimentId, payload: { error: message } });
      })
      .finally(() => this.active.delete(experimentId));
  }

  cancel(experimentId: string): ExperimentRecord {
    const experiment = this.store.getExperiment(experimentId);
    if (!experiment) throw new EvalRunnerError("EXPERIMENT_NOT_FOUND", "实验不存在", 404);
    if (["completed", "failed", "cancelled"].includes(experiment.status)) return experiment;
    const finishedAt = this.now().toISOString();
    for (const run of this.store.listRuns(experimentId)) {
      if (!["queued", "created", "running", "waiting", "grading"].includes(run.status)) continue;
      this.store.updateRun(run.id, { status: "cancelled", finishedAt, updatedAt: finishedAt });
      if (run.hearthTaskId) void this.client.cancelTask(run.hearthTaskId).catch(() => undefined);
    }
    this.store.updateExperiment(experimentId, { status: "cancelled", finishedAt });
    this.store.appendEvent("experiment.cancelled", { experimentId });
    return this.store.getExperiment(experimentId) ?? experiment;
  }

  summarize(experimentId: string): ExperimentSummary | null {
    const experiment = this.store.getExperiment(experimentId);
    if (!experiment) return null;
    const runs = this.store.listRuns(experimentId);
    const rows = runs.map((run) => {
      const family = this.store.getCase(run.caseKey)?.summary.family ?? "cross-app";
      return {
        family,
        status: run.status,
        score: run.score,
        reviewPending: run.reviewReasons.length > 0 && !this.store.getHumanReview(run.id)
      };
    });
    const families = EVAL_FAMILIES.map((family) => familySummary(family, rows));
    const passed = runs.filter((run) => run.status === "passed").length;
    const failed = runs.filter((run) => run.status === "failed" || run.status === "error").length;
    const blocked = runs.filter((run) => run.status === "blocked").length;
    const needsReview = runs.filter((run) => run.reviewReasons.length > 0 && !this.store.getHumanReview(run.id)).length;
    const scores = runs.flatMap((run) => run.score === null ? [] : [run.score]);
    const durations = runs.flatMap((run) => run.startedAt && run.finishedAt
      ? [Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt))]
      : []);
    const metrics = runs.map((run) => this.store.getRunMetrics(run.id)).filter((metric): metric is RunMetrics => Boolean(metric));
    return {
      experimentId,
      totalRuns: runs.length,
      passed,
      failed,
      blocked,
      needsReview,
      passRate: runs.length === 0 ? null : round(passed / runs.length * 100),
      avgScore: scores.length === 0 ? null : round(scores.reduce((sum, score) => sum + score, 0) / scores.length),
      avgDurationMs: durations.length === 0 ? null : Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
      inputTokens: metrics.reduce((sum, metric) => sum + metric.inputTokens, 0),
      outputTokens: metrics.reduce((sum, metric) => sum + metric.outputTokens, 0),
      retries: metrics.reduce((sum, metric) => sum + metric.retryCount, 0),
      approvals: metrics.reduce((sum, metric) => sum + metric.approvalCount, 0),
      families: families.length > 0 ? families : emptyFamilySummaries(),
      failureDiagnostics: diagnosticGroups(runs),
      generatedAt: this.now().toISOString()
    };
  }

  review(runId: string, decision: "pass" | "fail" | "unknown", reviewer = "local", note = ""): HumanReviewRecord {
    const run = this.store.getRun(runId);
    if (!run) throw new EvalRunnerError("RUN_NOT_FOUND", "评测运行不存在", 404);
    const loaded = this.catalog.get(run.caseKey);
    if (!loaded) throw new EvalRunnerError("CASE_NOT_FOUND", "评测 case 不存在", 404);
    const existing = this.store.listGraderResults(runId);
    const deterministic = deterministicFromRecords(existing);
    const judge = judgeFromRecords(existing);
    const judgeCriteria = loaded.manifest.criteria.filter((criterion) => criterion.source === "judge");
    const experiment = this.store.getExperiment(run.experimentId);
    const outcome = scoreRun({
      manifest: loaded.manifest,
      deterministic,
      judge,
      judgeExpected: experiment?.config.autoJudge === true && judgeCriteria.length > 0,
      humanDecision: decision,
      humanReviewed: decision !== "unknown",
      reviewReasonSeed: run.id,
      runFailed: ["failed", "error", "blocked"].includes(run.status),
      sampleRate: 0
    });
    const timestamp = this.now().toISOString();
    const review: HumanReviewRecord = {
      id: randomUUID(),
      runId,
      reviewer: reviewer.trim() || "local",
      decision,
      score: outcome.humanScore,
      note: note.trim(),
      createdAt: this.store.getHumanReview(runId)?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    const humanCriteria = loaded.manifest.criteria.filter((criterion) => criterion.source === "human");
    const humanResults: GraderResultRecord[] = decision === "unknown" ? [] : humanCriteria.map((criterion) => ({
      id: randomUUID(),
      runId,
      criterionId: criterion.id,
      source: "human",
      passed: decision === "pass",
      score: decision === "pass" ? criterion.points : 0,
      confidence: 1,
      reason: note.trim() || (decision === "pass" ? "人工复核通过" : "人工复核未通过"),
      evidence: [],
      model: null,
      promptHash: null,
      createdAt: timestamp
    }));
    this.store.replaceGraderResults(runId, [...existing.filter((result) => result.source !== "human"), ...humanResults]);
    this.store.upsertHumanReview(review);
    const nextStatus: ExperimentRunStatus = outcome.verdict === "passed"
      ? "passed"
      : outcome.verdict === "failed"
        ? "failed"
        : "needs_review";
    this.store.updateRun(runId, {
      status: nextStatus,
      score: outcome.score,
      reviewReasons: outcome.reviewReasons,
      updatedAt: timestamp,
      ...(["passed", "failed"].includes(nextStatus) ? { finishedAt: run.finishedAt ?? timestamp } : {})
    });
    this.store.appendEvent("review.submitted", {
      experimentId: run.experimentId,
      runId,
      payload: { decision, reviewer: review.reviewer, status: nextStatus, score: outcome.score }
    });
    this.refreshExperiment(run.experimentId);
    return review;
  }

  refreshExperiment(experimentId: string): ExperimentRecord | null {
    const experiment = this.store.getExperiment(experimentId);
    if (!experiment || experiment.status === "cancelled") return experiment;
    const runs = this.store.listRuns(experimentId);
    const summary = this.summarize(experimentId);
    const terminal = runs.every((run) => !["queued", "created", "running", "waiting", "grading"].includes(run.status));
    const pendingReview = runs.some((run) => run.reviewReasons.length > 0 && !this.store.getHumanReview(run.id));
    const allError = runs.length > 0 && runs.every((run) => run.status === "error");
    const status = terminal
      ? pendingReview
        ? "needs_review"
        : allError
          ? "failed"
          : "completed"
      : "running";
    return this.store.updateExperiment(experimentId, {
      status,
      summary,
      ...(terminal ? { finishedAt: experiment.finishedAt ?? this.now().toISOString() } : {})
    });
  }

  private async runExperiment(experimentId: string): Promise<void> {
    let experiment = this.store.getExperiment(experimentId);
    if (!experiment) throw new EvalRunnerError("EXPERIMENT_NOT_FOUND", "实验不存在", 404);
    if (experiment.status === "cancelled") return;
    experiment = this.store.updateExperiment(experimentId, {
      status: "running",
      startedAt: experiment.startedAt ?? this.now().toISOString()
    }) ?? experiment;
    this.store.appendEvent("experiment.started", { experimentId, payload: { runCount: this.store.listRuns(experimentId).length } });

    const queued = this.store.listQueuedRuns(experimentId);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(experiment.config.maxConcurrency, Math.max(1, queued.length)) }, async () => {
      while (cursor < queued.length) {
        const run = queued[cursor];
        cursor += 1;
        if (!run) break;
        if (this.store.getExperiment(experimentId)?.status === "cancelled") return;
        await this.executeRun(run);
        this.refreshExperiment(experimentId);
      }
    });
    await Promise.all(workers);
    this.refreshExperiment(experimentId);
  }

  private async executeRun(run: ExperimentRunRecord): Promise<void> {
    const loaded = this.catalog.get(run.caseKey);
    if (!loaded) {
      this.finishRunError(run, "CASE_NOT_FOUND", "评测 case 不存在");
      return;
    }
    const manifest = loaded.manifest;
    const startedAt = this.now().toISOString();
    this.store.updateRun(run.id, { status: "created", startedAt, updatedAt: startedAt });
    this.store.appendEvent("run.created", {
      experimentId: run.experimentId,
      runId: run.id,
      payload: { caseKey: run.caseKey, executorId: run.executorId, repetition: run.repetition }
    });
    try {
      const created = await this.client.createTask(this.buildTaskRequest(run, loaded));
      run.hearthTaskId = created.task.id;
      this.store.updateRun(run.id, { status: "running", hearthTaskId: created.task.id, updatedAt: this.now().toISOString() });
      this.store.appendEvent("run.task-created", {
        experimentId: run.experimentId,
        runId: run.id,
        payload: { hearthTaskId: created.task.id, created: created.created }
      });
      const wait = await this.waitForTask({ ...run, hearthTaskId: created.task.id }, manifest);
      this.store.updateRun(run.id, { status: "grading", updatedAt: this.now().toISOString() });
      this.store.appendEvent("run.grading", {
        experimentId: run.experimentId,
        runId: run.id,
        payload: { taskStatus: wait.status }
      });
      const artifacts = this.readArtifacts(run);
      const graded = await this.gradeRun(run, manifest, artifacts, wait);
      this.store.setRunMetrics(run.id, metricsFromView(wait.view));
      const finishedAt = this.now().toISOString();
      const runFailed = wait.status !== "completed";
      const status = runStatusFor(wait, graded, runFailed);
      this.store.updateRun(run.id, {
        status,
        score: graded.outcome.score,
        reviewReasons: graded.outcome.reviewReasons,
        error: runError(wait, graded),
        finishedAt,
        updatedAt: finishedAt
      });
      this.store.appendEvent("run.finished", {
        experimentId: run.experimentId,
        runId: run.id,
        payload: {
          status,
          score: graded.outcome.score,
          verdict: graded.outcome.verdict,
          reviewReasons: graded.outcome.reviewReasons,
          taskStatus: wait.status
        }
      });
    } catch (error) {
      this.finishRunError(run, "RUN_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  private buildTaskRequest(run: ExperimentRunRecord, loaded: LoadedCase) {
    const manifest = loaded.manifest;
    const experiment = this.store.getExperiment(run.experimentId);
    const runMode = experiment?.config.runMode ?? "offline";
    const inputs = (runMode === "live" ? manifest.liveInputs ?? manifest.inputs : manifest.inputs)
      .map((input) => this.toTaskInput(loaded, input));
    return {
      externalRef: run.externalRef,
      title: `${manifest.id} · ${manifest.title}`,
      goal: manifest.goal,
      inputs,
      expectedOutputs: manifest.expectedOutputs,
      executorId: run.executorId,
      runMode,
      networkHosts: runMode === "live" ? manifest.networkHosts ?? [] : [],
      outputDir: run.outputDir,
      timeoutMs: manifest.timeoutMs
    };
  }

  private toTaskInput(loaded: LoadedCase, input: EvalInput): { kind: "file" | "url"; label: string; value: string } {
    if (input.kind === "url") return { kind: "url", label: input.label, value: input.value ?? "" };
    const value = input.path ?? input.value ?? "";
    const absolute = resolveCaseInput(this.repoRoot, loaded.directory, value);
    return { kind: "file", label: input.label, value: relativePath(this.repoRoot, absolute) };
  }

  private async waitForTask(run: ExperimentRunRecord, manifest: CaseManifest): Promise<TaskWaitResult> {
    if (!run.hearthTaskId) throw new Error("评测运行缺少 Hearth 任务 ID");
    const deadline = Date.now() + manifest.timeoutMs + 120_000;
    let last: HearthTaskView | null = null;
    let waiting = false;
    while (Date.now() < deadline) {
      const view = await this.client.getTask(run.hearthTaskId);
      last = view;
      const status = view.task.status;
      if (isTerminalTaskStatus(status)) return { status, task: view.task, view, timedOut: false };
      if (status === "waiting_approval" && !waiting) {
        waiting = true;
        this.store.updateRun(run.id, { status: "waiting", error: "任务正在等待人工审批或输入", updatedAt: this.now().toISOString() });
        this.store.appendEvent("run.waiting", { experimentId: run.experimentId, runId: run.id, payload: { status } });
      }
      await this.sleep(this.pollIntervalMs);
    }
    const task = last?.task ?? { id: run.hearthTaskId, status: "running" };
    return { status: "timeout", task, view: last, timedOut: true };
  }

  private async gradeRun(run: ExperimentRunRecord, manifest: CaseManifest, artifacts: ArtifactMap, wait: TaskWaitResult): Promise<GradeResult> {
    const deterministic: Record<string, GraderOutcome> = {};
    const graderRecords: GraderResultRecord[] = [];
    const createdAt = this.now().toISOString();
    for (const criterion of manifest.criteria.filter((item) => item.source === "deterministic")) {
      const grader = manifest.graders.find((item) => item.id === criterion.graderId);
      let result: GraderOutcome;
      if (!grader) {
        result = { passed: false, reason: `缺少 grader：${criterion.graderId}`, evidence: [] };
      } else {
        try {
          result = runGrader(grader, artifacts);
        } catch (error) {
          result = { passed: false, reason: error instanceof Error ? error.message : String(error), evidence: [] };
        }
      }
      deterministic[criterion.id] = result;
      graderRecords.push({
        id: randomUUID(),
        runId: run.id,
        criterionId: criterion.id,
        source: "deterministic",
        passed: result.passed,
        score: result.passed ? 100 : 0,
        confidence: null,
        reason: result.reason,
        evidence: result.evidence,
        model: null,
        promptHash: null,
        createdAt
      });
    }

    const experiment = this.store.getExperiment(run.experimentId);
    const judgeCriteria = manifest.criteria.filter((item) => item.source === "judge");
    const judgeExpected = experiment?.config.autoJudge === true && judgeCriteria.length > 0;
    let judge: JudgeOutcome | null = null;
    if (judgeExpected) {
      const response = await this.requestJudge(run, manifest, deterministic, experiment?.config.autoRetry === true);
      if (response) {
        judge = {
          criteria: Object.fromEntries(response.criteria.map((item) => [item.id, {
            passed: item.passed,
            confidence: item.confidence,
            reason: item.reason
          }])) as JudgeOutcome["criteria"],
          overallConfidence: response.overallConfidence
        };
        for (const criterion of judgeCriteria) {
          const item = response.criteria.find((candidate) => candidate.id === criterion.id);
          if (!item) continue;
          graderRecords.push(judgeRecord(run.id, criterion.id, item, response.model, response.promptHash, createdAt));
        }
      } else {
        this.store.appendEvent("run.judge-unavailable", { experimentId: run.experimentId, runId: run.id });
      }
    }
    this.store.replaceGraderResults(run.id, graderRecords);
    const outcome = scoreRun({
      manifest,
      deterministic,
      judge,
      judgeExpected,
      humanDecision: null,
      reviewReasonSeed: run.id,
      runFailed: wait.status !== "completed",
      sampleRate: manifest.humanReview.sampleRate
    });
    return { graderRecords, deterministic, judge, judgeExpected, outcome };
  }

  private async requestJudge(
    run: ExperimentRunRecord,
    manifest: CaseManifest,
    deterministic: Record<string, GraderOutcome>,
    autoRetry: boolean
  ): Promise<{ criteria: JudgeCriterionResult[]; overallConfidence: number; model: string; promptHash: string } | null> {
    if (!run.hearthTaskId) return null;
    const criteria = manifest.criteria.filter((item) => item.source === "judge").map((criterion) => ({
      id: criterion.id,
      label: criterion.label,
      rubric: criterion.rubric ?? criterion.label,
      points: criterion.points
    }));
    const attempts = autoRetry ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.client.judge({
          taskId: run.hearthTaskId,
          criteria,
          deterministic: manifest.criteria
            .filter((item) => item.source === "deterministic")
            .map((criterion) => ({
              criterionId: criterion.id,
              passed: deterministic[criterion.id]?.passed === true,
              reason: deterministic[criterion.id]?.reason ?? "未执行"
            }))
        });
      } catch (error) {
        if (attempt + 1 >= attempts) return null;
        this.store.appendEvent("run.judge-retry", {
          experimentId: run.experimentId,
          runId: run.id,
          payload: { error: error instanceof Error ? error.message : String(error) }
        });
      }
    }
    return null;
  }

  private readArtifacts(run: ExperimentRunRecord): ArtifactMap {
    const root = resolve(this.repoRoot, run.outputDir);
    if (!isPathInside(this.artifactRoot, root)) throw new Error(`评测产物目录越界：${run.outputDir}`);
    const artifacts: ArtifactMap = {};
    if (!existsSync(root)) return artifacts;
    walkArtifacts(root, root, artifacts, 0);
    return artifacts;
  }

  private finishRunError(run: ExperimentRunRecord, code: string, message: string): void {
    const finishedAt = this.now().toISOString();
    this.store.updateRun(run.id, {
      status: "error",
      error: `${code}: ${message}`,
      reviewReasons: ["failed_sample"],
      finishedAt,
      updatedAt: finishedAt
    });
    this.store.appendEvent("run.error", {
      experimentId: run.experimentId,
      runId: run.id,
      payload: { code, message }
    });
    this.refreshExperiment(run.experimentId);
  }
}

function supportsRunMode(manifest: CaseManifest, mode: "offline" | "live"): boolean {
  return mode === "offline"
    ? manifest.runModes.some((item) => item !== "live-only")
    : manifest.runModes.some((item) => item === "live-only" || item === "live-optional");
}

function runStatusFor(wait: TaskWaitResult, graded: GradeResult, runFailed: boolean): ExperimentRunStatus {
  if (wait.status === "cancelled") return "cancelled";
  if (wait.timedOut) return "blocked";
  if (graded.outcome.verdict === "needs_review") return "needs_review";
  if (graded.outcome.verdict === "failed" || runFailed) return "failed";
  return "passed";
}

function runError(wait: TaskWaitResult, graded: GradeResult): string | null {
  if (wait.timedOut) return "TASK_TIMEOUT: 任务在评测超时前未结束";
  const taskError = wait.task.error?.message;
  if (wait.status !== "completed") return taskError ? `${wait.status}: ${taskError}` : `任务状态：${wait.status}`;
  if (graded.outcome.blockerFailures.length > 0) return `BLOCKER_FAILED: ${graded.outcome.blockerFailures.join(", ")}`;
  return null;
}

function judgeRecord(
  runId: string,
  criterionId: string,
  result: JudgeCriterionResult,
  model: string,
  promptHash: string,
  createdAt: string
): GraderResultRecord {
  return {
    id: randomUUID(),
    runId,
    criterionId,
    source: "judge",
    passed: result.passed,
    score: result.passed ? 100 : 0,
    confidence: result.confidence,
    reason: result.reason,
    evidence: result.evidence,
    model,
    promptHash,
    createdAt
  };
}

function deterministicFromRecords(records: GraderResultRecord[]): Record<string, GraderOutcome> {
  return Object.fromEntries(records
    .filter((record) => record.source === "deterministic")
    .map((record) => [record.criterionId, { passed: record.passed === true, reason: record.reason, evidence: record.evidence }]));
}

function judgeFromRecords(records: GraderResultRecord[]): JudgeOutcome | null {
  const judgeRecords = records.filter((record) => record.source === "judge");
  if (judgeRecords.length === 0) return null;
  const criteria = Object.fromEntries(judgeRecords.map((record) => [record.criterionId, {
    passed: record.passed === true,
    confidence: record.confidence ?? 0,
    reason: record.reason
  }]));
  return {
    criteria,
    overallConfidence: judgeRecords.reduce((sum, record) => sum + (record.confidence ?? 0), 0) / judgeRecords.length
  };
}

function metricsFromView(view: HearthTaskView | null): RunMetrics {
  const runs = view?.runs ?? [];
  return {
    inputTokens: runs.reduce((sum, run) => sum + (run.usage?.inputTokens ?? 0), 0),
    outputTokens: runs.reduce((sum, run) => sum + (run.usage?.outputTokens ?? 0), 0),
    retryCount: runs.reduce((sum, run) => sum + Math.max(0, run.attempt - 1), 0),
    approvalCount: view?.approvals?.length ?? 0
  };
}

function diagnosticGroups(runs: ExperimentRunRecord[]): ExperimentSummary["failureDiagnostics"] {
  const groups = new Map<string, string[]>();
  for (const run of runs) {
    if (!["failed", "blocked", "error"].includes(run.status)) continue;
    const kind = run.error?.split(":")[0]?.trim() || run.status;
    const ids = groups.get(kind) ?? [];
    ids.push(run.id);
    groups.set(kind, ids);
  }
  return [...groups.entries()].map(([kind, runIds]) => ({ kind, count: runIds.length, runIds }));
}

function walkArtifacts(root: string, directory: string, artifacts: ArtifactMap, depth: number): void {
  if (depth > 12 || Object.keys(artifacts).length >= 1_000) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walkArtifacts(root, absolute, artifacts, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    const stats = statSync(absolute);
    if (stats.size > 20 * 1024 * 1024) continue;
    const relative = absolute.slice(root.length + 1).replace(/\\/g, "/");
    const mimeType = mimeFor(relative);
    const text = isTextMime(mimeType) ? readFileSync(absolute, "utf8") : "";
    artifacts[relative] = { text, bytes: stats.size, mimeType };
  }
}

function mimeFor(path: string): string {
  const extension = extname(path).toLowerCase();
  if ([".md", ".markdown", ".txt", ".html", ".htm", ".css", ".js", ".ts", ".json", ".csv", ".yaml", ".yml"].includes(extension)) {
    return extension === ".md" || extension === ".markdown"
      ? "text/markdown"
      : extension === ".json"
        ? "application/json"
        : "text/plain";
  }
  return "application/octet-stream";
}

function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json";
}

function relativePath(root: string, absolute: string): string {
  return absolute.slice(resolve(root).length + 1).replace(/\\/g, "/");
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root).replace(/[\\/]+$/, "");
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}\\`) || candidate.startsWith(`${normalizedRoot}/`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
