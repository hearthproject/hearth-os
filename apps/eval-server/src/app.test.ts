import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireCaseCatalog } from "@hearth/eval-core/node";
import type {
  CreateExperimentRequest,
  ExperimentEnvironment,
  ExperimentRecord,
  ExperimentRunRecord,
  ExperimentSummary,
  GraderResultRecord,
  HumanReviewRecord
} from "@hearth/eval-core";
import { afterEach, describe, expect, it } from "vitest";
import { buildEvalApp } from "./app.ts";
import type { HearthClient } from "./hearth-client.ts";
import type { EvalRunner } from "./runner.ts";
import { EvalStore } from "./store.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe("eval control plane", () => {
  it("serves the catalog, experiment lifecycle, reviews, comparison, and events", async () => {
    const harness = await createHarness();
    const catalog = harness.catalog;
    const first = catalog[0]!;
    const second = catalog[1]!;

    const health = await harness.app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, service: "hearth-eval", cases: 2 });

    const dashboard = await harness.app.inject({ method: "GET", url: "/api/dashboard" });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json()).toMatchObject({
      pendingReviews: 1,
      runningExperiments: 0,
      catalog: { cases: expect.arrayContaining([expect.objectContaining({ caseKey: first.manifest.id })]) },
      system: { hearthReachable: true, judgeConfigured: true, executors: [expect.objectContaining({ id: "codex", canRun: true })] }
    });

    const filtered = await harness.app.inject({ method: "GET", url: `/api/cases?family=${first.manifest.family}` });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().cases.every((item: { family: string }) => item.family === first.manifest.family)).toBe(true);

    const detail = await harness.app.inject({ method: "GET", url: `/api/cases/${first.manifest.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      case: { caseKey: first.manifest.id },
      manifest: { id: first.manifest.id, criteria: expect.any(Array) },
      hasGolden: expect.any(Boolean)
    });
    expect((await harness.app.inject({ method: "GET", url: "/api/cases/DOES-NOT-EXIST" })).statusCode).toBe(404);

    const experiments = await harness.app.inject({ method: "GET", url: "/api/experiments" });
    expect(experiments.statusCode).toBe(200);
    expect(experiments.json().experiments).toHaveLength(2);

    const experiment = await harness.app.inject({ method: "GET", url: `/api/experiments/${harness.experiment.id}` });
    expect(experiment.statusCode).toBe(200);
    expect(experiment.json()).toMatchObject({ experiment: { id: harness.experiment.id }, summary: harness.summary });
    expect(experiment.json().runs).toHaveLength(2);
    expect(experiment.json().events.length).toBeGreaterThan(0);

    const run = await harness.app.inject({ method: "GET", url: `/api/runs/${harness.passedRun.id}` });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({
      run: { id: harness.passedRun.id, status: "passed" },
      case: { caseKey: first.manifest.id },
      graders: [expect.objectContaining({ criterionId: "quality", source: "deterministic" })],
      artifacts: [expect.objectContaining({ path: "result.md", preview: "# Result\n\ncomplete" })],
      hearthTask: { task: { id: "task-1" } }
    });
    expect((await harness.app.inject({ method: "GET", url: "/api/runs/missing" })).statusCode).toBe(404);

    const reviews = await harness.app.inject({ method: "GET", url: "/api/reviews" });
    expect(reviews.statusCode).toBe(200);
    expect(reviews.json().reviews).toEqual([
      expect.objectContaining({ run: expect.objectContaining({ id: harness.reviewRun.id }), reasons: ["low_confidence"] })
    ]);

    const review = await harness.app.inject({
      method: "POST",
      url: `/api/runs/${harness.reviewRun.id}/review`,
      payload: { decision: "pass", reviewer: "owner", note: "人工确认" }
    });
    expect(review.statusCode).toBe(200);
    expect(review.json()).toMatchObject({
      review: { runId: harness.reviewRun.id, decision: "pass", reviewer: "owner" },
      run: { status: "passed" }
    });
    expect((await harness.app.inject({ method: "GET", url: "/api/reviews" })).json().reviews).toEqual([]);

    const compare = await harness.app.inject({
      method: "GET",
      url: `/api/compare?left=${harness.experiment.id}&right=${harness.otherExperiment.id}`
    });
    expect(compare.statusCode).toBe(200);
    expect(compare.json()).toMatchObject({
      leftExperimentId: harness.experiment.id,
      rightExperimentId: harness.otherExperiment.id,
      aligned: true,
      familyDeltas: expect.any(Array)
    });
    expect(compare.json().familyDeltas).toHaveLength(8);
    expect((await harness.app.inject({ method: "GET", url: "/api/compare?left=" })).statusCode).toBe(400);

    const events = await harness.app.inject({ method: "GET", url: `/api/events?experimentId=${harness.experiment.id}&limit=10` });
    expect(events.statusCode).toBe(200);
    expect(events.json().events[0]).toMatchObject({ experimentId: harness.experiment.id, type: "experiment.created" });
    expect((await harness.app.inject({ method: "GET", url: "/api/events?limit=0" })).statusCode).toBe(400);

    expect(second.manifest.id).not.toBe(first.manifest.id);
  });

  it("previews run artifacts and confines them to the configured artifact root", async () => {
    const harness = await createHarness();
    const artifactUrl = `/api/runs/${harness.passedRun.id}/artifacts/result.md`;

    const preview = await harness.app.inject({ method: "GET", url: artifactUrl });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ path: "result.md", mimeType: "text/markdown", preview: "# Result\n\ncomplete" });

    const outside = await harness.app.inject({
      method: "GET",
      url: `/api/runs/${harness.passedRun.id}/artifacts/${encodeURIComponent("../../../../secret.txt")}`
    });
    expect(outside.statusCode).toBe(403);
    expect(outside.json()).toMatchObject({ error: "ARTIFACT_PATH_DENIED" });

    expect((await harness.app.inject({ method: "GET", url: `/api/runs/${harness.passedRun.id}/artifacts/missing.md` })).statusCode).toBe(404);
    expect((await harness.app.inject({ method: "GET", url: "/api/unknown" })).statusCode).toBe(404);
  });

  it("serves the SPA fallback without swallowing API missing routes", async () => {
    const harness = await createHarness();
    const page = await harness.app.inject({ method: "GET", url: "/experiments/example" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("Hearth Evaluation Console");

    const missing = await harness.app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).toContain("application/json");
  });
});

async function createHarness() {
  const root = mkdtempSync(join(tmpdir(), "hearth-eval-app-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new EvalStore(":memory:");
  cleanup.push(() => store.close());
  const catalog = requireCaseCatalog(repoRoot).slice(0, 2);
  store.syncCases(catalog);
  const first = catalog[0]!;
  const second = catalog[1]!;
  const summary = makeSummary(first.manifest.family, first.manifest.id);
  const otherSummary = makeSummary(first.manifest.family, first.manifest.id, 100, 100);
  const experiment = makeExperiment("EXP-LEFT", [first.manifest.id, second.manifest.id], summary);
  const otherExperiment = makeExperiment("EXP-RIGHT", [first.manifest.id, second.manifest.id], otherSummary);
  store.createExperiment(experiment);
  store.createExperiment(otherExperiment);

  const passedRun = makeRun(experiment, first, "passed");
  const reviewRun = makeRun(experiment, second, "needs_review", ["low_confidence"]);
  reviewRun.score = 71;
  store.createRuns([passedRun, reviewRun]);
  store.updateRun(passedRun.id, { hearthTaskId: "task-1", score: 92 });

  const grader: GraderResultRecord = {
    id: "grader-1",
    runId: passedRun.id,
    criterionId: "quality",
    source: "deterministic",
    passed: true,
    score: 100,
    confidence: null,
    reason: "内容完整",
    evidence: ["result.md"],
    model: null,
    promptHash: null,
    createdAt: new Date().toISOString()
  };
  store.replaceGraderResults(passedRun.id, [grader]);
  store.appendEvent("experiment.created", { experimentId: experiment.id, payload: { runs: 2 } });
  store.appendEvent("run.finished", { experimentId: experiment.id, runId: passedRun.id, payload: { status: "passed" } });

  const artifactRoot = join(root, ".hearth", "eval-artifacts");
  mkdirSync(join(root, passedRun.outputDir), { recursive: true });
  writeFileSync(join(root, passedRun.outputDir, "result.md"), "# Result\n\ncomplete", "utf8");
  writeFileSync(join(root, "secret.txt"), "do not expose", "utf8");
  const webDist = join(root, "web-dist");
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<!doctype html><title>Hearth Evaluation Console</title>", "utf8");

  const runner = {
    collectEnvironment: async () => experiment.environment,
    createExperiment: (request: CreateExperimentRequest, environment: ExperimentEnvironment) => {
      const created = makeExperiment("EXP-NEW", request.caseIds, null, environment);
      store.createExperiment(created);
      return created;
    },
    start: () => undefined,
    cancel: (id: string) => store.getExperiment(id),
    summarize: (id: string) => store.getExperiment(id)?.summary ?? null,
    review: (runId: string, decision: "pass" | "fail" | "unknown", reviewer = "local", note = "") => {
      const now = new Date().toISOString();
      const record: HumanReviewRecord = {
        id: `review-${runId}`,
        runId,
        reviewer,
        decision,
        score: decision === "pass" ? 92 : decision === "fail" ? 0 : null,
        note,
        createdAt: now,
        updatedAt: now
      };
      store.upsertHumanReview(record);
      store.updateRun(runId, { status: decision === "pass" ? "passed" : decision === "fail" ? "failed" : "needs_review", finishedAt: now, updatedAt: now });
      return record;
    }
  } as unknown as EvalRunner;

  const client = {
    baseUrl: "http://127.0.0.1:4317",
    health: async () => ({
      status: "ok",
      now: new Date().toISOString(),
      schemaVersion: 14,
      instanceId: "test-instance",
      chatModel: { configured: true, settings: { model: "judge-model" } }
    }),
    executors: async () => ({
      executors: [{ id: "codex", name: "Codex", description: "local executor", capabilities: ["files"], health: { canRun: true, version: "1.0.0" } }]
    }),
    getTask: async (id: string) => ({ task: { id, status: "completed" } })
  } as unknown as HearthClient;

  const app = await buildEvalApp({
    store,
    runner,
    client,
    catalog: new Map(catalog.map((item) => [item.manifest.id, item])),
    catalogIssues: 0,
    repoRoot: root,
    artifactRoot,
    dataDir: join(root, "data"),
    evalVersion: "test",
    webDist
  });
  cleanup.push(() => app.close());

  return { app, store, catalog, summary, experiment, otherExperiment, passedRun, reviewRun };
}

function makeExperiment(
  id: string,
  caseIds: string[],
  summary: ExperimentSummary | null,
  environment = makeEnvironment()
): ExperimentRecord {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    status: "completed",
    config: {
      name: id,
      caseIds,
      executorIds: ["codex"],
      repetitions: 1,
      runMode: "offline",
      autoJudge: true,
      autoRetry: true,
      maxConcurrency: 1,
      baselineExperimentId: null
    },
    environment,
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    summary
  };
}

function makeEnvironment(): ExperimentEnvironment {
  return {
    hearthUrl: "http://127.0.0.1:4317",
    hearthNow: new Date().toISOString(),
    schemaVersion: 14,
    instanceId: "test-instance",
    executorSettings: {},
    judgeModel: "judge-model",
    evalVersion: "test"
  };
}

function makeRun(
  experiment: ExperimentRecord,
  loaded: { manifest: { id: string; version: number }; contentHash: string },
  status: ExperimentRunRecord["status"],
  reviewReasons: ExperimentRunRecord["reviewReasons"] = []
): ExperimentRunRecord {
  const now = new Date().toISOString();
  const caseKey = loaded.manifest.id;
  return {
    id: `run-${experiment.id}-${caseKey}`,
    experimentId: experiment.id,
    caseKey,
    caseVersion: loaded.manifest.version,
    caseContentHash: loaded.contentHash,
    executorId: "codex",
    repetition: 1,
    status,
    hearthTaskId: null,
    outputDir: `.hearth/eval-artifacts/${experiment.id}/${caseKey}/codex/r1`,
    externalRef: `eval:${experiment.id}:${caseKey}:codex:r1`,
    attempt: 1,
    startedAt: now,
    finishedAt: now,
    score: status === "passed" ? 92 : null,
    error: null,
    reviewReasons,
    createdAt: now,
    updatedAt: now
  };
}

function makeSummary(family: ExperimentSummary["families"][number]["family"], caseKey: string, passRate = 100, avgScore = 92): ExperimentSummary {
  return {
    experimentId: "EXP-LEFT",
    totalRuns: 2,
    passed: 1,
    failed: 0,
    blocked: 0,
    needsReview: 1,
    passRate,
    avgScore,
    avgDurationMs: 1200,
    inputTokens: 100,
    outputTokens: 50,
    retries: 0,
    approvals: 1,
    families: [{
      family,
      total: 1,
      passed: 1,
      failed: 0,
      blocked: 0,
      needsReview: 0,
      passRate,
      avgScore
    }],
    failureDiagnostics: [],
    generatedAt: new Date().toISOString()
  };
}
