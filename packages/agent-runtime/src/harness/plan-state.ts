import type { AgentPlan, AgentPlanStep, AgentPlanStepState, AgentTodo, AgentToolState } from "../types.ts";

export interface PlanStepInput {
  title: string;
  detail?: string;
  owner?: string;
}

/** 由 submit_plan 的 steps 构造结构化计划；每步初始为 pending。 */
export function buildPlan(title: string, goal: string, steps: PlanStepInput[], now = Date.now()): AgentPlan {
  return {
    title: title || "implementation-plan",
    goal,
    steps: steps.map((step, index) => ({
      id: `p${index + 1}`,
      title: step.title,
      ...(step.detail ? { detail: step.detail } : {}),
      state: "pending" as const,
      ...(step.owner ? { owner: step.owner } : {})
    })),
    createdAt: now
  };
}

/** plan 步骤投影成 todo，供 UI 清单与 todo_write 复用。 */
export function planToTodos(plan: AgentPlan): AgentTodo[] {
  return plan.steps.map((step) => ({
    id: step.id,
    content: step.detail ? `${step.title}：${step.detail}` : step.title,
    status: step.state === "cancelled" ? "completed" : step.state
  }));
}

/**
 * 把 todo_write 的整体替换写回 plan.steps。按 id 匹配保留 title/detail/owner/note，
 * 只更新 state；新增的 todo 变成新步骤，被移除的步骤从 plan 删除。
 */
export function applyTodosToPlan(plan: AgentPlan, todos: AgentTodo[]): AgentPlan {
  const existing = new Map(plan.steps.map((step) => [step.id, step]));
  const seen = new Set<string>();
  const steps: AgentPlanStep[] = [];

  for (const todo of todos) {
    seen.add(todo.id);
    const previous = existing.get(todo.id);
    const state: AgentPlanStepState = todo.status === "cancelled" ? "cancelled" : todo.status;
    steps.push({
      id: todo.id,
      title: previous?.title ?? todo.content,
      ...(previous?.detail ? { detail: previous.detail } : {}),
      state,
      ...(previous?.owner ? { owner: previous.owner } : {}),
      ...(state === "cancelled" && previous?.note ? { note: previous.note } : {})
    });
  }
  return { ...plan, steps };
}

/** 把 plan 状态写回 state：既更新 plan，也同步 todos 投影。 */
export function setPlan(state: AgentToolState | undefined, plan: AgentPlan): void {
  if (!state) return;
  state.plan = plan;
  state.todos = planToTodos(plan);
}

/** todo_write 后调用：若存在 plan 则把状态回写，保持两者一致。 */
export function syncPlanFromTodos(state: AgentToolState | undefined): void {
  if (!state?.plan || state.plan.steps.length === 0) return;
  state.plan = applyTodosToPlan(state.plan, state.todos);
}

/**
 * 渲染成注入模型的上下文块。带每步 state，模型每轮都能看到最新进度；
 * 若文本未变化，运行时不会重复注入。
 */
export function renderPlanContext(plan: AgentPlan | undefined): string | null {
  if (!plan || plan.steps.length === 0) return null;
  const done = plan.steps.filter((step) => step.state === "completed").length;
  const lines: string[] = [
    "<active_plan>",
    `title: ${plan.title}`,
    `progress: ${done}/${plan.steps.length} completed`,
    `goal: ${plan.goal}`,
    "steps (state is authoritative; keep at most one in_progress):"
  ];
  for (const step of plan.steps) {
    const detail = step.detail ? ` — ${step.detail}` : "";
    const owner = step.owner ? ` [owner=${step.owner}]` : "";
    const note = step.note ? ` (${step.note})` : "";
    lines.push(`${step.id}. [${step.state}] ${step.title}${detail}${owner}${note}`);
  }
  lines.push("Use todo_write to update step state. Tool calls continue as usual.");
  lines.push("</active_plan>");
  return lines.join("\n");
}
