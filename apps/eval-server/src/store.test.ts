import { fileURLToPath } from "node:url";
import { requireCaseCatalog } from "@hearth/eval-core/node";
import type { ExperimentRecord, ExperimentRunRecord, GraderResultRecord } from "@hearth/eval-core";
import { describe, expect, it } from "vitest";
import { EvalStore } from "./store.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("EvalStore", () => {
  it("stores case versions, experiments, runs, graders, reviews, and events", () => {
    const store = new EvalStore(":memory:");
    try {
      const cases = requireCaseCatalog(repoRoot).slice(0, 3);
      store.syncCases(cases);
      expect(store.listCases()).toHaveLength(3);
      expect(store.getCase(cases[0]?.manifest.id ?? "")?.manifest.criteria.length).toBeGreaterThan(0);

      const experiment = makeExperiment(cases[0]?.manifest.id ?? "E01");
      store.createExperiment(experiment);
      const run = makeRun(experiment.id, cases[0]?.manifest.id ?? "E01");
      store.createRuns([run]);
      expect(store.listRuns(experiment.id)).toHaveLength(1);
      expect(store.getRunByExternalRef(run.externalRef)?.id).toBe(run.id);

      store.updateRun(run.id, { status: "needs_review", score: 86, reviewReasons: ["low_confidence"] });
      store.setRunMetrics(run.id, { inputTokens: 120, outputTokens: 30, retryCount: 1, approvalCount: 2 });
      expect(store.getRunMetrics(run.id)).toEqual({ inputTokens: 120, outputTokens: 30, retryCount: 1, approvalCount: 2 });
      expect(store.countPendingReviews()).toBe(1);

      const grader: GraderResultRecord = {
        id: "grader-1",
        runId: run.id,
        criterionId: "criterion",
        source: "deterministic",
        passed: true,
        score: 100,
        confidence: null,
        reason: "ok",
        evidence: ["file"],
        model: null,
        promptHash: null,
        createdAt: new Date().toISOString()
      };
      store.replaceGraderResults(run.id, [grader]);
      expect(store.listGraderResults(run.id)).toHaveLength(1);

      store.upsertHumanReview({
        id: "review-1", runId: run.id, reviewer: "owner", decision: "pass", score: 100,
        note: "checked", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      });
      expect(store.countPendingReviews()).toBe(0);
      expect(store.getHumanReview(run.id)?.decision).toBe("pass");

      const failedRun = { ...makeRun(experiment.id, cases[0]?.manifest.id ?? "E01", "failed"), id: "run-failed", externalRef: "exp:failed" };
      store.createRuns([failedRun]);
      expect(store.listPendingReviewRuns().map((item) => item.id)).toEqual([failedRun.id]);
      store.upsertHumanReview({
        id: "review-2", runId: failedRun.id, reviewer: "owner", decision: "fail", score: 0,
        note: "confirmed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      });
      expect(store.countPendingReviews()).toBe(0);

      const event = store.appendEvent("run.updated", { experimentId: experiment.id, runId: run.id, payload: { status: "needs_review" } });
      expect(store.listEvents({ afterSeq: event.seq - 1 })).toEqual([event]);
    } finally {
      store.close();
    }
  });

  it("marks interrupted work for review after restart", () => {
    const store = new EvalStore(":memory:");
    try {
      const experiment = makeExperiment("E01");
      store.createExperiment(experiment);
      const run = makeRun(experiment.id, "E01", "running");
      store.createRuns([run]);
      expect(store.recoverInterrupted()).toBe(1);
      expect(store.getRun(run.id)?.status).toBe("error");
      expect(store.getExperiment(experiment.id)?.status).toBe("needs_review");
      expect(store.listEvents().at(-1)?.type).toBe("system.recovered");
    } finally {
      store.close();
    }
  });
});

function makeExperiment(caseKey: string): ExperimentRecord {
  const now = new Date().toISOString();
  return {
    id: "experiment-1",
    name: "Baseline",
    status: "queued",
    config: {
      name: "Baseline",
      caseIds: [caseKey],
      executorIds: ["codex"],
      repetitions: 1,
      runMode: "offline",
      autoJudge: true,
      autoRetry: true,
      maxConcurrency: 1,
      baselineExperimentId: null
    },
    environment: {
      hearthUrl: "http://127.0.0.1:4317",
      hearthNow: now,
      schemaVersion: 14,
      instanceId: "instance",
      executorSettings: {},
      judgeModel: "judge-model",
      evalVersion: "0.1.0"
    },
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    summary: null
  };
}

function makeRun(experimentId: string, caseKey: string, status: ExperimentRunRecord["status"] = "queued"): ExperimentRunRecord {
  const now = new Date().toISOString();
  return {
    id: "run-1",
    experimentId,
    caseKey,
    caseVersion: 1,
    caseContentHash: "a".repeat(64),
    executorId: "codex",
    repetition: 1,
    status,
    hearthTaskId: null,
    outputDir: `.hearth/eval-artifacts/${experimentId}/${caseKey}/r1`,
    externalRef: `${experimentId}:${caseKey}:codex:r1`,
    attempt: 1,
    startedAt: null,
    finishedAt: null,
    score: null,
    error: null,
    reviewReasons: [],
    createdAt: now,
    updatedAt: now
  };
}
