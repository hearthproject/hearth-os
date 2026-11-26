import { describe, expect, it } from "vitest";
import { createAgentState } from "./file-state.ts";
import { serializeAgentState, deserializeAgentState } from "./checkpoint-state.ts";
import {
  applyTodosToPlan,
  buildPlan,
  planToTodos,
  renderPlanContext,
  setPlan,
  syncPlanFromTodos
} from "./plan-state.ts";

describe("structured plan", () => {
  it("builds steps with state and optional owner", () => {
    const plan = buildPlan("迁移测试", "迁移到 db", [
      { title: "重写 test_delete.py", detail: "去掉 JSON" },
      { title: "跑测试", owner: "reviewer" }
    ], 1000);
    expect(plan.steps).toEqual([
      { id: "p1", title: "重写 test_delete.py", detail: "去掉 JSON", state: "pending" },
      { id: "p2", title: "跑测试", state: "pending", owner: "reviewer" }
    ]);
    expect(plan.createdAt).toBe(1000);
  });

  it("renders per-step state for injection into the model", () => {
    const plan = buildPlan("迁移", "目标", [{ title: "A" }, { title: "B" }]);
    plan.steps[0]!.state = "completed";
    plan.steps[1]!.state = "in_progress";
    const text = renderPlanContext(plan);
    expect(text).toContain("<active_plan>");
    expect(text).toContain("progress: 1/2 completed");
    expect(text).toContain("p1. [completed] A");
    expect(text).toContain("p2. [in_progress] B");
    expect(renderPlanContext(undefined)).toBeNull();
  });

  it("projects plan steps into todos", () => {
    const plan = buildPlan("t", "g", [{ title: "A", detail: "细节" }, { title: "B" }]);
    expect(planToTodos(plan)).toEqual([
      { id: "p1", content: "A：细节", status: "pending" },
      { id: "p2", content: "B", status: "pending" }
    ]);
  });

  it("writes state back from todo_write while keeping step metadata", () => {
    const plan = buildPlan("t", "g", [{ title: "A", detail: "细节", owner: "worker" }, { title: "B" }]);
    const updated = applyTodosToPlan(plan, [
      { id: "p1", content: "A：细节", status: "completed" },
      { id: "p3", content: "C", status: "pending" }
    ]);
    expect(updated.steps[0]).toEqual({ id: "p1", title: "A", detail: "细节", state: "completed", owner: "worker" });
    expect(updated.steps[1]).toEqual({ id: "p3", title: "C", state: "pending" });
  });

  it("syncs todo status changes into the plan on state", () => {
    const state = createAgentState("E:\\work");
    setPlan(state, buildPlan("t", "g", [{ title: "A" }, { title: "B" }]));
    state.todos = state.todos.map((todo, index) => ({ ...todo, status: index === 0 ? "completed" : "in_progress" }));
    syncPlanFromTodos(state);
    expect(state.plan!.steps.map((step) => step.state)).toEqual(["completed", "in_progress"]);
  });

  it("preserves the plan across checkpoint serialization", () => {
    const state = createAgentState("E:\\work");
    setPlan(state, buildPlan("迁移", "目标", [{ title: "A", detail: "细节", owner: "worker" }], 1000));
    state.plan!.steps[0]!.state = "in_progress";
    const restored = deserializeAgentState(JSON.parse(JSON.stringify(serializeAgentState(state))));
    expect(restored!.plan).toEqual(state.plan);
  });
});
