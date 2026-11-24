import { describe, expect, it } from "vitest";
import type { GoalContract } from "./types.ts";
import {
  DEFAULT_GOAL_MAX_ROUNDS,
  GoalStateError,
  assertGoalAction,
  assertGoalTransition,
  clampGoalMaxRounds,
  evaluateGoalEligibility,
  goalBackoffMs,
  goalProgressDigest,
  normalizeGoal
} from "./goal-state.ts";

function goal(overrides: Partial<GoalContract> = {}): GoalContract {
  return normalizeGoal({
    goalId: "goal-1",
    title: "持久目标",
    objective: "把目标推进到完成",
    constraints: [],
    forbiddenActions: [],
    authoritySources: [{ kind: "user", ref: "conversation-1" }],
    successCriteria: [],
    evidenceRequirements: [],
    budget: {},
    stopConditions: [],
    reviewPolicy: "human_on_risk",
    currentState: "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  });
}

describe("goal state machine", () => {
  it("allows the documented lifecycle and rejects terminal resurrections", () => {
    expect(() => assertGoalTransition("draft", "active")).not.toThrow();
    expect(() => assertGoalTransition("active", "validating")).not.toThrow();
    expect(() => assertGoalTransition("validating", "done")).not.toThrow();
    expect(() => assertGoalTransition("paused", "validating")).not.toThrow();
    expect(() => assertGoalTransition("done", "active")).toThrow(GoalStateError);
    expect(() => assertGoalTransition("paused", "done")).toThrow(GoalStateError);
  });

  it("only permits start on draft, paused or awaiting_user", () => {
    expect(() => assertGoalAction(goal({ currentState: "draft" }), "start")).not.toThrow();
    expect(() => assertGoalAction(goal({ currentState: "active" }), "start")).toThrow("当前状态不能开始");
    expect(() => assertGoalAction(goal({ currentState: "done" }), "start")).toThrow(GoalStateError);
  });

  it("requires a verifier approval gate for approve", () => {
    const pending = goal({ currentState: "awaiting_user", stopReason: "verifier" });
    expect(() => assertGoalAction(pending, "approve")).not.toThrow();
    expect(() => assertGoalAction(goal({ currentState: "awaiting_user", stopReason: "needs_input" }), "approve"))
      .toThrow("没有待确认的完成报告");
  });

  it("never allows stopping a terminal goal", () => {
    for (const state of ["done", "failed", "cancelled"] as const) {
      expect(() => assertGoalAction(goal({ currentState: state }), "stop")).toThrow(GoalStateError);
    }
  });
});

describe("goal eligibility", () => {
  const now = new Date("2026-01-02T00:00:00.000Z");

  it("allows an active armed goal with no open work", () => {
    const result = evaluateGoalEligibility({
      goal: goal({ currentState: "active", armed: true }),
      now,
      hasOpenRound: false,
      taskStatus: "completed",
      executorAvailable: true,
      spentTokens: 0,
      elapsedMs: 0
    });
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe("ok");
  });

  it("explains why a goal is quiet instead of spinning", () => {
    const base = {
      now,
      hasOpenRound: false,
      taskStatus: "completed" as const,
      executorAvailable: true,
      spentTokens: 0,
      elapsedMs: 0
    };
    expect(evaluateGoalEligibility({ ...base, goal: goal({ currentState: "active", armed: false }) }).reason).toBe("disarmed");
    expect(evaluateGoalEligibility({ ...base, goal: goal({ currentState: "validating", armed: true }) }).reason).toBe("verifying");
    expect(evaluateGoalEligibility({ ...base, goal: goal({ currentState: "active", armed: true }), hasOpenRound: true }).reason).toBe("round_open");
    expect(evaluateGoalEligibility({ ...base, goal: goal({ currentState: "active", armed: true }), taskStatus: "running" }).reason).toBe("task_open");
    expect(evaluateGoalEligibility({ ...base, goal: goal({ currentState: "awaiting_user", armed: true }) }).reason).toBe("gate");
  });

  it("never stops at round counts or deadlines", () => {
    const atLimit = evaluateGoalEligibility({
      goal: goal({ currentState: "active", armed: true, roundCount: DEFAULT_GOAL_MAX_ROUNDS, maxRounds: DEFAULT_GOAL_MAX_ROUNDS }),
      now,
      hasOpenRound: false,
      taskStatus: "completed",
      executorAvailable: true,
      spentTokens: 0,
      elapsedMs: 0
    });
    expect(atLimit.reason).toBe("ok");
    const expired = evaluateGoalEligibility({
      goal: goal({ currentState: "active", armed: true, deadline: "2026-01-01T00:00:00.000Z" }),
      now,
      hasOpenRound: false,
      taskStatus: "completed",
      executorAvailable: true,
      spentTokens: 0,
      elapsedMs: 0
    });
    expect(expired.reason).toBe("ok");
  });

  it("returns a retry time when the executor is unavailable", () => {
    const result = evaluateGoalEligibility({
      goal: goal({ currentState: "active", armed: true }),
      now,
      hasOpenRound: false,
      taskStatus: "completed",
      executorAvailable: false,
      spentTokens: 0,
      elapsedMs: 0
    });
    expect(result.reason).toBe("executor_unavailable");
    expect(result.nextWakeAt).toBe("2026-01-02T00:05:00.000Z");
  });
});

describe("goal helpers", () => {
  it("keeps round limits uncapped", () => {
    expect(clampGoalMaxRounds(undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(clampGoalMaxRounds(0)).toBe(0);
    expect(clampGoalMaxRounds(999)).toBe(999);
  });

  it("detects no progress deterministically and ignores prose whitespace", () => {
    const first = goalProgressDigest({ artifactHashes: ["b", "a"], summary: "  done\n", intentEvidence: [] });
    const second = goalProgressDigest({ artifactHashes: ["a", "b"], summary: "done", intentEvidence: [] });
    expect(first).toBe(second);
    expect(goalProgressDigest({ artifactHashes: ["a", "c"], summary: "done", intentEvidence: [] })).not.toBe(first);
    expect(goalProgressDigest({ artifactHashes: ["a", "b"], summary: "different prose", intentEvidence: [] })).toBe(first);
    expect(goalProgressDigest({ artifactHashes: [], summary: "a", intentEvidence: [] }))
      .not.toBe(goalProgressDigest({ artifactHashes: [], summary: "b", intentEvidence: [] }));
  });

  it("backs off after consecutive failures", () => {
    expect(goalBackoffMs(0)).toBe(0);
    expect(goalBackoffMs(1)).toBe(5 * 60_000);
    expect(goalBackoffMs(3)).toBe(30 * 60_000);
  });
});
