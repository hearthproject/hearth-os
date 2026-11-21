import type { AgentFailure } from "./errors.ts";

export interface RetryPolicy {
  mode: "normal" | "always";
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: number;
  retryableCodes: string[];
  honorRetryAfter: boolean;
  deadlineMs?: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  mode: "normal",
  maxRetries: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
  jitter: 0.25,
  retryableCodes: [
    "MODEL_RATE_LIMIT",
    "MODEL_CAPACITY",
    "MODEL_TIMEOUT",
    "MODEL_TRANSPORT",
    "TOOL_TIMEOUT",
    "TOOL_ORPHANED"
  ],
  honorRetryAfter: true,
  deadlineMs: 6 * 60 * 60_000
};

export function resolveRetryPolicy(value: Partial<RetryPolicy> | undefined): RetryPolicy {
  const policy = { ...DEFAULT_RETRY_POLICY, ...(value ?? {}) };
  return {
    ...policy,
    maxRetries: clampInt(policy.maxRetries, 0, 20, DEFAULT_RETRY_POLICY.maxRetries),
    baseDelayMs: clampInt(policy.baseDelayMs, 0, 10_000, DEFAULT_RETRY_POLICY.baseDelayMs),
    maxDelayMs: clampInt(policy.maxDelayMs, 1_000, 600_000, DEFAULT_RETRY_POLICY.maxDelayMs),
    jitter: Math.max(0, Math.min(1, Number.isFinite(policy.jitter) ? policy.jitter : DEFAULT_RETRY_POLICY.jitter)),
    mode: policy.mode === "always" ? "always" : "normal",
    retryableCodes: Array.isArray(policy.retryableCodes) && policy.retryableCodes.length > 0
      ? policy.retryableCodes.filter((code): code is string => typeof code === "string")
      : [...DEFAULT_RETRY_POLICY.retryableCodes]
  };
}

export function retryDelayFor(
  policy: RetryPolicy,
  attempt: number,
  failure: Pick<AgentFailure, "code" | "retryAfterMs">,
  random: () => number = Math.random
): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitter = exponential * policy.jitter * (random() * 2 - 1);
  const backoff = Math.max(0, exponential + jitter);
  const retryAfter = policy.honorRetryAfter && failure.retryAfterMs && failure.retryAfterMs > 0
    ? failure.retryAfterMs
    : 0;
  return Math.min(policy.maxDelayMs, Math.max(backoff, retryAfter));
}

export function shouldRetryFailure(policy: RetryPolicy, failure: AgentFailure, attempt: number): boolean {
  if (!failure.retryable) return false;
  if (!policy.retryableCodes.includes(failure.code)) return false;
  if (policy.mode === "always") return true;
  return attempt <= policy.maxRetries;
}

export function retryWindowExceeded(policy: RetryPolicy, startedAt: number, now = Date.now()): boolean {
  if (!policy.deadlineMs || policy.deadlineMs <= 0) return false;
  return now - startedAt >= policy.deadlineMs;
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
