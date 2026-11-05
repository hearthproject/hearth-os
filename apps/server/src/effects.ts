import type { EffectRecord } from "@hearth/core";
import { executeGitHubEffect } from "./github.ts";

export async function executeEffect(effect: EffectRecord): Promise<Record<string, unknown>> {
  if (effect.kind.startsWith("github.")) return executeGitHubEffect(effect);
  throw new Error(`外部动作执行器尚未接入：${effect.kind}`);
}
