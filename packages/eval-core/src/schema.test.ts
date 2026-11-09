import { describe, expect, it } from "vitest";
import { validateCaseManifest } from "./schema.ts";
import type { CaseManifest } from "./types.ts";

const valid: CaseManifest = {
  schemaVersion: 1,
  id: "TEST-01",
  version: 1,
  title: "测试",
  family: "email",
  difficulty: "edge",
  runModes: ["offline"],
  description: "测试案例",
  goal: "完成任务",
  tags: ["fixture"],
  timeoutMs: 60_000,
  inputs: [{ kind: "file", label: "输入", path: "input.md" }],
  expectedOutputs: ["output.md"],
  graders: [{ id: "file", title: "文件", config: { kind: "file", path: "output.md" } }],
  criteria: [
    { id: "file", label: "文件存在", source: "deterministic", points: 60, severity: "blocker", graderId: "file" },
    { id: "quality", label: "质量", source: "judge", points: 30, severity: "scored", rubric: "清晰准确" },
    { id: "review", label: "人工", source: "human", points: 10, severity: "scored" }
  ],
  humanReview: { prompt: "复核", sampleRate: 0.1 }
};

describe("validateCaseManifest", () => {
  it("accepts a valid 60/30/10 manifest", () => {
    expect(validateCaseManifest(valid).success).toBe(true);
  });

  it("rejects incorrect scoring weights", () => {
    const result = validateCaseManifest({
      ...valid,
      criteria: valid.criteria.map((criterion) => criterion.id === "quality" ? { ...criterion, points: 20 } : criterion)
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.issues.some((issue) => issue.message.includes("60"))).toBe(true);
  });

  it("requires blocker criteria to be deterministic", () => {
    const result = validateCaseManifest({
      ...valid,
      criteria: valid.criteria.map((criterion) => criterion.id === "quality" ? { ...criterion, severity: "blocker" as const } : criterion)
    });
    expect(result.success).toBe(false);
  });
});
