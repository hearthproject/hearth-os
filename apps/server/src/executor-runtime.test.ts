import { describe, expect, it } from "vitest";
import { classifyExecutorProbeFailure, executorHealth } from "./executor-runtime.ts";
import { defaultExecutorSettings } from "./executor-settings.ts";

describe("executor runtime", () => {
  it("classifies 429 and quota failures as quota_exceeded", () => {
    expect(classifyExecutorProbeFailure("429 Too Many Requests", "HTTP_429").state).toBe("quota_exceeded");
    expect(classifyExecutorProbeFailure("当前账户额度已用尽", null).state).toBe("quota_exceeded");
    expect(classifyExecutorProbeFailure("connection refused", null).state).toBe("failed");
  });

  it("reports native as always ready", () => {
    const health = executorHealth("native", defaultExecutorSettings(), "executor-settings.json", 0);
    expect(health.canRun).toBe(true);
    expect(health.state).toBe("ready");
  });
});
