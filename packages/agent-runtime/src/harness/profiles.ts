import { NATIVE_TOKEN_CEILING, type RunBudget, type TaskRecord } from "@hearth/core";
import type { HarnessProfile } from "../types.ts";

/**
 * Coding tasks need a much larger turn budget than office drafts. The token
 * ceiling stays in place as a runaway guard; turns, tool calls and wall time
 * are the real constraints.
 */
export const CODING_RUN_BUDGET: RunBudget = {
  maxTurns: 300,
  maxToolCalls: 2_500,
  maxTokens: NATIVE_TOKEN_CEILING,
  maxDurationMs: 8 * 60 * 60_000
};

export function codingHarnessEnabled(): boolean {
  const value = process.env.HEARTH_CODING_HARNESS?.trim().toLowerCase();
  if (!value) return true;
  return !["0", "false", "off", "no"].includes(value);
}

export function resolveHarnessProfile(input: {
  taskKind?: TaskRecord["taskKind"];
  hasRepository?: boolean;
  codeIntent?: boolean;
  forced?: HarnessProfile;
}): HarnessProfile {
  if (input.forced) return input.forced;
  if (!codingHarnessEnabled()) return "general";
  if (input.taskKind === "workspace") return "coding";
  if (input.hasRepository) return "coding";
  if (input.codeIntent) return "coding";
  return "general";
}

export function budgetForProfile(profile: HarnessProfile, fallback: RunBudget): RunBudget {
  return profile === "coding" ? { ...CODING_RUN_BUDGET } : fallback;
}
