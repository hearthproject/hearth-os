import type {
  GoalAction,
  GoalContract,
  GoalEligibility,
  GoalEligibilityReason,
  GoalEvidenceRef,
  GoalState,
  TaskStatus
} from "./types.ts";

export const DEFAULT_GOAL_MAX_ROUNDS = 24;
export const MAX_GOAL_ROUNDS = 200;
export const DEFAULT_NO_PROGRESS_LIMIT = 3;

const TERMINAL_STATES: ReadonlySet<GoalState> = new Set(["done", "failed", "cancelled"]);

const TRANSITIONS: Record<GoalState, readonly GoalState[]> = {
  draft: ["active", "cancelled"],
  active: ["paused", "awaiting_user", "validating", "blocked", "cancelled"],
  paused: ["active", "validating", "cancelled"],
  awaiting_user: ["active", "validating", "blocked", "cancelled"],
  validating: ["done", "active", "awaiting_user", "paused", "blocked", "cancelled"],
  blocked: ["active", "cancelled"],
  done: [],
  failed: [],
  cancelled: []
};

export class GoalStateError extends Error {
  readonly code:
    | "GOAL_STATE_INVALID"
    | "GOAL_ROUND_LIMIT"
    | "GOAL_REVISION_CONFLICT"
    | "GOAL_ALREADY_ACTIVE"
    | "GOAL_VERIFIER_UNAVAILABLE"
    | "GOAL_EXECUTION_CONFLICT"
    | "GOAL_CONTRACT_INVALID";

  constructor(code: GoalStateError["code"], message: string) {
    super(message);
    this.name = "GoalStateError";
    this.code = code;
  }
}

export function isGoalTerminal(state: GoalState): boolean {
  return TERMINAL_STATES.has(state);
}

export function normalizeGoal(goal: GoalContract): GoalContract {
  return {
    ...goal,
    originalObjective: goal.originalObjective ?? goal.objective,
    contractRevision: Math.max(0, goal.contractRevision ?? 0),
    executionRevision: Math.max(0, goal.executionRevision ?? 0),
    amendments: goal.amendments ?? [],
    armed: goal.armed ?? false,
    roundCount: Math.max(0, goal.roundCount ?? 0),
    noProgressCount: Math.max(0, goal.noProgressCount ?? 0),
    lastProgressDigest: goal.lastProgressDigest ?? null,
    nextWakeAt: goal.nextWakeAt ?? null,
    stopReason: goal.stopReason ?? null,
    pauseReference: goal.pauseReference ?? null,
    commandsApprovedAt: goal.commandsApprovedAt ?? null,
    revision: Math.max(0, goal.revision ?? 0)
  };
}

export function clampGoalMaxRounds(value: number | undefined): number {
  // Goal rounds are uncapped; the helper remains for old callers that still
  // type-check against a numeric value.
  return value ?? Number.POSITIVE_INFINITY;
}

export function assertGoalTransition(from: GoalState, to: GoalState): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new GoalStateError("GOAL_STATE_INVALID", `目标状态不能从 ${from} 变为 ${to}`);
  }
}

export function assertGoalAction(goal: GoalContract, action: GoalAction): void {
  const state = goal.currentState;
  if (action === "switch_executor" || action === "amend_contract") {
    if (isGoalTerminal(state)) throw new GoalStateError("GOAL_STATE_INVALID", "目标已经结束，不能再修改运行契约");
    return;
  }
  if (action === "stop") {
    if (isGoalTerminal(state)) throw new GoalStateError("GOAL_STATE_INVALID", "目标已经结束，不能停止");
    return;
  }
  if (action === "approve") {
    if (state !== "awaiting_user" || goal.stopReason !== "verifier") {
      throw new GoalStateError("GOAL_STATE_INVALID", "当前没有待确认的完成报告");
    }
    return;
  }
  if (action === "start") {
    if (state !== "draft" && state !== "paused" && state !== "awaiting_user") {
      throw new GoalStateError("GOAL_STATE_INVALID", `当前状态不能开始：${state}`);
    }
    return;
  }
  if (action === "pause") {
    if (state !== "active") throw new GoalStateError("GOAL_STATE_INVALID", `当前状态不能暂停：${state}`);
    return;
  }
  if (action === "resume") {
    if (state !== "paused" && state !== "awaiting_user") {
      throw new GoalStateError("GOAL_STATE_INVALID", `当前状态不能继续：${state}`);
    }
    return;
  }
  if (action === "replan") {
    if (state !== "active" && state !== "paused" && state !== "blocked" && state !== "awaiting_user") {
      throw new GoalStateError("GOAL_STATE_INVALID", `当前状态不能重新规划：${state}`);
    }
    return;
  }
  if (action === "complete") {
    if (state !== "active" && state !== "awaiting_user" && state !== "paused") {
      throw new GoalStateError("GOAL_STATE_INVALID", `当前状态不能触发验收：${state}`);
    }
    return;
  }
  throw new GoalStateError("GOAL_STATE_INVALID", `未知目标动作：${action}`);
}

