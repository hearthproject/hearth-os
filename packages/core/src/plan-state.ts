import { PLAN_ACTIONS, PLAN_STAGES, type PlanActionName, type PlanRecord, type PlanStage } from "./types.ts";

export class PlanStateError extends Error {
  code: "PLAN_STATE_INVALID" | "PLAN_ALREADY_ACTIVE" | "PLAN_REVISION_CONFLICT";

  constructor(code: PlanStateError["code"], message: string) {
    super(message);
    this.name = "PlanStateError";
    this.code = code;
  }
}

const TRANSITIONS: Record<PlanStage, PlanStage[]> = {
  planning: ["awaiting_approval", "cancelled", "failed"],
  awaiting_approval: ["planning", "executing", "cancelled"],
  executing: ["completed", "failed", "awaiting_approval"],
  completed: [],
  failed: ["planning", "cancelled"],
  cancelled: []
};

const ACTION_STAGES: Record<PlanActionName, PlanStage[]> = {
  approve: ["awaiting_approval"],
  replan: ["awaiting_approval", "failed"],
  cancel: ["planning", "awaiting_approval", "executing", "failed"],
  retry: ["failed"]
};

export function normalizePlan(plan: PlanRecord): PlanRecord {
  return {
    ...plan,
    projectId: plan.projectId ?? null,
    planningTaskId: plan.planningTaskId ?? null,
    executionTaskId: plan.executionTaskId ?? null,
    ...(plan.execution ? { execution: plan.execution } : {}),
    planMarkdown: plan.planMarkdown ?? null,
    planPath: plan.planPath ?? null,
    revision: Number.isFinite(plan.revision) ? Math.max(0, plan.revision) : 0,
    approvedAt: plan.approvedAt ?? null,
    completedAt: plan.completedAt ?? null,
    error: plan.error ?? null
  };
}

export function nextPlanRevision(plan: PlanRecord): number {
  return (plan.revision ?? 0) + 1;
}

export function assertPlanTransition(from: PlanStage, to: PlanStage): void {
  if (from === to) return;
  if (!PLAN_STAGES.includes(to)) throw new PlanStateError("PLAN_STATE_INVALID", `未知计划状态：${to}`);
  if (!TRANSITIONS[from].includes(to)) {
    throw new PlanStateError("PLAN_STATE_INVALID", `计划状态不能从 ${from} 变为 ${to}`);
  }
}

export function assertPlanAction(stage: PlanStage, action: string): asserts action is PlanActionName {
  if (!PLAN_ACTIONS.includes(action as PlanActionName)) {
    throw new PlanStateError("PLAN_STATE_INVALID", `未知计划动作：${action}`);
  }
  const allowed = ACTION_STAGES[action as PlanActionName];
  if (!allowed.includes(stage)) {
    throw new PlanStateError("PLAN_STATE_INVALID", `计划处于 ${stage} 时不能执行 ${action}`);
  }
}

export function isTerminalPlanStage(stage: PlanStage): boolean {
  return stage === "completed" || stage === "cancelled";
}
