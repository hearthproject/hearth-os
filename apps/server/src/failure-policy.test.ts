import { describe, expect, it } from "vitest";
import {
  MAX_RETRY_DELAY_MS,
  canBlindRetry,
  classifyFailureClass,
  decideDisposition,
  failureCauseForClass,
  retryDelayMs
} from "./failure-policy.ts";

describe("failure policy", () => {
  it("classifies explicit failure signals before message heuristics", () => {
    expect(classifyFailureClass({ message: "timeout", effectUncertain: true })).toBe("effect_unknown");
    expect(classifyFailureClass({ message: "cancelled", aborted: true, stopping: true })).toBe("user_cancelled");
    expect(classifyFailureClass({ message: "validator failed", budgetExhausted: true })).toBe("budget_exhausted");
    expect(classifyFailureClass({ message: "validator failed", validatorFailed: true })).toBe("validation_failed");
  });

  it("classifies common transport, policy and credential failures", () => {
    expect(classifyFailureClass({ message: "审批拒绝" })).toBe("policy_denied");
    expect(classifyFailureClass({ message: "api key expired" })).toBe("auth");
    expect(classifyFailureClass({ message: "429 too many requests" })).toBe("rate_limit");
    expect(classifyFailureClass({ message: "overloaded 503" })).toBe("capacity");
    expect(classifyFailureClass({ message: "ETIMEDOUT" })).toBe("timeout");
    expect(classifyFailureClass({ message: "ECONNRESET network" })).toBe("transport");
    expect(classifyFailureClass({ message: "maxTurns budget exceeded" })).toBe("budget_exhausted");
    expect(classifyFailureClass({ message: "unexpected null" })).toBe("internal");
  });

  it("stops user cancellation and asks for policy or auth intervention", () => {
    expect(decideDisposition({ failure: "user_cancelled", attempt: 1 })).toMatchObject({ type: "stop" });
    expect(decideDisposition({ failure: "policy_denied", attempt: 1 })).toMatchObject({ type: "ask_user" });
    expect(decideDisposition({ failure: "auth", attempt: 1 })).toMatchObject({ type: "ask_user" });
  });

  it("repairs validation failures and reconciles uncertain effects", () => {
    expect(decideDisposition({ failure: "validation_failed", attempt: 1, repairTarget: "report" })).toEqual({
      type: "repair",
      target: "report",
      reason: "验收或产物校验失败，必须修复而不是盲目重跑"
    });
    expect(decideDisposition({ failure: "effect_unknown", attempt: 1, effectId: "effect-1" })).toEqual({
      type: "reconcile",
      effectId: "effect-1"
    });
    expect(decideDisposition({ failure: "effect_unknown", attempt: 1 })).toMatchObject({ type: "stop" });
  });

  it("retries transient failures within the attempt budget", () => {
    for (const failure of ["timeout", "capacity", "rate_limit", "transport"] as const) {
      expect(decideDisposition({ failure, attempt: 1, maxAttempts: 3 })).toMatchObject({ type: "retry", attempt: 2 });
      expect(canBlindRetry(failure)).toBe(true);
    }
    expect(decideDisposition({ failure: "timeout", attempt: 3, maxAttempts: 3 })).toMatchObject({ type: "handoff" });
  });

  it("hands off exhausted budgets and stops unclassified internal errors", () => {
    expect(decideDisposition({ failure: "budget_exhausted", attempt: 1 })).toMatchObject({ type: "handoff" });
    expect(decideDisposition({ failure: "internal", attempt: 1 })).toMatchObject({ type: "stop" });
  });

  it("uses capped exponential backoff", () => {
    expect(retryDelayMs(1, "timeout")).toBe(1_000);
    expect(retryDelayMs(2, "timeout")).toBe(2_000);
    expect(retryDelayMs(3, "timeout")).toBe(4_000);
    expect(retryDelayMs(1, "rate_limit")).toBe(5_000);
    expect(retryDelayMs(100, "rate_limit")).toBe(MAX_RETRY_DELAY_MS);
  });

  it("does not blind retry failures that require changed state", () => {
    expect(canBlindRetry("validation_failed")).toBe(false);
    expect(canBlindRetry("effect_unknown")).toBe(false);
    expect(canBlindRetry("auth")).toBe(false);
    expect(canBlindRetry("policy_denied")).toBe(false);
  });

  it("maps failure classes onto the existing diagnosis causes", () => {
    expect(failureCauseForClass("timeout")).toBe("transient");
    expect(failureCauseForClass("validation_failed")).toBe("contract_failure");
    expect(failureCauseForClass("effect_unknown")).toBe("effect_uncertain");
    expect(failureCauseForClass("budget_exhausted")).toBe("budget");
    expect(failureCauseForClass("auth")).toBe("permission");
    expect(failureCauseForClass("user_cancelled")).toBe("unknown");
  });
});
