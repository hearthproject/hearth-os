import { describe, expect, it } from "vitest";
import {
  PlanStateError,
  assertPlanAction,
  assertPlanTransition,
  isTerminalPlanStage,
  nextPlanRevision,
  normalizePlan
} from "./plan-state.ts";
import type { PlanRecord } from "./types.ts";

function plan(): PlanRecord {
  return {
    id: "plan-1",
    conversationId: "conv-1",
    projectId: null,
    title: "Plan",
    objective: "Ship it",
    stage: "planning",
    planningTaskId: null,
    executionTaskId: null,
    planMarkdown: null,
    planPath: null,
    revision: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    approvedAt: null,
    completedAt: null,
    error: null
  };
}

describe("plan state machine", () => {
  it("allows the approval, execution and replan lifecycle", () => {
    expect(() => assertPlanTransition("planning", "awaiting_approval")).not.toThrow();
    expect(() => assertPlanTransition("awaiting_approval", "executing")).not.toThrow();
    expect(() => assertPlanTransition("executing", "completed")).not.toThrow();
    expect(() => assertPlanTransition("failed", "planning")).not.toThrow();
    expect(() => assertPlanTransition("failed", "cancelled")).not.toThrow();
    expect(() => assertPlanTransition("executing", "awaiting_approval")).not.toThrow();
  });

  it("rejects terminations and invalid skips", () => {
    expect(() => assertPlanTransition("completed", "planning")).toThrow(PlanStateError);
    expect(() => assertPlanTransition("cancelled", "executing")).toThrow(PlanStateError);
    expect(() => assertPlanTransition("planning", "executing")).toThrow(PlanStateError);
  });

  it("permits saving an unchanged stage and rejects late actions", () => {
    expect(() => assertPlanTransition("planning", "planning")).not.toThrow();
    expect(() => assertPlanAction("completed", "approve")).toThrow(PlanStateError);
    expect(() => assertPlanAction("planning", "approve")).toThrow(PlanStateError);
    expect(() => assertPlanAction("failed", "cancel")).not.toThrow();
    expect(() => assertPlanAction("failed", "replan")).not.toThrow();
  });

  it("normalizes missing fields and bumps revisions", () => {
    const raw = { ...plan(), revision: Number.NaN } as unknown as PlanRecord;
    const normalized = normalizePlan(raw);
    expect(normalized.revision).toBe(0);
    expect(normalized.planPath).toBeNull();
    expect(nextPlanRevision(normalized)).toBe(1);
    expect(isTerminalPlanStage("completed")).toBe(true);
    expect(isTerminalPlanStage("failed")).toBe(false);
  });
});
