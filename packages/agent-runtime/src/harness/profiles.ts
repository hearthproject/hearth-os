import type { RunBudget, TaskRecord } from "@hearth/core";
import type { HarnessProfile } from "../types.ts";

// A run has no product-level ceiling. Callers may still pass an explicit
// budget for a bounded sub-run; undefined dimensions stay unlimited.
export const CODING_RUN_BUDGET: RunBudget = {};

export const GENERAL_RUN_BUDGET: RunBudget = {};

export function withBudgetDefaults(budget: RunBudget | undefined, _defaults: RunBudget): RunBudget {
  return { ...(budget ?? {}) };
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
