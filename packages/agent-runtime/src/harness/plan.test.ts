import { describe, expect, it } from "vitest";
import { defaultTaskPermissions } from "../tools.ts";
import type { AgentToolContext } from "../types.ts";
import { createAgentState } from "./file-state.ts";
import { MAX_PLAN_STEPS, submitPlanTool } from "./plan.ts";
import { TASK_PROFILES } from "./task-profile.ts";

function contextFor(mode: "build" | "plan"): AgentToolContext {
  return {
    workspaceRoot: "E:\\work",
    outDir: "E:\\work\\out",
    permissions: defaultTaskPermissions({ workspaceRoot: "E:\\work", outDir: "E:\\work\\out", networkHosts: [] }),
    signal: new AbortController().signal,
    state: createAgentState("E:\\work"),
    mode
  };
}

describe("submit_plan tool exposure", () => {
  it("is a direct tool in every task profile", () => {
    for (const profile of Object.values(TASK_PROFILES)) {
      expect(profile.directTools).toContain("submit_plan");
      expect(profile.directTools).toContain("todo_write");
    }
  });
});

describe("submit_plan structured steps", () => {
  it("records steps as pending todos and continues execution in build mode", async () => {
    const context = contextFor("build");
    const result = await submitPlanTool.execute({
      plan: "迁移测试到 db 模块",
      steps: [{ title: "重写 test_delete.py", detail: "去掉 JSON 操作" }, { title: "运行 pytest" }]
    }, context);
    expect(result.isError).toBeFalsy();
    expect(result.action).toBeUndefined();
    expect(context.state!.todos).toEqual([
      { id: "p1", content: "重写 test_delete.py：去掉 JSON 操作", status: "pending" },
      { id: "p2", content: "运行 pytest", status: "pending" }
    ]);
    expect(context.state!.plan).toEqual({
      title: "implementation-plan",
      goal: "迁移测试到 db 模块",
      createdAt: expect.any(Number),
      steps: [
        { id: "p1", title: "重写 test_delete.py", detail: "去掉 JSON 操作", state: "pending" },
        { id: "p2", title: "运行 pytest", state: "pending" }
      ]
    });
  });

  it("keeps plan mode behaviour: waits for approval and stores the steps", async () => {
    const context = contextFor("plan");
    const result = await submitPlanTool.execute({ plan: "方案", steps: [{ title: "第一步" }] }, context);
    expect(result.action).toBe("plan");
    expect(context.state!.mode).toBe("plan");
    expect(context.state!.todos).toHaveLength(1);
  });

  it("keeps the original plan-only flow when no steps are given", async () => {
    const context = contextFor("build");
    const result = await submitPlanTool.execute({ plan: "只有文字的方案" }, context);
    expect(result.action).toBe("plan");
    expect(context.state!.todos).toEqual([]);
  });

  it("rejects plans longer than the step limit and asks for subtasks", async () => {
    const context = contextFor("build");
    const steps = Array.from({ length: MAX_PLAN_STEPS + 1 }, (_value, index) => ({ title: `步骤 ${index + 1}` }));
    const result = await submitPlanTool.execute({ plan: "太长", steps }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("拆成子任务");
    expect(context.state!.todos).toEqual([]);
  });

  it("drops steps without a title", async () => {
    const context = contextFor("build");
    await submitPlanTool.execute({ plan: "方案", steps: [{ title: "  " }, { title: "有效步骤" }] }, context);
    expect(context.state!.todos.map((todo) => todo.content)).toEqual(["有效步骤"]);
  });
});
