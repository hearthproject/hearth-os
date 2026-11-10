import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadCaseCatalog } from "@hearth/eval-core/node";
import { HearthClient } from "./hearth-client.ts";
import { EvalRunner } from "./runner.ts";
import { EvalStore } from "./store.ts";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

describe("EvalRunner", () => {
  it("runs one offline case through task creation, grading, judging, and summary", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-eval-runner-"));
    const workspace = await fixture(root);
    const store = new EvalStore(":memory:");
    cleanup.push(() => store.close());
    const loaded = loadCaseCatalog(root);
    expect(loaded.issues).toEqual([]);
    const catalog = new Map(loaded.cases.map((item) => [item.manifest.id, item]));
    store.syncCases(loaded.cases);
    const runner = new EvalRunner({
      store,
      client: new HearthClient({ baseUrl: workspace.url }),
      repoRoot: root,
      artifactRoot: join(root, ".hearth", "eval-artifacts"),
      catalog,
      evalVersion: "test",
      pollIntervalMs: 5
    });
    const environment = await runner.collectEnvironment("judge-model");
    const experiment = runner.createExperiment({
      name: "runner-test",
      caseIds: ["TEST01"],
      executorIds: ["codex"],
      repetitions: 1,
      runMode: "offline",
      autoJudge: true,
      autoRetry: true,
      maxConcurrency: 1
    }, environment);
    runner.start(experiment.id);
    const finished = await waitFor(() => store.getExperiment(experiment.id)?.status === "completed" || store.getExperiment(experiment.id)?.status === "needs_review");
    expect(finished).toBe(true);
    const run = store.listRuns(experiment.id)[0];
    expect(run?.status).toBe("passed");
    expect(run?.score).toBe(100);
    expect(store.listGraderResults(run?.id ?? "").map((item) => item.source)).toEqual(["deterministic", "deterministic", "judge"]);
    expect(store.getRunMetrics(run?.id ?? "")).toEqual({ inputTokens: 42, outputTokens: 7, retryCount: 0, approvalCount: 1 });
    expect(store.getExperiment(experiment.id)?.summary).toMatchObject({ totalRuns: 1, passed: 1, passRate: 100, avgScore: 100 });
    expect(store.listEvents({ experimentId: experiment.id }).map((event) => event.type)).toContain("run.finished");
  });

  it("keeps sampled runs in the human review queue", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-eval-review-"));
    const workspace = await fixture(root, { sampleRate: 1 });
    const store = new EvalStore(":memory:");
    cleanup.push(() => store.close());
    const loaded = loadCaseCatalog(root);
    const catalog = new Map(loaded.cases.map((item) => [item.manifest.id, item]));
    store.syncCases(loaded.cases);
    const runner = new EvalRunner({
      store,
      client: new HearthClient({ baseUrl: workspace.url }),
      repoRoot: root,
      artifactRoot: join(root, ".hearth", "eval-artifacts"),
      catalog,
      evalVersion: "test",
      pollIntervalMs: 5
    });
    const experiment = runner.createExperiment({
      caseIds: ["TEST01"], executorIds: ["codex"], repetitions: 1, runMode: "offline",
      autoJudge: true, autoRetry: true, maxConcurrency: 1
    }, await runner.collectEnvironment("judge-model"));
    runner.start(experiment.id);
    await waitFor(() => store.getExperiment(experiment.id)?.status === "needs_review");
    const run = store.listRuns(experiment.id)[0];
    expect(run?.status).toBe("needs_review");
    expect(run?.reviewReasons).toContain("sampled");
    runner.review(run?.id ?? "", "pass", "owner", "人工确认");
    expect(store.getRun(run?.id ?? "")?.status).toBe("passed");
    expect(store.getHumanReview(run?.id ?? "")?.decision).toBe("pass");
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

async function fixture(root: string, options: { sampleRate?: number } = {}) {
  const caseDir = join(root, "eval", "cases", "TEST01");
  mkdirSync(join(caseDir, "golden"), { recursive: true });
  writeFileSync(join(caseDir, "input.md"), "input", "utf8");
  writeFileSync(join(caseDir, "golden", "result.md"), "# Result\n\ncomplete", "utf8");
  const manifest = {
    schemaVersion: 1,
    id: "TEST01",
    version: 1,
    title: "测试评测",
    family: "documents",
    difficulty: "normal",
    runModes: ["offline"],
    description: "test",
    goal: "生成结果",
    tags: ["test"],
    timeoutMs: 30_000,
    inputs: [{ kind: "file", label: "输入", path: "input.md" }],
    expectedOutputs: ["result.md"],
    graders: [
      { id: "file", title: "文件", config: { kind: "file", path: "result.md", minBytes: 5 } },
      { id: "text", title: "内容", config: { kind: "text", path: "result.md", includes: ["complete"] } }
    ],
    criteria: [
      { id: "exists", label: "存在", source: "deterministic", points: 30, severity: "blocker", graderId: "file" },
      { id: "content", label: "内容", source: "deterministic", points: 30, severity: "scored", graderId: "text" },
      { id: "quality", label: "质量", source: "judge", points: 30, severity: "scored", rubric: "完整" },
      { id: "human", label: "复核", source: "human", points: 10, severity: "scored" }
    ],
    humanReview: { prompt: "检查", sampleRate: options.sampleRate ?? 0 }
  };
  writeFileSync(join(caseDir, "case.json"), JSON.stringify(manifest, null, 2), "utf8");

  const app = Fastify();
  app.post("/api/eval/tasks", async (request) => {
    const body = request.body as { outputDir: string };
    const target = join(root, body.outputDir, "result.md");
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(join(caseDir, "golden", "result.md"), target);
    return { task: { id: "task-1", status: "completed", outputDir: body.outputDir }, created: true };
  });
  app.get("/api/tasks/:id", async () => ({
    task: { id: "task-1", status: "completed", error: null },
    runs: [{ attempt: 1, status: "completed", usage: { inputTokens: 42, outputTokens: 7 } }],
    approvals: [{ id: "approval-1" }]
  }));
  app.post("/api/eval/judge", async () => ({
    model: "judge-model",
    promptHash: "b".repeat(64),
    criteria: [{ id: "quality", passed: true, confidence: 0.92, reason: "完整", evidence: ["complete"] }],
    overallConfidence: 0.92,
    usage: { inputTokens: 10, outputTokens: 5 }
  }));
  app.get("/api/health", async () => ({ now: new Date().toISOString(), schemaVersion: 1, instanceId: "fake" }));
  app.post("/api/tasks/:id/cancel", async () => ({ ok: true }));
  await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => app.close());
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("fake server has no port");
  return { url: `http://127.0.0.1:${address.port}` };
}
