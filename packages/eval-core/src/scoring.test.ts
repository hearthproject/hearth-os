import { describe, expect, it } from "vitest";
import type { CaseManifest } from "./types.ts";
import { scoreRun, shouldSample } from "./scoring.ts";

const manifest: CaseManifest = {
  schemaVersion: 1,
  id: "TEST-01",
  version: 1,
  title: "测试任务",
  family: "documents",
  difficulty: "normal",
  runModes: ["offline"],
  description: "测试",
  goal: "生成结果",
  tags: [],
  timeoutMs: 30_000,
  inputs: [{ kind: "file", label: "输入", path: "input.md" }],
  expectedOutputs: ["result.md"],
  graders: [{ id: "file", title: "文件", config: { kind: "file", path: "result.md" } }],
  criteria: [
    { id: "blocker", label: "文件存在", source: "deterministic", points: 30, severity: "blocker", graderId: "file" },
    { id: "content", label: "内容正确", source: "deterministic", points: 30, severity: "scored", graderId: "file" },
    { id: "quality", label: "表达清晰", source: "judge", points: 30, severity: "scored", rubric: "内容清楚" },
    { id: "review", label: "人工复核", source: "human", points: 10, severity: "scored" }
  ],
  humanReview: { prompt: "检查结果", sampleRate: 0 }
};

describe("scoreRun", () => {
  it("normalizes objective and judge scores when no review is required", () => {
    const outcome = scoreRun({
      manifest,
      deterministic: {
        blocker: { passed: true, reason: "ok", evidence: [] },
        content: { passed: true, reason: "ok", evidence: [] }
      },
      judge: { criteria: { quality: { passed: true, confidence: 0.9, reason: "ok" } }, overallConfidence: 0.9 },
      judgeExpected: true,
      humanDecision: null,
      reviewReasonSeed: "run-1",
      runFailed: false
    });
    expect(outcome.verdict).toBe("passed");
    expect(outcome.score).toBe(100);
  });

  it("fails immediately when a blocker fails", () => {
    const outcome = scoreRun({
      manifest,
      deterministic: {
        blocker: { passed: false, reason: "missing", evidence: [] },
        content: { passed: true, reason: "ok", evidence: [] }
      },
      judge: { criteria: { quality: { passed: true, confidence: 0.9, reason: "ok" } }, overallConfidence: 0.9 },
      judgeExpected: true,
      humanDecision: null,
      reviewReasonSeed: "run-2",
      runFailed: true
    });
    expect(outcome.verdict).toBe("failed");
    expect(outcome.blockerFailures).toEqual(["blocker"]);
    expect(outcome.reviewReasons).toContain("failed_sample");
  });

  it("routes low-confidence judge output to review", () => {
    const outcome = scoreRun({
      manifest,
      deterministic: {
        blocker: { passed: true, reason: "ok", evidence: [] },
        content: { passed: true, reason: "ok", evidence: [] }
      },
      judge: { criteria: { quality: { passed: true, confidence: 0.4, reason: "unsure" } }, overallConfidence: 0.5 },
      judgeExpected: true,
      humanDecision: null,
      reviewReasonSeed: "run-3",
      runFailed: false
    });
    expect(outcome.verdict).toBe("needs_review");
    expect(outcome.reviewReasons).toContain("low_confidence");
  });

  it("uses deterministic-only normalization when judge is explicitly disabled", () => {
    const outcome = scoreRun({
      manifest,
      deterministic: {
        blocker: { passed: true, reason: "ok", evidence: [] },
        content: { passed: false, reason: "wrong", evidence: [] }
      },
      judge: null,
      judgeExpected: false,
      humanDecision: null,
      reviewReasonSeed: "run-4",
      runFailed: false
    });
    expect(outcome.verdict).toBe("failed");
    expect(outcome.score).toBe(50);
  });
});

describe("shouldSample", () => {
  it("is stable for a given seed", () => {
    expect(shouldSample("experiment:run", 0.1)).toBe(shouldSample("experiment:run", 0.1));
    expect(shouldSample("experiment:run", 0)).toBe(false);
    expect(shouldSample("experiment:run", 1)).toBe(true);
  });
});
