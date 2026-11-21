import { describe, expect, it } from "vitest";
import { DEFAULT_RETRY_POLICY, resolveRetryPolicy, retryDelayFor, retryWindowExceeded, shouldRetryFailure } from "./retry-policy.ts";
import type { AgentFailure } from "./errors.ts";

function failure(code: AgentFailure["code"], retryAfterMs?: number): AgentFailure {
  return {
    code,
    message: code,
    retryable: true,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
  };
}

describe("retry policy", () => {
  it("honors Retry-After over exponential backoff", () => {
    const policy = resolveRetryPolicy({ baseDelayMs: 1_000, jitter: 0 });
    expect(retryDelayFor(policy, 1, failure("MODEL_RATE_LIMIT", 60_000))).toBe(60_000);
    expect(retryDelayFor(policy, 3, failure("MODEL_RATE_LIMIT", 60_000))).toBe(60_000);
  });

  it("caps backoff at maxDelayMs", () => {
    const policy = resolveRetryPolicy({ baseDelayMs: 1_000, maxDelayMs: 10_000, jitter: 0 });
    expect(retryDelayFor(policy, 6, failure("MODEL_TRANSPORT"))).toBe(10_000);
  });

  it("keeps jitter within the configured band", () => {
    const policy = resolveRetryPolicy({ baseDelayMs: 1_000, jitter: 0.25 });
    const low = retryDelayFor(policy, 1, failure("MODEL_TRANSPORT"), () => 0);
    const high = retryDelayFor(policy, 1, failure("MODEL_TRANSPORT"), () => 1);
    expect(low).toBe(750);
    expect(high).toBe(1_250);
  });

  it("stops normal retries at the configured limit but always mode keeps retrying", () => {
    const normal = resolveRetryPolicy({ maxRetries: 2 });
    expect(shouldRetryFailure(normal, failure("MODEL_RATE_LIMIT"), 1)).toBe(true);
    expect(shouldRetryFailure(normal, failure("MODEL_RATE_LIMIT"), 3)).toBe(false);
    expect(shouldRetryFailure(resolveRetryPolicy({ mode: "always" }), failure("MODEL_RATE_LIMIT"), 99)).toBe(true);
    expect(shouldRetryFailure(normal, failure("MODEL_AUTH"), 1)).toBe(false);
  });

  it("treats the retry deadline as a hard window", () => {
    const policy = resolveRetryPolicy({ deadlineMs: 60_000 });
    expect(retryWindowExceeded(policy, 0, 59_000)).toBe(false);
    expect(retryWindowExceeded(policy, 0, 60_000)).toBe(true);
    expect(retryWindowExceeded(DEFAULT_RETRY_POLICY, Date.now() - 60_000)).toBe(false);
  });
});
