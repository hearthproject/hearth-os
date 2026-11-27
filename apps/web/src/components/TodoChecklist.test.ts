import { describe, expect, it } from "vitest";
import { collectEntries, latestTodos } from "./InlineRun.tsx";
import { MAX_TODO_ITEMS, splitInlineCode, todoHeaderText, validateTodoEdits } from "./TodoChecklist.tsx";
import type { TaskView } from "../lib/types.ts";
import type { EventEnvelope, TaskProgressDetail } from "@hearth/core";

function todosEvent(seq: number, todos: Array<{ id: string; content: string; status: string }>): EventEnvelope {
  return {
    seq,
    id: `todos-${seq}`,
    type: "task.progress",
    taskId: "task-1",
    runId: "run-1",
    payload: { kind: "todos", message: "待办已更新", detail: { todos } as TaskProgressDetail },
    originInstanceId: null,
    originSeq: null,
    createdAt: "2026-11-22T00:00:00.000Z"
  };
}

describe("todo checklist", () => {
  it("uses the latest todos event as a full replacement", () => {
    const events = [
      todosEvent(1, [{ id: "p1", content: "第一步", status: "pending" }]),
      todosEvent(2, [
        { id: "p1", content: "第一步", status: "completed" },
        { id: "p2", content: "第二步", status: "in_progress" }
      ])
    ];
    expect(latestTodos(events as TaskView["events"])).toEqual([
      { id: "p1", content: "第一步", status: "completed" },
      { id: "p2", content: "第二步", status: "in_progress" }
    ]);
  });

  it("returns an empty list when no todos were reported", () => {
    expect(latestTodos([])).toEqual([]);
  });

  it("keeps todo events out of the step trail", () => {
    const events = [todosEvent(1, [{ id: "p1", content: "第一步", status: "pending" }])];
    expect(collectEntries(events as TaskView["events"])).toEqual([]);
  });
});

describe("checklist presentation", () => {
  it("formats the header like the reference UI", () => {
    expect(todoHeaderText(0, 6)).toBe("0 out of 6 tasks completed");
    expect(todoHeaderText(3, 6)).toBe("3 out of 6 tasks completed");
  });

  it("splits backtick-wrapped code from surrounding text", () => {
    expect(splitInlineCode("重写 `test_delete.py`：从 `JSON` 迁移到 `db` 模块")).toEqual([
      { text: "重写 ", code: false },
      { text: "test_delete.py", code: true },
      { text: "：从 ", code: false },
      { text: "JSON", code: true },
      { text: " 迁移到 ", code: false },
      { text: "db", code: true },
      { text: " 模块", code: false }
    ]);
  });

  it("keeps plain content as a single text part", () => {
    expect(splitInlineCode("检查 gitignore")).toEqual([{ text: "检查 gitignore", code: false }]);
  });
});

describe("todo edit validation", () => {
  const item = (id: string, status = "pending") => ({ id, content: `步骤 ${id}`, status });

  it("accepts a normal edited list", () => {
    expect(validateTodoEdits([item("p1", "completed"), item("p2", "in_progress"), item("user-1")])).toBeNull();
  });

  it("rejects empty, blank, duplicate and over-long lists", () => {
    expect(validateTodoEdits([])).toBe("清单不能为空");
    expect(validateTodoEdits([{ id: "p1", content: "  ", status: "pending" }])).toBe("步骤内容不能为空");
    expect(validateTodoEdits([item("p1"), item("p1")])).toBe("步骤 id 重复");
    expect(validateTodoEdits(Array.from({ length: MAX_TODO_ITEMS + 1 }, (_, index) => item(`p${index}`)))).toBe(`最多 ${MAX_TODO_ITEMS} 条`);
  });

  it("allows at most one in_progress step", () => {
    expect(validateTodoEdits([item("p1", "in_progress"), item("p2", "in_progress")])).toBe("只能有一个进行中的步骤");
  });
});
