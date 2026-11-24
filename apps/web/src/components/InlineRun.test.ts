import { describe, expect, it } from "vitest";
import { collectEntries, isEntryExpanded } from "./InlineRun.tsx";
import type { TaskView } from "../lib/types.ts";
import type { EventEnvelope, TaskProgressDetail } from "@hearth/core";

function event(seq: number, id: string, detail: TaskProgressDetail, message = ""): EventEnvelope {
  return {
    seq,
    id,
    type: "task.progress",
    taskId: "task-1",
    runId: "run-1",
    payload: { kind: "native", message, detail },
    originInstanceId: null,
    originSeq: null,
    createdAt: "2026-11-22T00:00:00.000Z"
  };
}

function writeEvent(seq: number, path: string, content: string): EventEnvelope[] {
  return [
    event(seq, `start-${seq}`, { executorId: "native", eventType: "tool.started", title: "write_file", input: { path, content } }),
    event(seq + 1, `done-${seq}`, {
      executorId: "native",
      eventType: "tool.finished",
      title: "write_file",
      output: `已写入 ${path}`,
      status: "ok"
    })
  ];
}

function labelEntries(events: EventEnvelope[], expectedOutputs: readonly string[] = []) {
  return collectEntries(events as TaskView["events"], expectedOutputs)
    .filter((entry) => entry.type === "label");
}

describe("collectEntries 交付物完整展示", () => {
  it("第一次写 result.md 时自动展开并保留完整正文", () => {
    const content = "# 项目介绍\n\n" + "正文".repeat(50);
    const [entry] = labelEntries(writeEvent(1, "result.md", content));
    expect(entry?.type).toBe("label");
    if (entry?.type !== "label") return;
    const tool = entry.tools[0];
    expect(tool?.file).toBe("result.md");
    expect(tool?.content).toBe(content);
    expect(tool?.autoExpand).toBe(true);
    expect(entry.text).toBe("写入 result.md");
  });

  it("同一任务里第二次写 result.md 不再自动展开", () => {
    const entries = labelEntries([
      ...writeEvent(1, "result.md", "第一版"),
      ...writeEvent(3, "result.md", "第二版")
    ]);
    expect(entries).toHaveLength(2);
    const [first, second] = entries;
    if (first?.type !== "label" || second?.type !== "label") return;
    expect(first.tools[0]?.autoExpand).toBe(true);
    expect(second.tools[0]?.autoExpand).toBeUndefined();
    expect(second.tools[0]?.content).toBe("第二版");
  });

  it("非交付物的写入不自动展开", () => {
    const [entry] = labelEntries(writeEvent(1, "notes/draft.md", "草稿"));
    if (entry?.type !== "label") return;
    expect(entry.tools[0]?.autoExpand).toBeUndefined();
  });

  it("expectedOutputs 里列出的文件也算交付物", () => {
    const [entry] = labelEntries(writeEvent(1, "docs/报告.md", "报告正文"), ["docs/报告.md"]);
    if (entry?.type !== "label") return;
    expect(entry.tools[0]?.autoExpand).toBe(true);
  });

  it("apply_patch 写 result.md 时展示补丁正文", () => {
    const patch = "*** Add File: result.md\n+# 结果\n+完成\n";
    const [entry] = labelEntries([
      event(1, "patch-1", { executorId: "native", eventType: "tool.started", title: "apply_patch", input: { patch } })
    ]);
    if (entry?.type !== "label") return;
    expect(entry.tools[0]?.file).toBe("result.md");
    expect(entry.tools[0]?.content).toBe(patch);
    expect(entry.tools[0]?.autoExpand).toBe(true);
  });

  it("submit_plan 的结果去掉路径前缀并按 Markdown 展开", () => {
    const [entry] = labelEntries([
      event(1, "plan-start", { executorId: "native", eventType: "tool.started", title: "submit_plan", input: { plan: "## 计划" } }),
      event(2, "plan-done", {
        executorId: "native",
        eventType: "tool.finished",
        title: "submit_plan",
        output: "计划已写入 C:\\tmp\\plan.md。\n\n## 计划\n\n- 第一步",
        status: "ok"
      })
    ]);
    if (entry?.type !== "label") return;
    expect(entry.tools[0]?.content).toBe("## 计划\n\n- 第一步");
    expect(entry.tools[0]?.markdown).toBe(true);
    expect(entry.tools[0]?.autoExpand).toBe(true);
  });

  it("用户手动折叠后覆盖自动展开", () => {
    const [entry] = labelEntries(writeEvent(1, "result.md", "正文"));
    if (entry?.type !== "label") return;
    expect(isEntryExpanded(entry, {})).toBe(true);
    expect(isEntryExpanded(entry, { [entry.key]: false })).toBe(false);
  });
});