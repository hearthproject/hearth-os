import type { RunBudget, TaskRecord } from "@hearth/core";
import type { HarnessProfile } from "../types.ts";

// 默认不设置轮次、工具调用、Token 或时长上限；循环保护仍然生效。
export const CODING_RUN_BUDGET: RunBudget = {};

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
