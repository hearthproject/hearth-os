import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@hearth/core";
import { nativeProgressForEvent, nativeSystemPrompt } from "./native-executor.ts";

const baseTask = {
  id: "task-1",
  title: "测试任务",
  goal: "生成结构化结果",
  status: "queued",
  templateId: null,
  createdAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
  deadline: null,
  inputs: [],
  networkHosts: [],
  outputDir: "/tmp/out",
  currentRunId: null,
  nextAction: null,
  error: null
} as TaskRecord;

describe("native system prompt", () => {
  it("asks for machine-readable enum and boolean values", () => {
    const prompt = nativeSystemPrompt(baseTask, ["triage.json"]);
    expect(prompt).toContain("high/medium/low");
    expect(prompt).toContain("true/false");
    expect(prompt).toContain("null");
    expect(prompt).toContain("P0/P1");
    expect(prompt).toContain("核心事实直接放在顶层");
    expect(prompt).toContain("沿用输入对象的字段名");
  });
});

describe("native execution progress", () => {
  it("publishes visible progress for turns, tools, compaction and budgets", () => {
    expect(nativeProgressForEvent({ type: "turn.started", turn: 2 })).toMatchObject({
      kind: "turn",
      message: "开始第 2 轮执行",
      detail: { eventType: "turn.started" }
    });

    const call = { id: "call-1", name: "shell", arguments: { command: "git status" }, rawArguments: "{}" };
    expect(nativeProgressForEvent({ type: "tool.started", turn: 2, call })).toMatchObject({
      kind: "tool",
      message: "运行检查命令",
      detail: { eventType: "tool.started", title: "shell" }
    });
    expect(nativeProgressForEvent({
      type: "tool.finished",
      turn: 2,
      call,
      result: { content: "clean", isError: false },
      durationMs: 12
    })).toMatchObject({
      kind: "tool",
      message: "完成一步：shell",
      detail: { eventType: "tool.finished", status: "completed", durationMs: 12 }
    });
    expect(nativeProgressForEvent({
      type: "tool.finished",
      turn: 2,
      call,
      result: { content: "failed", isError: true },
      durationMs: 7
    })).toMatchObject({
      kind: "tool",
      message: "操作没有完成，正在调整：shell",
      detail: { eventType: "tool.finished", status: "failed" }
    });

    expect(nativeProgressForEvent({ type: "compacted", before: 20, after: 8 })).toMatchObject({
      kind: "context",
      message: "整理执行上下文，继续推进"
    });
    expect(nativeProgressForEvent({ type: "budget.exceeded", budget: "turns", limit: 200 })).toMatchObject({
      kind: "budget",
      message: "达到本轮执行预算（轮次）",
      detail: { eventType: "budget.exceeded", status: "turns" }
    });
  });
});
