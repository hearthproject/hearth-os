import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@hearth/core";
import { buildTaskResultAnswer, buildTaskStatusMessage } from "./task-status-messages.ts";

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "T01",
    templateId: null,
    title: "列出已合并 PR",
    goal: "列出合并 PR 及所属仓库",
    status: "completed",
    createdAt: "2026-11-18T10:00:00.000Z",
    updatedAt: "2026-11-18T10:12:00.000Z",
    deadline: null,
    inputs: [],
    networkHosts: [],
    outputDir: ".hearth/artifacts/T01",
    currentRunId: null,
    nextAction: "产物已保存",
    error: null,
    resultSummary: "共 165 条已合并 PR，分布在 24 个仓库。",
    conversationId: "conversation-1",
    executorId: "native",
    taskKind: "general",
    expectedOutputs: ["result.md"],
    ...overrides
  } as TaskRecord;
}

describe("task status messages", () => {
  it("keeps the completed status message short so the answer can carry the result", () => {
    const message = buildTaskStatusMessage({ task: task(), previousStatus: "running", approvalMode: "necessary" });
    expect(message).toBe("任务「列出已合并 PR」已完成。");
    expect(message).not.toContain("165");
  });
});

describe("task result answers", () => {
  it("returns the executor result with links to the published files", () => {
    const answer = buildTaskResultAnswer({
      task: task(),
      artifacts: [
        { id: "artifact-1", relativePath: "result.md", bytes: 31_000 },
        { id: "artifact-2", relativePath: "run-manifest.json", bytes: 900 },
        { id: "artifact-3", relativePath: "inputs/source.txt", bytes: 120 },
        { id: "artifact-4", relativePath: "notes.json", bytes: 200 }
      ]
    });
    expect(answer).toContain("共 165 条已合并 PR");
    expect(answer).toContain("[result.md](/api/tasks/T01/artifacts/artifact-1)");
    expect(answer).toContain("30.3 KB");
    expect(answer).not.toContain("run-manifest");
    expect(answer).not.toContain("inputs/");
    expect(answer).not.toContain("notes.json");
  });

  it("keeps expected JSON outputs but caps the file list", () => {
    const artifacts = Array.from({ length: 9 }, (_, index) => ({
      id: `artifact-${index}`,
      relativePath: index === 0 ? "summary.json" : `report-${index}.md`,
      bytes: 2_048
    }));
    const answer = buildTaskResultAnswer({
      task: task({ expectedOutputs: ["summary.json"] }),
      artifacts
    });
    expect(answer).toContain("summary.json");
    expect(answer).toContain("report-1.md");
    expect(answer).not.toContain("report-6.md");
  });

  it("can leave files to the chat chips below the answer", () => {
    const answer = buildTaskResultAnswer({
      task: task(),
      artifacts: [{ id: "artifact-1", relativePath: "result.md", bytes: 31_000 }]
    }, { includeFiles: false });
    expect(answer).toBe("共 165 条已合并 PR，分布在 24 个仓库。");
    expect(answer).not.toContain("交付文件");
  });

  it("explains an empty completion instead of returning a blank message", () => {
    const answer = buildTaskResultAnswer({ task: task({ resultSummary: null }), artifacts: [] });
    expect(answer).toBe("任务「列出已合并 PR」已完成，但没有返回文字结果或交付文件。");
  });

  it("clips very long results and points at the task page", () => {
    const answer = buildTaskResultAnswer({ task: task({ resultSummary: "结果".repeat(3_000) }), artifacts: [] });
    expect(answer.length).toBeLessThanOrEqual(4_001);
    expect(answer.endsWith("…")).toBe(true);
  });
});
