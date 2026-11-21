import type { RunBudget, TaskRecord } from "@hearth/core";
import type { HarnessProfile } from "../types.ts";

// Bounded defaults for coding runs. A caller can still widen or disable a
// dimension explicitly; undefined fields fall back to these values.
export const CODING_RUN_BUDGET: RunBudget = {
  maxTurns: 500,
  maxToolCalls: 1_000,
  maxTokens: 8_000_000,
  maxDurationMs: 12 * 60 * 60 * 1_000
};

export const GENERAL_RUN_BUDGET: RunBudget = {
  maxTurns: 200,
  maxToolCalls: 300,
  maxTokens: 3_000_000,
  maxDurationMs: 4 * 60 * 60 * 1_000
};

export function withBudgetDefaults(budget: RunBudget | undefined, defaults: RunBudget): RunBudget {
  const value = budget ?? {};
  return {
    maxTurns: value.maxTurns ?? defaults.maxTurns,
    maxToolCalls: value.maxToolCalls ?? defaults.maxToolCalls,
    maxTokens: value.maxTokens ?? defaults.maxTokens,
    maxDurationMs: value.maxDurationMs ?? defaults.maxDurationMs
  };
}

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
  return profile === "coding" ? withBudgetDefaults(fallback, CODING_RUN_BUDGET) : fallback;
}
