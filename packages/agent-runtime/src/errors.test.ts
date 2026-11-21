import { describe, expect, it } from "vitest";
import { modelFailureCode, normalizeModelFailure, normalizeToolFailure } from "./errors.ts";

describe("failure normalization", () => {
  it("maps HTTP status and provider errors to stable codes", () => {
    expect(modelFailureCode({ status: 429, message: "too many requests" })).toBe("MODEL_RATE_LIMIT");
    expect(modelFailureCode({ status: 503, message: "overloaded" })).toBe("MODEL_CAPACITY");
    expect(modelFailureCode({ status: 408, message: "timeout" })).toBe("MODEL_TIMEOUT");
    expect(modelFailureCode({ status: 401, message: "unauthorized" })).toBe("MODEL_AUTH");
    expect(modelFailureCode({ status: 400, message: "upstream_error" })).toBe("MODEL_TRANSPORT");
    expect(modelFailureCode(new Error("fetch failed"))).toBe("MODEL_TRANSPORT");
  });

  it("reads Retry-After from direct and nested error fields", () => {
    expect(normalizeModelFailure(Object.assign(new Error("429"), { status: 429, retryAfterMs: 12_000 })).retryAfterMs).toBe(12_000);
    expect(normalizeModelFailure(Object.assign(new Error("429"), { status: 429, detail: { retryAfterMs: 30_000 } })).retryAfterMs).toBe(30_000);
  });

  it("maps tool failures through a declared code and fallback", () => {
    const timeout = normalizeToolFailure(Object.assign(new Error("still running"), { code: "TOOL_TIMEOUT", retryable: true }));
    expect(timeout).toMatchObject({ code: "TOOL_TIMEOUT", retryable: true });
    expect(normalizeToolFailure(new Error("boom"))).toMatchObject({ code: "TOOL_EXEC_FAILED", retryable: true });
  });
});
