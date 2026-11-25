import { describe, expect, it } from "vitest";
import { triggerWindowTokens } from "./runtime.ts";

const BUFFER_TOKENS = 16_000;

function thresholdOf(windowTokens: number, reserveTokens: number, maxOutputTokens: number): number {
  return windowTokens - Math.max(reserveTokens, maxOutputTokens) - BUFFER_TOKENS;
}

describe("compactTriggerTokens window mapping", () => {
  it("makes the compaction threshold equal the trigger", () => {
    const window = triggerWindowTokens(256_000, 80_000, 35_200, 8_000);
    expect(thresholdOf(window, 35_200, 8_000)).toBe(80_000);
  });

  it("uses the larger of reserve and max output when computing the threshold", () => {
    const window = triggerWindowTokens(256_000, 80_000, 4_000, 20_000);
    expect(thresholdOf(window, 4_000, 20_000)).toBe(80_000);
  });

  it("never exceeds the real context window", () => {
    expect(triggerWindowTokens(100_000, 500_000, 35_200, 8_000)).toBe(100_000);
  });

  it("keeps the original window when no trigger is configured", () => {
    expect(triggerWindowTokens(256_000, undefined, 35_200, 8_000)).toBe(256_000);
    expect(triggerWindowTokens(256_000, 0, 35_200, 8_000)).toBe(256_000);
  });
});