const OPEN_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "recoverable",
  "paused"
]);

export interface GoalEligibilityInput {
  goal: GoalContract;
  now: Date;
  hasOpenRound: boolean;
  taskStatus: TaskStatus | null;
  executorAvailable: boolean;
  spentTokens: number;
  elapsedMs: number;
}

export function evaluateGoalEligibility(input: GoalEligibilityInput): GoalEligibility {
  const goal = normalizeGoal(input.goal);
  const nowMs = input.now.getTime();
  const denied = (reason: GoalEligibilityReason, detail: string, nextWakeAt?: string | null): GoalEligibility => ({
    eligible: false,
    reason,
    detail,
    ...(nextWakeAt ? { nextWakeAt } : {})
  });

  if (goal.currentState === "validating") return denied("verifying", "目标正在验收，验收结束后会决定下一步");
  if (goal.currentState === "awaiting_user") return denied("gate", "目标在等待你的决定或补充信息");
  if (goal.currentState !== "active") return denied("state_not_active", `目标当前状态为 ${goal.currentState}`);
  if (!goal.armed) return denied("disarmed", "自动推进未开启，需要你确认继续");
  if (input.hasOpenRound) return denied("round_open", "已有一轮正在进行");
  if (input.taskStatus && OPEN_TASK_STATUSES.has(input.taskStatus)) {
    return denied("task_open", `目标任务处于 ${input.taskStatus}，先处理当前任务状态`);
  }
  if (goal.nextWakeAt) {
    const wakeMs = Date.parse(goal.nextWakeAt);
    if (Number.isFinite(wakeMs) && wakeMs > nowMs) {
      return denied("backoff", `等待退避到 ${goal.nextWakeAt}`, goal.nextWakeAt);
    }
  }
  if (!input.executorAvailable) {
    const wakeAt = new Date(nowMs + 5 * 60_000).toISOString();
    return denied("executor_unavailable", "目标执行器当前不可用，稍后重试", wakeAt);
  }
  return { eligible: true, reason: "ok", detail: "可以开始下一轮" };
}

/** Web-safe deterministic digest for no-progress detection. */
export function goalProgressDigest(parts: {
  artifactHashes: string[];
  summary: string;
  intentEvidence: GoalEvidenceRef[];
}): string {
  const structural = [
    ...parts.artifactHashes.map((value) => value.trim()).sort(),
    ...parts.intentEvidence.map(goalEvidenceKey).sort()
  ];
  // Once a round leaves artifacts or evidence, prose changes alone are not progress.
  // With no structural output, fall back to the normalized summary so text-only work
  // can still be distinguished between rounds.
  const source = (structural.length > 0 ? structural : [parts.summary.replace(/\s+/g, " ").trim()])
    .join("\u0000");
  // FNV-1a 64-bit, expressed without Node-only APIs so core stays browser-safe.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= BigInt(source.charCodeAt(index));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export function goalEvidenceKey(evidence: GoalEvidenceRef): string {
  if (typeof evidence === "string") return evidence.trim();
  return [
    evidence.kind ?? "note",
    evidence.ref.trim(),
    evidence.sha256 ?? "",
    evidence.runId ?? ""
  ].join(":");
}

export function goalRoundLimitReached(_goal: GoalContract): boolean {
  return false;
}

export function goalBackoffMs(noProgressCount: number, failureCount = 0): number {
  const step = Math.max(noProgressCount, failureCount);
  if (step <= 0) return 0;
  if (step === 1) return 5 * 60_000;
  if (step === 2) return 15 * 60_000;
  return 30 * 60_000;
}
