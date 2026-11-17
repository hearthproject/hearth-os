import { describe, expect, it } from "vitest";
import { isTaskUnread, parseTaskReadState } from "./task-read-state.ts";

describe("task notification read state", () => {
  it("clears a viewed revision while preserving notifications for later updates", () => {
    const task = { id: "retry-task", updatedAt: "2026-11-17T10:00:00.000Z" };
    expect(isTaskUnread(task, {})).toBe(true);
    const seen = { [task.id]: task.updatedAt };
    expect(isTaskUnread(task, seen)).toBe(false);
    expect(isTaskUnread({ ...task, updatedAt: "2026-11-17T10:01:00.000Z" }, seen)).toBe(true);
    expect(isTaskUnread({ ...task, updatedAt: "2026-11-17T09:59:00.000Z" }, seen)).toBe(false);
  });
  it("recovers from invalid browser storage", () => {
    expect(parseTaskReadState("broken")).toEqual({});
    expect(parseTaskReadState("null")).toEqual({});
    expect(parseTaskReadState('{"task":"revision","invalid":123}')).toEqual({ task: "revision" });
  });
});
