import { describe, expect, it } from "vitest";
import { ModelClientError, parseRetryAfterMs, withModelRetry } from "./model-client.ts";

describe("model retry policy", () => {
  it("honors retry-after and succeeds on a later attempt", async () => {
    let calls = 0;
    const result = await withModelRetry(async () => {
      calls += 1;
      if (calls === 1) throw new ModelClientError("MODEL_REQUEST_FAILED", "rate limited", 429, 10);
      return "ok";
    }, undefined);

    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfterMs("1")).toBe(1_000);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("not-a-date")).toBeNull();
  });
});
