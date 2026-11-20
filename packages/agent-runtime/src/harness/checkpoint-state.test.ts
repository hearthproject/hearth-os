import { describe, expect, it } from "vitest";
import { deserializeAgentState, serializeAgentState } from "./checkpoint-state.ts";
import { createAgentState } from "./file-state.ts";

describe("checkpoint state", () => {
  it("round-trips read files, todos, snapshots, plan and mode", () => {
    const state = createAgentState("D:/work");
    state.readFiles.set("D:/work/src/a.ts", { size: 12, mtimeMs: 100, hash: "abc", ranges: [{ start: 1, end: 3 }, { start: 7, end: 7 }] });
    state.todos.push({ id: "t1", content: "finish", status: "in_progress" });
    state.snapshots.set("s1", "D:/work/.hearth/snapshots/s1");
    state.snapshotSeq = 2;
    state.planPath = "D:/work/plan.md";
    state.mode = "plan";
    state.activeSkills = ["skill-a"];
    state.subagents = [{ id: "a1", type: "explore", status: "completed", startedAt: 1, endedAt: 2 }];

    const restored = deserializeAgentState(serializeAgentState(state));

    expect(restored?.workspaceRoot).toBe("D:/work");
    expect(restored?.readFiles.get("D:/work/src/a.ts")).toEqual({ size: 12, mtimeMs: 100, hash: "abc", ranges: [{ start: 1, end: 3 }, { start: 7, end: 7 }] });
    expect(restored?.todos).toEqual([{ id: "t1", content: "finish", status: "in_progress" }]);
    expect(restored?.snapshots.get("s1")).toBe("D:/work/.hearth/snapshots/s1");
    expect(restored?.snapshotSeq).toBe(2);
    expect(restored?.planPath).toBe("D:/work/plan.md");
    expect(restored?.mode).toBe("plan");
    expect(restored?.activeSkills).toEqual(["skill-a"]);
    expect(restored?.subagents?.[0]).toEqual({ id: "a1", type: "explore", status: "completed", startedAt: 1, endedAt: 2 });
  });

  it("ignores malformed state instead of failing resume", () => {
    expect(deserializeAgentState(undefined)).toBeUndefined();
    expect(deserializeAgentState({ workspaceRoot: "x" } as never)).toBeUndefined();
    const restored = deserializeAgentState({
      workspaceRoot: "x",
      readFiles: [{ path: "x/a", size: "bad", mtimeMs: 1, hash: "h", ranges: [{ start: 1, end: 2 }, { start: "bad", end: 3 }] }],
      todos: [{ id: 1 }],
      snapshots: "bad",
      startedAt: 0
    } as never);
    expect(restored?.readFiles.get("x/a")?.ranges).toEqual([{ start: 1, end: 2 }]);
    expect(restored?.todos).toEqual([]);
    expect(restored?.snapshots.size).toBe(0);
  });
});
