import { describe, expect, it } from "vitest";
import {
  resolveContextWindowPolicy,
  suggestContextWindowTokens,
  taskContextBudgetTokens
} from "./context-window.ts";

describe("context window policy", () => {
  it("identifies DeepSeek Flash as a 1M model regardless of the wire protocol", () => {
    expect(suggestContextWindowTokens("deepseek-flash")).toBe(1_000_000);
    expect(suggestContextWindowTokens("deepseek-v4.1-flash")).toBe(1_000_000);
    expect(suggestContextWindowTokens("deepseek-v4-flash-1m")).toBe(1_000_000);
  });

  it("honors explicit window suffixes and leaves unknown models alone", () => {
    expect(suggestContextWindowTokens("qwen3-coder-256k")).toBe(256_000);
    expect(suggestContextWindowTokens("claude-sonnet-128k")).toBe(128_000);
    expect(suggestContextWindowTokens("some-model", 200_000)).toBe(200_000);
  });

  it("derives an 80% compact trigger and budgets from the model window", () => {
    const flash = resolveContextWindowPolicy({ contextWindowTokens: 1_000_000, maxOutputTokens: 8_000 });
    expect(flash.compactThresholdTokens).toBe(800_000);
    expect(flash.keepTokens).toBe(150_000);
    expect(flash.summaryMaxTokens).toBe(30_000);
    expect(flash.inputBudgetTokens).toBeGreaterThan(700_000);
    expect(taskContextBudgetTokens(flash)).toBeLessThan(flash.inputBudgetTokens);

    const small = resolveContextWindowPolicy({ contextWindowTokens: 256_000, maxOutputTokens: 8_000 });
    expect(small.compactThresholdTokens).toBe(204_800);
    expect(small.inputBudgetTokens).toBeLessThanOrEqual(small.compactThresholdTokens);
  });

  it("clamps missing and tiny windows to a usable floor", () => {
    const fallback = resolveContextWindowPolicy(null, { fallbackWindowTokens: 16_000 });
    expect(fallback.contextWindowTokens).toBe(16_000);
    expect(fallback.compactThresholdTokens).toBe(12_800);
    expect(fallback.maxOutputTokens).toBeLessThan(16_000);
  });
});
